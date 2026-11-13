import { AlertTriangle, CheckCircle2, MapPin, Pencil, Plus, Save, X } from "lucide-react";
import { Fragment, useEffect, useState } from "react";

import { DetailDialog, useDialogParam } from "@/components/DetailDialog";
import { AttendanceAdvancedNotice, AttendanceWorkforceShell } from "@/components/attendance/workforce/AttendanceWorkforceShell";
import {
  backdateAttendanceSchedule,
  createAttendanceSchedule,
  createAttendanceWorkLocation,
  listAttendanceScheduleAssignments,
  listAttendanceSchedules,
  listAttendanceWorkLocations,
  updateAttendanceSchedule,
  updateAttendanceWorkLocation,
  type AttendanceScheduleAssignmentItem, shiftHoursText,
  type ShiftBlock,
  unlocatedShifts,
  type WorkLocationUsage,
} from "@/lib/workforceAttendance";

function Notice({ error, notice }: { error: string | null; notice: string | null }) {
  return (
    <>
      {error ? (
        <div className="mb-4 flex gap-3 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </div>
      ) : null}
      {notice ? (
        <div className="mb-4 flex gap-3 rounded-2xl border border-success-line bg-success-soft p-4 text-sm text-success-ink">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> {notice}
        </div>
      ) : null}
    </>
  );
}

// ORG-005-3: how a mobile clock-in finds its place — the shift's location, else the employee's unit's.
const LOCATIONS_HREF = "/admin/attendance/settings/locations";
const SHIFTS_HREF = "/admin/attendance/shifts";
const SHIFT_LOCATION_HELP = "Absen dari HP dicek terhadap titik dan radius lokasi ini. Bila dikosongkan, dipakai lokasi kerja unit pegawai di Struktur; bila unitnya juga belum punya lokasi, absen HP tetap tersimpan tetapi masuk antrean tinjau.";
const NO_LOCATION_WARNING = "Belum ada lokasi — absen HP tidak dicek radius";

