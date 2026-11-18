// TRIP-002 client. The API authorizes every call and owns every rule — per diem rates, limits,
// settlement arithmetic and refunds; this module only shapes requests and labels states.
// Spec: docs/domain/trip-advance-per-diem.md.

import type { Pagination } from "@/lib/loans";

export type { Pagination };
export { approverRoleLabel, formatRupiah, formatTimestamp, parseRupiahInput, todayInJakarta } from "@/lib/loans";

export type AdvanceStatus =
  | "IN_REVIEW" | "APPROVED" | "DISBURSED" | "SETTLEMENT_SUBMITTED"
  | "AWAITING_TOP_UP" | "AWAITING_REFUND" | "SETTLED" | "REJECTED" | "CANCELLED";
export type WilayahKey = "DALAM_DAERAH" | "LUAR_DAERAH" | "LUAR_NEGERI";
export type GolonganKey = "PIMPINAN" | "KEPALA_UNIT" | "STAF";
export type TransactionMethod = "CASH" | "TRANSFER";

export interface Wilayah { key: WilayahKey; label: string }
export interface Golongan { key: GolonganKey; label: string }

/** Amounts are whole rupiah as JSON integers; the API refuses anything else. */
export interface AdvanceSummary {
  id: string;
  status: AdvanceStatus;
  wilayah: WilayahKey;
  wilayahLabel: string;
  amount: number;
  purpose: string;
  submittedAt: string;
  settlementBalance: number | null;
  businessTripId: string;
  tripDestination: string;
  tripStatus: string;
  tripStartOn: string;
  tripEndOn: string;
  dueOn: string;
  overdue: boolean;
  currentApproverName: string | null;
  employeeId?: string;
  employeeName?: string;
  employeeNumber?: string;
  unitName?: string | null;
}

export interface AdvanceStep {
  id: string;
  order: number;
  status: "waiting" | "pending" | "approved" | "rejected" | "cancelled";
  sources: string[];
  approverName: string;
  actedAt: string | null;
  decisionNote: string | null;
}

export interface AdvanceTransaction {
  id: string;
  kind: "DISBURSEMENT" | "TOP_UP" | "REFUND";
  amount: number;
  transactedOn: string;
  method: TransactionMethod;
  reference: string | null;
  note: string | null;
  recordedAt: string;
  recordedByName: string | null;
}

export interface AdvanceEvent {
  id: string;
  eventType: string;
  occurredAt: string;
  note: string | null;
  metadata: Record<string, unknown>;
  actorName: string | null;
}

export interface LinkedClaim {
  id: string;
  title: string;
  status: string;
  claimedTotal: number;
  verifiedTotal: number | null;
}

export interface SettlementPreview {
  maxPerDiemDays: number;
  tripDays: number;
  golongan: GolonganKey | null;
  golonganLabel: string | null;
  classificationCodes: string[];
  dailyRate: number | null;
  rateEffectiveFrom: string | null;
  verifiedClaims: number;
  pendingClaims: number;
  openClaims: number;
}

export interface AdvanceDetail extends AdvanceSummary {
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  unitName: string | null;
  finalDecidedAt: string | null;
  disbursedAt: string | null;
  settlementSubmittedAt: string | null;
  settlementNote: string | null;
  perDiemDays: number | null;
  perDiemGolonganLabel: string | null;
  organizerPerDiemDeclared: boolean;
  perDiemWaiveReason: string | null;
  perDiemRate: number | null;
  perDiemAmount: number | null;
  claimsTotal: number | null;
  settlementFinanceNote: string | null;
  settledAt: string | null;
  closedAt: string | null;
  rejectedBy: "APPROVER" | "FINANCE" | null;
  rejectReason: string | null;
  cancelReason: string | null;
  refundedTotal: number;
  refundOutstanding: number;
  steps: AdvanceStep[];
  transactions: AdvanceTransaction[];
  settledClaims: Array<{ claimId: string; title: string; verifiedTotal: number }>;
  linkedClaims: LinkedClaim[];
  settlementPreview: SettlementPreview;
  events: AdvanceEvent[];
}

