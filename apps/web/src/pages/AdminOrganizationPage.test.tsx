import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  OrganizationDesignerView,
  OrganizationEmployeeOption,
  OrganizationRolloutConfiguration,
} from "@/lib/organizationDesigner";
import { OrganizationDesignerWorkspace } from "@/pages/AdminOrganizationPage";
import type { AuthSession, PrincipalType } from "@/types/hcis";

function session(principalType: PrincipalType, permissions: string[]): AuthSession {
  return {
    principal: { id: "synthetic-actor", email: "actor@example.invalid", principalType },
    expiresAt: "2099-01-01T00:00:00Z",
    authorization: { organizationPermissions: permissions },
  };
}

const employees: OrganizationEmployeeOption[] = [
  { id: "employee-active", employeeNumber: "SYN-001", fullName: "Pegawai Aktif Sintetis", unitName: "Unit Sintetis", positionName: "Guru", status: "active" },
  { id: "employee-inactive", employeeNumber: "SYN-002", fullName: "Pegawai Nonaktif Sintetis", unitName: "Unit Sintetis", positionName: "Guru", status: "resigned" },
];

/** No rollout row configured: `GET /rollout` answers with its default object and no updatedAt. */
const legacyRollout: OrganizationRolloutConfiguration = {
  mode: "LEGACY",
  workflowKey: "LEAVE",
  organizationalNodeKey: null,
};

function view(overrides: Partial<OrganizationDesignerView> = {}): OrganizationDesignerView {
  return {
    viewDate: "2026-10-23",
    mode: "DRAFT",
    draft: {
      id: "synthetic-draft",
      name: "Perubahan Struktur Sintetis",
      effectiveOn: "2027-01-01",
      status: "DRAFT",
      validationReport: null,
      createdAt: "2026-10-16T00:00:00Z",
      validatedAt: null,
      publishedAt: null,
    },
    nodes: [{
      id: "node-id", stableKey: "node-key", name: "Sekolah Sintetis", nodeType: "UNIT",
      parentNodeKey: null, active: true, effectiveFrom: "2027-01-01", effectiveTo: null,
      visualRankOffset: 0, integrationCode: null, memberCount: 1, leaderPositionKey: "position-key",
    }],
    positions: [{
      id: "position-id", stableKey: "position-key", nodeKey: "node-key", title: "Kepala Sekolah Sintetis",
      parentPositionKey: null, singleIncumbent: true, vacancyPolicy: "CLIMB_TO_PARENT", active: true,
      effectiveFrom: "2027-01-01", effectiveTo: null, visualRankOffset: 0,
      primaryIncumbent: null, actingIncumbent: null,
    }],
    memberships: [],
    assignments: [],
    bindings: [],
    reportingOverrides: [],
    ...overrides,
  };
}

function render(input: {
  actor: AuthSession | null;
  data?: OrganizationDesignerView | null;
  rollout?: OrganizationRolloutConfiguration | null;
  rolloutFailed?: boolean;
  employeesFailed?: boolean;
}) {
  return renderToStaticMarkup(
    <OrganizationDesignerWorkspace
      session={input.actor}
      view={input.data === undefined ? view() : input.data}
      rollout={input.rollout === undefined ? legacyRollout : input.rollout}
      rolloutFailed={input.rolloutFailed ?? false}
      employees={employees}
      employeesFailed={input.employeesFailed ?? false}
      loading={false}
      effectiveDate="2026-10-23"
      onEffectiveDateChange={() => undefined}
      onDraftIdChange={() => undefined}
      onReload={() => Promise.resolve()}
      onRetryEmployees={() => undefined}
    />,
  );
}

/**
 * ORG-008-J is about what the operator reads. Stable keys stay in `data-*` attributes because the
 * ORG-004 visual-ranking contract requires them for layout assertions, so the check runs on text.
 */
function visibleText(html: string) {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
}

const hcAdmin = session("EMPLOYEE", ["organization.manage", "employees.manage"]);
const publisher = session("SUPER_ADMIN", ["organization.manage", "approvals.policy.manage"]);

