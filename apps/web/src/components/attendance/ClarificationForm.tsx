import { Send } from "lucide-react";
import { useState } from "react";

import { correctionTimestamps } from "@/lib/attendanceCorrection";
import { submitAttendanceClarification } from "@/lib/workforceAttendance";

/**
 * Employee clarification for one work date (ATT-011-7 §8): today from Clock In/Out, or a past date up to
 * 7 days back from Riwayat (the server enforces the window). Justification keeps the actual times;
 * correction proposes new clock times on that work date without touching the raw evidence.
 */
export function ClarificationForm({ workDate, defaultKind = "lateness", onSubmitted, onError, onCancel }: {
  workDate: string;
  defaultKind?: string;
  onSubmitted: (message: string) => void | Promise<void>;
  onError: (message: string) => void;
  onCancel?: () => void;
}) {
  const [mode, setMode] = useState<"correction" | "justification">("justification");
  const [kind, setKind] = useState(defaultKind);
  const [reason, setReason] = useState("");
  const [proposedIn, setProposedIn] = useState("");
  const [proposedOut, setProposedOut] = useState("");
  const [proposedOutNextDay, setProposedOutNextDay] = useState(false);
  const [sending, setSending] = useState(false);

  const proposed = correctionTimestamps({ date: workDate, checkIn: proposedIn, checkOut: proposedOut, checkOutNextDay: proposedOutNextDay });
  const proposalInvalid = mode === "correction" && ((!proposedIn && !proposedOut) || Boolean(proposed.error));

  const submit = async () => {
    if (!reason.trim() || sending || proposalInvalid) return;
    setSending(true);
    try {
      await submitAttendanceClarification({
        workDate, kind, mode, reason: reason.trim(),
        proposedCheckInAt: mode === "correction" ? proposed.checkInAt : null,
        proposedCheckOutAt: mode === "correction" ? proposed.checkOutAt : null,
      });
      setReason(""); setProposedIn(""); setProposedOut(""); setProposedOutNextDay(false);
      await onSubmitted("Klarifikasi dikirim ke Human Capital.");
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Klarifikasi gagal dikirim.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2">
        <select aria-label="Jenis pengajuan" value={mode} onChange={(event) => setMode(event.target.value as "correction" | "justification")} className="h-11 rounded-xl border border-border px-3 text-sm"><option value="justification">Justifikasi</option><option value="correction">Koreksi waktu</option></select>
        <select aria-label="Alasan klarifikasi" value={kind} onChange={(event) => setKind(event.target.value)} className="h-11 rounded-xl border border-border px-3 text-sm"><option value="lateness">Keterlambatan</option><option value="missing_check_in">Jam masuk belum tercatat</option><option value="missing_check_out">Jam keluar belum tercatat</option><option value="machine_issue">Masalah mesin</option><option value="early_leave">Pulang lebih awal</option><option value="outside_geofence">Di luar geofence</option><option value="other">Lainnya</option></select>
      </div>
      {mode === "correction" ? (
        <div className="mt-3">
          <p className="text-xs text-muted-foreground">Usulan jam untuk hari kerja {workDate} (WIB).</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-semibold text-muted-foreground">Jam masuk<input type="time" value={proposedIn} onChange={(event) => setProposedIn(event.target.value)} className="mt-1 h-11 w-full rounded-xl border border-border px-3 text-sm" aria-label="Usulan jam masuk" /></label>
            <div>
              <label className="text-xs font-semibold text-muted-foreground">Jam keluar<input type="time" value={proposedOut} onChange={(event) => setProposedOut(event.target.value)} className="mt-1 h-11 w-full rounded-xl border border-border px-3 text-sm" aria-label="Usulan jam keluar" /></label>
              <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={proposedOutNextDay} onChange={(event) => setProposedOutNextDay(event.target.checked)} />Keluar keesokan hari (+1 hari)</label>
            </div>
          </div>
          {proposed.error ? <p className="mt-2 text-xs font-semibold text-danger-ink" role="alert">{proposed.error}</p> : null}
        </div>
      ) : null}
      <textarea aria-label="Penjelasan klarifikasi" value={reason} maxLength={2000} onChange={(event) => setReason(event.target.value)} placeholder="Tuliskan penjelasan..." className="mt-3 min-h-24 w-full rounded-xl border border-border p-3 text-sm" />
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => void submit()} disabled={!reason.trim() || sending || proposalInvalid} className="min-h-11 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50"><Send className="mr-2 inline h-4 w-4" />{sending ? "Mengirim..." : "Kirim klarifikasi"}</button>
        {onCancel ? <button type="button" onClick={onCancel} className="min-h-11 rounded-xl border px-4 text-sm font-bold">Batal</button> : null}
      </div>
    </div>
  );
}
