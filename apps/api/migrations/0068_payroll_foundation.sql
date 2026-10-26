-- PAY-003 v1, step 1: payroll schema, roles and permissions.
-- Specification: docs/domain/payroll-calculation-v1.md
-- Decision: docs/architecture/adr/0003-payroll-calculation-in-hcis.md (ACCEPTED)
--
-- This migration creates storage and vocabulary only. No period is created, no
-- amount is written, no account receives a payroll role, and no existing table
-- changes. PAY-001/PAY-002 remain the official payslip path until the parallel
-- run passes, so nothing here affects the payslip screens.
--
-- Foundation Board: ORG-003-F and ORG-010-F forbid the board even aggregate
-- payroll figures, so foundation_board_viewer receives no payroll permission
-- here and must not be granted one without its own ADR.
--
-- Down, in this order:
--   1. Revoke every assignment of the three new roles through the reviewed route
--      (DELETE /admin/access/role-assignments/:assignmentId, which writes
--      role.assignment.removed). Deleting the rows directly loses that audit.
--   2. Confirm no payroll period exists and no payroll audit row was written:
--        SELECT count(*) FROM payroll_periods;       -- must be 0
--        SELECT count(*) FROM payroll_audit_events;  -- must be 0
--      If either is non-zero, stop: payroll history is a fact and this migration
--      does not come down. Keep the tables and withdraw the permissions instead.
--   3. DROP TABLE payroll_audit_events, payroll_result_lines, payroll_results,
--        payroll_period_inputs, payroll_loan_deductions, payroll_loans,
--        payroll_compensation_profiles, payroll_periods, payroll_policy_versions,
--        payroll_components;
--      No CASCADE: a dependency a later migration created must surface as an
--      error rather than be dropped silently.
--   4. DELETE FROM role_permissions WHERE permission_key LIKE 'payroll.%';
--      DELETE FROM permissions WHERE permission_key LIKE 'payroll.%';
--   5. DELETE FROM roles WHERE role_key IN ('finance_officer', 'finance_lead', 'director')
--        AND id IN ('10000000-0000-4000-8000-000000000012',
--                   '10000000-0000-4000-8000-000000000013',
--                   '10000000-0000-4000-8000-000000000014');
--      The id match keeps a role this migration found already present untouched.

-- The no-overlap guards below need btree_gist, as in 0021 and 0056. It is already
-- installed in production and in CI, so this is a no-op there.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Component catalog. Codes are stable and exportable, so a future payroll system
-- can read the history back (ADR-0003 decision 9).
CREATE TABLE IF NOT EXISTS payroll_components (
  code text PRIMARY KEY,
  display_name text NOT NULL CHECK (length(trim(display_name)) > 0),
  category text NOT NULL CHECK (category IN ('EARNING', 'DEDUCTION', 'EMPLOYER_COST')),
  -- Counts towards the BPJS Kesehatan contribution base (specification 3.1).
  is_fixed_allowance boolean NOT NULL DEFAULT false,
  -- Counts towards the PPh21 reporting base (specification 5.3).
  in_pph21_base boolean NOT NULL DEFAULT false,
  display_order integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_components_fixed_allowance_is_earning
    CHECK (NOT is_fixed_allowance OR category = 'EARNING'),
  CONSTRAINT payroll_components_pph21_base_is_earning
    CHECK (NOT in_pph21_base OR category = 'EARNING'),
  -- Lets a result line reference the code and its category together, so a
  -- deduction can never be stored as an earning.
  CONSTRAINT payroll_components_code_category UNIQUE (code, category)
);

