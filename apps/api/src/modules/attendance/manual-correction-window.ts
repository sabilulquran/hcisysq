import { jakartaWorkDate } from "./engine.js";

// Koreksi HC: a corrected check-in must fall on the selected work date and a corrected check-out on
// that date or the next one (a shift that ends after midnight, end_day_offset = 1), both in Asia/Jakarta.
// Without this check a correction for 20 October could carry a 26 October timestamp and the engine
// would count it.

const MAX_SPAN_MS = 24 * 60 * 60_000;

function nextDate(date: string) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

export type ManualCorrectionWindowError =
  | "CHECK_IN_OUTSIDE_WORK_DATE"
  | "CHECK_OUT_OUTSIDE_WORK_DATE"
  | "CHECK_OUT_BEFORE_CHECK_IN";

export function manualCorrectionWindowError(input: {
  workDate: string;
  checkInAt: string | null;
  checkOutAt: string | null;
}): ManualCorrectionWindowError | null {
  const checkIn = input.checkInAt ? new Date(input.checkInAt) : null;
  const checkOut = input.checkOutAt ? new Date(input.checkOutAt) : null;
  if (checkIn && jakartaWorkDate(checkIn) !== input.workDate) return "CHECK_IN_OUTSIDE_WORK_DATE";
  if (checkOut && ![input.workDate, nextDate(input.workDate)].includes(jakartaWorkDate(checkOut))) {
    return "CHECK_OUT_OUTSIDE_WORK_DATE";
  }
  if (checkIn && checkOut && (checkOut <= checkIn || checkOut.getTime() - checkIn.getTime() > MAX_SPAN_MS)) {
    return "CHECK_OUT_BEFORE_CHECK_IN";
  }
  return null;
}

export const manualCorrectionWindowMessages: Record<ManualCorrectionWindowError, string> = {
  CHECK_IN_OUTSIDE_WORK_DATE: "Jam masuk harus jatuh pada tanggal kerja yang dipilih.",
  CHECK_OUT_OUTSIDE_WORK_DATE: "Jam pulang harus pada tanggal kerja yang dipilih atau keesokan harinya.",
  CHECK_OUT_BEFORE_CHECK_IN: "Jam pulang harus setelah jam masuk dan paling lama 24 jam sesudahnya.",
};

// ATT-011-7 (§8, D-7): an employee clarifies today or up to 7 days back, never a future date.
export const CLARIFICATION_LOOKBACK_DAYS = 7;

export function clarificationDateAllowed(workDate: string, now = new Date()): boolean {
  const today = jakartaWorkDate(now);
  const oldest = new Date(`${today}T00:00:00Z`);
  oldest.setUTCDate(oldest.getUTCDate() - CLARIFICATION_LOOKBACK_DAYS);
  return workDate <= today && workDate >= oldest.toISOString().slice(0, 10);
}
