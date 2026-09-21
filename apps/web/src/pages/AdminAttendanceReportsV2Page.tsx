import { AlertTriangle, Download, Loader2, Printer } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AttendanceWorkforceShell } from "@/components/attendance/workforce/AttendanceWorkforceShell";
import { listEmployees, type AdminEmployeeListItem } from "@/lib/adminEmployees";
import { listAdmsDevices, type AdmsDevice } from "@/lib/attendance";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import {
  finalizeAttendanceDate,
  getAttendanceReportV2,
  listAttendanceSchedules,
  listAttendanceWorkLocations,
  type AttendanceReportType,
} from "@/lib/workforceAttendance";

function todayJakarta() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
}
function monthStart(value: string) { return value.slice(0, 8) + "01"; }
function shiftDate(value: string, days: number) {
  const date = new Date(value + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function formatTimestamp(value: unknown) {
  if (!value) return "—";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
  }).format(date);
}
function formatMinutes(value: unknown) {
  const minutes = Number(value ?? 0);
  if (!Number.isFinite(minutes)) return "—";
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  if (hours <= 0) return rest + " mnt";
  if (rest === 0) return hours + " jam";
  return hours + " jam " + rest + " mnt";
}
function statusLabel(value: unknown) {
  const labels: Record<string, string> = {
    scheduled: "Terjadwal",
    pending: "Belum check-in",
    present: "Hadir",
    late: "Terlambat",
    incomplete: "Belum lengkap",
    leave: "Cuti/Izin",
    absent: "Tidak hadir",
    off: "Libur",
    configuration_error: "Konfigurasi bermasalah",
    submitted: "Menunggu",
    approved: "Disetujui",
    rejected: "Ditolak",
    cancelled: "Dibatalkan",
  };
  return labels[String(value)] ?? String(value ?? "—");
}
function sourceLabel(value: unknown) {
  if (Array.isArray(value)) return value.map(sourceLabel).join(", ");
  const labels: Record<string, string> = { adms: "Fingerprint/ADMS", mobile: "Mobile", manual: "Manual" };
  return labels[String(value)] ?? String(value ?? "—");
}
function renderValue(key: string, value: unknown) {
  if (value == null || value === "") return "—";
  if (["workedMinutes", "breakMinutes", "lateMinutes", "earlyLeaveMinutes", "overtimeMinutes", "requestedMinutes", "approvedMinutes"].includes(key)) {
    return formatMinutes(value);
  }
  if (["scheduledStartAt", "scheduledEndAt", "firstCheckInAt", "lastCheckOutAt", "checkInAt", "checkOutAt", "occurredAt", "receivedAt", "createdAt", "decidedAt"].includes(key)) {
    return formatTimestamp(value);
  }
  if (key === "status") return statusLabel(value);
  if (key === "source" || key === "sources") return sourceLabel(value);
  if (typeof value === "boolean") return value ? "Ya" : "Tidak";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

const labels: Record<AttendanceReportType, string> = {
  detail: "Detail Harian",
  period: "Rekap Periode",
  unit: "Per Unit",
  sessions: "Sesi Kerja",
  scans: "Data Scan",
  schedule: "Jadwal Harian",
  overtime: "Lembur",
};

const descriptions: Record<AttendanceReportType, string> = {
  detail: "Satu baris per pegawai dan hari kerja dari hasil canonical terbaru.",
  period: "Ringkasan kehadiran per pegawai pada periode terpilih.",
  unit: "Ringkasan operasional per unit kerja.",
  sessions: "Rincian multi-punch per sesi masuk–pulang.",
  scans: "Jejak evidence dari fingerprint/ADMS, mobile, dan manual.",
  schedule: "Jadwal efektif historis termasuk versi roster yang dipublish.",
  overtime: "Permintaan dan durasi lembur yang diajukan atau disetujui.",
};

const columns: Record<AttendanceReportType, Array<[string, string]>> = {
  detail: [
    ["workDate", "Tanggal"], ["employeeNumber", "NIP"], ["employeeName", "Nama"], ["unitName", "Unit"],
    ["status", "Status"], ["scheduledStartAt", "Masuk jadwal"], ["scheduledEndAt", "Pulang jadwal"],
    ["firstCheckInAt", "Masuk aktual"], ["lastCheckOutAt", "Pulang aktual"], ["workedMinutes", "Jam kerja"],
    ["breakMinutes", "Jeda"], ["lateMinutes", "Terlambat"], ["lateJustified", "Telat beralasan"],
    ["earlyLeaveMinutes", "Pulang awal"], ["earlyLeaveJustified", "Pulang awal beralasan"],
    ["overtimeMinutes", "Lembur"], ["sources", "Sumber"], ["resultVersion", "Versi hasil"],
  ],
  period: [
    ["employeeNumber", "NIP"], ["employeeName", "Nama"], ["unitName", "Unit"], ["expectedDays", "Hari kerja"],
    ["attendanceDays", "Hadir"], ["lateDays", "Terlambat"], ["absenceDays", "Tidak hadir"], ["leaveDays", "Cuti/Izin"],
    ["workedMinutes", "Jam kerja"], ["breakMinutes", "Jeda"], ["lateMinutes", "Durasi telat"],
    ["earlyLeaveMinutes", "Pulang awal"], ["overtimeMinutes", "Lembur"],
  ],
  unit: [
    ["unitName", "Unit"], ["employees", "Pegawai"], ["expectedDays", "Hari kerja"], ["attendanceDays", "Hadir"],
    ["lateDays", "Terlambat"], ["absenceDays", "Tidak hadir"], ["leaveDays", "Cuti/Izin"],
    ["workedMinutes", "Jam kerja"], ["overtimeMinutes", "Lembur"],
  ],
  sessions: [
    ["workDate", "Tanggal"], ["employeeNumber", "NIP"], ["employeeName", "Nama"], ["unitName", "Unit"],
    ["sequence", "Sesi ke"], ["checkInAt", "Masuk sesi"], ["checkOutAt", "Pulang sesi"],
    ["workedMinutes", "Durasi"], ["complete", "Lengkap"], ["sourceSummary", "Sumber"], ["resultVersion", "Versi hasil"],
  ],
  scans: [
    ["occurredAt", "Waktu kejadian"], ["receivedAt", "Diterima server"], ["employeeNumber", "NIP"],
    ["employeeName", "Nama"], ["unitName", "Unit"], ["source", "Sumber"], ["eventKind", "Jenis"],
    ["deviceId", "Device ID"], ["sourceReference", "Referensi"],
  ],
  schedule: [
    ["workDate", "Tanggal"], ["employeeNumber", "NIP"], ["employeeName", "Nama"], ["unitName", "Unit"],
    ["scheduledStartAt", "Masuk jadwal"], ["scheduledEndAt", "Pulang jadwal"], ["workLocationName", "Lokasi"],
    ["status", "Status"], ["scheduleVersionId", "Versi jadwal"],
  ],
  overtime: [
    ["workDate", "Tanggal"], ["employeeNumber", "NIP"], ["employeeName", "Nama"], ["unitName", "Unit"],
    ["requestedMinutes", "Diajukan"], ["approvedMinutes", "Disetujui"], ["status", "Status"],
    ["note", "Catatan"], ["decisionNote", "Catatan keputusan"],
  ],
};

async function loadActiveEmployees() {
  const first = await listEmployees({ page: 1, pageSize: 100, status: "active" });
  if (first.pagination.pageCount <= 1) return { items: first.items, units: first.filters.units };
  const rest = await Promise.all(
    Array.from({ length: first.pagination.pageCount - 1 }, (_, index) =>
      listEmployees({ page: index + 2, pageSize: 100, status: "active" }),
    ),
  );
  return { items: [first, ...rest].flatMap((page) => page.items), units: first.filters.units };
}

type Filters = {
  employeeId: string;
  unitId: string;
  scheduleId: string;
  locationId: string;
  source: "" | "adms" | "mobile" | "manual";
  deviceId: string;
  status: string;
};

const emptyFilters: Filters = {
  employeeId: "", unitId: "", scheduleId: "", locationId: "", source: "", deviceId: "", status: "",
};

export function AdminAttendanceReportsV2Page() {
  const today = todayJakarta();
  const [type, setType] = useState<AttendanceReportType>("detail");
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(today);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [employees, setEmployees] = useState<AdminEmployeeListItem[]>([]);
  const [units, setUnits] = useState<Array<{ id: string; name: string }>>([]);
  const [schedules, setSchedules] = useState<Array<{ id: string; name: string }>>([]);
  const [locations, setLocations] = useState<Array<{ id: string; name: string }>>([]);
  const [devices, setDevices] = useState<AdmsDevice[]>([]);
  const [data, setData] = useState<{ summary?: Record<string, number>; items: Array<Record<string, unknown>> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canFinalize, setCanFinalize] = useState(false);

  useEffect(() => {
    void getCurrentSession().then((session) => setCanFinalize(hasPermission(session, "attendance.policy.manage")));
    void Promise.all([
      loadActiveEmployees(),
      listAttendanceSchedules(),
      listAttendanceWorkLocations(),
      listAdmsDevices(),
    ]).then(([employeeResult, scheduleResult, locationResult, deviceResult]) => {
      setEmployees(employeeResult.items);
      setUnits(employeeResult.units);
      setSchedules(scheduleResult.items.filter((item) => item.active).map((item) => ({ id: item.id, name: item.name })));
      setLocations(locationResult.items.filter((item) => item.active).map((item) => ({ id: item.id, name: item.name })));
      setDevices(deviceResult.items);
    }).catch(() => {
      // Report data remains usable even if one option catalog is unavailable.
    });
  }, []);

  const request = useMemo(() => ({
    type,
    from,
    to,
    ...(filters.status && type === "detail" ? { status: filters.status } : {}),
    ...(filters.employeeId ? { employeeId: filters.employeeId } : {}),
    ...(filters.unitId ? { unitId: filters.unitId } : {}),
    ...(filters.scheduleId ? { scheduleId: filters.scheduleId } : {}),
    ...(filters.locationId ? { locationId: filters.locationId } : {}),
    ...(filters.source ? { source: filters.source } : {}),
    ...(filters.deviceId ? { deviceId: filters.deviceId } : {}),
  }), [type, from, to, filters]);

  useEffect(() => {
    setBusy(true);
    void getAttendanceReportV2(request)
      .then((result) => {
        setData({ summary: result.summary, items: result.items });
        setError(null);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Laporan tidak dapat dimuat."))
      .finally(() => setBusy(false));
  }, [request]);

  const visibleColumns = columns[type];
  const scheduleFilters = ["detail", "period", "unit", "sessions", "schedule"].includes(type);
  const evidenceFilters = ["detail", "period", "unit", "sessions", "scans"].includes(type);
  const locationFilter = ["detail", "period", "unit", "sessions", "schedule"].includes(type);

  const changeType = (next: AttendanceReportType) => {
    setType(next);
    setFilters((current) => ({
      ...current,
      status: next === "detail" ? current.status : "",
      scheduleId: ["detail", "period", "unit", "sessions", "schedule"].includes(next) ? current.scheduleId : "",
      locationId: ["detail", "period", "unit", "sessions", "schedule"].includes(next) ? current.locationId : "",
      source: ["detail", "period", "unit", "sessions", "scans"].includes(next) ? current.source : "",
      deviceId: ["detail", "period", "unit", "sessions", "scans"].includes(next) ? current.deviceId : "",
    }));
  };

  const exportCsv = () => {
    if (!data?.items.length) return;
    const encode = (value: unknown) => '"' + String(value ?? "").replaceAll('"', '""') + '"';
    const csv = [
      visibleColumns.map(([, label]) => encode(label)).join(","),
      ...data.items.map((row) => visibleColumns.map(([key]) => encode(renderValue(key, row[key]))).join(",")),
    ].join("\r\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `hcis-kehadiran-${type}-${from}-${to}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const finalize = async () => {
    setBusy(true);
    setError(null);
    try {
      await finalizeAttendanceDate(from);
      const refreshed = await getAttendanceReportV2(request);
      setData({ summary: refreshed.summary, items: refreshed.items });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Finalisasi gagal.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AttendanceWorkforceShell section="reports" title="Laporan Kehadiran" description="Laporan canonical dari result version, sesi, scan, jadwal historis, dan lembur.">
      {error ? <div className="mb-4 flex gap-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"><AlertTriangle className="h-4 w-4" />{error}</div> : null}

      <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label className="text-xs font-semibold text-muted-foreground">Jenis laporan
            <select className="mt-1 h-10 w-full rounded-xl border px-3 text-sm" value={type} onChange={(e) => changeType(e.target.value as AttendanceReportType)}>
              {Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
          <label className="text-xs font-semibold text-muted-foreground">Dari
            <input className="mt-1 h-10 w-full rounded-xl border px-3 text-sm" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="text-xs font-semibold text-muted-foreground">Sampai
            <input className="mt-1 h-10 w-full rounded-xl border px-3 text-sm" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label className="text-xs font-semibold text-muted-foreground">Pegawai
            <select className="mt-1 h-10 w-full rounded-xl border px-3 text-sm" value={filters.employeeId} onChange={(e) => setFilters({ ...filters, employeeId: e.target.value })}>
              <option value="">Semua pegawai</option>
              {employees.map((item) => <option key={item.id} value={item.id}>{item.employeeNumber} · {item.fullName}</option>)}
            </select>
          </label>
          <label className="text-xs font-semibold text-muted-foreground">Unit
            <select className="mt-1 h-10 w-full rounded-xl border px-3 text-sm" value={filters.unitId} onChange={(e) => setFilters({ ...filters, unitId: e.target.value })}>
              <option value="">Semua unit</option>
              {units.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          {type === "detail" ? <label className="text-xs font-semibold text-muted-foreground">Status
            <select className="mt-1 h-10 w-full rounded-xl border px-3 text-sm" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
              <option value="">Semua status</option>
              {["scheduled", "pending", "present", "late", "incomplete", "leave", "absent", "off", "configuration_error"].map((item) => <option key={item} value={item}>{statusLabel(item)}</option>)}
            </select>
          </label> : null}
          {scheduleFilters ? <label className="text-xs font-semibold text-muted-foreground">Jadwal
            <select className="mt-1 h-10 w-full rounded-xl border px-3 text-sm" value={filters.scheduleId} onChange={(e) => setFilters({ ...filters, scheduleId: e.target.value })}>
              <option value="">Semua jadwal</option>
              {schedules.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label> : null}
          {locationFilter ? <label className="text-xs font-semibold text-muted-foreground">Lokasi
            <select className="mt-1 h-10 w-full rounded-xl border px-3 text-sm" value={filters.locationId} onChange={(e) => setFilters({ ...filters, locationId: e.target.value })}>
              <option value="">Semua lokasi</option>
              {locations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label> : null}
          {evidenceFilters ? <label className="text-xs font-semibold text-muted-foreground">Sumber
            <select className="mt-1 h-10 w-full rounded-xl border px-3 text-sm" value={filters.source} onChange={(e) => setFilters({ ...filters, source: e.target.value as Filters["source"] })}>
              <option value="">Semua sumber</option><option value="adms">Fingerprint/ADMS</option><option value="mobile">Mobile</option><option value="manual">Manual</option>
            </select>
          </label> : null}
          {evidenceFilters ? <label className="text-xs font-semibold text-muted-foreground">Mesin
            <select className="mt-1 h-10 w-full rounded-xl border px-3 text-sm" value={filters.deviceId} onChange={(e) => setFilters({ ...filters, deviceId: e.target.value })}>
              <option value="">Semua mesin</option>
              {devices.map((item) => <option key={item.id} value={item.id}>{item.displayName ?? item.serialNumber}</option>)}
            </select>
          </label> : null}
        </div>

        <div className="mt-4 rounded-xl bg-surface p-3 text-xs text-muted-foreground">
          <span className="font-bold text-brand-heading">{labels[type]}.</span> {descriptions[type]}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className="h-10 rounded-xl border px-3 text-xs font-bold" onClick={() => { setFrom(monthStart(today)); setTo(today); }}>Bulan ini</button>
          <button type="button" className="h-10 rounded-xl border px-3 text-xs font-bold" onClick={() => { setFrom(shiftDate(today, -6)); setTo(today); }}>7 hari terakhir</button>
          <button type="button" className="inline-flex h-10 items-center gap-2 rounded-xl border px-3 text-xs font-bold disabled:opacity-50" disabled={!data?.items.length} onClick={exportCsv}><Download className="h-4 w-4" /> Ekspor CSV</button>
          <button type="button" className="inline-flex h-10 items-center gap-2 rounded-xl border px-3 text-xs font-bold disabled:opacity-50" disabled={!data?.items.length} onClick={() => window.print()}><Printer className="h-4 w-4" /> Cetak / PDF</button>
          {canFinalize && from === to ? <button type="button" disabled={busy} className="h-10 rounded-xl bg-brand-primary px-3 text-xs font-bold text-white disabled:opacity-50" onClick={() => void finalize()}>Finalisasi tanggal</button> : null}
        </div>

        {data?.summary ? <div className="mt-4 flex flex-wrap gap-2">{Object.entries(data.summary).map(([key, value]) => <span key={key} className="rounded-full bg-surface px-3 py-1.5 text-xs font-bold">{statusLabel(key)}: {value}</span>)}</div> : null}
      </section>

      <section className="mt-5 overflow-hidden rounded-2xl border border-border/70 bg-white shadow-[var(--shadow-soft)]">
        <header className="border-b p-4"><h2 className="font-bold text-brand-heading">{labels[type]}</h2><p className="mt-1 text-xs text-muted-foreground">{from} → {to} · {data?.items.length ?? 0} baris</p></header>
        {busy ? <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat laporan…</div> :
          <div className="overflow-x-auto"><table className="min-w-[1100px] w-full text-left text-sm"><thead className="bg-surface text-xs text-muted-foreground"><tr>{visibleColumns.map(([key, label]) => <th key={key} className="p-3 whitespace-nowrap">{label}</th>)}</tr></thead><tbody className="divide-y">{(data?.items ?? []).map((row, index) => <tr key={String(row.id ?? row.employeeId ?? index) + ":" + String(row.workDate ?? index)}>{visibleColumns.map(([key]) => <td key={key} className="p-3 whitespace-nowrap">{renderValue(key, row[key])}</td>)}</tr>)}{data && data.items.length === 0 ? <tr><td colSpan={visibleColumns.length} className="p-8 text-center text-muted-foreground">Tidak ada data pada filter ini.</td></tr> : null}</tbody></table></div>}
      </section>
    </AttendanceWorkforceShell>
  );
}
