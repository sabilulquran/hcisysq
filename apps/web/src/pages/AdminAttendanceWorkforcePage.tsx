import { AlertTriangle, CheckCircle2, Loader2, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AdminShell } from "@/layouts/AdminShell";
import { listEmployees, type AdminEmployeeListItem } from "@/lib/adminEmployees";
import {
  createAttendanceRoster,
  createAttendanceSchedule,
  createAttendanceScheduleAssignment,
  createAttendanceWorkLocation,
  decideAttendanceClarification,
  finalizeAttendanceDate,
  getAttendanceReport,
  listAttendanceClarificationsForHc,
  listAttendanceSchedules,
  listAttendanceWorkLocations,
  publishAttendanceRoster,
  updateAttendanceRosterEntries,
} from "@/lib/workforceAttendance";

function todayJakarta() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function allEmployees() {
  const first = await listEmployees({ page: 1, pageSize: 100, status: "active" });
  if (first.pagination.pageCount <= 1) return first.items;
  const rest = await Promise.all(
    Array.from({ length: first.pagination.pageCount - 1 }, (_, index) =>
      listEmployees({ page: index + 2, pageSize: 100, status: "active" }),
    ),
  );
  return [first, ...rest].flatMap((item) => item.items);
}

export function AdminAttendanceWorkforcePage() {
  const [employees, setEmployees] = useState<AdminEmployeeListItem[]>([]);
  const [locations, setLocations] = useState<Array<{ id: string; name: string; latitude: number; longitude: number; radiusMeters: number; active: boolean }>>([]);
  const [schedules, setSchedules] = useState<Array<{
    id: string; name: string; startTime: string; endTime: string; lateGraceMinutes: number;
    earlyLeaveToleranceMinutes: number; active: boolean; workLocationId: string | null; workLocationName: string | null;
  }>>([]);
  const [clarifications, setClarifications] = useState<Array<Record<string, unknown>>>([]);
  const [reportDate, setReportDate] = useState(todayJakarta());
  const [report, setReport] = useState<{ summary: Record<string, number>; items: Array<Record<string, unknown>> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [locationName, setLocationName] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [radius, setRadius] = useState("150");

  const [scheduleName, setScheduleName] = useState("");
  const [startTime, setStartTime] = useState("08:00");
  const [endTime, setEndTime] = useState("16:00");
  const [grace, setGrace] = useState("10");
  const [earlyTolerance, setEarlyTolerance] = useState("0");
  const [scheduleLocationId, setScheduleLocationId] = useState("");

  const [employeeId, setEmployeeId] = useState("");
  const [scheduleId, setScheduleId] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(todayJakarta());

  const [rosterWeek, setRosterWeek] = useState("");
  const [rosterId, setRosterId] = useState("");
  const [rosterEmployeeId, setRosterEmployeeId] = useState("");
  const [rosterDate, setRosterDate] = useState("");
  const [rosterScheduleId, setRosterScheduleId] = useState("");
  const [rosterOff, setRosterOff] = useState(false);

  const reload = async () => {
    const [employeeResult, locationResult, scheduleResult, clarificationResult] = await Promise.all([
      allEmployees(),
      listAttendanceWorkLocations(),
      listAttendanceSchedules(),
      listAttendanceClarificationsForHc(),
    ]);
    setEmployees(employeeResult);
    setLocations(locationResult.items);
    setSchedules(scheduleResult.items);
    setClarifications(clarificationResult.items);
    setEmployeeId((current) => current || employeeResult[0]?.id || "");
    setRosterEmployeeId((current) => current || employeeResult[0]?.id || "");
    setScheduleId((current) => current || scheduleResult.items[0]?.id || "");
    setRosterScheduleId((current) => current || scheduleResult.items[0]?.id || "");
  };

  useEffect(() => {
    void reload().catch((cause) => setError(cause instanceof Error ? cause.message : "Data konfigurasi tidak dapat dimuat."));
  }, []);

  const run = async (operation: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await operation();
      setNotice(success);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Operasi gagal.");
    } finally {
      setBusy(false);
    }
  };

  const employeeOptions = useMemo(() => employees.map((item) => (
    <option key={item.id} value={item.id}>{item.fullName} · {item.employeeNumber}</option>
  )), [employees]);

  const loadReport = async () => {
    setBusy(true);
    try {
      const result = await getAttendanceReport(reportDate);
      setReport({ summary: result.summary, items: result.items });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Laporan tidak dapat dimuat.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AdminShell
      active="attendance-workforce"
      title="Operasional Kehadiran"
      description="Kelola lokasi kerja, jadwal/shift, assignment, roster, klarifikasi, finalisasi, dan laporan presensi."
    >
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

      <div className="grid gap-5 xl:grid-cols-2">
        <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
          <h2 className="text-base font-bold text-brand-heading">1. Lokasi kerja / geofence</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <input value={locationName} onChange={(event) => setLocationName(event.target.value)} placeholder="Nama lokasi" className="h-11 rounded-xl border border-border px-3 text-sm" />
            <input value={radius} onChange={(event) => setRadius(event.target.value)} type="number" min="10" placeholder="Radius meter" className="h-11 rounded-xl border border-border px-3 text-sm" />
            <input value={latitude} onChange={(event) => setLatitude(event.target.value)} type="number" step="any" placeholder="Latitude" className="h-11 rounded-xl border border-border px-3 text-sm" />
            <input value={longitude} onChange={(event) => setLongitude(event.target.value)} type="number" step="any" placeholder="Longitude" className="h-11 rounded-xl border border-border px-3 text-sm" />
          </div>
          <button
            type="button"
            disabled={busy || !locationName || !latitude || !longitude}
            onClick={() => void run(
              () => createAttendanceWorkLocation({
                name: locationName,
                latitude: Number(latitude),
                longitude: Number(longitude),
                radiusMeters: Number(radius),
              }),
              "Lokasi kerja disimpan.",
            )}
            className="mt-3 h-11 rounded-xl bg-brand-primary px-4 text-sm font-bold text-white disabled:opacity-50"
          >
            <Save className="mr-2 inline h-4 w-4" /> Simpan lokasi
          </button>
          <div className="mt-4 space-y-2 text-xs text-muted-foreground">
            {locations.map((item) => <div key={item.id}>{item.name} · radius {item.radiusMeters} m</div>)}
          </div>
        </section>

        <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
          <h2 className="text-base font-bold text-brand-heading">2. Template jadwal / shift</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <input value={scheduleName} onChange={(event) => setScheduleName(event.target.value)} placeholder="Nama jadwal" className="h-11 rounded-xl border border-border px-3 text-sm" />
            <select value={scheduleLocationId} onChange={(event) => setScheduleLocationId(event.target.value)} className="h-11 rounded-xl border border-border px-3 text-sm">
              <option value="">Tanpa lokasi kerja</option>
              {locations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <input type="time" value={startTime} onChange={(event) => setStartTime(event.target.value)} className="h-11 rounded-xl border border-border px-3 text-sm" />
            <input type="time" value={endTime} onChange={(event) => setEndTime(event.target.value)} className="h-11 rounded-xl border border-border px-3 text-sm" />
            <input type="number" value={grace} onChange={(event) => setGrace(event.target.value)} min="0" max="240" placeholder="Grace menit" className="h-11 rounded-xl border border-border px-3 text-sm" />
            <input type="number" value={earlyTolerance} onChange={(event) => setEarlyTolerance(event.target.value)} min="0" max="240" placeholder="Toleransi pulang" className="h-11 rounded-xl border border-border px-3 text-sm" />
          </div>
          <button
            type="button"
            disabled={busy || !scheduleName}
            onClick={() => void run(
              () => createAttendanceSchedule({
                name: scheduleName,
                startTime,
                endTime,
                lateGraceMinutes: Number(grace),
                earlyLeaveToleranceMinutes: Number(earlyTolerance),
                workLocationId: scheduleLocationId || null,
              }),
              "Template jadwal disimpan.",
            )}
            className="mt-3 h-11 rounded-xl bg-brand-primary px-4 text-sm font-bold text-white disabled:opacity-50"
          >Simpan jadwal</button>
          <div className="mt-4 space-y-2 text-xs text-muted-foreground">
            {schedules.map((item) => <div key={item.id}>{item.name} · {item.startTime.slice(0, 5)}–{item.endTime.slice(0, 5)} · grace {item.lateGraceMinutes} mnt</div>)}
          </div>
        </section>

        <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
          <h2 className="text-base font-bold text-brand-heading">3. Assignment jadwal default</h2>
          <div className="mt-4 grid gap-3">
            <select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} className="h-11 rounded-xl border border-border px-3 text-sm">{employeeOptions}</select>
            <select value={scheduleId} onChange={(event) => setScheduleId(event.target.value)} className="h-11 rounded-xl border border-border px-3 text-sm">
              {schedules.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <input type="date" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} className="h-11 rounded-xl border border-border px-3 text-sm" />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Default assignment UI memakai Senin–Jumat. Roster dapat override per tanggal.</p>
          <button
            type="button"
            disabled={busy || !employeeId || !scheduleId}
            onClick={() => void run(
              () => createAttendanceScheduleAssignment({
                employeeId,
                scheduleTemplateId: scheduleId,
                weekdays: [1, 2, 3, 4, 5],
                effectiveFrom,
                effectiveTo: null,
              }),
              "Assignment jadwal disimpan.",
            )}
            className="mt-3 h-11 rounded-xl bg-brand-primary px-4 text-sm font-bold text-white disabled:opacity-50"
          >Simpan assignment</button>
        </section>

        <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
          <h2 className="text-base font-bold text-brand-heading">4. Weekly roster</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <input type="date" value={rosterWeek} onChange={(event) => setRosterWeek(event.target.value)} className="h-11 rounded-xl border border-border px-3 text-sm" />
            <button
              type="button"
              disabled={busy || !rosterWeek}
              onClick={() => void run(async () => {
                const created = await createAttendanceRoster(rosterWeek);
                setRosterId(created.id);
              }, "Draft roster dibuat.")}
              className="h-11 rounded-xl border border-brand-primary px-4 text-sm font-bold text-brand-primary-deep disabled:opacity-50"
            >Buat draft</button>
          </div>
          {rosterId ? (
            <div className="mt-4 rounded-2xl bg-surface p-4">
              <p className="text-xs font-bold text-brand-heading">Draft aktif: {rosterId}</p>
              <div className="mt-3 grid gap-3">
                <select value={rosterEmployeeId} onChange={(event) => setRosterEmployeeId(event.target.value)} className="h-11 rounded-xl border border-border px-3 text-sm">{employeeOptions}</select>
                <input type="date" value={rosterDate} onChange={(event) => setRosterDate(event.target.value)} className="h-11 rounded-xl border border-border px-3 text-sm" />
                <select value={rosterScheduleId} onChange={(event) => setRosterScheduleId(event.target.value)} disabled={rosterOff} className="h-11 rounded-xl border border-border px-3 text-sm disabled:opacity-50">
                  {schedules.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={rosterOff} onChange={(event) => setRosterOff(event.target.checked)} /> Libur / OFF</label>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy || !rosterDate || !rosterEmployeeId}
                  onClick={() => void run(
                    () => updateAttendanceRosterEntries(rosterId, [{
                      employeeId: rosterEmployeeId,
                      workDate: rosterDate,
                      scheduleTemplateId: rosterOff ? null : rosterScheduleId,
                      isOff: rosterOff,
                      note: null,
                    }]),
                    "Entry roster disimpan.",
                  )}
                  className="h-10 rounded-xl border border-border bg-white px-3 text-xs font-bold disabled:opacity-50"
                >Simpan entry</button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => publishAttendanceRoster(rosterId), "Roster dipublikasikan.")}
                  className="h-10 rounded-xl bg-brand-primary px-3 text-xs font-bold text-white disabled:opacity-50"
                >Publish roster</button>
              </div>
            </div>
          ) : null}
        </section>
      </div>

      <section className="mt-5 rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
        <h2 className="text-base font-bold text-brand-heading">5. Klarifikasi menunggu keputusan</h2>
        <div className="mt-4 space-y-3">
          {clarifications.length === 0 ? <p className="text-sm text-muted-foreground">Tidak ada klarifikasi tertunda.</p> : null}
          {clarifications.map((item) => (
            <div key={String(item.id)} className="rounded-2xl border border-border/70 p-4">
              <p className="text-sm font-bold text-brand-heading">{String(item.employeeName)} · {String(item.workDate)}</p>
              <p className="mt-1 text-xs text-muted-foreground">{String(item.mode)} · {String(item.kind)}</p>
              <p className="mt-2 text-sm">{String(item.reason)}</p>
              <div className="mt-3 flex gap-2">
                <button type="button" disabled={busy} onClick={() => void run(() => decideAttendanceClarification(String(item.id), "approve", null), "Klarifikasi disetujui.")} className="h-9 rounded-xl bg-brand-primary px-3 text-xs font-bold text-white">Setujui</button>
                <button type="button" disabled={busy} onClick={() => void run(() => decideAttendanceClarification(String(item.id), "reject", null), "Klarifikasi ditolak.")} className="h-9 rounded-xl border border-border px-3 text-xs font-bold">Tolak</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-5 rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
        <h2 className="text-base font-bold text-brand-heading">6. Finalisasi & laporan harian</h2>
        <div className="mt-4 flex flex-wrap gap-2">
          <input type="date" value={reportDate} onChange={(event) => setReportDate(event.target.value)} className="h-11 rounded-xl border border-border px-3 text-sm" />
          <button type="button" disabled={busy} onClick={() => void run(() => finalizeAttendanceDate(reportDate), "Hasil kehadiran dimaterialisasi.")} className="h-11 rounded-xl bg-brand-primary px-4 text-sm font-bold text-white disabled:opacity-50">
            {busy ? <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> : null} Finalisasi
          </button>
          <button type="button" disabled={busy} onClick={() => void loadReport()} className="h-11 rounded-xl border border-border px-4 text-sm font-bold">Muat laporan</button>
        </div>
        {report ? (
          <div className="mt-4">
            <div className="flex flex-wrap gap-2">
              {Object.entries(report.summary).map(([key, value]) => <span key={key} className="rounded-full bg-surface px-3 py-1 text-xs font-bold">{key}: {value}</span>)}
            </div>
            <div className="mt-4 overflow-x-auto">
              <table className="min-w-full text-left text-xs">
                <thead><tr className="border-b"><th className="p-2">Pegawai</th><th className="p-2">Unit</th><th className="p-2">Status</th><th className="p-2">Telat</th><th className="p-2">Jam kerja</th></tr></thead>
                <tbody>
                  {report.items.map((item) => (
                    <tr key={String(item.employeeId)} className="border-b border-border/50">
                      <td className="p-2 font-semibold">{String(item.employeeName)}</td>
                      <td className="p-2">{String(item.unitName ?? "—")}</td>
                      <td className="p-2">{String(item.status)}</td>
                      <td className="p-2">{String(item.lateMinutes ?? 0)} mnt</td>
                      <td className="p-2">{String(item.workedMinutes ?? 0)} mnt</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </section>
    </AdminShell>
  );
}
