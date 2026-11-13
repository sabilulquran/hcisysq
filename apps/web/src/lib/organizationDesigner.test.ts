import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createOrganizationDraft,
  discardOrganizationDraft,
  getOrganizationDesignerView,
  listOpenOrganizationChanges,
  OrganizationDraftAlreadyOpenError,
  overtimeRuleSeatWarningText,
  updateOrganizationPosition,
  validateOrganizationDraft,
} from "@/lib/organizationDesigner";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Organization Designer API client", () => {
  it("requests an effective-dated draft chart", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ nodes: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await getOrganizationDesignerView({ effectiveDate: "2027-01-01", draftId: "draft-1" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/organization/designer?effectiveDate=2027-01-01&draftId=draft-1",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("sends visual-rank changes only as position presentation metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "position-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await updateOrganizationPosition("draft-1", "position-1", { visualRankOffset: 2 });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/organization/designer/drafts/draft-1/positions/position-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ visualRankOffset: 2 }),
      }),
    );
  });

  it("uses the server validation endpoint instead of validating authority client-side", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ valid: true, issues: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(validateOrganizationDraft("draft-1")).resolves.toEqual({ valid: true, issues: [] });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/organization/designer/drafts/draft-1/validate",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("ORG-008 follow-up: open change sets", () => {
  function reply(status: number, body: unknown) {
    return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }));
  }

  it("turns ORGANIZATION_DRAFT_ALREADY_OPEN into an error naming the open change", async () => {
    vi.stubGlobal("fetch", reply(409, {
      code: "ORGANIZATION_DRAFT_ALREADY_OPEN",
      message: "Another organization change is still open.",
      details: { changeSetId: "change-1", name: "Perubahan Lama", effectiveOn: "2026-08-21", status: "VALIDATED" },
    }));

    const failure = await createOrganizationDraft({ name: "Baru", effectiveOn: "2026-12-01" }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(OrganizationDraftAlreadyOpenError);
    expect((failure as OrganizationDraftAlreadyOpenError).code).toBe("ORGANIZATION_DRAFT_ALREADY_OPEN");
    expect((failure as OrganizationDraftAlreadyOpenError).openChange).toEqual({
      id: "change-1", name: "Perubahan Lama", effectiveOn: "2026-08-21", status: "VALIDATED",
    });
  });

  it("asks for open change sets one page at a time", async () => {
    const fetchMock = reply(200, { items: [], pagination: { page: 2, pageSize: 25, total: 0, pageCount: 1 } });
    vi.stubGlobal("fetch", fetchMock);

    await listOpenOrganizationChanges(2);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/organization/designer/drafts?status=OPEN&page=2&pageSize=25",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("sends the reason when discarding", async () => {
    const fetchMock = reply(200, { id: "change-1", status: "DISCARDED" });
    vi.stubGlobal("fetch", fetchMock);

    await discardOrganizationDraft("change-1", "Sudah digantikan struktur terbit");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/organization/designer/drafts/change-1/discard",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ reason: "Sudah digantikan struktur terbit" }) }),
    );
  });
});

describe("ORG-008-12 overtime rule seat warning text", () => {
  const base = {
    ruleId: "r1", positionKey: "k", targetLabel: "Direktur · Yayasan", reasonLabel: "Direktur — tidak menerima upah lembur",
    positionTitle: "Direktur", beforeUnitName: "Yayasan", afterUnitName: null,
  };
  it("reads as a sentence for each change, without codes", () => {
    expect(overtimeRuleSeatWarningText({ ...base, change: "REMOVED" })).toBe(
      'Jabatan Direktur dihapus di perubahan ini, padahal dipakai aturan lembur "Direktur — tidak menerima upah lembur".',
    );
    expect(overtimeRuleSeatWarningText({ ...base, change: "DEACTIVATED" })).toContain("tidak berlaku lagi");
    const moved = overtimeRuleSeatWarningText({ ...base, change: "MOVED", afterUnitName: "Bidang Pendidikan" });
    expect(moved).toContain("dipindah dari Yayasan ke Bidang Pendidikan");
    expect(moved).not.toMatch(/MOVED|REMOVED|DEACTIVATED/);
  });
});
