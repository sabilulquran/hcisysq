import type { AdmsDevice } from "@/lib/attendance";

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as T | { message?: string } | null;
  if (response.ok) return body as T;
  throw new Error((body as { message?: string } | null)?.message ?? "Manajemen ADMS tidak dapat diproses.");
}

function params<T extends object>(input: T) {
  const value = new URLSearchParams();
  for (const [key, item] of Object.entries(input as Record<string, string | number | undefined>)) {
    if (item !== undefined && item !== "") value.set(key, String(item));
  }
  const query = value.toString();
  return query ? `?${query}` : "";
}

export interface AdmsManagementSummary {
  fleet: {
    total: number;
    active: number;
    disabled: number;
    quarantined: number;
    retired: number;
  };
  detectedCount: number;
  unmappedPinCount: number;
  reviewRequiredCount: number;
  pendingJobCount: number;
  failedJob24hCount: number;
}

export type AdmsUserSyncState =
  | "synced"
  | "unmapped"
  | "missing_on_device"
  | "name_drift"
  | "review_required";

export interface AdmsUserSyncItem {
  deviceId: string;
  serialNumber: string;
  deviceName: string | null;
  deviceLifecycle: string;
  pin: string;
  mappingId: string | null;
  employeeId: string | null;
  employeeNumber: string | null;
  employeeName: string | null;
  employeeStatus: string | null;
  observedName: string | null;
  observedCardNumber: string | null;
  rosterObservedAt: string | null;
  lastEventAt: string | null;
  state: AdmsUserSyncState;
}

export interface AdmsManagementJob {
  id: string;
  deviceId: string;
  serialNumber: string;
  deviceName: string | null;
  commandNumber: string;
  commandType: string;
  reason: string;
  action: string;
  status: string;
  attemptCount: number;
  requestedRangeStart: string | null;
  requestedRangeEnd: string | null;
  deliveredAt: string | null;
  acknowledgedAt: string | null;
  completedAt: string | null;
  returnCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdmsManagementHealth {
  deviceId: string;
  serialNumber: string;
  deviceName: string | null;
  lifecycle: string;
  lastSeenAt: string | null;
  lastSuccessfulRequestAt: string | null;
  lastIp: string | null;
  effectiveTimeoutSeconds: number;
  reconciliationEnabled: boolean;
  reconciliationIntervalMinutes: number;
  reconciliationLastRequestedAt: string | null;
  failedJob24hCount: number;
  unmappedPinCount: number;
  sourceIp24hCount: number;
  connectivityStatus: "online" | "offline" | "unknown";
  reconciliationStale: boolean;
  alertCodes: string[];
}

export interface AdmsManagementAudit {
  id: string;
  action: string;
  deviceId: string | null;
  serialNumber: string | null;
  deviceName: string | null;
  actorEmail: string | null;
  createdAt: string;
}

export async function getAdmsManagementSummary() {
  return readJson<AdmsManagementSummary>(
    await fetch("/api/admin/attendance/adms/management/summary", {
      credentials: "include",
      headers: { Accept: "application/json" },
    }),
  );
}

export async function listAdmsUserSync(input: {
  deviceId?: string;
  state?: AdmsUserSyncState;
  q?: string;
  limit?: number;
} = {}) {
  return readJson<{ items: AdmsUserSyncItem[] }>(
    await fetch(`/api/admin/attendance/adms/management/user-sync${params(input)}`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    }),
  );
}

export async function listAdmsManagementJobs(input: {
  status?: string;
  deviceId?: string;
  limit?: number;
} = {}) {
  return readJson<{ items: AdmsManagementJob[] }>(
    await fetch(`/api/admin/attendance/adms/management/jobs${params(input)}`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    }),
  );
}

export async function listAdmsManagementHealth() {
  return readJson<{ items: AdmsManagementHealth[] }>(
    await fetch("/api/admin/attendance/adms/management/health", {
      credentials: "include",
      headers: { Accept: "application/json" },
    }),
  );
}

export async function listAdmsManagementAudit(limit = 100) {
  return readJson<{ items: AdmsManagementAudit[] }>(
    await fetch(`/api/admin/attendance/adms/management/audit?limit=${limit}`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    }),
  );
}

export async function retireAdmsDevice(
  deviceId: string,
  input: { note: string; replacementDeviceId?: string | null },
) {
  return readJson<{ item: AdmsDevice & { retiredAt: string; retirementNote: string; replacedByDeviceId: string | null } }>(
    await fetch(`/api/admin/attendance/adms/devices/${deviceId}/retire`, {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}
