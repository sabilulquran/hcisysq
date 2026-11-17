// TRIP-002 employee surface: request an advance (or per diem only) for one's own trip, see the
// per diem estimate and approvers, follow disbursement, ask for settlement, see the outcome.
// Spec: docs/domain/trip-advance-per-diem.md. The API owns every rule and amount.

import { Loader2, Plus, Wallet } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { DetailDialog, useDialogParam } from "@/components/DetailDialog";
import { DialogLoading, DialogMessages } from "@/components/DetailDialogParts";
import { PaginationBar } from "@/components/PaginationBar";
import { TripAdvanceDetailPanel } from "@/components/tripAdvances/TripAdvanceDetailPanel";
import { AppShell } from "@/layouts/AppShell";
import { replaceDialogParam } from "@/lib/detailDialogParam";
import { employeeShellUser } from "@/lib/employeeIdentity";
import { getEmployeeLeaveSummary, type EmployeeLeaveSummary } from "@/lib/employeeLeave";
import {
  advanceStatusLabel,
  approverRoleLabel,
  cancelMyAdvance,
  estimateAdvance,
  formatRupiah,
  getAdvanceableTrips,
  getMyAdvance,
  getMyAdvances,
  nextStepHint,
  parseRupiahInput,
  requestAdvance,
  submitSettlement,
  type AdvanceableTrip,
  type AdvanceDetail,
  type AdvanceEstimate,
  type AdvanceSummary,
  type Pagination,
  type Zone,
  type ZoneKey,
} from "@/lib/tripAdvances";

/** `?uangmuka=baru` opens the request form; any other value is an advance id. */
const NEW_ADVANCE = "baru";