export interface AdvanceableTrip {
  id: string;
  destination: string;
  startOn: string;
  endOn: string;
  status: string;
}

export interface AdvanceEstimate {
  tripId: string;
  wilayah: WilayahKey;
  golongan: GolonganKey;
  golonganLabel: string;
  days: number;
  dailyRate: number | null;
  rateEffectiveFrom: string | null;
  perDiemEstimate: number;
  maxAmount: number;
  approvalChain: Array<{ employeeId: string; name: string; sources: string[] }>;
}

export interface AdvanceApprovalItem {
  stepId: string;
  advanceId: string;
  sources: string[];
  requesterName: string;
  requesterNumber: string;
  unitName: string | null;
  wilayah: WilayahKey;
  wilayahLabel: string;
  amount: number;
  purpose: string;
  tripDestination: string;
  tripStartOn: string;
  tripEndOn: string;
  submittedAt: string;
}

export interface PerDiemRate {
  id: string;
  wilayah: WilayahKey;
  wilayahLabel: string;
  golongan: GolonganKey;
  golonganLabel: string;
  decreeReference: string | null;
  effectiveFrom: string;
  dailyAmount: number;
  note: string | null;
  createdAt: string;
  createdByName: string | null;
}

export interface CurrentRate {
  golongan: GolonganKey;
  golonganLabel: string;
  wilayah: WilayahKey;
  label: string;
  dailyAmount: number | null;
  effectiveFrom: string | null;
}

/** D-20: the classification-to-golongan map Human Capital keeps. */
export interface GolonganMapping {
  jobClassificationCode: string;
  classificationName: string | null;
  golongan: GolonganKey;
  golonganLabel: string;
  note: string | null;
  updatedAt: string;
  updatedByName: string | null;
}

export interface Claimant { id: string; fullName: string; employeeNumber: string; unitName: string | null }

export interface TransactionInput {
  paidOn: string;
  method: TransactionMethod;
  reference: string | null;
  note: string | null;
  idempotencyKey: string;
}

export class TripAdvanceApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "TripAdvanceApiError";
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as T | { code?: string; message?: string } | null;
  if (!response.ok) {
    const problem = body as { code?: string; message?: string } | null;
    throw new TripAdvanceApiError(response.status, problem?.code ?? "TRIP_ADVANCE_FAILED", problem?.message ?? "Uang muka dinas tidak dapat diproses.");
  }
  return body as T;
}

async function get<T>(path: string) {
  return readJson<T>(await fetch(`/api${path}`, { credentials: "include", headers: { Accept: "application/json" } }));
}

async function send<T>(method: "PUT" | "DELETE", path: string, payload?: unknown) {
  return readJson<T>(await fetch(`/api${path}`, {
    method,
    credentials: "include",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  }));
}

async function post<T>(path: string, payload: unknown) {
  return readJson<T>(await fetch(`/api${path}`, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }));
}

function query(params: Record<string, string | number | boolean | undefined | null>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : "";
}

// ---------------------------------------------------------------- employee

export const getMyAdvances = (page = 1) =>
  get<{
    items: AdvanceSummary[]; pagination: Pagination; wilayahs: Wilayah[]; golongans: Golongan[];
    policy: { maxAdvanceExpenses: number; settlementDueDays: number };
  }>(
    `/trip-advances/me${query({ page })}`,
  );
export const getMyAdvance = (id: string) => get<AdvanceDetail>(`/trip-advances/me/${id}`);
export const getAdvanceableTrips = (page = 1) =>
  get<{ items: AdvanceableTrip[]; pagination: Pagination }>(`/trip-advances/me/trips${query({ page, pageSize: 50 })}`);
export const estimateAdvance = (tripId: string, wilayah: WilayahKey) =>
  get<AdvanceEstimate>(`/trip-advances/me/estimate${query({ tripId, wilayah })}`);
export const requestAdvance = (input: { businessTripId: string; wilayah: WilayahKey; amount: number; purpose: string; idempotencyKey: string }) =>
  post<{ id: string; status: AdvanceStatus }>("/trip-advances/me", input);
