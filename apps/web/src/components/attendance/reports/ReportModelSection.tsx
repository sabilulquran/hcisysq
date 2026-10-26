import { AlertTriangle, Download, Eye, Loader2, Printer } from "lucide-react";
import { useEffect, useState } from "react";

import { REPORT_TABLE_CSS, ReportTableView } from "@/components/attendance/reports/ReportTableView";
import type { AttendanceCalculationScope } from "@/lib/attendanceCalculation";
import {
  REPORT_MODEL_OPTIONS,
  downloadAttendanceReport,
  getAttendanceReportModel,
  reportPrintHref,
  reportWarningText,
  type AttendanceReportModel,
  type AttendanceReportTable,
} from "@/lib/attendanceReports";

/**
 * ATT-014 §19.1 step ④: pick a report model, show it, then print or export. The table comes from the
 * server built on stored results; printing opens the standalone document of §19.2 in a new tab.
 */
export function ReportModelSection({ scope }: { scope: AttendanceCalculationScope }) {
  const [model, setModel] = useState<AttendanceReportModel>("daily_grid");
  const [table, setTable] = useState<AttendanceReportTable | null>(null);
  const [busy, setBusy] = useState<"view" | "csv" | "xlsx" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scopeKey = `${scope.from}|${scope.to}|${scope.unitId ?? ""}|${scope.employeeId ?? ""}`;

  // A preview always belongs to the current scope and model.
  useEffect(() => { setTable(null); }, [scopeKey, model]);

  const show = async () => {
    setBusy("view");
    setError(null);
    try {
      setTable(await getAttendanceReportModel(scope, model));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Laporan tidak dapat dibuat.");
    } finally {
      setBusy(null);
    }
  };

  const download = async (format: "csv" | "xlsx") => {
    setBusy(format);
    setError(null);
    try {
      await downloadAttendanceReport(scope, model, format);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Ekspor gagal.");
    } finally {
      setBusy(null);
    }
  };

  const option = REPORT_MODEL_OPTIONS.find((item) => item.value === model)!;
  const warning = table ? reportWarningText(table.warnings) : null;

  return (
    <div>
      <style>{REPORT_TABLE_CSS}</style>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
        <label className="text-xs font-semibold text-muted-foreground">Model laporan
          <select className="mt-1 h-10 w-full rounded-xl border px-3 text-sm" value={model} onChange={(event) => setModel(event.target.value as AttendanceReportModel)}>
            {REPORT_MODEL_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy !== null} onClick={() => void show()} className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-4 text-xs font-bold text-brand-foreground disabled:opacity-50">
            {busy === "view" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />} Tampilkan
          </button>
          <a href={reportPrintHref(scope, model)} target="_blank" rel="noopener" className="inline-flex h-10 items-center gap-2 rounded-xl border px-3 text-xs font-bold">
            <Printer className="h-4 w-4" /> Cetak
          </a>
          <button type="button" disabled={busy !== null} onClick={() => void download("xlsx")} className="inline-flex h-10 items-center gap-2 rounded-xl border px-3 text-xs font-bold disabled:opacity-50">
            {busy === "xlsx" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Excel
          </button>
          <button type="button" disabled={busy !== null} onClick={() => void download("csv")} className="inline-flex h-10 items-center gap-2 rounded-xl border px-3 text-xs font-bold disabled:opacity-50">
            {busy === "csv" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} CSV
          </button>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{option.hint} Setiap cetak dan ekspor tercatat di audit.</p>
      {error ? <div className="mt-3 flex gap-2 rounded-xl border border-danger-line bg-danger-soft p-3 text-sm text-danger-ink" role="alert"><AlertTriangle className="h-4 w-4 shrink-0" />{error}</div> : null}
      {table ? (
        <div className="mt-4">
          <h3 className="text-sm font-bold text-brand-heading">{table.title}</h3>
          <p className="text-xs text-muted-foreground">{table.header.scope} · {table.header.period}</p>
          {warning ? <p className="mt-1 text-xs font-semibold text-warning-ink">{warning}</p> : null}
          <div className="mt-3">
            {table.groups.length === 0
              ? <p className="text-sm text-muted-foreground">Tidak ada pegawai pada lingkup ini.</p>
              : <ReportTableView table={table} />}
          </div>
        </div>
      ) : null}
    </div>
  );
}
