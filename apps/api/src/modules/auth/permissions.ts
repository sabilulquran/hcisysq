import type { Pool } from "pg";
import type { AuthPrincipal } from "./service.js";

export const HC_OPERATIONAL_PERMISSIONS = [
  "employees.manage", "employees.read.all", "leave.validate", "leave.evidence.read",
  "attendance.resolution.read", "attendance.resolution.manage", "payslips.import", "payslips.publish",
] as const;

// Owner decision 2026-10-16 (AUTH-011): no access.roles.assign; only Super Admin grants roles (migration 0057).
export const HC_ADMIN_PERMISSIONS = [
  ...HC_OPERATIONAL_PERMISSIONS, "organization.manage", "access.manage",
  "leave.configuration.manage", "attendance.records.manage",
  "attendance.schedule.manage", "attendance.policy.manage",
  "attendance.clarification.manage", "attendance.reports.read", "attendance.overtime.manage",
  "attendance.shift_swap.manage", "attendance.devices.read", "attendance.devices.configure",
  "attendance.devices.operate", "attendance.devices.export", "attendance.calculation.run",
  "employment.read", "employment.manage",
  // DOC-002 D-13: migration 0102 grants documents.discipline.manage to human_capital_admin.
  "documents.read", "documents.manage", "documents.discipline.manage",
  // NOTIF-002: migration 0105 grants both to human_capital_admin.
  "announcements.read", "announcements.manage",
  // ORG-011: migration 0110 grants both to human_capital_admin.
  "job_classifications.read", "job_classifications.manage",
  // EMP-005 D-15: migration 0101 grants this to human_capital_admin, so the
  // bundle here says the same. Legacy Super Admin compatibility reads
  // ADMIN_PERMISSIONS, which deliberately leaves it out.
  "access.accounts.temporary_reactivate",
] as const;

/** DOC-001/DOC-002: HC-only; never granted through legacy Super Admin compatibility.
 * documents.discipline.manage joins human_capital_admin in migration 0102: at YSQ the HC
 * administrator issues warning letters, and no unit-scoped role carries it.
 * documents.correct stays outside every bundle and is granted through the separate
 * document_corrector role (spec §6, D-16). */
export const DOCUMENT_CORRECTOR_ROLE_KEY = "document_corrector";

/** NOTIF-002: HC-only; never granted through legacy Super Admin compatibility. */
export const ANNOUNCEMENT_PERMISSIONS = ["announcements.read", "announcements.manage"] as const;
export type AnnouncementPermission = (typeof ANNOUNCEMENT_PERMISSIONS)[number];

/** ORG-011: HC-only; never granted through legacy Super Admin compatibility. The catalog is
 * compensation reference data, so reading it is not part of the ordinary structure read. */
export const JOB_CLASSIFICATION_PERMISSIONS = [
  "job_classifications.read", "job_classifications.manage",
] as const;
export type JobClassificationPermission = (typeof JOB_CLASSIFICATION_PERMISSIONS)[number];
export const DOCUMENT_PERMISSIONS = [
  "documents.read", "documents.manage", "documents.discipline.manage", "documents.correct",
] as const;
export type DocumentPermission = (typeof DOCUMENT_PERMISSIONS)[number];

/**
 * ORG-008-8 (O-1, owner decision 2026-10-24): the second pair of eyes. It reads the structure and
 * holds approvals.policy.manage in full as AUTH-011 defines it; it holds no operational HC permission.
 */
export const HC_LEAD_ROLE_KEY = "human_capital_lead";

/**
 * PAY-003: Kepala HC runs payroll up to submission. The approval, the payment
 * confirmation and the reopen approval stay with other roles, so no account can
 * carry a period from input to approval on its own.
 */
export const PAYROLL_HC_LEAD_PERMISSIONS = [
  "payroll.policies.manage",
  "payroll.profiles.manage",
  "payroll.periods.manage",
  "payroll.inputs.manage",
  "payroll.calculate",
  "payroll.submit",
] as const;

/**
 * PAY-003: every payroll permission, and the roles that carry the ones Kepala HC
 * does not. Listed here so role assignment recognises them; Super Admin receives
 * none of them through legacy compatibility (ADR-0003).
 */
export const PAYROLL_PERMISSIONS = [
  "payroll.policies.manage",
  "payroll.profiles.manage",
  "payroll.periods.manage",
  "payroll.inputs.manage",
  "payroll.calculate",
  "payroll.submit",
  "payroll.approve",
  "payroll.reopen.approve",
  "payroll.loans.manage",
  "payroll.payments.confirm",
  "payroll.reports.read.organization",
  "payroll.transfers.read.organization",
] as const;

export const PAYROLL_ROLE_KEYS = ["finance_officer", "finance_lead", "director"] as const;