INSERT INTO payroll_components
  (code, display_name, category, is_fixed_allowance, in_pph21_base, display_order) VALUES
  ('BASIC',          'Gaji pokok',                          'EARNING',       true,  true,  10),
  ('TEACH_OVER',     'Kelebihan jam',                       'EARNING',       false, true,  20),
  ('PERF',           'Tunjangan kinerja',                   'EARNING',       true,  true,  30),
  ('SPOUSE',         'Tunjangan pasangan',                  'EARNING',       true,  true,  40),
  ('CHILD',          'Tunjangan anak',                      'EARNING',       true,  true,  50),
  ('FUNC',           'Tunjangan fungsional',                'EARNING',       true,  true,  60),
  ('POS',            'Tunjangan jabatan',                   'EARNING',       true,  true,  70),
  ('SPECIAL_QUAL',   'Tunjangan kualifikasi khusus',        'EARNING',       true,  true,  80),
  ('OVERTIME',       'Lembur',                              'EARNING',       false, true,  90),
  -- Shown as an earning and deducted again at the same amount, exactly as the
  -- legacy payslip does: the employee nets zero and the foundation bears the
  -- whole contribution, so it stays out of the PPh21 base.
  ('BPJS_KES_ALLOW', 'Tunjangan BPJS Kesehatan',            'EARNING',       false, false, 100),
  ('ARREARS',        'Rapel gaji',                          'EARNING',       false, true,  110),
  ('PJ_MEDIA',       'Insentif Pj. Media',                  'EARNING',       false, true,  120),
  ('TRANSPORT',      'Transport PKWT',                      'EARNING',       false, true,  130),
  ('TEACH_FEE',      'Honor mengajar PKWT',                 'EARNING',       false, true,  140),
  ('OTHER_INCOME',   'Pemasukan lain',                      'EARNING',       false, true,  150),
  ('ADJUST_EARN',    'Penyesuaian gaji (penambah)',         'EARNING',       false, true,  160),
  ('LOAN',           'Potongan kasbon',                     'DEDUCTION',     false, false, 200),
  ('BPJS_KES',       'Iuran BPJS Kesehatan',                'DEDUCTION',     false, false, 210),
  ('BPJS_KES_EXTRA', 'Iuran anggota keluarga tambahan',     'DEDUCTION',     false, false, 220),
  ('CHILD_EDU',      'Pendidikan anak',                     'DEDUCTION',     false, false, 230),
  ('TEACH_SHORT',    'Kekurangan jam',                      'DEDUCTION',     false, false, 240),
  ('ADJUST_DEDUCT',  'Penyesuaian gaji (potongan)',         'DEDUCTION',     false, false, 250),
  ('PPH21_EMPLOYER', 'PPh21 ditanggung yayasan',            'EMPLOYER_COST', false, false, 300)
ON CONFLICT (code) DO NOTHING;

-- Versioned policy. Every statutory rate, ceiling, floor and table lives here
-- with its source and its effective dates, never as a constant in code
-- (specification 10 item 9). Changing a policy adds a version; it never
-- overwrites one, so a past period stays recomputable.
CREATE TABLE IF NOT EXISTS payroll_policy_versions (
  id uuid PRIMARY KEY,
  policy_key text NOT NULL CHECK (policy_key IN (
    'SALARY_SCALE', 'BASIC_MULTIPLIER', 'TEACHING_HOURS', 'PERFORMANCE', 'FAMILY',
    'FUNCTIONAL_ALLOWANCE', 'POSITIONAL_ALLOWANCE', 'OVERTIME', 'BPJS_KESEHATAN',
    'CONTRACT_RATES', 'EARLY_SERVICE', 'VARIANCE_THRESHOLD', 'PPH21_TER'
  )),
  effective_from date NOT NULL,
  effective_to date NULL,
  payload jsonb NOT NULL,
  -- Where the values come from, e.g. a regulation number or the sheet and date.
  source text NOT NULL CHECK (length(trim(source)) > 0),
  note text NULL,
  created_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_policy_versions_date_order
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT payroll_policy_versions_no_overlap
    EXCLUDE USING gist (
      policy_key WITH =,
      daterange(effective_from, COALESCE(effective_to + 1, 'infinity'::date), '[)') WITH &&
    )
);

