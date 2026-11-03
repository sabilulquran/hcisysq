// ATT-015 Package 1 rules: kinds, date windows, state transitions. No database, no HTTP.
// Spec: docs/domain/attendance-remote-and-schedule-requests.md.

export const ARRANGEMENT_TYPES = ["FIELD_ASSIGNMENT", "REMOTE_WORK", "SCHEDULE_CHANGE"] as const;
export type ArrangementType = (typeof ARRANGEMENT_TYPES)[number];

export const ARRANGEMENT_STATUSES = ["IN_REVIEW", "APPROVED", "REJECTED", "CANCELLED", "APPLIED"] as const;
export type ArrangementStatus = (typeof ARRANGEMENT_STATUSES)[number];

/** The two kinds that explain a working day; a schedule change only changes the schedule. */
export const DISPOSITION_TYPES: readonly ArrangementType[] = ["FIELD_ASSIGNMENT", "REMOTE_WORK"];

/** D-08: a tugas luar or WFH in one of these states still occupies the employee's dates. */
export const OCCUPYING_STATUSES: readonly ArrangementStatus[] = ["IN_REVIEW", "APPROVED"];

/** §7.4: these requests are shown in the ATT-014 exceptions tab. */
export const VISIBLE_IN_ATTENDANCE: readonly ArrangementStatus[] = ["APPROVED", "APPLIED"];

/** D-04 DRAFT: at most 7 calendar days per tugas luar, counted inclusively. */
export const MAX_FIELD_ASSIGNMENT_DAYS = 7;
/** D-05 DRAFT: tugas luar up to 7 days back, the ATT-011-7 clarification window. */
export const FIELD_ASSIGNMENT_LOOKBACK_DAYS = 7;
/** D-05 DRAFT: nothing is requested more than 60 days ahead. */
export const MAX_LEAD_DAYS = 60;

/** The engine status an approved arrangement gives a working day without punches (§7.2). */
export function dispositionStatus(type: ArrangementType): "field_assignment" | "remote_work" | null {
  if (type === "FIELD_ASSIGNMENT") return "field_assignment";
  if (type === "REMOTE_WORK") return "remote_work";
  return null;
}

export type ArrangementPolicyCode =
  | "ARRANGEMENT_DATE_RANGE"
  | "ARRANGEMENT_TOO_LONG"
  | "ARRANGEMENT_SINGLE_DAY"
  | "ARRANGEMENT_DATE_TOO_EARLY"
  | "ARRANGEMENT_DATE_TOO_LATE";

export class ArrangementPolicyError extends Error {
  constructor(readonly code: ArrangementPolicyCode, message: string) {
    super(message);
    this.name = "ArrangementPolicyError";
  }
}

const DAY_MS = 86_400_000;

function epochDay(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / DAY_MS;
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** True only for a real calendar date written `YYYY-MM-DD` (rejects 2026-02-30). */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function arrangementDays(startOn: string, endOn: string): number {
  return epochDay(endOn) - epochDay(startOn) + 1;
}

/** D-05: the first date each kind may cover, given today's Asia/Jakarta date. */
export function earliestDate(type: ArrangementType, today: string): string {
  if (type === "FIELD_ASSIGNMENT") return addDays(today, -FIELD_ASSIGNMENT_LOOKBACK_DAYS);
  if (type === "REMOTE_WORK") return today;
  return addDays(today, 1);
}

/** D-02, D-04, D-05, D-09. `today` is the Asia/Jakarta date. */
export function validateArrangementDates(input: {
  type: ArrangementType;
  startOn: string;
  endOn: string;
  today: string;
}): { days: number } {
  if (!isCalendarDate(input.startOn) || !isCalendarDate(input.endOn) || input.endOn < input.startOn) {
    throw new ArrangementPolicyError("ARRANGEMENT_DATE_RANGE", "Tanggal selesai tidak boleh sebelum tanggal mulai.");
  }
  const days = arrangementDays(input.startOn, input.endOn);
  if (input.type !== "FIELD_ASSIGNMENT" && days !== 1) {
    throw new ArrangementPolicyError("ARRANGEMENT_SINGLE_DAY", input.type === "REMOTE_WORK"
      ? "WFH/WFA diajukan per hari: satu pengajuan untuk satu tanggal."
      : "Ubah jadwal diajukan untuk satu tanggal.");
  }
  if (days > MAX_FIELD_ASSIGNMENT_DAYS) {
    throw new ArrangementPolicyError("ARRANGEMENT_TOO_LONG",
      `Tugas luar paling lama ${MAX_FIELD_ASSIGNMENT_DAYS} hari. Tugas yang lebih lama atau menginap diajukan sebagai perjalanan dinas.`);
  }
  const earliest = earliestDate(input.type, input.today);
  if (input.startOn < earliest) {
    throw new ArrangementPolicyError("ARRANGEMENT_DATE_TOO_EARLY",
      input.type === "FIELD_ASSIGNMENT" ? `Tugas luar dapat diajukan paling lambat ${FIELD_ASSIGNMENT_LOOKBACK_DAYS} hari setelah kejadian.`
        : input.type === "REMOTE_WORK" ? "WFH/WFA tidak dapat diajukan untuk tanggal yang sudah lewat."
        : "Ubah jadwal diajukan paling cepat untuk besok.");
  }
  if (input.endOn > addDays(input.today, MAX_LEAD_DAYS)) {
    throw new ArrangementPolicyError("ARRANGEMENT_DATE_TOO_LATE", `Pengajuan paling jauh ${MAX_LEAD_DAYS} hari ke depan.`);
  }
  return { days };
}

export type ArrangementCanceller = "employee" | "hc";

/** D-10: the employee cancels a pending request, or an approved one before it starts; HC cancels either. */
export function canCancelArrangement(status: ArrangementStatus, startOn: string, today: string, by: ArrangementCanceller): boolean {
  if (status === "IN_REVIEW") return true;
  if (status !== "APPROVED") return false;
  return by === "hc" || today < startOn;
}

/** The dates an approval or a cancellation changes now: those already past and today (§7.3). */
export function datesToRecompute(startOn: string, endOn: string, today: string): string[] {
  const dates: string[] = [];
  for (let date = startOn; date <= endOn && date <= today; date = addDays(date, 1)) dates.push(date);
  return dates;
}

/** APR-001 vocabulary used by the shared approval decision rule. */
export function approvalRequestStatus(status: ArrangementStatus): "in_review" | "approved" | "rejected" | "cancelled" {
  if (status === "IN_REVIEW") return "in_review";
  if (status === "REJECTED") return "rejected";
  if (status === "CANCELLED") return "cancelled";
  return "approved";
}

export const ARRANGEMENT_TYPE_LABELS: Record<ArrangementType, string> = {
  FIELD_ASSIGNMENT: "Tugas luar",
  REMOTE_WORK: "WFH/WFA",
  SCHEDULE_CHANGE: "Ubah jadwal",
};
