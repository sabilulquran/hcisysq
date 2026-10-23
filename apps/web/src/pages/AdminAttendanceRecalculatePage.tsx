import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";

import { AttendanceWorkforceShell } from "@/components/attendance/workforce/AttendanceWorkforceShell";
import { finalizeAttendanceDate } from "@/lib/workforceAttendance";

function todayJakarta() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date()); }

/**
 * ATT-011 §3 Pengaturan → Finalisasi ulang. Until automatic recompute (ATT-011-2) ships, HC recomputes one
 * date here after late scans, schedule changes or leave decisions. Moved from Laporan; behaviour unchanged.
 */
export function AdminAttendanceRecalculatePage() {
  const [date, setDate] = useState(todayJakarta());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async () => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await finalizeAttendanceDate(date);
      setNotice(`Kehadiran ${result.date} dihitung ulang untuk ${result.materialized} pegawai.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Perhitungan ulang gagal.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AttendanceWorkforceShell tab="recalculate" title="Finalisasi ulang" description="Hitung ulang kehadiran semua pegawai untuk satu tanggal, misalnya setelah scan terlambat masuk, jadwal diubah, atau cuti diputuskan.">
      {error ? <div className="mb-4 flex gap-2 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink" role="alert"><AlertTriangle className="h-4 w-4" />{error}</div> : null}
      {notice ? <div className="mb-4 flex gap-2 rounded-2xl border border-success-line bg-success-soft p-4 text-sm text-success-ink"><CheckCircle2 className="h-4 w-4" />{notice}</div> : null}
      <section className="max-w-xl rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
        <label className="text-xs font-semibold text-muted-foreground">Tanggal
          <input className="mt-1 h-11 w-full rounded-xl border px-3 text-sm" type="date" max={todayJakarta()} value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">Data scan, klarifikasi, dan keputusan cuti tidak berubah. Hasil sebelumnya tetap tersimpan sebagai riwayat perhitungan.</p>
        <button type="button" disabled={busy || !date} onClick={() => void run()} className="mt-4 inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-4 text-xs font-bold text-brand-foreground disabled:opacity-50">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Hitung ulang tanggal ini
        </button>
      </section>
    </AttendanceWorkforceShell>
  );
}
