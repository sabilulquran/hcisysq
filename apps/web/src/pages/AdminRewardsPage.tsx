// REWARD-001 Admin → Penghargaan: monthly rounds from the Al-Qur'an scoreboard, the Kepala HCM's
// decisions, publication and its effects, revocation, and the manual CSV fallback (R-14 DRAFT).
// Spec: docs/domain/rewards.md §9. The API authorizes and decides everything; the buttons shown
// here are hints from the round's own `viewer` field.

import { Award as AwardIcon, Loader2, RefreshCw, Upload } from "lucide-react";
import { useEffect, useState } from "react";

import { DetailDialog, useDialogParam } from "@/components/DetailDialog";
import { PaginationBar } from "@/components/PaginationBar";
import { AdminShell } from "@/layouts/AdminShell";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import {
  awardCandidate,
  buildRound,
  cancelRound,
  CANDIDATE_STATUS_LABELS,
  declineCandidate,
  EFFECT_LABELS,
  getRound,
  getRoundEvents,
  getRounds,
  getSource,
  importSnapshot,
  labelText,
  MANUAL_CSV_TEMPLATE,
  monthLabel,
  previousMonth,
  publishBlocker,
  publishRound,
  retryEffect,
  revokeAward,
  RewardApiError,
  ROUND_STATUS_LABELS,
  seatGroups,
  SOURCE_KIND_LABELS,
  sourceMessage,
  takeNextRank,
  type AuditEvent,
  type Candidate,
  type Pagination,
  type RoundDetail,
  type RoundStatus,
  type RoundSummary,
  type SourceState,
} from "@/lib/rewards";
import type { AuthSession } from "@/types/hcis";

const field = "mt-1 h-11 w-full rounded-xl border bg-surface px-3 text-sm text-foreground";
const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-bold disabled:opacity-50";

export function SourceBanner({ source }: { source: SourceState }) {
  const message = sourceMessage(source.status);
  const tone = message.tone === "warning"
    ? "border-warning-line bg-warning-soft text-warning-ink"
    : message.tone === "ok" ? "border-border bg-surface text-brand-heading" : "border-border bg-brand-primary-pale text-brand-primary-deep";
  return (
    <div role="status" className={`mb-5 rounded-2xl border p-4 text-sm ${tone}`}>
      <p className="font-bold">{message.title}</p>
      <p className="mt-1">{message.body}</p>
      {source.fetch?.exhaustedAt ? (
        <p className="mt-1 font-semibold">Percobaan otomatis untuk {monthLabel(source.fetch.month)} sudah berhenti. Gunakan Susun ulang.</p>
      ) : null}
    </div>
  );
}

