// REIMB-001 Finance/HC surface: the register, summary per category, CSV export, verification,
// rejection and payment. Spec: docs/domain/reimbursement.md. The API authorizes every call and
// computes every total; this page only reads what Finance types as whole rupiah.

import { Download, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";

import { EmployeeSearchField, type PickedEmployee } from "@/components/attendance/workforce/EmployeeSearchField";
import { PaginationBar } from "@/components/PaginationBar";
import { ReimbursementDetailPanel } from "@/components/reimbursements/ReimbursementDetailPanel";
import { AdminShell } from "@/layouts/AdminShell";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import {
  adminReceiptHref,
  CLAIM_STATUS_LABELS,
  claimStatusLabel,
  exportHref,
  formatRupiah,
  getAdminClaim,
  getAdminClaims,
  getClaimSummary,
  monthStart,
  parseRupiahInput,
  payClaim,
  rejectClaimAsFinance,
  ReimbursementApiError,
  searchClaimants,
  todayInJakarta,
  verifyClaim,
  type Category,
  type CategoryKey,
  type ClaimDetail,
  type ClaimStatus,
  type ClaimSummary,
  type ClaimSummaryReport,
  type Pagination,
} from "@/lib/reimbursements";
import type { AuthSession } from "@/types/hcis";

const searchPeople = async (q: string) => (await searchClaimants(q)).items;
const REGISTER_STATUSES = (Object.keys(CLAIM_STATUS_LABELS) as ClaimStatus[]).filter((status) => status !== "DRAFT");
/** ENG-LIST-001-J: page and filters live in the query string, so a refresh or a shared link keeps them. */
function initialFilter() {
  const params = new URLSearchParams(window.location.search);
  const status = params.get("status");
  const category = params.get("category");
  return {
    page: Math.max(1, Number(params.get("page")) || 1),
    status: (status === null ? "APPROVED" : (REGISTER_STATUSES as string[]).includes(status) ? status : "") as ClaimStatus | "",
    category: (category ?? "") as CategoryKey | "",
  };
}

const emptyPayment = () => ({ paidOn: todayInJakarta(), method: "TRANSFER" as "CASH" | "TRANSFER", reference: "", note: "" });

export function AdminReimbursementsPage() {
  const [items, setItems] = useState<ClaimSummary[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [paging, setPaging] = useState<Pagination | null>(null);
  const [initial] = useState(initialFilter);
  const [page, setPage] = useState(initial.page);
  const [status, setStatus] = useState<ClaimStatus | "">(initial.status);
  const [category, setCategory] = useState<CategoryKey | "">(initial.category);
  const [employee, setEmployee] = useState<PickedEmployee | null>(null);
  const [from, setFrom] = useState(() => monthStart(todayInJakarta()));
  const [to, setTo] = useState(() => todayInJakarta());
  const [report, setReport] = useState<ClaimSummaryReport | null>(null);
  const [selected, setSelected] = useState<ClaimDetail | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [approvedAmounts, setApprovedAmounts] = useState<Record<string, string>>({});
  const [verificationNote, setVerificationNote] = useState("");
  const [payment, setPayment] = useState(emptyPayment);
  // One key per filled-in payment form, so a retry after a lost response records it once.
  const [paymentKey, setPaymentKey] = useState(() => crypto.randomUUID());
  // Verifying, rejecting and paying need reimbursements.manage; reading needs reimbursements.read.
  const canManage = hasPermission(session, "reimbursements.manage");

  const load = async () => {
    setLoading(true);
    try {
      // The register has no date window: an older claim approved today must still show (review finding).
      const result = await getAdminClaims({ page, status, category, employeeId: employee?.id });
      setItems(result.items);
      setPaging(result.pagination);
      setCategories(result.categories);
      setError(null);
    } catch (cause) {
      if (cause instanceof ReimbursementApiError && cause.status === 403) setForbidden(true);
      setError(cause instanceof Error ? cause.message : "Register reimbursement tidak dapat dimuat.");
    } finally {
      setLoading(false);
    }
  };

  const loadReport = async () => {
    try {
      setReport(await getClaimSummary(from, to));
    } catch {
      setReport(null);
    }
  };

  useEffect(() => {
    void load();
    const params = new URLSearchParams(window.location.search);
    params.set("page", String(page));
    params.set("status", status);
    if (category) params.set("category", category); else params.delete("category");
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, status, category, employee?.id]);
  useEffect(() => {
    if (from && to) void loadReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);
  useEffect(() => {
    void getCurrentSession().then(setSession).catch(() => {
      setSession(null);
      setError("Izin akun tidak dapat dibaca, sehingga tombol tindakan disembunyikan. Muat ulang halaman.");
    });
  }, []);

  const open = async (id: string) => {
    try {
      const claim = await getAdminClaim(id);
      setSelected(claim);
      setApprovedAmounts(Object.fromEntries(claim.items.map((item) => [item.id, String(item.amount)])));
      setVerificationNote("");
      setPayment(emptyPayment());
      setPaymentKey(crypto.randomUUID());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Klaim tidak dapat dibuka.");
    }
  };

  const run = async (action: () => Promise<string>, claim: ClaimDetail) => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      setNotice(await action());
      await Promise.all([load(), open(claim.id), loadReport()]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Tindakan belum dapat diselesaikan.");
    } finally {
      setBusy(false);
    }
  };

  // "0" is a valid approved amount (an item refused entirely); anything else must parse.
  const approvedValue = (itemId: string) => {
    const text = (approvedAmounts[itemId] ?? "").trim();
    return text === "0" ? 0 : parseRupiahInput(text);
  };
  const verificationReady = selected?.items.every((item) => approvedValue(item.id) !== null) ?? false;

  const verify = (claim: ClaimDetail) => {
    if (!verificationReady) return;
    void run(async () => {
      const result = await verifyClaim(
        claim.id,
        claim.items.map((item) => ({ itemId: item.id, approvedAmount: approvedValue(item.id)! })),
        verificationNote.trim() || null,
      );
      return `Klaim diverifikasi. Disetujui ${formatRupiah(result.verifiedTotal)}.`;
    }, claim);
  };

  const reject = (claim: ClaimDetail) => {
    const reason = window.prompt("Alasan penolakan Keuangan (minimal 10 karakter)");
    if (!reason || reason.trim().length < 10) return;
    void run(async () => {
      await rejectClaimAsFinance(claim.id, reason.trim());
      return "Klaim ditolak.";
    }, claim);
  };

  const pay = (claim: ClaimDetail) => {
    if (!window.confirm(`Catat pembayaran ${formatRupiah(claim.verifiedTotal ?? 0)} kepada ${claim.employeeName}?`)) return;
    void run(async () => {
      await payClaim(claim.id, {
        paidOn: payment.paidOn,
        method: payment.method,
        reference: payment.reference.trim() || null,
        note: payment.note.trim() || null,
        idempotencyKey: paymentKey,
      });
      return "Pembayaran dicatat.";
    }, claim);
  };

  const changePayment = (patch: Partial<ReturnType<typeof emptyPayment>>) => {
    setPayment((current) => ({ ...current, ...patch }));
    // The server replays a key only with identical terms, so any change is a new payment key.
    setPaymentKey(crypto.randomUUID());
  };

  const field = "mt-1 h-11 w-full rounded-xl border bg-surface px-3 text-sm text-foreground";

  return (
    <AdminShell active="services" title="Reimbursement" description="Register klaim, verifikasi bukti, dan pencatatan pembayaran.">
      {error ? <div role="alert" className="mb-5 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div> : null}
      {notice ? <div role="status" className="mb-5 rounded-2xl border border-border bg-surface p-4 text-sm text-brand-heading">{notice}</div> : null}

      {forbidden ? null : (
        <>
          <section className="mb-6 rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-sm font-bold text-brand-heading">Ringkasan per kategori</h2>
                <p className="text-xs text-muted-foreground">Klaim yang dikirim dalam rentang tanggal ini (maks. 366 hari). Unduhan CSV memakai rentang dan filter status yang sama.</p>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-xs font-semibold text-muted-foreground">Diajukan dari
                  <input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} className={field} />
                </label>
                <label className="text-xs font-semibold text-muted-foreground">Sampai
                  <input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} className={field} />
                </label>
                <a href={exportHref(from, to, status)}
                  className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border px-3 text-sm font-bold text-brand-heading">
                  <Download className="h-4 w-4" aria-hidden="true" /> Unduh CSV
                </a>
              </div>
            </div>
            {report && report.byCategory.length > 0 ? (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[28rem] text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr><th className="py-1 pr-2">Kategori</th><th className="py-1 pr-2 text-right">Baris</th><th className="py-1 pr-2 text-right">Diklaim</th><th className="py-1 pr-2 text-right">Disetujui</th><th className="py-1 text-right">Dibayar</th></tr>
                  </thead>
                  <tbody className="divide-y divide-border/70 tabular-nums">
                    {report.byCategory.map((row) => (
                      <tr key={row.category}>
                        <td className="py-1.5 pr-2">{row.label}</td>
                        <td className="py-1.5 pr-2 text-right">{row.items}</td>
                        <td className="py-1.5 pr-2 text-right">{formatRupiah(row.claimedTotal)}</td>
                        <td className="py-1.5 pr-2 text-right">{formatRupiah(row.verifiedTotal)}</td>
                        <td className="py-1.5 text-right">{formatRupiah(row.paidTotal)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">Belum ada klaim dalam rentang ini.</p>
            )}
          </section>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <section className="overflow-hidden rounded-3xl border border-border/75 bg-surface-raised shadow-[var(--shadow-soft)]">
              <div className="grid gap-3 p-5 sm:grid-cols-2">
                <label className="text-xs font-semibold text-muted-foreground">
                  Status
                  <select value={status} onChange={(event) => { setPage(1); setStatus(event.target.value as ClaimStatus | ""); }} className={field}>
                    <option value="">Semua status</option>
                    {REGISTER_STATUSES.map((key) => <option key={key} value={key}>{CLAIM_STATUS_LABELS[key]}</option>)}
                  </select>
                </label>
                <label className="text-xs font-semibold text-muted-foreground">
                  Kategori
                  <select value={category} onChange={(event) => { setPage(1); setCategory(event.target.value as CategoryKey | ""); }} className={field}>
                    <option value="">Semua kategori</option>
                    {categories.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
                  </select>
                </label>
                <div className="sm:col-span-2">
                  <EmployeeSearchField value={employee} onChange={(next) => { setPage(1); setEmployee(next); }}
                    search={searchPeople} emptyText="Tidak ada pengaju yang cocok." label="Pengaju" />
                </div>
              </div>

              {loading ? (
                <div className="flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat register...</div>
              ) : items.length === 0 ? (
                <p className="px-5 py-8 text-sm text-muted-foreground">Tidak ada klaim pada filter ini.</p>
              ) : (
                <ul className="divide-y divide-border/70 border-t border-border/70">
                  {items.map((claim) => (
                    <li key={claim.id}>
                      <button type="button" onClick={() => void open(claim.id)}
                        className={`w-full px-5 py-3 text-left hover:bg-muted/50 ${selected?.id === claim.id ? "bg-muted/60" : ""}`}>
                        <span className="block font-semibold text-brand-heading">{claim.employeeName} · <span className="tabular-nums">{formatRupiah(claim.claimedTotal)}</span></span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {claim.employeeNumber}{claim.unitName ? ` · ${claim.unitName}` : ""} · {claim.title}
                        </span>
                        <span className="mt-1 block text-[11px] font-semibold text-muted-foreground">
                          {claimStatusLabel(claim.status)}
                          {claim.currentApproverName ? ` · menunggu ${claim.currentApproverName}` : ""}
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
                  <ReimbursementDetailPanel
                    claim={selected}
                    receiptHref={(receipt) => adminReceiptHref(selected.id, receipt.id)}
                    itemAction={canManage && selected.status === "APPROVED" ? (itemId) => (
                      <label className="text-xs font-semibold text-muted-foreground">Disetujui (Rp)
                        <input inputMode="numeric" autoComplete="off" value={approvedAmounts[itemId] ?? ""} className={field}
                          onChange={(event) => setApprovedAmounts({ ...approvedAmounts, [itemId]: event.target.value })} />
                        {approvedAmounts[itemId] && approvedValue(itemId) === null ? (
                          <span className="mt-1 block font-normal text-danger-ink">Hanya angka dan titik ribuan, tanpa koma.</span>
                        ) : null}
                      </label>
                    ) : undefined}
                    actions={canManage ? (
                      <div className="w-full space-y-3">
                        {selected.status === "APPROVED" ? (
                          <div className="rounded-2xl border border-border/70 bg-surface p-3">
                            <p className="text-sm font-bold text-brand-heading">Verifikasi</p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              Periksa bukti, lalu isi nominal disetujui per baris di Rincian biaya. Bila ada yang dikurangi, tulis alasannya.
                            </p>
                            <label className="mt-2 block text-xs font-semibold text-muted-foreground">Catatan (wajib bila ada pengurangan)
                              <textarea rows={2} maxLength={500} value={verificationNote} onChange={(event) => setVerificationNote(event.target.value)}
                                className="mt-1 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground" />
                            </label>
                            <button type="button" disabled={busy || !verificationReady} onClick={() => verify(selected)}
                              className="mt-3 min-h-11 rounded-xl bg-brand-primary px-3 text-sm font-bold text-brand-foreground disabled:opacity-50">
                              Verifikasi
                            </button>
                          </div>
                        ) : null}
                        {selected.status === "VERIFIED" ? (
                          <div className="rounded-2xl border border-border/70 bg-surface p-3">
                            <p className="text-sm font-bold text-brand-heading">Catat pembayaran {formatRupiah(selected.verifiedTotal ?? 0)}</p>
                            <p className="mt-1 text-xs text-muted-foreground">Dibayar di luar slip gaji. Nominalnya selalu total yang disetujui.</p>
                            <div className="mt-2 grid gap-3 sm:grid-cols-2">
                              <label className="text-xs font-semibold text-muted-foreground">Tanggal bayar
                                <input type="date" max={todayInJakarta()} value={payment.paidOn} className={field}
                                  onChange={(event) => changePayment({ paidOn: event.target.value })} />
                              </label>
                              <label className="text-xs font-semibold text-muted-foreground">Cara
                                <select value={payment.method} className={field}
                                  onChange={(event) => changePayment({ method: event.target.value as "CASH" | "TRANSFER" })}>
                                  <option value="TRANSFER">Transfer</option>
                                  <option value="CASH">Tunai</option>
                                </select>
                              </label>
                              <label className="text-xs font-semibold text-muted-foreground">No. bukti (opsional)
                                <input maxLength={200} value={payment.reference} className={field}
                                  onChange={(event) => changePayment({ reference: event.target.value })} />
                              </label>
                              <label className="text-xs font-semibold text-muted-foreground">Catatan (opsional)
                                <input maxLength={500} value={payment.note} className={field}
                                  onChange={(event) => changePayment({ note: event.target.value })} />
                              </label>
                            </div>
                            <button type="button" disabled={busy} onClick={() => pay(selected)}
                              className="mt-3 min-h-11 rounded-xl bg-brand-primary px-3 text-sm font-bold text-brand-foreground disabled:opacity-50">
                              Catat pembayaran
                            </button>
                          </div>
                        ) : null}
                        {selected.status === "APPROVED" || selected.status === "VERIFIED" ? (
                          <button type="button" disabled={busy} onClick={() => reject(selected)}
                            className="min-h-11 rounded-xl border border-danger-line px-3 text-sm font-bold text-danger-ink disabled:opacity-50">
                            Tolak klaim
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  />
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Pilih klaim untuk melihat rincian, bukti, persetujuan, dan riwayatnya. Klaim yang sudah disetujui atasan menunggu
                  verifikasi Keuangan.
                </p>
              )}
            </section>
          </div>
        </>
      )}
    </AdminShell>
  );
}
