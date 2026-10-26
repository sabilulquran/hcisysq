import { describe, expect, it } from "vitest";

import {
  bindingIsFromPublishedStructure,
  findNodeUses,
  findPositionUses,
} from "../src/modules/organization/corrections.js";
import type { OrganizationSnapshot } from "../src/modules/organization/domain.js";

/**
 * ORG-008-4b: what still points at a unit or a position, so removing or switching it off is refused
 * with the reason rather than failing later as an unnamed validation code.
 */

const EFFECTIVE_ON = "2027-01-01";
const SCHOOL = "node-school";
const TEAM = "node-team";
const HEAD = "position-head";
const VICE = "position-vice";

function node(stableKey: string, name: string, parentNodeKey: string | null, active = true) {
  return {
    id: `${stableKey}-id`, stableKey, name, nodeType: "UNIT", parentNodeKey, active,
    effectiveFrom: "2026-01-01", effectiveTo: null, visualRankOffset: 0, integrationCode: null,
  };
}

function position(stableKey: string, nodeKey: string, title: string, parentPositionKey: string | null, active = true) {
  return {
    id: `${stableKey}-id`, stableKey, nodeKey, title, parentPositionKey, singleIncumbent: true,
    vacancyPolicy: "CLIMB_TO_PARENT" as const, active, effectiveFrom: "2026-01-01", effectiveTo: null,
    visualRankOffset: 0, jobProfileKey: null, holderSource: "EMPLOYEE" as const,
  };
}

function snapshot(overrides: Partial<OrganizationSnapshot> = {}): OrganizationSnapshot {
  return {
    changeSet: {
      id: "change-set", name: "Restruktur Sintetis", effectiveOn: EFFECTIVE_ON, status: "DRAFT",
      baseChangeSetId: null, validationReport: { valid: false, issues: [], checkedAt: "" },
      createdByAccountId: "actor", createdAt: "2026-10-01T00:00:00Z",
      validatedAt: null, publishedAt: null, revision: 0,
    },
    nodes: [node(SCHOOL, "SDIT", null)],
    jobProfiles: [],
    positions: [],
    memberships: [],
    incumbencies: [],
    authorityBindings: [],
    reportingOverrides: [],
    ...overrides,
  } as OrganizationSnapshot;
}

describe("ORG-008-4b what still points at a unit", () => {
  it("is empty for a unit nothing refers to", () => {
    expect(findNodeUses(snapshot(), SCHOOL, EFFECTIVE_ON)).toEqual([]);
  });

  it("names members, positions, sub-units and authority bindings", () => {
    const base = snapshot({
      nodes: [node(SCHOOL, "SDIT", null), node(TEAM, "Kurikulum", SCHOOL)],
      positions: [position(HEAD, SCHOOL, "Kepala SDIT", null)],
      memberships: [{
        id: "membership-1", nodeKey: SCHOOL, employeeId: "employee-ahmad", jobProfileKey: null,
        isPrimary: true, effectiveFrom: "2026-01-01", effectiveTo: null,
      }],
      authorityBindings: [{
        id: "binding-1", subjectKind: "NODE", subjectKey: SCHOOL, bindingType: "LEADER",
        targetPositionKey: HEAD, vacancyPolicy: "CLIMB_TO_PARENT",
        effectiveFrom: "2026-01-01", effectiveTo: null,
      }],
    } as Partial<OrganizationSnapshot>);

    const uses = findNodeUses(base, SCHOOL, EFFECTIVE_ON);
    expect(uses.map((item) => item.kind).sort())
      .toEqual(["AUTHORITY_BINDING", "CHILD_UNIT", "MEMBERSHIP", "POSITION"]);
    expect(uses.find((item) => item.kind === "CHILD_UNIT")?.name).toBe("Kurikulum");
    expect(uses.find((item) => item.kind === "POSITION")?.name).toBe("Kepala SDIT");
  });

  it("ignores records that are no longer effective on that date", () => {
    const base = snapshot({
      memberships: [{
        id: "membership-old", nodeKey: SCHOOL, employeeId: "employee-ahmad", jobProfileKey: null,
        isPrimary: true, effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30",
      }],
      nodes: [node(SCHOOL, "SDIT", null), node(TEAM, "Tim Lama", SCHOOL, false)],
    } as Partial<OrganizationSnapshot>);

    expect(findNodeUses(base, SCHOOL, EFFECTIVE_ON)).toEqual([]);
  });
});

describe("ORG-008-4b what still points at a position", () => {
  it("names the incumbent, an acting holder, authority targets, child positions and exceptions", () => {
    const base = snapshot({
      positions: [position(HEAD, SCHOOL, "Kepala SDIT", null), position(VICE, SCHOOL, "Wakil Kepala", HEAD)],
      incumbencies: [
        {
          id: "incumbency-1", positionKey: HEAD, employeeId: "employee-hasan", accountId: null,
          kind: "PRIMARY", isPrimaryStructural: false, effectiveFrom: "2026-01-01",
          effectiveTo: null, reason: null,
        },
        {
          id: "incumbency-2", positionKey: HEAD, employeeId: "employee-yusuf", accountId: null,
          kind: "ACTING", isPrimaryStructural: false, effectiveFrom: "2026-01-01",
          effectiveTo: null, reason: "Alasan",
        },
      ],
      authorityBindings: [{
        id: "binding-1", subjectKind: "NODE", subjectKey: SCHOOL, bindingType: "UNIT_APPROVER",
        targetPositionKey: HEAD, vacancyPolicy: "CLIMB_TO_PARENT",
        effectiveFrom: "2026-01-01", effectiveTo: null,
      }],
      reportingOverrides: [{
        id: "override-1", employeeId: "employee-ahmad", managerPositionKey: HEAD,
        managerEmployeeId: null, reason: "Pengecualian", effectiveFrom: "2026-01-01", effectiveTo: null,
      }],
    } as Partial<OrganizationSnapshot>);

    const uses = findPositionUses(base, HEAD, EFFECTIVE_ON);
    expect(uses.map((item) => item.kind).sort()).toEqual([
      "ACTING_INCUMBENT", "AUTHORITY_BINDING", "CHILD_POSITION", "INCUMBENT", "REPORTING_OVERRIDE",
    ]);
  });

  it("is empty for a position nothing refers to", () => {
    const base = snapshot({ positions: [position(VICE, SCHOOL, "Wakil Kepala", null)] } as Partial<OrganizationSnapshot>);
    expect(findPositionUses(base, VICE, EFFECTIVE_ON)).toEqual([]);
  });
});

describe("ORG-008-4b published authority is ended, not deleted", () => {
  it("treats a binding effective before this change set as published structure", () => {
    expect(bindingIsFromPublishedStructure({ effectiveFrom: "2026-01-01" }, EFFECTIVE_ON)).toBe(true);
  });

  it("treats a binding created inside this change set as removable", () => {
    expect(bindingIsFromPublishedStructure({ effectiveFrom: EFFECTIVE_ON }, EFFECTIVE_ON)).toBe(false);
  });
});
