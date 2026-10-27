-- ORG-008-9 (owner decision 2026-10-27): which structural seat an administrative role is meant to
-- follow, so a difference between the two can be shown. docs/domain/organization-designer-ux-spec.md 8.
--
-- Why: the Kepala HC role (0065) is granted by hand, while who actually holds the Kepala HC seat is
-- recorded in the organization structure. When the seat changes hands the role does not move with
-- it, so the previous holder could keep publishing structure. AUTH-011 forbids deriving
-- administrative permission from a position, so nothing here grants or revokes anything: the link
-- only lets the Akses screen warn when the role holders and the seat holders differ.
--
-- One row per role. The seat is a position stable key from the published structure; it is chosen
-- by Super Admin, never inferred from a title. Nothing is seeded.
--
-- Rollback/recovery:
--   DROP TABLE IF EXISTS access_role_position_links;
--   Roles, assignments, permissions and structure are untouched either way; only the warning goes.
--   The access_audit_events rows recording who set the link are kept.
--
-- Idempotent: rerunning changes nothing further.

CREATE TABLE IF NOT EXISTS access_role_position_links (
  role_key text PRIMARY KEY REFERENCES roles(role_key) ON DELETE CASCADE,
  position_key uuid NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  set_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  set_at timestamptz NOT NULL DEFAULT now()
);
