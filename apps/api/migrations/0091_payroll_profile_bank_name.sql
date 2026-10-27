-- PAY-003: the bank a payroll account belongs to.
-- Specification: docs/domain/payroll-calculation-v1.md sections 3.3, 7 and 10 item 7
--
-- The transfer list is specified as carrying the bank as well as the account
-- number and the holder's name, and the legacy flow routes between BSI and cash.
-- The compensation profile held the account but not the bank, so the column is
-- added here rather than inferred from the account number.
--
-- Nullable: profiles recorded before this migration do not know it, and a cash
-- recipient has no bank at all.
--
-- Down: ALTER TABLE payroll_compensation_profiles DROP COLUMN bank_name;

ALTER TABLE payroll_compensation_profiles
  ADD COLUMN IF NOT EXISTS bank_name text NULL;

COMMENT ON COLUMN payroll_compensation_profiles.bank_name IS
  'PAY-003 section 7: the bank the payroll account belongs to. NULL when unknown or paid in cash.';
