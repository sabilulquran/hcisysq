import type { AttendanceTodayCard, AttendanceTodayItem } from "@/lib/workforceAttendance";

// ATT-014 §5 Pantauan Hari Ini vocabulary. These are facts, never verdicts: no word here may say
// "Tidak hadir", "Terlambat" or "Tidak lengkap" — those come only from Kalkulasi.

export const TODAY_CARDS: readonly AttendanceTodayCard[] = [
  "scanned", "not_scanned", "not_connected", "off", "leave", "unscheduled", "unscheduled_with_scans", "configuration_error",
];

const cardLabels: Record<AttendanceTodayCard, string> = {
  scanned: "Sudah scan",
  not_scanned: "Belum ada scan",
  not_connected: "Belum terhubung mesin",
  off: "Libur",
  leave: "Cuti/Izin",
  unscheduled: "Tanpa jadwal",
  unscheduled_with_scans: "Scan tanpa jadwal",
  configuration_error: "Jadwal bermasalah",
};

export function todayCardLabel(value: unknown): string {
  return cardLabels[value as AttendanceTodayCard] ?? "Lainnya";
}

/** What the employee is expected to do today, in operator words. */
export function todayScheduleLabel(item: Pick<AttendanceTodayItem, "dayKind" | "scheduleName">, time: string | null): string {
  switch (item.dayKind) {
    case "scheduled": return [item.scheduleName ?? "Shift", time].filter(Boolean).join(" · ");
    case "off": return "Libur";
    case "holiday": return "Libur nasional";
    case "leave": return "Cuti/Izin";
    case "resolved_absent": return "Diputuskan tidak masuk";
    case "configuration_error": return "Jadwal bermasalah";
    case "unscheduled": return "Tanpa jadwal";
    default: return "—";
  }
}

export function todayFactLabel(item: Pick<AttendanceTodayItem, "fact" | "scanCount">): string {
  switch (item.fact) {
    case "before_shift": return "Belum waktunya masuk";
    case "no_scan": return "Belum ada scan";
    case "not_connected": return "Belum terhubung mesin";
    case "checked_in": return "Baru satu scan";
    case "has_scans": return `${item.scanCount} scan`;
    case "scan_on_rest_day": return "Scan pada hari libur";
    case "scan_without_schedule": return "Scan tanpa jadwal";
    default: return "—";
  }
}

/** Neutral difference between the first scan and the scheduled start, e.g. "+6 mnt" or "−5 mnt". */
export function todayDeltaLabel(minutes: number | null): string {
  if (minutes === null) return "—";
  if (minutes === 0) return "tepat";
  return `${minutes > 0 ? "+" : "−"}${Math.abs(minutes)} mnt`;
}
