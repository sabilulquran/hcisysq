import { describe, expect, it, vi } from "vitest";

import type {
  OrganizationChangeSet,
  OrganizationSnapshot,
} from "../src/modules/organization/domain.js";
import { OrganizationDraftError } from "../src/modules/organization/domain.js";
import { OrganizationDraftService } from "../src/modules/organization/draft-service.js";
import type { PostgresOrganizationRepository } from "../src/modules/organization/repository.js";

/**
 * ORG-008-3a: publishing a change set must not silently drop another publication.
 *
 * Every published change set is a complete snapshot and `loadEffectiveSnapshot` picks one by
 * `effective_on DESC, published_at DESC`. A draft clones its base once and is never refreshed, so a
 * publication that lands after the clone and takes effect no later than the draft would be replaced
 * by the older content the draft carries (gap D-2).
 */

const BASE_ID = "base-change-set";
const DRAFT_ID = "draft-change-set";

function changeSet(overrides: Partial<OrganizationChangeSet> = {}): OrganizationChangeSet {
  return {
    id: DRAFT_ID,
    name: "Restruktur Sintetis 2027",
    effectiveOn: "2027-01-01",
    status: "VALIDATED",
    baseChangeSetId: BASE_ID,
    validationReport: { valid: true, issues: [], checkedAt: "2026-10-15T00:00:00Z" },
    createdByAccountId: "synthetic-actor",
    createdAt: "2026-10-15T00:00:00Z",
    validatedAt: "2026-10-15T01:00:00Z",
    publishedAt: null,
    ...overrides,
  };
}

/** The base itself: published before the draft was created, so the draft already contains it. */
const publishedBase = changeSet({
  id: BASE_ID,
  name: "Struktur Oktober",
  effectiveOn: "2026-10-01",
  status: "PUBLISHED",
  baseChangeSetId: null,
  createdAt: "2026-09-01T00:00:00Z",
  publishedAt: "2026-09-20T00:00:00Z",
});

/** A correction published after the draft was cloned, effective before the draft's own date. */
const laterCorrection = changeSet({
  id: "correction-change-set",
  name: "Koreksi Oktober",
  effectiveOn: "2026-10-24",
  status: "PUBLISHED",
  baseChangeSetId: BASE_ID,
  createdAt: "2026-10-19T00:00:00Z",
  publishedAt: "2026-10-20T00:00:00Z",
});

function snapshot(set: OrganizationChangeSet): OrganizationSnapshot {
  return {
    changeSet: set,
    nodes: [], jobProfiles: [], positions: [], memberships: [],
    incumbencies: [], authorityBindings: [], reportingOverrides: [],
  };
}

function serviceWith(draft: OrganizationChangeSet, others: OrganizationChangeSet[]) {
  const publishValidated = vi.fn(async () => undefined);
  const repository = {
    loadChangeSetSnapshot: vi.fn(async (id: string) => {
      const found = [draft, ...others].find((item) => item.id === id);
      return found ? snapshot(found) : null;
    }),
    listChangeSets: vi.fn(async () => [draft, ...others]),
    publishValidated,
  } as unknown as PostgresOrganizationRepository;
  return { service: new OrganizationDraftService(repository), publishValidated };
}

async function publishError(draft: OrganizationChangeSet, others: OrganizationChangeSet[]) {
  const { service, publishValidated } = serviceWith(draft, others);
  const error = await service.publish(draft.id, "synthetic-actor").then(() => null, (cause: unknown) => cause);
  return { error, publishValidated };
}

