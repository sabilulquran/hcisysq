// TRIP-001 client. The API authorizes every call and owns every rule; this module only shapes
// requests and labels states. Spec: docs/domain/business-travel.md.

export type TripStatus = "IN_REVIEW" | "APPROVED" | "REJECTED" | "CANCELLED" | "ISSUED" | "COMPLETED";

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

export interface TripSummary {
  id: string;
  destination: string;
  purpose: string;
  status: TripStatus;
  startOn: string;
  endOn: string;
  submittedAt: string;
  finalDecidedAt: string | null;
  documentNumber: string | null;
  currentApproverName: string | null;
  employeeId?: string;
  employeeName?: string;
  employeeNumber?: string;
  unitName?: string | null;
}

export interface TripStep {
  id: string;
  order: number;
  status: "waiting" | "pending" | "approved" | "rejected" | "cancelled";
  sources: string[];
  approverName: string;
  actedAt: string | null;
  decisionNote: string | null;
}

export interface TripEvent {
  id: string;
  eventType: string;
  occurredAt: string;
  note: string | null;
  metadata: Record<string, unknown>;
  actorName: string | null;
}

export interface AssignmentLetter {
  id: string;
  documentNumber: string;
  status: "ISSUED" | "REVOKED";
  issuedAt: string;
  signer: { title?: string; name?: string | null };
  content: Record<string, string | null>;
}

export interface TripDetail extends TripSummary {
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  unitName: string | null;
  cancelReason: string | null;
  completionReport: string | null;
  completedAt: string | null;
  assignmentLetter: AssignmentLetter | null;
  steps: TripStep[];
  events: TripEvent[];
}

export interface TripApprovalItem {
  stepId: string;
  requestId: string;
  sources: string[];
  requesterName: string;
  requesterNumber: string;
  unitName: string | null;
  destination: string;
  purpose: string;
  startOn: string;
  endOn: string;
  submittedAt: string;
}

export interface TripPreview {
  days: number;
  approvalChain: Array<{ employeeId: string; name: string; sources: string[] }>;
}

export class TripApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "TripApiError";
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as T | { code?: string; message?: string } | null;
  if (!response.ok) {
    const problem = body as { code?: string; message?: string } | null;
    throw new TripApiError(response.status, problem?.code ?? "TRIP_FAILED", problem?.message ?? "Perjalanan dinas tidak dapat diproses.");
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

export const getMyTrips = (page = 1, status?: TripStatus) =>
  get<{ items: TripSummary[]; pagination: Pagination }>(`/trips/me${query({ page, status })}`);
export const getMyTrip = (id: string) => get<TripDetail>(`/trips/me/${id}`);
export const previewTrip = (startOn: string, endOn: string) => post<TripPreview>("/trips/me/preview", { startOn, endOn });
export const submitTrip = (input: { destination: string; purpose: string; startOn: string; endOn: string; idempotencyKey: string }) =>
  post<{ id: string; status: TripStatus }>("/trips/me", input);
export const cancelMyTrip = (id: string, reason: string) => post<{ id: string; status: TripStatus }>(`/trips/me/${id}/cancel`, { reason });
export const completeMyTrip = (id: string, report: string) => post<{ id: string; status: TripStatus }>(`/trips/me/${id}/complete`, { report });

export const getTripApprovals = (page = 1) =>
  get<{ items: TripApprovalItem[]; pagination: Pagination }>(`/trips/approvals${query({ page })}`);
export const decideTripApproval = (stepId: string, decision: "approve" | "reject", note: string | null) =>
  post<{ requestStatus: TripStatus }>(`/trips/approvals/${stepId}/decision`, { decision, note });

export const getAdminTrips = (filter: { page?: number; status?: TripStatus | ""; employeeId?: string | null }) =>
  get<{ items: TripSummary[]; pagination: Pagination }>(`/admin/trips${query({ page: filter.page ?? 1, status: filter.status, employeeId: filter.employeeId })}`);
export const getAdminTrip = (id: string) => get<TripDetail>(`/admin/trips/${id}`);
export const issueTripLetter = (id: string) => post<{ documentNumber: string }>(`/admin/trips/${id}/issue`);
export const cancelTripAsHc = (id: string, reason: string) => post<{ id: string; status: TripStatus }>(`/admin/trips/${id}/cancel`, { reason });

export const TRIP_STATUS_LABELS: Record<TripStatus, string> = {
  IN_REVIEW: "Menunggu persetujuan",
  APPROVED: "Disetujui, menunggu surat tugas",
  REJECTED: "Ditolak",
  CANCELLED: "Dibatalkan",
  ISSUED: "Surat tugas terbit",
  COMPLETED: "Selesai",
};

export function tripStatusLabel(status: string) {
  return TRIP_STATUS_LABELS[status as TripStatus] ?? status;
}

const EVENT_LABELS: Record<string, string> = {
  "trip.request.submitted": "Diajukan",
  "trip.approval.approved_step": "Tahap disetujui",
  "trip.request.approved": "Disetujui seluruhnya",
  "trip.request.rejected": "Ditolak",
  "trip.request.cancelled": "Dibatalkan",
  "trip.assignment.issued": "Surat tugas terbit",
  "trip.assignment.revoked": "Surat tugas dicabut",
  "trip.request.completed": "Diselesaikan",
};

export function tripEventLabel(eventType: string) {
  return EVENT_LABELS[eventType] ?? eventType;
}

export function approverRoleLabel(sources: string[]) {
  const labels = [
    sources.includes("DIRECT_MANAGER") ? "Atasan langsung" : null,
    sources.includes("UNIT_APPROVER") ? "Approver unit" : null,
  ].filter(Boolean);
  return labels.join(" + ") || "Approver";
}

export function formatTripDate(value: string) {
  return new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Jakarta" })
    .format(new Date(`${value}T00:00:00+07:00`));
}

export function formatTripRange(startOn: string, endOn: string) {
  return startOn === endOn ? formatTripDate(startOn) : `${formatTripDate(startOn)} – ${formatTripDate(endOn)}`;
}

export function formatTimestamp(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" }).format(new Date(value));
}

/** `YYYY-MM-DD` in Asia/Jakarta, so a form opened before 07:00 WIB does not default to yesterday. */
export function todayInJakarta() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
