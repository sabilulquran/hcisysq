import { AlertTriangle, CheckCircle2, Pencil, Plus, Save, X } from "lucide-react";
import { useEffect, useState } from "react";

import { AttendanceWorkforceShell } from "@/components/attendance/workforce/AttendanceWorkforceShell";
import { listEmployees, type AdminEmployeeListItem } from "@/lib/adminEmployees";
import {
  createAttendanceSchedule,
  createAttendanceScheduleAssignment,
  createAttendanceWorkLocation,
  listAttendanceScheduleAssignments,
  listAttendanceSchedules,
  listAttendanceWorkLocations,
  updateAttendanceSchedule,
  updateAttendanceScheduleAssignment,
  updateAttendanceWorkLocation,
  type AttendanceScheduleAssignmentItem,
} from "@/lib/workforceAttendance";

async function loadActiveEmployees() {
  const first = await listEmployees({ page: 1, pageSize: 100, status: "active" });
  if (first.pagination.pageCount <= 1) return first.items;
  const rest = await Promise.all(
    Array.from({ length: first.pagination.pageCount - 1 }, (_, index) =>
      listEmployees({ page: index + 2, pageSize: 100, status: "active" }),
    ),
  );
  return [first, ...rest].flatMap((item) => item.items);
}

function Notice({ error, notice }: { error: string | null; notice: string | null }) {
  return (
    <>
      {error ? (
        <div className="mb-4 flex gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </div>
      ) : null}
      {notice ? (
        <div className="mb-4 flex gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> {notice}
        </div>
      ) : null}
    </>
  );
}

