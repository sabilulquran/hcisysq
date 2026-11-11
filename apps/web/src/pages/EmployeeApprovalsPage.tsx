import {
  CheckCircle2,
  HandCoins,
  Loader2,
  Plane,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ArrangementApprovalsSection } from "@/components/arrangements/ArrangementApprovalsSection";
import { ProposeAlternativeDates } from "@/components/leave/ProposeAlternativeDates";
import { PaginationBar } from "@/components/PaginationBar";
import { AppShell } from "@/layouts/AppShell";
import {
  decideLeaveApproval,
  EmployeeLeaveApiError,
  getEmployeeLeaveSummary,
  getLeaveApprovalInbox,
  type EmployeeLeaveSummary,
  type LeaveApprovalInboxItem,
} from "@/lib/employeeLeave";
import {
  approverRoleLabel,
  decideTripApproval,
  formatTripRange,
  getTripApprovals,
  type Pagination,
  type TripApprovalItem,
} from "@/lib/trips";
import {
  decideLoanApproval,
  formatRupiah,
  getLoanApprovals,
  type LoanApprovalItem,
} from "@/lib/loans";

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Jakarta",
  }).format(new Date(`${value}T00:00:00+07:00`));
}

export function EmployeeApprovalsPage() {
  const [summary, setSummary] = useState<EmployeeLeaveSummary | null>(null);
  const [items, setItems] = useState<LeaveApprovalInboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [trips, setTrips] = useState<TripApprovalItem[]>([]);
  const [tripPaging, setTripPaging] = useState<Pagination | null>(null);
  const [tripPage, setTripPage] = useState(1);
  const [tripError, setTripError] = useState<string | null>(null);

  // TRIP-001: business trips use the same APR-001 snapshot, in their own queue, so a
  // failure there never hides the leave queue.
  const loadTrips = async (page = tripPage) => {
    try {
      const result = await getTripApprovals(page);
      setTrips(result.items);
      setTripPaging(result.pagination);
      setTripError(null);
    } catch (cause) {
      setTripError(cause instanceof Error ? cause.message : "Antrean perjalanan dinas tidak dapat dimuat.");
    }
  };

  const [loans, setLoans] = useState<LoanApprovalItem[]>([]);
  const [loanPaging, setLoanPaging] = useState<Pagination | null>(null);
  const [loanPage, setLoanPage] = useState(1);
  const [loanError, setLoanError] = useState<string | null>(null);

  // LOAN-001: loans use the same APR-001 snapshot in their own queue. The approver sees the
  // amount and tenor they decide on; the API sends nothing else of the loan.
  const loadLoans = async (page = loanPage) => {
    try {
      const result = await getLoanApprovals(page);
      setLoans(result.items);
      setLoanPaging(result.pagination);
      setLoanError(null);
    } catch (cause) {
      setLoanError(cause instanceof Error ? cause.message : "Antrean pinjaman tidak dapat dimuat.");
    }
  };

  const load = async () => {
    setLoading(true);
    try {
      const [nextSummary, inbox] = await Promise.all([
        getEmployeeLeaveSummary(),
        getLeaveApprovalInbox(),
      ]);
      setSummary(nextSummary);
      setItems(inbox.items);
    } catch (cause) {
      setError(
        cause instanceof EmployeeLeaveApiError
          ? cause.message
          : "Antrean approval tidak dapat dimuat.",
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    void loadTrips(1);
    void loadLoans(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const decideLoan = async (item: LoanApprovalItem, decision: "approve" | "reject") => {
    const note = decision === "reject" ? window.prompt("Alasan penolakan (minimal 5 karakter):") : null;
    if (decision === "reject" && (!note || note.trim().length < 5)) return;
    setActing(item.stepId);
    setLoanError(null);
    try {
      await decideLoanApproval(item.stepId, decision, note?.trim() || null);
      await loadLoans();
    } catch (cause) {
      setLoanError(cause instanceof Error ? cause.message : "Keputusan tidak dapat disimpan.");
    } finally {
      setActing(null);
    }
  };

  const decideTrip = async (item: TripApprovalItem, decision: "approve" | "reject") => {
    const note = decision === "reject" ? window.prompt("Alasan penolakan (minimal 5 karakter):") : null;
    if (decision === "reject" && (!note || note.trim().length < 5)) return;
    setActing(item.stepId);
    setTripError(null);
    try {
      await decideTripApproval(item.stepId, decision, note?.trim() || null);
      await loadTrips();
    } catch (cause) {
      setTripError(cause instanceof Error ? cause.message : "Keputusan tidak dapat disimpan.");
    } finally {
      setActing(null);
    }
  };

  const user = useMemo(() => {
    const employee = summary?.employee;
    return {
      name: employee?.fullName ?? "Pegawai",
      initials: initials(employee?.fullName ?? "P"),
      position: employee?.positionName ?? "Pegawai",
      unit: employee?.unitName ?? "Yayasan Sabilul Qur'an",
      additionalRole: "Approver",
    };
  }, [summary]);

  const decide = async (item: LeaveApprovalInboxItem, decision: "approve" | "reject") => {
    const note =
      decision === "reject"
        ? window.prompt("Alasan penolakan (opsional):")
        : null;
    setActing(item.stepId);
    setError(null);
    setNotice(null);
    try {
      await decideLeaveApproval(item.stepId, {
        decision,
        note: note?.trim() || null,
      });
      await load();
    } catch (cause) {
      setError(
        cause instanceof EmployeeLeaveApiError
          ? cause.message
          : "Keputusan approval tidak dapat disimpan.",
      );
    } finally {
      setActing(null);
    }
  };

  return (
    <AppShell user={user} activeItem="Persetujuan">
      <section>
        <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
          Manajemen
        </p>
        <h1 className="mt-1 text-2xl font-bold tracking-[-0.02em] text-brand-heading sm:text-[1.75rem]">
          Persetujuan
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Hanya tahap approval yang sedang aktif yang muncul di sini. Rantai approver sudah disnapshot saat pegawai mengajukan cuti, perjalanan dinas, atau pinjaman.
        </p>
      </section>

      {error ? (
        <div className="mt-5 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="mt-5 rounded-2xl border border-success-line bg-success-soft p-4 text-sm text-success-ink" role="status">
          {notice}
        </div>
      ) : null}

      <section className="mt-5 overflow-hidden rounded-3xl border border-border/70 bg-surface-raised shadow-[var(--shadow-soft)]">
        <div className="flex items-center gap-3 border-b border-border/70 px-5 py-4">
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-brand-yellow/15 text-warning-ink">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-base font-bold text-brand-heading">Cuti</h2>
            <p className="text-xs text-muted-foreground">{items.length} pengajuan menunggu keputusan.</p>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 px-5 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Memuat antrean...
          </div>
        ) : items.length === 0 ? (
          <p className="px-5 py-10 text-sm text-muted-foreground">Tidak ada approval yang menunggu.</p>
        ) : (
          <div className="divide-y divide-border/70">
            {items.map((item) => (
              <article key={item.stepId} className="p-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-brand-heading">{item.requesterName}</p>
                    <p className="mt-1 text-sm text-foreground">
                      {formatDate(item.startOn)} – {formatDate(item.endOn)} · {item.workingDays} hari kerja
                    </p>
                    {item.reason ? (
                      <p className="mt-2 max-w-2xl text-xs leading-5 text-muted-foreground">{item.reason}</p>
                    ) : null}
                    <p className="mt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {item.sources.includes("DIRECT_MANAGER") ? "Atasan langsung" : ""}
                      {item.sources.includes("DIRECT_MANAGER") && item.sources.includes("UNIT_APPROVER") ? " + " : ""}
                      {item.sources.includes("UNIT_APPROVER") ? "Approver unit" : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 lg:justify-end">
                    <ProposeAlternativeDates
                      stepId={item.stepId}
                      disabled={acting === item.stepId}
                      onDone={(outcome) => {
                        if (outcome.ok) {
                          setError(null);
                          setNotice(outcome.message);
                        } else {
                          setNotice(null);
                          setError(outcome.message);
                        }
                        void load();
                      }}
                    />
                    <button
                      type="button"
                      disabled={acting === item.stepId}
                      onClick={() => void decide(item, "reject")}
                      className="inline-flex h-10 items-center gap-2 rounded-xl border border-danger-line bg-surface-raised px-4 text-sm font-semibold text-danger-ink hover:bg-danger-soft disabled:opacity-60"
                    >
                      <XCircle className="h-4 w-4" aria-hidden="true" /> Tolak
                    </button>
                    <button
                      type="button"
                      disabled={acting === item.stepId}
                      onClick={() => void decide(item, "approve")}
                      className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground shadow-[var(--shadow-button)] disabled:opacity-60"
                    >
                      {acting === item.stepId ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                      )}
                      Setujui
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      <section className="mt-5 overflow-hidden rounded-3xl border border-border/70 bg-surface-raised shadow-[var(--shadow-soft)]">
        <div className="flex items-center gap-3 border-b border-border/70 px-5 py-4">
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-brand-primary/10 text-brand-primary-deep">
            <Plane className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-base font-bold text-brand-heading">Perjalanan Dinas</h2>
            <p className="text-xs text-muted-foreground">{tripPaging?.total ?? 0} pengajuan menunggu keputusan.</p>
          </div>
        </div>
        {tripError ? <p className="px-5 py-4 text-sm text-danger-ink">{tripError}</p> : null}
        {trips.length === 0 && !tripError ? (
          <p className="px-5 py-10 text-sm text-muted-foreground">Tidak ada perjalanan dinas yang menunggu.</p>
        ) : (
          <div className="divide-y divide-border/70">
            {trips.map((item) => (
              <article key={item.stepId} className="p-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-brand-heading">{item.requesterName} · {item.destination}</p>
                    <p className="mt-1 text-sm text-foreground">{formatTripRange(item.startOn, item.endOn)}{item.unitName ? ` · ${item.unitName}` : ""}</p>
                    <p className="mt-2 max-w-2xl text-xs leading-5 text-muted-foreground">{item.purpose}</p>
                    <p className="mt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{approverRoleLabel(item.sources)}</p>
                  </div>
                  <div className="flex gap-2">
                    <button type="button" disabled={acting === item.stepId} onClick={() => void decideTrip(item, "reject")}
                      className="inline-flex h-10 items-center gap-2 rounded-xl border border-danger-line bg-surface-raised px-4 text-sm font-semibold text-danger-ink hover:bg-danger-soft disabled:opacity-60">
                      <XCircle className="h-4 w-4" aria-hidden="true" /> Tolak
                    </button>
                    <button type="button" disabled={acting === item.stepId} onClick={() => void decideTrip(item, "approve")}
                      className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground shadow-[var(--shadow-button)] disabled:opacity-60">
                      {acting === item.stepId ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
                      Setujui
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
        {tripPaging && tripPaging.total > tripPaging.pageSize ? (
          <PaginationBar page={tripPaging.page} pageSize={tripPaging.pageSize} total={tripPaging.total}
            onPageChange={(next) => { setTripPage(next); void loadTrips(next); }} />
        ) : null}
      </section>
      <ArrangementApprovalsSection />
      <section className="mt-5 overflow-hidden rounded-3xl border border-border/70 bg-surface-raised shadow-[var(--shadow-soft)]">
        <div className="flex items-center gap-3 border-b border-border/70 px-5 py-4">
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-brand-primary/10 text-brand-primary-deep">
            <HandCoins className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-base font-bold text-brand-heading">Pinjaman</h2>
            <p className="text-xs text-muted-foreground">{loanPaging?.total ?? 0} pengajuan menunggu keputusan.</p>
          </div>
        </div>
        {loanError ? <p className="px-5 py-4 text-sm text-danger-ink">{loanError}</p> : null}
        {loans.length === 0 && !loanError ? (
          <p className="px-5 py-10 text-sm text-muted-foreground">Tidak ada pinjaman yang menunggu.</p>
        ) : (
          <div className="divide-y divide-border/70">
            {loans.map((item) => (
              <article key={item.stepId} className="p-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-brand-heading">{item.requesterName} · {formatRupiah(item.principal)}</p>
                    <p className="mt-1 text-sm text-foreground">{item.tenorMonths} bulan cicilan, tanpa bunga{item.unitName ? ` · ${item.unitName}` : ""}</p>
                    <p className="mt-2 max-w-2xl text-xs leading-5 text-muted-foreground">{item.purpose}</p>
                    <p className="mt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{approverRoleLabel(item.sources)}</p>
                  </div>
                  <div className="flex gap-2">
                    <button type="button" disabled={acting === item.stepId} onClick={() => void decideLoan(item, "reject")}
                      className="inline-flex h-10 items-center gap-2 rounded-xl border border-danger-line bg-surface-raised px-4 text-sm font-semibold text-danger-ink hover:bg-danger-soft disabled:opacity-60">
                      <XCircle className="h-4 w-4" aria-hidden="true" /> Tolak
                    </button>
                    <button type="button" disabled={acting === item.stepId} onClick={() => void decideLoan(item, "approve")}
                      className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground shadow-[var(--shadow-button)] disabled:opacity-60">
                      {acting === item.stepId ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
                      Setujui
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
        {loanPaging && loanPaging.total > loanPaging.pageSize ? (
          <PaginationBar page={loanPaging.page} pageSize={loanPaging.pageSize} total={loanPaging.total}
            onPageChange={(next) => { setLoanPage(next); void loadLoans(next); }} />
        ) : null}
      </section>
    </AppShell>
  );
}
