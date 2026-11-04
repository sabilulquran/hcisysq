-- AUTH-015 (ADR-0007, owner decision 2026-11-04): an administrative role follows a seat in the
-- published organization structure. docs/domain/role-follows-seat.md.
--
-- Owner, verbatim: "jangan bound ke orang, tapi ke struktur organisasi biar kalau resign itu
-- otomatis ke penggantinya". Until now (ORG-008-9, migration 0066) a role↔seat link only produced a
-- warning, because AUTH-011 forbade deriving administrative permission from a position. ADR-0007
-- supersedes that clause: whoever holds a linked seat today (PRIMARY or ACTING, in the latest
-- published change set, effective-dated) holds the role, evaluated on every request.
--
-- What this migration does:
--   1. access_role_position_links may hold several seats per role: the primary key becomes
--      (role_key, position_key). A seat may serve several roles too. Rows are kept as they are
--      (production holds none on 2026-11-04).
--   2. hcis_seat_role_holders(as_of): every incumbent of a linked seat on that date, with the
--      account and employee state that decides whether the role is effective. Read by the Akses
--      screen, which must also show holders whose role is NOT effective yet (account invited).
--   3. hcis_seat_permissions(as_of, for_account): the permissions a seat actually confers. Only an
--      active EMPLOYEE account of an active, not-removed employee; never an `access.*` permission,
--      so identity and role administration can never come from a seat, even if a later migration
--      adds such a permission to a linked role (ADR-0007 G-1).
--
-- Nothing is linked here, and nothing is granted: until a link row exists both functions return
-- no rows, so this migration changes no one's effective permissions.
--
-- Deployment order: the build that reads these functions must ship together with this migration
-- (the old build keeps reading only account_role_assignments, which is still correct while no link
-- exists; the old PUT route would fail on a role with two seats, which cannot exist before the new
-- build creates one).
--
-- Rollback/recovery:
--   DROP FUNCTION IF EXISTS hcis_seat_permissions(date, uuid);
--   DROP FUNCTION IF EXISTS hcis_seat_role_holders(date);
--   -- Only if every role has at most one seat (otherwise remove the extra links first through
--   -- DELETE /admin/access/role-seat-links/:roleKey/:positionKey, which audits them):
--   ALTER TABLE access_role_position_links DROP CONSTRAINT access_role_position_links_pkey;
--   ALTER TABLE access_role_position_links ADD PRIMARY KEY (role_key);
--   DROP INDEX IF EXISTS access_role_position_links_position_idx;
--   Effect of rollback with the old build: links become warnings again and every seat-derived
--   permission disappears at the next request. access_audit_events rows are never deleted.
--
-- Idempotent: rerunning changes nothing further.

-- The function bodies name employees.removed_at (0022). The organization recovery rehearsal
-- applies the canonical files before the recovered ones, so creation-time body checking would
-- refuse this file there; bodies are still checked on first call. Scoped to this transaction.
SET LOCAL check_function_bodies = off;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'access_role_position_links_pkey'
       AND conrelid = 'access_role_position_links'::regclass
       AND array_length(conkey, 1) = 1
  ) THEN
    ALTER TABLE access_role_position_links DROP CONSTRAINT access_role_position_links_pkey;
    ALTER TABLE access_role_position_links ADD PRIMARY KEY (role_key, position_key);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS access_role_position_links_position_idx
  ON access_role_position_links (position_key);

-- The structure in force on a date is the latest PUBLISHED change set effective on or before it,
-- ordered exactly like PostgresOrganizationRepository.loadEffectiveSnapshot, so the permission
-- engine and every screen that shows the structure agree on who sits where.
CREATE OR REPLACE FUNCTION hcis_seat_role_holders(as_of date)
RETURNS TABLE (
  role_key text,
  position_key uuid,
  change_set_id uuid,
  employee_id uuid,
  incumbency_kind text,
  account_id uuid,
  account_status text,
  employee_active boolean
)
LANGUAGE sql STABLE AS $$
  WITH structure AS (
    SELECT id FROM organization_change_sets
     WHERE status = 'PUBLISHED' AND effective_on <= as_of
     ORDER BY effective_on DESC, published_at DESC, created_at DESC, id DESC
     LIMIT 1
  )
  SELECT DISTINCT ON (link.role_key, position.stable_key, incumbency.employee_id)
         link.role_key, position.stable_key, structure.id, incumbency.employee_id, incumbency.kind,
         account.id, account.status,
         (employee.status = 'active' AND employee.removed_at IS NULL)
    FROM structure
    JOIN organization_positions position ON position.change_set_id = structure.id
    JOIN access_role_position_links link ON link.position_key = position.stable_key
    JOIN organization_incumbencies incumbency
      ON incumbency.change_set_id = structure.id AND incumbency.position_key = position.stable_key
    JOIN employees employee ON employee.id = incumbency.employee_id
    LEFT JOIN accounts account ON account.employee_id = employee.id AND account.principal_type = 'EMPLOYEE'
   WHERE position.active
     AND position.holder_source = 'EMPLOYEE'
     AND position.effective_from <= as_of
     AND (position.effective_to IS NULL OR position.effective_to >= as_of)
     AND incumbency.kind IN ('PRIMARY', 'ACTING')
     AND incumbency.employee_id IS NOT NULL
     AND incumbency.effective_from <= as_of
     AND (incumbency.effective_to IS NULL OR incumbency.effective_to >= as_of)
   -- One row per person per seat; PRIMARY wins over ACTING when both are recorded.
   ORDER BY link.role_key, position.stable_key, incumbency.employee_id,
            CASE incumbency.kind WHEN 'PRIMARY' THEN 0 ELSE 1 END
$$;

CREATE OR REPLACE FUNCTION hcis_seat_permissions(as_of date, for_account uuid DEFAULT NULL)
RETURNS TABLE (account_id uuid, permission_key text, role_key text, position_key uuid)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT holder.account_id, role_permission.permission_key, holder.role_key, holder.position_key
    FROM hcis_seat_role_holders(as_of) holder
    JOIN roles role ON role.role_key = holder.role_key
    JOIN role_permissions role_permission ON role_permission.role_id = role.id
   WHERE holder.account_id IS NOT NULL
     AND holder.account_status = 'active'
     AND holder.employee_active
     AND (for_account IS NULL OR holder.account_id = for_account)
     -- ADR-0007 G-1: identity, account and role administration never follow a seat.
     AND role_permission.permission_key NOT LIKE 'access.%'
$$;
