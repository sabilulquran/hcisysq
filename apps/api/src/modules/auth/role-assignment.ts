import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { AuthError, type AuthPrincipal } from "./service.js";
import {
  ACCESS_REACTIVATION_PERMISSION,
  ADMIN_PERMISSIONS, ANNOUNCEMENT_PERMISSIONS, BOARD_READ_PERMISSION, BOARD_VIEWER_ROLE_KEY,
  DOCUMENT_CORRECTOR_ROLE_KEY, DOCUMENT_PERMISSIONS, EMPLOYMENT_PERMISSIONS,
  HC_OPERATIONAL_PERMISSIONS,
  hasEffectiveOrganizationPermission,
  HC_LEAD_ROLE_KEY, IDENTITY_PERMISSIONS, JOB_CLASSIFICATION_PERMISSIONS,
  MODULE_ADMIN_ROLE_KEY, PAYROLL_PERMISSIONS, PAYROLL_ROLE_KEYS,
} from "./permissions.js";
import { assertAssignmentDates, assertAssignmentScope } from "../employees/org-access-policy.js";

const HCIS_ROLES = [
  "human_capital", "human_capital_admin", "unit_manager", "finance", "management", "special_approver", BOARD_VIEWER_ROLE_KEY,
  HC_LEAD_ROLE_KEY, DOCUMENT_CORRECTOR_ROLE_KEY, MODULE_ADMIN_ROLE_KEY, ...PAYROLL_ROLE_KEYS,
];
const HCIS_PERMISSIONS: readonly string[] = [
  ...ADMIN_PERMISSIONS, ...HC_OPERATIONAL_PERMISSIONS, ...EMPLOYMENT_PERMISSIONS, ...DOCUMENT_PERMISSIONS, ...ANNOUNCEMENT_PERMISSIONS,
  ...JOB_CLASSIFICATION_PERMISSIONS,
  ACCESS_REACTIVATION_PERMISSION,
  "employees.read.unit", "attendance.read.unit",
  "leave.approve", "leave.hc.approve", "reports.read.organization", "reports.export.organization", BOARD_READ_PERMISSION,
  ...PAYROLL_PERMISSIONS,
  // AUTH-014 §2.6: IDENTITY_PERMISSIONS are deliberately absent. They live in ADMIN_PERMISSIONS,
  // which legacy Super Admin compatibility still reads, but no role may carry them.
].filter((key) => !(IDENTITY_PERMISSIONS as readonly string[]).includes(key));

/**
 * AUTH-014 §2.5, §3.1: where the authority to grant a role comes from.
 *
 * `"break_glass"` is the SUPER_ADMIN principal acting through the existing HTTP routes — the
 * fallback for when SQ Hub is unavailable. `"sq_hub"` is the machine channel, where the Platform
 * Administrator has already been checked on the other side and HCIS has verified *which human* is
 * acting from a Keycloak-signed assertion.
 *
 * There is no third channel, and no HCIS permission confers this: a value of this type can only be
 * produced by a route that has already established its own precondition.
 */
export type GrantChannel = "sq_hub" | "break_glass";

export interface AssignableRole { roleKey: string; permissions: string[] }
export interface RoleAssignmentInput {
  roleId: string;
  scopeType: "own" | "unit" | "organization";
  organizationalUnitId?: string | null | undefined;
  startsOn?: string | null | undefined;
  endsOn?: string | null | undefined;
  reason?: string | null | undefined;
}

export type AssignmentScope = RoleAssignmentInput["scopeType"];

// AUTH-011 §Scope per peran (2026-10-30): permission guards read organization-scoped assignments
// only. A unit-scoped one names who serves a unit (ATT-011 reads it), and authority eligibility
// (organization/repository.ts capabilityValid) accepts any scope, which is why Kepala Unit stays
// unit-scoped. Each role works with exactly the scopes listed here and the screen offers no other;
// anything not listed is organization-only. "own" works for no role: self-service needs none.
const ROLE_SCOPES: Readonly<Record<string, readonly AssignmentScope[]>> = {
  human_capital: ["organization", "unit"],
  unit_manager: ["unit"],
};

export function allowedScopes(roleKey: string): readonly AssignmentScope[] {
  return ROLE_SCOPES[roleKey] ?? ["organization"];
}

const SCOPE_WORDS: Record<AssignmentScope, string> = {
  organization: "seluruh organisasi",
  unit: "satu unit",
  own: "diri sendiri",
};

