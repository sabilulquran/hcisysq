import { describe, expect, it, vi } from "vitest";

import type { OrganizationChangeSet, OrganizationSnapshot } from "../src/modules/organization/domain.js";
import { OrganizationDraftService } from "../src/modules/organization/draft-service.js";
import type { PostgresOrganizationRepository } from "../src/modules/organization/repository.js";
import { replayJournal, snapshotFromBase, type OrganizationJournalEntry } from "../src/modules/organization/replay.js";

/**
 * ORG-008-4c: rebuilding a change set by replaying what the operator asked for, either onto newer
 * structure or without one of its lines. A line that no longer fits is reported, never resolved.
 */

const EFFECTIVE_ON = "2027-01-01";
const BASE_UNIT = "node-base-unit";
const NEW_UNIT = "node-new-unit";
const NEW_POSITION = "position-new-head";

const CHANGE_SET: OrganizationSnapshot["changeSet"] = {
  id: "change-set", name: "Restruktur Sintetis", effectiveOn: EFFECTIVE_ON, status: "DRAFT",
  baseChangeSetId: "base", validationReport: { valid: false, issues: [], checkedAt: "" },
  createdByAccountId: "actor", createdAt: "2026-10-01T00:00:00Z",
  validatedAt: null, publishedAt: null, revision: 4,
};

function baseSnapshot(overrides: Partial<OrganizationSnapshot> = {}): OrganizationSnapshot {
  return {
    changeSet: { ...CHANGE_SET, id: "base", status: "PUBLISHED", publishedAt: "2026-09-20T00:00:00Z" },
    nodes: [{
      id: "base-node-id", stableKey: BASE_UNIT, name: "Yayasan", nodeType: "FOUNDATION",
      parentNodeKey: null, active: true, effectiveFrom: "2026-01-01", effectiveTo: null,
      visualRankOffset: 0, integrationCode: null,
    }],
    jobProfiles: [],
    positions: [],
    memberships: [],
    incumbencies: [],
    authorityBindings: [],
    reportingOverrides: [],
    ...overrides,
  } as OrganizationSnapshot;
}

/** What the operator did, in order: add a unit, then place someone into that same new unit. */
function journal(): OrganizationJournalEntry[] {
  return [
    {
      id: "journal-1", seq: 1, commandType: "ADD_UNIT",
      payload: { type: "ADD_UNIT", name: "Bidang Pendidikan", nodeType: "DIRECTORATE", parentNodeKey: BASE_UNIT },
      summary: { nodeKey: NEW_UNIT, name: "Bidang Pendidikan" },
    },
    {
      id: "journal-2", seq: 2, commandType: "PLACE_EMPLOYEES",
      payload: { type: "PLACE_EMPLOYEES", nodeKey: NEW_UNIT, employeeIds: ["employee-ahmad"] },
      summary: { nodeKey: NEW_UNIT, placed: 1, moved: 0 },
    },
  ];
}

