import { AlertTriangle, Download, Loader2 } from "lucide-react";
import { useState } from "react";

import {
  formatPph21Rate,
  formatRupiah,
  getPayrollPph21Report,
  payrollPph21CsvUrl,
  payrollPph21FlagLabel,
  payrollPph21Refusal,
  type PayrollPph21Report,
} from "@/lib/payroll";

export type Pph21PanelState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "refused"; tone: "info" | "error"; note: string }
  | { kind: "ready"; report: PayrollPph21Report };

/**
 * PAY-003 Laporan PPh21 (TER) on the period screen. Like the transfer list it is
 * opened deliberately rather than fetched with the page: it names every paid
 * person with their gross, and each read is recorded as sensitive access. Every
 * figure, rate and flag is the server's; the panel only lays them out.
 */
export function Pph21ReportPanel({ periodId }: { periodId: string }) {
  const [state, setState] = useState<Pph21PanelState>({ kind: "idle" });

  async function open() {
    setState({ kind: "loading" });
    try {
      const { report } = await getPayrollPph21Report(periodId);
      setState({ kind: "ready", report });
    } catch (cause) {
      setState({ kind: "refused", ...payrollPph21Refusal(cause) });
    }
  }

  return <Pph21ReportView periodId={periodId} state={state} onOpen={() => void open()} />;
}

export function Pph21ReportView({
  periodId,
  state,
  onOpen,
}: {
  periodId: string;
  state: Pph21PanelState;
  onOpen: () => void;
}) {
  const report = state.kind === "ready" ? state.report : null;
  return (
    <section className="min-w-0 rounded-lg border bg-card" aria-labelledby="pph21-heading">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 id="pph21-heading" className="text-sm font-semibold">Laporan PPh21 (TER)</h2>
          <p className="text-xs text-muted-foreground">
            {report
              ? `Masa pajak ${report.taxPeriod} · kode objek ${report.objectCode} · ${report.totals.employeeCount} pegawai dilaporkan.`
              : "Dari hasil final periode yang sudah disahkan; setiap pembukaan dicatat sebagai akses sensitif."}
          </p>
        </div>
        <span className="flex flex-wrap gap-2">
          {state.kind === "idle" || state.kind === "loading" || state.kind === "refused" ? (
            <button
              type="button"
              onClick={onOpen}
              disabled={state.kind === "loading"}
              aria-busy={state.kind === "loading"}
              className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm disabled:opacity-50"
            >
              {state.kind === "loading" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {state.kind === "refused" ? "Coba lagi" : "Buka laporan PPh21"}
            </button>
          ) : null}
          {report && report.rows.length > 0 ? (
            <a
              href={payrollPph21CsvUrl(periodId)}
              className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm"
            >
              <Download className="h-4 w-4" aria-hidden />
              Unduh CSV
            </a>
          ) : null}
        </span>
      </header>

      {state.kind === "loading" ? (
        <p role="status" className="px-4 py-3 text-sm text-muted-foreground">Memuat laporan PPh21…</p>
      ) : null}

      {state.kind === "refused" ? (
        state.tone === "error" ? (
          <div role="alert" className="m-4 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <p>{state.note}</p>
          </div>
        ) : (
          <p className="m-4 rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">{state.note}</p>
        )
      ) : null}

      {report ? <Pph21ReportBody report={report} /> : null}
    </section>
  );
}

function Pph21ReportBody({ report }: { report: PayrollPph21Report }) {
  const { totals } = report;
  return (
    <div className="space-y-3 p-4">
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Pegawai dilaporkan</dt>
          <dd className="font-medium">{totals.employeeCount}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Penghasilan bruto</dt>
          <dd className="font-medium">{formatRupiah(totals.gross)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">PPh21 (TER)</dt>
          <dd className="font-medium">{formatRupiah(totals.tax)}</dd>
        </div>
      </dl>

      {totals.ptkpMissingCount > 0 ||
      totals.annualCalculationCount > 0 ||
      totals.nonPermanentCount > 0 ||
      totals.excludedCount > 0 ||
      totals.skippedBlockedCount > 0 ? (
        <ul className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-800 dark:text-amber-300">
          {totals.ptkpMissingCount > 0 ? (
            <li>{totals.ptkpMissingCount} pegawai tanpa satu status PTKP terpetakan; PPh21 mereka belum masuk total.</li>
          ) : null}
          {totals.annualCalculationCount > 0 ? (
            <li>
              {totals.annualCalculationCount} pegawai berada di masa pajak terakhir; PPh21 finalnya memakai perhitungan
              tahunan Pasal 17 yang belum ada di HCIS, jadi angka TER-nya bukan angka final.
            </li>
          ) : null}
          {totals.nonPermanentCount > 0 ? (
            <li>
              {totals.nonPermanentCount} pegawai kontrak honorer/lepas dilaporkan dengan TER bulanan 21-100-01; aturan
              pegawai tidak tetap masih menunggu konfirmasi pemilik proses.
            </li>
          ) : null}
          {totals.excludedCount > 0 ? (
            <li>{totals.excludedCount} pegawai dikecualikan dari pelaporan menurut profil kompensasinya.</li>
          ) : null}
          {totals.skippedBlockedCount > 0 ? (
            <li>{totals.skippedBlockedCount} hasil masih memiliki blocker dan tidak dilaporkan.</li>
          ) : null}
        </ul>
      ) : null}

      {report.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Periode ini tidak memiliki hasil yang dibayar untuk dilaporkan.</p>
      ) : (
        <div className="-mx-4 overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <caption className="sr-only">PPh21 TER per pegawai, masa pajak {report.taxPeriod}</caption>
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-2">Pegawai</th>
                <th scope="col" className="px-4 py-2">PTKP / TER</th>
                <th scope="col" className="px-4 py-2 text-right">Bruto</th>
                <th scope="col" className="px-4 py-2 text-right">Tarif</th>
                <th scope="col" className="px-4 py-2 text-right">PPh21</th>
                <th scope="col" className="px-4 py-2">Catatan</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {report.rows.map((row) => (
                <tr key={row.employeeId}>
                  <td className="px-4 py-2">
                    {row.fullName}
                    <span className="block font-mono text-xs text-muted-foreground">{row.employeeNumber}</span>
                  </td>
                  <td className="px-4 py-2">
                    {row.ptkpStatus ?? "—"} / {row.terCategory ?? "—"}
                  </td>
                  <td className="px-4 py-2 text-right">{formatRupiah(row.gross)}</td>
                  <td className="px-4 py-2 text-right">{formatPph21Rate(row.rate)}</td>
                  <td className="px-4 py-2 text-right font-medium">{row.tax === null ? "—" : formatRupiah(row.tax)}</td>
                  <td className="px-4 py-2">
                    {row.flags.map((flag) => (
                      <span
                        key={flag}
                        className="mr-1 inline-block rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-800 dark:text-amber-300"
                      >
                        {payrollPph21FlagLabel(flag)}
                      </span>
                    ))}
                    {row.note ? <span className="block text-xs text-muted-foreground">{row.note}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Sumber tabel TER: {report.policy.source} (berlaku sejak {report.policy.effectiveFrom}). PPh21 ditanggung yayasan dan
        tidak dipotong dari gaji.
      </p>
    </div>
  );
}
