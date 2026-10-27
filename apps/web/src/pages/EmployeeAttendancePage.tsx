import { AlertTriangle, CalendarDays, CalendarRange, CheckCircle2, ClipboardCheck, Clock3, Loader2, LogIn, LogOut, Plus, TimerReset } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ClarificationForm } from "@/components/attendance/ClarificationForm";
import { AppShell } from "@/layouts/AppShell";
import { clarificationKindLabel, clarificationModeLabel, requestStatusLabel } from "@/lib/attendanceLabels";
import {
  canClarifyDate,
  awaitingLabel,
  cancelAttendanceOvertime,
  respondToOvertimeOrder,
  cancelMyAttendanceClarification,
  getMyAttendanceScheduleRange,
  getMyWorkforceAttendance,
  listMyAttendanceClarifications,
  submitAttendanceOvertime,
  type MyAttendanceClarification,
  type WorkforceResult,
  type WorkforceSnapshot,
} from "@/lib/workforceAttendance";

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
}
function jakartaToday() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date()); }
function shiftDate(value: string, days: number) { const d = new Date(value + "T00:00:00Z"); d.setUTCDate(d.getUTCDate()+days); return d.toISOString().slice(0,10); }
function formatDate(value: string) { return new Intl.DateTimeFormat("id-ID",{weekday:"short",day:"numeric",month:"short",year:"numeric",timeZone:"UTC"}).format(new Date(value+"T00:00:00Z")); }
/** Monday of the week containing the date (ISO week, as the roster). */
function mondayOf(value: string) { const day = new Date(value + "T00:00:00Z").getUTCDay(); return shiftDate(value, -((day + 6) % 7)); }
function formatTime(value: string | null | undefined) { return value ? new Intl.DateTimeFormat("id-ID",{hour:"2-digit",minute:"2-digit",hourCycle:"h23",timeZone:"Asia/Jakarta"}).format(new Date(value)) : "—"; }
function statusLabel(value: string | undefined) {
  const labels: Record<string,string> = { scheduled:"Terjadwal",pending:"Belum check-in",present:"Hadir",late:"Terlambat",incomplete:"Belum lengkap",leave:"Cuti / Izin",absent:"Tidak hadir",off:"Libur",configuration_error:"Jadwal perlu diperiksa",submitted:"Menunggu",approved:"Disetujui",rejected:"Ditolak",cancelled:"Dibatalkan" };
  return value ? labels[value] ?? value : "Belum dievaluasi";
}
function ResultFacts({ result }: { result: WorkforceResult | null }) {
  if (!result) return <span className="text-xs text-muted-foreground">Belum ada hasil materialized.</span>;
  return <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
    <span>Kerja {result.workedMinutes} mnt</span><span>Istirahat {result.breakMinutes} mnt</span>
    {result.lateMinutes > 0 ? <span>Telat {result.lateMinutes} mnt{result.lateJustified ? " · beralasan" : ""}</span> : null}
    {result.earlyLeaveMinutes > 0 ? <span>Pulang awal {result.earlyLeaveMinutes} mnt{result.earlyLeaveJustified ? " · beralasan" : ""}</span> : null}
    {result.overtimeMinutes > 0 ? <span>Lembur disetujui {result.overtimeMinutes} mnt</span> : null}
  </div>;
}

/** The most likely reason for a row, preselected in the form (the employee can change it). */
function kindFor(status: string | undefined) {
  return status === "late" ? "lateness" : status === "incomplete" ? "missing_check_out" : "other";
}

type OvertimeRequest = NonNullable<Awaited<ReturnType<typeof getMyWorkforceAttendance>>["overtimeRequests"]>[number];

