// ORG-008-2 read model: who every active employee reports to, and what is not ready yet.
//
// Read-only. It runs the ORG-004 resolver that approvals run, over one snapshot loaded once, and
// writes nothing: no snapshot row, no rollout row, no approval snapshot. The resolver fails closed,
// so a failure here is reported as the employee's problem to fix, never replaced by a guess.

import type {
  AuthorityEligibilityContext,
  AuthorityEligibilityResult,
  AuthorityEligibilityValidator,
  OrganizationSnapshot,
  ResolvedAuthority,
} from "./domain.js";
import { OrganizationResolutionError } from "./domain.js";
import { isEffective } from "./jakarta-date.js";
import { OrganizationAuthorityResolver } from "./resolver.js";

/**
 * Why this employee's direct manager is who it is, in the vocabulary of ORG-008 §5.1.
 * Derived from the resolver's own path; the resolver itself is not changed.
 */
export type OrganizationAuthoritySource =
  | "OVERRIDE"
  | "ACTING"
  | "VACANCY_CLIMB"
  | "POSITION_PARENT"
  | "MEMBERSHIP_LEADER"
  | "INHERITED_LEADER";

export interface OrganizationPersonEmployee {
  id: string;
  employeeNumber: string;
  fullName: string;
  legacyUnitId: string | null;
  legacyUnitName: string | null;
  legacyDirectManagerEmployeeId: string | null;
  legacyDirectManagerName: string | null;
  legacyUnitApproverEmployeeId: string | null;
  legacyUnitApproverName: string | null;
}

export interface OrganizationAuthorityView {
  employeeId: string;
  employeeName: string;
  positionKey: string | null;
  positionTitle: string | null;
  /** PRIMARY, ACTING, or OVERRIDE, as the resolver recorded it. */
  incumbentKind: string;
}

export type OrganizationComparison = "SAME" | "DIFFERENT" | "UNRESOLVED" | "NO_LEGACY";

export interface OrganizationPersonRow {
  employeeId: string;
  employeeNumber: string;
  fullName: string;
  unit: { nodeKey: string; name: string; path: string[] } | null;
  /**
   * ORG-005-1 (DRAFT D-5-3): where this person works — their unit's location, or the nearest
   * ancestor unit's when theirs names none. Null when no unit up the branch names one.
   */
  workLocation: { id: string; name: string; inheritedFromNodeKey: string | null } | null;
  position: { stableKey: string; title: string } | null;
  directManager: OrganizationAuthorityView | null;
  source: OrganizationAuthoritySource | null;
  /** Extra facts behind the source, so a screen can say "climbed" and "acting" together. */
  sourceDetails: OrganizationAuthoritySource[];
  unitApprover: OrganizationAuthorityView | null;
  issues: Array<{ scope: "DIRECT_MANAGER" | "UNIT_APPROVER" | "MEMBERSHIP"; code: string }>;
  legacy: {
    directManagerEmployeeId: string | null;
    directManagerName: string | null;
    unitApproverEmployeeId: string | null;
    unitApproverName: string | null;
    unitName: string | null;
    comparison: OrganizationComparison;
  } | null;
}

/**
 * ORG-008-2 performance (gap D-8): the resolver asks whether a candidate may approve once per
 * candidate per resolution, which is one database round trip each. Resolving several hundred
 * employees repeats the same few managers over and over, so the answer is memoised per request.
 *
 * The decision itself is unchanged: the same validator, the same context, the same answer. The cache
 * lives for one request only, so an eligibility change is picked up by the next one.
 */
export class RequestScopedEligibilityValidator implements AuthorityEligibilityValidator {
  private readonly answers = new Map<string, Promise<AuthorityEligibilityResult>>();
  private lookups = 0;

  constructor(private readonly inner: AuthorityEligibilityValidator) {}

  /** Round trips actually made, for the performance assertions. */
  get lookupCount(): number {
    return this.lookups;
  }

  validate(employeeId: string, context: AuthorityEligibilityContext): Promise<AuthorityEligibilityResult> {
    const key = [employeeId, context.effectiveDate, context.workflowKey ?? "", context.requiredCapability ?? ""].join("|");
    const cached = this.answers.get(key);
    if (cached) return cached;
    this.lookups += 1;
    const answer = this.inner.validate(employeeId, context);
    this.answers.set(key, answer);
    return answer;
  }
}

