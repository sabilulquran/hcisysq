// ATT-015 client: tugas luar, WFH/WFA and schedule change requests. The API authorizes every call and
// owns every rule; this module only shapes requests and labels states.
// Spec: docs/domain/attendance-remote-and-schedule-requests.md.

import { approverRoleLabel, formatTimestamp, formatTripRange, todayInJakarta, type Pagination } from "@/lib/trips";

export { approverRoleLabel, formatTimestamp, todayInJakarta, type Pagination };
export const formatArrangementRange = formatTripRange;

export type ArrangementType = "FIELD_ASSIGNMENT" | "REMOTE_WORK" | "SCHEDULE_CHANGE";
export type ArrangementStatus = "IN_REVIEW" | "APPROVED" | "REJECTED" | "CANCELLED" | "APPLIED";

export interface ArrangementSummary {
  id: string;
  type: ArrangementType;
  location: string | null;
  purpose: string;
  status: ArrangementStatus;
  startOn: string;
  endOn: string;
  currentScheduleName: string | null;
  requestedScheduleName: string | null;
  submittedAt: string;
  finalDecidedAt: string | null;
  appliedAt: string | null;
  currentApproverName: string | null;
  employeeId?: string;
  employeeName?: string;
  employeeNumber?: string;
  unitName?: string | null;
}

export interface ArrangementStep {
  id: string;
  order: number;
  status: "waiting" | "pending" | "approved" | "rejected" | "cancelled";
  sources: string[];
  approverName: string;
  actedAt: string | null;
  decisionNote: string | null;
}

export interface ArrangementEvent {
  id: string;
  eventType: string;
  occurredAt: string;
  note: string | null;
  metadata: Record<string, unknown>;
  actorName: string | null;
}

export interface ArrangementDetail extends ArrangementSummary {
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  unitName: string | null;
  cancelReason: string | null;
  appliedRosterId: string | null;
  steps: ArrangementStep[];
  events: ArrangementEvent[];
}

export interface ArrangementApprovalItem {
  stepId: string;
  requestId: string;
  sources: string[];
  requesterName: string;
  requesterNumber: string;
  unitName: string | null;
  type: ArrangementType;
  location: string | null;
  purpose: string;
  currentScheduleName: string | null;
  requestedScheduleName: string | null;
  startOn: string;
  endOn: string;
  submittedAt: string;
}

export interface ArrangementPreview {
  days: number;
  approvalChain: Array<{ employeeId: string; name: string; sources: string[] }>;
  meetings: Array<{ title: string; startAt: string; endAt: string }>;
  scheduleChange: { currentScheduleName: string | null; requestedScheduleName: string } | null;
}

export interface ScheduleOptions {
  workDate: string;
  current: {
    state: "scheduled" | "off" | "configuration_error";
    scheduleTemplateId: string | null;
    scheduleName: string | null;
    scheduledStartAt: string | null;
    scheduledEndAt: string | null;
  };
  options: Array<{ id: string; name: string; startTime: string; endTime: string }>;
}

export type ArrangementInput =
  | { type: "FIELD_ASSIGNMENT" | "REMOTE_WORK"; startOn: string; endOn: string; location: string }
  | { type: "SCHEDULE_CHANGE"; startOn: string; endOn: string; scheduleTemplateId: string };

export class WorkArrangementApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "WorkArrangementApiError";
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as T | { code?: string; message?: string } | null;
  if (!response.ok) {
    const problem = body as { code?: string; message?: string } | null;
    throw new WorkArrangementApiError(response.status, problem?.code ?? "ARRANGEMENT_FAILED", problem?.message ?? "Pengajuan tidak dapat diproses.");
  }
  return body as T;
}

async function get<T>(path: string) {
  return readJson<T>(await fetch(`/api${path}`, { credentials: "include", headers: { Accept: "application/json" } }));
}

async function post<T>(path: string, payload?: unknown) {
  return readJson<T>(await fetch(`/api${path}`, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  }));
}

function query(params: Record<string, string | number | undefined | null>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : "";
}

export const getMyArrangements = (page = 1, type?: ArrangementType | "") =>
  get<{ items: ArrangementSummary[]; pagination: Pagination }>(`/attendance/arrangements/me${query({ page, type })}`);