export const HC_LEAD_PERMISSIONS = [
  "organization.manage",
  "approvals.policy.manage",
  ...PAYROLL_HC_LEAD_PERMISSIONS,
  // ORG-011, owner decision 2026-10-30: Kepala HC manages the classification and grade
  // catalogs too. Migration 0113 grants both. The catalog carries no money and no authority
  // (ADR-0004), so this widens nothing Kepala HC can approve or publish.
  ...JOB_CLASSIFICATION_PERMISSIONS,
] as const;

/** EMP-005/EMP-006: HC-only; never granted through legacy Super Admin compatibility. */
export const EMPLOYMENT_PERMISSIONS = ["employment.read", "employment.manage", "employment.correct"] as const;

/**
 * EMP-005 D-15: granting a former employee a time-boxed reactivation. Carried
 * by human_capital_admin only (migration 0101) and deliberately outside
 * ADMIN_PERMISSIONS, so legacy Super Admin compatibility never grants it.
 */
export const ACCESS_REACTIVATION_PERMISSION = "access.accounts.temporary_reactivate";
export type EmploymentPermission = (typeof EMPLOYMENT_PERMISSIONS)[number];

/** ORG-010: read the Panel Organ Yayasan (aggregate only). Carried only by foundation_board_viewer;
 * outside every HC bundle and never granted through legacy Super Admin compatibility. */
export const BOARD_READ_PERMISSION = "board.read";
export const BOARD_VIEWER_ROLE_KEY = "foundation_board_viewer";

/**
 * AUTH-014 §4 (migration 0111): the Module Administrator. Module configuration only — shifts and
 * schedules, attendance policy, non-destructive device work, leave types, payroll policy and
 * periods. It never grants a role and never touches an account, which is the whole line between
 * this layer and the Platform Administrator in SQ Hub.
 */
export const MODULE_ADMIN_ROLE_KEY = "hcis_module_admin";
export const MODULE_ADMIN_PERMISSIONS = [
  "attendance.schedule.manage", "attendance.policy.manage", "attendance.shift_swap.manage",
  "attendance.calculation.run",
  "attendance.devices.read", "attendance.devices.configure", "attendance.devices.operate",
  "attendance.devices.export", "attendance.devices.technical",
  "leave.configuration.manage",
  "payroll.policies.manage", "payroll.periods.manage",
] as const;

/**
 * AUTH-014 §2.6 / ADR-0006 D-5: the permissions that decide who may grant roles and manage
 * governance accounts. No HCIS role may carry any of them, on any channel.
 *
 * Without this, the self-grant prohibition is decorative: a Platform Administrator cannot grant to
 * themselves, but could grant `access.roles.assign` to a second account they control, sign in as
 * it, and grant themselves anything. The ban lives here and in `canDelegateRole` rather than on the
 * channel route, so it binds break-glass too — a route-level ban would leave break-glass able to
 * mint and grant such a role, reopening the loop permanently.
 *
 * They stay in `ADMIN_PERMISSIONS` because legacy Super Admin compatibility still reads that list.
 * What changes is that no *role* may carry them.
 */
export const IDENTITY_PERMISSIONS = [
  "access.roles.assign", "access.roles.delegate", "access.governance.manage",
] as const;

// Only capabilities of the existing administrative APIs are eligible for legacy access.
// access.roles.assign stays here: legacy Super Admin compatibility is the only remaining role grantor.
export const ADMIN_PERMISSIONS = [
  "employees.manage", "employees.read.all", "organization.manage", "access.manage",
  "access.roles.assign", "access.roles.delegate", "access.governance.manage",
  "approvals.policy.manage", "leave.configuration.manage", "attendance.records.manage",
  "payslips.import", "payslips.publish", "attendance.devices.read",
  "attendance.devices.configure", "attendance.devices.operate", "attendance.devices.export",
  "attendance.devices.destructive", "attendance.devices.firmware", "attendance.devices.biometrics",
  "attendance.devices.technical",
  "attendance.schedule.manage", "attendance.policy.manage",
  "attendance.clarification.manage", "attendance.reports.read", "attendance.overtime.manage",
  "attendance.shift_swap.manage", "attendance.calculation.run",
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

/** ORG-010 §1.3: an active FOUNDATION_BOARD account (path B), or an active EMPLOYEE with an active
 * employee record and an effective organization-scope board.read assignment (path A). No cache. */
export async function hasBoardAccess(
  db: Pick<Pool, "query">, account: { id: string; principalType: string; status?: string },
): Promise<boolean> {
  if (account.status !== undefined && account.status !== "active") return false;
  if (account.principalType === "FOUNDATION_BOARD") return true;
  if (account.principalType !== "EMPLOYEE") return false;
  return hasOrganizationPermission(db, account.id, BOARD_READ_PERMISSION);
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
