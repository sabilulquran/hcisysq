// LOAN-001 Package 1 rules: amounts, eligibility, instalment schedule, repayment, states.
// No database, no HTTP. Spec: docs/domain/employee-loans.md.
//
// Money is whole rupiah. Every calculation here runs on bigint, so no amount ever passes
// through floating point (roadmap anti-copy guardrail); callers convert at the edge.

export const LOAN_STATUSES = ["IN_REVIEW", "APPROVED", "REJECTED", "CANCELLED", "DISBURSED", "PAID_OFF"] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];

export const PAYMENT_METHODS = ["CASH", "TRANSFER", "PAYROLL_DEDUCTION"] as const;
export type LoanPaymentMethod = (typeof PAYMENT_METHODS)[number];

export const DISBURSEMENT_METHODS = ["CASH", "TRANSFER"] as const;
export type LoanDisbursementMethod = (typeof DISBURSEMENT_METHODS)[number];

/** D-03 DRAFT: smallest and largest principal, whole rupiah. */
export const MIN_PRINCIPAL = 100_000n;
export const MAX_PRINCIPAL = 10_000_000n;
/** D-04 DRAFT: tenor in monthly instalments, the three choices legacy HCIS offered. */
export const TENOR_OPTIONS = [3, 6, 12] as const;
/** D-07 DRAFT: instalments are rounded down to this unit; the last one carries the remainder. */
export const INSTALMENT_ROUNDING = 1_000n;

/** D-06: a loan in one of these states blocks another request by the same employee. */
export const OPEN_LOAN_STATUSES: readonly LoanStatus[] = ["IN_REVIEW", "APPROVED", "DISBURSED"];

export type LoanPolicyCode =
  | "LOAN_PRINCIPAL_OUT_OF_RANGE"
  | "LOAN_TENOR_OUT_OF_RANGE"
  | "LOAN_INVALID_MONTH"
  | "LOAN_FIRST_DUE_TOO_EARLY"
  | "LOAN_DISBURSED_IN_FUTURE"
  | "LOAN_PAYMENT_EXCEEDS_BALANCE"
  | "LOAN_PAYMENT_NOT_POSITIVE";

export class LoanPolicyError extends Error {
  constructor(readonly code: LoanPolicyCode, message: string) {
    super(message);
    this.name = "LoanPolicyError";
  }
}

