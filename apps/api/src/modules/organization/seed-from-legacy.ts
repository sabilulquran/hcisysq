// ORG-008-7 (decision O-3): a first draft built from the data HCIS already holds.
//
// Without this, standing the structure up means retyping every unit, every placement and every
// manager that is already recorded — hundreds of rows, by hand, with the typos that come with it
// (gap S-1).
//
// What it reads, and nothing else:
//   - organizational_units      -> one unit each
//   - employees.organizational_unit_id -> who belongs where
//   - organizational_units.leave_approver_employee_id (ORG-002) -> the unit's leave approver
//   - employees.direct_manager_employee_id (ORG-002)            -> who reports to whom
//
// What it never does (invariant I-7): infer anything from a job title. No existing title is read,
// and the titles it creates are plain labels derived from the unit's own name, marked as proposals.
// Every result is a draft for Human Capital to review; nothing is published and rollout is untouched.
//
// Pure: legacy rows in, snapshot out. The caller persists it.

import { randomUUID } from "node:crypto";

import type { OrganizationSnapshot } from "./domain.js";

export interface LegacyUnitRow {
  id: string;
  name: string;
  leaveApproverEmployeeId: string | null;
}

export interface LegacyEmployeeRow {
  id: string;
  organizationalUnitId: string | null;
  directManagerEmployeeId: string | null;
}

export interface SeedFromLegacySummary {
  units: number;
  placements: number;
  unitApprovers: number;
  unitLeaders: number;
  reportingExceptions: number;
  employeesWithoutUnit: number;
  employeesWithoutManager: number;
}

export interface SeedFromLegacyResult {
  snapshot: OrganizationSnapshot;
  summary: SeedFromLegacySummary;
}

/** The one place a title is invented, and only ever from the unit's own name. */
function proposedTitle(role: "leader" | "approver", unitName: string): string {
  return role === "leader" ? `Pemimpin ${unitName}` : `Penyetuju cuti ${unitName}`;
}

