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
import { useEffect, useMemo, useRef, useState } from "react";

import { AdminShell } from "@/layouts/AdminShell";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import {
  bulkCorrectPayslipImportRows,
  bulkExcludePayslipImportRows,
  commitPayslipImport,
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
type RowEdit = { employeeNumber: string; period: string };

function sourceFormatLabel(value: PayslipSourceFormat) {
  if (value === "tetap") return "Tetap";
  if (value === "honorer") return "Honorer";
  return "Generic";
}

function csvCell(value: string | number | null) {
  const text = value === null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function parseCsvLine(line: string) {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

function rowStatusLabel(row: PayslipImportRow) {
  if (row.resolutionStatus === "drafted") return "Masuk draft";
  if (row.resolutionStatus === "excluded") return "Dihapus";
  return row.errors.length > 0 ? "Perlu tindakan" : "Siap draft";
}

function rowStatusClass(row: PayslipImportRow) {
  if (row.resolutionStatus === "drafted") return "bg-emerald-100 text-emerald-800";
  if (row.resolutionStatus === "excluded") return "bg-slate-200 text-slate-700";
  if (row.errors.length > 0) return "bg-amber-100 text-amber-800";
  return "bg-sky-100 text-sky-800";
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
  const [rowEdits, setRowEdits] = useState<Record<number, RowEdit>>({});
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [bulkPeriod, setBulkPeriod] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const correctionFileInputRef = useRef<HTMLInputElement | null>(null);

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
    setSelectedRows(new Set());
    setBulkPeriod("");
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
  const selectablePageRows = pagedRows.filter((row) => row.resolutionStatus === "pending");
  const pageFullySelected =
    selectablePageRows.length > 0 &&
    selectablePageRows.every((row) => selectedRows.has(row.rowNumber));

  const changedCorrections = useMemo(() => {
    if (!review) return [];
    return review.rows.flatMap((row) => {
      if (row.resolutionStatus !== "pending") return [];
      const edit = rowEdits[row.rowNumber];
      if (!edit) return [];
      const changed =
        edit.employeeNumber.trim() !== row.employeeNumber ||
        edit.period !== (row.period ?? "");
      if (!changed || !edit.employeeNumber.trim() || !edit.period) return [];
      return [{
        rowNumber: row.rowNumber,
        employeeNumber: edit.employeeNumber.trim(),
        period: edit.period,
      }];
    });
  }, [review, rowEdits]);

  const downloadCorrections = () => {
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
    anchor.download = `payslip-corrections-${review.id}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const saveCorrections = async (
    corrections: Array<{ rowNumber: number; employeeNumber: string; period: string }>,
    success: string,
  ) => {
    if (!review || corrections.length === 0) return;
    await run(async () => {
      for (let offset = 0; offset < corrections.length; offset += 500) {
        await bulkCorrectPayslipImportRows(review.id, corrections.slice(offset, offset + 500));
      }
    }, success, review.id);
  };

  const uploadCorrectionFile = async (selectedFile: File) => {
    if (!review) return;
    try {
      const text = (await selectedFile.text()).replace(/^\uFEFF/, "");
      const lines = text.split(/\r?\n/).filter((line) => line.trim());
      if (lines.length < 2) throw new Error("File koreksi tidak memiliki data.");
      const headers = parseCsvLine(lines[0]).map((value) => value.trim().toLowerCase());
      const rowIndex = headers.indexOf("row");
      const employeeIndex = headers.indexOf("employee_number");
      const periodIndex = headers.indexOf("period");
      if (rowIndex < 0 || employeeIndex < 0 || periodIndex < 0) {
        throw new Error("Header koreksi wajib memuat row, employee_number, period.");
      }
      const pendingNumbers = new Set(
        review.rows.filter((row) => row.resolutionStatus === "pending").map((row) => row.rowNumber),
      );
      const corrections = lines.slice(1).map((line) => {
        const values = parseCsvLine(line);
        return {
          rowNumber: Number(values[rowIndex]),
          employeeNumber: (values[employeeIndex] ?? "").trim(),
          period: (values[periodIndex] ?? "").trim(),
        };
      }).filter((row) =>
        Number.isInteger(row.rowNumber) &&
        pendingNumbers.has(row.rowNumber) &&
        row.employeeNumber.length > 0 &&
        /^\d{4}-(0[1-9]|1[0-2])$/.test(row.period),
      );
      if (corrections.length === 0) {
        throw new Error("Tidak ada baris koreksi pending yang valid di file tersebut.");
      }
      await saveCorrections(corrections, `${corrections.length} baris dari CSV koreksi sudah direvalidasi.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "CSV koreksi tidak dapat diproses.");
    } finally {
      if (correctionFileInputRef.current) correctionFileInputRef.current.value = "";
    }
  };

  const applyPeriodToSelected = () => {
    if (!bulkPeriod || selectedRows.size === 0) {
      setError("Pilih baris dan periode terlebih dahulu.");
      return;
    }
    setRowEdits((current) => {
      const next = { ...current };
      selectedRows.forEach((rowNumber) => {
        const currentRow = next[rowNumber];
        if (currentRow) next[rowNumber] = { ...currentRow, period: bulkPeriod };
      });
      return next;
    });
    setNotice(`Periode ${bulkPeriod} diterapkan ke ${selectedRows.size} baris. Klik Simpan semua perubahan untuk revalidasi.`);
    setError(null);
  };

  const excludeSelected = async () => {
    if (!review || selectedRows.size === 0) return;
    const rowNumbers = [...selectedRows];
    if (!window.confirm(
      `Hapus ${rowNumbers.length} baris terpilih dari batch? Baris tidak ikut slip gaji, tetapi jejak audit tetap disimpan.`,
    )) return;
    await run(async () => {
      for (let offset = 0; offset < rowNumbers.length; offset += 500) {
        await bulkExcludePayslipImportRows(review.id, rowNumbers.slice(offset, offset + 500));
      }
    }, `${rowNumbers.length} baris dihapus dari batch.`, review.id);
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
                <div className="rounded-xl bg-muted/40 p-3"><strong className="block text-brand-heading">Generic</strong><span>employee_number, period, lines_json</span></div>
                <div className="rounded-xl bg-muted/40 p-3"><strong className="block text-brand-heading">Tetap</strong><span>Gaji Pokok, Total Bruto, Gaji Neto, dan komponen terkait.</span></div>
                <div className="rounded-xl bg-muted/40 p-3"><strong className="block text-brand-heading">Honorer</strong><span>Value Honor/Transport, Total Penghasilan, Gaji Neto, dan komponen terkait.</span></div>
              </div>
            </div>
            <div className="space-y-3 rounded-2xl border border-border bg-surface/50 p-4">
              <div>
                <p className="text-xs font-bold text-brand-heading">File CSV</p>
                <input ref={fileInputRef} type="file" accept=".csv,text/csv" onChange={(event) => setFile(event.target.files?.[0] ?? null)} className="sr-only" />
                <button type="button" onClick={() => fileInputRef.current?.click()} className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-brand-primary/40 bg-white px-4 py-3 text-sm font-bold text-brand-primary-deep shadow-sm transition hover:bg-brand-primary-pale">
                  <FileUp className="h-4 w-4" /> Pilih file CSV
                </button>
                <p className="mt-2 break-all rounded-lg bg-white px-3 py-2 text-xs text-muted-foreground">{file?.name ?? "Belum ada file dipilih"}</p>
              </div>
              <label className="block text-xs font-bold text-brand-heading">
                Periode fallback untuk format lama
                <input type="month" value={fallbackPeriod} onChange={(event) => setFallbackPeriod(event.target.value)} className="mt-2 w-full rounded-xl border border-border bg-white px-3 py-2 text-sm font-normal" />
              </label>
              <p className="text-[11px] leading-5 text-muted-foreground">Opsional. Dipakai bila CSV tetap/honorer tidak memiliki kolom TANGGAL.</p>
              <button type="button" disabled={!file || busy} onClick={() => file && void run(() => previewPayslipImport(file, fallbackPeriod || undefined), "Preview disimpan. Baris valid siap dimasukkan ke draft; baris error dapat diperbaiki dari Review.")} className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand-primary px-4 py-2.5 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Preview CSV
              </button>
            </div>
          </div>
        </section>

        {error ? <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</div> : null}
        {notice ? <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">{notice}</div> : null}

        {review ? (
          <section className="overflow-hidden rounded-2xl border border-border bg-white shadow-[var(--shadow-soft)]">
            <div className="border-b border-border px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-bold text-brand-heading">Perbaikan batch · {review.sourceFilename}</h2>
                    <span className="rounded-full bg-brand-primary-pale px-2.5 py-1 text-[10px] font-bold text-brand-primary-deep">{sourceFormatLabel(review.sourceFormat)}</span>
                    <span className="rounded-full bg-muted px-2.5 py-1 text-[10px] font-bold uppercase">{review.status}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">Fokus layar ini adalah NIP, periode, dan validation issue. Nominal payroll tetap read-only dan disembunyikan sampai dibuka.</p>
                </div>
                <button type="button" onClick={() => setReview(null)} className="rounded-xl border border-border px-3 py-2 text-xs font-bold">Tutup</button>
              </div>

              <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-xl bg-emerald-50 p-3"><p className="text-[11px] font-bold uppercase text-emerald-700">Masuk draft</p><p className="mt-1 text-xl font-extrabold text-emerald-900">{review.draftedCount}</p></div>
                <div className="rounded-xl bg-sky-50 p-3"><p className="text-[11px] font-bold uppercase text-sky-700">Siap draft</p><p className="mt-1 text-xl font-extrabold text-sky-900">{review.pendingValidCount}</p></div>
                <div className="rounded-xl bg-amber-50 p-3"><p className="text-[11px] font-bold uppercase text-amber-700">Perlu tindakan</p><p className="mt-1 text-xl font-extrabold text-amber-900">{review.unresolvedCount}</p></div>
                <div className="rounded-xl bg-slate-100 p-3"><p className="text-[11px] font-bold uppercase text-slate-600">Dihapus</p><p className="mt-1 text-xl font-extrabold text-slate-900">{review.excludedCount}</p></div>
              </div>

              {review.unresolvedCount > 0 ? (
                <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-amber-900">{review.unresolvedCount} baris perlu keputusan sebelum Publish.</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {errorSummary.map(([message, count]) => <span key={message} className="rounded-full bg-white px-2.5 py-1 text-[11px] font-semibold text-amber-900">{count} × {message}</span>)}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="mt-4 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-800"><CheckCircle2 className="h-4 w-4" /> Tidak ada baris yang masih perlu tindakan.</div>
              )}

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex gap-2">
                  <button type="button" onClick={() => { setReviewFilter("errors"); setReviewPage(1); setSelectedRows(new Set()); }} className={`rounded-xl px-3 py-2 text-xs font-bold ${reviewFilter === "errors" ? "bg-brand-primary text-white" : "border border-border bg-white"}`}>Perlu tindakan ({review.unresolvedCount})</button>
                  <button type="button" onClick={() => { setReviewFilter("all"); setReviewPage(1); setSelectedRows(new Set()); }} className={`rounded-xl px-3 py-2 text-xs font-bold ${reviewFilter === "all" ? "bg-brand-primary text-white" : "border border-border bg-white"}`}>Semua ({review.rowCount})</button>
                </div>
                {errorRows.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={downloadCorrections} className="inline-flex items-center gap-2 rounded-xl border border-border bg-white px-3 py-2 text-xs font-bold"><Download className="h-4 w-4" /> Unduh CSV koreksi</button>
                    <input ref={correctionFileInputRef} type="file" accept=".csv,text/csv" className="sr-only" onChange={(event) => event.target.files?.[0] && void uploadCorrectionFile(event.target.files[0])} />
                    <button type="button" disabled={busy} onClick={() => correctionFileInputRef.current?.click()} className="inline-flex items-center gap-2 rounded-xl border border-brand-primary/30 bg-white px-3 py-2 text-xs font-bold text-brand-primary-deep disabled:opacity-50"><Upload className="h-4 w-4" /> Unggah CSV koreksi</button>
                  </div>
                ) : null}
              </div>

              <div className="mt-4 rounded-xl border border-border bg-surface/60 p-3">
                <div className="flex flex-wrap items-end gap-2">
                  <div className="mr-auto">
                    <p className="text-xs font-bold text-brand-heading">Aksi massal</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{selectedRows.size} baris dipilih · {changedCorrections.length} perubahan belum disimpan</p>
                  </div>
                  <label className="text-[11px] font-bold text-muted-foreground">
                    Set periode terpilih
                    <input type="month" value={bulkPeriod} onChange={(event) => setBulkPeriod(event.target.value)} className="mt-1 block rounded-lg border border-border bg-white px-2.5 py-2 text-xs font-normal text-brand-heading" />
                  </label>
                  <button type="button" disabled={selectedRows.size === 0 || !bulkPeriod || busy} onClick={applyPeriodToSelected} className="rounded-lg border border-border bg-white px-3 py-2 text-xs font-bold disabled:opacity-40">Terapkan periode</button>
                  <button type="button" disabled={changedCorrections.length === 0 || busy} onClick={() => void saveCorrections(changedCorrections, `${changedCorrections.length} perubahan sudah direvalidasi.`)} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-primary px-3 py-2 text-xs font-bold text-white disabled:opacity-40"><Save className="h-3.5 w-3.5" /> Simpan semua perubahan</button>
                  <button type="button" disabled={selectedRows.size === 0 || busy} onClick={() => void excludeSelected()} className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-2 text-xs font-bold text-red-700 disabled:opacity-40"><Trash2 className="h-3.5 w-3.5" /> Hapus terpilih</button>
                </div>
              </div>
            </div>

            <div className="max-h-[38rem] overflow-auto">
              <table className="w-full min-w-[62rem] table-fixed text-left text-sm">
                <thead className="sticky top-0 z-10 bg-surface text-[11px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="w-12 px-3 py-2.5">
                      <input
                        type="checkbox"
                        aria-label="Pilih semua baris pada halaman"
                        checked={pageFullySelected}
                        onChange={(event) => {
                          setSelectedRows((current) => {
                            const next = new Set(current);
                            selectablePageRows.forEach((row) => event.target.checked ? next.add(row.rowNumber) : next.delete(row.rowNumber));
                            return next;
                          });
                        }}
                      />
                    </th>
                    <th className="w-16 px-3 py-2.5">Row</th>
                    <th className="w-28 px-3 py-2.5">Status</th>
                    <th className="w-52 px-3 py-2.5">NIP / Pegawai</th>
                    <th className="w-40 px-3 py-2.5">Periode</th>
                    <th className="px-3 py-2.5">Masalah</th>
                    <th className="w-44 px-3 py-2.5">Data sumber</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {pagedRows.map((row) => {
                    const editable = row.resolutionStatus === "pending";
                    const edit = rowEdits[row.rowNumber] ?? { employeeNumber: row.employeeNumber, period: row.period ?? "" };
                    return (
                      <tr key={row.rowNumber} className={row.errors.length > 0 && row.resolutionStatus === "pending" ? "bg-amber-50/30" : undefined}>
                        <td className="px-3 py-2.5 align-top">
                          {editable ? <input type="checkbox" checked={selectedRows.has(row.rowNumber)} aria-label={`Pilih row ${row.rowNumber}`} onChange={(event) => setSelectedRows((current) => { const next = new Set(current); event.target.checked ? next.add(row.rowNumber) : next.delete(row.rowNumber); return next; })} /> : null}
                        </td>
                        <td className="px-3 py-2.5 align-top font-semibold">{row.rowNumber}</td>
                        <td className="px-3 py-2.5 align-top"><span className={`inline-flex rounded-full px-2 py-1 text-[10px] font-bold ${rowStatusClass(row)}`}>{rowStatusLabel(row)}</span></td>
                        <td className="px-3 py-2.5 align-top">
                          {editable ? <input value={edit.employeeNumber} onChange={(event) => setRowEdits((current) => ({ ...current, [row.rowNumber]: { ...edit, employeeNumber: event.target.value } }))} className="w-full rounded-lg border border-border bg-white px-2.5 py-1.5 text-xs" aria-label={`NIP row ${row.rowNumber}`} /> : <span className="font-semibold">{row.employeeNumber || "—"}</span>}
                        </td>
                        <td className="px-3 py-2.5 align-top">
                          {editable ? <input type="month" value={edit.period} onChange={(event) => setRowEdits((current) => ({ ...current, [row.rowNumber]: { ...edit, period: event.target.value } }))} className="w-full rounded-lg border border-border bg-white px-2.5 py-1.5 text-xs" aria-label={`Periode row ${row.rowNumber}`} /> : row.period?.slice(0, 7) ?? "—"}
                        </td>
                        <td className="px-3 py-2.5 align-top">
                          {row.errors.length === 0 ? <span className="text-xs font-semibold text-emerald-700">{row.resolutionStatus === "drafted" ? "Sudah masuk draft" : row.resolutionStatus === "excluded" ? "Dihapus dari batch" : "Valid"}</span> : <div className="space-y-1">{row.errors.map((message) => <div key={message} className="rounded-md bg-red-50 px-2 py-1 text-[11px] font-medium leading-4 text-red-700">{message}</div>)}</div>}
                        </td>
                        <td className="px-3 py-2.5 align-top">
                          {row.lines?.length ? (
                            <details className="text-xs">
                              <summary className="cursor-pointer font-semibold text-brand-primary-deep">Lihat {row.lines.length} komponen</summary>
                              <div className="mt-2 max-h-44 space-y-1 overflow-auto rounded-lg border border-border bg-white p-2">
                                {row.lines.map((line, index) => <div key={`${line.label}-${index}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 text-[11px]"><span className="text-muted-foreground">{line.label}</span><strong className="break-all text-right">{line.value}</strong></div>)}
                              </div>
                            </details>
                          ) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {pagedRows.length === 0 ? <div className="p-8 text-center text-sm text-muted-foreground">Tidak ada baris pada filter ini.</div> : null}
            </div>

            {visibleRows.length > reviewPageSize ? (
              <div className="flex items-center justify-between border-t border-border px-5 py-3 text-xs">
                <span className="text-muted-foreground">Menampilkan {(safePage - 1) * reviewPageSize + 1}–{Math.min(safePage * reviewPageSize, visibleRows.length)} dari {visibleRows.length} baris</span>
                <div className="flex gap-2">
                  <button type="button" disabled={safePage <= 1} onClick={() => { setReviewPage((value) => Math.max(1, value - 1)); setSelectedRows(new Set()); }} className="rounded-lg border border-border px-3 py-1.5 font-bold disabled:opacity-40">Sebelumnya</button>
                  <button type="button" disabled={safePage >= pageCount} onClick={() => { setReviewPage((value) => Math.min(pageCount, value + 1)); setSelectedRows(new Set()); }} className="rounded-lg border border-border px-3 py-1.5 font-bold disabled:opacity-40">Berikutnya</button>
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        <section className="overflow-hidden rounded-2xl border border-border bg-white shadow-[var(--shadow-soft)]">
          <div className="border-b border-border px-5 py-4">
            <h2 className="text-base font-bold text-brand-heading">Riwayat batch</h2>
            <p className="mt-1 text-xs text-muted-foreground">Baris valid boleh masuk draft lebih dulu. Slip baru terlihat pegawai setelah semua baris diselesaikan dan batch dipublish.</p>
          </div>
          {items === null ? (
            <div className="flex min-h-40 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>
          ) : items.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Belum ada batch payslip.</div>
          ) : (
            <div className="divide-y divide-border">
              {items.map((item) => {
                const hasPending = item.pendingValidCount > 0 || item.unresolvedCount > 0;
                const canPublishBatch = item.status === "committed" && item.pendingValidCount === 0 && item.unresolvedCount === 0 && item.draftedCount > 0;
                return (
                  <div key={item.id} className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <FileCheck2 className="h-4 w-4 text-brand-primary" />
                        <p className="font-bold">{item.sourceFilename}</p>
                        <span className="rounded-full bg-brand-primary-pale px-2 py-1 text-[10px] font-bold text-brand-primary-deep">{sourceFormatLabel(item.sourceFormat)}</span>
                        <span className="rounded-full bg-muted px-2 py-1 text-[11px] font-bold uppercase tracking-wide">{item.status}</span>
                      </div>
                      <p className="mt-2 text-sm text-muted-foreground">{item.rowCount} row · {item.draftedCount} draft · {item.pendingValidCount} siap draft · {item.unresolvedCount} perlu tindakan · {item.excludedCount} dihapus</p>
                      {item.status === "committed" && hasPending ? <p className="mt-1 text-xs font-semibold text-amber-700">Draft aman. Selesaikan baris pending sebelum Publish.</p> : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" disabled={busy} onClick={() => void openReview(item.id)} className="inline-flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm font-bold disabled:opacity-50"><Eye className="h-4 w-4" /> Review</button>
                      {item.status !== "published" && item.pendingValidCount > 0 ? <button type="button" disabled={busy} onClick={() => void run(() => commitPayslipImport(item.id), `${item.pendingValidCount} baris valid dimasukkan ke draft. Baris error tetap aman di Perlu tindakan.`, item.id)} className="rounded-xl bg-sky-700 px-3 py-2 text-sm font-bold text-white disabled:opacity-50">Masukkan {item.pendingValidCount} valid ke draft</button> : null}
                      {item.status === "committed" && canPublish ? <button type="button" disabled={busy || !canPublishBatch} onClick={() => void run(() => publishPayslipImport(item.id), "Batch dipublikasikan dan notifikasi pegawai dibuat.", item.id)} className="rounded-xl bg-brand-primary px-3 py-2 text-sm font-bold text-white disabled:opacity-50">Publish</button> : null}
                      {item.status === "committed" && canPublish && !canPublishBatch ? <span className="self-center text-xs font-semibold text-muted-foreground">Publish terkunci: selesaikan {item.pendingValidCount + item.unresolvedCount} baris pending</span> : null}
                      {item.status === "committed" && !canPublish ? <span className="self-center text-xs font-semibold text-muted-foreground">Menunggu akun dengan izin publish</span> : null}
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