function resolutionCode(error: unknown): string {
  if (error instanceof OrganizationResolutionError) return error.code;
  return "ORGANIZATION_RESOLUTION_FAILED";
}

/**
 * Translate the resolver's path into the operator-facing reason. The path holds the node keys walked
 * to find a leader binding, then every position visited while climbing past vacancies; an override
 * marks itself. Nothing is inferred from job titles (invariant I-7).
 */
export function describeAuthoritySource(
  snapshot: OrganizationSnapshot,
  authority: ResolvedAuthority,
): { source: OrganizationAuthoritySource; details: OrganizationAuthoritySource[] } {
  const positionKeys = new Set(snapshot.positions.map((item) => item.stableKey));
  const details: OrganizationAuthoritySource[] = [];

  if (authority.path[0]?.startsWith("override:")) {
    details.push("OVERRIDE");
  } else {
    const firstPositionIndex = authority.path.findIndex((entry) => positionKeys.has(entry));
    const nodeSteps = firstPositionIndex === -1 ? authority.path.length : firstPositionIndex;
    if (nodeSteps === 0) details.push("POSITION_PARENT");
    else if (nodeSteps === 1) details.push("MEMBERSHIP_LEADER");
    else details.push("INHERITED_LEADER");
  }

  const visitedPositions = authority.path.filter((entry) => positionKeys.has(entry));
  if (visitedPositions.length > 1) details.push("VACANCY_CLIMB");
  if (authority.incumbentKind === "ACTING") details.push("ACTING");

  // The most specific reason leads: an override, then who actually holds the seat, then the climb.
  const priority: OrganizationAuthoritySource[] = ["OVERRIDE", "ACTING", "VACANCY_CLIMB"];
  const source = priority.find((candidate) => details.includes(candidate)) ?? details[0]!;
  return { source, details };
}

function authorityView(
  snapshot: OrganizationSnapshot,
  authority: ResolvedAuthority,
  nameOf: (employeeId: string) => string,
): OrganizationAuthorityView {
  return {
    employeeId: authority.employeeId,
    employeeName: nameOf(authority.employeeId),
    positionKey: authority.positionKey,
    positionTitle: authority.positionKey
      ? snapshot.positions.find((item) => item.stableKey === authority.positionKey)?.title ?? null
      : null,
    incumbentKind: authority.incumbentKind,
  };
}

/** ORG-005-1 (D-5-3): the unit's own location, else the nearest ancestor's. Never a guess. */
export function resolveWorkLocation(
  snapshot: OrganizationSnapshot,
  nodeKey: string,
  asOf: string,
  locationNames: ReadonlyMap<string, string>,
): OrganizationPersonRow["workLocation"] {
  const seen = new Set<string>();
  let current: string | null = nodeKey;
  while (current && !seen.has(current)) {
    seen.add(current);
    const node = snapshot.nodes.find(
      (item) => item.stableKey === current && isEffective(item.effectiveFrom, item.effectiveTo, asOf),
    );
    // A switched-off unit names nothing and passes nothing down.
    if (!node || !node.active) return null;
    if (node.workLocationId) {
      return {
        id: node.workLocationId,
        name: locationNames.get(node.workLocationId) ?? "",
        inheritedFromNodeKey: node.stableKey === nodeKey ? null : node.stableKey,
      };
    }
    current = node.parentNodeKey;
  }
  return null;
}

function unitPath(snapshot: OrganizationSnapshot, nodeKey: string, asOf: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  let current: string | null = nodeKey;
  while (current && !seen.has(current)) {
    seen.add(current);
    const node = snapshot.nodes.find(
      (item) => item.stableKey === current && isEffective(item.effectiveFrom, item.effectiveTo, asOf),
    );
    if (!node) break;
    names.unshift(node.name);
    current = node.parentNodeKey;
  }
  return names;
}

