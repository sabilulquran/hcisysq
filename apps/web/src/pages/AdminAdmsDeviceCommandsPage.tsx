import { Loader2, RefreshCw, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { PaginationBar } from "@/components/PaginationBar";
import { hasPermission } from "@/lib/authorization";
import { useDeviceAdmin } from "@/components/attendance/device-admin/DeviceAdminContext";
import { SavedFilterBar } from "@/components/attendance/device-admin/SavedFilterBar";
import {
  cancelAdmsCommand,
  commandActionLabel,
  commandStatusLabel,
  listAdmsCommands,
  type AdmsCommandItem,
} from "@/lib/admsAdmin";

function fmt(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "Asia/Jakarta",
  }).format(new Date(value));
}

function statusClass(status: string) {
  if (status === "succeeded") return "bg-emerald-50 text-emerald-700";
  if (status === "failed" || status === "expired") return "bg-red-50 text-red-700";
  if (status === "cancelled") return "bg-slate-100 text-slate-600";
  if (status === "delivered" || status === "acknowledged") return "bg-sky-50 text-sky-700";
  return "bg-amber-50 text-amber-800";
}

function outcomeLabel(command: AdmsCommandItem) {
  if (command.status === "succeeded") return "Berhasil";
  if (command.status === "failed") return command.returnCode === null ? "Gagal" : `Gagal · kode ${command.returnCode}`;
  if (command.status === "cancelled") return "Dibatalkan";
  if (command.status === "expired") return "Kedaluwarsa";
  return "Belum selesai";
}

const COMMAND_STATUSES = new Set([
  "all", "queued", "pending", "delivered", "acknowledged", "succeeded", "failed", "cancelled", "expired",
]);

