import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  OrganizationActingTab,
  OrganizationApprovalCheckTab,
  OrganizationPeopleTab,
  OrganizationReadinessTab,
} from "@/components/organization/OrganizationReadOnlyTabs";
import type { OrganizationPosition } from "@/lib/organizationDesigner";
import { organizationModeBanner } from "@/lib/organizationLanguage";
import type {
  OrganizationApprovalPreview,
  OrganizationExplanation,
  OrganizationPeoplePage,
  OrganizationPerson,
  OrganizationReadiness,
} from "@/lib/organizationReadModel";

function visibleText(html: string) {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
}

const readiness: OrganizationReadiness = {
  asOf: "2026-10-24",
  changeSetId: null,
  activeEmployees: 412,
  withoutUnit: 23,
  unresolvedManager: 7,
  ineligibleManagers: 4,
  vacantRequiringActing: 2,
  actingEndingSoon: [
    { positionKey: "position-social", positionTitle: "Kepala Divisi Sosial", employeeId: "employee-yusuf", endsOn: "2026-10-31" },
  ],
  comparison: { same: 398, different: 9, unresolved: 5, noLegacy: 0 },
};

const person: OrganizationPerson = {
  employeeId: "employee-ahmad",
  employeeNumber: "S-014",
  fullName: "Ahmad Sintetis",
  unit: { nodeKey: "node-curriculum", name: "Kurikulum", path: ["SDIT", "Kurikulum"] },
  position: null,
  directManager: {
    employeeId: "employee-yusuf", employeeName: "Yusuf Sintetis",
    positionKey: "position-vice", positionTitle: "Wakil Kepala Kurikulum", incumbentKind: "PRIMARY",
  },
  source: "MEMBERSHIP_LEADER",
  sourceDetails: ["MEMBERSHIP_LEADER"],
  unitApprover: {
    employeeId: "employee-hasan", employeeName: "Hasan Sintetis",
    positionKey: "position-head", positionTitle: "Kepala SDIT", incumbentKind: "PRIMARY",
  },
  issues: [],
  legacy: {
    directManagerEmployeeId: "employee-yusuf", directManagerName: "Yusuf Sintetis",
    unitApproverEmployeeId: null, unitApproverName: null, unitName: "SDIT", comparison: "SAME",
  },
};

const unplaced: OrganizationPerson = {
  ...person,
  employeeId: "employee-citra",
  employeeNumber: "S-031",
  fullName: "Citra Sintetis",
  unit: null,
  directManager: null,
  source: null,
  sourceDetails: [],
  unitApprover: null,
  issues: [{ scope: "MEMBERSHIP", code: "MEMBERSHIP_NOT_CONFIGURED" }],
  legacy: null,
};

const peoplePage: OrganizationPeoplePage = {
  asOf: "2026-10-24", changeSetId: null, page: 1, pageSize: 50, total: 2, items: [person, unplaced],
};

const noop = () => undefined;

describe("ORG-008-2b Kesiapan", () => {
  it("states what needs fixing, in counts and operator words", () => {
    const html = renderToStaticMarkup(
      <OrganizationReadinessTab
        readiness={readiness} loading={false} error={null}
        onRetry={noop} onOpenIssue={noop} onOpenActing={noop}
      />,
    );
    const text = visibleText(html);

    expect(text).toContain("23 pegawai aktif belum punya unit");
    expect(text).toContain("7 pegawai atasannya belum bisa ditentukan");
    expect(text).toContain("2 jabatan kosong yang mewajibkan Plt, tanpa Plt");
    expect(text).toContain("1 Plt berakhir dalam 14 hari");
    expect(text).toContain("412 pegawai aktif");
  });

  it("says plainly that the comparison changes nothing", () => {
    const html = renderToStaticMarkup(
      <OrganizationReadinessTab
        readiness={readiness} loading={false} error={null}
        onRetry={noop} onOpenIssue={noop} onOpenActing={noop}
      />,
    );
    const text = visibleText(html);

    expect(text).toContain("Dibanding data atasan lama");
    expect(text).toContain("tidak mengubah mode persetujuan");
    expect(text).toContain("398");
  });

  it("reports a failed load as an error with a retry, not as zero problems", () => {
    const html = renderToStaticMarkup(
      <OrganizationReadinessTab
        readiness={null} loading={false} error="Kesiapan tidak dapat dihitung."
        onRetry={noop} onOpenIssue={noop} onOpenActing={noop}
      />,
    );
    expect(visibleText(html)).toContain("Kesiapan tidak dapat dihitung.");
    expect(html).toContain("Coba lagi");
    expect(visibleText(html)).not.toContain("Tidak ada yang perlu dibereskan");
  });
});