-- Effective-dated compensation profile per employment. History is never
-- overwritten; a change closes one row and opens the next.
CREATE TABLE IF NOT EXISTS payroll_compensation_profiles (
  id uuid PRIMARY KEY,
  employment_id uuid NOT NULL REFERENCES employments(id) ON DELETE RESTRICT,
  effective_from date NOT NULL,
  effective_to date NULL,
  education text NULL CHECK (education IN ('SD', 'SMP', 'SLTA', 'D1_D2', 'D3_D4', 'S1', 'S2_S3')),
  work_pattern text NULL CHECK (work_pattern IS NULL OR work_pattern IN ('FULL', 'HALF_DAY', 'HALF_DAY_II')),
  -- Stable references into the organization model (specification 3.3), not text
  -- labels. They carry no foreign key yet: ORG-008 is still moving the node and
  -- position tables, and a payroll profile must survive a structure revision
  -- rather than block it. The period layer resolves them and raises
  -- UNIT_NOT_MAPPED or POSITION_NOT_MAPPED when one no longer resolves.
  unit_ref uuid NULL,
  functional_position_ref uuid NULL,
  structural_position_ref uuid NULL,
  teaching_hours_per_week numeric(6, 2) NULL CHECK (teaching_hours_per_week IS NULL OR teaching_hours_per_week >= 0),
  spouse_count integer NOT NULL DEFAULT 0 CHECK (spouse_count >= 0),
  child_count integer NOT NULL DEFAULT 0 CHECK (child_count >= 0),
  registered_dependants integer NOT NULL DEFAULT 0 CHECK (registered_dependants >= 0),
  special_qualification_target bigint NULL CHECK (special_qualification_target IS NULL OR special_qualification_target >= 0),
  annual_performance_rate numeric(5, 4) NULL CHECK (annual_performance_rate IS NULL OR annual_performance_rate >= 0),
  monthly_performance_rate numeric(5, 4) NULL CHECK (monthly_performance_rate IS NULL OR monthly_performance_rate >= 0),
  bpjs_segment text NOT NULL DEFAULT 'BELUM_TERDAFTAR'
    CHECK (bpjs_segment IN ('PPU_YAYASAN', 'PBI', 'MANDIRI', 'BELUM_TERDAFTAR')),
  bpjs_active_from date NULL,
  -- Extra family members are normally derived from dependants; an override needs a reason.
  bpjs_extra_family_override integer NULL CHECK (bpjs_extra_family_override IS NULL OR bpjs_extra_family_override >= 0),
  bpjs_extra_family_override_reason text NULL,
  bpjs_decision_reference text NULL,
  ptkp_status text NULL,
  pj_media_rate_per_content bigint NULL CHECK (pj_media_rate_per_content IS NULL OR pj_media_rate_per_content >= 0),
  bank_account_number text NULL,
  bank_account_name text NULL,
  recorded_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_compensation_profiles_date_order
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT payroll_compensation_profiles_override_needs_reason
    CHECK (bpjs_extra_family_override IS NULL OR length(trim(coalesce(bpjs_extra_family_override_reason, ''))) > 0),
  CONSTRAINT payroll_compensation_profiles_bpjs_active_needs_segment
    CHECK (bpjs_active_from IS NULL OR bpjs_segment <> 'BELUM_TERDAFTAR'),
  CONSTRAINT payroll_compensation_profiles_no_overlap
    EXCLUDE USING gist (
      employment_id WITH =,
      daterange(effective_from, COALESCE(effective_to + 1, 'infinity'::date), '[)') WITH &&
    )
);

CREATE INDEX IF NOT EXISTS payroll_compensation_profiles_employment_idx
  ON payroll_compensation_profiles (employment_id, effective_from DESC);

