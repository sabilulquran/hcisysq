import { AlertTriangle, Calculator, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Download, FileText, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { AttendanceDayPanel } from "@/components/attendance/AttendanceDayPanel";
import { CorrectionEntryForm } from "@/components/attendance/CorrectionEntryForm";
import { MobileEvidencePanel } from "@/components/attendance/MobileEvidencePanel";
import { CalculationDialog, ExceptionsTab, OvertimeTab, SummaryTab } from "@/components/attendance/reports/ReportExtraTabs";
import { UnscheduledTab } from "@/components/attendance/reports/UnscheduledTab";
import { AttendanceWorkforceShell } from "@/components/attendance/workforce/AttendanceWorkforceShell";
import { EmployeeSearchField, type PickedEmployee } from "@/components/attendance/workforce/EmployeeSearchField";
import { listEmployees } from "@/lib/adminEmployees";
import {
  CALCULATION_RANGE_PRESETS,
  blockSummaryText,
  calculationRange,
  calculationRowStatusLabel,
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
  type AttendanceTransaction,
  type AttendanceTransactionSource,
  type AttendanceTransactions,
} from "@/lib/attendanceCalculation";
import { exportModelForTab } from "@/lib/attendanceExceptions";
import { mobileReviewLabel } from "@/lib/attendanceLabels";
import { REPORT_MODEL_OPTIONS, downloadAttendanceReport, reportPrintHref } from "@/lib/attendanceReports";
import { getAttendanceUnscheduled, type AttendanceUnscheduled } from "@/lib/attendanceUnscheduled";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import type { AuthSession } from "@/types/hcis";

const STATUS_FILTERS: AttendanceCalculationRowStatus[] = [
  "present", "late", "incomplete", "absent", "leave", "off", "unscheduled", "pending", "configuration_error", "not_calculated", "not_captured",
];
const TABS = [
  ["transactions", "Data Transaksi"], ["detail", "Harian"], ["exceptions", "Pengecualian"],
  ["summary", "Rekapitulasi"], ["overtime", "Lembur"], ["unscheduled", "Tanpa Jadwal"],
] as const;
type ReportTab = (typeof TABS)[number][0];

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
 * ATT-014 §20.2 Laporan dan Kalkulasi (R2b, D-14-17): one window, one control bar, one table per tab.
 * Kalkulasi runs on the server behind a progress popup; report models open in their own window
 * (D-14-18). Nothing is calculated automatically; tables read stored results and raw punches only.
 */
export function AdminAttendanceReportsPage() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const canRun = hasPermission(session, "attendance.calculation.run");
  const canPickEmployee = hasPermission(session, "employees.manage");
  const canEnterCorrection = hasPermission(session, "attendance.records.manage");
  const canManageSchedules = hasPermission(session, "attendance.schedule.manage");
  const canMapPins = hasPermission(session, "attendance.devices.operate");
  // Old links (Bukti HP) land here with ?tab=transactions&source=mobile.
  const initialSearch = new URLSearchParams(window.location.search);
  const [range, setRange] = useState(() => calculationRange("this_month"));
  const [unitId, setUnitId] = useState("");
  const [employee, setEmployee] = useState<PickedEmployee | null>(null);
  const [units, setUnits] = useState<Array<{ id: string; name: string }>>([]);
  const [tab, setTab] = useState<ReportTab>(() => TABS.find(([key]) => key === initialSearch.get("tab"))?.[0] ?? "transactions");
  // Bumped after a finished Kalkulasi so the read-only tabs reload too.
  const [version, setVersion] = useState(0);
  const [showRun, setShowRun] = useState(false);
  const [exporting, setExporting] = useState<"csv" | "xlsx" | null>(null);
  // ATT-011-3 §6.2: a Harian row opens the one-day panel.
  const [openDay, setOpenDay] = useState<{ employeeId: string; workDate: string } | null>(null);
  const [unscheduled, setUnscheduled] = useState<AttendanceUnscheduled | null>(null);
  const [unscheduledPage, setUnscheduledPage] = useState(1);
  const [pinPage, setPinPage] = useState(1);
  const [status, setStatus] = useState<AttendanceCalculationRowStatus | "">("");
  const [source, setSource] = useState<AttendanceTransactionSource | "">(
    SOURCE_FILTERS.some((item) => item.value === initialSearch.get("source")) ? initialSearch.get("source") as AttendanceTransactionSource : "",
  );
  const [needsReview, setNeedsReview] = useState(false);
  const [selectedPunch, setSelectedPunch] = useState<AttendanceTransaction | null>(null);
  const [correcting, setCorrecting] = useState(false);
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
        getAttendanceTransactions({ ...scope, ...(source ? { source } : {}), needsReview, page: transactionPage }),
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
  }, [range.from, range.to, unitId, employeeId, status, source, needsReview, changedOnly, detailPage, transactionPage]);

  useEffect(() => { void loadRows(); }, [loadRows]);

  // Tanpa Jadwal aggregates raw scans over the whole range, so it reloads only when the scope or its own
  // pages change, not on the filters of the other tabs.
  const loadUnscheduled = useCallback(async () => {
    try {
      setUnscheduled(await getAttendanceUnscheduled({ ...scope, page: unscheduledPage, pinPage }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Data tanpa jadwal tidak dapat dimuat.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to, unitId, employeeId, unscheduledPage, pinPage]);

  useEffect(() => { void loadUnscheduled(); }, [loadUnscheduled]);

  // Poll the active run every 2 seconds; reload the data when it finishes.
  useEffect(() => {
    if (!run || !isCalculationActive(run)) return;
    const timer = window.setTimeout(() => {
      void getAttendanceCalculation(run.id).then((next) => {
        setRun(next);
        if (!isCalculationActive(next)) {
          void loadRows();
          void loadUnscheduled();
          setVersion((value) => value + 1);
          // A completed run closes the popup; a failed or cancelled one stays until it is read.
          if (next.status === "completed") setShowRun(false);
        }
      }).catch(() => undefined);
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [run, loadRows, loadUnscheduled]);

  const pullData = async () => {
    setRequesting(true);
    setError(null);
    try {
      setRun(await requestAttendanceCalculation(scope));
      setShowRun(true);
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
  const resetPages = () => { setDetailPage(1); setTransactionPage(1); setUnscheduledPage(1); setPinPage(1); setRun(null); setSelectedPunch(null); };
  const changeRange = (next: { from: string; to: string }) => { setRange(next); resetPages(); };
  const active = isCalculationActive(run);
  const pending = rows ? (rows.summary.not_calculated ?? 0) : 0;
  const upToDate = rows !== null && rows.total > 0 && pending === 0 && rows.changedCount === 0;
  const neverPulled = rows !== null && rows.total > 0 && !rows.lastCalculatedAt;
  const exportModel = exportModelForTab(tab);

  const openReport = (model: (typeof REPORT_MODEL_OPTIONS)[number]["value"]) => {
    // One named window per model: clicking again reuses it instead of piling up windows.
    window.open(reportPrintHref(scope, model), `hcis-laporan-${model}`, "width=1100,height=800");
  };

  const exportTab = async (format: "csv" | "xlsx") => {
    if (!exportModel) return;
    setExporting(format);
    setError(null);
    try {
      await downloadAttendanceReport(scope, exportModel, format);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Ekspor gagal.");
    } finally {
      setExporting(null);
    }
  };

  return (
    <AttendanceWorkforceShell tab="reports" title="Laporan dan Kalkulasi" description="Pilih lingkup dan tanggal, jalankan Kalkulasi, tinjau tabelnya, lalu buka laporan.">
      {error ? <div className="mb-4 flex gap-2 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink" role="alert"><AlertTriangle className="h-4 w-4 shrink-0" />{error}</div> : null}
      {openDay ? (
        <AttendanceDayPanel employeeId={openDay.employeeId} workDate={openDay.workDate}
          canDecide={hasPermission(session, "attendance.clarification.manage")} canCorrect={canEnterCorrection}
          onClose={() => setOpenDay(null)} onChanged={() => void loadRows()} />
      ) : null}
      {run && showRun ? <CalculationDialog run={run} onCancel={() => void cancel()} onClose={() => setShowRun(false)} /> : null}

      <section className="rounded-2xl border border-border/70 bg-surface-raised shadow-[var(--shadow-soft)]">
        <div className="grid gap-3 border-b p-3 lg:flex lg:flex-wrap lg:items-end">
          {units.length > 0 ? (
            <label className="text-xs font-semibold text-muted-foreground">Unit
              <select className="mt-1 h-9 w-full rounded-xl border px-3 text-sm lg:w-48" value={unitId} onChange={(event) => { setUnitId(event.target.value); resetPages(); }}>
                <option value="">Semua unit</option>
                {units.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
              </select>
            </label>
          ) : null}
          {canPickEmployee ? <div className="lg:w-56"><EmployeeSearchField label="Pegawai (kosong = semua)" value={employee} onChange={(picked) => { setEmployee(picked); resetPages(); }} /></div> : null}
          <div className="grid grid-cols-2 gap-2 lg:flex">
            <label className="text-xs font-semibold text-muted-foreground">Dari
              <input className="mt-1 h-9 w-full rounded-xl border px-2 text-sm" type="date" max={range.to} value={range.from} onChange={(event) => changeRange({ ...range, from: event.target.value })} />
            </label>
            <label className="text-xs font-semibold text-muted-foreground">Sampai
              <input className="mt-1 h-9 w-full rounded-xl border px-2 text-sm" type="date" min={range.from} max={calculationRange("today").to} value={range.to} onChange={(event) => changeRange({ ...range, to: event.target.value })} />
            </label>
          </div>
          <label className="text-xs font-semibold text-muted-foreground">Rentang cepat
            <select className="mt-1 h-9 w-full rounded-xl border px-3 text-sm lg:w-36" value="" onChange={(event) => { const preset = CALCULATION_RANGE_PRESETS.find((item) => item.key === event.target.value); if (preset) changeRange(calculationRange(preset.key)); }}>
              <option value="">Pilih…</option>
              {CALCULATION_RANGE_PRESETS.map((preset) => <option key={preset.key} value={preset.key}>{preset.label}</option>)}
            </select>
          </label>
          <div className="flex flex-wrap gap-2 lg:ml-auto">
            {canRun ? (
              <button type="button" disabled={requesting || active} onClick={() => void pullData()} className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-brand-primary px-3 text-xs font-bold text-brand-foreground disabled:opacity-50">
                {requesting || active ? <Loader2 className="h-4 w-4 animate-spin" /> : <Calculator className="h-4 w-4" />} Kalkulasi
              </button>
            ) : null}
            <details className="relative">
              <summary className={`inline-flex h-9 cursor-pointer list-none items-center gap-1.5 rounded-xl border px-3 text-xs font-bold ${active ? "pointer-events-none opacity-50" : ""}`} aria-disabled={active}>
                <FileText className="h-4 w-4" /> Laporan <ChevronDown className="h-3.5 w-3.5" />
              </summary>
              <div className="absolute right-0 z-20 mt-1 w-72 rounded-xl border bg-surface-raised p-1 shadow-lg">
                {REPORT_MODEL_OPTIONS.map((option) => (
                  <button key={option.value} type="button" disabled={active} onClick={(event) => { (event.currentTarget.closest("details") as HTMLDetailsElement).open = false; openReport(option.value); }}
                    className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-surface disabled:opacity-50">
                    <span className="font-semibold">{option.label}</span>
                    <span className="block text-xs text-muted-foreground">{option.hint}</span>
                  </button>
                ))}
              </div>
            </details>
            <details className="relative">
              <summary className={`inline-flex h-9 cursor-pointer list-none items-center gap-1.5 rounded-xl border px-3 text-xs font-bold ${active || !exportModel ? "pointer-events-none opacity-50" : ""}`}
                aria-disabled={active || !exportModel} title={exportModel ? undefined : "Ekspor tab ini belum tersedia; buka Laporan untuk mencetak."}>
                {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Ekspor <ChevronDown className="h-3.5 w-3.5" />
              </summary>
              <div className="absolute right-0 z-20 mt-1 w-40 rounded-xl border bg-surface-raised p-1 shadow-lg">
                {(["xlsx", "csv"] as const).map((format) => (
                  <button key={format} type="button" disabled={exporting !== null} onClick={(event) => { (event.currentTarget.closest("details") as HTMLDetailsElement).open = false; void exportTab(format); }}
                    className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-surface disabled:opacity-50">{format === "xlsx" ? "Excel" : "CSV"}</button>
                ))}
              </div>
            </details>
          </div>
        </div>

        <p className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs" aria-live="polite">
          {!rows ? <span className="text-muted-foreground">Memuat…</span>
            : upToDate ? <span className="inline-flex items-center gap-1 text-success-ink"><CheckCircle2 className="h-4 w-4" />Dihitung {rows.lastCalculatedAt ? dateTime(rows.lastCalculatedAt) : ""} · data terbaru.</span>
            : neverPulled ? <span className="text-muted-foreground">Lingkup ini belum dihitung.{canRun ? " Tekan Kalkulasi." : " Minta HC yang berwenang menjalankan Kalkulasi."}</span>
            : (
              <span className="text-warning-ink">
                {rows.lastCalculatedAt ? `Dihitung ${dateTime(rows.lastCalculatedAt)} · ` : ""}
                {[pending ? `${pending} pegawai-hari belum dihitung` : null, rows.changedCount ? `${rows.changedCount} baris berubah sejak dihitung` : null].filter(Boolean).join(" · ")}
              </span>
            )}
          {run && !showRun && isCalculationActive(run) ? <button type="button" onClick={() => setShowRun(true)} className="font-semibold underline">Lihat progres</button> : null}
        </p>

        <div className="overflow-hidden">
          <nav className="flex gap-1 overflow-x-auto border-b bg-surface px-3 pt-2" role="tablist" aria-label="Tabel laporan">
            {TABS.map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
                className={`shrink-0 rounded-t-lg px-3 py-2 text-xs font-bold ${tab === key ? "bg-surface-raised text-brand-heading" : "text-muted-foreground"}`}>
                {label}{key === "unscheduled" && unscheduled ? ` (${unscheduled.employees.total})` : ""}
              </button>
            ))}
          </nav>

          {tab === "transactions" ? (
            <div role="tabpanel">
              <div className="flex flex-wrap items-center gap-3 p-3">
                <select aria-label="Filter sumber" className="h-9 rounded-xl border px-3 text-sm" value={source} onChange={(event) => { setSource(event.target.value as AttendanceTransactionSource | ""); setTransactionPage(1); setSelectedPunch(null); }}>
                  <option value="">Semua sumber</option>
                  {SOURCE_FILTERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
                {(transactions?.needsReviewTotal ?? 0) > 0 || needsReview ? (
                  <button type="button" aria-pressed={needsReview} onClick={() => { setNeedsReview(!needsReview); setTransactionPage(1); setSelectedPunch(null); }}
                    className={`h-9 rounded-xl border px-3 text-xs font-bold ${needsReview ? "border-warning-line bg-warning-soft text-warning-ink" : "text-warning-ink"}`}>
                    Perlu ditinjau ({transactions?.needsReviewTotal ?? 0})
                  </button>
                ) : null}
                <p className="text-xs text-muted-foreground">Satu baris = satu absen. "Dipakai" berarti jam itu dipakai pada hasil terakhir. Pilih baris untuk detailnya.</p>
              </div>
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full min-w-[860px] text-left text-sm">
                  <thead className="bg-surface text-xs text-muted-foreground">
                    <tr><th className="p-3">Waktu</th><th className="p-3">Pegawai</th><th className="p-3">Unit</th><th className="p-3">Tanggal</th><th className="p-3">Sumber</th><th className="p-3">Dipakai</th></tr>
                  </thead>
                  <tbody className="divide-y">
                    {transactions?.items.map((item) => (
                      <tr key={`${item.source}:${item.id}:${item.boundary ?? ""}`} onClick={() => { setSelectedPunch(item); setCorrecting(false); }}
                        className={`cursor-pointer hover:bg-surface ${selectedPunch?.id === item.id && selectedPunch.boundary === item.boundary ? "bg-brand-primary-pale" : ""}`}>
                        <td className="p-3 tabular-nums">{time(item.occurredAt)}{item.boundary ? <span className="ml-1 text-xs text-muted-foreground">({item.boundary === "check_in" ? "masuk" : "pulang"})</span> : null}</td>
                        <td className="p-3"><p className="font-semibold">{item.employeeName}</p><p className="text-xs text-muted-foreground">{item.employeeNumber}</p></td>
                        <td className="p-3">{item.unitName ?? "—"}</td>
                        <td className="p-3 tabular-nums">{shortDate(item.workDate)}</td>
                        <td className="p-3">
                          <span className="rounded-full bg-surface px-2 py-0.5 text-xs font-semibold">{transactionSourceLabel(item)}</span>
                          {item.reviewState === "needs_review" ? <span className="ml-1 rounded-full bg-warning-soft px-2 py-0.5 text-xs font-semibold text-warning-ink">{mobileReviewLabel(item.reviewState)}</span> : null}
                        </td>
                        <td className="p-3">{item.usedInResult ? "Ya" : "Belum"}</td>
                      </tr>
                    ))}
                    {transactions && transactions.items.length === 0 ? <tr><td colSpan={6} className="p-8 text-center text-muted-foreground">Tidak ada absen pada lingkup ini.</td></tr> : null}
                  </tbody>
                </table>
              </div>
              <ul className="divide-y md:hidden">
                {transactions?.items.map((item) => (
                  <li key={`${item.source}:${item.id}:${item.boundary ?? ""}`} className="cursor-pointer p-4" onClick={() => { setSelectedPunch(item); setCorrecting(false); }}>
                    <div className="flex items-start justify-between gap-3">
                      <div><p className="font-semibold">{item.employeeName}</p><p className="text-xs text-muted-foreground">{shortDate(item.workDate)} · {time(item.occurredAt)}</p></div>
                      <span className="rounded-full bg-surface px-2.5 py-1 text-xs font-bold">{transactionSourceLabel(item)}</span>
                    </div>
                    {item.reviewState === "needs_review" ? <p className="mt-1 text-xs font-semibold text-warning-ink">{mobileReviewLabel(item.reviewState)}</p> : null}
                  </li>
                ))}
                {transactions && transactions.items.length === 0 ? <li className="p-8 text-center text-sm text-muted-foreground">Tidak ada absen pada lingkup ini.</li> : null}
              </ul>
              {transactions ? <Pager page={transactions.page} totalPages={transactions.totalPages} total={transactions.total} loading={loading} onPage={(next) => { setTransactionPage(next); setSelectedPunch(null); }} /> : null}
              {selectedPunch ? (
                <div className="border-t bg-surface/50 p-4 text-sm" aria-label="Detail absen">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-bold text-brand-heading">{selectedPunch.employeeName} · {time(selectedPunch.occurredAt)}</p>
                      <p className="text-xs text-muted-foreground">{shortDate(selectedPunch.workDate)} · {transactionSourceLabel(selectedPunch)} · {selectedPunch.usedInResult ? "dipakai pada hasil terakhir" : "belum dipakai pada hasil"}</p>
                    </div>
                    <button type="button" onClick={() => setSelectedPunch(null)} className="rounded-lg border px-2 py-1 text-xs">Tutup</button>
                  </div>
                  {selectedPunch.reviewState === "needs_review" ? <p className="mt-2 text-xs font-semibold text-warning-ink">Perlu ditinjau: absen HP di luar lokasi kerja atau dengan GPS kurang akurat. Absen tetap tersimpan; perbaikan dilakukan lewat koreksi beralasan.</p> : null}
                  {selectedPunch.evidence ? <div className="mt-3 max-w-md"><MobileEvidencePanel evidence={selectedPunch.evidence} /></div> : null}
                  {canEnterCorrection ? (
                    correcting ? (
                      <div className="mt-3 max-w-xl rounded-xl border bg-surface-raised p-3">
                        <CorrectionEntryForm
                          employee={{ id: selectedPunch.employeeId, fullName: selectedPunch.employeeName, employeeNumber: selectedPunch.employeeNumber }}
                          initialDate={selectedPunch.workDate}
                          onSaved={() => void loadRows()}
                          onCancel={() => setCorrecting(false)}
                        />
                      </div>
                    ) : (
                      <button type="button" onClick={() => setCorrecting(true)} className="mt-3 h-9 rounded-xl border px-3 text-xs font-bold">Buat koreksi</button>
                    )
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : tab === "detail" ? (
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
                      <tr key={`${item.employeeId}:${item.workDate}`} onClick={() => setOpenDay({ employeeId: item.employeeId, workDate: item.workDate })} className="cursor-pointer hover:bg-surface">
                        <td className="p-3"><p className="font-semibold">{item.employeeName ?? "—"}</p><p className="text-xs text-muted-foreground">{item.employeeNumber ?? ""}</p></td>
                        <td className="p-3">{item.unitName ?? "—"}</td>
                        <td className="p-3 tabular-nums">{shortDate(item.workDate)}</td>
                        <td className="p-3 tabular-nums">{item.scheduledStartAt ? `${time(item.scheduledStartAt)}–${time(item.scheduledEndAt)}` : "—"}</td>
                        <td className="p-3 tabular-nums">{item.firstCheckInAt || item.lastCheckOutAt ? `${time(item.firstCheckInAt)} → ${time(item.lastCheckOutAt)}` : "—"}{item.blocks ? <p className="text-[11px] text-muted-foreground">{blockSummaryText(item.blocks)}</p> : null}</td>
                        <td className="p-3">
                          <p className="font-semibold">{calculationRowStatusLabel(item.status)}</p>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {item.provisional ? <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">Hari berjalan</span> : null}
                            {item.changedSinceCalculated ? <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-semibold text-warning-ink">Berubah sejak ditarik</span> : null}
                          </div>
                        </td>
                        <td className="p-3 tabular-nums">{minutes(item.lateMinutes)}</td>
                        <td className="p-3 tabular-nums">{minutes(item.earlyLeaveMinutes)}</td>
                        <td className="p-3 tabular-nums">{item.normal === null ? "—" : item.blocks ? `${item.actual ?? "—"} dari ${item.normal}` : `${item.normal}/${item.actual ?? "—"}`}</td>
                      </tr>
                    ))}
                    {rows && rows.items.length === 0 ? <tr><td colSpan={9} className="p-8 text-center text-muted-foreground">Tidak ada baris yang cocok dengan filter.</td></tr> : null}
                  </tbody>
                </table>
              </div>
              <ul className="divide-y md:hidden">
                {rows?.items.map((item) => (
                  <li key={`${item.employeeId}:${item.workDate}`} className="cursor-pointer p-4" onClick={() => setOpenDay({ employeeId: item.employeeId, workDate: item.workDate })}>
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
          ) : tab === "exceptions" ? (
            <div role="tabpanel"><ExceptionsTab scope={scope} version={version} /></div>
          ) : tab === "summary" ? (
            <div role="tabpanel"><SummaryTab scope={scope} version={version} /></div>
          ) : tab === "overtime" ? (
            <div role="tabpanel"><OvertimeTab scope={scope} version={version} /></div>
          ) : (
            <div role="tabpanel">
              <UnscheduledTab data={unscheduled} scope={scope} loading={loading} canManageSchedules={canManageSchedules} canMapPins={canMapPins}
                onPage={setUnscheduledPage} onPinPage={setPinPage} onChanged={() => { void loadRows(); void loadUnscheduled(); }} />
            </div>
          )}
        </div>
      </section>
    </AttendanceWorkforceShell>
  );
}
