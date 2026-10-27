import type { AuthSession } from "@/types/hcis";

export function hasPermission(session: AuthSession | null, permission: string): boolean {
  return session?.authorization?.organizationPermissions.includes(permission) === true;
}

const ATTENDANCE_PATH_PERMISSIONS: Record<string, string> = {
  "/admin/attendance/shifts": "attendance.schedule.manage",
  "/admin/attendance/schedules": "attendance.schedule.manage",
  "/admin/attendance/schedules/dates": "attendance.schedule.manage",
  "/admin/attendance/schedules/swaps": "attendance.shift_swap.manage",
  "/admin/attendance/daily": "attendance.reports.read",
  "/admin/attendance/reports": "attendance.reports.read",
  "/admin/attendance/reports/print": "attendance.reports.read",
  "/admin/attendance/overtime": "attendance.overtime.manage",
  "/admin/attendance/settings/locations": "attendance.schedule.manage",
};

// Ringkasan shows one card per area the account can load, so any attendance permission opens it.
const ATTENDANCE_SUMMARY_PERMISSIONS = [
  "attendance.reports.read", "attendance.clarification.manage", "attendance.overtime.manage",
  "attendance.shift_swap.manage", "attendance.schedule.manage", "attendance.records.manage", "attendance.policy.manage",
  "attendance.calculation.run",
];

// UI eligibility only. The API independently authorizes every operation.
export function canAccessAdminPath(session: AuthSession | null, path: string): boolean {
  if (!session || session.principal.principalType === "FOUNDATION_BOARD") return false;
  if (path === "/admin") return [
    "employees.manage", "organization.manage", "access.manage", "attendance.records.manage",
    "leave.configuration.manage", "payslips.import", "attendance.devices.read",
    "attendance.schedule.manage", "attendance.policy.manage", "attendance.clarification.manage", "attendance.reports.read", "attendance.overtime.manage", "attendance.shift_swap.manage",
    "attendance.calculation.run",
  ].some((permission) => hasPermission(session, permission));
  if (/^\/admin\/employees(?:\/|$)/.test(path)) return hasPermission(session, "employees.manage");
  // EMP-005: HC-only; Super Admin legacy compatibility never carries employment.*.
  if (path === "/admin/employment/consistency") return hasPermission(session, "employment.read");
  if (path === "/admin/organization") return hasPermission(session, "organization.manage");
  if (/^\/admin\/attendance\/adms(?:\/|$)/.test(path)) return hasPermission(session, "attendance.devices.read");
  if (/^\/admin\/attendance\/devices(?:\/|$)/.test(path)) {
    return hasPermission(session, "attendance.devices.read")
      && (!path.endsWith("/biometrics") || hasPermission(session, "attendance.devices.biometrics"))
      && (!path.endsWith("/settings") || hasPermission(session, "attendance.devices.configure"))
      && (!path.endsWith("/diagnostics") || hasPermission(session, "attendance.devices.technical"));
  }
  // ATT-011-3 Perlu Tindakan: any permission that acts on one of the queue's kinds opens it.
  if (path === "/admin/attendance/action-queue") {
    return ["attendance.clarification.manage", "attendance.records.manage", "attendance.reports.read", "attendance.schedule.manage"]
      .some((permission) => hasPermission(session, permission));
  }
  // ATT-011-3R Perbaikan Absen: deciding requests or entering corrections each open it.
  if (path === "/admin/attendance/corrections") {
    return hasPermission(session, "attendance.clarification.manage") || hasPermission(session, "attendance.records.manage");
  }
  // ATT-011-1: each screen is offered only to accounts whose permission loads its data (K-8).
  const attendancePermission = ATTENDANCE_PATH_PERMISSIONS[path];
  if (attendancePermission) return hasPermission(session, attendancePermission);
  if (path === "/admin/attendance") return ATTENDANCE_SUMMARY_PERMISSIONS.some((permission) => hasPermission(session, permission));
  if (path === "/admin/leave" || path === "/admin/leave/calendar") return hasPermission(session, "leave.configuration.manage");
  if (path === "/admin/payslips") return hasPermission(session, "payslips.import");
  // DOC-001/DOC-002: HC-only; Super Admin legacy compatibility never carries documents.*.
  if (path === "/admin/documents") return hasPermission(session, "documents.read");
  if (path === "/admin/access") return hasPermission(session, "access.manage");
  return false;
}


// UI eligibility only. Owner decision 2026-10-16 (AUTH-011): the API grants or removes roles
// only for a Super Admin principal holding access.roles.assign; everyone else gets 403.
export function canManageRoleAssignments(session: AuthSession | null): boolean {
  return session?.principal.principalType === "SUPER_ADMIN" && hasPermission(session, "access.roles.assign");
}

// ORG-010 §1.4: UI eligibility for /board only; GET /board/dashboard authorizes independently.
export function canAccessBoard(session: AuthSession | null): boolean {
  if (!session) return false;
  if (session.principal.principalType === "FOUNDATION_BOARD") return true;
  return session.principal.principalType === "EMPLOYEE" && hasPermission(session, "board.read");
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
