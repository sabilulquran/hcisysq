// LOAN-001 employee surface: request a loan, follow its approval, watch the schedule and the
// balance, cancel before disbursement. Spec: docs/domain/employee-loans.md.

import { HandCoins, Loader2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { LoanDetailPanel } from "@/components/loans/LoanDetailPanel";
import { PaginationBar } from "@/components/PaginationBar";
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

const emptyForm = () => ({ principal: "", tenorMonths: 6, purpose: "" });

export function EmployeeLoansPage() {
  const [employee, setEmployee] = useState<EmployeeLeaveSummary["employee"] | null>(null);
  const [items, setItems] = useState<LoanSummary[]>([]);
  const [page, setPage] = useState(1);
  const [paging, setPaging] = useState<Pagination | null>(null);
  const [selected, setSelected] = useState<LoanDetail | null>(null);
  const [form, setForm] = useState(emptyForm);
  // One key per filled-in form: a double click or a retry after a lost response replays
  // the same submission instead of creating a second loan.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [preview, setPreview] = useState<LoanPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
    // A notification links here with ?loan=<id>.
    const linked = new URLSearchParams(window.location.search).get("loan");
    if (linked) void open(linked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changePage = (next: number) => {
    setPage(next);
    void loadList(next).catch((cause) => setError(cause instanceof Error ? cause.message : "Halaman tidak dapat dimuat."));
  };

  const update = (patch: Partial<ReturnType<typeof emptyForm>>) => {
    setForm((current) => ({ ...current, ...patch }));
    if (patch.principal !== undefined || patch.tenorMonths !== undefined) setPreview(null);
  };

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
    if (principal === null) throw new Error("Tulis pokok pinjaman dalam rupiah tanpa koma, misalnya 1.500.000.");
    setPreview(await previewLoan(principal, form.tenorMonths));
  }, "Jadwal dan penyetuju tidak dapat diperiksa.");

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      if (principal === null) throw new Error("Tulis pokok pinjaman dalam rupiah tanpa koma, misalnya 1.500.000.");
      const created = await submitLoan({ principal, tenorMonths: form.tenorMonths, purpose: form.purpose.trim(), idempotencyKey });
      setForm(emptyForm());
      setPreview(null);
      setIdempotencyKey(crypto.randomUUID());
      setNotice("Pinjaman diajukan dan sedang menunggu persetujuan.");
      setPage(1);
      await loadList(1);
      await open(created.id);
    }, "Pinjaman tidak dapat diajukan.");
  };

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

        {error ? <div className="mt-5 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div> : null}
        {notice ? <div className="mt-5 rounded-2xl border border-border bg-surface p-4 text-sm text-brand-heading">{notice}</div> : null}

        <form onSubmit={submit} className="mt-6 rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
          <h2 className="text-sm font-bold text-brand-heading">Ajukan pinjaman</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-semibold text-brand-heading">
              Pokok pinjaman (Rp)
              <input required inputMode="numeric" autoComplete="off" value={form.principal} placeholder="Contoh: 1.500.000"
                onChange={(event) => update({ principal: event.target.value })} className={input} />
              {form.principal && principal === null ? (
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
              <textarea required minLength={10} maxLength={1000} rows={3} value={form.purpose}
                placeholder="Contoh: biaya perbaikan atap rumah"
                onChange={(event) => update({ purpose: event.target.value })}
                className="mt-1.5 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm font-normal text-brand-heading" />
            </label>
          </div>
          {preview ? (
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
                  {preview.approvalChain.map((step) => <li key={step.employeeId}>{step.name} ({approverRoleLabel(step.sources)})</li>)}
                </ol>
              </div>
            </div>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" disabled={busy || principal === null} onClick={() => void check()}
              className="min-h-11 rounded-xl border border-border px-4 text-sm font-bold text-brand-heading disabled:opacity-50">
              Lihat cicilan dan penyetuju
            </button>
            <button type="submit" disabled={busy || principal === null || form.purpose.trim().length < 10}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null} Kirim pengajuan
            </button>
          </div>
        </form>

        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <section className="overflow-hidden rounded-3xl border border-border/75 bg-surface-raised shadow-[var(--shadow-soft)]">
            <h2 className="px-5 pt-5 text-sm font-bold text-brand-heading">Pinjaman saya</h2>
            {loading ? (
              <div className="flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat...</div>
            ) : items.length === 0 ? (
              <p className="px-5 py-8 text-sm text-muted-foreground">Belum ada pinjaman.</p>
            ) : (
              <ul className="mt-3 divide-y divide-border/70">
                {items.map((loan) => (
                  <li key={loan.id}>
                    <button type="button" onClick={() => void open(loan.id)}
                      className={`flex w-full items-start gap-3 px-5 py-3 text-left hover:bg-muted/50 ${selected?.id === loan.id ? "bg-muted/60" : ""}`}>
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

          <section className="rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
            {selected ? (
              <>
                <div className="flex justify-end">
                  <button type="button" aria-label="Tutup detail" onClick={() => setSelected(null)} className="rounded-lg p-1 hover:bg-muted">
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <LoanDetailPanel
                  loan={selected}
                  actions={selected.status === "IN_REVIEW" || selected.status === "APPROVED" ? (
                    <button type="button" disabled={busy} onClick={() => cancel(selected)}
                      className="min-h-11 rounded-xl border border-danger-line px-3 text-sm font-bold text-danger-ink disabled:opacity-50">
                      Batalkan pengajuan
                    </button>
                  ) : null}
                />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Pilih pinjaman untuk melihat persetujuan, jadwal cicilan, pembayaran, dan riwayatnya.</p>
            )}
          </section>
        </div>
      </section>
    </AppShell>
  );
}
