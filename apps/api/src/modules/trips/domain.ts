// TRIP-001 Package 1 rules: dates, state transitions. No database, no HTTP.
// Spec: docs/domain/business-travel.md.

export const TRIP_STATUSES = ["IN_REVIEW", "APPROVED", "REJECTED", "CANCELLED", "ISSUED", "COMPLETED"] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];

/** D-03 DRAFT: at most 30 calendar days per request, counted inclusively. */
export const MAX_TRIP_DAYS = 30;

/** D-05: a trip in one of these states still occupies the employee's dates. */
export const OCCUPYING_TRIP_STATUSES: readonly TripStatus[] = ["IN_REVIEW", "APPROVED", "ISSUED", "COMPLETED"];

/** D-11: these trips are shown in the ATT-014 exceptions tab. */
export const VISIBLE_IN_ATTENDANCE: readonly TripStatus[] = ["APPROVED", "ISSUED", "COMPLETED"];

export class TripPolicyError extends Error {
  constructor(
    readonly code: "TRIP_DATE_RANGE" | "TRIP_TOO_LONG" | "TRIP_START_IN_PAST",
    message: string,
  ) {
    super(message);
    this.name = "TripPolicyError";
  }
}

const DAY_MS = 86_400_000;

function epochDay(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / DAY_MS;
}

/** True only for a real calendar date written `YYYY-MM-DD` (rejects 2026-02-30). */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function tripDays(startOn: string, endOn: string): number {
  return epochDay(endOn) - epochDay(startOn) + 1;
}

/** D-03 and D-04. `today` is the Asia/Jakarta date. */
export function validateTripDates(input: { startOn: string; endOn: string; today: string }): { days: number } {
  if (!isCalendarDate(input.startOn) || !isCalendarDate(input.endOn) || input.endOn < input.startOn) {
    throw new TripPolicyError("TRIP_DATE_RANGE", "Tanggal kembali tidak boleh sebelum tanggal berangkat.");
  }
  if (input.startOn < input.today) {
    throw new TripPolicyError("TRIP_START_IN_PAST", "Tanggal berangkat paling cepat hari ini.");
  }
  const days = tripDays(input.startOn, input.endOn);
  if (days > MAX_TRIP_DAYS) {
    throw new TripPolicyError("TRIP_TOO_LONG", `Satu perjalanan dinas paling lama ${MAX_TRIP_DAYS} hari.`);
  }
  return { days };
}

export type TripCanceller = "employee" | "hc";

/** D-08: the employee cancels until the letter is issued; HC also cancels an issued trip. */
export function canCancelTrip(status: TripStatus, by: TripCanceller): boolean {
  if (status === "IN_REVIEW" || status === "APPROVED") return true;
  return status === "ISSUED" && by === "hc";
}

/** D-10: completed by the traveller, after the letter is issued, on or after the return date. */
export function canCompleteTrip(status: TripStatus, endOn: string, today: string): boolean {
  return status === "ISSUED" && today >= endOn;
}

/** APR-001 vocabulary used by the shared approval decision rule. */
export function approvalRequestStatus(status: TripStatus): "in_review" | "approved" | "rejected" | "cancelled" {
  if (status === "IN_REVIEW") return "in_review";
  if (status === "REJECTED") return "rejected";
  if (status === "CANCELLED") return "cancelled";
  return "approved";
}
