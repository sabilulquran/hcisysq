import { AlertTriangle, CalendarPlus, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { PaginationBar } from "@/components/PaginationBar";
import { AdminShell } from "@/layouts/AdminShell";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import {
  createPayrollPeriod,
  listPayrollPeriods,
  payrollStateLabel,
  PayrollApiError,
  type PayrollPeriod,
} from "@/lib/payroll";
import type { AuthSession } from "@/types/hcis";

/**
 * The month after the newest period, which is the one an operator usually wants.
 * Returned as YYYY-MM for the month input; the request sends its first day.
 */
function nextMonthAfter(periods: readonly PayrollPeriod[]): string {
  const newest = periods[0]?.periodMonth;
  const base = newest ? new Date(`${newest}T00:00:00Z`) : new Date();
  const year = base.getUTCFullYear();
  const month = base.getUTCMonth() + (newest ? 1 : 0);
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 7);
}

function monthLabel(periodMonth: string): string {
  const date = new Date(`${periodMonth}T00:00:00Z`);
  return date.toLocaleDateString("id-ID", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function AdminPayrollPage() {
  const navigate = useNavigate();
  const [session, setSession] = useState<AuthSession | null>(null);
  const [periods, setPeriods] = useState<PayrollPeriod[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newMonth, setNewMonth] = useState("");

  const canManagePeriods = hasPermission(session, "payroll.periods.manage");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listPayrollPeriods({ page, pageSize });
      setPeriods(data.periods);
      setTotal(data.total);
      setNewMonth((current) => current || nextMonthAfter(data.periods));
    } catch (cause) {
      setError(cause instanceof PayrollApiError ? cause.message : "Daftar periode gagal dimuat.");
    } finally {
      setLoading(false);
    }
  }, [page, pageSize]);

  useEffect(() => {
    let active = true;
    void getCurrentSession().then((value) => {
      if (active) setSession(value);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate() {
    if (!newMonth) return;
    setCreating(true);
    setError(null);
    try {
      // The month input gives YYYY-MM; a period is named by its first day.
      const { period } = await createPayrollPeriod({ periodMonth: `${newMonth}-01` });
      await navigate({ to: "/admin/payroll/$periodId", params: { periodId: period.id } });
    } catch (cause) {
      setError(cause instanceof PayrollApiError ? cause.message : "Periode gagal dibuat.");
      setCreating(false);
    }
  }

  return (
    <AdminShell active="payroll" title="Payroll" description="Periode gaji: hitung, tinjau, sahkan, bayar, terbitkan slip.">
      <div className="space-y-6">
        {error ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <p>{error}</p>
          </div>
        ) : null}

        {canManagePeriods ? (
          <section className="rounded-lg border bg-card p-4">
            <h2 className="text-sm font-semibold">Buat periode</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Jendela cutoff dan tanggal gajian memakai default kebijakan; keduanya dapat diubah setelah periode dibuat.
            </p>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="text-sm">
                <span className="mb-1 block text-muted-foreground">Bulan periode</span>
                <input
                  type="month"
                  value={newMonth}
                  onChange={(event) => setNewMonth(event.target.value)}
                  className="h-9 rounded-md border bg-background px-3 text-sm"
                />
              </label>
              <button
                type="button"
                onClick={() => void handleCreate()}
                disabled={creating || !newMonth}
                className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {creating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CalendarPlus className="h-4 w-4" aria-hidden />}
                Buat periode
              </button>
            </div>
          </section>
        ) : null}

        <section className="rounded-lg border bg-card">
          <header className="border-b px-4 py-3">
            <h2 className="text-sm font-semibold">Periode</h2>
          </header>

          {loading ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">Memuat periode…</p>
          ) : periods.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">
              Belum ada periode payroll. Buat periode untuk bulan yang akan dibayarkan.
            </p>
          ) : (
            <ul className="divide-y">
              {periods.map((period) => (
                <li key={period.id}>
                  <button
                    type="button"
                    onClick={() => void navigate({ to: "/admin/payroll/$periodId", params: { periodId: period.id } })}
                    className="flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <span>
                      <span className="block text-sm font-medium">{monthLabel(period.periodMonth)}</span>
                      <span className="block text-xs text-muted-foreground">
                        Tanggal gajian {period.payDate} · cutoff {period.cutoffStart} s.d. {period.cutoffEnd}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="rounded-full border px-2 py-0.5">{payrollStateLabel(period.state)}</span>
                      <span className="text-muted-foreground">{period.resultCount} pegawai</span>
                      {period.blockerCount > 0 ? (
                        <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-destructive">
                          {period.blockerCount} blocker
                        </span>
                      ) : null}
                      {period.resultCount > 0 && !period.hasCurrentCalculation ? (
                        <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-400">
                          perlu hitung ulang
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {total > 0 ? (
            <div className="border-t px-4 py-3">
              <PaginationBar
                page={page}
                pageSize={pageSize}
                total={total}
                onPageChange={setPage}
                onPageSizeChange={(next) => {
                  setPageSize(next);
                  setPage(1);
                }}
              />
            </div>
          ) : null}
        </section>
      </div>
    </AdminShell>
  );
}
