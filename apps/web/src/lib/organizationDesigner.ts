import { AdminApiError } from "@/lib/adminEmployees";

export type OrganizationViewMode = "HISTORICAL" | "CURRENT" | "FUTURE" | "DRAFT";
export type OrganizationDraftStatus = "DRAFT" | "VALIDATED" | "PUBLISHED";
export type OrganizationVacancyPolicy =
  | "CLIMB_TO_PARENT"
  | "REQUIRE_ACTING_OR_BLOCK"
  | "BLOCK";

export interface OrganizationDraft {
  id: string;
  name: string;
  effectiveOn: string;
  status: OrganizationDraftStatus;
  validationReport: OrganizationValidationReport | null;
  createdAt: string;
  validatedAt: string | null;
  publishedAt: string | null;
}

export interface OrganizationIncumbent {
  assignmentId?: string;
  positionKey?: string;
  employeeId: string;
  employeeNumber?: string;
  employeeName: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  assignmentType?: "PRIMARY" | "ACTING";
  /** ORG-004 migrations 0020-0023: a Dewan account holder, or a holder of several structural seats.
   *  The API already sends these; ORG-008-1 uses them to mark a seat read-only before it is edited. */
  accountId?: string | null;
  accountEmail?: string | null;
  accountStatus?: string | null;
  isPrimaryStructural?: boolean;
}

export interface OrganizationNode {
  id: string;
  stableKey: string;
  name: string;
  nodeType: string;
  parentNodeKey: string | null;
  active: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  visualRankOffset: number;
  integrationCode: string | null;
  memberCount: number;
  leaderPositionKey: string | null;
}

export interface OrganizationPosition {
  id: string;
  stableKey: string;
  nodeKey: string;
  title: string;
  parentPositionKey: string | null;
  singleIncumbent: boolean;
  vacancyPolicy: OrganizationVacancyPolicy;
  active: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  visualRankOffset: number;
  holderSource?: "EMPLOYEE" | "ACCOUNT";
  primaryIncumbent: OrganizationIncumbent | null;
  actingIncumbent: OrganizationIncumbent | null;
}

export interface OrganizationMembership {
  id?: string;
  nodeKey: string;
  employeeId: string;
  employeeName?: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  isPrimary?: boolean;
}

