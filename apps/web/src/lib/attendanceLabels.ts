// ATT-011 §3 vocabulary: the only place backend attendance enums become operator words.
// Screens never print a raw enum; an unknown value falls back to a neutral word, not the code.

export const ATTENDANCE_STATUSES = [
  "scheduled", "pending", "present", "late", "incomplete", "leave", "absent", "off", "configuration_error",
] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

const statusLabels: Record<AttendanceStatus, string> = {
  scheduled: "Terjadwal",
  pending: "Belum absen",
  present: "Hadir",
  late: "Terlambat",
  incomplete: "Tidak lengkap",
  leave: "Cuti/Izin",
  absent: "Tidak hadir",
  off: "Libur",
  configuration_error: "Jadwal bermasalah",
};

export function attendanceStatusLabel(value: unknown): string {
  return statusLabels[value as AttendanceStatus] ?? "Tidak diketahui";
}

export const ATTENDANCE_SOURCES = ["adms", "mobile", "manual"] as const;
const sourceLabels: Record<(typeof ATTENDANCE_SOURCES)[number], string> = {
  adms: "Mesin",
  mobile: "HP",
  manual: "Koreksi HC",
};

export function attendanceSourceLabel(value: unknown): string {
  if (Array.isArray(value)) return value.length ? value.map(attendanceSourceLabel).join(", ") : "—";
  return sourceLabels[value as (typeof ATTENDANCE_SOURCES)[number]] ?? "Lainnya";
}

export const REQUEST_STATUSES = ["submitted", "approved", "rejected", "cancelled"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
const requestStatusLabels: Record<RequestStatus, string> = {
  submitted: "Menunggu",
  approved: "Disetujui",
  rejected: "Ditolak",
  cancelled: "Dibatalkan",
};

/** Overtime and clarification requests share the same lifecycle words. */
export function requestStatusLabel(value: unknown): string {
  return requestStatusLabels[value as RequestStatus] ?? "Tidak diketahui";
}

export const CLARIFICATION_MODES = ["correction", "justification"] as const;
const clarificationModeLabels: Record<(typeof CLARIFICATION_MODES)[number], string> = {
  correction: "Perbaiki jam",
  justification: "Terima alasan",
};

export function clarificationModeLabel(value: unknown): string {
  return clarificationModeLabels[value as (typeof CLARIFICATION_MODES)[number]] ?? "Klarifikasi";
}

export const CLARIFICATION_KINDS = [
  "missing_check_in", "missing_check_out", "machine_issue", "lateness", "early_leave", "outside_geofence", "other",
] as const;
const clarificationKindLabels: Record<(typeof CLARIFICATION_KINDS)[number], string> = {
  missing_check_in: "Lupa absen masuk",
  missing_check_out: "Lupa absen pulang",
  machine_issue: "Mesin bermasalah",
  lateness: "Terlambat",
  early_leave: "Pulang cepat",
  outside_geofence: "Di luar lokasi",
  other: "Lainnya",
};

export function clarificationKindLabel(value: unknown): string {
  return clarificationKindLabels[value as (typeof CLARIFICATION_KINDS)[number]] ?? "Lainnya";
}

export const MOBILE_REVIEW_STATES = ["accepted", "needs_review"] as const;
const mobileReviewLabels: Record<(typeof MOBILE_REVIEW_STATES)[number], string> = {
  accepted: "Di dalam lokasi",
  needs_review: "Perlu ditinjau",
};

export function mobileReviewLabel(value: unknown): string {
  return mobileReviewLabels[value as (typeof MOBILE_REVIEW_STATES)[number]] ?? "Perlu ditinjau";
}

export const GEOFENCE_STATUSES = ["inside", "outside", "uncertain_accuracy", "unassigned_location"] as const;
const geofenceLabels: Record<(typeof GEOFENCE_STATUSES)[number], string> = {
  inside: "Di dalam area",
  outside: "Di luar area",
  uncertain_accuracy: "Akurasi GPS rendah",
  unassigned_location: "Lokasi kerja belum ditetapkan",
};

export function geofenceLabel(value: unknown): string {
  return geofenceLabels[value as (typeof GEOFENCE_STATUSES)[number]] ?? "Lokasi tidak diketahui";
}

export const SCAN_EVENT_KINDS = ["check_in", "check_out", "punch", "correction"] as const;
const scanEventLabels: Record<(typeof SCAN_EVENT_KINDS)[number], string> = {
  check_in: "Masuk",
  check_out: "Pulang",
  punch: "Scan",
  correction: "Koreksi",
};

export function scanEventLabel(value: unknown): string {
  return scanEventLabels[value as (typeof SCAN_EVENT_KINDS)[number]] ?? "Scan";
}
