-- PAY-003: per-person exclusion from the PPh21 TER report.
-- Specification: docs/domain/payroll-calculation-v1.md sections 3.3, 5.3 and 7
--
-- Section 5.3 keeps a person out of the PPh21 report only through an explicit
-- attribute with a reason, never through an employee number written into code.
-- The attribute belongs to the compensation profile, which is effective-dated,
-- so an exclusion has a start and an end like every other payroll fact, and the
-- report reads it from the profile the result was calculated from.
--
-- Additive only: existing profiles become "reported" (false) with no reason,
-- which is what every profile meant before this column existed.
--
-- Down:
--   ALTER TABLE payroll_compensation_profiles
--     DROP CONSTRAINT IF EXISTS payroll_compensation_profiles_pph21_exclusion_needs_reason,
--     DROP COLUMN IF EXISTS pph21_report_exclusion_reason,
--     DROP COLUMN IF EXISTS pph21_report_excluded;
-- No data is lost by the down step beyond the exclusions themselves; record
-- them (employment id, effective_from, reason) before dropping if any exist.

-- Adding a column with a constant default is metadata-only, but the ALTER still
-- takes a brief ACCESS EXCLUSIVE lock. Fail fast rather than queue a payroll
-- screen behind a long transaction; the runner wraps this file in one
-- transaction, so SET LOCAL ends with it.
SET LOCAL lock_timeout = '5s';

ALTER TABLE payroll_compensation_profiles
  ADD COLUMN IF NOT EXISTS pph21_report_excluded boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pph21_report_exclusion_reason text NULL;

ALTER TABLE payroll_compensation_profiles
  DROP CONSTRAINT IF EXISTS payroll_compensation_profiles_pph21_exclusion_needs_reason;

ALTER TABLE payroll_compensation_profiles
  ADD CONSTRAINT payroll_compensation_profiles_pph21_exclusion_needs_reason
    CHECK (NOT pph21_report_excluded OR length(trim(coalesce(pph21_report_exclusion_reason, ''))) > 0);

COMMENT ON COLUMN payroll_compensation_profiles.pph21_report_excluded IS
  'PAY-003 section 5.3: true keeps this employment out of the PPh21 TER report while the profile applies.';
COMMENT ON COLUMN payroll_compensation_profiles.pph21_report_exclusion_reason IS
  'PAY-003 section 5.3: why the employment is excluded from the PPh21 report. Required when excluded.';
