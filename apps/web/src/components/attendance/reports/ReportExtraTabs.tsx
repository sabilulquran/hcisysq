import { AlertTriangle, ChevronLeft, ChevronRight, Loader2, Square, X } from "lucide-react";
import { useEffect, useState } from "react";

import { REPORT_TABLE_CSS, ReportTableView } from "@/components/attendance/reports/ReportTableView";
import {
  calculationProgress,
  calculationRunLabel,
  isCalculationActive,
  type AttendanceCalculationRun,
  type AttendanceCalculationScope,
} from "@/lib/attendanceCalculation";
import { getAttendanceExceptions, type AttendanceExceptions } from "@/lib/attendanceExceptions";
import { clarificationKindLabel, clarificationModeLabel, requestStatusLabel } from "@/lib/attendanceLabels";
import { getAttendanceReportModel, reportWarningText, type AttendanceReportTable } from "@/lib/attendanceReports";
import { getAttendanceReportV2 } from "@/lib/workforceAttendance";

// ATT-014 §20.2 (R2b): the read-only tabs Pengecualian, Rekapitulasi and Lembur, and the Kalkulasi
// progress popup. Each tab loads only while it is open and only for the current scope.

function shortDate(value: string) {
  return new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }).format(new Date(`${value.slice(0, 10)}T00:00:00Z`));
}
function scopeKey(scope: AttendanceCalculationScope) {
  return `${scope.from}|${scope.to}|${scope.unitId ?? ""}|${scope.employeeId ?? ""}`;
}
function ErrorNote({ message }: { message: string }) {
  return <p className="m-3 flex gap-2 rounded-xl border border-danger-line bg-danger-soft p-3 text-sm text-danger-ink" role="alert"><AlertTriangle className="h-4 w-4 shrink-0" />{message}</p>;
}

export function ExceptionsTab({ scope, version }: { scope: AttendanceCalculationScope; version: number }) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AttendanceExceptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = scopeKey(scope);

  useEffect(() => { setPage(1); }, [key]);
  useEffect(() => {
    let live = true;
    setError(null);
    void getAttendanceExceptions({ ...scope, page })
      .then((result) => { if (live) setData(result); })
      .catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : "Pengecualian tidak dapat dimuat."); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, page, version]);

  if (error) return <ErrorNote message={error} />;
  if (!data) return <p className="p-4 text-sm text-muted-foreground">Memuat…</p>;
  return (
    <div>
      <p className="p-3 text-xs text-muted-foreground">Cuti yang sudah disetujui, serta klarifikasi dan koreksi HC pada rentang ini. Hanya baca; perubahan dilakukan di <a className="font-semibold underline" href="/admin/attendance/corrections">Perbaikan Absen</a> atau menu Cuti.</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead className="bg-surface text-xs text-muted-foreground">
            <tr><th className="p-3">Tanggal</th><th className="p-3">Pegawai</th><th className="p-3">Unit</th><th className="p-3">Jenis</th><th className="p-3">Status</th><th className="p-3">Alasan</th></tr>
          </thead>
          <tbody className="divide-y">
            {data.items.map((item) => (
              <tr key={`${item.kind}:${item.id}`}>
                <td className="p-3 tabular-nums">{item.startOn === item.endOn ? shortDate(item.startOn) : `${shortDate(item.startOn)} – ${shortDate(item.endOn)}`}</td>
                <td className="p-3"><p className="font-semibold">{item.employeeName}</p><p className="text-xs text-muted-foreground">{item.employeeNumber}</p></td>
                <td className="p-3">{item.unitName ?? "—"}</td>
                <td className="p-3">
                  {item.kind === "leave" ? item.typeName : `${item.origin === "hc" ? "Koreksi HC" : "Klarifikasi"}: ${clarificationKindLabel(item.type)}`}
                  {item.kind === "clarification" ? <p className="text-xs text-muted-foreground">{clarificationModeLabel(item.mode)}</p> : null}
                </td>
                <td className="p-3">{item.kind === "leave" ? "Disetujui" : requestStatusLabel(item.status)}</td>
                <td className="p-3 text-xs">{item.reason ?? "—"}</td>
              </tr>
            ))}
            {data.items.length === 0 ? <tr><td colSpan={6} className="p-8 text-center text-muted-foreground">Tidak ada cuti, klarifikasi, atau koreksi pada lingkup ini.</td></tr> : null}
          </tbody>
        </table>
      </div>
      <footer className="flex items-center justify-between gap-3 border-t p-3 text-xs text-muted-foreground">
        <span>{data.total} baris · halaman {data.page} dari {data.pageCount}</span>
        <div className="flex gap-2">
          <button type="button" aria-label="Halaman sebelumnya" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)} className="rounded-lg border p-1.5 disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button>
          <button type="button" aria-label="Halaman berikutnya" disabled={data.page >= data.pageCount} onClick={() => setPage(data.page + 1)} className="rounded-lg border p-1.5 disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button>
        </div>
      </footer>
    </div>
  );
}

