import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { canManageRoleAssignments } from "@/lib/authorization";
import type { AccessAdminResponse } from "@/lib/adminOrgAccess";
import { AdminAccessWorkspace } from "@/pages/AdminAccessPage";
import type { AuthSession, PrincipalType } from "@/types/hcis";

function session(principalType: PrincipalType, permissions: string[]): AuthSession {
  return { principal: { id: "synthetic-actor", email: "actor@example.invalid", principalType },
    expiresAt: "2099-01-01T00:00:00Z", authorization: { organizationPermissions: permissions } };
}

const data: AccessAdminResponse = {
  accounts: [{
    id: "synthetic-account", employeeId: "synthetic-employee", email: "employee@example.invalid",
    principalType: "EMPLOYEE", status: "active", employeeNumber: "SYN-001", employeeName: "Synthetic Employee",
    employeeStatus: "active", unitName: "Synthetic Unit", createdAt: "2026-01-01T00:00:00Z",
    assignments: [{
      id: "synthetic-assignment", accountId: "synthetic-account", roleId: "synthetic-role", roleKey: "human_capital",
      roleName: "Synthetic Human Capital", scopeType: "organization", organizationalUnitId: null,
      organizationalUnitName: null, startsOn: null, endsOn: null, reason: null, createdAt: "2026-01-01T00:00:00Z",
    }],
  }],
  pagination: { page: 1, pageSize: 25, total: 1, pageCount: 1 },
  roles: [{ id: "synthetic-role", roleKey: "human_capital", name: "Synthetic Human Capital", description: null, permissions: ["leave.validate"] }],
  units: [{ id: "synthetic-unit", name: "Synthetic Unit" }],
  summary: { accounts: 1, active: 1, invited: 0, unaccountedActiveEmployees: 0 },
};

const render = (actor: AuthSession | null) =>
  renderToStaticMarkup(<AdminAccessWorkspace session={actor} data={data} onDataChange={() => undefined} />);

// The API returns 403 ROLE_GRANT_SUPER_ADMIN_ONLY for everyone else; this only hides the controls.
describe("AUTH-011 role-assignment controls follow backend authorization context", () => {
  it("shows create and remove controls to a Super Admin principal", () => {
    const actor = session("SUPER_ADMIN", ["access.manage", "access.roles.assign"]);
    expect(canManageRoleAssignments(actor)).toBe(true);
    const html = render(actor);
    expect(html).toContain("Tambah role tambahan");
    expect(html).toContain("Tambah assignment");
    expect(html).toContain(">Cabut</button>");
    expect(html).toContain("Synthetic Human Capital");
  });

  it("hides create and remove controls from HC admins and other Employee principals", () => {
    for (const actor of [
      session("EMPLOYEE", ["access.manage"]),
      // Even a stale or custom grant of access.roles.assign does not make an Employee a role grantor.
      session("EMPLOYEE", ["access.manage", "access.roles.assign", "access.roles.delegate"]),
      session("SUPER_ADMIN", ["access.manage"]),
      session("FOUNDATION_BOARD", ["access.manage", "access.roles.assign"]),
      null,
    ]) {
      expect(canManageRoleAssignments(actor)).toBe(false);
      const html = render(actor);
      expect(html).not.toContain("Tambah role tambahan");
      expect(html).not.toContain("Tambah assignment");
      expect(html).not.toContain(">Cabut</button>");
      expect(html).toContain("hanya dapat diberikan atau dicabut oleh Super Admin");
      // Existing assignments and account administration stay visible.
      expect(html).toContain("Synthetic Human Capital");
      expect(html).toContain("Daftar account");
    }
  });
});

describe("AUTH-011 §Scope per peran: the role form offers only the scopes that make the role work", () => {
  const superAdmin = session("SUPER_ADMIN", ["access.manage", "access.roles.assign"]);
  const withRole = (role: AccessAdminResponse["roles"][number]) =>
    renderToStaticMarkup(<AdminAccessWorkspace session={superAdmin} data={{ ...data, roles: [role] }} onDataChange={() => undefined} />);

  it("fills in the scope and asks nothing when a role works only one way", () => {
    const html = withRole({ id: "director", roleKey: "director", name: "Direktur",
      description: "Menyetujui payroll.", permissions: ["payroll.approve"], allowedScopes: ["organization"] });
    expect(html).not.toContain('aria-label="Cakupan peran"');
    expect(html).toContain("Berlaku untuk seluruh organisasi");
    expect(html).toContain("Menyetujui payroll.");
  });

  it("asks only between the scopes the role allows, never 'own'", () => {
    const html = withRole({ id: "hc", roleKey: "human_capital", name: "Staf Human Capital",
      description: null, permissions: ["leave.validate"], allowedScopes: ["organization", "unit"] });
    expect(html).toContain('aria-label="Cakupan peran"');
    expect(html).toContain(">Seluruh organisasi</option>");
    expect(html).toContain(">Satu unit</option>");
    expect(html).not.toContain("Diri sendiri");
  });

  it("names an organization-wide assignment in words, not as a code", () => {
    expect(render(superAdmin)).toContain("· Seluruh organisasi");
    expect(render(superAdmin)).not.toContain("· organization");
  });
});
