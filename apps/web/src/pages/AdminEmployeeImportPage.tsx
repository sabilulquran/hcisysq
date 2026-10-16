import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Upload } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

import { AdminShell } from "@/layouts/AdminShell";
import {
  AdminApiError,
  commitEmployeeImport,
  previewEmployeeImport,
  type EmployeeImportCommitResult,
  type EmployeeImportPreview,
} from "@/lib/adminEmployees";

const CSV_TEMPLATE = [
  "NIP,NAMA,STATUS AKTIF,STATUS KEPEGAWAIAN,UNIT,JABATAN,JENIS KEPEGAWAIAN,JABATAN FUNGSIONAL,JABATAN STRUKTURAL,EMAIL,NO HP,PENDIDIKAN TERAKHIR,TMT,TAHUN KELUAR (TTTT-BB)",
  "YSQ-DEMO-001,Pegawai Contoh,Aktif,Tetap,Unit Contoh,Jabatan Contoh,Tetap,-,-,pegawai.contoh@example.test,081234567890,S1,2026-01-01,",
].join("\r\n");

function summaryCard(label: string, value: number, tone: "neutral" | "good" | "warn" | "error") {
  const toneClass =
    tone === "good"
      ? "bg-success-soft text-success-ink"
      : tone === "warn"
        ? "bg-warning-soft text-warning-ink"
        : tone === "error"
          ? "bg-danger-soft text-danger-ink"
          : "bg-surface text-foreground";
  return (
    <div className={`rounded-xl px-4 py-3 ${toneClass}`}>
      <p className="text-xs font-semibold opacity-70">{label}</p>
      <p className="mt-1 text-xl font-bold">{value}</p>
    </div>
  );
}