export function buildSeedFromLegacy(input: {
  changeSet: OrganizationSnapshot["changeSet"];
  units: LegacyUnitRow[];
  employees: LegacyEmployeeRow[];
}): SeedFromLegacyResult {
  const effectiveOn = input.changeSet.effectiveOn;
  const snapshot: OrganizationSnapshot = {
    changeSet: input.changeSet,
    nodes: [],
    jobProfiles: [],
    positions: [],
    memberships: [],
    incumbencies: [],
    authorityBindings: [],
    reportingOverrides: [],
  };
  const summary: SeedFromLegacySummary = {
    units: 0, placements: 0, unitApprovers: 0, unitLeaders: 0,
    reportingExceptions: 0, employeesWithoutUnit: 0, employeesWithoutManager: 0,
  };

  const nodeKeyByUnit = new Map<string, string>();
  for (const unit of input.units) {
    const stableKey = randomUUID();
    nodeKeyByUnit.set(unit.id, stableKey);
    snapshot.nodes.push({
      id: randomUUID(),
      stableKey,
      name: unit.name,
      // The imported list is flat and carries no parent, so the proposal is flat too. Arranging the
      // hierarchy is the reviewer's job; guessing it from names would be inference.
      nodeType: "UNIT",
      parentNodeKey: null,
      active: true,
      effectiveFrom: effectiveOn,
      effectiveTo: null,
      visualRankOffset: 0,
      integrationCode: null,
      // ORG-008-6 (O-9): the link is known here for free, and it is what overtime notification needs.
      legacyUnitId: unit.id,
    });
    summary.units += 1;
  }

  const membersByUnit = new Map<string, LegacyEmployeeRow[]>();
  for (const employee of input.employees) {
    if (!employee.organizationalUnitId || !nodeKeyByUnit.has(employee.organizationalUnitId)) {
      summary.employeesWithoutUnit += 1;
      continue;
    }
    const nodeKey = nodeKeyByUnit.get(employee.organizationalUnitId)!;
    snapshot.memberships.push({
      id: randomUUID(),
      nodeKey,
      employeeId: employee.id,
      jobProfileKey: null,
      isPrimary: true,
      effectiveFrom: effectiveOn,
      effectiveTo: null,
    });
    summary.placements += 1;
    const bucket = membersByUnit.get(employee.organizationalUnitId) ?? [];
    bucket.push(employee);
    membersByUnit.set(employee.organizationalUnitId, bucket);
  }

  for (const unit of input.units) {
    const nodeKey = nodeKeyByUnit.get(unit.id)!;
    const members = membersByUnit.get(unit.id) ?? [];

    // The unit's leave approver is recorded explicitly in ORG-002, so it carries over as a seat.
    if (unit.leaveApproverEmployeeId) {
      const positionKey = randomUUID();
      snapshot.positions.push({
        id: randomUUID(),
        stableKey: positionKey,
        nodeKey,
        title: proposedTitle("approver", unit.name),
        parentPositionKey: null,
        singleIncumbent: true,
        vacancyPolicy: "CLIMB_TO_PARENT",
        active: true,
        effectiveFrom: effectiveOn,
        effectiveTo: null,
        visualRankOffset: 0,
        holderSource: "EMPLOYEE",
      });
      snapshot.incumbencies.push({
        id: randomUUID(),
        positionKey,
        employeeId: unit.leaveApproverEmployeeId,
        accountId: null,
        kind: "PRIMARY",
        isPrimaryStructural: false,
        effectiveFrom: effectiveOn,
        effectiveTo: null,
        reason: null,
      });
      snapshot.authorityBindings.push({
        id: randomUUID(),
        subjectKind: "NODE",
        subjectKey: nodeKey,
        bindingType: "UNIT_APPROVER",
        targetPositionKey: positionKey,
        vacancyPolicy: "CLIMB_TO_PARENT",
        effectiveFrom: effectiveOn,
        effectiveTo: null,
      });
      summary.unitApprovers += 1;
    }

    // One manager for the whole unit becomes that unit's leader; anything else stays a per-employee
    // exception, which is what the old data actually says. Both come from recorded relationships,
    // never from a title.
    const managers = new Set(members.map((member) => member.directManagerEmployeeId));
    const everyoneHasOne = members.length > 0 && !managers.has(null);
    const sharedManager = everyoneHasOne && managers.size === 1 ? [...managers][0]! : null;

    if (sharedManager && !members.some((member) => member.id === sharedManager)) {
      const positionKey = randomUUID();
      snapshot.positions.push({
        id: randomUUID(),
        stableKey: positionKey,
        nodeKey,
        title: proposedTitle("leader", unit.name),
        parentPositionKey: null,
        singleIncumbent: true,
        vacancyPolicy: "CLIMB_TO_PARENT",
        active: true,
        effectiveFrom: effectiveOn,
        effectiveTo: null,
        visualRankOffset: 0,
        holderSource: "EMPLOYEE",
      });
      snapshot.incumbencies.push({
        id: randomUUID(),
        positionKey,
        employeeId: sharedManager,
        accountId: null,
        kind: "PRIMARY",
        isPrimaryStructural: false,
        effectiveFrom: effectiveOn,
        effectiveTo: null,
        reason: null,
      });
      snapshot.authorityBindings.push({
        id: randomUUID(),
        subjectKind: "NODE",
        subjectKey: nodeKey,
        bindingType: "LEADER",
        targetPositionKey: positionKey,
        vacancyPolicy: "CLIMB_TO_PARENT",
        effectiveFrom: effectiveOn,
        effectiveTo: null,
      });
      summary.unitLeaders += 1;
      continue;
    }

    for (const member of members) {
      if (!member.directManagerEmployeeId) {
        summary.employeesWithoutManager += 1;
        continue;
      }
      if (member.directManagerEmployeeId === member.id) {
        // The old data has them managing themselves; the resolver would refuse it, so it is left
        // out and counted as missing for the reviewer to fix.
        summary.employeesWithoutManager += 1;
        continue;
      }
      snapshot.reportingOverrides.push({
        id: randomUUID(),
        employeeId: member.id,
        // Pointing at the person, exactly as ORG-002 records it, rather than inventing a seat.
        managerPositionKey: null,
        managerEmployeeId: member.directManagerEmployeeId,
        reason: "Usulan dari data atasan lama (ORG-002) — tinjau sebelum diterbitkan",
        effectiveFrom: effectiveOn,
        effectiveTo: null,
      });
      summary.reportingExceptions += 1;
    }
  }

  // Employees with no unit at all are not placed anywhere; they are counted so the reviewer sees
  // them on the Kesiapan screen instead of discovering them when an approval fails.
  return { snapshot, summary };
}
