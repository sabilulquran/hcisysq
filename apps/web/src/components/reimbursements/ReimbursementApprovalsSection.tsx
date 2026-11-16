// REIMB-001 approver queue on the Persetujuan page. Claims use the same APR-001 snapshot as
// leave, trips and loans; the approver opens the items and receipts of a claim only through
// their own step, and the API decides who may act.

import { CheckCircle2, Loader2, Receipt, XCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { DetailDialog, useDialogParam } from "@/components/DetailDialog";
import { DialogLoading, DialogMessages } from "@/components/DetailDialogParts";
import { PaginationBar } from "@/components/PaginationBar";
import { ReimbursementDetailPanel } from "@/components/reimbursements/ReimbursementDetailPanel";
import {
  approverReceiptHref,
  approverRoleLabel,
  decideClaimApproval,
  formatRupiah,
  getClaimApprovals,
  getClaimForApprover,
  type ClaimApprovalItem,
  type ClaimDetail,
  type Pagination,
} from "@/lib/reimbursements";

export function ReimbursementApprovalsSection() {
  const [items, setItems] = useState<ClaimApprovalItem[]>([]);
  const [paging, setPaging] = useState<Pagination | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ stepId: string; claim: ClaimDetail } | null>(null);
  // "Lihat rincian & bukti" opens the claim behind one approval step as a pop-up (?klaim=<stepId>).
  const [stepId, showClaim, closeClaim] = useDialogParam("klaim");

  const load = async (target = page) => {
    try {
      const result = await getClaimApprovals(target);
      setItems(result.items);
      setPaging(result.pagination);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Antrean reimbursement tidak dapat dimuat.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!stepId) {
      setOpened(null);
      return;
    }
    let current = true;
    setError(null);
    void getClaimForApprover(stepId)
      .then((claim) => { if (current) setOpened({ stepId, claim }); })
      .catch((cause: unknown) => { if (current) setError(cause instanceof Error ? cause.message : "Klaim tidak dapat dibuka."); });
    return () => { current = false; };
  }, [stepId]);

  const decide = async (item: Pick<ClaimApprovalItem, "stepId">, decision: "approve" | "reject") => {
    const note = decision === "reject" ? window.prompt("Alasan penolakan (minimal 5 karakter):") : null;
    if (decision === "reject" && (!note || note.trim().length < 5)) return;
    setActing(item.stepId);
    setError(null);
    try {
      await decideClaimApproval(item.stepId, decision, note?.trim() || null);
      if (stepId === item.stepId) closeClaim();
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
          <Receipt className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <h2 className="text-base font-bold text-brand-heading">Reimbursement</h2>
          <p className="text-xs text-muted-foreground">{paging?.total ?? 0} klaim menunggu keputusan.</p>
        </div>
      </div>
      {error && !stepId ? <p role="alert" className="px-5 py-4 text-sm text-danger-ink">{error}</p> : null}
      {loading ? (
        <div className="flex items-center gap-2 px-5 py-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat...</div>
      ) : items.length === 0 && !error ? (
        <p className="px-5 py-10 text-sm text-muted-foreground">Tidak ada klaim reimbursement yang menunggu.</p>
      ) : (
        <div className="divide-y divide-border/70">
          {items.map((item) => (
            <article key={item.stepId} className="p-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-brand-heading">{item.requesterName} · {formatRupiah(item.claimedTotal)}</p>
                  <p className="mt-1 text-sm text-foreground">
                    {item.title} · {item.itemCount} baris, {item.receiptCount} bukti{item.unitName ? ` · ${item.unitName}` : ""}
                  </p>
                  {item.tripDestination ? <p className="mt-1 text-xs text-muted-foreground">Perjalanan dinas: {item.tripDestination}</p> : null}
                  <p className="mt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{approverRoleLabel(item.sources)}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => showClaim(item.stepId)}
                    className="inline-flex h-10 items-center rounded-xl border border-border px-4 text-sm font-semibold text-brand-heading">
                    Lihat rincian &amp; bukti
                  </button>
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

      {stepId ? (
        <DetailDialog
          title="Rincian klaim"
          description={opened?.stepId === stepId ? `${opened.claim.employeeName} · ${formatRupiah(opened.claim.claimedTotal)}` : undefined}
          onClose={closeClaim}
        >
          <DialogMessages error={error} />
          {opened?.stepId === stepId ? (
            <>
              <ReimbursementDetailPanel claim={opened.claim} receiptHref={(receipt) => approverReceiptHref(stepId, receipt.id)} />
              <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-border/70 pt-4">
                <button type="button" disabled={acting === stepId} onClick={() => void decide({ stepId }, "reject")}
                  className="inline-flex h-10 items-center gap-2 rounded-xl border border-danger-line bg-surface-raised px-4 text-sm font-semibold text-danger-ink hover:bg-danger-soft disabled:opacity-60">
                  <XCircle className="h-4 w-4" aria-hidden="true" /> Tolak
                </button>
                <button type="button" disabled={acting === stepId} onClick={() => void decide({ stepId }, "approve")}
                  className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground shadow-[var(--shadow-button)] disabled:opacity-60">
                  {acting === stepId ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
                  Setujui
                </button>
              </div>
            </>
          ) : error ? null : <DialogLoading />}
        </DetailDialog>
      ) : null}
    </section>
  );
}
