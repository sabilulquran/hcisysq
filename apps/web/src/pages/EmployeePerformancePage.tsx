// PERF-001 employee surface: the employee's own reviews (self-assessment, result, acknowledgement)
// and, for raters, the team queue. Spec: docs/domain/performance-review.md. The API authorizes
// every call and says which actions are open through `allowedActions`.

import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { DetailDialog, useDialogParam } from "@/components/DetailDialog";
import { DialogLoading, DialogMessages } from "@/components/DetailDialogParts";
import { PaginationBar } from "@/components/PaginationBar";
import { ReviewDetailPanel, ScoreForm } from "@/components/performance/ReviewDetailPanel";
import { AppShell } from "@/layouts/AppShell";
import { employeeShellUser } from "@/lib/employeeIdentity";
import { getEmployeeLeaveSummary, type EmployeeLeaveSummary } from "@/lib/employeeLeave";
import {
  acknowledgeReview,
  formatPeriod,
  formatScore,
  getMyReview,
  getMyReviews,
  getTeamReview,
  getTeamReviews,
  REVIEW_STATUS_LABELS,
  reviewStatusLabel,
  submitRating,
  submitSelfAssessment,
  type Pagination,
  type ReviewDetail,
  type ReviewStatus,
  type ReviewSummary,
} from "@/lib/performance";

type Tab = "mine" | "team";

