-- PAY-003: record which compensation profile a payroll result was calculated from.
-- Specification: docs/domain/payroll-calculation-v1.md section 3.3 and section 6
--
-- A result already stores the policy versions it used. The compensation profile
-- was resolved by date alone, so nothing on the result said which row it read.
-- That is the other half of "a result is a fact": with both recorded, a past
-- period can be explained exactly as it was paid, even after the profile moves on.
--
-- Nullable, because results written before this migration cannot be told.
--
-- Down: ALTER TABLE payroll_results DROP COLUMN compensation_profile_id;

ALTER TABLE payroll_results
  ADD COLUMN IF NOT EXISTS compensation_profile_id uuid NULL
    REFERENCES payroll_compensation_profiles(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS payroll_results_profile_idx
  ON payroll_results (compensation_profile_id)
  WHERE compensation_profile_id IS NOT NULL;
