import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminNavigation } from "@/layouts/AdminShell";
import { canAccessAdminPath, canAccessBoard, canAccessEmployeeHcPath, canManageRoleAssignments } from "@/lib/authorization";
import { landingPath } from "@/lib/auth";
import type { AuthSession, PrincipalType } from "@/types/hcis";

function session(principalType: PrincipalType, permissions: string[]): AuthSession {
  return { principal: { id: "synthetic", email: "synthetic@example.invalid", principalType },
    expiresAt: "2099-01-01T00:00:00Z", authorization: { organizationPermissions: permissions } };
}
const hcAdmin = [
  "employees.manage", "employees.read.all", "leave.validate", "leave.evidence.read",
  "attendance.resolution.read", "attendance.resolution.manage", "payslips.import", "payslips.publish",
  "organization.manage", "access.manage", "leave.configuration.manage",
  "attendance.records.manage", "attendance.schedule.manage", "attendance.policy.manage",
  "attendance.clarification.manage", "attendance.reports.read", "attendance.overtime.manage",
  "attendance.shift_swap.manage", "attendance.devices.read", "attendance.devices.configure",
  "attendance.devices.operate", "attendance.devices.export",
];
const workforcePermissions = ["attendance.schedule.manage", "attendance.policy.manage", "attendance.clarification.manage", "attendance.reports.read", "attendance.overtime.manage", "attendance.shift_swap.manage"];

describe("AUTH-011 backend-derived admin navigation", () => {
  it("shows intended HC admin surfaces in both desktop and compact menus", () => {
    const actor = session("EMPLOYEE", hcAdmin);
    expect(landingPath(actor)).toBe("/app");
    for (const compact of [false, true]) {
      const html = renderToStaticMarkup(<AdminNavigation active="overview" session={actor} compact={compact} />);
      for (const path of ["/admin/employees", "/admin/organization", "/admin/access", "/admin/attendance", "/admin/payslips", "/admin/leave"]) {
        expect(html).toContain(`href="${path}"`);
        expect(canAccessAdminPath(actor, path)).toBe(true);
      }
      expect(html).toContain('href="/admin/attendance/adms"');
      expect(html).toContain("Mesin Fingerprint");
      expect(html).not.toContain('href="/admin/attendance/devices"');
      expect(html).not.toContain("Transaksi Lintas Mesin");
    }
    expect(canAccessAdminPath(actor, "/admin/attendance/devices/opaque/operations")).toBe(true);
    expect(canAccessAdminPath(actor, "/admin/attendance/devices/opaque/diagnostics")).toBe(false);
    expect(canAccessAdminPath(actor, "/admin/attendance/devices/opaque/settings")).toBe(true);
    expect(canAccessAdminPath(actor, "/admin/attendance/devices/opaque/data")).toBe(true);
    expect(canAccessAdminPath(actor, "/admin/attendance/devices/opaque/maintenance")).toBe(true);
    expect(canAccessAdminPath(actor, "/admin/attendance/devices/opaque/biometrics")).toBe(false);
    expect(canAccessEmployeeHcPath(actor, "/app/hc/leave")).toBe(true);
    expect(canAccessEmployeeHcPath(actor, "/app/hc/planned-leave")).toBe(true);
    expect(canAccessEmployeeHcPath(actor, "/app/hc/attendance-resolution")).toBe(true);
    // Owner decision 2026-10-16: HC admins reach /admin/access but cannot grant or remove roles.
    expect(hcAdmin).not.toContain("access.roles.assign");
    expect(canManageRoleAssignments(actor)).toBe(false);
  });

  it("does not infer permissions from Employee, operational HC or legacy principal labels", () => {
    for (const actor of [session("EMPLOYEE", []), session("EMPLOYEE", ["leave.validate"]), session("SUPER_ADMIN", [])]) {
      expect(canAccessAdminPath(actor, "/admin")).toBe(false);
      expect(canAccessAdminPath(actor, "/admin/access")).toBe(false);
      expect(renderToStaticMarkup(<AdminNavigation active="overview" session={actor} />)).not.toContain("href=");
    }
    expect(canAccessEmployeeHcPath(session("EMPLOYEE", ["leave.validate"]), "/app/hc/leave")).toBe(true);
    expect(canAccessEmployeeHcPath(session("EMPLOYEE", ["leave.validate"]), "/app/hc/attendance-resolution")).toBe(false);
    expect(canAccessEmployeeHcPath(session("EMPLOYEE", []), "/app/hc/leave")).toBe(false);
    expect(canAccessEmployeeHcPath(session("FOUNDATION_BOARD", ["leave.validate"]), "/app/hc/leave")).toBe(false);
    const missingContext: AuthSession = { principal: session("SUPER_ADMIN", []).principal, expiresAt: "2099-01-01T00:00:00Z" };
    expect(canAccessAdminPath(missingContext, "/admin")).toBe(false);
    expect(landingPath(session("EMPLOYEE", []))).toBe("/app");
  });

  it("exposes attendance workspace child routes and ADMS back office by explicit permissions", () => {
    const workforce = session("EMPLOYEE", workforcePermissions);
    for (const path of [
      "/admin/attendance",
      "/admin/attendance/shifts",
      "/admin/attendance/schedules",
      "/admin/attendance/schedules/dates",
      "/admin/attendance/schedules/swaps",
      "/admin/attendance/daily",
      "/admin/attendance/clarifications",
      "/admin/attendance/mobile-evidence",
      "/admin/attendance/reports",
      "/admin/attendance/overtime",
      "/admin/attendance/settings/locations",
      "/admin/attendance/calculation",
    ]) {
      expect(canAccessAdminPath(workforce, path)).toBe(true);
    }
    // Koreksi HC needs attendance.records.manage, which these permissions do not include.
    expect(canAccessAdminPath(workforce, "/admin/attendance/corrections")).toBe(false);
    expect(canAccessAdminPath(workforce, "/admin/attendance/adms")).toBe(false);
    // Pre-ATT-011 paths are redirects now, never screens of their own.
    expect(canAccessAdminPath(workforce, "/admin/attendance/workforce/reports")).toBe(false);
    expect(canAccessAdminPath(workforce, "/admin/attendance/settings/recalculate")).toBe(false);

    const deviceOperator = session("EMPLOYEE", ["attendance.devices.read"]);
    expect(canAccessAdminPath(deviceOperator, "/admin/attendance/adms")).toBe(true);
    expect(canAccessAdminPath(deviceOperator, "/admin/attendance/adms/transactions")).toBe(true);
    expect(canAccessAdminPath(deviceOperator, "/admin/attendance/devices")).toBe(true);
    expect(canAccessAdminPath(deviceOperator, "/admin/attendance/devices/id/operations")).toBe(true);
    expect(canAccessAdminPath(deviceOperator, "/admin/attendance/devices/id/diagnostics")).toBe(false);
    expect(canAccessAdminPath(deviceOperator, "/admin/attendance/devices/id/settings")).toBe(false);
    expect(canAccessAdminPath(deviceOperator, "/admin/attendance/devices/id/biometrics")).toBe(false);
    const html = renderToStaticMarkup(<AdminNavigation active="attendance-adms" session={deviceOperator} />);
    expect(html).toContain('href="/admin/attendance/adms"');
    expect(html).not.toContain('href="/admin/attendance/devices"');
  });

  it("keeps Board governance-only and honors trusted legacy compatibility context", () => {
    const board = session("FOUNDATION_BOARD", []);
    expect(landingPath(board)).toBe("/board");
    expect(canAccessAdminPath(board, "/admin/payslips")).toBe(false);
    const legacy = session("SUPER_ADMIN", [...hcAdmin, "attendance.devices.read", "attendance.devices.configure", "attendance.devices.biometrics", "attendance.devices.technical"]);
    expect(landingPath(legacy)).toBe("/admin");
    expect(renderToStaticMarkup(<AdminNavigation active="overview" session={legacy} />)).toContain('href="/admin/attendance/adms"');
    expect(canAccessAdminPath(legacy, "/admin/attendance/devices/id/biometrics")).toBe(true);
    expect(canAccessAdminPath(legacy, "/admin/attendance/devices/id/operations")).toBe(true);
    expect(canAccessAdminPath(legacy, "/admin/attendance/devices/id/diagnostics")).toBe(true);
    expect(canAccessAdminPath(legacy, "/admin/unknown")).toBe(false);
    expect(canManageRoleAssignments(legacy)).toBe(false);
    expect(canManageRoleAssignments(session("SUPER_ADMIN", [...hcAdmin, "access.roles.assign"]))).toBe(true);
  });
});

