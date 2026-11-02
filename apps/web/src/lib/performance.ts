// PERF-001 client. The API owns every rule: scoring, predicates, who may act and when (it sends
// `allowedActions`); this module only shapes requests and labels states.
// Spec: docs/domain/performance-review.md.

export type CycleKind = "MONTHLY" | "ANNUAL";
export type CycleStatus = "DRAFT" | "OPEN" | "CLOSED" | "CANCELLED";
export type ReviewStatus = "SELF_ASSESSMENT" | "MANAGER_REVIEW" | "HC_VALIDATION" | "FINALIZED" | "UNRATED" | "REMOVED";
export type ReviewAction = "self-assessment" | "acknowledge" | "rate" | "finalize" | "return" | "assign-rater" | "remove";

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

export interface Indicator {
  code: string;
  label: string;
  description: string;
  weight: number;
}

export interface Predicate {
  code: string;
  label: string;
  minScore: number;
}

export interface Rubric {
  indicators: Indicator[];
  predicates: Predicate[];
}

export type Scores = Record<string, number>;

export interface CycleSummary {
  id: string;
  name: string;
  kind: CycleKind;
  status: CycleStatus;
  periodStart: string;
  periodEnd: string;
  selfDueOn: string;
  reviewDueOn: string;
  participantCount?: number;
}

export interface CycleDetail extends CycleSummary {
  rubric: Rubric;
  recap: {
    participants: number;
    byStatus: Record<ReviewStatus, number>;
    byPredicate: Array<Predicate & { count: number }>;
    raterMissing: number;
    raterAccountNotReady: number;
  };
  events: PerformanceEvent[];
}

export interface ReviewSummary {
  id: string;
  status: ReviewStatus;
  cycleId: string;
  cycleName: string;
  cycleKind: CycleKind;
  cycleStatus: CycleStatus;
  periodStart: string;
  periodEnd: string;
  selfDueOn: string;
  reviewDueOn: string;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  unitName: string | null;
  raterEmployeeId: string | null;
  raterName: string | null;
  raterSource: "DIRECT_MANAGER" | "GOVERNANCE_APPROVER" | "HC_ASSIGNED" | null;
  raterAccountReady: boolean | null;
  selfSubmittedAt: string | null;
  ratedAt: string | null;
  finalizedAt: string | null;
  acknowledgedAt: string | null;
  finalScore: number | null;
  predicateCode: string | null;
  predicateLabel: string | null;
}

export interface PerformanceEvent {
  id: string;
  eventType: string;
  occurredAt: string;
  note: string | null;
  metadata: Record<string, unknown>;
  actorName: string | null;
}

export interface ReviewDetail extends ReviewSummary {
  rubric: Rubric;
  selfAssessment: { scores: Scores; note: string | null } | null;
  rating: { scores: Scores; strengths: string | null; improvements: string | null; note: string | null } | null;
  acknowledgementComment: string | null;
  removedReason: string | null;
  allowedActions: ReviewAction[];
  events: PerformanceEvent[];
}

export interface CycleInput {
  name: string;
  kind: CycleKind;
  periodStart: string;
  periodEnd: string;
  selfDueOn: string;
  reviewDueOn: string;
  rubric?: Rubric;
}

export class PerformanceApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "PerformanceApiError";
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as T | { code?: string; message?: string } | null;
  if (!response.ok) {
    const problem = body as { code?: string; message?: string } | null;
    throw new PerformanceApiError(response.status, problem?.code ?? "PERFORMANCE_FAILED", problem?.message ?? "Penilaian kinerja tidak dapat diproses.");
  }
  return body as T;
}

async function get<T>(path: string) {
  return readJson<T>(await fetch(`/api${path}`, { credentials: "include", headers: { Accept: "application/json" } }));
}

async function send<T>(method: "POST" | "PATCH", path: string, payload?: unknown) {
  return readJson<T>(await fetch(`/api${path}`, {
    method,
    credentials: "include",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  }));
}

function query(params: Record<string, string | number | boolean | undefined | null>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : "";
}

type Page<T> = { items: T[]; pagination: Pagination };

export const getMyReviews = (page = 1) => get<Page<ReviewSummary>>(`/performance/me${query({ page })}`);
export const getMyReview = (id: string) => get<ReviewDetail>(`/performance/me/${id}`);
export const submitSelfAssessment = (id: string, scores: Scores, note: string | null) =>
  send<{ status: ReviewStatus }>("POST", `/performance/me/${id}/self-assessment`, { scores, note });
export const acknowledgeReview = (id: string, comment: string | null) =>
  send<{ status: ReviewStatus }>("POST", `/performance/me/${id}/acknowledge`, { comment });

export const getTeamReviews = (page = 1, status?: ReviewStatus | "") =>
  get<Page<ReviewSummary>>(`/performance/team${query({ page, status })}`);
export const getTeamReview = (id: string) => get<ReviewDetail>(`/performance/team/${id}`);
export const submitRating = (id: string, input: { scores: Scores; strengths: string | null; improvements: string | null; note: string | null }) =>
  send<{ status: ReviewStatus; predicateLabel: string; finalScore: number }>("POST", `/performance/team/${id}/rating`, input);

export const getCycles = (page = 1, status?: CycleStatus | "") =>
  get<Page<CycleSummary>>(`/admin/performance/cycles${query({ page, status })}`);
