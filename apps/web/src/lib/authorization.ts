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
    "attendance.schedule.manage", "attendance.policy.manage", "attendance.clarification.manage", "attendance.reports.read", "attendance.overtime.manage", "attendance.shift_swap.manage",
  ].some((permission) => hasPermission(session, permission));
  if (/^\/admin\/employees(?:\/|$)/.test(path)) return hasPermission(session, "employees.manage");
  if (path === "/admin/organization") return hasPermission(session, "organization.manage");
  if (/^\/admin\/attendance\/adms(?:\/|$)/.test(path)) return hasPermission(session, "attendance.devices.read");
  if (/^\/admin\/attendance\/devices(?:\/|$)/.test(path)) {
    return hasPermission(session, "attendance.devices.read")
      && (!path.endsWith("/biometrics") || hasPermission(session, "attendance.devices.biometrics"))
      && (!path.endsWith("/settings") || hasPermission(session, "attendance.devices.configure"))
      && (!path.endsWith("/operations") || hasPermission(session, "attendance.devices.technical"))
      && (!path.endsWith("/diagnostics") || hasPermission(session, "attendance.devices.technical"));
  }
  if (path === "/admin/attendance") return hasPermission(session, "attendance.records.manage");
  if (path === "/admin/attendance/workforce") return [
    "attendance.schedule.manage", "attendance.policy.manage",
    "attendance.clarification.manage", "attendance.reports.read", "attendance.overtime.manage", "attendance.shift_swap.manage",
  ].some((permission) => hasPermission(session, permission));
  if (/^\/admin\/attendance\/workforce\/(locations|schedules|assignments|roster)$/.test(path)) {
    return hasPermission(session, "attendance.schedule.manage");
  }
  if (/^\/admin\/attendance\/workforce\/(clarifications|mobile)$/.test(path)) {
    return hasPermission(session, "attendance.clarification.manage");
  }
  if (path === "/admin/attendance/workforce/overtime") {
    return hasPermission(session, "attendance.overtime.manage");
  }
  if (path === "/admin/attendance/workforce/shift-swaps") {
    return hasPermission(session, "attendance.shift_swap.manage");
  }
  if (path === "/admin/attendance/workforce/reports") {
    return hasPermission(session, "attendance.reports.read");
  }
  if (path === "/admin/leave" || path === "/admin/leave/calendar") return hasPermission(session, "leave.configuration.manage");
  if (path === "/admin/payslips") return hasPermission(session, "payslips.import");
  if (path === "/admin/access") return hasPermission(session, "access.manage");
  return false;
}


export function canAccessEmployeeHcPath(session: AuthSession | null, path: string): boolean {
  if (!session || session.principal.principalType !== "EMPLOYEE") return false;
  if (path === "/app/hc/leave" || path === "/app/hc/planned-leave") {
    return hasPermission(session, "leave.validate");
  }
  if (path === "/app/hc/attendance-resolution") {
    return hasPermission(session, "attendance.resolution.manage");
  }
  return false;
}