describe("default landing by principal persona", () => {
  it.each([
    ["Foundation Board", session("FOUNDATION_BOARD", hcAdmin), "/board"],
    ["ordinary employee", session("EMPLOYEE", []), "/app"],
    ["employee with admin capability", session("EMPLOYEE", hcAdmin), "/app"],
    ["non-Employee with admin capability", session("SUPER_ADMIN", hcAdmin), "/admin"],
  ] as const)("lands %s at the expected path", (_label, actor, expected) => {
    expect(landingPath(actor)).toBe(expected);
  });
});

describe("ORG-010 /board route eligibility", () => {
  it("allows FOUNDATION_BOARD and an Employee with board.read, and denies everyone else", () => {
    expect(canAccessBoard(session("FOUNDATION_BOARD", []))).toBe(true);
    expect(canAccessBoard(session("EMPLOYEE", ["board.read"]))).toBe(true);
    expect(canAccessBoard(session("EMPLOYEE", []))).toBe(false);
    expect(canAccessBoard(session("EMPLOYEE", hcAdmin))).toBe(false);
    expect(canAccessBoard(session("SUPER_ADMIN", ["board.read"]))).toBe(false);
    expect(canAccessBoard(null)).toBe(false);
  });

  it("keeps landing paths and adds no admin path for board.read", () => {
    const viewer = session("EMPLOYEE", ["board.read"]);
    expect(landingPath(viewer)).toBe("/app");
    expect(canAccessAdminPath(viewer, "/admin")).toBe(false);
    expect(landingPath(session("FOUNDATION_BOARD", []))).toBe("/board");
    expect(canAccessAdminPath(session("FOUNDATION_BOARD", ["board.read"]), "/admin")).toBe(false);
  });
});
