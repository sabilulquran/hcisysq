// EMP-011 §10: Pegawai → Dokumen Pegawai, the HC worklist. "Akan berakhir" holds VERIFIED
// documents of active employees expiring within the window, including those already past (D-15);
// "Menunggu verifikasi" holds employee proposals (D-06). Each read is audited by the API.

import { useEffect, useState } from "react";

import { PaginationBar } from "@/components/PaginationBar";
import { AdminShell } from "@/layouts/AdminShell";
import { formatDate } from "@/lib/employment";
import {
  EmployeeDocumentApiError,
  getExpiringDocuments,
  getPendingDocuments,
  type ExpiringItem,
  type Pagination,
  type PendingItem,
} from "@/lib/employeeDocuments";

const WINDOWS = [30, 60, 90, 180];
type Tab = "expiring" | "pending";

type View<T> =
  | { kind: "loading" }
  | { kind: "forbidden" }
  | { kind: "error"; message: string }
  | { kind: "ready"; items: T[]; pagination: Pagination };

function readQuery(): { tab: Tab; withinDays: number; page: number } {
  const params = new URLSearchParams(window.location.search);
  const withinDays = Number(params.get("withinDays") ?? "60");
  const page = Number(params.get("page") ?? "1");
  return {
    tab: params.get("view") === "pending" ? "pending" : "expiring",
    withinDays: WINDOWS.includes(withinDays) ? withinDays : 60,
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

function hrefFor(tab: Tab, withinDays: number, page = 1) {
  const params = new URLSearchParams({ view: tab });
  if (tab === "expiring") params.set("withinDays", String(withinDays));
  if (page > 1) params.set("page", String(page));
  return `/admin/employee-documents?${params.toString()}`;
}

function failed(cause: unknown): View<never> {
  if (cause instanceof EmployeeDocumentApiError && cause.status === 403) return { kind: "forbidden" };
  return { kind: "error", message: cause instanceof Error ? cause.message : "Daftar tidak dapat dimuat. Periksa koneksi lalu coba lagi." };
}

const tabClass = (active: boolean) =>
  `rounded-xl px-3 py-1.5 text-sm font-bold ${active ? "bg-brand-primary-deep text-white" : "border border-border/70 text-muted-foreground"}`;

export function AdminEmployeeDocumentsPage() {
  const [{ tab, withinDays, page }] = useState(readQuery);
  const [expiring, setExpiring] = useState<View<ExpiringItem>>({ kind: "loading" });
  const [pending, setPending] = useState<View<PendingItem>>({ kind: "loading" });

  useEffect(() => {
    let mounted = true;
    if (tab === "expiring") {
      void getExpiringDocuments({ withinDays, page })
        .then((data) => { if (mounted) setExpiring({ kind: "ready", items: data.items, pagination: data.pagination }); })
        .catch((cause: unknown) => { if (mounted) setExpiring(failed(cause)); });
    } else {
      void getPendingDocuments(page)
        .then((data) => { if (mounted) setPending({ kind: "ready", items: data.items, pagination: data.pagination }); })
        .catch((cause: unknown) => { if (mounted) setPending(failed(cause)); });
    }
    return () => { mounted = false; };
  }, [tab, withinDays, page]);

  const view = tab === "expiring" ? expiring : pending;

  return (
    <AdminShell
      active="employee-documents"
      title="Dokumen Pegawai"
      description="Dokumen pribadi pegawai yang segera berakhir dan unggahan pegawai yang menunggu verifikasi."
    >
      <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Daftar kerja dokumen">
        <a role="tab" aria-selected={tab === "expiring"} href={hrefFor("expiring", withinDays)} className={tabClass(tab === "expiring")}>Akan berakhir</a>
        <a role="tab" aria-selected={tab === "pending"} href={hrefFor("pending", withinDays)} className={tabClass(tab === "pending")}>Menunggu verifikasi</a>
      </div>
      {tab === "expiring" ? (
        <div className="mb-4 flex flex-wrap gap-2">
          {WINDOWS.map((option) => (
            <a
              key={option}
              href={hrefFor("expiring", option)}
              aria-current={option === withinDays ? "page" : undefined}
              className={`rounded-xl px-3 py-1 text-xs font-bold ${option === withinDays ? "bg-brand-primary-pale text-brand-primary-deep" : "border border-border/70 text-muted-foreground"}`}
            >
              {option} hari
            </a>
          ))}
        </div>
      ) : null}

      {view.kind === "loading" ? <p className="text-sm text-muted-foreground">Memuat data…</p> : null}
      {view.kind === "forbidden" ? <p className="text-sm text-muted-foreground">Akun ini tidak berhak membuka arsip dokumen pegawai.</p> : null}
      {view.kind === "error" ? <p role="alert" className="text-sm text-danger-ink">{view.message}</p> : null}
      {view.kind === "ready" && view.items.length === 0 ? (
        <div className="rounded-2xl border border-border/70 p-4 text-sm text-muted-foreground">
          {view.pagination.total > 0 ? (
            <>Halaman {view.pagination.page} kosong. <a className="font-bold text-brand-primary-deep" href={hrefFor(tab, withinDays)}>Kembali ke halaman pertama</a></>
          ) : tab === "expiring" ? `Tidak ada dokumen yang berakhir dalam ${withinDays} hari ke depan.` : "Tidak ada unggahan pegawai yang menunggu verifikasi."}
        </div>
      ) : null}

      {view.kind === "ready" && view.items.length > 0 ? (
        <div className="overflow-x-auto rounded-2xl border border-border/70">
          <table className="w-full min-w-[640px] text-left text-sm">
            <caption className="sr-only">{tab === "expiring" ? "Dokumen yang akan berakhir" : "Unggahan yang menunggu verifikasi"}</caption>
            <thead className="bg-surface text-xs uppercase text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-3">Pegawai</th>
                <th scope="col" className="px-4 py-3">Unit</th>
                <th scope="col" className="px-4 py-3">Dokumen</th>
                <th scope="col" className="px-4 py-3">{tab === "expiring" ? "Berlaku sampai" : "Diunggah"}</th>
                {tab === "expiring" ? <th scope="col" className="px-4 py-3">Sisa</th> : null}
              </tr>
            </thead>
            <tbody>
              {view.items.map((row) => (
                <tr key={row.id} className="border-t border-border/70">
                  <td className="px-4 py-3">
                    <a className="font-bold text-brand-primary-deep" href={`/admin/employees/${row.employeeId}?tab=dokumen`}>{row.fullName}</a>
                    <span className="block text-xs text-muted-foreground">{row.employeeNumber}</span>
                  </td>
                  <td className="px-4 py-3">{row.unitName ?? "—"}</td>
                  <td className="px-4 py-3">{row.typeLabel}{row.title ? <span className="block text-xs text-muted-foreground">{row.title}</span> : null}</td>
                  {"expiresOn" in row ? (
                    <>
                      <td className="px-4 py-3">{formatDate(row.expiresOn)}</td>
                      <td className="px-4 py-3">
                        {row.expired ? (
                          <span className="rounded-full bg-danger-soft px-2 py-0.5 text-xs font-bold text-danger-ink">Lewat {Math.abs(row.daysLeft)} hari</span>
                        ) : `${row.daysLeft} hari`}
                      </td>
                    </>
                  ) : (
                    <td className="px-4 py-3">
                      {new Date(row.createdAt).toLocaleDateString("id-ID")}
                      {row.replacesDocumentId ? <span className="block text-xs text-muted-foreground">mengganti dokumen lama</span> : null}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {view.pagination.total > view.pagination.pageSize ? (
            <PaginationBar
              page={view.pagination.page}
              pageSize={view.pagination.pageSize}
              total={view.pagination.total}
              onPageChange={(next) => window.location.assign(hrefFor(tab, withinDays, next))}
            />
          ) : null}
        </div>
      ) : null}
    </AdminShell>
  );
}
