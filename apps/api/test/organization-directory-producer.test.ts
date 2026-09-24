import { describe, expect, it } from "vitest";

import type { OrganizationSnapshot } from "../src/modules/organization/domain.js";
import { buildOrganizationDirectorySnapshot } from "../src/modules/organization-directory/producer.js";

const ids = {
  changeSet: "00000000-0000-4000-8000-000000000101",
  actor: "00000000-0000-4000-8000-000000000102",
  rootRow: "00000000-0000-4000-8000-000000000103",
  root: "00000000-0000-4000-8000-000000000104",
  childRow: "00000000-0000-4000-8000-000000000105",
  child: "00000000-0000-4000-8000-000000000106",
  futureRow: "00000000-0000-4000-8000-000000000107",
  future: "00000000-0000-4000-8000-000000000108",
  positionRow: "00000000-0000-4000-8000-000000000109",
  position: "00000000-0000-4000-8000-000000000110",
  futurePositionRow: "00000000-0000-4000-8000-000000000111",
  futurePosition: "00000000-0000-4000-8000-000000000112",
  membership: "00000000-0000-4000-8000-000000000113",
  incumbency: "00000000-0000-4000-8000-000000000114",
  employeeOne: "00000000-0000-4000-8000-000000000115",
  employeeTwo: "00000000-0000-4000-8000-000000000116",
};

function sourceSnapshot(): OrganizationSnapshot {
  return {
    changeSet: {
      id: ids.changeSet,
      name: "Synthetic accepted structure",
      effectiveOn: "2026-09-01",
      status: "PUBLISHED",
      baseChangeSetId: null,
      validationReport: { valid: true, issues: [] },
      createdByAccountId: ids.actor,
      createdAt: "2026-08-25T01:00:00.000Z",
      validatedAt: "2026-08-26T01:00:00.000Z",
      publishedAt: "2026-09-01T01:00:00.000Z",
    },
    nodes: [
      {
        id: ids.rootRow, stableKey: ids.root, name: "Yayasan Demo", nodeType: "ROOT",
        parentNodeKey: null, active: true, effectiveFrom: "2026-01-01", effectiveTo: null,
        visualRankOffset: 0, integrationCode: "PRIVATE-CODE",
      },
      {
        id: ids.childRow, stableKey: ids.child, name: "Unit Demo", nodeType: "UNIT",
        parentNodeKey: ids.root, active: true, effectiveFrom: "2026-01-01", effectiveTo: null,
        visualRankOffset: 0, integrationCode: null,
      },
      {
        id: ids.futureRow, stableKey: ids.future, name: "Future Demo", nodeType: "UNIT",
        parentNodeKey: ids.root, active: true, effectiveFrom: "2026-10-01", effectiveTo: null,
        visualRankOffset: 0, integrationCode: null,
      },
    ],
    jobProfiles: [],
    positions: [
      {
        id: ids.positionRow, stableKey: ids.position, nodeKey: ids.child,
        title: "Koordinator Demo", parentPositionKey: null, singleIncumbent: true,
        vacancyPolicy: "CLIMB_TO_PARENT", active: true, effectiveFrom: "2026-01-01",
        effectiveTo: null, visualRankOffset: 0, holderSource: "EMPLOYEE",
      },
      {
        id: ids.futurePositionRow, stableKey: ids.futurePosition, nodeKey: ids.future,
        title: "Future Position", parentPositionKey: null, singleIncumbent: true,
        vacancyPolicy: "CLIMB_TO_PARENT", active: true, effectiveFrom: "2026-10-01",
        effectiveTo: null, visualRankOffset: 0, holderSource: "EMPLOYEE",
      },
    ],
    memberships: [{
      id: ids.membership,
      employeeId: ids.employeeOne,
      nodeKey: ids.child,
      jobProfileKey: null,
      isPrimary: true,
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-09-24",
    }],
    incumbencies: [{
      id: ids.incumbency,
      positionKey: ids.position,
      employeeId: ids.employeeOne,
      accountId: null,
      kind: "PRIMARY",
      isPrimaryStructural: true,
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-09-24",
      reason: "Private acting/reporting reason must never be exported",
    }],
    authorityBindings: [],
    reportingOverrides: [],
  };
}

