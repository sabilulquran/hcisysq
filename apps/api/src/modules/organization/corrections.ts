// ORG-008-4b: undoing a mistake inside a change set that has not been published.
//
// Today a unit or position typed in by mistake can only be renamed or moved, because there is no
// delete and no deactivate anywhere in the UI even though PATCH supports `active` (gap S-3). The
// authority dialog can only add, so one wrong leader makes the change set permanently unvalidatable
// and the only way out is to throw the whole thing away (gap W-1).
//
// Two rules keep that from becoming a way to rewrite history:
//   - anything that has ever been published can only be deactivated or ended, never deleted;
//   - nothing can be removed or deactivated while something still points at it, and the answer says
//     what points at it rather than failing later as an unnamed validation code.
//
// Pure: it inspects a snapshot and reports. The caller decides and persists.

import type { OrganizationSnapshot } from "./domain.js";
import { isEffective } from "./jakarta-date.js";

export interface OrganizationItemUse {
  kind:
    | "MEMBERSHIP"
    | "POSITION"
    | "CHILD_UNIT"
    | "INCUMBENT"
    | "ACTING_INCUMBENT"
    | "AUTHORITY_BINDING"
    | "CHILD_POSITION"
    | "REPORTING_OVERRIDE";
  /** The record that still points at the item; identifiers only. */
  id: string;
  /** A name the screen can show, when the snapshot has one. */
  name: string | null;
}

function activeNodes(snapshot: OrganizationSnapshot, asOf: string) {
  return snapshot.nodes.filter((item) => item.active && isEffective(item.effectiveFrom, item.effectiveTo, asOf));
}

function activePositions(snapshot: OrganizationSnapshot, asOf: string) {
  return snapshot.positions.filter((item) => item.active && isEffective(item.effectiveFrom, item.effectiveTo, asOf));
}

/** What still points at a unit, on the date the change set takes effect. */
export function findNodeUses(snapshot: OrganizationSnapshot, nodeKey: string, asOf: string): OrganizationItemUse[] {
  const uses: OrganizationItemUse[] = [];
  for (const membership of snapshot.memberships) {
    if (membership.nodeKey !== nodeKey) continue;
    if (!isEffective(membership.effectiveFrom, membership.effectiveTo, asOf)) continue;
    uses.push({ kind: "MEMBERSHIP", id: membership.employeeId, name: null });
  }
  for (const position of activePositions(snapshot, asOf)) {
    if (position.nodeKey === nodeKey) uses.push({ kind: "POSITION", id: position.stableKey, name: position.title });
  }
  for (const node of activeNodes(snapshot, asOf)) {
    if (node.parentNodeKey === nodeKey) uses.push({ kind: "CHILD_UNIT", id: node.stableKey, name: node.name });
  }
  for (const binding of snapshot.authorityBindings) {
    if (binding.subjectKey !== nodeKey) continue;
    if (!isEffective(binding.effectiveFrom, binding.effectiveTo, asOf)) continue;
    uses.push({ kind: "AUTHORITY_BINDING", id: binding.id, name: binding.bindingType });
  }
  return uses;
}

/** What still points at a position, on the date the change set takes effect. */
export function findPositionUses(snapshot: OrganizationSnapshot, positionKey: string, asOf: string): OrganizationItemUse[] {
  const uses: OrganizationItemUse[] = [];
  for (const incumbency of snapshot.incumbencies) {
    if (incumbency.positionKey !== positionKey) continue;
    if (!isEffective(incumbency.effectiveFrom, incumbency.effectiveTo, asOf)) continue;
    uses.push({
      kind: incumbency.kind === "ACTING" ? "ACTING_INCUMBENT" : "INCUMBENT",
      id: incumbency.employeeId ?? incumbency.accountId ?? incumbency.id,
      name: null,
    });
  }
  for (const binding of snapshot.authorityBindings) {
    if (binding.targetPositionKey !== positionKey) continue;
    if (!isEffective(binding.effectiveFrom, binding.effectiveTo, asOf)) continue;
    uses.push({ kind: "AUTHORITY_BINDING", id: binding.id, name: binding.bindingType });
  }
  for (const position of activePositions(snapshot, asOf)) {
    if (position.parentPositionKey === positionKey) {
      uses.push({ kind: "CHILD_POSITION", id: position.stableKey, name: position.title });
    }
  }
  for (const override of snapshot.reportingOverrides) {
    if (override.managerPositionKey !== positionKey) continue;
    if (!isEffective(override.effectiveFrom, override.effectiveTo, asOf)) continue;
    uses.push({ kind: "REPORTING_OVERRIDE", id: override.employeeId, name: null });
  }
  return uses;
}

/**
 * A binding that was already in effect before this change set starts came from published structure,
 * so it is ended rather than deleted; one created inside this change set never existed anywhere else
 * and can simply go.
 */
export function bindingIsFromPublishedStructure(
  binding: { effectiveFrom: string },
  changeSetEffectiveOn: string,
): boolean {
  return binding.effectiveFrom < changeSetEffectiveOn;
}
