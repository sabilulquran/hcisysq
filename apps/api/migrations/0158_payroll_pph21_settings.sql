-- PAY-003: PPH21_SETTINGS policy key — PPh21 borne by the yayasan (PPH21_EMPLOYER,
-- decision P6) and daily TER for pegawai tidak tetap (21-100-03, decision P10).
-- Specification: docs/domain/payroll-calculation-v1.md section 7.5
--
-- Both switches live in a versioned policy row, off by default: without a row the
-- calculation and the reports behave exactly as before. This migration only lets
-- the key be written; it inserts no row.
--
-- Down (restores the 0155 constraint):
--   DELETE FROM payroll_policy_versions WHERE policy_key = 'PPH21_SETTINGS';  -- record the rows first
--   ALTER TABLE payroll_policy_versions DROP CONSTRAINT IF EXISTS payroll_policy_versions_policy_key_check;
--   ALTER TABLE payroll_policy_versions ADD CONSTRAINT payroll_policy_versions_policy_key_check
--     CHECK (policy_key IN ('SALARY_SCALE', 'BASIC_MULTIPLIER', 'TEACHING_HOURS', 'PERFORMANCE', 'FAMILY',
--       'FUNCTIONAL_ALLOWANCE', 'POSITIONAL_ALLOWANCE', 'OVERTIME', 'BPJS_KESEHATAN',
--       'CONTRACT_RATES', 'EARLY_SERVICE', 'VARIANCE_THRESHOLD', 'PPH21_TER', 'PERFORMANCE_PERCENT',
--       'PPH21_ANNUAL'));
-- PPH21_EMPLOYER lines already written by a calculation stay in their results;
-- recalculating a working period after the down step removes them.

-- The runner wraps the file in one transaction; the table is a few dozen rows and
-- lock_timeout bounds the wait.
SET LOCAL lock_timeout = '5s';

ALTER TABLE payroll_policy_versions DROP CONSTRAINT IF EXISTS payroll_policy_versions_policy_key_check;
ALTER TABLE payroll_policy_versions
  ADD CONSTRAINT payroll_policy_versions_policy_key_check CHECK (policy_key IN (
    'SALARY_SCALE', 'BASIC_MULTIPLIER', 'TEACHING_HOURS', 'PERFORMANCE', 'FAMILY',
    'FUNCTIONAL_ALLOWANCE', 'POSITIONAL_ALLOWANCE', 'OVERTIME', 'BPJS_KESEHATAN',
    'CONTRACT_RATES', 'EARLY_SERVICE', 'VARIANCE_THRESHOLD', 'PPH21_TER', 'PERFORMANCE_PERCENT',
    'PPH21_ANNUAL', 'PPH21_SETTINGS'
  ));