/** The latest date "Mundurkan awal berlaku" accepts: strictly earlier than the current start. */
function dayBefore(date: string) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function todayJakarta() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date()); }
function tomorrowJakarta() { const value = new Date(`${todayJakarta()}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + 1); return value.toISOString().slice(0, 10); }

type ScheduleItem = Awaited<ReturnType<typeof listAttendanceSchedules>>["items"][number];
type ScheduleEditForm = { name: string; startTime: string; endTime: string; endDayOffset: string; lateGraceMinutes: string; earlyLeaveToleranceMinutes: string; workLocationId: string; active: boolean; effectiveFrom: string };
// ATT-011-4a: editing starts from a scheduled change when there is one, so saving does not undo it.
function scheduleEditForm(item: ScheduleItem): ScheduleEditForm {
  const pending = item.pendingVersion;
  return {
    name: item.name, startTime: pending?.startTime ?? item.startTime, endTime: pending?.endTime ?? item.endTime,
    endDayOffset: String(item.endDayOffset ?? 0), lateGraceMinutes: String(pending?.lateGraceMinutes ?? item.lateGraceMinutes),
    earlyLeaveToleranceMinutes: String(pending?.earlyLeaveToleranceMinutes ?? item.earlyLeaveToleranceMinutes),
    workLocationId: item.workLocationId ?? "", active: item.active, effectiveFrom: pending?.effectiveFrom ?? tomorrowJakarta(),
  };
}
function hoursChanges(item: ScheduleItem, form: ScheduleEditForm) {
  const changes: { startTime?: string; endTime?: string; endDayOffset?: number; lateGraceMinutes?: number; earlyLeaveToleranceMinutes?: number; workLocationId?: string | null } = {};
  if (form.startTime.slice(0, 5) !== item.startTime.slice(0, 5)) changes.startTime = form.startTime;
  if (form.endTime.slice(0, 5) !== item.endTime.slice(0, 5)) changes.endTime = form.endTime;
  if (Number(form.endDayOffset) !== (item.endDayOffset ?? 0)) changes.endDayOffset = Number(form.endDayOffset);
  if (Number(form.lateGraceMinutes) !== item.lateGraceMinutes) changes.lateGraceMinutes = Number(form.lateGraceMinutes);
  if (Number(form.earlyLeaveToleranceMinutes) !== item.earlyLeaveToleranceMinutes) changes.earlyLeaveToleranceMinutes = Number(form.earlyLeaveToleranceMinutes);
  if ((form.workLocationId || null) !== (item.workLocationId ?? null)) changes.workLocationId = form.workLocationId || null;
  return changes;
}
function hoursChanged(item: ScheduleItem, form: ScheduleEditForm) { return Object.keys(hoursChanges(item, form)).length > 0; }
// Only what changed is sent: hours and location from "Berlaku mulai", a rename or deactivation from now.
function scheduleChanges(item: ScheduleItem, form: ScheduleEditForm) {
  const hours = hoursChanges(item, form);
  return {
    ...hours,
    ...(Object.keys(hours).length ? { effectiveFrom: form.effectiveFrom || todayJakarta() } : {}),
    ...(form.name !== item.name ? { name: form.name } : {}),
    ...(form.active !== item.active ? { active: form.active } : {}),
  };
}

type LocationItem = { id: string; name: string; latitude: number; longitude: number; radiusMeters: number; active: boolean; usage?: WorkLocationUsage };
type LocationEditFields = { name: string; latitude: string; longitude: string; radiusMeters: string; active: boolean };

/** The "Edit" pop-up of one work location; its fields start from the saved values. */
function LocationEditForm({ item, busy, onSave, onCancel }: { item: LocationItem; busy: boolean; onSave: (form: LocationEditFields) => void; onCancel: () => void }) {
  const [editForm, setEditForm] = useState<LocationEditFields>(() => ({ name: item.name, latitude: String(item.latitude), longitude: String(item.longitude), radiusMeters: String(item.radiusMeters), active: item.active }));
  return (
    <div className="grid gap-3 text-sm">
      <label className="grid gap-1 text-xs font-semibold text-muted-foreground">Nama lokasi
        <input className="h-10 rounded-xl border px-3 text-sm font-normal text-foreground" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="grid gap-1 text-xs font-semibold text-muted-foreground">Latitude
          <input className="h-10 rounded-xl border px-3 text-sm font-normal text-foreground" type="number" step="any" value={editForm.latitude} onChange={(e) => setEditForm({ ...editForm, latitude: e.target.value })} />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-muted-foreground">Longitude
          <input className="h-10 rounded-xl border px-3 text-sm font-normal text-foreground" type="number" step="any" value={editForm.longitude} onChange={(e) => setEditForm({ ...editForm, longitude: e.target.value })} />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-muted-foreground">Radius (meter)
          <input className="h-10 rounded-xl border px-3 text-sm font-normal text-foreground" type="number" min="10" value={editForm.radiusMeters} onChange={(e) => setEditForm({ ...editForm, radiusMeters: e.target.value })} />
        </label>
      </div>
      <div className="grid gap-1 text-xs"><span className="font-semibold text-muted-foreground">Dipakai oleh</span><LocationUsage usage={item.usage} active={item.active} /></div>
      <label className="flex items-center gap-2"><input type="checkbox" checked={editForm.active} onChange={(e) => setEditForm({ ...editForm, active: e.target.checked })} /> Aktif</label>
      <div className="flex flex-wrap gap-2 border-t pt-3">
        <button type="button" disabled={busy} className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-4 text-xs font-bold text-brand-foreground disabled:opacity-50" onClick={() => onSave(editForm)}><Save className="h-4 w-4" /> Simpan</button>
        <button type="button" className="h-10 rounded-xl border px-4 text-xs font-bold" onClick={onCancel}>Batal</button>
      </div>
    </div>
  );
}

export function AdminAttendanceLocationsPage() {
  const [items, setItems] = useState<LocationItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [form, setForm] = useState({ name: "", latitude: "", longitude: "", radiusMeters: "150" });
  // The location being edited opens as a pop-up kept in the URL (`?lokasi=<id>`).
  const [editing, openEditing, closeEditing] = useDialogParam("lokasi");
  const editItem = editing ? items.find((item) => item.id === editing) ?? null : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => { setItems((await listAttendanceWorkLocations()).items); setLoaded(true); };
  useEffect(() => { void load().catch((cause) => setError(cause instanceof Error ? cause.message : "Lokasi kerja tidak dapat dimuat.")); }, []);

  const run = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true); setError(null); setNotice(null);
    try { await action(); await load(); setNotice(message); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Lokasi kerja gagal disimpan."); }
    finally { setBusy(false); }
  };

  return (
    <AttendanceWorkforceShell tab="locations" title="Lokasi kerja" description="Titik kerja dan radius untuk absen dari HP. Absen di luar radius tetap tersimpan dan ditandai untuk ditinjau.">
      <Notice error={error} notice={notice} />
      <section className="rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
        <h2 className="font-bold text-brand-heading">Tambah lokasi</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">Satu lokasi untuk setiap tempat kerja, misalnya satu gedung sekolah. Titik diambil dari peta (klik kanan di Google Maps lalu salin koordinat). Radius 100–200 m biasanya cukup untuk satu gedung; dua sekolah dalam satu kompleks boleh dibuat sebagai dua lokasi dengan titik dan radius masing-masing.</p>
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
          className="mt-3 inline-flex h-11 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50"
        ><Plus className="h-4 w-4" /> Tambah lokasi</button>
      </section>

      <section className="mt-5 overflow-hidden rounded-2xl border border-border/70 bg-surface-raised shadow-[var(--shadow-soft)]">
        <div className="border-b border-border/70 p-4">
          <h2 className="font-bold text-brand-heading">Daftar lokasi</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">Absen dari HP dicek terhadap lokasi shift pegawai. Shift tanpa lokasi memakai lokasi unit pegawai yang diatur di <a className="font-semibold text-brand-primary-deep underline" href="/admin/organization">Struktur</a>.</p>
        </div>
        {loaded && items.length === 0 ? (
          <div className="flex gap-3 p-5 text-sm text-muted-foreground">
            <MapPin className="mt-0.5 h-4 w-4 shrink-0" />
            <p>Belum ada lokasi kerja. Tambahkan lokasi seperti gedung sekolah di atas, lalu pilih lokasinya pada <a className="font-semibold text-brand-primary-deep underline" href={SHIFTS_HREF}>Shift</a> supaya absen dari HP dicek radiusnya.</p>
          </div>
        ) : (
        <div className="overflow-x-auto">
          <table className="min-w-[980px] w-full text-left text-sm">
            <thead className="bg-surface text-xs text-muted-foreground"><tr><th className="p-3">Nama</th><th className="p-3">Latitude</th><th className="p-3">Longitude</th><th className="p-3">Radius</th><th className="p-3">Dipakai oleh</th><th className="p-3">Status</th><th className="p-3">Aksi</th></tr></thead>
            <tbody className="divide-y divide-border/70">
              {items.map((item) => (
                <tr key={item.id}>
                  <td className="p-3 font-semibold">{item.name}</td><td className="p-3 font-mono text-xs">{item.latitude}</td><td className="p-3 font-mono text-xs">{item.longitude}</td><td className="p-3">{item.radiusMeters} m</td><td className="p-3"><LocationUsage usage={item.usage} active={item.active} /></td><td className="p-3">{item.active ? "Aktif" : "Nonaktif"}</td>
                  <td className="p-3"><button className="inline-flex items-center gap-1 text-xs font-bold text-brand-primary-deep" onClick={() => openEditing(item.id)}><Pencil className="h-3.5 w-3.5" /> Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
      </section>

      {editing && loaded ? (
        <DetailDialog title={editItem ? `Edit lokasi ${editItem.name}` : "Edit lokasi"} onClose={closeEditing}>
          <Notice error={error} notice={null} />
          {editItem ? (
            <LocationEditForm item={editItem} busy={busy} onCancel={closeEditing} onSave={(editForm) => void run(async () => {
              await updateAttendanceWorkLocation(editItem.id, {
                name: editForm.name, latitude: Number(editForm.latitude), longitude: Number(editForm.longitude),
                radiusMeters: Number(editForm.radiusMeters), active: editForm.active,
              }); closeEditing();
            }, "Lokasi diperbarui.")} />
          ) : <p className="text-sm text-muted-foreground">Lokasi ini tidak ada di daftar yang ditampilkan.</p>}
        </DetailDialog>
      ) : null}
    </AttendanceWorkforceShell>
  );
}

/** ORG-005-3: the Shift screen banner with the count and the next step. */
export function UnlocatedShiftsBanner({ count, hasLocations, onLocate }: { count: number; hasLocations: boolean; onLocate: () => void }) {
  if (!count) return null;
  return (
    <div role="status" className="mb-4 flex flex-wrap items-start gap-3 rounded-2xl border border-warning-line bg-warning-soft p-4 text-sm text-warning-ink">
      <MapPin className="mt-0.5 h-4 w-4 shrink-0" />
      <p className="min-w-[16rem] flex-1">
        <span className="font-bold">{count} shift aktif belum punya lokasi kerja.</span>{" "}
        Absen dari HP pegawai di shift ini tidak dicek radius, kecuali unitnya punya lokasi di Struktur; hasilnya masuk antrean tinjau.
      </p>
      {hasLocations ? (
        <button type="button" className="h-9 rounded-lg bg-brand-primary px-3 text-xs font-bold text-brand-foreground" onClick={onLocate}>Atur lokasi</button>
      ) : (
        <a className="inline-flex h-9 items-center rounded-lg bg-brand-primary px-3 text-xs font-bold text-brand-foreground" href={LOCATIONS_HREF}>Tambah lokasi kerja</a>
      )}
    </div>
  );
}

/** ORG-005-3: which shifts, how many units and machines use a location; a nudge when no shift does. */
export function LocationUsage({ usage, active }: { usage: WorkLocationUsage | undefined; active: boolean }) {
  if (!usage) return <span className="text-muted-foreground">—</span>;
  const extra = [usage.unitCount ? `${usage.unitCount} unit` : null, usage.deviceCount ? `${usage.deviceCount} mesin` : null].filter(Boolean).join(" · ");
  return (
    <div className="grid gap-1 text-xs">
      {usage.shifts.length ? (
        <span><span className="font-semibold">{usage.shifts.length} shift:</span> {usage.shifts.map((shift) => shift.name).join(", ")}</span>
      ) : active ? (
        <a className="font-semibold text-brand-primary-deep underline" href={SHIFTS_HREF}>Belum dipakai shift — tautkan ke shift</a>
      ) : <span className="text-muted-foreground">Tidak dipakai shift</span>}
      {extra ? <span className="text-muted-foreground">{extra}</span> : null}
    </div>
  );
}

/** The "Edit" pop-up of one shift; its fields start from the saved values or the scheduled change. */
function ShiftEditForm({ item, locations, busy, onSave, onCancel }: {
  item: ScheduleItem;
  locations: Array<{ id: string; name: string; active: boolean }>;
  busy: boolean;
  onSave: (form: ScheduleEditForm) => void;
  onCancel: () => void;
}) {
  const [editForm, setEditForm] = useState<ScheduleEditForm>(() => scheduleEditForm(item));
  return (
    <div className="grid gap-3 text-sm">
      <label className="grid gap-1 text-xs font-semibold text-muted-foreground">Nama shift
        <input className="h-10 rounded-xl border px-3 text-sm font-normal text-foreground" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="grid gap-1 text-xs font-semibold text-muted-foreground">Jam mulai
          <input className="h-10 rounded-xl border px-3 text-sm font-normal text-foreground" type="time" value={editForm.startTime.slice(0,5)} onChange={(e) => setEditForm({ ...editForm, startTime: e.target.value })} />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-muted-foreground">Jam selesai
          <input className="h-10 rounded-xl border px-3 text-sm font-normal text-foreground" type="time" value={editForm.endTime.slice(0,5)} onChange={(e) => setEditForm({ ...editForm, endTime: e.target.value })} />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-muted-foreground">Selesai
          <select className="h-10 rounded-xl border px-3 text-sm font-normal text-foreground" value={editForm.endDayOffset} onChange={(e) => setEditForm({ ...editForm, endDayOffset: e.target.value })}><option value="0">Hari sama</option><option value="1">+1 hari</option></select>
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-xs font-semibold text-muted-foreground">Toleransi terlambat (menit)
          <input className="h-10 rounded-xl border px-3 text-sm font-normal text-foreground" type="number" value={editForm.lateGraceMinutes} onChange={(e) => setEditForm({ ...editForm, lateGraceMinutes: e.target.value })} />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-muted-foreground">Toleransi pulang cepat (menit)
          <input className="h-10 rounded-xl border px-3 text-sm font-normal text-foreground" type="number" value={editForm.earlyLeaveToleranceMinutes} onChange={(e) => setEditForm({ ...editForm, earlyLeaveToleranceMinutes: e.target.value })} />
        </label>
      </div>
      <label className="grid gap-1 text-xs font-semibold text-brand-heading">Lokasi kerja (absen HP)
        <select className="h-10 rounded-xl border border-brand-primary/40 px-3 text-sm font-normal text-foreground" value={editForm.workLocationId} onChange={(e) => setEditForm({ ...editForm, workLocationId: e.target.value })}><option value="">Tanpa lokasi (pakai lokasi unit)</option>{locations.filter((loc) => loc.active || loc.id === editForm.workLocationId).map((loc) => <option key={loc.id} value={loc.id}>{loc.name}</option>)}</select>
        <span className="text-[11px] font-normal leading-4 text-muted-foreground">Berlaku mulai tanggal di bawah. Kosong = lokasi unit pegawai.</span>
      </label>
      <label className="grid gap-1 text-xs font-semibold text-muted-foreground">Berlaku mulai
        <input className="h-10 w-full max-w-xs rounded-xl border px-3 text-sm font-normal text-foreground" type="date" min={todayJakarta()} value={editForm.effectiveFrom} onChange={(e) => setEditForm({ ...editForm, effectiveFrom: e.target.value })} />
        <span className="font-normal text-muted-foreground">Dipakai {item.employeeCount ?? 0} pegawai; jadwal sebelum tanggal ini tidak berubah.</span>
      </label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={editForm.active} onChange={(e) => setEditForm({ ...editForm, active: e.target.checked })} /> Aktif</label>
      <div className="flex flex-wrap gap-2 border-t pt-3">
        <button type="button" disabled={busy} className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-4 text-xs font-bold text-brand-foreground disabled:opacity-50" onClick={() => onSave(editForm)}><Save className="h-4 w-4" /> Simpan</button>
        <button type="button" className="h-10 rounded-xl border px-4 text-xs font-bold" onClick={onCancel}>Batal</button>
      </div>
    </div>
  );
}

export function AdminAttendanceSchedulesPage() {
  const [locations, setLocations] = useState<Array<{ id: string; name: string; active: boolean }>>([]);
  const [items, setItems] = useState<Awaited<ReturnType<typeof listAttendanceSchedules>>["items"]>([]);
  const [form, setForm] = useState({ name: "", startTime: "08:00", endTime: "16:00", endDayOffset: "0", lateGraceMinutes: "10", earlyLeaveToleranceMinutes: "0", workLocationId: "", effectiveFrom: "" });
  // ATT-013: blocks 2-3 of a shift with more than one work block per day.
  const [extraBlocks, setExtraBlocks] = useState<ShiftBlock[]>([]);
  // ATT-013 D-13-6: "Hitungan hari" per block; empty = an equal share for every block.
  const [firstWeight, setFirstWeight] = useState("");
  // ATT-014 §20.10 "Mundurkan awal berlaku": one shift at a time, date + reason, audited by the API.
  const [backdating, setBackdating] = useState<{ id: string; effectiveFrom: string; reason: string } | null>(null);
  // The shift being edited opens as a pop-up kept in the URL (`?shift=<id>`).
  const [editing, openEditing, closeEditing] = useDialogParam("shift");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  const [mobileOn, setMobileOn] = useState(false);

  const load = async () => {
    const [scheduleResult, locationResult] = await Promise.all([listAttendanceSchedules(), listAttendanceWorkLocations()]);
    setItems(scheduleResult.items); setLocations(locationResult.items); setMobileOn(Boolean(scheduleResult.mobileAttendanceEnabled)); setLoaded(true);
  };
  const editItem = editing ? items.find((item) => item.id === editing) ?? null : null;
  // ORG-005-3: an active shift without a location is worth a warning only while HP attendance is on.
  const activeLocations = locations.filter((item) => item.active);
  const unlocated = unlocatedShifts(items, mobileOn, new Set(locations.filter((item) => !item.active).map((item) => item.id)));
  const startLocating = (item: ScheduleItem) => openEditing(item.id);
  useEffect(() => { void load().catch((cause) => setError(cause instanceof Error ? cause.message : "Shift tidak dapat dimuat.")); }, []);
  const run = async (action: () => Promise<unknown>, message: string) => { setBusy(true); setError(null); setNotice(null); try { await action(); await load(); setNotice(message); } catch (cause) { setError(cause instanceof Error ? cause.message : "Shift gagal disimpan."); } finally { setBusy(false); } };

  return (
    <AttendanceWorkforceShell tab="shifts" title="Shift" description="Jam kerja, toleransi terlambat, toleransi pulang cepat, dan lokasi kerja. Shift yang melewati tengah malam selesai keesokan harinya.">
      <Notice error={error} notice={notice} />
      <UnlocatedShiftsBanner count={unlocated.length} hasLocations={activeLocations.length > 0} onLocate={() => startLocating(unlocated[0]!)} />
      <section className="rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
        <h2 className="font-bold text-brand-heading">Tambah shift</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <input className="h-11 rounded-xl border px-3 text-sm" placeholder="Nama shift" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="h-11 rounded-xl border px-3 text-sm" type="time" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} />
          <input className="h-11 rounded-xl border px-3 text-sm" type="time" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} />
          <select className="h-11 rounded-xl border px-3 text-sm" value={form.endDayOffset} onChange={(e) => setForm({ ...form, endDayOffset: e.target.value })}><option value="0">Selesai hari yang sama</option><option value="1">Selesai hari berikutnya (+1)</option></select>
          <input className="h-11 rounded-xl border px-3 text-sm" type="number" min="0" max="240" placeholder="Toleransi terlambat (menit)" aria-label="Toleransi terlambat (menit)" value={form.lateGraceMinutes} onChange={(e) => setForm({ ...form, lateGraceMinutes: e.target.value })} />
          <input className="h-11 rounded-xl border px-3 text-sm" type="number" min="0" max="240" placeholder="Toleransi pulang cepat (menit)" aria-label="Toleransi pulang cepat (menit)" value={form.earlyLeaveToleranceMinutes} onChange={(e) => setForm({ ...form, earlyLeaveToleranceMinutes: e.target.value })} />
          <label className="text-xs font-semibold text-muted-foreground">Berlaku sejak
            <input className="mt-1 h-11 w-full rounded-xl border px-3 text-sm" type="date" max={todayJakarta()} value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} />
          </label>
        </div>
        <div className="mt-3 rounded-xl border border-brand-primary/30 bg-surface p-3">
          <label htmlFor="new-shift-location" className="flex items-center gap-2 text-sm font-bold text-brand-heading"><MapPin className="h-4 w-4" /> Lokasi kerja (untuk absen HP)</label>
          <select id="new-shift-location" className="mt-2 h-11 w-full max-w-md rounded-xl border px-3 text-sm" value={form.workLocationId} onChange={(e) => setForm({ ...form, workLocationId: e.target.value })}><option value="">Tanpa lokasi (pakai lokasi unit)</option>{activeLocations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">{SHIFT_LOCATION_HELP}{activeLocations.length ? null : <> Belum ada lokasi kerja: <a className="font-semibold text-brand-primary-deep underline" href={LOCATIONS_HREF}>tambahkan di Lokasi kerja</a>.</>}</p>
        </div>
        <div className="mt-3 grid gap-2">
          {extraBlocks.map((block, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-xs font-semibold text-muted-foreground">Blok {index + 2}</span>
              <input className="h-10 rounded-xl border px-3" type="time" aria-label={`Mulai blok ${index + 2}`} value={block.startTime} onChange={(e) => setExtraBlocks(extraBlocks.map((item, at) => at === index ? { ...item, startTime: e.target.value } : item))} />
              <input className="h-10 rounded-xl border px-3" type="time" aria-label={`Selesai blok ${index + 2}`} value={block.endTime} onChange={(e) => setExtraBlocks(extraBlocks.map((item, at) => at === index ? { ...item, endTime: e.target.value } : item))} />
              <input className="h-10 w-28 rounded-xl border px-3" type="number" min="0.01" max="1" step="0.01" placeholder="Hitungan hari" aria-label={`Hitungan hari blok ${index + 2}`} value={block.workdayWeight ?? ""} onChange={(e) => setExtraBlocks(extraBlocks.map((item, at) => {
                if (at !== index) return item;
                const { workdayWeight: _old, ...rest } = item;
                void _old;
                return e.target.value ? { ...rest, workdayWeight: Number(e.target.value) } : rest;
              }))} />
              <button type="button" className="rounded-lg border p-2" aria-label={`Hapus blok ${index + 2}`} onClick={() => setExtraBlocks(extraBlocks.filter((_, at) => at !== index))}><X className="h-4 w-4" /></button>
            </div>
          ))}
          {extraBlocks.length ? (
            <label className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">Hitungan hari blok 1
              <input className="h-10 w-28 rounded-xl border px-3 text-sm" type="number" min="0.01" max="1" step="0.01" value={firstWeight} onChange={(e) => setFirstWeight(e.target.value)} />
            </label>
          ) : null}
          {extraBlocks.length < 2 ? (
            <button type="button" className="inline-flex w-fit items-center gap-1 text-xs font-bold text-brand-primary-deep" onClick={() => setExtraBlocks([...extraBlocks, { startTime: "", endTime: "" }])}><Plus className="h-3.5 w-3.5" /> Tambah blok</button>
          ) : null}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Blok tambahan untuk pegawai yang bekerja dua atau tiga kali sehari dengan jeda panjang (misalnya 04:00–08:30 dan 14:30–19:30). Setiap blok dinilai sendiri dengan toleransi yang sama. Jeda antarblok minimal 30 menit. Hitungan hari (misalnya 0,5 + 0,5) harus berjumlah 1; kosongkan semuanya untuk bagian yang sama rata.</p>
        <p className="mt-2 text-xs text-muted-foreground">Pilih "Selesai hari berikutnya" untuk shift malam. "Berlaku sejak" menentukan tanggal pertama shift ini dipakai (kosong = sejak disimpan); pola jadwal pada tanggal sebelumnya tidak dinilai. Perubahan jam shift langsung berlaku sejak disimpan, termasuk untuk hari ini.</p>
        <button className="mt-3 inline-flex h-11 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50" disabled={busy || !form.name || extraBlocks.some((block) => !block.startTime || !block.endTime)} onClick={() => void run(async () => {
          await createAttendanceSchedule({ name: form.name, startTime: form.startTime, endTime: form.endTime, endDayOffset: Number(form.endDayOffset), lateGraceMinutes: Number(form.lateGraceMinutes), earlyLeaveToleranceMinutes: Number(form.earlyLeaveToleranceMinutes), workLocationId: form.workLocationId || null, ...(form.effectiveFrom ? { effectiveFrom: form.effectiveFrom } : {}), ...(extraBlocks.length ? { extraBlocks, ...(firstWeight ? { firstBlockWorkdayWeight: Number(firstWeight) } : {}) } : {}) });
          setForm({ name: "", startTime: "08:00", endTime: "16:00", endDayOffset: "0", lateGraceMinutes: "10", earlyLeaveToleranceMinutes: "0", workLocationId: "", effectiveFrom: "" });
          setExtraBlocks([]);
          setFirstWeight("");
        }, "Shift ditambahkan.")}><Plus className="h-4 w-4" /> Tambah shift</button>
      </section>

      <section className="mt-5 overflow-hidden rounded-2xl border border-border/70 bg-surface-raised shadow-[var(--shadow-soft)]">
        <div className="border-b p-4"><h2 className="font-bold text-brand-heading">Daftar shift</h2></div>
        <div className="overflow-x-auto"><table className="min-w-[950px] w-full text-left text-sm"><thead className="bg-surface text-xs text-muted-foreground"><tr><th className="p-3">Shift</th><th className="p-3">Jam</th><th className="p-3">Toleransi terlambat</th><th className="p-3">Toleransi pulang cepat</th><th className="p-3">Lokasi</th><th className="p-3">Berlaku sejak</th><th className="p-3">Status</th><th className="p-3">Aksi</th></tr></thead><tbody className="divide-y">
          {items.map((item) => (
            <Fragment key={item.id}>
            <tr id={`shift-${item.id}`}><td className="p-3 font-semibold">{item.name}</td><td className="p-3">{shiftHoursText(item)}{item.pendingVersion ? <span className="block text-xs text-warning-ink">Mulai {item.pendingVersion.effectiveFrom}: {item.pendingVersion.startTime.slice(0, 5)}–{item.pendingVersion.endTime.slice(0, 5)}</span> : null}<span className="block text-xs text-muted-foreground">Dipakai {item.employeeCount ?? 0} pegawai</span></td><td className="p-3">{item.lateGraceMinutes} mnt</td><td className="p-3">{item.earlyLeaveToleranceMinutes} mnt</td><td className="p-3">{unlocated.includes(item) ? (
              <span className="grid gap-1">
                {item.workLocationName ? <span className="text-muted-foreground line-through">{item.workLocationName}</span> : null}
                <span className="inline-flex w-fit items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-xs font-semibold text-warning-ink"><AlertTriangle className="h-3 w-3" /> {item.workLocationName ? "Lokasi nonaktif — absen HP tidak memakainya" : NO_LOCATION_WARNING}</span>
                {activeLocations.length ? <button type="button" className="w-fit text-xs font-bold text-brand-primary-deep" onClick={() => startLocating(item)}>Atur lokasi</button> : null}
              </span>
            ) : (item.workLocationName ?? "—")}</td><td className="p-3 tabular-nums">{item.effectiveFrom ?? "—"}</td><td className="p-3">{item.active ? "Aktif" : "Nonaktif"}</td><td className="p-3"><div className="flex flex-wrap gap-3"><button className="inline-flex items-center gap-1 text-xs font-bold text-brand-primary-deep" onClick={() => openEditing(item.id)}><Pencil className="h-3.5 w-3.5" /> Edit</button><button className="text-xs font-bold text-brand-primary-deep" onClick={() => setBackdating({ id: item.id, effectiveFrom: "", reason: "" })}>Mundurkan awal berlaku</button></div></td></tr>
            {backdating?.id === item.id ? (
              <tr><td colSpan={8} className="bg-surface p-3">
                <div className="flex flex-wrap items-end gap-3 text-sm">
                  <label className="text-xs font-semibold text-muted-foreground">Berlaku sejak (lebih awal dari {item.effectiveFrom ?? "sekarang"})
                    <input className="mt-1 h-9 rounded-lg border px-2" type="date" max={dayBefore(item.effectiveFrom ?? todayJakarta())} value={backdating.effectiveFrom} onChange={(e) => setBackdating({ ...backdating, effectiveFrom: e.target.value })} />
                  </label>
                  <label className="min-w-[16rem] flex-1 text-xs font-semibold text-muted-foreground">Alasan
                    <input className="mt-1 h-9 w-full rounded-lg border px-2" maxLength={500} value={backdating.reason} onChange={(e) => setBackdating({ ...backdating, reason: e.target.value })} placeholder="Mis. shift ini sudah dipakai sejak Juli 2021" />
                  </label>
                  <button className="h-9 rounded-lg bg-brand-primary px-3 text-xs font-bold text-brand-foreground disabled:opacity-50" disabled={busy || !backdating.effectiveFrom || backdating.reason.trim().length < 3} onClick={() => void run(async () => { await backdateAttendanceSchedule(item.id, { effectiveFrom: backdating.effectiveFrom, reason: backdating.reason.trim() }); setBackdating(null); }, "Awal berlaku shift dimundurkan. Jalankan Kalkulasi untuk menghitung ulang tanggal yang baru tercakup.")}>Simpan</button>
                  <button className="h-9 rounded-lg border px-3 text-xs font-bold" onClick={() => setBackdating(null)}>Batal</button>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">Jam dan toleransi versi pertama shift ini akan berlaku juga untuk tanggal sebelumnya. Pola jadwal pegawai tetap harus mencakup tanggal tersebut. Perubahan dicatat di audit.</p>
              </td></tr>
            ) : null}
            </Fragment>
          ))}
        </tbody></table></div>
      </section>

      {editing && loaded ? (
        <DetailDialog title={editItem ? `Edit shift ${editItem.name}` : "Edit shift"} onClose={closeEditing}>
          <Notice error={error} notice={null} />
          {editItem ? (
            <ShiftEditForm item={editItem} locations={locations} busy={busy} onCancel={closeEditing} onSave={(editForm) => void run(async () => { const changes = scheduleChanges(editItem, editForm); if (Object.keys(changes).length) await updateAttendanceSchedule(editItem.id, changes); closeEditing(); }, editForm.effectiveFrom > todayJakarta() && hoursChanged(editItem, editForm) ? `Shift diperbarui mulai ${editForm.effectiveFrom}.` : "Shift diperbarui.")} />
          ) : <p className="text-sm text-muted-foreground">Shift ini tidak ada di daftar yang ditampilkan.</p>}
        </DetailDialog>
      ) : null}
    </AttendanceWorkforceShell>
  );
}

const weekdayLabels = ["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"];

function maskDays(mask: number) {
  return weekdayLabels.filter((_, index) => (mask & (1 << index)) !== 0).join(", ");
}

// ATT-011-8: the old pattern screen is a read-only "Tampilan lanjutan". Schedules are changed in Kalender
// (Atur/Ganti/Salin jadwal); the pattern endpoints stay for compatibility only.
export function AdminAttendanceAssignmentsPage() {
  const [items, setItems] = useState<AttendanceScheduleAssignmentItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listAttendanceScheduleAssignments()
      .then((result) => setItems(result.items))
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Pola jadwal tidak dapat dimuat."));
  }, []);

  return (
    <AttendanceWorkforceShell tab="patterns" title="Pola jadwal (lama)" description="Tampilan lanjutan, baca saja: pola jadwal per pegawai seperti yang tersimpan. Jadwal diubah di Kalender.">
      <AttendanceAdvancedNotice />
      <Notice error={error} notice={null} />
      <section className="overflow-hidden rounded-2xl border border-border/70 bg-surface-raised shadow-[var(--shadow-soft)]">
        <div className="border-b p-4"><h2 className="font-bold text-brand-heading">Riwayat pola jadwal</h2><p className="mt-1 text-xs text-muted-foreground">Pola yang tumpang tindih membuat hari itu berstatus "Jadwal bermasalah". Perbaiki lewat Atur jadwal di Kalender; perubahan dari Kalender menutup pola lama dengan sendirinya.</p></div>
        {items === null && !error ? <p className="p-5 text-sm text-muted-foreground">Memuat…</p> : null}
        {items && items.length === 0 ? <p className="p-5 text-sm text-muted-foreground">Belum ada pola jadwal.</p> : null}
        {items && items.length ? (
          <div className="overflow-x-auto"><table className="min-w-[900px] w-full text-left text-sm"><thead className="bg-surface text-xs text-muted-foreground"><tr><th className="p-3">Pegawai</th><th className="p-3">Unit</th><th className="p-3">Shift</th><th className="p-3">Hari</th><th className="p-3">Periode</th></tr></thead><tbody className="divide-y">
            {items.map((item) => <tr key={item.id}><td className="p-3"><p className="font-semibold">{item.employeeName}</p><p className="text-xs text-muted-foreground">{item.employeeNumber}</p></td><td className="p-3">{item.unitName ?? "—"}</td><td className="p-3">{item.scheduleName}</td><td className="p-3">{maskDays(item.weekdayMask)}</td><td className="p-3">{item.effectiveFrom} → {item.effectiveTo ?? "seterusnya"}</td></tr>)}
          </tbody></table></div>
        ) : null}
      </section>
    </AttendanceWorkforceShell>
  );
}
