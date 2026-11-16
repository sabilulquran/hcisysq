import { AlertTriangle, CalendarDays, CalendarRange, CheckCircle2, ClipboardCheck, Clock3, Loader2, LogIn, LogOut, Plus, RefreshCw, TimerReset } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ClarificationForm } from "@/components/attendance/ClarificationForm";
import { MyTransactionList } from "@/components/attendance/MyTransactionList";
import { DetailDialog, useDialogParam } from "@/components/DetailDialog";
import { DialogMessages } from "@/components/DetailDialogParts";
import { AppShell } from "@/layouts/AppShell";
import { OvertimeWarnings } from "@/components/attendance/OvertimeWarnings";
import { clarificationKindLabel, clarificationModeLabel, requestStatusLabel } from "@/lib/attendanceLabels";
import {
  canClarifyDate,
  awaitingLabel,
  cancelAttendanceOvertime,
  respondToOvertimeOrder,
  cancelMyAttendanceClarification,
  getMyAttendanceScheduleRange,
  getMyAttendanceTransactions,
  getMyWorkforceAttendance,
  listMyAttendanceClarifications,
  submitAttendanceOvertime,
  type OvertimeWarning,
  type MyAttendanceClarification,
  type MyTransactionDay,
  type MyTransactions,
  type PendingScans,
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
  const labels: Record<string,string> = { scheduled:"Terjadwal",pending:"Belum check-in",present:"Hadir",late:"Terlambat",incomplete:"Belum lengkap",leave:"Cuti / Izin",absent:"Tidak hadir",off:"Libur",configuration_error:"Jadwal perlu diperiksa",field_assignment:"Tugas luar",remote_work:"WFH/WFA",business_trip:"Dinas",submitted:"Menunggu",approved:"Disetujui",rejected:"Ditolak",cancelled:"Dibatalkan" };
  return value ? labels[value] ?? value : "Belum dievaluasi";
}
export interface HistoryRow {
  workDate: string;
  schedule: WorkforceSnapshot["schedule"];
  result: WorkforceResult | null;
  pendingScans: PendingScans | null;
}

/**
 * ATT-014 §6.5c (DRAFT): Transaksi dan hasil kehadiran dipisah tegas.
 *
 * - Masuk / Keluar dibaca dari transaksi mentah (scan pertama dan terakhir tanggal itu), real-time
 *   dan tidak menunggu Kalkulasi. `day` null berarti tidak ada scan; `undefined` berarti transaksi
 *   belum termuat, lalu baris memakai sumber lama (hasil, atau `pendingScans` §6.5b).
 * - Status, Kerja, Telat, Lembur hanya dari hasil kalkulasi. Tanpa hasil: "—", bukan 0 (keputusan
 *   owner 2026-10-24, kehadiran tidak dihitung otomatis). Ada scan yang masuk setelah hasil dibuat:
 *   angka resmi tetap tampil, diberi penanda "Ada scan baru sejak dihitung".
 */
