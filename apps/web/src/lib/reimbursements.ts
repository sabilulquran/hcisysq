// REIMB-001 client. The API authorizes every call and owns every rule — categories, limits,
// totals, verification and payment; this module only shapes requests and labels states.
// Spec: docs/domain/reimbursement.md.

import type { Pagination } from "@/lib/loans";

export type { Pagination };
export { approverRoleLabel, formatRupiah, formatTimestamp, parseRupiahInput, todayInJakarta } from "@/lib/loans";

export type ClaimStatus = "DRAFT" | "IN_REVIEW" | "APPROVED" | "VERIFIED" | "PAID" | "REJECTED" | "CANCELLED";
export type CategoryKey = "TRANSPORT" | "ACCOMMODATION" | "MEALS" | "OPERATIONAL" | "OTHER";
export type PaymentMethod = "CASH" | "TRANSFER" | "PAYROLL";

export interface Category {
  key: CategoryKey;
  label: string;
  /** D-02 DRAFT per-item cap, whole rupiah; shown as guidance, enforced by the API. */
  maxPerItem: number;
}

export interface ClaimPolicy {
  minItemAmount: number;
  maxClaimTotal: number;
  maxItems: number;
  maxReceipts: number;
  maxExpenseAgeDays: number;
  maxOpenDrafts: number;
}

/** Amounts are whole rupiah as JSON integers; the API refuses anything else. */
export interface ClaimSummary {
  id: string;
  status: ClaimStatus;
  title: string;
  claimedTotal: number;
  verifiedTotal: number | null;
  createdAt: string;
  submittedAt: string | null;
  paidAt: string | null;
  businessTripId: string | null;
  tripDestination: string | null;
  itemCount: number;
  currentApproverName: string | null;
  employeeId?: string;
  employeeName?: string;
  employeeNumber?: string;
  unitName?: string | null;
}

export interface ClaimItem {
  id: string;
  lineNo: number;
  category: CategoryKey;
  categoryLabel: string;
  expenseDate: string;
  description: string;
  amount: number;
  approvedAmount?: number | null;
}

export interface ClaimReceipt {
  id: string;
  contentType: string;
  byteSize: number;
  createdAt: string;
  /** Register only (D-16): other live claims carrying the same file. */
  duplicateClaims?: number;
}

export interface ClaimStep {
  id: string;
  order: number;
  status: "waiting" | "pending" | "approved" | "rejected" | "cancelled";
  sources: string[];
  approverName: string;
  actedAt: string | null;
  decisionNote: string | null;
}

export interface ClaimEvent {
  id: string;
  eventType: string;
  occurredAt: string;
  note: string | null;
  metadata: Record<string, unknown>;
  actorName: string | null;
}

export interface ClaimPayment {
  id: string;
  amount: number;
  paidOn: string;
  method: PaymentMethod;
  payrollMonth: string | null;
  reference: string | null;
  note: string | null;
  recordedAt: string;
  recordedByName: string | null;
}

export interface ClaimDetail extends ClaimSummary {
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  unitName: string | null;
  tripStartOn: string | null;
  tripEndOn: string | null;
  tripStatus: string | null;
  verifiedAt?: string | null;
  verificationNote?: string | null;
  rejectedBy: "APPROVER" | "FINANCE" | null;
  rejectReason: string | null;
  cancelReason: string | null;
  items: ClaimItem[];
  receipts: ClaimReceipt[];
  steps: ClaimStep[];
  /** Absent in the approver view. */
  payment?: ClaimPayment | null;
  events?: ClaimEvent[];
}

export interface ClaimApprovalItem {
  stepId: string;
  claimId: string;
  sources: string[];
  requesterName: string;
  requesterNumber: string;
  unitName: string | null;
  title: string;
  claimedTotal: number;
  itemCount: number;
  receiptCount: number;
  tripDestination: string | null;
  submittedAt: string;
}

export interface LinkableTrip {
  id: string;
  destination: string;
  startOn: string;
  endOn: string;
  status: string;
}

export interface Claimant {
  id: string;
  fullName: string;
  employeeNumber: string;
  unitName: string | null;
}

export interface ClaimSummaryReport {
  from: string;
  to: string;
  byStatus: Array<{ status: ClaimStatus; claims: number; claimedTotal: number; verifiedTotal: number }>;
  byCategory: Array<{ category: CategoryKey; label: string; items: number; claimedTotal: number; verifiedTotal: number; paidTotal: number }>;
}