export function EmployeePerformancePage() {
  const [employee, setEmployee] = useState<EmployeeLeaveSummary["employee"] | null>(null);
  const [tab, setTab] = useState<Tab>(() => (new URLSearchParams(window.location.search).get("tab") === "team" ? "team" : "mine"));
  const [items, setItems] = useState<ReviewSummary[]>([]);
  const [paging, setPaging] = useState<Pagination | null>(null);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<ReviewStatus | "">("");
  const [selected, setSelected] = useState<ReviewDetail | null>(null);
  // The open review lives in ?review=<id> (with ?tab=team for raters); notification links use the
  // same parameters. It shows as a pop-up.
  const [reviewId, showReview, closeReview] = useDialogParam("review");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const user = useMemo(() => employeeShellUser(employee), [employee]);

  const load = async () => {
    setLoading(true);
    try {
      const result = tab === "mine" ? await getMyReviews(page) : await getTeamReviews(page, status);
      setItems(result.items);
      setPaging(result.pagination);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Penilaian kinerja tidak dapat dimuat.");
    } finally {
      setLoading(false);
    }
  };

  const open = async (id: string, from: Tab = tab) => {
    setError(null);
    try {
      setSelected(from === "mine" ? await getMyReview(id) : await getTeamReview(id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Penilaian kinerja tidak dapat dibuka.");
    }
  };

  useEffect(() => {
    void getEmployeeLeaveSummary().then((summary) => setEmployee(summary.employee)).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (reviewId) void open(reviewId);
    else setSelected(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewId]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, page, status]);

  const switchTab = (next: Tab) => {
    // The tab is part of a review's link: a rater's review opens from the team queue.
    const url = new URL(window.location.href);
    if (next === "team") url.searchParams.set("tab", "team");
    else url.searchParams.delete("tab");
    window.history.replaceState(window.history.state, "", url);
    setTab(next);
    setPage(1);
    setStatus("");
    setSelected(null);
  };

  const run = async (action: () => Promise<string>, review: ReviewDetail) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await action());
      await Promise.all([load(), open(review.id)]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Tindakan belum dapat diselesaikan.");
    } finally {
      setBusy(false);
    }
  };

  const acknowledge = (review: ReviewDetail) => {
    const comment = window.prompt("Tanggapan atas hasil penilaian (opsional, boleh dikosongkan)");
    if (comment === null) return;
    void run(async () => {
      await acknowledgeReview(review.id, comment.trim() || null);
      return "Hasil penilaian ditandai sudah dibaca.";
    }, review);
  };

  const tabClass = (active: boolean) =>
    `min-h-11 rounded-xl px-4 text-sm font-bold ${active ? "bg-brand-primary text-brand-foreground" : "border border-border text-brand-heading"}`;

  return (
    <AppShell user={user} activeItem="Kinerja">
      <section className="mx-auto max-w-5xl">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand-primary-deep">Pengembangan</p>
        <h1 className="mt-1 text-2xl font-bold text-brand-heading sm:text-3xl">Penilaian Kinerja</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Isi penilaian diri pada setiap siklus. Atasan Anda memberi nilai, lalu Human Capital mengesahkan. Hasilnya
          tampil di sini setelah disahkan. Penilaian ini belum memengaruhi tunjangan kinerja.
        </p>

        <div className="mt-5 flex flex-wrap gap-2" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "mine"} className={tabClass(tab === "mine")} onClick={() => switchTab("mine")}>Penilaian saya</button>
          <button type="button" role="tab" aria-selected={tab === "team"} className={tabClass(tab === "team")} onClick={() => switchTab("team")}>Tim yang saya nilai</button>
        </div>

        {error && !reviewId ? <div className="mt-5 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div> : null}
        {notice && !reviewId ? <div className="mt-5 rounded-2xl border border-border bg-surface p-4 text-sm text-brand-heading">{notice}</div> : null}

        <div className="mt-6">
          <section className="overflow-hidden rounded-3xl border border-border/75 bg-surface-raised shadow-[var(--shadow-soft)]">
            {tab === "team" ? (
              <div className="p-5 pb-0">
                <label className="text-xs font-semibold text-muted-foreground">
                  Status
                  <select value={status} onChange={(event) => { setPage(1); setStatus(event.target.value as ReviewStatus | ""); }}
                    className="mt-1 h-11 w-full rounded-xl border bg-surface px-3 text-sm text-foreground">
                    <option value="">Semua status</option>
                    {(Object.keys(REVIEW_STATUS_LABELS) as ReviewStatus[]).filter((key) => key !== "REMOVED")
                      .map((key) => <option key={key} value={key}>{REVIEW_STATUS_LABELS[key]}</option>)}
                  </select>
                </label>
              </div>
            ) : null}
            {loading ? (
              <div className="flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat...</div>
            ) : items.length === 0 ? (
              <p className="px-5 py-8 text-sm text-muted-foreground">
                {tab === "mine" ? "Belum ada siklus penilaian untuk Anda." : "Tidak ada pegawai yang ditugaskan kepada Anda untuk dinilai."}
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-border/70">
                {items.map((item) => (
                  <li key={item.id}>
                    <button type="button" onClick={() => showReview(item.id)}
                      className={`w-full px-5 py-3 text-left hover:bg-muted/50 ${reviewId === item.id ? "bg-muted/60" : ""}`}>
                      <span className="block font-semibold text-brand-heading">{tab === "team" ? item.employeeName : item.cycleName}</span>
                      <span className="block text-xs text-muted-foreground">
                        {tab === "team" ? `${item.cycleName} · ` : ""}{formatPeriod(item.periodStart, item.periodEnd)}
                      </span>
                      <span className="mt-1 block text-[11px] font-semibold text-muted-foreground">
                        {reviewStatusLabel(item.status)}
                        {item.predicateCode ? ` · ${item.predicateCode} ${item.predicateLabel} (${formatScore(item.finalScore)})` : ""}
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

          {reviewId ? (
            <DetailDialog title="Detail penilaian kinerja" onClose={closeReview} wide>
              <DialogMessages error={error} notice={notice} />
              {selected?.id === reviewId ? (
                <>
                  <ReviewDetailPanel
                    review={selected}
                    form={selected.allowedActions.includes("self-assessment") ? (
                      <ScoreForm key={`self-${selected.id}`} kind="self" rubric={selected.rubric} busy={busy}
                        onSubmit={(input) => void run(async () => {
                          await submitSelfAssessment(selected.id, input.scores, input.note);
                          return "Penilaian diri terkirim ke penilai.";
                        }, selected)} />
                    ) : selected.allowedActions.includes("rate") ? (
                      <ScoreForm key={`rate-${selected.id}-${selected.status}`} kind="rating" rubric={selected.rubric}
                        initial={selected.rating?.scores ?? null} initialText={selected.rating} busy={busy}
                        onSubmit={(input) => void run(async () => {
                          const result = await submitRating(selected.id, input);
                          return `Nilai terkirim: ${formatScore(result.finalScore)} · ${result.predicateLabel}. Menunggu pengesahan Human Capital.`;
                        }, selected)} />
                    ) : null}
                    actions={selected.allowedActions.includes("acknowledge") ? (
                      <button type="button" disabled={busy} onClick={() => acknowledge(selected)}
                        className="min-h-11 rounded-xl bg-brand-primary px-3 text-sm font-bold text-brand-foreground disabled:opacity-50">
                        Tandai sudah dibaca
                      </button>
                    ) : null}
                  />
                  {tab === "team" && selected.status === "SELF_ASSESSMENT" && !selected.allowedActions.includes("rate") ? (
                    <p className="mt-4 text-xs text-muted-foreground">
                      Anda dapat menilai setelah pegawai mengirim penilaian diri atau setelah {selected.selfDueOn}.
                    </p>
                  ) : null}
                </>
              ) : error ? null : <DialogLoading />}
            </DetailDialog>
          ) : null}
        </div>
      </section>
    </AppShell>
  );
}
