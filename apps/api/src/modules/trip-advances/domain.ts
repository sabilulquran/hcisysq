// TRIP-002 rules: zones, per diem, advance limit, settlement arithmetic, refund and payment
// windows, states. No database, no HTTP. Spec: docs/domain/trip-advance-per-diem.md.
//
// Money is whole rupiah and every calculation runs on bigint (D-18); callers convert at the edge.

import { formatRupiah, isCalendarDate, rupiahToJson, toRupiah } from "../loans/domain.js";

export { formatRupiah, isCalendarDate, rupiahToJson, toRupiah };

export const ADVANCE_STATUSES = [
  "IN_REVIEW", "APPROVED", "DISBURSED", "SETTLEMENT_SUBMITTED",
  "AWAITING_TOP_UP", "AWAITING_REFUND", "SETTLED", "REJECTED", "CANCELLED",
] as const;
export type AdvanceStatus = (typeof ADVANCE_STATUSES)[number];

/** D-13: an advance that has not been settled yet holds the trip's claims for its settlement. */
export const UNSETTLED_STATUSES: readonly AdvanceStatus[] = ["IN_REVIEW", "APPROVED", "DISBURSED", "SETTLEMENT_SUBMITTED"];

export const WILAYAH_KEYS = ["DALAM_DAERAH", "LUAR_DAERAH", "LUAR_NEGERI"] as const;
export type WilayahKey = (typeof WILAYAH_KEYS)[number];

/**
 * D-01 (SK 01.111/YSQ/VII/2026, Lampiran 1). SK hanya mengenal dua wilayah. `LUAR_NEGERI`
 * dipertahankan sebagai kode supaya perjalanan luar negeri tetap dapat diajukan, tetapi SK tidak
 * menetapkan tarifnya: kode ini harus berperilaku "tarif belum ditetapkan", bukan Rp0.
 */
export const WILAYAH: Record<WilayahKey, string> = {
  DALAM_DAERAH: "Dalam Daerah (Wilayah III Cirebon)",
  LUAR_DAERAH: "Luar Daerah (di luar Wilayah III Cirebon)",
  LUAR_NEGERI: "Luar negeri (belum diatur SK)",
};

export const GOLONGAN_KEYS = ["PIMPINAN", "KEPALA_UNIT", "STAF"] as const;
export type GolonganKey = (typeof GOLONGAN_KEYS)[number];

/** D-01 (SK 01.111/YSQ/VII/2026, Lampiran 1). */
export const GOLONGAN: Record<GolonganKey, string> = {
  PIMPINAN: "Pimpinan / Yayasan",
  KEPALA_UNIT: "Kepala Unit Kerja",
  STAF: "Staf",
};

/**
 * D-20 DRAFT: seseorang yang memegang lebih dari satu klasifikasi (guru yang juga kepala unit)
 * memakai golongan tertinggi yang terpetakan. SK tidak mengatur rangkap jabatan.
 */
const GOLONGAN_RANK: Record<GolonganKey, number> = { PIMPINAN: 3, KEPALA_UNIT: 2, STAF: 1 };

export function highestGolongan(values: readonly GolonganKey[]): GolonganKey | null {
  let best: GolonganKey | null = null;
  for (const value of values) if (best === null || GOLONGAN_RANK[value] > GOLONGAN_RANK[best]) best = value;
  return best;
}

export function isGolongan(value: string): value is GolonganKey {
  return (GOLONGAN_KEYS as readonly string[]).includes(value);
}

/** D-02 DRAFT: the per-day ceiling the rate table accepts. */
export const MAX_DAILY_RATE = 5_000_000n;
/** D-04 DRAFT: the advance may cover up to this much in expenses on top of the per diem estimate. */
export const MAX_ADVANCE_EXPENSES = 10_000_000n;
/** D-09 DRAFT. */
export const SETTLEMENT_DUE_DAYS = 14;
/** D-04: trips an advance may be requested for. */
export const ADVANCEABLE_TRIP_STATUSES = ["IN_REVIEW", "APPROVED", "ISSUED"] as const;
/** D-07: a trip still going ahead. */
export const ACTIVE_TRIP_STATUSES = ["APPROVED", "ISSUED"] as const;
/** D-03: a trip that never happened earns no per diem. */
export const ENDED_TRIP_STATUSES = ["CANCELLED", "REJECTED"] as const;
export const TRANSACTION_METHODS = ["CASH", "TRANSFER"] as const;
export type TransactionMethod = (typeof TRANSACTION_METHODS)[number];

/** The database ceiling of every settlement amount column (claims_total, per_diem_amount). */
export const MAX_SETTLEMENT_AMOUNT = 1_000_000_000n;

export const MAX_EXPORT_DAYS = 366;
export const MAX_EXPORT_ROWS = 20_000;

