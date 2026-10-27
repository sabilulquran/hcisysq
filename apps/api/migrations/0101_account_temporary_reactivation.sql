-- EMP-005 Package 1 step S5A (spec §8.5, owner decision D-15, 2026-10-16).
--
-- When an employment ends, the linked HCIS login account is deactivated
-- automatically. A former employee who still needs access for a short while
-- (own payslips, own attendance history, own leave history) gets an explicit,
-- time-boxed reactivation granted by an HC Admin: never an open-ended status
-- flip. Maximum 30 days, mandatory reason, mandatory expiry.
--
-- Additive only.
--
-- Down (valid while no grant has been used in production):
--   DROP TABLE IF EXISTS account_temporary_reactivations;
--   DELETE FROM role_permissions WHERE permission_key = 'access.accounts.temporary_reactivate';
--   DELETE FROM permissions WHERE permission_key = 'access.accounts.temporary_reactivate';
-- Accounts already deactivated by a termination stay inactive (fail closed);
-- access administration reactivates them through the normal flow if needed.

CREATE TABLE IF NOT EXISTS account_temporary_reactivations (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(trim(reason)) >= 10),
  starts_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  granted_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  revoked_at timestamptz NULL,
  revoked_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_temporary_reactivations_window_check
    CHECK (expires_at > starts_at AND expires_at <= starts_at + interval '30 days'),
  -- A grant ends either because someone revoked it (then we know who) or
  -- because it expired and the daily job closed it (then nobody did).
  CONSTRAINT account_temporary_reactivations_revoked_check
    CHECK (revoked_by_account_id IS NULL OR revoked_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS account_temporary_reactivations_account_idx
  ON account_temporary_reactivations (account_id, expires_at DESC);

-- One live grant per account: extending means revoking and granting again, so
-- the audit trail always names who extended the access and why.
CREATE UNIQUE INDEX IF NOT EXISTS account_temporary_reactivations_live_idx
  ON account_temporary_reactivations (account_id)
  WHERE revoked_at IS NULL;

INSERT INTO permissions (permission_key, description)
VALUES (
  'access.accounts.temporary_reactivate',
  'EMP-005 D-15: grant a time-boxed reactivation to a former employee account (max 30 days)'
)
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, 'access.accounts.temporary_reactivate'
FROM roles role
WHERE role.role_key = 'human_capital_admin'
ON CONFLICT DO NOTHING;
