-- EMP-001: Employee population membership is separate from employment status.
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS removed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS removed_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS removal_reason text NULL;

ALTER TABLE employees
  ADD CONSTRAINT employees_removal_metadata_check
  CHECK ((removed_at IS NULL AND removed_by_account_id IS NULL AND removal_reason IS NULL)
      OR (removed_at IS NOT NULL AND removal_reason IS NOT NULL));

CREATE INDEX IF NOT EXISTS employees_removed_at_idx ON employees (removed_at);

CREATE TABLE IF NOT EXISTS employee_import_source_snapshots (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  import_job_id uuid NOT NULL REFERENCES employee_import_jobs(id) ON DELETE RESTRICT,
  row_number integer NOT NULL CHECK (row_number > 0),
  source_filename text NOT NULL,
  source_sheet text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  source_data jsonb NOT NULL,
  unmodeled_source_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (import_job_id, row_number)
);
CREATE INDEX IF NOT EXISTS employee_import_source_snapshots_employee_idx
  ON employee_import_source_snapshots (employee_id, imported_at DESC);
