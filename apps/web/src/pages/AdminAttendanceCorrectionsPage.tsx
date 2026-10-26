import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Loader2, Plus, Search, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { CorrectionEntryForm } from "@/components/attendance/CorrectionEntryForm";
import { MobileEvidencePanel } from "@/components/attendance/MobileEvidencePanel";
import { AttendanceWorkforceShell } from "@/components/attendance/workforce/AttendanceWorkforceShell";
import { getAttendanceTransactions, transactionSourceLabel, type AttendanceTransaction } from "@/lib/attendanceCalculation";
import {
  correctionOriginLabel,
  listAttendanceCorrections,
  type AttendanceCorrectionItem,
  type AttendanceCorrectionPage,
  type CorrectionStatus,
} from "@/lib/attendanceCorrections";
import { clarificationKindLabel, clarificationModeLabel, mobileReviewLabel, requestStatusLabel } from "@/lib/attendanceLabels";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import { decideAttendanceClarification } from "@/lib/workforceAttendance";
import type { AuthSession } from "@/types/hcis";

const STATUS_TABS: Array<{ value: CorrectionStatus; label: string }> = [
  { value: "submitted", label: "Menunggu keputusan" },
  { value: "approved", label: "Disetujui" },
  { value: "rejected", label: "Ditolak" },
  { value: "cancelled", label: "Dibatalkan" },
  { value: "all", label: "Semua" },
];

