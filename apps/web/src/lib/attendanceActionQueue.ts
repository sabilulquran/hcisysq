import type { AttendanceTransaction } from "@/lib/attendanceCalculation";
import { WorkforceAttendanceApiError } from "@/lib/workforceAttendance";

// ATT-011-3 "Perlu tindakan" queue and the one-day detail panel (§6.1, §6.2).

export type ActionKind = "clarification" | "mobile_review" | "incomplete" | "configuration_error";

export const ACTION_KIND_LABELS: Record<ActionKind, string> = {
  clarification: "Klarifikasi menunggu",
  mobile_review: "Absen HP perlu ditinjau",
  incomplete: "Tidak lengkap lebih dari 1 hari",
  configuration_error: "Jadwal bermasalah",
};

export interface ActionQueueItem {
  kind: ActionKind;
  id: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  unitName: string | null;
  workDate: string;
  detail: string | null;
  mode: string | null;
  reason: string | null;
  occurredAt: string | null;
}

export interface ActionQueue {
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
  kinds: ActionKind[];
  counts: Partial<Record<ActionKind, number>>;
  items: ActionQueueItem[];
}

export interface AttendanceDay {
  employee: { id: string; employeeNumber: string; fullName: string; unitName: string | null };
  workDate: string;
  schedule: {
    state: "scheduled" | "off" | "configuration_error";
    name: string | null;
    scheduledStartAt: string | null;
    scheduledEndAt: string | null;
    lateGraceMinutes: number;
    rosterId: string | null;
    reason?: string;
  };
  result: null | {
    status: string;
    version: number;
    firstCheckInAt: string | null;
    lastCheckOutAt: string | null;
    workedMinutes: number;
    lateMinutes: number;
    earlyLeaveMinutes: number;
    overtimeMinutes: number;
    createdAt: string;
    sessions: Array<{ sequence: number; checkInAt: string | null; checkOutAt: string | null; workedMinutes: number | null; complete: boolean }>;
    /** ATT-013: one entry per block of a multi-block day. */
    blocks?: Array<{ sequence: number; scheduledStartAt: string; scheduledEndAt: string; firstCheckInAt: string | null; lastCheckOutAt: string | null; status: string; lateMinutes: number; earlyLeaveMinutes: number }>;
  };
  punches: AttendanceTransaction[];
  clarifications: Array<{ id: string; kind: string; mode: string; status: string; reason: string; decisionNote: string | null }>;
  leave: Array<{ id: string; name: string; startOn: string; endOn: string }>;
  overtime: Array<{ id: string; status: string; requestedMinutes: number; approvedMinutes: number | null }>;
}

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  const body = (await response.json().catch(() => null)) as T | { code?: string; message?: string } | null;
  if (!response.ok) {
    const error = body as { code?: string; message?: string } | null;
    throw new WorkforceAttendanceApiError(response.status, error?.code ?? "REQUEST_FAILED", error?.message ?? fallback);
  }
  return body as T;
}

export async function getActionQueue(input: { unitId?: string; kind?: ActionKind | ""; page?: number }) {
  const params = new URLSearchParams({ page: String(input.page ?? 1) });
  if (input.unitId) params.set("unitId", input.unitId);
  if (input.kind) params.set("kind", input.kind);
  return readJson<ActionQueue>(
    await fetch(`/api/admin/attendance/action-queue?${params.toString()}`, { credentials: "include", headers: { Accept: "application/json" } }),
    "Antrean tidak dapat dimuat.",
  );
}

export async function getAttendanceDay(employeeId: string, workDate: string) {
  return readJson<AttendanceDay>(
    await fetch(`/api/admin/attendance/daily/${encodeURIComponent(employeeId)}/${encodeURIComponent(workDate)}`, {
      credentials: "include", headers: { Accept: "application/json" },
    }),
    "Detail hari tidak dapat dimuat.",
  );
}

export async function requestEmployeeClarification(employeeId: string, workDate: string) {
  return readJson<{ notified: boolean }>(
    await fetch(`/api/admin/attendance/daily/${encodeURIComponent(employeeId)}/${encodeURIComponent(workDate)}/request-clarification`, {
      method: "POST", credentials: "include", headers: { Accept: "application/json" },
    }),
    "Permintaan klarifikasi tidak dapat dikirim.",
  );
}