export function AdminAttendanceLocationsPage() {
  const [items, setItems] = useState<Array<{ id: string; name: string; latitude: number; longitude: number; radiusMeters: number; active: boolean }>>([]);
  const [form, setForm] = useState({ name: "", latitude: "", longitude: "", radiusMeters: "150" });
  const [editing, setEditing] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: "", latitude: "", longitude: "", radiusMeters: "150", active: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => setItems((await listAttendanceWorkLocations()).items);
  useEffect(() => { void load().catch((cause) => setError(cause instanceof Error ? cause.message : "Lokasi tidak dapat dimuat.")); }, []);

  const run = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true); setError(null); setNotice(null);
    try { await action(); await load(); setNotice(message); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Operasi lokasi gagal."); }
    finally { setBusy(false); }
  };

  return (
    <AttendanceWorkforceShell section="locations" title="Lokasi & Geofence" description="Kelola titik kerja yang dipakai untuk evaluasi GPS mobile attendance.">
      <Notice error={error} notice={notice} />
      <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
        <h2 className="font-bold text-brand-heading">Tambah lokasi</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <input className="h-11 rounded-xl border border-border px-3 text-sm" placeholder="Nama lokasi" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="h-11 rounded-xl border border-border px-3 text-sm" type="number" step="any" placeholder="Latitude" value={form.latitude} onChange={(e) => setForm({ ...form, latitude: e.target.value })} />
          <input className="h-11 rounded-xl border border-border px-3 text-sm" type="number" step="any" placeholder="Longitude" value={form.longitude} onChange={(e) => setForm({ ...form, longitude: e.target.value })} />
          <input className="h-11 rounded-xl border border-border px-3 text-sm" type="number" min="10" placeholder="Radius meter" value={form.radiusMeters} onChange={(e) => setForm({ ...form, radiusMeters: e.target.value })} />
        </div>
        <button
          type="button"
          disabled={busy || !form.name || !form.latitude || !form.longitude}
          onClick={() => void run(async () => {
            await createAttendanceWorkLocation({
              name: form.name,
              latitude: Number(form.latitude),
              longitude: Number(form.longitude),
              radiusMeters: Number(form.radiusMeters),
            });
            setForm({ name: "", latitude: "", longitude: "", radiusMeters: "150" });
          }, "Lokasi kerja ditambahkan.")}
          className="mt-3 inline-flex h-11 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-white disabled:opacity-50"
        ><Plus className="h-4 w-4" /> Tambah lokasi</button>
      </section>

      <section className="mt-5 overflow-hidden rounded-2xl border border-border/70 bg-white shadow-[var(--shadow-soft)]">
        <div className="border-b border-border/70 p-4"><h2 className="font-bold text-brand-heading">Daftar lokasi</h2></div>
        <div className="overflow-x-auto">
          <table className="min-w-[850px] w-full text-left text-sm">
            <thead className="bg-surface text-xs text-muted-foreground"><tr><th className="p-3">Nama</th><th className="p-3">Latitude</th><th className="p-3">Longitude</th><th className="p-3">Radius</th><th className="p-3">Status</th><th className="p-3">Aksi</th></tr></thead>
            <tbody className="divide-y divide-border/70">
              {items.map((item) => editing === item.id ? (
                <tr key={item.id}>
                  <td className="p-3"><input className="h-9 w-full rounded-lg border px-2" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} /></td>
                  <td className="p-3"><input className="h-9 w-36 rounded-lg border px-2" type="number" step="any" value={editForm.latitude} onChange={(e) => setEditForm({ ...editForm, latitude: e.target.value })} /></td>
                  <td className="p-3"><input className="h-9 w-36 rounded-lg border px-2" type="number" step="any" value={editForm.longitude} onChange={(e) => setEditForm({ ...editForm, longitude: e.target.value })} /></td>
                  <td className="p-3"><input className="h-9 w-24 rounded-lg border px-2" type="number" min="10" value={editForm.radiusMeters} onChange={(e) => setEditForm({ ...editForm, radiusMeters: e.target.value })} /></td>
                  <td className="p-3"><label className="flex items-center gap-2"><input type="checkbox" checked={editForm.active} onChange={(e) => setEditForm({ ...editForm, active: e.target.checked })} /> Aktif</label></td>
                  <td className="p-3"><div className="flex gap-2"><button className="rounded-lg bg-brand-primary p-2 text-white" onClick={() => void run(async () => {
                    await updateAttendanceWorkLocation(item.id, {
                      name: editForm.name, latitude: Number(editForm.latitude), longitude: Number(editForm.longitude),
                      radiusMeters: Number(editForm.radiusMeters), active: editForm.active,
                    }); setEditing(null);
                  }, "Lokasi diperbarui.")}><Save className="h-4 w-4" /></button><button className="rounded-lg border p-2" onClick={() => setEditing(null)}><X className="h-4 w-4" /></button></div></td>
                </tr>
              ) : (
                <tr key={item.id}>
                  <td className="p-3 font-semibold">{item.name}</td><td className="p-3 font-mono text-xs">{item.latitude}</td><td className="p-3 font-mono text-xs">{item.longitude}</td><td className="p-3">{item.radiusMeters} m</td><td className="p-3">{item.active ? "Aktif" : "Nonaktif"}</td>
                  <td className="p-3"><button className="inline-flex items-center gap-1 text-xs font-bold text-brand-primary-deep" onClick={() => { setEditing(item.id); setEditForm({ name: item.name, latitude: String(item.latitude), longitude: String(item.longitude), radiusMeters: String(item.radiusMeters), active: item.active }); }}><Pencil className="h-3.5 w-3.5" /> Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </AttendanceWorkforceShell>
  );
}

export function AdminAttendanceSchedulesPage() {
  const [locations, setLocations] = useState<Array<{ id: string; name: string; active: boolean }>>([]);
  const [items, setItems] = useState<Array<{ id: string; name: string; startTime: string; endTime: string; endDayOffset: number; lateGraceMinutes: number; earlyLeaveToleranceMinutes: number; active: boolean; workLocationId: string | null; workLocationName: string | null }>>([]);
  const [form, setForm] = useState({ name: "", startTime: "08:00", endTime: "16:00", endDayOffset: "0", lateGraceMinutes: "10", earlyLeaveToleranceMinutes: "0", workLocationId: "" });
  const [editing, setEditing] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: "", startTime: "08:00", endTime: "16:00", endDayOffset: "0", lateGraceMinutes: "0", earlyLeaveToleranceMinutes: "0", workLocationId: "", active: true });
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    const [scheduleResult, locationResult] = await Promise.all([listAttendanceSchedules(), listAttendanceWorkLocations()]);
    setItems(scheduleResult.items); setLocations(locationResult.items);
  };
  useEffect(() => { void load().catch((cause) => setError(cause instanceof Error ? cause.message : "Jadwal tidak dapat dimuat.")); }, []);
  const run = async (action: () => Promise<unknown>, message: string) => { setBusy(true); setError(null); setNotice(null); try { await action(); await load(); setNotice(message); } catch (cause) { setError(cause instanceof Error ? cause.message : "Operasi jadwal gagal."); } finally { setBusy(false); } };

  return (
    <AttendanceWorkforceShell section="schedules" title="Jadwal & Shift" description="Template jam kerja, grace keterlambatan, toleransi pulang, lokasi, dan shift overnight.">
      <Notice error={error} notice={notice} />
      <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
        <h2 className="font-bold text-brand-heading">Tambah template</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <input className="h-11 rounded-xl border px-3 text-sm" placeholder="Nama jadwal" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="h-11 rounded-xl border px-3 text-sm" type="time" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} />
          <input className="h-11 rounded-xl border px-3 text-sm" type="time" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} />
          <select className="h-11 rounded-xl border px-3 text-sm" value={form.endDayOffset} onChange={(e) => setForm({ ...form, endDayOffset: e.target.value })}><option value="0">Selesai hari yang sama</option><option value="1">Selesai hari berikutnya (+1)</option></select>
          <input className="h-11 rounded-xl border px-3 text-sm" type="number" min="0" max="240" placeholder="Grace menit" value={form.lateGraceMinutes} onChange={(e) => setForm({ ...form, lateGraceMinutes: e.target.value })} />
          <input className="h-11 rounded-xl border px-3 text-sm" type="number" min="0" max="240" placeholder="Toleransi pulang" value={form.earlyLeaveToleranceMinutes} onChange={(e) => setForm({ ...form, earlyLeaveToleranceMinutes: e.target.value })} />
          <select className="h-11 rounded-xl border px-3 text-sm" value={form.workLocationId} onChange={(e) => setForm({ ...form, workLocationId: e.target.value })}><option value="">Tanpa lokasi</option>{locations.filter((item) => item.active).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Hari selesai disimpan eksplisit. Ini menjaga shift historis tetap benar, termasuk shift yang berakhir hari berikutnya meski jam akhirnya lebih besar dari jam mulai.</p>
        <button className="mt-3 inline-flex h-11 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-white disabled:opacity-50" disabled={busy || !form.name} onClick={() => void run(async () => {
          await createAttendanceSchedule({ name: form.name, startTime: form.startTime, endTime: form.endTime, endDayOffset: Number(form.endDayOffset), lateGraceMinutes: Number(form.lateGraceMinutes), earlyLeaveToleranceMinutes: Number(form.earlyLeaveToleranceMinutes), workLocationId: form.workLocationId || null });
          setForm({ name: "", startTime: "08:00", endTime: "16:00", endDayOffset: "0", lateGraceMinutes: "10", earlyLeaveToleranceMinutes: "0", workLocationId: "" });
        }, "Template jadwal ditambahkan.")}><Plus className="h-4 w-4" /> Tambah jadwal</button>
      </section>

      <section className="mt-5 overflow-hidden rounded-2xl border border-border/70 bg-white shadow-[var(--shadow-soft)]">
        <div className="border-b p-4"><h2 className="font-bold text-brand-heading">Template tersedia</h2></div>
        <div className="overflow-x-auto"><table className="min-w-[950px] w-full text-left text-sm"><thead className="bg-surface text-xs text-muted-foreground"><tr><th className="p-3">Jadwal</th><th className="p-3">Jam</th><th className="p-3">Grace</th><th className="p-3">Pulang</th><th className="p-3">Lokasi</th><th className="p-3">Status</th><th className="p-3">Aksi</th></tr></thead><tbody className="divide-y">
          {items.map((item) => editing === item.id ? (
            <tr key={item.id}>
              <td className="p-3"><input className="h-9 w-full rounded-lg border px-2" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} /></td>
              <td className="p-3"><div className="flex gap-1"><input className="h-9 rounded-lg border px-2" type="time" value={editForm.startTime.slice(0,5)} onChange={(e) => setEditForm({ ...editForm, startTime: e.target.value })} /><input className="h-9 rounded-lg border px-2" type="time" value={editForm.endTime.slice(0,5)} onChange={(e) => setEditForm({ ...editForm, endTime: e.target.value })} /></div></td>
              <td className="p-3"><div className="grid gap-1"><select className="h-9 rounded-lg border px-2 text-xs" value={editForm.endDayOffset} onChange={(e) => setEditForm({ ...editForm, endDayOffset: e.target.value })}><option value="0">Hari sama</option><option value="1">+1 hari</option></select><input className="h-9 w-20 rounded-lg border px-2" type="number" value={editForm.lateGraceMinutes} onChange={(e) => setEditForm({ ...editForm, lateGraceMinutes: e.target.value })} /></div></td>
              <td className="p-3"><input className="h-9 w-20 rounded-lg border px-2" type="number" value={editForm.earlyLeaveToleranceMinutes} onChange={(e) => setEditForm({ ...editForm, earlyLeaveToleranceMinutes: e.target.value })} /></td>
              <td className="p-3"><select className="h-9 rounded-lg border px-2" value={editForm.workLocationId} onChange={(e) => setEditForm({ ...editForm, workLocationId: e.target.value })}><option value="">Tanpa lokasi</option>{locations.map((loc) => <option key={loc.id} value={loc.id}>{loc.name}</option>)}</select></td>
              <td className="p-3"><label className="flex gap-2"><input type="checkbox" checked={editForm.active} onChange={(e) => setEditForm({ ...editForm, active: e.target.checked })} /> Aktif</label></td>
              <td className="p-3"><div className="flex gap-2"><button className="rounded-lg bg-brand-primary p-2 text-white" onClick={() => void run(async () => { await updateAttendanceSchedule(item.id, { name: editForm.name, startTime: editForm.startTime, endTime: editForm.endTime, endDayOffset: Number(editForm.endDayOffset), lateGraceMinutes: Number(editForm.lateGraceMinutes), earlyLeaveToleranceMinutes: Number(editForm.earlyLeaveToleranceMinutes), workLocationId: editForm.workLocationId || null, active: editForm.active }); setEditing(null); }, "Jadwal diperbarui.")}><Save className="h-4 w-4" /></button><button className="rounded-lg border p-2" onClick={() => setEditing(null)}><X className="h-4 w-4" /></button></div></td>
            </tr>
          ) : (
            <tr key={item.id}><td className="p-3 font-semibold">{item.name}</td><td className="p-3">{item.startTime.slice(0,5)}–{item.endTime.slice(0,5)}{item.endDayOffset === 1 ? " · +1 hari" : ""}</td><td className="p-3">{item.lateGraceMinutes} mnt</td><td className="p-3">{item.earlyLeaveToleranceMinutes} mnt</td><td className="p-3">{item.workLocationName ?? "—"}</td><td className="p-3">{item.active ? "Aktif" : "Nonaktif"}</td><td className="p-3"><button className="inline-flex items-center gap-1 text-xs font-bold text-brand-primary-deep" onClick={() => { setEditing(item.id); setEditForm({ name: item.name, startTime: item.startTime, endTime: item.endTime, endDayOffset: String(item.endDayOffset ?? 0), lateGraceMinutes: String(item.lateGraceMinutes), earlyLeaveToleranceMinutes: String(item.earlyLeaveToleranceMinutes), workLocationId: item.workLocationId ?? "", active: item.active }); }}><Pencil className="h-3.5 w-3.5" /> Edit</button></td></tr>
          ))}
        </tbody></table></div>
      </section>
    </AttendanceWorkforceShell>
  );
}

