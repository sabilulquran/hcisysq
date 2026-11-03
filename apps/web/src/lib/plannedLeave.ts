import type { CriticalPeriodMatch } from "@/lib/leaveCriticalPeriods";

export type SupportedPlannedLeaveKey =
  | "employee_marriage"
  | "child_marriage"
  | "child_circumcision"
  | "hajj"
  | "unpaid";

export interface PlannedLeaveEvidenceInput {
  fileName: string;
  contentType: "application/pdf" | "image/jpeg" | "image/png";
  contentBase64: string;
}

export interface PlannedLeavePolicy {
  key: SupportedPlannedLeaveKey;
  name: string;
  minimumNoticeDays: number | null;
  evidenceRequirement: "none" | "required";
  hcHandling: "validate" | "approve";
  notes: string[];
}

export interface PlannedLeaveSummary {
  employee: {
    id: string;
    employeeNumber: string;
    fullName: string;
    unitName: string | null;
    positionName: string | null;
  };
  policies: PlannedLeavePolicy[];
  requests: Array<{
    id: string;
    policyKey: SupportedPlannedLeaveKey;
    policyName: string;
    status: "in_review" | "approved" | "rejected" | "cancelled";
    startOn: string;
    endOn: string;
    workingDays: number;
    reason: string | null;
    validationSummary: {
      calendarDurationDays?: number;
      unpaid?: boolean;
    };
    submittedAt: string;
    finalDecidedAt: string | null;
    currentApproverName: string | null;
    hcTaskKind: "validate" | "approve" | null;
    hcTaskStatus: string | null;
    nextAction: string;
  }>;
}

export interface PlannedLeavePreview {
  policy: PlannedLeavePolicy;
  workingDays: number;
  calendarDurationDays: number;
  workingDates: string[];
  nonWorkingDates: string[];
  minimumNoticeDays: number;
  noticeDays: number;
  unpaid: boolean;
  approvalChain: Array<{
    employeeId: string;
    name: string;
    sources: Array<"DIRECT_MANAGER" | "UNIT_APPROVER">;
  }>;
  criticalPeriods: CriticalPeriodMatch[];
  criticalReviewRequired: boolean;
  nextAction: string;
}

export class PlannedLeaveApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PlannedLeaveApiError";
  }
}

async function readJson<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T;
  const body = (await response.json().catch(() => null)) as
    | { code?: string; message?: string }
    | null;
  throw new PlannedLeaveApiError(
    response.status,
    body?.code ?? "REQUEST_FAILED",
    body?.message ?? "Permintaan tidak dapat diproses.",
  );
}

export async function getPlannedLeaveSummary(): Promise<PlannedLeaveSummary> {
  const response = await fetch("/api/leave/planned/me/summary", {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  return readJson(response);
}

export async function previewPlannedLeave(input: {
  policyKey: SupportedPlannedLeaveKey;
  startOn: string;
  endOn: string;
  hasEvidence: boolean;
}): Promise<PlannedLeavePreview> {
  const response = await fetch("/api/leave/planned/me/preview", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input),
  });
  return readJson(response);
}

export async function submitPlannedLeave(input: {
  policyKey: SupportedPlannedLeaveKey;
  startOn: string;
  endOn: string;
  reason: string | null;
  idempotencyKey: string;
  evidence: PlannedLeaveEvidenceInput | null;
}): Promise<{
  id: string;
  status: string;
  policyKey: SupportedPlannedLeaveKey;
  policyName: string;
  workingDays: number;
  calendarDurationDays: number;
  unpaid: boolean;
  nextAction: string;
}> {
  const response = await fetch("/api/leave/planned/me/submit", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input),
  });
  return readJson(response);
}

export async function uploadPlannedLeaveEvidence(
  requestId: string,
  evidence: PlannedLeaveEvidenceInput,
): Promise<{ id: string; fileName: string; contentType: string; byteSize: number }> {
  const response = await fetch(`/api/leave/planned/me/requests/${requestId}/evidence`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(evidence),
  });
  return readJson(response);
}

export interface PlannedHcQueue {
  items: Array<{
    taskId: string;
    requestId: string;
    requesterEmployeeId: string;
    requesterName: string;
    employeeNumber: string;
    unitName: string | null;
    positionName: string | null;
    policyKey: SupportedPlannedLeaveKey;
    policyName: string;
    startOn: string;
    endOn: string;
    workingDays: number;
    reason: string | null;
    validationSummary: {
      calendarDurationDays?: number;
      unpaid?: boolean;
      /** LEAVE-009 D-02: recorded for Cuti Tanpa Gaji, which HC already decides. */
      criticalPeriods?: CriticalPeriodMatch[];
    };
    evidenceRequirement: "none" | "required";
    submittedAt: string;
    taskStatus: string;
    taskNote: string | null;
    evidence: Array<{
      id: string;
      fileName: string;
      contentType: string;
      byteSize: number;
      createdAt: string;
    }>;
  }>;
}

export async function getPlannedHcValidationQueue(): Promise<PlannedHcQueue> {
  const response = await fetch("/api/leave/planned/hc/validation-queue", {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  return readJson(response);
}

export async function decidePlannedHcValidation(
  taskId: string,
  input: { action: "validate" | "request_correction"; note: string | null },
) {
  const response = await fetch(`/api/leave/planned/hc/tasks/${taskId}/validation-decision`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input),
  });
  return readJson<{ requestId: string; requestStatus: string; taskStatus: string }>(response);
}

export async function getPlannedHcApprovalQueue(): Promise<PlannedHcQueue> {
  const response = await fetch("/api/leave/planned/hc/approval-queue", {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  return readJson(response);
}

export async function decidePlannedHcApproval(
  taskId: string,
  input: { decision: "approve" | "reject"; note: string | null },
) {
  const response = await fetch(`/api/leave/planned/hc/tasks/${taskId}/approval-decision`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input),
  });
  return readJson<{ requestId: string; requestStatus: string; taskStatus: string }>(response);
}

export function plannedHcEvidenceHref(requestId: string, evidenceId: string) {
  return `/api/leave/planned/hc/requests/${requestId}/evidence/${evidenceId}`;
}
