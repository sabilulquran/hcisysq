// ATT-015 employee surface: ask for tugas luar, WFH/WFA or a schedule change, follow its approval,
// cancel it. Spec: docs/domain/attendance-remote-and-schedule-requests.md.

import { CalendarClock, Home, Loader2, MapPin } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ArrangementDetailPanel } from "@/components/arrangements/ArrangementDetailPanel";
import { DetailDialog, useDialogParam } from "@/components/DetailDialog";
import { DialogLoading, DialogMessages } from "@/components/DetailDialogParts";
import { PaginationBar } from "@/components/PaginationBar";
import { AppShell } from "@/layouts/AppShell";
import { employeeShellUser } from "@/lib/employeeIdentity";
import { getEmployeeLeaveSummary, type EmployeeLeaveSummary } from "@/lib/employeeLeave";
import {
  approverRoleLabel,
  ARRANGEMENT_TYPE_LABELS,
  arrangementStatusLabel,
  arrangementSubject,
  cancelMyArrangement,
  formatArrangementRange,
  formatClock,
  getMyArrangement,
  getMyArrangements,
  getScheduleOptions,
  previewArrangement,
  submitArrangement,
  todayInJakarta,
  type ArrangementDetail,
  type ArrangementInput,
  type ArrangementPreview,
  type ArrangementSummary,
  type ArrangementType,
  type Pagination,
  type ScheduleOptions,
} from "@/lib/workArrangements";