const weekdayLabels = ["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"];

function maskDays(mask: number) {
  return weekdayLabels.filter((_, index) => (mask & (1 << index)) !== 0).join(", ");
}

export function AdminAttendanceAssignmentsPage() {
  const [employees, setEmployees] = useState<AdminEmployeeListItem[]>([]);
  const [schedules, setSchedules] = useState<Array<{ id: string; name: string; active: boolean }>>([]);
  const [items, setItems] = useState<AttendanceScheduleAssignmentItem[]>([]);
  const [employeeId, setEmployeeId] = useState("");
  const [scheduleId, setScheduleId] = useState("");
  const [weekdays, setWeekdays] = useState<number[]>([1,2,3,4,5]);
  const [effectiveFrom, setEffectiveFrom] = useState(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date()));
  const [effectiveTo, setEffectiveTo] = useState("");
  const [endDates, setEndDates] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null); const [busy, setBusy] = useState(false);

  const load = async () => {
    const [employeeResult, scheduleResult, assignmentResult] = await Promise.all([loadActiveEmployees(), listAttendanceSchedules(), listAttendanceScheduleAssignments()]);
    setEmployees(employeeResult); setSchedules(scheduleResult.items); setItems(assignmentResult.items);
    setEmployeeId((current) => current || employeeResult[0]?.id || "");
    setScheduleId((current) => current || scheduleResult.items.find((item) => item.active)?.id || "");
  };
  useEffect(() => { void load().catch((cause) => setError(cause instanceof Error ? cause.message : "Assignment tidak dapat dimuat.")); }, []);
  const run = async (action: () => Promise<unknown>, message: string) => { setBusy(true); setError(null); setNotice(null); try { await action(); await load(); setNotice(message); } catch (cause) { setError(cause instanceof Error ? cause.message : "Operasi assignment gagal."); } finally { setBusy(false); } };

  return (
    <AttendanceWorkforceShell section="assignments" title="Assignment Jadwal" description="Hubungkan pegawai ke jadwal default secara effective-dated dan pilih hari kerja Senin–Minggu.">
      <Notice error={error} notice={notice} />
      <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
        <h2 className="font-bold text-brand-heading">Assignment baru</h2>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <select className="h-11 rounded-xl border px-3 text-sm" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>{employees.map((item) => <option key={item.id} value={item.id}>{item.fullName} · {item.employeeNumber}</option>)}</select>
          <select className="h-11 rounded-xl border px-3 text-sm" value={scheduleId} onChange={(e) => setScheduleId(e.target.value)}>{schedules.filter((item) => item.active).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">{weekdayLabels.map((label,index) => { const day=index+1; const active=weekdays.includes(day); return <button type="button" key={label} onClick={() => setWeekdays((current) => active ? current.filter((value) => value !== day) : [...current, day].sort())} className={"h-9 rounded-xl border px-3 text-xs font-bold " + (active ? "border-brand-primary bg-brand-primary-pale text-brand-primary-deep" : "border-border")}>{label}</button>; })}</div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="text-xs font-semibold text-muted-foreground">Berlaku mulai<input className="mt-1 h-11 w-full rounded-xl border px-3 text-sm" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} /></label><label className="text-xs font-semibold text-muted-foreground">Berakhir (opsional)<input className="mt-1 h-11 w-full rounded-xl border px-3 text-sm" type="date" value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)} /></label></div>
        <button disabled={busy || !employeeId || !scheduleId || weekdays.length === 0} className="mt-3 inline-flex h-11 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-white disabled:opacity-50" onClick={() => void run(() => createAttendanceScheduleAssignment({ employeeId, scheduleTemplateId: scheduleId, weekdays, effectiveFrom, effectiveTo: effectiveTo || null }), "Assignment jadwal ditambahkan.")}><Plus className="h-4 w-4" /> Tambah assignment</button>
      </section>

      <section className="mt-5 overflow-hidden rounded-2xl border border-border/70 bg-white shadow-[var(--shadow-soft)]">
        <div className="border-b p-4"><h2 className="font-bold text-brand-heading">Riwayat assignment</h2><p className="mt-1 text-xs text-muted-foreground">Assignment tumpang tindih akan ditandai configuration error oleh engine; akhiri assignment lama sebelum membuat periode baru yang bentrok.</p></div>
        <div className="overflow-x-auto"><table className="min-w-[1000px] w-full text-left text-sm"><thead className="bg-surface text-xs text-muted-foreground"><tr><th className="p-3">Pegawai</th><th className="p-3">Unit</th><th className="p-3">Jadwal</th><th className="p-3">Hari</th><th className="p-3">Periode</th><th className="p-3">Akhiri</th></tr></thead><tbody className="divide-y">
          {items.map((item) => <tr key={item.id}><td className="p-3"><p className="font-semibold">{item.employeeName}</p><p className="text-xs text-muted-foreground">{item.employeeNumber}</p></td><td className="p-3">{item.unitName ?? "—"}</td><td className="p-3">{item.scheduleName}</td><td className="p-3">{maskDays(item.weekdayMask)}</td><td className="p-3">{item.effectiveFrom} → {item.effectiveTo ?? "seterusnya"}</td><td className="p-3">{item.effectiveTo ? <span className="text-xs text-muted-foreground">Selesai</span> : <div className="flex gap-2"><input className="h-9 rounded-lg border px-2 text-xs" type="date" value={endDates[item.id] ?? ""} onChange={(e) => setEndDates({ ...endDates, [item.id]: e.target.value })} /><button disabled={!endDates[item.id]} className="rounded-lg border px-3 text-xs font-bold disabled:opacity-50" onClick={() => void run(() => updateAttendanceScheduleAssignment(item.id, endDates[item.id] || null), "Assignment diakhiri.")}>Akhiri</button></div>}</td></tr>)}
        </tbody></table></div>
      </section>
    </AttendanceWorkforceShell>
  );
}
