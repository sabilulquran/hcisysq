import { AlertTriangle, ArrowLeftRight, CalendarRange, CheckCircle2, ChevronRight, ClipboardCheck, Loader2, Plus, RefreshCw, TimerReset } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ClarificationForm } from "@/components/attendance/ClarificationForm";
import { MyTransactionList } from "@/components/attendance/MyTransactionList";
import { AttendancePanel, AttendanceTabList, useAttendanceTab } from "@/components/attendance/AttendanceTabs";
import { DetailDialog, useDialogParam } from "@/components/DetailDialog";
import { DialogMessages } from "@/components/DetailDialogParts";
import { PaginationBar } from "@/components/PaginationBar";
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

/** ENG-LIST-001-L: the 30-day history is a bounded set, so it pages in the browser. */
export const HISTORY_PAGE_SIZE = 7;

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
  if (!result) return <span className="text-xs text-muted-foreground">Menit kerja, telat dan lembur keluar setelah Human Capital menjalankan Kalkulasi.</span>;
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
          {order ? <p className="font-semibold text-brand-heading">Perintah lembur dari atasan{item.supervisorName ? ` (${item.supervisorName})` : ""}</p> : null}
          <p className="font-medium">{item.workDate} · {item.requestedMinutes} mnt · {requestStatusLabel(item.status)}</p>
          {item.note ? <p className="mt-1">{item.note}</p> : null}
          {item.awaiting && !waitingForMe ? <p className="mt-1 text-muted-foreground">{awaitingLabel(item.awaiting, item.supervisorName)}</p> : null}
          {item.approvedMinutes != null ? <p className="mt-1 text-muted-foreground">Disetujui {item.approvedMinutes} mnt</p> : null}
          {item.decisionNote ? <p className="mt-1 text-muted-foreground">{item.decisionNote}</p> : null}
        </div>
        {item.status === "submitted" && !order ? (
          <button type="button" disabled={busy} onClick={onCancel} className="shrink-0 rounded-lg border px-2.5 py-1.5 text-2xs font-semibold disabled:opacity-50">{cancelling ? "Membatalkan…" : "Batalkan"}</button>
        ) : null}
      </div>
      {waitingForMe ? (
        <div className="mt-2 flex gap-2">
          <button type="button" disabled={busy} onClick={() => onRespond("agree")} className="min-h-10 rounded-lg bg-brand-primary px-4 text-xs font-semibold text-brand-foreground disabled:opacity-50">Setuju</button>
          <button type="button" disabled={busy} onClick={() => onRespond("decline")} className="min-h-10 rounded-lg border px-4 text-xs font-semibold disabled:opacity-50">Tolak</button>
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
    <p className="font-semibold text-brand-heading">Hasil kehadiran (kalkulasi)</p>
    <p className="mt-1">Jadwal {formatTime(row.schedule.scheduledStartAt)}–{formatTime(row.schedule.scheduledEndAt)}</p>
    {result ? <>
      <p className="mt-1">{statusLabel(result.status)} · Masuk {formatTime(result.firstCheckInAt)} · Keluar {formatTime(result.lastCheckOutAt)} · Kerja {result.workedMinutes} mnt · Telat {result.lateMinutes} mnt · Lembur {result.overtimeMinutes} mnt</p>
      {day?.newSinceCalculation ? <p className="mt-1 font-semibold text-warning-ink">Ada scan baru sejak dihitung; angka ini bisa berubah setelah Human Capital mengkalkulasi ulang.</p> : null}
    </> : <p className="mt-1">Belum dihitung. Menit kerja, telat dan lembur keluar setelah Human Capital menjalankan Kalkulasi.</p>}
  </div>;
}

export function EmployeeAttendancePage() {
  const today = jakartaToday();
  const [snapshot,setSnapshot]=useState<WorkforceSnapshot|null>(null);
  const [history,setHistory]=useState<HistoryRow[]>([]);
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
  const [tab,selectTab]=useAttendanceTab();
  const [historyPage,setHistoryPage]=useState(1);
  // #overtime is the published "Ajukan lembur" link, so it opens the form, not just the tab.
  const [overtimeFormOpen,setOvertimeFormOpen]=useState(()=>typeof window!=="undefined"&&window.location.hash==="#overtime");
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
      setOvertimeFormOpen(false);
      await load();
    }catch(cause){setError(cause instanceof Error?cause.message:"Pengajuan lembur gagal dikirim.");}
    finally{setSubmitting(false);}
  };

  /**
   * #overtime and #clarifications name a section inside a tab panel that React mounts after the
   * browser has already handled the hash, so the anchor scroll has to be repeated once the panel
   * is on the page. Without this a direct link lands on Pengajuan but at the top of it.
   */
  useEffect(()=>{
    if(loading||tab!=="pengajuan") return;
    const name=window.location.hash.replace(/^#/,"");
    if(name!=="overtime"&&name!=="clarifications") return;
    document.getElementById(name)?.scrollIntoView({block:"start"});
  },[loading,tab]);

  const todayDay=dayFor(snapshot?.workDate??today);
  const todayCheckIn=formatTime(todayDay===undefined?snapshot?.result?.firstCheckInAt:todayDay?.firstScanAt);
  const todayCheckOut=formatTime(todayDay===undefined?snapshot?.result?.lastCheckOutAt:todayDay?.lastScanAt);

  const totalHistory=history.length;
  const pageStart=(historyPage-1)*HISTORY_PAGE_SIZE;
  const pageRows=history.slice(pageStart,pageStart+HISTORY_PAGE_SIZE);

  return <AppShell user={user} activeItem="Kehadiran">
    <section className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold text-brand-heading sm:text-3xl">Kehadiran</h1>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">Scan Anda muncul di sini begitu diterima. Status dan menit kerja keluar setelah Human Capital menghitungnya.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <a href="/app/attendance/clock" className="inline-flex min-h-11 items-center rounded-xl bg-brand-primary px-5 text-sm font-semibold text-brand-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Clock In/Out</a>
        <a href="/app/attendance/shift-swap" className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border px-4 text-sm font-medium text-brand-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><ArrowLeftRight className="h-4 w-4" aria-hidden="true" />Tukar Shift</a>
      </div>
    </section>
    {error&&!clarifyDate?<div className="mt-5 flex gap-2 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink"><AlertTriangle className="h-4 w-4"/>{error}</div>:null}
    {notice&&!clarifyDate?<div className="mt-5 flex gap-2 rounded-2xl border border-success-line bg-success-soft p-4 text-sm text-success-ink"><CheckCircle2 className="h-4 w-4"/>{notice}</div>:null}
    {loading?<div className="mt-6 flex items-center gap-2 rounded-2xl border bg-surface-raised p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin"/>Memuat kehadiran…</div>:snapshot?<>
      {/* Hari ini: one block, no nested cards. Everything an employee checks at a glance. */}
      <section aria-label="Hari ini" className="mt-5 rounded-2xl border border-border/80 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
        <p className="sq-eyebrow text-muted-foreground">{formatDate(snapshot.workDate)}</p>
        <h2 className="mt-1 text-xl font-semibold text-brand-heading">{statusLabel(currentStatus)}</h2>
        <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
          <div><dt className="text-xs text-muted-foreground">Jadwal</dt><dd className="sq-nums mt-0.5 text-base font-medium text-brand-heading">{formatTime(snapshot.schedule.scheduledStartAt)} – {formatTime(snapshot.schedule.scheduledEndAt)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Masuk</dt><dd className="sq-nums mt-0.5 text-base font-medium text-brand-heading">{todayCheckIn}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Keluar</dt><dd className="sq-nums mt-0.5 text-base font-medium text-brand-heading">{todayCheckOut}</dd></div>
        </dl>
        <details className="mt-4 border-t border-border/70 pt-3">
          <summary className="cursor-pointer text-sm font-medium text-brand-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Rincian hari ini</summary>
          <div className="mt-3 space-y-3">
            <p className="text-xs text-muted-foreground">Lokasi: <span className="text-brand-heading">{snapshot.schedule.workLocation?.name??"Tidak ditetapkan"}</span></p>
            <ResultFacts result={snapshot.result}/>
            {snapshot.result?.sessions?.length ? <div className="space-y-1 text-xs text-muted-foreground"><p className="font-medium text-brand-heading">Sesi kerja</p>{snapshot.result.sessions.map(s=><p key={s.sequence}>Sesi {s.sequence}: {formatTime(s.checkInAt)} – {formatTime(s.checkOutAt)} · {s.workedMinutes??0} mnt{s.complete?"":" · belum lengkap"}</p>)}</div>:null}
          </div>
        </details>
      </section>

      <section className="mt-5">
        <AttendanceTabList tab={tab} onSelect={selectTab}/>

        <AttendancePanel tab={tab} value="riwayat">
          <div className="overflow-hidden rounded-2xl border border-border/80 bg-surface-raised shadow-[var(--shadow-soft)]">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
              <div><h2 className="font-semibold text-brand-heading">Riwayat 30 hari</h2><p className="text-xs text-muted-foreground">Jam masuk dan keluar dari scan yang diterima.</p></div>
              <button type="button" onClick={()=>void loadTransactions()} disabled={refreshingTransactions} className="inline-flex min-h-10 items-center gap-2 rounded-lg border px-3 text-xs font-semibold disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{refreshingTransactions?<Loader2 aria-hidden="true" className="h-4 w-4 animate-spin"/>:<RefreshCw aria-hidden="true" className="h-4 w-4"/>}Segarkan scan</button>
            </header>
            {transactionsError?<p role="alert" className="border-b bg-danger-soft px-4 py-3 text-xs text-danger-ink">Scan terbaru tidak dapat dimuat: {transactionsError}</p>:null}
            {transactions?.truncated?<p className="border-b bg-warning-soft px-4 py-3 text-xs text-warning-ink">Scan pada rentang ini terlalu banyak untuk ditampilkan semuanya; hubungi Human Capital.</p>:null}
            {totalHistory===0?<p className="p-8 text-center text-sm text-muted-foreground">Belum ada hari yang tercatat pada 30 hari terakhir.</p>:<>
              <div className="hidden overflow-x-auto md:block"><table className="w-full text-left text-sm"><thead className="bg-surface text-xs text-muted-foreground"><tr><th className="px-4 py-2">Tanggal</th><th className="px-4 py-2">Status</th><th className="px-4 py-2">Masuk</th><th className="px-4 py-2">Keluar</th><th className="px-4 py-2">Kerja</th><th className="px-4 py-2"/></tr></thead><tbody className="divide-y">{pageRows.map(item=>{const cells=historyCells(item,dayFor(item.workDate));return <tr key={item.workDate}>
                <td className="px-4 py-2.5 font-medium">{formatDate(item.workDate)}</td>
                <td className={cells.pending?"px-4 py-2.5 text-muted-foreground":"px-4 py-2.5"}>{cells.status}{cells.stale?<span className="mt-1 block w-fit rounded-full bg-warning-soft px-2 py-0.5 text-2xs font-semibold text-warning-ink">Ada scan baru</span>:null}</td>
                <td className="sq-nums px-4 py-2.5">{cells.checkIn}</td>
                <td className="sq-nums px-4 py-2.5">{cells.checkOut}</td>
                <td className="sq-nums px-4 py-2.5">{cells.worked}</td>
                <td className="px-4 py-2.5 text-right"><button type="button" onClick={()=>showTransactions(item.workDate)} className="rounded-lg border px-2.5 py-1.5 text-2xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Lihat hari ini{cells.scanCount?` (${cells.scanCount})`:""}</button></td>
              </tr>;})}</tbody></table></div>
              {/* One row, one action: date, status and the two scan times, then the day's detail. */}
              <ul className="divide-y md:hidden">{pageRows.map(item=>{const cells=historyCells(item,dayFor(item.workDate));return <li key={item.workDate}>
                <button type="button" onClick={()=>showTransactions(item.workDate)} className="flex w-full items-center justify-between gap-3 p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span className="min-w-0">
                    <span className="block font-medium text-brand-heading">{formatDate(item.workDate)}</span>
                    <span className="sq-nums mt-0.5 block text-xs text-muted-foreground">{cells.checkIn} → {cells.checkOut}</span>
                    {cells.stale?<span className="mt-1 block text-2xs font-semibold text-warning-ink">Ada scan baru sejak dihitung</span>:null}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="rounded-full bg-surface px-2.5 py-1 text-xs font-medium">{cells.status}</span>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true"/>
                  </span>
                </button>
              </li>;})}</ul>
              <PaginationBar page={historyPage} pageSize={HISTORY_PAGE_SIZE} total={totalHistory} onPageChange={setHistoryPage}/>
            </>}
            {history.some(item=>historyCells(item,dayFor(item.workDate)).marker)?<p className="border-t px-4 py-3 text-xs text-muted-foreground"><b>Belum dihitung</b>: scan Anda sudah diterima tetapi tanggalnya belum dikalkulasi Human Capital. <b>Ada scan baru</b>: angka pada baris itu dihitung sebelum scan terbaru masuk dan bisa berubah.</p>:null}
          </div>
        </AttendancePanel>

        <AttendancePanel tab={tab} value="jadwal">
          <section id="jadwal" className="scroll-mt-28 rounded-2xl border border-border/80 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
            <div className="flex items-center gap-2"><CalendarRange className="h-5 w-5 text-brand-primary-deep"/><div><h2 className="font-semibold text-brand-heading">Jadwal dua minggu</h2><p className="text-xs text-muted-foreground">Minggu ini dan minggu depan.</p></div></div>
            {upcoming.length===0?<p className="mt-4 text-sm text-muted-foreground">Jadwal dua minggu ini belum tersedia.</p>:
            <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {upcoming.map(item=><li key={item.workDate} className={`rounded-xl border p-3 text-xs ${item.workDate===today?"border-brand-primary/50 bg-brand-primary-pale":""}`}>
                <p className="font-medium">{formatDate(item.workDate)}</p>
                <p className="sq-nums mt-1 text-sm font-medium text-brand-heading">{item.schedule.state==="scheduled"?`${formatTime(item.schedule.scheduledStartAt)}–${formatTime(item.schedule.scheduledEndAt)}`:item.schedule.state==="off"?"Libur / tanpa jadwal":"Jadwal perlu diperiksa"}</p>
                {item.schedule.rosterId?<p className="mt-1 font-medium text-warning-ink">Jadwal diganti</p>:null}
              </li>)}
            </ul>}
          </section>
        </AttendancePanel>

        <AttendancePanel tab={tab} value="pengajuan">
          <div className="grid gap-4">
            <section id="overtime" className="scroll-mt-28 rounded-2xl border border-border/80 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-center gap-2"><TimerReset className="h-5 w-5 text-brand-primary-deep"/><div><h2 className="font-semibold text-brand-heading">Lembur</h2><p className="text-xs text-muted-foreground">Hanya menit yang disetujui yang masuk hasil kehadiran.</p></div></div>
                {!overtimeFormOpen?<button type="button" onClick={()=>setOvertimeFormOpen(true)} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border px-4 text-xs font-semibold text-brand-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Plus className="h-4 w-4" aria-hidden="true"/>Ajukan lembur</button>:null}
              </div>
              {overtimeFormOpen?<div className="mt-4 rounded-xl border border-border/70 p-4">
                <fieldset disabled={submitting} className="min-w-0">
                  <legend className="text-xs font-medium text-brand-heading">Pengajuan lembur baru</legend>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="grid gap-1 text-xs text-muted-foreground">Tanggal<input className="h-10 rounded-xl border px-3 text-sm text-brand-heading" type="date" value={overtime.workDate} onChange={e=>setOvertime({...overtime,workDate:e.target.value})}/></label>
                    <label className="grid gap-1 text-xs text-muted-foreground">Menit<input className="h-10 rounded-xl border px-3 text-sm text-brand-heading" type="number" min="1" max="1440" value={overtime.requestedMinutes} onChange={e=>setOvertime({...overtime,requestedMinutes:e.target.value})}/></label>
                  </div>
                  <label className="mt-3 grid gap-1 text-xs text-muted-foreground">Catatan (opsional)<input className="h-10 w-full rounded-xl border px-3 text-sm text-brand-heading" value={overtime.note} onChange={e=>setOvertime({...overtime,note:e.target.value})}/></label>
                </fieldset>
                <OvertimeWarnings warnings={overtimeWarnings}/>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button disabled={submitting||!overtime.workDate} onClick={()=>void submitOvertime(overtimeWarnings!==null)} className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-brand-primary px-4 text-xs font-semibold text-brand-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{submitting?"Mengirim…":overtimeWarnings?"Tetap kirim":"Kirim pengajuan"}</button>
                  <button type="button" disabled={submitting} onClick={()=>{setOvertimeFormOpen(false);setOvertimeWarnings(null);}} className="inline-flex min-h-10 items-center rounded-xl border px-4 text-xs font-medium disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Batal</button>
                </div>
              </div>:null}
              <div className="mt-4 space-y-2">
                {snapshot.overtimeRequests?.slice(0,5).map(item=><OvertimeRequestCard key={item.id} item={item} busy={cancellingOvertimeId!==null} cancelling={cancellingOvertimeId===item.id} onCancel={()=>void cancelOvertime(item.id)} onRespond={(decision)=>void respondOrder(item.id,decision)}/>)}
                {!snapshot.overtimeRequests?.length?<p className="text-xs text-muted-foreground">Belum ada pengajuan lembur.</p>:null}
              </div>
            </section>

            <section id="clarifications" className="scroll-mt-28 rounded-2xl border border-border/80 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
              <div className="flex items-center gap-2"><ClipboardCheck className="h-5 w-5 text-brand-primary-deep"/><div><h2 className="font-semibold text-brand-heading">Klarifikasi</h2><p className="text-xs text-muted-foreground">Ajukan dari sebuah hari di Riwayat, hingga 7 hari ke belakang.</p></div></div>
              <div className="mt-3 space-y-2">
                {clarifications.slice(0,10).map(item=><div key={item.id} className="flex items-start justify-between gap-3 rounded-xl bg-surface p-3 text-xs">
                  <div><p className="font-medium">{formatDate(item.workDate)} · {clarificationKindLabel(item.kind)} · {clarificationModeLabel(item.mode)}</p><p className="mt-1 text-muted-foreground">{requestStatusLabel(item.status)}{item.decisionNote?` · ${item.decisionNote}`:""}</p></div>
                  {item.status==="submitted"?<button type="button" disabled={cancellingClarificationId!==null} onClick={()=>void cancelClarification(item.id)} className="shrink-0 rounded-lg border px-2.5 py-1.5 text-2xs font-semibold disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{cancellingClarificationId===item.id?"Membatalkan…":"Batalkan"}</button>:null}
                </div>)}
                {clarifications.length===0?<p className="text-xs text-muted-foreground">Belum ada klarifikasi.</p>:null}
              </div>
            </section>
          </div>
        </AttendancePanel>
      </section>

      {transactionDate?<DetailDialog title={formatDate(transactionDate)} description="Setiap scan yang diterima, apa adanya. Ini bukan hasil kehadiran." onClose={closeTransactions}>
        <MyTransactionList items={(transactions?.items??[]).filter(entry=>entry.workDate===transactionDate)} refreshing={refreshingTransactions} generatedAt={transactions?.generatedAt??null} error={transactionsError} onRefresh={()=>void loadTransactions()}/>
        <TransactionResultNote row={history.find(entry=>entry.workDate===transactionDate)??null} day={dayFor(transactionDate)}/>
        {canClarifyDate(transactionDate,today,history.find(entry=>entry.workDate===transactionDate)?.result?.status)?
          <button type="button" onClick={()=>{closeTransactions();showClarification(transactionDate);}} className="mt-4 inline-flex min-h-10 items-center rounded-xl border px-4 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Ajukan klarifikasi</button>
          :null}
      </DetailDialog>:null}
      {clarifyDate?<DetailDialog title={clarifyRow?`Klarifikasi untuk ${formatDate(clarifyRow.workDate)}`:"Klarifikasi kehadiran"} onClose={closeClarification}>
        <DialogMessages error={error}/>
        {clarifyRow&&clarifiable?<ClarificationForm key={clarifyRow.workDate} workDate={clarifyRow.workDate} defaultKind={kindFor(clarifyRow.result?.status)}
          onError={(message)=>{setNotice(null);setError(message);}} onCancel={closeClarification}
          onSubmitted={async(message)=>{closeClarification();setError(null);setNotice(message);await load();}}/>
          :<p className="text-sm text-muted-foreground">Tanggal ini tidak dapat diklarifikasi. Ajukan dari sebuah hari di Riwayat, hingga 7 hari ke belakang.</p>}
      </DetailDialog>:null}
    </>:null}
  </AppShell>;
}
