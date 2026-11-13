// TRAIN-001 employee surface: hours this year, programs I take part in with their schedule and
// my attendance, my training history, and an external training with its certificate.
// Spec: docs/domain/training.md.

import { GraduationCap, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { DetailDialog, useDialogParam } from "@/components/DetailDialog";
import { DialogLoading, DialogMessages } from "@/components/DetailDialogParts";
import { PaginationBar } from "@/components/PaginationBar";
import { AppShell } from "@/layouts/AppShell";
import { employeeShellUser } from "@/lib/employeeIdentity";
import { getEmployeeLeaveSummary, type EmployeeLeaveSummary } from "@/lib/employeeLeave";
import {
  ATTENDANCE_LABELS,
  CATEGORY_LABELS,
  formatDateRange,
  formatHours,
  formatInstant,
  formatSessionTime,
  getMyProgram,
  getMyPrograms,
  getMyTrainingRecords,
  getMyTrainingSummary,
  myCertificateUrl,
  PARTICIPANT_STATUS_LABELS,
  PROGRAM_STATUS_LABELS,
  readCertificate,
  RECORD_STATUS_LABELS,
  submitExternalTraining,
  todayInJakarta,
  withdrawMyRecord,
  type HoursSummary,
  type Pagination,
  type ProgramDetail,
  type ProgramSummary,
  type TrainingCategory,
  type TrainingRecord,
} from "@/lib/training";

const emptyForm = () => ({
  title: "", category: "OTHER" as TrainingCategory, organizer: "", description: "",
  startOn: todayInJakarta(), endOn: todayInJakarta(), hours: "",
});

export function EmployeeTrainingPage() {
  const [employee, setEmployee] = useState<EmployeeLeaveSummary["employee"] | null>(null);
  const [summary, setSummary] = useState<HoursSummary | null>(null);
  const [programs, setPrograms] = useState<ProgramSummary[]>([]);
  const [programPaging, setProgramPaging] = useState<Pagination | null>(null);
  const [records, setRecords] = useState<TrainingRecord[]>([]);
  const [recordPaging, setRecordPaging] = useState<Pagination | null>(null);
  const [selected, setSelected] = useState<ProgramDetail | null>(null);
  // The open program lives in ?program=<id> (notification links use it too) and shows as a pop-up.
  const [programId, showProgram, closeProgram] = useDialogParam("program");
  const [form, setForm] = useState(emptyForm);
  const [file, setFile] = useState<File | null>(null);
  // One key per filled-in form: a retry after a lost response replays the same record.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const user = useMemo(() => employeeShellUser(employee), [employee]);

  const loadPrograms = async (page = 1) => {
    const result = await getMyPrograms(page);
    setPrograms(result.items);
    setProgramPaging(result.pagination);
  };
  const loadRecords = async (page = 1) => {
    const result = await getMyTrainingRecords(page);
    setRecords(result.items);
    setRecordPaging(result.pagination);
  };
  const loadAll = () => Promise.all([getMyTrainingSummary().then(setSummary), loadPrograms(), loadRecords()]);

  const open = async (id: string) => {
    setError(null);
    try {
      setSelected(await getMyProgram(id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Program tidak dapat dibuka.");
    }
  };

  useEffect(() => {
    void getEmployeeLeaveSummary().then((value) => setEmployee(value.employee)).catch(() => undefined);
    void loadAll()
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Data pelatihan tidak dapat dimuat."))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (programId) void open(programId);
    else setSelected(null);
  }, [programId]);

  const run = async (action: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallback);
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await submitExternalTraining({
        title: form.title.trim(), category: form.category, organizer: form.organizer.trim(),
        description: form.description.trim() || null, startOn: form.startOn, endOn: form.endOn,
        hours: Number(form.hours), certificate: file ? await readCertificate(file) : null, idempotencyKey,
      });
      setForm(emptyForm());
      setFile(null);
      setIdempotencyKey(crypto.randomUUID());
      setNotice("Pelatihan eksternal dikirim dan menunggu verifikasi Human Capital.");
      await loadRecords();
    }, "Pelatihan eksternal tidak dapat dikirim.");
  };

  const withdraw = (record: TrainingRecord) => {
    if (!window.confirm(`Tarik pengajuan "${record.title}"?`)) return;
    void run(async () => {
      await withdrawMyRecord(record.id);
      setNotice("Pengajuan ditarik.");
      await loadRecords(recordPaging?.page ?? 1);
    }, "Pengajuan tidak dapat ditarik.");
  };

  const input = "mt-1.5 min-h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm font-normal text-brand-heading";
  const card = "rounded-3xl border border-border/75 bg-surface-raised shadow-[var(--shadow-soft)]";

  return (
    <AppShell user={user} activeItem="Pelatihan">
      <section className="mx-auto max-w-5xl">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand-primary-deep">Kinerja &amp; Pengembangan</p>
        <h1 className="mt-1 text-2xl font-bold text-brand-heading sm:text-3xl">Pelatihan</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Jadwal pelatihan yang Anda ikuti, riwayat pelatihan, dan jam pelatihan Anda. Pelatihan dari pihak luar dapat
          Anda catat sendiri lalu diverifikasi Human Capital.
        </p>

        {error && !programId ? <div className="mt-5 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div> : null}
        {notice && !programId ? <div className="mt-5 rounded-2xl border border-border bg-surface p-4 text-sm text-brand-heading">{notice}</div> : null}

        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          {[
            ["Jam pelatihan " + (summary?.year ?? ""), summary ? formatHours(summary.totalHours) : "-"],
            ["Internal / eksternal", summary ? `${formatHours(summary.internalHours)} / ${formatHours(summary.externalHours)}` : "-"],
            ["Sebagai narasumber", summary ? formatHours(summary.speakerHours) : "-"],
          ].map(([label, value]) => (
            <div key={label} className={`${card} p-4`}>
              <p className="text-xs font-semibold text-muted-foreground">{label}</p>
              <p className="mt-1 text-lg font-bold text-brand-heading">{value}</p>
            </div>
          ))}
        </div>

        <div className="mt-6">
          <section className={`${card} overflow-hidden`}>
            <h2 className="px-5 pt-5 text-sm font-bold text-brand-heading">Program yang saya ikuti</h2>
            {loading ? (
              <div className="flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat...</div>
            ) : programs.length === 0 ? (
              <p className="px-5 py-8 text-sm text-muted-foreground">Belum ada program pelatihan untuk Anda.</p>
            ) : (
              <ul className="mt-3 divide-y divide-border/70">
                {programs.map((program) => (
                  <li key={program.id}>
                    <button type="button" onClick={() => showProgram(program.id)}
                      className={`flex w-full items-start gap-3 px-5 py-3 text-left hover:bg-muted/50 ${programId === program.id ? "bg-muted/60" : ""}`}>
                      <GraduationCap className="mt-0.5 h-4 w-4 shrink-0 text-brand-primary-deep" aria-hidden="true" />
                      <span className="min-w-0">
                        <span className="block truncate font-semibold text-brand-heading">{program.title}</span>
                        <span className="block text-xs text-muted-foreground">
                          {program.nextSessionAt ? `Sesi berikutnya ${formatInstant(program.nextSessionAt)} WIB` : PROGRAM_STATUS_LABELS[program.status]}
                        </span>
                        <span className="mt-1 block text-[11px] font-semibold text-muted-foreground">
                          {program.participantStatus ? PARTICIPANT_STATUS_LABELS[program.participantStatus] : ""}
                          {program.attendedHours != null ? ` · ${formatHours(program.attendedHours)}` : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {programPaging && programPaging.total > 0 ? (
              <PaginationBar page={programPaging.page} pageSize={programPaging.pageSize} total={programPaging.total}
                onPageChange={(page) => void loadPrograms(page)} />
            ) : null}
          </section>

          {programId ? (
            <DetailDialog
              title={selected?.id === programId ? selected.title : "Program pelatihan"}
              description={selected?.id === programId ? `${CATEGORY_LABELS[selected.category]} · ${selected.organizer}` : undefined}
              onClose={closeProgram}
            >
              <DialogMessages error={error} />
              {selected?.id === programId ? (
                <>
                  {selected.description ? <p className="text-sm text-muted-foreground">{selected.description}</p> : null}
                  <ol className={`${selected.description ? "mt-4 " : ""}space-y-2`}>
                    {selected.sessions.map((session) => (
                      <li key={session.id} className="rounded-2xl border border-border/70 p-3 text-sm">
                        <p className={`font-semibold ${session.status === "CANCELLED" ? "text-muted-foreground line-through" : "text-brand-heading"}`}>{session.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatSessionTime(session.startAt, session.endAt)}
                          {session.location ? ` · ${session.location}` : ""}
                          {session.speakerName ? ` · ${session.speakerName}` : ""}
                        </p>
                        <p className="mt-1 text-[11px] font-semibold text-muted-foreground">
                          {session.status === "CANCELLED" ? "Dibatalkan" : session.myAttendance ? ATTENDANCE_LABELS[session.myAttendance] : "Kehadiran belum dicatat"}
                        </p>
                      </li>
                    ))}
                  </ol>
                </>
              ) : error ? null : <DialogLoading />}
            </DetailDialog>
          ) : null}
        </div>

        <section className={`${card} mt-6 overflow-hidden`}>
          <h2 className="px-5 pt-5 text-sm font-bold text-brand-heading">Riwayat pelatihan</h2>
          {records.length === 0 && !loading ? (
            <p className="px-5 py-8 text-sm text-muted-foreground">Belum ada catatan pelatihan.</p>
          ) : (
            <ul className="mt-3 divide-y divide-border/70">
              {records.map((record) => (
                <li key={record.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3 text-sm">
                  <span className="min-w-0">
                    <span className="block font-semibold text-brand-heading">{record.title}</span>
                    <span className="block text-xs text-muted-foreground">
                      {formatDateRange(record.startOn, record.endOn)} · {record.organizer} · {formatHours(record.hours)}
                      {record.role === "SPEAKER" ? " · narasumber" : ""}
                    </span>
                    <span className="mt-1 block text-[11px] font-semibold text-muted-foreground">
                      {RECORD_STATUS_LABELS[record.status]}
                      {record.completed === false ? " · belum memenuhi kehadiran" : ""}
                      {record.rejectReason ? ` · ${record.rejectReason}` : ""}
                    </span>
                  </span>
                  <span className="flex gap-2">
                    {record.certificateId ? (
                      <a href={myCertificateUrl(record.id)} className="min-h-11 rounded-xl border border-border px-3 py-2.5 text-xs font-bold text-brand-heading">Sertifikat</a>
                    ) : null}
                    {record.status === "SUBMITTED" ? (
                      <button type="button" disabled={busy} onClick={() => withdraw(record)}
                        className="min-h-11 rounded-xl border border-danger-line px-3 text-xs font-bold text-danger-ink disabled:opacity-50">Tarik</button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {recordPaging && recordPaging.total > 0 ? (
            <PaginationBar page={recordPaging.page} pageSize={recordPaging.pageSize} total={recordPaging.total}
              onPageChange={(page) => void loadRecords(page)} />
          ) : null}
        </section>

        <form onSubmit={submit} className={`${card} mt-6 p-5`}>
          <h2 className="text-sm font-bold text-brand-heading">Catat pelatihan dari pihak luar</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-semibold text-brand-heading sm:col-span-2">
              Nama pelatihan
              <input required minLength={3} maxLength={200} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} className={input} />
            </label>
            <label className="text-sm font-semibold text-brand-heading">
              Penyelenggara
              <input required minLength={3} maxLength={200} value={form.organizer} onChange={(event) => setForm({ ...form, organizer: event.target.value })} className={input} />
            </label>
            <label className="text-sm font-semibold text-brand-heading">
              Kategori
              <select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value as TrainingCategory })} className={input}>
                {Object.entries(CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className="text-sm font-semibold text-brand-heading">
              Mulai
              <input type="date" required max={todayInJakarta()} value={form.startOn}
                onChange={(event) => setForm({ ...form, startOn: event.target.value, endOn: event.target.value > form.endOn ? event.target.value : form.endOn })} className={input} />
            </label>
            <label className="text-sm font-semibold text-brand-heading">
              Selesai
              <input type="date" required min={form.startOn} max={todayInJakarta()} value={form.endOn}
                onChange={(event) => setForm({ ...form, endOn: event.target.value })} className={input} />
            </label>
            <label className="text-sm font-semibold text-brand-heading">
              Jumlah jam
              <input type="number" required min={0.5} max={200} step={0.25} value={form.hours}
                onChange={(event) => setForm({ ...form, hours: event.target.value })} className={input} />
            </label>
            <label className="text-sm font-semibold text-brand-heading">
              Sertifikat (PDF/JPG/PNG, maks 2 MB)
              <input type="file" accept="application/pdf,image/jpeg,image/png" onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                className="mt-1.5 block w-full text-sm font-normal text-muted-foreground" />
            </label>
            <label className="text-sm font-semibold text-brand-heading sm:col-span-2">
              Ringkasan materi (opsional)
              <textarea maxLength={2000} rows={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })}
                className="mt-1.5 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm font-normal text-brand-heading" />
            </label>
          </div>
          <button type="submit" disabled={busy || form.title.trim().length < 3 || form.organizer.trim().length < 3 || !form.hours}
            className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null} Kirim untuk diverifikasi
          </button>
        </form>
      </section>
    </AppShell>
  );
}