function employees() {
  return [
    {
      id: ids.employeeOne,
      employeeNumber: "DEMO-001",
      fullName: "Pegawai Demo Satu",
      status: "active" as const,
      employmentStatus: "Tetap",
      startedOn: "2025-01-01",
      endedOn: null,
      removedAt: null,
    },
    {
      id: ids.employeeTwo,
      employeeNumber: "DEMO-002",
      fullName: "Pegawai Demo Dua",
      status: "active" as const,
      employmentStatus: "Kontrak",
      startedOn: "2025-06-01",
      endedOn: null,
      removedAt: new Date("2026-09-20T00:00:00.000Z"),
    },
  ];
}

describe("ORG-006 producer snapshot", () => {
  it("uses stable namespaced identifiers, inclusive effective dates, and excludes future entities", () => {
    const output = buildOrganizationDirectorySnapshot({
      snapshot: sourceSnapshot(),
      employees: employees(),
      identities: [{
        employeeId: ids.employeeOne,
        issuer: "https://identity.example.test/realms/demo",
        subject: "opaque-demo-subject",
      }],
      asOf: "2026-09-24",
      generatedAt: "2026-09-24T01:30:00.000Z",
    });

    expect(output.units.map((item) => item.id)).toEqual([
      `hcis:org-node:${ids.root}`,
      `hcis:org-node:${ids.child}`,
    ].sort());
    expect(output.positions).toHaveLength(1);
    expect(output.people[0]).toMatchObject({
      id: `hcis:employee:${ids.employeeOne}`,
      currentPrimaryUnitId: `hcis:org-node:${ids.child}`,
      structuralPositionIds: [`hcis:org-position:${ids.position}`],
      primaryStructuralPositionId: `hcis:org-position:${ids.position}`,
      active: true,
    });
    expect(output.people[0]?.identityRefs).toEqual([{
      issuer: "https://identity.example.test/realms/demo",
      subject: "opaque-demo-subject",
    }]);
  });

  it("projects removed employees as inactive without deleting their stable person identity", () => {
    const output = buildOrganizationDirectorySnapshot({
      snapshot: sourceSnapshot(),
      employees: employees(),
      identities: [],
      asOf: "2026-09-24",
      generatedAt: "2026-09-24T01:30:00.000Z",
    });

    expect(output.people.find((item) => item.id === `hcis:employee:${ids.employeeTwo}`))
      .toMatchObject({ active: false, employeeNumber: "DEMO-002" });
  });

  it("is content-idempotent across retries and changes version when projected person content changes", () => {
    const base = {
      snapshot: sourceSnapshot(),
      identities: [],
      asOf: "2026-09-24",
    };
    const first = buildOrganizationDirectorySnapshot({
      ...base,
      employees: employees(),
      generatedAt: "2026-09-24T01:30:00.000Z",
    });
    const retry = buildOrganizationDirectorySnapshot({
      ...base,
      employees: employees(),
      generatedAt: "2026-09-24T01:35:00.000Z",
    });
    const changedEmployees = employees();
    changedEmployees[0] = { ...changedEmployees[0]!, status: "inactive" };
    const changed = buildOrganizationDirectorySnapshot({
      ...base,
      employees: changedEmployees,
      generatedAt: "2026-09-24T01:40:00.000Z",
    });

    expect(retry.version).toBe(first.version);
    expect(retry.generatedAt).not.toBe(first.generatedAt);
    expect(changed.version).not.toBe(first.version);
    expect(changed.people[0]?.active).toBe(false);
  });

  it("does not leak snapshot-local row ids, integration codes, or private reasons", () => {
    const output = buildOrganizationDirectorySnapshot({
      snapshot: sourceSnapshot(),
      employees: employees(),
      identities: [],
      asOf: "2026-09-24",
      generatedAt: "2026-09-24T01:30:00.000Z",
    });
    const serialized = JSON.stringify(output);

    expect(serialized).not.toContain(ids.rootRow);
    expect(serialized).not.toContain("PRIVATE-CODE");
    expect(serialized).not.toContain("Private acting/reporting reason");
  });
});
