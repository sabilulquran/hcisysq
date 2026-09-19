import { AlertTriangle, CheckCircle2, Eye, Loader2, Search, Smartphone, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AttendanceWorkforceShell } from "@/components/attendance/workforce/AttendanceWorkforceShell";
import {
  attendanceMobileEvidencePhotoUrl,
  decideAttendanceClarification,
  finalizeAttendanceDate,
  getAttendanceReport,
  listAttendanceClarificationsForHcByStatus,
  listAttendanceMobileEvidence,
  type AttendanceMobileEvidenceItem,
} from "@/lib/workforceAttendance";

function todayJakarta() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function fmt(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
  }).format(new Date(value));
}

function statusLabel(value: string) {
  const labels: Record<string, string> = {
    submitted: "Menunggu",
    approved: "Disetujui",
    rejected: "Ditolak",
    cancelled: "Dibatalkan",
    present: "Hadir",
    late: "Terlambat",
    incomplete: "Belum lengkap",
    leave: "Cuti/Izin",
    absent: "Tidak hadir",
    off: "Libur",
    pending: "Berjalan",
    scheduled: "Terjadwal",
    configuration_error: "Konfigurasi bermasalah",
  };
  return labels[value] ?? value;
}

export function AdminAttendanceClarificationsPage() {
  const [status, setStatus] = useState<"all" | "submitted" | "approved" | "rejected" | "cancelled">("submitted");
  const [items, setItems] = useState<Array<{
    id: string; workDate: string; kind: string; mode: string; reason: string; status: string;
    proposedCheckInAt: string | null; proposedCheckOutAt: string | null; decisionNote: string | null;
    decidedAt: string | null; employeeId: string; employeeNumber: string; employeeName: string;
    unitName: string | null; createdAt: string;
  }>>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => setItems((await listAttendanceClarificationsForHcByStatus(status)).items);
  useEffect(() => { void load().catch((cause) => setError(cause instanceof Error ? cause.message : "Klarifikasi tidak dapat dimuat.")); }, [status]);

  const decide = async (id: string, decision: "approve" | "reject") => {
    setBusy(id); setError(null); setNotice(null);
    try {
      await decideAttendanceClarification(id, decision, notes[id]?.trim() || null);
      await load();
      setNotice(decision === "approve" ? "Klarifikasi disetujui." : "Klarifikasi ditolak.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Keputusan tidak dapat disimpan.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <AttendanceWorkforceShell section="clarifications" title="Klarifikasi Kehadiran" description="Tinjau correction dan justification tanpa menulis ulang raw evidence.">
      {error ? <div className="mb-4 flex gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"><AlertTriangle className="h-4 w-4" /> {error}</div> : null}
      {notice ? <div className="mb-4 flex gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800"><CheckCircle2 className="h-4 w-4" /> {notice}</div> : null}

      <section className="rounded-2xl border border-border/70 bg-white shadow-[var(--shadow-soft)]">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 p-4">
          <div><h2 className="font-bold text-brand-heading">Pengajuan pegawai</h2><p className="mt-1 text-xs text-muted-foreground">Justifikasi mempertahankan waktu aktual; correction menambah fakta turunan setelah approval.</p></div>
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="h-10 rounded-xl border px-3 text-sm">
            <option value="submitted">Menunggu</option><option value="approved">Disetujui</option><option value="rejected">Ditolak</option><option value="cancelled">Dibatalkan</option><option value="all">Semua</option>
          </select>
        </header>
        <div className="divide-y divide-border/70">
          {items.map((item) => (
            <article key={item.id} className="p-5">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-bold text-brand-heading">{item.employeeName}</h3>
                    <span className="rounded-full bg-surface px-2.5 py-1 text-[11px] font-bold">{statusLabel(item.status)}</span>
                    <span className="rounded-full border border-border px-2.5 py-1 text-[11px]">{item.mode === "correction" ? "Koreksi waktu" : "Justifikasi"}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{item.employeeNumber} · {item.unitName ?? "Tanpa unit"} · {item.workDate} · {item.kind}</p>
                  <p className="mt-3 text-sm leading-6">{item.reason}</p>
                  {item.mode === "correction" ? <p className="mt-2 text-xs text-muted-foreground">Usulan masuk: {fmt(item.proposedCheckInAt)} · keluar: {fmt(item.proposedCheckOutAt)}</p> : null}
                  {item.decisionNote ? <p className="mt-2 rounded-xl bg-surface p-3 text-xs">Catatan keputusan: {item.decisionNote}</p> : null}
                </div>
                {item.status === "submitted" ? (
                  <div className="w-full shrink-0 lg:w-[320px]">
                    <textarea value={notes[item.id] ?? ""} onChange={(e) => setNotes({ ...notes, [item.id]: e.target.value })} placeholder="Catatan keputusan (opsional)" className="min-h-20 w-full rounded-xl border p-3 text-sm" />
                    <div className="mt-2 flex gap-2">
                      <button disabled={busy !== null} onClick={() => void decide(item.id, "approve")} className="h-10 flex-1 rounded-xl bg-brand-primary px-3 text-xs font-bold text-white disabled:opacity-50">{busy === item.id ? "Memproses…" : "Setujui"}</button>
                      <button disabled={busy !== null} onClick={() => void decide(item.id, "reject")} className="h-10 flex-1 rounded-xl border px-3 text-xs font-bold disabled:opacity-50">Tolak</button>
                    </div>
                  </div>
                ) : null}
              </div>
            </article>
          ))}
          {items.length === 0 ? <div className="p-8 text-center text-sm text-muted-foreground">Tidak ada klarifikasi pada filter ini.</div> : null}
        </div>
      </section>
    </AttendanceWorkforceShell>
  );
}

function geofenceLabel(value: AttendanceMobileEvidenceItem["geofenceStatus"]) {
  if (value === "inside") return "Di dalam area";
  if (value === "outside") return "Di luar area";
  if (value === "uncertain_accuracy") return "Akurasi GPS rendah";
  return "Lokasi belum ditetapkan";
}

export function AdminAttendanceMobileEvidencePage() {
  const [date, setDate] = useState(todayJakarta());
  const [reviewState, setReviewState] = useState<"all" | "accepted" | "needs_review">("needs_review");
  const [items, setItems] = useState<AttendanceMobileEvidenceItem[]>([]);
  const [query, setQuery] = useState("");
  const [photoId, setPhotoId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => setItems((await listAttendanceMobileEvidence({ date, reviewState })).items);
  useEffect(() => { void load().catch((cause) => setError(cause instanceof Error ? cause.message : "Evidence mobile tidak dapat dimuat.")); }, [date, reviewState]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("id-ID");
    if (!needle) return items;
    return items.filter((item) => [item.employeeName, item.employeeNumber, item.unitName ?? "", item.workLocationName ?? ""].join(" ").toLocaleLowerCase("id-ID").includes(needle));
  }, [items, query]);

  return (
    <AttendanceWorkforceShell section="mobile" title="Evidence Mobile" description="Review GPS, geofence, dan foto kamera secara on-demand. Foto tidak dipreload massal.">
      {error ? <div className="mb-4 flex gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"><AlertTriangle className="h-4 w-4" /> {error}</div> : null}

      <section className="rounded-2xl border border-border/70 bg-white shadow-[var(--shadow-soft)]">
        <header className="flex flex-col gap-3 border-b border-border/70 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div><h2 className="font-bold text-brand-heading">GPS + foto presensi</h2><p className="mt-1 text-xs text-muted-foreground">Outside/uncertain evidence tetap disimpan; keputusan administratif dilakukan melalui klarifikasi.</p></div>
          <div className="flex flex-wrap gap-2">
            <label className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><input className="h-10 rounded-xl border pl-9 pr-3 text-sm" placeholder="Cari pegawai/unit…" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
            <input className="h-10 rounded-xl border px-3 text-sm" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <select className="h-10 rounded-xl border px-3 text-sm" value={reviewState} onChange={(e) => setReviewState(e.target.value as typeof reviewState)}><option value="needs_review">Perlu review</option><option value="accepted">Diterima geofence</option><option value="all">Semua</option></select>
          </div>
        </header>

        <div className="overflow-x-auto">
          <table className="min-w-[1100px] w-full text-left text-sm">
            <thead className="bg-surface text-xs text-muted-foreground"><tr><th className="p-3">Pegawai</th><th className="p-3">Aksi/Waktu</th><th className="p-3">Lokasi kerja</th><th className="p-3">GPS</th><th className="p-3">Geofence</th><th className="p-3">Review</th><th className="p-3">Foto</th></tr></thead>
            <tbody className="divide-y divide-border/70">
              {filtered.map((item) => <tr key={item.id}>
                <td className="p-3"><p className="font-semibold">{item.employeeName}</p><p className="text-xs text-muted-foreground">{item.employeeNumber} · {item.unitName ?? "—"}</p></td>
                <td className="p-3"><p className="font-semibold">{item.action === "check_in" ? "Clock in" : "Clock out"}</p><p className="text-xs text-muted-foreground">{fmt(item.occurredAt)}</p></td>
                <td className="p-3">{item.workLocationName ?? "Belum ditetapkan"}{item.radiusMeters ? <p className="text-xs text-muted-foreground">radius {item.radiusMeters} m</p> : null}</td>
                <td className="p-3"><p>±{Math.round(item.accuracyMeters)} m</p><p className="text-xs text-muted-foreground">{item.distanceMeters === null ? "jarak —" : Math.round(item.distanceMeters) + " m dari titik"}</p></td>
                <td className="p-3">{geofenceLabel(item.geofenceStatus)}</td>
                <td className="p-3"><span className={"rounded-full px-2.5 py-1 text-xs font-bold " + (item.reviewState === "accepted" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800")}>{item.reviewState === "accepted" ? "Accepted" : "Needs review"}</span></td>
                <td className="p-3"><button onClick={() => setPhotoId(item.id)} className="inline-flex h-9 items-center gap-2 rounded-xl border px-3 text-xs font-bold"><Eye className="h-4 w-4" /> Lihat</button></td>
              </tr>)}
              {filtered.length === 0 ? <tr><td colSpan={7} className="p-8 text-center text-muted-foreground">Tidak ada evidence pada filter ini.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      {photoId ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-xl rounded-2xl bg-white p-4 shadow-xl">
            <div className="mb-3 flex items-center justify-between"><div className="flex items-center gap-2"><Smartphone className="h-4 w-4" /><h2 className="font-bold">Foto evidence</h2></div><button className="rounded-lg p-2 hover:bg-surface" onClick={() => setPhotoId(null)}><X className="h-4 w-4" /></button></div>
            <img src={attendanceMobileEvidencePhotoUrl(photoId)} alt="Foto evidence presensi" className="max-h-[70vh] w-full rounded-xl bg-black object-contain" />
            <p className="mt-3 text-xs text-muted-foreground">Akses foto diaudit dan response memakai Cache-Control: no-store.</p>
          </div>
        </div>
      ) : null}
    </AttendanceWorkforceShell>
  );
}

export function AdminAttendanceReportsPage() {
  const [date, setDate] = useState(todayJakarta());
  const [status, setStatus] = useState("");
  const [report, setReport] = useState<{ summary: Record<string, number>; items: Array<Record<string, unknown>> } | null>(null);
  const [busy, setBusy] = useState<"load" | "finalize" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    setBusy("load");
    try {
      const result = await getAttendanceReport(date, status || undefined);
      setReport({ summary: result.summary, items: result.items });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Laporan tidak dapat dimuat.");
    } finally { setBusy(null); }
  };
  useEffect(() => { void load(); }, [date, status]);

  const finalize = async () => {
    setBusy("finalize"); setNotice(null); setError(null);
    try {
      const result = await finalizeAttendanceDate(date);
      setNotice(String(result.materialized) + " hasil pegawai dimaterialisasi.");
      const refreshed = await getAttendanceReport(date, status || undefined);
      setReport({ summary: refreshed.summary, items: refreshed.items });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Finalisasi gagal."); }
    finally { setBusy(null); }
  };

  return (
    <AttendanceWorkforceShell section="reports" title="Laporan Kehadiran" description="Finalisasi result version dan baca rekap harian tanpa menghitung potongan payroll.">
      {error ? <div className="mb-4 flex gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"><AlertTriangle className="h-4 w-4" /> {error}</div> : null}
      {notice ? <div className="mb-4 flex gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800"><CheckCircle2 className="h-4 w-4" /> {notice}</div> : null}

      <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs font-semibold text-muted-foreground">Tanggal<input className="mt-1 block h-10 rounded-xl border px-3 text-sm" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label className="text-xs font-semibold text-muted-foreground">Status<select className="mt-1 block h-10 rounded-xl border px-3 text-sm" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Semua</option><option value="present">Hadir</option><option value="late">Terlambat</option><option value="incomplete">Belum lengkap</option><option value="leave">Cuti/Izin</option><option value="absent">Tidak hadir</option><option value="off">Libur</option><option value="configuration_error">Configuration error</option></select></label>
          <button disabled={busy !== null} onClick={() => void finalize()} className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-4 text-xs font-bold text-white disabled:opacity-50">{busy === "finalize" ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Finalisasi tanggal</button>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">{Object.entries(report?.summary ?? {}).map(([key,value]) => <span key={key} className="rounded-full bg-surface px-3 py-1.5 text-xs font-bold">{statusLabel(key)}: {value}</span>)}</div>
      </section>

      <section className="mt-5 overflow-hidden rounded-2xl border border-border/70 bg-white shadow-[var(--shadow-soft)]">
        <div className="overflow-x-auto"><table className="min-w-[1100px] w-full text-left text-sm"><thead className="bg-surface text-xs text-muted-foreground"><tr><th className="p-3">Pegawai</th><th className="p-3">Unit</th><th className="p-3">Status</th><th className="p-3">Masuk</th><th className="p-3">Keluar</th><th className="p-3">Jam kerja</th><th className="p-3">Telat</th><th className="p-3">Pulang awal</th><th className="p-3">Justifikasi</th></tr></thead><tbody className="divide-y">
          {(report?.items ?? []).map((item) => <tr key={String(item.employeeId)}><td className="p-3"><p className="font-semibold">{String(item.employeeName)}</p><p className="text-xs text-muted-foreground">{String(item.employeeNumber)}</p></td><td className="p-3">{String(item.unitName ?? "—")}</td><td className="p-3">{statusLabel(String(item.status))}</td><td className="p-3">{fmt(item.firstCheckInAt as string | null)}</td><td className="p-3">{fmt(item.lastCheckOutAt as string | null)}</td><td className="p-3">{String(item.workedMinutes ?? 0)} mnt</td><td className="p-3">{String(item.lateMinutes ?? 0)} mnt</td><td className="p-3">{String(item.earlyLeaveMinutes ?? 0)} mnt</td><td className="p-3">{item.justified ? "Ya" : "Tidak"}</td></tr>)}
          {report && report.items.length === 0 ? <tr><td colSpan={9} className="p-8 text-center text-muted-foreground">Belum ada hasil pada filter ini. Jalankan finalisasi bila diperlukan.</td></tr> : null}
        </tbody></table></div>
      </section>
    </AttendanceWorkforceShell>
  );
}
