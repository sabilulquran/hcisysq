import { AlertTriangle, Download, Loader2, RefreshCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "@tanstack/react-router";

import { AdminShell } from "@/layouts/AdminShell";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import {
  draftPayrollPayslips,
  formatRupiah,
  getPayrollPeriod,
  getPayrollReport,
  getPayrollResults,
  getPayrollTransfers,
  getPayrollVariance,
  payrollActionLabel,
  payrollOperationLabel,
  payrollStateLabel,
  payrollTransfersCsvUrl,
  publishPayrollPayslips,
  resolvePayrollAttendanceInputs,
  transitionPayrollPeriod,
  PayrollApiError,
  type PayrollPeriod,
  type PayrollPeriodAction,
  type PayrollPeriodOperation,
  type PayrollPeriodTransition,
  type PayrollReport,
  type PayrollResult,
  type PayrollTransferRow,
  type PayrollVarianceRow,
} from "@/lib/payroll";
import type { AuthSession } from "@/types/hcis";

/**
 * What to say when a panel came back refused. A period still being worked on is
 * not an error, and neither is a permission someone does not hold; both are
 * facts a reviewer needs rather than a blank space.
 */
function panelNote(key: string, outcome: PromiseSettledResult<unknown>): Record<string, string> {
  if (outcome.status === "fulfilled") return {};
  const reason = outcome.reason;
  if (reason instanceof PayrollApiError) {
    if (reason.code === "PAYROLL_NOT_APPROVED_YET") {
      return { [key]: "Angka periode ini baru terbuka setelah periode disahkan." };
    }
    if (reason.code === "PAYROLL_FORBIDDEN") {
      return { [key]: "Anda tidak memiliki akses untuk bagian ini." };
    }
    return { [key]: reason.message };
  }
  return { [key]: "Bagian ini gagal dimuat." };
}

const VARIANCE_LABELS: Record<PayrollVarianceRow["kind"], string> = {
  COMPONENT: "Komponen berubah",
  NEW_EMPLOYEE: "Pegawai baru",
  LEAVING_EMPLOYEE: "Pegawai keluar",
  LARGE_MANUAL_INPUT: "Input manual besar",
};

export function AdminPayrollPeriodPage() {
  const { periodId } = useParams({ from: "/admin/payroll/$periodId" });
  const [session, setSession] = useState<AuthSession | null>(null);
  const [period, setPeriod] = useState<PayrollPeriod | null>(null);
  const [transitions, setTransitions] = useState<PayrollPeriodTransition[]>([]);
  const [results, setResults] = useState<PayrollResult[]>([]);
  const [report, setReport] = useState<PayrollReport | null>(null);
  const [variances, setVariances] = useState<PayrollVarianceRow[]>([]);
  const [transfers, setTransfers] = useState<PayrollTransferRow[] | null>(null);
  const [panelNotes, setPanelNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canReadTransfers = hasPermission(session, "payroll.transfers.read.organization");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const detail = await getPayrollPeriod(periodId);
      setPeriod(detail.period);
      setTransitions(detail.transitions);

      // Each of these is refused on its own terms (not approved yet, no
      // permission), so one closed door must not blank the whole screen — and a
      // closed door must say so, or a director approves a period that looks
      // empty rather than unreadable. The transfer list is not fetched here: it
      // carries account numbers and every read of it is recorded, so it is
      // opened deliberately.
      const [resultsOutcome, reportOutcome, varianceOutcome] = await Promise.allSettled([
        getPayrollResults(periodId),
        getPayrollReport(periodId),
        getPayrollVariance(periodId),
      ]);
      setResults(resultsOutcome.status === "fulfilled" ? resultsOutcome.value.results : []);
      setReport(reportOutcome.status === "fulfilled" ? reportOutcome.value.report : null);
      setVariances(varianceOutcome.status === "fulfilled" ? varianceOutcome.value.variances : []);
      setTransfers(null);
      setPanelNotes({
        ...panelNote("results", resultsOutcome),
        ...panelNote("report", reportOutcome),
        ...panelNote("variance", varianceOutcome),
      });
    } catch (cause) {
      setError(cause instanceof PayrollApiError ? cause.message : "Periode gagal dimuat.");
    } finally {
      setLoading(false);
    }
  }, [periodId]);

  useEffect(() => {
    let active = true;
    void getCurrentSession().then((value) => {
      if (active) setSession(value);
    });
    void load();
    return () => {
      active = false;
    };
  }, [load]);

  async function run(label: string, work: () => Promise<string | null>) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const message = await work();
      if (message) setNotice(message);
      await load();
    } catch (cause) {
      setError(cause instanceof PayrollApiError ? cause.message : "Tindakan gagal diproses.");
    } finally {
      setBusy(null);
    }
  }

  function handleAction(action: PayrollPeriodAction) {
    let reason: string | undefined;
    // Which actions carry a reason is the server's table, not the screen's.
    if (period?.reasonRequiredActions.includes(action)) {
      const answer = window.prompt(`Alasan untuk "${payrollActionLabel(action)}"`);
      if (answer === null || answer.trim().length === 0) return;
      reason = answer.trim();
    }
    void run(action, async () => {
      const outcome = await transitionPayrollPeriod(periodId, action, reason);
      return `Periode sekarang ${payrollStateLabel(outcome.period.state)}.`;
    });
  }

  function handleOperation(operation: PayrollPeriodOperation) {
    void run(operation, async () => {
      if (operation === "resolve_attendance") {
        const outcome = await resolvePayrollAttendanceInputs(periodId);
        return `Lembur ${outcome.overtimeCount} pegawai, kehadiran ${outcome.attendanceCount} pegawai; ${outcome.clearedCount} baris lama dihapus.`;
      }
      if (operation === "draft_payslips") {
        const outcome = await draftPayrollPayslips(periodId);
        const conflicts = outcome.importConflicts.length;
        return `Slip disiapkan: ${outcome.drafted} baru, ${outcome.revised} revisi, ${outcome.alreadyCurrent} tidak berubah${
          conflicts > 0 ? `; ${conflicts} pegawai memakai slip batch impor dan dilewati.` : "."
        }`;
      }
      const outcome = await publishPayrollPayslips(periodId);
      return `${outcome.published} slip diterbitkan.`;
    });
  }

  if (loading && !period) {
    return (
      <AdminShell active="payroll" title="Payroll" description="Memuat periode…">
        <p className="text-sm text-muted-foreground">Memuat periode…</p>
      </AdminShell>
    );
  }

  if (!period) {
    return (
      <AdminShell active="payroll" title="Payroll" description="Periode tidak ditemukan.">
        <p className="text-sm text-muted-foreground">{error ?? "Periode tidak ditemukan."}</p>
      </AdminShell>
    );
  }

  return (
    <AdminShell
      active="payroll"
      title={`Payroll ${period.periodMonth.slice(0, 7)}`}
      description={`Tanggal gajian ${period.payDate} · cutoff ${period.cutoffStart} s.d. ${period.cutoffEnd}`}
    >
      <div className="space-y-6">
        {error ? (
          <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <p>{error}</p>
          </div>
        ) : null}
        {notice ? (
          <p role="status" className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm text-emerald-700 dark:text-emerald-400">
            {notice}
          </p>
        ) : null}

        <section className="rounded-lg border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border px-2 py-0.5 text-xs">{payrollStateLabel(period.state)}</span>
            <span className="text-xs text-muted-foreground">{period.resultCount} pegawai dihitung</span>
            {period.blockerCount > 0 ? (
              <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive">
                {period.blockerCount} blocker
              </span>
            ) : null}
            {period.resultCount > 0 && !period.hasCurrentCalculation ? (
              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
                input berubah sejak perhitungan terakhir
              </span>
            ) : null}
            {period.reopenCount > 0 ? (
              <span className="text-xs text-muted-foreground">dibuka ulang {period.reopenCount}×</span>
            ) : null}
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {period.availableActions.map((action) => (
              <button
                key={action}
                type="button"
                onClick={() => handleAction(action)}
                disabled={busy !== null}
                aria-busy={busy === action}
                className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm disabled:opacity-50"
              >
                {busy === action ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                {payrollActionLabel(action)}
              </button>
            ))}
            {period.availableOperations.map((operation) => (
              <button
                key={operation}
                type="button"
                onClick={() => handleOperation(operation)}
                disabled={busy !== null}
                aria-busy={busy === operation}
                className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm disabled:opacity-50"
              >
                {busy === operation ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : operation === "resolve_attendance" ? (
                  <RefreshCcw className="h-4 w-4" aria-hidden />
                ) : null}
                {payrollOperationLabel(operation)}
              </button>
            ))}
          </div>
        </section>

        {panelNotes.report ? (
          <p className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">{panelNotes.report}</p>
        ) : null}
        {report ? (
          <section className="rounded-lg border bg-card p-4">
            <h2 className="text-sm font-semibold">Rekap periode</h2>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-muted-foreground">Penerima</dt>
                <dd className="font-medium">{report.totals.employeeCount}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Bruto</dt>
                <dd className="font-medium">{formatRupiah(report.totals.gross)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Potongan</dt>
                <dd className="font-medium">{formatRupiah(report.totals.deductions)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Netto</dt>
                <dd className="font-medium">{formatRupiah(report.totals.net)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Dibayar</dt>
                <dd className="font-medium">{formatRupiah(report.totals.payable)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Biaya yayasan</dt>
                <dd className="font-medium">{formatRupiah(report.totals.employerCost)}</dd>
              </div>
            </dl>
          </section>
        ) : null}

        {panelNotes.variance ? (
          <p className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">{panelNotes.variance}</p>
        ) : null}
        {variances.length > 0 ? (
          <section className="rounded-lg border bg-card">
            <header className="border-b px-4 py-3">
              <h2 className="text-sm font-semibold">Perlu ditinjau</h2>
              <p className="text-xs text-muted-foreground">
                Perbandingan dengan periode sebelumnya, disaring ambang kebijakan.
              </p>
            </header>
            <ul className="divide-y text-sm">
              {variances.map((row) => (
                <li key={`${row.employmentId}-${row.componentCode ?? row.kind}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                  <span>
                    <span className="font-medium">{VARIANCE_LABELS[row.kind]}</span>
                    {row.componentCode ? <span className="text-muted-foreground"> · {row.componentCode}</span> : null}
                  </span>
                  <span className="text-muted-foreground">
                    {formatRupiah(row.previousAmount)} → {formatRupiah(row.currentAmount)}{" "}
                    <span className="font-medium text-foreground">({formatRupiah(row.delta)})</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {panelNotes.results ? (
          <p className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">{panelNotes.results}</p>
        ) : null}
        {results.length > 0 ? (
          <section className="rounded-lg border bg-card">
            <header className="border-b px-4 py-3">
              <h2 className="text-sm font-semibold">Hasil per pegawai</h2>
            </header>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-4 py-2">Employment</th>
                    <th scope="col" className="px-4 py-2 text-right">Bruto</th>
                    <th scope="col" className="px-4 py-2 text-right">Potongan</th>
                    <th scope="col" className="px-4 py-2 text-right">Dibayar</th>
                    <th scope="col" className="px-4 py-2">Catatan</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {results.map((result) => (
                    <tr key={result.employmentId}>
                      <td className="px-4 py-2 font-mono text-xs">{result.employmentId.slice(0, 8)}</td>
                      <td className="px-4 py-2 text-right">{formatRupiah(result.gross)}</td>
                      <td className="px-4 py-2 text-right">{formatRupiah(result.deductions)}</td>
                      <td className="px-4 py-2 text-right font-medium">{formatRupiah(result.payable)}</td>
                      <td className="px-4 py-2">
                        {result.blockers.length > 0 ? (
                          <span className="text-destructive">{result.blockers.map((blocker) => blocker.code).join(", ")}</span>
                        ) : result.payFactorReason !== "none" ? (
                          <span className="text-muted-foreground">
                            {result.payFactorReason === "proration" ? "Prorata" : "Masa kerja awal"}
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {canReadTransfers ? (
          <section className="rounded-lg border bg-card">
            <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold">Daftar transfer</h2>
                <p className="text-xs text-muted-foreground">
                  {transfers === null
                    ? "Berisi nomor rekening; setiap pembukaan dicatat sebagai akses sensitif."
                    : `${transfers.length} penerima.`}
                </p>
              </div>
              <span className="flex gap-2">
                {transfers === null ? (
                  <button
                    type="button"
                    onClick={() =>
                      void run("transfers", async () => {
                        const outcome = await getPayrollTransfers(periodId);
                        setTransfers(outcome.transfers);
                        return null;
                      })
                    }
                    disabled={busy !== null}
                    aria-busy={busy === "transfers"}
                    className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm disabled:opacity-50"
                  >
                    {busy === "transfers" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                    Buka daftar transfer
                  </button>
                ) : null}
                <a
                  href={payrollTransfersCsvUrl(periodId)}
                  className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm"
                >
                  <Download className="h-4 w-4" aria-hidden />
                  Unduh CSV
                </a>
              </span>
            </header>
            <div className={transfers === null ? "hidden" : "overflow-x-auto"}>
              <table className="w-full text-sm">
                <caption className="sr-only">Daftar penerima transfer periode ini</caption>
                <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-4 py-2">NIP</th>
                    <th scope="col" className="px-4 py-2">Nama</th>
                    <th scope="col" className="px-4 py-2">Bank</th>
                    <th scope="col" className="px-4 py-2">Rekening</th>
                    <th scope="col" className="px-4 py-2 text-right">Dibayar</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {(transfers ?? []).map((row) => (
                    <tr key={row.employeeNumber}>
                      <td className="px-4 py-2 font-mono text-xs">{row.employeeNumber}</td>
                      <td className="px-4 py-2">{row.fullName}</td>
                      <td className="px-4 py-2">{row.bankName ?? "—"}</td>
                      <td className="px-4 py-2 font-mono text-xs">{row.bankAccountNumber ?? "—"}</td>
                      <td className="px-4 py-2 text-right font-medium">{formatRupiah(row.payable)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {transitions.length > 0 ? (
          <section className="rounded-lg border bg-card">
            <header className="border-b px-4 py-3">
              <h2 className="text-sm font-semibold">Riwayat keputusan</h2>
            </header>
            <ul className="divide-y text-sm">
              {transitions.map((entry) => (
                <li key={`${entry.occurredAt}-${entry.action}`} className="px-4 py-2">
                  <span className="font-medium">{payrollActionLabel(entry.action as PayrollPeriodAction)}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {entry.fromState} → {entry.toState}
                  </span>
                  {entry.reason ? <p className="text-muted-foreground">“{entry.reason}”</p> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </AdminShell>
  );
}