describe("ORG-008-3a stale-base publish guard", () => {
  it("refuses a draft whose base another publication has already replaced, and writes nothing", async () => {
    const { error, publishValidated } = await publishError(changeSet(), [publishedBase, laterCorrection]);

    expect(error).toBeInstanceOf(OrganizationDraftError);
    expect((error as OrganizationDraftError).code).toBe("CHANGE_SET_BASE_STALE");
    expect((error as OrganizationDraftError).details).toMatchObject({
      changeSetId: "correction-change-set",
      name: "Koreksi Oktober",
      effectiveOn: "2026-10-24",
    });
    expect(publishValidated).not.toHaveBeenCalled();
  });

  it("publishes normally while the base is still the newest publication", async () => {
    const { service, publishValidated } = serviceWith(changeSet(), [publishedBase]);

    await expect(service.publish(DRAFT_ID, "synthetic-actor")).resolves.toBeUndefined();
    expect(publishValidated).toHaveBeenCalledTimes(1);
    expect(publishValidated).toHaveBeenCalledWith(DRAFT_ID, "synthetic-actor");
  });

  it("allows a publication that takes effect after this one, which it therefore cannot shadow", async () => {
    const laterEffective = changeSet({
      id: "future-change-set", name: "Struktur 2028", effectiveOn: "2028-01-01",
      status: "PUBLISHED", createdAt: "2026-10-19T00:00:00Z", publishedAt: "2026-10-20T00:00:00Z",
    });
    const { service, publishValidated } = serviceWith(changeSet(), [publishedBase, laterEffective]);

    await expect(service.publish(DRAFT_ID, "synthetic-actor")).resolves.toBeUndefined();
    expect(publishValidated).toHaveBeenCalledTimes(1);
  });

  it("refuses on an equal effective date, where published_at DESC still lets this draft win", async () => {
    const sameDate = changeSet({
      id: "same-date-change-set", name: "Koreksi Awal 2027", effectiveOn: "2027-01-01",
      status: "PUBLISHED", createdAt: "2026-10-19T00:00:00Z", publishedAt: "2026-10-20T00:00:00Z",
    });
    const { error, publishValidated } = await publishError(changeSet(), [publishedBase, sameDate]);

    expect((error as OrganizationDraftError).code).toBe("CHANGE_SET_BASE_STALE");
    expect(publishValidated).not.toHaveBeenCalled();
  });

  it("never treats the draft's own base as a conflict, whenever it was published", async () => {
    // Same base, but recorded as published after this draft was created.
    const republishedBase = { ...publishedBase, publishedAt: "2026-10-20T00:00:00Z" };
    const { service, publishValidated } = serviceWith(changeSet(), [republishedBase]);

    await expect(service.publish(DRAFT_ID, "synthetic-actor")).resolves.toBeUndefined();
    expect(publishValidated).toHaveBeenCalledTimes(1);
  });

  it("ignores change sets that are not published", async () => {
    const otherDraft = changeSet({
      id: "other-draft", name: "Perubahan Lain", effectiveOn: "2026-11-01",
      status: "DRAFT", createdAt: "2026-10-19T00:00:00Z", publishedAt: null, validatedAt: null,
    });
    const otherValidated = changeSet({
      id: "other-validated", name: "Perubahan Siap", effectiveOn: "2026-11-02",
      status: "VALIDATED", createdAt: "2026-10-19T00:00:00Z", publishedAt: null,
    });
    const { service, publishValidated } = serviceWith(changeSet(), [publishedBase, otherDraft, otherValidated]);

    await expect(service.publish(DRAFT_ID, "synthetic-actor")).resolves.toBeUndefined();
    expect(publishValidated).toHaveBeenCalledTimes(1);
  });

  it("names the most recently published conflict when several exist", async () => {
    const earlier = changeSet({
      id: "earlier-correction", name: "Koreksi Pertama", effectiveOn: "2026-10-10",
      status: "PUBLISHED", createdAt: "2026-10-16T00:00:00Z", publishedAt: "2026-10-17T00:00:00Z",
    });
    const { service } = serviceWith(changeSet(), [publishedBase, earlier, laterCorrection]);

    const conflict = await service.findStaleBaseConflict(changeSet());
    expect(conflict?.changeSetId).toBe("correction-change-set");

    await expect(service.publish(DRAFT_ID, "synthetic-actor")).rejects.toThrow(OrganizationDraftError);
  });

  it("marks a scheduled publication whose content a later correction already replaced", async () => {
    // The reverse case: the 2027 structure is already published, and the correction landed after it
    // was created. The guard cannot undo that, so the state has to be visible instead.
    const scheduled = changeSet({
      status: "PUBLISHED", publishedAt: "2026-10-16T00:00:00Z",
    });
    const { service } = serviceWith(scheduled, [publishedBase, laterCorrection]);

    const conflict = await service.findStaleBaseConflict(scheduled);
    expect(conflict?.name).toBe("Koreksi Oktober");
  });

  it("still refuses an unvalidated draft before considering its base", async () => {
    const notValidated = changeSet({ status: "DRAFT", validatedAt: null, validationReport: { valid: false, issues: [], checkedAt: "" } });
    const { error, publishValidated } = await publishError(notValidated, [publishedBase, laterCorrection]);

    expect((error as OrganizationDraftError).code).toBe("CHANGE_SET_NOT_VALIDATED");
    expect(publishValidated).not.toHaveBeenCalled();
  });
});
