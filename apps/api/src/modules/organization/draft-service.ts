import type {
  OrganizationImpactPreview,
  OrganizationSnapshot,
  OrganizationValidationIssue,
  OrganizationValidationReport,
} from "./domain.js";
import { OrganizationDraftError, OrganizationResolutionError } from "./domain.js";
import { isEffective } from "./jakarta-date.js";
import type { PostgresOrganizationRepository } from "./repository.js";
import { OrganizationAuthorityResolver } from "./resolver.js";

export class OrganizationDraftService {
  constructor(private readonly repository: PostgresOrganizationRepository) {}

  async validateDraft(
    changeSetId: string,
    actorAccountId: string,
  ): Promise<OrganizationValidationReport> {
    const snapshot = await this.requireMutable(changeSetId);
    const issues: OrganizationValidationIssue[] = [];
    this.validateReferences(snapshot, issues);
    this.validateCycles(snapshot, issues);
    this.validateOverlaps(snapshot, issues);
    await this.validateIncumbents(snapshot, issues);
    const report: OrganizationValidationReport = {
      valid: issues.length === 0,
      issues,
      checkedAt: new Date().toISOString(),
    };
    await this.repository.markValidated(changeSetId, actorAccountId, report);
    return report;
  }

  async previewImpact(changeSetId: string): Promise<OrganizationImpactPreview> {
    const draft = await this.repository.loadChangeSetSnapshot(changeSetId);
    if (!draft) throw new OrganizationDraftError("CHANGE_SET_NOT_FOUND", "Organization draft was not found.");
    const before = draft.changeSet.baseChangeSetId
      ? await this.repository.loadChangeSetSnapshot(draft.changeSet.baseChangeSetId)
      : null;
    const date = draft.changeSet.effectiveOn;
    const beforeResolver = before ? this.resolverFor(before) : null;
    const afterResolver = this.resolverFor(draft);
    const employees = new Set([
      ...(before?.memberships ?? []).filter((item) => item.isPrimary).map((item) => item.employeeId),
      ...draft.memberships.filter((item) => item.isPrimary).map((item) => item.employeeId),
    ]);
    const directManagerChanges: OrganizationImpactPreview["directManagerChanges"] = [];
    const unitByNode = new Map<string, { beforeEmployeeId: string | null; afterEmployeeId: string | null }>();
    const unresolvedEmployeeIds: string[] = [];

    for (const employeeId of employees) {
      const beforeManager = beforeResolver
        ? await safelyResolve(() => beforeResolver.resolveDirectManager({ requesterEmployeeId: employeeId, effectiveDate: date }))
        : null;
      const afterManager = await safelyResolve(
        () => afterResolver.resolveDirectManager({ requesterEmployeeId: employeeId, effectiveDate: date }),
      );
      if (beforeManager?.employeeId !== afterManager?.employeeId) {
        directManagerChanges.push({
          employeeId,
          beforeEmployeeId: beforeManager?.employeeId ?? null,
          afterEmployeeId: afterManager?.employeeId ?? null,
        });
      }
      if (!afterManager) unresolvedEmployeeIds.push(employeeId);

      const beforeUnit = beforeResolver
        ? await safelyResolve(() => beforeResolver.resolveUnitApprover({ requesterEmployeeId: employeeId, effectiveDate: date }))
        : null;
      const afterUnit = await safelyResolve(
        () => afterResolver.resolveUnitApprover({ requesterEmployeeId: employeeId, effectiveDate: date }),
      );
      const nodeKey = draft.memberships.find(
        (item) => item.employeeId === employeeId && item.isPrimary
          && isEffective(item.effectiveFrom, item.effectiveTo, date),
      )?.nodeKey;
      if (nodeKey && beforeUnit?.employeeId !== afterUnit?.employeeId) {
        unitByNode.set(nodeKey, {
          beforeEmployeeId: beforeUnit?.employeeId ?? null,
          afterEmployeeId: afterUnit?.employeeId ?? null,
        });
      }
    }

    const routingBefore = before ? routingFingerprint(before) : "";
    const routingAfter = routingFingerprint(draft);
    const routingImpact = routingBefore !== routingAfter;
    const visualChanged = before ? visualFingerprint(before) !== visualFingerprint(draft) : false;
    return {
      directManagerChanges,
      unitApproverChanges: [...unitByNode].map(([nodeKey, value]) => ({ nodeKey, ...value })),
      affectedAuthorityPaths: changedAuthorityKeys(before, draft),
      vacantPositionKeys: draft.positions
        .filter((position) => position.active && isEffective(position.effectiveFrom, position.effectiveTo, date))
        .filter((position) => !draft.incumbencies.some(
          (incumbency) => incumbency.positionKey === position.stableKey
            && isEffective(incumbency.effectiveFrom, incumbency.effectiveTo, date),
        ))
        .map((position) => position.stableKey),
      unresolvedEmployeeIds: [...new Set(unresolvedEmployeeIds)],
      visualOnly: visualChanged && !routingImpact,
      routingImpact,
    };
  }

