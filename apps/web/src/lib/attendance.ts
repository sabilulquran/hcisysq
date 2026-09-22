export interface AttendanceEmployee {
  id: string;
  employeeNumber: string;
  fullName: string;
  status: "active" | "inactive" | "resigned";
  unitName: string | null;
  positionName: string | null;
}

export interface AttendanceRecord {
  employeeId: string;
  attendanceDate: string;
  checkInAt: string | null;
  checkOutAt: string | null;
  source: "manual" | "integration";
  createdAt: string;
  updatedAt: string;
}

export interface AdminAttendanceRecord extends AttendanceRecord {
  sourceReference: string | null;
  note: string | null;
}

export interface AttendanceListResponse {
  referenceDate?: string;
  range: {
    from: string;
    to: string;
  };
  employee: AttendanceEmployee;
  items: AttendanceRecord[];
}

export interface AdminAttendanceListResponse
  extends Omit<AttendanceListResponse, "items" | "referenceDate"> {
  items: AdminAttendanceRecord[];
}

export type AdmsDeviceLifecycle = "active" | "disabled" | "quarantined" | "retired";

export interface AdmsDevice {
  id: string;
  serialNumber: string;
  displayName: string | null;
  lifecycle: AdmsDeviceLifecycle;
  timezone: string;
  model: string | null;
  firmwareVersion: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  lastSuccessfulRequestAt: string | null;
  lastIp: string | null;
  createdAt: string;
  updatedAt: string;
  activeMappingCount?: number;
  unmappedPinCount?: number;
}

export interface AdmsMapping {
  id: string;
  pin: string;
  employeeId: string;
  employeeNumber?: string;
  employeeName?: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
}

export interface AdmsObservedPin {
  pin: string;
  eventCount: number;
  firstEventAt: string;
  lastEventAt: string;
  mappingId: string | null;
  employeeId: string | null;
  employeeNumber: string | null;
  employeeName: string | null;
}

export interface AdmsRecentEvent {
  id: string;
  pin: string;
  occurredAt: string;
  receivedAt: string;
  sourceRequestId: string;
}

export interface AdmsQuarantine {
  id: string;
  reason: string;
  details: Record<string, unknown>;
  createdAt: string;
  requestId: string;
}

export interface AdmsDeviceDetailResponse {
  item: AdmsDevice;
  mappings: AdmsMapping[];
  observedPins: AdmsObservedPin[];
  recentEvents: AdmsRecentEvent[];
  recentQuarantines: AdmsQuarantine[];
}

export class AttendanceApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AttendanceApiError";
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as
    | T
    | { code?: string; message?: string }
    | null;
  if (response.ok) return body as T;
  const error = body as { code?: string; message?: string } | null;
  throw new AttendanceApiError(
    response.status,
    error?.code ?? "ATTENDANCE_REQUEST_FAILED",
    error?.message ?? "Data kehadiran tidak dapat diproses.",
  );
}

function rangeParams(input: { from?: string; to?: string } = {}) {
  const params = new URLSearchParams();
  if (input.from) params.set("from", input.from);
  if (input.to) params.set("to", input.to);
  const query = params.toString();
  return query ? `?${query}` : "";
}

export async function getMyAttendance(
  input: { from?: string; to?: string } = {},
): Promise<AttendanceListResponse> {
  return readJson(
    await fetch(`/api/attendance/me${rangeParams(input)}`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    }),
  );
}

export async function getAdminEmployeeAttendance(
  employeeId: string,
  input: { from?: string; to?: string } = {},
): Promise<AdminAttendanceListResponse> {
  return readJson(
    await fetch(`/api/admin/attendance/employees/${employeeId}${rangeParams(input)}`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    }),
  );
}

export async function saveAdminAttendanceRecord(
  employeeId: string,
  attendanceDate: string,
  input: {
    checkInAt: string | null;
    checkOutAt: string | null;
    note: string | null;
  },
): Promise<{ item: AdminAttendanceRecord }> {
  return readJson(
    await fetch(`/api/admin/attendance/employees/${employeeId}/${attendanceDate}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function deleteAdminAttendanceRecord(
  employeeId: string,
  attendanceDate: string,
): Promise<void> {
  const response = await fetch(
    `/api/admin/attendance/employees/${employeeId}/${attendanceDate}`,
    {
      method: "DELETE",
      credentials: "include",
      headers: { Accept: "application/json" },
    },
  );
  if (response.ok) return;
  await readJson<never>(response);
}

export async function listAdmsDevices(): Promise<{ items: AdmsDevice[] }> {
  return readJson(
    await fetch("/api/admin/attendance/adms/devices", {
      credentials: "include",
      headers: { Accept: "application/json" },
    }),
  );
}

export async function createAdmsDevice(input: {
  serialNumber: string;
  displayName: string | null;
  timezone?: string;
}): Promise<{ item: AdmsDevice }> {
  return readJson(
    await fetch("/api/admin/attendance/adms/devices", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function getAdmsDevice(deviceId: string): Promise<AdmsDeviceDetailResponse> {
  return readJson(
    await fetch(`/api/admin/attendance/adms/devices/${deviceId}`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    }),
  );
}

export async function updateAdmsDevice(
  deviceId: string,
  input: Partial<{
    displayName: string | null;
    lifecycle: AdmsDeviceLifecycle;
    timezone: string;
    model: string | null;
    firmwareVersion: string | null;
  }>,
): Promise<{ item: AdmsDevice }> {
  return readJson(
    await fetch(`/api/admin/attendance/adms/devices/${deviceId}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function createAdmsMapping(
  deviceId: string,
  input: { pin: string; employeeId: string; effectiveFrom?: string },
): Promise<{ item: AdmsMapping; projection: unknown }> {
  return readJson(
    await fetch(`/api/admin/attendance/adms/devices/${deviceId}/mappings`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function endAdmsMapping(mappingId: string): Promise<void> {
  const response = await fetch(`/api/admin/attendance/adms/mappings/${mappingId}`, {
    method: "DELETE",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (response.ok) return;
  await readJson<never>(response);
}


export interface AdmsGlobalTransaction {
  id: string;
  deviceId: string;
  serialNumber: string;
  deviceName: string | null;
  pin: string;
  occurredAtRaw: string;
  occurredAt: string;
  receivedAt: string;
  sourceRequestId: string;
  employeeId: string | null;
  employeeNumber: string | null;
  employeeName: string | null;
  unitName: string | null;
  mappingState: "mapped" | "unmapped";
}

export async function listAdmsGlobalTransactions(input: {
  deviceId?: string;
  pin?: string;
  employeeId?: string;
  mapping?: "all" | "mapped" | "unmapped";
  from?: string;
  to?: string;
} = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== "" && value !== "all") params.set(key, value);
  }
  const query = params.toString();
  return readJson<{ items: AdmsGlobalTransaction[] }>(
    await fetch(`/api/admin/attendance/adms/transactions${query ? `?${query}` : ""}`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    }),
  );
}
