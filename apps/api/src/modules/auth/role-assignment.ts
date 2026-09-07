import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { AuthError, type AuthPrincipal } from "./service.js";
import { ADMIN_PERMISSIONS, HC_OPERATIONAL_PERMISSIONS, hasEffectiveOrganizationPermission } from "./permissions.js";
import { assertAssignmentDates, assertAssignmentScope } from "../employees/org-access-policy.js";

const HCIS_ROLES = ["human_capital", "human_capital_admin", "unit_manager", "finance", "management", "special_approver"];
const HCIS_PERMISSIONS: readonly string[] = [
  ...ADMIN_PERMISSIONS, ...HC_OPERATIONAL_PERMISSIONS, "employees.read.unit", "attendance.read.unit",
  "leave.approve", "leave.hc.approve", "reports.read.organization", "reports.export.organization",
];

export interface AssignableRole { roleKey: string; permissions: string[] }
export interface RoleAssignmentInput {
  roleId: string;
  scopeType: "own" | "unit" | "organization";
  organizationalUnitId?: string | null | undefined;
  startsOn?: string | null | undefined;
  endsOn?: string | null | undefined;
  reason?: string | null | undefined;
}

export function canDelegateRole(role: AssignableRole, delegated: boolean): boolean {
  if (!HCIS_ROLES.includes(role.roleKey) || !role.permissions.length) return false;
  if (!role.permissions.every((key) => HCIS_PERMISSIONS.includes(key))) return false;
  return delegated || (role.roleKey === "human_capital"
    && role.permissions.every((key) => (HC_OPERATIONAL_PERMISSIONS as readonly string[]).includes(key)));
}

function forbidden(): never {
  throw new AuthError(403, "ROLE_DELEGATION_FORBIDDEN", "Assignment di luar mandat administrasi akun ini.");
}

async function requireDelegation(
  db: PoolClient, actor: AuthPrincipal, targetId: string, roleId: string,
): Promise<AssignableRole> {
  if (actor.id === targetId) forbidden();
  if (!(await hasEffectiveOrganizationPermission(db, actor, "access.roles.assign"))) forbidden();
  const result = await db.query<AssignableRole>(
    `SELECT role.role_key AS "roleKey", coalesce(array_agg(permission.permission_key)
      FILTER (WHERE permission.permission_key IS NOT NULL), ARRAY[]::text[]) AS permissions
     FROM roles role LEFT JOIN role_permissions permission ON permission.role_id = role.id
     WHERE role.id = $1 GROUP BY role.id`, [roleId],
  );
  const role = result.rows[0];
  if (!role) throw new AuthError(404, "ROLE_NOT_FOUND", "Role tidak ditemukan.");
  const delegated = await hasEffectiveOrganizationPermission(db, actor, "access.roles.delegate");
  if (!canDelegateRole(role, delegated)) forbidden();
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

export async function createRoleAssignment(
  pool: Pool, actor: AuthPrincipal, accountId: string, input: RoleAssignmentInput,
): Promise<string> {
  if (actor.id === accountId) forbidden();
  assertAssignmentScope(input.scopeType, input.organizationalUnitId ?? null);
  assertAssignmentDates(input.startsOn ?? null, input.endsOn ?? null);
  return atomic(pool, async (db) => {
    await lockEmployeeAccount(db, accountId);
    const role = await requireDelegation(db, actor, accountId, input.roleId);
    if (role.roleKey === "human_capital_admin" &&
      (input.scopeType !== "organization" || !input.reason?.trim())) {
      throw new AuthError(400, "ADMIN_ORGANIZATION_MANDATE_REQUIRED", "Admin HC memerlukan scope organisasi dan alasan penugasan.");
    }
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
    await db.query(`INSERT INTO access_audit_events (id, actor_account_id, action, entity_type, entity_id, payload)
      VALUES ($1,$2,'role.assignment.created','role_assignment',$3,$4::jsonb)`,
    [randomUUID(), actor.id, id, JSON.stringify({ accountId, ...input })]);
    return id;
  });
}

export async function removeRoleAssignment(pool: Pool, actor: AuthPrincipal, assignmentId: string): Promise<void> {
  await atomic(pool, async (db) => {
    const result = await db.query<{ accountId: string; roleId: string }>(
      `SELECT account_id AS "accountId", role_id AS "roleId" FROM account_role_assignments WHERE id = $1`, [assignmentId]);
    const assignment = result.rows[0];
    if (!assignment) throw new AuthError(404, "ASSIGNMENT_NOT_FOUND", "Assignment tidak ditemukan.");
    await lockEmployeeAccount(db, assignment.accountId);
    await requireDelegation(db, actor, assignment.accountId, assignment.roleId);
    const removed = await db.query("DELETE FROM account_role_assignments WHERE id = $1 RETURNING id", [assignmentId]);
    if (!removed.rowCount) throw new AuthError(404, "ASSIGNMENT_NOT_FOUND", "Assignment tidak ditemukan.");
    await db.query(`INSERT INTO access_audit_events (id, actor_account_id, action, entity_type, entity_id, payload)
      VALUES ($1,$2,'role.assignment.removed','role_assignment',$3,$4::jsonb)`,
    [randomUUID(), actor.id, assignmentId, JSON.stringify(assignment)]);
  });
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
