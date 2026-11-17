-- PAY-003: PAYSLIP_LAYOUT policy key — the payslip block "Ditanggung yayasan"
-- (owner decision 2026-11-17).
-- Specification: docs/domain/payroll-calculation-v1.md section 7.6
--
-- With a PAYSLIP_LAYOUT version whose employerBlock is true in force on a
-- period's pay date, the slips drafted from that period no longer list the BPJS
-- Kesehatan contribution the yayasan bears as income and as an equal deduction:
-- it is shown, with PPh21 the yayasan bears, in a block of its own, and net pay
-- is unchanged. Without a version the slips are laid out exactly as before.
--
-- This migration only lets the key be written; it inserts no row, changes no
-- payslip and no payroll result, and grants no permission. Opening a version is
-- the existing POST /payroll/policies (payroll.policies.manage), audited as any
-- other policy version.
--
-- Down (restores the constraint of 0164):
--   DELETE FROM payroll_policy_versions WHERE policy_key = 'PAYSLIP_LAYOUT';  -- record the rows first
--   ALTER TABLE payroll_policy_versions DROP CONSTRAINT IF EXISTS payroll_policy_versions_policy_key_check;
--   ALTER TABLE payroll_policy_versions ADD CONSTRAINT payroll_policy_versions_policy_key_check
--     CHECK (policy_key IN ('SALARY_SCALE', 'BASIC_MULTIPLIER', 'TEACHING_HOURS', 'PERFORMANCE', 'FAMILY',
--       'FUNCTIONAL_ALLOWANCE', 'POSITIONAL_ALLOWANCE', 'OVERTIME', 'BPJS_KESEHATAN',
--       'CONTRACT_RATES', 'EARLY_SERVICE', 'VARIANCE_THRESHOLD', 'PPH21_TER', 'PERFORMANCE_PERCENT',
--       'PPH21_ANNUAL', 'PPH21_SETTINGS', 'THR'));
-- Slips already drafted with the block keep their lines (a published slip is
-- never edited); drafting an unpublished one again after the down step rebuilds
-- it in the earlier layout.

-- The runner wraps the file in one transaction; the table is a few dozen rows and
-- lock_timeout bounds the wait.
SET LOCAL lock_timeout = '5s';

ALTER TABLE payroll_policy_versions DROP CONSTRAINT IF EXISTS payroll_policy_versions_policy_key_check;
ALTER TABLE payroll_policy_versions
  ADD CONSTRAINT payroll_policy_versions_policy_key_check CHECK (policy_key IN (
    'SALARY_SCALE', 'BASIC_MULTIPLIER', 'TEACHING_HOURS', 'PERFORMANCE', 'FAMILY',
    'FUNCTIONAL_ALLOWANCE', 'POSITIONAL_ALLOWANCE', 'OVERTIME', 'BPJS_KESEHATAN',
    'CONTRACT_RATES', 'EARLY_SERVICE', 'VARIANCE_THRESHOLD', 'PPH21_TER', 'PERFORMANCE_PERCENT',
    'PPH21_ANNUAL', 'PPH21_SETTINGS', 'THR', 'PAYSLIP_LAYOUT'
  ));
