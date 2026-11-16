-- PAY-003: annual PPh21 (Pasal 17) for the final masa pajak, bukti potong
-- 1721-A1, and the tax identity it needs.
-- Specification: docs/domain/payroll-calculation-v1.md sections 7.4 and 8
--
-- 1. Policy key PPH21_ANNUAL: PTKP, biaya jabatan, the Pasal 17 layers and the
--    PKP rounding unit are a versioned policy row like PPH21_TER, never code.
-- 2. payroll_tax_identities: the NIK and NPWP a 1721-A1 must print. HCIS did
--    not store either. Both are kept sealed (AES-256-GCM, key derived from the
--    server key; tax-identity-crypto.ts), never in clear, and only the last four
--    digits are kept readable for the masked display. No route returns the
--    sealed value; only the 1721-A1 document and its recap export open it.
--
-- Down:
--   DROP TABLE IF EXISTS payroll_tax_identities;
--   ALTER TABLE payroll_policy_versions DROP CONSTRAINT IF EXISTS payroll_policy_versions_policy_key_check;
--   DELETE FROM payroll_policy_versions WHERE policy_key = 'PPH21_ANNUAL';  -- record the rows first
--   ALTER TABLE payroll_policy_versions ADD CONSTRAINT payroll_policy_versions_policy_key_check
--     CHECK (policy_key IN ('SALARY_SCALE', 'BASIC_MULTIPLIER', 'TEACHING_HOURS', 'PERFORMANCE', 'FAMILY',
--       'FUNCTIONAL_ALLOWANCE', 'POSITIONAL_ALLOWANCE', 'OVERTIME', 'BPJS_KESEHATAN',
--       'CONTRACT_RATES', 'EARLY_SERVICE', 'VARIANCE_THRESHOLD', 'PPH21_TER'));
-- Dropping the table loses the stored NIK/NPWP; they are re-entered from the
-- source documents, never from a dump.

SET LOCAL lock_timeout = '5s';

-- The inline CHECK of 0069 carries PostgreSQL's default name. NOT VALID then
-- VALIDATE, as 0147 does, so the scan runs under SHARE UPDATE EXCLUSIVE.
ALTER TABLE payroll_policy_versions DROP CONSTRAINT IF EXISTS payroll_policy_versions_policy_key_check;
ALTER TABLE payroll_policy_versions
  ADD CONSTRAINT payroll_policy_versions_policy_key_check CHECK (policy_key IN (
    'SALARY_SCALE', 'BASIC_MULTIPLIER', 'TEACHING_HOURS', 'PERFORMANCE', 'FAMILY',
    'FUNCTIONAL_ALLOWANCE', 'POSITIONAL_ALLOWANCE', 'OVERTIME', 'BPJS_KESEHATAN',
    'CONTRACT_RATES', 'EARLY_SERVICE', 'VARIANCE_THRESHOLD', 'PPH21_TER', 'PPH21_ANNUAL'
  )) NOT VALID;
ALTER TABLE payroll_policy_versions VALIDATE CONSTRAINT payroll_policy_versions_policy_key_check;

CREATE TABLE IF NOT EXISTS payroll_tax_identities (
  employee_id uuid PRIMARY KEY REFERENCES employees(id) ON DELETE RESTRICT,
  -- "v1.<iv>.<tag>.<ciphertext>", base64url; NULL when not recorded.
  nik_sealed text NULL,
  nik_last4 text NULL CHECK (nik_last4 IS NULL OR nik_last4 ~ '^[0-9]{4}$'),
  npwp_sealed text NULL,
  npwp_last4 text NULL CHECK (npwp_last4 IS NULL OR npwp_last4 ~ '^[0-9]{4}$'),
  updated_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_tax_identities_nik_pair CHECK ((nik_sealed IS NULL) = (nik_last4 IS NULL)),
  CONSTRAINT payroll_tax_identities_npwp_pair CHECK ((npwp_sealed IS NULL) = (npwp_last4 IS NULL))
);

COMMENT ON TABLE payroll_tax_identities IS
  'PAY-003 section 7.4: NIK/NPWP for the bukti potong 1721-A1, sealed with AES-256-GCM. Never logged or audited.';