export interface BuildPeopleViewInput {
  snapshot: OrganizationSnapshot | null;
  employees: OrganizationPersonEmployee[];
  eligibility: AuthorityEligibilityValidator;
  asOf: string;
  workflowKey?: string | undefined;
  requiredCapability?: string | undefined;
  includeLegacy?: boolean | undefined;
  /** ORG-005-1: work location names by id, for the row's workLocation. */
  workLocationNames?: ReadonlyMap<string, string> | undefined;
}

/**
 * One row per active employee, including employees who are in no unit at all — the case the impact
 * preview cannot see today, so nobody learns about it until an approval fails (gap P-3).
 */
export async function buildOrganizationPeopleView(input: BuildPeopleViewInput): Promise<OrganizationPersonRow[]> {
  const { snapshot, employees, asOf } = input;
  const nameById = new Map(employees.map((item) => [item.id, item.fullName]));
  const nameOf = (employeeId: string) => nameById.get(employeeId) ?? "";

  const rows: OrganizationPersonRow[] = [];
  if (!snapshot) {
    for (const employee of employees) {
      rows.push(emptyRow(employee, input.includeLegacy ?? false, "NO_STRUCTURE"));
    }
    return rows;
  }

  const resolver = new OrganizationAuthorityResolver(
    { loadEffectiveSnapshot: async () => snapshot },
    { eligibilityValidator: input.eligibility },
  );

  for (const employee of employees) {
    const membership = snapshot.memberships.find(
      (item) => item.employeeId === employee.id && item.isPrimary
        && isEffective(item.effectiveFrom, item.effectiveTo, asOf),
    );
    const ownIncumbency = snapshot.incumbencies.find(
      (item) => item.employeeId === employee.id && item.kind === "PRIMARY"
        && isEffective(item.effectiveFrom, item.effectiveTo, asOf),
    );
    const ownPosition = ownIncumbency
      ? snapshot.positions.find((item) => item.stableKey === ownIncumbency.positionKey) ?? null
      : null;

    const issues: OrganizationPersonRow["issues"] = [];
    if (!membership && !ownIncumbency) {
      issues.push({ scope: "MEMBERSHIP", code: "MEMBERSHIP_NOT_CONFIGURED" });
    }

    const resolution = {
      requesterEmployeeId: employee.id,
      effectiveDate: asOf,
      ...(input.workflowKey === undefined ? {} : { workflowKey: input.workflowKey }),
      ...(input.requiredCapability === undefined ? {} : { requiredCapability: input.requiredCapability }),
    };

    let directManager: OrganizationAuthorityView | null = null;
    let source: OrganizationAuthoritySource | null = null;
    let sourceDetails: OrganizationAuthoritySource[] = [];
    try {
      const resolved = await resolver.resolveDirectManager(resolution);
      directManager = authorityView(snapshot, resolved, nameOf);
      const described = describeAuthoritySource(snapshot, resolved);
      source = described.source;
      sourceDetails = described.details;
    } catch (error) {
      issues.push({ scope: "DIRECT_MANAGER", code: resolutionCode(error) });
    }

    let unitApprover: OrganizationAuthorityView | null = null;
    try {
      const resolved = await resolver.resolveUnitApprover(resolution);
      unitApprover = resolved ? authorityView(snapshot, resolved, nameOf) : null;
    } catch (error) {
      issues.push({ scope: "UNIT_APPROVER", code: resolutionCode(error) });
    }

    rows.push({
      employeeId: employee.id,
      employeeNumber: employee.employeeNumber,
      fullName: employee.fullName,
      unit: membership
        ? {
            nodeKey: membership.nodeKey,
            name: snapshot.nodes.find((item) => item.stableKey === membership.nodeKey)?.name ?? "",
            path: unitPath(snapshot, membership.nodeKey, asOf),
          }
        : null,
      workLocation: membership
        ? resolveWorkLocation(snapshot, membership.nodeKey, asOf, input.workLocationNames ?? new Map())
        : null,
      position: ownPosition ? { stableKey: ownPosition.stableKey, title: ownPosition.title } : null,
      directManager,
      source,
      sourceDetails,
      unitApprover,
      issues,
      legacy: input.includeLegacy
        ? {
            directManagerEmployeeId: employee.legacyDirectManagerEmployeeId,
            directManagerName: employee.legacyDirectManagerName,
            unitApproverEmployeeId: employee.legacyUnitApproverEmployeeId,
            unitApproverName: employee.legacyUnitApproverName,
            unitName: employee.legacyUnitName,
            comparison: compareWithLegacy(directManager, employee.legacyDirectManagerEmployeeId),
          }
        : null,
    });
  }
  return rows;
}