function addDays(date: string, days: number) {
  const base = new Date(`${date}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** D-05 DRAFT, mirrored for the date pickers only; the API decides. */
function earliestFor(type: ArrangementType) {
  const today = todayInJakarta();
  if (type === "FIELD_ASSIGNMENT") return addDays(today, -7);
  if (type === "REMOTE_WORK") return today;
  return addDays(today, 1);
}

const TYPE_HELP: Record<ArrangementType, string> = {
  FIELD_ASSIGNMENT: "Bertugas di luar lokasi kerja pada jam kerja, paling lama 7 hari. Tugas yang menginap diajukan sebagai Perjalanan Dinas.",
  REMOTE_WORK: "Bekerja dari rumah atau lokasi lain untuk satu hari. Setiap hari diajukan dan disetujui tersendiri.",
  SCHEDULE_CHANGE: "Mengganti shift Anda sendiri pada satu tanggal mulai besok. Setelah disetujui, Human Capital menerapkannya.",
};

const TYPE_ICONS = { FIELD_ASSIGNMENT: MapPin, REMOTE_WORK: Home, SCHEDULE_CHANGE: CalendarClock } as const;

const emptyForm = (type: ArrangementType = "FIELD_ASSIGNMENT") => {
  const start = type === "FIELD_ASSIGNMENT" ? todayInJakarta() : earliestFor(type);
  return { type, location: "", purpose: "", startOn: start, endOn: start, scheduleTemplateId: "" };
};

export function EmployeeWorkArrangementsPage() {
  const [employee, setEmployee] = useState<EmployeeLeaveSummary["employee"] | null>(null);
  const [items, setItems] = useState<ArrangementSummary[]>([]);
  const [page, setPage] = useState(1);
  const [paging, setPaging] = useState<Pagination | null>(null);
  const [selected, setSelected] = useState<ArrangementDetail | null>(null);
  // The open request lives in ?arrangement=<id> (notification links use it too) and shows as a pop-up.
  const [arrangementId, showArrangement, closeArrangement] = useDialogParam("arrangement");
  const [form, setForm] = useState(() => emptyForm());
  // One key per filled-in form: a double click or a retry after a lost response replays the same submission.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [preview, setPreview] = useState<ArrangementPreview | null>(null);
  const [schedule, setSchedule] = useState<ScheduleOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const user = useMemo(() => employeeShellUser(employee), [employee]);
  const singleDay = form.type !== "FIELD_ASSIGNMENT";

  const loadList = async (target = page) => {
    const result = await getMyArrangements(target);
    setItems(result.items);
    setPaging(result.pagination);
  };

  const open = async (id: string) => {
    setError(null);
    try {
      setSelected(await getMyArrangement(id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pengajuan tidak dapat dibuka.");
    }
  };

  useEffect(() => {
    void getEmployeeLeaveSummary().then((summary) => setEmployee(summary.employee)).catch(() => undefined);
    void loadList(1)
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Pengajuan tidak dapat dimuat."))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (arrangementId) void open(arrangementId);
    else setSelected(null);
  }, [arrangementId]);

  // A schedule change shows the current shift of the chosen date and the shifts it may become.
  useEffect(() => {
    if (form.type !== "SCHEDULE_CHANGE" || !form.startOn) {
      setSchedule(null);
      return;
    }
    let alive = true;
    void getScheduleOptions(form.startOn)
      .then((result) => { if (alive) setSchedule(result); })
      .catch((cause) => { if (alive) { setSchedule(null); setError(cause instanceof Error ? cause.message : "Daftar shift tidak dapat dimuat."); } });
    return () => { alive = false; };
  }, [form.type, form.startOn]);

  const changePage = (next: number) => {
    setPage(next);
    void loadList(next).catch((cause) => setError(cause instanceof Error ? cause.message : "Halaman tidak dapat dimuat."));
  };

  const update = (patch: Partial<ReturnType<typeof emptyForm>>) => {
    setForm((current) => {
      const next = { ...current, ...patch };
      if (next.type !== "FIELD_ASSIGNMENT") next.endOn = next.startOn;
      return next;
    });
    if (patch.type !== undefined || patch.startOn !== undefined || patch.endOn !== undefined || patch.scheduleTemplateId !== undefined) setPreview(null);
  };

  const chooseType = (type: ArrangementType) => {
    setForm(emptyForm(type));
    setPreview(null);
    setIdempotencyKey(crypto.randomUUID());
  };

  const input = (): ArrangementInput => form.type === "SCHEDULE_CHANGE"
    ? { type: "SCHEDULE_CHANGE", startOn: form.startOn, endOn: form.startOn, scheduleTemplateId: form.scheduleTemplateId }
    : { type: form.type, startOn: form.startOn, endOn: form.endOn, location: form.location.trim() };

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

  const check = () => run(async () => {
    setPreview(await previewArrangement(input()));
  }, "Pengajuan tidak dapat diperiksa.");

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const created = await submitArrangement({ ...input(), purpose: form.purpose.trim(), idempotencyKey });
      setForm(emptyForm(form.type));
      setPreview(null);
      setIdempotencyKey(crypto.randomUUID());
      setNotice(`${ARRANGEMENT_TYPE_LABELS[form.type]} diajukan dan sedang menunggu persetujuan.`);
      setPage(1);
      await loadList(1);
      showArrangement(created.id);
    }, "Pengajuan tidak dapat dikirim.");
  };

  const cancel = (item: ArrangementDetail) => {
    const reason = window.prompt("Alasan pembatalan (minimal 5 karakter)");
    if (!reason || reason.trim().length < 5) return;
    void run(async () => {
      await cancelMyArrangement(item.id, reason.trim());
      setNotice("Pengajuan dibatalkan.");
      await Promise.all([loadList(), open(item.id)]);
    }, "Pengajuan tidak dapat dibatalkan.");
  };

  const ready = form.purpose.trim().length >= 10
    && (form.type === "SCHEDULE_CHANGE" ? Boolean(form.scheduleTemplateId) : form.location.trim().length >= 3);
  const today = todayInJakarta();
  const field = "mt-1.5 min-h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm font-normal text-brand-heading";

  return (
    <AppShell user={user} activeItem="Tugas Luar & WFH">
      <section className="mx-auto max-w-5xl">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand-primary-deep">Layanan Pegawai</p>
        <h1 className="mt-1 text-2xl font-bold text-brand-heading sm:text-3xl">Tugas Luar &amp; WFH</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Ajukan tugas di luar lokasi kerja, bekerja dari rumah atau lokasi lain, atau ubah shift Anda. Atasan langsung lalu
          approver unit menyetujui. Yang disetujui menjelaskan hari tanpa scan di rekap kehadiran; jam absen tidak diisi otomatis.
        </p>

        {error && !arrangementId ? <div className="mt-5 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div> : null}
        {notice && !arrangementId ? <div className="mt-5 rounded-2xl border border-border bg-surface p-4 text-sm text-brand-heading">{notice}</div> : null}

        <form onSubmit={submit} className="mt-6 rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
          <h2 className="text-sm font-bold text-brand-heading">Ajukan</h2>
          <div className="mt-3 grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Jenis pengajuan">
            {(Object.keys(ARRANGEMENT_TYPE_LABELS) as ArrangementType[]).map((type) => {
              const Icon = TYPE_ICONS[type];
              const active = form.type === type;
              return (
                <button key={type} type="button" role="radio" aria-checked={active} onClick={() => chooseType(type)}
                  className={`flex min-h-11 items-center gap-2 rounded-xl border px-3 text-left text-sm font-semibold ${active ? "border-brand-primary bg-brand-primary/10 text-brand-primary-deep" : "border-border text-brand-heading"}`}>
                  <Icon className="h-4 w-4 shrink-0" aria-hidden="true" /> {ARRANGEMENT_TYPE_LABELS[type]}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">{TYPE_HELP[form.type]}</p>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {form.type !== "SCHEDULE_CHANGE" ? (
              <label className="text-sm font-semibold text-brand-heading sm:col-span-2">
                {form.type === "FIELD_ASSIGNMENT" ? "Tempat tugas" : "Lokasi kerja"}
                <input required minLength={3} maxLength={200} value={form.location}
                  placeholder={form.type === "FIELD_ASSIGNMENT" ? "Contoh: SDIT Mitra Cibinong" : "Contoh: Rumah, Cibinong"}
                  onChange={(event) => update({ location: event.target.value })} className={field} />
              </label>
            ) : null}
            <label className="text-sm font-semibold text-brand-heading">
              {singleDay ? "Tanggal" : "Mulai"}
              <input type="date" required min={earliestFor(form.type)} value={form.startOn}
                onChange={(event) => update({ startOn: event.target.value, endOn: event.target.value > form.endOn ? event.target.value : form.endOn })}
                className={field} />
            </label>
            {!singleDay ? (
              <label className="text-sm font-semibold text-brand-heading">
                Selesai
                <input type="date" required min={form.startOn} max={addDays(form.startOn, 6)} value={form.endOn}
                  onChange={(event) => update({ endOn: event.target.value })} className={field} />
              </label>
            ) : null}
            {form.type === "SCHEDULE_CHANGE" ? (
              <div className="text-sm font-semibold text-brand-heading">
                <label htmlFor="arrangement-shift">Shift tujuan</label>
                <select id="arrangement-shift" required value={form.scheduleTemplateId}
                  onChange={(event) => update({ scheduleTemplateId: event.target.value })} className={field}
                  disabled={!schedule || schedule.current.state !== "scheduled"}>
                  <option value="">Pilih shift</option>
                  {(schedule?.options ?? []).map((option) => (
                    <option key={option.id} value={option.id}>{option.name} ({option.startTime}–{option.endTime})</option>
                  ))}
                </select>
                <p className="mt-1 text-xs font-normal text-muted-foreground">
                  {!schedule ? "Memuat jadwal..."
                    : schedule.current.state !== "scheduled" ? "Tanggal ini bukan hari kerja terjadwal; ubah jadwal tidak tersedia."
                    : `Jadwal saat ini: ${schedule.current.scheduleName ?? "-"}${schedule.current.scheduledStartAt && schedule.current.scheduledEndAt
                      ? ` (${formatClock(schedule.current.scheduledStartAt)}–${formatClock(schedule.current.scheduledEndAt)})` : ""}`}
                </p>
              </div>
            ) : null}
            <label className="text-sm font-semibold text-brand-heading sm:col-span-2">
              Keperluan
              <textarea required minLength={10} maxLength={1000} rows={3} value={form.purpose}
                placeholder={form.type === "SCHEDULE_CHANGE" ? "Contoh: mengantar orang tua kontrol ke rumah sakit pagi hari" : "Contoh: mendampingi santri lomba tahfizh tingkat kecamatan"}
                onChange={(event) => update({ purpose: event.target.value })}
                className="mt-1.5 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm font-normal text-brand-heading" />
            </label>
          </div>
          {form.type === "FIELD_ASSIGNMENT" && form.startOn < today ? (
            <p className="mt-3 text-xs text-muted-foreground">Tanggal yang sudah lewat langsung dihitung ulang di kehadiran begitu disetujui.</p>
          ) : null}
          {preview ? (
            <div className="mt-4 rounded-2xl border border-border/70 bg-surface p-3 text-sm">
              <p className="font-semibold text-brand-heading">{preview.days} hari · penyetuju:</p>
              <ol className="mt-1 list-decimal pl-5 text-muted-foreground">
                {preview.approvalChain.map((step) => <li key={step.employeeId}>{step.name} ({approverRoleLabel(step.sources)})</li>)}
              </ol>
              {preview.meetings.length > 0 ? (
                <div className="mt-3 rounded-xl border border-warning-line bg-warning-soft p-2 text-xs text-warning-ink">
                  <p className="font-semibold">Anda terdaftar di rapat pada tanggal ini:</p>
                  <ul className="mt-1 list-disc pl-4">
                    {preview.meetings.map((meeting) => (
                      <li key={`${meeting.title}-${meeting.startAt}`}>{meeting.title} ({formatClock(meeting.startAt)}–{formatClock(meeting.endAt)})</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" disabled={busy || (form.type === "SCHEDULE_CHANGE" && !form.scheduleTemplateId)} onClick={() => void check()}
              className="min-h-11 rounded-xl border border-border px-4 text-sm font-bold text-brand-heading disabled:opacity-50">
              Periksa penyetuju
            </button>
            <button type="submit" disabled={busy || !ready}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null} Kirim pengajuan
            </button>
          </div>
        </form>

        <div className="mt-6">
          <section className="overflow-hidden rounded-3xl border border-border/75 bg-surface-raised shadow-[var(--shadow-soft)]">
            <h2 className="px-5 pt-5 text-sm font-bold text-brand-heading">Pengajuan saya</h2>
            {loading ? (
              <div className="flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat...</div>
            ) : items.length === 0 ? (
              <p className="px-5 py-8 text-sm text-muted-foreground">Belum ada pengajuan tugas luar, WFH, atau ubah jadwal.</p>
            ) : (
              <ul className="mt-3 divide-y divide-border/70">
                {items.map((item) => {
                  const Icon = TYPE_ICONS[item.type];
                  return (
                    <li key={item.id}>
                      <button type="button" onClick={() => showArrangement(item.id)}
                        className={`flex w-full items-start gap-3 px-5 py-3 text-left hover:bg-muted/50 ${arrangementId === item.id ? "bg-muted/60" : ""}`}>
                        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-brand-primary-deep" aria-hidden="true" />
                        <span className="min-w-0">
                          <span className="block truncate font-semibold text-brand-heading">{ARRANGEMENT_TYPE_LABELS[item.type]} · {arrangementSubject(item)}</span>
                          <span className="block text-xs text-muted-foreground">{formatArrangementRange(item.startOn, item.endOn)}</span>
                          <span className="mt-1 block text-[11px] font-semibold text-muted-foreground">
                            {arrangementStatusLabel(item.status, item.type)}
                            {item.currentApproverName ? ` · menunggu ${item.currentApproverName}` : ""}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {paging && paging.total > 0 ? (
              <PaginationBar page={paging.page} pageSize={paging.pageSize} total={paging.total} onPageChange={changePage} />
            ) : null}
          </section>

          {arrangementId ? (
            <DetailDialog title="Detail pengajuan" onClose={closeArrangement}>
              <DialogMessages error={error} notice={notice} />
              {selected?.id === arrangementId ? (
                <ArrangementDetailPanel
                  item={selected}
                  actions={selected.status === "IN_REVIEW" || (selected.status === "APPROVED" && today < selected.startOn) ? (
                    <button type="button" disabled={busy} onClick={() => cancel(selected)}
                      className="min-h-11 rounded-xl border border-danger-line px-3 text-sm font-bold text-danger-ink disabled:opacity-50">
                      Batalkan
                    </button>
                  ) : null}
                />
              ) : error ? null : <DialogLoading />}
            </DetailDialog>
          ) : null}
        </div>
      </section>
    </AppShell>
  );
}
