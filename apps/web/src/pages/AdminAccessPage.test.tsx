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

// AUTH-002-INVITE: in Akun SQ mode an invited employee gets "Kirim aktivasi" instead of a local link.
describe("AUTH-002-INVITE activation controls", () => {
  const hc = session("EMPLOYEE", ["access.manage"]);
  const invited = { ...data.accounts[0]!, status: "invited" as const, assignments: [] };

  it("offers Kirim aktivasi and no local link in invitation mode", () => {
    const html = renderToStaticMarkup(
      <AdminAccessWorkspace session={hc} data={{ ...data, activationMethod: "invitation", accounts: [invited] }} onDataChange={() => undefined} />,
    );
    expect(html).toContain(">Kirim aktivasi</button>");
    expect(html).not.toContain("Buat link aktivasi");
  });

  it("keeps the activation link in local mode", () => {
    const html = renderToStaticMarkup(
      <AdminAccessWorkspace session={hc} data={{ ...data, activationMethod: "link", accounts: [invited] }} onDataChange={() => undefined} />,
    );
    expect(html).toContain("Buat link aktivasi");
    expect(html).not.toContain("Kirim aktivasi");
  });

  it("shows the latest send per channel without contacts and offers a resend", () => {
    const html = renderToStaticMarkup(
      <AdminAccessWorkspace
        session={hc}
        data={{
          ...data,
          activationMethod: "invitation",
          accounts: [{
            ...invited,
            latestInvitation: {
              sentAt: "2026-11-04T03:00:00Z", emailStatus: "sent", whatsappStatus: "no_phone",
              hubAccess: "granted", completedAt: null, revokedAt: null,
            },
          }],
        }}
        onDataChange={() => undefined}
      />,
    );
    expect(html).toContain("Kirim ulang aktivasi");
    expect(html).toContain("Email Akun SQ terkirim");
    expect(html).toContain("nomor HP pegawai kosong");
  });
});

// AUTH-002 closing note: in Akun SQ mode no local password link is offered to anyone.
describe("AUTH-002 local activation hidden in Akun SQ mode", () => {
  const governance = session("SUPER_ADMIN", ["access.manage", "access.governance.manage"]);
  const invitedBoard = {
    ...data.accounts[0]!, id: "synthetic-board", employeeId: null, principalType: "FOUNDATION_BOARD" as const,
    status: "invited" as const, employeeNumber: null, employeeName: null, employeeStatus: null, unitName: null, assignments: [],
  };

  it("offers no local link for an invited Organ Yayasan account and prepares it without one", () => {
    const html = renderToStaticMarkup(
      <AdminAccessWorkspace session={governance} data={{ ...data, activationMethod: "invitation", accounts: [invitedBoard] }} onDataChange={() => undefined} />,
    );
    expect(html).not.toContain("Buat link aktivasi");
    expect(html).toContain(">Siapkan account</button>");
    expect(html).not.toContain("link aktivasi</button>");
  });

  it("keeps the Organ Yayasan link in local mode", () => {
    const html = renderToStaticMarkup(
      <AdminAccessWorkspace session={governance} data={{ ...data, activationMethod: "link", accounts: [invitedBoard] }} onDataChange={() => undefined} />,
    );
    expect(html).toContain("Buat link aktivasi");
    expect(html).toContain("Siapkan account &amp; link aktivasi");
  });
});