/** ATT-011-6b-2: one overtime request; a supervisor's order waiting for the employee asks Setuju / Tolak. */
export function OvertimeRequestCard({ item, busy, cancelling, onCancel, onRespond }: {
  item: OvertimeRequest;
  busy: boolean;
  cancelling: boolean;
  onCancel: () => void;
  onRespond: (decision: "agree" | "decline") => void;
}) {
  const order = item.initiatedBy === "supervisor";
  const waitingForMe = order && item.status === "submitted";
  return (
    <div className={`rounded-xl p-3 text-xs ${waitingForMe ? "border border-brand-primary/40 bg-brand-primary-pale" : "bg-surface"}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          {order ? <p className="font-bold text-brand-heading">Perintah lembur dari atasan{item.supervisorName ? ` (${item.supervisorName})` : ""}</p> : null}
          <p className="font-semibold">{item.workDate} · {item.requestedMinutes} mnt · {requestStatusLabel(item.status)}</p>
          {item.note ? <p className="mt-1">{item.note}</p> : null}
          {item.awaiting && !waitingForMe ? <p className="mt-1 text-muted-foreground">{awaitingLabel(item.awaiting, item.supervisorName)}</p> : null}
          {item.approvedMinutes != null ? <p className="mt-1 text-muted-foreground">Disetujui {item.approvedMinutes} mnt</p> : null}
          {item.decisionNote ? <p className="mt-1 text-muted-foreground">{item.decisionNote}</p> : null}
        </div>
        {item.status === "submitted" && !order ? (
          <button type="button" disabled={busy} onClick={onCancel} className="shrink-0 rounded-lg border px-2.5 py-1.5 text-[11px] font-bold disabled:opacity-50">{cancelling ? "Membatalkan…" : "Batalkan"}</button>
        ) : null}
      </div>
      {waitingForMe ? (
        <div className="mt-2 flex gap-2">
          <button type="button" disabled={busy} onClick={() => onRespond("agree")} className="min-h-10 rounded-lg bg-brand-primary px-4 text-xs font-bold text-brand-foreground disabled:opacity-50">Setuju</button>
          <button type="button" disabled={busy} onClick={() => onRespond("decline")} className="min-h-10 rounded-lg border px-4 text-xs font-bold disabled:opacity-50">Tolak</button>
        </div>
      ) : null}
    </div>
  );
}

export function EmployeeAttendancePage() {
  const today = jakartaToday();
  const [snapshot,setSnapshot]=useState<WorkforceSnapshot|null>(null);
  const [history,setHistory]=useState<Array<{workDate:string;schedule:WorkforceSnapshot["schedule"];result:WorkforceResult|null}>>([]);
  const [loading,setLoading]=useState(true); const [error,setError]=useState<string|null>(null); const [notice,setNotice]=useState<string|null>(null);
  const [overtime,setOvertime]=useState({workDate:today,requestedMinutes:"60",note:""}); const [submitting,setSubmitting]=useState(false);
  const [cancellingOvertimeId,setCancellingOvertimeId]=useState<string|null>(null);
  const [upcoming,setUpcoming]=useState<Array<{workDate:string;schedule:WorkforceSnapshot["schedule"]}>>([]);
  const [clarifications,setClarifications]=useState<MyAttendanceClarification[]>([]);
  const [clarifyingDate,setClarifyingDate]=useState<{workDate:string;kind:string}|null>(null);
  const [cancellingClarificationId,setCancellingClarificationId]=useState<string|null>(null);
  // This week and next week (§8 "Jadwal saya"), 14 days within the 31-day range limit.
  const weekStart=mondayOf(today);

  const fetchAll = () => Promise.all([
    getMyWorkforceAttendance(today),
    getMyAttendanceScheduleRange(shiftDate(today,-29),today),
    getMyAttendanceScheduleRange(weekStart,shiftDate(weekStart,13)),
    listMyAttendanceClarifications(),
  ]);
  const apply = ([current, range, weeks, mine]: Awaited<ReturnType<typeof fetchAll>>) => {
    setSnapshot(current); setHistory([...range.items].reverse()); setUpcoming(weeks.items); setClarifications(mine.items); setError(null);
  };
  const load = async () => { apply(await fetchAll()); };
  useEffect(()=>{
    void fetchAll().then(apply)
      .catch(cause=>setError(cause instanceof Error?cause.message:"Kehadiran tidak dapat dimuat.")).finally(()=>setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[today]);

  const cancelClarification=async(clarificationId:string)=>{
    setCancellingClarificationId(clarificationId);setError(null);setNotice(null);
    try{
      await cancelMyAttendanceClarification(clarificationId);
      setNotice("Klarifikasi dibatalkan.");
      await load();
    }catch(cause){setError(cause instanceof Error?cause.message:"Klarifikasi tidak dapat dibatalkan.");}
    finally{setCancellingClarificationId(null);}
  };

  const user=useMemo(()=>({name:snapshot?.employee.fullName??"Pegawai",initials:initials(snapshot?.employee.fullName??"P"),position:"Pegawai",unit:"Yayasan Sabilul Qur'an"}),[snapshot?.employee.fullName]);
  const currentStatus=snapshot?.result?.status ?? snapshot?.schedule.state;

  const cancelOvertime=async(overtimeId:string)=>{
    setCancellingOvertimeId(overtimeId);setError(null);setNotice(null);
    try{
      await cancelAttendanceOvertime(overtimeId);
      setNotice("Pengajuan lembur dibatalkan.");
      await load();
    }catch(cause){setError(cause instanceof Error?cause.message:"Pengajuan lembur tidak dapat dibatalkan.");}
    finally{setCancellingOvertimeId(null);}
  };

  // ATT-011-6b-2 flow B: agree to or decline a supervisor's order (D-5a).
  const respondOrder=async(overtimeId:string,decision:"agree"|"decline")=>{
    setCancellingOvertimeId(overtimeId);setError(null);setNotice(null);
    try{
      await respondToOvertimeOrder(overtimeId,decision);
      setNotice(decision==="agree"?"Perintah lembur Anda setujui.":"Perintah lembur Anda tolak.");
      await load();
    }catch(cause){setError(cause instanceof Error?cause.message:"Jawaban perintah lembur gagal dikirim.");}
    finally{setCancellingOvertimeId(null);}
  };
  const submitOvertime=async()=>{
    setSubmitting(true);setError(null);setNotice(null);
    try{
      await submitAttendanceOvertime({workDate:overtime.workDate,requestedMinutes:Number(overtime.requestedMinutes),note:overtime.note||null});
      setNotice("Pengajuan lembur dikirim ke atasan Anda. Menit lembur baru masuk rekap setelah disetujui.");
      setOvertime({workDate:today,requestedMinutes:"60",note:""});
      await load();
    }catch(cause){setError(cause instanceof Error?cause.message:"Pengajuan lembur gagal dikirim.");}
    finally{setSubmitting(false);}
  };

  return <AppShell user={user} activeItem="Kehadiran">
    <section>
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Kehadiran saya</p>
      <h1 className="mt-1 text-2xl font-bold text-brand-heading sm:text-3xl">Kehadiran</h1>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">Jadwal, scan fingerprint, presensi HP, koreksi, cuti/izin, dan lembur dibaca dari satu hasil kehadiran canonical.</p>
      <a href="/app/attendance/clock" className="mt-4 inline-flex min-h-11 items-center rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground">Buka Clock In / Out</a>
    </section>
    {error?<div className="mt-5 flex gap-2 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink"><AlertTriangle className="h-4 w-4"/>{error}</div>:null}
    {notice?<div className="mt-5 flex gap-2 rounded-2xl border border-success-line bg-success-soft p-4 text-sm text-success-ink"><CheckCircle2 className="h-4 w-4"/>{notice}</div>:null}
    {loading?<div className="mt-6 flex items-center gap-2 rounded-3xl border bg-surface-raised p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin"/>Memuat kehadiran…</div>:snapshot?<>
      <section className="mt-6 grid gap-4 lg:grid-cols-2">
        <article className="rounded-[2rem] border border-border/80 bg-surface-raised p-5 shadow-[var(--shadow-raised)]">
          <div className="flex justify-between gap-4"><div><p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">{formatDate(snapshot.workDate)}</p><h2 className="mt-1 text-xl font-bold text-brand-heading">{statusLabel(currentStatus)}</h2></div><Clock3 className="h-6 w-6 text-brand-primary-deep"/></div>
          <div className="mt-5 grid grid-cols-2 gap-3"><div className="rounded-2xl bg-surface p-4"><p className="text-xs text-muted-foreground">Jadwal</p><p className="mt-1 font-bold">{formatTime(snapshot.schedule.scheduledStartAt)} – {formatTime(snapshot.schedule.scheduledEndAt)}</p></div><div className="rounded-2xl bg-surface p-4"><p className="text-xs text-muted-foreground">Lokasi</p><p className="mt-1 font-bold">{snapshot.schedule.workLocation?.name??"Tidak ditetapkan"}</p></div></div>
          <div className="mt-3 grid grid-cols-2 gap-3"><div className="rounded-2xl border p-4"><p className="flex items-center gap-2 text-xs text-muted-foreground"><LogIn className="h-4 w-4"/>Masuk aktual</p><p className="mt-1 text-xl font-bold">{formatTime(snapshot.result?.firstCheckInAt)}</p></div><div className="rounded-2xl border p-4"><p className="flex items-center gap-2 text-xs text-muted-foreground"><LogOut className="h-4 w-4"/>Keluar aktual</p><p className="mt-1 text-xl font-bold">{formatTime(snapshot.result?.lastCheckOutAt)}</p></div></div>
          <div className="mt-3"><ResultFacts result={snapshot.result}/></div>
          {snapshot.result?.sessions?.length ? <div className="mt-4 rounded-2xl bg-surface p-4"><p className="text-xs font-bold text-brand-heading">Sesi kerja</p><div className="mt-2 space-y-1 text-xs text-muted-foreground">{snapshot.result.sessions.map(s=><p key={s.sequence}>Sesi {s.sequence}: {formatTime(s.checkInAt)} – {formatTime(s.checkOutAt)} · {s.workedMinutes??0} mnt{s.complete?"":" · belum lengkap"}</p>)}</div></div>:null}
        </article>
        <article id="overtime" className="scroll-mt-28 rounded-[2rem] border border-border/80 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
          <div className="flex items-center gap-2"><TimerReset className="h-5 w-5 text-brand-primary-deep"/><h2 className="font-bold text-brand-heading">Ajukan lembur</h2></div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">Pulang lebih lambat tidak otomatis menjadi lembur. Hanya menit yang disetujui yang masuk hasil kehadiran.</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2"><input className="h-10 rounded-xl border px-3 text-sm" type="date" value={overtime.workDate} onChange={e=>setOvertime({...overtime,workDate:e.target.value})}/><input className="h-10 rounded-xl border px-3 text-sm" type="number" min="1" max="1440" value={overtime.requestedMinutes} onChange={e=>setOvertime({...overtime,requestedMinutes:e.target.value})}/></div>
          <input className="mt-3 h-10 w-full rounded-xl border px-3 text-sm" placeholder="Catatan (opsional)" value={overtime.note} onChange={e=>setOvertime({...overtime,note:e.target.value})}/>
          <button disabled={submitting||!overtime.workDate} onClick={()=>void submitOvertime()} className="mt-3 inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-4 text-xs font-bold text-brand-foreground disabled:opacity-50"><Plus className="h-4 w-4"/>{submitting?"Mengirim…":"Kirim pengajuan"}</button>
          <div className="mt-5 border-t pt-4"><p className="text-xs font-bold text-brand-heading">Pengajuan terakhir</p><div className="mt-2 space-y-2">{snapshot.overtimeRequests?.slice(0,5).map(item=><OvertimeRequestCard key={item.id} item={item} busy={cancellingOvertimeId!==null} cancelling={cancellingOvertimeId===item.id} onCancel={()=>void cancelOvertime(item.id)} onRespond={(decision)=>void respondOrder(item.id,decision)}/>)}{!snapshot.overtimeRequests?.length?<p className="text-xs text-muted-foreground">Belum ada pengajuan lembur.</p>:null}</div></div>
        </article>
      </section>
      <section className="mt-5 rounded-[2rem] border border-border/80 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
        <div className="flex items-center gap-2"><CalendarRange className="h-5 w-5 text-brand-primary-deep"/><div><h2 className="font-bold text-brand-heading">Jadwal saya</h2><p className="text-xs text-muted-foreground">Minggu ini dan minggu depan.</p></div></div>
        <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-7">
          {upcoming.map(item=><li key={item.workDate} className={`rounded-xl border p-3 text-xs ${item.workDate===today?"border-brand-primary/50 bg-brand-primary-pale":""}`}>
            <p className="font-semibold">{formatDate(item.workDate)}</p>
            <p className="mt-1 text-sm font-bold">{item.schedule.state==="scheduled"?`${formatTime(item.schedule.scheduledStartAt)}–${formatTime(item.schedule.scheduledEndAt)}`:item.schedule.state==="off"?"Libur / tanpa jadwal":"Jadwal perlu diperiksa"}</p>
            {item.schedule.rosterId?<p className="mt-1 font-semibold text-warning-ink">Jadwal diganti</p>:null}
          </li>)}
        </ul>
      </section>
      <section id="clarifications" className="scroll-mt-28 mt-5 rounded-[2rem] border border-border/80 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
        <div className="flex items-center gap-2"><ClipboardCheck className="h-5 w-5 text-brand-primary-deep"/><div><h2 className="font-bold text-brand-heading">Klarifikasi saya</h2><p className="text-xs text-muted-foreground">Ajukan dari Riwayat untuk tanggal hingga 7 hari ke belakang. Pengajuan yang masih menunggu bisa dibatalkan.</p></div></div>
        <div className="mt-3 space-y-2">
          {clarifications.slice(0,10).map(item=><div key={item.id} className="flex items-start justify-between gap-3 rounded-xl bg-surface p-3 text-xs">
            <div><p className="font-semibold">{formatDate(item.workDate)} · {clarificationKindLabel(item.kind)} · {clarificationModeLabel(item.mode)}</p><p className="mt-1 text-muted-foreground">{requestStatusLabel(item.status)}{item.decisionNote?` · ${item.decisionNote}`:""}</p></div>
            {item.status==="submitted"?<button type="button" disabled={cancellingClarificationId!==null} onClick={()=>void cancelClarification(item.id)} className="shrink-0 rounded-lg border px-2.5 py-1.5 text-[11px] font-bold disabled:opacity-50">{cancellingClarificationId===item.id?"Membatalkan…":"Batalkan"}</button>:null}
          </div>)}
          {clarifications.length===0?<p className="text-xs text-muted-foreground">Belum ada klarifikasi.</p>:null}
        </div>
      </section>
      <section className="mt-5 overflow-hidden rounded-[2rem] border border-border/80 bg-surface-raised shadow-[var(--shadow-soft)]">
        <header className="flex items-center gap-2 border-b px-5 py-4"><CalendarDays className="h-5 w-5"/><div><h2 className="font-bold text-brand-heading">Riwayat 30 hari</h2><p className="text-xs text-muted-foreground">Hasil kehadiran dan jadwal yang berlaku pada tanggalnya.</p></div></header>
        {clarifyingDate?<div className="border-b bg-surface/60 p-5">
          <p className="mb-3 text-sm font-bold text-brand-heading">Klarifikasi untuk {formatDate(clarifyingDate.workDate)}</p>
          <ClarificationForm key={clarifyingDate.workDate} workDate={clarifyingDate.workDate} defaultKind={clarifyingDate.kind}
            onError={(message)=>{setNotice(null);setError(message);}} onCancel={()=>setClarifyingDate(null)}
            onSubmitted={async(message)=>{setClarifyingDate(null);setError(null);setNotice(message);await load();}}/>
        </div>:null}
        <div className="hidden overflow-x-auto md:block"><table className="min-w-[900px] w-full text-left text-sm"><thead className="bg-surface text-xs text-muted-foreground"><tr><th className="p-3">Tanggal</th><th className="p-3">Status</th><th className="p-3">Jadwal</th><th className="p-3">Masuk</th><th className="p-3">Keluar</th><th className="p-3">Kerja</th><th className="p-3">Telat</th><th className="p-3">Lembur</th><th className="p-3"/></tr></thead><tbody className="divide-y">{history.map(item=><tr key={item.workDate}><td className="p-3 font-semibold">{formatDate(item.workDate)}</td><td className="p-3">{statusLabel(item.result?.status??item.schedule.state)}</td><td className="p-3">{formatTime(item.schedule.scheduledStartAt)}–{formatTime(item.schedule.scheduledEndAt)}</td><td className="p-3">{formatTime(item.result?.firstCheckInAt)}</td><td className="p-3">{formatTime(item.result?.lastCheckOutAt)}</td><td className="p-3">{item.result?.workedMinutes??0} mnt</td><td className="p-3">{item.result?.lateMinutes??0} mnt</td><td className="p-3">{item.result?.overtimeMinutes??0} mnt</td><td className="p-3">{canClarifyDate(item.workDate,today,item.result?.status)?<button type="button" onClick={()=>setClarifyingDate({workDate:item.workDate,kind:kindFor(item.result?.status)})} className="rounded-lg border px-2.5 py-1.5 text-[11px] font-bold">Ajukan klarifikasi</button>:null}</td></tr>)}</tbody></table></div>
        <ul className="divide-y md:hidden">{history.map(item=><li key={item.workDate} className="p-4 text-sm">
          <div className="flex items-start justify-between gap-3"><div><p className="font-semibold">{formatDate(item.workDate)}</p><p className="text-xs text-muted-foreground">{formatTime(item.result?.firstCheckInAt)} → {formatTime(item.result?.lastCheckOutAt)}</p></div><span className="rounded-full bg-surface px-2.5 py-1 text-xs font-bold">{statusLabel(item.result?.status??item.schedule.state)}</span></div>
          {canClarifyDate(item.workDate,today,item.result?.status)?<button type="button" onClick={()=>setClarifyingDate({workDate:item.workDate,kind:kindFor(item.result?.status)})} className="mt-2 min-h-10 rounded-lg border px-3 text-xs font-bold">Ajukan klarifikasi</button>:null}
        </li>)}</ul>
      </section>
    </>:null}
  </AppShell>;
}
