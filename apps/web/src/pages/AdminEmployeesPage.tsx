import { Search } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { AdminShell } from "@/layouts/AdminShell";
import {
  AdminApiError,
  listEmployees,
  type AdminEmployeeListResponse,
  type EmployeeStatus,
} from "@/lib/adminEmployees";

function statusLabel(status: EmployeeStatus) {
  if (status === "active") return "Aktif";
  if (status === "resigned") return "Keluar";
  return "Tidak aktif";
}

function statusClass(status: EmployeeStatus) {
  if (status === "active") return "bg-success-soft text-success-ink";
  if (status === "resigned") return "bg-warning-soft text-warning-ink";
  return "bg-muted text-foreground";
}

export function AdminEmployeesPage() {
  const [data, setData] = useState<AdminEmployeeListResponse | null>(null);
  const [draftQuery, setDraftQuery] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<EmployeeStatus | "">("");
  const [unitId, setUnitId] = useState("");
  const [positionId, setPositionId] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    void listEmployees({ page, pageSize: 25, q: query, status, unitId, positionId })
      .then((result) => {
        if (mounted) setData(result);
      })
      .catch((cause: unknown) => {
        if (!mounted) return;
        setError(
          cause instanceof AdminApiError
            ? cause.message
            : "Daftar pegawai tidak dapat dimuat.",
        );
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [page, positionId, query, status, unitId]);

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setPage(1);
    setQuery(draftQuery.trim());
  };

  const summary = data?.summary ?? { total: 0, active: 0, inactive: 0, resigned: 0 };

  return (
    <AdminShell
      active="employees"
      title="Data Pegawai"
      description="Employee master read-only. Gunakan pencarian dan filter untuk review data hasil import; detail pegawai dipakai untuk reporting line dan kesiapan account."
    >
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          ["Total", summary.total],
          ["Aktif", summary.active],
          ["Tidak aktif", summary.inactive],
          ["Keluar", summary.resigned],
        ].map(([label, value]) => (
          <article key={String(label)} className="rounded-2xl border border-border/70 bg-surface-raised p-4 shadow-[var(--shadow-soft)]">
            <p className="text-xs font-semibold text-muted-foreground">{label}</p>
            <p className="mt-1 text-2xl font-bold text-brand-heading">{value}</p>
          </article>
        ))}
      </section>

      <section className="mt-5 rounded-2xl border border-border/70 bg-surface-raised p-4 shadow-[var(--shadow-soft)]">
        <form onSubmit={submitSearch} className="grid gap-3 lg:grid-cols-[minmax(14rem,1.3fr)_repeat(3,minmax(10rem,0.7fr))_auto]">
          <label className="relative block">
            <span className="sr-only">Cari pegawai</span>
            <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <input
              value={draftQuery}
              onChange={(event) => setDraftQuery(event.target.value)}
              placeholder="Cari NIP, nama, atau email"
              className="h-10 w-full rounded-xl border border-border bg-surface pl-9 pr-3 text-sm outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/15"
            />
          </label>

          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as EmployeeStatus | "");
              setPage(1);
            }}
            className="h-10 rounded-xl border border-border bg-surface px-3 text-sm outline-none focus:border-brand-primary"
          >
            <option value="">Semua status</option>
            <option value="active">Aktif</option>
            <option value="inactive">Tidak aktif</option>
            <option value="resigned">Keluar</option>
          </select>

          <select
            value={unitId}
            onChange={(event) => {
              setUnitId(event.target.value);
              setPage(1);
            }}
            className="h-10 min-w-0 rounded-xl border border-border bg-surface px-3 text-sm outline-none focus:border-brand-primary"
          >
            <option value="">Semua unit</option>
            {data?.filters.units.map((unit) => (
              <option key={unit.id} value={unit.id}>{unit.name}</option>
            ))}
          </select>

          <select
            value={positionId}
            onChange={(event) => {
              setPositionId(event.target.value);
              setPage(1);
            }}
            className="h-10 min-w-0 rounded-xl border border-border bg-surface px-3 text-sm outline-none focus:border-brand-primary"
          >
            <option value="">Semua jabatan</option>
            {data?.filters.positions.map((position) => (
              <option key={position.id} value={position.id}>{position.name}</option>
            ))}
          </select>

          <button type="submit" className="h-10 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground hover:bg-brand-primary-deep">
            Cari
          </button>
        </form>
      </section>

      <section className="mt-4 overflow-hidden rounded-2xl border border-border/70 bg-surface-raised shadow-[var(--shadow-soft)]">
        {error ? (
          <div className="p-6 text-sm text-destructive">{error}</div>
        ) : loading ? (
          <div className="p-8 text-center text-sm text-muted-foreground">Memuat data pegawai...</div>
        ) : data?.items.length ? (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] border-collapse text-left text-sm">
                <thead className="bg-surface text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-semibold">NIP</th>
                    <th className="px-4 py-3 font-semibold">Nama</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold">Unit</th>
                    <th className="px-4 py-3 font-semibold">Jabatan</th>
                    <th className="px-4 py-3 font-semibold">Email</th>
                    <th className="px-4 py-3 font-semibold">TMT</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/70">
                  {data.items.map((employee) => (
                    <tr key={employee.id} className="hover:bg-surface/70">
                      <td className="whitespace-nowrap px-4 py-3 font-semibold text-foreground">{employee.employeeNumber}</td>
                      <td className="px-4 py-3">
                        <a href={`/admin/employees/${employee.id}`} className="font-semibold text-brand-primary-deep hover:underline">
                          {employee.fullName}
                        </a>
                        <p className="mt-0.5 text-xs text-muted-foreground">{employee.employmentStatus ?? "—"}</p>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-bold ${statusClass(employee.status)}`}>
                          {statusLabel(employee.status)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{employee.unitName ?? "—"}</td>
                      <td className="px-4 py-3 text-muted-foreground">{employee.positionName ?? "—"}</td>
                      <td className="px-4 py-3 text-muted-foreground">{employee.email ?? "—"}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{employee.startedOn ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-col gap-3 border-t border-border/70 px-4 py-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
              <span>
                Halaman {data.pagination.page} dari {data.pagination.pageCount} · {data.pagination.total} hasil
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  className="h-9 rounded-xl border border-border bg-surface-raised px-3 font-semibold text-foreground disabled:opacity-40"
                >
                  Sebelumnya
                </button>
                <button
                  type="button"
                  disabled={page >= data.pagination.pageCount}
                  onClick={() => setPage((current) => current + 1)}
                  className="h-9 rounded-xl border border-border bg-surface-raised px-3 font-semibold text-foreground disabled:opacity-40"
                >
                  Berikutnya
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="p-10 text-center">
            <p className="text-sm font-semibold text-foreground">Belum ada pegawai yang cocok.</p>
            <p className="mt-1 text-sm text-muted-foreground">Jika database masih kosong, mulai dari menu Impor Pegawai.</p>
          </div>
        )}
      </section>
    </AdminShell>
  );
}
