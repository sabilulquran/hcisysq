import type { Pool } from "pg";
import type { AuthPrincipal } from "./service.js";

export const HC_OPERATIONAL_PERMISSIONS = [
  "employees.manage", "employees.read.all", "leave.validate", "leave.evidence.read",
  "attendance.resolution.read", "attendance.resolution.manage", "payslips.import", "payslips.publish",
] as const;

export const HC_ADMIN_PERMISSIONS = [
  ...HC_OPERATIONAL_PERMISSIONS, "organization.manage", "access.manage",
  "access.roles.assign", "leave.configuration.manage", "attendance.records.manage",
] as const;

// Only capabilities of the existing administrative APIs are eligible for legacy access.
export const ADMIN_PERMISSIONS = [
  "employees.manage", "employees.read.all", "organization.manage", "access.manage",
  "access.roles.assign", "access.roles.delegate", "access.governance.manage",
  "approvals.policy.manage", "leave.configuration.manage", "attendance.records.manage",
  "payslips.import", "payslips.publish", "attendance.devices.read",
  "attendance.devices.configure", "attendance.devices.operate", "attendance.devices.export",
  "attendance.devices.destructive", "attendance.devices.firmware", "attendance.devices.biometrics",
] as const;
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

export interface AuthorizationContext {
  organizationPermissions: string[];
}

/** @deprecated AUTH-011: remove only after accepted OIDC cutover and administrator UAT.
 * This is HCIS compatibility, never SQ Platform Administrator or workflow approval.
 */
export function hasLegacySuperAdminCompatibility(principal: AuthPrincipal, permission: string): boolean {
  return principal.principalType === "SUPER_ADMIN"
    && (ADMIN_PERMISSIONS as readonly string[]).includes(permission);
}

export async function hasOrganizationPermission(
  db: Pick<Pool, "query">,
  accountId: string,
  permissionKey: string,
): Promise<boolean> {
  const result = await db.query<{ allowed: boolean }>(
    `SELECT EXISTS (
      SELECT 1
      FROM account_role_assignments assignment
      JOIN role_permissions role_permission ON role_permission.role_id = assignment.role_id
      JOIN accounts principal_account ON principal_account.id = assignment.account_id
      JOIN employees principal_employee ON principal_employee.id = principal_account.employee_id
      WHERE assignment.account_id = $1
        AND role_permission.permission_key = $2
        AND principal_account.principal_type = 'EMPLOYEE'
        AND principal_account.status = 'active' AND principal_employee.status = 'active'
        AND assignment.scope_type = 'organization'
        AND assignment.organizational_unit_id IS NULL
        AND (assignment.starts_on IS NULL OR assignment.starts_on <= current_date)
        AND (assignment.ends_on IS NULL OR assignment.ends_on >= current_date)
    ) AS allowed`,
    [accountId, permissionKey],
  );
  return result.rows[0]?.allowed === true;
}

export async function hasEffectiveOrganizationPermission(
  db: Pick<Pool, "query">, principal: AuthPrincipal, permission: string,
): Promise<boolean> {
  if (hasLegacySuperAdminCompatibility(principal, permission)) return true;
  if (principal.principalType !== "EMPLOYEE") return false;
  return hasOrganizationPermission(db, principal.id, permission);
}

export async function resolveAuthorizationContext(
  db: Pick<Pool, "query">, principal: AuthPrincipal,
): Promise<AuthorizationContext> {
  const compatibility = ADMIN_PERMISSIONS.filter((key) => hasLegacySuperAdminCompatibility(principal, key));
  if (principal.principalType !== "EMPLOYEE") return { organizationPermissions: compatibility };
  const result = await db.query<{ permissionKey: string }>(
    `SELECT DISTINCT role_permission.permission_key AS "permissionKey"
     FROM account_role_assignments assignment
     JOIN role_permissions role_permission ON role_permission.role_id = assignment.role_id
     JOIN accounts principal_account ON principal_account.id = assignment.account_id
     JOIN employees principal_employee ON principal_employee.id = principal_account.employee_id
     WHERE assignment.account_id = $1
       AND principal_account.principal_type = 'EMPLOYEE'
       AND principal_account.status = 'active' AND principal_employee.status = 'active'
       AND assignment.scope_type = 'organization'
       AND assignment.organizational_unit_id IS NULL
       AND (assignment.starts_on IS NULL OR assignment.starts_on <= current_date)
       AND (assignment.ends_on IS NULL OR assignment.ends_on >= current_date)
     ORDER BY role_permission.permission_key`, [principal.id],
  );
  return { organizationPermissions: result.rows.map((row) => row.permissionKey) };
}
