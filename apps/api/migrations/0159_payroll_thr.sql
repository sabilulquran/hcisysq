-- PAY-003-THR: Tunjangan Hari Raya as a period kind of its own.
-- Spec: docs/domain/payroll-thr.md (decisions T1-T14, DRAFT 2026-11-17).
--
-- What changes:
--   1. payroll_periods gains period_kind (REGULAR | THR), holiday_date and holiday_name. One
--      period per kind per month per legal entity, so a THR period sits beside the monthly one.
--   2. payroll_components gains is_thr_wage (the "upah" of Permenaker 6/2016: basic salary plus
--      fixed allowances) and the THR component.
--   3. payroll_policy_versions accepts the THR policy key, with one DRAFT version.
--   4. payslips gains kind, and "one current slip per employee and month" becomes "per employee,
--      month and kind", so a THR slip never supersedes the salary slip of the same month.
--
-- Deployment order (OPS-MI8-REL-001 §4.5): every column has a default that keeps the old build's
-- reads and writes valid (REGULAR, false), so the window between migrate and cutover changes
-- nothing for it.
--
-- Down, only while no THR period exists (SELECT count(*) FROM payroll_periods WHERE period_kind =
-- 'THR' must be 0; otherwise withdraw the THR routes and keep the columns):
--   DELETE FROM payroll_policy_versions WHERE policy_key = 'THR';
--   restore payroll_policy_versions_policy_key_check without 'THR' (keeping PERFORMANCE_PERCENT and PPH21_ANNUAL);
--   DELETE FROM payroll_components WHERE code = 'THR';
--   ALTER TABLE payroll_components DROP CONSTRAINT payroll_components_thr_wage_is_earning,
--     DROP COLUMN is_thr_wage;
--   ALTER TABLE payroll_periods DROP CONSTRAINT payroll_periods_unique_month_per_kind,
--     DROP CONSTRAINT payroll_periods_thr_holiday, then re-add payroll_periods_unique_month
--     as in 0069 and drop period_kind, holiday_date, holiday_name;
--   restore enforce_one_current_payslip and prevent_published_payslip_mutation from 0100,
--   then ALTER TABLE payslips DROP COLUMN kind.

-- 1. Period kind -----------------------------------------------------------------------------
ALTER TABLE payroll_periods
  ADD COLUMN IF NOT EXISTS period_kind text NOT NULL DEFAULT 'REGULAR'
    CHECK (period_kind IN ('REGULAR', 'THR')),
  ADD COLUMN IF NOT EXISTS holiday_date date NULL,
  ADD COLUMN IF NOT EXISTS holiday_name text NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_periods_thr_holiday') THEN
    -- A THR period names its holiday and is paid before it; a monthly period has none.
    ALTER TABLE payroll_periods
      ADD CONSTRAINT payroll_periods_thr_holiday CHECK (
        (period_kind = 'THR'
          AND holiday_date IS NOT NULL
          AND holiday_name IS NOT NULL AND length(trim(holiday_name)) > 0
          AND pay_date < holiday_date)
        OR (period_kind = 'REGULAR' AND holiday_date IS NULL AND holiday_name IS NULL)
      );
  END IF;
END;
$$;

