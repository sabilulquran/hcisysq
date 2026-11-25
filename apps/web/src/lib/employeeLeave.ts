import type { CriticalPeriodMatch } from "@/lib/leaveCriticalPeriods";

/** LEAVE-003 R2: which quota rule read a set of dates — 3 days a quarter, or 6 days a semester. */
export type AnnualLeaveQuotaScheme = "QUARTER" | "SEMESTER";

export type AnnualLeavePeriodKey =
  | "JAN_MAR"
  | "APR_JUN"
  | "JUL_SEP"
  | "OCT_DEC"
  | "JAN_JUN"
  | "JUL_DEC";

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
    minimumNoticeDays: number | null;
    /**
     * LEAVE-003 R2: no `periodLimitDays` here. The limit depends on the leave date, so it comes
     * from `annualLeave` (`currentPeriodLimitDays`, and `allocationDays` per period).
     */
  };
  annualLeave: {
    annualEntitlementDays: number;
    eligibleFrom: string;
    eligible: boolean;
    availableNowDays: number;
    quotaScheme: AnnualLeaveQuotaScheme;
    /** The day the semester rule starts applying, by leave date; null while it never does. */
    semesterEffectiveFrom: string | null;
    currentPeriodKey: AnnualLeavePeriodKey;
    currentPeriodLimitDays: number;
    periods: AnnualLeavePeriodView[];
  } | null;
  pendingApprovalCount: number;
  requests: LeaveRequestSummary[];
}

/** An ISO date as a reader expects it; the raw value if it is not one. */
export function formatQuotaDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf())) return value;
  return parsed.toLocaleDateString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * LEAVE-003 R2: what the employee is told about the quota period and the boundary one request may
 * not cross.
 *
 * `quotaScheme` and `periodLimitDays` must describe the dates being talked about — today's rule in
 * the entitlement box, the preview's rule once dates are chosen. Enforcement follows the **leave**
 * date, so a box that always spoke for today would promise the old rule to someone picking dates
 * after the change. While the change is still ahead, the hint says so instead of pretending the
 * rule in force today is the only one.
 */
export function annualQuotaHint(input: {
  quotaScheme: AnnualLeaveQuotaScheme;
  periodLimitDays: number;
  semesterEffectiveFrom?: string | null;
  /** The date `quotaScheme` was derived from. */
  referenceDate?: string;
}): string {
  const current =
    input.quotaScheme === "SEMESTER"
      ? `${input.periodLimitDays} hari kerja per semester. Satu pengajuan harus berada dalam satu semester: tanggal yang melewati 30 Juni-1 Juli atau pergantian tahun diajukan terpisah.`
      : `${input.periodLimitDays} hari kerja per periode tiga bulan. Satu pengajuan harus berada dalam satu periode: tanggal setelah batas periode diajukan terpisah.`;

  const changesLater =
    input.quotaScheme === "QUARTER" &&
    Boolean(input.semesterEffectiveFrom) &&
    Boolean(input.referenceDate) &&
    input.semesterEffectiveFrom! > input.referenceDate!;

  return changesLater
    ? `${current} Untuk tanggal cuti mulai ${formatQuotaDate(input.semesterEffectiveFrom!)}, batasnya berpindah ke per semester (Januari-Juni dan Juli-Desember); yang berlaku adalah aturan pada tanggal cuti, bukan tanggal pengajuan.`
    : current;
}

/** LEAVE-008 adds `postponement_proposed` (awaiting my answer) and `postponed` (replaced). */
export type LeaveRequestStatus =
  | "in_review"
  | "approved"
  | "rejected"
  | "cancelled"
  | "postponement_proposed"
  | "postponed";

/** LEAVE-008: the latest proposal of other dates on one request. */
export interface LeavePostponement {
  id: string;
  status: "proposed" | "accepted" | "declined";
  proposedStartOn: string;
  proposedEndOn: string;
  proposedWorkingDays: number;
  note: string;
  proposedByName: string;
  proposedAt: string;
  respondedAt: string | null;
  replacementRequestId: string | null;
}

/** LEAVE-008 fields that every leave history item carries. */
export interface LeavePostponementFields {
  postponement?: LeavePostponement | null;
  replacesRequestId?: string | null;
  canRespondToPostponement?: boolean;
}

export interface LeaveRequestSummary extends LeavePostponementFields {
  id: string;
  policyKey: string;
  status: LeaveRequestStatus;
  startOn: string;
  endOn: string;
  workingDays: number;
  reason: string | null;
  annualPeriodKey: AnnualLeavePeriodKey | null;
  submittedAt: string;
  finalDecidedAt: string | null;
  currentApproverName: string | null;
  /** LEAVE-010: the API says whether the requester may still withdraw it. */
  canCancel: boolean;
}

export interface AnnualLeavePreview {
  annualEntitlementDays: number;
  quotaScheme: AnnualLeaveQuotaScheme;
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
  quotaScheme: AnnualLeaveQuotaScheme;
  periodKey: AnnualLeavePeriodKey;
  periodLimitDays: number;
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

/** LEAVE-010: withdraw my own request while it still awaits a decision. */
export async function cancelLeaveRequest(requestId: string, reason: string | null): Promise<{ id: string; status: "cancelled" }> {
  return readJson(
    await fetch(`/api/leave/me/requests/${requestId}/cancel`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ reason }),
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

export interface LeavePostponementPreview {
  stepId: string;
  requestId: string;
  policyKey: string;
  currentStartOn: string;
  currentEndOn: string;
  proposedStartOn: string;
  proposedEndOn: string;
  workingDays: number;
  workingDates: string[];
  nonWorkingDates: string[];
  criticalPeriods: CriticalPeriodMatch[];
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  return readJson<T>(
    await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** LEAVE-008: check other dates for my active approval step; nothing is stored. */
export function previewLeavePostponement(stepId: string, input: { startOn: string; endOn: string }) {
  return postJson<LeavePostponementPreview>(`/api/leave/approvals/${stepId}/postponement/preview`, input);
}

/** LEAVE-008: propose other dates instead of approving or rejecting. */
export function postponeLeaveApproval(stepId: string, input: { startOn: string; endOn: string; note: string }) {
  return postJson<{
    requestId: string;
    requestStatus: "postponement_proposed";
    proposalId: string;
    proposedStartOn: string;
    proposedEndOn: string;
    proposedWorkingDays: number;
  }>(`/api/leave/approvals/${stepId}/postpone`, input);
}

/** LEAVE-008: accept the proposed dates; the API submits a replacement request. */
export function acceptLeavePostponement(proposalId: string, idempotencyKey: string) {
  return postJson<{
    proposalId: string;
    status: "accepted";
    replacementRequestId: string;
    idempotentReplay: boolean;
  }>(`/api/leave/me/postponements/${proposalId}/accept`, { idempotencyKey });
}

/** LEAVE-008: decline the proposed dates; the original request ends without leave. */
export function declineLeavePostponement(proposalId: string, reason: string | null) {
  return postJson<{ proposalId: string; status: "declined"; requestStatus: LeaveRequestStatus }>(
    `/api/leave/me/postponements/${proposalId}/decline`,
    { reason },
  );
}
