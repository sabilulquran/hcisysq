import { Eye, FileCheck2, Loader2, Upload } from "lucide-react";
import { useEffect, useState } from "react";

import { AdminShell } from "@/layouts/AdminShell";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import {
  commitPayslipImport,
  getPayslipImport,
  listPayslipImports,
  previewPayslipImport,
  publishPayslipImport,
  type PayslipImportBatch,
  type PayslipImportDetail,
  type PayslipSourceFormat,
} from "@/lib/payslips";
import type { AuthSession } from "@/types/hcis";

function sourceFormatLabel(value: PayslipSourceFormat) {
  if (value === "tetap") return "Tetap";
  if (value === "honorer") return "Honorer";
  return "Generic";
}

export function AdminPayslipsPage() {
  const [items, setItems] = useState<PayslipImportBatch[] | null>(null);
  const [review, setReview] = useState<PayslipImportDetail | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fallbackPeriod, setFallbackPeriod] = useState("");
  const [session, setSession] = useState<AuthSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canPublish = hasPermission(session, "payslips.publish");

  const refresh = async () => {
    const result = await listPayslipImports();
    setItems(result.items);
  };

  useEffect(() => {
    void refresh().catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : "Riwayat payslip tidak dapat dimuat."),
    );
    void getCurrentSession().then(setSession).catch(() => setSession(null));
  }, []);

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      await refresh();
      setNotice(success);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Operasi payslip gagal diproses.");
    } finally {
      setBusy(false);
    }
  };

  const openReview = async (batchId: string) => {
    setBusy(true);
    setError(null);
    try {
      setReview(await getPayslipImport(batchId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Detail batch tidak dapat dimuat.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AdminShell
      active="payslips"
      title="Pengelolaan Slip Gaji"
      description="Import, validasi, review, commit draft, lalu publish. HCIS mempertahankan nilai dari sumber payroll dan tidak menghitung gaji."
    >
      <div className="space-y-6">
        <section className="rounded-2xl border border-border bg-white p-5 shadow-[var(--shadow-soft)]">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,28rem)]">
            <div>
              <h2 className="text-base font-bold text-brand-heading">Import & preview CSV</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                Mendukung format generic HCIS, payroll pegawai tetap, dan payroll honorer. Format legacy dideteksi otomatis dari header; NIP dicocokkan ke nomor pegawai.
              </p>
              <div className="mt-4 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                <div className="rounded-xl bg-muted/40 p-3">
                  <strong className="block text-brand-heading">Generic</strong>
                  <span>employee_number, period, lines_json</span>
                </div>
                <div className="rounded-xl bg-muted/40 p-3">
                  <strong className="block text-brand-heading">Tetap</strong>
                  <span>Gaji Pokok, Total Bruto, Gaji Neto, dan komponen terkait.</span>
                </div>
                <div className="rounded-xl bg-muted/40 p-3">
                  <strong className="block text-brand-heading">Honorer</strong>
                  <span>Value Honor/Transport, Total Penghasilan, Gaji Neto, dan komponen terkait.</span>
                </div>
              </div>
            </div>

            <div className="space-y-3 rounded-2xl border border-border bg-surface/50 p-4">
              <label className="block text-xs font-bold text-brand-heading">
                File CSV
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                  className="mt-2 block w-full text-sm font-normal"
                />
              </label>
              <label className="block text-xs font-bold text-brand-heading">
                Periode fallback untuk format lama
                <input
                  type="month"
                  value={fallbackPeriod}
                  onChange={(event) => setFallbackPeriod(event.target.value)}
                  className="mt-2 w-full rounded-xl border border-border bg-white px-3 py-2 text-sm font-normal"
                />
              </label>
              <p className="text-[11px] leading-5 text-muted-foreground">
                Opsional. Dipakai hanya bila CSV tetap/honorer tidak memiliki kolom TANGGAL. Format generic tetap membaca period dari file.
              </p>
              <button
                type="button"
                disabled={!file || busy}
                onClick={() =>
                  file &&
                  void run(
                    () => previewPayslipImport(file, fallbackPeriod || undefined),
                    "Preview disimpan. Periksa format terdeteksi dan validation error sebelum commit.",
                  )
                }
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand-primary px-4 py-2.5 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                Preview CSV
              </button>
            </div>
          </div>
        </section>

        {error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</div>
        ) : null}
        {notice ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">{notice}</div>
        ) : null}

        {review ? (
          <section className="overflow-hidden rounded-2xl border border-border bg-white shadow-[var(--shadow-soft)]">
            <div className="border-b border-border px-5 py-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-bold text-brand-heading">Review {review.sourceFilename}</h2>
                    <span className="rounded-full bg-brand-primary-pale px-2.5 py-1 text-[10px] font-bold text-brand-primary-deep">
                      {sourceFormatLabel(review.sourceFormat)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {review.rowCount} row · {review.validCount} valid · {review.errorCount} error. Nilai ditampilkan persis sebagai string import, tanpa kalkulasi.
                  </p>
                </div>
                <button type="button" onClick={() => setReview(null)} className="rounded-xl border border-border px-3 py-2 text-xs font-bold">
                  Tutup review
                </button>
              </div>
            </div>
            <div className="max-h-[32rem] overflow-auto">
              <table className="w-full min-w-[48rem] text-left text-sm">
                <thead className="sticky top-0 bg-surface text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Row</th>
                    <th className="px-4 py-3">Pegawai</th>
                    <th className="px-4 py-3">Periode</th>
                    <th className="px-4 py-3">Komponen import</th>
                    <th className="px-4 py-3">Validasi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {review.rows.map((row) => (
                    <tr key={row.rowNumber}>
                      <td className="px-4 py-3 align-top">{row.rowNumber}</td>
                      <td className="px-4 py-3 align-top font-semibold">{row.employeeNumber}</td>
                      <td className="px-4 py-3 align-top">{row.period?.slice(0, 7) ?? "—"}</td>
                      <td className="px-4 py-3 align-top">
                        <div className="space-y-1">
                          {row.lines?.map((line, index) => (
                            <div key={`${line.label}-${index}`} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
                              <span className="text-muted-foreground">{line.label}</span>
                              <span className="break-words font-semibold">{line.value}</span>
                            </div>
                          )) ?? "—"}
                        </div>
                      </td>
                      <td className="px-4 py-3 align-top">
                        {row.errors.length === 0 ? (
                          <span className="font-semibold text-emerald-700">Valid</span>
                        ) : (
                          <ul className="list-disc space-y-1 pl-4 text-red-700">
                            {row.errors.map((message) => <li key={message}>{message}</li>)}
                          </ul>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        <section className="overflow-hidden rounded-2xl border border-border bg-white shadow-[var(--shadow-soft)]">
          <div className="border-b border-border px-5 py-4">
            <h2 className="text-base font-bold text-brand-heading">Riwayat batch</h2>
            <p className="mt-1 text-xs text-muted-foreground">Preview dan commit belum terlihat pegawai. Slip baru tersedia setelah publish.</p>
          </div>

          {items === null ? (
            <div className="flex min-h-40 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>
          ) : items.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Belum ada batch payslip.</div>
          ) : (
            <div className="divide-y divide-border">
              {items.map((item) => (
                <div key={item.id} className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <FileCheck2 className="h-4 w-4 text-brand-primary" />
                      <p className="font-bold">{item.sourceFilename}</p>
                      <span className="rounded-full bg-brand-primary-pale px-2 py-1 text-[10px] font-bold text-brand-primary-deep">
                        {sourceFormatLabel(item.sourceFormat)}
                      </span>
                      <span className="rounded-full bg-muted px-2 py-1 text-[11px] font-bold uppercase tracking-wide">{item.status}</span>
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {item.rowCount} row · {item.validCount} valid · {item.errorCount} error
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void openReview(item.id)}
                      className="inline-flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm font-bold disabled:opacity-50"
                    >
                      <Eye className="h-4 w-4" /> Review
                    </button>
                    {item.status === "previewed" ? (
                      <button
                        type="button"
                        disabled={busy || item.errorCount > 0}
                        onClick={() => void run(() => commitPayslipImport(item.id), "Batch di-commit sebagai draft.")}
                        className="rounded-xl border border-border px-3 py-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Commit draft
                      </button>
                    ) : null}
                    {item.status === "committed" && canPublish ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void run(() => publishPayslipImport(item.id), "Batch dipublikasikan dan notifikasi pegawai dibuat.")}
                        className="rounded-xl bg-brand-primary px-3 py-2 text-sm font-bold text-white disabled:opacity-50"
                      >
                        Publish
                      </button>
                    ) : null}
                    {item.status === "committed" && !canPublish ? (
                      <span className="self-center text-xs font-semibold text-muted-foreground">Menunggu akun dengan izin publish</span>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </AdminShell>
  );
}
