import { describe, expect, it, vi } from "vitest";

import type { OrganizationSnapshot } from "../src/modules/organization/domain.js";
import { OrganizationDraftService } from "../src/modules/organization/draft-service.js";
import type { PostgresOrganizationRepository } from "../src/modules/organization/repository.js";

/** ORG-005-1: a unit may not be published as working at a location switched off since. */

function snapshot(workLocationId: string | null, active = true): OrganizationSnapshot {
  return {
    changeSet: {
      id: "draft", name: "Synthetic", effectiveOn: "2027-01-01", status: "DRAFT", baseChangeSetId: null,
      validationReport: { valid: false, issues: [], checkedAt: "" }, createdByAccountId: "actor",
      createdAt: "2026-10-27T00:00:00Z", validatedAt: null, publishedAt: null, revision: 0,
    },
    nodes: [{
      id: "node", stableKey: "school", name: "SDIT", nodeType: "SCHOOL", parentNodeKey: null, active,
      effectiveFrom: "2027-01-01", effectiveTo: null, visualRankOffset: 0, integrationCode: null, workLocationId,
    }],
    jobProfiles: [], positions: [], memberships: [], incumbencies: [], authorityBindings: [], reportingOverrides: [],
  } as OrganizationSnapshot;
}

function service(draft: OrganizationSnapshot, inactive: string[]) {
  const repository = {
    loadChangeSetSnapshot: vi.fn(async () => draft),
    markValidated: vi.fn(async () => undefined),
    inactiveWorkLocationIds: vi.fn(async () => inactive),
  };
  return { repository, draftService: new OrganizationDraftService(repository as unknown as PostgresOrganizationRepository) };
}

describe("ORG-005-1 validation of unit work locations", () => {
  it("reports a unit naming a location that is no longer active", async () => {
    const { draftService } = service(snapshot("loc-old"), ["loc-old"]);
    const report = await draftService.validateDraft("draft", "actor");
    expect(report.valid).toBe(false);
    expect(report.issues).toMatchObject([{ code: "WORK_LOCATION_INACTIVE", entityId: "school" }]);
  });

  it("passes an active location", async () => {
    const { draftService } = service(snapshot("loc-sdit"), []);
    expect((await draftService.validateDraft("draft", "actor")).valid).toBe(true);
  });

  it("does not look anything up when no active unit names a location", async () => {
    for (const draft of [snapshot(null), snapshot("loc-old", false)]) {
      const { draftService, repository } = service(draft, ["loc-old"]);
      expect((await draftService.validateDraft("draft", "actor")).valid).toBe(true);
      expect(repository.inactiveWorkLocationIds).not.toHaveBeenCalled();
    }
  });
});