/** Indonesian thousands grouping, digits only: 1500000n -> "Rp1.500.000". Never floats. */
export function formatRupiah(amount: bigint): string {
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}Rp${digits}`;
}

/**
 * Reads an amount from the database or the wire. pg returns bigint columns as strings; the
 * API accepts JSON integers. Anything that is not a whole number is refused, never rounded.
 */
export function toRupiah(value: string | number | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new RangeError("amount is not a safe whole number");
    return BigInt(value);
  }
  if (!/^-?\d+$/.test(value)) throw new RangeError("amount is not a whole number");
  return BigInt(value);
}

/** For JSON responses. The database caps every amount far below 2^53 (CHECK constraints). */
export function rupiahToJson(amount: bigint): number {
  const value = Number(amount);
  if (!Number.isSafeInteger(value)) throw new RangeError("amount exceeds the JSON-safe range");
  return value;
}

/** True only for a real calendar date written `YYYY-MM-DD` (rejects 2026-02-30). */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** `YYYY-MM` with a month from 01 to 12. */
export function isMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

export function addMonths(month: string, count: number): string {
  const [year, monthNumber] = month.split("-").map(Number) as [number, number];
  const index = year * 12 + (monthNumber - 1) + count;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** D-03 and D-04. */
export function validateLoanTerms(input: { principal: bigint; tenorMonths: number }): void {
  if (input.principal < MIN_PRINCIPAL || input.principal > MAX_PRINCIPAL) {
    throw new LoanPolicyError(
      "LOAN_PRINCIPAL_OUT_OF_RANGE",
      `Pokok pinjaman antara ${formatRupiah(MIN_PRINCIPAL)} dan ${formatRupiah(MAX_PRINCIPAL)}.`,
    );
  }
  if (!(TENOR_OPTIONS as readonly number[]).includes(input.tenorMonths)) {
    throw new LoanPolicyError("LOAN_TENOR_OUT_OF_RANGE", `Lama cicilan ${TENOR_OPTIONS.join(", ")} bulan.`);
  }
}

export interface ScheduledInstalment {
  sequence: number;
  dueMonth: string;
  amount: bigint;
}

/**
 * D-07: equal monthly instalments, no interest (D-02). Each one is the principal divided by
 * the tenor, rounded down to Rp1.000; the last carries the remainder, so the schedule always
 * sums to the principal exactly. If the rounding unit would swallow the whole share, the
 * share is rounded down to the rupiah instead.
 */
export function buildInstalmentSchedule(input: {
  principal: bigint;
  tenorMonths: number;
  firstDueMonth: string;
}): ScheduledInstalment[] {
  const tenor = BigInt(input.tenorMonths);
  const share = input.principal / tenor;
  const rounded = (share / INSTALMENT_ROUNDING) * INSTALMENT_ROUNDING;
  const base = rounded > 0n ? rounded : share;
  const last = input.principal - base * (tenor - 1n);
  return Array.from({ length: input.tenorMonths }, (_, index) => ({
    sequence: index + 1,
    dueMonth: addMonths(input.firstDueMonth, index),
    amount: index === input.tenorMonths - 1 ? last : base,
  }));
}

/**
 * D-09: disbursement date no later than today; first instalment no earlier than the month
 * after disbursement. Without an explicit month the first instalment falls in that next month.
 */
export function resolveFirstDueMonth(input: { disbursedOn: string; firstDueMonth?: string | null; today: string }): string {
  if (!isCalendarDate(input.disbursedOn)) {
    throw new LoanPolicyError("LOAN_INVALID_MONTH", "Tanggal pencairan tidak valid.");
  }
  if (input.disbursedOn > input.today) {
    throw new LoanPolicyError("LOAN_DISBURSED_IN_FUTURE", "Tanggal pencairan tidak boleh setelah hari ini.");
  }
  const earliest = addMonths(input.disbursedOn.slice(0, 7), 1);
  const month = input.firstDueMonth ?? earliest;
  if (!isMonth(month)) throw new LoanPolicyError("LOAN_INVALID_MONTH", "Bulan cicilan pertama tidak valid.");
  if (month < earliest) {
    throw new LoanPolicyError("LOAN_FIRST_DUE_TOO_EARLY", "Cicilan pertama paling cepat bulan setelah pencairan.");
  }
  return month;
}

export type InstalmentState = "PAID" | "PARTIAL" | "UNPAID";

export interface InstalmentStanding {
  sequence: number;
  dueMonth: string;
  amount: bigint;
  paid: bigint;
  state: InstalmentState;
  overdue: boolean;
}

/**
 * D-11: payments fill instalments oldest first. Because the fill is cumulative, what each
 * instalment has received depends only on the total of the payments still in force, so a
 * reversal needs no stored allocation: the standing is recomputed from the new total.
 */
export function instalmentStanding(
  schedule: ReadonlyArray<{ sequence: number; dueMonth: string; amount: bigint }>,
  paidTotal: bigint,
  currentMonth: string,
): InstalmentStanding[] {
  let remaining = paidTotal;
  return [...schedule]
    .sort((left, right) => left.sequence - right.sequence)
    .map((instalment) => {
      const paid = remaining >= instalment.amount ? instalment.amount : remaining > 0n ? remaining : 0n;
      remaining -= paid;
      const state: InstalmentState = paid === instalment.amount ? "PAID" : paid > 0n ? "PARTIAL" : "UNPAID";
      return { ...instalment, paid, state, overdue: state !== "PAID" && instalment.dueMonth < currentMonth };
    });
}

/** D-10: a payment is positive and never more than the balance it pays down. */
export function assertPaymentFits(amount: bigint, outstanding: bigint): void {
  if (amount <= 0n) throw new LoanPolicyError("LOAN_PAYMENT_NOT_POSITIVE", "Jumlah pembayaran harus lebih dari nol.");
  if (amount > outstanding) {
    throw new LoanPolicyError("LOAN_PAYMENT_EXCEEDS_BALANCE", "Jumlah pembayaran melebihi sisa pinjaman.");
  }
}

/** The state a disbursed loan takes once its in-force payments total `paidTotal`. */
export function repaymentStatus(principal: bigint, paidTotal: bigint): "DISBURSED" | "PAID_OFF" {
  return paidTotal === principal ? "PAID_OFF" : "DISBURSED";
}

export type LoanCanceller = "employee" | "finance";

/** D-08: cancellation only before money changes hands. */
export function canCancelLoan(status: LoanStatus): boolean {
  return status === "IN_REVIEW" || status === "APPROVED";
}

/** APR-001 vocabulary used by the shared approval decision rule. */
export function approvalRequestStatus(status: LoanStatus): "in_review" | "approved" | "rejected" | "cancelled" {
  if (status === "IN_REVIEW") return "in_review";
  if (status === "REJECTED") return "rejected";
  if (status === "CANCELLED") return "cancelled";
  return "approved";
}
