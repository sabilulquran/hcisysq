-- ATT-011-4 §5.3 Perubahan Jadwal: one change set per "Atur / Ganti / Salin jadwal", applied atomically
-- after a preview, never edited afterwards (a later change set corrects it). Items record each assignment
-- or roster change with its before/after state, which is also the recovery path.
-- Additive: the previous release never reads these tables or columns. Rollback (once unused):
--   ALTER TABLE attendance_rosters DROP COLUMN change_set_id;
--   ALTER TABLE attendance_schedule_assignments DROP COLUMN change_set_id;
--   DROP TABLE attendance_schedule_change_items; DROP TABLE attendance_schedule_change_sets;
CREATE TABLE IF NOT EXISTS attendance_schedule_change_sets (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('pattern', 'replacement', 'copy', 'revert')),
  status text NOT NULL DEFAULT 'applied' CHECK (status IN ('applied')),
  requested_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  applied_at timestamptz NOT NULL DEFAULT now(),
  note text NULL CHECK (note IS NULL OR char_length(note) <= 500),
  input jsonb NOT NULL,
  scope_summary jsonb NOT NULL,
  preview_fingerprint text NOT NULL CHECK (preview_fingerprint ~ '^[0-9a-f]{64}$'),
  idempotency_key text NULL CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 8 AND 128),
  reverts_change_set_id uuid NULL REFERENCES attendance_schedule_change_sets(id) ON DELETE RESTRICT,
  UNIQUE (idempotency_key)
);
CREATE INDEX IF NOT EXISTS attendance_schedule_change_sets_applied_idx
  ON attendance_schedule_change_sets (applied_at DESC, id);

CREATE TABLE IF NOT EXISTS attendance_schedule_change_items (
  id uuid PRIMARY KEY,
  change_set_id uuid NOT NULL REFERENCES attendance_schedule_change_sets(id) ON DELETE RESTRICT,
  sequence integer NOT NULL CHECK (sequence >= 1),
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN (
    'assignment_created', 'assignment_ended', 'assignment_removed', 'roster_entry_set', 'roster_entry_off',
    'roster_entry_cleared'
  )),
  work_date_from date NOT NULL,
  work_date_to date NULL,
  weekday_mask integer NULL CHECK (weekday_mask IS NULL OR weekday_mask BETWEEN 1 AND 127),
  schedule_template_id uuid NULL REFERENCES attendance_schedule_templates(id) ON DELETE RESTRICT,
  before_state jsonb NULL,
  after_state jsonb NULL,
  UNIQUE (change_set_id, sequence)
);
CREATE INDEX IF NOT EXISTS attendance_schedule_change_items_employee_idx
  ON attendance_schedule_change_items (employee_id, work_date_from);

ALTER TABLE attendance_schedule_assignments
  ADD COLUMN IF NOT EXISTS change_set_id uuid NULL REFERENCES attendance_schedule_change_sets(id) ON DELETE RESTRICT;
ALTER TABLE attendance_rosters
  ADD COLUMN IF NOT EXISTS change_set_id uuid NULL REFERENCES attendance_schedule_change_sets(id) ON DELETE RESTRICT;
