// ORG-001: layar HC untuk menetapkan atasan langsung banyak pegawai sekaligus.
//
// Ia tinggal di Struktur Organisasi, bukan di menu baru, karena di sinilah
// cakupan reporting line dibaca dan dari sinilah ORG-004 menghitung siapa
// menyetujui siapa. Izin membukanya (`organization.manage`) dan izin menulisnya
// (`approvals.policy.manage`) dipegang peran yang sama — Kepala HC — sedangkan
// layar Daftar Pegawai menuntut `employees.manage` yang justru tidak dipegang
// Kepala HC.
//
// Tidak ada jalan pintas: unggah berkas -> dry-run -> baca tabel -> konfirmasi.

import { AlertTriangle, CheckCircle2, Download, Upload, UsersRound } from "lucide-react";
import { useState, type FormEvent } from "react";

import { AdminApiError } from "@/lib/adminEmployees";
import { hasPermission } from "@/lib/authorization";
import {
  applyManagerAssignments,
  managerAssignmentOutcomeLabel,
  managerAssignmentPersonLabel,
  MANAGER_ASSIGNMENT_CSV_TEMPLATE,
  previewManagerAssignments,
  type ManagerAssignmentApplyResult,
  type ManagerAssignmentPreview,
  type ManagerAssignmentPreviewRow,
} from "@/lib/managerAssignments";
import { cn } from "@/lib/utils";
import type { AuthSession } from "@/types/hcis";

function SummaryCard({ label, value, tone }: { label: string; value: number; tone: "neutral" | "good" | "warn" | "error" }) {
  return (
    <div
      className={cn(
        "rounded-xl px-4 py-3",
        tone === "good" && "bg-success-soft text-success-ink",
        tone === "warn" && "bg-warning-soft text-warning-ink",
        tone === "error" && "bg-danger-soft text-danger-ink",
        tone === "neutral" && "bg-surface text-foreground",
      )}
    >
      <p className="text-xs font-semibold opacity-70">{label}</p>
      <p className="mt-1 text-xl font-bold">{value}</p>
    </div>
  );
}

function OutcomeBadge({ row }: { row: ManagerAssignmentPreviewRow }) {
  return (
    <span
      className={cn(
        "rounded-full px-2.5 py-1 text-xs font-bold",
        row.outcome === "change" && "bg-brand-primary-pale text-brand-primary-deep",
        row.outcome === "unchanged" && "bg-muted text-muted-foreground",
        row.outcome === "refused" && "bg-danger-soft text-danger-ink",
      )}
    >
      {managerAssignmentOutcomeLabel(row.outcome)}
    </span>
  );
}

