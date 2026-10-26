// ORG-008-2b: client for the ORG-008-2a read endpoints.
//
// These live at /api/admin/organization/* rather than under .../designer, and they only read:
// nothing here creates, changes, publishes, or switches rollout.

import { AdminApiError } from "@/lib/adminEmployees";

export type OrganizationAuthoritySource =
  | "OVERRIDE"
  | "ACTING"
  | "VACANCY_CLIMB"
  | "POSITION_PARENT"
  | "MEMBERSHIP_LEADER"
  | "INHERITED_LEADER";

export type OrganizationComparison = "SAME" | "DIFFERENT" | "UNRESOLVED" | "NO_LEGACY";

export interface OrganizationResolvedPerson {
  employeeId: string;
  employeeName: string;
  positionKey: string | null;
  positionTitle: string | null;
  incumbentKind: string;
}

export interface OrganizationPerson {
  employeeId: string;
  employeeNumber: string;
  fullName: string;
  unit: { nodeKey: string; name: string; path: string[] } | null;
  /** ORG-005-1 (DRAFT): the unit's work location, or the nearest ancestor's; null when none names one. */
  workLocation?: { id: string; name: string; inheritedFromNodeKey: string | null } | null;
  position: { stableKey: string; title: string } | null;
  directManager: OrganizationResolvedPerson | null;
  source: OrganizationAuthoritySource | null;
  sourceDetails: OrganizationAuthoritySource[];
  unitApprover: OrganizationResolvedPerson | null;
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

export interface OrganizationPeoplePage {
  asOf: string;
  changeSetId: string | null;
  page: number;
  pageSize: number;
  total: number;
  items: OrganizationPerson[];
}

export interface OrganizationReadiness {
  asOf: string;
  changeSetId: string | null;
  activeEmployees: number;
  withoutUnit: number;
  /** ORG-005-1: placed, but no unit up the branch names a work location. Informational only. */
  withoutWorkLocation?: number;
  unresolvedManager: number;
  ineligibleManagers: number;
  vacantRequiringActing: number;
  actingEndingSoon: Array<{
    positionKey: string;
    positionTitle: string;
    employeeId: string | null;
    endsOn: string;
  }>;
  comparison: { same: number; different: number; unresolved: number; noLegacy: number } | null;
}

export interface OrganizationExplanationStep {
  code: string;
  params: Record<string, string | null>;
}

export interface OrganizationExplanation {
  asOf: string;
  employeeId: string;
  person: OrganizationPerson;
  steps: OrganizationExplanationStep[];
}

export type OrganizationPreviewWorkflow = "LEAVE_ANNUAL" | "LEAVE_UNPAID" | "OVERTIME";

export interface OrganizationApprovalPreview {
  employee: { id: string; employeeNumber?: string; fullName: string };
  effectiveDate: string;
  workflow: OrganizationPreviewWorkflow;
  workflowKey: string;
  changeSetId: string;
  preview: boolean;
  governanceApplied: boolean;
  steps: Array<{
    employeeId: string;
    employeeName: string;
    positionTitle: string | null;
    authorityType: string;
    source: string;
  }>;
  oversight: {
    employeeId: string;
    employeeName: string;
    positionTitle: string | null;
    appliesInMode: "STRUCTURE";
  } | null;
  warnings: Array<{ code: string }>;
}

export interface OrganizationCapabilities {
  viewStructure: boolean;
  composeChange: boolean;
  discardChange: boolean;
  assignIncumbents: boolean;
  manageAuthority: boolean;
  publish: boolean;
  manageRollout: boolean;
}

async function readJson<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T;
  const body = (await response.json().catch(() => null)) as { code?: string; message?: string } | null;
  throw new AdminApiError(
    response.status,
    body?.code ?? "REQUEST_FAILED",
    body?.message ?? "Permintaan Struktur Organisasi tidak dapat diproses.",
  );
}

async function read<T>(path: string, params: Record<string, string | undefined>): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") query.set(key, value);
  }
  const suffix = query.toString();
  const response = await fetch(`/api/admin/organization/${path}${suffix ? `?${suffix}` : ""}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  return readJson<T>(response);
}

export function getOrganizationPeople(input: {
  asOf?: string;
  draftId?: string | null;
  nodeKey?: string;
  issue?: string;
  q?: string;
  page?: number;
  pageSize?: number;
  withLegacy?: boolean;
}): Promise<OrganizationPeoplePage> {
  return read<OrganizationPeoplePage>("people", {
    asOf: input.asOf,
    draftId: input.draftId ?? undefined,
    nodeKey: input.nodeKey,
    issue: input.issue,
    q: input.q,
    page: input.page === undefined ? undefined : String(input.page),
    pageSize: input.pageSize === undefined ? undefined : String(input.pageSize),
    withLegacy: input.withLegacy ? "true" : undefined,
  });
}

export function getOrganizationReadiness(input: {
  asOf?: string;
  draftId?: string | null;
}): Promise<OrganizationReadiness> {
  return read<OrganizationReadiness>("readiness", {
    asOf: input.asOf,
    draftId: input.draftId ?? undefined,
  });
}

export function getOrganizationExplanation(input: {
  employeeId: string;
  asOf?: string;
  draftId?: string | null;
}): Promise<OrganizationExplanation> {
  return read<OrganizationExplanation>("explanation", {
    employeeId: input.employeeId,
    asOf: input.asOf,
    draftId: input.draftId ?? undefined,
  });
}

export function getOrganizationCapabilities(): Promise<OrganizationCapabilities> {
  return read<OrganizationCapabilities>("capabilities", {});
}

export async function previewOrganizationApproval(input: {
  employeeId: string;
  workflow: OrganizationPreviewWorkflow;
  date?: string;
  draftId?: string | null;
}): Promise<OrganizationApprovalPreview> {
  const response = await fetch("/api/admin/organization/resolution-preview", {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      employeeId: input.employeeId,
      workflow: input.workflow,
      ...(input.date ? { date: input.date } : {}),
      ...(input.draftId ? { draftId: input.draftId } : {}),
    }),
  });
  return readJson<OrganizationApprovalPreview>(response);
}

export interface OrganizationUnitHcStaff {
  asOf: string;
  nodeKey: string;
  /** The linked imported units, this unit first and then upwards. */
  linkedUnitIds: string[];
  /** True when nothing up the branch is linked, so ATT-011 keeps its wider recipients. */
  fallback: boolean;
  items: Array<{
    employeeId: string;
    fullName: string;
    roleKey: string;
    unitId: string;
    unitName: string;
  }>;
}

export function getOrganizationUnitHcStaff(input: {
  nodeKey: string;
  asOf?: string;
  draftId?: string | null;
}): Promise<OrganizationUnitHcStaff> {
  return read<OrganizationUnitHcStaff>(`units/${input.nodeKey}/hc-staff`, {
    asOf: input.asOf,
    draftId: input.draftId ?? undefined,
  });
}

export interface OrganizationPositionSearchResult {
  asOf: string;
  items: Array<{ stableKey: string; title: string; nodeKey: string; unitPath: string[] }>;
}

export function searchOrganizationPositions(input: {
  q?: string;
  asOf?: string;
  draftId?: string | null;
}): Promise<OrganizationPositionSearchResult> {
  return read<OrganizationPositionSearchResult>("positions/search", {
    q: input.q,
    asOf: input.asOf,
    draftId: input.draftId ?? undefined,
  });
}
