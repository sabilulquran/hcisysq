import { describe, expect, it } from "vitest";

import type { OrganizationPosition, OrganizationRolloutConfiguration } from "@/lib/organizationDesigner";
import {
  organizationApiMessage,
  organizationAuthorityLabel,
  organizationDraftStatusLabel,
  organizationIssueSentence,
  organizationModeBanner,
  organizationNodeTypeLabel,
  organizationSeatEditability,
  organizationVacancyPolicyLabel,
} from "@/lib/organizationLanguage";

/** ORG-008 §7: every code the server can report must reach the operator as a sentence. */
const SPEC_ISSUE_CODES = [
  "PRIMARY_MEMBERSHIP_OVERLAP",
  "PRIMARY_INCUMBENCY_OVERLAP",
  "AUTHORITY_BINDING_OVERLAP",
  "STRUCTURAL_NODE_CYCLE",
  "SUPERVISORY_POSITION_CYCLE",
  "AUTHORITY_LOOP",
  "INACTIVE_INCUMBENT",
  "INVALID_NODE_PARENT",
  "INVALID_POSITION_PARENT",
  "INVALID_MEMBERSHIP_REFERENCE",
  "INVALID_BINDING_REFERENCE",
  "AUTHORITY_NOT_CONFIGURED",
  "MEMBERSHIP_NOT_CONFIGURED",
  "AMBIGUOUS_MEMBERSHIP",
  "AUTHORITY_VACANT",
  "ACTING_AUTHORITY_REQUIRED",
  "AUTHORITY_INELIGIBLE",
  "AUTHORITY_SELF_RESOLUTION",
  "AUTHORITY_TRAVERSAL_LIMIT",
  "ORGANIZATION_DRAFT_BASE_STALE",
  "ORGANIZATION_DRAFT_CHANGED",
  "PRIMARY_STRUCTURAL_EDIT_REQUIRES_REVIEW",
  "ACCOUNT_HELD_POSITION_EDIT_REQUIRES_REVIEW",
] as const;

function position(overrides: Partial<OrganizationPosition> = {}): OrganizationPosition {
  return {
    id: "synthetic-position-id",
    stableKey: "synthetic-position",
    nodeKey: "synthetic-node",
    title: "Kepala Sekolah Sintetis",
    parentPositionKey: null,
    singleIncumbent: true,
    vacancyPolicy: "CLIMB_TO_PARENT",
    active: true,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    visualRankOffset: 0,
    primaryIncumbent: null,
    actingIncumbent: null,
    ...overrides,
  };
}

describe("ORG-008-1 kamus istilah", () => {
  it("translates every node type named by the spec and never leaks an unknown enum", () => {
    expect(organizationNodeTypeLabel("FOUNDATION")).toBe("Yayasan");
    expect(organizationNodeTypeLabel("DIRECTORATE")).toBe("Bidang");
    expect(organizationNodeTypeLabel("UNIT")).toBe("Sekolah/Unit");
    expect(organizationNodeTypeLabel("DIVISION")).toBe("Divisi");
    expect(organizationNodeTypeLabel("DEPARTMENT")).toBe("Bagian");
    expect(organizationNodeTypeLabel("TEAM")).toBe("Tim");
    expect(organizationNodeTypeLabel("SOME_FUTURE_TYPE")).toBe("Unit lainnya");
    expect(organizationNodeTypeLabel("SOME_FUTURE_TYPE")).not.toContain("_");
  });

  it("states the vacancy rule as a sentence instead of the stored enum", () => {
    expect(organizationVacancyPolicyLabel("CLIMB_TO_PARENT")).toBe("Bila kosong: naik ke atasan berikutnya");
    expect(organizationVacancyPolicyLabel("REQUIRE_ACTING_OR_BLOCK")).toContain("wajib ada Plt");
    expect(organizationVacancyPolicyLabel("BLOCK")).toBe("Bila kosong: pengajuan ditahan");
  });

  it("names each authority binding the way the operator reads it", () => {
    expect(organizationAuthorityLabel("LEADER")).toBe("Pemimpin unit");
    expect(organizationAuthorityLabel("UNIT_APPROVER")).toBe("Penyetuju cuti unit");
    expect(organizationAuthorityLabel("SUPERVISORY_PARENT")).toBe("Melapor ke");
    expect(organizationAuthorityLabel("GOVERNANCE_APPROVER")).toBe("Penyetuju khusus untuk jabatan ini");
    expect(organizationAuthorityLabel("OVERSIGHT_PARENT")).toBe("Diberi tahu setelah disetujui");
  });

  it("reads a published change set as scheduled or effective, never as the raw status", () => {
    expect(organizationDraftStatusLabel("DRAFT")).toBe("Sedang disusun");
    expect(organizationDraftStatusLabel("VALIDATED")).toBe("Siap diterbitkan");
    expect(organizationDraftStatusLabel("PUBLISHED", { effectiveOn: "2027-01-01", today: "2026-10-23" }))
      .toBe("Terjadwal berlaku 2027-01-01");
    expect(organizationDraftStatusLabel("PUBLISHED", { effectiveOn: "2026-10-01", today: "2026-10-23" }))
      .toBe("Berlaku");
  });
});