export function AdminEmployeeImportPage() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<EmployeeImportPreview | null>(null);
  const [committed, setCommitted] = useState<EmployeeImportCommitResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validationSummary = useMemo(() => {
    if (!preview) return [] as Array<{ code: string; count: number; severity: "warning" | "error" }>;
    const counts = new Map<string, { count: number; severity: "warning" | "error" }>();
    for (const row of preview.rows) {
      for (const issue of row.issues) {
        const current = counts.get(issue.code);
        counts.set(issue.code, {
          count: (current?.count ?? 0) + 1,
          severity: current?.severity === "error" || issue.severity === "error" ? "error" : "warning",
        });
      }
    }
    return [...counts.entries()]
      .map(([code, value]) => ({ code, ...value }))
      .sort((a, b) => (a.severity === b.severity ? b.count - a.count : a.severity === "error" ? -1 : 1));
  }, [preview]);

  const skipCount = preview?.rows.filter((row) => row.action === "skip").length ?? 0;

  const handlePreview = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) return;

    setLoading(true);
    setError(null);
    setPreview(null);
    setCommitted(null);
    try {
      setPreview(await previewEmployeeImport(file));
    } catch (cause) {
      setError(
        cause instanceof AdminApiError
          ? cause.message
          : "File import tidak dapat dipreview.",
      );
    } finally {
      setLoading(false);
    }
  };

  const handleCommit = async () => {
    if (!preview || preview.errorCount > 0 || preview.status !== "previewed") return;

    setCommitting(true);
    setError(null);
    try {
      const result = await commitEmployeeImport(preview.importId);
      setCommitted(result);
      setPreview((current) =>
        current
          ? { ...current, status: result.status, committedAt: result.committedAt }
          : current,
      );
    } catch (cause) {
      setError(
        cause instanceof AdminApiError
          ? cause.message
          : "Import tidak dapat di-commit.",
      );
    } finally {
      setCommitting(false);
    }
  };

  return (
    <AdminShell
      active="import"
      title="Impor Pegawai"
      description="CSV UTF-8 adalah format yang disarankan; XLSX tetap didukung. Tidak ada perubahan employee master sebelum konfirmasi dijalankan."
    >
      <section className="rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
        <div className="mb-4 flex flex-col gap-3 rounded-xl border border-brand-primary/20 bg-brand-primary-pale/60 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-bold text-brand-heading">Gunakan CSV untuk import rutin</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              CSV lebih deterministik karena tidak membawa formula, format tanggal Excel, merged cells, atau hidden rows. XLSX tetap tersedia untuk kompatibilitas master lama.
            </p>
          </div>
          <a
            href={`data:text/csv;charset=utf-8,${encodeURIComponent(CSV_TEMPLATE)}`}
            download="template-import-pegawai.csv"
            className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl border border-brand-primary/30 bg-surface-raised px-4 text-sm font-bold text-brand-primary-deep"
          >
            <Download className="h-4 w-4" aria-hidden="true" />
            Template CSV
          </a>
        </div>

        <form onSubmit={handlePreview} className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
          <label className="block">
            <span className="mb-2 block text-sm font-bold text-foreground">File pegawai (.csv / .xlsx)</span>
            <input
              type="file"
              accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setPreview(null);
                setCommitted(null);
                setError(null);
              }}
              className="block w-full rounded-xl border border-border bg-surface p-2 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-primary-pale file:px-3 file:py-2 file:text-xs file:font-bold file:text-brand-primary-deep"
            />
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              CSV membaca header pada baris pertama. XLSX membaca sheet <strong>Master Data SDM YSQ</strong>. Raw upload dibuang setelah request selesai.
            </p>
          </label>
          <button
            type="submit"
            disabled={!file || loading}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-brand-primary px-5 text-sm font-bold text-brand-foreground hover:bg-brand-primary-deep disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Upload className="h-4 w-4" aria-hidden="true" />
            {loading ? "Memproses..." : "Buat preview"}
          </button>
        </form>
      </section>

      {error ? (
        <div className="mt-4 flex gap-3 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <p>{error}</p>
        </div>
      ) : null}

      {preview ? (
        <>
          <section className="mt-5 rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-primary-pale text-brand-primary-deep">
                  <FileSpreadsheet className="h-5 w-5" aria-hidden="true" />
                </span>
                <div>
                  <p className="text-sm font-bold text-brand-heading">{preview.sourceFilename}</p>
                  <p className="mt-1 text-xs text-muted-foreground">Sumber: {preview.sourceSheet}</p>
                  <p className="mt-1 text-xs text-muted-foreground">Import ID: {preview.importId}</p>
                  <p className="mt-1 text-xs text-muted-foreground">Checksum SHA-256: {preview.checksumSha256.slice(0, 16)}…</p>
                </div>
              </div>
              <a href="/admin/employees/imports" className="text-sm font-bold text-brand-primary-deep hover:underline">Lihat riwayat impor</a>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {summaryCard("Baris", preview.rowCount, "neutral")}
              {summaryCard("Insert", preview.insertCount, "good")}
              {summaryCard("Update", preview.updateCount, "neutral")}
              {summaryCard("Skip", skipCount, "neutral")}
              {summaryCard("Warning", preview.warningCount, "warn")}
              {summaryCard("Error", preview.errorCount, "error")}
            </div>

            {validationSummary.length ? (
              <div className="mt-4 rounded-2xl border border-border/70 bg-surface p-4">
                <p className="text-sm font-bold text-foreground">Ringkasan validasi</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {validationSummary.map((item) => (
                    <span
                      key={item.code}
                      className={item.severity === "error"
                        ? "rounded-full bg-danger-soft px-3 py-1 text-xs font-semibold text-danger-ink"
                        : "rounded-full bg-warning-soft px-3 py-1 text-xs font-semibold text-warning-ink"}
                    >
                      {item.code} · {item.count}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="mt-5 flex flex-col gap-3 rounded-2xl border border-border/70 bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-bold text-foreground">
                  {preview.errorCount > 0
                    ? "Preview belum dapat di-commit"
                    : committed
                      ? "Import sudah berhasil di-commit"
                      : "Preview siap dikonfirmasi"}
                </p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {preview.errorCount > 0
                    ? "Perbaiki error lalu buat preview baru. Warning dan record skip tidak memblokir commit."
                    : committed
                      ? `${committed.committedCount} employee diproses. Buka Daftar Pegawai untuk melihat hasilnya.`
                      : "Duplicate NIP memilih satu kondisi terkini: valid, lalu aktif, lalu TMT terbaru, lalu baris terakhir. Record lain dilewati sebagai skip."}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleCommit()}
                disabled={preview.errorCount > 0 || preview.status !== "previewed" || committing || Boolean(committed)}
                className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl bg-brand-primary px-5 text-sm font-bold text-brand-foreground hover:bg-brand-primary-deep disabled:cursor-not-allowed disabled:opacity-50"
              >
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                {committing ? "Mengimpor..." : committed ? "Sudah diimpor" : "Konfirmasi import"}
              </button>
            </div>
          </section>

          <section className="mt-4 overflow-hidden rounded-2xl border border-border/70 bg-surface-raised shadow-[var(--shadow-soft)]">
            <div className="border-b border-border/70 px-5 py-4">
              <h2 className="text-sm font-bold text-brand-heading">Hasil validasi per baris</h2>
              <p className="mt-1 text-xs text-muted-foreground">Menampilkan maksimal 200 baris pertama dari preview.</p>
            </div>
            <div className="max-h-[34rem] overflow-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="sticky top-0 bg-surface text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Baris</th>
                    <th className="px-4 py-3 font-semibold">Aksi</th>
                    <th className="px-4 py-3 font-semibold">Validasi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/70">
                  {preview.rows.slice(0, 200).map((row) => (
                    <tr key={row.rowNumber}>
                      <td className="px-4 py-3 font-semibold">{row.rowNumber}</td>
                      <td className="px-4 py-3">
                        <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-bold uppercase text-foreground">{row.action}</span>
                      </td>
                      <td className="px-4 py-3">
                        {row.issues.length ? (
                          <div className="space-y-1.5">
                            {row.issues.map((issue) => (
                              <p key={`${row.rowNumber}-${issue.code}`} className={issue.severity === "error" ? "text-xs text-danger-ink" : "text-xs text-warning-ink"}>
                                <strong>{issue.code}</strong> · {issue.message}
                              </p>
                            ))}
                          </div>
                        ) : (
                          <span className="text-xs text-success-ink">Valid</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </AdminShell>
  );
}