function longDate(value: string) {
  return new Intl.DateTimeFormat("id-ID", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}
function clock(value: string | null) {
  return value ? new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Jakarta" }).format(new Date(value)) : "—";
}
function proposal(item: AttendanceCorrectionItem) {
  if (item.mode !== "correction") return "—";
  return `${clock(item.proposedCheckInAt)} → ${clock(item.proposedCheckOutAt)}`;
}

function DayPunches({ item, canSeeEvidence }: { item: AttendanceCorrectionItem; canSeeEvidence: boolean }) {
  const [punches, setPunches] = useState<AttendanceTransaction[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setPunches(null);
    setFailed(false);
    void getAttendanceTransactions({ from: item.workDate, to: item.workDate, employeeId: item.employeeId, pageSize: 50 })
      .then((result) => { if (active) setPunches(result.items); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [item.employeeId, item.workDate]);
  if (failed) return <p className="text-xs text-muted-foreground">Absen hari itu tidak dapat dimuat (perlu izin membaca laporan kehadiran).</p>;
  if (!punches) return <p className="text-xs text-muted-foreground">Memuat absen hari itu…</p>;
  if (punches.length === 0) return <p className="text-xs text-muted-foreground">Tidak ada absen tercatat pada tanggal ini.</p>;
  return (
    <ul className="grid gap-2">
      {punches.map((punch) => (
        <li key={`${punch.source}:${punch.id}:${punch.boundary ?? ""}`} className="rounded-xl border p-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold tabular-nums">{clock(punch.occurredAt)}</span>
            <span className="rounded-full bg-surface px-2 py-0.5 font-semibold">{transactionSourceLabel(punch)}</span>
            {punch.reviewState === "needs_review" ? <span className="rounded-full bg-warning-soft px-2 py-0.5 font-semibold text-warning-ink">{mobileReviewLabel(punch.reviewState)}</span> : null}
          </div>
          {canSeeEvidence && punch.evidence ? <div className="mt-2"><MobileEvidencePanel evidence={punch.evidence} /></div> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * ATT-011-3R Perbaikan Absen (ATT-014 §19.6): one list for requests from employees (via HCIS) and
 * corrections entered by HC. Each action keeps its own permission: deciding requests needs
 * attendance.clarification.manage, entering a correction needs attendance.records.manage.
 */
export function AdminAttendanceCorrectionsPage() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const canDecide = hasPermission(session, "attendance.clarification.manage");
  const canEnter = hasPermission(session, "attendance.records.manage");
  const [status, setStatus] = useState<CorrectionStatus>("submitted");
  const [origin, setOrigin] = useState<"all" | "employee" | "hc">("all");
  const [mode, setMode] = useState<"all" | "correction" | "justification">("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AttendanceCorrectionPage | null>(null);
  const [selected, setSelected] = useState<AttendanceCorrectionItem | null>(null);
  const [entering, setEntering] = useState(false);
  const [note, setNote] = useState("");
  const [deciding, setDeciding] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => { void getCurrentSession().then(setSession).catch(() => setSession(null)); }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await listAttendanceCorrections({ status, origin, mode, from, to, q, page }));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Daftar perbaikan absen tidak dapat dimuat.");
    } finally {
      setLoading(false);
    }
  }, [status, origin, mode, from, to, q, page]);

  useEffect(() => { void load(); }, [load]);

  const decide = async (decision: "approve" | "reject") => {
    if (!selected) return;
    setDeciding(decision);
    setError(null);
    try {
      await decideAttendanceClarification(selected.id, decision, note.trim() || null);
      setNotice(decision === "approve" ? "Pengajuan disetujui. Hasil tanggal itu dihitung ulang." : "Pengajuan ditolak.");
      setSelected(null);
      setNote("");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Keputusan gagal disimpan.");
    } finally {
      setDeciding(null);
    }
  };

  const changeFilter = (apply: () => void) => { apply(); setPage(1); setSelected(null); };

  return (
    <AttendanceWorkforceShell tab="corrections" title="Perbaikan Absen" description="Pengajuan pegawai lewat HCIS dan koreksi yang diinput HC, dalam satu daftar. Data scan asli tidak pernah diubah; setiap perbaikan menjadi catatan baru beserta alasannya.">
      {error ? <div className="mb-4 flex gap-2 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink" role="alert"><AlertTriangle className="h-4 w-4 shrink-0" />{error}</div> : null}
      {notice ? <div className="mb-4 flex gap-2 rounded-2xl border border-success-line bg-success-soft p-4 text-sm text-success-ink"><CheckCircle2 className="h-4 w-4 shrink-0" />{notice}</div> : null}

      {canEnter ? (
        <section className="mb-4 rounded-2xl border border-border/70 bg-surface-raised p-4 shadow-[var(--shadow-soft)]">
          {entering ? (
            <>
              <h2 className="mb-3 font-bold text-brand-heading">Input koreksi</h2>
              <CorrectionEntryForm onSaved={() => void load()} onCancel={() => setEntering(false)} />
            </>
          ) : (
            <button type="button" onClick={() => setEntering(true)} className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-4 text-xs font-bold text-brand-foreground">
              <Plus className="h-4 w-4" /> Input koreksi
            </button>
          )}
        </section>
      ) : null}

      <section className="overflow-hidden rounded-2xl border border-border/70 bg-surface-raised shadow-[var(--shadow-soft)]">
        <nav className="flex flex-wrap gap-1 border-b bg-surface px-3 pt-2" aria-label="Status">
          {STATUS_TABS.map((tab) => (
            <button key={tab.value} type="button" aria-pressed={status === tab.value} onClick={() => changeFilter(() => setStatus(tab.value))}
              className={`rounded-t-lg px-3 py-2 text-xs font-bold ${status === tab.value ? "bg-surface-raised text-brand-heading" : "text-muted-foreground"}`}>
              {tab.label}{tab.value === "submitted" && data?.submittedCount ? ` (${data.submittedCount})` : ""}
            </button>
          ))}
        </nav>
        <div className="flex flex-wrap items-end gap-3 border-b p-3">
          <label className="relative"><Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <input aria-label="Cari pegawai" className="h-9 rounded-xl border pl-9 pr-3 text-sm" placeholder="Cari nama/NIP…" value={q} onChange={(event) => changeFilter(() => setQ(event.target.value))} />
          </label>
          <select aria-label="Asal" className="h-9 rounded-xl border px-3 text-sm" value={origin} onChange={(event) => changeFilter(() => setOrigin(event.target.value as typeof origin))}>
            <option value="all">Semua asal</option><option value="employee">Diajukan pegawai</option><option value="hc">Diinput HC</option>
          </select>
          <select aria-label="Jenis" className="h-9 rounded-xl border px-3 text-sm" value={mode} onChange={(event) => changeFilter(() => setMode(event.target.value as typeof mode))}>
            <option value="all">Semua jenis</option><option value="correction">Perbaiki jam</option><option value="justification">Terima alasan</option>
          </select>
          <label className="text-xs text-muted-foreground">Dari <input type="date" className="ml-1 h-9 rounded-xl border px-2 text-sm" value={from} onChange={(event) => changeFilter(() => setFrom(event.target.value))} /></label>
          <label className="text-xs text-muted-foreground">Sampai <input type="date" className="ml-1 h-9 rounded-xl border px-2 text-sm" value={to} onChange={(event) => changeFilter(() => setTo(event.target.value))} /></label>
        </div>

        <div className="grid lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="bg-surface text-xs text-muted-foreground">
                <tr><th className="p-3">Tanggal kerja</th><th className="p-3">Pegawai</th><th className="p-3">Asal</th><th className="p-3">Jenis</th><th className="p-3">Usulan jam</th><th className="p-3">Status</th></tr>
              </thead>
              <tbody className="divide-y">
                {data?.items.map((item) => (
                  <tr key={item.id} onClick={() => { setSelected(item); setNote(""); }} className={`cursor-pointer hover:bg-surface ${selected?.id === item.id ? "bg-brand-primary-pale" : ""}`}>
                    <td className="p-3 tabular-nums">{longDate(item.workDate)}</td>
                    <td className="p-3"><p className="font-semibold">{item.employeeName}</p><p className="text-xs text-muted-foreground">{item.employeeNumber} · {item.unitName ?? "—"}</p></td>
                    <td className="p-3"><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${item.origin === "hc" ? "bg-surface" : "bg-brand-primary-pale text-brand-primary-deep"}`}>{correctionOriginLabel(item.origin)}</span></td>
                    <td className="p-3"><p>{clarificationModeLabel(item.mode)}</p><p className="text-xs text-muted-foreground">{clarificationKindLabel(item.kind)}</p></td>
                    <td className="p-3 tabular-nums">{proposal(item)}</td>
                    <td className="p-3">{requestStatusLabel(item.status)}</td>
                  </tr>
                ))}
                {data && data.items.length === 0 ? <tr><td colSpan={6} className="p-8 text-center text-muted-foreground">Tidak ada perbaikan absen pada filter ini.</td></tr> : null}
              </tbody>
            </table>
            {data ? (
              <footer className="flex items-center justify-between gap-3 border-t p-3 text-xs text-muted-foreground">
                <span>{loading ? "Memuat…" : `${data.total} baris · halaman ${data.page} dari ${data.totalPages}`}</span>
                <div className="flex gap-2">
                  <button type="button" aria-label="Halaman sebelumnya" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)} className="rounded-lg border p-1.5 disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button>
                  <button type="button" aria-label="Halaman berikutnya" disabled={data.page >= data.totalPages} onClick={() => setPage(data.page + 1)} className="rounded-lg border p-1.5 disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button>
                </div>
              </footer>
            ) : null}
          </div>

          <aside className="border-t p-4 lg:border-l lg:border-t-0" aria-label="Detail">
            {selected ? (
              <div className="grid gap-3 text-sm">
                <div className="flex items-start justify-between gap-2">
                  <div><p className="font-bold text-brand-heading">{selected.employeeName}</p><p className="text-xs text-muted-foreground">{longDate(selected.workDate)} · {correctionOriginLabel(selected.origin)}</p></div>
                  <button type="button" aria-label="Tutup detail" onClick={() => setSelected(null)} className="rounded-lg p-1 hover:bg-surface"><X className="h-4 w-4" /></button>
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">Jenis</dt><dd>{clarificationModeLabel(selected.mode)} · {clarificationKindLabel(selected.kind)}</dd>
                  <dt className="text-muted-foreground">Usulan jam</dt><dd className="tabular-nums">{proposal(selected)}</dd>
                  <dt className="text-muted-foreground">Alasan</dt><dd className="whitespace-pre-wrap">{selected.reason}</dd>
                  <dt className="text-muted-foreground">Status</dt><dd>{requestStatusLabel(selected.status)}{selected.decidedByEmail ? ` · oleh ${selected.decidedByEmail}` : ""}</dd>
                  {selected.decisionNote ? <><dt className="text-muted-foreground">Catatan</dt><dd>{selected.decisionNote}</dd></> : null}
                </dl>
                <div>
                  <p className="mb-2 text-xs font-semibold text-muted-foreground">Absen tercatat hari itu</p>
                  <DayPunches item={selected} canSeeEvidence={canDecide} />
                </div>
                {canDecide && selected.status === "submitted" ? (
                  <div className="grid gap-2 border-t pt-3">
                    <textarea aria-label="Catatan keputusan" className="min-h-16 rounded-xl border p-2 text-sm" placeholder="Catatan keputusan (opsional)" maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} />
                    <div className="flex gap-2">
                      <button type="button" disabled={deciding !== null} onClick={() => void decide("approve")} className="inline-flex h-9 items-center gap-1 rounded-xl bg-brand-primary px-3 text-xs font-bold text-brand-foreground disabled:opacity-50">{deciding === "approve" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Setujui</button>
                      <button type="button" disabled={deciding !== null} onClick={() => void decide("reject")} className="inline-flex h-9 items-center gap-1 rounded-xl border px-3 text-xs font-bold disabled:opacity-50">{deciding === "reject" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Tolak</button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : <p className="text-sm text-muted-foreground">Pilih baris untuk melihat alasan, absen hari itu, dan memutuskan pengajuan.</p>}
          </aside>
        </div>
      </section>
    </AttendanceWorkforceShell>
  );
}
