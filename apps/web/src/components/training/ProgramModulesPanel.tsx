// TRAIN-001 R4 HC surface inside an online program pop-up: storage status, modules with materials,
// video upload, quiz, publishing, per-participant progress and manual completion.

import { useEffect, useState } from "react";

import { PaginationBar } from "@/components/PaginationBar";
import type { Pagination } from "@/lib/training";
import { getInstruments, type InstrumentSummary } from "@/lib/trainingEvaluation";
import {
  adminPreviewUrl,
  archiveModule,
  completeMaterialFor,
  createMaterial,
  createModule,
  formatBytes,
  formatDuration,
  getModules,
  getOnlineProgress,
  getStorageInfo,
  publishModule,
  removeMaterial,
  updateModule,
  uploadVideo,
  type AdminModule,
  type ProgressRow,
  type StorageInfo,
} from "@/lib/trainingOnline";

const input = "mt-1 min-h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm font-normal text-brand-heading";
const label = "text-xs font-semibold text-muted-foreground";
const primary = "inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50";
const secondary = "min-h-11 rounded-xl border border-border px-3 text-sm font-bold text-brand-heading disabled:opacity-50";
const danger = "min-h-11 rounded-xl border border-danger-line px-3 text-sm font-bold text-danger-ink disabled:opacity-50";

/** Storage line for HC; exported for markup tests. */
export function StorageLine({ info }: { info: StorageInfo }) {
  if (!info.enabled) return <p className="text-sm text-warning-ink">Modul daring belum diaktifkan di server ini (kapasitas penyimpanan video belum disediakan).</p>;
  return (
    <p className="text-xs text-muted-foreground">
      Penyimpanan video: {formatBytes(info.usedBytes)} dari {formatBytes(info.quotaBytes)} terpakai · maks {formatBytes(info.videoMaxBytes)} per berkas.
    </p>
  );
}