export const cancelMyAdvance = (id: string, reason: string) =>
  post<{ status: AdvanceStatus }>(`/trip-advances/me/${id}/cancel`, { reason });
export const submitSettlement = (id: string, note: string | null, organizerPerDiemReceived = false) =>
  post<{ status: AdvanceStatus }>(`/trip-advances/me/${id}/settlement`, { note, organizerPerDiemReceived });

// ---------------------------------------------------------------- approver

export const getAdvanceApprovals = (page = 1) =>
  get<{ items: AdvanceApprovalItem[]; pagination: Pagination }>(`/trip-advances/approvals${query({ page })}`);
export const decideAdvanceApproval = (stepId: string, decision: "approve" | "reject", note: string | null) =>
  post<{ advanceStatus: AdvanceStatus }>(`/trip-advances/approvals/${stepId}/decision`, { decision, note });

// ------------------------------------------------------------------- admin

export const getAdminAdvances = (filter: { page?: number; status?: AdvanceStatus | ""; employeeId?: string | null; overdue?: boolean }) =>
  get<{ items: AdvanceSummary[]; pagination: Pagination; wilayahs: Wilayah[] }>(`/admin/trip-advances${query({
    page: filter.page ?? 1, status: filter.status, employeeId: filter.employeeId, overdue: filter.overdue ? true : undefined,
  })}`);
export const getAdminAdvance = (id: string) => get<AdvanceDetail>(`/admin/trip-advances/${id}`);
export const searchAdvanceClaimants = (q: string) =>
  get<{ items: Claimant[]; pagination: Pagination }>(`/admin/trip-advances/claimants${query({ q, pageSize: 20 })}`);
export const advanceExportHref = (from: string, to: string, status?: AdvanceStatus | "") =>
  `/api/admin/trip-advances/export.csv${query({ from, to, status })}`;
export const rejectAdvance = (id: string, reason: string) =>
  post<{ status: AdvanceStatus }>(`/admin/trip-advances/${id}/reject`, { reason });
/** Never carries an amount: the API disburses the approved amount. */
export const disburseAdvance = (id: string, input: TransactionInput) =>
  post<{ status: AdvanceStatus; amount: number }>(`/admin/trip-advances/${id}/disburse`, input);
export const settleAdvance = (id: string, input: {
  perDiemDays: number; note: string | null; organizerPerDiemPaid?: boolean; waiveReason?: string | null; idempotencyKey: string;
}) =>
  post<{ status: AdvanceStatus; perDiemAmount: number; claimsTotal: number; settlementBalance: number }>(`/admin/trip-advances/${id}/settle`, input);
/** Never carries an amount: the API pays the settlement balance. */
export const payTopUp = (id: string, input: TransactionInput) =>
  post<{ status: AdvanceStatus; amount: number }>(`/admin/trip-advances/${id}/top-up`, input);
export const recordRefund = (id: string, input: TransactionInput & { amount: number }) =>
  post<{ status: AdvanceStatus; refundOutstanding: number }>(`/admin/trip-advances/${id}/refunds`, input);
export const getPerDiemRates = (page = 1, wilayah?: WilayahKey | "", golongan?: GolonganKey | "") =>
  get<{ items: PerDiemRate[]; pagination: Pagination; current: CurrentRate[]; golongans: Golongan[]; wilayahs: Wilayah[] }>(
    `/admin/trip-per-diem-rates${query({ page, wilayah, golongan })}`,
  );
export const createPerDiemRate = (input: {
  golongan: GolonganKey; wilayah: WilayahKey; effectiveFrom: string; dailyAmount: number; note: string | null;
}) => post<{ id: string }>("/admin/trip-per-diem-rates", input);
export const getGolonganMap = (page = 1) =>
  get<{ items: GolonganMapping[]; pagination: Pagination; unmapped: Array<{ code: string; name: string }>; golongans: Golongan[] }>(
    `/admin/trip-per-diem-golongan${query({ page })}`,
  );
export const mapGolongan = (input: { jobClassificationCode: string; golongan: GolonganKey; note: string | null }) =>
  send<{ jobClassificationCode: string }>("PUT", "/admin/trip-per-diem-golongan", input);
