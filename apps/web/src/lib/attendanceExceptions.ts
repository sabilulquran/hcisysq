import type { AttendanceCalculationScope } from "@/lib/attendanceCalculation";
import { WorkforceAttendanceApiError } from "@/lib/workforceAttendance";

// ATT-014 §20.2 tab "Pengecualian" (R2b): approved leave and clarifications/corrections in the range.

export interface AttendanceException {
  kind: "leave" | "clarification";
  id: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  unitName: string | null;
  startOn: string;
  endOn: string;
  type: string;
  typeName: string | null;
  mode: string | null;
  origin: "employee" | "hc" | null;
  status: string;
  reason: string | null;
}

export interface AttendanceExceptions {
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
  items: AttendanceException[];
}

export async function getAttendanceExceptions(scope: AttendanceCalculationScope & { page?: number }) {
  const params = new URLSearchParams({ from: scope.from, to: scope.to, page: String(scope.page ?? 1) });
  if (scope.unitId) params.set("unitId", scope.unitId);
  if (scope.employeeId) params.set("employeeId", scope.employeeId);
  const response = await fetch(`/api/admin/attendance/exceptions?${params.toString()}`, { credentials: "include", headers: { Accept: "application/json" } });
  const body = (await response.json().catch(() => null)) as AttendanceExceptions | { code?: string; message?: string } | null;
  if (!response.ok) {
    const error = body as { code?: string; message?: string } | null;
    throw new WorkforceAttendanceApiError(response.status, error?.code ?? "ATTENDANCE_EXCEPTIONS_FAILED", error?.message ?? "Pengecualian tidak dapat dimuat.");
  }
  return body as AttendanceExceptions;
}

/** Which server report model the "Ekspor" menu uses for a tab; null when the tab has none yet (R2d). */
export function exportModelForTab(tab: string): "daily_detail" | "employee_summary" | null {
  if (tab === "detail") return "daily_detail";
  if (tab === "summary") return "employee_summary";
  return null;
}
