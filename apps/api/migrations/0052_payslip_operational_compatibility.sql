ALTER TABLE payslip_import_batches
  ADD COLUMN IF NOT EXISTS source_format text NOT NULL DEFAULT 'generic'
  CHECK (source_format IN ('generic', 'tetap', 'honorer'));

ALTER TABLE payslips
  ADD COLUMN IF NOT EXISTS source_format text NOT NULL DEFAULT 'generic'
  CHECK (source_format IN ('generic', 'tetap', 'honorer'));

COMMENT ON COLUMN payslip_import_batches.source_format IS
  'PAYSLIP-002 import presentation shape; generic, tetap, or honorer. No payroll calculation semantics.';

COMMENT ON COLUMN payslips.source_format IS
  'PAYSLIP-002 presentation metadata copied from source batch; published values remain imported display data.';
