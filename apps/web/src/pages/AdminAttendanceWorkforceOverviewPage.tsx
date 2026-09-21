import { AlertTriangle, CalendarRange, ClipboardCheck, MapPin, Search, Smartphone, UsersRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AttendanceWorkforceShell } from "@/components/attendance/workforce/AttendanceWorkforceShell";
import {
  getAttendanceDaily,
  listAttendanceClarificationsForHcByStatus,
  listAttendanceMobileEvidence,
  listAttendanceSchedules,
  listAttendanceWorkLocations,
  type AttendanceDailyItem,
} from "@/lib/workforceAttendance";

function todayJakarta() { return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Jakarta"}).format(new Date()); }
function fmt(value:string|null){return value?new Intl.DateTimeFormat("id-ID",{hour:"2-digit",minute:"2-digit",hourCycle:"h23",timeZone:"Asia/Jakarta"}).format(new Date(value)):"—";}
function label(value:string){const map:Record<string,string>={scheduled:"Terjadwal",pending:"Belum check-in",present:"Hadir",late:"Terlambat",incomplete:"Belum lengkap",leave:"Cuti/Izin",absent:"Tidak hadir",off:"Libur",configuration_error:"Konfigurasi"};return map[value]??value;}

export function AdminAttendanceWorkforceOverviewPage(){
 const [date,setDate]=useState(todayJakarta()); const [items,setItems]=useState<AttendanceDailyItem[]>([]); const [summary,setSummary]=useState<Record<string,number>>({});
 const [schedules,setSchedules]=useState(0); const [locations,setLocations]=useState(0); const [clarifications,setClarifications]=useState(0); const [mobileReview,setMobileReview]=useState(0);
 const [q,setQ]=useState(""); const [status,setStatus]=useState(""); const [error,setError]=useState<string|null>(null);

 useEffect(()=>{
  let active=true;
  const refresh=async()=>{
    const [daily,sch,loc,clar,mob]=await Promise.allSettled([
      getAttendanceDaily(date),listAttendanceSchedules(),listAttendanceWorkLocations(),
      listAttendanceClarificationsForHcByStatus("submitted"),
      listAttendanceMobileEvidence({date,reviewState:"needs_review"}),
    ]);
    if(!active)return;
    if(daily.status==="fulfilled"){
      setItems(daily.value.items);
      setSummary(daily.value.summary);
      setError(null);
    }else{
      setError(daily.reason instanceof Error?daily.reason.message:"Dashboard harian tidak dapat dimuat.");
    }
    if(sch.status==="fulfilled")setSchedules(sch.value.items.filter(i=>i.active).length);
    if(loc.status==="fulfilled")setLocations(loc.value.items.filter(i=>i.active).length);
    if(clar.status==="fulfilled")setClarifications(clar.value.items.length);
    if(mob.status==="fulfilled")setMobileReview(mob.value.items.length);
  };
  void refresh();
  const interval=date===todayJakarta()?window.setInterval(()=>{void refresh();},30000):null;
  return()=>{active=false;if(interval!==null)window.clearInterval(interval);};
 },[date]);

 const filtered=useMemo(()=>{const needle=q.trim().toLowerCase();return items.filter(i=>(!status||i.status===status)&&(!needle||[i.employeeName,i.employeeNumber,i.unitName??""].join(" ").toLowerCase().includes(needle)));},[items,q,status]);
 const cards=[
  ["Pegawai aktif",items.length,UsersRound],["Jadwal aktif",schedules,CalendarRange],["Lokasi aktif",locations,MapPin],
  ["Belum check-in",summary.pending??0,UsersRound],["Klarifikasi",clarifications,ClipboardCheck],["Evidence review",mobileReview,Smartphone],
 ] as const;

 return <AttendanceWorkforceShell section="overview" title="Operasional Kehadiran" description="Dashboard harian canonical: seluruh pegawai aktif tetap terlihat meski belum mempunyai result materialized.">
  {error?<div className="mb-5 flex gap-2 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><AlertTriangle className="h-4 w-4"/>{error}</div>:null}
  <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">{cards.map(([name,value,Icon])=><article key={name} className="rounded-2xl border border-border/70 bg-white p-4 shadow-[var(--shadow-soft)]"><div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground"><Icon className="h-4 w-4"/>{name}</div><p className="mt-2 text-2xl font-bold text-brand-heading">{value}</p></article>)}</section>
  <section className="mt-5 overflow-hidden rounded-2xl border border-border/70 bg-white shadow-[var(--shadow-soft)]">
   <header className="flex flex-col gap-3 border-b p-4 lg:flex-row lg:items-center lg:justify-between"><div><h2 className="font-bold text-brand-heading">Kehadiran pegawai</h2><p className="mt-1 text-xs text-muted-foreground">Status tanpa result dihitung read-only dari jadwal efektif, kalender, cuti/resolution, dan waktu saat ini.</p></div><div className="flex flex-wrap gap-2"><input className="h-10 rounded-xl border px-3 text-sm" type="date" value={date} onChange={e=>setDate(e.target.value)}/><select className="h-10 rounded-xl border px-3 text-sm" value={status} onChange={e=>setStatus(e.target.value)}><option value="">Semua status</option>{["pending","present","late","incomplete","leave","absent","off","scheduled","configuration_error"].map(s=><option key={s} value={s}>{label(s)}</option>)}</select><label className="relative"><Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground"/><input className="h-10 rounded-xl border pl-9 pr-3 text-sm" placeholder="Cari pegawai/unit…" value={q} onChange={e=>setQ(e.target.value)}/></label></div></header>
   <div className="flex flex-wrap gap-2 border-b px-4 py-3">{Object.entries(summary).map(([key,value])=><span key={key} className="rounded-full bg-surface px-3 py-1.5 text-xs font-bold">{label(key)}: {value}</span>)}</div>
   <div className="overflow-x-auto"><table className="min-w-[1050px] w-full text-left text-sm"><thead className="bg-surface text-xs text-muted-foreground"><tr><th className="p-3">Pegawai</th><th className="p-3">Unit</th><th className="p-3">Status</th><th className="p-3">Jadwal</th><th className="p-3">Masuk</th><th className="p-3">Keluar</th><th className="p-3">Kerja</th><th className="p-3">Telat</th><th className="p-3">Lembur</th><th className="p-3">Sumber</th></tr></thead><tbody className="divide-y">{filtered.map(i=><tr key={i.employeeId}><td className="p-3"><p className="font-semibold">{i.employeeName}</p><p className="text-xs text-muted-foreground">{i.employeeNumber}{i.materialized?" · v"+i.resultVersion:" · live"}</p></td><td className="p-3">{i.unitName??"—"}</td><td className="p-3">{label(i.status)}</td><td className="p-3">{fmt(i.scheduledStartAt)}–{fmt(i.scheduledEndAt)}</td><td className="p-3">{fmt(i.firstCheckInAt)}</td><td className="p-3">{fmt(i.lastCheckOutAt)}</td><td className="p-3">{i.workedMinutes} mnt</td><td className="p-3">{i.lateMinutes} mnt{i.lateJustified?" ✓":""}</td><td className="p-3">{i.overtimeMinutes} mnt</td><td className="p-3">{i.sources.join(", ")||"—"}</td></tr>)}{filtered.length===0?<tr><td colSpan={10} className="p-8 text-center text-muted-foreground">Tidak ada pegawai yang cocok dengan filter.</td></tr>:null}</tbody></table></div>
  </section>
 </AttendanceWorkforceShell>;
}
