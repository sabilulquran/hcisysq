import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, DownloadCloud, Loader2, RefreshCw, Square } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { LegacyReportSection } from "@/components/attendance/reports/LegacyReportSection";
import { ReportModelSection } from "@/components/attendance/reports/ReportModelSection";
import { AttendanceWorkforceShell } from "@/components/attendance/workforce/AttendanceWorkforceShell";
import { EmployeeSearchField, type PickedEmployee } from "@/components/attendance/workforce/EmployeeSearchField";
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
  getAttendanceTransactions,
  isCalculationActive,
  requestAttendanceCalculation,
  transactionSourceLabel,
  type AttendanceCalculationRowStatus,
  type AttendanceCalculationRows,
  type AttendanceCalculationRun,
  type AttendanceTransactionSource,
  type AttendanceTransactions,
} from "@/lib/attendanceCalculation";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import type { AuthSession } from "@/types/hcis";

const STATUS_FILTERS: AttendanceCalculationRowStatus[] = [
  "present", "late", "incomplete", "absent", "leave", "off", "pending", "configuration_error", "not_calculated", "not_captured",
];
const SOURCE_FILTERS: Array<{ value: AttendanceTransactionSource; label: string }> = [
  { value: "adms", label: "Mesin" }, { value: "mobile", label: "HP" }, { value: "correction", label: "Koreksi" }, { value: "manual", label: "Koreksi HC (lama)" },
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

function Step({ number, title, hint, children }: { number: string; title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="mb-4 rounded-2xl border border-border/70 bg-surface-raised p-4 shadow-[var(--shadow-soft)]">
      <header className="mb-3 flex items-baseline gap-2">
        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-primary-pale text-xs font-bold text-brand-primary-deep">{number}</span>
        <div>
          <h2 className="font-bold text-brand-heading">{title}</h2>
          {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
        </div>
      </header>
      {children}
    </section>
  );
}

function Pager({ page, totalPages, total, loading, onPage }: { page: number; totalPages: number; total: number; loading: boolean; onPage: (page: number) => void }) {
  return (
    <footer className="flex items-center justify-between gap-3 border-t p-3 text-xs text-muted-foreground">
      <span>{loading ? "Memuat…" : `${total} baris · halaman ${page} dari ${totalPages}`}</span>
      <div className="flex gap-2">
        <button type="button" aria-label="Halaman sebelumnya" disabled={page <= 1} onClick={() => onPage(page - 1)} className="rounded-lg border p-1.5 disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button>
        <button type="button" aria-label="Halaman berikutnya" disabled={page >= totalPages} onClick={() => onPage(page + 1)} className="rounded-lg border p-1.5 disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button>
      </div>
    </footer>
  );
}

/**
 * ATT-014 §19.1 Laporan: one flow on one screen. ① choose the scope, ② Tarik data (a Kalkulasi run on
 * the server), ③ review the half-raw data, ④ pick a report model. Nothing is calculated
 * automatically; tables read stored results and raw punches only.
 */
export function AdminAttendanceReportsPage() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const canRun = hasPermission(session, "attendance.calculation.run");
  const canPickEmployee = hasPermission(session, "employees.manage");
  const [range, setRange] = useState(() => calculationRange("this_month"));
  const [unitId, setUnitId] = useState("");
  const [employee, setEmployee] = useState<PickedEmployee | null>(null);
  const [units, setUnits] = useState<Array<{ id: string; name: string }>>([]);
  const [tab, setTab] = useState<"transactions" | "detail">("transactions");
  const [status, setStatus] = useState<AttendanceCalculationRowStatus | "">("");
  const [source, setSource] = useState<AttendanceTransactionSource | "">("");
  const [changedOnly, setChangedOnly] = useState(false);
  const [detailPage, setDetailPage] = useState(1);
  const [transactionPage, setTransactionPage] = useState(1);
  const [rows, setRows] = useState<AttendanceCalculationRows | null>(null);
  const [transactions, setTransactions] = useState<AttendanceTransactions | null>(null);
  const [run, setRun] = useState<AttendanceCalculationRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [requesting, setRequesting] = useState(false);

  const employeeId = employee?.id ?? "";
  const scope = { from: range.from, to: range.to, ...(unitId ? { unitId } : {}), ...(employeeId ? { employeeId } : {}) };

  useEffect(() => {
    void getCurrentSession().then((value) => {
      setSession(value);
      // K-8: the unit list comes from the employee catalog; without it the unit filter is hidden.
      if (hasPermission(value, "employees.manage")) {
        void listEmployees({ pageSize: 1, status: "active" }).then((result) => setUnits(result.filters.units)).catch(() => undefined);
      }
    }).catch(() => setSession(null));
  }, []);

  const loadRows = useCallback(async () => {
    setLoading(true);
    try {
      const [detail, punches] = await Promise.all([
        getAttendanceCalculationRows({ ...scope, ...(status ? { status } : {}), changedOnly, page: detailPage }),
        getAttendanceTransactions({ ...scope, ...(source ? { source } : {}), page: transactionPage }),
      ]);
      setRows(detail);
      setTransactions(punches);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Data tidak dapat dimuat.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to, unitId, employeeId, status, source, changedOnly, detailPage, transactionPage]);

  useEffect(() => { void loadRows(); }, [loadRows]);

  // Poll the active run every 2 seconds; reload the data when it finishes.
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

  const pullData = async () => {
    setRequesting(true);
    setError(null);
    try {
      setRun(await requestAttendanceCalculation(scope));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Data tidak dapat ditarik.");
    } finally {
      setRequesting(false);
    }
  };

  const cancel = async () => {
    if (!run) return;
    try {
      setRun(await cancelAttendanceCalculation(run.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Penarikan data tidak dapat dibatalkan.");
    }
  };

  // Changing the scope clears the previous run and starts both tables from page 1.
  const resetPages = () => { setDetailPage(1); setTransactionPage(1); setRun(null); };
  const changeRange = (next: { from: string; to: string }) => { setRange(next); resetPages(); };
  const active = isCalculationActive(run);
  const pending = rows ? (rows.summary.not_calculated ?? 0) : 0;
  const upToDate = rows !== null && rows.total > 0 && pending === 0 && rows.changedCount === 0;
  const neverPulled = rows !== null && rows.total > 0 && !rows.lastCalculatedAt;

  return (
    <AttendanceWorkforceShell tab="reports" title="Laporan" description="Atur lingkup dan tanggal, tarik data, tinjau data mentahnya, lalu pilih model laporan.">
      {error ? <div className="mb-4 flex gap-2 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink" role="alert"><AlertTriangle className="h-4 w-4 shrink-0" />{error}</div> : null}

      <Step number="1" title="Lingkup" hint="Unit, pegawai, dan rentang tanggal (maksimal 93 hari).">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4 xl:items-end">
          {units.length > 0 ? (
            <label className="text-xs font-semibold text-muted-foreground">Unit
              <select className="mt-1 h-10 w-full rounded-xl border px-3 text-sm" value={unitId} onChange={(event) => { setUnitId(event.target.value); resetPages(); }}>
                <option value="">Semua unit</option>
                {units.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
              </select>
            </label>
          ) : null}
          {canPickEmployee ? <EmployeeSearchField label="Pegawai (kosong = semua)" value={employee} onChange={(picked) => { setEmployee(picked); resetPages(); }} /> : null}
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
      </Step>

      <Step number="2" title="Tarik data" hint="Menghitung kehadiran dari scan, jadwal, klarifikasi, dan cuti yang sudah final. Hari ini dihitung sebagai hasil sementara.">
        <div className="flex flex-wrap items-center gap-3 text-sm" aria-live="polite">
          {canRun ? (
            <button
              type="button"
              disabled={requesting || active}
              onClick={() => void pullData()}
              className={upToDate
                ? "inline-flex h-10 items-center gap-2 rounded-xl border px-4 text-xs font-bold disabled:opacity-50"
                : "inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-4 text-xs font-bold text-brand-foreground disabled:opacity-50"}
            >
              {requesting || active ? <Loader2 className="h-4 w-4 animate-spin" /> : upToDate ? <RefreshCw className="h-4 w-4" /> : <DownloadCloud className="h-4 w-4" />}
              {upToDate ? "Tarik ulang" : "Tarik data"}
            </button>
          ) : null}
          {rows ? (
            upToDate ? (
              <span className="inline-flex items-center gap-1 text-success-ink"><CheckCircle2 className="h-4 w-4" />Data sudah terbaru{rows.lastCalculatedAt ? ` (ditarik ${dateTime(rows.lastCalculatedAt)})` : ""}.</span>
            ) : neverPulled ? (
              <span className="text-muted-foreground">Data untuk lingkup ini belum ditarik.{canRun ? "" : " Minta HC yang berwenang untuk menarik data."}</span>
            ) : (
              <span className="text-warning-ink">
                {rows.lastCalculatedAt ? `Ditarik ${dateTime(rows.lastCalculatedAt)}. ` : ""}
                {[pending ? `${pending} pegawai-hari belum ditarik` : null, rows.changedCount ? `${rows.changedCount} berubah sejak ditarik` : null].filter(Boolean).join(", ")}.
              </span>
            )
          ) : null}
        </div>
        {run ? (
          <div className="mt-3 rounded-xl border bg-surface p-3">
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
      </Step>

      <Step number="3" title="Data mentah" hint="Belum berbentuk laporan. Data scan asli tidak pernah diubah di sini.">
        <div className="-mx-4 overflow-hidden border-y border-border/70">
          <nav className="flex gap-1 border-b bg-surface px-3 pt-2" role="tablist" aria-label="Data mentah">
            {([["transactions", "Data Transaksi"], ["detail", "Detail Harian"]] as const).map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
                className={`rounded-t-lg px-3 py-2 text-xs font-bold ${tab === key ? "bg-surface-raised text-brand-heading" : "text-muted-foreground"}`}>
                {label}
              </button>
            ))}
          </nav>

          {tab === "transactions" ? (
            <div role="tabpanel">
              <div className="flex flex-wrap items-center gap-3 p-3">
                <select aria-label="Filter sumber" className="h-9 rounded-xl border px-3 text-sm" value={source} onChange={(event) => { setSource(event.target.value as AttendanceTransactionSource | ""); setTransactionPage(1); }}>
                  <option value="">Semua sumber</option>
                  {SOURCE_FILTERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
                <p className="text-xs text-muted-foreground">Satu baris = satu absen. "Dipakai" berarti jam itu dipakai pada hasil terakhir.</p>
              </div>
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full min-w-[860px] text-left text-sm">
                  <thead className="bg-surface text-xs text-muted-foreground">
                    <tr><th className="p-3">Waktu</th><th className="p-3">Pegawai</th><th className="p-3">Unit</th><th className="p-3">Tanggal</th><th className="p-3">Sumber</th><th className="p-3">Dipakai</th></tr>
                  </thead>
                  <tbody className="divide-y">
                    {transactions?.items.map((item) => (
                      <tr key={`${item.source}:${item.id}:${item.boundary ?? ""}`}>
                        <td className="p-3 tabular-nums">{time(item.occurredAt)}{item.boundary ? <span className="ml-1 text-xs text-muted-foreground">({item.boundary === "check_in" ? "masuk" : "pulang"})</span> : null}</td>
                        <td className="p-3"><p className="font-semibold">{item.employeeName}</p><p className="text-xs text-muted-foreground">{item.employeeNumber}</p></td>
                        <td className="p-3">{item.unitName ?? "—"}</td>
                        <td className="p-3 tabular-nums">{shortDate(item.workDate)}</td>
                        <td className="p-3"><span className="rounded-full bg-surface px-2 py-0.5 text-xs font-semibold">{transactionSourceLabel(item)}</span></td>
                        <td className="p-3">{item.usedInResult ? "Ya" : "Belum"}</td>
                      </tr>
                    ))}
                    {transactions && transactions.items.length === 0 ? <tr><td colSpan={6} className="p-8 text-center text-muted-foreground">Tidak ada absen pada lingkup ini.</td></tr> : null}
                  </tbody>
                </table>
              </div>
              <ul className="divide-y md:hidden">
                {transactions?.items.map((item) => (
                  <li key={`${item.source}:${item.id}:${item.boundary ?? ""}`} className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div><p className="font-semibold">{item.employeeName}</p><p className="text-xs text-muted-foreground">{shortDate(item.workDate)} · {time(item.occurredAt)}</p></div>
                      <span className="rounded-full bg-surface px-2.5 py-1 text-xs font-bold">{transactionSourceLabel(item)}</span>
                    </div>
                  </li>
                ))}
                {transactions && transactions.items.length === 0 ? <li className="p-8 text-center text-sm text-muted-foreground">Tidak ada absen pada lingkup ini.</li> : null}
              </ul>
              {transactions ? <Pager page={transactions.page} totalPages={transactions.totalPages} total={transactions.total} loading={loading} onPage={setTransactionPage} /> : null}
            </div>
          ) : (
            <div role="tabpanel">
              <div className="flex flex-wrap items-center gap-3 p-3">
                <select aria-label="Filter status" className="h-9 rounded-xl border px-3 text-sm" value={status} onChange={(event) => { setStatus(event.target.value as AttendanceCalculationRowStatus | ""); setDetailPage(1); }}>
                  <option value="">Semua status</option>
                  {STATUS_FILTERS.map((key) => <option key={key} value={key}>{calculationRowStatusLabel(key)}{rows?.summary[key] ? ` (${rows.summary[key]})` : ""}</option>)}
                </select>
                <label className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                  <input type="checkbox" checked={changedOnly} onChange={(event) => { setChangedOnly(event.target.checked); setDetailPage(1); }} /> Berubah sejak ditarik
                </label>
                <p className="text-xs text-muted-foreground">Tanggal sebelum pegawai terhubung ke mesin tampil "Tidak tercatat", bukan Tidak hadir.</p>
              </div>
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
                            {item.changedSinceCalculated ? <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-semibold text-warning-ink">Berubah sejak ditarik</span> : null}
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
                  </li>
                ))}
                {rows && rows.items.length === 0 ? <li className="p-8 text-center text-sm text-muted-foreground">Tidak ada baris yang cocok dengan filter.</li> : null}
              </ul>
              {rows ? <Pager page={rows.page} totalPages={rows.totalPages} total={rows.total} loading={loading} onPage={setDetailPage} /> : null}
            </div>
          )}
        </div>
      </Step>

      <Step number="4" title="Laporan" hint="Pilih model laporan untuk lingkup di atas, tampilkan, lalu cetak atau ekspor.">
        {pending || (rows?.changedCount ?? 0) > 0 ? (
          <p className="mb-3 rounded-xl border border-warning-line bg-warning-soft p-3 text-xs text-warning-ink">Sebagian data belum ditarik atau berubah sejak ditarik. Tarik data dulu agar laporan memakai hasil terbaru.</p>
        ) : null}
        <ReportModelSection scope={scope} />
        <details className="mt-6 border-t pt-4">
          <summary className="cursor-pointer text-xs font-semibold text-muted-foreground">Format lama (sesi kerja, data scan, jadwal, lembur)</summary>
          <p className="mt-2 text-xs text-muted-foreground">Format ATT-009 untuk satu rilis lagi, sampai model baru menggantikannya.</p>
          <div className="mt-3"><LegacyReportSection from={range.from} to={range.to} unitId={unitId} employeeId={employeeId} /></div>
        </details>
      </Step>
    </AttendanceWorkforceShell>
  );
}
