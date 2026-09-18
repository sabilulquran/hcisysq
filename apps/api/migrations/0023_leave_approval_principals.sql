-- Add governance-account approval principals without rewriting historic employee steps.
ALTER TABLE leave_request_approval_steps
  ALTER COLUMN approver_employee_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS approver_account_id uuid NULL REFERENCES accounts(id) ON DELETE RESTRICT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'leave_request_approval_steps_exactly_one_principal'
  ) THEN
    ALTER TABLE leave_request_approval_steps
      ADD CONSTRAINT leave_request_approval_steps_exactly_one_principal
      CHECK (num_nonnulls(approver_employee_id, approver_account_id) = 1);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS leave_request_approval_steps_account_inbox_idx
  ON leave_request_approval_steps (approver_account_id, status, created_at DESC)
  WHERE approver_account_id IS NOT NULL;

ALTER TABLE leave_notification_outbox
  DROP CONSTRAINT IF EXISTS leave_notification_outbox_target_type_check;

ALTER TABLE leave_notification_outbox
  ADD CONSTRAINT leave_notification_outbox_target_type_check
  CHECK (target_type IN ('employee', 'account', 'role'));

INSERT INTO permissions (permission_key, description)
VALUES ('leave.governance.approve', 'Approve an explicitly snapshotted governance Leave step')
ON CONFLICT (permission_key) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO roles (id, role_key, name, description, is_system)
VALUES (
  '10000000-0000-4000-8000-000000000006',
  'governance_leave_approver',
  'Governance Leave Approver',
  'Minimum capability for an explicitly selected Foundation Board Leave authority.',
  true
)
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT id, 'leave.governance.approve' FROM roles WHERE role_key = 'governance_leave_approver'
ON CONFLICT DO NOTHING;
