import { AlertTriangle, Clock3, Loader2, Save, UserRound } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { AdminShell } from "@/layouts/AdminShell";
import { getAdminEmployeeAttendance, type AdminAttendanceListResponse } from "@/lib/attendance";
import { listEmployees, type AdminEmployeeListItem } from "@/lib/adminEmployees";
import { createCanonicalManualCorrection } from "@/lib/workforceAttendance";

function todayJakarta(){return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Jakarta"}).format(new Date());}
function fmtDate(value:string){return new Intl.DateTimeFormat("id-ID",{weekday:"short",day:"numeric",month:"short",year:"numeric",timeZone:"UTC"}).format(new Date(value+"T00:00:00Z"));}
function fmtTime(value:string|null){return value?new Intl.DateTimeFormat("id-ID",{hour:"2-digit",minute:"2-digit",hourCycle:"h23",timeZone:"Asia/Jakarta"}).format(new Date(value)):"—";}
function toIso(value:string){return new Date(value+":00+07:00").toISOString();}

async function allEmployees(){
 const first=await listEmployees({page:1,pageSize:100,status:"active"});
 if(first.pagination.pageCount<=1)return first.items;
 const rest=await Promise.all(Array.from({length:first.pagination.pageCount-1},(_,i)=>listEmployees({page:i+2,pageSize:100,status:"active"})));
 return [first,...rest].flatMap(page=>page.items);
}

export function AdminAttendancePage(){
 const [employees,setEmployees]=useState<AdminEmployeeListItem[]>([]); const [employeeId,setEmployeeId]=useState("");
 const [attendance,setAttendance]=useState<AdminAttendanceListResponse|null>(null); const [date,setDate]=useState(todayJakarta());
 const [checkIn,setCheckIn]=useState(""); const [checkOut,setCheckOut]=useState(""); const [reason,setReason]=useState("");
 const [loading,setLoading]=useState(false); const [saving,setSaving]=useState(false); const [error,setError]=useState<string|null>(null); const [notice,setNotice]=useState<string|null>(null);

 const load=useCallback(async(id:string)=>{if(!id)return;setLoading(true);try{setAttendance(await getAdminEmployeeAttendance(id));setError(null);}catch(cause){setError(cause instanceof Error?cause.message:"Kehadiran tidak dapat dimuat.");}finally{setLoading(false);}},[]);
 useEffect(()=>{void allEmployees().then(items=>{setEmployees(items);setEmployeeId(items[0]?.id??"");}).catch(cause=>setError(cause instanceof Error?cause.message:"Daftar pegawai tidak dapat dimuat."));},[]);
 useEffect(()=>{void load(employeeId);},[employeeId,load]);

 const submit=async(event:FormEvent)=>{
  event.preventDefault();
  if(!employeeId||(!checkIn&&!checkOut)||reason.trim().length<3)return;
  setSaving(true);setError(null);setNotice(null);
  try{
   await createCanonicalManualCorrection({employeeId,workDate:date,checkInAt:checkIn?toIso(checkIn):null,checkOutAt:checkOut?toIso(checkOut):null,reason:reason.trim()});
   setNotice("Koreksi canonical disimpan sebagai fakta turunan append-only. Evidence mesin/mobile tidak diubah.");
   setCheckIn("");setCheckOut("");setReason("");await load(employeeId);
  }catch(cause){setError(cause instanceof Error?cause.message:"Koreksi gagal disimpan.");}
  finally{setSaving(false);}
 };

 return <AdminShell active="attendance" title="Koreksi Kehadiran" description="Koreksi manual sekarang masuk ke attendance engine canonical; raw fingerprint/mobile evidence tetap immutable.">
  {error?<div className="mb-4 flex gap-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"><AlertTriangle className="h-4 w-4"/>{error}</div>:null}
  {notice?<div className="mb-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">{notice}</div>:null}
  <section className="grid gap-5 xl:grid-cols-[0.8fr_1.2fr]">
   <article className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]"><div className="flex items-center gap-2"><UserRound className="h-5 w-5 text-brand-primary-deep"/><h2 className="font-bold text-brand-heading">Pegawai</h2></div><select className="mt-4 h-11 w-full rounded-xl border px-3 text-sm" value={employeeId} onChange={e=>setEmployeeId(e.target.value)}>{employees.map(e=><option key={e.id} value={e.id}>{e.fullName} · {e.employeeNumber}</option>)}</select><div className="mt-4 rounded-xl bg-surface p-3 text-xs leading-5 text-muted-foreground">Tidak ada lagi operasi hapus presensi. Bila fakta perlu diperbaiki, buat koreksi baru dengan alasan sehingga audit dan versi hasil tetap utuh.</div></article>
   <article className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]"><div className="flex items-center gap-2"><Clock3 className="h-5 w-5 text-brand-primary-deep"/><h2 className="font-bold text-brand-heading">Koreksi canonical</h2></div><form className="mt-4 grid gap-3" onSubmit={submit}><input className="h-11 rounded-xl border px-3 text-sm" type="date" value={date} onChange={e=>setDate(e.target.value)}/><div className="grid gap-3 sm:grid-cols-2"><label className="text-xs font-semibold text-muted-foreground">Jam masuk WIB<input className="mt-1 h-11 w-full rounded-xl border px-3 text-sm" type="datetime-local" value={checkIn} onChange={e=>setCheckIn(e.target.value)}/></label><label className="text-xs font-semibold text-muted-foreground">Jam keluar WIB<input className="mt-1 h-11 w-full rounded-xl border px-3 text-sm" type="datetime-local" value={checkOut} onChange={e=>setCheckOut(e.target.value)}/></label></div><textarea className="min-h-20 rounded-xl border p-3 text-sm" placeholder="Alasan koreksi wajib (min. 3 karakter)" value={reason} onChange={e=>setReason(e.target.value)} maxLength={1000}/><button disabled={saving||!employeeId||(!checkIn&&!checkOut)||reason.trim().length<3} className="inline-flex h-10 w-fit items-center gap-2 rounded-xl bg-brand-primary px-4 text-xs font-bold text-white disabled:opacity-50">{saving?<Loader2 className="h-4 w-4 animate-spin"/>:<Save className="h-4 w-4"/>}Simpan koreksi</button></form></article>
  </section>
  <section className="mt-5 overflow-hidden rounded-2xl border border-border/70 bg-white shadow-[var(--shadow-soft)]"><header className="border-b p-4"><h2 className="font-bold text-brand-heading">Riwayat 30 hari</h2><p className="mt-1 text-xs text-muted-foreground">Canonical result ditampilkan lebih dulu; legacy ATT-001 hanya fallback bila belum ada hasil canonical pada tanggal tersebut.</p></header>{loading?<div className="p-6 text-sm text-muted-foreground">Memuat…</div>:<div className="overflow-x-auto"><table className="min-w-[850px] w-full text-left text-sm"><thead className="bg-surface text-xs text-muted-foreground"><tr><th className="p-3">Tanggal</th><th className="p-3">Masuk</th><th className="p-3">Keluar</th><th className="p-3">Sumber</th><th className="p-3">Referensi</th></tr></thead><tbody className="divide-y">{attendance?.items.map(item=><tr key={item.attendanceDate}><td className="p-3 font-semibold">{fmtDate(item.attendanceDate)}</td><td className="p-3">{fmtTime(item.checkInAt)}</td><td className="p-3">{fmtTime(item.checkOutAt)}</td><td className="p-3">{item.source==="integration"?"Canonical/integrasi":"Legacy manual"}</td><td className="p-3 font-mono text-xs">{item.sourceReference??"—"}</td></tr>)}{attendance && attendance.items.length===0?<tr><td colSpan={5} className="p-8 text-center text-muted-foreground">Belum ada rekaman.</td></tr>:null}</tbody></table></div>}</section>
 </AdminShell>;
}