export const unmapGolongan = (code: string) =>
  send<{ jobClassificationCode: string }>("DELETE", `/admin/trip-per-diem-golongan/${encodeURIComponent(code)}`);

// ------------------------------------------------------------------ labels

export const ADVANCE_STATUS_LABELS: Record<AdvanceStatus, string> = {
  IN_REVIEW: "Menunggu persetujuan",
  APPROVED: "Disetujui",
  DISBURSED: "Dicairkan, menunggu pertanggungjawaban",
  SETTLEMENT_SUBMITTED: "Pertanggungjawaban diajukan",
  AWAITING_TOP_UP: "Kekurangan menunggu dibayar",
  AWAITING_REFUND: "Menunggu pengembalian pegawai",
  SETTLED: "Selesai",
  REJECTED: "Ditolak",
  CANCELLED: "Dibatalkan",
};

export function advanceStatusLabel(status: string) {
  return ADVANCE_STATUS_LABELS[status as AdvanceStatus] ?? status;
}

export const TRANSACTION_LABELS: Record<AdvanceTransaction["kind"], string> = {
  DISBURSEMENT: "Pencairan uang muka",
  TOP_UP: "Pembayaran kekurangan",
  REFUND: "Pengembalian dari pegawai",
};

export const METHOD_LABELS: Record<TransactionMethod, string> = { CASH: "Tunai", TRANSFER: "Transfer" };

const EVENT_LABELS: Record<string, string> = {
  "trip_advance.request.submitted": "Diajukan",
  "trip_advance.approval.approved_step": "Tahap disetujui",
  "trip_advance.request.approved": "Disetujui seluruhnya",
  "trip_advance.request.rejected": "Ditolak penyetuju",
  "trip_advance.request.cancelled": "Dibatalkan",
  "trip_advance.finance.rejected": "Ditolak Keuangan",
  "trip_advance.disbursed": "Dicairkan",
  "trip_advance.settlement.submitted": "Pertanggungjawaban diajukan",
  "trip_advance.settled": "Diselesaikan Keuangan",
  "trip_advance.top_up.paid": "Kekurangan dibayar",
  "trip_advance.refund.recorded": "Pengembalian dicatat",
  "trip_advance.closed": "Selesai",
  "trip_advance.golongan.mapped": "Golongan klasifikasi dipetakan",
  "trip_advance.golongan.unmapped": "Pemetaan golongan dihapus",
};

export function advanceEventLabel(eventType: string) {
  return EVENT_LABELS[eventType] ?? eventType;
}

/** What the employee should do next, in plain words; the API decides whether they may. */
export function nextStepHint(advance: Pick<AdvanceSummary, "status" | "amount" | "overdue" | "dueOn">) {
  switch (advance.status) {
    case "IN_REVIEW": return "Menunggu keputusan penyetuju.";
    case "APPROVED": return advance.amount === 0
      ? "Ajukan pertanggungjawaban setelah kembali untuk menerima uang harian."
      : "Menunggu Keuangan mencairkan uang muka.";
    case "DISBURSED": return advance.overdue
      ? `Tenggat ${advance.dueOn} sudah lewat. Klaim biaya lewat Reimbursement, lalu ajukan pertanggungjawaban.`
      : `Klaim biaya lewat Reimbursement dengan menautkan perjalanan ini, lalu ajukan pertanggungjawaban paling lambat ${advance.dueOn}.`;
    case "SETTLEMENT_SUBMITTED": return "Keuangan sedang menghitung uang harian dan klaim Anda.";
    case "AWAITING_TOP_UP": return "Keuangan akan membayar kekurangannya.";
    case "AWAITING_REFUND": return "Kembalikan sisa uang muka ke Keuangan.";
    default: return null;
  }
}

/** Positive: owed to the employee; negative: owed by the employee. */
export function balanceLabel(balance: number | null) {
  if (balance === null) return null;
  if (balance > 0) return "Kurang, dibayar ke pegawai";
  if (balance < 0) return "Lebih, dikembalikan pegawai";
  return "Pas";
}
