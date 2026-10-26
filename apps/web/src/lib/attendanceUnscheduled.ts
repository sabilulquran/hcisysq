import type { AttendanceCalculationScope } from "@/lib/attendanceCalculation";
import { WorkforceAttendanceApiError } from "@/lib/workforceAttendance";

// ATT-014 §20.3 Tanpa Jadwal (R2a): who scans without a schedule, and which machine scans cannot be
// attributed yet. Read-only from the API; actions reuse the existing schedule and mapping screens.

export interface UnscheduledEmployee {
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  unitName: string | null;
  position: string | null;
  days: number;
  firstDate: string;
  lastDate: string;
  earliestLastScan: string;
  latestLastScan: string;
  scheduleStartsOn: string | null;
}

export interface UnattributedPin {
  deviceId: string;
  deviceName: string;
  pin: string;
  scans: number;
  firstScanAt: string;
  lastScanAt: string;
  status: "unmapped" | "before_mapping" | "outside_mapping";
  mappedEmployeeId: string | null;
  mappedEmployeeName: string | null;
  mappedEmployeeStartedOn: string | null;
  mappingEffectiveFrom: string | null;
}

interface Page<T> { page: number; pageSize: number; total: number; totalPages: number; items: T[] }

export interface AttendanceUnscheduled {
  from: string;
  to: string;
  employees: Page<UnscheduledEmployee>;
  /** null when the account may not read device data (PINs). */
  pins: Page<UnattributedPin> | null;
}

export async function getAttendanceUnscheduled(scope: AttendanceCalculationScope & { page?: number; pinPage?: number }) {
  const params = new URLSearchParams({ from: scope.from, to: scope.to, page: String(scope.page ?? 1), pinPage: String(scope.pinPage ?? 1) });
  if (scope.unitId) params.set("unitId", scope.unitId);
  if (scope.employeeId) params.set("employeeId", scope.employeeId);
  const response = await fetch(`/api/admin/attendance/unscheduled?${params.toString()}`, { credentials: "include", headers: { Accept: "application/json" } });
  const body = (await response.json().catch(() => null)) as AttendanceUnscheduled | { code?: string; message?: string } | null;
  if (!response.ok) {
    const error = body as { code?: string; message?: string } | null;
    throw new WorkforceAttendanceApiError(response.status, error?.code ?? "ATTENDANCE_UNSCHEDULED_FAILED", error?.message ?? "Data tanpa jadwal tidak dapat dimuat.");
  }
  return body as AttendanceUnscheduled;
}

export interface PositionGroup {
  position: string;
  employees: UnscheduledEmployee[];
  /** Range of the last scan time per day across the group; information only, never a shift proposal. */
  lastScanRange: string;
}

/** Groups by position: a whole job group usually lacks a fitting shift, not one person (§20.3). */
export function groupByPosition(employees: UnscheduledEmployee[]): PositionGroup[] {
  const groups = new Map<string, UnscheduledEmployee[]>();
  for (const employee of employees) {
    const key = employee.position?.trim() || "Tanpa jabatan";
    groups.set(key, [...(groups.get(key) ?? []), employee]);
  }
  return [...groups.entries()].map(([position, list]) => {
    const earliest = list.map((item) => item.earliestLastScan).sort()[0]!;
    const latest = list.map((item) => item.latestLastScan).sort().at(-1)!;
    return { position, employees: list, lastScanRange: earliest === latest ? earliest : `${earliest}–${latest}` };
  });
}

export function unscheduledReason(employee: Pick<UnscheduledEmployee, "scheduleStartsOn">): string {
  if (!employee.scheduleStartsOn) return "Belum punya pola jadwal";
  const date = new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${employee.scheduleStartsOn}T00:00:00Z`));
  return `Pola jadwal mulai ${date}; scan sebelumnya tidak dinilai`;
}

export function unattributedStatusLabel(status: UnattributedPin["status"]): string {
  if (status === "unmapped") return "PIN belum dipetakan";
  if (status === "before_mapping") return "Scan sebelum pemetaan berlaku";
  return "Scan di luar masa pemetaan";
}
