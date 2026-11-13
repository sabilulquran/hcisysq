// REIMB-001 Package 1 rules: categories and limits, claim validation, verification, payment,
// states. No database, no HTTP. Spec: docs/domain/reimbursement.md.
//
// Money is whole rupiah and every calculation here runs on bigint, so no amount passes through
// floating point; callers convert at the edge (D-15).

import { formatRupiah, isCalendarDate, isMonth, rupiahToJson, toRupiah } from "../loans/domain.js";

export { formatRupiah, isCalendarDate, isMonth, rupiahToJson, toRupiah };

export const CLAIM_STATUSES = ["DRAFT", "IN_REVIEW", "APPROVED", "VERIFIED", "PAID", "REJECTED", "CANCELLED"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const CATEGORY_KEYS = ["TRANSPORT", "ACCOMMODATION", "MEALS", "OPERATIONAL", "OTHER"] as const;
export type CategoryKey = (typeof CATEGORY_KEYS)[number];

/** D-02 DRAFT: the catalog the form shows; the per-item cap is whole rupiah. */
export const CATEGORIES: Record<CategoryKey, { label: string; maxPerItem: bigint }> = {
  TRANSPORT: { label: "Transportasi", maxPerItem: 3_000_000n },
  ACCOMMODATION: { label: "Akomodasi", maxPerItem: 2_000_000n },
  MEALS: { label: "Konsumsi", maxPerItem: 1_000_000n },
  OPERATIONAL: { label: "Operasional / perlengkapan kerja", maxPerItem: 2_000_000n },
  OTHER: { label: "Lainnya", maxPerItem: 1_000_000n },
};

/** D-03 DRAFT. */
export const MIN_ITEM_AMOUNT = 1_000n;
export const MAX_CLAIM_TOTAL = 10_000_000n;
export const MAX_ITEMS = 10;
/** D-04 DRAFT: the oldest expense date accepted at submission, in days before today. */
export const MAX_EXPENSE_AGE_DAYS = 90;
/** D-05 DRAFT. */
export const MAX_RECEIPTS = 10;
/** D-07 DRAFT. */
export const MAX_OPEN_DRAFTS = 5;

export const PAYMENT_METHODS = ["CASH", "TRANSFER", "PAYROLL"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** D-06: trips a claim may be linked to. */
export const LINKABLE_TRIP_STATUSES = ["APPROVED", "ISSUED", "COMPLETED"] as const;

/** D-17 DRAFT. */
export const MAX_EXPORT_DAYS = 366;
export const MAX_EXPORT_ROWS = 20_000;

export type ReimbursementPolicyCode =
  | "REIMBURSEMENT_UNKNOWN_CATEGORY"
  | "REIMBURSEMENT_ITEM_COUNT"
  | "REIMBURSEMENT_ITEM_BELOW_MINIMUM"
  | "REIMBURSEMENT_ITEM_ABOVE_LIMIT"
  | "REIMBURSEMENT_TOTAL_ABOVE_LIMIT"
  | "REIMBURSEMENT_INVALID_DATE"
  | "REIMBURSEMENT_EXPENSE_IN_FUTURE"
  | "REIMBURSEMENT_EXPENSE_TOO_OLD"
  | "REIMBURSEMENT_ITEMS_MISMATCH"
  | "REIMBURSEMENT_APPROVED_EXCEEDS_CLAIM"
  | "REIMBURSEMENT_REDUCTION_NOTE_REQUIRED"
  | "REIMBURSEMENT_NOTHING_APPROVED"
  | "REIMBURSEMENT_PAYMENT_DATE"
  | "REIMBURSEMENT_PAYROLL_HANDOFF_DISABLED"
  | "REIMBURSEMENT_PAYROLL_MONTH_REQUIRED";

export class ReimbursementPolicyError extends Error {
  constructor(readonly code: ReimbursementPolicyCode, message: string) {
    super(message);
    this.name = "ReimbursementPolicyError";
  }
}

export interface ItemInput {
  category: string;
  expenseDate: string;
  description: string;
  amount: bigint;
}

const DAY_MS = 86_400_000;

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function isCategory(value: string): value is CategoryKey {
  return (CATEGORY_KEYS as readonly string[]).includes(value);
}

/**
 * D-02, D-03 and the part of D-04 that never changes with time (no future dates). Returns the
 * claimed total. Runs on every draft save and again at submission.
 */
export function validateItems(items: readonly ItemInput[], today: string): bigint {
  if (items.length < 1 || items.length > MAX_ITEMS) {
    throw new ReimbursementPolicyError("REIMBURSEMENT_ITEM_COUNT", `Satu klaim berisi 1 sampai ${MAX_ITEMS} baris biaya.`);
  }
  let total = 0n;
  for (const item of items) {
    if (!isCategory(item.category)) {
      throw new ReimbursementPolicyError("REIMBURSEMENT_UNKNOWN_CATEGORY", "Kategori biaya tidak dikenal.");
    }
    if (!isCalendarDate(item.expenseDate)) {
      throw new ReimbursementPolicyError("REIMBURSEMENT_INVALID_DATE", "Tanggal biaya tidak valid.");
    }
    if (item.expenseDate > today) {
      throw new ReimbursementPolicyError("REIMBURSEMENT_EXPENSE_IN_FUTURE", "Tanggal biaya tidak boleh setelah hari ini.");
    }
    if (item.amount < MIN_ITEM_AMOUNT) {
      throw new ReimbursementPolicyError(
        "REIMBURSEMENT_ITEM_BELOW_MINIMUM", `Nominal setiap baris paling sedikit ${formatRupiah(MIN_ITEM_AMOUNT)}.`,
      );
    }
    const category = CATEGORIES[item.category];
    if (item.amount > category.maxPerItem) {
      throw new ReimbursementPolicyError(
        "REIMBURSEMENT_ITEM_ABOVE_LIMIT",
        `Batas ${category.label} ${formatRupiah(category.maxPerItem)} per baris.`,
      );
    }
    total += item.amount;
  }
  if (total > MAX_CLAIM_TOTAL) {
    throw new ReimbursementPolicyError(
      "REIMBURSEMENT_TOTAL_ABOVE_LIMIT", `Total satu klaim paling banyak ${formatRupiah(MAX_CLAIM_TOTAL)}.`,
    );
  }
  return total;
}

/** D-04: at submission no expense may be older than MAX_EXPENSE_AGE_DAYS. */
export function assertExpensesFresh(items: ReadonlyArray<{ expenseDate: string }>, today: string): void {
  const oldest = addDays(today, -MAX_EXPENSE_AGE_DAYS);
  if (items.some((item) => item.expenseDate < oldest)) {
    throw new ReimbursementPolicyError(
      "REIMBURSEMENT_EXPENSE_TOO_OLD", `Biaya paling lama ${MAX_EXPENSE_AGE_DAYS} hari sebelum klaim dikirim.`,
    );
  }
}

/**
 * D-09: every item exactly once, each approved amount between zero and its claim, a note when
 * anything was cut, and something left to pay. Returns the verified total and how many items
 * were reduced.
 */
export function verifyAmounts(
  items: ReadonlyArray<{ id: string; amount: bigint }>,
  decisions: ReadonlyArray<{ itemId: string; approvedAmount: bigint }>,
  note: string | null,
): { total: bigint; reduced: number; approved: Map<string, bigint> } {
  const approved = new Map<string, bigint>();
  for (const decision of decisions) {
    if (approved.has(decision.itemId)) {
      throw new ReimbursementPolicyError("REIMBURSEMENT_ITEMS_MISMATCH", "Setiap baris biaya diputuskan tepat satu kali.");
    }
    approved.set(decision.itemId, decision.approvedAmount);
  }
  if (approved.size !== items.length || items.some((item) => !approved.has(item.id))) {
    throw new ReimbursementPolicyError("REIMBURSEMENT_ITEMS_MISMATCH", "Setiap baris biaya diputuskan tepat satu kali.");
  }
  let total = 0n;
  let reduced = 0;
  for (const item of items) {
    const value = approved.get(item.id)!;
    if (value < 0n || value > item.amount) {
      throw new ReimbursementPolicyError(
        "REIMBURSEMENT_APPROVED_EXCEEDS_CLAIM", "Nominal disetujui antara nol dan nominal yang diklaim.",
      );
    }
    if (value < item.amount) reduced += 1;
    total += value;
  }
  if (reduced > 0 && (!note || note.trim().length < 10)) {
    throw new ReimbursementPolicyError(
      "REIMBURSEMENT_REDUCTION_NOTE_REQUIRED", "Tulis alasan (minimal 10 karakter) bila ada nominal yang dikurangi.",
    );
  }
  if (total === 0n) {
    throw new ReimbursementPolicyError(
      "REIMBURSEMENT_NOTHING_APPROVED", "Tidak ada nominal yang disetujui. Tolak klaim ini dengan alasannya.",
    );
  }
  return { total, reduced, approved };
}

/** D-10, D-11: the date window and the payroll switch. */
export function validatePayment(input: {
  paidOn: string;
  verifiedOn: string;
  today: string;
  method: PaymentMethod;
  payrollMonth: string | null;
  payrollHandoffEnabled: boolean;
}): void {
  if (input.method === "PAYROLL") {
    if (!input.payrollHandoffEnabled) {
      throw new ReimbursementPolicyError(
        "REIMBURSEMENT_PAYROLL_HANDOFF_DISABLED",
        "Pembayaran lewat payroll belum diaktifkan. Bayar tunai atau transfer di luar slip gaji.",
      );
    }
    if (!input.payrollMonth || !isMonth(input.payrollMonth)) {
      throw new ReimbursementPolicyError("REIMBURSEMENT_PAYROLL_MONTH_REQUIRED", "Bulan payroll wajib diisi (YYYY-MM).");
    }
  }
  if (!isCalendarDate(input.paidOn) || input.paidOn < input.verifiedOn || input.paidOn > input.today) {
    throw new ReimbursementPolicyError("REIMBURSEMENT_PAYMENT_DATE", "Tanggal bayar antara tanggal verifikasi dan hari ini.");
  }
}

export type Canceller = "employee";

/** D-07, D-08. */
export function canEmployeeCancel(status: ClaimStatus): boolean {
  return status === "DRAFT" || status === "IN_REVIEW" || status === "APPROVED";
}

/** D-09: Finance may refuse a claim it has not paid. */
export function canFinanceReject(status: ClaimStatus): boolean {
  return status === "APPROVED" || status === "VERIFIED";
}

/** APR-001 vocabulary used by the shared approval decision rule. */
export function approvalRequestStatus(status: ClaimStatus): "in_review" | "approved" | "rejected" | "cancelled" {
  if (status === "IN_REVIEW") return "in_review";
  if (status === "REJECTED") return "rejected";
  if (status === "CANCELLED" || status === "DRAFT") return "cancelled";
  return "approved";
}

/** D-17: the export window, both ends inclusive. */
export function exportWindowOk(from: string, to: string): boolean {
  if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) return false;
  return Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) < MAX_EXPORT_DAYS * DAY_MS;
}

export function categoryCatalog() {
  return CATEGORY_KEYS.map((key) => ({
    key,
    label: CATEGORIES[key].label,
    maxPerItem: rupiahToJson(CATEGORIES[key].maxPerItem),
  }));
}