function compareWithLegacy(
  directManager: OrganizationAuthorityView | null,
  legacyManagerId: string | null,
): OrganizationComparison {
  if (!directManager) return "UNRESOLVED";
  if (!legacyManagerId) return "NO_LEGACY";
  return directManager.employeeId === legacyManagerId ? "SAME" : "DIFFERENT";
}

function emptyRow(
  employee: OrganizationPersonEmployee,
  includeLegacy: boolean,
  code: string,
): OrganizationPersonRow {
  return {
    employeeId: employee.id,
    employeeNumber: employee.employeeNumber,
    fullName: employee.fullName,
    unit: null,
    workLocation: null,
    position: null,
    directManager: null,
    source: null,
    sourceDetails: [],
    unitApprover: null,
    issues: [{ scope: "MEMBERSHIP", code }],
    legacy: includeLegacy
      ? {
          directManagerEmployeeId: employee.legacyDirectManagerEmployeeId,
          directManagerName: employee.legacyDirectManagerName,
          unitApproverEmployeeId: employee.legacyUnitApproverEmployeeId,
          unitApproverName: employee.legacyUnitApproverName,
          unitName: employee.legacyUnitName,
          comparison: "UNRESOLVED",
        }
      : null,
  };
}

export interface OrganizationReadiness {
  asOf: string;
  changeSetId: string | null;
  activeEmployees: number;
  withoutUnit: number;
  /** ORG-005-1: placed in a unit, but no unit up the branch names a work location. */
  withoutWorkLocation: number;
  unresolvedManager: number;
  ineligibleManagers: number;
  vacantRequiringActing: number;
  actingEndingSoon: Array<{ positionKey: string; positionTitle: string; employeeId: string | null; endsOn: string }>;
  comparison: { same: number; different: number; unresolved: number; noLegacy: number } | null;
}

/** The counts behind the Kesiapan screen, derived from the same rows so the two can never disagree. */
export function computeOrganizationReadiness(input: {
  rows: OrganizationPersonRow[];
  snapshot: OrganizationSnapshot | null;
  asOf: string;
  actingHorizonDays?: number;
}): OrganizationReadiness {
  const { rows, snapshot, asOf } = input;
  const horizonDays = input.actingHorizonDays ?? 14;
  const horizon = new Date(`${asOf}T00:00:00Z`);
  horizon.setUTCDate(horizon.getUTCDate() + horizonDays);
  const horizonDate = horizon.toISOString().slice(0, 10);

  const vacantRequiringActing = (snapshot?.positions ?? []).filter((position) =>
    position.active
    && position.vacancyPolicy === "REQUIRE_ACTING_OR_BLOCK"
    && isEffective(position.effectiveFrom, position.effectiveTo, asOf)
    && !(snapshot?.incumbencies ?? []).some((item) =>
      item.positionKey === position.stableKey && isEffective(item.effectiveFrom, item.effectiveTo, asOf)),
  ).length;

  const actingEndingSoon = (snapshot?.incumbencies ?? [])
    .filter((item) => item.kind === "ACTING" && item.effectiveTo !== null
      && item.effectiveTo >= asOf && item.effectiveTo <= horizonDate)
    .map((item) => ({
      positionKey: item.positionKey,
      positionTitle: snapshot?.positions.find((position) => position.stableKey === item.positionKey)?.title ?? "",
      employeeId: item.employeeId ?? null,
      endsOn: item.effectiveTo!,
    }));

  const withLegacy = rows.filter((row) => row.legacy !== null);
  return {
    asOf,
    changeSetId: snapshot?.changeSet.id ?? null,
    activeEmployees: rows.length,
    withoutUnit: rows.filter((row) => row.unit === null && row.position === null).length,
    // ORG-005-1: informational only, never a reason to refuse publishing (D-5-3).
    withoutWorkLocation: rows.filter((row) => row.unit !== null && row.workLocation === null).length,
    unresolvedManager: rows.filter((row) => row.directManager === null).length,
    ineligibleManagers: rows.filter((row) =>
      row.issues.some((issue) => issue.code === "AUTHORITY_INELIGIBLE")).length,
    vacantRequiringActing,
    actingEndingSoon,
    comparison: withLegacy.length === 0 ? null : {
      same: withLegacy.filter((row) => row.legacy?.comparison === "SAME").length,
      different: withLegacy.filter((row) => row.legacy?.comparison === "DIFFERENT").length,
      unresolved: withLegacy.filter((row) => row.legacy?.comparison === "UNRESOLVED").length,
      noLegacy: withLegacy.filter((row) => row.legacy?.comparison === "NO_LEGACY").length,
    },
  };
}

