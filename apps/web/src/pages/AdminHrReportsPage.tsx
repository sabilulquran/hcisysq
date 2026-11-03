// RPT-001 Laporan HR: five HR reports, paged on screen and downloadable as CSV or XLSX by the
// report roles. Spec: docs/domain/hr-reports.md. The API decides scope, columns and export rights;
// this screen only shows what it is given.

import { Download, Loader2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import { PaginationBar } from "@/components/PaginationBar";
import { AdminShell } from "@/layouts/AdminShell";
import {
  currentMonthPeriod,
  downloadHrReport,
  exportAllowedFor,
  formatReportCell,
  getHrReportAccess,
  getHrReportPage,
  HrReportApiError,
  type EmployeeStatusFilter,
  type HrReportAccess,
  type HrReportFilters,
  type HrReportKey,
  type HrReportPage,
} from "@/lib/hrReports";

const STATUS_OPTIONS: Array<{ value: EmployeeStatusFilter; label: string }> = [
  { value: "active", label: "Aktif" },
  { value: "inactive", label: "Nonaktif" },
  { value: "resigned", label: "Berhenti" },
  { value: "all", label: "Semua status" },
];

const inputClass = "mt-1 h-11 w-full rounded-xl border bg-surface px-3 text-sm text-foreground";
const labelClass = "text-xs font-semibold text-muted-foreground";

export function ReportScopeNote({ access }: { access: HrReportAccess }) {
  const scope = access.scope.type === "organization"
    ? "seluruh organisasi"
    : `unit ${access.scope.units.map((unit) => unit.name).join(", ")}`;
  return (
    <div className="mb-5 rounded-2xl border border-border bg-surface p-4 text-sm leading-6 text-brand-heading" role="note">
      <p>Cakupan laporan Anda: <span className="font-bold">{scope}</span>.</p>
      <p className="text-xs text-muted-foreground">
        {access.canExport
          ? "Anda dapat mengunduh CSV atau XLSX. Setiap unduhan tercatat di audit."
          : "Peran Anda hanya untuk melihat. Unduhan dibuka oleh peran Pimpinan (Laporan)."}
        {" "}NIK, rekening, alamat, kontak, dan nominal gaji tidak dimuat di laporan ini.
      </p>
    </div>
  );
}

export function AdminHrReportsPage() {
  const [access, setAccess] = useState<HrReportAccess | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [report, setReport] = useState<HrReportKey>("employees");
  const [filters, setFilters] = useState<HrReportFilters>(() => ({ status: "active", ...currentMonthPeriod() }));
  const [draft, setDraft] = useState<HrReportFilters>(filters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [data, setData] = useState<HrReportPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"csv" | "xlsx" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getHrReportAccess().then(setAccess).catch((cause: unknown) => {
      if (cause instanceof HrReportApiError && cause.status === 403) setForbidden(true);
      else setError(cause instanceof Error ? cause.message : "Laporan tidak dapat dimuat.");
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!access) return;
    let current = true;
    setLoading(true);
    getHrReportPage(report, filters, page, pageSize)
      .then((result) => { if (current) { setData(result); setError(null); } })
      .catch((cause: unknown) => {
        if (!current) return;
        setData(null);
        setError(cause instanceof Error ? cause.message : "Laporan tidak dapat dimuat.");
      })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [access, report, filters, page, pageSize]);

  const definition = access?.reports.find((item) => item.key === report) ?? null;
  const exportable = access ? exportAllowedFor(access, filters.unitId) : false;
  const exportUnits = access?.exportScope?.type === "unit"
    ? access.filters.units.filter((unit) => access.exportScope?.unitIds.includes(unit.id)).map((unit) => unit.name)
    : [];

  const apply = (next: HrReportFilters) => {
    setPage(1);
    setFilters(next);
    setDraft(next);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    apply(draft);
  };
  const download = async (format: "csv" | "xlsx") => {
    setBusy(format);
    setError(null);
    try {
      await downloadHrReport(report, filters, format);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Laporan tidak dapat diunduh.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <AdminShell active="reports" title="Laporan HR" description="Daftar pegawai serta rekap cuti, lembur, perjalanan dinas, dan pelatihan.">
      {forbidden ? (
        <div className="rounded-2xl border border-border bg-surface p-5 text-sm leading-6 text-brand-heading" role="alert">
          <p className="font-bold">Laporan HR belum dapat dibuka dari akun ini</p>
          <p className="text-muted-foreground">
            Laporan dibuka oleh peran Pembaca Laporan (melihat) atau Pimpinan (Laporan) (melihat dan mengunduh), untuk seluruh
            organisasi atau satu unit. Minta pengelola akses meninjau peran akun ini bila Anda memerlukannya.
          </p>
        </div>
      ) : null}
      {error ? <div className="mb-5 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink" role="alert">{error}</div> : null}
      {access ? <ReportScopeNote access={access} /> : null}

      {access && definition ? (
        <section className="overflow-hidden rounded-3xl border border-border/75 bg-surface-raised shadow-[var(--shadow-soft)]">
          <div className="flex gap-2 overflow-x-auto border-b border-border/70 p-3" role="tablist" aria-label="Pilih laporan">
            {access.reports.map((item) => (
              <button key={item.key} type="button" role="tab" aria-selected={item.key === report}
                onClick={() => { setReport(item.key); setPage(1); }}
                className={`min-h-11 shrink-0 rounded-xl px-3 text-sm font-semibold ${item.key === report
                  ? "bg-brand-primary-pale text-brand-primary-deep" : "text-muted-foreground hover:bg-muted/70"}`}>
                {item.title}
              </button>
            ))}
          </div>

          <form onSubmit={submit} className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-4">
            <label className={labelClass}>
              Unit
              <select value={filters.unitId ?? ""} onChange={(event) => apply({ ...draft, unitId: event.target.value || undefined })} className={inputClass}>
                <option value="">{access.scope.type === "organization" ? "Semua unit" : "Semua unit dalam cakupan"}</option>
                {access.filters.units.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
              </select>
            </label>
            {definition.period ? (
              <>
                <label className={labelClass}>
                  Dari tanggal
                  <input type="date" required value={draft.from ?? ""} onChange={(event) => setDraft({ ...draft, from: event.target.value })} className={inputClass} />
                </label>
                <label className={labelClass}>
                  Sampai tanggal
                  <input type="date" required value={draft.to ?? ""} onChange={(event) => setDraft({ ...draft, to: event.target.value })} className={inputClass} />
                </label>
              </>
            ) : (
              <>
                <label className={labelClass}>
                  Status
                  <select value={filters.status ?? "active"} onChange={(event) => apply({ ...draft, status: event.target.value as EmployeeStatusFilter })} className={inputClass}>
                    {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
                <label className={labelClass}>
                  Jenis kepegawaian
                  <select value={filters.employmentType ?? ""} onChange={(event) => apply({ ...draft, employmentType: event.target.value || undefined })} className={inputClass}>
                    <option value="">Semua jenis</option>
                    {access.filters.employmentTypes.map((type) => <option key={type} value={type}>{type}</option>)}
                  </select>
                </label>
              </>
            )}
            <label className={labelClass}>
              Cari nama atau NIP
              <input type="search" maxLength={100} value={draft.q ?? ""} onChange={(event) => setDraft({ ...draft, q: event.target.value || undefined })}
                className={inputClass} placeholder="Hanya untuk layar, tidak untuk unduhan" />
            </label>
            <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-4">
              <button type="submit" className="min-h-11 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground">Tampilkan</button>
              {access.canExport && !exportable ? (
                <span className="text-[11px] text-muted-foreground">
                  Unduhan akun Anda hanya untuk unit {exportUnits.join(", ")}. Pilih unit tersebut untuk mengunduh.
                </span>
              ) : null}
              {exportable ? (
                <>
                  {(["xlsx", "csv"] as const).map((format) => (
                    <button key={format} type="button" disabled={busy !== null || loading || !data?.pagination.total}
                      onClick={() => void download(format)}
                      className="inline-flex min-h-11 items-center gap-2 rounded-xl border px-4 text-sm font-bold text-brand-heading disabled:opacity-50">
                      {busy === format ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Download className="h-4 w-4" aria-hidden="true" />}
                      Unduh {format.toUpperCase()}
                    </button>
                  ))}
                  <span className="text-[11px] text-muted-foreground">
                    Unduhan memakai filter di atas tanpa pencarian nama, paling banyak {access.limits.exportRowLimit.toLocaleString("id-ID")} baris.
                  </span>
                </>
              ) : null}
            </div>
          </form>

          {loading ? (
            <div className="flex items-center gap-2 border-t border-border/70 px-5 py-8 text-sm text-muted-foreground" role="status">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Memuat laporan...
            </div>
          ) : !data || data.items.length === 0 ? (
            <p className="border-t border-border/70 px-5 py-8 text-sm text-muted-foreground">Tidak ada data pada filter ini.</p>
          ) : (
            <div className="overflow-x-auto border-t border-border/70">
              <table className="min-w-full text-left text-sm">
                <caption className="sr-only">{data.title}</caption>
                <thead className="bg-surface text-xs text-muted-foreground">
                  <tr>
                    {data.columns.map((column) => (
                      <th key={column.key} scope="col" className={`whitespace-nowrap px-4 py-2 font-semibold ${column.kind === "number" ? "text-right" : ""}`}>
                        {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/70">
                  {data.items.map((row) => (
                    <tr key={row.rowId}>
                      {data.columns.map((column) => (
                        <td key={column.key} className={`whitespace-nowrap px-4 py-2 ${column.kind === "number" ? "text-right tabular-nums" : ""}`}>
                          {formatReportCell(column, row[column.key])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data && data.pagination.total > 0 ? (
            <PaginationBar page={data.pagination.page} pageSize={data.pagination.pageSize} total={data.pagination.total}
              onPageChange={setPage} onPageSizeChange={(size) => { setPage(1); setPageSize(size); }} />
          ) : null}
        </section>
      ) : null}
    </AdminShell>
  );
}
