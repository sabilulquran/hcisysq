import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  OrganizationDesignerView,
  OrganizationEmployeeOption,
  OrganizationRolloutConfiguration,
} from "@/lib/organizationDesigner";
import { OrganizationDesignerWorkspace, classificationOptions, positionClassificationPatch } from "@/pages/AdminOrganizationPage";
import type { JobClassification } from "@/lib/jobClassifications";
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
  /** ORG-011: null is the ordinary case for an account without job_classifications.read. */
  classifications?: JobClassification[] | null;
  classificationsTruncated?: boolean;
  classificationsFailed?: boolean;
}) {
  return renderToStaticMarkup(
    <OrganizationDesignerWorkspace
      session={input.actor}
      view={input.data === undefined ? view() : input.data}
      rollout={input.rollout === undefined ? legacyRollout : input.rollout}
      rolloutFailed={input.rolloutFailed ?? false}
      employees={employees}
      classifications={input.classifications ?? null}
      classificationsTruncated={input.classificationsTruncated ?? false}
      classificationsFailed={input.classificationsFailed ?? false}
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
  it("hides publishing from an HC admin and says who publishes", () => {
    const html = render({ actor: hcAdmin });
    expect(html).toContain("Diterbitkan oleh Kepala HC");
    expect(html).not.toContain(">Terbitkan<");
  });

  it("tells an HC admin a checked change is waiting for Kepala HC (ORG-008-8)", () => {
    const validated = view();
    validated.draft = { ...validated.draft!, status: "VALIDATED", validatedAt: "2026-10-20T00:00:00Z" };
    const html = render({ actor: hcAdmin, data: validated });
    expect(visibleText(html)).toContain("Siap diterbitkan — menunggu Kepala HC");
    expect(html).not.toContain(">Terbitkan<");
  });

  it("offers an HC admin the composing start that writes leaders and approvers (ORG-008-8, O-1)", () => {
    // Before ORG-008-8 this needed approvals.policy.manage, so an HC admin never saw it.
    const empty = view({ nodes: [], positions: [], draft: null, mode: "CURRENT" });
    expect(visibleText(render({ actor: hcAdmin, data: empty }))).toContain("Mulai dari data yang sudah ada");
  });

  it("offers publishing to a principal holding approvals.policy.manage", () => {
    const html = render({ actor: publisher });
    expect(html).toContain("Terbitkan");
    expect(html).not.toContain("menunggu Kepala HC");
  });

  it("explains instead of offering Terbitkan to a publisher who composed the change (ORG-008-10)", () => {
    const own = view();
    own.publishBlockedForSelf = true;
    const text = visibleText(render({ actor: publisher, data: own }));
    expect(text).toContain("Anda ikut menyusun — terbitkan oleh Kepala HC lain atau Super Admin");
    expect(text).not.toMatch(/ Terbitkan /);
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

describe("ORG-008-4d daftar \"Yang berubah\" menyertai perubahan", () => {
  it("shows the change list while a change is open", () => {
    const text = visibleText(render({ actor: publisher }));
    expect(text).toContain("Yang berubah");
    expect(text).toContain("Belum ada yang diubah pada perubahan ini");
  });

  it("does not show the change list when no change is open", () => {
    const text = visibleText(render({ actor: publisher, data: view({ draft: null, mode: "CURRENT" }) }));
    expect(text).not.toContain("Yang berubah");
  });

  it("warns, and offers the way out, when another publication replaced the base", () => {
    const stale = view({
      staleBase: {
        changeSetId: "other", name: "Koreksi Oktober",
        effectiveOn: "2026-10-24", publishedAt: "2026-10-20T00:00:00Z",
      },
    });
    const text = visibleText(render({ actor: publisher, data: stale }));

    expect(text).toContain("Struktur sudah diubah oleh");
    expect(text).toContain("Koreksi Oktober");
    expect(text).toContain("Perbarui dari struktur terbaru");
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

describe("ORG-011 seat classification in the designer", () => {
  const guru: JobClassification = {
    id: "c1", code: "FUNC_GURU", name: "Guru", family: "FUNCTIONAL",
    gradeCode: null, active: true, effectiveFrom: "2026-01-01", effectiveTo: null,
  };
  const closing: JobClassification = { ...guru, id: "c2", code: "FUNC_LAMA", name: "Guru Lama", effectiveTo: "2026-12-31" };
  const family = () => "Fungsional";

  it("sends nothing about the classification when the catalog could not be read", () => {
    // organization.manage does not carry job_classifications.read, so this is an ordinary
    // account, not a broken one. Sending null here would clear a seat on every title edit.
    expect(positionClassificationPatch("FUNC_GURU", null, "FUNC_GURU")).toEqual({});
    expect(positionClassificationPatch(null, null, "FUNC_GURU")).toEqual({});
  });

  it("sends the key only when the operator actually changed it", () => {
    expect(positionClassificationPatch("FUNC_GURU", [guru], null)).toEqual({ jobClassificationCode: "FUNC_GURU" });
    expect(positionClassificationPatch("", [guru], "FUNC_GURU")).toEqual({ jobClassificationCode: null });
    // Unchanged: an absent key is what keeps a lapsed code from being refused on a title edit.
    expect(positionClassificationPatch("FUNC_GURU", [guru], "FUNC_GURU")).toEqual({});
    expect(positionClassificationPatch("", [guru], null)).toEqual({});
  });

  it("keeps a lapsed code in the list so a plain edit cannot wipe it", () => {
    // A cloned change set moves to a new date and a classification can be closed afterwards.
    // Without this option the select would match nothing, fall back to the empty choice, and
    // a title edit would silently clear the seat.
    const options = classificationOptions([guru], "FUNC_DIHAPUS", family);
    expect(options[0]).toEqual({
      code: "FUNC_DIHAPUS", label: "FUNC_DIHAPUS (tidak berlaku pada tanggal ini)", lapsed: true,
    });
    expect(options.map((option) => option.code)).toContain("FUNC_GURU");
  });

  it("does not duplicate a code that is still in the catalog", () => {
    const options = classificationOptions([guru], "FUNC_GURU", family);
    expect(options.filter((option) => option.code === "FUNC_GURU")).toHaveLength(1);
    expect(options[0]?.lapsed).toBe(false);
  });

  it("names the day a classification stops applying", () => {
    expect(classificationOptions([closing], null, family)[0]?.label)
      .toBe("Guru Lama (Fungsional, berakhir 2026-12-31)");
  });
});