function assertRoleScope(roleKey: string, scope: AssignmentScope): void {
  const scopes = allowedScopes(roleKey);
  if (scopes.includes(scope)) return;
  throw new AuthError(400, "ROLE_SCOPE_NOT_ALLOWED",
    `Peran ini hanya berlaku untuk ${scopes.map((item) => SCOPE_WORDS[item]).join(" atau ")}.`);
}

/**
 * AUTH-014 §2.6: a role carrying an identity permission is refused outright, whatever the channel
 * and whatever else is true of it. Checked against the role's stored permissions, never against a
 * list the caller supplied.
 */
export function carriesIdentityPermission(role: AssignableRole): boolean {
  return role.permissions.some((key) => (IDENTITY_PERMISSIONS as readonly string[]).includes(key));
}

export function canDelegateRole(role: AssignableRole, delegated: boolean, channel?: GrantChannel): boolean {
  if (!HCIS_ROLES.includes(role.roleKey) || !role.permissions.length) return false;
  if (carriesIdentityPermission(role)) return false;
  if (!role.permissions.every((key) => HCIS_PERMISSIONS.includes(key))) return false;
  // AUTH-014 §2.5: on either channel the authority comes from the channel, not from a permission
  // the actor holds. Keeping the old `delegated` requirement here would make the whole thing
  // unusable: access.roles.assign was removed from every role by migration 0057 and may never be
  // granted again, so no actor can hold it, and without it only human_capital would be grantable.
  return channel !== undefined || delegated || (role.roleKey === "human_capital"
    && role.permissions.every((key) => (HC_OPERATIONAL_PERMISSIONS as readonly string[]).includes(key)));
}

/**
 * AUTH-014 §2.5, §3.1 (supersedes the 2026-10-16 rule that only Super Admin may grant).
 *
 * `"break_glass"` keeps the old behaviour exactly: SUPER_ADMIN and nobody else. `"sq_hub"` admits
 * the employee account the channel resolved from a signed actor assertion — the Platform
 * Administrator working from their ordinary account, which is the point of ADR-0006 D-3.
 *
 * Note what this deliberately does NOT read: any permission of the actor's. Break-glass authority
 * used to arrive through `hasLegacySuperAdminCompatibility`, so removing that shim — which
 * AUTH-011 schedules — would have silently killed the fallback. It now stands on the channel.
 */
export function assertRoleGrantor(actor: AuthPrincipal, channel: GrantChannel): void {
  if (channel === "break_glass") {
    if (actor.principalType !== "SUPER_ADMIN") {
      throw new AuthError(403, "ROLE_GRANT_SUPER_ADMIN_ONLY", "Hanya Super Admin yang dapat memberikan atau mencabut role.");
    }
    return;
  }
  // The channel resolves a human account from the assertion; a machine or a governance account is
  // never a grantor, and SUPER_ADMIN does not reach HCIS through SQ Hub.
  if (actor.principalType !== "EMPLOYEE") {
    throw new AuthError(403, "ROLE_GRANT_ACTOR_INVALID", "Pemberi peran lewat SQ Hub harus akun pegawai yang aktif.");
  }
}

function forbidden(): never {
  throw new AuthError(403, "ROLE_DELEGATION_FORBIDDEN", "Assignment di luar mandat administrasi akun ini.");
}

async function requireDelegation(
  db: PoolClient, actor: AuthPrincipal, targetId: string, roleId: string, channel: GrantChannel,
): Promise<AssignableRole> {
  if (actor.id === targetId) forbidden();
  assertRoleGrantor(actor, channel);
  const result = await db.query<AssignableRole>(
    `SELECT role.role_key AS "roleKey", coalesce(array_agg(permission.permission_key)
      FILTER (WHERE permission.permission_key IS NOT NULL), ARRAY[]::text[]) AS permissions
     FROM roles role LEFT JOIN role_permissions permission ON permission.role_id = role.id
     WHERE role.id = $1 GROUP BY role.id`, [roleId],
  );
  const role = result.rows[0];
  if (!role) throw new AuthError(404, "ROLE_NOT_FOUND", "Role tidak ditemukan.");
  // A separate code from ROLE_DELEGATION_FORBIDDEN on purpose: this is not "outside your mandate",
  // it is "no role may ever carry this", and an operator chasing a 403 should be told which.
  if (carriesIdentityPermission(role)) {
    throw new AuthError(403, "ROLE_IDENTITY_PERMISSION_FORBIDDEN",
      "Peran yang membawa kewenangan identitas tidak dapat diberikan dari HCIS.");
  }
  if (!canDelegateRole(role, false, channel)) forbidden();
  return role;
}

