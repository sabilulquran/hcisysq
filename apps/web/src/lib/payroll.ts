// PAY-003 payroll client. The screens read and show; every rule about who may do
// what, and what an amount is, stays on the server (AGENTS.md section 4).

export type PayrollPeriodState =
  | "DRAFT"
  | "COLLECTING"
  | "CALCULATED"
  | "SUBMITTED"
  | "APPROVED"
  | "PAYMENT_CONFIRMED"
  | "PUBLISHED"
  | "REOPEN_REQUESTED";

export type PayrollPeriodAction =
  | "start_collecting"
  | "calculate"
  | "submit"
  | "return"
  | "approve"
  | "confirm_payment"
  | "publish"
  | "request_reopen"
  | "approve_reopen"
  | "reject_reopen";

export interface PayrollPeriod {
  id: string;
  legalEntityKey: string | null;
  periodMonth: string;
  payDate: string;
  periodStart: string;
  periodEnd: string;
  cutoffStart: string;
  cutoffEnd: string;
  state: PayrollPeriodState;
  stateBeforeReopenRequest: string | null;
  submittedByAccountId: string | null;
  submittedAt: string | null;
  approvedByAccountId: string | null;
  approvedAt: string | null;
  paymentConfirmedAt: string | null;
  publishedAt: string | null;
  reopenCount: number;
  version: number;
  resultCount: number;
  blockerCount: number;
  inputCount: number;
  hasCurrentCalculation: boolean;
  availableActions: PayrollPeriodAction[];
}

export interface PayrollPeriodTransition {
  action: string;
  fromState: string;
  toState: string;
  reason: string | null;
  actorAccountId: string | null;
  occurredAt: string;
}

export interface PayrollBlocker {
  code: string;
  message: string;
}

export interface PayrollResult {
  employmentId: string;
  revision: number;
  gross: string;
  deductions: string;
  net: string;
  payable: string;
  employerCost: string;
  payFactor: string;
  payFactorReason: "none" | "proration" | "early_service";
  bpjsBase: string;
  blockers: PayrollBlocker[];
  calculatedAt: string;
}

export interface PayrollResultLine {
  employmentId: string;
  componentCode: string;
  category: "EARNING" | "DEDUCTION" | "EMPLOYER_COST";
  amount: string;
  basis: string | null;
  displayOrder: number;
}

export interface PayrollReport {
  totals: {
    employeeCount: number;
    gross: string;
    deductions: string;
    net: string;
    payable: string;
    employerCost: string;
    blockerCount: number;
  };
  byUnit: Array<{ unitRef: string | null; employeeCount: number; payable: string }>;
  byComponent: Array<{
    componentCode: string;
    category: string;
    employeeCount: number;
    amount: string;
  }>;
}

export interface PayrollTransferRow {
  employeeNumber: string;
  fullName: string;
  unitRef: string | null;
  payable: string;
  bankName: string | null;
  bankAccountNumber: string | null;
  bankAccountName: string | null;
  paymentConfirmedAt: string | null;
}

export interface PayrollVarianceRow {
  employmentId: string;
  componentCode: string | null;
  previousAmount: string;
  currentAmount: string;
  delta: string;
  kind: "COMPONENT" | "NEW_EMPLOYEE" | "LEAVING_EMPLOYEE" | "LARGE_MANUAL_INPUT";
}

