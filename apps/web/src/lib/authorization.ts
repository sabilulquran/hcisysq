import type { AuthSession } from "@/types/hcis";

export function hasPermission(session: AuthSession | null, permission: string): boolean {
  return session?.authorization?.organizationPermissions.includes(permission) === true;
}

// UI eligibility only. The API independently authorizes every operation.
export function canAccessAdminPath(session: AuthSession | null, path: string): boolean {
  if (!session || session.principal.principalType === "FOUNDATION_BOARD") return false;
  if (path === "/admin") return [
    "employees.manage", "organization.manage", "access.manage", "attendance.records.manage",
    "leave.configuration.manage", "payslips.import", "attendance.devices.read",
  ].some((permission) => hasPermission(session, permission));
  if (/^\/admin\/employees(?:\/|$)/.test(path)) return hasPermission(session, "employees.manage");
  if (path === "/admin/organization") return hasPermission(session, "organization.manage");
  if (/^\/admin\/attendance\/devices(?:\/|$)/.test(path)) {
    return hasPermission(session, "attendance.devices.read")
      && (!path.endsWith("/biometrics") || hasPermission(session, "attendance.devices.biometrics"))
      && (!path.endsWith("/settings") || hasPermission(session, "attendance.devices.configure"));
  }
  if (path === "/admin/attendance") return hasPermission(session, "attendance.records.manage");
  if (path === "/admin/leave" || path === "/admin/leave/calendar") return hasPermission(session, "leave.configuration.manage");
  if (path === "/admin/payslips") return hasPermission(session, "payslips.import");
  if (path === "/admin/access") return hasPermission(session, "access.manage");
  return false;
}