  async publish(changeSetId: string, actorAccountId: string): Promise<void> {
    const snapshot = await this.repository.loadChangeSetSnapshot(changeSetId);
    if (!snapshot) throw new OrganizationDraftError("CHANGE_SET_NOT_FOUND", "Organization draft was not found.");
    if (snapshot.changeSet.status !== "VALIDATED" || !snapshot.changeSet.validationReport.valid) {
      throw new OrganizationDraftError(
        "CHANGE_SET_NOT_VALIDATED",
        "Organization change set must pass validation before publish.",
      );
    }
    await this.repository.publishValidated(changeSetId, actorAccountId);
  }

  private resolverFor(snapshot: OrganizationSnapshot): OrganizationAuthorityResolver {
    return new OrganizationAuthorityResolver(
      { loadEffectiveSnapshot: async () => snapshot },
      { eligibilityValidator: this.repository },
    );
  }

  private async requireMutable(changeSetId: string): Promise<OrganizationSnapshot> {
    const snapshot = await this.repository.loadChangeSetSnapshot(changeSetId);
    if (!snapshot) throw new OrganizationDraftError("CHANGE_SET_NOT_FOUND", "Organization draft was not found.");
    if (snapshot.changeSet.status === "PUBLISHED") {
      throw new OrganizationDraftError("CHANGE_SET_PUBLISHED", "Published organization history is immutable.");
    }
    return snapshot;
  }

  private validateReferences(snapshot: OrganizationSnapshot, issues: OrganizationValidationIssue[]): void {
    const nodeKeys = new Set(snapshot.nodes.map((item) => item.stableKey));
    const positionKeys = new Set(snapshot.positions.map((item) => item.stableKey));
    const profileKeys = new Set(snapshot.jobProfiles.map((item) => item.stableKey));
    for (const node of snapshot.nodes) {
      if (node.parentNodeKey && !nodeKeys.has(node.parentNodeKey)) {
        issues.push(issue("INVALID_NODE_PARENT", "Node parent does not exist.", "node", node.id));
      }
    }
    for (const position of snapshot.positions) {
      if (!nodeKeys.has(position.nodeKey)) {
        issues.push(issue("INVALID_POSITION_NODE", "Position node does not exist.", "position", position.id));
      }
      if (position.parentPositionKey && !positionKeys.has(position.parentPositionKey)) {
        issues.push(issue("INVALID_POSITION_PARENT", "Position parent does not exist.", "position", position.id));
      }
    }
    for (const membership of snapshot.memberships) {
      if (!nodeKeys.has(membership.nodeKey)) {
        issues.push(issue("INVALID_MEMBERSHIP_NODE", "Membership node does not exist.", "membership", membership.id));
      }
      if (membership.jobProfileKey && !profileKeys.has(membership.jobProfileKey)) {
        issues.push(issue("INVALID_JOB_PROFILE", "Membership job profile does not exist.", "membership", membership.id));
      }
    }
    for (const binding of snapshot.authorityBindings) {
      const subjectExists = binding.subjectKind === "NODE"
        ? nodeKeys.has(binding.subjectKey)
        : positionKeys.has(binding.subjectKey);
      if (!subjectExists || !positionKeys.has(binding.targetPositionKey)) {
        issues.push(issue("INVALID_AUTHORITY_REFERENCE", "Authority binding contains an invalid reference.", "authority_binding", binding.id));
      }
    }
  }