export const getCycle = (id: string) => get<CycleDetail>(`/admin/performance/cycles/${id}`);
export const createCycle = (input: CycleInput) => send<{ id: string }>("POST", "/admin/performance/cycles", input);
export const updateCycle = (id: string, input: Partial<CycleInput>) => send<{ id: string }>("PATCH", `/admin/performance/cycles/${id}`, input);
export const openCycle = (id: string) => send<{ participants: number }>("POST", `/admin/performance/cycles/${id}/open`);
export const closeCycle = (id: string) => send<{ finalized: number; unrated: number }>("POST", `/admin/performance/cycles/${id}/close`);
export const cancelCycle = (id: string, reason: string) => send<{ status: CycleStatus }>("POST", `/admin/performance/cycles/${id}/cancel`, { reason });
export const addParticipants = (id: string, input: { employeeIds: string[] } | { allActive: true }) =>
  send<{ added: number; readded: number; alreadyIn: number; withoutRater: number }>("POST", `/admin/performance/cycles/${id}/participants`, input);
export const getCycleReviews = (id: string, filter: { page?: number; status?: ReviewStatus | ""; predicate?: string; q?: string; raterMissing?: boolean | null }) =>
  get<Page<ReviewSummary>>(`/admin/performance/cycles/${id}/reviews${query({
    page: filter.page ?? 1, status: filter.status, predicate: filter.predicate,
    q: filter.q && filter.q.trim().length >= 2 ? filter.q.trim() : undefined, raterMissing: filter.raterMissing,
  })}`);
export const getAdminReview = (id: string) => get<ReviewDetail>(`/admin/performance/reviews/${id}`);
export const finalizeReview = (id: string) => send<{ status: ReviewStatus }>("POST", `/admin/performance/reviews/${id}/finalize`);
export const returnReview = (id: string, reason: string) => send<{ status: ReviewStatus }>("POST", `/admin/performance/reviews/${id}/return`, { reason });
export const assignRater = (id: string, raterEmployeeId: string, reason: string) =>
  send<{ raterEmployeeId: string }>("POST", `/admin/performance/reviews/${id}/rater`, { raterEmployeeId, reason });
export const removeReview = (id: string, reason: string) => send<{ status: ReviewStatus }>("POST", `/admin/performance/reviews/${id}/remove`, { reason });
export const getEmployeeHistory = (employeeId: string, page = 1) =>
  get<Page<ReviewSummary>>(`/admin/performance/employees/${employeeId}/reviews${query({ page })}`);

export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  SELF_ASSESSMENT: "Menunggu penilaian diri",
  MANAGER_REVIEW: "Menunggu penilai",
  HC_VALIDATION: "Menunggu pengesahan HC",
  FINALIZED: "Final",
  UNRATED: "Tidak dinilai",
  REMOVED: "Dikeluarkan",
};

export const CYCLE_STATUS_LABELS: Record<CycleStatus, string> = {
  DRAFT: "Draf",
  OPEN: "Dibuka",
  CLOSED: "Ditutup",
  CANCELLED: "Dibatalkan",
};

export const CYCLE_KIND_LABELS: Record<CycleKind, string> = { MONTHLY: "Bulanan", ANNUAL: "Tahunan (tahun ajaran)" };

/** D-04: the legacy 1-4 scale. */
export const SCALE_OPTIONS = [
  { value: 4, label: "4 · Sangat baik" },
  { value: 3, label: "3 · Baik" },
  { value: 2, label: "2 · Cukup" },
  { value: 1, label: "1 · Kurang" },
];

const RATER_SOURCE_LABELS: Record<string, string> = {
  DIRECT_MANAGER: "Atasan langsung",
  GOVERNANCE_APPROVER: "Penyetuju struktur",
  HC_ASSIGNED: "Ditunjuk HC",
};

export function raterSourceLabel(source: string | null) {
  return source ? RATER_SOURCE_LABELS[source] ?? source : "Belum ada penilai";
}

const EVENT_LABELS: Record<string, string> = {
  "performance.cycle.created": "Siklus dibuat",
  "performance.cycle.updated": "Siklus diubah",
  "performance.cycle.opened": "Siklus dibuka",
  "performance.cycle.closed": "Siklus ditutup",
  "performance.cycle.cancelled": "Siklus dibatalkan",
  "performance.review.added": "Masuk siklus",
  "performance.review.readded": "Dimasukkan kembali",
  "performance.review.rater_assigned": "Penilai ditunjuk HC",
  "performance.review.self_submitted": "Penilaian diri dikirim",
  "performance.review.rated": "Dinilai penilai",
  "performance.review.returned": "Dikembalikan HC",
  "performance.review.finalized": "Disahkan HC",
  "performance.review.acknowledged": "Ditandai dibaca",
  "performance.review.removed": "Dikeluarkan dari siklus",
  "performance.review.unrated": "Tidak dinilai sampai siklus ditutup",
};

export function eventLabel(eventType: string) {
  return EVENT_LABELS[eventType] ?? eventType;
}

export function reviewStatusLabel(status: string) {
  return REVIEW_STATUS_LABELS[status as ReviewStatus] ?? status;
}

export function formatScore(score: number | null) {
  return score === null ? "-" : score.toLocaleString("id-ID", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Jakarta" })
    .format(new Date(`${value}T00:00:00+07:00`));
}

export function formatPeriod(start: string, end: string) {
  return `${formatDate(start)} – ${formatDate(end)}`;
}

export function formatTimestamp(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" }).format(new Date(value));
}

/** Defaults for a new cycle form: the current Jakarta month, deadlines on its last day. */
export function monthlyDefaults(): CycleInput {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  const label = new Intl.DateTimeFormat("id-ID", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)));
  return {
    name: `Penilaian kinerja ${label}`,
    kind: "MONTHLY",
    periodStart: `${today.slice(0, 7)}-01`,
    periodEnd: last,
    selfDueOn: last,
    reviewDueOn: last,
  };
}
