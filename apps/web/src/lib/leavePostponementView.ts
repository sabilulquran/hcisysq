// LEAVE-008 display helpers shared by the requester and approver screens.

import type { LeavePostponement } from "@/lib/employeeLeave";

export function formatLeaveDay(value: string) {
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Jakarta",
  }).format(new Date(`${value}T00:00:00+07:00`));
}

export function formatLeaveRange(startOn: string, endOn: string) {
  return startOn === endOn ? formatLeaveDay(startOn) : `${formatLeaveDay(startOn)} – ${formatLeaveDay(endOn)}`;
}

/** Short status line for a request touched by LEAVE-008; null when nothing to add. */
export function postponementStatusNote(item: {
  status: string;
  replacesRequestId?: string | null;
  postponement?: LeavePostponement | null;
}) {
  if (item.status === "postponed") return "Ditangguhkan — diganti pengajuan baru dengan tanggal usulan.";
  if (item.status === "cancelled" && item.postponement?.status === "declined") return "Anda menolak usulan tanggal lain.";
  if (item.replacesRequestId) return "Pengganti pengajuan sebelumnya, menjalani persetujuan dari awal.";
  return null;
}
