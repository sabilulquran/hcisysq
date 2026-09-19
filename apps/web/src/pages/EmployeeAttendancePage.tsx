import { AlertTriangle, CalendarDays, CheckCircle2, Clock3, Loader2, LogIn, LogOut, Plus, TimerReset } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AppShell } from "@/layouts/AppShell";
import {
  getMyAttendanceScheduleRange,
  getMyWorkforceAttendance,
  submitAttendanceOvertime,
  type WorkforceResult,
  type WorkforceSnapshot,
} from "@/lib/workforceAttendance";

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
}
function jakartaToday() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date()); }
function shiftDate(value: string, days: number) { const d = new Date(value + "T00:00:00Z"); d.setUTCDate(d.getUTCDate()+days); return d.toISOString().slice(0,10); }
function formatDate(value: string) { return new Intl.DateTimeFormat("id-ID",{weekday:"short",day:"numeric",month:"short",year:"numeric",timeZone:"UTC"}).format(new Date(value+"T00:00:00Z")); }
function formatTime(value: string | null | undefined) { return value ? new Intl.DateTimeFormat("id-ID",{hour:"2-digit",minute:"2-digit",hourCycle:"h23",timeZone:"Asia/Jakarta"}).format(new Date(value)) : "—"; }
function statusLabel(value: string | undefined) {
  const labels: Record<string,string> = { scheduled:"Terjadwal",pending:"Belum check-in",present:"Hadir",late:"Terlambat",incomplete:"Belum lengkap",leave:"Cuti / Izin",absent:"Tidak hadir",off:"Libur",configuration_error:"Jadwal perlu diperiksa" };
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

export function EmployeeAttendancePage() {
  const today = jakartaToday();
  const [snapshot,setSnapshot]=useState<WorkforceSnapshot|null>(null);
  const [history,setHistory]=useState<Array<{workDate:string;schedule:WorkforceSnapshot["schedule"];result:WorkforceResult|null}>>([]);
  const [loading,setLoading]=useState(true); const [error,setError]=useState<string|null>(null); const [notice,setNotice]=useState<string|null>(null);
  const [overtime,setOvertime]=useState({workDate:today,requestedMinutes:"60",note:""}); const [submitting,setSubmitting]=useState(false);

  const load = async () => {
    const [current, range] = await Promise.all([
      getMyWorkforceAttendance(today),
      getMyAttendanceScheduleRange(shiftDate(today,-29),today),
    ]);
    setSnapshot(current); setHistory([...range.items].reverse()); setError(null);
  };
  useEffect(()=>{void load().catch(cause=>setError(cause instanceof Error?cause.message:"Kehadiran tidak dapat dimuat.")).finally(()=>setLoading(false));},[]);

  const user=useMemo(()=>({name:snapshot?.employee.fullName??"Pegawai",initials:initials(snapshot?.employee.fullName??"P"),position:"Pegawai",unit:"Yayasan Sabilul Qur'an"}),[snapshot?.employee.fullName]);
  const currentStatus=snapshot?.result?.status ?? snapshot?.schedule.state;

  const submitOvertime=async()=>{
    setSubmitting(true);setError(null);setNotice(null);
    try{
      await submitAttendanceOvertime({workDate:overtime.workDate,requestedMinutes:Number(overtime.requestedMinutes),note:overtime.note||null});
      setNotice("Pengajuan lembur dikirim. Menit lembur baru masuk rekap setelah disetujui.");
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
      <a href="/app/attendance/clock" className="mt-4 inline-flex min-h-11 items-center rounded-xl bg-brand-primary px-4 text-sm font-bold text-white">Buka Clock In / Out</a>
    </section>
    {error?<div className="mt-5 flex gap-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"><AlertTriangle className="h-4 w-4"/>{error}</div>:null}
    {notice?<div className="mt-5 flex gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800"><CheckCircle2 className="h-4 w-4"/>{notice}</div>:null}
    {loading?<div className="mt-6 flex items-center gap-2 rounded-3xl border bg-white p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin"/>Memuat kehadiran…</div>:snapshot?<>
      <section className="mt-6 grid gap-4 lg:grid-cols-2">
        <article className="rounded-[2rem] border border-border/80 bg-white p-5 shadow-[var(--shadow-raised)]">
          <div className="flex justify-between gap-4"><div><p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">{formatDate(snapshot.workDate)}</p><h2 className="mt-1 text-xl font-bold text-brand-heading">{statusLabel(currentStatus)}</h2></div><Clock3 className="h-6 w-6 text-brand-primary-deep"/></div>
          <div className="mt-5 grid grid-cols-2 gap-3"><div className="rounded-2xl bg-surface p-4"><p className="text-xs text-muted-foreground">Jadwal</p><p className="mt-1 font-bold">{formatTime(snapshot.schedule.scheduledStartAt)} – {formatTime(snapshot.schedule.scheduledEndAt)}</p></div><div className="rounded-2xl bg-surface p-4"><p className="text-xs text-muted-foreground">Lokasi</p><p className="mt-1 font-bold">{snapshot.schedule.workLocation?.name??"Tidak ditetapkan"}</p></div></div>
          <div className="mt-3 grid grid-cols-2 gap-3"><div className="rounded-2xl border p-4"><p className="flex items-center gap-2 text-xs text-muted-foreground"><LogIn className="h-4 w-4"/>Masuk aktual</p><p className="mt-1 text-xl font-bold">{formatTime(snapshot.result?.firstCheckInAt)}</p></div><div className="rounded-2xl border p-4"><p className="flex items-center gap-2 text-xs text-muted-foreground"><LogOut className="h-4 w-4"/>Keluar aktual</p><p className="mt-1 text-xl font-bold">{formatTime(snapshot.result?.lastCheckOutAt)}</p></div></div>
          <div className="mt-3"><ResultFacts result={snapshot.result}/></div>
          {snapshot.result?.sessions?.length ? <div className="mt-4 rounded-2xl bg-surface p-4"><p className="text-xs font-bold text-brand-heading">Sesi kerja</p><div className="mt-2 space-y-1 text-xs text-muted-foreground">{snapshot.result.sessions.map(s=><p key={s.sequence}>Sesi {s.sequence}: {formatTime(s.checkInAt)} – {formatTime(s.checkOutAt)} · {s.workedMinutes??0} mnt{s.complete?"":" · belum lengkap"}</p>)}</div></div>:null}
        </article>
        <article className="rounded-[2rem] border border-border/80 bg-white p-5 shadow-[var(--shadow-soft)]">
          <div className="flex items-center gap-2"><TimerReset className="h-5 w-5 text-brand-primary-deep"/><h2 className="font-bold text-brand-heading">Ajukan lembur</h2></div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">Pulang lebih lambat tidak otomatis menjadi lembur. Hanya menit yang disetujui yang masuk hasil kehadiran.</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2"><input className="h-10 rounded-xl border px-3 text-sm" type="date" value={overtime.workDate} onChange={e=>setOvertime({...overtime,workDate:e.target.value})}/><input className="h-10 rounded-xl border px-3 text-sm" type="number" min="1" max="1440" value={overtime.requestedMinutes} onChange={e=>setOvertime({...overtime,requestedMinutes:e.target.value})}/></div>
          <input className="mt-3 h-10 w-full rounded-xl border px-3 text-sm" placeholder="Catatan (opsional)" value={overtime.note} onChange={e=>setOvertime({...overtime,note:e.target.value})}/>
          <button disabled={submitting||!overtime.workDate} onClick={()=>void submitOvertime()} className="mt-3 inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-4 text-xs font-bold text-white disabled:opacity-50"><Plus className="h-4 w-4"/>{submitting?"Mengirim…":"Kirim pengajuan"}</button>
          <div className="mt-5 border-t pt-4"><p className="text-xs font-bold text-brand-heading">Pengajuan terakhir</p><div className="mt-2 space-y-2">{snapshot.overtimeRequests?.slice(0,5).map(item=><div key={item.id} className="rounded-xl bg-surface p-3 text-xs"><p className="font-semibold">{item.workDate} · {item.requestedMinutes} mnt · {item.status}</p>{item.approvedMinutes!=null?<p className="mt-1 text-muted-foreground">Disetujui {item.approvedMinutes} mnt</p>:null}</div>)}{!snapshot.overtimeRequests?.length?<p className="text-xs text-muted-foreground">Belum ada pengajuan lembur.</p>:null}</div></div>
        </article>
      </section>
      <section className="mt-5 overflow-hidden rounded-[2rem] border border-border/80 bg-white shadow-[var(--shadow-soft)]">
        <header className="flex items-center gap-2 border-b px-5 py-4"><CalendarDays className="h-5 w-5"/><div><h2 className="font-bold text-brand-heading">Riwayat 30 hari</h2><p className="text-xs text-muted-foreground">Canonical result dan jadwal efektif historis.</p></div></header>
        <div className="overflow-x-auto"><table className="min-w-[900px] w-full text-left text-sm"><thead className="bg-surface text-xs text-muted-foreground"><tr><th className="p-3">Tanggal</th><th className="p-3">Status</th><th className="p-3">Jadwal</th><th className="p-3">Masuk</th><th className="p-3">Keluar</th><th className="p-3">Kerja</th><th className="p-3">Telat</th><th className="p-3">Lembur</th></tr></thead><tbody className="divide-y">{history.map(item=><tr key={item.workDate}><td className="p-3 font-semibold">{formatDate(item.workDate)}</td><td className="p-3">{statusLabel(item.result?.status??item.schedule.state)}</td><td className="p-3">{formatTime(item.schedule.scheduledStartAt)}–{formatTime(item.schedule.scheduledEndAt)}</td><td className="p-3">{formatTime(item.result?.firstCheckInAt)}</td><td className="p-3">{formatTime(item.result?.lastCheckOutAt)}</td><td className="p-3">{item.result?.workedMinutes??0} mnt</td><td className="p-3">{item.result?.lateMinutes??0} mnt</td><td className="p-3">{item.result?.overtimeMinutes??0} mnt</td></tr>)}</tbody></table></div>
      </section>
    </>:null}
  </AppShell>;
}