describe("ORG-008-1 tombol mengikuti izin yang benar-benar dipakai API", () => {
  it("hides publishing from an HC admin and says who it waits for", () => {
    const html = render({ actor: hcAdmin });
    expect(html).toContain("Terbitkan: menunggu Kepala HC");
    expect(html).not.toContain(">Terbitkan<");
  });

  it("offers publishing to a principal holding approvals.policy.manage", () => {
    const html = render({ actor: publisher });
    expect(html).toContain("Terbitkan");
    expect(html).not.toContain("menunggu Kepala HC");
  });

  it("keeps composing available to an HC admin", () => {
    const html = render({ actor: hcAdmin });
    expect(html).toContain("Periksa");
    expect(html).toContain("Lihat dampak");
    expect(html).toContain("Tutup perubahan");
  });

  it("refuses the whole screen without organization.manage", () => {
    const html = render({ actor: session("EMPLOYEE", ["leave.validate"]) });
    expect(html).toContain("Anda tidak punya akses ke Struktur Organisasi");
    expect(html).not.toContain("Mulai perubahan struktur");
  });
});

describe("ORG-008-1 banner mode selalu tampil (acceptance ORG-008-K)", () => {
  it("states that approvals still use the legacy manager data", () => {
    const html = render({ actor: hcAdmin });
    expect(html).toContain("Persetujuan cuti saat ini memakai data atasan lama.");
    expect(html).toContain("belum dipakai untuk persetujuan");
  });

  it("does not claim a mode when the rollout endpoint fails", () => {
    const html = render({ actor: hcAdmin, rollout: null, rolloutFailed: true });
    expect(html).toContain("Mode persetujuan tidak dapat dimuat.");
    expect(html).not.toContain("Persetujuan cuti saat ini memakai data atasan lama.");
  });
});

describe("ORG-008-1 bahasa operator di layar utama (acceptance ORG-008-J)", () => {
  it("shows no raw enum, error code, or stable key in anything the operator reads", () => {
    const text = visibleText(render({ actor: publisher }));
    for (const leak of [
      "DRAFT", "VALIDATED", "PUBLISHED", "CLIMB_TO_PARENT", "REQUIRE_ACTING_OR_BLOCK",
      "LEADER", "UNIT_APPROVER", "SUPERVISORY_PARENT", "GOVERNANCE_APPROVER", "OVERSIGHT_PARENT",
      "FOUNDATION", "DIRECTORATE", "DEPARTMENT", "VACANT", "node-key", "position-key", "synthetic-draft",
    ]) {
      expect(text).not.toContain(leak);
    }
  });

  it("uses the operator vocabulary for the unit, the seat, and the change", () => {
    const html = render({ actor: publisher });
    expect(html).toContain("Sekolah/Unit");
    expect(html).toContain("Kosong · belum ada pejabat");
    expect(html).toContain("Sedang disusun");
    expect(html).toContain("Berlaku mulai");
  });
});

describe("ORG-008-1 perubahan tidak hilang dan kegagalan tidak disamarkan", () => {
  it("replaces the date picker while a change is open, so switching dates cannot close it (gap D-1)", () => {
    const html = render({ actor: hcAdmin });
    expect(html).toContain("Perubahan yang sedang dibuka");
    expect(html).toContain("Perubahan Struktur Sintetis");
    expect(html).not.toContain('type="date"');
  });

  it("offers the date picker again once no change is open", () => {
    const html = render({ actor: hcAdmin, data: view({ draft: null, mode: "CURRENT" }) });
    expect(html).toContain('type="date"');
    expect(html).toContain("Mulai perubahan struktur");
  });

  it("reports a failed employee list as an error instead of an empty list (gap U-2)", () => {
    const html = render({ actor: hcAdmin, employeesFailed: true });
    expect(html).toContain("Daftar pegawai tidak dapat dimuat");
    expect(html).toContain("Coba lagi");
  });

  it("shows the empty structure state in Indonesian", () => {
    const html = render({ actor: hcAdmin, data: view({ nodes: [], positions: [], draft: null, mode: "CURRENT" }) });
    expect(html).toContain("Belum ada struktur");
    expect(html).not.toContain("Start organization structure");
  });
});