export class PayrollApiError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "PayrollApiError";
    this.code = code;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    ...init,
    ...(init?.body === undefined ? {} : { headers: { "Content-Type": "application/json", ...init.headers } }),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { message?: string; code?: string }
      | null;
    throw new PayrollApiError(
      payload?.message ?? "Permintaan payroll gagal diproses.",
      payload?.code ?? "PAYROLL_REQUEST_FAILED",
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function listPayrollPeriods(query: { page?: number; pageSize?: number } = {}) {
  const params = new URLSearchParams();
  if (query.page) params.set("page", String(query.page));
  if (query.pageSize) params.set("pageSize", String(query.pageSize));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return request<{ page: number; pageSize: number; periods: PayrollPeriod[] }>(
    `/api/payroll/periods${suffix}`,
  );
}

export function createPayrollPeriod(body: {
  periodMonth: string;
  payDate?: string;
  cutoffStart?: string;
  cutoffEnd?: string;
}) {
  return request<{ period: PayrollPeriod }>("/api/payroll/periods", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getPayrollPeriod(periodId: string) {
  return request<{ period: PayrollPeriod; transitions: PayrollPeriodTransition[] }>(
    `/api/payroll/periods/${encodeURIComponent(periodId)}`,
  );
}

export function transitionPayrollPeriod(
  periodId: string,
  action: PayrollPeriodAction,
  reason?: string,
) {
  return request<{ period: PayrollPeriod; applied: boolean }>(
    `/api/payroll/periods/${encodeURIComponent(periodId)}/transitions`,
    { method: "POST", body: JSON.stringify(reason ? { action, reason } : { action }) },
  );
}

export function resolvePayrollAttendanceInputs(periodId: string) {
  return request<{
    overtimeCount: number;
    attendanceCount: number;
    clearedCount: number;
    skippedOwnCount: number;
  }>(`/api/payroll/periods/${encodeURIComponent(periodId)}/inputs/from-attendance`, {
    method: "POST",
  });
}

export function getPayrollResults(periodId: string) {
  return request<{ results: PayrollResult[]; lines: PayrollResultLine[] }>(
    `/api/payroll/periods/${encodeURIComponent(periodId)}/results`,
  );
}

export function getPayrollReport(periodId: string) {
  return request<{ report: PayrollReport }>(
    `/api/payroll/periods/${encodeURIComponent(periodId)}/report`,
  );
}

export function getPayrollVariance(periodId: string) {
  return request<{
    previousPeriodId: string | null;
    threshold: { relative: number; absolute: number; manualInput: number } | null;
    variances: PayrollVarianceRow[];
  }>(`/api/payroll/periods/${encodeURIComponent(periodId)}/variance`);
}

export function getPayrollTransfers(periodId: string) {
  return request<{ transfers: PayrollTransferRow[] }>(
    `/api/payroll/periods/${encodeURIComponent(periodId)}/transfers`,
  );
}

/** The CSV the server builds, so the file a bank sees is the server's, not the browser's. */
export function payrollTransfersCsvUrl(periodId: string) {
  return `/api/payroll/periods/${encodeURIComponent(periodId)}/transfers?format=csv`;
}

export function draftPayrollPayslips(periodId: string) {
  return request<{
    drafted: number;
    revised: number;
    alreadyCurrent: number;
    importConflicts: string[];
  }>(`/api/payroll/periods/${encodeURIComponent(periodId)}/payslips`, { method: "POST" });
}

export function publishPayrollPayslips(periodId: string) {
  return request<{ published: number }>(
    `/api/payroll/periods/${encodeURIComponent(periodId)}/payslips/publish`,
    { method: "POST" },
  );
}

const STATE_LABELS: Record<PayrollPeriodState, string> = {
  DRAFT: "Draft",
  COLLECTING: "Pengumpulan input",
  CALCULATED: "Sudah dihitung",
  SUBMITTED: "Diajukan",
  APPROVED: "Disahkan",
  PAYMENT_CONFIRMED: "Pembayaran dikonfirmasi",
  PUBLISHED: "Slip terbit",
  REOPEN_REQUESTED: "Menunggu keputusan buka ulang",
};

export function payrollStateLabel(state: PayrollPeriodState): string {
  return STATE_LABELS[state] ?? state;
}

const ACTION_LABELS: Record<PayrollPeriodAction, string> = {
  start_collecting: "Mulai kumpulkan input",
  calculate: "Hitung periode",
  submit: "Ajukan untuk pengesahan",
  return: "Kembalikan ke HC",
  approve: "Sahkan periode",
  confirm_payment: "Konfirmasi pembayaran",
  publish: "Tandai periode terbit",
  request_reopen: "Minta buka ulang",
  approve_reopen: "Setujui buka ulang",
  reject_reopen: "Tolak buka ulang",
};

export function payrollActionLabel(action: PayrollPeriodAction): string {
  return ACTION_LABELS[action] ?? action;
}

/** The three actions the specification requires a reason for (section 6). */
export function payrollActionNeedsReason(action: PayrollPeriodAction): boolean {
  return action === "return" || action === "request_reopen" || action === "reject_reopen";
}

/**
 * Amounts arrive as strings because they are exact rupiah the server computed.
 * The screen only groups the thousands; it never does arithmetic on them.
 */
export function formatRupiah(amount: string): string {
  const negative = amount.trim().startsWith("-");
  const digits = amount.replace(/[^0-9]/g, "");
  if (digits.length === 0) return amount;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}Rp${grouped}`;
}
