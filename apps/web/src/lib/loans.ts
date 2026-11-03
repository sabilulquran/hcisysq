// LOAN-001 client. The API authorizes every call and owns every rule — limits, the schedule,
// balances; this module only shapes requests, reads rupiah input and labels states.
// Spec: docs/domain/employee-loans.md.

export type LoanStatus = "IN_REVIEW" | "APPROVED" | "REJECTED" | "CANCELLED" | "DISBURSED" | "PAID_OFF";
export type LoanPaymentMethod = "CASH" | "TRANSFER" | "PAYROLL_DEDUCTION";

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

/** Amounts are whole rupiah as JSON integers; the API refuses anything else. */
export interface LoanSummary {
  id: string;
  status: LoanStatus;
  tenorMonths: number;
  purpose: string;
  principal: number;
  paidTotal: number;
  outstanding: number;
  submittedAt: string;
  finalDecidedAt: string | null;
  disbursedOn: string | null;
  firstDueMonth: string | null;
  currentApproverName: string | null;
  employeeId?: string;
  employeeName?: string;
  employeeNumber?: string;
  unitName?: string | null;
}

export interface LoanStep {
  id: string;
  order: number;
  status: "waiting" | "pending" | "approved" | "rejected" | "cancelled";
  sources: string[];
  approverName: string;
  actedAt: string | null;
  decisionNote: string | null;
}

export interface LoanEvent {
  id: string;
  eventType: string;
  occurredAt: string;
  note: string | null;
  metadata: Record<string, unknown>;
  actorName: string | null;
}

export interface LoanInstalment {
  sequence: number;
  dueMonth: string;
  amount: number;
  paid: number;
  state: "PAID" | "PARTIAL" | "UNPAID";
  overdue: boolean;
}

export interface LoanPayment {
  id: string;
  amount: number;
  paidOn: string;
  method: LoanPaymentMethod;
  reference: string | null;
  note: string | null;
  status: "ACTIVE" | "REVERSED";
  recordedAt: string;
  recordedByName: string | null;
  reversedAt: string | null;
  reverseReason: string | null;
}

export interface LoanDetail extends LoanSummary {
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  unitName: string | null;
  cancelReason: string | null;
  disbursementMethod: "CASH" | "TRANSFER" | null;
  disbursementReference: string | null;
  paidOffAt: string | null;
  schedule: LoanInstalment[];
  payments: LoanPayment[];
  steps: LoanStep[];
  events: LoanEvent[];
}

export interface LoanApprovalItem {
  stepId: string;
  loanId: string;
  sources: string[];
  requesterName: string;
  requesterNumber: string;
  unitName: string | null;
  purpose: string;
  tenorMonths: number;
  principal: number;
  submittedAt: string;
}

export interface LoanPreview {
  schedule: Array<{ sequence: number; dueMonth: string; amount: number }>;
  approvalChain: Array<{ employeeId: string; name: string; sources: string[] }>;
}

export interface LoanBorrower {
  id: string;
  fullName: string;
  employeeNumber: string;
  unitName: string | null;
}

