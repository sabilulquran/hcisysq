// TRAIN-001 Human Capital surface: programs with sessions, participants and attendance, the
// external-record verification queue, and the yearly hours summary.
// Spec: docs/domain/training.md. The API authorizes every call and owns every rule.

import { Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";

import { EmployeeSearchField, type PickedEmployee } from "@/components/attendance/workforce/EmployeeSearchField";
import { DetailDialog, useDialogParam } from "@/components/DetailDialog";
import { replaceDialogParam } from "@/components/detailDialogUrl";
import { PaginationBar } from "@/components/PaginationBar";
import { AdminShell } from "@/layouts/AdminShell";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import {
  adminCertificateUrl,
  ATTENDANCE_LABELS,
  cancelProgram,
  cancelSession,
  CATEGORY_LABELS,
  completeProgram,
  createProgram,
  createSession,
  describeConflict,
  enrollParticipants,
  eventLabel,
  formatDateRange,
  formatHours,
  formatInstant,
  formatSessionTime,
  getAttendance,
  getHours,
  getParticipants,
  getProgram,
  getPrograms,
  getRecord,
  getRecords,
  PARTICIPANT_STATUS_LABELS,
  PROGRAM_STATUS_LABELS,
  readCertificate,
  RECORD_STATUS_LABELS,
  rejectRecord,
  saveAttendance,
  searchTrainingEmployees,
  todayInJakarta,
  TrainingApiError,
  uploadCertificate,
  verifyRecord,
  wibInstant,
  withdrawParticipant,
  type AttendanceRow,
  type AttendanceStatus,
  type Conflict,
  type HoursRow,
  type Pagination,
  type Participant,
  type ProgramDetail,
  type ProgramStatus,
  type ProgramSummary,
  type RecordDetail,
  type RecordStatus,
  type TrainingCategory,
  type TrainingRecord,
  type TrainingSession,
} from "@/lib/training";
import type { AuthSession } from "@/types/hcis";

type Tab = "programs" | "records" | "hours";

const input = "mt-1 min-h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm font-normal text-brand-heading";
const label = "text-xs font-semibold text-muted-foreground";
const card = "rounded-3xl border border-border/75 bg-surface-raised shadow-[var(--shadow-soft)]";
const primary = "inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50";
const secondary = "min-h-11 rounded-xl border border-border px-3 text-sm font-bold text-brand-heading disabled:opacity-50";
const danger = "min-h-11 rounded-xl border border-danger-line px-3 text-sm font-bold text-danger-ink disabled:opacity-50";

/** Shared by every tab: run one action, show its notice or error and the time conflicts it returned. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<{ blocks: Conflict[]; warnings: Conflict[] }>({ blocks: [], warnings: [] });
  const run = async (action: () => Promise<string | void>, fallback: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    setConflicts({ blocks: [], warnings: [] });
    try {
      const message = await action();
      if (message) setNotice(message);
    } catch (cause) {
      if (cause instanceof TrainingApiError && cause.conflicts.length > 0) setConflicts({ blocks: cause.conflicts, warnings: [] });
      setError(cause instanceof Error ? cause.message : fallback);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, notice, conflicts, setError, setNotice, setConflicts, run };
}

function Feedback({ action }: { action: ReturnType<typeof useAction> }) {
  const { error, notice, conflicts } = action;
  return (
    <>
      {error ? <div className="mb-4 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div> : null}
      {conflicts.blocks.length > 0 ? (
        <ul className="mb-4 list-disc rounded-2xl border border-danger-line bg-danger-soft p-4 pl-8 text-sm text-danger-ink">
          {conflicts.blocks.map((item, index) => <li key={`${item.employeeId}-${index}`}>{describeConflict(item)}</li>)}
        </ul>
      ) : null}
      {notice ? <div className="mb-4 rounded-2xl border border-border bg-surface p-4 text-sm text-brand-heading">{notice}</div> : null}
      {conflicts.warnings.length > 0 ? (
        <ul className="mb-4 list-disc rounded-2xl border border-warning-line bg-warning-soft p-4 pl-8 text-sm text-warning-ink">
          {conflicts.warnings.map((item, index) => <li key={`${item.employeeId}-${index}`}>Peringatan: {describeConflict(item)}</li>)}
        </ul>
      ) : null}
    </>
  );
}

function DialogLoading() {
  return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat...</div>;
}

export function AdminTrainingPage() {
  const [session, setSession] = useState<AuthSession | null>(null);
  // A link to a record (`?catatan=<id>`) opens on the tab that shows it.
  const [tab, setTab] = useState<Tab>(() => (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("catatan") ? "records" : "programs"));
  const canManage = hasPermission(session, "training.manage");

  useEffect(() => {
    void getCurrentSession().then(setSession).catch(() => setSession(null));
  }, []);

  return (
    <AdminShell active="services" title="Pelatihan" description="Program, jadwal, peserta, kehadiran, catatan, dan jam pelatihan pegawai.">
      <div role="tablist" className="mb-5 flex flex-wrap gap-2">
        {([["programs", "Program"], ["records", "Catatan & verifikasi"], ["hours", "Rekap jam"]] as const).map(([key, text]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
            className={`min-h-11 rounded-xl px-4 text-sm font-bold ${tab === key ? "bg-brand-primary text-brand-foreground" : "border border-border text-brand-heading"}`}>
            {text}
          </button>
        ))}
      </div>
      {tab === "programs" ? <ProgramsTab canManage={canManage} /> : null}
      {tab === "records" ? <RecordsTab canManage={canManage} /> : null}
      {tab === "hours" ? <HoursTab /> : null}
    </AdminShell>
  );
}

// ---------------------------------------------------------------- programs

const emptyProgram = () => ({ title: "", category: "PEDAGOGY" as TrainingCategory, organizer: "", capacity: "", minAttendancePercent: "80", description: "" });

function ProgramsTab({ canManage }: { canManage: boolean }) {
  const action = useAction();
  const [items, setItems] = useState<ProgramSummary[]>([]);
  const [paging, setPaging] = useState<Pagination | null>(null);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<ProgramStatus | "">("ACTIVE");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  // The open program lives in the URL: `?program=<id>`, or `?program=baru` for the create form.
  const [programId, openProgram, closeProgram] = useDialogParam("program");
  const creating = programId === "baru";
  const [selected, setSelected] = useState<ProgramDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [form, setForm] = useState(emptyProgram);

  const load = async () => {
    setLoading(true);
    try {
      const result = await getPrograms({ page, status, q: q.trim() || undefined });
      setItems(result.items);
      setPaging(result.pagination);
    } catch (cause) {
      if (cause instanceof TrainingApiError && cause.status === 403) setForbidden(true);
      action.setError(cause instanceof Error ? cause.message : "Program tidak dapat dimuat.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), q ? 250 : 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, status, q]);

  const open = async (id: string) => {
    try {
      setSelected(await getProgram(id));
      setDetailError(null);
    } catch (cause) {
      setDetailError(cause instanceof Error ? cause.message : "Program tidak dapat dibuka.");
    }
  };

  useEffect(() => {
    setSelected(null);
    setDetailError(null);
    if (!programId || programId === "baru") return;
    let active = true;
    void getProgram(programId)
      .then((program) => { if (active) setSelected(program); })
      .catch((cause) => { if (active) setDetailError(cause instanceof Error ? cause.message : "Program tidak dapat dibuka."); });
    return () => { active = false; };
  }, [programId]);

  const create = (event: React.FormEvent) => {
    event.preventDefault();
    void action.run(async () => {
      const created = await createProgram({
        title: form.title.trim(), category: form.category, organizer: form.organizer.trim() || null,
        description: form.description.trim() || null, capacity: form.capacity ? Number(form.capacity) : null,
        minAttendancePercent: Number(form.minAttendancePercent),
      });
      setForm(emptyProgram());
      await load();
      replaceDialogParam("program", created.id);
      return "Program dibuat. Tambahkan sesi dan peserta.";
    }, "Program tidak dapat dibuat.");
  };

  if (forbidden) return <Feedback action={action} />;

  return (
    <>
      <Feedback action={action} />
      <section className={`${card} overflow-hidden`}>
        <div className="grid gap-3 p-5 sm:grid-cols-2">
          <label className={label}>
            Status
            <select className={input} value={status} onChange={(event) => { setPage(1); setStatus(event.target.value as ProgramStatus | ""); }}>
              <option value="">Semua</option>
              {Object.entries(PROGRAM_STATUS_LABELS).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select>
          </label>
          <label className={label}>
            Cari judul
            <input className={input} value={q} maxLength={100} onChange={(event) => { setPage(1); setQ(event.target.value); }} />
          </label>
        </div>
        {canManage ? (
          <div className="px-5 pb-3">
            <button type="button" className={secondary} onClick={() => openProgram("baru")}>Program baru</button>
          </div>
        ) : null}
        {loading ? (
          <div className="flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat...</div>
        ) : items.length === 0 ? (
          <p className="px-5 py-8 text-sm text-muted-foreground">Belum ada program pada filter ini.</p>
        ) : (
          <ul className="divide-y divide-border/70 border-t border-border/70">
            {items.map((program) => (
              <li key={program.id}>
                <button type="button" onClick={() => openProgram(program.id)}
                  className={`w-full px-5 py-3 text-left hover:bg-muted/50 ${programId === program.id ? "bg-muted/60" : ""}`}>
                  <span className="block font-semibold text-brand-heading">{program.title}</span>
                  <span className="block text-xs text-muted-foreground">
                    {CATEGORY_LABELS[program.category]} · {program.sessionCount} sesi · {program.participantCount} peserta
                    {program.firstSessionAt ? ` · mulai ${formatInstant(program.firstSessionAt)}` : ""}
                  </span>
                  <span className="mt-1 block text-[11px] font-semibold text-muted-foreground">{PROGRAM_STATUS_LABELS[program.status]}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {paging && paging.total > 0 ? <PaginationBar page={paging.page} pageSize={paging.pageSize} total={paging.total} onPageChange={setPage} /> : null}
      </section>

      {creating && canManage ? (
        <DetailDialog title="Program baru" description="Setelah disimpan, tambahkan sesi dan peserta." onClose={closeProgram}>
          <Feedback action={action} />
          <form onSubmit={create} className="grid gap-3 sm:grid-cols-2">
            <label className={`${label} sm:col-span-2`}>
              Judul
              <input required minLength={3} maxLength={200} className={input} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
            </label>
            <label className={label}>
              Kategori
              <select className={input} value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value as TrainingCategory })}>
                {Object.entries(CATEGORY_LABELS).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
              </select>
            </label>
            <label className={label}>
              Penyelenggara (kosong = yayasan)
              <input maxLength={200} className={input} value={form.organizer} onChange={(event) => setForm({ ...form, organizer: event.target.value })} />
            </label>
            <label className={label}>
              Kuota peserta (opsional)
              <input type="number" min={1} max={500} className={input} value={form.capacity} onChange={(event) => setForm({ ...form, capacity: event.target.value })} />
            </label>
            <label className={label}>
              Kehadiran minimal (%)
              <input type="number" min={50} max={100} required className={input} value={form.minAttendancePercent}
                onChange={(event) => setForm({ ...form, minAttendancePercent: event.target.value })} />
            </label>
            <label className={`${label} sm:col-span-2`}>
              Deskripsi (opsional)
              <textarea maxLength={2000} rows={2} className="mt-1 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-brand-heading"
                value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
            </label>
            <div className="sm:col-span-2">
              <button type="submit" className={primary} disabled={action.busy || form.title.trim().length < 3}>Simpan program</button>
            </div>
          </form>
        </DetailDialog>
      ) : null}
      {programId && !creating ? (
        <DetailDialog
          title={selected?.title ?? "Program"}
          description={selected ? (
            <>
              {CATEGORY_LABELS[selected.category]} · {selected.organizer} · {PROGRAM_STATUS_LABELS[selected.status]}
              {selected.capacity ? ` · kuota ${selected.capacity}` : ""} · kehadiran minimal {selected.minAttendancePercent}%
            </>
          ) : undefined}
          onClose={closeProgram}
        >
          {selected ? (
            <>
              <Feedback action={action} />
              <ProgramPanel key={selected.id} program={selected} canManage={canManage} action={action}
                reload={async () => { await Promise.all([load(), open(selected.id)]); }} />
            </>
          ) : detailError ? (
            <p className="text-sm text-muted-foreground">{detailError}</p>
          ) : <DialogLoading />}
        </DetailDialog>
      ) : null}
    </>
  );
}

const emptySession = () => ({ title: "", day: todayInJakarta(), from: "08:00", to: "10:00", location: "", speakerName: "" });

function ProgramPanel({ program, canManage, action, reload }: {
  program: ProgramDetail;
  canManage: boolean;
  action: ReturnType<typeof useAction>;
  reload: () => Promise<void>;
}) {
  const active = program.status === "ACTIVE";
  const editable = canManage && active;
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [paging, setPaging] = useState<Pagination | null>(null);
  const [page, setPage] = useState(1);
  const [picked, setPicked] = useState<PickedEmployee[]>([]);
  const [sessionForm, setSessionForm] = useState(emptySession);
  const [speaker, setSpeaker] = useState<PickedEmployee | null>(null);
  const [sheet, setSheet] = useState<TrainingSession | null>(null);

  const loadParticipants = async () => {
    const result = await getParticipants(program.id, page);
    setParticipants(result.items);
    setPaging(result.pagination);
  };
  useEffect(() => {
    void loadParticipants().catch((cause) => action.setError(cause instanceof Error ? cause.message : "Peserta tidak dapat dimuat."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [program.id, page]);

  const refresh = async () => { await Promise.all([reload(), loadParticipants()]); };

  const addSession = (event: React.FormEvent) => {
    event.preventDefault();
    void action.run(async () => {
      const result = await createSession(program.id, {
        title: sessionForm.title.trim(), startAt: wibInstant(sessionForm.day, sessionForm.from), endAt: wibInstant(sessionForm.day, sessionForm.to),
        location: sessionForm.location.trim() || null, speakerEmployeeId: speaker?.id ?? null,
        speakerName: speaker ? null : sessionForm.speakerName.trim() || null,
      });
      action.setConflicts({ blocks: [], warnings: result.warnings });
      setSessionForm(emptySession());
      setSpeaker(null);
      await reload();
      return "Sesi dijadwalkan.";
    }, "Sesi tidak dapat dijadwalkan.");
  };

  const enroll = () => void action.run(async () => {
    const result = await enrollParticipants(program.id, picked.map((person) => person.id));
    action.setConflicts({ blocks: [], warnings: result.warnings });
    setPicked([]);
    await refresh();
    return `${result.enrolled.length} peserta ditambahkan${result.alreadyEnrolled.length ? `, ${result.alreadyEnrolled.length} sudah terdaftar` : ""}.`;
  }, "Peserta tidak dapat ditambahkan.");

  const withdraw = (person: Participant) => {
    const reason = window.prompt(`Alasan mengeluarkan ${person.fullName} (minimal 5 karakter)`);
    if (!reason || reason.trim().length < 5) return;
    void action.run(async () => { await withdrawParticipant(program.id, person.employeeId, reason.trim()); await refresh(); return "Peserta dikeluarkan."; },
      "Peserta tidak dapat dikeluarkan.");
  };

  const dropSession = (item: TrainingSession) => {
    const reason = window.prompt(`Alasan membatalkan sesi "${item.title}" (minimal 5 karakter)`);
    if (!reason || reason.trim().length < 5) return;
    void action.run(async () => { await cancelSession(item.id, reason.trim()); await reload(); return "Sesi dibatalkan."; }, "Sesi tidak dapat dibatalkan.");
  };

  const close = () => {
    if (!window.confirm("Tutup program? Catatan pelatihan dibuat dan program tidak dapat diubah lagi.")) return;
    void action.run(async () => {
      const result = await completeProgram(program.id);
      await refresh();
      return `Program ditutup: ${result.records} catatan pelatihan dibuat (${formatHours(result.totalHours)} per peserta penuh).`;
    }, "Program tidak dapat ditutup.");
  };

  const cancel = () => {
    const reason = window.prompt("Alasan membatalkan program (minimal 10 karakter). Semua sesi ikut dibatalkan.");
    if (!reason || reason.trim().length < 10) return;
    void action.run(async () => { await cancelProgram(program.id, reason.trim()); await refresh(); return "Program dibatalkan."; },
      "Program tidak dapat dibatalkan.");
  };

  return (
    <div>
      {program.cancelReason ? <p className="text-xs text-danger-ink">Dibatalkan: {program.cancelReason}</p> : null}
      {editable ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={primary} disabled={action.busy} onClick={close}>Tutup program</button>
          <button type="button" className={danger} disabled={action.busy} onClick={cancel}>Batalkan program</button>
        </div>
      ) : null}

      <h3 className="mt-5 text-sm font-bold text-brand-heading">Sesi ({program.sessions.length})</h3>
      {program.sessions.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">Belum ada sesi.</p> : (
        <ol className="mt-2 space-y-2">
          {program.sessions.map((item) => (
            <li key={item.id} className="rounded-2xl border border-border/70 p-3 text-sm">
              <p className={`font-semibold ${item.status === "CANCELLED" ? "text-muted-foreground line-through" : "text-brand-heading"}`}>{item.title}</p>
              <p className="text-xs text-muted-foreground">
                {formatSessionTime(item.startAt, item.endAt)}{item.location ? ` · ${item.location}` : ""}{item.speakerName ? ` · ${item.speakerName}` : ""}
              </p>
              {item.status === "SCHEDULED" ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-semibold text-muted-foreground">Hadir {item.presentCount ?? 0} · tercatat {item.recordedCount ?? 0}</span>
                  <button type="button" className={secondary} onClick={() => setSheet(item)}>Daftar hadir</button>
                  {editable ? <button type="button" className={danger} disabled={action.busy} onClick={() => dropSession(item)}>Batalkan sesi</button> : null}
                </div>
              ) : <p className="mt-1 text-[11px] text-muted-foreground">Dibatalkan: {item.cancelReason}</p>}
            </li>
          ))}
        </ol>
      )}
      {sheet ? <AttendanceSheet key={sheet.id} session={sheet} editable={editable} action={action} onClose={() => setSheet(null)} onSaved={refresh} /> : null}

      {editable ? (
        <form onSubmit={addSession} className="mt-3 grid gap-3 rounded-2xl border border-border/70 p-3 sm:grid-cols-3">
          <label className={`${label} sm:col-span-3`}>
            Judul sesi
            <input required minLength={3} maxLength={200} className={input} value={sessionForm.title} onChange={(event) => setSessionForm({ ...sessionForm, title: event.target.value })} />
          </label>
          <label className={label}>
            Tanggal
            <input type="date" required className={input} value={sessionForm.day} onChange={(event) => setSessionForm({ ...sessionForm, day: event.target.value })} />
          </label>
          <label className={label}>
            Mulai (WIB)
            <input type="time" required className={input} value={sessionForm.from} onChange={(event) => setSessionForm({ ...sessionForm, from: event.target.value })} />
          </label>
          <label className={label}>
            Selesai (WIB)
            <input type="time" required className={input} value={sessionForm.to} onChange={(event) => setSessionForm({ ...sessionForm, to: event.target.value })} />
          </label>
          <label className={label}>
            Tempat
            <input maxLength={200} className={input} value={sessionForm.location} onChange={(event) => setSessionForm({ ...sessionForm, location: event.target.value })} />
          </label>
          <div className="sm:col-span-2">
            <EmployeeSearchField label="Narasumber pegawai (opsional)" value={speaker} onChange={setSpeaker} search={searchTrainingEmployees} />
          </div>
          {speaker ? null : (
            <label className={`${label} sm:col-span-3`}>
              Atau narasumber dari luar
              <input maxLength={150} className={input} value={sessionForm.speakerName} onChange={(event) => setSessionForm({ ...sessionForm, speakerName: event.target.value })} />
            </label>
          )}
          <div className="sm:col-span-3">
            <button type="submit" className={primary} disabled={action.busy || sessionForm.title.trim().length < 3}>Jadwalkan sesi</button>
          </div>
        </form>
      ) : null}

      <h3 className="mt-5 text-sm font-bold text-brand-heading">Peserta</h3>
      {editable ? (
        <div className="mt-2 rounded-2xl border border-border/70 p-3">
          <EmployeeSearchField label="Tambah peserta" value={null} search={searchTrainingEmployees}
            onChange={(person) => { if (person && !picked.some((item) => item.id === person.id)) setPicked([...picked, person]); }} />
          {picked.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {picked.map((person) => (
                <span key={person.id} className="inline-flex items-center gap-1 rounded-full bg-muted px-3 py-1 text-xs font-semibold text-brand-heading">
                  {person.fullName}
                  <button type="button" aria-label={`Hapus ${person.fullName}`} onClick={() => setPicked(picked.filter((item) => item.id !== person.id))}>
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <button type="button" className={primary} disabled={action.busy} onClick={enroll}>Daftarkan {picked.length} pegawai</button>
            </div>
          ) : null}
        </div>
      ) : null}
      {participants.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">Belum ada peserta.</p> : (
        <ul className="mt-2 divide-y divide-border/70">
          {participants.map((person) => (
            <li key={person.employeeId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span>
                <span className="block font-semibold text-brand-heading">{person.fullName}</span>
                <span className="block text-xs text-muted-foreground">
                  {person.employeeNumber}{person.unitName ? ` · ${person.unitName}` : ""} · {PARTICIPANT_STATUS_LABELS[person.status]}
                  · hadir {person.presentSessions} sesi{person.attendedHours != null ? ` · ${formatHours(person.attendedHours)}` : ""}
                </span>
              </span>
              {editable && person.status === "ENROLLED" ? (
                <button type="button" className={danger} disabled={action.busy} onClick={() => withdraw(person)}>Keluarkan</button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {paging && paging.total > paging.pageSize ? <PaginationBar page={paging.page} pageSize={paging.pageSize} total={paging.total} onPageChange={setPage} /> : null}
    </div>
  );
}

function AttendanceSheet({ session, editable, action, onClose, onSaved }: {
  session: TrainingSession;
  editable: boolean;
  action: ReturnType<typeof useAction>;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [rows, setRows] = useState<AttendanceRow[]>([]);
  const [paging, setPaging] = useState<Pagination | null>(null);
  const [page, setPage] = useState(1);
  const [marks, setMarks] = useState<Record<string, AttendanceStatus>>({});
  const started = Date.parse(session.startAt) <= Date.now();

  useEffect(() => {
    void getAttendance(session.id, page).then((result) => {
      setRows(result.items);
      setPaging(result.pagination);
      setMarks(Object.fromEntries(result.items.filter((row) => row.status).map((row) => [row.employeeId, row.status!])));
    }).catch((cause) => action.setError(cause instanceof Error ? cause.message : "Daftar hadir tidak dapat dimuat."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, page]);

  const save = () => void action.run(async () => {
    const entries = rows.filter((row) => row.participantStatus === "ENROLLED" && marks[row.employeeId])
      .map((row) => ({ employeeId: row.employeeId, status: marks[row.employeeId]! }));
    const result = await saveAttendance(session.id, entries);
    await onSaved();
    return `${result.recorded} kehadiran disimpan.`;
  }, "Kehadiran tidak dapat disimpan.");

  return (
    <div className="mt-3 rounded-2xl border border-brand-primary/40 p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-bold text-brand-heading">Daftar hadir · {session.title}</p>
        <button type="button" aria-label="Tutup daftar hadir" onClick={onClose} className="rounded-lg p-1 hover:bg-muted"><X className="h-4 w-4" /></button>
      </div>
      {!started ? <p className="mt-1 text-xs text-muted-foreground">Kehadiran dapat dicatat setelah sesi dimulai.</p> : null}
      {rows.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">Belum ada peserta.</p> : (
        <ul className="mt-2 divide-y divide-border/70">
          {rows.map((row) => (
            <li key={row.employeeId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span className="font-semibold text-brand-heading">{row.fullName}</span>
              {editable && started && row.participantStatus === "ENROLLED" ? (
                <span className="flex flex-wrap gap-1" role="radiogroup" aria-label={`Kehadiran ${row.fullName}`}>
                  {(Object.keys(ATTENDANCE_LABELS) as AttendanceStatus[]).map((status) => (
                    <button key={status} type="button" role="radio" aria-checked={marks[row.employeeId] === status}
                      onClick={() => setMarks({ ...marks, [row.employeeId]: status })}
                      className={`min-h-11 rounded-xl px-3 text-xs font-bold ${marks[row.employeeId] === status ? "bg-brand-primary text-brand-foreground" : "border border-border text-brand-heading"}`}>
                      {ATTENDANCE_LABELS[status]}
                    </button>
                  ))}
                </span>
              ) : <span className="text-xs text-muted-foreground">{row.status ? ATTENDANCE_LABELS[row.status] : "Belum dicatat"}</span>}
            </li>
          ))}
        </ul>
      )}
      {paging && paging.total > paging.pageSize ? <PaginationBar page={paging.page} pageSize={paging.pageSize} total={paging.total} onPageChange={setPage} /> : null}
      {editable && started && rows.length > 0 ? (
        <button type="button" className={`${primary} mt-3`} disabled={action.busy || Object.keys(marks).length === 0} onClick={save}>Simpan kehadiran</button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- records

function RecordsTab({ canManage }: { canManage: boolean }) {
  const action = useAction();
  const [items, setItems] = useState<TrainingRecord[]>([]);
  const [paging, setPaging] = useState<Pagination | null>(null);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<RecordStatus | "">("SUBMITTED");
  const [source, setSource] = useState<"INTERNAL" | "EXTERNAL" | "">("");
  const [loading, setLoading] = useState(true);
  // The open record lives in the URL (`?catatan=<id>`).
  const [recordId, openRecord, closeRecord] = useDialogParam("catatan");
  const [selected, setSelected] = useState<RecordDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const result = await getRecords({ page, status, source });
      setItems(result.items);
      setPaging(result.pagination);
    } catch (cause) {
      action.setError(cause instanceof Error ? cause.message : "Catatan tidak dapat dimuat.");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, status, source]);

  const open = async (id: string) => {
    try { setSelected(await getRecord(id)); setDetailError(null); } catch (cause) { setDetailError(cause instanceof Error ? cause.message : "Catatan tidak dapat dibuka."); }
  };

  useEffect(() => {
    setSelected(null);
    setDetailError(null);
    if (!recordId) return;
    let active = true;
    void getRecord(recordId)
      .then((record) => { if (active) setSelected(record); })
      .catch((cause) => { if (active) setDetailError(cause instanceof Error ? cause.message : "Catatan tidak dapat dibuka."); });
    return () => { active = false; };
  }, [recordId]);

  const verify = (record: RecordDetail) => void action.run(async () => {
    await verifyRecord(record.id); await Promise.all([load(), open(record.id)]); return "Catatan diverifikasi.";
  }, "Catatan tidak dapat diverifikasi.");

  const reject = (record: RecordDetail) => {
    const reason = window.prompt("Alasan penolakan (minimal 5 karakter)");
    if (!reason || reason.trim().length < 5) return;
    void action.run(async () => { await rejectRecord(record.id, reason.trim()); await Promise.all([load(), open(record.id)]); return "Catatan ditolak."; },
      "Catatan tidak dapat ditolak.");
  };

  const attach = (record: RecordDetail, file: File | undefined) => {
    if (!file) return;
    void action.run(async () => { await uploadCertificate(record.id, await readCertificate(file)); await open(record.id); return "Sertifikat diunggah."; },
      "Sertifikat tidak dapat diunggah.");
  };

  return (
    <>
      <Feedback action={action} />
      <section className={`${card} overflow-hidden`}>
        <div className="grid gap-3 p-5 sm:grid-cols-2">
          <label className={label}>
            Status
            <select className={input} value={status} onChange={(event) => { setPage(1); setStatus(event.target.value as RecordStatus | ""); }}>
              <option value="">Semua</option>
              {Object.entries(RECORD_STATUS_LABELS).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select>
          </label>
          <label className={label}>
            Sumber
            <select className={input} value={source} onChange={(event) => { setPage(1); setSource(event.target.value as "INTERNAL" | "EXTERNAL" | ""); }}>
              <option value="">Semua</option>
              <option value="INTERNAL">Program internal</option>
              <option value="EXTERNAL">Pihak luar</option>
            </select>
          </label>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat...</div>
        ) : items.length === 0 ? (
          <p className="px-5 py-8 text-sm text-muted-foreground">Tidak ada catatan pada filter ini.</p>
        ) : (
          <ul className="divide-y divide-border/70 border-t border-border/70">
            {items.map((record) => (
              <li key={record.id}>
                <button type="button" onClick={() => openRecord(record.id)}
                  className={`w-full px-5 py-3 text-left hover:bg-muted/50 ${recordId === record.id ? "bg-muted/60" : ""}`}>
                  <span className="block font-semibold text-brand-heading">{record.employeeName} · {record.title}</span>
                  <span className="block text-xs text-muted-foreground">
                    {formatDateRange(record.startOn, record.endOn)} · {formatHours(record.hours)} · {RECORD_STATUS_LABELS[record.status]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {paging && paging.total > 0 ? <PaginationBar page={paging.page} pageSize={paging.pageSize} total={paging.total} onPageChange={setPage} /> : null}
      </section>

      {recordId ? (
        <DetailDialog
          title={selected?.title ?? "Catatan pelatihan"}
          description={selected ? <>{selected.employeeName} · {selected.employeeNumber}{selected.unitName ? ` · ${selected.unitName}` : ""}</> : undefined}
          onClose={closeRecord}
        >
          {selected ? (
            <div className="text-sm">
              <Feedback action={action} />
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Penyelenggara</dt><dd>{selected.organizer}</dd>
                <dt className="text-muted-foreground">Kategori</dt><dd>{CATEGORY_LABELS[selected.category]}</dd>
                <dt className="text-muted-foreground">Tanggal</dt><dd>{formatDateRange(selected.startOn, selected.endOn)}</dd>
                <dt className="text-muted-foreground">Jam</dt><dd>{formatHours(selected.hours)}{selected.role === "SPEAKER" ? " (narasumber)" : ""}</dd>
                <dt className="text-muted-foreground">Status</dt><dd>{RECORD_STATUS_LABELS[selected.status]}{selected.completed === false ? " · belum memenuhi kehadiran" : ""}</dd>
                {selected.rejectReason ? <><dt className="text-muted-foreground">Alasan</dt><dd>{selected.rejectReason}</dd></> : null}
              </dl>
              {selected.description ? <p className="mt-3 text-muted-foreground">{selected.description}</p> : null}
              <div className="mt-3 flex flex-wrap gap-2">
                {selected.certificateId ? <a className={secondary + " py-2.5"} href={adminCertificateUrl(selected.id)}>Unduh sertifikat</a> : <span className="text-xs text-muted-foreground">Tanpa sertifikat.</span>}
                {canManage && selected.status === "SUBMITTED" ? (
                  <>
                    <button type="button" className={primary} disabled={action.busy} onClick={() => verify(selected)}>Verifikasi</button>
                    <button type="button" className={danger} disabled={action.busy} onClick={() => reject(selected)}>Tolak</button>
                  </>
                ) : null}
                {canManage && selected.source === "INTERNAL" ? (
                  <label className={secondary + " inline-flex cursor-pointer items-center"}>
                    Unggah sertifikat
                    <input type="file" accept="application/pdf,image/jpeg,image/png" className="sr-only" onChange={(event) => attach(selected, event.target.files?.[0])} />
                  </label>
                ) : null}
              </div>
              <h3 className="mt-4 text-xs font-bold text-brand-heading">Riwayat</h3>
              <ol className="mt-1 space-y-1 text-xs text-muted-foreground">
                {selected.events.map((event) => (
                  <li key={event.id}>{formatInstant(event.occurredAt)} · {eventLabel(event.eventType)}{event.actorName ? ` · ${event.actorName}` : ""}{event.note ? ` · ${event.note}` : ""}</li>
                ))}
              </ol>
            </div>
          ) : detailError ? (
            <p className="text-sm text-muted-foreground">{detailError}</p>
          ) : <DialogLoading />}
        </DetailDialog>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- hours

function HoursTab() {
  const action = useAction();
  const thisYear = Number(todayInJakarta().slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<HoursRow[]>([]);
  const [paging, setPaging] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setLoading(true);
      void getHours({ page, year, q: q.trim() || undefined })
        .then((result) => { setItems(result.items); setPaging(result.pagination); })
        .catch((cause) => action.setError(cause instanceof Error ? cause.message : "Rekap jam tidak dapat dimuat."))
        .finally(() => setLoading(false));
    }, q ? 250 : 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, year, q]);

  return (
    <>
      <Feedback action={action} />
      <section className={`${card} overflow-hidden`}>
        <div className="grid gap-3 p-5 sm:grid-cols-3">
          <label className={label}>
            Tahun
            <select className={input} value={year} onChange={(event) => { setPage(1); setYear(Number(event.target.value)); }}>
              {[thisYear, thisYear - 1, thisYear - 2].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className={`${label} sm:col-span-2`}>
            Cari nama atau NIP
            <input className={input} value={q} maxLength={100} onChange={(event) => { setPage(1); setQ(event.target.value); }} />
          </label>
        </div>
        <p className="px-5 pb-3 text-xs text-muted-foreground">Hanya catatan terverifikasi. Jam narasumber dihitung terpisah. Tidak ada target jam yang ditetapkan.</p>
        {loading ? (
          <div className="flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat...</div>
        ) : items.length === 0 ? (
          <p className="px-5 py-8 text-sm text-muted-foreground">Tidak ada pegawai aktif yang cocok.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-y border-border/70 text-xs text-muted-foreground">
                <tr><th className="px-5 py-2">Pegawai</th><th className="px-3 py-2">Total</th><th className="px-3 py-2">Internal</th><th className="px-3 py-2">Eksternal</th><th className="px-3 py-2">Narasumber</th><th className="px-3 py-2">Catatan</th></tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {items.map((row) => (
                  <tr key={row.employeeId}>
                    <td className="px-5 py-2"><span className="block font-semibold text-brand-heading">{row.fullName}</span><span className="text-xs text-muted-foreground">{row.employeeNumber}{row.unitName ? ` · ${row.unitName}` : ""}</span></td>
                    <td className="px-3 py-2 font-semibold">{formatHours(row.totalHours)}</td>
                    <td className="px-3 py-2">{formatHours(row.internalHours)}</td>
                    <td className="px-3 py-2">{formatHours(row.externalHours)}</td>
                    <td className="px-3 py-2">{formatHours(row.speakerHours)}</td>
                    <td className="px-3 py-2">{row.recordCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {paging && paging.total > 0 ? <PaginationBar page={paging.page} pageSize={paging.pageSize} total={paging.total} onPageChange={setPage} /> : null}
      </section>
    </>
  );
}
