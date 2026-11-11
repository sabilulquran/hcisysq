// NOTIF-003 pure rules: Jakarta clock, send window, threshold windows, preferences.
// Spec: docs/domain/reminders.md §3–§4.

/** D-04: reminders are made and handed over only between 06:00 and 21:00 WIB (Kirim SQ jam kirim). */
export const SEND_WINDOW_START_HOUR = 6;
export const SEND_WINDOW_END_HOUR = 21;

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

export interface JakartaClock {
  /** YYYY-MM-DD */
  date: string;
  hour: number;
  minute: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

/** WIB is UTC+7 all year, so a fixed offset is exact. */
export function jakartaClock(now: Date): JakartaClock {
  const shifted = new Date(now.getTime() + WIB_OFFSET_MS);
  return {
    date: shifted.toISOString().slice(0, 10),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

export function insideSendWindow(now: Date): boolean {
  const { hour } = jakartaClock(now);
  return hour >= SEND_WINDOW_START_HOUR && hour < SEND_WINDOW_END_HOUR;
}

/** D-12: a reminder's WhatsApp message expires at 21:00 WIB on the day it was made. */
export function endOfSendWindow(now: Date): Date {
  const { date } = jakartaClock(now);
  return new Date(`${date}T${String(SEND_WINDOW_END_HOUR).padStart(2, "0")}:00:00+07:00`);
}

/** D-05: a rule runs once per Jakarta day, at or after its hour, on its weekdays. */
export function ruleIsDue(rule: { fireHour: number; weekdays?: readonly number[] }, now: Date): boolean {
  const clock = jakartaClock(now);
  if (!insideSendWindow(now)) return false;
  if (clock.hour < rule.fireHour) return false;
  return !rule.weekdays || rule.weekdays.includes(clock.weekday);
}

/**
 * D-06: the smallest threshold already reached, so a missed day or a late record still gets one
 * reminder, and the larger thresholds it skipped are not sent afterwards. Null when nothing is due
 * yet or the date has passed.
 */
export function thresholdReached(daysLeft: number, thresholds: readonly number[]): number | null {
  if (daysLeft < 0) return null;
  const reached = thresholds.filter((threshold) => daysLeft <= threshold);
  return reached.length ? Math.min(...reached) : null;
}

/** Whole days from `today` to `date` (both YYYY-MM-DD). */
export function daysBetween(today: string, date: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** D-08: a stored preference wins; otherwise the rule's default. */
export function whatsappEnabled(defaultWhatsApp: boolean, stored: boolean | null | undefined): boolean {
  return stored ?? defaultWhatsApp;
}

export function formatJakartaDate(date: string): string {
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "long", timeZone: "Asia/Jakarta" })
    .format(new Date(`${date}T00:00:00+07:00`));
}

/** "H-7" style labels; H-0 reads as "hari ini". */
export function dueLabel(daysLeft: number): string {
  if (daysLeft <= 0) return "hari ini";
  if (daysLeft === 1) return "besok";
  return `${daysLeft} hari lagi`;
}
