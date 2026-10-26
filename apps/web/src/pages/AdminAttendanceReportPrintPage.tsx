import { useEffect, useState } from "react";

import { ReportTableView } from "@/components/attendance/reports/ReportTableView";
import { getAttendanceReportModel, parseReportPrintSearch, reportWarningText, type AttendanceReportTable } from "@/lib/attendanceReports";
import { REPORT_LETTERHEAD } from "@/lib/reportLetterhead";
import { printCss } from "@/lib/reportPrintCss";

/** The sheet itself, separate from data loading so it can be rendered and tested on its own. */
export function ReportPrintSheet({ table }: { table: AttendanceReportTable }) {
  const warning = reportWarningText(table.warnings);
  const signature = REPORT_LETTERHEAD.signature;
  return (
    <article className="report-sheet">
      <style>{printCss(table.orientation, REPORT_LETTERHEAD.footer)}</style>
      <header className="kop">
        <img src={REPORT_LETTERHEAD.logoSrc} alt={`Lambang ${REPORT_LETTERHEAD.organizationName}`} />
        <div>
          <div className="nama">{REPORT_LETTERHEAD.organizationName}</div>
          <div className="alamat">{REPORT_LETTERHEAD.addressLine}</div>
        </div>
      </header>
      <div className="judul">
        <h1>{table.printTitle}</h1>
        <div className="sub">{table.header.period}</div>
      </div>
      <dl className="identitas">
        <div><dt>Unit</dt><dd>{table.header.unit}</dd></div>
        <div><dt>Jumlah pegawai</dt><dd>{table.header.employeeCount} orang</dd></div>
        <div><dt>Penyaring</dt><dd>{table.header.filter}</dd></div>
        <div><dt>Hari kerja</dt><dd>{table.header.workDays} hari</dd></div>
      </dl>
      <div className="meta-hitung">
        <span>Data dihitung: <b>{table.header.calculatedAt}</b></span>
        <span>Dicetak: <b>{table.header.printedAt}</b></span>
        <span>Dicetak oleh: <b>{table.header.printedBy}</b></span>
      </div>
      {warning ? <p className="peringatan">{warning}</p> : null}
      <ReportTableView table={table} print />
      {signature ? (
        <div className="ttd">
          <div className="blok">
            {signature.place}<br />{signature.label}
            <div className="garis" />
            <div>{signature.name}</div>
            <div className="jabatan">{signature.role}</div>
          </div>
        </div>
      ) : null}
    </article>
  );
}

/**
 * ATT-014 §19.2 print document, opened in a new tab from Laporan: only the sheet, no admin shell, menu
 * or filters. The browser print dialog opens once the sheet has rendered.
 */
export function AdminAttendanceReportPrintPage() {
  const [table, setTable] = useState<AttendanceReportTable | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const request = parseReportPrintSearch(window.location.search);
    if (!request) {
      setError("Alamat dokumen cetak tidak lengkap. Buka lagi dari halaman Laporan.");
      return;
    }
    void getAttendanceReportModel(request.scope, request.model, "print")
      .then((result) => {
        setTable(result);
        document.title = `${result.printTitle} · ${result.from} s/d ${result.to}`;
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Laporan tidak dapat dibuat."));
  }, []);

  useEffect(() => {
    if (!table) return;
    const timer = window.setTimeout(() => window.print(), 300);
    return () => window.clearTimeout(timer);
  }, [table]);

  if (error) return <main className="p-8 text-sm text-danger-ink" role="alert">{error}</main>;
  if (!table) return <main className="p-8 text-sm text-muted-foreground">Menyiapkan dokumen cetak…</main>;

  return (
    <main className="bg-white">
      <div className="report-screen-only mx-auto my-4 flex max-w-3xl flex-wrap items-center justify-between gap-3 rounded-xl border bg-surface p-3 text-sm">
        <span>Dokumen cetak. Pilih "Simpan sebagai PDF" di dialog cetak untuk berkas PDF. Nomor halaman tampil di Chrome dan Edge.</span>
        <button type="button" onClick={() => window.print()} className="rounded-lg bg-brand-primary px-3 py-1.5 text-xs font-bold text-brand-foreground">Cetak</button>
      </div>
      <ReportPrintSheet table={table} />
    </main>
  );
}
