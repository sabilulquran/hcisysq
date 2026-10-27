import { attendanceStatusLabel } from "@/lib/attendanceLabels";
import { WorkforceAttendanceApiError } from "@/lib/workforceAttendance";

// ATT-014-2 Kalkulasi client and vocabulary. The API decides scope, coverage and every verdict;
// this module only moves requests and turns enums into operator words.

export type AttendanceCalculationStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface AttendanceCalculationRun {
  id: string;
  status: AttendanceCalculationStatus;
  position: number | null;
  unitId: string | null;
  employeeId: string | null;
  from: string;
  to: string;
  totalPairs: number;
  processedPairs: number;
  failedPairs: number;
  uncoveredPairs: number;
  cancelRequested: boolean;
  errorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type AttendanceCalculationRowStatus =
  | "scheduled" | "pending" | "present" | "late" | "incomplete" | "leave" | "absent" | "off" | "configuration_error"
  | "unscheduled" | "not_captured" | "not_calculated";

export interface AttendanceCalculationRow {
  employeeId: string;
  employeeNumber: string | null;
  employeeName: string | null;
  unitId: string | null;
  unitName: string | null;
  workDate: string;
  status: AttendanceCalculationRowStatus;
  provisional: boolean;
  changedSinceCalculated: boolean;
  resultVersion: number | null;
  calculatedAt: string | null;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  firstCheckInAt: string | null;
  lastCheckOutAt: string | null;
  workedMinutes: number | null;
  lateMinutes: number | null;
  earlyLeaveMinutes: number | null;
  overtimeMinutes: number | null;
  incompleteSession: boolean | null;
  normal: number | null;
  actual: number | null;
}

export interface AttendanceCalculationRows {
  from: string;
  to: string;
  today: string;
  generatedAt: string;
  lastCalculatedAt: string | null;
  changedCount: number;
  summary: Partial<Record<AttendanceCalculationRowStatus, number>>;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  items: AttendanceCalculationRow[];
}

export interface AttendanceCalculationScope {
  unitId?: string;
  employeeId?: string;
  from: string;
  to: string;
}

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as T | { code?: string; message?: string } | null;
  if (response.ok) return body as T;
  const error = body as { code?: string; message?: string } | null;
  throw new WorkforceAttendanceApiError(
    response.status,
    error?.code ?? "ATTENDANCE_CALCULATION_REQUEST_FAILED",
    error?.message ?? "Permintaan kalkulasi tidak dapat diproses.",
  );
}

export async function requestAttendanceCalculation(scope: AttendanceCalculationScope) {
  return readJson<AttendanceCalculationRun>(await fetch("/api/admin/attendance/calculations", {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(scope),
  }));
}

export async function getAttendanceCalculation(id: string) {
  return readJson<AttendanceCalculationRun>(await fetch(`/api/admin/attendance/calculations/${id}`, {
    credentials: "include", headers: { Accept: "application/json" },
  }));
}

export async function cancelAttendanceCalculation(id: string) {
  return readJson<AttendanceCalculationRun>(await fetch(`/api/admin/attendance/calculations/${id}/cancel`, {
    method: "POST", credentials: "include", headers: { Accept: "application/json" },
  }));
}

export async function getAttendanceCalculationRows(
  scope: AttendanceCalculationScope & { status?: AttendanceCalculationRowStatus; changedOnly?: boolean; page?: number; pageSize?: number },
) {
  const params = new URLSearchParams({ from: scope.from, to: scope.to });
  if (scope.unitId) params.set("unitId", scope.unitId);
  if (scope.employeeId) params.set("employeeId", scope.employeeId);
  if (scope.status) params.set("status", scope.status);
  if (scope.changedOnly) params.set("changedOnly", "true");
  params.set("page", String(scope.page ?? 1));
  params.set("pageSize", String(scope.pageSize ?? 50));
  return readJson<AttendanceCalculationRows>(await fetch(`/api/admin/attendance/calculation-rows?${params.toString()}`, {
    credentials: "include", headers: { Accept: "application/json" },
  }));
}

export function calculationRowStatusLabel(status: AttendanceCalculationRowStatus): string {
  if (status === "not_captured") return "Tidak tercatat (belum terhubung mesin)";
  if (status === "not_calculated") return "Belum dikalkulasi";
  if (status === "unscheduled") return "Tanpa jadwal";
  return attendanceStatusLabel(status);
}

export function calculationRunLabel(run: AttendanceCalculationRun): string {
  switch (run.status) {
    case "queued": return run.position ? `Menunggu giliran (urutan ke-${run.position})` : "Menunggu giliran";
    case "running": return run.cancelRequested ? "Menghentikan…" : "Sedang dikalkulasi";
    case "completed": return run.failedPairs > 0 ? `Selesai, ${run.failedPairs} gagal dihitung — coba kalkulasi ulang` : "Selesai";
    case "cancelled": return "Dibatalkan. Hasil yang sudah dihitung tetap tersimpan.";
    case "failed":
      return run.errorCode === "INTERRUPTED"
        ? "Kalkulasi terhenti. Jalankan ulang — hasil yang sudah dihitung tetap aman."
        : "Kalkulasi gagal. Jalankan ulang.";
    default: return "—";
  }
}

