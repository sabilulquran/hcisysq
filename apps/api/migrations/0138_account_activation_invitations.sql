-- AUTH-002-INVITE: "Kirim aktivasi" in Account & Akses (OIDC mode). One row per send.
-- Spec: docs/domain/account-activation.md "AUTH-002-INVITE".
--
-- A row records that SQ Hub prepared the Akun SQ for this account (HUB-IMPL-024), which identity
-- HCIS mapped from that answer, and what happened on each channel. It holds no contact, token or
-- link: the password link is created and e-mailed by Keycloak itself.
-- The first OIDC sign-in of an `invited` account with an open row for the same identity makes the
-- account `active` and closes the row. Suspending or deactivating the account revokes open rows.
--
-- Down (no other table refers to this one):
--   DROP TABLE account_activation_invitations;

CREATE TABLE account_activation_invitations (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  issued_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  identity_issuer text NOT NULL CHECK (length(identity_issuer) BETWEEN 1 AND 2048),
  identity_subject text NOT NULL CHECK (length(identity_subject) BETWEEN 1 AND 512),
  email_status text NOT NULL CHECK (email_status IN ('sent', 'not_needed', 'failed')),
  whatsapp_status text NOT NULL
    CHECK (whatsapp_status IN ('pending', 'sent', 'dry_run', 'no_phone', 'not_allowlisted', 'failed', 'skipped')),
  hub_access text NOT NULL CHECK (hub_access IN ('granted', 'already_active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  whatsapp_updated_at timestamptz NULL,
  completed_at timestamptz NULL,
  revoked_at timestamptz NULL,
  CHECK (completed_at IS NULL OR revoked_at IS NULL)
);

CREATE INDEX account_activation_invitations_account_idx
  ON account_activation_invitations (account_id, created_at DESC);
