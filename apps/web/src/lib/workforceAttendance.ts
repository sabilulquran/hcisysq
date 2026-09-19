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
  lateJustified: boolean;
  earlyLeaveJustified: boolean;
  outsideGeofenceJustified: boolean;
  overtimeMinutes: number;
  sessions?: Array<{
    sequence: number;
    checkInAt: string;
    checkOutAt: string | null;
    workedMinutes: number | null;
    complete: boolean;
    sourceSummary: string;
  }>;
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
  overtimeRequests: Array<{
    id: string;
    workDate: string;
    requestedMinutes: number;
    approvedMinutes: number | null;
    note: string | null;
    status: "submitted" | "approved" | "rejected" | "cancelled";
    decisionNote: string | null;
    createdAt: string;
    decidedAt: string | null;
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
    id: string; name: string; startTime: string; endTime: string; endDayOffset: number;
    lateGraceMinutes: number; earlyLeaveToleranceMinutes: number;
    active: boolean; workLocationId: string | null; workLocationName: string | null;
  }> }>(await fetch("/api/admin/attendance/schedules", { credentials: "include", headers: { Accept: "application/json" } }));
}

export async function createAttendanceSchedule(input: {
  name: string; startTime: string; endTime: string; endDayOffset?: number; lateGraceMinutes: number;
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


export interface AttendanceScheduleAssignmentItem {
  id: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  unitName: string | null;
  scheduleTemplateId: string;
  scheduleName: string;
  weekdayMask: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
}

export interface AttendanceRosterWorkspace {
  weekStart: string;
  rosters: Array<{
    id: string;
    weekStart: string;
    version: number;
    status: "DRAFT" | "PUBLISHED";
    publishedAt: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  entries: Array<{
    rosterId: string;
    employeeId: string;
    workDate: string;
    scheduleTemplateId: string | null;
    isOff: boolean;
    note: string | null;
  }>;
  employees: Array<{
    id: string;
    employeeNumber: string;
    employeeName: string;
    unitName: string | null;
    defaultScheduleId: string | null;
  }>;
  schedules: Array<{
    id: string;
    name: string;
    startTime: string;
    endTime: string;
    endDayOffset?: number;
    active: boolean;
  }>;
}

export interface AttendanceMobileEvidenceItem {
  id: string;
  action: "check_in" | "check_out";
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  distanceMeters: number | null;
  geofenceStatus: "inside" | "outside" | "uncertain_accuracy" | "unassigned_location";
  reviewState: "accepted" | "needs_review";
  photoByteLength: number;
  createdAt: string;
  occurredAt: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  unitName: string | null;
  workLocationId: string | null;
  workLocationName: string | null;
  radiusMeters: number | null;
}

export async function updateAttendanceWorkLocation(
  locationId: string,
  input: Partial<{ name: string; latitude: number; longitude: number; radiusMeters: number; active: boolean }>,
) {
  return readJson<{ id: string }>(await fetch(`/api/admin/attendance/work-locations/${locationId}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input),
  }));
}

export async function updateAttendanceSchedule(
  scheduleId: string,
  input: Partial<{
    name: string; startTime: string; endTime: string; endDayOffset?: number; lateGraceMinutes: number;
    earlyLeaveToleranceMinutes: number; workLocationId: string | null; active: boolean;
  }>,
) {
  return readJson<{ id: string }>(await fetch(`/api/admin/attendance/schedules/${scheduleId}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input),
  }));
}

export async function listAttendanceScheduleAssignments() {
  return readJson<{ items: AttendanceScheduleAssignmentItem[] }>(
    await fetch("/api/admin/attendance/schedule-assignments", {
      credentials: "include",
      headers: { Accept: "application/json" },
    }),
  );
}

export async function updateAttendanceScheduleAssignment(
  assignmentId: string,
  effectiveTo: string | null,
) {
  return readJson<{ id: string }>(await fetch(`/api/admin/attendance/schedule-assignments/${assignmentId}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ effectiveTo }),
  }));
}

export async function getAttendanceRosterWeek(weekStart: string) {
  return readJson<AttendanceRosterWorkspace>(
    await fetch(`/api/admin/attendance/rosters?weekStart=${encodeURIComponent(weekStart)}`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    }),
  );
}

export async function removeAttendanceRosterEntry(
  rosterId: string,
  employeeId: string,
  workDate: string,
) {
  const response = await fetch(
    `/api/admin/attendance/rosters/${rosterId}/entries/${employeeId}/${workDate}`,
    { method: "DELETE", credentials: "include", headers: { Accept: "application/json" } },
  );
  if (response.ok) return;
  await readJson<never>(response);
}

export async function copyPreviousAttendanceRoster(rosterId: string) {
  return readJson<{ copied: number }>(
    await fetch(`/api/admin/attendance/rosters/${rosterId}/copy-previous`, {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json" },
    }),
  );
}

export async function listAttendanceClarificationsForHcByStatus(
  status: "all" | "submitted" | "approved" | "rejected" | "cancelled" = "submitted",
) {
  return readJson<{ items: Array<{
    id: string;
    workDate: string;
    kind: string;
    mode: string;
    reason: string;
    status: string;
    proposedCheckInAt: string | null;
    proposedCheckOutAt: string | null;
    decisionNote: string | null;
    decidedAt: string | null;
    employeeId: string;
    employeeNumber: string;
    employeeName: string;
    unitName: string | null;
    createdAt: string;
  }> }>(await fetch(`/api/admin/attendance/clarifications?status=${encodeURIComponent(status)}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  }));
}

