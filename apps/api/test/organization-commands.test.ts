import { describe, expect, it } from "vitest";

import {
  applyOrganizationCommand,
  OrganizationCommandError,
  type OrganizationCommand,
} from "../src/modules/organization/commands.js";
import type { OrganizationSnapshot } from "../src/modules/organization/domain.js";

/**
 * ORG-008-4a: one operator action applied as one atomic command, without collapsing the ORG-004
 * model — a node, a position, an incumbency and each binding stay separate audited records (I-6).
 */

const EFFECTIVE_ON = "2027-01-01";
const SCHOOL = "node-school";
const HEAD = "position-head";
const VICE = "position-vice";

function snapshot(overrides: Partial<OrganizationSnapshot> = {}): OrganizationSnapshot {
  return {
    changeSet: {
      id: "change-set", name: "Restruktur Sintetis", effectiveOn: EFFECTIVE_ON, status: "DRAFT",
      baseChangeSetId: null, validationReport: { valid: false, issues: [], checkedAt: "" },
      createdByAccountId: "actor", createdAt: "2026-10-01T00:00:00Z",
      validatedAt: null, publishedAt: null, revision: 0,
    },
    nodes: [{
      id: "node-id", stableKey: SCHOOL, name: "SDIT", nodeType: "UNIT", parentNodeKey: null,
      active: true, effectiveFrom: "2026-01-01", effectiveTo: null, visualRankOffset: 0,
      integrationCode: null,
    }],
    jobProfiles: [],
    positions: [
      {
        id: "head-id", stableKey: HEAD, nodeKey: SCHOOL, title: "Kepala SDIT", parentPositionKey: null,
        singleIncumbent: true, vacancyPolicy: "CLIMB_TO_PARENT", active: true,
        effectiveFrom: "2026-01-01", effectiveTo: null, visualRankOffset: 0,
        jobProfileKey: null, holderSource: "EMPLOYEE",
      },
      {
        id: "vice-id", stableKey: VICE, nodeKey: SCHOOL, title: "Wakil Kepala", parentPositionKey: null,
        singleIncumbent: true, vacancyPolicy: "CLIMB_TO_PARENT", active: true,
        effectiveFrom: "2026-01-01", effectiveTo: null, visualRankOffset: 0,
        jobProfileKey: null, holderSource: "EMPLOYEE",
      },
    ],
    memberships: [],
    incumbencies: [],
    authorityBindings: [],
    reportingOverrides: [],
    ...overrides,
  } as OrganizationSnapshot;
}

function apply(command: OrganizationCommand, base: OrganizationSnapshot = snapshot()) {
  return applyOrganizationCommand(base, command);
}

function expectRefusal(command: OrganizationCommand, base: OrganizationSnapshot = snapshot()) {
  try {
    apply(command, base);
  } catch (error) {
    if (error instanceof OrganizationCommandError) return error;
    throw error;
  }
  throw new Error("Expected the command to be refused.");
}

