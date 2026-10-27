// ATT-011-5 Jadwal planner: client for the Perubahan Jadwal API (ATT-011-4b/4c). The server plans,
// validates and authorizes everything; this module only carries the requests.

export class ScheduleChangeApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly issues?: ScheduleChangeIssue[]) {
    super(message);
    this.name = "ScheduleChangeApiError";
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as (T & { code?: string; message?: string; issues?: ScheduleChangeIssue[] }) | null;
  if (response.ok) return body as T;
  throw new ScheduleChangeApiError(
    response.status,
    body?.code ?? "SCHEDULE_CHANGE_REQUEST_FAILED",
    body?.message ?? "Perubahan jadwal tidak dapat diproses.",
    body?.issues,
  );
}

export type CalendarSource = "roster" | "roster_off" | "holiday" | "pattern" | "conflict" | "off";

export interface ScheduleCalendar {
  from: string;
  to: string;
  page: number;
  pageSize: number;
  total: number;
  employees: Array<{
    id: string;
    employeeNumber: string;
    fullName: string;
    unitName: string | null;
    days: Array<{ date: string; source: CalendarSource; scheduleTemplateId: string | null; changeSetId: string | null }>;
  }>;
  shifts: Array<{ id: string; name: string; startTime: string; endTime: string; active: boolean }>;
  holidays: Array<{ date: string; label: string | null }>;
}

export function getScheduleCalendar(input: { from: string; to: string; unitId?: string; q?: string; page?: number }) {
  const params = new URLSearchParams({ from: input.from, to: input.to, page: String(input.page ?? 1) });
  if (input.unitId) params.set("unitId", input.unitId);
  if (input.q) params.set("q", input.q);
  return fetch(`/api/admin/attendance/schedule-calendar?${params}`, { credentials: "include" }).then((response) => readJson<ScheduleCalendar>(response));
}

type Scope = { employeeIds?: string[]; unitId?: string | null; excludeEmployeeIds?: string[]; workOnHolidays?: boolean; note?: string | null };
export type ScheduleChangeInput =
  | (Scope & { kind: "pattern"; scheduleTemplateId: string | null; from: string; to: string | null; weekdays: number[]; untickedDays: "off" | "keep" })
  | (Scope & { kind: "replacement"; scheduleTemplateId: string | null; from: string; to: string })
  | (Scope & { kind: "copy"; sourceWeekStart: string; targetWeekStarts: string[] })
  | { kind: "revert"; changeSetId: string; note: string; excludeEmployeeIds?: string[] };

export interface ScheduleChangeIssue {
  employeeId: string | null;
  employeeName: string | null;
  code: string;
  date: string | null;
  message: string;
  blocking: boolean;
}

export interface ScheduleChangePreview {
  fingerprint: string;
  summary: { employees: number; from: string; to: string | null; newEmployees: number; replacedEmployees: number; rosterDays: number; blockingIssues: number };
  issues: ScheduleChangeIssue[];
  holidays: Array<{ date: string; label: string | null }>;
  employees: Array<{ id: string; employeeNumber: string; fullName: string; changes: number }>;
  employeesTotal: number;
}

export function previewScheduleChange(change: ScheduleChangeInput) {
  return fetch("/api/admin/attendance/schedule-changes/preview", {
    method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(change),
  }).then((response) => readJson<ScheduleChangePreview>(response));
}

/** The same key for retries of one Terapkan, so a network failure never applies twice (§5.5). */
export function applyScheduleChange(change: ScheduleChangeInput, previewFingerprint: string, idempotencyKey: string) {
  return fetch("/api/admin/attendance/schedule-changes", {
    method: "POST", credentials: "include",
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify({ change, previewFingerprint }),
  }).then((response) => readJson<{ id: string; replayed: boolean; recalculated: number }>(response));
}

export interface ScheduleChangeHistory {
  items: Array<{
    id: string;
    kind: "pattern" | "replacement" | "copy" | "revert";
    appliedAt: string;
    note: string | null;
    requestedBy: string | null;
    revertsChangeSetId: string | null;
    summary: ScheduleChangePreview["summary"];
  }>;
  page: number;
  pageSize: number;
  total: number;
}

export function listScheduleChanges(page = 1) {
  return fetch(`/api/admin/attendance/schedule-changes?page=${page}&pageSize=25`, { credentials: "include" })
    .then((response) => readJson<ScheduleChangeHistory>(response));
}
