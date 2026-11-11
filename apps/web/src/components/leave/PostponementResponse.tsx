// LEAVE-008: the requester answers an approver's proposal of other dates. The API says whether
// the request awaits an answer (`canRespondToPostponement`) and revalidates under lock; this
// component shows the proposal and asks for confirmation.

import { CalendarClock, CheckCircle2, Loader2 } from "lucide-react";
import { useState } from "react";

import {
  acceptLeavePostponement,
  declineLeavePostponement,
  EmployeeLeaveApiError,
  type LeavePostponement,
} from "@/lib/employeeLeave";
import { formatLeaveRange } from "@/lib/leavePostponementView";

export function PostponementResponse({
  postponement,
  onDone,
}: {
  postponement: LeavePostponement;
  onDone: (outcome: { ok: true; message: string } | { ok: false; message: string }) => void;
}) {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  // One key per proposal view: a retried click replays the same acceptance.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const accept = async () => {
    setBusy("accept");
    try {
      await acceptLeavePostponement(postponement.id, idempotencyKey);
      onDone({ ok: true, message: "Usulan diterima. Pengajuan pengganti sudah dikirim dan menunggu persetujuan." });
    } catch (cause) {
      onDone({
        ok: false,
        message: cause instanceof EmployeeLeaveApiError ? cause.message : "Usulan belum dapat diterima.",
      });
    } finally {
      setBusy(null);
    }
  };

  const decline = async () => {
    setBusy("decline");
    try {
      await declineLeavePostponement(postponement.id, reason.trim() || null);
      setDeclining(false);
      onDone({ ok: true, message: "Usulan ditolak. Pengajuan ini selesai tanpa cuti." });
    } catch (cause) {
      onDone({
        ok: false,
        message: cause instanceof EmployeeLeaveApiError ? cause.message : "Usulan belum dapat ditolak.",
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-3 rounded-2xl border border-warning-line bg-warning-soft p-3 text-left">
      <p className="flex items-center gap-2 text-xs font-bold text-warning-ink">
        <CalendarClock className="h-4 w-4 shrink-0" aria-hidden="true" />
        {postponement.proposedByName} mengusulkan tanggal lain
      </p>
      <p className="mt-2 text-sm font-semibold text-brand-heading">
        {formatLeaveRange(postponement.proposedStartOn, postponement.proposedEndOn)} · {postponement.proposedWorkingDays} hari kerja
      </p>
      <p className="mt-1 whitespace-pre-line text-xs leading-5 text-foreground">{postponement.note}</p>
      <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
        Bila diterima, sistem mengirim pengajuan baru dengan tanggal ini dan persetujuan dimulai lagi dari awal.
      </p>
      {declining ? (
        <div className="mt-3">
          <label className="block text-xs text-muted-foreground">
            Alasan menolak (opsional)
            <input
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              className="mt-1 min-h-11 w-full rounded-xl border border-border bg-surface-raised px-3 text-sm text-brand-heading"
            />
          </label>
          <p className="mt-2 text-xs font-semibold text-brand-heading">Tolak usulan? Pengajuan ini selesai tanpa cuti.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void decline()}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-danger-ink px-3 text-xs font-bold text-surface-raised disabled:opacity-50"
            >
              {busy === "decline" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Ya, tolak usulan
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => setDeclining(false)}
              className="min-h-11 rounded-xl border border-border bg-surface-raised px-3 text-xs font-bold text-brand-heading disabled:opacity-50"
            >
              Kembali
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void accept()}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand-primary px-3 text-xs font-bold text-brand-foreground disabled:opacity-50"
          >
            {busy === "accept" ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            )}
            Terima tanggal ini
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => setDeclining(true)}
            className="min-h-11 rounded-xl border border-border bg-surface-raised px-3 text-xs font-bold text-brand-heading disabled:opacity-50"
          >
            Tolak usulan
          </button>
        </div>
      )}
    </div>
  );
}
