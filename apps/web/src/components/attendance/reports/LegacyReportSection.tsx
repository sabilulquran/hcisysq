import { AlertTriangle, Download, Loader2, Printer } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ATTENDANCE_STATUSES, attendanceSourceLabel, attendanceStatusLabel, requestStatusLabel, scanEventLabel } from "@/lib/attendanceLabels";
import { listAdmsDevices, type AdmsDevice } from "@/lib/attendance";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import { csvCell } from "@/lib/csv";
import {
  getAttendanceReportV2,
  listAttendanceSchedules,
  listAttendanceWorkLocations,
  type AttendanceReportType,
} from "@/lib/workforceAttendance";

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
const REQUEST_STATUS_VALUES = ["submitted", "approved", "rejected", "cancelled"] as const;

function renderValue(key: string, value: unknown) {
  if (value == null || value === "") return "—";
  if (["workedMinutes", "breakMinutes", "lateMinutes", "earlyLeaveMinutes", "overtimeMinutes", "requestedMinutes", "approvedMinutes"].includes(key)) {
    return formatMinutes(value);
  }
  if (["scheduledStartAt", "scheduledEndAt", "firstCheckInAt", "lastCheckOutAt", "checkInAt", "checkOutAt", "occurredAt", "receivedAt", "createdAt", "decidedAt"].includes(key)) {
    return formatTimestamp(value);
  }
  if (key === "status") return (REQUEST_STATUS_VALUES as readonly unknown[]).includes(value) ? requestStatusLabel(value) : attendanceStatusLabel(value);
  if (key === "source" || key === "sources") return attendanceSourceLabel(value);
  if (key === "eventKind") return scanEventLabel(value);
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
  detail: "Satu baris per pegawai per hari kerja, sesuai hasil perhitungan terakhir.",
  period: "Ringkasan kehadiran per pegawai pada periode terpilih.",
  unit: "Ringkasan operasional per unit kerja.",
  sessions: "Rincian setiap pasangan scan masuk–pulang dalam satu hari.",
  scans: "Semua data scan dari mesin, HP, dan koreksi HC.",
  schedule: "Jadwal yang berlaku per tanggal, termasuk perubahan jadwal per tanggal.",
  overtime: "Permintaan dan durasi lembur yang diajukan atau disetujui.",
};

const columns: Record<AttendanceReportType, Array<[string, string]>> = {
  detail: [
    ["workDate", "Tanggal"], ["employeeNumber", "NIP"], ["employeeName", "Nama"], ["unitName", "Unit"],
    ["status", "Status"], ["scheduledStartAt", "Masuk jadwal"], ["scheduledEndAt", "Pulang jadwal"],
    ["firstCheckInAt", "Masuk aktual"], ["lastCheckOutAt", "Pulang aktual"], ["workedMinutes", "Jam kerja"],
    ["breakMinutes", "Jeda"], ["lateMinutes", "Terlambat"], ["lateJustified", "Telat beralasan"],
    ["earlyLeaveMinutes", "Pulang awal"], ["earlyLeaveJustified", "Pulang awal beralasan"],
    ["overtimeMinutes", "Lembur"], ["sources", "Sumber"],
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
    ["workedMinutes", "Durasi"], ["complete", "Lengkap"],
  ],
  scans: [
    ["occurredAt", "Waktu kejadian"], ["receivedAt", "Diterima server"], ["employeeNumber", "NIP"],
    ["employeeName", "Nama"], ["unitName", "Unit"], ["source", "Sumber"], ["eventKind", "Jenis"],
    ["deviceId", "Mesin"],
  ],
  schedule: [
    ["workDate", "Tanggal"], ["employeeNumber", "NIP"], ["employeeName", "Nama"], ["unitName", "Unit"],
    ["scheduledStartAt", "Masuk jadwal"], ["scheduledEndAt", "Pulang jadwal"], ["workLocationName", "Lokasi"],
    ["status", "Status"],
  ],
  overtime: [
    ["workDate", "Tanggal"], ["employeeNumber", "NIP"], ["employeeName", "Nama"], ["unitName", "Unit"],
    ["requestedMinutes", "Diajukan"], ["approvedMinutes", "Disetujui"], ["status", "Status"],
    ["note", "Catatan"], ["decisionNote", "Catatan keputusan"],
  ],
};

