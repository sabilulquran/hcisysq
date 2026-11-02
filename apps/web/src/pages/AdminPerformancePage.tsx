// PERF-001 Human Capital surface: cycles and their rubric, participants, the recap table, review
// validation, rater assignment, and per-employee history. Spec: docs/domain/performance-review.md.
// The API authorizes every call and computes every score and predicate.

import { Loader2, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";

import { EmployeeSearchField, type PickedEmployee } from "@/components/attendance/workforce/EmployeeSearchField";
import { PaginationBar } from "@/components/PaginationBar";
import { ReviewDetailPanel } from "@/components/performance/ReviewDetailPanel";
import { AdminShell } from "@/layouts/AdminShell";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import {
  addParticipants,
  assignRater,
  cancelCycle,
  closeCycle,
  createCycle,
  CYCLE_KIND_LABELS,
  CYCLE_STATUS_LABELS,
  finalizeReview,
  formatPeriod,
  formatScore,
  getAdminReview,
  getCycle,
  getCycleReviews,
  getCycles,
  getEmployeeHistory,
  monthlyDefaults,
  openCycle,
  PerformanceApiError,
  raterSourceLabel,
  removeReview,
  returnReview,
  REVIEW_STATUS_LABELS,
  reviewStatusLabel,
  updateCycle,
  type CycleDetail,
  type CycleInput,
  type CycleKind,
  type CycleStatus,
  type CycleSummary,
  type Pagination,
  type ReviewDetail,
  type ReviewStatus,
  type ReviewSummary,
  type Rubric,
} from "@/lib/performance";
import type { AuthSession } from "@/types/hcis";

const card = "rounded-3xl border border-border/75 bg-surface-raised shadow-[var(--shadow-soft)]";
const field = "mt-1 h-11 w-full rounded-xl border bg-surface px-3 text-sm text-foreground";
const primary = "min-h-11 rounded-xl bg-brand-primary px-3 text-sm font-bold text-brand-foreground disabled:opacity-50";
const secondary = "min-h-11 rounded-xl border border-border px-3 text-sm font-bold text-brand-heading disabled:opacity-50";
const danger = "min-h-11 rounded-xl border border-danger-line px-3 text-sm font-bold text-danger-ink disabled:opacity-50";

function message(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

export function AdminPerformancePage() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [cycles, setCycles] = useState<CycleSummary[]>([]);
  const [cyclePaging, setCyclePaging] = useState<Pagination | null>(null);
  const [cyclePage, setCyclePage] = useState(1);
  const [cycleStatus, setCycleStatus] = useState<CycleStatus | "">("");
  const [cycle, setCycle] = useState<CycleDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const canManage = hasPermission(session, "performance.manage");
  // The employee picker reads the employee register, which performance.* alone does not open.
  const canSearchEmployees = hasPermission(session, "employees.manage");

  const loadCycles = async () => {
    setLoading(true);
    try {
      const result = await getCycles(cyclePage, cycleStatus);
      setCycles(result.items);
      setCyclePaging(result.pagination);
      setError(null);
    } catch (cause) {
      if (cause instanceof PerformanceApiError && cause.status === 403) setForbidden(true);
      setError(message(cause, "Siklus penilaian tidak dapat dimuat."));
    } finally {
      setLoading(false);
    }
  };

  const openCycleDetail = async (id: string) => {
    try {
      setCycle(await getCycle(id));
      setCreating(false);
    } catch (cause) {
      setError(message(cause, "Siklus tidak dapat dibuka."));
    }
  };

  useEffect(() => {
    void loadCycles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cyclePage, cycleStatus]);
  useEffect(() => {
    void getCurrentSession().then(setSession).catch(() => {
      setSession(null);
      setError("Izin akun tidak dapat dibaca, sehingga tombol tindakan disembunyikan. Muat ulang halaman.");
    });
  }, []);

  /** Runs one action, shows its notice, and reloads the list and the open cycle. */
  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      setNotice(await action());
      await loadCycles();
      if (cycle) await openCycleDetail(cycle.id);
    } catch (cause) {
      setError(message(cause, "Tindakan belum dapat diselesaikan."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AdminShell active="services" title="Penilaian Kinerja" description="Siklus penilaian, rubrik, pengesahan hasil, dan rekap predikat.">
      {error ? <div className="mb-5 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div> : null}
      {notice ? <div className="mb-5 rounded-2xl border border-border bg-surface p-4 text-sm text-brand-heading">{notice}</div> : null}

      {forbidden ? null : (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,2fr)]">
          <section className={`overflow-hidden ${card}`}>
            <div className="space-y-3 p-5">
              <label className="block text-xs font-semibold text-muted-foreground">
                Status siklus
                <select value={cycleStatus} onChange={(event) => { setCyclePage(1); setCycleStatus(event.target.value as CycleStatus | ""); }} className={field}>
                  <option value="">Semua status</option>
                  {(Object.keys(CYCLE_STATUS_LABELS) as CycleStatus[]).map((key) => <option key={key} value={key}>{CYCLE_STATUS_LABELS[key]}</option>)}
                </select>
              </label>
              {canManage ? (
                <button type="button" className={`${secondary} inline-flex w-full items-center justify-center gap-2`} onClick={() => { setCreating(true); setCycle(null); }}>
                  <Plus className="h-4 w-4" aria-hidden="true" /> Siklus baru
                </button>
              ) : null}
            </div>
            {loading ? (
              <div className="flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat siklus...</div>
            ) : cycles.length === 0 ? (
              <p className="px-5 py-8 text-sm text-muted-foreground">Belum ada siklus penilaian.</p>
            ) : (
              <ul className="divide-y divide-border/70 border-t border-border/70">
                {cycles.map((item) => (
                  <li key={item.id}>
                    <button type="button" onClick={() => void openCycleDetail(item.id)}
                      className={`w-full px-5 py-3 text-left hover:bg-muted/50 ${cycle?.id === item.id ? "bg-muted/60" : ""}`}>
                      <span className="block font-semibold text-brand-heading">{item.name}</span>
                      <span className="block text-xs text-muted-foreground">{CYCLE_KIND_LABELS[item.kind]} · {formatPeriod(item.periodStart, item.periodEnd)}</span>
                      <span className="mt-1 block text-[11px] font-semibold text-muted-foreground">
                        {CYCLE_STATUS_LABELS[item.status]}{item.participantCount !== undefined ? ` · ${item.participantCount} peserta` : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {cyclePaging && cyclePaging.total > 0 ? (
              <PaginationBar page={cyclePaging.page} pageSize={cyclePaging.pageSize} total={cyclePaging.total} onPageChange={setCyclePage} />
            ) : null}
          </section>

          <div className="min-w-0 space-y-6">
            {creating && canManage ? (
              <CycleForm busy={busy} onCancel={() => setCreating(false)} onSubmit={(input) => void run(async () => {
                const created = await createCycle(input);
                setCreating(false);
                await openCycleDetail(created.id);
                return "Siklus draf dibuat. Atur rubrik dan tambahkan peserta sebelum membuka siklus.";
              })} />
            ) : cycle ? (
              <CycleWorkspace key={cycle.id} cycle={cycle} canManage={canManage} canSearchEmployees={canSearchEmployees} busy={busy} run={run} />
            ) : (
              <p className={`${card} p-5 text-sm text-muted-foreground`}>Pilih siklus untuk melihat rekap dan penilaiannya.</p>
            )}
          </div>
        </div>
      )}
    </AdminShell>
  );
}

function CycleForm({ busy, onSubmit, onCancel }: { busy: boolean; onSubmit: (input: CycleInput) => void; onCancel: () => void }) {
  const [form, setForm] = useState<CycleInput>(monthlyDefaults);
  const update = (patch: Partial<CycleInput>) => setForm((current) => ({ ...current, ...patch }));
  return (
    <form className={`${card} p-5`} onSubmit={(event) => { event.preventDefault(); onSubmit({ ...form, name: form.name.trim() }); }}>
      <div className="flex items-start justify-between">
        <h2 className="text-sm font-bold text-brand-heading">Siklus penilaian baru</h2>
        <button type="button" aria-label="Tutup" onClick={onCancel} className="rounded-lg p-1 hover:bg-muted"><X className="h-4 w-4" /></button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Bulanan memakai satu bulan kalender penuh; tahunan memakai satu tahun ajaran (1 Juli–30 Juni). Rubrik bawaan dipakai dan dapat diubah selama draf.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-semibold text-muted-foreground sm:col-span-2">
          Nama
          <input required minLength={3} maxLength={120} value={form.name} onChange={(event) => update({ name: event.target.value })} className={field} />
        </label>
        <label className="text-xs font-semibold text-muted-foreground">
          Jenis
          <select value={form.kind} onChange={(event) => update({ kind: event.target.value as CycleKind })} className={field}>
            {(Object.keys(CYCLE_KIND_LABELS) as CycleKind[]).map((key) => <option key={key} value={key}>{CYCLE_KIND_LABELS[key]}</option>)}
          </select>
        </label>
        <span className="hidden sm:block" />
        {([
          ["periodStart", "Awal periode"], ["periodEnd", "Akhir periode"],
          ["selfDueOn", "Batas penilaian diri"], ["reviewDueOn", "Batas penilaian atasan"],
        ] as const).map(([key, label]) => (
          <label key={key} className="text-xs font-semibold text-muted-foreground">
            {label}
            <input type="date" required value={form[key]} onChange={(event) => update({ [key]: event.target.value })} className={field} />
          </label>
        ))}
      </div>
      <button type="submit" disabled={busy || form.name.trim().length < 3} className={`${primary} mt-4`}>Buat siklus draf</button>
    </form>
  );
}

function CycleWorkspace({ cycle, canManage, canSearchEmployees, busy, run }: {
  cycle: CycleDetail;
  canManage: boolean;
  canSearchEmployees: boolean;
  busy: boolean;
  run: (action: () => Promise<string>) => Promise<void>;
}) {
  const [items, setItems] = useState<ReviewSummary[]>([]);
  const [paging, setPaging] = useState<Pagination | null>(null);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<ReviewStatus | "">(cycle.status === "OPEN" ? "HC_VALIDATION" : "");
  const [predicate, setPredicate] = useState("");
  const [raterMissing, setRaterMissing] = useState(false);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [participant, setParticipant] = useState<PickedEmployee | null>(null);
  const [review, setReview] = useState<ReviewDetail | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const editable = cycle.status === "DRAFT" || cycle.status === "OPEN";

  useEffect(() => {
    const timer = window.setTimeout(() => { setPage(1); setDebounced(search); }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const load = async () => {
    setLoading(true);
    try {
      const result = await getCycleReviews(cycle.id, { page, status, predicate, q: debounced, raterMissing: raterMissing ? true : null });
      setItems(result.items);
      setPaging(result.pagination);
      setListError(null);
    } catch (cause) {
      setListError(message(cause, "Penilaian tidak dapat dimuat."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, status, predicate, raterMissing, debounced, cycle]);

  const openReview = async (id: string) => {
    try {
      setReview(await getAdminReview(id));
    } catch (cause) {
      setListError(message(cause, "Penilaian tidak dapat dibuka."));
    }
  };

  /** Review actions reload the review itself as well as the cycle. */
  const act = (action: () => Promise<string>) => void run(async () => {
    const text = await action();
    if (review) await openReview(review.id);
    return text;
  });

  return (
    <>
      <section className={`${card} p-5`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-muted-foreground">{CYCLE_KIND_LABELS[cycle.kind]} · {formatPeriod(cycle.periodStart, cycle.periodEnd)}</p>
            <h2 className="mt-1 text-lg font-bold text-brand-heading">{cycle.name}</h2>
            <p className="text-xs text-muted-foreground">
              {CYCLE_STATUS_LABELS[cycle.status]} · penilaian diri sampai {cycle.selfDueOn} · penilai sampai {cycle.reviewDueOn}
            </p>
          </div>
          {canManage ? (
            <div className="flex flex-wrap gap-2">
              {cycle.status === "DRAFT" ? (
                <>
                  <button type="button" disabled={busy} className={primary} onClick={() => {
                    if (!window.confirm("Buka siklus? Rubrik dikunci dan peserta mendapat notifikasi.")) return;
                    void run(async () => `Siklus dibuka untuk ${(await openCycle(cycle.id)).participants} peserta.`);
                  }}>Buka siklus</button>
                  <button type="button" disabled={busy} className={danger} onClick={() => {
                    const reason = window.prompt("Alasan membatalkan siklus draf (minimal 10 karakter)");
                    if (!reason || reason.trim().length < 10) return;
                    void run(async () => { await cancelCycle(cycle.id, reason.trim()); return "Siklus dibatalkan."; });
                  }}>Batalkan</button>
                </>
              ) : null}
              {cycle.status === "OPEN" ? (
                <button type="button" disabled={busy} className={secondary} onClick={() => {
                  if (!window.confirm("Tutup siklus? Penilaian yang belum dinilai menjadi Tidak dinilai dan siklus tidak dapat dibuka lagi.")) return;
                  void run(async () => {
                    const result = await closeCycle(cycle.id);
                    return `Siklus ditutup: ${result.finalized} final, ${result.unrated} tidak dinilai.`;
                  });
                }}>Tutup siklus</button>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          <Stat label="Peserta" value={cycle.recap.participants} />
          <Stat label="Menunggu pengesahan" value={cycle.recap.byStatus.HC_VALIDATION} />
          <Stat label="Final" value={cycle.recap.byStatus.FINALIZED} />
          <Stat label="Tanpa penilai" value={cycle.recap.raterMissing} warn={cycle.recap.raterMissing > 0} />
        </div>
        {cycle.recap.raterAccountNotReady > 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">{cycle.recap.raterAccountNotReady} penilaian menunggu penilai yang akunnya belum aktif.</p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          {cycle.recap.byPredicate.map((item) => (
            <span key={item.code} className="rounded-full bg-muted px-3 py-1 font-semibold text-brand-heading">
              {item.code} {item.label}: {item.count}
            </span>
          ))}
        </div>

        {cycle.status === "DRAFT" && canManage ? <RubricEditor cycle={cycle} busy={busy} run={run} /> : <RubricView rubric={cycle.rubric} />}

        {canManage && editable ? (
          <div className="mt-5 rounded-2xl border border-border/70 bg-surface p-4">
            <h3 className="text-sm font-bold text-brand-heading">Peserta</h3>
            <p className="mt-1 text-xs text-muted-foreground">Penilai diambil dari atasan langsung menurut struktur saat pegawai ditambahkan.</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              {canSearchEmployees ? <EmployeeSearchField value={participant} onChange={setParticipant} label="Tambah satu pegawai" /> : <span />}
              <div className="flex flex-wrap gap-2">
                {canSearchEmployees ? (
                  <button type="button" disabled={busy || !participant} className={secondary} onClick={() => participant && void run(async () => {
                    const result = await addParticipants(cycle.id, { employeeIds: [participant.id] });
                    setParticipant(null);
                    return participantNotice(result);
                  })}>Tambah</button>
                ) : null}
                <button type="button" disabled={busy} className={secondary} onClick={() => {
                  if (!window.confirm("Tambahkan semua pegawai aktif yang belum menjadi peserta?")) return;
                  void run(async () => participantNotice(await addParticipants(cycle.id, { allActive: true })));
                }}>Semua pegawai aktif</button>
              </div>
            </div>
          </div>
        ) : null}
      </section>

      <section className={`overflow-hidden ${card}`}>
        <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-xs font-semibold text-muted-foreground">
            Cari pegawai
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Nama atau NIP (min. 2 huruf)" className={field} />
          </label>
          <label className="text-xs font-semibold text-muted-foreground">
            Status
            <select value={status} onChange={(event) => { setPage(1); setStatus(event.target.value as ReviewStatus | ""); }} className={field}>
              <option value="">Semua status</option>
              {(Object.keys(REVIEW_STATUS_LABELS) as ReviewStatus[]).map((key) => <option key={key} value={key}>{REVIEW_STATUS_LABELS[key]}</option>)}
            </select>
          </label>
          <label className="text-xs font-semibold text-muted-foreground">
            Predikat (final)
            <select value={predicate} onChange={(event) => { setPage(1); setPredicate(event.target.value); }} className={field}>
              <option value="">Semua predikat</option>
              {cycle.rubric.predicates.map((item) => <option key={item.code} value={item.code}>{item.code} {item.label}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 self-end text-xs font-semibold text-muted-foreground sm:h-11">
            <input type="checkbox" checked={raterMissing} onChange={(event) => { setPage(1); setRaterMissing(event.target.checked); }} />
            Hanya tanpa penilai
          </label>
        </div>
        {listError ? <p className="px-5 pb-3 text-sm text-danger-ink">{listError}</p> : null}
        {loading ? (
          <div className="flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat penilaian...</div>
        ) : items.length === 0 ? (
          <p className="px-5 py-8 text-sm text-muted-foreground">Tidak ada penilaian pada filter ini.</p>
        ) : (
          <div className="overflow-x-auto border-t border-border/70">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr><th className="px-5 py-2">Pegawai</th><th className="px-3 py-2">Penilai</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Nilai</th></tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {items.map((item) => (
                  <tr key={item.id} onClick={() => void openReview(item.id)}
                    className={`cursor-pointer hover:bg-muted/50 ${review?.id === item.id ? "bg-muted/60" : ""}`}>
                    <td className="px-5 py-2">
                      <button type="button" className="text-left font-semibold text-brand-heading" onClick={(event) => { event.stopPropagation(); void openReview(item.id); }}>
                        {item.employeeName}
                      </button>
                      <span className="block text-xs text-muted-foreground">{item.employeeNumber}{item.unitName ? ` · ${item.unitName}` : ""}</span>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {item.raterName ?? <span className="text-danger-ink">Belum ada</span>}
                      <span className="block text-muted-foreground">{raterSourceLabel(item.raterSource)}{item.raterName && item.raterAccountReady === false ? " · akun belum aktif" : ""}</span>
                    </td>
                    <td className="px-3 py-2 text-xs">{reviewStatusLabel(item.status)}</td>
                    <td className="px-3 py-2 text-xs">{item.predicateCode ? `${item.predicateCode} · ${formatScore(item.finalScore)}` : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {paging && paging.total > 0 ? (
          <PaginationBar page={paging.page} pageSize={paging.pageSize} total={paging.total} onPageChange={setPage} />
        ) : null}
      </section>

      {review ? (
        <section className={`${card} p-5`}>
          <div className="flex justify-end">
            <button type="button" aria-label="Tutup detail" onClick={() => setReview(null)} className="rounded-lg p-1 hover:bg-muted"><X className="h-4 w-4" /></button>
          </div>
          <ReviewDetailPanel
            review={review}
            form={canManage && review.allowedActions.includes("assign-rater") && canSearchEmployees ? (
              <RaterPicker key={review.id} busy={busy} onAssign={(rater, reason) => act(async () => {
                await assignRater(review.id, rater.id, reason);
                return `${rater.fullName} ditunjuk sebagai penilai.`;
              })} />
            ) : null}
            actions={canManage ? (
              <>
                {review.allowedActions.includes("finalize") ? (
                  <button type="button" disabled={busy} className={primary} onClick={() => act(async () => {
                    await finalizeReview(review.id);
                    return `Penilaian ${review.employeeName} disahkan.`;
                  })}>Sahkan</button>
                ) : null}
                {review.allowedActions.includes("return") ? (
                  <button type="button" disabled={busy} className={secondary} onClick={() => {
                    const reason = window.prompt("Alasan mengembalikan ke penilai (minimal 10 karakter)");
                    if (!reason || reason.trim().length < 10) return;
                    act(async () => { await returnReview(review.id, reason.trim()); return "Penilaian dikembalikan ke penilai."; });
                  }}>Kembalikan ke penilai</button>
                ) : null}
                {review.allowedActions.includes("remove") ? (
                  <button type="button" disabled={busy} className={`${danger} inline-flex items-center gap-1`} onClick={() => {
                    const reason = window.prompt("Alasan mengeluarkan pegawai dari siklus (minimal 5 karakter)");
                    if (!reason || reason.trim().length < 5) return;
                    act(async () => { await removeReview(review.id, reason.trim()); return "Pegawai dikeluarkan dari siklus."; });
                  }}><Trash2 className="h-4 w-4" aria-hidden="true" />Keluarkan</button>
                ) : null}
              </>
            ) : null}
          />
          <EmployeeHistory key={review.employeeId} employeeId={review.employeeId} />
        </section>
      ) : null}
    </>
  );
}

function participantNotice(result: { added: number; readded: number; alreadyIn: number; withoutRater: number }) {
  const parts = [`${result.added + result.readded} pegawai ditambahkan`];
  if (result.alreadyIn) parts.push(`${result.alreadyIn} sudah menjadi peserta`);
  if (result.withoutRater) parts.push(`${result.withoutRater} belum punya penilai dan perlu ditunjuk`);
  return `${parts.join(", ")}.`;
}

function Stat({ label, value, warn = false }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-surface p-3">
      <p className="text-xs font-semibold text-muted-foreground">{label}</p>
      <p className={`mt-1 text-xl font-bold ${warn ? "text-danger-ink" : "text-brand-heading"}`}>{value}</p>
    </div>
  );
}

function RubricView({ rubric }: { rubric: Rubric }) {
  return (
    <details className="mt-5 rounded-2xl border border-border/70 bg-surface p-4 text-sm">
      <summary className="cursor-pointer font-bold text-brand-heading">Rubrik (terkunci)</summary>
      <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
        {rubric.indicators.map((item) => <li key={item.code}>{item.label} · {item.weight}%</li>)}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">
        Predikat: {rubric.predicates.map((item) => `${item.code} ${item.label} ≥ ${formatScore(item.minScore)}`).join("; ")}
      </p>
    </details>
  );
}

function codeFrom(label: string, taken: string[]) {
  const base = label.toUpperCase().normalize("NFD").replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30) || "INDIKATOR";
  let candidate = /^[A-Z]/.test(base) ? base : `I_${base}`;
  for (let index = 2; taken.includes(candidate); index += 1) candidate = `${base}_${index}`;
  return candidate;
}

/** Editing a DRAFT rubric; the server validates weights and boundaries on save. */
function RubricEditor({ cycle, busy, run }: { cycle: CycleDetail; busy: boolean; run: (action: () => Promise<string>) => Promise<void> }) {
  const [rubric, setRubric] = useState<Rubric>(cycle.rubric);
  const total = rubric.indicators.reduce((sum, item) => sum + (Number.isFinite(item.weight) ? item.weight : 0), 0);
  const setIndicator = (index: number, patch: Partial<Rubric["indicators"][number]>) =>
    setRubric((current) => ({ ...current, indicators: current.indicators.map((item, at) => (at === index ? { ...item, ...patch } : item)) }));
  const setPredicate = (index: number, patch: Partial<Rubric["predicates"][number]>) =>
    setRubric((current) => ({ ...current, predicates: current.predicates.map((item, at) => (at === index ? { ...item, ...patch } : item)) }));

  return (
    <div className="mt-5 rounded-2xl border border-border/70 bg-surface p-4">
      <h3 className="text-sm font-bold text-brand-heading">Rubrik (draf)</h3>
      <p className="mt-1 text-xs text-muted-foreground">Skala nilai 1–4. Jumlah bobot harus 100; saat ini {total}.</p>
      <div className="mt-3 space-y-2">
        {rubric.indicators.map((item, index) => (
          <div key={item.code} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_5rem_auto]">
            <input aria-label="Nama indikator" value={item.label} onChange={(event) => setIndicator(index, { label: event.target.value })} className={field} />
            <input aria-label="Keterangan indikator" value={item.description} onChange={(event) => setIndicator(index, { description: event.target.value })} className={field} />
            <input aria-label="Bobot" type="number" min={1} max={100} value={item.weight}
              onChange={(event) => setIndicator(index, { weight: Number(event.target.value) })} className={field} />
            <button type="button" aria-label={`Hapus ${item.label}`} disabled={rubric.indicators.length <= 1} className="rounded-lg p-2 hover:bg-muted disabled:opacity-40"
              onClick={() => setRubric((current) => ({ ...current, indicators: current.indicators.filter((_, at) => at !== index) }))}>
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
        <button type="button" className={`${secondary} inline-flex items-center gap-1`} onClick={() => setRubric((current) => ({
          ...current,
          indicators: [...current.indicators, { code: codeFrom("Indikator baru", current.indicators.map((item) => item.code)), label: "Indikator baru", description: "", weight: 0 }],
        }))}><Plus className="h-4 w-4" aria-hidden="true" />Indikator</button>
      </div>
      <h4 className="mt-4 text-xs font-bold text-muted-foreground">Predikat dan batas bawah nilai akhir</h4>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {rubric.predicates.map((item, index) => (
          <div key={item.code} className="grid grid-cols-[3rem_minmax(0,1fr)_6rem] items-center gap-2">
            <span className="text-sm font-bold text-brand-heading">{item.code}</span>
            <input aria-label={`Label predikat ${item.code}`} value={item.label} onChange={(event) => setPredicate(index, { label: event.target.value })} className={field} />
            <input aria-label={`Batas bawah ${item.code}`} type="number" step="0.01" min={1} max={4} value={item.minScore}
              onChange={(event) => setPredicate(index, { minScore: Number(event.target.value) })} className={field} />
          </div>
        ))}
      </div>
      <button type="button" disabled={busy} className={`${primary} mt-4`} onClick={() => void run(async () => {
        await updateCycle(cycle.id, { rubric: { ...rubric, indicators: rubric.indicators.map((item) => ({ ...item, label: item.label.trim(), description: item.description.trim() })) } });
        return "Rubrik disimpan.";
      })}>Simpan rubrik</button>
    </div>
  );
}

function RaterPicker({ busy, onAssign }: { busy: boolean; onAssign: (rater: PickedEmployee, reason: string) => void }) {
  const [rater, setRater] = useState<PickedEmployee | null>(null);
  const [reason, setReason] = useState("");
  return (
    <div className="rounded-2xl border border-border/70 bg-surface p-4">
      <h3 className="text-sm font-bold text-brand-heading">Tunjuk penilai</h3>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <EmployeeSearchField value={rater} onChange={setRater} label="Penilai" />
        <label className="text-xs font-semibold text-muted-foreground">
          Alasan
          <input value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} placeholder="Contoh: atasan belum tercatat di struktur" className={field} />
        </label>
      </div>
      <button type="button" disabled={busy || !rater || reason.trim().length < 5} className={`${secondary} mt-3`}
        onClick={() => rater && onAssign(rater, reason.trim())}>Simpan penilai</button>
    </div>
  );
}

function EmployeeHistory({ employeeId }: { employeeId: string }) {
  const [items, setItems] = useState<ReviewSummary[]>([]);
  const [paging, setPaging] = useState<Pagination | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getEmployeeHistory(employeeId, page)
      .then((result) => { setItems(result.items); setPaging(result.pagination); setError(null); })
      .catch((cause) => setError(message(cause, "Riwayat tidak dapat dimuat.")));
  }, [employeeId, page]);

  return (
    <section className="mt-6 border-t border-border/70 pt-4">
      <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Riwayat penilaian pegawai</h3>
      {error ? <p className="mt-2 text-sm text-danger-ink">{error}</p> : null}
      <ul className="mt-2 divide-y divide-border/70 text-sm">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap justify-between gap-2 py-2">
            <span>{item.cycleName}<span className="block text-xs text-muted-foreground">{formatPeriod(item.periodStart, item.periodEnd)}</span></span>
            <span className="text-xs font-semibold text-brand-heading">
              {item.predicateCode && item.status === "FINALIZED" ? `${item.predicateCode} ${item.predicateLabel} · ${formatScore(item.finalScore)}` : reviewStatusLabel(item.status)}
            </span>
          </li>
        ))}
      </ul>
      {paging && paging.total > paging.pageSize ? (
        <PaginationBar page={paging.page} pageSize={paging.pageSize} total={paging.total} onPageChange={setPage} />
      ) : null}
    </section>
  );
}