describe("ORG-008-4a Tambah unit in one action (gap S-2)", () => {
  it("creates the unit, its leadership seat, the incumbent, and both bindings at once", () => {
    const result = apply({
      type: "ADD_UNIT",
      name: "Bidang Pendidikan",
      nodeType: "DIRECTORATE",
      parentNodeKey: SCHOOL,
      leader: { title: "Kepala Bidang Pendidikan", employeeId: "employee-head" },
    });

    expect(result.snapshot.nodes).toHaveLength(2);
    expect(result.snapshot.positions).toHaveLength(3);
    expect(result.snapshot.incumbencies).toHaveLength(1);
    // Leader and unit approver, because forgetting the second is what silently breaks leave routing.
    expect(result.snapshot.authorityBindings.map((item) => item.bindingType).sort())
      .toEqual(["LEADER", "UNIT_APPROVER"]);
    // Each primitive is audited on its own (invariant I-6, I-10).
    expect(result.events.map((event) => event.action)).toEqual([
      "organization.node.created",
      "organization.position.created",
      "organization.incumbency.created",
      "organization.authority_binding.created",
      "organization.authority_binding.created",
    ]);
  });

  it("uses climb-to-parent for the new leadership seat (decision O-6)", () => {
    const result = apply({
      type: "ADD_UNIT", name: "Divisi Sosial", nodeType: "DIVISION", parentNodeKey: null,
      leader: { title: "Kepala Divisi Sosial" },
    });
    const created = result.snapshot.positions.find((item) => item.title === "Kepala Divisi Sosial");
    expect(created?.vacancyPolicy).toBe("CLIMB_TO_PARENT");
    expect(result.snapshot.incumbencies).toHaveLength(0);
  });

  it("can leave the unit approver out when the operator unticks it", () => {
    const result = apply({
      type: "ADD_UNIT", name: "Tim Humas", nodeType: "TEAM", parentNodeKey: SCHOOL,
      leader: { title: "Ketua Tim Humas", alsoUnitApprover: false },
    });
    expect(result.snapshot.authorityBindings.map((item) => item.bindingType)).toEqual(["LEADER"]);
  });

  it("creates a plain unit when no leader is given", () => {
    const result = apply({ type: "ADD_UNIT", name: "Sekretariat", nodeType: "UNIT", parentNodeKey: null });
    expect(result.snapshot.positions).toHaveLength(2);
    expect(result.events.map((event) => event.action)).toEqual(["organization.node.created"]);
  });

  it("refuses a parent unit that does not exist", () => {
    const error = expectRefusal({
      type: "ADD_UNIT", name: "Anak", nodeType: "TEAM", parentNodeKey: "node-missing",
    });
    expect(error.code).toBe("ORGANIZATION_NODE_NOT_FOUND");
  });
});

describe("ORG-008-4a Tempatkan pegawai (gaps P-1, P-2)", () => {
  const withMember = () => snapshot({
    nodes: [
      ...snapshot().nodes,
      {
        id: "other-id", stableKey: "node-other", name: "Divisi Sosial", nodeType: "DIVISION",
        parentNodeKey: null, active: true, effectiveFrom: "2026-01-01", effectiveTo: null,
        visualRankOffset: 0, integrationCode: null,
      },
    ],
    memberships: [{
      id: "membership-1", nodeKey: "node-other", employeeId: "employee-ahmad",
      jobProfileKey: null, isPrimary: true, effectiveFrom: "2026-01-01", effectiveTo: null,
    }],
  } as Partial<OrganizationSnapshot>);

  it("adds members without replacing the unit's whole list", () => {
    const base = snapshot({
      memberships: [{
        id: "membership-existing", nodeKey: SCHOOL, employeeId: "employee-budi",
        jobProfileKey: null, isPrimary: true, effectiveFrom: "2026-01-01", effectiveTo: null,
      }],
    } as Partial<OrganizationSnapshot>);
    const result = apply({ type: "PLACE_EMPLOYEES", nodeKey: SCHOOL, employeeIds: ["employee-ahmad"] }, base);

    expect(result.snapshot.memberships.map((item) => item.employeeId).sort())
      .toEqual(["employee-ahmad", "employee-budi"]);
    expect(result.summary).toMatchObject({ placed: 1, moved: 0 });
  });

  it("names the clash instead of letting validation fail later with no name", () => {
    const error = expectRefusal(
      { type: "PLACE_EMPLOYEES", nodeKey: SCHOOL, employeeIds: ["employee-ahmad"] },
      withMember(),
    );
    expect(error.code).toBe("ORGANIZATION_MEMBERSHIP_CONFLICT");
    expect(error.details).toMatchObject({
      conflicts: [{ employeeId: "employee-ahmad", nodeName: "Divisi Sosial" }],
    });
  });

  it("moves the employee once the operator confirms, closing the old membership rather than deleting it", () => {
    const result = apply(
      { type: "PLACE_EMPLOYEES", nodeKey: SCHOOL, employeeIds: ["employee-ahmad"], move: true },
      withMember(),
    );
    const closed = result.snapshot.memberships.find((item) => item.nodeKey === "node-other");
    const created = result.snapshot.memberships.find((item) => item.nodeKey === SCHOOL);

    expect(closed?.effectiveTo).toBe("2026-12-31");
    expect(created?.effectiveFrom).toBe(EFFECTIVE_ON);
    expect(result.summary).toMatchObject({ placed: 1, moved: 1 });
  });

  it("does nothing when the employee is already a member of that unit", () => {
    const base = snapshot({
      memberships: [{
        id: "membership-1", nodeKey: SCHOOL, employeeId: "employee-ahmad",
        jobProfileKey: null, isPrimary: true, effectiveFrom: "2026-01-01", effectiveTo: null,
      }],
    } as Partial<OrganizationSnapshot>);
    const result = apply({ type: "PLACE_EMPLOYEES", nodeKey: SCHOOL, employeeIds: ["employee-ahmad"] }, base);

    expect(result.snapshot.memberships).toHaveLength(1);
    expect(result.events).toEqual([]);
  });
});

