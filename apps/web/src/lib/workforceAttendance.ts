export class WorkforceAttendanceApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "WorkforceAttendanceApiError";
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as T | { code?: string; message?: string } | null;
  if (response.ok) return body as T;
  const error = body as { code?: string; message?: string } | null;
  throw new WorkforceAttendanceApiError(
    response.status,
    error?.code ?? "ATTENDANCE_WORKFORCE_REQUEST_FAILED",
    error?.message ?? "Permintaan kehadiran tidak dapat diproses.",
  );
}

export interface WorkforceResult {
  id: string;
  workDate: string;
  version: number;
  status: string;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  firstCheckInAt: string | null;
  lastCheckOutAt: string | null;
  workedMinutes: number;
  breakMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  incompleteSession: boolean;
  justified: boolean;
}

export interface ResolvedSchedule {
  state: "scheduled" | "off" | "configuration_error";
  scheduleTemplateId: string | null;
  rosterId: string | null;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  workLocation: null | {
    id: string;
    name: string;
    latitude: number;
    longitude: number;
    radiusMeters: number;
  };
}

export interface WorkforceSnapshot {
  employee: { id: string; fullName: string; employeeNumber: string };
  workDate: string;
  mobileEnabled: boolean;
  schedule: ResolvedSchedule;
  result: WorkforceResult | null;
  clarifications: Array<{
    id: string;
    workDate: string;
    kind: string;
    mode: string;
    reason: string;
    status: string;
    proposedCheckInAt: string | null;
    proposedCheckOutAt: string | null;
    decisionNote: string | null;
    createdAt: string;
  }>;
  mobileEvidence: Array<{
    id: string;
    action: "check_in" | "check_out";
    geofenceStatus: string;
    reviewState: string;
    distanceMeters: number | null;
    accuracyMeters: number;
    createdAt: string;
  }>;
}

export async function getMyWorkforceAttendance(date?: string): Promise<WorkforceSnapshot> {
  const query = date ? `?date=${encodeURIComponent(date)}` : "";
  return readJson(await fetch(`/api/attendance/me/workforce${query}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  }));
}

export async function clockMobileAttendance(input: {
  action: "check_in" | "check_out";
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  photoBase64: string;
  idempotencyKey: string;
}) {
  return readJson<{
    duplicate: boolean;
    evidenceId: string;
    workDate: string;
    geofenceStatus: string;
    reviewState: string;
    distanceMeters: number | null;
    result: WorkforceResult | null;
  }>(await fetch("/api/attendance/mobile/clock", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "Idempotency-Key": input.idempotencyKey,
    },
    body: JSON.stringify({
      action: input.action,
      latitude: input.latitude,
      longitude: input.longitude,
      accuracyMeters: input.accuracyMeters,
      photoBase64: input.photoBase64,
    }),
  }));
}

export async function submitAttendanceClarification(input: {
  workDate: string;
  kind: string;
  mode: "correction" | "justification";
  reason: string;
  proposedCheckInAt?: string | null;
  proposedCheckOutAt?: string | null;
}) {
  return readJson<{ id: string; status: string }>(await fetch("/api/attendance/clarifications", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input),
  }));
}

export async function listAttendanceClarificationsForHc() {
  return readJson<{ items: Array<Record<string, unknown>> }>(await fetch("/api/admin/attendance/clarifications", {
    credentials: "include",
    headers: { Accept: "application/json" },
  }));
}

export async function decideAttendanceClarification(
  clarificationId: string,
  decision: "approve" | "reject",
  note: string | null,
) {
  return readJson(await fetch(`/api/admin/attendance/clarifications/${clarificationId}/decision`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ decision, note }),
  }));
}

export async function listAttendanceWorkLocations() {
  return readJson<{ items: Array<{ id: string; name: string; latitude: number; longitude: number; radiusMeters: number; active: boolean }> }>(
    await fetch("/api/admin/attendance/work-locations", { credentials: "include", headers: { Accept: "application/json" } }),
  );
}

export async function createAttendanceWorkLocation(input: {
  name: string; latitude: number; longitude: number; radiusMeters: number;
}) {
  return readJson<{ id: string }>(await fetch("/api/admin/attendance/work-locations", {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input),
  }));
}

export async function listAttendanceSchedules() {
  return readJson<{ items: Array<{
    id: string; name: string; startTime: string; endTime: string;
    lateGraceMinutes: number; earlyLeaveToleranceMinutes: number;
    active: boolean; workLocationId: string | null; workLocationName: string | null;
  }> }>(await fetch("/api/admin/attendance/schedules", { credentials: "include", headers: { Accept: "application/json" } }));
}

export async function createAttendanceSchedule(input: {
  name: string; startTime: string; endTime: string; lateGraceMinutes: number;
  earlyLeaveToleranceMinutes: number; workLocationId: string | null;
}) {
  return readJson<{ id: string }>(await fetch("/api/admin/attendance/schedules", {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input),
  }));
}

export async function createAttendanceScheduleAssignment(input: {
  employeeId: string; scheduleTemplateId: string; weekdays: number[];
  effectiveFrom: string; effectiveTo: string | null;
}) {
  return readJson<{ id: string }>(await fetch("/api/admin/attendance/schedule-assignments", {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input),
  }));
}

export async function createAttendanceRoster(weekStart: string) {
  return readJson<{ id: string; version: number; status: string }>(await fetch("/api/admin/attendance/rosters", {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ weekStart }),
  }));
}

export async function updateAttendanceRosterEntries(
  rosterId: string,
  entries: Array<{
    employeeId: string; workDate: string; scheduleTemplateId: string | null;
    isOff: boolean; note: string | null;
  }>,
) {
  return readJson<{ updated: number }>(await fetch(`/api/admin/attendance/rosters/${rosterId}/entries`, {
    method: "PUT", credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ entries }),
  }));
}

export async function publishAttendanceRoster(rosterId: string) {
  return readJson(await fetch(`/api/admin/attendance/rosters/${rosterId}/publish`, {
    method: "POST", credentials: "include", headers: { Accept: "application/json" },
  }));
}

export async function finalizeAttendanceDate(date: string) {
  return readJson<{ date: string; materialized: number }>(await fetch(`/api/admin/attendance/finalize/${date}`, {
    method: "POST", credentials: "include", headers: { Accept: "application/json" },
  }));
}

export async function getAttendanceReport(date: string, status?: string) {
  const params = new URLSearchParams({ date });
  if (status) params.set("status", status);
  return readJson<{ date: string; summary: Record<string, number>; items: Array<Record<string, unknown>> }>(
    await fetch(`/api/admin/attendance/report?${params.toString()}`, {
      credentials: "include", headers: { Accept: "application/json" },
    }),
  );
}
