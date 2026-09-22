import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Eye,
  FileCheck2,
  FileUp,
  Loader2,
  Save,
  Trash2,
  Upload,
} from "lucide-react";
import { useMemo, useRef, useState, useEffect } from "react";

import { AdminShell } from "@/layouts/AdminShell";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import {
  commitPayslipImport,
  correctPayslipImportRow,
  excludePayslipImportRow,
  getPayslipImport,
  listPayslipImports,
  previewPayslipImport,
  publishPayslipImport,
  type PayslipImportBatch,
  type PayslipImportDetail,
  type PayslipImportRow,
  type PayslipSourceFormat,
} from "@/lib/payslips";
import type { AuthSession } from "@/types/hcis";

type ReviewFilter = "errors" | "all";

function sourceFormatLabel(value: PayslipSourceFormat) {
  if (value === "tetap") return "Tetap";
  if (value === "honorer") return "Honorer";
  return "Generic";
}

function csvCell(value: string | number | null) {
  const text = value === null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function rowStatusLabel(row: PayslipImportRow) {
  if (row.resolutionStatus === "drafted") return "Masuk draft";
  if (row.resolutionStatus === "excluded") return "Dihapus";
  return row.errors.length > 0 ? "Perlu tindakan" : "Siap draft";
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
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("errors");
  const [reviewPage, setReviewPage] = useState(1);
  const [rowEdits, setRowEdits] = useState<Record<number, { employeeNumber: string; period: string }>>({});
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const canPublish = hasPermission(session, "payslips.publish");
  const reviewPageSize = 100;

  const refresh = async () => {
    const result = await listPayslipImports();
    setItems(result.items);
  };

  const applyReview = (detail: PayslipImportDetail) => {
    setReview(detail);
    setRowEdits(
      Object.fromEntries(
        detail.rows.map((row) => [
          row.rowNumber,
          { employeeNumber: row.employeeNumber, period: row.period ?? "" },
        ]),
      ),
    );
    if (detail.unresolvedCount === 0 && reviewFilter === "errors") setReviewFilter("all");
    setReviewPage(1);
  };

  const reloadReview = async (batchId: string) => {
    applyReview(await getPayslipImport(batchId));
  };

  useEffect(() => {
    void refresh().catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : "Riwayat payslip tidak dapat dimuat."),
    );
    void getCurrentSession().then(setSession).catch(() => setSession(null));
  }, []);

  const run = async (
    action: () => Promise<unknown>,
    success: string,
    affectedBatchId?: string,
  ) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      await refresh();
      if (affectedBatchId && review?.id === affectedBatchId) {
        await reloadReview(affectedBatchId);
      }
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
      const detail = await getPayslipImport(batchId);
      setReviewFilter(detail.unresolvedCount > 0 ? "errors" : "all");
      applyReview(detail);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Detail batch tidak dapat dimuat.");
    } finally {
      setBusy(false);
    }
  };

  const errorRows = useMemo(
    () =>
      review?.rows.filter(
        (row) => row.resolutionStatus === "pending" && row.errors.length > 0,
      ) ?? [],
    [review],
  );

  const errorSummary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of errorRows) {
      for (const message of row.errors) {
        counts.set(message, (counts.get(message) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [errorRows]);

  const visibleRows = useMemo(() => {
    if (!review) return [];
    return reviewFilter === "errors" ? errorRows : review.rows;
  }, [review, reviewFilter, errorRows]);

  const pageCount = Math.max(1, Math.ceil(visibleRows.length / reviewPageSize));
  const safePage = Math.min(reviewPage, pageCount);
  const pagedRows = visibleRows.slice(
    (safePage - 1) * reviewPageSize,
    safePage * reviewPageSize,
  );

  const downloadErrors = () => {
    if (!review || errorRows.length === 0) return;
    const rows = [
      ["row", "employee_number", "period", "errors"],
      ...errorRows.map((row) => [
        String(row.rowNumber),
        row.employeeNumber,
        row.period ?? "",
        row.errors.join(" | "),
      ]),
    ];
    const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `payslip-errors-${review.id}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const saveCorrection = async (row: PayslipImportRow) => {
    if (!review) return;
    const edit = rowEdits[row.rowNumber];
    if (!edit?.employeeNumber.trim() || !edit.period) {
      setError("NIP/nomor pegawai dan periode wajib diisi sebelum menyimpan perbaikan.");
      return;
    }
    await run(
      () =>
        correctPayslipImportRow(review.id, row.rowNumber, {
          employeeNumber: edit.employeeNumber.trim(),
          period: edit.period,
        }),
      `Baris ${row.rowNumber} sudah direvalidasi.`,
      review.id,
    );
  };

  const excludeRow = async (row: PayslipImportRow) => {
    if (!review) return;
    const confirmed = window.confirm(
      `Hapus baris ${row.rowNumber} dari batch? Baris tidak akan ikut slip gaji, tetapi jejak audit tetap disimpan.`,
    );
    if (!confirmed) return;
    await run(
      () => excludePayslipImportRow(review.id, row.rowNumber),
      `Baris ${row.rowNumber} dihapus dari batch.`,
      review.id,
    );
  };

  return (
    <AdminShell
      active="payslips"
      title="Pengelolaan Slip Gaji"
      description="Import data payroll, masukkan baris valid ke draft, selesaikan baris bermasalah, lalu publish. HCIS tidak menghitung ulang gaji."
    >
      <div className="space-y-6">
        <section className="rounded-2xl border border-border bg-white p-5 shadow-[var(--shadow-soft)]">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,28rem)]">
            <div>
              <h2 className="text-base font-bold text-brand-heading">Import & preview CSV</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                Mendukung format generic HCIS, payroll pegawai tetap, dan payroll honorer. Baris valid dapat masuk draft meskipun baris lain masih perlu diperbaiki.
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
              <div>
                <p className="text-xs font-bold text-brand-heading">File CSV</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                  className="sr-only"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-brand-primary/40 bg-white px-4 py-3 text-sm font-bold text-brand-primary-deep shadow-sm transition hover:bg-brand-primary-pale"
                >
                  <FileUp className="h-4 w-4" />
                  Pilih file CSV
                </button>
                <p className="mt-2 break-all rounded-lg bg-white px-3 py-2 text-xs text-muted-foreground">
                  {file?.name ?? "Belum ada file dipilih"}
                </p>
              </div>

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
                Opsional. Dipakai bila CSV tetap/honorer tidak memiliki kolom TANGGAL.
              </p>
              <button
                type="button"
                disabled={!file || busy}
                onClick={() =>
                  file &&
                  void run(
                    () => previewPayslipImport(file, fallbackPeriod || undefined),
                    "Preview disimpan. Baris valid siap dimasukkan ke draft; baris error dapat diperbaiki dari Review.",
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
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-bold text-brand-heading">Review {review.sourceFilename}</h2>
                    <span className="rounded-full bg-brand-primary-pale px-2.5 py-1 text-[10px] font-bold text-brand-primary-deep">
                      {sourceFormatLabel(review.sourceFormat)}
                    </span>
                    <span className="rounded-full bg-muted px-2.5 py-1 text-[10px] font-bold uppercase">{review.status}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Nilai payroll tetap read-only. Di sini hanya NIP/nomor pegawai dan periode yang dapat diperbaiki.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setReview(null)}
                  className="rounded-xl border border-border px-3 py-2 text-xs font-bold"
                >
                  Tutup review
                </button>
              </div>

              <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-xl bg-emerald-50 p-3">
                  <p className="text-[11px] font-bold uppercase text-emerald-700">Masuk draft</p>
                  <p className="mt-1 text-xl font-extrabold text-emerald-900">{review.draftedCount}</p>
                </div>
                <div className="rounded-xl bg-sky-50 p-3">
                  <p className="text-[11px] font-bold uppercase text-sky-700">Siap draft</p>
                  <p className="mt-1 text-xl font-extrabold text-sky-900">{review.pendingValidCount}</p>
                </div>
                <div className="rounded-xl bg-amber-50 p-3">
                  <p className="text-[11px] font-bold uppercase text-amber-700">Perlu tindakan</p>
                  <p className="mt-1 text-xl font-extrabold text-amber-900">{review.unresolvedCount}</p>
                </div>
                <div className="rounded-xl bg-slate-100 p-3">
                  <p className="text-[11px] font-bold uppercase text-slate-600">Dihapus dari batch</p>
                  <p className="mt-1 text-xl font-extrabold text-slate-900">{review.excludedCount}</p>
                </div>
              </div>

              {review.unresolvedCount > 0 ? (
                <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-amber-900">
                        {review.unresolvedCount} baris belum akan ikut slip gaji.
                      </p>
                      <p className="mt-1 text-xs leading-5 text-amber-800">
                        Perbaiki NIP/periode lalu masukkan ke draft, atau Hapus dari batch bila memang tidak perlu diikutkan. Publish tetap dikunci sampai semuanya diputuskan.
                      </p>
                      {errorSummary.length > 0 ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {errorSummary.map(([message, count]) => (
                            <span key={message} className="rounded-full bg-white px-2.5 py-1 text-[11px] font-semibold text-amber-900">
                              {count} × {message}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="mt-4 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-800">
                  <CheckCircle2 className="h-4 w-4" />
                  Tidak ada baris yang masih perlu tindakan.
                </div>
              )}

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setReviewFilter("errors");
                      setReviewPage(1);
                    }}
                    className={`rounded-xl px-3 py-2 text-xs font-bold ${
                      reviewFilter === "errors" ? "bg-brand-primary text-white" : "border border-border bg-white"
                    }`}
                  >
                    Perlu tindakan ({review.unresolvedCount})
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setReviewFilter("all");
                      setReviewPage(1);
                    }}
                    className={`rounded-xl px-3 py-2 text-xs font-bold ${
                      reviewFilter === "all" ? "bg-brand-primary text-white" : "border border-border bg-white"
                    }`}
                  >
                    Semua ({review.rowCount})
                  </button>
                </div>
                {errorRows.length > 0 ? (
                  <button
                    type="button"
                    onClick={downloadErrors}
                    className="inline-flex items-center gap-2 rounded-xl border border-border bg-white px-3 py-2 text-xs font-bold"
                  >
                    <Download className="h-4 w-4" />
                    Unduh daftar error
                  </button>
                ) : null}
              </div>
            </div>

            <div className="max-h-[36rem] overflow-auto">
              <table className="w-full min-w-[70rem] text-left text-sm">
                <thead className="sticky top-0 z-10 bg-surface text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Row</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">NIP / Pegawai</th>
                    <th className="px-4 py-3">Periode</th>
                    <th className="px-4 py-3">Komponen import</th>
                    <th className="px-4 py-3">Validasi & aksi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {pagedRows.map((row) => {
                    const editable = row.resolutionStatus === "pending" && row.errors.length > 0;
                    const edit = rowEdits[row.rowNumber] ?? {
                      employeeNumber: row.employeeNumber,
                      period: row.period ?? "",
                    };
                    return (
                      <tr key={row.rowNumber}>
                        <td className="px-4 py-3 align-top font-semibold">{row.rowNumber}</td>
                        <td className="px-4 py-3 align-top">
                          <span
                            className={`inline-flex rounded-full px-2 py-1 text-[10px] font-bold ${
                              row.resolutionStatus === "drafted"
                                ? "bg-emerald-100 text-emerald-800"
                                : row.resolutionStatus === "excluded"
                                  ? "bg-slate-200 text-slate-700"
                                  : row.errors.length > 0
                                    ? "bg-amber-100 text-amber-800"
                                    : "bg-sky-100 text-sky-800"
                            }`}
                          >
                            {rowStatusLabel(row)}
                          </span>
                        </td>
                        <td className="px-4 py-3 align-top">
                          {editable ? (
                            <input
                              value={edit.employeeNumber}
                              onChange={(event) =>
                                setRowEdits((current) => ({
                                  ...current,
                                  [row.rowNumber]: { ...edit, employeeNumber: event.target.value },
                                }))
                              }
                              className="w-44 rounded-lg border border-border bg-white px-2.5 py-2 text-sm"
                              aria-label={`NIP row ${row.rowNumber}`}
                            />
                          ) : (
                            <span className="font-semibold">{row.employeeNumber || "—"}</span>
                          )}
                        </td>
                        <td className="px-4 py-3 align-top">
                          {editable ? (
                            <input
                              type="month"
                              value={edit.period}
                              onChange={(event) =>
                                setRowEdits((current) => ({
                                  ...current,
                                  [row.rowNumber]: { ...edit, period: event.target.value },
                                }))
                              }
                              className="w-40 rounded-lg border border-border bg-white px-2.5 py-2 text-sm"
                              aria-label={`Periode row ${row.rowNumber}`}
                            />
                          ) : (
                            row.period?.slice(0, 7) ?? "—"
                          )}
                        </td>
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
                            <span className="font-semibold text-emerald-700">
                              {row.resolutionStatus === "drafted" ? "Sudah masuk draft" : row.resolutionStatus === "excluded" ? "Dihapus dari batch" : "Valid"}
                            </span>
                          ) : (
                            <ul className="list-disc space-y-1 pl-4 text-red-700">
                              {row.errors.map((message) => <li key={message}>{message}</li>)}
                            </ul>
                          )}
                          {editable ? (
                            <div className="mt-3 flex flex-wrap gap-2">
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void saveCorrection(row)}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-primary px-3 py-2 text-xs font-bold text-white disabled:opacity-50"
                              >
                                <Save className="h-3.5 w-3.5" />
                                Simpan perbaikan
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void excludeRow(row)}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-2 text-xs font-bold text-red-700 disabled:opacity-50"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                Hapus dari batch
                              </button>
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {pagedRows.length === 0 ? (
                <div className="p-8 text-center text-sm text-muted-foreground">
                  Tidak ada baris pada filter ini.
                </div>
              ) : null}
            </div>

            {visibleRows.length > reviewPageSize ? (
              <div className="flex items-center justify-between border-t border-border px-5 py-3 text-xs">
                <span className="text-muted-foreground">
                  Menampilkan {(safePage - 1) * reviewPageSize + 1}–{Math.min(safePage * reviewPageSize, visibleRows.length)} dari {visibleRows.length} baris
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={safePage <= 1}
                    onClick={() => setReviewPage((value) => Math.max(1, value - 1))}
                    className="rounded-lg border border-border px-3 py-1.5 font-bold disabled:opacity-40"
                  >
                    Sebelumnya
                  </button>
                  <button
                    type="button"
                    disabled={safePage >= pageCount}
                    onClick={() => setReviewPage((value) => Math.min(pageCount, value + 1))}
                    className="rounded-lg border border-border px-3 py-1.5 font-bold disabled:opacity-40"
                  >
                    Berikutnya
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        <section className="overflow-hidden rounded-2xl border border-border bg-white shadow-[var(--shadow-soft)]">
          <div className="border-b border-border px-5 py-4">
            <h2 className="text-base font-bold text-brand-heading">Riwayat batch</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Baris valid boleh masuk draft lebih dulu. Slip baru terlihat pegawai setelah semua baris diselesaikan dan batch dipublish.
            </p>
          </div>

          {items === null ? (
            <div className="flex min-h-40 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>
          ) : items.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Belum ada batch payslip.</div>
          ) : (
            <div className="divide-y divide-border">
              {items.map((item) => {
                const hasPending = item.pendingValidCount > 0 || item.unresolvedCount > 0;
                const canPublishBatch =
                  item.status === "committed" &&
                  item.pendingValidCount === 0 &&
                  item.unresolvedCount === 0 &&
                  item.draftedCount > 0;
                return (
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
                        {item.rowCount} row · {item.draftedCount} draft · {item.pendingValidCount} siap draft · {item.unresolvedCount} perlu tindakan · {item.excludedCount} dihapus
                      </p>
                      {item.status === "committed" && hasPending ? (
                        <p className="mt-1 text-xs font-semibold text-amber-700">
                          Draft aman. Selesaikan baris pending sebelum Publish.
                        </p>
                      ) : null}
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

                      {item.status !== "published" && item.pendingValidCount > 0 ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(
                              () => commitPayslipImport(item.id),
                              `${item.pendingValidCount} baris valid dimasukkan ke draft. Baris error tetap aman di Perlu tindakan.`,
                              item.id,
                            )
                          }
                          className="rounded-xl bg-sky-700 px-3 py-2 text-sm font-bold text-white disabled:opacity-50"
                        >
                          Masukkan {item.pendingValidCount} valid ke draft
                        </button>
                      ) : null}

                      {item.status === "committed" && canPublish ? (
                        <button
                          type="button"
                          disabled={busy || !canPublishBatch}
                          onClick={() =>
                            void run(
                              () => publishPayslipImport(item.id),
                              "Batch dipublikasikan dan notifikasi pegawai dibuat.",
                              item.id,
                            )
                          }
                          className="rounded-xl bg-brand-primary px-3 py-2 text-sm font-bold text-white disabled:opacity-50"
                        >
                          Publish
                        </button>
                      ) : null}

                      {item.status === "committed" && canPublish && !canPublishBatch ? (
                        <span className="self-center text-xs font-semibold text-muted-foreground">
                          Publish terkunci: selesaikan {item.pendingValidCount + item.unresolvedCount} baris pending
                        </span>
                      ) : null}

                      {item.status === "committed" && !canPublish ? (
                        <span className="self-center text-xs font-semibold text-muted-foreground">
                          Menunggu akun dengan izin publish
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </AdminShell>
  );
}