  private validateCycles(snapshot: OrganizationSnapshot, issues: OrganizationValidationIssue[]): void {
    detectCycle(
      snapshot.nodes.map((item) => [item.stableKey, item.parentNodeKey] as const),
      "STRUCTURAL_NODE_CYCLE", issues,
    );
    const parentByPosition = new Map(
      snapshot.positions.map((item) => [item.stableKey, item.parentPositionKey] as const),
    );
    for (const binding of snapshot.authorityBindings) {
      if (binding.subjectKind === "POSITION" && binding.bindingType === "SUPERVISORY_PARENT") {
        parentByPosition.set(binding.subjectKey, binding.targetPositionKey);
      }
    }
    detectCycle([...parentByPosition], "SUPERVISORY_POSITION_CYCLE", issues);
    for (const type of ["GOVERNANCE_APPROVER", "OVERSIGHT_PARENT"] as const) {
      detectCycle(
        snapshot.authorityBindings
          .filter((item) => item.subjectKind === "POSITION" && item.bindingType === type)
          .map((item) => [item.subjectKey, item.targetPositionKey] as const),
        "AUTHORITY_LOOP", issues,
      );
    }
  }

  private validateOverlaps(snapshot: OrganizationSnapshot, issues: OrganizationValidationIssue[]): void {
    findOverlaps(
      snapshot.incumbencies.filter((item) => item.kind === "PRIMARY"),
      (item) => item.positionKey,
      "PRIMARY_INCUMBENCY_OVERLAP", issues,
    );
    findOverlaps(
      snapshot.memberships.filter((item) => item.isPrimary),
      (item) => item.employeeId,
      "PRIMARY_MEMBERSHIP_OVERLAP", issues,
    );
    findOverlaps(snapshot.reportingOverrides, (item) => item.employeeId, "REPORTING_OVERRIDE_OVERLAP", issues);
    findOverlaps(
      snapshot.authorityBindings,
      (item) => `${item.subjectKind}:${item.subjectKey}:${item.bindingType}`,
      "AUTHORITY_BINDING_OVERLAP", issues,
    );
  }

  private async validateIncumbents(
    snapshot: OrganizationSnapshot,
    issues: OrganizationValidationIssue[],
  ): Promise<void> {
    for (const incumbency of snapshot.incumbencies.filter(
      (item) => isEffective(item.effectiveFrom, item.effectiveTo, snapshot.changeSet.effectiveOn),
    )) {
      const position = snapshot.positions.find((item) => item.stableKey === incumbency.positionKey);
      const holderSource = position?.holderSource ?? "EMPLOYEE";
      if (holderSource === "ACCOUNT") {
        if (!incumbency.accountId || incumbency.employeeId) {
          issues.push(issue(
            "INVALID_INCUMBENCY_PRINCIPAL",
            "Account-held position must reference exactly one account principal.",
            "incumbency",
            incumbency.id,
          ));
        }
        continue;
      }
      if (!incumbency.employeeId || incumbency.accountId) {
        issues.push(issue(
          "INVALID_INCUMBENCY_PRINCIPAL",
          "Employee-held position must reference exactly one employee principal.",
          "incumbency",
          incumbency.id,
        ));
        continue;
      }
      const eligibility = await this.repository.validateStructuralIncumbent(incumbency.employeeId);
      if (!eligibility.eligible) {
        issues.push(issue(
          "INACTIVE_INCUMBENT",
          `Incumbent must reference an active employee: ${eligibility.reason ?? "unknown"}.`,
          "incumbency",
          incumbency.id,
        ));
      }
    }
  }
}

async function safelyResolve<T>(operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof OrganizationResolutionError) return null;
    throw error;
  }
}

function issue(
  code: string,
  message: string,
  entityType?: string,
  entityId?: string,
): OrganizationValidationIssue {
  return { code, message, entityType, entityId };
}

