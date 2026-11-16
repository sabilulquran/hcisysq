// TRIP-002 Finance/HC surface: the advance register, CSV export, disbursement, settlement,
// top-up and refunds, and the versioned per diem rate table. Spec:
// docs/domain/trip-advance-per-diem.md. The API authorizes every call and computes every amount;
// Finance types only refund amounts, per diem days and rates, as whole rupiah.

import { Download, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { EmployeeSearchField, type PickedEmployee } from "@/components/attendance/workforce/EmployeeSearchField";
import { DetailDialog, useDialogParam } from "@/components/DetailDialog";
import { PaginationBar } from "@/components/PaginationBar";
import { TripAdvanceDetailPanel } from "@/components/tripAdvances/TripAdvanceDetailPanel";
import { AdminShell } from "@/layouts/AdminShell";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import {
  ADVANCE_STATUS_LABELS,
  advanceExportHref,
  advanceStatusLabel,
  createPerDiemRate,
  disburseAdvance,
  formatRupiah,
  getAdminAdvance,
  getAdminAdvances,
  getPerDiemRates,
  parseRupiahInput,
  payTopUp,
  recordRefund,
  rejectAdvance,
  searchAdvanceClaimants,
  settleAdvance,
  todayInJakarta,
  TripAdvanceApiError,
  type AdvanceDetail,
  type AdvanceStatus,
  type AdvanceSummary,
  type CurrentRate,
  type Pagination,
  type PerDiemRate,
  type TransactionMethod,
  type ZoneKey,
} from "@/lib/tripAdvances";
import type { AuthSession } from "@/types/hcis";

const searchPeople = async (q: string) => (await searchAdvanceClaimants(q)).items;
const STATUSES = Object.keys(ADVANCE_STATUS_LABELS) as AdvanceStatus[];

/** ENG-LIST-001-J: page and filters live in the query string. */
function initialFilter() {
  const params = new URLSearchParams(window.location.search);
  const status = params.get("status");
  return {
    page: Math.max(1, Number(params.get("page")) || 1),
    status: (status && (STATUSES as string[]).includes(status) ? status : "") as AdvanceStatus | "",
    overdue: params.get("overdue") === "true",
  };
}

const emptyTransaction = () => ({ paidOn: todayInJakarta(), method: "TRANSFER" as TransactionMethod, reference: "", note: "", amount: "" });

export function AdminTripAdvancesPage() {
  const [initial] = useState(initialFilter);
  const [items, setItems] = useState<AdvanceSummary[]>([]);
  const [paging, setPaging] = useState<Pagination | null>(null);
  const [page, setPage] = useState(initial.page);
  const [status, setStatus] = useState<AdvanceStatus | "">(initial.status);
  const [overdue, setOverdue] = useState(initial.overdue);
  const [employee, setEmployee] = useState<PickedEmployee | null>(null);
  const [from, setFrom] = useState(() => `${todayInJakarta().slice(0, 7)}-01`);
  const [to, setTo] = useState(() => todayInJakarta());
  const [advanceId, openAdvance, closeAdvance] = useDialogParam("uangmuka");
  const [selected, setSelected] = useState<AdvanceDetail | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [transaction, setTransaction] = useState(emptyTransaction);
  // One key per filled-in form, so a retry after a lost response records the money once.
  const [transactionKey, setTransactionKey] = useState(() => crypto.randomUUID());
  const [perDiemDays, setPerDiemDays] = useState("");
  const [settleNote, setSettleNote] = useState("");
  const [rates, setRates] = useState<PerDiemRate[]>([]);
  const [current, setCurrent] = useState<CurrentRate[]>([]);
  const [ratePaging, setRatePaging] = useState<Pagination | null>(null);
  const [ratePage, setRatePage] = useState(1);
  const [rateForm, setRateForm] = useState({ zone: "NATIONAL" as ZoneKey, effectiveFrom: todayInJakarta(), dailyAmount: "", note: "" });
  const canManage = hasPermission(session, "trip_advances.manage");
  const canRead = hasPermission(session, "trip_advances.read");
  const canManageRates = hasPermission(session, "trip_per_diem.manage");

  const load = async () => {
    setLoading(true);
    try {
      const result = await getAdminAdvances({ page, status, employeeId: employee?.id, overdue });
      setItems(result.items);
      setPaging(result.pagination);
      setError(null);
    } catch (cause) {
      if (cause instanceof TripAdvanceApiError && cause.status === 403) setForbidden(true);
      else setError(cause instanceof Error ? cause.message : "Register uang muka tidak dapat dimuat.");
    } finally {
      setLoading(false);
    }
  };

  const loadRates = async (target = ratePage) => {
    try {
      const result = await getPerDiemRates(target);
      setRates(result.items);
      setCurrent(result.current);
      setRatePaging(result.pagination);
    } catch {
      setRates([]);
    }
  };

  useEffect(() => {
    void getCurrentSession().then(setSession).catch(() => {
      setSession(null);
      setError("Izin akun tidak dapat dibaca, sehingga tombol tindakan disembunyikan. Muat ulang halaman.");
    });
    void loadRates(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
    const params = new URLSearchParams(window.location.search);
    params.set("page", String(page));
    if (status) params.set("status", status); else params.delete("status");
    if (overdue) params.set("overdue", "true"); else params.delete("overdue");
    window.history.replaceState(window.history.state, "", `${window.location.pathname}?${params.toString()}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, status, overdue, employee?.id]);

  const open = async (id: string) => {
    try {
      const advance = await getAdminAdvance(id);
      setSelected(advance);
      setTransaction(emptyTransaction());
      setTransactionKey(crypto.randomUUID());
      setPerDiemDays(String(advance.settlementPreview.maxPerDiemDays));
      setSettleNote("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Uang muka tidak dapat dibuka.");
    }
  };

  useEffect(() => {
    setSelected(null);
    if (advanceId) void open(advanceId);
  }, [advanceId]);

  const run = async (action: () => Promise<string>, advance: AdvanceDetail) => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      setNotice(await action());
      await Promise.all([load(), open(advance.id)]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Tindakan belum dapat diselesaikan.");
    } finally {
      setBusy(false);
    }
  };

  const changeTransaction = (patch: Partial<ReturnType<typeof emptyTransaction>>) => {
    setTransaction((value) => ({ ...value, ...patch }));
    // The server replays a key only with identical terms, so any change is a new key.
    setTransactionKey(crypto.randomUUID());
  };

  const transactionInput = () => ({
    paidOn: transaction.paidOn,
    method: transaction.method,
    reference: transaction.reference.trim() || null,
    note: transaction.note.trim() || null,
    idempotencyKey: transactionKey,
  });

  const disburse = (advance: AdvanceDetail) => {
    if (!window.confirm(`Catat pencairan ${formatRupiah(advance.amount)} kepada ${advance.employeeName}?`)) return;
    void run(async () => { await disburseAdvance(advance.id, transactionInput()); return "Pencairan dicatat."; }, advance);
  };

  const settle = (advance: AdvanceDetail) => {
    const days = Number(perDiemDays);
    if (!Number.isInteger(days) || days < 0) return;
    void run(async () => {
      const result = await settleAdvance(advance.id, { perDiemDays: days, note: settleNote.trim() || null, idempotencyKey: transactionKey });
      return `Diselesaikan. Uang harian ${formatRupiah(result.perDiemAmount)}, klaim ${formatRupiah(result.claimsTotal)}, selisih ${formatRupiah(result.settlementBalance)}.`;
    }, advance);
  };

  const topUp = (advance: AdvanceDetail) => {
    if (!window.confirm(`Catat pembayaran kekurangan ${formatRupiah(advance.settlementBalance ?? 0)} kepada ${advance.employeeName}?`)) return;
    void run(async () => { await payTopUp(advance.id, transactionInput()); return "Pembayaran kekurangan dicatat."; }, advance);
  };

  const refundAmount = parseRupiahInput(transaction.amount);
  const refund = (advance: AdvanceDetail) => {
    if (refundAmount === null) return;
    void run(async () => {
      const result = await recordRefund(advance.id, { ...transactionInput(), amount: refundAmount });
      return result.refundOutstanding === 0 ? "Pengembalian lunas; uang muka selesai." : `Pengembalian dicatat. Sisa ${formatRupiah(result.refundOutstanding)}.`;
    }, advance);
  };

  const reject = (advance: AdvanceDetail) => {
    const reason = window.prompt("Alasan penolakan Keuangan (minimal 10 karakter)");
    if (!reason || reason.trim().length < 10) return;
    void run(async () => { await rejectAdvance(advance.id, reason.trim()); return "Uang muka ditolak."; }, advance);
  };

  const rateAmount = rateForm.dailyAmount.trim() === "0" ? 0 : parseRupiahInput(rateForm.dailyAmount);
  const saveRate = (event: React.FormEvent) => {
    event.preventDefault();
    if (rateAmount === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    void createPerDiemRate({ zone: rateForm.zone, effectiveFrom: rateForm.effectiveFrom, dailyAmount: rateAmount, note: rateForm.note.trim() || null })
      .then(async () => {
        setNotice("Tarif baru dicatat.");
        setRateForm({ ...rateForm, dailyAmount: "", note: "" });
        setRatePage(1);
        await loadRates(1);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Tarif tidak dapat dicatat."))
      .finally(() => setBusy(false));
  };

  const field = "mt-1 h-11 w-full rounded-xl border bg-surface px-3 text-sm text-foreground";
  const transactionFields = (withAmount: boolean) => (
    <div className="mt-2 grid gap-3 sm:grid-cols-2">
      {withAmount ? (
        <label className="text-xs font-semibold text-muted-foreground">Nominal diterima (Rp)
          <input inputMode="numeric" autoComplete="off" value={transaction.amount} className={field}
            onChange={(event) => changeTransaction({ amount: event.target.value })} />
        </label>
      ) : null}
      <label className="text-xs font-semibold text-muted-foreground">Tanggal
        <input type="date" max={todayInJakarta()} value={transaction.paidOn} className={field} onChange={(event) => changeTransaction({ paidOn: event.target.value })} />
      </label>
      <label className="text-xs font-semibold text-muted-foreground">Cara
        <select value={transaction.method} className={field} onChange={(event) => changeTransaction({ method: event.target.value as TransactionMethod })}>
          <option value="TRANSFER">Transfer</option>
          <option value="CASH">Tunai</option>
        </select>
      </label>
      <label className="text-xs font-semibold text-muted-foreground">No. bukti (opsional)
        <input maxLength={200} value={transaction.reference} className={field} onChange={(event) => changeTransaction({ reference: event.target.value })} />
      </label>
      <label className="text-xs font-semibold text-muted-foreground">Catatan (opsional)
        <input maxLength={500} value={transaction.note} className={field} onChange={(event) => changeTransaction({ note: event.target.value })} />
      </label>
    </div>
  );
  const box = "rounded-2xl border border-border/70 bg-surface p-3";
  const primary = "mt-3 min-h-11 rounded-xl bg-brand-primary px-3 text-sm font-bold text-brand-foreground disabled:opacity-50";

  return (
    <AdminShell active="services" title="Uang Muka Dinas" description="Register uang muka perjalanan dinas, pertanggungjawaban, dan tarif uang harian.">
      {error && !advanceId ? <div role="alert" className="mb-5 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div> : null}
      {notice && !advanceId ? <div role="status" className="mb-5 rounded-2xl border border-border bg-surface p-4 text-sm text-brand-heading">{notice}</div> : null}

      <section className="mb-6 rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
        <h2 className="text-sm font-bold text-brand-heading">Tarif uang harian</h2>
        <p className="text-xs text-muted-foreground">
          Tarif per hari per zona, berversi. Perjalanan memakai tarif yang berlaku pada tanggal berangkat. Tanpa tarif, uang harian tidak dapat dihitung.
        </p>
        <dl className="mt-3 grid grid-cols-2 gap-2 text-sm lg:grid-cols-4">
          {current.map((rate) => (
            <div key={rate.zone} className="rounded-xl border border-border/70 bg-surface px-3 py-2">
              <dt className="text-xs text-muted-foreground">{rate.label}</dt>
              <dd className="font-bold tabular-nums text-brand-heading">
                {rate.dailyAmount === null ? "Belum ditetapkan" : `${formatRupiah(rate.dailyAmount)}/hari`}
              </dd>
              {rate.effectiveFrom ? <dd className="text-[11px] text-muted-foreground">berlaku {rate.effectiveFrom}</dd> : null}
            </div>
          ))}
        </dl>
        {canManageRates ? (
          <form onSubmit={saveRate} className="mt-4 grid gap-3 sm:grid-cols-4">
            <label className="text-xs font-semibold text-muted-foreground">Zona
              <select value={rateForm.zone} className={field} onChange={(event) => setRateForm({ ...rateForm, zone: event.target.value as ZoneKey })}>
                {current.map((rate) => <option key={rate.zone} value={rate.zone}>{rate.label}</option>)}
              </select>
            </label>
            <label className="text-xs font-semibold text-muted-foreground">Berlaku mulai
              <input type="date" required value={rateForm.effectiveFrom} className={field} onChange={(event) => setRateForm({ ...rateForm, effectiveFrom: event.target.value })} />
            </label>
            <label className="text-xs font-semibold text-muted-foreground">Nominal per hari (Rp)
              <input inputMode="numeric" autoComplete="off" required value={rateForm.dailyAmount} className={field}
                onChange={(event) => setRateForm({ ...rateForm, dailyAmount: event.target.value })} />
            </label>
            <label className="text-xs font-semibold text-muted-foreground">Catatan (opsional)
              <input maxLength={500} value={rateForm.note} className={field} onChange={(event) => setRateForm({ ...rateForm, note: event.target.value })} />
            </label>
            <div className="sm:col-span-4">
              <button type="submit" disabled={busy || rateAmount === null} className="min-h-11 rounded-xl bg-brand-primary px-3 text-sm font-bold text-brand-foreground disabled:opacity-50">
                Catat versi tarif
              </button>
            </div>
          </form>
        ) : null}
        {rates.length > 0 ? (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[32rem] text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr><th className="py-1 pr-2">Zona</th><th className="py-1 pr-2">Berlaku mulai</th><th className="py-1 pr-2 text-right">Per hari</th><th className="py-1 pr-2">Dicatat</th><th className="py-1">Catatan</th></tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {rates.map((rate) => (
                  <tr key={rate.id}>
                    <td className="py-1.5 pr-2">{rate.zoneLabel}</td>
                    <td className="py-1.5 pr-2">{rate.effectiveFrom}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{formatRupiah(rate.dailyAmount)}</td>
                    <td className="py-1.5 pr-2 text-xs text-muted-foreground">{rate.createdByName ?? "-"}</td>
                    <td className="py-1.5 text-xs">{rate.note ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {ratePaging && ratePaging.total > ratePaging.pageSize ? (
              <PaginationBar page={ratePaging.page} pageSize={ratePaging.pageSize} total={ratePaging.total}
                onPageChange={(next) => { setRatePage(next); void loadRates(next); }} />
            ) : null}
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">Belum ada tarif yang dicatat.</p>
        )}
      </section>

      {forbidden || (session && !canRead) ? (
        <p className="rounded-2xl border border-border bg-surface p-4 text-sm text-muted-foreground">Register uang muka hanya untuk Keuangan dan HC.</p>
      ) : (
        <section className="overflow-hidden rounded-3xl border border-border/75 bg-surface-raised shadow-[var(--shadow-soft)]">
          <div className="grid gap-3 p-5 sm:grid-cols-2">
            <label className="text-xs font-semibold text-muted-foreground">Status
              <select value={status} onChange={(event) => { setPage(1); setStatus(event.target.value as AdvanceStatus | ""); }} className={field}>
                <option value="">Semua status</option>
                {STATUSES.map((key) => <option key={key} value={key}>{ADVANCE_STATUS_LABELS[key]}</option>)}
              </select>
            </label>
            <label className="flex items-end gap-2 pb-3 text-sm text-foreground">
              <input type="checkbox" checked={overdue} onChange={(event) => { setPage(1); setOverdue(event.target.checked); }} />
              Hanya yang terlambat dipertanggungjawabkan
            </label>
            <div className="sm:col-span-2">
              <EmployeeSearchField value={employee} onChange={(next) => { setPage(1); setEmployee(next); }}
                search={searchPeople} emptyText="Tidak ada pengaju yang cocok." label="Pengaju" />
            </div>
            <div className="flex flex-wrap items-end gap-2 sm:col-span-2">
              <label className="text-xs font-semibold text-muted-foreground">Diajukan dari
                <input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} className={field} />
              </label>
              <label className="text-xs font-semibold text-muted-foreground">Sampai
                <input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} className={field} />
              </label>
              <a href={advanceExportHref(from, to, status)} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border px-3 text-sm font-bold text-brand-heading">
                <Download className="h-4 w-4" aria-hidden="true" /> Unduh CSV
              </a>
            </div>
          </div>
          {loading ? (
            <div className="flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat register...</div>
          ) : items.length === 0 ? (
            <p className="px-5 py-8 text-sm text-muted-foreground">Tidak ada uang muka pada filter ini.</p>
          ) : (
            <ul className="divide-y divide-border/70 border-t border-border/70">
              {items.map((advance) => (
                <li key={advance.id}>
                  <button type="button" onClick={() => { setNotice(null); openAdvance(advance.id); }}
                    className={`w-full px-5 py-3 text-left hover:bg-muted/50 ${advanceId === advance.id ? "bg-muted/60" : ""}`}>
                    <span className="block font-semibold text-brand-heading">
                      {advance.employeeName} · <span className="tabular-nums">{advance.amount === 0 ? "Hanya uang harian" : formatRupiah(advance.amount)}</span>
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {advance.employeeNumber}{advance.unitName ? ` · ${advance.unitName}` : ""} · {advance.tripDestination} · {advance.tripStartOn} – {advance.tripEndOn}
                    </span>
                    <span className={`mt-1 block text-[11px] font-semibold ${advance.overdue ? "text-danger-ink" : "text-muted-foreground"}`}>
                      {advanceStatusLabel(advance.status)}{advance.overdue ? ` · terlambat sejak ${advance.dueOn}` : ""}
                      {advance.currentApproverName ? ` · menunggu ${advance.currentApproverName}` : ""}
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
      )}

      {advanceId && !forbidden ? (
        <DetailDialog wide title="Detail uang muka" description={selected ? `${selected.employeeName} · ${selected.tripDestination}` : undefined} onClose={closeAdvance}>
          {error ? <div role="alert" className="mb-4 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div> : null}
          {notice ? <div role="status" className="mb-4 rounded-2xl border border-border bg-surface p-4 text-sm text-brand-heading">{notice}</div> : null}
          {selected?.id === advanceId ? (
            <TripAdvanceDetailPanel
              advance={selected}
              actions={canManage ? (
                <div className="w-full space-y-3">
                  {selected.status === "APPROVED" && selected.amount > 0 ? (
                    <div className={box}>
                      <p className="text-sm font-bold text-brand-heading">Cairkan {formatRupiah(selected.amount)}</p>
                      <p className="mt-1 text-xs text-muted-foreground">Di luar slip gaji. Nominalnya selalu uang muka yang disetujui.</p>
                      {transactionFields(false)}
                      <button type="button" disabled={busy} onClick={() => disburse(selected)} className={primary}>Catat pencairan</button>
                    </div>
                  ) : null}
                  {selected.status === "SETTLEMENT_SUBMITTED" ? (
                    <div className={box}>
                      <p className="text-sm font-bold text-brand-heading">Selesaikan pertanggungjawaban</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {selected.settlementPreview.verifiedClaims} klaim terverifikasi diperhitungkan
                        {selected.settlementPreview.pendingClaims > 0 ? `; ${selected.settlementPreview.pendingClaims} klaim belum selesai — verifikasi dulu di Reimbursement` : ""}.
                        {" "}Tarif: {selected.settlementPreview.dailyRate === null ? "belum ditetapkan" : `${formatRupiah(selected.settlementPreview.dailyRate)}/hari`}.
                        {" "}Paling banyak {selected.settlementPreview.maxPerDiemDays} hari.
                      </p>
                      {selected.settlementNote ? <p className="mt-1 text-xs text-foreground">Catatan pegawai: {selected.settlementNote}</p> : null}
                      <div className="mt-2 grid gap-3 sm:grid-cols-2">
                        <label className="text-xs font-semibold text-muted-foreground">Hari uang harian
                          <input type="number" min={0} max={selected.settlementPreview.maxPerDiemDays} value={perDiemDays} className={field}
                            onChange={(event) => setPerDiemDays(event.target.value)} />
                        </label>
                        <label className="text-xs font-semibold text-muted-foreground">Catatan (wajib bila hari dikurangi)
                          <input maxLength={500} value={settleNote} className={field} onChange={(event) => setSettleNote(event.target.value)} />
                        </label>
                      </div>
                      <button type="button" disabled={busy} onClick={() => settle(selected)} className={primary}>Selesaikan</button>
                    </div>
                  ) : null}
                  {selected.status === "AWAITING_TOP_UP" ? (
                    <div className={box}>
                      <p className="text-sm font-bold text-brand-heading">Bayar kekurangan {formatRupiah(selected.settlementBalance ?? 0)}</p>
                      {transactionFields(false)}
                      <button type="button" disabled={busy} onClick={() => topUp(selected)} className={primary}>Catat pembayaran</button>
                    </div>
                  ) : null}
                  {selected.status === "AWAITING_REFUND" ? (
                    <div className={box}>
                      <p className="text-sm font-bold text-brand-heading">Catat pengembalian · sisa {formatRupiah(selected.refundOutstanding)}</p>
                      {transactionFields(true)}
                      <button type="button" disabled={busy || refundAmount === null} onClick={() => refund(selected)} className={primary}>Catat pengembalian</button>
                    </div>
                  ) : null}
                  {selected.status === "APPROVED" ? (
                    <button type="button" disabled={busy} onClick={() => reject(selected)}
                      className="min-h-11 rounded-xl border border-danger-line px-3 text-sm font-bold text-danger-ink disabled:opacity-50">
                      Tolak uang muka
                    </button>
                  ) : null}
                </div>
              ) : undefined}
            />
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat uang muka...</div>
          )}
        </DetailDialog>
      ) : null}
    </AdminShell>
  );
}