type Filters = {
  scheduleId: string;
  locationId: string;
  source: "" | "adms" | "mobile" | "manual";
  deviceId: string;
  status: string;
};

const emptyFilters: Filters = {
  scheduleId: "", locationId: "", source: "", deviceId: "", status: "",
};

/**
 * ATT-014 §19.1 step ④, interim: the ATT-009 report formats for the scope chosen in step ①, until the
 * new report models and print documents of ATT-014-4R replace them.
 */
export function LegacyReportSection({ from, to, unitId, employeeId }: { from: string; to: string; unitId: string; employeeId: string }) {
  const [type, setType] = useState<AttendanceReportType>("detail");
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [schedules, setSchedules] = useState<Array<{ id: string; name: string }>>([]);
  const [locations, setLocations] = useState<Array<{ id: string; name: string }>>([]);
  const [devices, setDevices] = useState<AdmsDevice[]>([]);
  const [data, setData] = useState<{ summary?: Record<string, number>; items: Array<Record<string, unknown>> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // K-8: load only the filter catalogs this account may read; a missing one hides its filter.
  useEffect(() => {
    void getCurrentSession().then((session) => {
      if (hasPermission(session, "attendance.schedule.manage")) {
        void listAttendanceSchedules()
          .then((result) => setSchedules(result.items.filter((item) => item.active).map((item) => ({ id: item.id, name: item.name }))))
          .catch(() => undefined);
        void listAttendanceWorkLocations()
          .then((result) => setLocations(result.items.filter((item) => item.active).map((item) => ({ id: item.id, name: item.name }))))
          .catch(() => undefined);
      }
      if (hasPermission(session, "attendance.devices.read")) {
        void listAdmsDevices().then((result) => setDevices(result.items)).catch(() => undefined);
      }
    });
  }, []);

  const request = useMemo(() => ({
    type,
    from,
    to,
    ...(filters.status && type === "detail" ? { status: filters.status } : {}),
    ...(employeeId ? { employeeId } : {}),
    ...(unitId ? { unitId } : {}),
    ...(filters.scheduleId ? { scheduleId: filters.scheduleId } : {}),
    ...(filters.locationId ? { locationId: filters.locationId } : {}),
    ...(filters.source ? { source: filters.source } : {}),
    ...(filters.deviceId ? { deviceId: filters.deviceId } : {}),
  }), [type, from, to, unitId, employeeId, filters]);

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

  const deviceNames = useMemo(() => new Map(devices.map((item) => [item.id, item.displayName ?? item.serialNumber])), [devices]);
  // A device is shown by name; without the device catalog the column is left out rather than showing an id.
  const visibleColumns = columns[type].filter(([key]) => key !== "deviceId" || devices.length > 0);
  const cell = (key: string, value: unknown) => key === "deviceId" ? (deviceNames.get(String(value)) ?? "—") : renderValue(key, value);
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
    const csv = [
      visibleColumns.map(([, label]) => csvCell(label)).join(","),
      ...data.items.map((row) => visibleColumns.map(([key]) => csvCell(cell(key, row[key]))).join(",")),
    ].join("\r\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `hcis-kehadiran-${type}-${from}-${to}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      {error ? <div className="mb-4 flex gap-2 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink"><AlertTriangle className="h-4 w-4" />{error}</div> : null}

      <section className="rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label className="text-xs font-semibold text-muted-foreground">Model laporan
            <select className="mt-1 h-10 w-full rounded-xl border px-3 text-sm" value={type} onChange={(e) => changeType(e.target.value as AttendanceReportType)}>
              {Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
          {type === "detail" ? <label className="text-xs font-semibold text-muted-foreground">Status
            <select className="mt-1 h-10 w-full rounded-xl border px-3 text-sm" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
              <option value="">Semua status</option>
              {ATTENDANCE_STATUSES.map((item) => <option key={item} value={item}>{attendanceStatusLabel(item)}</option>)}
            </select>
          </label> : null}
          {scheduleFilters && schedules.length > 0 ? <label className="text-xs font-semibold text-muted-foreground">Shift
            <select className="mt-1 h-10 w-full rounded-xl border px-3 text-sm" value={filters.scheduleId} onChange={(e) => setFilters({ ...filters, scheduleId: e.target.value })}>
              <option value="">Semua shift</option>
              {schedules.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label> : null}
          {locationFilter && locations.length > 0 ? <label className="text-xs font-semibold text-muted-foreground">Lokasi
            <select className="mt-1 h-10 w-full rounded-xl border px-3 text-sm" value={filters.locationId} onChange={(e) => setFilters({ ...filters, locationId: e.target.value })}>
              <option value="">Semua lokasi</option>
              {locations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label> : null}
          {evidenceFilters ? <label className="text-xs font-semibold text-muted-foreground">Sumber
            <select className="mt-1 h-10 w-full rounded-xl border px-3 text-sm" value={filters.source} onChange={(e) => setFilters({ ...filters, source: e.target.value as Filters["source"] })}>
              <option value="">Semua sumber</option><option value="adms">{attendanceSourceLabel("adms")}</option><option value="mobile">{attendanceSourceLabel("mobile")}</option><option value="manual">{attendanceSourceLabel("manual")}</option>
            </select>
          </label> : null}
          {evidenceFilters && devices.length > 0 ? <label className="text-xs font-semibold text-muted-foreground">Mesin
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
          <button type="button" className="inline-flex h-10 items-center gap-2 rounded-xl border px-3 text-xs font-bold disabled:opacity-50" disabled={!data?.items.length} onClick={exportCsv}><Download className="h-4 w-4" /> Ekspor CSV</button>
          <button type="button" className="inline-flex h-10 items-center gap-2 rounded-xl border px-3 text-xs font-bold disabled:opacity-50" disabled={!data?.items.length} onClick={() => window.print()}><Printer className="h-4 w-4" /> Cetak / PDF</button>
        </div>

        {data?.summary ? <div className="mt-4 flex flex-wrap gap-2">{Object.entries(data.summary).map(([key, value]) => <span key={key} className="rounded-full bg-surface px-3 py-1.5 text-xs font-bold">{attendanceStatusLabel(key)}: {value}</span>)}</div> : null}
      </section>

      <section className="mt-5 overflow-hidden rounded-2xl border border-border/70 bg-surface-raised shadow-[var(--shadow-soft)]">
        <header className="border-b p-4"><h2 className="font-bold text-brand-heading">{labels[type]}</h2><p className="mt-1 text-xs text-muted-foreground">{from} → {to} · {data?.items.length ?? 0} baris</p></header>
        {busy ? <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat laporan…</div> :
          <div className="overflow-x-auto"><table className="min-w-[1100px] w-full text-left text-sm"><thead className="bg-surface text-xs text-muted-foreground"><tr>{visibleColumns.map(([key, label]) => <th key={key} className="p-3 whitespace-nowrap">{label}</th>)}</tr></thead><tbody className="divide-y">{(data?.items ?? []).map((row, index) => <tr key={String(row.id ?? row.employeeId ?? index) + ":" + String(row.workDate ?? index)}>{visibleColumns.map(([key]) => <td key={key} className="p-3 whitespace-nowrap">{cell(key, row[key])}</td>)}</tr>)}{data && data.items.length === 0 ? <tr><td colSpan={visibleColumns.length} className="p-8 text-center text-muted-foreground">Tidak ada data pada filter ini.</td></tr> : null}</tbody></table></div>}
      </section>
    </>
  );
}