-- Payroll period. One per month per legal entity (NULL is the implicit YSQ
-- default, as in employments.legal_entity_key).
CREATE TABLE IF NOT EXISTS payroll_periods (
  id uuid PRIMARY KEY,
  legal_entity_key uuid NULL,
  -- First day of the payroll month.
  period_month date NOT NULL CHECK (extract(day from period_month) = 1),
  pay_date date NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  -- Input cutoff window for overtime and contract attendance (specification 10 item 1).
  cutoff_start date NOT NULL,
  cutoff_end date NOT NULL,
  state text NOT NULL DEFAULT 'DRAFT' CHECK (state IN (
    'DRAFT', 'COLLECTING', 'CALCULATED', 'SUBMITTED', 'APPROVED',
    'PAYMENT_CONFIRMED', 'PUBLISHED', 'REOPEN_REQUESTED'
  )),
  -- The state a reopen request returns to if the director rejects it. It exists
  -- exactly while the period waits on that answer.
  state_before_reopen_request text NULL CHECK (
    state_before_reopen_request IS NULL
    OR state_before_reopen_request IN ('APPROVED', 'PAYMENT_CONFIRMED', 'PUBLISHED')
  ),
  created_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  submitted_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  submitted_at timestamptz NULL,
  approved_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  approved_at timestamptz NULL,
  payment_confirmed_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  payment_confirmed_at timestamptz NULL,
  published_at timestamptz NULL,
  reopen_count integer NOT NULL DEFAULT 0 CHECK (reopen_count >= 0),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_periods_date_order CHECK (period_end >= period_start),
  CONSTRAINT payroll_periods_reopen_state_pairs_with_request
    CHECK ((state = 'REOPEN_REQUESTED') = (state_before_reopen_request IS NOT NULL)),
  CONSTRAINT payroll_periods_cutoff_order CHECK (cutoff_end >= cutoff_start),
  -- No self-approval: whoever submits a period cannot approve the same one.
  CONSTRAINT payroll_periods_no_self_approval
    CHECK (
      submitted_by_account_id IS NULL
      OR approved_by_account_id IS NULL
      OR submitted_by_account_id <> approved_by_account_id
    ),
  CONSTRAINT payroll_periods_unique_month
    EXCLUDE USING gist (
      (COALESCE(legal_entity_key, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
      daterange(period_month, (period_month + interval '1 month')::date, '[)') WITH &&
    )
);

-- Loans. The outstanding balance is the principal less the deductions that
-- belong to a period which actually reached APPROVED.
CREATE TABLE IF NOT EXISTS payroll_loans (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  granted_on date NOT NULL,
  principal bigint NOT NULL CHECK (principal > 0),
  -- Fixed instalment, or NULL when finance sets the amount per period.
  instalment bigint NULL CHECK (instalment IS NULL OR instalment > 0),
  note text NULL,
  recorded_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS payroll_loans_employee_idx ON payroll_loans (employee_id, granted_on DESC);
CREATE INDEX IF NOT EXISTS payroll_loans_open_idx ON payroll_loans (employee_id) WHERE closed_at IS NULL;

CREATE TABLE IF NOT EXISTS payroll_loan_deductions (
  id uuid PRIMARY KEY,
  loan_id uuid NOT NULL REFERENCES payroll_loans(id) ON DELETE RESTRICT,
  period_id uuid NOT NULL REFERENCES payroll_periods(id) ON DELETE RESTRICT,
  amount bigint NOT NULL CHECK (amount > 0),
  recorded_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- Repeating the operation must not double the deduction (specification 6).
  CONSTRAINT payroll_loan_deductions_once_per_period UNIQUE (loan_id, period_id)
);

-- Locking loans at CALCULATED and listing a period's deductions both read by period.
CREATE INDEX IF NOT EXISTS payroll_loan_deductions_period_idx
  ON payroll_loan_deductions (period_id);

-- Period inputs. One row per employment per input key, with the actor and the
-- reason where the specification requires one.
CREATE TABLE IF NOT EXISTS payroll_period_inputs (
  id uuid PRIMARY KEY,
  period_id uuid NOT NULL REFERENCES payroll_periods(id) ON DELETE RESTRICT,
  employment_id uuid NOT NULL REFERENCES employments(id) ON DELETE RESTRICT,
  input_key text NOT NULL CHECK (input_key IN (
    'OVERTIME_HOURS', 'CONTRACT_ATTENDANCE_DAYS', 'CONTRACT_TEACHING_HOURS',
    'CHILD_EDUCATION', 'PJ_MEDIA', 'ARREARS', 'ADJUSTMENT', 'PRORATION_FACTOR',
    'FULL_PAY_DESPITE_LEAVING', 'OTHER_INCOME',
    'TEACHING_HOURS_PER_WEEK_OVERRIDE', 'ANNUAL_PERFORMANCE_OVERRIDE',
    'MONTHLY_PERFORMANCE_OVERRIDE'
  )),
  -- One numeric column: rupiah, hours, days or a factor, depending on input_key.
  value numeric(14, 4) NOT NULL,
  -- Where the number came from: ATTENDANCE for a resolved ATT-010 figure,
  -- MANUAL for an entry by human capital, IMPORT for a period file.
  origin text NOT NULL CHECK (origin IN ('ATTENDANCE', 'MANUAL', 'IMPORT')),
  reason text NULL,
  decision_reference text NULL,
  recorded_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_period_inputs_one_per_key UNIQUE (period_id, employment_id, input_key),
  CONSTRAINT payroll_period_inputs_reason_required
    CHECK (
      input_key NOT IN ('ADJUSTMENT', 'ARREARS', 'PRORATION_FACTOR', 'FULL_PAY_DESPITE_LEAVING')
      OR length(trim(coalesce(reason, ''))) > 0
    ),
  -- Specification 4: a salary adjustment carries a reason AND the decision it rests on.
  CONSTRAINT payroll_period_inputs_adjustment_has_decision
    CHECK (input_key <> 'ADJUSTMENT' OR length(trim(coalesce(decision_reference, ''))) > 0),
  CONSTRAINT payroll_period_inputs_proration_range
    CHECK (input_key <> 'PRORATION_FACTOR' OR (value > 0 AND value <= 1))
);

CREATE INDEX IF NOT EXISTS payroll_period_inputs_period_idx
  ON payroll_period_inputs (period_id, employment_id);

-- Stored results. A result is a fact: approval locks it, and a recalculation
-- after a reopen stores a new revision with lineage to the previous one.
CREATE TABLE IF NOT EXISTS payroll_results (
  id uuid PRIMARY KEY,
  period_id uuid NOT NULL REFERENCES payroll_periods(id) ON DELETE RESTRICT,
  employment_id uuid NOT NULL REFERENCES employments(id) ON DELETE RESTRICT,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  previous_result_id uuid NULL REFERENCES payroll_results(id) ON DELETE RESTRICT,
  gross bigint NOT NULL,
  deductions bigint NOT NULL,
  net bigint NOT NULL,
  payable bigint NOT NULL,
  employer_cost bigint NOT NULL DEFAULT 0,
  pay_factor numeric(5, 4) NOT NULL DEFAULT 1 CHECK (pay_factor > 0 AND pay_factor <= 1),
  pay_factor_reason text NOT NULL DEFAULT 'none'
    CHECK (pay_factor_reason IN ('none', 'proration', 'early_service')),
  bpjs_base bigint NOT NULL DEFAULT 0,
  extra_family_members integer NOT NULL DEFAULT 0 CHECK (extra_family_members >= 0),
  -- Difference against what was already paid, when a period is reopened after
  -- payment. Carried into the next period as arrears or an adjustment.
  payment_difference bigint NOT NULL DEFAULT 0,
  blockers jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The exact input snapshot and policy versions the amounts came from, so the
  -- same result can be reproduced without reading today's tables.
  input_snapshot jsonb NOT NULL,
  policy_version_ids jsonb NOT NULL,
  locked_at timestamptz NULL,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_results_one_revision UNIQUE (period_id, employment_id, revision),
  CONSTRAINT payroll_results_factor_pairs_with_reason
    CHECK ((pay_factor = 1) = (pay_factor_reason = 'none')),
  -- ADR-0003 decision 4: a result is a fact. It is only reproducible with the
  -- snapshot and the policy versions it came from, and the period-level blocker
  -- "inputs changed since the last calculation" compares against that snapshot.
  -- An employee with no period input legitimately has an empty snapshot object,
  -- but a result always rests on at least one policy version.
  CONSTRAINT payroll_results_snapshot_present
    CHECK (jsonb_typeof(input_snapshot) = 'object' AND jsonb_array_length(policy_version_ids) > 0),
  -- A revision beyond the first must say which result it replaces.
  CONSTRAINT payroll_results_revision_has_lineage
    CHECK ((revision = 1) OR previous_result_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS payroll_results_period_idx ON payroll_results (period_id);
-- The employee payslip and the previous-period variance both read by employment.
CREATE INDEX IF NOT EXISTS payroll_results_employment_idx
  ON payroll_results (employment_id, calculated_at DESC);

CREATE TABLE IF NOT EXISTS payroll_result_lines (
  id uuid PRIMARY KEY,
  result_id uuid NOT NULL REFERENCES payroll_results(id) ON DELETE RESTRICT,
  component_code text NOT NULL,
  category text NOT NULL CHECK (category IN ('EARNING', 'DEDUCTION', 'EMPLOYER_COST')),
  amount bigint NOT NULL,
  basis text NULL,
  display_order integer NOT NULL,
  CONSTRAINT payroll_result_lines_component_fk
    FOREIGN KEY (component_code, category) REFERENCES payroll_components(code, category) ON DELETE RESTRICT,
  CONSTRAINT payroll_result_lines_one_per_component UNIQUE (result_id, component_code)
);

CREATE INDEX IF NOT EXISTS payroll_result_lines_result_idx ON payroll_result_lines (result_id);

-- Audit. Identifiers, counts, states and period aggregates only: no per-person
-- amount, bank account or identity number belongs in a payload (specification 8).
CREATE TABLE IF NOT EXISTS payroll_audit_events (
  id uuid PRIMARY KEY,
  actor_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (length(trim(action)) > 0),
  period_id uuid NULL REFERENCES payroll_periods(id) ON DELETE SET NULL,
  employment_id uuid NULL REFERENCES employments(id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  -- Specification 8 as a constraint rather than a comment: a per-person amount,
  -- a bank account or an identity number must never reach an audit payload.
  -- Period aggregates are allowed and carry their own names (gross_total, ...).
  CONSTRAINT payroll_audit_events_payload_has_no_personal_amount
    CHECK (
      jsonb_typeof(payload) = 'object'
      AND NOT (payload ?| ARRAY[
        'amount', 'gross', 'net', 'payable', 'deductions', 'salary', 'basic',
        'bank_account_number', 'bank_account_name', 'account_number', 'nik', 'lines'
      ])
    )
);

CREATE INDEX IF NOT EXISTS payroll_audit_events_time_idx ON payroll_audit_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS payroll_audit_events_period_idx
  ON payroll_audit_events (period_id, occurred_at DESC);

INSERT INTO permissions (permission_key, description) VALUES
  ('payroll.policies.manage', 'PAY-003: mengelola kebijakan payroll berversi (skala gaji, tunjangan, statutori)'),
  ('payroll.profiles.manage', 'PAY-003: mengelola profil kompensasi pegawai, bukan miliknya sendiri'),
  ('payroll.periods.manage', 'PAY-003: membuat dan menjalankan periode payroll'),
  ('payroll.inputs.manage', 'PAY-003: mengisi input periode, bukan miliknya sendiri'),
  ('payroll.calculate', 'PAY-003: menjalankan perhitungan periode'),
  ('payroll.submit', 'PAY-003: mengajukan periode untuk pengesahan'),
  ('payroll.approve', 'PAY-003: mengesahkan periode; tidak boleh akun yang mengajukan'),
  ('payroll.reopen.approve', 'PAY-003: menyetujui atau menolak pembukaan ulang periode final'),
  ('payroll.loans.manage', 'PAY-003: mengelola kasbon pegawai; terkunci setelah periode CALCULATED'),
  ('payroll.payments.confirm', 'PAY-003: mengonfirmasi pembayaran periode yang sudah disahkan'),
  ('payroll.reports.read.organization', 'PAY-003: membaca laporan payroll final tanpa nomor rekening'),
  ('payroll.transfers.read.organization', 'PAY-003: membaca dan mengekspor daftar transfer berisi rekening penerima')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO roles (id, role_key, name, description, is_system) VALUES
  ('10000000-0000-4000-8000-000000000012', 'finance_officer', 'Keuangan',
   'PAY-003: mengelola kasbon pegawai dan menyiapkan pembayaran periode payroll yang sudah disahkan.', true),
  ('10000000-0000-4000-8000-000000000013', 'finance_lead', 'Kepala Keuangan',
   'PAY-003: membaca laporan payroll final dan daftar transfer, serta mengonfirmasi pembayaran.', true),
  ('10000000-0000-4000-8000-000000000014', 'director', 'Direktur',
   'PAY-003: mengesahkan periode payroll dan menyetujui pembukaan ulang periode final. Tidak dapat mengubah nilai.', true)
ON CONFLICT (role_key) DO NOTHING;

-- Kepala Human Capital runs payroll up to submission but never approves it.
INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, permission_key
FROM roles role CROSS JOIN unnest(ARRAY[
  'payroll.policies.manage',
  'payroll.profiles.manage',
  'payroll.periods.manage',
  'payroll.inputs.manage',
  'payroll.calculate',
  'payroll.submit'
]::text[]) AS permission_key
WHERE role.role_key = 'human_capital_lead'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, permission_key
FROM roles role CROSS JOIN unnest(ARRAY[
  'payroll.loans.manage'
]::text[]) AS permission_key
WHERE role.role_key = 'finance_officer'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, permission_key
FROM roles role CROSS JOIN unnest(ARRAY[
  'payroll.payments.confirm',
  'payroll.reports.read.organization',
  'payroll.transfers.read.organization'
]::text[]) AS permission_key
WHERE role.role_key = 'finance_lead'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, permission_key
FROM roles role CROSS JOIN unnest(ARRAY[
  'payroll.approve',
  'payroll.reopen.approve',
  'payroll.reports.read.organization'
]::text[]) AS permission_key
WHERE role.role_key = 'director'
ON CONFLICT DO NOTHING;