export function AdminAdmsDeviceCommandsPage() {
  const { deviceId, refresh: refreshDevice, session } = useDeviceAdmin();
  const canOperate = hasPermission(session, "attendance.devices.operate");
  const [items, setItems] = useState<AdmsCommandItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [selected, setSelected] = useState<AdmsCommandItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await listAdmsCommands(deviceId);
    setItems(result.items);
  }, [deviceId]);

  useEffect(() => {
    setLoading(true);
    void load()
      .then(() => setError(null))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Riwayat perintah tidak dapat dimuat."))
      .finally(() => setLoading(false));
  }, [load]);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([load(), refreshDevice()]);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Riwayat perintah tidak dapat dimuat ulang.");
    } finally {
      setRefreshing(false);
    }
  }, [load, refreshDevice]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("id-ID");
    return items.filter((item) => {
      if (status !== "all" && item.status !== status) return false;
      if (!needle) return true;
      const action = commandActionLabel(item);
      return [item.commandNumber, action, item.reason, item.status]
        .some((value) => value.toLocaleLowerCase("id-ID").includes(needle));
    });
  }, [items, query, status]);

  useEffect(() => setPage(1), [query, status, pageSize]);
  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    if (page > totalPages) setPage(totalPages);
  }, [filtered.length, page, pageSize]);

  const pagedItems = useMemo(
    () => filtered.slice((page - 1) * pageSize, page * pageSize),
    [filtered, page, pageSize],
  );

  const cancel = useCallback(async (command: AdmsCommandItem) => {
    if (!window.confirm(`Batalkan perintah C:${command.commandNumber} (${commandActionLabel(command)})?`)) return;
    setBusyId(command.id);
    try {
      await cancelAdmsCommand(command.id);
      setNotice(`Perintah C:${command.commandNumber} dibatalkan.`);
      setError(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Perintah tidak dapat dibatalkan.");
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const applySavedFilter = useCallback((criteria: Record<string, unknown>) => {
    setQuery(typeof criteria.query === "string" ? criteria.query : "");
    setStatus(typeof criteria.status === "string" && COMMAND_STATUSES.has(criteria.status) ? criteria.status : "all");
    if (typeof criteria.pageSize === "number" && [10, 25, 50, 100].includes(criteria.pageSize)) {
      setPageSize(criteria.pageSize);
    }
    setPage(1);
  }, []);

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-bold text-brand-heading">Perintah mesin</h2>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">Satu tempat untuk melihat apakah operasi ke mesin masih menunggu, sudah dikirim, selesai, gagal, atau dibatalkan.</p>
          </div>
          <button type="button" onClick={() => void refreshAll()} disabled={refreshing || loading} className="inline-flex h-9 items-center gap-2 rounded-xl border border-border bg-white px-3 text-xs font-semibold hover:bg-surface disabled:opacity-50">
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} /> {refreshing ? "Memuat…" : "Muat ulang"}
          </button>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_13rem]">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cari nomor atau jenis perintah" className="h-10 w-full rounded-xl border border-border bg-white pl-9 pr-3 text-sm outline-none focus:border-brand-primary" />
          </label>
          <select value={status} onChange={(event) => setStatus(event.target.value)} className="h-10 rounded-xl border border-border bg-white px-3 text-sm text-brand-heading" aria-label="Filter status perintah">
            <option value="all">Semua status</option>
            <option value="queued">Menunggu giliran</option>
            <option value="pending">Menunggu mesin</option>
            <option value="delivered">Sudah dikirim</option>
            <option value="acknowledged">Diterima mesin</option>
            <option value="succeeded">Berhasil</option>
            <option value="failed">Gagal</option>
            <option value="cancelled">Dibatalkan</option>
            <option value="expired">Kedaluwarsa</option>
          </select>
        </div>
        <SavedFilterBar deviceId={deviceId} viewKey="commands" criteria={{ query, status, pageSize }} onApply={applySavedFilter} canManage={canOperate} />
        {notice ? <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">{notice}</div> : null}
        {error ? <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs leading-5 text-red-800">{error}</div> : null}
      </section>

      <section className="overflow-hidden rounded-2xl border border-border/70 bg-white shadow-[var(--shadow-soft)]">
        {loading ? (
          <div className="flex min-h-56 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Memuat riwayat perintah…</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">Belum ada perintah yang cocok.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead className="border-b border-border/70 bg-surface/70 text-[11px] uppercase tracking-[0.08em] text-muted-foreground"><tr><th className="px-4 py-3 font-bold">ID</th><th className="px-4 py-3 font-bold">Perintah</th><th className="px-4 py-3 font-bold">Status</th><th className="px-4 py-3 font-bold">Dibuat</th><th className="px-4 py-3 font-bold">Dikirim</th><th className="px-4 py-3 font-bold">Selesai</th><th className="px-4 py-3 font-bold">Hasil</th><th className="px-4 py-3 text-right font-bold">Aksi</th></tr></thead>
              <tbody className="divide-y divide-border/60">
                {pagedItems.map((item) => (
                  <tr key={item.id} className="align-top hover:bg-surface/40">
                    <td className="px-4 py-4 font-mono text-xs font-bold text-brand-heading">C:{item.commandNumber}</td>
                    <td className="px-4 py-4"><div className="font-semibold text-brand-heading">{commandActionLabel(item)}</div>{item.requestedRangeStart && item.requestedRangeEnd ? <div className="mt-1 text-[11px] text-muted-foreground">{fmt(item.requestedRangeStart)} – {fmt(item.requestedRangeEnd)}</div> : null}</td>
                    <td className="px-4 py-4"><span className={`inline-flex rounded-full px-2 py-1 text-[11px] font-semibold ${statusClass(item.status)}`}>{commandStatusLabel(item.status)}</span></td>
                    <td className="px-4 py-4 text-xs text-muted-foreground">{fmt(item.createdAt)}</td>
                    <td className="px-4 py-4 text-xs text-muted-foreground">{fmt(item.deliveredAt)}</td>
                    <td className="px-4 py-4 text-xs text-muted-foreground">{fmt(item.completedAt)}</td>
                    <td className="px-4 py-4 text-xs font-medium text-brand-heading">{outcomeLabel(item)}</td>
                    <td className="px-4 py-4"><div className="flex justify-end gap-2">{item.status === "pending" && canOperate ? <button type="button" disabled={busyId !== null} onClick={() => void cancel(item)} className="h-8 rounded-lg border border-red-200 px-3 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50">{busyId === item.id ? "Membatalkan…" : "Batalkan"}</button> : null}<button type="button" onClick={() => setSelected(item)} className="h-8 rounded-lg border border-border px-3 text-xs font-semibold hover:bg-surface">Detail</button></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <PaginationBar page={page} pageSize={pageSize} total={filtered.length} onPageChange={setPage} onPageSizeChange={(size) => { setPageSize(size); setPage(1); }} />
        <div className="border-t border-border/70 bg-surface/30 px-4 py-3 text-[11px] leading-5 text-muted-foreground">Sumber API membatasi 100 perintah terbaru. Payload protokol mentah tidak diekspos ke browser; halaman ini hanya menampilkan metadata operasional yang aman.</div>
      </section>

      {selected ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4" role="dialog" aria-modal="true" aria-labelledby="command-detail-title">
          <div className="max-h-[88vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-4"><div><div className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Detail operasional</div><h3 id="command-detail-title" className="mt-1 text-base font-bold text-brand-heading">C:{selected.commandNumber} · {commandActionLabel(selected)}</h3></div><button type="button" onClick={() => setSelected(null)} className="rounded-lg p-2 hover:bg-surface" aria-label="Tutup"><X className="h-4 w-4" /></button></div>
            <dl className="mt-5 grid grid-cols-[9rem_minmax(0,1fr)] gap-x-3 gap-y-3 text-xs">
              <dt className="text-muted-foreground">Status</dt><dd className="font-semibold text-brand-heading">{commandStatusLabel(selected.status)}</dd>
              <dt className="text-muted-foreground">Command type</dt><dd className="font-mono text-brand-heading">{selected.commandType}</dd>
              <dt className="text-muted-foreground">Reason</dt><dd className="font-mono text-brand-heading">{selected.reason}</dd>
              <dt className="text-muted-foreground">Attempt</dt><dd className="text-brand-heading">{selected.attemptCount}</dd>
              <dt className="text-muted-foreground">Return code</dt><dd className="font-mono text-brand-heading">{selected.returnCode ?? "—"}</dd>
              {selected.requestedRangeStart && selected.requestedRangeEnd ? <><dt className="text-muted-foreground">Requested range</dt><dd className="text-brand-heading">{fmt(selected.requestedRangeStart)} – {fmt(selected.requestedRangeEnd)}</dd></> : null}
              <dt className="text-muted-foreground">Dibuat</dt><dd className="text-brand-heading">{fmt(selected.createdAt)}</dd>
              <dt className="text-muted-foreground">Dikirim</dt><dd className="text-brand-heading">{fmt(selected.deliveredAt)}</dd>
              <dt className="text-muted-foreground">Diakui</dt><dd className="text-brand-heading">{fmt(selected.acknowledgedAt)}</dd>
              <dt className="text-muted-foreground">Selesai</dt><dd className="text-brand-heading">{fmt(selected.completedAt)}</dd>
              <dt className="text-muted-foreground">Kedaluwarsa</dt><dd className="text-brand-heading">{fmt(selected.expiresAt)}</dd>
            </dl>
          </div>
        </div>
      ) : null}
    </div>
  );
}
