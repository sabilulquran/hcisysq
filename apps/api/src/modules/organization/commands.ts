// ORG-008-4a: one operator action, applied as one atomic command.
//
// Registering a unit with its head is five separate dialogs today — group, position, incumbent,
// leader binding, unit-approver binding — and forgetting one of them is invisible until an approval
// fails (gap S-2). A command does the whole thing or none of it.
//
// It does NOT collapse the model: the backend still stores a node, a position, an incumbency, and
// each authority binding as its own audited record (invariant I-6). What changes is how many round
// trips and half-finished states an operator can get into.
//
// Pure: a snapshot goes in, a snapshot comes out, along with the audit events the caller must write
// in the same transaction. Nothing here talks to the database, so every rule below is testable.

import { randomUUID } from "node:crypto";

import type {
  OrganizationAuthorityBinding,
  OrganizationSnapshot,
  VacancyPolicy,
} from "./domain.js";
import { assertIsoDate, isEffective } from "./jakarta-date.js";

export class OrganizationCommandError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
    /** 409 for a state conflict the operator must resolve, 400 for an input that cannot be meant. */
    public readonly statusCode: 400 | 409 = 409,
  ) {
    super(message);
    this.name = "OrganizationCommandError";
  }
}

/**
 * ORG-008-4c: the stable keys a command created when it was first applied. Replaying a journal reuses
 * them so commands that referred to those keys still match.
 */
export interface OrganizationCommandKeys {
  nodeKey?: string | undefined;
  positionKey?: string | undefined;
}

export interface OrganizationCommandAudit {
  action: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
}

export interface OrganizationCommandResult {
  snapshot: OrganizationSnapshot;
  /** One event per primitive record written, as ORG-004 requires, plus the caller's summary event. */
  events: OrganizationCommandAudit[];
  /** Short, identifier-level description for the journal and the "Yang berubah" list. */
  summary: Record<string, unknown>;
}

/**
 * Journal lines whose command type is one of these can be replayed onto a fresh base. Every other
 * line (a manual edit made through a single-record endpoint, or the legacy seed) records a change
 * the journal cannot reproduce.
 */
export const REPLAYABLE_COMMAND_TYPES: ReadonlySet<string> = new Set([
  "ADD_UNIT", "PLACE_EMPLOYEES", "APPOINT_ACTING", "SET_REPORTS_TO",
  "SET_UNIT_LEADER", "SET_UNIT_APPROVER", "SET_OVERRIDE",
]);

export type OrganizationCommand =
  | {
      type: "ADD_UNIT";
      name: string;
      nodeType: string;
      parentNodeKey: string | null;
      leader?: {
        title: string;
        employeeId?: string | null;
        vacancyPolicy?: VacancyPolicy;
        alsoUnitApprover?: boolean;
      };
    }
  | { type: "PLACE_EMPLOYEES"; nodeKey: string; employeeIds: string[]; move?: boolean }
  | {
      type: "APPOINT_ACTING";
      positionKey: string;
      employeeId: string;
      effectiveFrom: string;
      effectiveTo: string;
      reason: string;
      mandateNumber?: string | null;
    }
  | { type: "SET_REPORTS_TO"; positionKey: string; parentPositionKey: string | null }
  | { type: "SET_UNIT_LEADER"; nodeKey: string; positionKey: string }
  | { type: "SET_UNIT_APPROVER"; nodeKey: string; positionKey: string }
  | {
      type: "SET_OVERRIDE";
      employeeId: string;
      managerPositionKey: string;
      reason: string;
      effectiveFrom?: string;
      effectiveTo?: string | null;
    };

