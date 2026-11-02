// LOAN-001 Finance surface: the loan register, disbursement, repayments and their correction.
// Spec: docs/domain/employee-loans.md. The API authorizes every call and computes every amount;
// this page only reads what Finance types as whole rupiah.

import { Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";

import { EmployeeSearchField, type PickedEmployee } from "@/components/attendance/workforce/EmployeeSearchField";
import { LoanDetailPanel } from "@/components/loans/LoanDetailPanel";
import { PaginationBar } from "@/components/PaginationBar";
import { AdminShell } from "@/layouts/AdminShell";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import {
  cancelLoanAsFinance,
  disburseLoan,
  formatRupiah,
  getAdminLoan,
  getAdminLoans,
  LOAN_STATUS_LABELS,
  LoanApiError,
  loanStatusLabel,
  parseRupiahInput,
  PAYMENT_METHOD_LABELS,
  recordLoanPayment,
  reverseLoanPayment,
  searchLoanBorrowers,
  todayInJakarta,
  type LoanDetail,
  type LoanPayment,
  type LoanPaymentMethod,
  type LoanStatus,
  type LoanSummary,
  type Pagination,
} from "@/lib/loans";
import type { AuthSession } from "@/types/hcis";

const searchBorrowers = async (q: string) => (await searchLoanBorrowers(q)).items;

const emptyDisbursement = () => ({ disbursedOn: todayInJakarta(), method: "TRANSFER" as "CASH" | "TRANSFER", reference: "", firstDueMonth: "" });
const emptyPayment = () => ({ amount: "", paidOn: todayInJakarta(), method: "PAYROLL_DEDUCTION" as LoanPaymentMethod, reference: "", note: "" });

export function AdminLoansPage() {
  const [items, setItems] = useState<LoanSummary[]>([]);
  const [paging, setPaging] = useState<Pagination | null>(null);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<LoanStatus | "">("APPROVED");
  const [employee, setEmployee] = useState<PickedEmployee | null>(null);
  const [selected, setSelected] = useState<LoanDetail | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [disbursement, setDisbursement] = useState(emptyDisbursement);
  const [payment, setPayment] = useState(emptyPayment);
  // One key per filled-in payment form, so a retry after a lost response records it once.
  const [paymentKey, setPaymentKey] = useState(() => crypto.randomUUID());
  // Disbursing, recording and cancelling need loans.manage; reading the register needs loans.read.
  const canManage = hasPermission(session, "loans.manage");
  const paymentAmount = parseRupiahInput(payment.amount);

  const load = async () => {
    setLoading(true);
    try {
      const result = await getAdminLoans({ page, status, employeeId: employee?.id });
      setItems(result.items);
      setPaging(result.pagination);
      setError(null);
    } catch (cause) {
      if (cause instanceof LoanApiError && cause.status === 403) setForbidden(true);
      setError(cause instanceof Error ? cause.message : "Register pinjaman tidak dapat dimuat.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, status, employee?.id]);
  useEffect(() => {
    void getCurrentSession().then(setSession).catch(() => {
      setSession(null);
      setError("Izin akun tidak dapat dibaca, sehingga tombol tindakan disembunyikan. Muat ulang halaman.");
    });
  }, []);

  const open = async (id: string) => {
    try {
      setSelected(await getAdminLoan(id));
      setDisbursement(emptyDisbursement());
      setPayment(emptyPayment());
      setPaymentKey(crypto.randomUUID());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pinjaman tidak dapat dibuka.");
    }
  };

  const run = async (action: () => Promise<string>, loan: LoanDetail) => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      setNotice(await action());
      await Promise.all([load(), open(loan.id)]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Tindakan belum dapat diselesaikan.");
    } finally {
      setBusy(false);
    }
  };

  const disburse = (loan: LoanDetail) => {
    if (!window.confirm(`Cairkan ${formatRupiah(loan.principal)} untuk ${loan.employeeName}? Jadwal cicilan dibuat dan tidak dapat diubah.`)) return;
    void run(async () => {
      const result = await disburseLoan(loan.id, {
        disbursedOn: disbursement.disbursedOn,
        method: disbursement.method,
        reference: disbursement.reference.trim() || null,
        firstDueMonth: disbursement.firstDueMonth || null,
      });
      return `Pinjaman dicairkan. Cicilan pertama ${result.firstDueMonth}.`;
    }, loan);
  };

  const pay = (loan: LoanDetail) => {
    if (paymentAmount === null) return;
    const settles = paymentAmount === loan.outstanding;
    if (!window.confirm(`Catat pembayaran ${formatRupiah(paymentAmount)}${settles ? " sebagai pelunasan" : ""}?`)) return;
    void run(async () => {
      const result = await recordLoanPayment(loan.id, {
        amount: paymentAmount,
        paidOn: payment.paidOn,
        method: payment.method,
        reference: payment.reference.trim() || null,
        note: payment.note.trim() || null,
        idempotencyKey: paymentKey,
      });
      return result.status === "PAID_OFF" ? "Pembayaran dicatat. Pinjaman lunas." : "Pembayaran dicatat.";
    }, loan);
  };

  const reverse = (loan: LoanDetail, target: LoanPayment) => {
    const reason = window.prompt(`Alasan koreksi pembayaran ${formatRupiah(target.amount)} (minimal 10 karakter). Pembayaran tidak dihapus, hanya ditandai dikoreksi.`);
    if (!reason || reason.trim().length < 10) return;
    void run(async () => {
      await reverseLoanPayment(loan.id, target.id, reason.trim());
      return "Pembayaran dikoreksi; sisa pinjaman dihitung ulang.";
    }, loan);
  };

  const cancel = (loan: LoanDetail) => {
    const reason = window.prompt("Alasan pembatalan (minimal 10 karakter)");
    if (!reason || reason.trim().length < 10) return;
    void run(async () => {
      await cancelLoanAsFinance(loan.id, reason.trim());
      return "Pengajuan pinjaman dibatalkan.";
    }, loan);
  };

  const field = "mt-1 h-11 w-full rounded-xl border bg-surface px-3 text-sm text-foreground";

  return (
    <AdminShell active="services" title="Pinjaman Pegawai" description="Register pinjaman, pencairan, dan pencatatan cicilan.">
      {error ? <div className="mb-5 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div> : null}
      {notice ? <div className="mb-5 rounded-2xl border border-border bg-surface p-4 text-sm text-brand-heading">{notice}</div> : null}

      {forbidden ? null : (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <section className="overflow-hidden rounded-3xl border border-border/75 bg-surface-raised shadow-[var(--shadow-soft)]">
            <div className="grid gap-3 p-5 sm:grid-cols-2">
              <label className="text-xs font-semibold text-muted-foreground">
                Status
                <select value={status} onChange={(event) => { setPage(1); setStatus(event.target.value as LoanStatus | ""); }} className={field}>
                  <option value="">Semua status</option>
                  {(Object.keys(LOAN_STATUS_LABELS) as LoanStatus[]).map((key) => <option key={key} value={key}>{LOAN_STATUS_LABELS[key]}</option>)}
                </select>
              </label>
              <EmployeeSearchField value={employee} onChange={(next) => { setPage(1); setEmployee(next); }}
                search={searchBorrowers} emptyText="Tidak ada peminjam yang cocok." label="Peminjam" />
            </div>

            {loading ? (
              <div className="flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat register...</div>
            ) : items.length === 0 ? (
              <p className="px-5 py-8 text-sm text-muted-foreground">Tidak ada pinjaman pada filter ini.</p>
            ) : (
              <ul className="divide-y divide-border/70 border-t border-border/70">
                {items.map((loan) => (
                  <li key={loan.id}>
                    <button type="button" onClick={() => void open(loan.id)}
                      className={`w-full px-5 py-3 text-left hover:bg-muted/50 ${selected?.id === loan.id ? "bg-muted/60" : ""}`}>
                      <span className="block font-semibold text-brand-heading">{loan.employeeName} · <span className="tabular-nums">{formatRupiah(loan.principal)}</span></span>
                      <span className="block text-xs text-muted-foreground">
                        {loan.employeeNumber}{loan.unitName ? ` · ${loan.unitName}` : ""} · {loan.tenorMonths} bulan
                      </span>
                      <span className="mt-1 block text-[11px] font-semibold text-muted-foreground">
                        {loanStatusLabel(loan.status)}
                        {loan.currentApproverName ? ` · menunggu ${loan.currentApproverName}` : ""}
                        {loan.status === "DISBURSED" ? ` · sisa ${formatRupiah(loan.outstanding)}` : ""}
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
                  paymentAction={canManage ? (target) => (
                    <button type="button" disabled={busy} onClick={() => reverse(selected, target)}
                      className="min-h-9 rounded-lg border border-border px-2 text-xs font-bold text-brand-heading disabled:opacity-50">
                      Koreksi
                    </button>
                  ) : undefined}
                  actions={canManage ? (
                    <div className="w-full space-y-3">
                      {selected.status === "APPROVED" ? (
                        <div className="rounded-2xl border border-border/70 bg-surface p-3">
                          <p className="text-sm font-bold text-brand-heading">Pencairan</p>
                          <div className="mt-2 grid gap-3 sm:grid-cols-2">
                            <label className="text-xs font-semibold text-muted-foreground">Tanggal cair
                              <input type="date" max={todayInJakarta()} value={disbursement.disbursedOn} className={field}
                                onChange={(event) => setDisbursement({ ...disbursement, disbursedOn: event.target.value })} />
                            </label>
                            <label className="text-xs font-semibold text-muted-foreground">Cara
                              <select value={disbursement.method} className={field}
                                onChange={(event) => setDisbursement({ ...disbursement, method: event.target.value as "CASH" | "TRANSFER" })}>
                                <option value="TRANSFER">Transfer</option>
                                <option value="CASH">Tunai</option>
                              </select>
                            </label>
                            <label className="text-xs font-semibold text-muted-foreground">Cicilan pertama (opsional)
                              <input type="month" value={disbursement.firstDueMonth} className={field}
                                onChange={(event) => setDisbursement({ ...disbursement, firstDueMonth: event.target.value })} />
                            </label>
                            <label className="text-xs font-semibold text-muted-foreground">No. bukti (opsional)
                              <input maxLength={200} value={disbursement.reference} className={field}
                                onChange={(event) => setDisbursement({ ...disbursement, reference: event.target.value })} />
                            </label>
                          </div>
                          <p className="mt-2 text-xs text-muted-foreground">Tanpa bulan cicilan pertama, cicilan mulai bulan setelah pencairan.</p>
                          <button type="button" disabled={busy} onClick={() => disburse(selected)}
                            className="mt-3 min-h-11 rounded-xl bg-brand-primary px-3 text-sm font-bold text-brand-foreground disabled:opacity-50">
                            Cairkan dan buat jadwal
                          </button>
                        </div>
                      ) : null}
                      {selected.status === "DISBURSED" ? (
                        <div className="rounded-2xl border border-border/70 bg-surface p-3">
                          <p className="text-sm font-bold text-brand-heading">Catat pembayaran</p>
                          <div className="mt-2 grid gap-3 sm:grid-cols-2">
                            <label className="text-xs font-semibold text-muted-foreground">Jumlah (Rp)
                              <input inputMode="numeric" autoComplete="off" value={payment.amount} placeholder="Contoh: 250.000" className={field}
                                onChange={(event) => setPayment({ ...payment, amount: event.target.value })} />
                              {payment.amount && paymentAmount === null ? (
                                <span className="mt-1 block font-normal text-danger-ink">Hanya angka dan titik ribuan, tanpa koma.</span>
                              ) : null}
                            </label>
                            <label className="text-xs font-semibold text-muted-foreground">Tanggal bayar
                              <input type="date" min={selected.disbursedOn ?? undefined} max={todayInJakarta()} value={payment.paidOn} className={field}
                                onChange={(event) => setPayment({ ...payment, paidOn: event.target.value })} />
                            </label>
                            <label className="text-xs font-semibold text-muted-foreground">Cara
                              <select value={payment.method} className={field}
                                onChange={(event) => setPayment({ ...payment, method: event.target.value as LoanPaymentMethod })}>
                                {(Object.keys(PAYMENT_METHOD_LABELS) as LoanPaymentMethod[]).map((key) => <option key={key} value={key}>{PAYMENT_METHOD_LABELS[key]}</option>)}
                              </select>
                            </label>
                            <label className="text-xs font-semibold text-muted-foreground">No. bukti / periode slip (opsional)
                              <input maxLength={200} value={payment.reference} className={field}
                                onChange={(event) => setPayment({ ...payment, reference: event.target.value })} />
                            </label>
                          </div>
                          <div className="mt-3 flex flex-wrap gap-2">
                            <button type="button" disabled={busy || paymentAmount === null} onClick={() => pay(selected)}
                              className="min-h-11 rounded-xl bg-brand-primary px-3 text-sm font-bold text-brand-foreground disabled:opacity-50">
                              Catat pembayaran
                            </button>
                            <button type="button" disabled={busy}
                              onClick={() => setPayment({ ...payment, amount: String(selected.outstanding) })}
                              className="min-h-11 rounded-xl border border-border px-3 text-sm font-bold text-brand-heading disabled:opacity-50">
                              Isi sisa ({formatRupiah(selected.outstanding)}) untuk pelunasan
                            </button>
                          </div>
                        </div>
                      ) : null}
                      {selected.status === "IN_REVIEW" || selected.status === "APPROVED" ? (
                        <button type="button" disabled={busy} onClick={() => cancel(selected)}
                          className="min-h-11 rounded-xl border border-danger-line px-3 text-sm font-bold text-danger-ink disabled:opacity-50">
                          Batalkan pengajuan
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Pilih pinjaman untuk melihat jadwal cicilan, pembayaran, dan riwayatnya. Pinjaman yang sudah disetujui
                menunggu pencairan oleh Keuangan.
              </p>
            )}
          </section>
        </div>
      )}
    </AdminShell>
  );
}