async function lockEmployeeAccount(db: PoolClient, accountId: string) {
  const result = await db.query<{ principalType: string; employeeStatus: string }>(
    `SELECT account.principal_type AS "principalType", employee.status AS "employeeStatus"
     FROM accounts account LEFT JOIN employees employee ON employee.id = account.employee_id
     WHERE account.id = $1 FOR UPDATE OF account`, [accountId],
  );
  if (!result.rows[0]) throw new AuthError(404, "ACCOUNT_NOT_FOUND", "Account tidak ditemukan.");
  if (result.rows[0].principalType !== "EMPLOYEE") forbidden();
}

async function atomic<T>(pool: Pool, operation: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const result = await operation(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally { db.release(); }
}

export interface GrantContext {
  channel: GrantChannel;
  /** AUTH-014 §2.3: the SQ Hub request id, unique per action. Absent on the break-glass path. */
  hubRequestId?: string | null | undefined;
}

export async function createRoleAssignment(
  pool: Pool, actor: AuthPrincipal, accountId: string, input: RoleAssignmentInput,
  context: GrantContext = { channel: "break_glass" },
): Promise<string> {
  assertRoleGrantor(actor, context.channel);
  if (actor.id === accountId) forbidden();
  assertAssignmentScope(input.scopeType, input.organizationalUnitId ?? null);
  assertAssignmentDates(input.startsOn ?? null, input.endsOn ?? null);
  return atomic(pool, async (db) => {
    await lockEmployeeAccount(db, accountId);
    const role = await requireDelegation(db, actor, accountId, input.roleId, context.channel);
    // AUTH-014 §4.1: the Module Administrator is an organization-wide configuration mandate, and a
    // unit-scoped grant of it would satisfy no guard anyway. The reason names who appointed them.
    if (role.roleKey === MODULE_ADMIN_ROLE_KEY &&
      (input.scopeType !== "organization" || !input.reason?.trim())) {
      throw new AuthError(400, "ADMIN_ORGANIZATION_MANDATE_REQUIRED", "Admin Modul memerlukan scope organisasi dan alasan penugasan.");
    }
    if (role.roleKey === "human_capital_admin" &&
      (input.scopeType !== "organization" || !input.reason?.trim())) {
      throw new AuthError(400, "ADMIN_ORGANIZATION_MANDATE_REQUIRED", "Admin HC memerlukan scope organisasi dan alasan penugasan.");
    }
    // ORG-008-8: Kepala HC publishes structure and changes approval policy for the whole foundation.
    // A unit-scoped grant would satisfy no organization guard anyway, so it is refused rather than
    // stored as an assignment that silently does nothing; the mandate names who appointed them.
    if (role.roleKey === HC_LEAD_ROLE_KEY &&
      (input.scopeType !== "organization" || !input.reason?.trim())) {
      throw new AuthError(400, "ADMIN_ORGANIZATION_MANDATE_REQUIRED", "Kepala HC memerlukan scope organisasi dan alasan penugasan.");
    }
    // ORG-010 §1.1: the board-view role is organization scope only and needs a reason naming the mandate.
    if (role.roleKey === BOARD_VIEWER_ROLE_KEY) {
      if (input.scopeType !== "organization" || input.organizationalUnitId) {
        throw new AuthError(400, "ROLE_SCOPE_INVALID", "Panel Organ Yayasan hanya dapat diberikan dengan scope organisasi.");
      }
      if (!input.reason?.trim()) {
        throw new AuthError(400, "ROLE_REASON_REQUIRED", "Alasan penugasan wajib diisi, misalnya nomor SK kepengurusan.");
      }
    }
    // Every other role: an assignment with a scope the role cannot use would be stored, shown and
    // silently grant nothing. The three guards above keep their own codes; this covers the rest.
    assertRoleScope(role.roleKey, input.scopeType);
    if (input.organizationalUnitId) {
      const unit = await db.query("SELECT id FROM organizational_units WHERE id = $1", [input.organizationalUnitId]);
      if (!unit.rowCount) throw new AuthError(404, "UNIT_NOT_FOUND", "Unit organisasi tidak ditemukan.");
    }
    const id = randomUUID();
    await db.query(`INSERT INTO account_role_assignments
      (id, account_id, role_id, scope_type, organizational_unit_id, starts_on, ends_on, reason, assigned_by_account_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, accountId, input.roleId, input.scopeType,
      input.organizationalUnitId ?? null, input.startsOn ?? null, input.endsOn ?? null, input.reason?.trim() || null, actor.id]);
    // A less privileged issuer may still hold an earlier invitation. Elevation
    // must invalidate it while the account lock serializes issuance/activation.
    if (!canDelegateRole(role, false)) {
      await db.query(`UPDATE account_activation_tokens SET revoked_at = now()
        WHERE account_id = $1 AND revoked_at IS NULL AND consumed_at IS NULL`, [accountId]);
    }
    await writeGrantAudit(db, "role.assignment.created", actor, context, id,
      { accountId, ...input, roleKey: role.roleKey });
    return id;
  });
}

export async function removeRoleAssignment(
  pool: Pool, actor: AuthPrincipal, assignmentId: string,
  context: GrantContext = { channel: "break_glass" },
): Promise<void> {
  assertRoleGrantor(actor, context.channel);
  await atomic(pool, async (db) => {
    const result = await db.query<{ accountId: string; roleId: string }>(
      `SELECT account_id AS "accountId", role_id AS "roleId" FROM account_role_assignments WHERE id = $1`, [assignmentId]);
    const assignment = result.rows[0];
    if (!assignment) throw new AuthError(404, "ASSIGNMENT_NOT_FOUND", "Assignment tidak ditemukan.");
    await lockEmployeeAccount(db, assignment.accountId);
    await requireDelegation(db, actor, assignment.accountId, assignment.roleId, context.channel);
    const removed = await db.query("DELETE FROM account_role_assignments WHERE id = $1 RETURNING id", [assignmentId]);
    if (!removed.rowCount) throw new AuthError(404, "ASSIGNMENT_NOT_FOUND", "Assignment tidak ditemukan.");
    await writeGrantAudit(db, "role.assignment.removed", actor, context, assignmentId, assignment);
  });
}

/**
 * AUTH-014 §2.7. Three things the old write did not record: which channel the grant came through,
 * and the SQ Hub request id that lets both sides be reconciled.
 *
 * `actor_source` is what makes a break-glass grant visible among ordinary ones (ADR-0006 R-1
 * point 6); the unique index on (hub_request_id, action) is what stops a captured request being
 * replayed into a second assignment while the machine token is still valid.
 */
async function writeGrantAudit(
  db: PoolClient, action: "role.assignment.created" | "role.assignment.removed",
  actor: AuthPrincipal, context: GrantContext, entityId: string, payload: unknown,
): Promise<void> {
  const actorSource = context.channel === "sq_hub" ? "sq_hub" : "hcis_break_glass";
  await db.query(
    `INSERT INTO access_audit_events
       (id, actor_account_id, action, entity_type, entity_id, payload, actor_source, hub_request_id)
     VALUES ($1,$2,$3,'role_assignment',$4,$5::jsonb,$6,$7)`,
    [randomUUID(), actor.id, action, entityId, JSON.stringify(payload), actorSource,
      context.hubRequestId ?? null],
  );
}

// Account state/invite management must not become a way to take over a privileged principal.
export async function assertAccountManagementTarget(
  db: Pick<Pool, "query">, actor: AuthPrincipal, targetId: string,
): Promise<void> {
  if (actor.id === targetId) forbidden();
  if (!(await hasEffectiveOrganizationPermission(db, actor, "access.manage"))) forbidden();
  const account = await db.query<{ principalType: string }>(
    `SELECT principal_type AS "principalType" FROM accounts WHERE id = $1`, [targetId]);
  if (!account.rows[0]) throw new AuthError(404, "ACCOUNT_NOT_FOUND", "Account tidak ditemukan.");
  if (account.rows[0].principalType === "SUPER_ADMIN") forbidden();
  if (account.rows[0].principalType === "FOUNDATION_BOARD") {
    if (!(await hasEffectiveOrganizationPermission(db, actor, "access.governance.manage"))) forbidden();
    return;
  }
  if (account.rows[0].principalType !== "EMPLOYEE") forbidden();
  if (await hasEffectiveOrganizationPermission(db, actor, "access.roles.delegate")) return;
  const roles = await db.query<AssignableRole>(
    `SELECT role.role_key AS "roleKey", coalesce(array_agg(permission.permission_key)
      FILTER (WHERE permission.permission_key IS NOT NULL), ARRAY[]::text[]) AS permissions
     FROM account_role_assignments assignment JOIN roles role ON role.id = assignment.role_id
     LEFT JOIN role_permissions permission ON permission.role_id = role.id
     WHERE assignment.account_id = $1 GROUP BY role.id`, [targetId]);
  if (!roles.rows.every((role) => canDelegateRole(role, false))) forbidden();
}