export class LoanApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "LoanApiError";
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as T | { code?: string; message?: string } | null;
  if (!response.ok) {
    const problem = body as { code?: string; message?: string } | null;
    throw new LoanApiError(response.status, problem?.code ?? "LOAN_FAILED", problem?.message ?? "Pinjaman tidak dapat diproses.");
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

export const getMyLoans = (page = 1) =>
  get<{ items: LoanSummary[]; pagination: Pagination }>(`/loans/me${query({ page })}`);
export const getMyLoan = (id: string) => get<LoanDetail>(`/loans/me/${id}`);
export const previewLoan = (principal: number, tenorMonths: number) =>
  post<LoanPreview>("/loans/me/preview", { principal, tenorMonths });
export const submitLoan = (input: { principal: number; tenorMonths: number; purpose: string; idempotencyKey: string }) =>
  post<{ id: string; status: LoanStatus }>("/loans/me", input);
export const cancelMyLoan = (id: string, reason: string) => post<{ id: string; status: LoanStatus }>(`/loans/me/${id}/cancel`, { reason });

export const getLoanApprovals = (page = 1) =>
  get<{ items: LoanApprovalItem[]; pagination: Pagination }>(`/loans/approvals${query({ page })}`);
export const decideLoanApproval = (stepId: string, decision: "approve" | "reject", note: string | null) =>
  post<{ loanStatus: LoanStatus }>(`/loans/approvals/${stepId}/decision`, { decision, note });

export const getAdminLoans = (filter: { page?: number; status?: LoanStatus | ""; employeeId?: string | null }) =>
  get<{ items: LoanSummary[]; pagination: Pagination }>(`/admin/loans${query({ page: filter.page ?? 1, status: filter.status, employeeId: filter.employeeId })}`);
export const getAdminLoan = (id: string) => get<LoanDetail>(`/admin/loans/${id}`);
export const searchLoanBorrowers = (q: string) =>
  get<{ items: LoanBorrower[]; pagination: Pagination }>(`/admin/loans/borrowers${query({ q, pageSize: 20 })}`);
export const disburseLoan = (id: string, input: { disbursedOn: string; method: "CASH" | "TRANSFER"; reference: string | null; firstDueMonth: string | null }) =>
  post<{ firstDueMonth: string }>(`/admin/loans/${id}/disburse`, input);
export const recordLoanPayment = (id: string, input: {
  amount: number; paidOn: string; method: LoanPaymentMethod; reference: string | null; note: string | null; idempotencyKey: string;
}) => post<{ status: LoanStatus }>(`/admin/loans/${id}/payments`, input);
export const reverseLoanPayment = (id: string, paymentId: string, reason: string) =>
  post<{ status: LoanStatus }>(`/admin/loans/${id}/payments/${paymentId}/reverse`, { reason });
export const cancelLoanAsFinance = (id: string, reason: string) =>
  post<{ id: string; status: LoanStatus }>(`/admin/loans/${id}/cancel`, { reason });

/** D-04 DRAFT: the tenors the form offers. The API is the authority and refuses others. */
export const TENOR_OPTIONS = [3, 6, 12] as const;

/**
 * Reads what a person typed as rupiah ("1.500.000", "Rp 1500000") into a whole number, or
 * null. Plain digits, or digits grouped by dots in threes; anything else — a comma, a decimal
 * point such as "50000.00", a stray dot — is refused rather than guessed, so "50000.00" never
 * becomes five million and no amount passes through floating-point arithmetic.
 */
export function parseRupiahInput(text: string): number | null {
  const cleaned = text.trim().replace(/^rp\.?\s*/i, "");
  if (!/^\d{1,13}$/.test(cleaned) && !/^\d{1,3}(\.\d{3}){1,4}$/.test(cleaned)) return null;
  const value = Number(cleaned.replace(/\./g, ""));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function formatRupiah(amount: number) {
  return `Rp${new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 }).format(amount)}`;
}

export const LOAN_STATUS_LABELS: Record<LoanStatus, string> = {
  IN_REVIEW: "Menunggu persetujuan",
  APPROVED: "Disetujui, menunggu pencairan",
  REJECTED: "Ditolak",
  CANCELLED: "Dibatalkan",
  DISBURSED: "Berjalan",
  PAID_OFF: "Lunas",
};

export function loanStatusLabel(status: string) {
  return LOAN_STATUS_LABELS[status as LoanStatus] ?? status;
}

export const PAYMENT_METHOD_LABELS: Record<LoanPaymentMethod, string> = {
  CASH: "Tunai",
  TRANSFER: "Transfer",
  PAYROLL_DEDUCTION: "Potong gaji (dicatat manual)",
};

const EVENT_LABELS: Record<string, string> = {
  "loan.request.submitted": "Diajukan",
  "loan.approval.approved_step": "Tahap disetujui",
  "loan.request.approved": "Disetujui seluruhnya",
  "loan.request.rejected": "Ditolak",
  "loan.request.cancelled": "Dibatalkan",
  "loan.disbursed": "Dicairkan",
  "loan.payment.recorded": "Pembayaran dicatat",
  "loan.payment.reversed": "Pembayaran dikoreksi",
  "loan.paid_off": "Lunas",
};

export function loanEventLabel(eventType: string) {
  return EVENT_LABELS[eventType] ?? eventType;
}

export function approverRoleLabel(sources: string[]) {
  const labels = [
    sources.includes("DIRECT_MANAGER") ? "Atasan langsung" : null,
    sources.includes("UNIT_APPROVER") ? "Approver unit" : null,
  ].filter(Boolean);
  return labels.join(" + ") || "Approver";
}

export function formatLoanMonth(month: string) {
  return new Intl.DateTimeFormat("id-ID", { month: "long", year: "numeric", timeZone: "Asia/Jakarta" })
    .format(new Date(`${month}-01T00:00:00+07:00`));
}

export function formatLoanDate(value: string) {
  return new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Jakarta" })
    .format(new Date(`${value}T00:00:00+07:00`));
}

export function formatTimestamp(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" }).format(new Date(value));
}

/** `YYYY-MM-DD` in Asia/Jakarta, so a form opened before 07:00 WIB does not default to yesterday. */
export function todayInJakarta() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
