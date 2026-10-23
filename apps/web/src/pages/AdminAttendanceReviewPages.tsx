import { AlertTriangle, CheckCircle2, Eye, Search, Smartphone, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AttendanceWorkforceShell } from "@/components/attendance/workforce/AttendanceWorkforceShell";
import {
  clarificationKindLabel,
  clarificationModeLabel,
  mobileReviewLabel,
  requestStatusLabel,
} from "@/lib/attendanceLabels";
import {
  attendanceMobileEvidencePhotoUrl,
  decideAttendanceClarification,
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
  useEffect(() => {
    void listAttendanceClarificationsForHcByStatus(status)
      .then((result) => setItems(result.items))
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Klarifikasi tidak dapat dimuat."));
  }, [status]);

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
    <AttendanceWorkforceShell tab="clarifications" title="Klarifikasi" description="Pengajuan pegawai untuk memperbaiki jam absen atau menerima alasan. Data scan asli tidak diubah.">
      {error ? <div className="mb-4 flex gap-3 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink"><AlertTriangle className="h-4 w-4" /> {error}</div> : null}
      {notice ? <div className="mb-4 flex gap-3 rounded-2xl border border-success-line bg-success-soft p-4 text-sm text-success-ink"><CheckCircle2 className="h-4 w-4" /> {notice}</div> : null}

      <section className="rounded-2xl border border-border/70 bg-surface-raised shadow-[var(--shadow-soft)]">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 p-4">
          <div><h2 className="font-bold text-brand-heading">Pengajuan pegawai</h2><p className="mt-1 text-xs text-muted-foreground">"Terima alasan" mempertahankan jam yang tercatat. "Perbaiki jam" menambahkan jam usulan setelah disetujui.</p></div>
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
                    <span className="rounded-full bg-surface px-2.5 py-1 text-[11px] font-bold">{requestStatusLabel(item.status)}</span>
                    <span className="rounded-full border border-border px-2.5 py-1 text-[11px]">{clarificationModeLabel(item.mode)}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{item.employeeNumber} · {item.unitName ?? "Tanpa unit"} · {item.workDate} · {clarificationKindLabel(item.kind)}</p>
                  <p className="mt-3 text-sm leading-6">{item.reason}</p>
                  {item.mode === "correction" ? <p className="mt-2 text-xs text-muted-foreground">Usulan masuk: {fmt(item.proposedCheckInAt)} · keluar: {fmt(item.proposedCheckOutAt)}</p> : null}
                  {item.decisionNote ? <p className="mt-2 rounded-xl bg-surface p-3 text-xs">Catatan keputusan: {item.decisionNote}</p> : null}
                </div>
                {item.status === "submitted" ? (
                  <div className="w-full shrink-0 lg:w-[320px]">
                    <textarea value={notes[item.id] ?? ""} onChange={(e) => setNotes({ ...notes, [item.id]: e.target.value })} placeholder="Catatan keputusan (opsional)" className="min-h-20 w-full rounded-xl border p-3 text-sm" />
                    <div className="mt-2 flex gap-2">
                      <button disabled={busy !== null} onClick={() => void decide(item.id, "approve")} className="h-10 flex-1 rounded-xl bg-brand-primary px-3 text-xs font-bold text-brand-foreground disabled:opacity-50">{busy === item.id ? "Memproses…" : "Setujui"}</button>
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

  useEffect(() => {
    void listAttendanceMobileEvidence({ date, reviewState })
      .then((result) => setItems(result.items))
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Bukti absen HP tidak dapat dimuat."));
  }, [date, reviewState]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("id-ID");
    if (!needle) return items;
    return items.filter((item) => [item.employeeName, item.employeeNumber, item.unitName ?? "", item.workLocationName ?? ""].join(" ").toLocaleLowerCase("id-ID").includes(needle));
  }, [items, query]);

  return (
    <AttendanceWorkforceShell tab="mobile-evidence" title="Bukti absen HP" description="Lokasi GPS dan foto absen dari HP. Foto dibuka satu per satu, dan setiap pembukaan dicatat.">
      {error ? <div className="mb-4 flex gap-3 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink"><AlertTriangle className="h-4 w-4" /> {error}</div> : null}

      <section className="rounded-2xl border border-border/70 bg-surface-raised shadow-[var(--shadow-soft)]">
        <header className="flex flex-col gap-3 border-b border-border/70 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div><h2 className="font-bold text-brand-heading">GPS dan foto absen</h2><p className="mt-1 text-xs text-muted-foreground">Absen di luar lokasi atau dengan GPS kurang akurat tetap tersimpan. Keputusan diambil melalui Klarifikasi.</p></div>
          <div className="flex flex-wrap gap-2">
            <label className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><input className="h-10 rounded-xl border pl-9 pr-3 text-sm" placeholder="Cari pegawai/unit…" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
            <input className="h-10 rounded-xl border px-3 text-sm" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <select className="h-10 rounded-xl border px-3 text-sm" value={reviewState} onChange={(e) => setReviewState(e.target.value as typeof reviewState)}><option value="needs_review">Perlu ditinjau</option><option value="accepted">Di dalam lokasi</option><option value="all">Semua</option></select>
          </div>
        </header>

        <div className="overflow-x-auto">
          <table className="min-w-[1100px] w-full text-left text-sm">
            <thead className="bg-surface text-xs text-muted-foreground"><tr><th className="p-3">Pegawai</th><th className="p-3">Aksi/Waktu</th><th className="p-3">Lokasi kerja</th><th className="p-3">GPS</th><th className="p-3">Posisi</th><th className="p-3">Tinjauan</th><th className="p-3">Foto</th></tr></thead>
            <tbody className="divide-y divide-border/70">
              {filtered.map((item) => <tr key={item.id}>
                <td className="p-3"><p className="font-semibold">{item.employeeName}</p><p className="text-xs text-muted-foreground">{item.employeeNumber} · {item.unitName ?? "—"}</p></td>
                <td className="p-3"><p className="font-semibold">{item.action === "check_in" ? "Absen masuk" : "Absen pulang"}</p><p className="text-xs text-muted-foreground">{fmt(item.occurredAt)}</p></td>
                <td className="p-3">{item.workLocationName ?? "Belum ditetapkan"}{item.radiusMeters ? <p className="text-xs text-muted-foreground">radius {item.radiusMeters} m</p> : null}</td>
                <td className="p-3"><p>±{Math.round(item.accuracyMeters)} m</p><p className="text-xs text-muted-foreground">{item.distanceMeters === null ? "jarak —" : Math.round(item.distanceMeters) + " m dari titik"}</p></td>
                <td className="p-3">{geofenceLabel(item.geofenceStatus)}</td>
                <td className="p-3"><span className={"rounded-full px-2.5 py-1 text-xs font-bold " + (item.reviewState === "accepted" ? "bg-success-soft text-success-ink" : "bg-warning-soft text-warning-ink")}>{mobileReviewLabel(item.reviewState)}</span></td>
                <td className="p-3"><button onClick={() => setPhotoId(item.id)} className="inline-flex h-9 items-center gap-2 rounded-xl border px-3 text-xs font-bold"><Eye className="h-4 w-4" /> Lihat</button></td>
              </tr>)}
              {filtered.length === 0 ? <tr><td colSpan={7} className="p-8 text-center text-muted-foreground">Tidak ada bukti absen pada filter ini.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      {photoId ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-xl rounded-2xl bg-surface-raised p-4 shadow-xl">
            <div className="mb-3 flex items-center justify-between"><div className="flex items-center gap-2"><Smartphone className="h-4 w-4" /><h2 className="font-bold">Foto absen</h2></div><button className="rounded-lg p-2 hover:bg-surface" onClick={() => setPhotoId(null)}><X className="h-4 w-4" /></button></div>
            <img src={attendanceMobileEvidencePhotoUrl(photoId)} alt="Foto absen pegawai" className="max-h-[70vh] w-full rounded-xl bg-black object-contain" />
            <p className="mt-3 text-xs text-muted-foreground">Setiap pembukaan foto dicatat dan foto tidak disimpan di perangkat ini.</p>
          </div>
        </div>
      ) : null}
    </AttendanceWorkforceShell>
  );
}
