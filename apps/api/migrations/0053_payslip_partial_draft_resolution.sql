ALTER TABLE payslip_import_rows
  ADD COLUMN IF NOT EXISTS resolution_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS draft_payslip_id uuid NULL REFERENCES payslips(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS excluded_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS excluded_at timestamptz NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payslip_import_rows_resolution_status_check'
  ) THEN
    ALTER TABLE payslip_import_rows
      ADD CONSTRAINT payslip_import_rows_resolution_status_check
      CHECK (resolution_status IN ('pending', 'drafted', 'excluded'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payslip_import_rows_resolution_consistency_check'
  ) THEN
    ALTER TABLE payslip_import_rows
      ADD CONSTRAINT payslip_import_rows_resolution_consistency_check
      CHECK (
        (resolution_status = 'pending'
          AND draft_payslip_id IS NULL
          AND excluded_at IS NULL
          AND excluded_by_account_id IS NULL)
        OR
        (resolution_status = 'drafted'
          AND draft_payslip_id IS NOT NULL
          AND excluded_at IS NULL
          AND excluded_by_account_id IS NULL)
        OR
        (resolution_status = 'excluded'
          AND draft_payslip_id IS NULL
          AND excluded_at IS NOT NULL
          AND excluded_by_account_id IS NOT NULL)
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS payslip_import_rows_draft_payslip_uidx
  ON payslip_import_rows (draft_payslip_id)
  WHERE draft_payslip_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS payslip_import_rows_resolution_idx
  ON payslip_import_rows (batch_id, resolution_status, row_number);

COMMENT ON COLUMN payslip_import_rows.resolution_status IS
  'PAYSLIP-003 lifecycle: pending, drafted, or explicitly excluded.';
COMMENT ON COLUMN payslip_import_rows.draft_payslip_id IS
  'Draft payslip created from this row; null until successfully drafted.';
COMMENT ON COLUMN payslip_import_rows.excluded_at IS
  'Soft exclusion timestamp; excluded rows remain auditable and are never silently dropped.';
