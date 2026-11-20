// TRIP-001 employee surface: submit a business trip, follow its approval, print the surat
// tugas, cancel or complete it. Spec: docs/domain/business-travel.md.

import { ArrowLeft, CheckCircle2, ChevronRight, Loader2, Plane } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { DetailDialog, useDialogParam } from "@/components/DetailDialog";
import { DialogLoading, DialogMessages } from "@/components/DetailDialogParts";
import { PaginationBar } from "@/components/PaginationBar";
import { TripDetailPanel } from "@/components/trips/TripDetailPanel";
import { WizardDone } from "@/components/wizard/WizardDone";
import { WizardSteps } from "@/components/wizard/WizardSteps";
import { AppShell } from "@/layouts/AppShell";
import { employeeShellUser } from "@/lib/employeeIdentity";
import { getEmployeeLeaveSummary, type EmployeeLeaveSummary } from "@/lib/employeeLeave";
import {
  approverRoleLabel,
  cancelMyTrip,
  completeMyTrip,
  formatTripRange,
  getMyTrip,
  getMyTrips,
  previewTrip,
  submitTrip,
  todayInJakarta,
  tripStatusLabel,
  type Pagination,
  type TripDetail,
  type TripPreview,
  type TripSummary,
} from "@/lib/trips";
import { useWizardStep } from "@/lib/useWizardStep";

// UX-FLOW-001: one step per screen. The step lives in ?langkah= so Back goes one step back.
const STEPS = ["isi", "periksa", "selesai"] as const;
const STEP_LABELS = ["Isi data", "Periksa", "Selesai"] as const;

const emptyForm = () => ({ destination: "", purpose: "", startOn: todayInJakarta(), endOn: todayInJakarta() });