/** Tiga hasil dry-run dalam satu tabel: tidak berubah, akan berubah (lama -> baru), ditolak. */
export function ManagerAssignmentPreviewTable({ rows }: { rows: ManagerAssignmentPreviewRow[] }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border/70 bg-surface-raised shadow-[var(--shadow-soft)]">
      <div className="max-h-[34rem] overflow-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="sticky top-0 bg-surface text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-semibold">Baris</th>
              <th className="px-4 py-3 font-semibold">Pegawai</th>
              <th className="px-4 py-3 font-semibold">Hasil</th>
              <th className="px-4 py-3 font-semibold">Atasan</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/70">
            {rows.map((row) => (
              <tr key={row.rowNumber}>
                <td className="px-4 py-3 font-semibold">{row.rowNumber}</td>
                <td className="px-4 py-3">
                  <p className="font-semibold text-foreground">{row.employeeName ?? "—"}</p>
                  <p className="text-xs text-muted-foreground">{row.employeeNumber}</p>
                </td>
                <td className="px-4 py-3"><OutcomeBadge row={row} /></td>
                <td className="px-4 py-3 text-xs">
                  {row.outcome === "refused" ? (
                    <p className="text-danger-ink">
                      <strong>{row.code}</strong> · {row.message}
                    </p>
                  ) : row.outcome === "unchanged" ? (
                    <p className="text-muted-foreground">{managerAssignmentPersonLabel(row.toManager)}</p>
                  ) : (
                    <p className="text-foreground">
                      {managerAssignmentPersonLabel(row.fromManager)}
                      <span className="px-1.5 text-muted-foreground" aria-label="menjadi">→</span>
                      {managerAssignmentPersonLabel(row.toManager)}
                    </p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">Berkas tidak memuat baris data.</p>
        ) : null}
      </div>
    </section>
  );
}

export function OrganizationManagerBulkTab({ session }: { session: AuthSession | null }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ManagerAssignmentPreview | null>(null);
  const [applied, setApplied] = useState<ManagerAssignmentApplyResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canApply = hasPermission(session, "approvals.policy.manage");

  const reset = (next: File | null) => {
    setFile(next);
    setPreview(null);
    setApplied(null);
    setError(null);
  };

  const handlePreview = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) return;
    setPreviewing(true);
    setError(null);
    setPreview(null);
    setApplied(null);
    try {
      setPreview(await previewManagerAssignments(file));
    } catch (cause) {
      setError(cause instanceof AdminApiError ? cause.message : "Berkas tidak dapat diperiksa.");
    } finally {
      setPreviewing(false);
    }
  };

  const handleApply = async () => {
    if (!file || !preview || !preview.applicable || applied) return;
    setApplying(true);
    setError(null);
    try {
      setApplied(await applyManagerAssignments(file, preview.previewToken));
    } catch (cause) {
      setError(
        cause instanceof AdminApiError
          ? cause.message
          : "Penetapan atasan langsung tidak dapat diterapkan.",
      );
      // Preview lama tidak boleh dipakai lagi sesudah penolakan apa pun.
      setPreview(null);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
        <div className="flex gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-primary-pale text-brand-primary-deep">
            <UsersRound className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-sm font-bold text-brand-heading">Atasan langsung dari berkas</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Berkas CSV dengan dua kolom: <strong>NIP</strong> dan <strong>NIP ATASAN</strong>. Dikunci pada NIP, tidak pada nama,
              karena nama tidak unik. Isi <strong>-</strong> pada NIP ATASAN bila atasan langsung memang ingin dikosongkan; sel yang
              dibiarkan kosong ditolak. Pemeriksaan selalu dijalankan lebih dulu dan tidak menulis apa pun.
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <form onSubmit={handlePreview} className="flex w-full flex-col gap-3 sm:flex-row sm:items-end">
            <label className="block w-full">
              <span className="mb-2 block text-sm font-bold text-foreground">Berkas atasan langsung (.csv)</span>
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => reset(event.target.files?.[0] ?? null)}
                className="block w-full rounded-xl border border-border bg-surface p-2 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-primary-pale file:px-3 file:py-2 file:text-xs file:font-bold file:text-brand-primary-deep"
              />
            </label>
            <button
              type="submit"
              disabled={!file || previewing}
              className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl bg-brand-primary px-5 text-sm font-bold text-brand-foreground hover:bg-brand-primary-deep disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Upload className="h-4 w-4" aria-hidden="true" />
              {previewing ? "Memeriksa..." : "Periksa berkas"}
            </button>
          </form>
          <a
            href={`data:text/csv;charset=utf-8,${encodeURIComponent(MANAGER_ASSIGNMENT_CSV_TEMPLATE)}`}
            download="template-atasan-langsung.csv"
            className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl border border-brand-primary/30 bg-surface-raised px-4 text-sm font-bold text-brand-primary-deep"
          >
            <Download className="h-4 w-4" aria-hidden="true" />
            Template CSV
          </a>
        </div>

        {!canApply ? (
          <p className="mt-4 rounded-xl bg-warning-soft px-3 py-2 text-xs font-bold text-warning-ink">
            Account ini dapat memeriksa berkas, tetapi penetapan atasan langsung dijalankan oleh pemegang kewenangan persetujuan.
          </p>
        ) : null}
      </section>

      {error ? (
        <div role="alert" className="flex gap-3 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <p>{error}</p>
        </div>
      ) : null}

      {applied ? (
        <div role="status" className="flex gap-3 rounded-2xl border border-success-line bg-success-soft p-4 text-sm text-success-ink">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <p>
            {applied.appliedCount} atasan langsung diperbarui, {applied.unchangedCount} baris memang sudah sesuai. Catatan audit
            batch: {applied.batchId}.
          </p>
        </div>
      ) : null}

      {preview ? (
        <>
          <section className="rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
            <p className="text-sm font-bold text-brand-heading">{preview.sourceFilename}</p>
            <p className="mt-1 text-xs text-muted-foreground">Checksum SHA-256: {preview.checksumSha256.slice(0, 16)}…</p>

            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <SummaryCard label="Baris" value={preview.rowCount} tone="neutral" />
              <SummaryCard label="Akan berubah" value={preview.changeCount} tone="good" />
              <SummaryCard label="Tidak berubah" value={preview.unchangedCount} tone="neutral" />
              <SummaryCard label="Ditolak" value={preview.refusedCount} tone="error" />
            </div>

            <div className="mt-5 flex flex-col gap-3 rounded-2xl border border-border/70 bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs leading-5 text-muted-foreground">
                {preview.applicable
                  ? "Belum ada perubahan tersimpan. Konfirmasi menerapkan seluruh berkas sekaligus dalam satu transaksi."
                  : "Satu baris yang ditolak membatalkan seluruh berkas. Perbaiki berkasnya, lalu periksa ulang."}
              </p>
              <button
                type="button"
                onClick={() => void handleApply()}
                disabled={!preview.applicable || !canApply || applying || Boolean(applied)}
                className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl bg-brand-primary px-5 text-sm font-bold text-brand-foreground hover:bg-brand-primary-deep disabled:cursor-not-allowed disabled:opacity-50"
              >
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                {applying ? "Menerapkan..." : applied ? "Sudah diterapkan" : "Konfirmasi penetapan"}
              </button>
            </div>
          </section>

          <ManagerAssignmentPreviewTable rows={preview.rows} />
        </>
      ) : null}
    </div>
  );
}
