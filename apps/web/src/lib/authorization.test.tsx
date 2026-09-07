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

describe("AUTH-011 backend-derived admin navigation", () => {
  it("shows intended HC admin surfaces in both desktop and compact menus", () => {
    const actor = session("EMPLOYEE", hcAdmin);
    expect(landingPath(actor)).toBe("/admin");
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
