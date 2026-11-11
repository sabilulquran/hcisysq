import { Search } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { AdminShell } from "@/layouts/AdminShell";
import {
  AdminApiError,
  listEmployees,
  outsideHcisBadgeLabel,
  type AdminEmployeeListItem,
  type AdminEmployeeListResponse,
  type EmployeeManagementScopeFilter,
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

const SCOPE_OPTIONS: Array<[EmployeeManagementScopeFilter, string]> = [
  ["MANAGED", "Dikelola HCIS"],
  ["OUTSIDE_HCIS", "Di luar pengelolaan HCIS"],
  ["ALL", "Semua data"],
];

/**
 * EMP-005 S2B §13.9: which population the list shows. The default is the one
 * HCIS manages; "Di luar pengelolaan HCIS" finds the BUMY staff and Pengurus
 * Yayasan records, which are kept but read-only.
 */
export function ManagementScopeFilter({
  value,
  onChange,
}: {
  value: EmployeeManagementScopeFilter;
  onChange: (scope: EmployeeManagementScopeFilter) => void;
}) {
  return (
    <select
      aria-label="Cakupan pengelolaan"
      value={value}
      onChange={(event) => onChange(event.target.value as EmployeeManagementScopeFilter)}
      className="h-10 min-w-0 rounded-xl border border-border bg-surface px-3 text-sm outline-none focus:border-brand-primary"
    >
      {SCOPE_OPTIONS.map(([scope, label]) => (
        <option key={scope} value={scope}>{label}</option>
      ))}
    </select>
  );
}

/** One table row. A marked record carries the grey §13.9 badge beside its status. */
export function EmployeeListRow({ employee }: { employee: AdminEmployeeListItem }) {
  const outside = outsideHcisBadgeLabel(employee);
  return (
    <tr className="hover:bg-surface/70">
      <td className="whitespace-nowrap px-4 py-3 font-semibold text-foreground">{employee.employeeNumber}</td>
      <td className="px-4 py-3">
        <a href={`/admin/employees/${employee.id}`} className="font-semibold text-brand-primary-deep hover:underline">
          {employee.fullName}
        </a>
        <p className="mt-0.5 text-xs text-muted-foreground">{employee.employmentStatus ?? "—"}</p>
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1.5">
          <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-bold ${statusClass(employee.status)}`}>
            {statusLabel(employee.status)}
          </span>
          {outside ? (
            <span className="inline-flex rounded-full bg-muted px-2.5 py-1 text-xs font-bold text-muted-foreground">
              {outside}
            </span>
          ) : null}
        </div>
      </td>
      <td className="px-4 py-3 text-muted-foreground">{employee.unitName ?? "—"}</td>
      <td className="px-4 py-3 text-muted-foreground">{employee.positionName ?? "—"}</td>
      <td className="px-4 py-3 text-muted-foreground">{employee.email ?? "—"}</td>
      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{employee.startedOn ?? "—"}</td>
    </tr>
  );
}

/** Empty list. With the "outside" filter the import hint would mislead, so it says what the filter holds. */
export function EmployeeListEmpty({ scope }: { scope: EmployeeManagementScopeFilter }) {
  if (scope === "OUTSIDE_HCIS") {
    return (
      <div className="p-10 text-center">
        <p className="text-sm font-semibold text-foreground">Tidak ada data di luar pengelolaan HCIS yang cocok.</p>
        <p className="mt-1 text-sm text-muted-foreground">Staf BUMY dan Pengurus Yayasan yang sudah ditandai HC muncul di sini.</p>
      </div>
    );
  }
  return (
    <div className="p-10 text-center">
      <p className="text-sm font-semibold text-foreground">Belum ada pegawai yang cocok.</p>
      <p className="mt-1 text-sm text-muted-foreground">Jika database masih kosong, mulai dari menu Impor Pegawai.</p>
    </div>
  );
}

export function AdminEmployeesPage() {
  const [data, setData] = useState<AdminEmployeeListResponse | null>(null);
  const [draftQuery, setDraftQuery] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<EmployeeStatus | "">("");
  const [unitId, setUnitId] = useState("");
  const [positionId, setPositionId] = useState("");
  // EMP-005 S2B §8.7: marked records are hidden unless HC asks for them.
  const [scope, setScope] = useState<EmployeeManagementScopeFilter>("MANAGED");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    void listEmployees({ page, pageSize: 25, q: query, status, unitId, positionId, scope })
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
    // scope belongs here: without it the "Di luar pengelolaan HCIS" filter changed
    // nothing until another filter or the page moved.
  }, [page, positionId, query, scope, status, unitId]);

  const changeScope = (next: EmployeeManagementScopeFilter) => {
    setScope(next);
    setPage(1);
  };

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setPage(1);
    setQuery(draftQuery.trim());
  };

  const summary = data?.summary ?? { total: 0, active: 0, inactive: 0, resigned: 0, outsideHcis: 0 };

  return (
    <AdminShell
      active="employees"
      title="Data Pegawai"
      description="Employee master read-only. Gunakan pencarian dan filter untuk review data hasil import; detail pegawai dipakai untuk reporting line dan kesiapan account."
    >
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[
          // "Total" counts the population HCIS manages; the marked records
          // have their own tile so the difference is never a silent one.
          ["Dikelola HCIS", summary.total],
          ["Aktif", summary.active],
          ["Tidak aktif", summary.inactive],
          ["Keluar", summary.resigned],
        ].map(([label, value]) => (
          <article key={String(label)} className="rounded-2xl border border-border/70 bg-surface-raised p-4 shadow-[var(--shadow-soft)]">
            <p className="text-xs font-semibold text-muted-foreground">{label}</p>
            <p className="mt-1 text-2xl font-bold text-brand-heading">{value}</p>
          </article>
        ))}
        {/* The marked records' tile doubles as the way into the filter. */}
        <button
          type="button"
          onClick={() => changeScope("OUTSIDE_HCIS")}
          aria-pressed={scope === "OUTSIDE_HCIS"}
          className={`rounded-2xl border bg-surface-raised p-4 text-left shadow-[var(--shadow-soft)] hover:border-brand-primary ${
            scope === "OUTSIDE_HCIS" ? "border-brand-primary" : "border-border/70"
          }`}
        >
          <span className="block text-xs font-semibold text-muted-foreground">Di luar pengelolaan HCIS</span>
          <span className="mt-1 block text-2xl font-bold text-brand-heading">{summary.outsideHcis}</span>
        </button>
      </section>

      <section className="mt-5 rounded-2xl border border-border/70 bg-surface-raised p-4 shadow-[var(--shadow-soft)]">
        <form onSubmit={submitSearch} className="grid gap-3 lg:grid-cols-[minmax(14rem,1.3fr)_repeat(4,minmax(9rem,0.7fr))_auto]">
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

          <ManagementScopeFilter value={scope} onChange={changeScope} />

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

      {scope === "OUTSIDE_HCIS" ? (
        <p role="status" className="mt-4 rounded-2xl border border-border/70 bg-muted px-4 py-3 text-sm text-muted-foreground">
          Data di luar pengelolaan HCIS hanya dapat dibaca. Riwayat cuti, kehadiran, dan slip tetap terlihat di detail masing-masing.
        </p>
      ) : null}

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
                    <EmployeeListRow key={employee.id} employee={employee} />
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
          <EmployeeListEmpty scope={scope} />
        )}
      </section>
    </AdminShell>
  );
}
