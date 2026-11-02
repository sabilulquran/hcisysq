// TRIP-001 Human Capital surface: the business travel register, the surat tugas, and
// cancellation. Spec: docs/domain/business-travel.md. The API authorizes every call.

import { Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";

import { EmployeeSearchField, type PickedEmployee } from "@/components/attendance/workforce/EmployeeSearchField";
import { PaginationBar } from "@/components/PaginationBar";
import { TripDetailPanel } from "@/components/trips/TripDetailPanel";
import { AdminShell } from "@/layouts/AdminShell";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import {
  cancelTripAsHc,
  formatTripRange,
  getAdminTrip,
  getAdminTrips,
  issueTripLetter,
  TRIP_STATUS_LABELS,
  TripApiError,
  tripStatusLabel,
  type Pagination,
  type TripDetail,
  type TripStatus,
  type TripSummary,
} from "@/lib/trips";
import type { AuthSession } from "@/types/hcis";

export function AdminTripsPage() {
  const [items, setItems] = useState<TripSummary[]>([]);
  const [paging, setPaging] = useState<Pagination | null>(null);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<TripStatus | "">("APPROVED");
  const [employee, setEmployee] = useState<PickedEmployee | null>(null);
  const [selected, setSelected] = useState<TripDetail | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Issuing and cancelling need trips.manage; reading the register needs trips.read only.
  const canManage = hasPermission(session, "trips.manage");
  // The employee search reads the employee register, which trips.read alone does not open.
  const canSearchEmployees = hasPermission(session, "employees.manage");

  const load = async () => {
    setLoading(true);
    try {
      const result = await getAdminTrips({ page, status, employeeId: employee?.id });
      setItems(result.items);
      setPaging(result.pagination);
      setError(null);
    } catch (cause) {
      if (cause instanceof TripApiError && cause.status === 403) setForbidden(true);
      setError(cause instanceof Error ? cause.message : "Register perjalanan dinas tidak dapat dimuat.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, status, employee?.id]);
  useEffect(() => {
    void getCurrentSession().then(setSession).catch(() => {
      setSession(null);
      setError("Izin akun tidak dapat dibaca, sehingga tombol tindakan disembunyikan. Muat ulang halaman.");
    });
  }, []);

  const open = async (id: string) => {
    try {
      setSelected(await getAdminTrip(id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Perjalanan dinas tidak dapat dibuka.");
    }
  };

  const run = async (action: () => Promise<string>, trip: TripDetail) => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      setNotice(await action());
      await Promise.all([load(), open(trip.id)]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Tindakan belum dapat diselesaikan.");
    } finally {
      setBusy(false);
    }
  };

  const issue = (trip: TripDetail) => void run(async () => {
    const result = await issueTripLetter(trip.id);
    return `Surat tugas ${result.documentNumber} terbit.`;
  }, trip);

  const cancel = (trip: TripDetail) => {
    const reason = window.prompt(trip.status === "ISSUED"
      ? "Alasan pembatalan (minimal 10 karakter). Surat tugas akan dicabut dan nomornya tetap terpakai."
      : "Alasan pembatalan (minimal 10 karakter)");
    if (!reason || reason.trim().length < 10) return;
    void run(async () => {
      await cancelTripAsHc(trip.id, reason.trim());
      return "Perjalanan dinas dibatalkan.";
    }, trip);
  };

  return (
    <AdminShell active="services" title="Perjalanan Dinas" description="Register perjalanan dinas pegawai dan penerbitan surat tugas.">
      {error ? <div className="mb-5 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink print:hidden">{error}</div> : null}
      {notice ? <div className="mb-5 rounded-2xl border border-border bg-surface p-4 text-sm text-brand-heading print:hidden">{notice}</div> : null}

      {forbidden ? null : (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <section className="overflow-hidden rounded-3xl border border-border/75 bg-surface-raised shadow-[var(--shadow-soft)] print:hidden">
            <div className="grid gap-3 p-5 sm:grid-cols-2">
              <label className="text-xs font-semibold text-muted-foreground">
                Status
                <select value={status} onChange={(event) => { setPage(1); setStatus(event.target.value as TripStatus | ""); }}
                  className="mt-1 h-11 w-full rounded-xl border bg-surface px-3 text-sm text-foreground">
                  <option value="">Semua status</option>
                  {(Object.keys(TRIP_STATUS_LABELS) as TripStatus[]).map((key) => <option key={key} value={key}>{TRIP_STATUS_LABELS[key]}</option>)}
                </select>
              </label>
              {canSearchEmployees ? (
                <EmployeeSearchField value={employee} onChange={(next) => { setPage(1); setEmployee(next); }} />
              ) : null}
            </div>

            {loading ? (
              <div className="flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat register...</div>
            ) : items.length === 0 ? (
              <p className="px-5 py-8 text-sm text-muted-foreground">Tidak ada perjalanan dinas pada filter ini.</p>
            ) : (
              <ul className="divide-y divide-border/70 border-t border-border/70">
                {items.map((trip) => (
                  <li key={trip.id}>
                    <button type="button" onClick={() => void open(trip.id)}
                      className={`w-full px-5 py-3 text-left hover:bg-muted/50 ${selected?.id === trip.id ? "bg-muted/60" : ""}`}>
                      <span className="block font-semibold text-brand-heading">{trip.employeeName} · {trip.destination}</span>
                      <span className="block text-xs text-muted-foreground">
                        {trip.employeeNumber}{trip.unitName ? ` · ${trip.unitName}` : ""} · {formatTripRange(trip.startOn, trip.endOn)}
                      </span>
                      <span className="mt-1 block text-[11px] font-semibold text-muted-foreground">
                        {tripStatusLabel(trip.status)}
                        {trip.currentApproverName ? ` · menunggu ${trip.currentApproverName}` : ""}
                        {trip.documentNumber ? ` · ${trip.documentNumber}` : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {paging && paging.total > 0 ? (
              <PaginationBar page={paging.page} pageSize={paging.pageSize} total={paging.total} onPageChange={setPage} />
            ) : null}
          </section>

          <section className="rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)] print:border-0 print:shadow-none">
            {selected ? (
              <>
                <div className="flex justify-end print:hidden">
                  <button type="button" aria-label="Tutup detail" onClick={() => setSelected(null)} className="rounded-lg p-1 hover:bg-muted">
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <TripDetailPanel
                  trip={selected}
                  actions={canManage ? (
                    <>
                      {selected.status === "APPROVED" ? (
                        <button type="button" disabled={busy} onClick={() => issue(selected)}
                          className="min-h-11 rounded-xl bg-brand-primary px-3 text-sm font-bold text-brand-foreground disabled:opacity-50">
                          Terbitkan surat tugas
                        </button>
                      ) : null}
                      {["IN_REVIEW", "APPROVED", "ISSUED"].includes(selected.status) ? (
                        <button type="button" disabled={busy} onClick={() => cancel(selected)}
                          className="min-h-11 rounded-xl border border-danger-line px-3 text-sm font-bold text-danger-ink disabled:opacity-50">
                          Batalkan perjalanan
                        </button>
                      ) : null}
                    </>
                  ) : null}
                />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Pilih perjalanan untuk melihat tahap persetujuan dan riwayatnya. Perjalanan yang sudah disetujui
                menunggu surat tugas dari Human Capital.
              </p>
            )}
          </section>
        </div>
      )}
    </AdminShell>
  );
}
