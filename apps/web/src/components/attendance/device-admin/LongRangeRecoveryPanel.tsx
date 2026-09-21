import { CalendarRange, Loader2, RefreshCw, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useDeviceAdmin } from "@/components/attendance/device-admin/DeviceAdminContext";
import { hasPermission } from "@/lib/authorization";
import {
  cancelAdmsRecoveryJob,
  listAdmsRecoveryJobs,
  recoveryProgress,
  recoveryStatusLabel,
  requestAdmsLongRangeRecovery,
  type AdmsRecoveryJob,
} from "@/lib/admsRecovery";

const DAY_MS = 86_400_000;

function fmt(value: string) {
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
  }).format(new Date(value));
}

function statusClass(status: AdmsRecoveryJob["status"]) {
  if (status === "succeeded") return "bg-emerald-50 text-emerald-700";
  if (status === "failed") return "bg-red-50 text-red-700";
  if (status === "cancelled") return "bg-slate-100 text-slate-700";
  return "bg-sky-50 text-sky-700";
}

export function LongRangeRecoveryPanel() {
  const { deviceId, session, sessionResolved } = useDeviceAdmin();
  const canOperate = hasPermission(session, "attendance.devices.operate");
  const [items, setItems] = useState<AdmsRecoveryJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    try {
      const result = await listAdmsRecoveryJobs(deviceId);
      setItems(result.items);
      setError(null);
    } catch (cause) {
      if (!quiet) setError(cause instanceof Error ? cause.message : "Riwayat pemulihan tidak dapat dimuat.");
    } finally {
      if (!quiet) setRefreshing(false);
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    void load(true);
  }, [load]);

  useEffect(() => {
    if (!items.some((item) => item.status === "running")) return;
    const timer = window.setInterval(() => void load(true), 15_000);
    return () => window.clearInterval(timer);
  }, [items, load]);

  const rangePlan = useMemo(() => {
    if (!startAt || !endAt) return null;
    const start = new Date(startAt);
    const end = new Date(endAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    const durationMs = end.getTime() - start.getTime();
    if (durationMs < 0) return { valid: false, reason: "Waktu akhir sebelum waktu mulai.", days: 0, chunks: 0 };
    const days = durationMs / DAY_MS;
    if (durationMs <= 31 * DAY_MS) {
      return { valid: false, reason: "Untuk rentang sampai 31 hari gunakan Ambil ulang transaksi di atas.", days, chunks: 1 };
    }
    if (durationMs > 730 * DAY_MS) {
      return { valid: false, reason: "Satu job dibatasi maksimal 730 hari.", days, chunks: 0 };
    }
    return {
      valid: true,
      reason: null,
      days,
      chunks: Math.ceil((durationMs + 1_000) / (31 * DAY_MS)),
    };
  }, [endAt, startAt]);

  const createJob = useCallback(async () => {
    if (!rangePlan?.valid || !startAt || !endAt) return;
    const start = new Date(startAt);
    const end = new Date(endAt);
    const confirmed = window.confirm(
      `Buat pemulihan ${rangePlan.chunks} chunk untuk periode ${start.toLocaleString("id-ID")} sampai ${end.toLocaleString("id-ID")}?\n\nHCIS hanya akan mengirim DATA QUERY ATTLOG maksimal 31 hari per chunk, satu per satu. Tidak ada USERINFO atau operasi biometrik.`,
    );
    if (!confirmed) return;

    setBusy("create");
    try {
      const result = await requestAdmsLongRangeRecovery(
        deviceId,
        start.toISOString(),
        end.toISOString(),
        31,
      );
      setNotice(
        `Pemulihan periode panjang dibuat: ${result.item.totalChunks} chunk. Command pertama${result.item.firstCommandNumber ? ` C:${result.item.firstCommandNumber}` : ""} akan diproses lebih dulu.`,
      );
      setStartAt("");
      setEndAt("");
      setError(null);
      await load(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pemulihan periode panjang tidak dapat dibuat.");
    } finally {
      setBusy(null);
    }
  }, [deviceId, endAt, load, rangePlan, startAt]);

  const cancelJob = useCallback(async (job: AdmsRecoveryJob) => {
    if (!window.confirm("Batalkan job pemulihan ini? Hanya chunk yang belum dikirim yang dapat dihentikan dengan aman.")) return;
    setBusy(`cancel:${job.id}`);
    try {
      await cancelAdmsRecoveryJob(job.id);
      setNotice("Job pemulihan dibatalkan. Chunk yang belum dikirim tidak akan diteruskan.");
      setError(null);
      await load(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Job pemulihan tidak dapat dibatalkan.");
    } finally {
      setBusy(null);
    }
  }, [load]);

  return (
    <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <CalendarRange className="h-4 w-4 text-brand-primary-deep" aria-hidden="true" />
            <h2 className="text-base font-bold text-brand-heading">Pemulihan periode panjang</h2>
          </div>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
            Untuk rentang lebih dari 31 hari, HCIS memecah permintaan menjadi DATA QUERY ATTLOG yang sudah tervalidasi dan menjalankannya satu per satu. Ini bukan command upload-all baru.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={refreshing}
          className="inline-flex h-9 items-center gap-2 rounded-xl border border-border px-3 text-xs font-semibold hover:bg-surface disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          Muat ulang
        </button>
      </div>

      {canOperate ? <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
        <label className="text-xs font-semibold text-muted-foreground">
          Mulai
          <input
            type="datetime-local"
            value={startAt}
            onChange={(event) => setStartAt(event.target.value)}
            className="mt-1 h-10 w-full rounded-xl border border-border px-3 text-sm text-brand-heading outline-none focus:border-brand-primary"
          />
        </label>
        <label className="text-xs font-semibold text-muted-foreground">
          Selesai
          <input
            type="datetime-local"
            value={endAt}
            onChange={(event) => setEndAt(event.target.value)}
            className="mt-1 h-10 w-full rounded-xl border border-border px-3 text-sm text-brand-heading outline-none focus:border-brand-primary"
          />
        </label>
        <button
          type="button"
          disabled={!rangePlan?.valid || busy !== null}
          onClick={() => void createJob()}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-brand-primary px-4 text-xs font-bold text-white disabled:opacity-50"
        >
          {busy === "create" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Buat job
        </button>
      </div> : sessionResolved ? (
        <div className="mt-4 rounded-xl bg-surface p-3 text-xs leading-5 text-muted-foreground">
          Mode baca saja. Membuat atau membatalkan job pemulihan memerlukan izin operasi perangkat.
        </div>
      ) : null}

      {canOperate && rangePlan ? (
        <div className={`mt-2 text-[11px] ${rangePlan.valid ? "text-sky-700" : "text-muted-foreground"}`}>
          {rangePlan.valid
            ? `Rencana: sekitar ${Math.ceil(rangePlan.days)} hari → ${rangePlan.chunks} chunk, maksimal 31 hari per chunk.`
            : rangePlan.reason}
        </div>
      ) : null}

      {notice ? <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs leading-5 text-emerald-800">{notice}</div> : null}
      {error ? <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs leading-5 text-red-800">{error}</div> : null}

      <div className="mt-5 border-t border-border/70 pt-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">Job terbaru</div>
          <div className="text-[11px] text-muted-foreground">Maks. 730 hari per job · 31 hari per chunk</div>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 rounded-xl bg-surface p-4 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Memuat riwayat pemulihan…
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-4 text-xs text-muted-foreground">
            Belum ada pemulihan periode panjang untuk mesin ini.
          </div>
        ) : (
          <div className="space-y-2">
            {items.slice(0, 6).map((job) => {
              const progress = recoveryProgress(job);
              return (
                <div key={job.id} className="rounded-xl border border-border/70 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-xs font-semibold text-brand-heading">
                        {fmt(job.requestedRangeStart)} — {fmt(job.requestedRangeEnd)}
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        {job.succeededChunks}/{job.totalChunks} chunk selesai
                        {job.activeCommandNumber ? ` · aktif C:${job.activeCommandNumber}` : ""}
                        {job.queuedChunks > 0 ? ` · ${job.queuedChunks} menunggu giliran` : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${statusClass(job.status)}`}>
                        {recoveryStatusLabel(job.status)}
                      </span>
                      {job.status === "running" && canOperate ? (
                        <button
                          type="button"
                          onClick={() => void cancelJob(job)}
                          disabled={busy !== null}
                          className="inline-flex h-8 items-center gap-1 rounded-lg border border-border px-2.5 text-[11px] font-semibold hover:bg-surface disabled:opacity-50"
                        >
                          {busy === `cancel:${job.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <XCircle className="h-3 w-3" />}
                          Batalkan
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface" aria-label={`Progress ${progress}%`}>
                    <div className="h-full rounded-full bg-brand-primary" style={{ width: `${progress}%` }} />
                  </div>
                  {job.failureReason ? <div className="mt-2 text-[11px] font-medium text-red-700">Alasan berhenti: {job.failureReason}</div> : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="mt-4 rounded-xl bg-surface px-3 py-2.5 text-[11px] leading-5 text-muted-foreground">
        Pemulihan ini hanya mengirim fakta ATTLOG. Exact duplicate tetap dideduplikasi server dan tidak ada inferensi terlambat, absen, jam kerja, overtime, cuti, atau payroll.
      </div>
    </section>
  );
}
