// LEAVE-009 HC surface: leave that fell in a critical period (masa kritis) and has passed line
// approval waits here for a Human Capital decision. Spec: docs/domain/leave-critical-periods.md §9.
// The API authorizes every call; an HC account without the approval mandate sees an explanation.

import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { PaginationBar } from "@/components/PaginationBar";
import { AppShell } from "@/layouts/AppShell";
import { getPlannedLeaveSummary, type PlannedLeaveSummary } from "@/lib/plannedLeave";
import {
  CriticalPeriodApiError,
  criticalPeriodRange,
  decideCriticalReview,
  getCriticalReviewQueue,
  type CriticalReviewQueueItem,
  type Pagination,
} from "@/lib/leaveCriticalPeriods";

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function HcCriticalLeavePage() {
  const [summary, setSummary] = useState<PlannedLeaveSummary | null>(null);
  const [items, setItems] = useState<CriticalReviewQueueItem[]>([]);
  const [paging, setPaging] = useState<Pagination | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [noMandate, setNoMandate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyReview, setBusyReview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const result = await getCriticalReviewQueue({ page, pageSize });
      setItems(result.items);
      setPaging(result.pagination);
      setNoMandate(false);
      setError(null);
    } catch (cause) {
      if (cause instanceof CriticalPeriodApiError && cause.code === "HC_APPROVAL_FORBIDDEN") {
        setNoMandate(true);
        setItems([]);
        setPaging(null);
      } else {
        setError(cause instanceof Error ? cause.message : "Antrean masa kritis tidak dapat dimuat.");
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize]);
  useEffect(() => {
    void getPlannedLeaveSummary().then(setSummary).catch(() => setSummary(null));
  }, []);

  const user = useMemo(() => {
    const employee = summary?.employee;
    return {
      name: employee?.fullName ?? "Human Capital",
      initials: initials(employee?.fullName ?? "HC"),
      position: employee?.positionName ?? "Human Capital",
      unit: employee?.unitName ?? "Yayasan Sabilul Qur'an",
    };
  }, [summary]);

  const decide = async (item: CriticalReviewQueueItem, decision: "approve" | "reject") => {
    let note: string | null = null;
    if (decision === "reject") {
      const answer = window.prompt("Alasan penolakan (akan terlihat di riwayat):");
      // Cancel means "do not reject"; only an answered prompt sends the decision.
      if (answer === null) return;
      note = answer.trim() || null;
    }
    setBusyReview(item.reviewId);
    setError(null);
    setSuccess(null);
    try {
      const result = await decideCriticalReview(item.reviewId, { decision, note });
      setSuccess(
        decision === "reject"
          ? `Cuti ${item.requesterName} ditolak.`
          : result.hcTaskStatus === "pending"
            ? `Cuti ${item.requesterName} lolos tinjauan masa kritis dan lanjut ke pemeriksaan administrasi HC.`
            : `Cuti ${item.requesterName} disetujui.`,
      );
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Keputusan tidak dapat disimpan.");
    } finally {
      setBusyReview(null);
    }
  };

  return (
    <AppShell user={user} activeItem="Cuti Masa Kritis">
      <section>
        <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">Human Capital</p>
        <h1 className="mt-1 text-2xl font-bold tracking-[-0.02em] text-brand-heading">Cuti di masa kritis</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          Cuti yang jatuh di pekan ujian, PPDB, atau masa kritis lain sudah disetujui atasan dan menunggu keputusan Human Capital. Pertimbangkan kecukupan guru dan staf di unitnya.
        </p>
      </section>

      {error ? (
        <div role="alert" className="mt-5 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div>
      ) : null}
      {success ? (
        <div role="status" className="mt-5 rounded-2xl border border-success-line bg-success-soft p-4 text-sm text-success-ink">{success}</div>
      ) : null}

      <section className="mt-5 overflow-hidden rounded-3xl border border-border/70 bg-surface-raised shadow-[var(--shadow-soft)]">
        {loading ? (
          <div className="flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Memuat antrean...
          </div>
        ) : noMandate ? (
          <p className="px-5 py-8 text-sm text-muted-foreground">
            Akun ini memiliki akses Human Capital, tetapi tidak memiliki mandat persetujuan HC untuk memutus cuti di masa kritis.
          </p>
        ) : items.length === 0 ? (
          <p className="px-5 py-8 text-sm text-muted-foreground">Tidak ada cuti masa kritis yang menunggu keputusan.</p>
        ) : (
          <div className="divide-y divide-border/70">
            {items.map((item) => (
              <article key={item.reviewId} className="p-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-brand-heading">{item.requesterName} · {item.policyName}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {item.unitName ?? "Tanpa unit"}{item.positionName ? ` · ${item.positionName}` : ""}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {criticalPeriodRange(item)} · {item.workingDays} hari kerja
                    </p>
                    {item.reason ? (
                      <p className="mt-2 text-xs leading-5 text-muted-foreground">Alasan: {item.reason}</p>
                    ) : null}
                    <ul className="mt-3 flex flex-wrap gap-2">
                      {item.periods.map((period) => (
                        <li
                          key={period.id}
                          className="inline-flex items-center gap-1.5 rounded-xl border border-warning-line bg-warning-soft px-3 py-1.5 text-xs font-semibold text-warning-ink"
                        >
                          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                          {period.label} · {criticalPeriodRange(period)}
                          {period.unitName ? ` · ${period.unitName}` : ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      disabled={busyReview === item.reviewId}
                      onClick={() => void decide(item, "reject")}
                      className="inline-flex h-10 items-center gap-2 rounded-xl border border-danger-line bg-surface-raised px-4 text-xs font-bold text-danger-ink disabled:opacity-50"
                    >
                      <XCircle className="h-4 w-4" aria-hidden="true" /> Tolak
                    </button>
                    <button
                      type="button"
                      disabled={busyReview === item.reviewId}
                      onClick={() => void decide(item, "approve")}
                      className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-4 text-xs font-bold text-brand-foreground disabled:opacity-50"
                    >
                      {busyReview === item.reviewId
                        ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
                      Setujui
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
        {paging && !noMandate ? (
          <PaginationBar
            page={paging.page}
            pageSize={paging.pageSize}
            total={paging.total}
            onPageChange={setPage}
            onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
          />
        ) : null}
      </section>
    </AppShell>
  );
}
