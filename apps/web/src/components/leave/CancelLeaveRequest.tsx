// LEAVE-010: the requester withdraws a request that still awaits a decision. The API decides
// whether an item can be cancelled (`canCancel`) and checks again under lock; this component
// only asks for confirmation and an optional reason.

import { Loader2 } from "lucide-react";
import { useState } from "react";

import { cancelLeaveRequest, EmployeeLeaveApiError } from "@/lib/employeeLeave";

export function CancelLeaveRequest({
  requestId,
  onDone,
}: {
  requestId: string;
  onDone: (outcome: { ok: true } | { ok: false; message: string }) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await cancelLeaveRequest(requestId, reason.trim() || null);
      setConfirming(false);
      onDone({ ok: true });
    } catch (cause) {
      onDone({
        ok: false,
        message: cause instanceof EmployeeLeaveApiError ? cause.message : "Pengajuan belum dapat dibatalkan.",
      });
    } finally {
      setBusy(false);
    }
  };

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="min-h-11 rounded-xl border border-border px-3 text-xs font-bold text-brand-heading"
      >
        Batalkan pengajuan
      </button>
    );
  }

  return (
    <div className="mt-2 rounded-2xl border border-border bg-surface p-3">
      <p className="text-xs font-semibold text-brand-heading">
        Batalkan pengajuan ini? Penyetuju tidak perlu memprosesnya lagi, dan jatah cuti kembali tersedia.
      </p>
      <label className="mt-2 block text-xs text-muted-foreground">
        Alasan (opsional)
        <input
          value={reason}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
          className="mt-1 min-h-11 w-full rounded-xl border border-border bg-surface-raised px-3 text-sm text-brand-heading"
        />
      </label>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void submit()}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-danger-ink px-3 text-xs font-bold text-surface-raised disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          Ya, batalkan
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setConfirming(false)}
          className="min-h-11 rounded-xl border border-border px-3 text-xs font-bold text-brand-heading disabled:opacity-50"
        >
          Tidak jadi
        </button>
      </div>
    </div>
  );
}