function dayBefore(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function requireNode(snapshot: OrganizationSnapshot, nodeKey: string) {
  const node = snapshot.nodes.find((item) => item.stableKey === nodeKey);
  if (!node) {
    throw new OrganizationCommandError(
      "ORGANIZATION_NODE_NOT_FOUND", "The unit referenced by the command does not exist.", { nodeKey },
    );
  }
  return node;
}

function requirePosition(snapshot: OrganizationSnapshot, positionKey: string) {
  const position = snapshot.positions.find((item) => item.stableKey === positionKey);
  if (!position) {
    throw new OrganizationCommandError(
      "ORGANIZATION_POSITION_NOT_FOUND", "The position referenced by the command does not exist.", { positionKey },
    );
  }
  return position;
}

/**
 * End the authority bindings of one kind on a unit before a new one is created.
 *
 * Today the Kewenangan dialog can only add, so a second leader on the same unit makes the change set
 * permanently invalid with AUTHORITY_BINDING_OVERLAP and the only way out is to throw it away
 * (gap W-1). Replacing means closing the old record, never deleting it, so history stays readable.
 */
function endBindings(
  snapshot: OrganizationSnapshot,
  subjectKey: string,
  bindingType: OrganizationAuthorityBinding["bindingType"],
  effectiveOn: string,
  events: OrganizationCommandAudit[],
): void {
  for (const binding of snapshot.authorityBindings) {
    if (binding.subjectKey !== subjectKey || binding.bindingType !== bindingType) continue;
    if (!isEffective(binding.effectiveFrom, binding.effectiveTo, effectiveOn)) continue;
    if (binding.effectiveFrom >= effectiveOn) {
      // Created inside this change set and never published: it can simply be dropped.
      snapshot.authorityBindings = snapshot.authorityBindings.filter((item) => item.id !== binding.id);
    } else {
      binding.effectiveTo = dayBefore(effectiveOn);
    }
    events.push({
      action: "organization.authority_binding.ended",
      entityType: "organization_authority_binding",
      entityId: binding.id,
      payload: { subjectKey, bindingType, endedOn: dayBefore(effectiveOn) },
    });
  }
}

function addBinding(
  snapshot: OrganizationSnapshot,
  input: {
    subjectKey: string;
    bindingType: OrganizationAuthorityBinding["bindingType"];
    targetPositionKey: string;
    vacancyPolicy: VacancyPolicy;
    effectiveFrom: string;
  },
  events: OrganizationCommandAudit[],
): void {
  const created = {
    id: randomUUID(),
    subjectKind: "NODE" as const,
    subjectKey: input.subjectKey,
    bindingType: input.bindingType,
    targetPositionKey: input.targetPositionKey,
    vacancyPolicy: input.vacancyPolicy,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: null,
  };
  snapshot.authorityBindings.push(created);
  events.push({
    action: "organization.authority_binding.created",
    entityType: "organization_authority_binding",
    entityId: created.id,
    payload: {
      subjectKey: input.subjectKey,
      bindingType: input.bindingType,
      targetPositionKey: input.targetPositionKey,
    },
  });
}

function applyAddUnit(
  snapshot: OrganizationSnapshot,
  command: Extract<OrganizationCommand, { type: "ADD_UNIT" }>,
  effectiveOn: string,
  events: OrganizationCommandAudit[],
  reuseKeys?: OrganizationCommandKeys,
): Record<string, unknown> {
  if (command.parentNodeKey) requireNode(snapshot, command.parentNodeKey);
  const node = {
    id: randomUUID(),
    // ORG-008-4c: on replay the keys this command minted the first time are reused, so a later
    // command that referred to them still finds them. A fresh application mints new ones.
    stableKey: reuseKeys?.nodeKey ?? randomUUID(),
    name: command.name.trim(),
    nodeType: command.nodeType.trim(),
    parentNodeKey: command.parentNodeKey,
    active: true,
    effectiveFrom: effectiveOn,
    effectiveTo: null,
    visualRankOffset: 0,
    integrationCode: null,
  };
  snapshot.nodes.push(node);
  events.push({
    action: "organization.node.created",
    entityType: "organization_node",
    entityId: node.id,
    payload: { stableKey: node.stableKey, name: node.name, parentNodeKey: node.parentNodeKey },
  });

  const summary: Record<string, unknown> = { nodeKey: node.stableKey, name: node.name };
  if (!command.leader) return summary;

  const position = {
    id: randomUUID(),
    stableKey: reuseKeys?.positionKey ?? randomUUID(),
    nodeKey: node.stableKey,
    title: command.leader.title.trim(),
    parentPositionKey: null,
    singleIncumbent: true,
    // Decision O-6: a unit's own leadership seat climbs when it is empty, unless the owner marks it.
    vacancyPolicy: command.leader.vacancyPolicy ?? "CLIMB_TO_PARENT",
    active: true,
    effectiveFrom: effectiveOn,
    effectiveTo: null,
    visualRankOffset: 0,
    jobProfileKey: null,
    holderSource: "EMPLOYEE" as const,
  };
  snapshot.positions.push(position);
  events.push({
    action: "organization.position.created",
    entityType: "organization_position",
    entityId: position.id,
    payload: { stableKey: position.stableKey, title: position.title, nodeKey: node.stableKey },
  });
  summary.positionKey = position.stableKey;
  summary.positionTitle = position.title;

  if (command.leader.employeeId) {
    const incumbency = {
      id: randomUUID(),
      positionKey: position.stableKey,
      employeeId: command.leader.employeeId,
      accountId: null,
      kind: "PRIMARY" as const,
      isPrimaryStructural: false,
      effectiveFrom: effectiveOn,
      effectiveTo: null,
      reason: null,
    };
    snapshot.incumbencies.push(incumbency);
    events.push({
      action: "organization.incumbency.created",
      entityType: "organization_incumbency",
      entityId: incumbency.id,
      payload: { positionKey: position.stableKey, kind: "PRIMARY" },
    });
    summary.incumbentEmployeeId = command.leader.employeeId;
  }

  addBinding(snapshot, {
    subjectKey: node.stableKey,
    bindingType: "LEADER",
    targetPositionKey: position.stableKey,
    vacancyPolicy: position.vacancyPolicy,
    effectiveFrom: effectiveOn,
  }, events);

  // Spec 4.7: "pemimpin ini juga penyetuju cuti unit" is ticked by default, because forgetting it is
  // exactly the step that silently breaks leave routing today.
  if (command.leader.alsoUnitApprover !== false) {
    addBinding(snapshot, {
      subjectKey: node.stableKey,
      bindingType: "UNIT_APPROVER",
      targetPositionKey: position.stableKey,
      vacancyPolicy: position.vacancyPolicy,
      effectiveFrom: effectiveOn,
    }, events);
    summary.unitApprover = true;
  }
  return summary;
}

function applyPlaceEmployees(
  snapshot: OrganizationSnapshot,
  command: Extract<OrganizationCommand, { type: "PLACE_EMPLOYEES" }>,
  effectiveOn: string,
  events: OrganizationCommandAudit[],
): Record<string, unknown> {
  requireNode(snapshot, command.nodeKey);
  if (command.employeeIds.length === 0) {
    throw new OrganizationCommandError(
      "ORGANIZATION_NO_EMPLOYEES", "Select at least one employee to place.", {}, 400,
    );
  }

  // Checked here, not at validation time, so the operator learns about a clash while they can still
  // answer it (gap P-2). Today it surfaces as PRIMARY_MEMBERSHIP_OVERLAP with no name attached.
  const conflicts = command.employeeIds.flatMap((employeeId) => {
    const existing = snapshot.memberships.find(
      (item) => item.employeeId === employeeId && item.isPrimary && item.nodeKey !== command.nodeKey
        && isEffective(item.effectiveFrom, item.effectiveTo, effectiveOn),
    );
    if (!existing) return [];
    const node = snapshot.nodes.find((item) => item.stableKey === existing.nodeKey);
    return [{ employeeId, nodeKey: existing.nodeKey, nodeName: node?.name ?? null }];
  });
  if (conflicts.length > 0 && command.move !== true) {
    throw new OrganizationCommandError(
      "ORGANIZATION_MEMBERSHIP_CONFLICT",
      "Some employees are already a primary member of another unit; confirm the move.",
      { conflicts },
    );
  }

  const moved: string[] = [];
  const added: string[] = [];
  for (const employeeId of command.employeeIds) {
    const existing = snapshot.memberships.filter(
      (item) => item.employeeId === employeeId && item.isPrimary
        && isEffective(item.effectiveFrom, item.effectiveTo, effectiveOn),
    );
    const alreadyHere = existing.some((item) => item.nodeKey === command.nodeKey);
    if (alreadyHere) continue;

    for (const membership of existing) {
      if (membership.effectiveFrom >= effectiveOn) {
        snapshot.memberships = snapshot.memberships.filter((item) => item.id !== membership.id);
      } else {
        membership.effectiveTo = dayBefore(effectiveOn);
      }
      events.push({
        action: "organization.membership.ended",
        entityType: "organization_membership",
        entityId: membership.id,
        payload: { employeeId, nodeKey: membership.nodeKey, endedOn: dayBefore(effectiveOn) },
      });
      moved.push(employeeId);
    }

    const created = {
      id: randomUUID(),
      nodeKey: command.nodeKey,
      employeeId,
      jobProfileKey: null,
      isPrimary: true,
      effectiveFrom: effectiveOn,
      effectiveTo: null,
    };
    snapshot.memberships.push(created);
    events.push({
      action: "organization.membership.created",
      entityType: "organization_membership",
      entityId: created.id,
      payload: { employeeId, nodeKey: command.nodeKey },
    });
    added.push(employeeId);
  }
  return { nodeKey: command.nodeKey, placed: added.length, moved: moved.length };
}

function applyAppointActing(
  snapshot: OrganizationSnapshot,
  command: Extract<OrganizationCommand, { type: "APPOINT_ACTING" }>,
  events: OrganizationCommandAudit[],
): Record<string, unknown> {
  requirePosition(snapshot, command.positionKey);
  assertIsoDate(command.effectiveFrom);
  assertIsoDate(command.effectiveTo);
  if (command.effectiveTo < command.effectiveFrom) {
    throw new OrganizationCommandError(
      "ORGANIZATION_ACTING_PERIOD_INVALID", "The acting period ends before it starts.", {}, 400,
    );
  }
  // Decision O-5: the reason is the operator's, and it is stored. Today the server writes a fixed
  // "Explicit acting mandate" instead, so nobody can tell afterwards why a Plt was appointed (M-6).
  const reason = command.reason.trim();
  if (reason.length === 0) {
    throw new OrganizationCommandError(
      "ORGANIZATION_ACTING_REASON_REQUIRED", "An acting appointment needs a reason.", {}, 400,
    );
  }

  for (const existing of snapshot.incumbencies.filter(
    (item) => item.positionKey === command.positionKey && item.kind === "ACTING",
  )) {
    snapshot.incumbencies = snapshot.incumbencies.filter((item) => item.id !== existing.id);
    events.push({
      action: "organization.incumbency.ended",
      entityType: "organization_incumbency",
      entityId: existing.id,
      payload: { positionKey: command.positionKey, kind: "ACTING" },
    });
  }

  const created = {
    id: randomUUID(),
    positionKey: command.positionKey,
    employeeId: command.employeeId,
    accountId: null,
    kind: "ACTING" as const,
    isPrimaryStructural: false,
    effectiveFrom: command.effectiveFrom,
    effectiveTo: command.effectiveTo,
    reason: command.mandateNumber ? `${reason} (surat tugas: ${command.mandateNumber.trim()})` : reason,
  };
  snapshot.incumbencies.push(created);
  events.push({
    action: "organization.incumbency.created",
    entityType: "organization_incumbency",
    entityId: created.id,
    payload: {
      positionKey: command.positionKey,
      kind: "ACTING",
      effectiveFrom: created.effectiveFrom,
      effectiveTo: created.effectiveTo,
      hasReason: true,
    },
  });
  return {
    positionKey: command.positionKey,
    employeeId: command.employeeId,
    effectiveFrom: command.effectiveFrom,
    effectiveTo: command.effectiveTo,
  };
}

function applySetReportsTo(
  snapshot: OrganizationSnapshot,
  command: Extract<OrganizationCommand, { type: "SET_REPORTS_TO" }>,
  effectiveOn: string,
  events: OrganizationCommandAudit[],
): Record<string, unknown> {
  const position = requirePosition(snapshot, command.positionKey);
  if (command.parentPositionKey) {
    requirePosition(snapshot, command.parentPositionKey);
    if (command.parentPositionKey === command.positionKey) {
      throw new OrganizationCommandError(
        "ORGANIZATION_POSITION_SELF_PARENT", "A position cannot report to itself.", {}, 400,
      );
    }
  }
  position.parentPositionKey = command.parentPositionKey;
  events.push({
    action: "organization.position.updated",
    entityType: "organization_position",
    entityId: position.id,
    payload: { stableKey: position.stableKey, parentPositionKey: command.parentPositionKey },
  });

  // "Melapor ke" is one answer. A supervisory binding on the same position silently overrules the
  // field today, so two screens can disagree (gap M-2); the command ends the binding instead.
  for (const binding of snapshot.authorityBindings) {
    if (binding.subjectKey !== position.stableKey || binding.bindingType !== "SUPERVISORY_PARENT") continue;
    if (!isEffective(binding.effectiveFrom, binding.effectiveTo, effectiveOn)) continue;
    if (binding.effectiveFrom >= effectiveOn) {
      snapshot.authorityBindings = snapshot.authorityBindings.filter((item) => item.id !== binding.id);
    } else {
      binding.effectiveTo = dayBefore(effectiveOn);
    }
    events.push({
      action: "organization.authority_binding.ended",
      entityType: "organization_authority_binding",
      entityId: binding.id,
      payload: { subjectKey: position.stableKey, bindingType: "SUPERVISORY_PARENT" },
    });
  }
  return { positionKey: position.stableKey, parentPositionKey: command.parentPositionKey };
}

function applySetUnitAuthority(
  snapshot: OrganizationSnapshot,
  command: Extract<OrganizationCommand, { type: "SET_UNIT_LEADER" | "SET_UNIT_APPROVER" }>,
  effectiveOn: string,
  events: OrganizationCommandAudit[],
): Record<string, unknown> {
  requireNode(snapshot, command.nodeKey);
  const position = requirePosition(snapshot, command.positionKey);
  const bindingType = command.type === "SET_UNIT_LEADER" ? "LEADER" : "UNIT_APPROVER";
  endBindings(snapshot, command.nodeKey, bindingType, effectiveOn, events);
  addBinding(snapshot, {
    subjectKey: command.nodeKey,
    bindingType,
    targetPositionKey: command.positionKey,
    vacancyPolicy: position.vacancyPolicy,
    effectiveFrom: effectiveOn,
  }, events);
  return { nodeKey: command.nodeKey, bindingType, positionKey: command.positionKey };
}

function applySetOverride(
  snapshot: OrganizationSnapshot,
  command: Extract<OrganizationCommand, { type: "SET_OVERRIDE" }>,
  effectiveOn: string,
  events: OrganizationCommandAudit[],
): Record<string, unknown> {
  requirePosition(snapshot, command.managerPositionKey);
  const reason = command.reason.trim();
  if (reason.length === 0) {
    throw new OrganizationCommandError(
      "ORGANIZATION_OVERRIDE_REASON_REQUIRED", "A reporting exception needs a reason.", {}, 400,
    );
  }
  const effectiveFrom = command.effectiveFrom ?? effectiveOn;
  assertIsoDate(effectiveFrom);

  for (const existing of snapshot.reportingOverrides.filter(
    (item) => item.employeeId === command.employeeId
      && isEffective(item.effectiveFrom, item.effectiveTo, effectiveFrom),
  )) {
    if (existing.effectiveFrom >= effectiveFrom) {
      snapshot.reportingOverrides = snapshot.reportingOverrides.filter((item) => item.id !== existing.id);
    } else {
      existing.effectiveTo = dayBefore(effectiveFrom);
    }
    events.push({
      action: "organization.reporting_override.ended",
      entityType: "organization_reporting_override",
      entityId: existing.id,
      payload: { employeeId: command.employeeId },
    });
  }

  const created = {
    id: randomUUID(),
    employeeId: command.employeeId,
    managerPositionKey: command.managerPositionKey,
    managerEmployeeId: null,
    reason,
    effectiveFrom,
    effectiveTo: command.effectiveTo ?? null,
  };
  snapshot.reportingOverrides.push(created);
  events.push({
    action: "organization.reporting_override.created",
    entityType: "organization_reporting_override",
    entityId: created.id,
    payload: {
      employeeId: command.employeeId,
      managerPositionKey: command.managerPositionKey,
      effectiveFrom,
      hasReason: true,
    },
  });
  return { employeeId: command.employeeId, managerPositionKey: command.managerPositionKey };
}

/**
 * Apply one command to a draft snapshot.
 *
 * The caller persists the returned snapshot and writes every returned event in the same transaction,
 * so a command either lands whole or not at all (invariant I-10).
 */
export function applyOrganizationCommand(
  snapshot: OrganizationSnapshot,
  command: OrganizationCommand,
  reuseKeys?: OrganizationCommandKeys,
): OrganizationCommandResult {
  const effectiveOn = snapshot.changeSet.effectiveOn;
  const events: OrganizationCommandAudit[] = [];
  let summary: Record<string, unknown>;

  switch (command.type) {
    case "ADD_UNIT":
      summary = applyAddUnit(snapshot, command, effectiveOn, events, reuseKeys);
      break;
    case "PLACE_EMPLOYEES":
      summary = applyPlaceEmployees(snapshot, command, effectiveOn, events);
      break;
    case "APPOINT_ACTING":
      summary = applyAppointActing(snapshot, command, events);
      break;
    case "SET_REPORTS_TO":
      summary = applySetReportsTo(snapshot, command, effectiveOn, events);
      break;
    case "SET_UNIT_LEADER":
    case "SET_UNIT_APPROVER":
      summary = applySetUnitAuthority(snapshot, command, effectiveOn, events);
      break;
    case "SET_OVERRIDE":
      summary = applySetOverride(snapshot, command, effectiveOn, events);
      break;
    default: {
      const unknown = command as { type?: string };
      throw new OrganizationCommandError(
        "ORGANIZATION_UNKNOWN_COMMAND", "Unknown organization command.", { type: unknown.type ?? null }, 400,
      );
    }
  }

  return { snapshot, events, summary };
}