export interface DraftItemInput {
  category: CategoryKey;
  expenseDate: string;
  description: string;
  amount: number;
}

export interface DraftInput {
  title: string;
  businessTripId: string | null;
  items: DraftItemInput[];
}

export class ReimbursementApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "ReimbursementApiError";
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as T | { code?: string; message?: string } | null;
  if (!response.ok) {
    const problem = body as { code?: string; message?: string } | null;
    throw new ReimbursementApiError(response.status, problem?.code ?? "REIMBURSEMENT_FAILED", problem?.message ?? "Reimbursement tidak dapat diproses.");
  }
  return body as T;
}

async function get<T>(path: string) {
  return readJson<T>(await fetch(`/api${path}`, { credentials: "include", headers: { Accept: "application/json" } }));
}

async function send<T>(method: "POST" | "PUT" | "DELETE", path: string, payload?: unknown) {
  return readJson<T>(await fetch(`/api${path}`, {
    method,
    credentials: "include",
    headers: { Accept: "application/json", ...(payload === undefined ? {} : { "Content-Type": "application/json" }) },
    body: payload === undefined ? null : JSON.stringify(payload),
  }));
}

function query(params: Record<string, string | number | undefined | null>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : "";
}

// ---------------------------------------------------------------- employee

export const getMyClaims = (page = 1) =>
  get<{ items: ClaimSummary[]; pagination: Pagination; categories: Category[]; policy: ClaimPolicy }>(`/reimbursements/me${query({ page })}`);
export const getMyClaim = (id: string) => get<ClaimDetail>(`/reimbursements/me/${id}`);
export const getLinkableTrips = (page = 1) =>
  get<{ items: LinkableTrip[]; pagination: Pagination }>(`/reimbursements/me/trips${query({ page, pageSize: 50 })}`);
export const previewApprovers = () =>
  get<{ approvalChain: Array<{ employeeId: string; name: string; sources: string[] }> }>("/reimbursements/me/approvers");
export const createDraft = (input: DraftInput & { idempotencyKey: string }) =>
  send<{ id: string; status: ClaimStatus }>("POST", "/reimbursements/me", input);
export const updateDraft = (id: string, input: DraftInput) =>
  send<{ id: string; status: ClaimStatus }>("PUT", `/reimbursements/me/${id}`, input);
export const uploadReceipt = (id: string, file: { contentType: string; contentBase64: string }) =>
  send<{ id: string }>("POST", `/reimbursements/me/${id}/receipts`, file);
export const removeReceipt = (id: string, receiptId: string) =>
  send<{ removed: boolean }>("DELETE", `/reimbursements/me/${id}/receipts/${receiptId}`);
export const submitClaim = (id: string) => send<{ status: ClaimStatus }>("POST", `/reimbursements/me/${id}/submit`, {});
export const cancelMyClaim = (id: string, reason: string | null) =>
  send<{ status: ClaimStatus }>("POST", `/reimbursements/me/${id}/cancel`, { reason });
export const myReceiptHref = (id: string, receiptId: string) => `/api/reimbursements/me/${id}/receipts/${receiptId}`;

// ---------------------------------------------------------------- approver

export const getClaimApprovals = (page = 1) =>
  get<{ items: ClaimApprovalItem[]; pagination: Pagination }>(`/reimbursements/approvals${query({ page })}`);
export const getClaimForApprover = (stepId: string) => get<ClaimDetail>(`/reimbursements/approvals/${stepId}`);
export const decideClaimApproval = (stepId: string, decision: "approve" | "reject", note: string | null) =>
  send<{ claimStatus: ClaimStatus }>("POST", `/reimbursements/approvals/${stepId}/decision`, { decision, note });
export const approverReceiptHref = (stepId: string, receiptId: string) => `/api/reimbursements/approvals/${stepId}/receipts/${receiptId}`;

// ------------------------------------------------------------------- admin

