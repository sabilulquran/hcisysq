// ATT-015 approver queue on the Persetujuan page. Same APR-001 snapshot as leave and trips, in its own
// queue; only the step holder sees and decides it (the API enforces that).

import { Briefcase, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { PaginationBar } from "@/components/PaginationBar";
import {
  approverRoleLabel,
  arrangementSubject,
  arrangementTypeLabel,
  decideArrangementApproval,
  formatArrangementRange,
  getArrangementApprovals,
  type ArrangementApprovalItem,
  type Pagination,
} from "@/lib/workArrangements";

export function ArrangementApprovalsSection() {
  const [items, setItems] = useState<ArrangementApprovalItem[]>([]);
  const [paging, setPaging] = useState<Pagination | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async (target = page) => {
    try {
      const result = await getArrangementApprovals(target);
      setItems(result.items);
      setPaging(result.pagination);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Antrean tugas luar dan WFH tidak dapat dimuat.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const decide = async (item: ArrangementApprovalItem, decision: "approve" | "reject") => {
    const note = decision === "reject" ? window.prompt("Alasan penolakan (minimal 5 karakter):") : null;
    if (decision === "reject" && (!note || note.trim().length < 5)) return;
    setActing(item.stepId);
    setError(null);
    try {
      await decideArrangementApproval(item.stepId, decision, note?.trim() || null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Keputusan tidak dapat disimpan.");
    } finally {
      setActing(null);
    }
  };

  return (
    <section className="mt-5 overflow-hidden rounded-3xl border border-border/70 bg-surface-raised shadow-[var(--shadow-soft)]">
      <div className="flex items-center gap-3 border-b border-border/70 px-5 py-4">
        <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-brand-primary/10 text-brand-primary-deep">
          <Briefcase className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <h2 className="text-base font-bold text-brand-heading">Tugas Luar, WFH &amp; Ubah Jadwal</h2>
          <p className="text-xs text-muted-foreground">{paging?.total ?? 0} pengajuan menunggu keputusan.</p>
        </div>
      </div>
      {error ? <p className="px-5 py-4 text-sm text-danger-ink">{error}</p> : null}
      {loading ? (
        <div className="flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat...</div>
      ) : items.length === 0 && !error ? (
        <p className="px-5 py-10 text-sm text-muted-foreground">Tidak ada tugas luar, WFH, atau ubah jadwal yang menunggu.</p>
      ) : (
        <div className="divide-y divide-border/70">
          {items.map((item) => (
            <article key={item.stepId} className="p-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-brand-heading">
                    {item.requesterName} · {arrangementTypeLabel(item.type)}: {arrangementSubject(item)}
                  </p>
                  <p className="mt-1 text-sm text-foreground">{formatArrangementRange(item.startOn, item.endOn)}{item.unitName ? ` · ${item.unitName}` : ""}</p>
                  <p className="mt-2 max-w-2xl text-xs leading-5 text-muted-foreground">{item.purpose}</p>
                  <p className="mt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{approverRoleLabel(item.sources)}</p>
                </div>
                <div className="flex gap-2">
                  <button type="button" disabled={acting === item.stepId} onClick={() => void decide(item, "reject")}
                    className="inline-flex h-10 items-center gap-2 rounded-xl border border-danger-line bg-surface-raised px-4 text-sm font-semibold text-danger-ink hover:bg-danger-soft disabled:opacity-60">
                    <XCircle className="h-4 w-4" aria-hidden="true" /> Tolak
                  </button>
                  <button type="button" disabled={acting === item.stepId} onClick={() => void decide(item, "approve")}
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
      {paging && paging.total > paging.pageSize ? (
        <PaginationBar page={paging.page} pageSize={paging.pageSize} total={paging.total}
          onPageChange={(next) => { setPage(next); void load(next); }} />
      ) : null}
    </section>
  );
}
