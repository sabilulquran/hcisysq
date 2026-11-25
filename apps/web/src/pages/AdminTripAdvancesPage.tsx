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
  getGolonganMap,
  getPerDiemActivation,
  mapGolongan,
  READINESS_LABELS,
  setPerDiemActivation,
  unmapGolongan,
  todayInJakarta,
  TripAdvanceApiError,
  type AdvanceDetail,
  type AdvanceStatus,
  type AdvanceSummary,
  type CurrentRate,
  type Pagination,
  type PerDiemRate,
  type TransactionMethod,
  type WilayahKey,
  type GolonganKey,
  type GolonganMapping,
  type PerDiemActivation,
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
  const [rateForm, setRateForm] = useState({
    golongan: "STAF" as GolonganKey, wilayah: "LUAR_DAERAH" as WilayahKey,
    effectiveFrom: todayInJakarta(), dailyAmount: "", note: "",
  });
  const [golonganMap, setGolonganMap] = useState<GolonganMapping[]>([]);
  const [unmappedCodes, setUnmappedCodes] = useState<Array<{ code: string; name: string }>>([]);
  const [mapForm, setMapForm] = useState({ jobClassificationCode: "", golongan: "STAF" as GolonganKey, note: "" });
  const [activation, setActivation] = useState<PerDiemActivation | null>(null);
  const [activationReason, setActivationReason] = useState("");
  const [organizerPaid, setOrganizerPaid] = useState(false);
  const [waiveReason, setWaiveReason] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
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

  const loadGolonganMap = async () => {
    try {
      const result = await getGolonganMap();
      setGolonganMap(result.items);
      setUnmappedCodes(result.unmapped);
    } catch {
      setGolonganMap([]);
      setUnmappedCodes([]);
    }
  };

  const saveMapping = (event: React.FormEvent) => {
    event.preventDefault();
    const code = mapForm.jobClassificationCode.trim().toUpperCase();
    if (!code) return;
    setBusy(true);
    void mapGolongan({ jobClassificationCode: code, golongan: mapForm.golongan, note: mapForm.note.trim() || null })
      .then(async () => {
        setNotice(`Klasifikasi ${code} dipetakan ke golongan uang saku.`);
        setError(null);
        setMapForm({ jobClassificationCode: "", golongan: "STAF", note: "" });
        await loadGolonganMap();
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Pemetaan golongan tidak dapat disimpan."))
      .finally(() => setBusy(false));
  };

  const removeMapping = (code: string) => {
    if (!window.confirm(`Hapus pemetaan golongan untuk klasifikasi ${code}? Perkiraan uang harian pegawai dengan klasifikasi ini akan terhenti sampai dipetakan lagi.`)) return;
    setBusy(true);
    void unmapGolongan(code)
      .then(async () => { setNotice(`Pemetaan ${code} dihapus.`); setError(null); await loadGolonganMap(); })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Pemetaan golongan tidak dapat dihapus."))
      .finally(() => setBusy(false));
  };

  // D-22: the lock and everything that stands between it and being opened.
  const loadActivation = async () => {
    try {
      setActivation(await getPerDiemActivation());
    } catch {
      setActivation(null);
    }
  };

  const changeActivation = (state: "ACTIVE" | "INACTIVE") => {
    const reason = activationReason.trim();
    if (reason.length < 10) {
      setError("Tulis alasan menyalakan atau mematikan uang saku (10–500 karakter).");
      return;
    }
    setBusy(true);
    void setPerDiemActivation({ state, reason })
      .then(async () => {
        setNotice(state === "ACTIVE"
          ? "Uang saku perjalanan dinas dinyalakan. Pegawai dapat mengajukan uang muka."
          : "Uang saku perjalanan dinas dimatikan. Pengajuan baru ditutup; uang muka yang sudah berjalan tetap dapat diselesaikan.");
        setError(null);
        setActivationReason("");
        await loadActivation();
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Status uang saku tidak dapat diubah."))
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    void getCurrentSession().then(setSession).catch(() => {
      setSession(null);
      setError("Izin akun tidak dapat dibaca, sehingga tombol tindakan disembunyikan. Muat ulang halaman.");
    });
    void loadRates(1);
    void loadGolonganMap();
    void loadActivation();
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
      // D-21: the declaration, the waiver reason and the correction reason belong to THIS advance.
      // Carrying them to the next one would withhold someone else's uang saku on A's grounds.
      setOrganizerPaid(advance.organizerPerDiemDeclared);
      setWaiveReason("");
      setOverrideReason("");
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
      const result = await settleAdvance(advance.id, {
        perDiemDays: days,
        note: settleNote.trim() || null,
        organizerPerDiemPaid: organizerPaid,
        waiveReason: waiveReason.trim() || null,
        organizerOverrideReason: overrideReason.trim() || null,
        idempotencyKey: transactionKey,
      });
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
    void createPerDiemRate({
      golongan: rateForm.golongan, wilayah: rateForm.wilayah, effectiveFrom: rateForm.effectiveFrom,
      dailyAmount: rateAmount, note: rateForm.note.trim() || null,
    })
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

      {activation ? (
        <section className="mb-6 rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
          <h2 className="text-sm font-bold text-brand-heading">Status uang saku perjalanan dinas</h2>
          <p className="text-xs text-muted-foreground">
            Uang saku terkunci sampai dinyalakan, dan hanya dapat dinyalakan bila katalog klasifikasi jabatan,
            pemetaan golongan, dan tarifnya sudah lengkap. Pemeriksaan ini diulang pada setiap penyalaan.
          </p>
          <div className={`mt-3 ${box}`}>
            <p className="text-sm font-bold text-brand-heading">
              {activation.state === "ACTIVE" ? "Aktif" : "Belum aktif (terkunci)"}
            </p>
            {activation.changedAt ? (
              <p className="text-xs text-muted-foreground">
                Diubah {activation.changedAt.slice(0, 10)}
                {activation.changedByName ? ` oleh ${activation.changedByName}` : ""}
                {activation.reason ? ` — ${activation.reason}` : ""}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">Belum pernah dinyalakan sejak fitur ini terpasang.</p>
            )}
          </div>
          {activation.blockers.length > 0 ? (
            <div className={`mt-3 ${box}`}>
              <p className="text-xs font-semibold text-danger-ink">Belum dapat dinyalakan:</p>
              <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                {activation.blockers.map((finding, index) => (
                  <li key={`${finding.kind}-${index}`}>
                    <span className="font-semibold">{READINESS_LABELS[finding.kind] ?? finding.kind}</span>
                    {` — ${finding.detail}`}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {activation.warnings.length > 0 ? (
            <div className={`mt-3 ${box}`}>
              <p className="text-xs font-semibold text-muted-foreground">Peringatan (tidak menahan penyalaan):</p>
              <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                {activation.warnings.map((finding, index) => (
                  <li key={`${finding.kind}-${index}`}>
                    {(READINESS_LABELS[finding.kind] ?? finding.kind)}{` — ${finding.detail}`}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {canManageRates ? (
            <div className="mt-3">
              <label className="text-xs font-semibold text-muted-foreground">Alasan (10–500 karakter)
                <input
                  maxLength={500}
                  value={activationReason}
                  className={field}
                  onChange={(event) => setActivationReason(event.target.value)}
                />
              </label>
              {activation.state === "ACTIVE" ? (
                <button type="button" className={primary} disabled={busy} onClick={() => changeActivation("INACTIVE")}>
                  Matikan uang saku
                </button>
              ) : (
                <button
                  type="button"
                  className={primary}
                  disabled={busy || !activation.ready}
                  onClick={() => changeActivation("ACTIVE")}
                >
                  Nyalakan uang saku
                </button>
              )}
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="mb-6 rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
        <h2 className="text-sm font-bold text-brand-heading">Tarif uang harian</h2>
        <p className="text-xs text-muted-foreground">
          Tarif per hari per orang menurut golongan dan wilayah (SK Yayasan Sabilul Qur’an Nomor 01.111/YSQ/VII/2026, Lampiran 1),
          berversi. Perjalanan memakai tarif yang berlaku pada tanggal berangkat. Tanpa tarif, uang harian tidak dapat dihitung.
        </p>
        <dl className="mt-3 grid grid-cols-2 gap-2 text-sm lg:grid-cols-3">
          {current.map((rate) => (
            <div key={`${rate.golongan}-${rate.wilayah}`} className="rounded-xl border border-border/70 bg-surface px-3 py-2">
              <dt className="text-xs text-muted-foreground">{rate.golonganLabel} · {rate.label}</dt>
              <dd className="font-bold tabular-nums text-brand-heading">
                {rate.dailyAmount === null ? "Belum ditetapkan" : `${formatRupiah(rate.dailyAmount)}/hari`}
              </dd>
              {rate.effectiveFrom ? <dd className="text-2xs text-muted-foreground">berlaku {rate.effectiveFrom}</dd> : null}
            </div>
          ))}
        </dl>
        {canManageRates ? (
          <form onSubmit={saveRate} className="mt-4 grid gap-3 sm:grid-cols-4">
            <label className="text-xs font-semibold text-muted-foreground">Golongan
              <select value={rateForm.golongan} className={field} onChange={(event) => setRateForm({ ...rateForm, golongan: event.target.value as GolonganKey })}>
                {[...new Map(current.map((rate) => [rate.golongan, rate.golonganLabel])).entries()]
                  .map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </label>
            <label className="text-xs font-semibold text-muted-foreground">Wilayah
              <select value={rateForm.wilayah} className={field} onChange={(event) => setRateForm({ ...rateForm, wilayah: event.target.value as WilayahKey })}>
                {[...new Map(current.map((rate) => [rate.wilayah, rate.label])).entries()]
                  .map(([key, label]) => <option key={key} value={key}>{label}</option>)}
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
                <tr><th className="py-1 pr-2">Golongan</th><th className="py-1 pr-2">Wilayah</th><th className="py-1 pr-2">Berlaku mulai</th><th className="py-1 pr-2 text-right">Per hari</th><th className="py-1 pr-2">Dicatat</th><th className="py-1">Catatan</th></tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {rates.map((rate) => (
                  <tr key={rate.id}>
                    <td className="py-1.5 pr-2">{rate.golonganLabel}</td>
                    <td className="py-1.5 pr-2">{rate.wilayahLabel}</td>
                    <td className="py-1.5 pr-2">{rate.effectiveFrom}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{formatRupiah(rate.dailyAmount)}</td>
                    <td className="py-1.5 pr-2 text-xs text-muted-foreground">{rate.createdByName ?? rate.decreeReference ?? "-"}</td>
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

      <section className="mb-6 rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
        <h2 className="text-sm font-bold text-brand-heading">Golongan uang saku per klasifikasi jabatan</h2>
        <p className="text-xs text-muted-foreground">
          Golongan seorang pegawai berasal dari klasifikasi jabatannya (ORG-011), bukan dari teks jabatan. Klasifikasi yang
          belum dipetakan membuat perkiraan uang harian pegawai itu berhenti dengan galat konfigurasi, bukan memakai tarif termurah.
        </p>
        {unmappedCodes.length > 0 ? (
          <p role="status" className="mt-3 rounded-xl border border-border bg-surface px-3 py-2 text-xs text-brand-heading">
            Belum dipetakan: {unmappedCodes.map((row) => row.code).join(", ")}
          </p>
        ) : null}
        {canManageRates ? (
          <form onSubmit={saveMapping} className="mt-4 grid gap-3 sm:grid-cols-4">
            <label className="text-xs font-semibold text-muted-foreground">Kode klasifikasi
              <input required maxLength={48} value={mapForm.jobClassificationCode} className={field}
                onChange={(event) => setMapForm({ ...mapForm, jobClassificationCode: event.target.value.toUpperCase() })} />
            </label>
            <label className="text-xs font-semibold text-muted-foreground">Golongan
              <select value={mapForm.golongan} className={field} onChange={(event) => setMapForm({ ...mapForm, golongan: event.target.value as GolonganKey })}>
                <option value="PIMPINAN">Pimpinan / Yayasan</option>
                <option value="KEPALA_UNIT">Kepala Unit Kerja</option>
                <option value="STAF">Staf</option>
              </select>
            </label>
            <label className="text-xs font-semibold text-muted-foreground">Catatan (opsional)
              <input maxLength={500} value={mapForm.note} className={field} onChange={(event) => setMapForm({ ...mapForm, note: event.target.value })} />
            </label>
            <div className="sm:col-span-4">
              <button type="submit" disabled={busy || !mapForm.jobClassificationCode.trim()} className="min-h-11 rounded-xl bg-brand-primary px-3 text-sm font-bold text-brand-foreground disabled:opacity-50">
                Simpan pemetaan
              </button>
            </div>
          </form>
        ) : null}
        {golonganMap.length > 0 ? (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[32rem] text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr><th className="py-1 pr-2">Kode</th><th className="py-1 pr-2">Klasifikasi</th><th className="py-1 pr-2">Golongan</th><th className="py-1 pr-2">Diubah</th><th className="py-1" /></tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {golonganMap.map((row) => (
                  <tr key={row.jobClassificationCode}>
                    <td className="py-1.5 pr-2 font-semibold">{row.jobClassificationCode}</td>
                    <td className="py-1.5 pr-2 text-xs">{row.classificationName ?? "-"}</td>
                    <td className="py-1.5 pr-2">{row.golonganLabel}</td>
                    <td className="py-1.5 pr-2 text-xs text-muted-foreground">{row.updatedByName ?? "-"}</td>
                    <td className="py-1.5 text-right">
                      {canManageRates ? (
                        <button type="button" disabled={busy} onClick={() => removeMapping(row.jobClassificationCode)} className="text-xs font-bold text-danger-ink disabled:opacity-50">
                          Hapus
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">Belum ada klasifikasi jabatan yang dipetakan ke golongan.</p>
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
                    <span className={`mt-1 block text-2xs font-semibold ${advance.overdue ? "text-danger-ink" : "text-muted-foreground"}`}>
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
                        {" "}Golongan: {selected.settlementPreview.golonganLabel ?? "belum dipetakan"}.
                        {" "}Tarif: {selected.settlementPreview.dailyRate === null ? "belum ditetapkan" : `${formatRupiah(selected.settlementPreview.dailyRate)}/hari`}.
                        {" "}Paling banyak {selected.settlementPreview.maxPerDiemDays} hari.
                      </p>
                      {selected.organizerPerDiemDeclared ? (
                        <p role="status" className="mt-1 rounded-xl border border-border bg-surface px-3 py-2 text-xs text-brand-heading">
                          Pegawai menyatakan sudah menerima uang saku dari penyelenggara untuk penugasan ini. Diktum Keempat SK
                          01.111/YSQ/VII/2026: uang harian tidak dibayar lagi. Isi 0 hari dan tulis alasannya. Bila pernyataan itu
                          keliru, hapus centang di bawah dan tulis alasan koreksinya.
                        </p>
                      ) : null}
                      {selected.settlementNote ? <p className="mt-1 text-xs text-foreground">Catatan pegawai: {selected.settlementNote}</p> : null}
                      <div className="mt-2 grid gap-3 sm:grid-cols-2">
                        <label className="text-xs font-semibold text-muted-foreground">Hari uang harian
                          <input type="number" min={0} max={selected.settlementPreview.maxPerDiemDays} value={perDiemDays} className={field}
                            onChange={(event) => { setPerDiemDays(event.target.value); setTransactionKey(crypto.randomUUID()); }} />
                        </label>
                        <label className="text-xs font-semibold text-muted-foreground">Catatan (wajib bila hari dikurangi)
                          <input maxLength={500} value={settleNote} className={field} onChange={(event) => { setSettleNote(event.target.value); setTransactionKey(crypto.randomUUID()); }} />
                        </label>
                        <label className="flex items-center gap-2 text-xs font-semibold text-muted-foreground sm:col-span-2">
                          <input type="checkbox" checked={organizerPaid}
                            onChange={(event) => { setOrganizerPaid(event.target.checked); setTransactionKey(crypto.randomUUID()); }} />
                          Uang saku sudah diterima dari penyelenggara atau pihak lain (tidak dibayar dua kali)
                        </label>
                        {organizerPaid !== selected.organizerPerDiemDeclared ? (
                          <label className="text-xs font-semibold text-muted-foreground sm:col-span-2">
                            {selected.organizerPerDiemDeclared
                              ? "Alasan mengoreksi pernyataan pegawai (10\u2013500 karakter, wajib)"
                              : "Alasan menetapkan uang saku sudah diterima dari penyelenggara (10\u2013500 karakter, wajib)"}
                            <input maxLength={500} value={overrideReason} className={field}
                              onChange={(event) => { setOverrideReason(event.target.value); setTransactionKey(crypto.randomUUID()); }} />
                          </label>
                        ) : null}
                        <label className="text-xs font-semibold text-muted-foreground sm:col-span-2">
                          Alasan uang harian ditahan atau dikurangi (10–500 karakter, wajib bila ditahan)
                          <input maxLength={500} value={waiveReason} className={field}
                            onChange={(event) => { setWaiveReason(event.target.value); setTransactionKey(crypto.randomUUID()); }} />
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
