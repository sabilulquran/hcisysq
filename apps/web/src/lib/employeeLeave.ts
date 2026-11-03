import type { CriticalPeriodMatch } from "@/lib/leaveCriticalPeriods";

export type AnnualLeavePeriodKey = "JAN_MAR" | "APR_JUN" | "JUL_SEP" | "OCT_DEC";

export interface AnnualLeavePeriodView {
  key: AnnualLeavePeriodKey;
  label: string;
  allocationDays: number;
  usedDays: number;
  remainingDays: number;
  usableFrom: string | null;
  status: "not_eligible" | "upcoming" | "current" | "closed";
}

export interface EmployeeLeaveSummary {
  referenceDate: string;
  employee: {
    id: string;
    employeeNumber: string;
    fullName: string;
    unitName: string | null;
    positionName: string | null;
    leaveEntitlementGroup: "education" | "non_education" | null;
    startedOn: string | null;
  };
  annualPolicy: {
    key: "annual";
    name: string;
    annualEntitlementDays?: number;
    periodLimitDays?: number;
    minimumNoticeDays: number | null;
  };
  annualLeave: {
    annualEntitlementDays: number;
    eligibleFrom: string;
    eligible: boolean;
    availableNowDays: number;
    currentPeriodKey: AnnualLeavePeriodKey;
    currentPeriodLimitDays: number;
    periods: AnnualLeavePeriodView[];
  } | null;
  pendingApprovalCount: number;
  requests: LeaveRequestSummary[];
}

export interface LeaveRequestSummary {
  id: string;
  policyKey: string;
  status: "in_review" | "approved" | "rejected" | "cancelled";
  startOn: string;
  endOn: string;
  workingDays: number;
  reason: string | null;
  annualPeriodKey: AnnualLeavePeriodKey | null;
  submittedAt: string;
  finalDecidedAt: string | null;
  currentApproverName: string | null;
  /** LEAVE-009: null when the request touched no critical period. */
  criticalReviewStatus?: "waiting" | "pending" | "approved" | "rejected" | null;
}

export interface AnnualLeavePreview {
  annualEntitlementDays: number;
  periodKey: AnnualLeavePeriodKey;
  periodLimitDays: number;
  availableDaysBeforeRequest: number;
  requestedWorkingDays: number;
  availableDaysAfterRequest: number;
  minimumNoticeDays: number;
  noticeDays: number;
  workingDates: string[];
  nonWorkingDates: string[];
  approvalChain: Array<{
    employeeId: string;
    name: string;
    sources: Array<"DIRECT_MANAGER" | "UNIT_APPROVER">;
  }>;
  criticalPeriods: CriticalPeriodMatch[];
  criticalReviewRequired: boolean;
}

export interface LeaveApprovalInboxItem {
  stepId: string;
  requestId: string;
  requesterEmployeeId: string;
  requesterName: string;
  policyKey: string;
  startOn: string;
  endOn: string;
  workingDays: number;
  reason: string | null;
  submittedAt: string;
  sources: string[];
}

export class EmployeeLeaveApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EmployeeLeaveApiError";
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as
    | T
    | { code?: string; message?: string }
    | null;
  if (response.ok) return body as T;
  const error = body as { code?: string; message?: string } | null;
  throw new EmployeeLeaveApiError(
    response.status,
    error?.code ?? "REQUEST_FAILED",
    error?.message ?? "Permintaan tidak dapat diproses.",
  );
}

export async function getEmployeeLeaveSummary(): Promise<EmployeeLeaveSummary> {
  const summary = await readJson<EmployeeLeaveSummary>(
    await fetch("/api/leave/me/summary", {
      credentials: "include",
      headers: { Accept: "application/json" },
    }),
  );
  return {
    ...summary,
    requests: summary.requests.filter((request) => request.policyKey === "annual"),
  };
}

export async function previewAnnualLeave(input: {
  startOn: string;
  endOn: string;
  reason?: string | null;
}): Promise<AnnualLeavePreview> {
  return readJson(
    await fetch("/api/leave/me/annual/preview", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function submitAnnualLeave(input: {
  startOn: string;
  endOn: string;
  reason?: string | null;
  idempotencyKey: string;
}): Promise<{
  id: string;
  status: "in_review";
  workingDays: number;
  periodKey: AnnualLeavePeriodKey;
  annualEntitlementDays: number;
}> {
  return readJson(
    await fetch("/api/leave/me/annual/submit", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function getLeaveApprovalInbox(): Promise<{ items: LeaveApprovalInboxItem[] }> {
  return readJson(
    await fetch("/api/leave/approvals", {
      credentials: "include",
      headers: { Accept: "application/json" },
    }),
  );
}

export async function decideLeaveApproval(
  stepId: string,
  input: { decision: "approve" | "reject"; note?: string | null },
): Promise<{
  requestId: string;
  requestStatus: string;
  stepStatus: string;
  nextPendingStepId: string | null;
}> {
  return readJson(
    await fetch(`/api/leave/approvals/${stepId}/decision`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    }),
  );
}