/** D-18 DRAFT, mirrored for the date picker only; the API decides. Same 7 days as tugas luar. */
function earliestTripStart() {
  const base = new Date(`${todayInJakarta()}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() - 7);
  return base.toISOString().slice(0, 10);
}

export function EmployeeTripsPage() {
  const { step, index, goTo } = useWizardStep(STEPS);
  const [employee, setEmployee] = useState<EmployeeLeaveSummary["employee"] | null>(null);
  const [items, setItems] = useState<TripSummary[]>([]);
  const [page, setPage] = useState(1);
  const [paging, setPaging] = useState<Pagination | null>(null);
  const [selected, setSelected] = useState<TripDetail | null>(null);
  // The open trip lives in ?trip=<id> (notification links use it too) and shows as a pop-up.
  const [tripId, showTrip, closeTrip] = useDialogParam("trip");
  const [form, setForm] = useState(emptyForm);
  // One key per filled-in form: a double click or a retry after a lost response replays
  // the same submission instead of creating a second trip.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [preview, setPreview] = useState<TripPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<{ id: string; message: string } | null>(null);

  const user = useMemo(() => employeeShellUser(employee), [employee]);

  const loadList = async (target = page) => {
    const result = await getMyTrips(target);
    setItems(result.items);
    setPaging(result.pagination);
  };

  const open = async (id: string) => {
    setError(null);
    try {
      setSelected(await getMyTrip(id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Perjalanan dinas tidak dapat dibuka.");
    }
  };

  useEffect(() => {
    void getEmployeeLeaveSummary().then((summary) => setEmployee(summary.employee)).catch(() => undefined);
    void loadList(1)
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Perjalanan dinas tidak dapat dimuat."))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tripId) void open(tripId);
    else setSelected(null);
  }, [tripId]);

  const changePage = (next: number) => {
    setPage(next);
    void loadList(next).catch((cause) => setError(cause instanceof Error ? cause.message : "Halaman tidak dapat dimuat."));
  };

  const update = (patch: Partial<ReturnType<typeof emptyForm>>) => {
    setForm((current) => ({ ...current, ...patch }));
    if (patch.startOn !== undefined || patch.endOn !== undefined) setPreview(null);
  };

  const run = async (action: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallback);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } finally {
      setBusy(false);
    }
  };

  // UX-FLOW-001: tombol lanjut tetap aktif; syarat yang belum terpenuhi dijelaskan di isiannya.
  const [attempted, setAttempted] = useState(false);
  const focusFirstInvalid = () => {
    window.requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>("[aria-invalid='true']");
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
      target?.focus({ preventScroll: true });
    });
  };

  const checkApprovers = () => {
    setAttempted(true);
    if (!ready) {
      focusFirstInvalid();
      return Promise.resolve();
    }
    return run(async () => {
    setPreview(await previewTrip(form.startOn, form.endOn));
    goTo("periksa");
  }, "Penyetuju tidak dapat diperiksa.");
  };

  const submit = () => {
    void run(async () => {
      const created = await submitTrip({ ...form, destination: form.destination.trim(), purpose: form.purpose.trim(), idempotencyKey });
      setForm(emptyForm());
      setAttempted(false);
      setPreview(null);
      setIdempotencyKey(crypto.randomUUID());
      setSubmitted({ id: created.id, message: "Perjalanan dinas diajukan dan sedang menunggu persetujuan." });
      goTo("selesai", { replace: true });
      setPage(1);
      await loadList(1);
    }, "Perjalanan dinas tidak dapat diajukan.");
  };

  // A later step cannot open without the data of the step before it (refresh, direct link).
  useEffect(() => {
    if (step === "periksa" && !preview) goTo("isi", { replace: true });
    if (step === "selesai" && !submitted) goTo("isi", { replace: true });
  }, [step, preview, submitted, goTo]);

  const ready = form.destination.trim().length >= 3 && form.purpose.trim().length >= 10;

  const cancel = (trip: TripDetail) => {
    const reason = window.prompt("Alasan pembatalan (minimal 5 karakter)");
    if (!reason || reason.trim().length < 5) return;
    void run(async () => {
      await cancelMyTrip(trip.id, reason.trim());
      setNotice("Perjalanan dinas dibatalkan.");
      await Promise.all([loadList(), open(trip.id)]);
    }, "Perjalanan dinas tidak dapat dibatalkan.");
  };

  const complete = (trip: TripDetail) => {
    const report = window.prompt("Laporan singkat hasil perjalanan (minimal 10 karakter)");
    if (!report || report.trim().length < 10) return;
    void run(async () => {
      await completeMyTrip(trip.id, report.trim());
      setNotice("Perjalanan dinas ditandai selesai.");
      await Promise.all([loadList(), open(trip.id)]);
    }, "Perjalanan dinas tidak dapat diselesaikan.");
  };

  const input = "mt-1.5 min-h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm font-normal text-brand-heading";

  return (
    <AppShell user={user} activeItem="Perjalanan Dinas">
      <section className="mx-auto max-w-5xl">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand-primary-deep print:hidden">Layanan Pegawai</p>
        <h1 className="mt-1 text-2xl font-bold text-brand-heading sm:text-3xl print:hidden">Perjalanan Dinas</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground print:hidden">
          Ajukan penugasan ke luar tempat kerja. Atasan langsung lalu approver unit menyetujui, kemudian Human Capital
          menerbitkan surat tugas bernomor. Biaya dan uang muka belum diurus di sini.
        </p>

        {error && !tripId ? <div className="mt-5 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink print:hidden">{error}</div> : null}
        {notice && !tripId && step === "isi" ? <div className="mt-5 rounded-2xl border border-border bg-surface p-4 text-sm text-brand-heading print:hidden">{notice}</div> : null}

        <div className="print:hidden"><WizardSteps steps={STEP_LABELS} current={index} /></div>

        {step === "isi" ? (
          <form onSubmit={(event) => { event.preventDefault(); void checkApprovers(); }} className="mt-5 rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)] print:hidden">
            <h2 className="text-sm font-bold text-brand-heading">Ajukan perjalanan dinas</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="text-sm font-semibold text-brand-heading sm:col-span-2">
                Tujuan
                <input required maxLength={200} value={form.destination} placeholder="Contoh: Kantor Kemenag Kota Bandung"
                  aria-invalid={attempted && form.destination.trim().length < 3}
                  onChange={(event) => update({ destination: event.target.value })} className={input} />
                {attempted && form.destination.trim().length < 3 ? (
                  <span className="mt-1 block text-xs font-normal text-danger-ink">Tulis tujuan minimal 3 karakter.</span>
                ) : null}
              </label>
              <label className="text-sm font-semibold text-brand-heading">
                Berangkat
                <input type="date" required min={earliestTripStart()} value={form.startOn}
                  onChange={(event) => update({ startOn: event.target.value, endOn: event.target.value > form.endOn ? event.target.value : form.endOn })}
                  className={input} />
              </label>
              <label className="text-sm font-semibold text-brand-heading">
                Kembali
                <input type="date" required min={form.startOn} value={form.endOn}
                  onChange={(event) => update({ endOn: event.target.value })} className={input} />
              </label>
              <label className="text-sm font-semibold text-brand-heading sm:col-span-2">
                Keperluan
                <textarea required maxLength={1000} rows={3} value={form.purpose}
                  placeholder="Contoh: rapat koordinasi kurikulum tahfidz dengan yayasan mitra"
                  aria-invalid={attempted && form.purpose.trim().length < 10}
                  onChange={(event) => update({ purpose: event.target.value })}
                  className="mt-1.5 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm font-normal text-brand-heading" />
                {attempted && form.purpose.trim().length < 10 ? (
                  <span className="mt-1 block text-xs font-normal text-danger-ink">Tulis keperluan minimal 10 karakter.</span>
                ) : null}
              </label>
            </div>
            <div className="mt-6 flex justify-end">
              <button type="submit" disabled={busy}
                className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-brand-primary px-5 text-sm font-bold text-brand-foreground shadow-[var(--shadow-button)] disabled:opacity-50 sm:w-auto">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                Periksa penyetuju
                {busy ? null : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
              </button>
            </div>
          </form>
        ) : null}

        {step === "periksa" && preview ? (
          <section className="mt-5 rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)] print:hidden">
            <h2 className="text-sm font-bold text-brand-heading">Ringkasan sebelum dikirim</h2>
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
              <div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">Tujuan</dt><dd className="mt-0.5 break-words font-semibold text-brand-heading">{form.destination.trim()}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Tanggal</dt><dd className="mt-0.5 font-semibold text-brand-heading">{formatTripRange(form.startOn, form.endOn)}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Lama</dt><dd className="mt-0.5 font-semibold text-brand-heading">{preview.days} hari</dd></div>
              <div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">Keperluan</dt><dd className="mt-0.5 whitespace-pre-line break-words text-brand-heading">{form.purpose.trim()}</dd></div>
            </dl>
            <div className="mt-4 rounded-2xl border border-border/70 bg-surface p-3 text-sm">
              <p className="font-semibold text-brand-heading">{preview.days} hari · penyetuju:</p>
              <ol className="mt-1 list-decimal pl-5 text-muted-foreground">
                {preview.approvalChain.map((approver) => <li key={approver.employeeId}>{approver.name} ({approverRoleLabel(approver.sources)})</li>)}
              </ol>
            </div>
            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
              <button type="button" disabled={busy} onClick={() => goTo("isi")}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border bg-surface-raised px-4 text-sm font-semibold disabled:opacity-50">
                <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Ubah data
              </button>
              <button type="button" disabled={busy || !ready} onClick={submit}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-brand-primary px-5 text-sm font-bold text-brand-foreground shadow-[var(--shadow-button)] disabled:opacity-50">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
                Kirim pengajuan
              </button>
            </div>
          </section>
        ) : null}

        {step === "selesai" && submitted ? (
          <div className="print:hidden">
            <WizardDone title="Pengajuan terkirim" message={submitted.message}>
              <button type="button" onClick={() => showTrip(submitted.id)}
                className="inline-flex min-h-11 items-center justify-center rounded-xl bg-brand-primary px-5 text-sm font-bold text-brand-foreground">
                Lihat detail perjalanan
              </button>
              <button type="button" onClick={() => { setSubmitted(null); goTo("isi", { replace: true }); }}
                className="inline-flex min-h-11 items-center justify-center rounded-xl border border-border px-5 text-sm font-semibold">
                Kembali ke Perjalanan Dinas
              </button>
            </WizardDone>
          </div>
        ) : null}

        <div className="mt-6">
          {step === "isi" ? (
          <section className="overflow-hidden rounded-3xl border border-border/75 bg-surface-raised shadow-[var(--shadow-soft)] print:hidden">
            <h2 className="px-5 pt-5 text-sm font-bold text-brand-heading">Perjalanan saya</h2>
            {loading ? (
              <div className="flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat...</div>
            ) : items.length === 0 ? (
              <p className="px-5 py-8 text-sm text-muted-foreground">Belum ada perjalanan dinas.</p>
            ) : (
              <ul className="mt-3 divide-y divide-border/70">
                {items.map((trip) => (
                  <li key={trip.id}>
                    <button type="button" onClick={() => showTrip(trip.id)}
                      className={`flex w-full items-start gap-3 px-5 py-3 text-left hover:bg-muted/50 ${tripId === trip.id ? "bg-muted/60" : ""}`}>
                      <Plane className="mt-0.5 h-4 w-4 shrink-0 text-brand-primary-deep" aria-hidden="true" />
                      <span className="min-w-0">
                        <span className="block truncate font-semibold text-brand-heading">{trip.destination}</span>
                        <span className="block text-xs text-muted-foreground">{formatTripRange(trip.startOn, trip.endOn)}</span>
                        <span className="mt-1 block text-[11px] font-semibold text-muted-foreground">
                          {tripStatusLabel(trip.status)}
                          {trip.currentApproverName ? ` · menunggu ${trip.currentApproverName}` : ""}
                          {trip.documentNumber ? ` · ${trip.documentNumber}` : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {paging && paging.total > 0 ? (
              <PaginationBar page={paging.page} pageSize={paging.pageSize} total={paging.total} onPageChange={changePage} />
            ) : null}
          </section>
          ) : null}

          {tripId ? (
            <DetailDialog title="Detail perjalanan dinas" onClose={closeTrip} wide>
              <DialogMessages error={error} notice={notice} />
              {selected?.id === tripId ? (
                <TripDetailPanel
                  trip={selected}
                  actions={(
                    <>
                      {selected.status === "IN_REVIEW" || selected.status === "APPROVED" ? (
                        <button type="button" disabled={busy} onClick={() => cancel(selected)}
                          className="min-h-11 rounded-xl border border-danger-line px-3 text-sm font-bold text-danger-ink disabled:opacity-50">
                          Batalkan
                        </button>
                      ) : null}
                      {selected.status === "ISSUED" ? (
                        <button type="button" disabled={busy} onClick={() => complete(selected)}
                          className="min-h-11 rounded-xl bg-brand-primary px-3 text-sm font-bold text-brand-foreground disabled:opacity-50">
                          Tandai selesai
                        </button>
                      ) : null}
                    </>
                  )}
                />
              ) : error ? null : <DialogLoading />}
            </DetailDialog>
          ) : null}
        </div>
      </section>
    </AppShell>
  );
}