export function EmployeeTripAdvancesPage() {
  const [employee, setEmployee] = useState<EmployeeLeaveSummary["employee"] | null>(null);
  const [items, setItems] = useState<AdvanceSummary[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [page, setPage] = useState(() => Math.max(1, Number(new URLSearchParams(window.location.search).get("page")) || 1));
  const [paging, setPaging] = useState<Pagination | null>(null);
  const [param, showAdvance, closeAdvance] = useDialogParam("uangmuka");
  const [selected, setSelected] = useState<AdvanceDetail | null>(null);
  const [trips, setTrips] = useState<AdvanceableTrip[]>([]);
  const [tripPaging, setTripPaging] = useState<Pagination | null>(null);
  const [form, setForm] = useState({ tripId: "", zone: "NATIONAL" as ZoneKey, amount: "", perDiemOnly: false, purpose: "" });
  const [estimate, setEstimate] = useState<AdvanceEstimate | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const user = useMemo(() => employeeShellUser(employee), [employee]);

  const loadList = async (target = page) => {
    const result = await getMyAdvances(target);
    setItems(result.items);
    setPaging(result.pagination);
    setZones(result.zones);
  };

  const loadTrips = async (target: number) => {
    const result = await getAdvanceableTrips(target);
    setTrips((current) => (target === 1 ? result.items : [...current, ...result.items]));
    setTripPaging(result.pagination);
  };

  useEffect(() => {
    void getEmployeeLeaveSummary().then((summary) => setEmployee(summary.employee)).catch(() => undefined);
    void loadList(page)
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Uang muka dinas tidak dapat dimuat."))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setSelected(null);
    if (param === NEW_ADVANCE) {
      setForm({ tripId: "", zone: "NATIONAL", amount: "", perDiemOnly: false, purpose: "" });
      setEstimate(null);
      setIdempotencyKey(crypto.randomUUID());
      void loadTrips(1).catch(() => setTrips([]));
    } else if (param) {
      void getMyAdvance(param).then(setSelected)
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Uang muka tidak dapat dibuka."));
    }
  }, [param]);

  // The estimate follows the picked trip and zone; the API computes it from the rate table.
  useEffect(() => {
    if (param !== NEW_ADVANCE || !form.tripId) {
      setEstimate(null);
      return;
    }
    let current = true;
    void estimateAdvance(form.tripId, form.zone)
      .then((result) => { if (current) setEstimate(result); })
      .catch((cause: unknown) => { if (current) { setEstimate(null); setError(cause instanceof Error ? cause.message : "Perkiraan tidak dapat dihitung."); } });
    return () => { current = false; };
  }, [param, form.tripId, form.zone]);

  const changePage = (next: number) => {
    setPage(next);
    const params = new URLSearchParams(window.location.search);
    params.set("page", String(next));
    window.history.replaceState(window.history.state, "", `${window.location.pathname}?${params.toString()}`);
    void loadList(next).catch((cause) => setError(cause instanceof Error ? cause.message : "Halaman tidak dapat dimuat."));
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

  const amount = form.perDiemOnly ? 0 : parseRupiahInput(form.amount);
  const formValid = Boolean(form.tripId && amount !== null && [...form.purpose.trim()].length >= 10);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!formValid || amount === null) return;
    void run(async () => {
      const created = await requestAdvance({
        businessTripId: form.tripId, zone: form.zone, amount, purpose: form.purpose.trim(), idempotencyKey,
      });
      setNotice("Pengajuan terkirim ke penyetuju perjalanan Anda.");
      setPage(1);
      await loadList(1);
      replaceDialogParam("uangmuka", created.id);
    }, "Pengajuan tidak dapat dikirim.");
  };

  const cancel = (advance: AdvanceDetail) => {
    const reason = window.prompt("Alasan pembatalan (minimal 5 karakter)");
    if (!reason || reason.trim().length < 5) return;
    void run(async () => {
      await cancelMyAdvance(advance.id, reason.trim());
      setNotice("Pengajuan dibatalkan.");
      await Promise.all([loadList(), getMyAdvance(advance.id).then(setSelected)]);
    }, "Pengajuan tidak dapat dibatalkan.");
  };

  const settle = (advance: AdvanceDetail) => {
    if (!window.confirm("Ajukan pertanggungjawaban sekarang? Pastikan semua biaya perjalanan sudah diklaim lewat Reimbursement.")) return;
    void run(async () => {
      await submitSettlement(advance.id, null);
      setNotice("Pertanggungjawaban diajukan. Keuangan akan menghitung uang harian dan klaim Anda.");
      await Promise.all([loadList(), getMyAdvance(advance.id).then(setSelected)]);
    }, "Pertanggungjawaban tidak dapat diajukan.");
  };

  const input = "mt-1.5 min-h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm font-normal text-brand-heading";
  const creating = param === NEW_ADVANCE;

  return (
    <AppShell user={user} activeItem="Uang Muka Dinas">
      <section className="mx-auto max-w-5xl">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand-primary-deep">Keuangan Saya</p>
        <h1 className="mt-1 text-2xl font-bold text-brand-heading sm:text-3xl">Uang Muka Dinas</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Ajukan uang muka untuk perjalanan dinas Anda, atau hanya uang harian. Setelah kembali, klaim biaya nyata lewat
          Reimbursement dengan menautkan perjalanannya, lalu ajukan pertanggungjawaban. Keuangan menghitung uang harian dan
          selisihnya: kekurangan dibayar ke Anda, kelebihan dikembalikan ke Keuangan.
        </p>

        {error && !param ? <div role="alert" className="mt-5 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div> : null}
        {notice && !param ? <div role="status" className="mt-5 rounded-2xl border border-border bg-surface p-4 text-sm text-brand-heading">{notice}</div> : null}

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-bold text-brand-heading">Uang muka saya</h2>
          <button type="button" onClick={() => { setNotice(null); setError(null); showAdvance(NEW_ADVANCE); }}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground shadow-[var(--shadow-button)]">
            <Plus className="h-4 w-4" aria-hidden="true" /> Ajukan uang muka
          </button>
        </div>

        <section className="mt-4 overflow-hidden rounded-3xl border border-border/75 bg-surface-raised shadow-[var(--shadow-soft)]">
          {loading ? (
            <div className="flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat...</div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-5 py-10 text-center text-sm text-muted-foreground">
              <Wallet className="h-6 w-6" aria-hidden="true" />
              Belum ada pengajuan uang muka dinas.
            </div>
          ) : (
            <ul className="divide-y divide-border/70">
              {items.map((advance) => (
                <li key={advance.id}>
                  <button type="button" onClick={() => { setNotice(null); showAdvance(advance.id); }} className="w-full px-5 py-3 text-left hover:bg-muted/50">
                    <span className="block font-semibold text-brand-heading">
                      {advance.tripDestination} · <span className="tabular-nums">{advance.amount === 0 ? "Hanya uang harian" : formatRupiah(advance.amount)}</span>
                    </span>
                    <span className="block text-xs text-muted-foreground">{advance.tripStartOn} – {advance.tripEndOn} · {advance.zoneLabel}</span>
                    <span className={`mt-1 block text-[11px] font-semibold ${advance.overdue ? "text-danger-ink" : "text-muted-foreground"}`}>
                      {advanceStatusLabel(advance.status)}{advance.overdue ? " · terlambat" : ""}
                      {advance.currentApproverName ? ` · menunggu ${advance.currentApproverName}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {paging && paging.total > paging.pageSize ? (
            <PaginationBar page={paging.page} pageSize={paging.pageSize} total={paging.total} onPageChange={changePage} />
          ) : null}
        </section>
      </section>

      {param ? (
        <DetailDialog wide title={creating ? "Ajukan uang muka dinas" : "Detail uang muka"} onClose={closeAdvance}>
          <DialogMessages error={error} notice={notice} />
          {creating ? (
            <form onSubmit={submit} className="space-y-4">
              <label className="block text-xs font-semibold text-muted-foreground">Perjalanan dinas
                <select required value={form.tripId} className={input} onChange={(event) => setForm({ ...form, tripId: event.target.value })}>
                  <option value="">Pilih perjalanan</option>
                  {trips.map((trip) => (
                    <option key={trip.id} value={trip.id}>{trip.destination} · {trip.startOn} – {trip.endOn}</option>
                  ))}
                </select>
                {trips.length === 0 ? (
                  <span className="mt-1 block font-normal">Belum ada perjalanan yang dapat diajukan uang muka. Ajukan perjalanan dinas lebih dulu.</span>
                ) : null}
                {tripPaging && trips.length < tripPaging.total ? (
                  <button type="button" className="mt-1 text-xs font-bold text-brand-primary-deep"
                    onClick={() => void loadTrips(Math.floor(trips.length / tripPaging.pageSize) + 1)}>
                    Tampilkan perjalanan lebih lama
                  </button>
                ) : null}
              </label>
              <label className="block text-xs font-semibold text-muted-foreground">Zona perjalanan
                <select value={form.zone} className={input} onChange={(event) => setForm({ ...form, zone: event.target.value as ZoneKey })}>
                  {zones.map((zone) => <option key={zone.key} value={zone.key}>{zone.label}</option>)}
                </select>
              </label>
              {estimate ? (
                <div className="rounded-2xl border border-border/70 bg-surface p-3 text-sm">
                  <p className="font-semibold text-brand-heading">
                    Perkiraan uang harian: {estimate.dailyRate === null
                      ? "tarif zona ini belum ditetapkan HC/Keuangan"
                      : `${estimate.days} hari × ${formatRupiah(estimate.dailyRate)} = ${formatRupiah(estimate.perDiemEstimate)}`}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Uang muka paling banyak {formatRupiah(estimate.maxAmount)}. Uang harian final dihitung Keuangan saat pertanggungjawaban.
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Penyetuju: {estimate.approvalChain.map((step) => `${step.name} (${approverRoleLabel(step.sources)})`).join(" → ")}
                  </p>
                </div>
              ) : null}
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input type="checkbox" checked={form.perDiemOnly} onChange={(event) => setForm({ ...form, perDiemOnly: event.target.checked })} />
                Hanya uang harian, tanpa uang muka
              </label>
              {!form.perDiemOnly ? (
                <label className="block text-xs font-semibold text-muted-foreground">Nominal uang muka (Rp)
                  <input inputMode="numeric" autoComplete="off" value={form.amount} className={input}
                    onChange={(event) => setForm({ ...form, amount: event.target.value })} />
                  {form.amount && amount === null ? <span className="mt-1 block font-normal text-danger-ink">Hanya angka dan titik ribuan, tanpa koma.</span> : null}
                </label>
              ) : null}
              <label className="block text-xs font-semibold text-muted-foreground">Rincian perkiraan biaya (10–1000 karakter)
                <textarea rows={3} maxLength={1000} value={form.purpose} onChange={(event) => setForm({ ...form, purpose: event.target.value })}
                  className="mt-1.5 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-brand-heading" />
              </label>
              <button type="submit" disabled={busy || !formValid}
                className="min-h-11 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50">
                {busy ? "Mengirim..." : "Kirim pengajuan"}
              </button>
            </form>
          ) : selected?.id === param ? (
            <>
              {nextStepHint(selected) ? <p className="mb-4 rounded-2xl border border-border/70 bg-surface p-3 text-sm text-brand-heading">{nextStepHint(selected)}</p> : null}
              <TripAdvanceDetailPanel
                advance={selected}
                actions={(
                  <>
                    {selected.status === "DISBURSED" || (selected.status === "APPROVED" && selected.amount === 0) ? (
                      <>
                        <a href="/app/reimbursements?claim=baru"
                          className="inline-flex min-h-11 items-center rounded-xl border border-border px-3 text-sm font-bold text-brand-heading">
                          Klaim biaya di Reimbursement
                        </a>
                        <button type="button" disabled={busy} onClick={() => settle(selected)}
                          className="min-h-11 rounded-xl bg-brand-primary px-3 text-sm font-bold text-brand-foreground disabled:opacity-50">
                          Ajukan pertanggungjawaban
                        </button>
                      </>
                    ) : null}
                    {selected.status === "IN_REVIEW" || selected.status === "APPROVED" ? (
                      <button type="button" disabled={busy} onClick={() => cancel(selected)}
                        className="min-h-11 rounded-xl border border-danger-line px-3 text-sm font-bold text-danger-ink disabled:opacity-50">
                        Batalkan pengajuan
                      </button>
                    ) : null}
                  </>
                )}
              />
            </>
          ) : error ? null : <DialogLoading />}
        </DetailDialog>
      ) : null}
    </AppShell>
  );
}
