import type { AttendanceCalculationScope } from "@/lib/attendanceCalculation";
import { WorkforceAttendanceApiError } from "@/lib/workforceAttendance";

// ATT-014 §7/§19.2 report models. The server builds every table from stored results; the screen
// preview and the print document only render it.

export type AttendanceReportModel = "daily_grid" | "employee_summary" | "daily_detail";

export const REPORT_MODEL_OPTIONS: Array<{ value: AttendanceReportModel; label: string; hint: string }> = [
  { value: "daily_grid", label: "Laporan Harian (Grid Bulanan)", hint: "Satu baris per pegawai, satu kolom per tanggal, berisi simbol kehadiran. Dicetak lanskap." },
  { value: "employee_summary", label: "Rekapitulasi Pegawai", hint: "Satu baris per pegawai dengan Normal, Riil, Presensi %, dan jumlah per jenis, subtotal per unit." },
  { value: "daily_detail", label: "Detail Harian", hint: "Satu baris per pegawai per tanggal: jadwal, scan, status, terlambat, pulang cepat, lembur." },
];

export type ReportCell = string | number | null;

export interface AttendanceReportTable {
  model: AttendanceReportModel;
  title: string;
  orientation: "landscape" | "portrait";
  columns: Array<{ key: string; label: string; align?: "right" | "center"; weekend?: boolean }>;
  groups: Array<{ unitName: string; rows: Array<Record<string, ReportCell>>; subtotal: Record<string, ReportCell> | null }>;
  total: Record<string, ReportCell> | null;
  legend: Array<{ symbol: string; label: string }> | null;
  header: { scope: string; period: string; printedBy: string; printedAt: string };
  warnings: { notCalculated: number; changed: number; provisional: boolean };
  from: string;
  to: string;
}

function reportParams(scope: AttendanceCalculationScope, extra: Record<string, string>) {
  const params = new URLSearchParams({ from: scope.from, to: scope.to, ...extra });
  if (scope.unitId) params.set("unitId", scope.unitId);
  if (scope.employeeId) params.set("employeeId", scope.employeeId);
  return params;
}

async function failure(response: Response): Promise<never> {
  const body = (await response.json().catch(() => null)) as { code?: string; message?: string } | null;
  throw new WorkforceAttendanceApiError(response.status, body?.code ?? "ATTENDANCE_REPORT_FAILED", body?.message ?? "Laporan tidak dapat dibuat.");
}

export async function getAttendanceReportModel(scope: AttendanceCalculationScope, model: AttendanceReportModel, purpose: "view" | "print" = "view") {
  const response = await fetch(`/api/admin/attendance/reports/${model}?${reportParams(scope, { purpose }).toString()}`, {
    credentials: "include", headers: { Accept: "application/json" },
  });
  if (!response.ok) return failure(response);
  return (await response.json()) as AttendanceReportTable;
}

/** Downloads CSV or XLSX built on the server; the server audits the export. */
export async function downloadAttendanceReport(scope: AttendanceCalculationScope, model: AttendanceReportModel, format: "csv" | "xlsx") {
  const response = await fetch(`/api/admin/attendance/reports/${model}?${reportParams(scope, { format }).toString()}`, {
    credentials: "include",
  });
  if (!response.ok) return failure(response);
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `hcis-kehadiran-${model}-${scope.from}-${scope.to}.${format}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Address of the standalone print document (§19.2), opened in a new tab. */
export function reportPrintHref(scope: AttendanceCalculationScope, model: AttendanceReportModel) {
  return `/admin/attendance/reports/print?${reportParams(scope, { model }).toString()}`;
}

/** Reads the print document's address back into a scope; null when it is incomplete. */
export function parseReportPrintSearch(search: string): { scope: AttendanceCalculationScope; model: AttendanceReportModel } | null {
  const params = new URLSearchParams(search);
  const model = params.get("model");
  const from = params.get("from");
  const to = params.get("to");
  if (!from || !to || !REPORT_MODEL_OPTIONS.some((option) => option.value === model)) return null;
  return {
    model: model as AttendanceReportModel,
    scope: { from, to, ...(params.get("unitId") ? { unitId: params.get("unitId")! } : {}), ...(params.get("employeeId") ? { employeeId: params.get("employeeId")! } : {}) },
  };
}

export function reportCellText(value: ReportCell | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number") return new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 }).format(value);
  return value;
}

export function reportWarningText(warnings: AttendanceReportTable["warnings"]): string | null {
  const parts = [
    warnings.notCalculated ? `${warnings.notCalculated} pegawai-hari belum ditarik` : null,
    warnings.changed ? `${warnings.changed} berubah sejak ditarik` : null,
    warnings.provisional ? "hari ini masih hasil sementara" : null,
  ].filter(Boolean);
  return parts.length ? `Perhatian: ${parts.join(", ")}.` : null;
}
