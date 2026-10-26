import { WorkforceAttendanceApiError } from "@/lib/workforceAttendance";

// ATT-011-3R Perbaikan Absen (ATT-014 §19.6): employee requests and HC corrections in one list.

export type CorrectionStatus = "all" | "submitted" | "approved" | "rejected" | "cancelled";
export type CorrectionOrigin = "employee" | "hc";

export interface AttendanceCorrectionItem {
  id: string;
  workDate: string;
  kind: string;
  mode: "correction" | "justification";
  reason: string;
  status: Exclude<CorrectionStatus, "all">;
  origin: CorrectionOrigin;
  proposedCheckInAt: string | null;
  proposedCheckOutAt: string | null;
  decisionNote: string | null;
  decidedAt: string | null;
  decidedByEmail: string | null;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  unitName: string | null;
  createdAt: string;
}

export interface AttendanceCorrectionPage {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  submittedCount: number | null;
  items: AttendanceCorrectionItem[];
}

export async function listAttendanceCorrections(filter: {
  status: CorrectionStatus;
  origin: "all" | CorrectionOrigin;
  mode: "all" | "correction" | "justification";
  from?: string;
  to?: string;
  q?: string;
  page: number;
}) {
  const params = new URLSearchParams({ status: filter.status, origin: filter.origin, mode: filter.mode, page: String(filter.page), pageSize: "50" });
  if (filter.from) params.set("from", filter.from);
  if (filter.to) params.set("to", filter.to);
  if (filter.q?.trim()) params.set("q", filter.q.trim());
  const response = await fetch(`/api/admin/attendance/clarifications?${params.toString()}`, { credentials: "include", headers: { Accept: "application/json" } });
  const body = (await response.json().catch(() => null)) as AttendanceCorrectionPage | { code?: string; message?: string } | null;
  if (!response.ok) {
    const error = body as { code?: string; message?: string } | null;
    throw new WorkforceAttendanceApiError(response.status, error?.code ?? "ATTENDANCE_CORRECTIONS_FAILED", error?.message ?? "Daftar perbaikan absen tidak dapat dimuat.");
  }
  return body as AttendanceCorrectionPage;
}

export function correctionOriginLabel(origin: CorrectionOrigin): string {
  return origin === "hc" ? "Diinput HC" : "Diajukan pegawai";
}