describe("ORG-008-4c replaying a journal onto a base", () => {
  it("reuses the keys the first application minted, so later lines still find them", () => {
    const result = replayJournal({ changeSet: CHANGE_SET, base: baseSnapshot(), entries: journal() });

    expect(result.skipped).toEqual([]);
    expect(result.applied.map((entry) => entry.seq)).toEqual([1, 2]);
    // Without reusing the key, the second command would point at a unit that no longer exists.
    expect(result.snapshot.nodes.some((item) => item.stableKey === NEW_UNIT)).toBe(true);
    expect(result.snapshot.memberships[0]).toMatchObject({ nodeKey: NEW_UNIT, employeeId: "employee-ahmad" });
  });

  it("carries the newer structure through, which is the point of rebuilding", () => {
    const corrected = baseSnapshot({
      nodes: [
        ...baseSnapshot().nodes,
        {
          id: "correction-id", stableKey: "node-correction", name: "Unit Koreksi", nodeType: "UNIT",
          parentNodeKey: BASE_UNIT, active: true, effectiveFrom: "2026-10-24", effectiveTo: null,
          visualRankOffset: 0, integrationCode: null,
        },
      ],
    } as Partial<OrganizationSnapshot>);
    const result = replayJournal({ changeSet: CHANGE_SET, base: corrected, entries: journal() });

    expect(result.snapshot.nodes.map((item) => item.stableKey)).toContain("node-correction");
    expect(result.snapshot.nodes.map((item) => item.stableKey)).toContain(NEW_UNIT);
  });

  it("reports a line that no longer fits instead of resolving it, and keeps the rest", () => {
    // The newer structure no longer has the parent the first line was attached to.
    const withoutParent = baseSnapshot({ nodes: [] } as Partial<OrganizationSnapshot>);
    const result = replayJournal({ changeSet: CHANGE_SET, base: withoutParent, entries: journal() });

    // Both lines are reported: the first lost its parent, and the second depended on the first.
    expect(result.skipped).toEqual([
      expect.objectContaining({ seq: 1, commandType: "ADD_UNIT", code: "ORGANIZATION_NODE_NOT_FOUND" }),
      expect.objectContaining({ seq: 2, commandType: "PLACE_EMPLOYEES", code: "ORGANIZATION_NODE_NOT_FOUND" }),
    ]);
    expect(result.snapshot.nodes).toEqual([]);
  });

  it("leaves one line out for an undo and renumbers what remains", () => {
    const result = replayJournal({
      changeSet: CHANGE_SET, base: baseSnapshot(), entries: journal(), skipSeq: 2,
    });

    expect(result.applied.map((entry) => entry.commandType)).toEqual(["ADD_UNIT"]);
    expect(result.applied[0]?.seq).toBe(1);
    expect(result.snapshot.memberships).toEqual([]);
    expect(result.snapshot.nodes.some((item) => item.stableKey === NEW_UNIT)).toBe(true);
  });

  it("reports the lines that depended on an undone one rather than dropping them silently", () => {
    const result = replayJournal({
      changeSet: CHANGE_SET, base: baseSnapshot(), entries: journal(), skipSeq: 1,
    });

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ seq: 2, code: "ORGANIZATION_NODE_NOT_FOUND" }),
    ]);
  });

  it("gives fresh row identifiers while keeping stable keys, so nothing is shared with the base", () => {
    const base = baseSnapshot();
    const built = snapshotFromBase(CHANGE_SET, base);

    expect(built.nodes[0]?.stableKey).toBe(BASE_UNIT);
    expect(built.nodes[0]?.id).not.toBe(base.nodes[0]?.id);
  });

  it("starts from nothing when no structure is published yet", () => {
    const built = snapshotFromBase(CHANGE_SET, null);
    expect(built.nodes).toEqual([]);
    expect(built.changeSet.id).toBe("change-set");
  });

  it("applies an acting appointment on replay with its reason intact", () => {
    const base = baseSnapshot({
      positions: [{
        id: "head-id", stableKey: NEW_POSITION, nodeKey: BASE_UNIT, title: "Kepala", parentPositionKey: null,
        singleIncumbent: true, vacancyPolicy: "CLIMB_TO_PARENT", active: true,
        effectiveFrom: "2026-01-01", effectiveTo: null, visualRankOffset: 0,
        jobProfileKey: null, holderSource: "EMPLOYEE",
      }],
    } as Partial<OrganizationSnapshot>);
    const entries: OrganizationJournalEntry[] = [{
      id: "journal-acting", seq: 1, commandType: "APPOINT_ACTING",
      payload: {
        type: "APPOINT_ACTING", positionKey: NEW_POSITION, employeeId: "employee-yusuf",
        effectiveFrom: "2026-09-01", effectiveTo: "2026-12-31", reason: "Menunggu pengangkatan",
      },
      summary: { positionKey: NEW_POSITION },
    }];
    const result = replayJournal({ changeSet: CHANGE_SET, base, entries });

    expect(result.snapshot.incumbencies[0]).toMatchObject({
      kind: "ACTING", reason: "Menunggu pengangkatan",
    });
  });
});