export function historyCells(item: HistoryRow, day?: MyTransactionDay | null) {
  const result = item.result;
  const live = day !== undefined;
  const firstScan = live ? day?.firstScanAt ?? null : result ? result.firstCheckInAt : item.pendingScans?.firstScanAt ?? null;
  const lastScan = live ? day?.lastScanAt ?? null : result ? result.lastCheckOutAt : item.pendingScans?.lastScanAt ?? null;
  const hasScan = live ? Boolean(day) : item.pendingScans !== null;
  const pending = !result && hasScan;
  const stale = Boolean(result && day?.newSinceCalculation);
  const minutes = (value: number | null | undefined) => result ? `${value ?? 0} mnt` : "—";
  return {
    pending,
    stale,
    marker: pending ? "Belum dihitung" : stale ? "Ada scan baru sejak dihitung" : null,
    status: result ? statusLabel(result.status) : pending ? "Belum dihitung" : statusLabel(item.schedule.state),
    checkIn: formatTime(firstScan),
    checkOut: formatTime(lastScan),
    scanCount: live ? day?.scanCount ?? 0 : item.pendingScans?.scanCount ?? null,
    worked: minutes(result?.workedMinutes),
    late: minutes(result?.lateMinutes),
    overtime: minutes(result?.overtimeMinutes),
  };
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

/** The calculated side of one date, beside its raw punches, so the two are never confused. */
function TransactionResultNote({ row, day }: { row: HistoryRow | null; day: MyTransactionDay | null | undefined }) {
  if (!row) return null;
  const result = row.result;
  return <div className="mt-4 rounded-xl bg-surface p-3 text-xs text-muted-foreground">
    <p className="font-bold text-brand-heading">Hasil kehadiran (kalkulasi)</p>
    {result ? <>
      <p className="mt-1">{statusLabel(result.status)} · Masuk {formatTime(result.firstCheckInAt)} · Keluar {formatTime(result.lastCheckOutAt)} · Kerja {result.workedMinutes} mnt · Telat {result.lateMinutes} mnt</p>
      {day?.newSinceCalculation ? <p className="mt-1 font-bold text-warning-ink">Ada scan baru sejak dihitung; angka ini bisa berubah setelah Human Capital mengkalkulasi ulang.</p> : null}
    </> : <p className="mt-1">Belum dihitung. Menit kerja, telat dan lembur keluar setelah Human Capital menjalankan Kalkulasi.</p>}
  </div>;
}

export function EmployeeAttendancePage() {
  const today = jakartaToday();
  const [snapshot,setSnapshot]=useState<WorkforceSnapshot|null>(null);
  const [history,setHistory]=useState<Array<{workDate:string;schedule:WorkforceSnapshot["schedule"];result:WorkforceResult|null;pendingScans:PendingScans|null}>>([]);
  const [loading,setLoading]=useState(true); const [error,setError]=useState<string|null>(null); const [notice,setNotice]=useState<string|null>(null);
  const [overtime,setOvertimeForm]=useState({workDate:today,requestedMinutes:"60",note:""}); const [submitting,setSubmitting]=useState(false);
  const [overtimeWarnings,setOvertimeWarnings]=useState<OvertimeWarning[]|null>(null);
  // A changed form needs a new check before "Tetap kirim".
  const setOvertime=(value:typeof overtime)=>{setOvertimeForm(value);setOvertimeWarnings(null);};
  const [cancellingOvertimeId,setCancellingOvertimeId]=useState<string|null>(null);
  const [upcoming,setUpcoming]=useState<Array<{workDate:string;schedule:WorkforceSnapshot["schedule"]}>>([]);
  const [clarifications,setClarifications]=useState<MyAttendanceClarification[]>([]);
  // "Ajukan klarifikasi" opens the form for one day as a pop-up named in the URL (?klarifikasi=<tanggal>).
  const [clarifyDate,showClarification,closeClarification]=useDialogParam("klarifikasi");
  const [cancellingClarificationId,setCancellingClarificationId]=useState<string|null>(null);
  // ATT-014 §6.5c: raw punches for the 30-day history, read live and refreshed every minute.
  const [transactions,setTransactions]=useState<MyTransactions|null>(null);
  const [transactionsError,setTransactionsError]=useState<string|null>(null);
  const [refreshingTransactions,setRefreshingTransactions]=useState(false);
  const [transactionDate,showTransactions,closeTransactions]=useDialogParam("transaksi");
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
  const historyFrom=shiftDate(today,-29);
  // Only the latest request may write state: the timer, the tab coming back and Segarkan can overlap.
  const transactionsRequest=useRef(0);
  const loadTransactions=useCallback(async()=>{
    const ticket=++transactionsRequest.current;
    setRefreshingTransactions(true);
    try{
      const next=await getMyAttendanceTransactions(historyFrom,today);
      if(ticket===transactionsRequest.current){ setTransactions(next); setTransactionsError(null); }
    }
    catch(cause){ if(ticket===transactionsRequest.current) setTransactionsError(cause instanceof Error?cause.message:"Transaksi tidak dapat dimuat."); }
    finally{ if(ticket===transactionsRequest.current) setRefreshingTransactions(false); }
  },[historyFrom,today]);
  useEffect(()=>{
    void loadTransactions();
    const onVisible=()=>{ if(document.visibilityState==="visible") void loadTransactions(); };
    const timer=window.setInterval(onVisible,60_000);
    document.addEventListener("visibilitychange",onVisible);
    return ()=>{ transactionsRequest.current+=1; window.clearInterval(timer); document.removeEventListener("visibilitychange",onVisible); };
  },[loadTransactions]);
  const dayByDate=useMemo(()=>new Map((transactions?.days??[]).map(day=>[day.workDate,day])),[transactions]);
  /**
   * undefined while the transactions are not loaded, or for a date dropped by the row ceiling
   * (`truncated`): the row then falls back to the stored sources instead of claiming "no scan".
   */
  const dayFor=(workDate:string):MyTransactionDay|null|undefined=>{
    if(!transactions) return undefined;
    const day=dayByDate.get(workDate);
    return day ?? (transactions.truncated ? undefined : null);
  };
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

  const clarifyRow=clarifyDate?history.find(item=>item.workDate===clarifyDate)??null:null;
  const clarifiable=clarifyRow!==null&&canClarifyDate(clarifyRow.workDate,today,clarifyRow.result?.status);

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
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Jawaban perintah lembur gagal dikirim.");
      // ATT-011-6b-3: a 409 may already have cancelled the order; show it as it is now.
      await load().catch(()=>undefined);
    }
    finally{setCancellingOvertimeId(null);}
  };
  // ATT-011-6b-3 D-5b: check first; above the PP 35/2021 guide the warning is shown and "Tetap kirim" sends.
  const submitOvertime=async(confirmed=false)=>{
    setSubmitting(true);setError(null);setNotice(null);
    const input={workDate:overtime.workDate,requestedMinutes:Number(overtime.requestedMinutes),note:overtime.note||null};
    try{
      if(!confirmed){
        const preview=await submitAttendanceOvertime({...input,dryRun:true});
        if(preview.warnings.length){setOvertimeWarnings(preview.warnings);return;}
      }
      await submitAttendanceOvertime(input);
      setOvertimeWarnings(null);
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
    {error&&!clarifyDate?<div className="mt-5 flex gap-2 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink"><AlertTriangle className="h-4 w-4"/>{error}</div>:null}
    {notice&&!clarifyDate?<div className="mt-5 flex gap-2 rounded-2xl border border-success-line bg-success-soft p-4 text-sm text-success-ink"><CheckCircle2 className="h-4 w-4"/>{notice}</div>:null}
    {loading?<div className="mt-6 flex items-center gap-2 rounded-3xl border bg-surface-raised p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin"/>Memuat kehadiran…</div>:snapshot?<>
      <section className="mt-6 grid gap-4 lg:grid-cols-2">
        <article className="rounded-[2rem] border border-border/80 bg-surface-raised p-5 shadow-[var(--shadow-raised)]">
          <div className="flex justify-between gap-4"><div><p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">{formatDate(snapshot.workDate)}</p><h2 className="mt-1 text-xl font-bold text-brand-heading">{statusLabel(currentStatus)}</h2></div><Clock3 className="h-6 w-6 text-brand-primary-deep"/></div>
          <div className="mt-5 grid grid-cols-2 gap-3"><div className="rounded-2xl bg-surface p-4"><p className="text-xs text-muted-foreground">Jadwal</p><p className="mt-1 font-bold">{formatTime(snapshot.schedule.scheduledStartAt)} – {formatTime(snapshot.schedule.scheduledEndAt)}</p></div><div className="rounded-2xl bg-surface p-4"><p className="text-xs text-muted-foreground">Lokasi</p><p className="mt-1 font-bold">{snapshot.schedule.workLocation?.name??"Tidak ditetapkan"}</p></div></div>
          <div className="mt-3 grid grid-cols-2 gap-3"><div className="rounded-2xl border p-4"><p className="flex items-center gap-2 text-xs text-muted-foreground"><LogIn className="h-4 w-4"/>Masuk aktual</p><p className="mt-1 text-xl font-bold">{formatTime(dayFor(snapshot.workDate)===undefined?snapshot.result?.firstCheckInAt:dayFor(snapshot.workDate)?.firstScanAt)}</p></div><div className="rounded-2xl border p-4"><p className="flex items-center gap-2 text-xs text-muted-foreground"><LogOut className="h-4 w-4"/>Keluar aktual</p><p className="mt-1 text-xl font-bold">{formatTime(dayFor(snapshot.workDate)===undefined?snapshot.result?.lastCheckOutAt:dayFor(snapshot.workDate)?.lastScanAt)}</p></div></div>
          <div className="mt-3"><ResultFacts result={snapshot.result}/></div>
          {snapshot.result?.sessions?.length ? <div className="mt-4 rounded-2xl bg-surface p-4"><p className="text-xs font-bold text-brand-heading">Sesi kerja</p><div className="mt-2 space-y-1 text-xs text-muted-foreground">{snapshot.result.sessions.map(s=><p key={s.sequence}>Sesi {s.sequence}: {formatTime(s.checkInAt)} – {formatTime(s.checkOutAt)} · {s.workedMinutes??0} mnt{s.complete?"":" · belum lengkap"}</p>)}</div></div>:null}
        </article>
        <article id="overtime" className="scroll-mt-28 rounded-[2rem] border border-border/80 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
          <div className="flex items-center gap-2"><TimerReset className="h-5 w-5 text-brand-primary-deep"/><h2 className="font-bold text-brand-heading">Ajukan lembur</h2></div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">Pulang lebih lambat tidak otomatis menjadi lembur. Hanya menit yang disetujui yang masuk hasil kehadiran.</p>
          <fieldset disabled={submitting} className="min-w-0"><div className="mt-4 grid gap-3 sm:grid-cols-2"><input className="h-10 rounded-xl border px-3 text-sm" type="date" value={overtime.workDate} onChange={e=>setOvertime({...overtime,workDate:e.target.value})}/><input className="h-10 rounded-xl border px-3 text-sm" type="number" min="1" max="1440" value={overtime.requestedMinutes} onChange={e=>setOvertime({...overtime,requestedMinutes:e.target.value})}/></div>
          <input className="mt-3 h-10 w-full rounded-xl border px-3 text-sm" placeholder="Catatan (opsional)" value={overtime.note} onChange={e=>setOvertime({...overtime,note:e.target.value})}/></fieldset>
          <OvertimeWarnings warnings={overtimeWarnings}/>
          <button disabled={submitting||!overtime.workDate} onClick={()=>void submitOvertime(overtimeWarnings!==null)} className="mt-3 inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-4 text-xs font-bold text-brand-foreground disabled:opacity-50"><Plus className="h-4 w-4"/>{submitting?"Mengirim…":overtimeWarnings?"Tetap kirim":"Kirim pengajuan"}</button>
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
        <header className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4"><div className="flex items-center gap-2"><CalendarDays className="h-5 w-5"/><div><h2 className="font-bold text-brand-heading">Riwayat 30 hari</h2><p className="text-xs text-muted-foreground">Masuk dan Keluar dari scan yang diterima (real-time). Status dan menit dari hasil kalkulasi Human Capital.</p></div></div><button type="button" onClick={()=>void loadTransactions()} disabled={refreshingTransactions} className="inline-flex min-h-10 items-center gap-2 rounded-lg border px-3 text-xs font-bold disabled:opacity-50">{refreshingTransactions?<Loader2 aria-hidden="true" className="h-4 w-4 animate-spin"/>:<RefreshCw aria-hidden="true" className="h-4 w-4"/>}Segarkan scan</button></header>
        {transactionsError?<p role="alert" className="border-b bg-danger-soft px-5 py-3 text-xs text-danger-ink">Scan terbaru tidak dapat dimuat: {transactionsError}</p>:null}
        {transactions?.truncated?<p className="border-b bg-warning-soft px-5 py-3 text-xs text-warning-ink">Scan pada rentang ini terlalu banyak untuk ditampilkan semuanya; hubungi Human Capital.</p>:null}
        <div className="hidden overflow-x-auto md:block"><table className="min-w-[900px] w-full text-left text-sm"><thead className="bg-surface text-xs text-muted-foreground"><tr><th className="p-3">Tanggal</th><th className="p-3">Status</th><th className="p-3">Jadwal</th><th className="p-3">Masuk</th><th className="p-3">Keluar</th><th className="p-3">Kerja</th><th className="p-3">Telat</th><th className="p-3">Lembur</th><th className="p-3"/></tr></thead><tbody className="divide-y">{history.map(item=>{const cells=historyCells(item,dayFor(item.workDate));return <tr key={item.workDate}><td className="p-3 font-semibold">{formatDate(item.workDate)}</td><td className={cells.pending?"p-3 text-muted-foreground":"p-3"}>{cells.status}{cells.stale?<span className="mt-1 block w-fit rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-bold text-warning-ink">Ada scan baru sejak dihitung</span>:null}</td><td className="p-3">{formatTime(item.schedule.scheduledStartAt)}–{formatTime(item.schedule.scheduledEndAt)}</td><td className="p-3">{cells.checkIn}</td><td className="p-3">{cells.checkOut}</td><td className="p-3">{cells.worked}</td><td className="p-3">{cells.late}</td><td className="p-3">{cells.overtime}</td><td className="p-3"><div className="flex flex-wrap justify-end gap-2"><button type="button" onClick={()=>showTransactions(item.workDate)} className="rounded-lg border px-2.5 py-1.5 text-[11px] font-bold">Transaksi{cells.scanCount?` (${cells.scanCount})`:""}</button>{canClarifyDate(item.workDate,today,item.result?.status)?<button type="button" onClick={()=>showClarification(item.workDate)} className="rounded-lg border px-2.5 py-1.5 text-[11px] font-bold">Ajukan klarifikasi</button>:null}</div></td></tr>;})}</tbody></table></div>
        <ul className="divide-y md:hidden">{history.map(item=>{const cells=historyCells(item,dayFor(item.workDate));return <li key={item.workDate} className="p-4 text-sm">
          <div className="flex items-start justify-between gap-3"><div><p className="font-semibold">{formatDate(item.workDate)}</p><p className="text-xs text-muted-foreground">{cells.checkIn} → {cells.checkOut}</p></div><span className="rounded-full bg-surface px-2.5 py-1 text-xs font-bold">{cells.status}</span></div>
          {cells.stale?<p className="mt-1 text-[11px] font-bold text-warning-ink">Ada scan baru sejak dihitung</p>:null}
          <div className="mt-2 flex flex-wrap gap-2"><button type="button" onClick={()=>showTransactions(item.workDate)} className="min-h-10 rounded-lg border px-3 text-xs font-bold">Transaksi{cells.scanCount?` (${cells.scanCount})`:""}</button>{canClarifyDate(item.workDate,today,item.result?.status)?<button type="button" onClick={()=>showClarification(item.workDate)} className="min-h-10 rounded-lg border px-3 text-xs font-bold">Ajukan klarifikasi</button>:null}</div>
        </li>;})}</ul>
        {history.some(item=>historyCells(item,dayFor(item.workDate)).marker)?<p className="border-t px-5 py-3 text-xs text-muted-foreground"><b>Belum dihitung</b>: scan Anda sudah diterima tetapi tanggalnya belum dikalkulasi Human Capital, jadi menit kerja, telat dan lembur belum keluar. <b>Ada scan baru sejak dihitung</b>: angka di baris itu berasal dari kalkulasi sebelum scan terbaru masuk dan bisa berubah saat dikalkulasi ulang.</p>:null}
      </section>
      {transactionDate?<DetailDialog title={`Transaksi ${formatDate(transactionDate)}`} description="Setiap scan yang diterima, apa adanya. Ini bukan hasil kehadiran." onClose={closeTransactions}>
        <MyTransactionList items={(transactions?.items??[]).filter(entry=>entry.workDate===transactionDate)} refreshing={refreshingTransactions} generatedAt={transactions?.generatedAt??null} error={transactionsError} onRefresh={()=>void loadTransactions()}/>
        <TransactionResultNote row={history.find(entry=>entry.workDate===transactionDate)??null} day={dayFor(transactionDate)}/>
      </DetailDialog>:null}
      {clarifyDate?<DetailDialog title={clarifyRow?`Klarifikasi untuk ${formatDate(clarifyRow.workDate)}`:"Klarifikasi kehadiran"} onClose={closeClarification}>
        <DialogMessages error={error}/>
        {clarifyRow&&clarifiable?<ClarificationForm key={clarifyRow.workDate} workDate={clarifyRow.workDate} defaultKind={kindFor(clarifyRow.result?.status)}
          onError={(message)=>{setNotice(null);setError(message);}} onCancel={closeClarification}
          onSubmitted={async(message)=>{closeClarification();setError(null);setNotice(message);await load();}}/>
          :<p className="text-sm text-muted-foreground">Tanggal ini tidak dapat diklarifikasi. Ajukan dari Riwayat untuk tanggal hingga 7 hari ke belakang.</p>}
      </DetailDialog>:null}
    </>:null}
  </AppShell>;
}
