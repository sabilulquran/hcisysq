import { canAccessAdminPath } from "@/lib/authorization";
import type { AuthSession } from "@/types/hcis";

// ATT-011 §3: "Waktu & Kehadiran" = Ringkasan, Shift, Jadwal, Kehadiran, Lembur, Mesin Fingerprint, Pengaturan.
// A section is shown only when the account can load at least one of its tabs (K-8), and it opens on
// the first tab the account can load.

export type AttendanceSectionKey = "summary" | "shifts" | "schedules" | "records" | "overtime" | "devices" | "settings";

export type AttendanceTabKey =
  | "summary"
  | "shifts"
  | "patterns" | "dates" | "swaps"
  | "daily" | "queue" | "corrections" | "reports"
  | "overtime"
  | "devices"
  | "locations";

export interface AttendanceTab {
  key: AttendanceTabKey;
  label: string;
  href: string;
}

export interface AttendanceSection {
  key: AttendanceSectionKey;
  label: string;
  tabs: AttendanceTab[];
}

export const attendanceSections: AttendanceSection[] = [
  {
    key: "summary",
    label: "Ringkasan",
    tabs: [
      { key: "summary", label: "Ringkasan", href: "/admin/attendance" },
      // ATT-011-3 §3/§6.1: the "Perlu tindakan" queue lives with Ringkasan; Kehadiran keeps three tabs (ATT-014 §19.8).
      { key: "queue", label: "Perlu Tindakan", href: "/admin/attendance/action-queue" },
    ],
  },
  { key: "shifts", label: "Shift", tabs: [{ key: "shifts", label: "Shift", href: "/admin/attendance/shifts" }] },
  {
    key: "schedules",
    label: "Jadwal",
    tabs: [
      { key: "patterns", label: "Pola jadwal", href: "/admin/attendance/schedules" },
      { key: "dates", label: "Jadwal per tanggal", href: "/admin/attendance/schedules/dates" },
      { key: "swaps", label: "Tukar shift", href: "/admin/attendance/schedules/swaps" },
    ],
  },
  {
    key: "records",
    label: "Kehadiran",
    tabs: [
      { key: "daily", label: "Pantauan Hari Ini", href: "/admin/attendance/daily" },
      { key: "corrections", label: "Perbaikan Absen", href: "/admin/attendance/corrections" },
      { key: "reports", label: "Laporan", href: "/admin/attendance/reports" },
    ],
  },
  { key: "overtime", label: "Lembur", tabs: [{ key: "overtime", label: "Lembur", href: "/admin/attendance/overtime" }] },
  { key: "devices", label: "Mesin Fingerprint", tabs: [{ key: "devices", label: "Mesin Fingerprint", href: "/admin/attendance/adms" }] },
  {
    key: "settings",
    label: "Pengaturan",
    tabs: [
      { key: "locations", label: "Lokasi kerja", href: "/admin/attendance/settings/locations" },
    ],
  },
];

export function attendanceSectionOf(tab: AttendanceTabKey): AttendanceSection {
  return attendanceSections.find((section) => section.tabs.some((item) => item.key === tab))!;
}

export function accessibleAttendanceTabs(session: AuthSession | null, section: AttendanceSection): AttendanceTab[] {
  return section.tabs.filter((tab) => canAccessAdminPath(session, tab.href));
}

/** Where the menu entry for a section points, or null when the account cannot load any of it. */
export function attendanceSectionHref(session: AuthSession | null, key: AttendanceSectionKey): string | null {
  const section = attendanceSections.find((item) => item.key === key)!;
  return accessibleAttendanceTabs(session, section)[0]?.href ?? null;
}

/**
 * Routes before ATT-011 → their new home, kept for at least one release so bookmarks and links from
 * notifications keep working. `/admin/attendance` itself stays and now opens Ringkasan.
 */
export const legacyAttendanceRedirects: Record<string, string> = {
  "/admin/attendance/workforce": "/admin/attendance",
  "/admin/attendance/workforce/locations": "/admin/attendance/settings/locations",
  "/admin/attendance/workforce/schedules": "/admin/attendance/shifts",
  "/admin/attendance/workforce/assignments": "/admin/attendance/schedules",
  "/admin/attendance/workforce/roster": "/admin/attendance/schedules/dates",
  "/admin/attendance/workforce/clarifications": "/admin/attendance/corrections",
  "/admin/attendance/workforce/mobile": "/admin/attendance/reports?tab=transactions&source=mobile",
  "/admin/attendance/workforce/overtime": "/admin/attendance/overtime",
  "/admin/attendance/workforce/shift-swaps": "/admin/attendance/schedules/swaps",
  "/admin/attendance/workforce/reports": "/admin/attendance/reports",
  // ATT-014 §19.1 (R1): Kalkulasi is the "Tarik data" step inside Laporan.
  "/admin/attendance/settings/recalculate": "/admin/attendance/reports",
  "/admin/attendance/calculation": "/admin/attendance/reports",
  // ATT-014 §19.8 (R1): Klarifikasi and Koreksi HC became Perbaikan Absen; Bukti HP lives in Data Transaksi.
  "/admin/attendance/clarifications": "/admin/attendance/corrections",
  "/admin/attendance/mobile-evidence": "/admin/attendance/reports?tab=transactions&source=mobile",
};
