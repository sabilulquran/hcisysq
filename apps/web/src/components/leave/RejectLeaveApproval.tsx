// LEAVE-001/APR-001: "Tolak" on an active leave approval step. The reason is collected in the page
// itself, not in `window.prompt`: the browser dialog cannot be read by a screen reader, Android
// Chrome offers to suppress it after the first use, and an approver who suppresses it then presses
// a Tolak button that does nothing. The reason reaches the requester with the decision
// (LEAVE-010-F), so it is written where the approver can see what they are about to send.

import { Loader2, XCircle } from "lucide-react";
import { useState } from "react";

import { DetailDialog, useDialogParam } from "@/components/DetailDialog";

export function RejectLeaveApproval({
  stepId,
  requesterName,
  range,
  disabled,
  onConfirm,
}: {
  stepId: string;
  requesterName: string;
  /** Human-readable dates of the request being refused, shown so the wrong card cannot be refused. */
  range: string;
  disabled?: boolean;
  /** Resolves to null when the decision was sent, or to the message to show inside the dialog. */
  onConfirm: (note: string | null) => Promise<string | null>;
}) {
  const [rejecting, showForm, closeForm] = useDialogParam("tolak-cuti");
  const open = rejecting === stepId;
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancel = () => {
    if (busy) return;
    closeForm();
    setNote("");
    setError(null);
  };

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      // The failure stays in this dialog: closing it would hide the message behind the page banner
      // and throw away a reason the approver has already written.
      const failure = await onConfirm(note.trim() || null);
      if (failure) {
        setError(failure);
        return;
      }
      closeForm();
      setNote("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => showForm(stepId)}
        className="inline-flex h-10 items-center gap-2 rounded-xl border border-danger-line bg-surface-raised px-4 text-sm font-semibold text-danger-ink hover:bg-danger-soft disabled:opacity-60"
      >
        <XCircle className="h-4 w-4" aria-hidden="true" /> Tolak
      </button>
      {open ? (
        <DetailDialog
          title="Tolak pengajuan cuti"
          description={`${requesterName} · ${range}`}
          onClose={cancel}
        >
          <p className="text-sm text-muted-foreground">
            Pengajuan ini ditutup sebagai ditolak dan pemohon menerima pemberitahuannya. Keputusan
            yang sudah dikirim tidak dapat ditarik kembali; pemohon perlu mengajukan ulang.
          </p>
          <label className="mt-3 block text-xs font-semibold text-brand-heading">
            Alasan penolakan (boleh kosong, dibaca pemohon)
            <textarea
              value={note}
              rows={3}
              maxLength={1000}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Misalnya: tanggal itu bentrok dengan kegiatan unit"
              className="mt-1 w-full rounded-xl border border-border bg-surface-raised px-3 py-2 text-sm font-normal"
            />
          </label>
          {error ? (
            <p className="mt-2 text-xs font-semibold text-danger-ink" role="alert">
              {error}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void send()}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-danger-line bg-danger-soft px-3 text-xs font-bold text-danger-ink disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Tolak pengajuan
            </button>
            <button
              type="button"
              disabled={busy}
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