describe("ORG-008-4a Tunjuk Plt with the operator's own reason (gap M-6, decision O-5)", () => {
  it("stores the reason the operator wrote", () => {
    const result = apply({
      type: "APPOINT_ACTING", positionKey: HEAD, employeeId: "employee-yusuf",
      effectiveFrom: "2026-09-01", effectiveTo: "2026-12-31",
      reason: "Kepala divisi mengundurkan diri; menunggu pengangkatan",
    });
    const acting = result.snapshot.incumbencies[0];

    expect(acting?.kind).toBe("ACTING");
    expect(acting?.reason).toBe("Kepala divisi mengundurkan diri; menunggu pengangkatan");
    expect(acting?.reason).not.toBe("Explicit acting mandate");
    // The audit records that a reason exists, not the sentence itself.
    expect(result.events[0]?.payload).toMatchObject({ hasReason: true });
    expect(JSON.stringify(result.events)).not.toContain("mengundurkan diri");
  });

  it("appends the mandate number when one is given, and keeps it optional", () => {
    const result = apply({
      type: "APPOINT_ACTING", positionKey: HEAD, employeeId: "employee-yusuf",
      effectiveFrom: "2026-09-01", effectiveTo: "2026-12-31",
      reason: "Menunggu pengangkatan", mandateNumber: "001/SK/2026",
    });
    expect(result.snapshot.incumbencies[0]?.reason).toContain("001/SK/2026");
  });

  it("refuses an appointment without a reason or with a period that ends first", () => {
    expect(expectRefusal({
      type: "APPOINT_ACTING", positionKey: HEAD, employeeId: "employee-yusuf",
      effectiveFrom: "2026-09-01", effectiveTo: "2026-12-31", reason: "   ",
    }).code).toBe("ORGANIZATION_ACTING_REASON_REQUIRED");

    expect(expectRefusal({
      type: "APPOINT_ACTING", positionKey: HEAD, employeeId: "employee-yusuf",
      effectiveFrom: "2026-12-31", effectiveTo: "2026-09-01", reason: "Alasan",
    }).code).toBe("ORGANIZATION_ACTING_PERIOD_INVALID");
  });

  it("replaces an earlier acting appointment instead of leaving two", () => {
    const base = snapshot({
      incumbencies: [{
        id: "acting-old", positionKey: HEAD, employeeId: "employee-lama", accountId: null,
        kind: "ACTING", isPrimaryStructural: false, effectiveFrom: "2026-02-01",
        effectiveTo: "2026-08-31", reason: "Alasan lama",
      }],
    } as Partial<OrganizationSnapshot>);
    const result = apply({
      type: "APPOINT_ACTING", positionKey: HEAD, employeeId: "employee-yusuf",
      effectiveFrom: "2026-09-01", effectiveTo: "2026-12-31", reason: "Alasan baru",
    }, base);

    expect(result.snapshot.incumbencies).toHaveLength(1);
    expect(result.snapshot.incumbencies[0]?.employeeId).toBe("employee-yusuf");
  });
});

