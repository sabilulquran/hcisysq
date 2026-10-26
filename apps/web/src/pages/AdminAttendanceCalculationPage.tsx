import { AlertTriangle, ChevronLeft, ChevronRight, Loader2, Play, RefreshCw, Square } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { AttendanceWorkforceShell } from "@/components/attendance/workforce/AttendanceWorkforceShell";
import { listEmployees } from "@/lib/adminEmployees";
import {
  CALCULATION_RANGE_PRESETS,
  calculationProgress,
  calculationRange,
  calculationRowStatusLabel,
  calculationRunLabel,
  cancelAttendanceCalculation,
  getAttendanceCalculation,
  getAttendanceCalculationRows,
  isCalculationActive,
  requestAttendanceCalculation,
  type AttendanceCalculationRowStatus,
  type AttendanceCalculationRows,
  type AttendanceCalculationRun,
} from "@/lib/attendanceCalculation";
import { hasPermission } from "@/lib/authorization";
import { getCurrentSession } from "@/lib/auth";
import type { AuthSession } from "@/types/hcis";

const STATUS_FILTERS: AttendanceCalculationRowStatus[] = [
  "present", "late", "incomplete", "absent", "leave", "off", "pending", "configuration_error", "not_calculated", "not_captured",
];

function time(value: string | null) {
  return value ? new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Jakarta" }).format(new Date(value)) : "—";
}
function dateTime(value: string) {
  return new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Jakarta" }).format(new Date(value));
}
function shortDate(value: string) {
  return new Intl.DateTimeFormat("id-ID", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Jakarta" }).format(new Date(`${value}T12:00:00+07:00`));
}
function minutes(value: number | null) {
  return value ? `${value} mnt` : "—";
}

/**
 * ATT-014-2 Kalkulasi. HC picks a unit and a date range and presses Kalkulasi; the server calculates
 * every covered employee-day with the attendance engine. The table reads stored results only. Six
 * tabs, column tools and reports follow in ATT-014-3/4.
 */
export function AdminAttendanceCalculationPage() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const canRun = hasPermission(session, "attendance.calculation.run");
  const [range, setRange] = useState(() => calculationRange("this_month"));
  const [unitId, setUnitId] = useState("");
  const [units, setUnits] = useState<Array<{ id: string; name: string }>>([]);
  const [status, setStatus] = useState<AttendanceCalculationRowStatus | "">("");
  const [changedOnly, setChangedOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<AttendanceCalculationRows | null>(null);
  const [run, setRun] = useState<AttendanceCalculationRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [requesting, setRequesting] = useState(false);

  const scope = { from: range.from, to: range.to, ...(unitId ? { unitId } : {}) };

  useEffect(() => {
    void getCurrentSession().then(setSession).catch(() => setSession(null));
    void listEmployees({ pageSize: 1, status: "active" }).then((result) => setUnits(result.filters.units)).catch(() => undefined);
  }, []);

  const loadRows = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await getAttendanceCalculationRows({ ...scope, ...(status ? { status } : {}), changedOnly, page }));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Data kalkulasi tidak dapat dimuat.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to, unitId, status, changedOnly, page]);

  useEffect(() => { void loadRows(); }, [loadRows]);

  // Poll the active run every 2 seconds; reload the table when it finishes.
  useEffect(() => {
    if (!run || !isCalculationActive(run)) return;
    const timer = window.setTimeout(() => {
      void getAttendanceCalculation(run.id).then((next) => {
        setRun(next);
        if (!isCalculationActive(next)) void loadRows();
      }).catch(() => undefined);
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [run, loadRows]);

  const startCalculation = async () => {
    setRequesting(true);
    setError(null);
    try {
      setRun(await requestAttendanceCalculation(scope));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Kalkulasi tidak dapat dimulai.");
    } finally {
      setRequesting(false);
    }
  };

  const cancel = async () => {
    if (!run) return;
    try {
      setRun(await cancelAttendanceCalculation(run.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Kalkulasi tidak dapat dibatalkan.");
    }
  };

  const changeRange = (next: { from: string; to: string }) => { setRange(next); setPage(1); };
  const active = isCalculationActive(run);
  const empty = rows && rows.total > 0 && Object.keys(rows.summary).every((key) => key === "not_calculated" || key === "not_captured");

  return (
    <AttendanceWorkforceShell tab="calculation" title="Kalkulasi" description="Pilih unit dan rentang tanggal, lalu tekan Kalkulasi. Status resmi (hadir, terlambat, tidak hadir) dihitung dari scan, jadwal, klarifikasi, dan cuti yang sudah final.">
      {error ? <div className="mb-4 flex gap-2 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink" role="alert"><AlertTriangle className="h-4 w-4 shrink-0" />{error}</div> : null}

      <section className="mb-4 rounded-2xl border border-border/70 bg-surface-raised p-4 shadow-[var(--shadow-soft)]">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-end">
          <label className="text-xs font-semibold text-muted-foreground">Unit
            <select className="mt-1 h-10 w-full rounded-xl border px-3 text-sm" value={unitId} onChange={(event) => { setUnitId(event.target.value); setPage(1); }}>
              <option value="">Semua unit</option>
              {units.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
            </select>
          </label>
          <label className="text-xs font-semibold text-muted-foreground">Dari
            <input className="mt-1 h-10 w-full rounded-xl border px-3 text-sm" type="date" max={range.to} value={range.from} onChange={(event) => changeRange({ ...range, from: event.target.value })} />
          </label>
          <label className="text-xs font-semibold text-muted-foreground">Sampai
            <input className="mt-1 h-10 w-full rounded-xl border px-3 text-sm" type="date" min={range.from} max={calculationRange("today").to} value={range.to} onChange={(event) => changeRange({ ...range, to: event.target.value })} />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {CALCULATION_RANGE_PRESETS.map((preset) => (
            <button key={preset.key} type="button" onClick={() => changeRange(calculationRange(preset.key))} className="rounded-full border px-3 py-1 text-xs font-semibold text-muted-foreground hover:bg-surface">
              {preset.label}
            </button>
          ))}
        </div>
        {canRun ? (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="button" disabled={requesting || active} onClick={() => void startCalculation()} className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-4 text-xs font-bold text-brand-foreground disabled:opacity-50">
              {requesting || active ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Kalkulasi
            </button>
            <p className="text-xs text-muted-foreground">Maksimal 93 hari per kalkulasi. Hari ini dihitung sebagai hasil sementara.</p>
          </div>
        ) : null}
        {run ? (
          <div className="mt-4 rounded-xl border bg-surface p-3" aria-live="polite">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="font-semibold">{calculationRunLabel(run)}</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {run.processedPairs}/{run.totalPairs} pegawai-hari{run.uncoveredPairs ? ` · ${run.uncoveredPairs} tidak tercatat` : ""}
              </span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-border/60" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={calculationProgress(run)}>
              <div className="h-full bg-brand-primary transition-all" style={{ width: `${calculationProgress(run)}%` }} />
            </div>
            {active && !run.cancelRequested ? (
              <button type="button" onClick={() => void cancel()} className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-danger-ink"><Square className="h-3 w-3" /> Batalkan</button>
            ) : null}
          </div>
        ) : null}
      </section>

      {rows && rows.changedCount > 0 ? (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-warning-line bg-warning-soft p-4 text-sm text-warning-ink">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{rows.changedCount} baris berubah sejak dikalkulasi (scan baru atau jadwal berubah).</span>
          {canRun ? <button type="button" disabled={active} onClick={() => void startCalculation()} className="inline-flex items-center gap-1 font-bold underline disabled:opacity-50"><RefreshCw className="h-3 w-3" /> Kalkulasi ulang</button> : null}
        </div>
      ) : null}

      <section className="overflow-hidden rounded-2xl border border-border/70 bg-surface-raised shadow-[var(--shadow-soft)]">
        <header className="flex flex-col gap-3 border-b p-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="font-bold text-brand-heading">Detail Harian</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {rows?.lastCalculatedAt ? `Dihitung terakhir ${dateTime(rows.lastCalculatedAt)}.` : "Belum dikalkulasi untuk rentang ini."}
              {" "}Tanggal sebelum pegawai terhubung ke mesin tampil "Tidak tercatat", bukan Tidak hadir.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <select aria-label="Filter status" className="h-10 rounded-xl border px-3 text-sm" value={status} onChange={(event) => { setStatus(event.target.value as AttendanceCalculationRowStatus | ""); setPage(1); }}>
              <option value="">Semua status</option>
              {STATUS_FILTERS.map((key) => <option key={key} value={key}>{calculationRowStatusLabel(key)}{rows?.summary[key] ? ` (${rows.summary[key]})` : ""}</option>)}
            </select>
            <label className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
              <input type="checkbox" checked={changedOnly} onChange={(event) => { setChangedOnly(event.target.checked); setPage(1); }} /> Berubah sejak dikalkulasi
            </label>
          </div>
        </header>

        {empty ? <p className="border-b bg-surface p-4 text-sm text-muted-foreground">Belum dikalkulasi untuk rentang ini.{canRun ? " Tekan Kalkulasi untuk menghitung." : ""}</p> : null}

        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[1000px] text-left text-sm">
            <thead className="bg-surface text-xs text-muted-foreground">
              <tr>
                <th className="p-3">Pegawai</th><th className="p-3">Unit</th><th className="p-3">Tanggal</th><th className="p-3">Jadwal</th>
                <th className="p-3">Scan masuk/pulang</th><th className="p-3">Status</th><th className="p-3">Terlambat</th><th className="p-3">Pulang cepat</th>
                <th className="p-3">Normal/Riil</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows?.items.map((item) => (
                <tr key={`${item.employeeId}:${item.workDate}`}>
                  <td className="p-3"><p className="font-semibold">{item.employeeName ?? "—"}</p><p className="text-xs text-muted-foreground">{item.employeeNumber ?? ""}</p></td>
                  <td className="p-3">{item.unitName ?? "—"}</td>
                  <td className="p-3 tabular-nums">{shortDate(item.workDate)}</td>
                  <td className="p-3 tabular-nums">{item.scheduledStartAt ? `${time(item.scheduledStartAt)}–${time(item.scheduledEndAt)}` : "—"}</td>
                  <td className="p-3 tabular-nums">{item.firstCheckInAt || item.lastCheckOutAt ? `${time(item.firstCheckInAt)} → ${time(item.lastCheckOutAt)}` : "—"}</td>
                  <td className="p-3">
                    <p className="font-semibold">{calculationRowStatusLabel(item.status)}</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {item.provisional ? <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">Hari berjalan</span> : null}
                      {item.changedSinceCalculated ? <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-semibold text-warning-ink">Berubah sejak dikalkulasi</span> : null}
                    </div>
                  </td>
                  <td className="p-3 tabular-nums">{minutes(item.lateMinutes)}</td>
                  <td className="p-3 tabular-nums">{minutes(item.earlyLeaveMinutes)}</td>
                  <td className="p-3 tabular-nums">{item.normal === null ? "—" : `${item.normal}/${item.actual ?? "—"}`}</td>
                </tr>
              ))}
              {rows && rows.items.length === 0 ? <tr><td colSpan={9} className="p-8 text-center text-muted-foreground">Tidak ada baris yang cocok dengan filter.</td></tr> : null}
            </tbody>
          </table>
        </div>

        <ul className="divide-y md:hidden">
          {rows?.items.map((item) => (
            <li key={`${item.employeeId}:${item.workDate}`} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div><p className="font-semibold">{item.employeeName ?? "—"}</p><p className="text-xs text-muted-foreground">{shortDate(item.workDate)} · {item.unitName ?? "—"}</p></div>
                <span className="rounded-full bg-surface px-2.5 py-1 text-right text-xs font-bold">{calculationRowStatusLabel(item.status)}</span>
              </div>
              <p className="mt-2 text-sm tabular-nums">{item.firstCheckInAt || item.lastCheckOutAt ? `${time(item.firstCheckInAt)} → ${time(item.lastCheckOutAt)}` : "Tanpa scan"}</p>
              {item.provisional || item.changedSinceCalculated ? (
                <p className="mt-1 text-xs text-muted-foreground">{[item.provisional ? "Hari berjalan" : null, item.changedSinceCalculated ? "Berubah sejak dikalkulasi" : null].filter(Boolean).join(" · ")}</p>
              ) : null}
            </li>
          ))}
          {rows && rows.items.length === 0 ? <li className="p-8 text-center text-sm text-muted-foreground">Tidak ada baris yang cocok dengan filter.</li> : null}
        </ul>

        {rows ? (
          <footer className="flex items-center justify-between gap-3 border-t p-3 text-xs text-muted-foreground">
            <span>{loading ? "Memuat…" : `${rows.total} baris · halaman ${rows.page} dari ${rows.totalPages}`}</span>
            <div className="flex gap-2">
              <button type="button" aria-label="Halaman sebelumnya" disabled={rows.page <= 1} onClick={() => setPage(rows.page - 1)} className="rounded-lg border p-1.5 disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button>
              <button type="button" aria-label="Halaman berikutnya" disabled={rows.page >= rows.totalPages} onClick={() => setPage(rows.page + 1)} className="rounded-lg border p-1.5 disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button>
            </div>
          </footer>
        ) : null}
      </section>
    </AttendanceWorkforceShell>
  );
}