export type TripAdvancePolicyCode =
  | "TRIP_ADVANCE_AMOUNT_ABOVE_LIMIT"
  | "TRIP_ADVANCE_PER_DIEM_DAYS"
  | "TRIP_ADVANCE_REDUCTION_NOTE_REQUIRED"
  | "TRIP_PER_DIEM_RATE_MISSING"
  | "TRIP_PER_DIEM_NOT_PAYABLE_TWICE"
  | "TRIP_ADVANCE_PAYMENT_DATE"
  | "TRIP_ADVANCE_REFUND_EXCEEDS_DUE"
  | "TRIP_ADVANCE_SETTLEMENT_TOO_LARGE";

export class TripAdvancePolicyError extends Error {
  constructor(readonly code: TripAdvancePolicyCode, message: string) {
    super(message);
    this.name = "TripAdvancePolicyError";
  }
}

const DAY_MS = 86_400_000;

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function isWilayah(value: string): value is WilayahKey {
  return (WILAYAH_KEYS as readonly string[]).includes(value);
}

/** D-03: calendar days of a trip, both ends inclusive. */
export function tripDays(startOn: string, endOn: string): number {
  return Math.round((Date.parse(`${endOn}T00:00:00Z`) - Date.parse(`${startOn}T00:00:00Z`)) / DAY_MS) + 1;
}

/** D-03: the most per diem days a settlement may count. A trip that did not happen counts none. */
export function maxPerDiemDays(trip: { status: string; startOn: string; endOn: string }): number {
  return (ENDED_TRIP_STATUSES as readonly string[]).includes(trip.status) ? 0 : tripDays(trip.startOn, trip.endOn);
}

/** D-04: the per diem estimate shown at request time and the advance ceiling it gives. */
export function advanceLimit(days: number, dailyRate: bigint | null): { perDiemEstimate: bigint; maxAmount: bigint } {
  const perDiemEstimate = BigInt(days) * (dailyRate ?? 0n);
  return { perDiemEstimate, maxAmount: MAX_ADVANCE_EXPENSES + perDiemEstimate };
}

export function assertAdvanceAmount(amount: bigint, maxAmount: bigint): void {
  if (amount < 0n || amount > maxAmount) {
    throw new TripAdvancePolicyError(
      "TRIP_ADVANCE_AMOUNT_ABOVE_LIMIT",
      `Uang muka paling banyak ${formatRupiah(maxAmount)} (Rp10.000.000 ditambah perkiraan uang harian).`,
    );
  }
}

/** D-09: the settlement deadline. A cancelled trip is due from whichever comes first. */
export function settlementDueOn(trip: { status: string; endOn: string; cancelledOn: string | null }): string {
  const base = trip.status === "CANCELLED" && trip.cancelledOn && trip.cancelledOn < trip.endOn ? trip.cancelledOn : trip.endOn;
  return addDays(base, SETTLEMENT_DUE_DAYS);
}

/** The day a cancelled `trip` was cancelled (WIB), from its TRIP-001 cancellation event. */
export const CANCELLED_ON_SQL = `(SELECT (COALESCE(
    (SELECT max(cancel_event.occurred_at) FROM business_trip_events cancel_event
      WHERE cancel_event.request_id = trip.id AND cancel_event.event_type = 'trip.request.cancelled'),
    trip.updated_at) AT TIME ZONE 'Asia/Jakarta')::date)`;

/**
 * D-09 in SQL over a `trip` alias of business_trip_requests: the same deadline as settlementDueOn.
 * A cancelled trip is dated by its TRIP-001 cancellation event, falling back to the row's last
 * update only for a trip cancelled without one.
 */
export const DUE_ON_SQL = `(CASE WHEN trip.status = 'CANCELLED' AND ${CANCELLED_ON_SQL} < trip.end_on
  THEN ${CANCELLED_ON_SQL} ELSE trip.end_on END + ${SETTLEMENT_DUE_DAYS})`;

export interface SettlementInput {
  advanceAmount: bigint;
  claims: readonly bigint[];
  perDiemDays: number;
  maxDays: number;
  dailyRate: bigint | null;
  note: string | null;
  /** D-21 (Diktum Keempat): uang saku dari penyelenggara untuk penugasan yang sama. */
  organizerPerDiemPaid?: boolean;
}

export interface SettlementResult {
  perDiemAmount: bigint;
  claimsTotal: bigint;
  balance: bigint;
  status: "SETTLED" | "AWAITING_TOP_UP" | "AWAITING_REFUND";
}

/**
 * D-10: per diem + verified claims - advance. Days above the trip, a cut without a note, and per
 * diem without a rate are refused; nothing is guessed.
 */