/** Rekapitulasi: the employee_summary model, the same table the report and its export use. */
export function SummaryTab({ scope, version }: { scope: AttendanceCalculationScope; version: number }) {
  const [table, setTable] = useState<AttendanceReportTable | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = scopeKey(scope);

  useEffect(() => {
    let live = true;
    setTable(null);
    setError(null);
    void getAttendanceReportModel(scope, "employee_summary")
      .then((result) => { if (live) setTable(result); })
      .catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : "Rekapitulasi tidak dapat dimuat."); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version]);

  if (error) return <ErrorNote message={error} />;
  if (!table) return <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat rekapitulasi…</p>;
  const warning = reportWarningText(table.warnings);
  return (
    <div className="p-3">
      <style>{REPORT_TABLE_CSS}</style>
      {warning ? <p className="mb-2 text-xs font-semibold text-warning-ink">{warning}</p> : null}
      {table.groups.length === 0 ? <p className="text-sm text-muted-foreground">Tidak ada pegawai pada lingkup ini.</p> : <ReportTableView table={table} />}
    </div>
  );
}

/** Lembur: overtime requests in the range, read-only (ATT-011-6a: no overtime verdict from scans). */
export function OvertimeTab({ scope, version }: { scope: AttendanceCalculationScope; version: number }) {
  const [items, setItems] = useState<Array<Record<string, unknown>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = scopeKey(scope);

  useEffect(() => {
    let live = true;
    setItems(null);
    setError(null);
    void getAttendanceReportV2({ type: "overtime", from: scope.from, to: scope.to, ...(scope.unitId ? { unitId: scope.unitId } : {}), ...(scope.employeeId ? { employeeId: scope.employeeId } : {}) })
      .then((result) => { if (live) setItems(result.items); })
      .catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : "Lembur tidak dapat dimuat."); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version]);

  if (error) return <ErrorNote message={error} />;
  if (!items) return <p className="p-4 text-sm text-muted-foreground">Memuat…</p>;
  const minutes = (value: unknown) => (typeof value === "number" && value > 0 ? `${value} mnt` : "—");
  return (
    <div>
      <p className="p-3 text-xs text-muted-foreground">Pengajuan lembur pada rentang ini. Hanya baca; keputusan lembur ada di menu Lembur.</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="bg-surface text-xs text-muted-foreground">
            <tr><th className="p-3">Tanggal</th><th className="p-3">Pegawai</th><th className="p-3">Unit</th><th className="p-3">Diajukan</th><th className="p-3">Disetujui</th><th className="p-3">Status</th><th className="p-3">Catatan</th></tr>
          </thead>
          <tbody className="divide-y">
            {items.map((item, index) => (
              <tr key={String(item.id ?? index)}>
                <td className="p-3 tabular-nums">{item.workDate ? shortDate(String(item.workDate)) : "—"}</td>
                <td className="p-3"><p className="font-semibold">{String(item.employeeName ?? "—")}</p><p className="text-xs text-muted-foreground">{String(item.employeeNumber ?? "")}</p></td>
                <td className="p-3">{String(item.unitName ?? "—")}</td>
                <td className="p-3 tabular-nums">{minutes(item.requestedMinutes)}</td>
                <td className="p-3 tabular-nums">{minutes(item.approvedMinutes)}</td>
                <td className="p-3">{requestStatusLabel(item.status)}</td>
                <td className="p-3 text-xs">{String(item.note ?? item.decisionNote ?? "—")}</td>
              </tr>
            ))}
            {items.length === 0 ? <tr><td colSpan={7} className="p-8 text-center text-muted-foreground">Tidak ada pengajuan lembur pada lingkup ini.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Kalkulasi progress popup (D-14-17): stays open while the run is active, with Batal. A finished run
 * closes it from the page; a failed or cancelled run stays until the user closes it.
 */
export function CalculationDialog({ run, onCancel, onClose }: {
  run: AttendanceCalculationRun;
  onCancel: () => void;
  onClose: () => void;
}) {
  const active = isCalculationActive(run);
  const progress = calculationProgress(run);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="calculation-dialog-title">
      <div className="w-full max-w-md rounded-2xl border bg-surface-raised p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <h2 id="calculation-dialog-title" className="font-bold text-brand-heading">{active ? "Menghitung…" : calculationRunLabel(run)}</h2>
          {!active ? <button type="button" aria-label="Tutup" onClick={onClose} className="rounded-lg border p-1"><X className="h-4 w-4" /></button> : null}
        </div>
        <p className="mt-2 text-sm tabular-nums" aria-live="polite">
          {progress}% ({run.processedPairs} dari {run.totalPairs} pegawai-hari){run.uncoveredPairs ? ` · ${run.uncoveredPairs} tidak tercatat` : ""}
        </p>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-border/60" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
          <div className="h-full bg-brand-primary transition-all" style={{ width: `${progress}%` }} />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">Laporan dan Ekspor menunggu sampai perhitungan selesai.</p>
        <div className="mt-4 flex justify-end gap-2">
          {active && !run.cancelRequested ? (
            <button type="button" onClick={onCancel} className="inline-flex h-9 items-center gap-1 rounded-xl border px-3 text-xs font-bold text-danger-ink"><Square className="h-3 w-3" /> Batal</button>
          ) : null}
          {active && run.cancelRequested ? <span className="text-xs text-muted-foreground">Membatalkan…</span> : null}
          {!active ? <button type="button" onClick={onClose} className="h-9 rounded-xl border px-3 text-xs font-bold">Tutup</button> : null}
        </div>
      </div>
    </div>
  );
}
