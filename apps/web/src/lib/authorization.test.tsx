import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminNavigation } from "@/layouts/AdminShell";
import { canAccessAdminPath } from "@/lib/authorization";
import { landingPath } from "@/lib/auth";
import type { AuthSession, PrincipalType } from "@/types/hcis";

function session(principalType: PrincipalType, permissions: string[]): AuthSession {
  return { principal: { id: "synthetic", email: "synthetic@example.invalid", principalType },
    expiresAt: "2099-01-01T00:00:00Z", authorization: { organizationPermissions: permissions } };
}
const hcAdmin = ["employees.manage", "organization.manage", "access.manage", "access.roles.assign",
  "leave.configuration.manage", "attendance.records.manage", "payslips.import", "payslips.publish"];
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
      expect(html).not.toContain('href="/admin/attendance/devices"');
    }
    expect(canAccessAdminPath(actor, "/admin/attendance/devices/opaque/biometrics")).toBe(false);
  });

  it("does not infer permissions from Employee, operational HC or legacy principal labels", () => {
    for (const actor of [session("EMPLOYEE", []), session("EMPLOYEE", ["leave.validate"]), session("SUPER_ADMIN", [])]) {
      expect(canAccessAdminPath(actor, "/admin")).toBe(false);
      expect(canAccessAdminPath(actor, "/admin/access")).toBe(false);
      expect(renderToStaticMarkup(<AdminNavigation active="overview" session={actor} />)).not.toContain("href=");
    }
    const missingContext: AuthSession = { principal: session("SUPER_ADMIN", []).principal, expiresAt: "2099-01-01T00:00:00Z" };
    expect(canAccessAdminPath(missingContext, "/admin")).toBe(false);
    expect(landingPath(session("EMPLOYEE", []))).toBe("/app");
  });

  it("exposes attendance workspace child routes and ADMS back office by explicit permissions", () => {
    const workforce = session("EMPLOYEE", workforcePermissions);
    for (const path of [
      "/admin/attendance/workforce",
      "/admin/attendance/workforce/locations",
      "/admin/attendance/workforce/schedules",
      "/admin/attendance/workforce/assignments",
      "/admin/attendance/workforce/roster",
      "/admin/attendance/workforce/clarifications",
      "/admin/attendance/workforce/mobile",
      "/admin/attendance/workforce/overtime",
      "/admin/attendance/workforce/shift-swaps",
      "/admin/attendance/workforce/reports",
    ]) {
      expect(canAccessAdminPath(workforce, path)).toBe(true);
    }
    expect(canAccessAdminPath(workforce, "/admin/attendance/adms")).toBe(false);

    const deviceOperator = session("EMPLOYEE", ["attendance.devices.read"]);
    expect(canAccessAdminPath(deviceOperator, "/admin/attendance/adms")).toBe(true);
    expect(canAccessAdminPath(deviceOperator, "/admin/attendance/adms/transactions")).toBe(true);
    expect(canAccessAdminPath(deviceOperator, "/admin/attendance/devices")).toBe(true);
    const html = renderToStaticMarkup(<AdminNavigation active="attendance-adms" session={deviceOperator} />);
    expect(html).toContain('href="/admin/attendance/adms"');
    expect(html).toContain('href="/admin/attendance/devices"');
  });

  it("keeps Board governance-only and honors trusted legacy compatibility context", () => {
    const board = session("FOUNDATION_BOARD", []);
    expect(landingPath(board)).toBe("/board");
    expect(canAccessAdminPath(board, "/admin/payslips")).toBe(false);
    const legacy = session("SUPER_ADMIN", [...hcAdmin, "attendance.devices.read", "attendance.devices.configure", "attendance.devices.biometrics"]);
    expect(landingPath(legacy)).toBe("/admin");
    expect(renderToStaticMarkup(<AdminNavigation active="overview" session={legacy} />)).toContain('href="/admin/attendance/devices"');
    expect(canAccessAdminPath(legacy, "/admin/attendance/devices/id/biometrics")).toBe(true);
    expect(canAccessAdminPath(legacy, "/admin/unknown")).toBe(false);
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