describe("ORG-008-2b Pegawai", () => {
  const render = (overrides: Partial<Parameters<typeof OrganizationPeopleTab>[0]> = {}) =>
    renderToStaticMarkup(
      <OrganizationPeopleTab
        page={peoplePage} loading={false} error={null} onRetry={noop}
        query="" issue="" onQueryChange={noop} onIssueChange={noop} onPageChange={noop}
        selectedEmployeeId={null} explanation={null} explanationLoading={false}
        onSelect={noop} onCloseExplanation={noop}
        {...overrides}
      />,
    );

  it("shows each employee with unit, direct manager, and the reason in Indonesian", () => {
    const text = visibleText(render());

    expect(text).toContain("Ahmad Sintetis");
    expect(text).toContain("SDIT › Kurikulum");
    expect(text).toContain("Yusuf Sintetis");
    expect(text).toContain("pemimpin unitnya");
    // The source enum itself must not reach the screen.
    expect(text).not.toContain("MEMBERSHIP_LEADER");
  });

  it("shows an employee with no unit as a problem rather than hiding them", () => {
    const text = visibleText(render());
    expect(text).toContain("Citra Sintetis");
    expect(text).toContain("Perlu dibereskan");
  });

  it("explains the answer in sentences, with no step code on screen", () => {
    const explanation: OrganizationExplanation = {
      asOf: "2026-10-24",
      employeeId: person.employeeId,
      person,
      steps: [
        { code: "MEMBER_OF_UNIT", params: { employee: "Ahmad Sintetis", unit: "SDIT › Kurikulum" } },
        { code: "UNIT_LEADER_IS_POSITION", params: { unit: "Kurikulum", position: "Wakil Kepala Kurikulum" } },
        { code: "RESULT_DIRECT_MANAGER", params: { employee: "Yusuf Sintetis", position: "Wakil Kepala Kurikulum" } },
      ],
    };
    const text = visibleText(render({ selectedEmployeeId: person.employeeId, explanation }));

    expect(text).toContain("Ahmad Sintetis adalah anggota SDIT › Kurikulum.");
    expect(text).toContain("Pemimpin unit Kurikulum adalah jabatan Wakil Kepala Kurikulum.");
    expect(text).toContain("Atasan langsungnya: Yusuf Sintetis");
    for (const code of ["MEMBER_OF_UNIT", "UNIT_LEADER_IS_POSITION", "RESULT_DIRECT_MANAGER"]) {
      expect(text).not.toContain(code);
    }
  });

  it("skips a step code it does not know instead of printing it raw", () => {
    const explanation: OrganizationExplanation = {
      asOf: "2026-10-24", employeeId: person.employeeId, person,
      steps: [{ code: "SOME_FUTURE_STEP", params: { employee: "Ahmad Sintetis" } }],
    };
    const text = visibleText(render({ selectedEmployeeId: person.employeeId, explanation }));
    expect(text).not.toContain("SOME_FUTURE_STEP");
  });

  it("reports a failed load as an error, not as an empty list", () => {
    const html = render({ page: null, error: "Daftar pegawai tidak dapat dimuat." });
    expect(visibleText(html)).toContain("Daftar pegawai tidak dapat dimuat.");
    expect(visibleText(html)).not.toContain("Tidak ada pegawai yang cocok");
  });
});

describe("ORG-008-2b Plt & jabatan kosong", () => {
  const position = (stableKey: string, title: string, overrides: Partial<OrganizationPosition> = {}): OrganizationPosition => ({
    id: `${stableKey}-id`, stableKey, nodeKey: "node", title, parentPositionKey: null,
    singleIncumbent: true, vacancyPolicy: "REQUIRE_ACTING_OR_BLOCK", active: true,
    effectiveFrom: "2026-01-01", effectiveTo: null, visualRankOffset: 0,
    primaryIncumbent: null, actingIncumbent: null, ...overrides,
  });

  it("marks an acting appointment that ends within 14 days", () => {
    const positions = [
      position("position-social", "Kepala Divisi Sosial", {
        actingIncumbent: {
          employeeId: "employee-yusuf", employeeName: "Yusuf Sintetis",
          effectiveFrom: "2026-09-01", effectiveTo: "2026-10-31",
        },
      }),
      position("position-empty", "Kepala Bagian Umum"),
    ];
    const text = visibleText(renderToStaticMarkup(
      <OrganizationActingTab readiness={readiness} positions={positions} loading={false} error={null} onRetry={noop} />,
    ));

    expect(text).toContain("Kepala Divisi Sosial");
    expect(text).toContain("Plt Yusuf Sintetis");
    expect(text).toContain("berakhir dalam 14 hari");
    expect(text).toContain("Kepala Bagian Umum");
    expect(text).toContain("wajib ada Plt");
    expect(text).not.toContain("REQUIRE_ACTING_OR_BLOCK");
  });
});

