// LEAVE-008: the owner of an active leave approval step proposes other dates instead of approving
// or rejecting. The API checks the dates against the requester's leave rules (preview) and again
// under lock (postpone); this form only collects them.

import { CalendarClock, Loader2 } from "lucide-react";
import { useState } from "react";

import { DetailDialog, useDialogParam } from "@/components/DetailDialog";
import { CriticalPeriodNotice } from "@/components/leave/CriticalPeriodNotice";

import {
  EmployeeLeaveApiError,
  postponeLeaveApproval,
  previewLeavePostponement,
  type LeavePostponementPreview,
} from "@/lib/employeeLeave";
import { formatLeaveRange } from "@/lib/leavePostponementView";

export function ProposeAlternativeDates({
  stepId,
  disabled,
  onDone,
}: {
  stepId: string;
  disabled?: boolean;
  onDone: (outcome: { ok: true; message: string } | { ok: false; message: string }) => void;
}) {
  // The form opens as a small pop-up named in the URL (?usul-tanggal=<stepId>); the button stays in the card.
  const [proposing, showForm, closeForm] = useDialogParam("usul-tanggal");
  const open = proposing === stepId;
  const [startOn, setStartOn] = useState("");
  const [endOn, setEndOn] = useState("");
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<LeavePostponementPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "send" | null>(null);

  const reset = () => {
    setPreview(null);
    setError(null);
  };

  const check = async () => {
    reset();
    if (!startOn || !endOn) {
      setError("Pilih tanggal mulai dan selesai usulan.");
      return;
    }
    setBusy("preview");
    try {
      setPreview(await previewLeavePostponement(stepId, { startOn, endOn }));
    } catch (cause) {
      setError(cause instanceof EmployeeLeaveApiError ? cause.message : "Tanggal usulan belum dapat diperiksa.");
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    if (note.trim().length < 5) {
      setError("Tulis catatan untuk pegawai, minimal 5 karakter.");
      return;
    }
    setBusy("send");
    setError(null);
    try {
      const result = await postponeLeaveApproval(stepId, { startOn, endOn, note: note.trim() });
      closeForm();
      onDone({
        ok: true,
        message: `Usulan ${formatLeaveRange(result.proposedStartOn, result.proposedEndOn)} terkirim. Pegawai akan menerima atau menolaknya.`,
      });
    } catch (cause) {
      const message = cause instanceof EmployeeLeaveApiError ? cause.message : "Usulan tidak dapat dikirim.";
      setError(message);
      if (cause instanceof EmployeeLeaveApiError && ["REQUEST_NOT_REVIEWABLE", "STEP_NOT_PENDING"].includes(cause.code)) {
        onDone({ ok: false, message });
      }
    } finally {
      setBusy(null);
    }
  };

  const cancel = () => {
    closeForm();
    reset();
  };

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => showForm(stepId)}
        className="inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-surface-raised px-4 text-sm font-semibold text-brand-heading hover:bg-muted/50 disabled:opacity-60"
      >
        <CalendarClock className="h-4 w-4" aria-hidden="true" /> Usulkan tanggal lain
      </button>
      {open ? (
        <DetailDialog
          title="Usulkan tanggal lain"
          description="Pengajuan ini tidak disetujui atau ditolak. Pegawai memilih menerima tanggal usulan (pengajuan baru, persetujuan dari awal) atau menolaknya."
          onClose={cancel}
        >
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs font-semibold text-brand-heading">
              Mulai
              <input
                type="date"
                value={startOn}
                onChange={(event) => { setStartOn(event.target.value); reset(); }}
                className="mt-1 h-11 w-full rounded-xl border border-border bg-surface-raised px-2 text-sm font-normal"
              />
            </label>
            <label className="text-xs font-semibold text-brand-heading">
              Selesai
              <input
                type="date"
                value={endOn}
                onChange={(event) => { setEndOn(event.target.value); reset(); }}
                className="mt-1 h-11 w-full rounded-xl border border-border bg-surface-raised px-2 text-sm font-normal"
              />
            </label>
          </div>
          <label className="mt-2 block text-xs font-semibold text-brand-heading">
            Catatan untuk pegawai
            <textarea
              value={note}
              rows={2}
              maxLength={1000}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Mengapa tanggal semula belum dapat diberikan"
              className="mt-1 w-full rounded-xl border border-border bg-surface-raised px-3 py-2 text-sm font-normal"
            />
          </label>
          {error ? <p className="mt-2 text-xs font-semibold text-danger-ink" role="alert">{error}</p> : null}
          {preview ? (
            <div className="mt-2 rounded-xl bg-brand-primary-pale/45 p-2 text-xs text-brand-heading">
              {formatLeaveRange(preview.proposedStartOn, preview.proposedEndOn)} · <b>{preview.workingDays} hari kerja</b>. Tanggal ini memenuhi aturan cuti pegawai.
              {preview.criticalReviewRequired ? <CriticalPeriodNotice periods={preview.criticalPeriods} /> : null}
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {preview ? (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void send()}
                className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand-primary px-3 text-xs font-bold text-brand-foreground disabled:opacity-50"
              >
                {busy === "send" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                Kirim usulan
              </button>
            ) : (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void check()}
                className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border bg-surface-raised px-3 text-xs font-bold text-brand-heading disabled:opacity-50"
              >
                {busy === "preview" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                Periksa tanggal
              </button>
            )}
            <button
              type="button"
              disabled={busy !== null}
              onClick={cancel}
              className="min-h-11 rounded-xl border border-border bg-surface-raised px-3 text-xs font-bold text-brand-heading disabled:opacity-50"
            >
              Batal
            </button>
          </div>
        </DetailDialog>
      ) : null}
    </>
  );
}
