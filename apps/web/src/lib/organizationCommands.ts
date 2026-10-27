// ORG-008-4d: client for the ORG-008-4 command, correction and replay endpoints.
//
// Each call is one operator action. The server applies it whole or not at all, and answers a refusal
// with the reason — who still occupies a seat, which employees are already in another unit — so the
// screen can say it rather than showing a code.

import { AdminApiError } from "@/lib/adminEmployees";

export type OrganizationCommandType =
  | "ADD_UNIT"
  | "PLACE_EMPLOYEES"
  | "APPOINT_ACTING"
  | "SET_REPORTS_TO"
  | "SET_UNIT_LEADER"
  | "SET_UNIT_APPROVER"
  | "SET_OVERRIDE"
  | "SET_PRIMARY_STRUCTURAL_POSITION";

export type OrganizationCommand =
  | {
      type: "ADD_UNIT";
      name: string;
      nodeType: string;
      parentNodeKey: string | null;
      leader?: {
        title: string;
        employeeId?: string | null;
        vacancyPolicy?: "CLIMB_TO_PARENT" | "REQUIRE_ACTING_OR_BLOCK" | "BLOCK";
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
    }
  // ORG-008-11: for someone holding two seats, which one their own approvals start from.
  | { type: "SET_PRIMARY_STRUCTURAL_POSITION"; employeeId: string; positionKey: string };

export interface OrganizationCommandResult {
  commandType: OrganizationCommandType;
  seq: number;
  primitives: number;
  summary: Record<string, unknown>;
}

export interface OrganizationJournalEntry {
  id: string;
  seq: number;
  commandType: OrganizationCommandType;
  summary: Record<string, unknown>;
  actorAccountId: string;
  createdAt: string;
}

export interface OrganizationReplayReport {
  applied: boolean;
  baseChangeSetId: string | null;
  kept: Array<{ seq: number; commandType: OrganizationCommandType; summary: Record<string, unknown> }>;
  skipped: Array<{ seq: number; commandType: OrganizationCommandType; code: string; message: string }>;
  /**
   * Lines a rebuild cannot reproduce (a manual edit, or the legacy seed). While any is listed the
   * API refuses to apply, so the screen says which ones and does not offer to continue.
   */
  blocked?: Array<{ seq: number; commandType: string; summary: Record<string, unknown> }>;
}

export interface OrganizationItemUse {
  kind: string;
  id: string;
  name: string | null;
}

/** A refusal that carries what the operator has to resolve first. */
export interface OrganizationConflictDetails {
  conflicts?: Array<{ employeeId: string; nodeKey: string; nodeName: string | null }>;
  uses?: OrganizationItemUse[];
  itemKind?: string;
  deactivateInstead?: boolean;
  endInstead?: boolean;
}

export class OrganizationCommandRefused extends AdminApiError {
  constructor(status: number, code: string, message: string, public readonly details: OrganizationConflictDetails) {
    super(status, code, message);
    this.name = "OrganizationCommandRefused";
  }
}

async function readJson<T>(response: Response): Promise<T> {
  if (response.ok) {
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
  const body = (await response.json().catch(() => null)) as
    | { code?: string; message?: string; details?: OrganizationConflictDetails }
    | null;
  const code = body?.code ?? "REQUEST_FAILED";
  const message = body?.message ?? "Permintaan Struktur Organisasi tidak dapat diproses.";
  if (body?.details) throw new OrganizationCommandRefused(response.status, code, message, body.details);
  throw new AdminApiError(response.status, code, message);
}

function designerUrl(path: string) {
  return `/api/admin/organization/designer${path}`;
}

async function send<T>(path: string, init: RequestInit, revision?: number): Promise<T> {
  const response = await fetch(designerUrl(path), {
    ...init,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      // ORG-008-3b: carry the revision last read, so a concurrent edit is refused instead of
      // overwriting the other person's work.
      ...(revision === undefined ? {} : { "If-Match": String(revision) }),
      ...init.headers,
    },
  });
  return readJson<T>(response);
}

export function applyOrganizationCommand(
  draftId: string,
  command: OrganizationCommand,
  revision?: number,
): Promise<OrganizationCommandResult> {
  return send<OrganizationCommandResult>(
    `/drafts/${draftId}/commands`,
    { method: "POST", body: JSON.stringify(command) },
    revision,
  );
}

export interface OrganizationJournalPage {
  /** Newest step first (ENG-LIST-001). */
  items: OrganizationJournalEntry[];
  pagination: { page: number; pageSize: number; total: number; pageCount: number };
}

export const ORGANIZATION_JOURNAL_PAGE_SIZE = 50;

export function listOrganizationJournal(draftId: string, page = 1): Promise<OrganizationJournalPage> {
  return send<OrganizationJournalPage>(
    `/drafts/${draftId}/journal?page=${page}&pageSize=${ORGANIZATION_JOURNAL_PAGE_SIZE}`,
    {},
  );
}

export function rebaseOrganizationDraft(
  draftId: string,
  input: { apply: boolean },
  revision?: number,
): Promise<OrganizationReplayReport> {
  return send<OrganizationReplayReport>(
    `/drafts/${draftId}/rebase`,
    { method: "POST", body: JSON.stringify(input) },
    revision,
  );
}

export function undoOrganizationJournalEntry(
  draftId: string,
  seq: number,
  input: { apply: boolean },
  revision?: number,
): Promise<OrganizationReplayReport> {
  return send<OrganizationReplayReport>(
    `/drafts/${draftId}/journal/${seq}/undo`,
    { method: "POST", body: JSON.stringify(input) },
    revision,
  );
}

export function deleteOrganizationNode(draftId: string, itemId: string, revision?: number): Promise<void> {
  return send<void>(`/drafts/${draftId}/nodes/${itemId}`, { method: "DELETE" }, revision);
}

export function deleteOrganizationPosition(draftId: string, itemId: string, revision?: number): Promise<void> {
  return send<void>(`/drafts/${draftId}/positions/${itemId}`, { method: "DELETE" }, revision);
}

export function deleteOrganizationBinding(draftId: string, itemId: string, revision?: number): Promise<void> {
  return send<void>(`/drafts/${draftId}/authority-bindings/${itemId}`, { method: "DELETE" }, revision);
}

export function endOrganizationBinding(
  draftId: string,
  itemId: string,
  effectiveTo: string,
  revision?: number,
): Promise<unknown> {
  return send<unknown>(
    `/drafts/${draftId}/authority-bindings/${itemId}`,
    { method: "PATCH", body: JSON.stringify({ effectiveTo }) },
    revision,
  );
}

export interface OrganizationSeedSummary {
  units: number;
  placements: number;
  unitApprovers: number;
  unitLeaders: number;
  reportingExceptions: number;
  employeesWithoutUnit: number;
  employeesWithoutManager: number;
}

export interface OrganizationSeedResult {
  id: string;
  name: string;
  effectiveOn: string;
  proposal: boolean;
  summary: OrganizationSeedSummary;
}

/**
 * ORG-008-7 (decision O-3): build a first change set from the units, placements, unit approvers and
 * managers HCIS already records. The result is a proposal to review; nothing is published.
 */
export function seedOrganizationDraftFromLegacy(input: {
  name: string;
  effectiveOn: string;
}): Promise<OrganizationSeedResult> {
  return send<OrganizationSeedResult>("/drafts/from-legacy", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
