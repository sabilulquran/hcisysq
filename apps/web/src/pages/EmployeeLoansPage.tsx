// LOAN-001 employee surface: request a loan, follow its approval, watch the schedule and the
// balance, cancel before disbursement. Spec: docs/domain/employee-loans.md.

import { ArrowLeft, CheckCircle2, ChevronRight, HandCoins, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { DetailDialog, useDialogParam } from "@/components/DetailDialog";
import { DialogLoading, DialogMessages } from "@/components/DetailDialogParts";
import { LoanDetailPanel } from "@/components/loans/LoanDetailPanel";
import { PaginationBar } from "@/components/PaginationBar";
import { WizardDone } from "@/components/wizard/WizardDone";
import { WizardSteps } from "@/components/wizard/WizardSteps";
import { AppShell } from "@/layouts/AppShell";
import { employeeShellUser } from "@/lib/employeeIdentity";
import { getEmployeeLeaveSummary, type EmployeeLeaveSummary } from "@/lib/employeeLeave";
import {
  approverRoleLabel,
  cancelMyLoan,
  formatLoanMonth,
  formatRupiah,
  getMyLoan,
  getMyLoans,
  loanStatusLabel,
  parseRupiahInput,
  previewLoan,
  submitLoan,
  TENOR_OPTIONS,
  type LoanDetail,
  type LoanPreview,
  type LoanSummary,
  type Pagination,
} from "@/lib/loans";
import { useWizardStep } from "@/lib/useWizardStep";

// UX-FLOW-001: one step per screen. The step lives in ?langkah= so Back goes one step back.
const STEPS = ["isi", "periksa", "selesai"] as const;
const STEP_LABELS = ["Isi data", "Periksa", "Selesai"] as const;

const emptyForm = () => ({ principal: "", tenorMonths: 6, purpose: "" });

export function EmployeeLoansPage() {
  const { step, index, goTo } = useWizardStep(STEPS);
  const [employee, setEmployee] = useState<EmployeeLeaveSummary["employee"] | null>(null);
  const [items, setItems] = useState<LoanSummary[]>([]);
  const [page, setPage] = useState(1);
  const [paging, setPaging] = useState<Pagination | null>(null);
  const [selected, setSelected] = useState<LoanDetail | null>(null);
  // The open loan lives in ?loan=<id> (notification links use it too) and shows as a pop-up.
  const [loanId, showLoan, closeLoan] = useDialogParam("loan");
  const [form, setForm] = useState(emptyForm);
  // One key per filled-in form: a double click or a retry after a lost response replays
  // the same submission instead of creating a second loan.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [preview, setPreview] = useState<LoanPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<{ id: string; message: string } | null>(null);

  const user = useMemo(() => employeeShellUser(employee), [employee]);
  const principal = parseRupiahInput(form.principal);

  const loadList = async (target = page) => {
    const result = await getMyLoans(target);
    setItems(result.items);
    setPaging(result.pagination);
  };

  const open = async (id: string) => {
    setError(null);
    try {
      setSelected(await getMyLoan(id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pinjaman tidak dapat dibuka.");
    }
  };

  useEffect(() => {
    void getEmployeeLeaveSummary().then((summary) => setEmployee(summary.employee)).catch(() => undefined);
    void loadList(1)
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Pinjaman tidak dapat dimuat."))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (loanId) void open(loanId);
    else setSelected(null);
  }, [loanId]);

  const changePage = (next: number) => {
    setPage(next);
    void loadList(next).catch((cause) => setError(cause instanceof Error ? cause.message : "Halaman tidak dapat dimuat."));
  };

  const update = (patch: Partial<ReturnType<typeof emptyForm>>) => {
    setForm((current) => ({ ...current, ...patch }));
    if (patch.principal !== undefined || patch.tenorMonths !== undefined) {
      setPreview(null);
      // The server refuses a reused key with other terms: new terms, new submission.
      setIdempotencyKey(crypto.randomUUID());
    }
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

  const check = () => {
    setAttempted(true);
    if (principal === null || form.purpose.trim().length < 10) {
      focusFirstInvalid();
      return Promise.resolve();
    }
    return run(async () => {
    if (principal === null) throw new Error("Tulis pokok pinjaman dalam rupiah tanpa koma, misalnya 1.500.000.");
    setPreview(await previewLoan(principal, form.tenorMonths));
    goTo("periksa");
  }, "Jadwal dan penyetuju tidak dapat diperiksa.");
  };

  const submit = () => {
    void run(async () => {
      if (principal === null) throw new Error("Tulis pokok pinjaman dalam rupiah tanpa koma, misalnya 1.500.000.");
      const created = await submitLoan({ principal, tenorMonths: form.tenorMonths, purpose: form.purpose.trim(), idempotencyKey });
      setForm(emptyForm());
      setAttempted(false);
      setPreview(null);
      setIdempotencyKey(crypto.randomUUID());
      setSubmitted({ id: created.id, message: "Pinjaman diajukan dan sedang menunggu persetujuan." });
      goTo("selesai", { replace: true });
      setPage(1);
      await loadList(1);
    }, "Pinjaman tidak dapat diajukan.");
  };

  // A later step cannot open without the data of the step before it (refresh, direct link).
  useEffect(() => {
    if (step === "periksa" && (!preview || principal === null)) goTo("isi", { replace: true });
    if (step === "selesai" && !submitted) goTo("isi", { replace: true });
  }, [step, preview, principal, submitted, goTo]);

  const cancel = (loan: LoanDetail) => {
    const reason = window.prompt("Alasan pembatalan (minimal 5 karakter)");
    if (!reason || reason.trim().length < 5) return;
    void run(async () => {
      await cancelMyLoan(loan.id, reason.trim());
      setNotice("Pengajuan pinjaman dibatalkan.");
      await Promise.all([loadList(), open(loan.id)]);
    }, "Pinjaman tidak dapat dibatalkan.");
  };

  const input = "mt-1.5 min-h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm font-normal text-brand-heading";

  return (
    <AppShell user={user} activeItem="Pinjaman">
      <section className="mx-auto max-w-5xl">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand-primary-deep">Keuangan Saya</p>
        <h1 className="mt-1 text-2xl font-bold text-brand-heading sm:text-3xl">Pinjaman</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Ajukan pinjaman tanpa bunga. Atasan langsung lalu approver unit menyetujui, kemudian Keuangan mencairkan dan
          menetapkan jadwal cicilan. Cicilan belum dipotong otomatis dari gaji; Keuangan mencatat setiap pembayaran di sini.
        </p>

        {error && !loanId ? <div className="mt-5 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div> : null}
        {notice && !loanId && step === "isi" ? <div className="mt-5 rounded-2xl border border-border bg-surface p-4 text-sm text-brand-heading">{notice}</div> : null}

        <WizardSteps steps={STEP_LABELS} current={index} />

        {step === "isi" ? (
          <form onSubmit={(event) => { event.preventDefault(); void check(); }} className="mt-5 rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
            <h2 className="text-sm font-bold text-brand-heading">Ajukan pinjaman</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="text-sm font-semibold text-brand-heading">
                Pokok pinjaman (Rp)
                <input required inputMode="numeric" autoComplete="off" value={form.principal} placeholder="Contoh: 1.500.000"
                  aria-invalid={attempted && principal === null}
                  onChange={(event) => update({ principal: event.target.value })} className={input} />
                {(form.principal || attempted) && principal === null ? (
                  <span className="mt-1 block text-xs font-normal text-danger-ink">Hanya angka dan titik ribuan, tanpa koma.</span>
                ) : null}
              </label>
              <label className="text-sm font-semibold text-brand-heading">
                Lama cicilan
                <select value={form.tenorMonths} onChange={(event) => update({ tenorMonths: Number(event.target.value) })} className={input}>
                  {TENOR_OPTIONS.map((months) => <option key={months} value={months}>{months} bulan</option>)}
                </select>
              </label>
              <label className="text-sm font-semibold text-brand-heading sm:col-span-2">
                Keperluan
                <textarea required maxLength={1000} rows={3} value={form.purpose}
                  placeholder="Contoh: biaya perbaikan atap rumah"
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
                Lihat cicilan dan penyetuju
                {busy ? null : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
              </button>
            </div>
          </form>
        ) : null}

        {step === "periksa" && preview && principal !== null ? (
          <section className="mt-5 rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
            <h2 className="text-sm font-bold text-brand-heading">Ringkasan sebelum dikirim</h2>
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
              <div><dt className="text-xs text-muted-foreground">Pokok pinjaman</dt><dd className="mt-0.5 font-semibold tabular-nums text-brand-heading">{formatRupiah(principal)}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Lama cicilan</dt><dd className="mt-0.5 font-semibold text-brand-heading">{form.tenorMonths} bulan</dd></div>
              <div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">Keperluan</dt><dd className="mt-0.5 whitespace-pre-line break-words text-brand-heading">{form.purpose.trim()}</dd></div>
            </dl>
            <div className="mt-4 grid gap-3 rounded-2xl border border-border/70 bg-surface p-3 text-sm sm:grid-cols-2">
              <div>
                <p className="font-semibold text-brand-heading">Perkiraan cicilan</p>
                <p className="text-xs text-muted-foreground">Bulan pasti ditetapkan Keuangan saat pencairan.</p>
                <ul className="mt-1 text-muted-foreground">
                  {preview.schedule.map((row) => (
                    <li key={row.sequence} className="flex justify-between gap-3 tabular-nums">
                      <span>{formatLoanMonth(row.dueMonth)}</span><span>{formatRupiah(row.amount)}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="font-semibold text-brand-heading">Penyetuju</p>
                <ol className="mt-1 list-decimal pl-5 text-muted-foreground">
                  {preview.approvalChain.map((approver) => <li key={approver.employeeId}>{approver.name} ({approverRoleLabel(approver.sources)})</li>)}
                </ol>
              </div>
            </div>
            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
              <button type="button" disabled={busy} onClick={() => goTo("isi")}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border bg-surface-raised px-4 text-sm font-semibold disabled:opacity-50">
                <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Ubah data
              </button>
              <button type="button" disabled={busy || form.purpose.trim().length < 10} onClick={submit}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-brand-primary px-5 text-sm font-bold text-brand-foreground shadow-[var(--shadow-button)] disabled:opacity-50">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
                Kirim pengajuan
              </button>
            </div>
          </section>
        ) : null}

        {step === "selesai" && submitted ? (
          <WizardDone title="Pengajuan terkirim" message={submitted.message}>
            <button type="button" onClick={() => showLoan(submitted.id)}
              className="inline-flex min-h-11 items-center justify-center rounded-xl bg-brand-primary px-5 text-sm font-bold text-brand-foreground">
              Lihat detail pinjaman
            </button>
            <button type="button" onClick={() => { setSubmitted(null); goTo("isi", { replace: true }); }}
              className="inline-flex min-h-11 items-center justify-center rounded-xl border border-border px-5 text-sm font-semibold">
              Kembali ke Pinjaman
            </button>
          </WizardDone>
        ) : null}

        {step === "isi" ? (
        <section className="mt-6 overflow-hidden rounded-3xl border border-border/75 bg-surface-raised shadow-[var(--shadow-soft)]">
          <h2 className="px-5 pt-5 text-sm font-bold text-brand-heading">Pinjaman saya</h2>
          {loading ? (
            <div className="flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat...</div>
          ) : items.length === 0 ? (
            <p className="px-5 py-8 text-sm text-muted-foreground">Belum ada pinjaman.</p>
          ) : (
            <ul className="mt-3 divide-y divide-border/70">
              {items.map((loan) => (
                <li key={loan.id}>
                  <button type="button" onClick={() => showLoan(loan.id)}
                    className={`flex w-full items-start gap-3 px-5 py-3 text-left hover:bg-muted/50 ${loanId === loan.id ? "bg-muted/60" : ""}`}>
                    <HandCoins className="mt-0.5 h-4 w-4 shrink-0 text-brand-primary-deep" aria-hidden="true" />
                    <span className="min-w-0">
                      <span className="block font-semibold tabular-nums text-brand-heading">{formatRupiah(loan.principal)} · {loan.tenorMonths} bulan</span>
                      <span className="block truncate text-xs text-muted-foreground">{loan.purpose}</span>
                      <span className="mt-1 block text-[11px] font-semibold text-muted-foreground">
                        {loanStatusLabel(loan.status)}
                        {loan.currentApproverName ? ` · menunggu ${loan.currentApproverName}` : ""}
                        {loan.status === "DISBURSED" ? ` · sisa ${formatRupiah(loan.outstanding)}` : ""}
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

        {loanId ? (
          <DetailDialog title="Detail pinjaman" onClose={closeLoan}>
            <DialogMessages error={error} notice={notice} />
            {selected?.id === loanId ? (
              <LoanDetailPanel
                loan={selected}
                actions={selected.status === "IN_REVIEW" || selected.status === "APPROVED" ? (
                  <button type="button" disabled={busy} onClick={() => cancel(selected)}
                    className="min-h-11 rounded-xl border border-danger-line px-3 text-sm font-bold text-danger-ink disabled:opacity-50">
                    Batalkan pengajuan
                  </button>
                ) : null}
              />
            ) : error ? null : <DialogLoading />}
          </DetailDialog>
        ) : null}
      </section>
    </AppShell>
  );
}