export const getMyArrangement = (id: string) => get<ArrangementDetail>(`/attendance/arrangements/me/${id}`);
export const getScheduleOptions = (workDate: string) =>
  get<ScheduleOptions>(`/attendance/arrangements/schedule-options${query({ workDate })}`);
export const previewArrangement = (input: ArrangementInput) => post<ArrangementPreview>("/attendance/arrangements/me/preview", input);
export const submitArrangement = (input: ArrangementInput & { purpose: string; idempotencyKey: string }) =>
  post<{ id: string; status: ArrangementStatus }>("/attendance/arrangements/me", input);
export const cancelMyArrangement = (id: string, reason: string) =>
  post<{ id: string; status: ArrangementStatus }>(`/attendance/arrangements/me/${id}/cancel`, { reason });

export const getArrangementApprovals = (page = 1) =>
  get<{ items: ArrangementApprovalItem[]; pagination: Pagination }>(`/attendance/arrangements/approvals${query({ page })}`);
export const decideArrangementApproval = (stepId: string, decision: "approve" | "reject", note: string | null) =>
  post<{ requestStatus: ArrangementStatus }>(`/attendance/arrangements/approvals/${stepId}/decision`, { decision, note });

export const getAdminArrangements = (filter: { page?: number; status?: ArrangementStatus | ""; type?: ArrangementType | ""; employeeId?: string | null }) =>
  get<{ items: ArrangementSummary[]; pagination: Pagination }>(`/admin/attendance/arrangements${query({
    page: filter.page ?? 1, status: filter.status, type: filter.type, employeeId: filter.employeeId,
  })}`);
export const getAdminArrangement = (id: string) => get<ArrangementDetail>(`/admin/attendance/arrangements/${id}`);
export const applyScheduleChange = (id: string) => post<{ id: string; status: ArrangementStatus }>(`/admin/attendance/arrangements/${id}/apply`);
export const cancelArrangementAsHc = (id: string, reason: string) =>
  post<{ id: string; status: ArrangementStatus }>(`/admin/attendance/arrangements/${id}/cancel`, { reason });

export const ARRANGEMENT_TYPE_LABELS: Record<ArrangementType, string> = {
  FIELD_ASSIGNMENT: "Tugas luar",
  REMOTE_WORK: "WFH/WFA",
  SCHEDULE_CHANGE: "Ubah jadwal",
};

export const ARRANGEMENT_STATUS_LABELS: Record<ArrangementStatus, string> = {
  IN_REVIEW: "Menunggu persetujuan",
  APPROVED: "Disetujui",
  REJECTED: "Ditolak",
  CANCELLED: "Dibatalkan",
  APPLIED: "Jadwal sudah diubah",
};

export function arrangementTypeLabel(type: string) {
  return ARRANGEMENT_TYPE_LABELS[type as ArrangementType] ?? type;
}

/** A schedule change waits for HC after approval; the other kinds take effect at approval. */
export function arrangementStatusLabel(status: string, type?: string) {
  if (status === "APPROVED" && type === "SCHEDULE_CHANGE") return "Disetujui, menunggu diterapkan HC";
  return ARRANGEMENT_STATUS_LABELS[status as ArrangementStatus] ?? status;
}

/** One line that says what the request is about, for lists and queues. */
export function arrangementSubject(item: Pick<ArrangementSummary, "type" | "location" | "currentScheduleName" | "requestedScheduleName">) {
  if (item.type === "SCHEDULE_CHANGE") return `${item.currentScheduleName ?? "Jadwal"} → ${item.requestedScheduleName ?? "-"}`;
  return item.location ?? "";
}

const EVENT_LABELS: Record<string, string> = {
  "arrangement.request.submitted": "Diajukan",
  "arrangement.approval.approved_step": "Tahap disetujui",
  "arrangement.request.approved": "Disetujui seluruhnya",
  "arrangement.request.rejected": "Ditolak",
  "arrangement.request.cancelled": "Dibatalkan",
  "arrangement.schedule.applied": "Jadwal diterapkan",
};

export function arrangementEventLabel(eventType: string) {
  return EVENT_LABELS[eventType] ?? eventType;
}

export function formatClock(value: string) {
  return new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Jakarta" })
    .format(new Date(value)).replace(".", ":");
}