function detectCycle(
  edges: ReadonlyArray<readonly [string, string | null]>,
  code: string,
  issues: OrganizationValidationIssue[],
): void {
  const parent = new Map(edges);
  for (const start of parent.keys()) {
    const seen = new Set<string>();
    let current: string | null | undefined = start;
    while (current) {
      if (seen.has(current)) {
        if (!issues.some((item) => item.code === code)) {
          issues.push(issue(code, "Organization relationship contains a cycle."));
        }
        break;
      }
      seen.add(current);
      current = parent.get(current);
    }
  }
}

function findOverlaps<T extends { id: string; effectiveFrom: string; effectiveTo: string | null }>(
  items: T[],
  group: (item: T) => string,
  code: string,
  issues: OrganizationValidationIssue[],
): void {
  for (let leftIndex = 0; leftIndex < items.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex += 1) {
      const left = items[leftIndex]!;
      const right = items[rightIndex]!;
      if (group(left) !== group(right)) continue;
      const leftEnd = left.effectiveTo ?? "9999-12-31";
      const rightEnd = right.effectiveTo ?? "9999-12-31";
      if (left.effectiveFrom <= rightEnd && right.effectiveFrom <= leftEnd) {
        issues.push(issue(code, "Effective periods overlap.", undefined, right.id));
      }
    }
  }
}

function routingFingerprint(snapshot: OrganizationSnapshot): string {
  const order = <T,>(items: T[], fields: (item: T) => unknown[]) => items
    .map(fields)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return JSON.stringify({
    nodes: order(snapshot.nodes, (item) => [item.stableKey, item.parentNodeKey,
      item.active, item.effectiveFrom, item.effectiveTo]),
    positions: order(snapshot.positions, (item) => [item.stableKey, item.nodeKey,
      item.parentPositionKey, item.singleIncumbent, item.vacancyPolicy, item.active,
      item.effectiveFrom, item.effectiveTo, item.holderSource ?? "EMPLOYEE"]),
    memberships: order(snapshot.memberships, (item) => [item.employeeId, item.nodeKey,
      item.jobProfileKey, item.isPrimary, item.effectiveFrom, item.effectiveTo]),
    incumbencies: order(snapshot.incumbencies, (item) => [item.positionKey, item.employeeId,
      item.accountId ?? null, item.kind, item.isPrimaryStructural ?? false,
      item.effectiveFrom, item.effectiveTo]),
    authorityBindings: order(snapshot.authorityBindings, (item) => [item.subjectKind,
      item.subjectKey, item.bindingType, item.targetPositionKey, item.vacancyPolicy,
      item.effectiveFrom, item.effectiveTo]),
    reportingOverrides: order(snapshot.reportingOverrides, (item) => [item.employeeId,
      item.managerPositionKey, item.managerEmployeeId, item.effectiveFrom, item.effectiveTo]),
  });
}

function visualFingerprint(snapshot: OrganizationSnapshot): string {
  return JSON.stringify({
    nodes: snapshot.nodes.map((item) => [item.stableKey, item.visualRankOffset]).sort(),
    positions: snapshot.positions.map((item) => [item.stableKey, item.visualRankOffset]).sort(),
  });
}

function changedAuthorityKeys(
  before: OrganizationSnapshot | null,
  after: OrganizationSnapshot,
): string[] {
  if (!before) return after.authorityBindings.map((item) => item.subjectKey);
  const beforeMap = new Map(before.authorityBindings.map((item) => [
    `${item.subjectKind}:${item.subjectKey}:${item.bindingType}`,
    `${item.targetPositionKey}:${item.vacancyPolicy}:${item.effectiveFrom}:${item.effectiveTo}`,
  ]));
  const afterMap = new Map(after.authorityBindings.map((item) => [
    `${item.subjectKind}:${item.subjectKey}:${item.bindingType}`,
    `${item.targetPositionKey}:${item.vacancyPolicy}:${item.effectiveFrom}:${item.effectiveTo}`,
  ]));
  return [...new Set([...beforeMap.keys(), ...afterMap.keys()])]
    .filter((key) => beforeMap.get(key) !== afterMap.get(key));
}