function CandidateCard({
  candidate, round, busy, onAward, onDecline, onNextRank,
}: {
  candidate: Candidate;
  round: RoundDetail;
  busy: boolean;
  onAward: () => void;
  onDecline: () => void;
  onNextRank: () => void;
}) {
  const decidable = round.viewer.decidableCandidateIds.includes(candidate.id);
  const vacated = candidate.status === "DECLINED" || candidate.status === "UNRESOLVED";
  const canRefill = round.viewer.canManage && round.status === "PENDING_DECISION" && vacated && !candidate.replaced;
  return (
    <li className="rounded-2xl border border-border/75 bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-bold text-brand-heading">{candidate.employeeName ?? "Orang tidak dikenal di HCIS"}</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-2xs font-bold text-muted-foreground">{CANDIDATE_STATUS_LABELS[candidate.status]}</span>
        {candidate.replacesCandidateId ? (
          <span className="rounded-full bg-brand-primary-pale px-2 py-0.5 text-2xs font-bold text-brand-primary-deep">Peringkat berikutnya</span>
        ) : null}
        {candidate.labels.length ? (
          <span className="rounded-full bg-warning-soft px-2 py-0.5 text-2xs font-bold text-warning-ink">Sebagian {labelText(candidate.labels)}</span>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {[candidate.employeeNumber, candidate.employeeUnitName].filter(Boolean).join(" · ") || candidate.personRef}
      </p>
      <dl className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <div><dt className="text-muted-foreground">Peringkat</dt><dd className="font-bold tabular-nums">{candidate.rank}</dd></div>
        <div><dt className="text-muted-foreground">Halaman</dt><dd className="font-bold tabular-nums">{candidate.pages.toLocaleString("id-ID", { minimumFractionDigits: 1 })}</dd></div>
        <div><dt className="text-muted-foreground">Hari aktif</dt><dd className="font-bold tabular-nums">{candidate.activeDays}</dd></div>
        <div><dt className="text-muted-foreground">Khatam</dt><dd className="font-bold tabular-nums">{candidate.khatam}</dd></div>
      </dl>
      {candidate.unresolvedReason ? (
        <p className="mt-2 text-xs text-danger-ink">
          {candidate.unresolvedReason === "UNKNOWN_PERSON" ? "Orang di papan skor tidak dikenal di HCIS." : "Pegawai tidak lagi aktif."}
        </p>
      ) : null}
      {candidate.declineReason ? <p className="mt-2 text-xs text-muted-foreground">Alasan: {candidate.declineReason}</p> : null}
      {candidate.decidedByName ? <p className="mt-1 text-2xs text-muted-foreground">Diputuskan oleh {candidate.decidedByName}</p> : null}
      {decidable || canRefill ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {decidable && candidate.status !== "AWARDED" && !candidate.replaced ? (
            <button type="button" disabled={busy} onClick={onAward} className={`${button} bg-brand-primary text-brand-foreground`}>Tetapkan</button>
          ) : null}
          {decidable && candidate.status !== "DECLINED" && !candidate.replaced ? (
            <button type="button" disabled={busy} onClick={onDecline} className={`${button} border border-border text-brand-heading`}>Tidak ditetapkan</button>
          ) : null}
          {canRefill ? (
            <button type="button" disabled={busy} onClick={onNextRank} className={`${button} border border-border text-brand-heading`}>Ambil peringkat berikutnya</button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** The round as the API sent it, separate from loading so every state renders in tests. */
export function RoundDetailView({
  round, busy, onAction,
}: {
  round: RoundDetail;
  busy: boolean;
  onAction: (action: "award" | "decline" | "next" | "publish" | "cancel" | "revoke" | "retry", id: string) => void;
}) {
  const blocker = publishBlocker(round);
  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-border/75 bg-surface p-4 text-sm">
        <p className="font-bold text-brand-heading">{monthLabel(round.month)} · {ROUND_STATUS_LABELS[round.status]}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Sumber: {SOURCE_KIND_LABELS[round.sourceKind]} · versi snapshot {round.snapshotVersion} · {round.snapshotRowCount} baris
        </p>
        {round.sourceKind === "MANUAL_IMPORT" ? (
          <p className="mt-2 rounded-xl bg-warning-soft p-2 text-xs text-warning-ink">
            Kandidat berasal dari impor CSV oleh {round.importedByName ?? "HC"} ({round.importRowCount} baris): {round.importNote}. Jalur sementara sampai aplikasi Al-Qur&apos;an tersambung.
          </p>
        ) : null}
        {round.directoryStale ? (
          <p className="mt-2 rounded-xl bg-warning-soft p-2 text-xs text-warning-ink">
            Data unit di papan skor diambil saat Direktori Organisasi tertinggal. Periksa unit kandidat sebelum menetapkan.
          </p>
        ) : null}
        {round.viewer.isImporter ? (
          <p className="mt-2 text-xs text-muted-foreground">Anda mengimpor snapshot ini, jadi tidak dapat memutuskan kandidatnya.</p>
        ) : null}
        {round.cancelReason ? <p className="mt-2 text-xs text-muted-foreground">Dibatalkan: {round.cancelReason}</p> : null}
        {round.publishedByName ? <p className="mt-2 text-xs text-muted-foreground">Diterbitkan oleh {round.publishedByName}</p> : null}
      </section>

      {round.candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">Papan skor bulan ini kosong; tidak ada kandidat. Putaran ini dapat dibatalkan.</p>
      ) : seatGroups(round.candidates).map((group) => (
        <section key={group.key}>
          <h3 className="mb-2 text-sm font-bold text-brand-heading">{group.title}</h3>
          <ul className="space-y-2">
            {group.candidates.map((candidate) => (
              <CandidateCard
                key={candidate.id}
                candidate={candidate}
                round={round}
                busy={busy}
                onAward={() => onAction("award", candidate.id)}
                onDecline={() => onAction("decline", candidate.id)}
                onNextRank={() => onAction("next", candidate.id)}
              />
            ))}
          </ul>
        </section>
      ))}

      {round.viewer.canManage && round.status === "PENDING_DECISION" ? (
        <section className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={busy || blocker !== null} onClick={() => onAction("publish", round.id)}
            className={`${button} bg-brand-primary text-brand-foreground`}>Terbitkan</button>
          <button type="button" disabled={busy} onClick={() => onAction("cancel", round.id)}
            className={`${button} border border-border text-brand-heading`}>Batalkan putaran</button>
          {blocker ? <span className="text-xs text-muted-foreground">{blocker}</span> : null}
        </section>
      ) : null}

      {round.awards.length ? (
        <section>
          <h3 className="mb-2 text-sm font-bold text-brand-heading">Penerima</h3>
          <ul className="divide-y divide-border/70 rounded-2xl border border-border/75">
            {round.awards.map((award) => (
              <li key={award.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                <span>
                  <span className="font-semibold text-brand-heading">{award.recipientName}</span>
                  <span className="block text-xs text-muted-foreground">
                    {award.categoryLabel}
                    {award.status === "REVOKED" ? ` · Dicabut: ${award.revokeReason}` : award.certificateReady ? " · Sertifikat siap" : " · Sertifikat disiapkan"}
                  </span>
                </span>
                {round.viewer.canManage && award.status === "ACTIVE" && award.employeeId !== round.viewer.employeeId ? (
                  <button type="button" disabled={busy} onClick={() => onAction("revoke", award.id)}
                    className={`${button} border border-danger-line text-danger-ink`}>Cabut</button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {round.outbox.length ? (
        <section>
          <h3 className="mb-2 text-sm font-bold text-brand-heading">Pengiriman</h3>
          <ul className="space-y-1 text-xs">
            {round.outbox.map((item) => {
              const recipient = round.awards.find((award) => award.id === item.awardId)?.recipientName;
              return (
                <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface px-3 py-2">
                  <span>
                    {EFFECT_LABELS[item.effect]}{recipient ? ` · ${recipient}` : ""} ·{" "}
                    <span className={item.status === "DONE" ? "text-muted-foreground" : "font-bold text-warning-ink"}>
                      {item.status === "DONE" ? "Terkirim" : "Belum terkirim"}
                    </span>
                    {item.lastError ? ` (${item.lastError})` : ""}
                  </span>
                  {round.viewer.canManage && item.status !== "DONE" ? (
                    <button type="button" disabled={busy} onClick={() => onAction("retry", item.id)}
                      className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-border px-2 font-bold">
                      <RefreshCw className="h-3 w-3" aria-hidden="true" />Kirim ulang
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function AuditTrail({ roundId, version }: { roundId: string; version: number }) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: AuditEvent[]; pagination: Pagination } | null>(null);
  useEffect(() => {
    void getRoundEvents(roundId, page).then(setData).catch(() => setData(null));
  }, [roundId, page, version]);
  if (!data || data.pagination.total === 0) return null;
  return (
    <section className="mt-5 overflow-hidden rounded-2xl border border-border/75">
      <h3 className="px-4 pt-3 text-sm font-bold text-brand-heading">Jejak audit</h3>
      <ul className="divide-y divide-border/70 text-xs">
        {data.items.map((event) => (
          <li key={event.id} className="px-4 py-2">
            <span className="font-semibold">{event.eventType}</span> · {event.actorName} ·{" "}
            {new Date(event.occurredAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}
            {event.reason ? <span className="block text-muted-foreground">{event.reason}</span> : null}
          </li>
        ))}
      </ul>
      <PaginationBar page={data.pagination.page} pageSize={data.pagination.pageSize} total={data.pagination.total} onPageChange={setPage} />
    </section>
  );
}

export function AdminRewardsPage() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [source, setSource] = useState<SourceState | null>(null);
  const [items, setItems] = useState<RoundSummary[]>([]);
  const [paging, setPaging] = useState<Pagination | null>(null);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<RoundStatus | "">("");
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problems, setProblems] = useState<Array<{ line: number; message: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [month, setMonth] = useState(previousMonth);
  const [importNote, setImportNote] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [roundId, openRound, closeRound] = useDialogParam("putaran");
  const [round, setRound] = useState<RoundDetail | null>(null);
  const [roundVersion, setRoundVersion] = useState(0);

  const canManage = hasPermission(session, "reward.manage");
  const canImport = hasPermission(session, "reward.import");

  const load = async () => {
    setLoading(true);
    try {
      const [rounds, sourceState] = await Promise.all([getRounds({ page, status }), getSource()]);
      setItems(rounds.items);
      setPaging(rounds.pagination);
      setSource(sourceState);
      setError(null);
    } catch (cause) {
      if (cause instanceof RewardApiError && cause.status === 403) setForbidden(true);
      setError(cause instanceof Error ? cause.message : "Penghargaan tidak dapat dimuat.");
    } finally {
      setLoading(false);
    }
  };

  const loadRound = async (id: string) => {
    try {
      setRound(await getRound(id));
      setRoundVersion((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Putaran tidak dapat dibuka.");
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, status]);
  useEffect(() => {
    void getCurrentSession().then(setSession).catch(() => setSession(null));
  }, []);
  useEffect(() => {
    setRound(null);
    if (roundId) void loadRound(roundId);
  }, [roundId]);

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    setProblems([]);
    try {
      setNotice(await work());
      await load();
      if (roundId) await loadRound(roundId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Tindakan belum dapat diselesaikan.");
      if (cause instanceof RewardApiError) setProblems(cause.problems);
    } finally {
      setBusy(false);
    }
  };

  const reason = (label: string) => {
    const text = window.prompt(`${label} (5–500 karakter)`)?.trim();
    return text && text.length >= 5 ? text : null;
  };

  const onAction = (action: "award" | "decline" | "next" | "publish" | "cancel" | "revoke" | "retry", id: string) => {
    if (action === "award") void run(async () => { await awardCandidate(id); return "Kandidat ditetapkan."; });
    if (action === "next") void run(async () => { await takeNextRank(id); return "Peringkat berikutnya ditambahkan dari snapshot yang sama."; });
    if (action === "retry") void run(async () => { await retryEffect(id); return "Pengiriman dicoba lagi."; });
    if (action === "publish") {
      if (!window.confirm("Terbitkan putaran ini? Penerima diberi tahu, pengumuman terbit, dan putaran tidak bisa diubah lagi.")) return;
      void run(async () => { const result = await publishRound(id); return `Putaran terbit dengan ${result.awards} penerima.`; });
    }
    const needsReason = { decline: "Alasan tidak ditetapkan", cancel: "Alasan membatalkan putaran", revoke: "Alasan mencabut penghargaan" } as const;
    if (action === "decline" || action === "cancel" || action === "revoke") {
      const text = reason(needsReason[action]);
      if (!text) return;
      if (action === "decline") void run(async () => { await declineCandidate(id, text); return "Kandidat tidak ditetapkan."; });
      if (action === "cancel") void run(async () => { await cancelRound(id, text); return "Putaran dibatalkan."; });
      if (action === "revoke") void run(async () => { await revokeAward(id, text); return "Penghargaan dicabut."; });
    }
  };

  const submitImport = () => {
    if (!importFile) return;
    void run(async () => {
      const csv = await importFile.text();
      const result = await importSnapshot(month, importNote.trim(), csv);
      openRound(result.id);
      return `Snapshot diimpor: ${result.rows} baris, ${result.candidates} kandidat.`;
    });
  };

  return (
    <AdminShell active="services" title="Penghargaan" description="Penghargaan tilawah bulanan dari papan skor aplikasi Al-Qur'an.">
      {error ? (
        <div role="alert" className="mb-5 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">
          {error}
          {problems.length ? (
            <ul className="mt-2 list-disc pl-5">{problems.map((problem) => <li key={`${problem.line}-${problem.message}`}>Baris {problem.line}: {problem.message}</li>)}</ul>
          ) : null}
        </div>
      ) : null}
      {notice ? <div role="status" className="mb-5 rounded-2xl border border-border bg-surface p-4 text-sm text-brand-heading">{notice}</div> : null}

      {forbidden ? null : (
        <>
          {source ? <SourceBanner source={source} /> : null}

          {(canManage && source && !source.manualImportOpen) || (canImport && source?.manualImportOpen) ? (
            <section className="mb-6 grid gap-4 rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)] [&>*]:min-w-0 sm:grid-cols-2">
              <label className="text-xs font-semibold text-muted-foreground">Bulan
                <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} className={field} />
              </label>
              {canManage && source && !source.manualImportOpen ? (
                <div className="flex items-end">
                  <button type="button" disabled={busy || !month} className={`${button} bg-brand-primary text-brand-foreground`}
                    onClick={() => void run(async () => { const created = await buildRound(month); openRound(created.id); return "Putaran disusun dari papan skor."; })}>
                    <RefreshCw className="h-4 w-4" aria-hidden="true" />Susun ulang
                  </button>
                </div>
              ) : null}
              {canImport && source?.manualImportOpen ? (
                <div className="space-y-3 sm:col-span-2">
                  <p className="text-xs text-muted-foreground">
                    Impor snapshot manual (sementara, sampai aplikasi Al-Qur&apos;an tersambung). Kolom CSV:{" "}
                    <code className="rounded bg-muted px-1 break-all">{MANUAL_CSV_TEMPLATE.split("\n")[0]}</code>. Cakupan diisi YAYASAN atau nama/kode unit; label kosong, otomatis, atau mandiri.
                    Kepala HCM yang memutuskan; pengimpor tidak dapat memutuskan.
                  </p>
                  <label className="block text-xs font-semibold text-muted-foreground">Catatan sumber data
                    <input value={importNote} maxLength={500} onChange={(event) => setImportNote(event.target.value)} className={field}
                      placeholder="Mis. rekap papan skor dari koordinator tilawah" />
                  </label>
                  <label className="block text-xs font-semibold text-muted-foreground">Berkas CSV
                    <input type="file" accept=".csv,text/csv" onChange={(event) => setImportFile(event.target.files?.[0] ?? null)} className="mt-1 block text-sm" />
                  </label>
                  <button type="button" disabled={busy || !importFile || importNote.trim().length < 5 || !month} onClick={submitImport}
                    className={`${button} bg-brand-primary text-brand-foreground`}>
                    <Upload className="h-4 w-4" aria-hidden="true" />Impor snapshot
                  </button>
                </div>
              ) : null}
            </section>
          ) : null}

          <section className="overflow-hidden rounded-3xl border border-border/75 bg-surface-raised shadow-[var(--shadow-soft)]">
            <div className="p-5">
              <label className="text-xs font-semibold text-muted-foreground">Status
                <select value={status} onChange={(event) => { setPage(1); setStatus(event.target.value as RoundStatus | ""); }} className={field}>
                  <option value="">Semua status</option>
                  {(Object.keys(ROUND_STATUS_LABELS) as RoundStatus[]).map((key) => <option key={key} value={key}>{ROUND_STATUS_LABELS[key]}</option>)}
                </select>
              </label>
            </div>
            {loading ? (
              <div className="flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat putaran...</div>
            ) : items.length === 0 ? (
              <div className="px-5 py-10 text-center text-sm text-muted-foreground">
                <AwardIcon className="mx-auto h-8 w-8" aria-hidden="true" />
                <p className="mt-2 font-bold text-brand-heading">Belum ada putaran</p>
              </div>
            ) : (
              <ul className="divide-y divide-border/70 border-t border-border/70">
                {items.map((item) => (
                  <li key={item.id}>
                    <button type="button" onClick={() => openRound(item.id)} className="w-full px-5 py-3 text-left hover:bg-muted/50">
                      <span className="block font-semibold text-brand-heading">{monthLabel(item.month)} · {ROUND_STATUS_LABELS[item.status]}</span>
                      <span className="block text-xs text-muted-foreground">
                        {item.candidateCount} kandidat · {item.awardedCount} ditetapkan · {SOURCE_KIND_LABELS[item.sourceKind]}
                        {item.directoryStale ? " · Direktori tertinggal" : ""}
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
        </>
      )}

      {!forbidden && roundId ? (
        <DetailDialog wide title="Putaran penghargaan" description={round ? monthLabel(round.month) : undefined} onClose={closeRound}>
          {error ? <div role="alert" className="mb-4 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div> : null}
          {notice ? <div role="status" className="mb-4 rounded-2xl border border-border bg-surface p-4 text-sm text-brand-heading">{notice}</div> : null}
          {round?.id === roundId ? (
            <>
              <RoundDetailView round={round} busy={busy} onAction={onAction} />
              <AuditTrail roundId={round.id} version={roundVersion} />
            </>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat putaran...</div>
          )}
        </DetailDialog>
      ) : null}
    </AdminShell>
  );
}