describe("ORG-008-1 pesan masalah", () => {
  it("maps every code listed by the spec to an Indonesian sentence without the code", () => {
    for (const code of SPEC_ISSUE_CODES) {
      const sentence = organizationIssueSentence({ code, itemKey: null });
      expect(sentence).not.toContain(code);
      expect(sentence).not.toMatch(/[A-Z]{3,}_[A-Z]/);
      expect(sentence.length).toBeGreaterThan(20);
    }
  });

  it("uses the item name when the chart knows it", () => {
    const sentence = organizationIssueSentence(
      { code: "AUTHORITY_NOT_CONFIGURED", itemKey: "node-key" },
      (key) => (key === "node-key" ? "SDIT · Kurikulum" : null),
    );
    expect(sentence).toBe("Unit SDIT · Kurikulum dan unit di atasnya belum punya pemimpin.");
  });

  it("stays truthful instead of inventing a name the chart cannot resolve", () => {
    const sentence = organizationIssueSentence({ code: "MEMBERSHIP_NOT_CONFIGURED", itemKey: "unknown" }, () => null);
    expect(sentence).toBe("Ada pegawai yang belum punya unit.");
  });

  it("keeps an unmapped code off the screen and points at the technical panel", () => {
    const sentence = organizationIssueSentence({ code: "SOME_NEW_SERVER_CODE", itemKey: null });
    expect(sentence).not.toContain("SOME_NEW_SERVER_CODE");
    expect(sentence).toContain("dukungan teknis");
  });

  it("translates API failures and falls back to the caller sentence, never to the code", () => {
    expect(organizationApiMessage("ORGANIZATION_DRAFT_NOT_VALIDATED", "x")).toContain("diperiksa dulu");
    expect(organizationApiMessage("ACCOUNT_HELD_POSITION_EDIT_REQUIRES_REVIEW", "x")).toContain("akun Dewan");
    expect(organizationApiMessage("A_CODE_WE_DO_NOT_KNOW", "Perubahan tidak dapat disimpan."))
      .toBe("Perubahan tidak dapat disimpan.");
    expect(organizationApiMessage(undefined, "Perubahan tidak dapat disimpan."))
      .toBe("Perubahan tidak dapat disimpan.");
  });
});

describe("ORG-008-1 banner mode (acceptance ORG-008-K)", () => {
  it("states LEGACY as a fact only when no rollout row exists", () => {
    // GET /admin/organization/rollout answers with its default object, so no row carries updatedAt.
    const banner = organizationModeBanner({ mode: "LEGACY", workflowKey: "LEAVE", organizationalNodeKey: null });
    expect(banner.certain).toBe(true);
    expect(banner.tone).toBe("info");
    expect(banner.title).toContain("data atasan lama");
    expect(banner.detail).toContain("belum dipakai untuk persetujuan");
  });

  it("refuses to claim a mode once any rollout row is configured", () => {
    const configured: OrganizationRolloutConfiguration = {
      mode: "SHADOW", workflowKey: "LEAVE", organizationalNodeKey: null,
      effectiveFrom: "2026-11-01", updatedAt: "2026-11-01T00:00:00Z",
    };
    const banner = organizationModeBanner(configured);
    expect(banner.certain).toBe(false);
    expect(banner.tone).toBe("warning");
    expect(banner.title).toContain("tidak dapat dipastikan");
  });

  it("says so plainly when the mode cannot be loaded", () => {
    const banner = organizationModeBanner(null, { loadFailed: true });
    expect(banner.certain).toBe(false);
    expect(banner.title).toContain("tidak dapat dimuat");
  });

  it("does not raise a false alarm while the mode is still loading", () => {
    const banner = organizationModeBanner(null, { pending: true });
    expect(banner.tone).toBe("info");
    expect(banner.certain).toBe(false);
    expect(banner.title).toContain("Memeriksa");
  });
});

describe("ORG-008-1 jabatan read-only", () => {
  it("marks an account-held seat read-only before the API refuses it", () => {
    const byHolderSource = organizationSeatEditability(position({ holderSource: "ACCOUNT" }));
    expect(byHolderSource.editable).toBe(false);
    expect(byHolderSource.badge).toBe("Belum bisa diubah di sini");
    expect(byHolderSource.reason).toContain("akun Dewan");

    const byIncumbent = organizationSeatEditability(position({
      primaryIncumbent: {
        employeeId: "", employeeName: "dewan@example.invalid", effectiveFrom: "2026-01-01",
        effectiveTo: null, accountId: "synthetic-account",
      },
    }));
    expect(byIncumbent.editable).toBe(false);
  });

  it("marks a seat held as someone's primary structural position read-only", () => {
    const result = organizationSeatEditability(position({
      primaryIncumbent: {
        employeeId: "synthetic-employee", employeeName: "Pegawai Sintetis", effectiveFrom: "2026-01-01",
        effectiveTo: null, isPrimaryStructural: true,
      },
    }));
    expect(result.editable).toBe(false);
    expect(result.reason).toContain("lebih dari satu jabatan");
  });

  it("leaves an ordinary employee-held seat editable", () => {
    const result = organizationSeatEditability(position({
      primaryIncumbent: {
        employeeId: "synthetic-employee", employeeName: "Pegawai Sintetis",
        effectiveFrom: "2026-01-01", effectiveTo: null,
      },
    }));
    expect(result).toEqual({ editable: true, badge: null, reason: null });
  });
});