export interface OrganizationExplanationStep {
  code:
    | "MEMBER_OF_UNIT"
    | "NOT_IN_ANY_UNIT"
    | "HOLDS_POSITION"
    | "UNIT_LEADER_IS_POSITION"
    | "LEADER_INHERITED_FROM_PARENT"
    | "POSITION_REPORTS_TO"
    | "REPORTING_OVERRIDE"
    | "POSITION_VACANT_CLIMBED"
    | "POSITION_HELD_BY_ACTING"
    | "RESULT_DIRECT_MANAGER"
    | "RESULT_UNIT_APPROVER"
    | "RESULT_UNRESOLVED";
  params: Record<string, string | null>;
}

/**
 * The steps behind one employee's answer, as codes plus parameters. Sentences are composed in the
 * web app, where the operator vocabulary already lives (ORG-008-1), so the API stays language-free.
 */
export function explainPerson(row: OrganizationPersonRow): OrganizationExplanationStep[] {
  const steps: OrganizationExplanationStep[] = [];
  if (row.unit) {
    steps.push({ code: "MEMBER_OF_UNIT", params: { employee: row.fullName, unit: row.unit.path.join(" › ") || row.unit.name } });
  } else if (row.position) {
    steps.push({ code: "HOLDS_POSITION", params: { employee: row.fullName, position: row.position.title } });
  } else {
    steps.push({ code: "NOT_IN_ANY_UNIT", params: { employee: row.fullName } });
  }

  if (row.sourceDetails.includes("OVERRIDE")) {
    steps.push({ code: "REPORTING_OVERRIDE", params: { employee: row.fullName } });
  } else if (row.sourceDetails.includes("POSITION_PARENT") && row.position) {
    steps.push({ code: "POSITION_REPORTS_TO", params: { position: row.position.title, parent: row.directManager?.positionTitle ?? null } });
  } else if (row.sourceDetails.includes("INHERITED_LEADER")) {
    steps.push({ code: "LEADER_INHERITED_FROM_PARENT", params: { unit: row.unit?.name ?? null, position: row.directManager?.positionTitle ?? null } });
  } else if (row.sourceDetails.includes("MEMBERSHIP_LEADER")) {
    steps.push({ code: "UNIT_LEADER_IS_POSITION", params: { unit: row.unit?.name ?? null, position: row.directManager?.positionTitle ?? null } });
  }

  if (row.sourceDetails.includes("VACANCY_CLIMB")) {
    steps.push({ code: "POSITION_VACANT_CLIMBED", params: { position: row.directManager?.positionTitle ?? null } });
  }
  if (row.sourceDetails.includes("ACTING")) {
    steps.push({ code: "POSITION_HELD_BY_ACTING", params: { employee: row.directManager?.employeeName ?? null, position: row.directManager?.positionTitle ?? null } });
  }

  if (row.directManager) {
    steps.push({ code: "RESULT_DIRECT_MANAGER", params: { employee: row.directManager.employeeName, position: row.directManager.positionTitle } });
  } else {
    const issue = row.issues.find((item) => item.scope === "DIRECT_MANAGER") ?? row.issues[0];
    steps.push({ code: "RESULT_UNRESOLVED", params: { code: issue?.code ?? null } });
  }
  if (row.unitApprover) {
    steps.push({ code: "RESULT_UNIT_APPROVER", params: { employee: row.unitApprover.employeeName, position: row.unitApprover.positionTitle } });
  }
  return steps;
}