describe("ORG-008-4c staleness is measured from the base a change set carries", () => {
  function changeSet(overrides: Partial<OrganizationChangeSet> = {}): OrganizationChangeSet {
    return { ...CHANGE_SET, ...overrides } as OrganizationChangeSet;
  }

  const published = (id: string, effectiveOn: string, publishedAt: string): OrganizationChangeSet =>
    changeSet({ id, effectiveOn, status: "PUBLISHED", publishedAt, baseChangeSetId: null });

  function service(all: OrganizationChangeSet[]) {
    const repository = { listChangeSets: vi.fn(async () => all) } as unknown as PostgresOrganizationRepository;
    return new OrganizationDraftService(repository);
  }

  it("stops reporting a publication once the change set has been rebuilt onto it", async () => {
    const correction = published("correction", "2026-10-24", "2026-10-20T00:00:00Z");
    const draft = changeSet({ baseChangeSetId: "correction" });

    const conflict = await service([draft, correction]).findStaleBaseConflict(draft);
    expect(conflict).toBeNull();
  });

  it("still reports a publication that landed after that base", async () => {
    const correction = published("correction", "2026-10-24", "2026-10-20T00:00:00Z");
    const later = published("later", "2026-11-01", "2026-10-25T00:00:00Z");
    const draft = changeSet({ baseChangeSetId: "correction" });

    const conflict = await service([draft, correction, later]).findStaleBaseConflict(draft);
    expect(conflict?.changeSetId).toBe("later");
  });

  it("ignores a publication the base already supersedes", async () => {
    // Published before the base, so the base's snapshot already carries its content.
    const older = published("older", "2026-10-10", "2026-10-05T00:00:00Z");
    const correction = published("correction", "2026-10-24", "2026-10-20T00:00:00Z");
    const draft = changeSet({ baseChangeSetId: "correction" });

    const conflict = await service([draft, correction, older]).findStaleBaseConflict(draft);
    expect(conflict).toBeNull();
  });

  it("falls back to creation time when the change set has no base at all", async () => {
    const correction = published("correction", "2026-10-24", "2026-10-20T00:00:00Z");
    const draft = changeSet({ baseChangeSetId: null });

    const conflict = await service([draft, correction]).findStaleBaseConflict(draft);
    expect(conflict?.changeSetId).toBe("correction");
  });
});

describe("ORG-008 review: lines replay cannot reproduce", () => {
  const manualEdit: OrganizationJournalEntry = {
    id: "journal-3", seq: 3, commandType: "MANUAL_EDIT",
    payload: { replayable: false },
    summary: { action: "node.updated", nodeKey: BASE_UNIT, name: "Yayasan Baru", fields: ["name"] },
  };

  it("reports a manual edit as blocking instead of dropping it", () => {
    const result = replayJournal({ changeSet: CHANGE_SET, base: baseSnapshot(), entries: [...journal(), manualEdit] });

    expect(result.blocked).toEqual([{ seq: 3, commandType: "MANUAL_EDIT", summary: manualEdit.summary }]);
    expect(result.applied.map((entry) => entry.seq)).toEqual([1, 2]);
  });

  it("reports the legacy seed as blocking, because the old data cannot be read back into it", () => {
    const seed: OrganizationJournalEntry = {
      id: "journal-0", seq: 1, commandType: "SEED_FROM_LEGACY",
      payload: { source: "ORG-002" }, summary: { units: 12, placements: 140 },
    };
    const result = replayJournal({ changeSet: CHANGE_SET, base: null, entries: [seed] });

    expect(result.blocked).toMatchObject([{ seq: 1, commandType: "SEED_FROM_LEGACY" }]);
    expect(result.skipped).toEqual([]);
  });

  it("does not block when the line being undone is the manual edit itself", () => {
    const result = replayJournal({
      changeSet: CHANGE_SET, base: baseSnapshot(), entries: [...journal(), manualEdit], skipSeq: 3,
    });

    expect(result.blocked).toEqual([]);
    expect(result.applied).toHaveLength(2);
  });
});
