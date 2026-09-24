import { createHash } from "node:crypto";

import type { Pool, QueryResultRow } from "pg";

import type { OrganizationSnapshot } from "../organization/domain.js";
import { jakartaBusinessDate } from "../organization/jakarta-date.js";
import { PostgresOrganizationRepository } from "../organization/repository.js";
import {
  ORGANIZATION_DIRECTORY_SCHEMA_VERSION,
  organizationDirectorySnapshotSchema,
  type OrganizationDirectoryPerson,
  type OrganizationDirectoryPosition,
  type OrganizationDirectorySnapshot,
  type OrganizationDirectoryUnit,
} from "./contract.js";

interface EmployeeDirectoryRow extends QueryResultRow {
  id: string;
  employeeNumber: string;
  fullName: string;
  status: "active" | "inactive" | "resigned";
  employmentStatus: string | null;
  startedOn: string | Date | null;
  endedOn: string | Date | null;
  removedAt: Date | null;
}

interface EmployeeIdentityRow extends QueryResultRow {
  employeeId: string;
  issuer: string;
  subject: string;
}

export class OrganizationDirectoryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrganizationDirectoryUnavailableError";
  }
}

export class OrganizationDirectoryContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrganizationDirectoryContractError";
  }
}

function unitExternalId(stableKey: string): string {
  return `hcis:org-node:${stableKey}`;
}

function positionExternalId(stableKey: string): string {
  return `hcis:org-position:${stableKey}`;
}

function personExternalId(employeeId: string): string {
  return `hcis:employee:${employeeId}`;
}

function dateText(value: string | Date | null): string | null {
  if (value === null) return null;
  return typeof value === "string" ? value.slice(0, 10) : jakartaBusinessDate(value);
}

function containsDate(
  period: { effectiveFrom: string; effectiveTo: string | null },
  asOf: string,
): boolean {
  return period.effectiveFrom <= asOf
    && (period.effectiveTo === null || period.effectiveTo >= asOf);
}

function canonicalVersion(input: Omit<OrganizationDirectorySnapshot, "version" | "generatedAt" | "counts"> & {
  counts: OrganizationDirectorySnapshot["counts"];
}): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex")}`;
}

function assertReferences(
  units: OrganizationDirectoryUnit[],
  positions: OrganizationDirectoryPosition[],
): void {
  const unitIds = new Set(units.map((item) => item.id));
  for (const unit of units) {
    if (unit.parentUnitId !== null && !unitIds.has(unit.parentUnitId)) {
      throw new OrganizationDirectoryContractError(
        `Unit ${unit.id} references a parent that is not visible for the requested business date.`,
      );
    }
  }

  const positionIds = new Set(positions.map((item) => item.id));
  for (const position of positions) {
    if (!unitIds.has(position.unitId)) {
      throw new OrganizationDirectoryContractError(
        `Position ${position.id} references a unit that is not visible for the requested business date.`,
      );
    }
    if (position.parentPositionId !== null && !positionIds.has(position.parentPositionId)) {
      throw new OrganizationDirectoryContractError(
        `Position ${position.id} references a parent position that is not visible for the requested business date.`,
      );
    }
  }
}