export const getAdminClaims = (filter: {
  page?: number; status?: ClaimStatus | ""; category?: CategoryKey | ""; employeeId?: string | null; from?: string; to?: string;
}) => get<{ items: ClaimSummary[]; pagination: Pagination; categories: Category[] }>(`/admin/reimbursements${query({
  page: filter.page ?? 1, status: filter.status, category: filter.category, employeeId: filter.employeeId, from: filter.from, to: filter.to,
})}`);
export const getAdminClaim = (id: string) => get<ClaimDetail>(`/admin/reimbursements/${id}`);
export const searchClaimants = (q: string) =>
  get<{ items: Claimant[]; pagination: Pagination }>(`/admin/reimbursements/claimants${query({ q, pageSize: 20 })}`);
export const getClaimSummary = (from: string, to: string) =>
  get<ClaimSummaryReport>(`/admin/reimbursements/summary${query({ from, to })}`);
export const exportHref = (from: string, to: string, status?: ClaimStatus | "") =>
  `/api/admin/reimbursements/export.csv${query({ from, to, status })}`;
export const adminReceiptHref = (id: string, receiptId: string) => `/api/admin/reimbursements/${id}/receipts/${receiptId}`;
export const verifyClaim = (id: string, items: Array<{ itemId: string; approvedAmount: number }>, note: string | null) =>
  send<{ status: ClaimStatus; verifiedTotal: number }>("POST", `/admin/reimbursements/${id}/verify`, { items, note });
export const rejectClaimAsFinance = (id: string, reason: string) =>
  send<{ status: ClaimStatus }>("POST", `/admin/reimbursements/${id}/reject`, { reason });
export const payClaim = (id: string, input: {
  paidOn: string; method: "CASH" | "TRANSFER"; reference: string | null; note: string | null; idempotencyKey: string;
}) => send<{ status: ClaimStatus; amount: number }>("POST", `/admin/reimbursements/${id}/pay`, input);

// ------------------------------------------------------------------ labels

export const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  DRAFT: "Draf",
  IN_REVIEW: "Menunggu persetujuan",
  APPROVED: "Disetujui, menunggu verifikasi Keuangan",
  VERIFIED: "Diverifikasi, menunggu pembayaran",
  PAID: "Dibayar",
  REJECTED: "Ditolak",
  CANCELLED: "Dibatalkan",
};

export function claimStatusLabel(status: string) {
  return CLAIM_STATUS_LABELS[status as ClaimStatus] ?? status;
}

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: "Tunai",
  TRANSFER: "Transfer",
  PAYROLL: "Bersama gaji",
};

const EVENT_LABELS: Record<string, string> = {
  "reimbursement.draft.created": "Draf dibuat",
  "reimbursement.draft.updated": "Draf diubah",
  "reimbursement.receipt.added": "Bukti diunggah",
  "reimbursement.receipt.removed": "Bukti dihapus",
  "reimbursement.receipt.read": "Bukti dibuka",
  "reimbursement.request.submitted": "Dikirim",
  "reimbursement.approval.approved_step": "Tahap disetujui",
  "reimbursement.request.approved": "Disetujui seluruhnya",
  "reimbursement.request.rejected": "Ditolak penyetuju",
  "reimbursement.request.cancelled": "Dibatalkan",
  "reimbursement.verified": "Diverifikasi Keuangan",
  "reimbursement.finance.rejected": "Ditolak Keuangan",
  "reimbursement.paid": "Dibayar",
};

export function claimEventLabel(eventType: string) {
  return EVENT_LABELS[eventType] ?? eventType;
}

export function formatClaimDate(value: string) {
  return new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Jakarta" })
    .format(new Date(`${value}T00:00:00+07:00`));
}

export const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;
const RECEIPT_TYPES = ["application/pdf", "image/jpeg", "image/png"];
export const RECEIPT_ACCEPT = ".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png";

/** Reads a picked file into the JSON shape the API takes; the API re-checks size and content. */
export async function readReceiptFile(file: File): Promise<{ contentType: string; contentBase64: string }> {
  if (!RECEIPT_TYPES.includes(file.type)) throw new Error("Bukti harus PDF, JPG, atau PNG.");
  if (file.size > MAX_RECEIPT_BYTES) throw new Error("Bukti maksimal 4 MB per berkas.");
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Berkas tidak dapat dibaca."));
    reader.readAsDataURL(file);
  });
  return { contentType: file.type, contentBase64: dataUrl.slice(dataUrl.indexOf(",") + 1) };
}

/** First day of the Jakarta month for `date` (YYYY-MM-DD). */
export function monthStart(date: string) {
  return `${date.slice(0, 7)}-01`;
}