describe("ORG-008-2b Cek persetujuan", () => {
  const preview: OrganizationApprovalPreview = {
    employee: { id: "employee-ahmad", fullName: "Ahmad Sintetis" },
    effectiveDate: "2026-10-24",
    workflow: "LEAVE_ANNUAL",
    workflowKey: "LEAVE",
    changeSetId: "change-set",
    preview: false,
    governanceApplied: false,
    steps: [
      { employeeId: "employee-yusuf", employeeName: "Yusuf Sintetis", positionTitle: "Wakil Kepala Kurikulum", authorityType: "DIRECT_MANAGER", source: "PRIMARY" },
      { employeeId: "employee-hasan", employeeName: "Hasan Sintetis", positionTitle: "Kepala SDIT", authorityType: "UNIT_APPROVER", source: "PRIMARY" },
    ],
    oversight: { employeeId: "employee-director", employeeName: "Fulan Sintetis", positionTitle: "Direktur", appliesInMode: "STRUCTURE" },
    warnings: [],
  };

  const render = (result: OrganizationApprovalPreview | null, legacyPerson: OrganizationPerson | null = null) =>
    renderToStaticMarkup(
      <OrganizationApprovalCheckTab
        employees={[{ id: "employee-ahmad", fullName: "Ahmad Sintetis", employeeNumber: "S-014" }]}
        employeeId="employee-ahmad" workflow="LEAVE_ANNUAL" date="2026-10-24"
        onEmployeeChange={noop} onWorkflowChange={noop} onDateChange={noop} onSubmit={noop}
        loading={false} error={null} result={result} legacyPerson={legacyPerson}
      />,
    );

  it("lists the approval steps in order and who is told afterwards", () => {
    const text = visibleText(render(preview));

    expect(text).toContain("1. Yusuf Sintetis");
    expect(text).toContain("2. Hasan Sintetis");
    expect(text).toContain("yang diberi tahu: Fulan Sintetis");
    expect(text).toContain("berlaku hanya bila persetujuan sudah memakai struktur ini");
    expect(text).toContain("Pengajuan yang sudah dikirim tidak berubah");
  });

  it("marks overtime as a preview while its approver rule is not decided", () => {
    const text = visibleText(render({ ...preview, workflow: "OVERTIME", preview: true, warnings: [{ code: "OVERTIME_CAPABILITY_PENDING" }] }));
    expect(text).toContain("syarat penyetuju lembur belum ditetapkan");
    expect(text).not.toContain("OVERTIME_CAPABILITY_PENDING");
  });

  it("shows the legacy answer beside the structural one", () => {
    const text = visibleText(render(preview, person));
    expect(text).toContain("Dengan data atasan lama: Yusuf Sintetis");
    expect(text).toContain("sama");
  });
});

describe("ORG-008-2b banner is now exact (acceptance ORG-008-K)", () => {
  it("states LEGACY as a fact when the server reports no rollout row", () => {
    const banner = organizationModeBanner({
      mode: "LEGACY", workflowKey: "LEAVE", organizationalNodeKey: null,
      configuredRowCount: 0, settings: [], asOf: "2026-10-24", updatedAt: "2026-10-01T00:00:00Z",
    });
    expect(banner.certain).toBe(true);
    expect(banner.title).toContain("data atasan lama");
  });

  it("still states LEGACY when every effective row is LEGACY", () => {
    const banner = organizationModeBanner({
      mode: "LEGACY", workflowKey: "LEAVE", organizationalNodeKey: null, configuredRowCount: 1,
      settings: [{ workflowKey: "LEAVE", organizationalNodeKey: null, mode: "LEGACY", effectiveFrom: "2026-01-01", effectiveTo: null }],
    });
    expect(banner.certain).toBe(true);
    expect(banner.tone).toBe("info");
  });

  it("warns, and no longer hedges, once a unit is on another mode", () => {
    const banner = organizationModeBanner({
      mode: "SHADOW", workflowKey: "LEAVE", organizationalNodeKey: null, configuredRowCount: 2,
      settings: [
        { workflowKey: "LEAVE", organizationalNodeKey: null, mode: "LEGACY", effectiveFrom: "2026-01-01", effectiveTo: null },
        { workflowKey: "LEAVE", organizationalNodeKey: "node-sdit", mode: "SHADOW", effectiveFrom: "2026-10-01", effectiveTo: null },
      ],
    });
    expect(banner.certain).toBe(true);
    expect(banner.tone).toBe("warning");
    expect(banner.title).toContain("Sebagian unit");
    expect(banner.detail).toContain("uji banding");
  });
});
