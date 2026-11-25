import type {
  AnnualLeavePeriodKey,
  AnnualLeaveQuotaScheme,
} from "@/lib/employeeLeave";

export interface AdministrationQueueItem {
  taskId: string;
  taskStatus: "pending" | "needs_correction";
  requestId: string;
  requesterEmployeeId: string;
  requesterName: string;
  employeeNumber: string;
  unitName: string | null;
  positionName: string | null;
  entitlementGroup: "education" | "non_education" | null;
  policyKey: string;
  policyName: string;
  startOn: string;
  endOn: string;
  workingDays: number;
  workingDates: string[];
  reason: string | null;
  evidenceRequirement: "none" | "required" | "required_deferred_allowed" | "conditional";
  taskNote: string | null;
  submittedAt: string;
  evidence: Array<{
    id: string;
    fileName: string;
    contentType: string;
    byteSize: number;
    createdAt: string;
  }>;
}

export interface HcAdministrationQueue {
  actor: {
    id: string;
    fullName: string;
    employeeNumber: string;
    unitName: string | null;
    positionName: string | null;
  };
  items: AdministrationQueueItem[];
}

export interface AnnualConversionOffer {
  available: boolean;
  /** LEAVE-003 R2: which quota rule read these dates. */
  quotaScheme: AnnualLeaveQuotaScheme;
  periodKey: AnnualLeavePeriodKey | null;
  periodLimitDays: number;
  usedDays: number;
  remainingDays: number;
  requestedDays: number;
  reason: string | null;
}

export interface AttendanceResolutionItem {
  caseId: string;
  employeeId: string;
  requesterName: string;
  employeeNumber: string;
  unitName: string | null;
  positionName: string | null;
  entitlementGroup: "education" | "non_education" | null;
  startedOn: string | null;
  sourceRequestId: string;
  policyKey: string;
  policyName: string;
  status: "open" | "awaiting_employee" | "resolved";
  proposedResolution: "dispensation" | "unpaid_absence" | "annual_conversion" | "manual_review" | null;
  finalResolution: "dispensation" | "unpaid_absence" | "annual_conversion" | null;
  note: string | null;
  employeeResponseNote: string | null;
  unresolvedDates: string[];
  annualConversion: AnnualConversionOffer;
  createdAt: string;
  updatedAt: string;
}

export interface HcAttendanceResolutionQueue {
  actor: {
    id: string;
    fullName: string;
    employeeNumber: string;
    unitName: string | null;
    positionName: string | null;
  };
  items: AttendanceResolutionItem[];
}

export class AttendanceResolutionApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AttendanceResolutionApiError";
  }
}

async function readJson<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T;
  const body = (await response.json().catch(() => null)) as
    | { code?: string; message?: string }
    | null;
  throw new AttendanceResolutionApiError(
    response.status,
    body?.code ?? "REQUEST_FAILED",
    body?.message ?? "Permintaan tidak dapat diproses.",
  );
}

export async function getHcAdministrationQueue(): Promise<HcAdministrationQueue> {
  const response = await fetch("/api/leave/hc/administration-queue", {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  return readJson(response);
}

export async function decideLeaveAdministration(
  taskId: string,
  input: {
    action: "validate_all" | "request_correction" | "validate_partial" | "not_validated";
    note: string | null;
    validatedDates?: string[];
  },
): Promise<{
  requestId: string;
  requestStatus: string;
  administrationStatus: string;
  taskStatus: string;
  validatedDates?: string[];
  unresolvedDates?: string[];
  resolutionCaseId: string | null;
}> {
  const response = await fetch(`/api/leave/hc/tasks/${taskId}/administration-decision`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input),
  });
  return readJson(response);
}

export async function getHcAttendanceResolutionQueue(): Promise<HcAttendanceResolutionQueue> {
  const response = await fetch("/api/attendance/resolutions/hc", {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  return readJson(response);
}

export async function decideAttendanceResolution(
  caseId: string,
  input: {
    action: "dispensation" | "unpaid_absence" | "manual_review" | "propose_annual_conversion";
    note: string | null;
  },
) {
  const response = await fetch(`/api/attendance/resolutions/hc/${caseId}/decision`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input),
  });
  return readJson<{
    caseId: string;
    status: string;
    proposedResolution?: string;
    finalResolution?: string;
  }>(response);
}

export async function getMyAttendanceResolutions(): Promise<{
  items: AttendanceResolutionItem[];
}> {
  const response = await fetch("/api/attendance/resolutions/me", {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  return readJson(response);
}

export async function decideMyAnnualConversion(
  caseId: string,
  input: { decision: "accept" | "reject"; note: string | null },
) {
  const response = await fetch(
    `/api/attendance/resolutions/me/${caseId}/annual-conversion-decision`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    },
  );
  return readJson<{
    caseId: string;
    status: string;
    decision: "accept" | "reject";
    annualRequestId?: string;
    periodKey?: string;
    convertedDays?: number;
  }>(response);
}
