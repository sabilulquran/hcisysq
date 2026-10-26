import { useEffect, useState } from "react";

import { ReportTableView } from "@/components/attendance/reports/ReportTableView";
import { getAttendanceReportModel, parseReportPrintSearch, reportWarningText, type AttendanceReportTable } from "@/lib/attendanceReports";
import { REPORT_LETTERHEAD } from "@/lib/reportLetterhead";
import { printCss } from "@/lib/reportPrintCss";

/** ATT-014 §19.2 print document, opened in a new tab from Laporan. */
export function AdminAttendanceReportPrintPage() {
  const [table, setTable] = useState<AttendanceReportTable | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = parseReportPrintSearch(window.location.search);

  useEffect(() => {
    if (!request) {
      setError("Alamat dokumen cetak tidak lengkap. Buka lagi dari halaman Laporan.");
      return;
    }
    void getAttendanceReportModel(request.scope, request.model, "print")
      .then((result) => {
        setTable(result);
        document.title = `${result.title} · ${result.from} s/d ${result.to}`;
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Laporan tidak dapat dibuat."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Offer the browser print dialog once the document has rendered.
  useEffect(() => {
    if (!table) return;
    const timer = window.setTimeout(() => window.print(), 300);
    return () => window.clearTimeout(timer);
  }, [table]);

  if (error) return <main className="p-8 text-sm text-danger-ink" role="alert">{error}</main>;
  if (!table) return <main className="p-8 text-sm text-muted-foreground">Menyiapkan dokumen cetak…</main>;

  const warning = reportWarningText(table.warnings);
  return (
    <main className="report-sheet">
      <style>{printCss(table.orientation)}</style>
      <div className="report-screen-only mb-4 flex items-center justify-between gap-3 rounded-xl border bg-surface p-3 text-sm">
        <span>Dokumen cetak. Gunakan dialog cetak peramban; pilih "Simpan sebagai PDF" untuk berkas PDF.</span>
        <button type="button" onClick={() => window.print()} className="rounded-lg bg-brand-primary px-3 py-1.5 text-xs font-bold text-brand-foreground">Cetak</button>
      </div>
      <header className="report-letterhead mb-3 flex items-center gap-3 border-b-2 border-gray-700 pb-2">
        <img src={REPORT_LETTERHEAD.logoSrc} alt="" className="h-12 w-12 object-contain" />
        <div>
          <p className="text-base font-extrabold leading-tight">{REPORT_LETTERHEAD.organizationName}</p>
          <p className="text-xs text-gray-600">{REPORT_LETTERHEAD.subtitle}</p>
        </div>
      </header>
      <section className="mb-3">
        <h1 className="text-lg font-bold">{table.title}</h1>
        <p className="text-xs">{table.header.scope} · {table.header.period}</p>
        <p className="text-xs text-gray-600">Dicetak oleh {table.header.printedBy} pada {table.header.printedAt} WIB</p>
        {warning ? <p className="mt-1 text-xs font-semibold">{warning}</p> : null}
      </section>
      <ReportTableView table={table} print />
      {REPORT_LETTERHEAD.signature ? (
        <footer className="mt-10 flex justify-end text-xs">
          <div className="text-center">
            <p>{REPORT_LETTERHEAD.signature.label}</p>
            <p className="mt-16 border-t border-gray-700 pt-1">{REPORT_LETTERHEAD.signature.role}</p>
          </div>
        </footer>
      ) : null}
    </main>
  );
}