describe("ORG-008-4a one answer for Melapor ke (gap M-2)", () => {
  it("sets the parent and ends a supervisory binding that would have overruled it", () => {
    const base = snapshot({
      authorityBindings: [{
        id: "binding-supervisor", subjectKind: "POSITION", subjectKey: VICE,
        bindingType: "SUPERVISORY_PARENT", targetPositionKey: HEAD,
        vacancyPolicy: "CLIMB_TO_PARENT", effectiveFrom: "2026-01-01", effectiveTo: null,
      }],
    } as Partial<OrganizationSnapshot>);
    const result = apply({ type: "SET_REPORTS_TO", positionKey: VICE, parentPositionKey: HEAD }, base);

    expect(result.snapshot.positions.find((item) => item.stableKey === VICE)?.parentPositionKey).toBe(HEAD);
    expect(result.snapshot.authorityBindings[0]?.effectiveTo).toBe("2026-12-31");
    expect(result.events.map((event) => event.action)).toContain("organization.authority_binding.ended");
  });

  it("refuses a position that would report to itself", () => {
    expect(expectRefusal({ type: "SET_REPORTS_TO", positionKey: VICE, parentPositionKey: VICE }).code)
      .toBe("ORGANIZATION_POSITION_SELF_PARENT");
  });
});

describe("ORG-008-4a replacing a unit leader or approver (gap W-1)", () => {
  it("ends the previous binding instead of creating a second one that can never validate", () => {
    const base = snapshot({
      authorityBindings: [{
        id: "binding-leader", subjectKind: "NODE", subjectKey: SCHOOL, bindingType: "LEADER",
        targetPositionKey: HEAD, vacancyPolicy: "CLIMB_TO_PARENT",
        effectiveFrom: "2026-01-01", effectiveTo: null,
      }],
    } as Partial<OrganizationSnapshot>);
    const result = apply({ type: "SET_UNIT_LEADER", nodeKey: SCHOOL, positionKey: VICE }, base);

    const effective = result.snapshot.authorityBindings.filter(
      (item) => item.bindingType === "LEADER" && item.effectiveTo === null,
    );
    expect(effective).toHaveLength(1);
    expect(effective[0]?.targetPositionKey).toBe(VICE);
    expect(result.snapshot.authorityBindings.find((item) => item.id === "binding-leader")?.effectiveTo)
      .toBe("2026-12-31");
  });

  it("drops a binding created inside this change set rather than closing a period that never began", () => {
    const base = snapshot({
      authorityBindings: [{
        id: "binding-new", subjectKind: "NODE", subjectKey: SCHOOL, bindingType: "UNIT_APPROVER",
        targetPositionKey: HEAD, vacancyPolicy: "CLIMB_TO_PARENT",
        effectiveFrom: EFFECTIVE_ON, effectiveTo: null,
      }],
    } as Partial<OrganizationSnapshot>);
    const result = apply({ type: "SET_UNIT_APPROVER", nodeKey: SCHOOL, positionKey: VICE }, base);

    expect(result.snapshot.authorityBindings).toHaveLength(1);
    expect(result.snapshot.authorityBindings[0]?.targetPositionKey).toBe(VICE);
  });
});

describe("ORG-008-4a Atur atasan khusus (gap M-4)", () => {
  it("records the exception with the reason, which ORG-004 requires", () => {
    const result = apply({
      type: "SET_OVERRIDE", employeeId: "employee-ahmad", managerPositionKey: HEAD,
      reason: "Guru ini melapor langsung ke kepala sekolah",
    });
    expect(result.snapshot.reportingOverrides).toHaveLength(1);
    expect(result.snapshot.reportingOverrides[0]).toMatchObject({
      managerPositionKey: HEAD, effectiveFrom: EFFECTIVE_ON,
    });
    expect(JSON.stringify(result.events)).not.toContain("kepala sekolah");
  });

  it("refuses an exception with no reason", () => {
    expect(expectRefusal({
      type: "SET_OVERRIDE", employeeId: "employee-ahmad", managerPositionKey: HEAD, reason: " ",
    }).code).toBe("ORGANIZATION_OVERRIDE_REASON_REQUIRED");
  });
});

describe("ORG-008-4a a refused command changes nothing", () => {
  it("leaves the snapshot untouched when the command is refused part-way", () => {
    const base = snapshot();
    const before = JSON.stringify(base);
    expectRefusal({
      type: "APPOINT_ACTING", positionKey: "position-missing", employeeId: "employee-yusuf",
      effectiveFrom: "2026-09-01", effectiveTo: "2026-12-31", reason: "Alasan",
    }, base);
    expect(JSON.stringify(base)).toBe(before);
  });
});
