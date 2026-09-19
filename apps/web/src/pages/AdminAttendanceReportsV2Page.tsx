import { AlertTriangle, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AttendanceWorkforceShell } from "@/components/attendance/workforce/AttendanceWorkforceShell";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import { finalizeAttendanceDate, getAttendanceReportV2, type AttendanceReportType } from "@/lib/workforceAttendance";

function todayJakarta() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date()); }
function monthStart(value: string) { return value.slice(0, 8) + "01"; }
function text(value: unknown) { if (value == null || value === "") return "—"; if (typeof value === "boolean") return value ? "Ya" : "Tidak"; return String(value); }
const labels: Record<AttendanceReportType,string> = { detail:"Detail Harian", period:"Rekap Periode", unit:"Per Unit", sessions:"Sesi Kerja", scans:"Data Scan", schedule:"Jadwal Harian", overtime:"Lembur" };

export function AdminAttendanceReportsV2Page() {
  const today = todayJakarta();
  const [type, setType] = useState<AttendanceReportType>("detail");
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(today);
  const [status, setStatus] = useState("");
  const [data, setData] = useState<{ summary?: Record<string,number>; items: Array<Record<string,unknown>> } | null>(null);
  const [busy, setBusy] = useState(false); const [error,setError]=useState<string|null>(null); const [canFinalize,setCanFinalize]=useState(false);
  useEffect(() => { void getCurrentSession().then((session) => setCanFinalize(hasPermission(session,"attendance.policy.manage"))); },[]);
  useEffect(() => {
    setBusy(true);
    void getAttendanceReportV2({ type, from, to, ...(type === "detail" && status ? { status } : {}) })
      .then((result) => { setData({ summary: result.summary, items: result.items }); setError(null); })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Laporan tidak dapat dimuat."))
      .finally(() => setBusy(false));
  },[type,from,to,status]);

  const columns = useMemo(() => {
    const preferred: Record<AttendanceReportType,string[]> = {
      detail:["workDate","employeeNumber","employeeName","unitName","status","scheduledStartAt","scheduledEndAt","firstCheckInAt","lastCheckOutAt","workedMinutes","breakMinutes","lateMinutes","earlyLeaveMinutes","overtimeMinutes","lateJustified","earlyLeaveJustified"],
      period:["employeeNumber","employeeName","unitName","expectedDays","attendanceDays","lateDays","absenceDays","leaveDays","workedMinutes","breakMinutes","overtimeMinutes"],
      unit:["unitName","employees","expectedDays","attendanceDays","lateDays","absenceDays","leaveDays","workedMinutes","overtimeMinutes"],
      sessions:["workDate","employeeNumber","employeeName","unitName","sequence","checkInAt","checkOutAt","workedMinutes","complete","resultVersion"],
      scans:["occurredAt","receivedAt","employeeNumber","employeeName","unitName","source","eventKind","deviceId","sourceReference"],
      schedule:["workDate","employeeNumber","employeeName","unitName","scheduledStartAt","scheduledEndAt","workLocationName","status","scheduleVersionId"],
      overtime:["workDate","employeeNumber","employeeName","unitName","requestedMinutes","approvedMinutes","status","note","decisionNote"],
    };
    return preferred[type];
  },[type]);

  return <AttendanceWorkforceShell section="reports" title="Laporan Kehadiran" description="Laporan canonical dari result version, session, scan, jadwal historis, dan lembur.">
    {error ? <div className="mb-4 flex gap-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"><AlertTriangle className="h-4 w-4"/>{error}</div> : null}
    <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <label className="text-xs font-semibold text-muted-foreground">Jenis<select className="mt-1 h-10 w-full rounded-xl border px-3 text-sm" value={type} onChange={(e)=>setType(e.target.value as AttendanceReportType)}>{Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
        <label className="text-xs font-semibold text-muted-foreground">Dari<input className="mt-1 h-10 w-full rounded-xl border px-3 text-sm" type="date" value={from} onChange={(e)=>setFrom(e.target.value)}/></label>
        <label className="text-xs font-semibold text-muted-foreground">Sampai<input className="mt-1 h-10 w-full rounded-xl border px-3 text-sm" type="date" value={to} onChange={(e)=>setTo(e.target.value)}/></label>
        <label className="text-xs font-semibold text-muted-foreground">Status<select disabled={type!=="detail"} className="mt-1 h-10 w-full rounded-xl border px-3 text-sm disabled:bg-surface" value={status} onChange={(e)=>setStatus(e.target.value)}><option value="">Semua</option><option value="scheduled">Terjadwal</option><option value="pending">Belum check-in</option><option value="present">Hadir</option><option value="late">Terlambat</option><option value="incomplete">Belum lengkap</option><option value="leave">Cuti/Izin</option><option value="absent">Tidak hadir</option><option value="off">Libur</option><option value="configuration_error">Konfigurasi</option></select></label>
        <div className="flex items-end gap-2"><button className="h-10 rounded-xl border px-3 text-xs font-bold" onClick={()=>{setFrom(monthStart(today));setTo(today);}}>Bulan ini</button>{canFinalize && from===to ? <button disabled={busy} className="h-10 rounded-xl bg-brand-primary px-3 text-xs font-bold text-white disabled:opacity-50" onClick={()=>void finalizeAttendanceDate(from).then(()=>getAttendanceReportV2({type,from,to}).then(r=>setData({summary:r.summary,items:r.items})))}>Finalisasi</button>:null}</div>
      </div>
      {data?.summary ? <div className="mt-4 flex flex-wrap gap-2">{Object.entries(data.summary).map(([key,value])=><span key={key} className="rounded-full bg-surface px-3 py-1.5 text-xs font-bold">{key}: {value}</span>)}</div>:null}
    </section>
    <section className="mt-5 overflow-hidden rounded-2xl border border-border/70 bg-white shadow-[var(--shadow-soft)]">
      <header className="border-b p-4"><h2 className="font-bold text-brand-heading">{labels[type]}</h2><p className="mt-1 text-xs text-muted-foreground">{from} → {to} · {data?.items.length ?? 0} baris</p></header>
      {busy ? <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin"/>Memuat laporan…</div> :
      <div className="overflow-x-auto"><table className="min-w-[1100px] w-full text-left text-sm"><thead className="bg-surface text-xs text-muted-foreground"><tr>{columns.map(col=><th key={col} className="p-3">{col}</th>)}</tr></thead><tbody className="divide-y">{(data?.items??[]).map((row,index)=><tr key={index}>{columns.map(col=><td key={col} className="p-3">{text(row[col])}</td>)}</tr>)}{data && data.items.length===0?<tr><td colSpan={columns.length} className="p-8 text-center text-muted-foreground">Tidak ada data.</td></tr>:null}</tbody></table></div>}
    </section>
  </AttendanceWorkforceShell>;
}
