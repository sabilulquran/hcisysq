-- AUTH-002-INVITE: "Kirim aktivasi" in Account & Akses (OIDC mode). One row per attempt.
-- Spec: docs/domain/account-activation.md "AUTH-002-INVITE".
--
-- An attempt is recorded as `pending` and committed before HCIS calls SQ Hub (HUB-IMPL-024), so no
-- transaction is held across that call and every attempt counts for the resend limit. It becomes
-- `issued` (with the identity HCIS mapped from SQ Hub's answer and the per-channel results) or
-- `failed` (with an error code). No contact, token or link is stored: Keycloak itself creates and
-- e-mails the password link.
-- The first OIDC sign-in of an `invited` account with an open `issued` row for the same identity,
-- within 14 days, makes the account `active` and completes the row. Any later status change by an
-- administrator completes (active) or revokes (other statuses) open rows.
--
-- Down (no other table refers to this one):
--   DROP TABLE account_activation_invitations;

CREATE TABLE account_activation_invitations (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  issued_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  state text NOT NULL CHECK (state IN ('pending', 'issued', 'failed')),
  failure_code text NULL CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  identity_issuer text NULL CHECK (identity_issuer IS NULL OR length(identity_issuer) BETWEEN 1 AND 2048),
  identity_subject text NULL CHECK (identity_subject IS NULL OR length(identity_subject) BETWEEN 1 AND 512),
  email_status text NULL CHECK (email_status IN ('sent', 'not_needed', 'failed')),
  whatsapp_status text NULL
    CHECK (whatsapp_status IN ('pending', 'sent', 'dry_run', 'no_phone', 'not_allowlisted', 'failed', 'skipped')),
  hub_access text NULL CHECK (hub_access IN ('granted', 'already_active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  whatsapp_updated_at timestamptz NULL,
  completed_at timestamptz NULL,
  revoked_at timestamptz NULL,
  CHECK (completed_at IS NULL OR revoked_at IS NULL),
  CHECK (
    state <> 'issued'
    OR (identity_issuer IS NOT NULL AND identity_subject IS NOT NULL
        AND email_status IS NOT NULL AND whatsapp_status IS NOT NULL AND hub_access IS NOT NULL)
  )
);

CREATE INDEX account_activation_invitations_account_idx
  ON account_activation_invitations (account_id, created_at DESC);
