export type ShiftSwapStatus =
  | "awaiting_counterpart"
  | "awaiting_hc"
  | "approved"
  | "rejected_by_counterpart"
  | "rejected_by_hc"
  | "cancelled";

export interface ShiftSwapCandidate {
  id: string;
  employeeNumber: string;
  fullName: string;
  unitName: string | null;
  schedule: {
    scheduleTemplateId: string;
    scheduleVersionId: string;
    scheduledStartAt: string;
    scheduledEndAt: string;
  };
}

export interface ShiftSwapItem {
  id: string;
  requesterEmployeeId: string;
  requesterEmployeeNumber: string;
  requesterName: string;
  requesterUnitName: string | null;
  counterpartEmployeeId: string;
  counterpartEmployeeNumber: string;
  counterpartName: string;
  counterpartUnitName: string | null;
  workDate: string;
  requesterScheduleTemplateId: string;
  requesterScheduleVersionId: string;
  requesterScheduleName: string;
  requesterRosterId: string | null;
  requesterScheduledStartAt: string;
  requesterScheduledEndAt: string;
  counterpartScheduleTemplateId: string;
  counterpartScheduleVersionId: string;
  counterpartScheduleName: string;
  counterpartRosterId: string | null;
  counterpartScheduledStartAt: string;
  counterpartScheduledEndAt: string;
  note: string | null;
  status: ShiftSwapStatus;
  counterpartDecision: "accepted" | "rejected" | null;
  counterpartDecisionNote: string | null;
  counterpartDecidedAt: string | null;
  hcDecision: "approved" | "rejected" | null;
  hcDecisionNote: string | null;
  hcDecidedAt: string | null;
  publishedRosterId: string | null;
  createdAt: string;
  updatedAt: string;
}

export class ShiftSwapApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "ShiftSwapApiError";
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as T | { code?: string; message?: string } | null;
  if (response.ok) return body as T;
  const error = body as { code?: string; message?: string } | null;
  throw new ShiftSwapApiError(
    response.status,
    error?.code ?? "SHIFT_SWAP_REQUEST_FAILED",
    error?.message ?? "Permintaan tukar shift tidak dapat diproses.",
  );
}

export async function getShiftSwapCandidates(workDate: string) {
  return readJson<{
    workDate: string;
    requesterSchedule: {
      scheduleTemplateId: string;
      scheduleVersionId: string;
      scheduledStartAt: string;
      scheduledEndAt: string;
    };
    requesterHasActiveSwap: boolean;
    items: ShiftSwapCandidate[];
  }>(await fetch(`/api/attendance/shift-swaps/candidates?workDate=${encodeURIComponent(workDate)}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  }));
}

export async function getMyShiftSwaps(
  status: "all" | "active" | ShiftSwapStatus = "all",
) {
  return readJson<{ employeeId: string; items: ShiftSwapItem[] }>(
    await fetch(`/api/attendance/shift-swaps/me?status=${encodeURIComponent(status)}`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    }),
  );
}

export async function createShiftSwap(input: {
  counterpartEmployeeId: string;
  workDate: string;
  note?: string | null;
}) {
  return readJson<{ id: string; status: ShiftSwapStatus }>(
    await fetch("/api/attendance/shift-swaps", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function decideShiftSwapAsCounterpart(
  shiftSwapId: string,
  decision: "accept" | "reject",
  note?: string | null,
) {
  return readJson<{ id: string; status: ShiftSwapStatus }>(
    await fetch(`/api/attendance/shift-swaps/${shiftSwapId}/counterpart-decision`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ decision, note: note ?? null }),
    }),
  );
}

export async function cancelShiftSwap(shiftSwapId: string) {
  const response = await fetch(`/api/attendance/shift-swaps/${shiftSwapId}/cancel`, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (response.ok) return;
  await readJson<never>(response);
}

export async function listShiftSwapsForHc(
  status: "all" | ShiftSwapStatus = "awaiting_hc",
) {
  return readJson<{ items: ShiftSwapItem[] }>(
    await fetch(`/api/admin/attendance/shift-swaps?status=${encodeURIComponent(status)}`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    }),
  );
}

export async function decideShiftSwapAsHc(
  shiftSwapId: string,
  decision: "approve" | "reject",
  note?: string | null,
) {
  return readJson<{
    id: string;
    status: ShiftSwapStatus;
    roster?: { rosterId: string; version: number; weekStart: string };
    recomputed?: boolean[];
  }>(await fetch(`/api/admin/attendance/shift-swaps/${shiftSwapId}/decision`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ decision, note: note ?? null }),
  }));
}