export function ProgramModulesPanel({ programId, programStatus, canManage }: { programId: string; programStatus: string; canManage: boolean }) {
  const editable = canManage && programStatus === "ACTIVE";
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [modules, setModules] = useState<AdminModule[]>([]);
  const [progress, setProgress] = useState<ProgressRow[]>([]);
  const [paging, setPaging] = useState<Pagination | null>(null);
  const [page, setPage] = useState(1);
  const [form, setForm] = useState({ title: "", creditHours: "1" });
  const [material, setMaterial] = useState<Record<string, { kind: "VIDEO" | "TEXT"; title: string; body: string }>>({});
  const [tests, setTests] = useState<InstrumentSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    const storage = await getStorageInfo();
    setInfo(storage);
    if (!storage.enabled) return;
    setModules((await getModules(programId)).items);
  };
  const loadProgress = async () => {
    const result = await getOnlineProgress(programId, page);
    setProgress(result.items);
    setPaging(result.pagination);
  };
  useEffect(() => {
    void load().catch((cause) => setError(cause instanceof Error ? cause.message : "Modul tidak dapat dimuat."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [programId]);
  useEffect(() => {
    if (!info?.enabled) return;
    void loadProgress().catch(() => undefined);
    if (editable) void getInstruments({ kind: "TEST", status: "ACTIVE" }).then((result) => setTests(result.items)).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.enabled, page]);

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await work());
      await load();
      await loadProgress();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Tindakan tidak dapat diproses.");
    } finally {
      setBusy(false);
    }
  };

  if (!info) return null;
  return (
    <div className="mt-6 border-t border-border/70 pt-4">
      <h3 className="text-sm font-bold text-brand-heading">Modul daring</h3>
      <StorageLine info={info} />
      {error ? <div role="alert" className="mt-2 rounded-2xl border border-danger-line bg-danger-soft p-3 text-sm text-danger-ink">{error}</div> : null}
      {notice ? <div role="status" className="mt-2 rounded-2xl border border-border bg-surface p-3 text-sm text-brand-heading">{notice}</div> : null}
      {!info.enabled ? null : (
        <>
          <ol className="mt-3 space-y-3">
            {modules.map((module) => {
              const draft = editable && module.status === "DRAFT";
              const next = material[module.id] ?? { kind: "VIDEO" as const, title: "", body: "" };
              return (
                <li key={module.id} className="rounded-2xl border border-border/70 p-3 text-sm">
                  <p className={`font-semibold ${module.status === "ARCHIVED" ? "text-muted-foreground line-through" : "text-brand-heading"}`}>
                    {module.position}. {module.title}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {module.creditHours} jam kredit · {module.status === "DRAFT" ? "Draf" : module.status === "PUBLISHED" ? "Terbit" : "Diarsipkan"}
                    {module.quizItemCount ? ` · kuis ${module.quizItemCount} soal, lulus ${module.quizPassingScore}` : " · tanpa kuis"}
                  </p>
                  <ul className="mt-2 space-y-2">
                    {module.materials.map((item) => (
                      <li key={item.id} className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          {item.kind === "VIDEO" ? "Video" : "Bacaan"}: {item.title}
                          <span className="ml-1 text-xs text-muted-foreground">
                            {item.kind === "VIDEO" ? (item.hasVideo ? `${formatDuration(item.durationSeconds)} · ${formatBytes(item.byteSize)}` : "belum diunggah") : `${item.bodyLength ?? 0} huruf`}
                          </span>
                        </span>
                        <span className="flex flex-wrap gap-2">
                          {item.hasVideo ? <a className={secondary} href={adminPreviewUrl(item.id)} target="_blank" rel="noreferrer">Pratinjau</a> : null}
                          {draft && item.kind === "VIDEO" ? (
                            <label className={`${secondary} inline-flex cursor-pointer items-center`}>
                              {item.hasVideo ? "Ganti video" : "Unggah MP4"}
                              <input type="file" accept="video/mp4" className="sr-only" disabled={busy}
                                onChange={(event) => {
                                  const file = event.target.files?.[0];
                                  if (file) void run(async () => { const result = await uploadVideo(item.id, file); return `Video tersimpan (${formatDuration(result.durationSeconds)}).`; });
                                }} />
                            </label>
                          ) : null}
                          {draft ? <button type="button" className={danger} disabled={busy} onClick={() => void run(async () => { await removeMaterial(item.id); return "Materi dihapus."; })}>Hapus</button> : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {draft ? (
                    <div className="mt-3 grid gap-2 sm:grid-cols-3">
                      <label className={label}>
                        Materi baru
                        <select className={input} value={next.kind} onChange={(event) => setMaterial({ ...material, [module.id]: { ...next, kind: event.target.value as "VIDEO" | "TEXT" } })}>
                          <option value="VIDEO">Video</option>
                          <option value="TEXT">Bacaan</option>
                        </select>
                      </label>
                      <label className={`${label} sm:col-span-2`}>
                        Judul materi
                        <input className={input} maxLength={200} value={next.title} onChange={(event) => setMaterial({ ...material, [module.id]: { ...next, title: event.target.value } })} />
                      </label>
                      {next.kind === "TEXT" ? (
                        <label className={`${label} sm:col-span-3`}>
                          Isi bacaan
                          <textarea rows={4} maxLength={20000} className={`${input} py-2`} value={next.body}
                            onChange={(event) => setMaterial({ ...material, [module.id]: { ...next, body: event.target.value } })} />
                        </label>
                      ) : null}
                      <div className="sm:col-span-3 flex flex-wrap gap-2">
                        <button type="button" className={secondary} disabled={busy || next.title.trim().length < 3 || (next.kind === "TEXT" && !next.body.trim())}
                          onClick={() => void run(async () => {
                            await createMaterial(module.id, { kind: next.kind, title: next.title.trim(), ...(next.kind === "TEXT" ? { body: next.body.trim() } : {}) });
                            setMaterial({ ...material, [module.id]: { kind: next.kind, title: "", body: "" } });
                            return "Materi ditambahkan.";
                          })}>Tambah materi</button>
                        <label className={label}>
                          Kuis (instrumen tes)
                          <select className={input} value={module.quizInstrumentId ?? ""} disabled={busy}
                            onChange={(event) => void run(async () => { await updateModule(module.id, { quizInstrumentId: event.target.value || null }); return "Kuis disimpan."; })}>
                            <option value="">Tanpa kuis</option>
                            {tests.map((test) => <option key={test.id} value={test.id}>{test.title}</option>)}
                          </select>
                        </label>
                        <button type="button" className={primary} disabled={busy} onClick={() => {
                          if (!window.confirm("Terbitkan modul? Setelah terbit modul tidak dapat diubah.")) return;
                          void run(async () => { await publishModule(module.id); return "Modul terbit dan peserta diberi tahu."; });
                        }}>Terbitkan</button>
                        <button type="button" className={danger} disabled={busy} onClick={() => {
                          const reason = window.prompt("Alasan mengarsipkan modul (minimal 5 karakter)");
                          if (reason && reason.trim().length >= 5) void run(async () => { await archiveModule(module.id, reason.trim()); return "Modul diarsipkan."; });
                        }}>Arsipkan</button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
          {editable && modules.filter((module) => module.status !== "ARCHIVED").length < 20 ? (
            <div className="mt-3 grid gap-2 rounded-2xl border border-border/70 p-3 sm:grid-cols-3">
              <label className={`${label} sm:col-span-2`}>
                Judul modul
                <input className={input} maxLength={200} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
              </label>
              <label className={label}>
                Jam kredit
                <input type="number" min={0.25} max={40} step={0.25} className={input} value={form.creditHours} onChange={(event) => setForm({ ...form, creditHours: event.target.value })} />
              </label>
              <div className="sm:col-span-3">
                <button type="button" className={primary} disabled={busy || form.title.trim().length < 3}
                  onClick={() => void run(async () => {
                    await createModule(programId, { title: form.title.trim(), description: null, creditHours: Number(form.creditHours) });
                    setForm({ title: "", creditHours: "1" });
                    return "Modul draf dibuat. Tambahkan materi lalu terbitkan.";
                  })}>Tambah modul</button>
              </div>
            </div>
          ) : null}

          <h4 className="mt-5 text-sm font-bold text-brand-heading">Kemajuan peserta</h4>
          {progress.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">Belum ada peserta.</p> : (
            <ul className="mt-2 divide-y divide-border/70">
              {progress.map((row) => (
                <li key={row.employeeId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span>
                    <span className="block font-semibold text-brand-heading">{row.fullName}</span>
                    <span className="block text-xs text-muted-foreground">
                      {row.employeeNumber} · materi {row.completedMaterials}/{row.materialCount} · kuis lulus {row.passedQuizzes}
                      {row.participantStatus === "COMPLETED" ? " · selesai" : ""}
                    </span>
                  </span>
                  {editable && row.participantStatus === "ENROLLED" ? (
                    <ManualComplete modules={modules} onSubmit={(materialId, reason) => run(async () => {
                      await completeMaterialFor(materialId, row.employeeId, reason);
                      return "Materi ditandai selesai.";
                    })} busy={busy} />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {paging && paging.total > paging.pageSize ? <PaginationBar page={paging.page} pageSize={paging.pageSize} total={paging.total} onPageChange={setPage} /> : null}
        </>
      )}
    </div>
  );
}

function ManualComplete({ modules, onSubmit, busy }: { modules: AdminModule[]; onSubmit: (materialId: string, reason: string) => Promise<void>; busy: boolean }) {
  const materials = modules.filter((module) => module.status === "PUBLISHED").flatMap((module) => module.materials);
  const [materialId, setMaterialId] = useState("");
  if (materials.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <select aria-label="Materi" className={`${input} mt-0 w-48`} value={materialId} onChange={(event) => setMaterialId(event.target.value)}>
        <option value="">Tandai selesai...</option>
        {materials.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select>
      <button type="button" className={secondary} disabled={busy || !materialId} onClick={() => {
        const reason = window.prompt("Alasan penandaan selesai (aksesibilitas, gangguan teknis; minimal 5 karakter)");
        if (reason && reason.trim().length >= 5) void onSubmit(materialId, reason.trim());
      }}>Simpan</button>
    </span>
  );
}
