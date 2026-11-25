// TRIP-002 approver queue on the Persetujuan page. An advance runs on the same APR-001 chain as
// its trip; the API decides who may act.

import { CheckCircle2, Loader2, Wallet, XCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { PaginationBar } from "@/components/PaginationBar";
import {
  approverRoleLabel,
  decideAdvanceApproval,
  formatRupiah,
  getAdvanceApprovals,
  type AdvanceApprovalItem,
  type Pagination,
} from "@/lib/tripAdvances";

export function TripAdvanceApprovalsSection() {
  const [items, setItems] = useState<AdvanceApprovalItem[]>([]);
  const [paging, setPaging] = useState<Pagination | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  const load = async (target = page) => {
    try {
      const result = await getAdvanceApprovals(target);
      setItems(result.items);
      setPaging(result.pagination);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Antrean uang muka dinas tidak dapat dimuat.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const decide = async (item: AdvanceApprovalItem, decision: "approve" | "reject") => {
    const note = decision === "reject" ? window.prompt("Alasan penolakan (minimal 5 karakter):") : null;
    if (decision === "reject" && (!note || note.trim().length < 5)) return;
    setActing(item.stepId);
    setError(null);
    try {
      await decideAdvanceApproval(item.stepId, decision, note?.trim() || null);
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
          <Wallet className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <h2 className="text-base font-bold text-brand-heading">Uang Muka Dinas</h2>
          <p className="text-xs text-muted-foreground">{paging?.total ?? 0} pengajuan menunggu keputusan.</p>
        </div>
      </div>
      {error ? <p role="alert" className="px-5 py-4 text-sm text-danger-ink">{error}</p> : null}
      {loading ? (
        <div className="flex items-center gap-2 px-5 py-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat...</div>
      ) : items.length === 0 && !error ? (
        <p className="px-5 py-10 text-sm text-muted-foreground">Tidak ada uang muka dinas yang menunggu.</p>
      ) : (
        <div className="divide-y divide-border/70">
          {items.map((item) => (
            <article key={item.stepId} className="p-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-brand-heading">
                    {item.requesterName} · {item.amount === 0 ? "Hanya uang harian" : formatRupiah(item.amount)}
                  </p>
                  <p className="mt-1 text-sm text-foreground">
                    {item.tripDestination} · {item.tripStartOn} – {item.tripEndOn} · {item.wilayahLabel}{item.unitName ? ` · ${item.unitName}` : ""}
                  </p>
                  <p className="mt-1 whitespace-pre-line text-xs text-muted-foreground">{item.purpose}</p>
                  <p className="sq-eyebrow mt-2 text-muted-foreground">{approverRoleLabel(item.sources)}</p>
                </div>
                <div className="flex flex-wrap gap-2">
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