export interface OrganizationAuthorityBinding {
  id: string;
  sourceType: "NODE" | "POSITION";
  sourceKey: string;
  authorityType:
    | "SUPERVISORY_PARENT"
    | "LEADER"
    | "UNIT_APPROVER"
    | "GOVERNANCE_APPROVER"
    | "OVERSIGHT_PARENT";
  targetPositionKey: string;
  vacancyPolicy: OrganizationVacancyPolicy;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface OrganizationReportingOverride {
  id: string;
  employeeId: string;
  managerPositionKey: string;
  reason: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface OrganizationDesignerView {
  viewDate: string;
  mode: OrganizationViewMode;
  draft: OrganizationDraft | null;
  nodes: OrganizationNode[];
  positions: OrganizationPosition[];
  memberships: OrganizationMembership[];
  assignments: OrganizationIncumbent[];
  bindings: OrganizationAuthorityBinding[];
  reportingOverrides: OrganizationReportingOverride[];
}

export interface OrganizationEmployeeOption {
  id: string;
  employeeNumber: string;
  fullName: string;
  unitName: string | null;
  positionName: string | null;
  status?: "active" | "inactive" | "resigned";
}

export interface OrganizationValidationIssue {
  code: string;
  message: string;
  severity: "ERROR" | "WARNING";
  itemKey?: string | null;
}

export interface OrganizationValidationReport {
  valid: boolean;
  issues: OrganizationValidationIssue[];
}

export interface OrganizationImpactPreview {
  directManagerChanges: Array<Record<string, unknown>>;
  unitApproverChanges: Array<Record<string, unknown>>;
  authorityPathsAffected: Array<Record<string, unknown>>;
  vacantAuthorities: Array<Record<string, unknown>>;
  unresolvedEmployees: Array<Record<string, unknown>>;
  visualOnlyChanges: Array<Record<string, unknown>>;
  noApprovalRoutingImpact: boolean;
}

export interface OrganizationResolutionPreview {
  employee: {
    id: string;
    employeeNumber?: string;
    fullName: string;
  };
  effectiveDate: string;
  workflowKey: string;
  mode?: string;
  steps: Array<{
    authorityType?: string;
    employeeId: string;
    employeeName: string;
    positionTitle?: string | null;
    source?: string;
  }>;
  oversight?: {
    employeeId: string;
    employeeName: string;
    positionTitle?: string | null;
  } | null;
  warnings: Array<{ code: string; message: string }>;
}

export interface OrganizationRolloutSetting {
  workflowKey: string;
  organizationalNodeKey: string | null;
  mode: "LEGACY" | "SHADOW" | "STRUCTURE";
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface OrganizationRolloutConfiguration {
  mode: "LEGACY" | "SHADOW" | "STRUCTURE";
  /** ORG-008-2: how many rollout rows exist at all, and the rows effective today. */
  configuredRowCount?: number;
  asOf?: string;
  settings?: OrganizationRolloutSetting[];
  workflowKey?: string | null;
  organizationalNodeKey?: string | null;
  effectiveFrom?: string;
  effectiveTo?: string | null;
  reason?: string;
  updatedAt?: string;
}

async function readJson<T>(response: Response): Promise<T> {
  if (response.ok) {
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  const body = (await response.json().catch(() => null)) as
    | { code?: string; message?: string }
    | null;
  throw new AdminApiError(
    response.status,
    body?.code ?? "REQUEST_FAILED",
    body?.message ?? "Permintaan Organization Designer tidak dapat diproses.",
  );
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/admin/organization/designer${path}`, {
    ...init,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  return readJson<T>(response);
}

export function getOrganizationDesignerView(input: {
  effectiveDate: string;
  draftId?: string | null;
}): Promise<OrganizationDesignerView> {
  const params = new URLSearchParams({ effectiveDate: input.effectiveDate });
  if (input.draftId) params.set("draftId", input.draftId);
  return request<OrganizationDesignerView>(`?${params.toString()}`);
}

export async function listOrganizationEmployees(): Promise<OrganizationEmployeeOption[]> {
  const result = await request<
    OrganizationEmployeeOption[] | { items: OrganizationEmployeeOption[] }
  >("/employees");
  return Array.isArray(result) ? result : result.items;
}

export function createOrganizationDraft(input: {
  name: string;
  effectiveOn: string;
}): Promise<OrganizationDraft> {
  return request<OrganizationDraft>("/drafts", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getOrganizationDraft(draftId: string): Promise<OrganizationDraft> {
  return request<OrganizationDraft>(`/drafts/${draftId}`);
}

export function createOrganizationNode(
  draftId: string,
  input: {
    name: string;
    nodeType: string;
    parentNodeKey: string | null;
    visualRankOffset?: number;
    integrationCode?: string | null;
  },
): Promise<OrganizationNode> {
  return request<OrganizationNode>(`/drafts/${draftId}/nodes`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateOrganizationNode(
  draftId: string,
  nodeId: string,
  input: Partial<
    Pick<
      OrganizationNode,
      | "name"
      | "nodeType"
      | "parentNodeKey"
      | "active"
      | "visualRankOffset"
      | "integrationCode"
      | "leaderPositionKey"
    >
  >,
): Promise<OrganizationNode> {
  return request<OrganizationNode>(`/drafts/${draftId}/nodes/${nodeId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function createOrganizationPosition(
  draftId: string,
  input: {
    nodeKey: string;
    title: string;
    parentPositionKey: string | null;
    vacancyPolicy: OrganizationVacancyPolicy;
    singleIncumbent?: boolean;
    visualRankOffset?: number;
  },
): Promise<OrganizationPosition> {
  return request<OrganizationPosition>(`/drafts/${draftId}/positions`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateOrganizationPosition(
  draftId: string,
  positionId: string,
  input: Partial<
    Pick<
      OrganizationPosition,
      | "nodeKey"
      | "title"
      | "parentPositionKey"
      | "vacancyPolicy"
      | "singleIncumbent"
      | "active"
      | "visualRankOffset"
    >
  >,
): Promise<OrganizationPosition> {
  return request<OrganizationPosition>(`/drafts/${draftId}/positions/${positionId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function replaceOrganizationMemberships(
  draftId: string,
  input: {
    nodeKey: string;
    employeeIds: string[];
    effectiveFrom: string;
    effectiveTo?: string | null;
  },
): Promise<void> {
  return request<void>(`/drafts/${draftId}/memberships`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function replaceOrganizationIncumbencies(
  draftId: string,
  input: {
    positionKey: string;
    primaryEmployeeId?: string | null;
    actingEmployeeId?: string | null;
    actingFrom?: string | null;
    actingTo?: string | null;
    effectiveFrom: string;
  },
): Promise<void> {
  return request<void>(`/drafts/${draftId}/incumbencies`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function createOrganizationAuthorityBinding(
  draftId: string,
  input: Omit<OrganizationAuthorityBinding, "id">,
): Promise<OrganizationAuthorityBinding> {
  return request<OrganizationAuthorityBinding>(`/drafts/${draftId}/authority-bindings`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function createOrganizationReportingOverride(
  draftId: string,
  input: Omit<OrganizationReportingOverride, "id">,
): Promise<OrganizationReportingOverride> {
  return request<OrganizationReportingOverride>(`/drafts/${draftId}/reporting-overrides`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function validateOrganizationDraft(
  draftId: string,
): Promise<OrganizationValidationReport> {
  return request<OrganizationValidationReport>(`/drafts/${draftId}/validate`, {
    method: "POST",
  });
}

export function getOrganizationImpact(
  draftId: string,
): Promise<OrganizationImpactPreview> {
  return request<OrganizationImpactPreview>(`/drafts/${draftId}/impact`);
}

export function previewOrganizationResolution(
  draftId: string,
  input: { employeeId: string; workflowKey: string; effectiveDate: string },
): Promise<OrganizationResolutionPreview> {
  return request<OrganizationResolutionPreview>(
    `/drafts/${draftId}/resolution-preview`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function publishOrganizationDraft(draftId: string): Promise<OrganizationDraft> {
  return request<OrganizationDraft>(`/drafts/${draftId}/publish`, { method: "POST" });
}

export async function getOrganizationRollout(): Promise<OrganizationRolloutConfiguration> {
  const response = await fetch("/api/admin/organization/rollout", {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  return readJson<OrganizationRolloutConfiguration>(response);
}

export async function updateOrganizationRollout(
  input: OrganizationRolloutConfiguration,
): Promise<OrganizationRolloutConfiguration> {
  const response = await fetch("/api/admin/organization/rollout", {
    method: "PATCH",
    credentials: "include",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return readJson<OrganizationRolloutConfiguration>(response);
}