export async function listAttendanceMobileEvidence(input: {
  date?: string;
  reviewState?: "all" | "accepted" | "needs_review";
} = {}) {
  const params = new URLSearchParams();
  if (input.date) params.set("date", input.date);
  if (input.reviewState && input.reviewState !== "all") params.set("reviewState", input.reviewState);
  const query = params.toString();
  return readJson<{ items: AttendanceMobileEvidenceItem[] }>(
    await fetch(`/api/admin/attendance/mobile-evidence${query ? `?${query}` : ""}`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    }),
  );
}

export function attendanceMobileEvidencePhotoUrl(evidenceId: string) {
  return `/api/admin/attendance/mobile-evidence/${encodeURIComponent(evidenceId)}/photo`;
}


export interface AttendanceDailyItem {
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  unitId: string | null;
  unitName: string | null;
  workDate: string;
  status: string;
  resultVersion: number | null;
  scheduleTemplateId: string | null;
  scheduleVersionId: string | null;
  rosterId: string | null;
  workLocationId: string | null;
  workLocationName: string | null;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  firstCheckInAt: string | null;
  lastCheckOutAt: string | null;
  workedMinutes: number;
  breakMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
  incompleteSession: boolean;
  justified: boolean;
  lateJustified: boolean;
  earlyLeaveJustified: boolean;
  outsideGeofenceJustified: boolean;
  sources: string[];
  deviceIds: string[];
  materialized: boolean;
}

export async function getAttendanceDaily(date: string) {
  return readJson<{ date: string; summary: Record<string, number>; items: AttendanceDailyItem[] }>(
    await fetch(`/api/admin/attendance/daily?date=${encodeURIComponent(date)}`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    }),
  );
}

export type AttendanceReportType = "detail" | "period" | "unit" | "sessions" | "scans" | "schedule" | "overtime";

export async function getAttendanceReportV2(input: {
  type: AttendanceReportType;
  from: string;
  to: string;
  status?: string;
  employeeId?: string;
  unitId?: string;
  scheduleId?: string;
  locationId?: string;
  source?: "adms" | "mobile" | "manual";
  deviceId?: string;
}) {
  const params = new URLSearchParams({ type: input.type, from: input.from, to: input.to });
  for (const [key, value] of Object.entries(input)) {
    if (["type", "from", "to"].includes(key) || value === undefined || value === "") continue;
    params.set(key, String(value));
  }
  return readJson<{ type: AttendanceReportType; from: string; to: string; summary?: Record<string, number>; items: Array<Record<string, unknown>> }>(
    await fetch(`/api/admin/attendance/report?${params.toString()}`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    }),
  );
}

export interface AttendanceOvertimeItem {
  id: string;
  employeeId?: string;
  employeeNumber?: string;
  employeeName?: string;
  unitName?: string | null;
  workDate: string;
  requestedMinutes: number;
  approvedMinutes: number | null;
  note: string | null;
  status: "submitted" | "approved" | "rejected" | "cancelled";
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export async function listMyAttendanceOvertime() {
  return readJson<{ items: AttendanceOvertimeItem[] }>(
    await fetch("/api/attendance/overtime/me", { credentials: "include", headers: { Accept: "application/json" } }),
  );
}

export async function submitAttendanceOvertime(input: {
  workDate: string;
  requestedMinutes: number;
  note?: string | null;
}) {
  return readJson<{ id: string; status: string }>(
    await fetch("/api/attendance/overtime", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function cancelAttendanceOvertime(overtimeId: string) {
  const response = await fetch(`/api/attendance/overtime/${encodeURIComponent(overtimeId)}/cancel`, {
    method: "POST", credentials: "include", headers: { Accept: "application/json" },
  });
  if (response.ok) return;
  await readJson<never>(response);
}

export async function listAttendanceOvertime(
  status: "all" | "submitted" | "approved" | "rejected" | "cancelled" = "submitted",
) {
  return readJson<{ items: AttendanceOvertimeItem[] }>(
    await fetch(`/api/admin/attendance/overtime?status=${encodeURIComponent(status)}`, {
      credentials: "include", headers: { Accept: "application/json" },
    }),
  );
}

export async function createAttendanceOvertimeForEmployee(input: {
  employeeId: string;
  workDate: string;
  requestedMinutes: number;
  note?: string | null;
}) {
  return readJson<{ id: string; status: string }>(
    await fetch("/api/admin/attendance/overtime", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function decideAttendanceOvertime(
  overtimeId: string,
  input: { decision: "approve" | "reject"; approvedMinutes?: number | null; note?: string | null },
) {
  return readJson(
    await fetch(`/api/admin/attendance/overtime/${encodeURIComponent(overtimeId)}/decision`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function createCanonicalManualCorrection(input: {
  employeeId: string;
  workDate: string;
  checkInAt: string | null;
  checkOutAt: string | null;
  reason: string;
}) {
  return readJson(
    await fetch("/api/admin/attendance/manual-corrections", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    }),
  );
}