ALTER TABLE payroll_periods DROP CONSTRAINT IF EXISTS payroll_periods_unique_month;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_periods_unique_month_per_kind') THEN
    ALTER TABLE payroll_periods
      ADD CONSTRAINT payroll_periods_unique_month_per_kind
      EXCLUDE USING gist (
        (COALESCE(legal_entity_key, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
        period_kind WITH =,
        daterange(period_month, (period_month + interval '1 month')::date, '[)') WITH &&
      );
  END IF;
END;
$$;

-- 2. Component catalog -----------------------------------------------------------------------
ALTER TABLE payroll_components
  ADD COLUMN IF NOT EXISTS is_thr_wage boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_components_thr_wage_is_earning') THEN
    ALTER TABLE payroll_components
      ADD CONSTRAINT payroll_components_thr_wage_is_earning CHECK (NOT is_thr_wage OR category = 'EARNING');
  END IF;
END;
$$;

-- T6 (DRAFT): basic salary and the allowances paid every month regardless of attendance — the
-- same list as the fixed allowances of PAY-003 §10 item 2.
UPDATE payroll_components SET is_thr_wage = true
WHERE code IN ('BASIC', 'PERF', 'SPOUSE', 'CHILD', 'FUNC', 'POS', 'SPECIAL_QUAL');

INSERT INTO payroll_components
  (code, display_name, category, is_fixed_allowance, in_pph21_base, display_order, is_thr_wage) VALUES
  ('THR', 'Tunjangan Hari Raya', 'EARNING', false, true, 170, false)
ON CONFLICT (code) DO NOTHING;

-- 3. Policy -----------------------------------------------------------------------------------
ALTER TABLE payroll_policy_versions DROP CONSTRAINT IF EXISTS payroll_policy_versions_policy_key_check;
ALTER TABLE payroll_policy_versions
  ADD CONSTRAINT payroll_policy_versions_policy_key_check CHECK (policy_key IN (
    'SALARY_SCALE', 'BASIC_MULTIPLIER', 'TEACHING_HOURS', 'PERFORMANCE', 'FAMILY',
    'FUNCTIONAL_ALLOWANCE', 'POSITIONAL_ALLOWANCE', 'OVERTIME', 'BPJS_KESEHATAN',
    'CONTRACT_RATES', 'EARLY_SERVICE', 'VARIANCE_THRESHOLD', 'PPH21_TER',
    -- 0153 (PERF-001 link) added PERFORMANCE_PERCENT and 0157 PPH21_ANNUAL; this rebuild keeps both.
    'PERFORMANCE_PERCENT', 'PPH21_ANNUAL', 'THR'
  ));

INSERT INTO payroll_policy_versions (id, policy_key, effective_from, effective_to, payload, source, note)
SELECT '7a0f3c2e-5b1d-4e8a-9c41-0d2b6e8f1a52', 'THR', DATE '2026-01-01', NULL,
  '{"fullServiceMonths": 12, "minimumServiceMonths": 1, "paymentDeadlineDaysBeforeHoliday": 7,
    "terminationGraceDays": 30, "terminationGraceTermCategories": ["TETAP", "PERCOBAAN"],
    "eligibleTermCategories": ["TETAP", "PERCOBAAN", "KONTRAK"]}'::jsonb,
  'Permenaker 6/2016 Pasal 2, 3, 5 ayat (4), 7',
  'DRAFT default agent 2026-11-17 (docs/domain/payroll-thr.md T1-T14); kategori yang berhak menunggu konfirmasi process owner'
WHERE NOT EXISTS (SELECT 1 FROM payroll_policy_versions WHERE policy_key = 'THR');

-- 4. Payslips ---------------------------------------------------------------------------------
ALTER TABLE payslips
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'REGULAR' CHECK (kind IN ('REGULAR', 'THR'));

DROP INDEX IF EXISTS payslips_current_per_period_idx;
CREATE INDEX IF NOT EXISTS payslips_current_per_period_kind_idx
  ON payslips (employee_id, period, kind)
  WHERE superseded_by_id IS NULL;

CREATE OR REPLACE FUNCTION enforce_one_current_payslip()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_count integer;
BEGIN
  SELECT count(*) INTO current_count
  FROM payslips
  WHERE employee_id = NEW.employee_id
    AND period = NEW.period
    AND kind = NEW.kind
    AND superseded_by_id IS NULL;

  IF current_count > 1 THEN
    RAISE EXCEPTION 'more than one current payslip for employee % period % kind %',
      NEW.employee_id, NEW.period, NEW.kind
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NULL;
END;
$$;

-- Same guard as 0100, with kind among the columns a supersede must leave untouched.
CREATE OR REPLACE FUNCTION prevent_published_payslip_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.published_at IS NOT NULL THEN
    IF TG_OP = 'UPDATE'
       AND OLD.superseded_by_id IS NULL
       AND NEW.superseded_by_id IS NOT NULL
       AND NEW.id IS NOT DISTINCT FROM OLD.id
       AND NEW.employee_id IS NOT DISTINCT FROM OLD.employee_id
       AND NEW.period IS NOT DISTINCT FROM OLD.period
       AND NEW.kind IS NOT DISTINCT FROM OLD.kind
       AND NEW.lines IS NOT DISTINCT FROM OLD.lines
       AND NEW.source_format IS NOT DISTINCT FROM OLD.source_format
       AND NEW.source_batch_id IS NOT DISTINCT FROM OLD.source_batch_id
       AND NEW.source_period_id IS NOT DISTINCT FROM OLD.source_period_id
       AND NEW.revision_of IS NOT DISTINCT FROM OLD.revision_of
       AND NEW.published_at IS NOT DISTINCT FROM OLD.published_at
       AND NEW.published_by_account_id IS NOT DISTINCT FROM OLD.published_by_account_id
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'published payslip is immutable';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON COLUMN payslips.kind IS
  'PAY-003-THR: REGULAR salary slip or THR slip. One current slip per employee, month and kind.';
COMMENT ON COLUMN payroll_periods.period_kind IS
  'PAY-003-THR: REGULAR monthly payroll or THR (Tunjangan Hari Raya), docs/domain/payroll-thr.md.';