export function settle(input: SettlementInput): SettlementResult {
  // D-21: uang saku tidak dibayar dua kali. Bila pegawai sudah menerimanya dari penyelenggara
  // atau pihak lain untuk penugasan yang sama, uang harian tidak dibayar sama sekali.
  if (input.organizerPerDiemPaid && input.perDiemDays > 0) {
    throw new TripAdvancePolicyError(
      "TRIP_PER_DIEM_NOT_PAYABLE_TWICE",
      "Uang saku sudah diterima dari penyelenggara untuk penugasan ini, jadi uang harian tidak dibayar lagi. Isi 0 hari.",
    );
  }
  if (!Number.isInteger(input.perDiemDays) || input.perDiemDays < 0 || input.perDiemDays > input.maxDays) {
    throw new TripAdvancePolicyError(
      "TRIP_ADVANCE_PER_DIEM_DAYS", `Hari uang harian antara 0 dan ${input.maxDays} hari.`,
    );
  }
  if (input.perDiemDays < input.maxDays && (!input.note || [...input.note.trim()].length < 10)) {
    throw new TripAdvancePolicyError(
      "TRIP_ADVANCE_REDUCTION_NOTE_REQUIRED", "Tulis alasan (minimal 10 karakter) bila hari uang harian dikurangi.",
    );
  }
  if (input.perDiemDays > 0 && input.dailyRate === null) {
    throw new TripAdvancePolicyError(
      "TRIP_PER_DIEM_RATE_MISSING",
      "Tarif uang harian golongan dan wilayah ini belum ditetapkan untuk tanggal berangkat. Minta HC/Keuangan mengisi tarif, atau isi 0 hari.",
    );
  }
  const perDiemAmount = BigInt(input.perDiemDays) * (input.dailyRate ?? 0n);
  const claimsTotal = input.claims.reduce((sum, value) => sum + value, 0n);
  // The stored columns are capped at Rp1.000.000.000 (migration 0160); refuse, never overflow.
  if (claimsTotal > MAX_SETTLEMENT_AMOUNT || perDiemAmount > MAX_SETTLEMENT_AMOUNT) {
    throw new TripAdvancePolicyError(
      "TRIP_ADVANCE_SETTLEMENT_TOO_LARGE",
      `Total klaim atau uang harian melebihi ${formatRupiah(MAX_SETTLEMENT_AMOUNT)}; selesaikan sebagian klaim di luar uang muka ini.`,
    );
  }
  const balance = perDiemAmount + claimsTotal - input.advanceAmount;
  const status = balance === 0n ? "SETTLED" : balance > 0n ? "AWAITING_TOP_UP" : "AWAITING_REFUND";
  return { perDiemAmount, claimsTotal, balance, status };
}

/** D-07, D-11, D-12: a transaction date between its precondition date and today. */
export function assertTransactionDate(on: string, earliest: string, today: string): void {
  if (!isCalendarDate(on) || on < earliest || on > today) {
    throw new TripAdvancePolicyError("TRIP_ADVANCE_PAYMENT_DATE", "Tanggal transaksi antara tanggal keputusan sebelumnya dan hari ini.");
  }
}

/** D-12: a refund is at least Rp1 and never more than what is still owed. Returns what remains. */
export function applyRefund(owed: bigint, refunded: bigint, amount: bigint): bigint {
  const remaining = owed - refunded;
  if (amount < 1n || amount > remaining) {
    throw new TripAdvancePolicyError(
      "TRIP_ADVANCE_REFUND_EXCEEDS_DUE", `Pengembalian paling banyak sisa kewajiban ${formatRupiah(remaining)}.`,
    );
  }
  return remaining - amount;
}

/** D-06. */
export function canEmployeeCancel(status: AdvanceStatus): boolean {
  return status === "IN_REVIEW" || status === "APPROVED";
}

/** D-08: settlement is asked for after the cash went out, or at once for a per-diem-only advance. */
export function canSubmitSettlement(status: AdvanceStatus, amount: bigint): boolean {
  return status === "DISBURSED" || (status === "APPROVED" && amount === 0n);
}

/** APR-001 vocabulary used by the shared approval decision rule. */
export function approvalRequestStatus(status: AdvanceStatus): "in_review" | "approved" | "rejected" | "cancelled" {
  if (status === "IN_REVIEW") return "in_review";
  if (status === "REJECTED") return "rejected";
  if (status === "CANCELLED") return "cancelled";
  return "approved";
}

/** D-19: the export window, both ends inclusive. */
export function exportWindowOk(from: string, to: string): boolean {
  if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) return false;
  return Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) < MAX_EXPORT_DAYS * DAY_MS;
}

export function wilayahCatalog() {
  return WILAYAH_KEYS.map((key) => ({ key, label: WILAYAH[key] }));
}

export function golonganCatalog() {
  return GOLONGAN_KEYS.map((key) => ({ key, label: GOLONGAN[key] }));
}
