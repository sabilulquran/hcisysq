// ORG-011 Package 4: audited CSV import of the job classification and grade catalogs.
// The server owns every rule; this panel only sends the file twice (check, then apply) and shows
// the report. Nothing is written until the operator applies a file whose check had no errors.

import { useRef, useState } from "react";

import { AdminApiError } from "@/lib/adminEmployees";
import {
  importJobCatalog,
  importOutcomeLabels,
  type CatalogImportReport,
  type CatalogKind,
} from "@/lib/jobClassifications";

export const IMPORT_TEMPLATES: Record<CatalogKind, string> = {
  CLASSIFICATION: "code,name,family,grade_code,effective_from\r\n",
  GRADE: "code,name,rank_order,effective_from\r\n",
};

export function templateHref(kind: CatalogKind): string {
  return `data:text/csv;charset=utf-8,${encodeURIComponent(IMPORT_TEMPLATES[kind])}`;
}

/** Applying is allowed only for the exact text that passed a clean check. */
export function canApply(checked: { csv: string; report: CatalogImportReport } | null, csv: string | null): boolean {
  return checked !== null && csv !== null && checked.csv === csv
    && checked.report.dryRun && checked.report.summary.error === 0
    && checked.report.summary.create + checked.report.summary.amend > 0;
}

export function JobCatalogImportPanel({ kind, onApplied }: { kind: CatalogKind; onApplied: () => void }) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [checked, setChecked] = useState<{ csv: string; report: CatalogImportReport } | null>(null);
  const [report, setReport] = useState<CatalogImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noun = kind === "CLASSIFICATION" ? "klasifikasi" : "golongan";
  // A later pick wins even when an earlier file finishes reading last, so the audited file name
  // always belongs to the text that is sent.
  const pick = useRef(0);

  async function choose(input: HTMLInputElement) {
    const file = input.files?.[0];
    const ticket = ++pick.current;
    setChecked(null);
    setReport(null);
    setError(null);
    if (!file) { setCsv(null); setFileName(null); return; }
    const text = await file.text();
    // Cleared so choosing the same file again after fixing it on disk fires a new change event.
    input.value = "";
    if (ticket !== pick.current) return;
    setFileName(file.name);
    setCsv(text);
  }

  async function send(dryRun: boolean) {
    if (!csv || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await importJobCatalog({ kind, csv, dryRun, fileName });
      setReport(result);
      if (dryRun) setChecked({ csv, report: result });
      // After any real attempt the earlier check no longer stands: a refused file must be checked
      // again (the catalog may have moved), and an applied one must not be sent twice.
      if (!dryRun) setChecked(null);
      if (!dryRun && result.applied) onApplied();
    } catch (cause) {
      setError(cause instanceof AdminApiError ? cause.message : "Impor gagal diproses.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3 rounded-lg border p-4" aria-label={`Impor ${noun}`}>
      <h2 className="text-sm font-bold text-brand-heading">Impor {noun} dari CSV</h2>
      <p className="text-xs text-muted-foreground">
        Kode baru dibuat, kode yang sudah ada mendapat versi baru mulai <span className="font-mono">effective_from</span>,
        dan baris yang sama persis dilewati. Penutupan kode tetap lewat tombol Tutup. Satu baris salah membatalkan
        seluruh berkas, dan setiap perubahan tercatat di riwayat.{" "}
        <a href={templateHref(kind)} download={`templat-${noun}.csv`} className="font-bold text-brand-primary">Unduh templat</a>
      </p>
      {fileName ? <p className="text-xs text-muted-foreground">Berkas: {fileName}</p> : null}
      <input
        type="file"
        accept=".csv,text/csv"
        aria-label={`Berkas CSV ${noun}`}
        onChange={(event) => void choose(event.target)}
        className="block text-sm"
      />
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!csv || busy} onClick={() => void send(true)}
          className="rounded-md border px-4 py-2 text-sm font-bold disabled:opacity-50">
          {busy ? "Memeriksa…" : "Periksa berkas"}
        </button>
        <button type="button" disabled={!canApply(checked, csv) || busy} onClick={() => void send(false)}
          className="rounded-md bg-brand px-4 py-2 text-sm font-bold text-brand-ink disabled:opacity-50">
          Terapkan impor
        </button>
      </div>
      {error ? <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink">{error}</p> : null}
      {report ? <ImportReportView report={report} /> : null}
    </section>
  );
}

export function ImportReportView({ report }: { report: CatalogImportReport }) {
  const { summary } = report;
  const headline = report.applied
    ? "Impor diterapkan."
    : report.dryRun
      ? summary.error > 0 ? "Pemeriksaan menemukan baris yang ditolak. Perbaiki berkas lalu periksa lagi." : "Pemeriksaan bersih. Belum ada yang disimpan."
      : "Impor tidak diterapkan karena ada baris yang ditolak. Tidak ada yang disimpan.";
  return (
    <div role="status" className="space-y-2">
      <p className="text-sm font-semibold">{headline}</p>
      <p className="text-xs text-muted-foreground">
        {summary.rows} baris: {summary.create} kode baru, {summary.amend} versi baru, {summary.unchanged} tidak berubah, {summary.error} ditolak.
      </p>
      {/* One file is at most 1.000 rows; the whole report is shown, scrolled, never cut. */}
      <div className="max-h-72 overflow-auto rounded-md border">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-surface text-muted-foreground">
            <tr><th className="px-2 py-1">Baris</th><th className="px-2 py-1">Kode</th><th className="px-2 py-1">Hasil</th><th className="px-2 py-1">Keterangan</th></tr>
          </thead>
          <tbody>
            {report.rows.map((row) => (
              <tr key={row.line} className={`border-t ${row.outcome === "ERROR" ? "text-danger-ink" : ""}`}>
                <td className="px-2 py-1">{row.line}</td>
                <td className="px-2 py-1 font-mono">{row.code ?? "—"}</td>
                <td className="px-2 py-1">{importOutcomeLabels[row.outcome]}</td>
                <td className="px-2 py-1">{row.message ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