export function buildOrganizationDirectorySnapshot(input: {
  snapshot: OrganizationSnapshot;
  employees: EmployeeDirectoryRow[];
  identities: EmployeeIdentityRow[];
  asOf: string;
  generatedAt?: string;
}): OrganizationDirectorySnapshot {
  const { snapshot, asOf } = input;
  if (snapshot.changeSet.status !== "PUBLISHED" || snapshot.changeSet.effectiveOn > asOf) {
    throw new OrganizationDirectoryContractError("Only an effective PUBLISHED snapshot can be exported.");
  }
  if (!snapshot.changeSet.publishedAt) {
    throw new OrganizationDirectoryContractError("Published source snapshot has no publishedAt timestamp.");
  }

  const units: OrganizationDirectoryUnit[] = snapshot.nodes
    .filter((item) => item.effectiveFrom <= asOf)
    .map((item) => ({
      id: unitExternalId(item.stableKey),
      name: item.name,
      nodeType: item.nodeType,
      parentUnitId: item.parentNodeKey ? unitExternalId(item.parentNodeKey) : null,
      active: item.active,
      effectiveFrom: item.effectiveFrom,
      effectiveTo: item.effectiveTo,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  const visibleUnitIds = new Set(units.map((item) => item.id));
  const positions: OrganizationDirectoryPosition[] = snapshot.positions
    .filter((item) => item.effectiveFrom <= asOf)
    .map((item) => ({
      id: positionExternalId(item.stableKey),
      unitId: unitExternalId(item.nodeKey),
      title: item.title,
      parentPositionId: item.parentPositionKey
        ? positionExternalId(item.parentPositionKey)
        : null,
      active: item.active,
      effectiveFrom: item.effectiveFrom,
      effectiveTo: item.effectiveTo,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  assertReferences(units, positions);
  const visiblePositionIds = new Set(positions.map((item) => item.id));

  const identityByEmployee = new Map<string, Array<{ issuer: string; subject: string }>>();
  for (const identity of input.identities) {
    const existing = identityByEmployee.get(identity.employeeId) ?? [];
    existing.push({ issuer: identity.issuer, subject: identity.subject });
    identityByEmployee.set(identity.employeeId, existing);
  }

  const people: OrganizationDirectoryPerson[] = input.employees.map((employee) => {
    const currentMemberships = snapshot.memberships.filter(
      (item) => item.employeeId === employee.id && item.isPrimary && containsDate(item, asOf),
    );
    if (currentMemberships.length > 1) {
      throw new OrganizationDirectoryContractError(
        `Employee ${employee.id} has multiple effective primary memberships.`,
      );
    }
    const primaryMembership = currentMemberships[0] ?? null;
    const currentPrimaryUnitId = primaryMembership
      ? unitExternalId(primaryMembership.nodeKey)
      : null;
    if (currentPrimaryUnitId && !visibleUnitIds.has(currentPrimaryUnitId)) {
      throw new OrganizationDirectoryContractError(
        `Employee ${employee.id} references a primary unit that is not visible.`,
      );
    }

    const structural = snapshot.incumbencies.filter(
      (item) =>
        item.employeeId === employee.id
        && item.kind === "PRIMARY"
        && containsDate(item, asOf),
    );
    const structuralPositionIds = [...new Set(
      structural.map((item) => positionExternalId(item.positionKey)),
    )].sort();
    for (const id of structuralPositionIds) {
      if (!visiblePositionIds.has(id)) {
        throw new OrganizationDirectoryContractError(
          `Employee ${employee.id} references a structural position that is not visible.`,
        );
      }
    }

    const explicitPrimary = structural.filter((item) => item.isPrimaryStructural);
    if (explicitPrimary.length > 1) {
      throw new OrganizationDirectoryContractError(
        `Employee ${employee.id} has multiple effective primary structural positions.`,
      );
    }
    const primaryStructuralPositionId = explicitPrimary[0]
      ? positionExternalId(explicitPrimary[0].positionKey)
      : null;

    const identityRefs = (identityByEmployee.get(employee.id) ?? [])
      .sort((left, right) =>
        left.issuer.localeCompare(right.issuer) || left.subject.localeCompare(right.subject));

    return {
      id: personExternalId(employee.id),
      employeeNumber: employee.employeeNumber,
      displayName: employee.fullName,
      active: employee.status === "active" && employee.removedAt === null,
      employmentStatus: employee.employmentStatus,
      startedOn: dateText(employee.startedOn),
      endedOn: dateText(employee.endedOn),
      currentPrimaryUnitId,
      structuralPositionIds,
      primaryStructuralPositionId,
      identityRefs,
    };
  }).sort((left, right) => left.id.localeCompare(right.id));

  const source = {
    system: "hcis" as const,
    snapshotId: snapshot.changeSet.id,
    effectiveOn: snapshot.changeSet.effectiveOn,
    publishedAt: snapshot.changeSet.publishedAt,
    createdAt: snapshot.changeSet.createdAt,
  };
  const counts = {
    units: units.length,
    positions: positions.length,
    people: people.length,
  };
  const versionInput = {
    schemaVersion: ORGANIZATION_DIRECTORY_SCHEMA_VERSION,
    source,
    asOf,
    counts,
    units,
    positions,
    people,
  };
  const response: OrganizationDirectorySnapshot = {
    ...versionInput,
    version: canonicalVersion(versionInput),
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };

  const parsed = organizationDirectorySnapshotSchema.safeParse(response);
  if (!parsed.success) {
    throw new OrganizationDirectoryContractError("Generated directory payload failed schema validation.");
  }
  return parsed.data;
}

export async function loadOrganizationDirectorySnapshot(
  pool: Pool,
  asOf: string,
): Promise<OrganizationDirectorySnapshot> {
  const repository = new PostgresOrganizationRepository(pool);
  const snapshot = await repository.loadEffectiveSnapshot(asOf);
  if (!snapshot) {
    throw new OrganizationDirectoryUnavailableError(
      "No effective published organization snapshot is available.",
    );
  }

  const [employees, identities] = await Promise.all([
    pool.query<EmployeeDirectoryRow>(
      `SELECT id,
         employee_number AS "employeeNumber",
         full_name AS "fullName",
         status,
         employment_status AS "employmentStatus",
         started_on AS "startedOn",
         ended_on AS "endedOn",
         removed_at AS "removedAt"
       FROM employees
       ORDER BY id`,
    ),
    pool.query<EmployeeIdentityRow>(
      `SELECT employee_id AS "employeeId",
         identity_issuer AS issuer,
         identity_subject AS subject
       FROM accounts
       WHERE employee_id IS NOT NULL
         AND principal_type = 'EMPLOYEE'
         AND identity_issuer IS NOT NULL
         AND identity_subject IS NOT NULL
       ORDER BY employee_id, identity_issuer, identity_subject`,
    ),
  ]);

  return buildOrganizationDirectorySnapshot({
    snapshot,
    employees: employees.rows,
    identities: identities.rows,
    asOf,
  });
}
