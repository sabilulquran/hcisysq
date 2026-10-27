// EMP-007 P2-2 worklist "Sertifikat akan berakhir" (spec
// docs/domain/employment-administration-package2.md §7.5). A certificate never
// expires by itself: the ones already past stay on the list until HC records a
// new one, which is why the window includes them.

import { useEffect, useState } from "react";

import { PaginationBar } from "@/components/PaginationBar";
import { AdminShell } from "@/layouts/AdminShell";
import { EmploymentApiError, formatDate, type EmploymentView } from "@/lib/employment";
import {
  VERIFICATION_STATUS_LABEL,
  getExpiringCertificates,
  type ExpiringCertificateList,
} from "@/lib/employeeProfile";

const WINDOWS = [30, 60, 90, 180];

function readQuery(): { withinDays: number; page: number } {
  const params = new URLSearchParams(window.location.search);
  const withinDays = Number(params.get("withinDays") ?? "60");
  const page = Number(params.get("page") ?? "1");
  return {
    withinDays: WINDOWS.includes(withinDays) ? withinDays : 60,
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

function hrefFor(withinDays: number, page = 1): string {
  const params = new URLSearchParams({ withinDays: String(withinDays) });
  if (page > 1) params.set("page", String(page));
  return `/admin/employees/certificates/expiring?${params.toString()}`;
}

function viewFrom(cause: unknown): EmploymentView<never> {
  if (cause instanceof EmploymentApiError) {
    if (cause.status === 403) return { kind: "forbidden" };
    return { kind: "error", message: cause.message };
  }
  return { kind: "error", message: "Daftar sertifikat tidak dapat dimuat. Periksa koneksi lalu coba lagi." };
}

export function AdminExpiringCertificatesPage() {
  const [{ withinDays, page }] = useState(readQuery);
  const [view, setView] = useState<EmploymentView<ExpiringCertificateList>>({ kind: "loading" });

  useEffect(() => {
    let mounted = true;
    void getExpiringCertificates({ withinDays, page })
      .then((data) => { if (mounted) setView({ kind: "ready", data }); })
      .catch((cause: unknown) => { if (mounted) setView(viewFrom(cause)); });
    return () => { mounted = false; };
  }, [withinDays, page]);

  return (
    <AdminShell
      active="expiring-certificates"
      title="Sertifikat Akan Berakhir"
      description="Sertifikat pegawai yang masa berlakunya segera habis, termasuk yang sudah lewat dan belum diperbarui."
    >
      <div className="mb-4 flex flex-wrap gap-2">
        {WINDOWS.map((option) => (
          <a
            key={option}
            href={hrefFor(option)}
            aria-current={option === withinDays ? "page" : undefined}
            className={`rounded-xl px-3 py-1.5 text-sm font-bold ${
              option === withinDays ? "bg-brand-primary-deep text-white" : "border border-border/70 text-muted-foreground"
            }`}
          >
            {option} hari
          </a>
        ))}
      </div>

      {view.kind === "loading" ? <p className="text-sm text-muted-foreground">Memuat data…</p> : null}
      {view.kind === "forbidden" ? (
        <p className="text-sm text-muted-foreground">Akun ini tidak berhak melihat data sertifikat pegawai.</p>
      ) : null}
      {view.kind === "error" ? <p role="alert" className="text-sm text-danger-ink">{view.message}</p> : null}
      {/* An empty page past the end is not an empty list: the total says so,
          and the pager has to stay or the operator is stranded there. */}
      {view.kind === "ready" && view.data.rows.length === 0 && view.data.total > 0 ? (
        <div className="rounded-2xl border border-border/70 p-4">
          <p className="text-sm text-muted-foreground">
            Halaman {view.data.page} kosong. Ada {view.data.total} sertifikat pada rentang ini.
          </p>
          <a className="mt-2 inline-block text-sm font-bold text-brand-primary-deep" href={hrefFor(withinDays)}>
            Kembali ke halaman pertama
          </a>
        </div>
      ) : null}
      {view.kind === "ready" ? (
        view.data.rows.length === 0 ? (
          view.data.total > 0 ? null : (
            <p className="text-sm text-muted-foreground">
              Tidak ada sertifikat yang berakhir dalam {view.data.withinDays} hari ke depan.
            </p>
          )
        ) : (
          <div className="overflow-hidden rounded-2xl border border-border/70">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Sertifikat yang akan berakhir</caption>
              <thead className="bg-surface text-xs uppercase text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3">Pegawai</th>
                  <th scope="col" className="px-4 py-3">Unit</th>
                  <th scope="col" className="px-4 py-3">Sertifikat</th>
                  <th scope="col" className="px-4 py-3">Berlaku sampai</th>
                  <th scope="col" className="px-4 py-3">Sisa</th>
                  <th scope="col" className="px-4 py-3">Verifikasi</th>
                </tr>
              </thead>
              <tbody>
                {view.data.rows.map((row) => (
                  <tr key={row.recordId} className="border-t border-border/70">
                    <td className="px-4 py-3">
                      <a className="font-bold text-brand-primary-deep" href={`/admin/employees/${row.employeeId}`}>
                        {row.fullName}
                      </a>
                      <span className="block text-xs text-muted-foreground">{row.employeeNumber}</span>
                    </td>
                    <td className="px-4 py-3">{row.unitName ?? "—"}</td>
                    <td className="px-4 py-3">
                      {row.name}
                      {row.issuer ? <span className="block text-xs text-muted-foreground">{row.issuer}</span> : null}
                    </td>
                    <td className="px-4 py-3">{formatDate(row.expiresOn)}</td>
                    <td className="px-4 py-3">
                      {row.expired ? (
                        <span className="rounded-full bg-warning-soft px-2 py-0.5 text-xs font-bold text-warning-ink">
                          Lewat {Math.abs(row.daysLeft)} hari
                        </span>
                      ) : (
                        `${row.daysLeft} hari`
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {VERIFICATION_STATUS_LABEL[row.verificationStatus]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {view.data.total > view.data.pageSize ? (
              <PaginationBar
                page={view.data.page}
                pageSize={view.data.pageSize}
                total={view.data.total}
                onPageChange={(next) => window.location.assign(hrefFor(withinDays, next))}
              />
            ) : null}
          </div>
        )
      ) : null}
    </AdminShell>
  );
}
