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
  mappingId: string | null;
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

export type MappingAlignmentStatus = "change" | "unchanged" | "missing_start_date" | "invalid_range" | "overlap" | "removes_scans";

export interface MappingAlignmentItem {
  mappingId: string;
  deviceName: string;
  pin: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  startedOn: string | null;
  currentFrom: string;
  targetFrom: string | null;
  scansAdded: number;
  scansRemoved: number;
  status: MappingAlignmentStatus;
}

export interface MappingAlignmentResult {
  applied: boolean;
  summary: { mappings: number; change: number; unchanged: number; missingStartDate: number; invalidRange: number; overlap: number; removesScans: number; scansAdded: number; scansRemoved: number };
  items: MappingAlignmentItem[];
}

/** ADMS-R2c "Sesuaikan dengan TMT": without apply it is a dry run that changes nothing. */
export async function alignAdmsMappingsToStartDate(input: { mappingIds: string[]; apply: boolean; reason?: string }) {
  const response = await fetch("/api/admin/attendance/adms/mappings/align-to-start-date", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json().catch(() => null)) as MappingAlignmentResult | { code?: string; message?: string } | null;
  if (!response.ok) {
    const error = body as { code?: string; message?: string } | null;
    throw new WorkforceAttendanceApiError(response.status, error?.code ?? "ADMS_MAPPING_ALIGNMENT_FAILED", error?.message ?? "Penyesuaian pemetaan tidak dapat diproses.");
  }
  return body as MappingAlignmentResult;
}

export function alignmentStatusLabel(status: MappingAlignmentStatus): string {
  if (status === "change") return "Akan disesuaikan";
  if (status === "unchanged") return "Sudah sesuai TMT";
  if (status === "missing_start_date") return "TMT pegawai belum diisi";
  if (status === "invalid_range") return "TMT setelah pemetaan berakhir";
  if (status === "removes_scans") return "TMT lebih akhir; scan akan lepas, tidak diterapkan";
  return "Bertumpuk dengan pemegang PIN lain";
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

export type AssignmentPlan =
  | { employeeId: string; action: "create"; from: string; to: string | null }
  | { employeeId: string; action: "skip"; reason: string };

function dayBefore(date: string) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

/**
 * Plans one new schedule pattern per employee without overlapping an existing one: two patterns on the
 * same date make the engine report "Jadwal bermasalah" (ambiguous assignment). The new pattern ends the
 * day before the next existing pattern; an employee whose pattern already covers the start date is
 * skipped with a reason.
 */
export function planAssignments(
  employeeIds: string[],
  existing: Array<{ employeeId: string; effectiveFrom: string; effectiveTo: string | null }>,
  from: string,
): AssignmentPlan[] {
  return employeeIds.map((employeeId) => {
    const own = existing.filter((item) => item.employeeId === employeeId);
    const covering = own.find((item) => item.effectiveFrom <= from && (item.effectiveTo === null || item.effectiveTo >= from));
    if (covering) return { employeeId, action: "skip", reason: `sudah punya pola sejak ${covering.effectiveFrom}` };
    const next = own.filter((item) => item.effectiveFrom > from).map((item) => item.effectiveFrom).sort()[0];
    return { employeeId, action: "create", from, to: next ? dayBefore(next) : null };
  });
}