export function calculationProgress(run: AttendanceCalculationRun): number {
  if (run.status === "completed") return 100;
  if (!run.totalPairs) return 0;
  return Math.min(100, Math.round((run.processedPairs / run.totalPairs) * 100));
}

export function isCalculationActive(run: AttendanceCalculationRun | null): boolean {
  return run?.status === "queued" || run?.status === "running";
}

function jakartaDate(date: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(date);
}

function shift(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export type CalculationRangePreset = "today" | "yesterday" | "this_week" | "last_week" | "this_month" | "last_month";

export const CALCULATION_RANGE_PRESETS: Array<{ key: CalculationRangePreset; label: string }> = [
  { key: "today", label: "Hari ini" },
  { key: "yesterday", label: "Kemarin" },
  { key: "this_week", label: "Minggu ini" },
  { key: "last_week", label: "Minggu lalu" },
  { key: "this_month", label: "Bulan ini" },
  { key: "last_month", label: "Bulan lalu" },
];

/** §6.1 range shortcuts in Asia/Jakarta. A range never ends after today (D-14-4). */
export function calculationRange(preset: CalculationRangePreset, now = new Date()): { from: string; to: string } {
  const today = jakartaDate(now);
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay() || 7;
  const monday = shift(today, 1 - weekday);
  const monthStart = `${today.slice(0, 7)}-01`;
  switch (preset) {
    case "today": return { from: today, to: today };
    case "yesterday": return { from: shift(today, -1), to: shift(today, -1) };
    case "this_week": return { from: monday, to: today };
    case "last_week": return { from: shift(monday, -7), to: shift(monday, -1) };
    case "this_month": return { from: monthStart, to: today };
    case "last_month": {
      const lastDay = shift(monthStart, -1);
      return { from: `${lastDay.slice(0, 7)}-01`, to: lastDay };
    }
  }
}

export type AttendanceTransactionSource = "adms" | "mobile" | "manual" | "correction";

export interface AttendanceTransaction {
  id: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  unitName: string | null;
  occurredAt: string;
  workDate: string;
  source: AttendanceTransactionSource;
  correctionBy: "hc" | "employee" | null;
  boundary: "check_in" | "check_out" | null;
  deviceName: string | null;
  usedInResult: boolean;
  /** Mobile punches only: "Perlu ditinjau" when outside the work location or GPS is poor. */
  reviewState: "accepted" | "needs_review" | null;
  geofenceStatus: "inside" | "outside" | "uncertain_accuracy" | "unassigned_location" | null;
  /** Present only for accounts with attendance.clarification.manage (ATT-006). */
  evidence?: {
    evidenceId: string;
    latitude: number;
    longitude: number;
    accuracyMeters: number;
    distanceMeters: number | null;
    geofenceStatus: "inside" | "outside" | "uncertain_accuracy" | "unassigned_location";
    workLocationName: string | null;
    radiusMeters: number | null;
  } | null;
}

export interface AttendanceTransactions {
  from: string;
  to: string;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  needsReviewTotal: number;
  items: AttendanceTransaction[];
}

export async function getAttendanceTransactions(
  scope: AttendanceCalculationScope & { source?: AttendanceTransactionSource; needsReview?: boolean; page?: number; pageSize?: number },
) {
  const params = new URLSearchParams({ from: scope.from, to: scope.to });
  if (scope.unitId) params.set("unitId", scope.unitId);
  if (scope.employeeId) params.set("employeeId", scope.employeeId);
  if (scope.source) params.set("source", scope.source);
  if (scope.needsReview) params.set("reviewState", "needs_review");
  params.set("page", String(scope.page ?? 1));
  params.set("pageSize", String(scope.pageSize ?? 50));
  return readJson<AttendanceTransactions>(await fetch(`/api/admin/attendance/transactions?${params.toString()}`, {
    credentials: "include", headers: { Accept: "application/json" },
  }));
}

/** Data Transaksi "Sumber" badge: where the punch came from, in operator words. */
export function transactionSourceLabel(item: Pick<AttendanceTransaction, "source" | "correctionBy" | "deviceName">): string {
  switch (item.source) {
    case "adms": return item.deviceName ? `Mesin · ${item.deviceName}` : "Mesin";
    case "mobile": return "HP";
    case "manual": return "Koreksi HC";
    case "correction": return item.correctionBy === "hc" ? "Koreksi HC" : "Koreksi pegawai";
    default: return "—";
  }
}
