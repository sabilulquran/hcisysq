-- PAY-003-THR: honorarium and daily workers receive THR on their average wage.
-- Spec: docs/domain/payroll-thr.md T5 and section 2.1 (owner decision 2026-11-17).
--
-- What changes:
--   1. payroll_period_inputs accepts THR_AVERAGE_WAGE: the average monthly wage human capital
--      types for one honorarium worker on one THR period when the approved salary periods do not
--      cover every month Permenaker 6/2016 Pasal 3 ayat (3) asks for. Like ADJUSTMENT it must
--      carry a reason and a decision reference, and it is a positive whole rupiah.
--   2. The THR policy gains a second version, effective from the decision date: KONTRAK_HONORER
--      and LEPAS join eligibleTermCategories, and averageWageComponents names the earnings that
--      count as wages received. The first version (0164) is closed the day before and keeps its
--      payload, so a THR period paid under it calculates as it did.
--
-- No new table, column, route or permission.
--
-- Deployment order (OPS-MI8-REL-001 §4.5): the old build never writes THR_AVERAGE_WAGE, so the
-- wider checks change nothing for it. Between migrate and cutover the old build would read the new
-- policy version on a THR period paid on or after its first day and answer
-- THR_WAGE_BASIS_UNSUPPORTED for honorarium rows, which blocks the period rather than paying
-- anything: fail closed, and no THR period exists in that window anyway.
--
-- Down, only while no THR_AVERAGE_WAGE input exists and no result rests on the new version
-- (SELECT count(*) FROM payroll_period_inputs WHERE input_key = 'THR_AVERAGE_WAGE' and
--  SELECT count(*) FROM payroll_results WHERE policy_version_ids ? '3c1e9b7a-64f2-4d0b-8a55-2f7d1c9e0b43'
--  must both be 0; otherwise keep the schema and open a new THR version without the two terms):
--   DELETE FROM payroll_policy_versions WHERE id = '3c1e9b7a-64f2-4d0b-8a55-2f7d1c9e0b43';
--   UPDATE payroll_policy_versions SET effective_to = NULL
--     WHERE policy_key = 'THR' AND effective_to = (the new version's effective_from - 1);
--   ALTER TABLE payroll_period_inputs DROP CONSTRAINT payroll_period_inputs_thr_average_wage_whole;
--   restore payroll_period_inputs_input_key_check, payroll_period_inputs_reason_required and
--   payroll_period_inputs_adjustment_has_decision as in 0069 (without THR_AVERAGE_WAGE).

-- 1. Period input --------------------------------------------------------------------------------
ALTER TABLE payroll_period_inputs DROP CONSTRAINT IF EXISTS payroll_period_inputs_input_key_check;
ALTER TABLE payroll_period_inputs
  ADD CONSTRAINT payroll_period_inputs_input_key_check CHECK (input_key IN (
    'OVERTIME_HOURS', 'CONTRACT_ATTENDANCE_DAYS', 'CONTRACT_TEACHING_HOURS',
    'CHILD_EDUCATION', 'PJ_MEDIA', 'ARREARS', 'ADJUSTMENT', 'PRORATION_FACTOR',
    'FULL_PAY_DESPITE_LEAVING', 'OTHER_INCOME',
    'TEACHING_HOURS_PER_WEEK_OVERRIDE', 'ANNUAL_PERFORMANCE_OVERRIDE',
    'MONTHLY_PERFORMANCE_OVERRIDE',
    'THR_AVERAGE_WAGE'
  ));

ALTER TABLE payroll_period_inputs DROP CONSTRAINT IF EXISTS payroll_period_inputs_reason_required;
ALTER TABLE payroll_period_inputs
  ADD CONSTRAINT payroll_period_inputs_reason_required CHECK (
    input_key NOT IN ('ADJUSTMENT', 'ARREARS', 'PRORATION_FACTOR', 'FULL_PAY_DESPITE_LEAVING', 'THR_AVERAGE_WAGE')
    OR length(trim(coalesce(reason, ''))) > 0
  );

-- Keeps its 0069 name: it now covers both inputs that rest on a decision.
ALTER TABLE payroll_period_inputs DROP CONSTRAINT IF EXISTS payroll_period_inputs_adjustment_has_decision;
ALTER TABLE payroll_period_inputs
  ADD CONSTRAINT payroll_period_inputs_adjustment_has_decision CHECK (
    input_key NOT IN ('ADJUSTMENT', 'THR_AVERAGE_WAGE')
    OR length(trim(coalesce(decision_reference, ''))) > 0
  );

-- Dropped and added like the three above rather than guarded by a pg_constraint lookup: that
-- catalog is not schema-scoped, so a lookup by name would skip the constraint in any second schema
-- of the same database (the recovery rehearsal migrates one).
ALTER TABLE payroll_period_inputs DROP CONSTRAINT IF EXISTS payroll_period_inputs_thr_average_wage_whole;
ALTER TABLE payroll_period_inputs
  ADD CONSTRAINT payroll_period_inputs_thr_average_wage_whole CHECK (
    input_key <> 'THR_AVERAGE_WAGE' OR (value > 0 AND value = trunc(value))
  );

-- 2. THR policy, second version --------------------------------------------------------------------
DO $$
DECLARE
  decision_date CONSTANT date := DATE '2026-11-17';
  new_version_id CONSTANT uuid := '3c1e9b7a-64f2-4d0b-8a55-2f7d1c9e0b43';
  open_version payroll_policy_versions%ROWTYPE;
  new_from date;
  eligible jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM payroll_policy_versions WHERE id = new_version_id) THEN
    RETURN;
  END IF;

  -- A version an operator already opened from the decision date on is theirs: nothing is closed
  -- or added behind it. The new rule is then opened from the policy screen.
  IF EXISTS (
    SELECT 1 FROM payroll_policy_versions WHERE policy_key = 'THR' AND effective_from >= decision_date
  ) THEN
    RAISE NOTICE 'PAY-003-THR 0167: a THR policy version already starts on or after %, left untouched; open the non-permanent version from the policy screen', decision_date;
    RETURN;
  END IF;

  SELECT * INTO open_version
  FROM payroll_policy_versions
  WHERE policy_key = 'THR' AND effective_to IS NULL
  ORDER BY effective_from DESC
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE NOTICE 'PAY-003-THR 0167: no open THR policy version to supersede; open the non-permanent version from the policy screen';
    RETURN;
  END IF;

  -- ADR-0003: an approved period stays reproducible. A THR period already approved keeps reading
  -- the version it was paid under, so the new one starts after the latest such pay date.
  SELECT greatest(decision_date, coalesce(max(pay_date) + 1, decision_date)) INTO new_from
  FROM payroll_periods
  WHERE period_kind = 'THR'
    AND state IN ('APPROVED', 'PAYMENT_CONFIRMED', 'PUBLISHED', 'REOPEN_REQUESTED');

  eligible := coalesce(open_version.payload -> 'eligibleTermCategories', '[]'::jsonb);
  eligible := eligible || coalesce(
    (SELECT jsonb_agg(term ORDER BY position)
     FROM unnest(ARRAY['KONTRAK_HONORER', 'LEPAS']) WITH ORDINALITY AS added(term, position)
     WHERE NOT eligible ? term),
    '[]'::jsonb
  );

  UPDATE payroll_policy_versions SET effective_to = new_from - 1 WHERE id = open_version.id;

  INSERT INTO payroll_policy_versions (id, policy_key, effective_from, effective_to, payload, source, note)
  VALUES (
    new_version_id, 'THR', new_from, NULL,
    open_version.payload || jsonb_build_object(
      'eligibleTermCategories', eligible,
      -- Section 2.1 H4 (DRAFT): the honorarium pay of PAY-003 section 5.2. THR itself, reimbursement
      -- hand-offs and one-off adjustments are not wages received.
      'averageWageComponents', '["TRANSPORT", "TEACH_FEE", "PJ_MEDIA", "OTHER_INCOME"]'::jsonb
    ),
    'Permenaker 6/2016 Pasal 2, 3, 5 ayat (4), 7; keputusan owner 2026-11-17',
    'Keputusan owner 2026-11-17: honorer dan pekerja lepas mendapat THR dari rata-rata upah 12 bulan (docs/domain/payroll-thr.md T5); rincian 2.1 (komponen, jendela, pembulatan) DRAFT menunggu konfirmasi process owner'
  );

  -- The same event the policy screen writes, so the change is on the payroll audit trail.
  INSERT INTO payroll_audit_events (id, actor_account_id, action, period_id, payload)
  VALUES (
    gen_random_uuid(), NULL, 'payroll.policy.version_opened', NULL,
    jsonb_build_object(
      'policy_key', 'THR',
      'effective_from', to_char(new_from, 'YYYY-MM-DD'),
      'origin', 'migration 0167_payroll_thr_non_permanent',
      'superseded_version_id', open_version.id
    )
  );
END;
$$;

COMMENT ON CONSTRAINT payroll_period_inputs_thr_average_wage_whole ON payroll_period_inputs IS
  'PAY-003-THR T5: the typed average monthly wage of an honorarium worker is a positive whole rupiah.';
