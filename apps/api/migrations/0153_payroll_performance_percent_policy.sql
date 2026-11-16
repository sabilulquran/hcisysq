-- PAY-003 / PERF-001: allow the PERFORMANCE_PERCENT policy key.
-- Specification: docs/domain/payroll-calculation-v1.md section 5.5,
-- docs/domain/performance-review.md section 11
--
-- The predicate -> performance percentage mapping is a versioned payroll
-- policy, and the version is also the switch: with no PERFORMANCE_PERCENT
-- version effective on a pay date (the state this migration leaves every
-- database in), or with `enabled: false`, payroll reads the compensation
-- profile exactly as before. This migration inserts no version.
--
-- Down (only while no PERFORMANCE_PERCENT version exists, or after exporting it):
--   DELETE FROM payroll_policy_versions WHERE policy_key = 'PERFORMANCE_PERCENT';
--   ALTER TABLE payroll_policy_versions DROP CONSTRAINT IF EXISTS payroll_policy_versions_policy_key_check;
--   ALTER TABLE payroll_policy_versions ADD CONSTRAINT payroll_policy_versions_policy_key_check
--     CHECK (policy_key IN (
--       'SALARY_SCALE', 'BASIC_MULTIPLIER', 'TEACHING_HOURS', 'PERFORMANCE', 'FAMILY',
--       'FUNCTIONAL_ALLOWANCE', 'POSITIONAL_ALLOWANCE', 'OVERTIME', 'BPJS_KESEHATAN',
--       'CONTRACT_RATES', 'EARLY_SERVICE', 'VARIANCE_THRESHOLD', 'PPH21_TER'));
-- A deleted version that a result references stays explainable through the
-- result's input_snapshot.performance_link; export it before deleting anyway.

-- The table is small (policy versions), but fail fast rather than queue a
-- payroll screen behind a long transaction.
SET LOCAL lock_timeout = '5s';

-- No IF EXISTS: 0069 always created this constraint under its default name,
-- and a silent no-op would leave the old CHECK refusing the new key.
ALTER TABLE payroll_policy_versions
  DROP CONSTRAINT payroll_policy_versions_policy_key_check;

ALTER TABLE payroll_policy_versions
  ADD CONSTRAINT payroll_policy_versions_policy_key_check
  CHECK (policy_key IN (
    'SALARY_SCALE', 'BASIC_MULTIPLIER', 'TEACHING_HOURS', 'PERFORMANCE', 'FAMILY',
    'FUNCTIONAL_ALLOWANCE', 'POSITIONAL_ALLOWANCE', 'OVERTIME', 'BPJS_KESEHATAN',
    'CONTRACT_RATES', 'EARLY_SERVICE', 'VARIANCE_THRESHOLD', 'PPH21_TER',
    'PERFORMANCE_PERCENT'
  ));
