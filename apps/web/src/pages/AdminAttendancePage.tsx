import { AlertTriangle, Clock3, Loader2, Save, UserRound } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { AttendanceWorkforceShell } from "@/components/attendance/workforce/AttendanceWorkforceShell";
import { EmployeeSearchField, type PickedEmployee } from "@/components/attendance/workforce/EmployeeSearchField";
import { getAdminEmployeeAttendance, type AdminAttendanceListResponse } from "@/lib/attendance";
import { createCanonicalManualCorrection } from "@/lib/workforceAttendance";

function todayJakarta(){return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Jakarta"}).format(new Date());}
function fmtDate(value:string){return new Intl.DateTimeFormat("id-ID",{weekday:"short",day:"numeric",month:"short",year:"numeric",timeZone:"UTC"}).format(new Date(value+"T00:00:00Z"));}
function fmtTime(value:string|null){return value?new Intl.DateTimeFormat("id-ID",{hour:"2-digit",minute:"2-digit",hourCycle:"h23",timeZone:"Asia/Jakarta"}).format(new Date(value)):"—";}
function toIso(value:string){return new Date(value+":00+07:00").toISOString();}

export function AdminAttendancePage(){
 const [employee,setEmployee]=useState<PickedEmployee|null>(null);
 const [attendance,setAttendance]=useState<AdminAttendanceListResponse|null>(null); const [date,setDate]=useState(todayJakarta());
 const [checkIn,setCheckIn]=useState(""); const [checkOut,setCheckOut]=useState(""); const [reason,setReason]=useState("");
 const [loading,setLoading]=useState(false); const [saving,setSaving]=useState(false); const [error,setError]=useState<string|null>(null); const [notice,setNotice]=useState<string|null>(null);
 const employeeId=employee?.id??"";

 const load=useCallback(async(id:string)=>{if(!id){setAttendance(null);return;}setLoading(true);try{setAttendance(await getAdminEmployeeAttendance(id));setError(null);}catch(cause){setError(cause instanceof Error?cause.message:"Kehadiran tidak dapat dimuat.");}finally{setLoading(false);}},[]);
 useEffect(()=>{void load(employeeId);},[employeeId,load]);

 const submit=async(event:FormEvent)=>{
  event.preventDefault();
  if(!employeeId||(!checkIn&&!checkOut)||reason.trim().length<3)return;
  setSaving(true);setError(null);setNotice(null);
  try{
   await createCanonicalManualCorrection({employeeId,workDate:date,checkInAt:checkIn?toIso(checkIn):null,checkOutAt:checkOut?toIso(checkOut):null,reason:reason.trim()});
   setNotice("Koreksi tersimpan beserta alasannya. Data scan dari mesin dan HP tidak diubah.");
   setCheckIn("");setCheckOut("");setReason("");await load(employeeId);
  }catch(cause){setError(cause instanceof Error?cause.message:"Koreksi gagal disimpan.");}
  finally{setSaving(false);}
 };

 return <AttendanceWorkforceShell tab="corrections" title="Koreksi HC" description="Tambahkan jam masuk atau pulang yang benar beserta alasannya. Data scan asli tetap tersimpan dan tidak diubah.">
  {error?<div className="mb-4 flex gap-2 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink"><AlertTriangle className="h-4 w-4"/>{error}</div>:null}
  {notice?<div className="mb-4 rounded-2xl border border-success-line bg-success-soft p-4 text-sm text-success-ink">{notice}</div>:null}
  <section className="grid gap-5 xl:grid-cols-[0.8fr_1.2fr]">
   <article className="rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]"><div className="flex items-center gap-2"><UserRound className="h-5 w-5 text-brand-primary-deep"/><h2 className="font-bold text-brand-heading">Pegawai</h2></div><div className="mt-4"><EmployeeSearchField value={employee} onChange={setEmployee}/></div><div className="mt-4 rounded-xl bg-surface p-3 text-xs leading-5 text-muted-foreground">Absen tidak bisa dihapus. Bila jam perlu diperbaiki, buat koreksi baru dengan alasan sehingga riwayatnya tetap utuh.</div></article>
   <article className="rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]"><div className="flex items-center gap-2"><Clock3 className="h-5 w-5 text-brand-primary-deep"/><h2 className="font-bold text-brand-heading">Koreksi jam</h2></div><form className="mt-4 grid gap-3" onSubmit={submit}><label className="text-xs font-semibold text-muted-foreground">Tanggal<input className="mt-1 h-11 w-full rounded-xl border px-3 text-sm" type="date" value={date} onChange={e=>setDate(e.target.value)}/></label><div className="grid gap-3 sm:grid-cols-2"><label className="text-xs font-semibold text-muted-foreground">Jam masuk WIB<input className="mt-1 h-11 w-full rounded-xl border px-3 text-sm" type="datetime-local" value={checkIn} onChange={e=>setCheckIn(e.target.value)}/></label><label className="text-xs font-semibold text-muted-foreground">Jam pulang WIB<input className="mt-1 h-11 w-full rounded-xl border px-3 text-sm" type="datetime-local" value={checkOut} onChange={e=>setCheckOut(e.target.value)}/></label></div><textarea className="min-h-20 rounded-xl border p-3 text-sm" placeholder="Alasan koreksi wajib (min. 3 karakter)" value={reason} onChange={e=>setReason(e.target.value)} maxLength={1000}/><button disabled={saving||!employeeId||(!checkIn&&!checkOut)||reason.trim().length<3} className="inline-flex h-10 w-fit items-center gap-2 rounded-xl bg-brand-primary px-4 text-xs font-bold text-brand-foreground disabled:opacity-50">{saving?<Loader2 className="h-4 w-4 animate-spin"/>:<Save className="h-4 w-4"/>}Simpan koreksi</button></form></article>
  </section>
  <section className="mt-5 overflow-hidden rounded-2xl border border-border/70 bg-surface-raised shadow-[var(--shadow-soft)]"><header className="border-b p-4"><h2 className="font-bold text-brand-heading">Riwayat 30 hari</h2><p className="mt-1 text-xs text-muted-foreground">Jam masuk dan pulang yang tercatat untuk pegawai terpilih.</p></header>{!employee?<div className="p-6 text-sm text-muted-foreground">Cari dan pilih pegawai untuk melihat riwayatnya.</div>:loading?<div className="p-6 text-sm text-muted-foreground">Memuat…</div>:<div className="overflow-x-auto"><table className="min-w-[640px] w-full text-left text-sm"><thead className="bg-surface text-xs text-muted-foreground"><tr><th className="p-3">Tanggal</th><th className="p-3">Masuk</th><th className="p-3">Pulang</th><th className="p-3">Sumber</th></tr></thead><tbody className="divide-y">{attendance?.items.map(item=><tr key={item.attendanceDate}><td className="p-3 font-semibold">{fmtDate(item.attendanceDate)}</td><td className="p-3">{fmtTime(item.checkInAt)}</td><td className="p-3">{fmtTime(item.checkOutAt)}</td><td className="p-3">{item.source==="integration"?"Hasil perhitungan":"Catatan lama"}</td></tr>)}{attendance && attendance.items.length===0?<tr><td colSpan={4} className="p-8 text-center text-muted-foreground">Belum ada catatan.</td></tr>:null}</tbody></table></div>}</section>
 </AttendanceWorkforceShell>;
}
