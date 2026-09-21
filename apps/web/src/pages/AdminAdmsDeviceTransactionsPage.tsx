import { Download, DownloadCloud, Loader2, RefreshCw, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { PaginationBar } from "@/components/PaginationBar";
import { useDeviceAdmin } from "@/components/attendance/device-admin/DeviceAdminContext";
import { SavedFilterBar } from "@/components/attendance/device-admin/SavedFilterBar";
import {
  listAdmsTransactions,
  requestAdmsAttendanceRange,
  requestAdmsSyncNew,
  type AdmsTransactionItem,
} from "@/lib/admsAdmin";
import { admsTransactionExportUrl } from "@/lib/admsOperations";
import { hasPermission } from "@/lib/authorization";

function fmt(value: string) {
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "Asia/Jakarta",
  }).format(new Date(value));
}

export function AdminAdmsDeviceTransactionsPage() {
  const { deviceId, refresh: refreshDevice, session, sessionResolved } = useDeviceAdmin();
  const canOperate = hasPermission(session, "attendance.devices.operate");
  const canExport = hasPermission(session, "attendance.devices.export");
  const [items, setItems] = useState<AdmsTransactionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");

  const load = useCallback(async () => {
    const result = await listAdmsTransactions(deviceId);
    setItems(result.items);
  }, [deviceId]);

  useEffect(() => {
    setLoading(true);
    void load()
      .then(() => setError(null))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Transaksi mesin tidak dapat dimuat."))
      .finally(() => setLoading(false));
  }, [load]);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([load(), refreshDevice()]);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Transaksi mesin tidak dapat dimuat ulang.");
    } finally {
      setRefreshing(false);
    }
  }, [load, refreshDevice]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("id-ID");
    if (!needle) return items;
    return items.filter((item) =>
      [item.pin, item.employeeName, item.employeeNumber, item.occurredAtRaw]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase("id-ID").includes(needle)),
    );
  }, [items, query]);

  useEffect(() => setPage(1), [query, pageSize]);
  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    if (page > totalPages) setPage(totalPages);
  }, [filtered.length, page, pageSize]);

  const pagedItems = useMemo(
    () => filtered.slice((page - 1) * pageSize, page * pageSize),
    [filtered, page, pageSize],
  );

  const requestLatest = useCallback(async () => {
    setBusy("latest");
    try {
      const result = await requestAdmsSyncNew(deviceId);
      setNotice(`Perintah C:${result.item.commandNumber} untuk meminta transaksi terbaru sudah dibuat. Pantau prosesnya di tab Perintah.`);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Permintaan transaksi terbaru tidak dapat dibuat.");
    } finally {
      setBusy(null);
    }
  }, [deviceId]);

  const requestRecovery = useCallback(async () => {
    if (!rangeStart || !rangeEnd) {
      setError("Waktu mulai dan selesai harus diisi.");
      return;
    }
    const start = new Date(rangeStart);
    const end = new Date(rangeEnd);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
      setError("Rentang waktu tidak valid.");
      return;
    }
    if (end.getTime() - start.getTime() > 31 * 86_400_000) {
      setError("Rentang pengambilan ulang maksimal 31 hari.");
      return;
    }

    setBusy("recovery");
    try {
      const result = await requestAdmsAttendanceRange(deviceId, start.toISOString(), end.toISOString());
      setNotice(`Perintah C:${result.item.commandNumber} untuk mengambil ulang transaksi sudah dibuat. Pantau proses dan hasilnya di tab Perintah.`);
      setRecoveryOpen(false);
      setRangeStart("");
      setRangeEnd("");
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Permintaan pengambilan ulang transaksi tidak dapat dibuat.");
    } finally {
      setBusy(null);
    }
  }, [deviceId, rangeEnd, rangeStart]);

  const applySavedFilter = useCallback((criteria: Record<string, unknown>) => {
    setQuery(typeof criteria.query === "string" ? criteria.query : "");
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
            <h2 className="text-base font-bold text-brand-heading">Transaksi mesin</h2>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
              Menampilkan fakta punch mentah yang sudah tersimpan dari mesin ini. Data di sini tidak menyimpulkan terlambat, absen, jam kerja, overtime, atau payroll.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {canExport ? <a href={admsTransactionExportUrl(deviceId)} className="inline-flex h-9 items-center gap-2 rounded-xl border border-border bg-white px-3 text-xs font-semibold hover:bg-surface"><Download className="h-3.5 w-3.5" /> Export CSV</a> : null}
            {canOperate ? (
              <>
                <button type="button" disabled={busy !== null} onClick={() => void requestLatest()} className="inline-flex h-9 items-center gap-2 rounded-xl border border-border bg-white px-3 text-xs font-semibold hover:bg-surface disabled:opacity-50">
                  {busy === "latest" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <DownloadCloud className="h-3.5 w-3.5" />} Minta transaksi terbaru
                </button>
                <button type="button" disabled={busy !== null} onClick={() => setRecoveryOpen(true)} className="h-9 rounded-xl bg-brand-primary px-3 text-xs font-semibold text-white disabled:opacity-50">Ambil ulang transaksi</button>
              </>
            ) : null}
            <button type="button" onClick={() => void refreshAll()} disabled={refreshing || loading} className="inline-flex h-9 items-center gap-2 rounded-xl border border-border bg-white px-3 text-xs font-semibold hover:bg-surface disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} /> Muat ulang</button>
          </div>
        </div>

        <label className="relative mt-4 block max-w-xl">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cari PIN, nama, nomor pegawai, atau timestamp mentah" className="h-10 w-full rounded-xl border border-border bg-white pl-9 pr-3 text-sm outline-none focus:border-brand-primary" />
        </label>
        <SavedFilterBar deviceId={deviceId} viewKey="transactions" criteria={{ query, pageSize }} onApply={applySavedFilter} canManage={canOperate} />

        {sessionResolved && !canOperate ? <div className="mt-4 rounded-xl bg-surface p-3 text-xs leading-5 text-muted-foreground">Mode baca saja. Permintaan sinkronisasi dan recovery memerlukan izin operasi perangkat.</div> : null}
        {notice ? <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs leading-5 text-emerald-800">{notice}</div> : null}
        {error ? <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs leading-5 text-red-800">{error}</div> : null}
      </section>

      <section className="overflow-hidden rounded-2xl border border-border/70 bg-white shadow-[var(--shadow-soft)]">
        {loading ? (
          <div className="flex min-h-56 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Memuat transaksi…</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">Belum ada transaksi yang cocok.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="border-b border-border/70 bg-surface/70 text-[11px] uppercase tracking-[0.08em] text-muted-foreground"><tr><th className="px-4 py-3 font-bold">Waktu mesin</th><th className="px-4 py-3 font-bold">PIN</th><th className="px-4 py-3 font-bold">Pegawai HCIS</th><th className="px-4 py-3 font-bold">Diterima HCIS</th><th className="px-4 py-3 font-bold">Status</th></tr></thead>
              <tbody className="divide-y divide-border/60">
                {pagedItems.map((item) => (
                  <tr key={item.id} className="hover:bg-surface/40">
                    <td className="px-4 py-4"><div className="font-semibold text-brand-heading">{fmt(item.occurredAt)}</div><div className="mt-1 font-mono text-[11px] text-muted-foreground">{item.occurredAtRaw}</div></td>
                    <td className="px-4 py-4 font-mono text-xs font-bold text-brand-heading">{item.pin}</td>
                    <td className="px-4 py-4">{item.employeeName ? <><div className="font-semibold text-brand-heading">{item.employeeName}</div><div className="mt-1 text-xs text-muted-foreground">{item.employeeNumber ?? "—"}</div></> : <span className="text-xs font-medium text-amber-700">Belum terhubung</span>}</td>
                    <td className="px-4 py-4 text-xs text-muted-foreground">{fmt(item.receivedAt)}</td>
                    <td className="px-4 py-4"><span className="inline-flex rounded-full bg-surface px-2 py-1 text-[11px] font-semibold text-brand-heading">Tersimpan</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <PaginationBar page={page} pageSize={pageSize} total={filtered.length} onPageChange={setPage} onPageSizeChange={(size) => { setPageSize(size); setPage(1); }} />
        <div className="border-t border-border/70 bg-surface/30 px-4 py-3 text-[11px] leading-5 text-muted-foreground">Sumber API tetap membatasi 200 transaksi terbaru yang tersimpan. Pagination hanya mengatur tampilan; export membaca fakta raw durable hingga batas server, dan pengambilan ulang tetap exact-deduped.</div>
      </section>

      {canOperate && recoveryOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4" role="dialog" aria-modal="true" aria-labelledby="recovery-dialog-title">
          <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-4"><div><h3 id="recovery-dialog-title" className="text-base font-bold text-brand-heading">Ambil ulang transaksi</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">HCIS akan meminta mesin ini mengirim ulang transaksi tersimpan untuk rentang waktu yang dipilih. Maksimal 31 hari per permintaan.</p></div><button type="button" onClick={() => setRecoveryOpen(false)} className="rounded-lg p-2 hover:bg-surface" aria-label="Tutup"><X className="h-4 w-4" /></button></div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-semibold text-muted-foreground">Mulai<input type="datetime-local" value={rangeStart} onChange={(event) => setRangeStart(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-border px-3 text-sm text-brand-heading outline-none focus:border-brand-primary" /></label>
              <label className="text-xs font-semibold text-muted-foreground">Selesai<input type="datetime-local" value={rangeEnd} onChange={(event) => setRangeEnd(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-border px-3 text-sm text-brand-heading outline-none focus:border-brand-primary" /></label>
            </div>
            <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setRecoveryOpen(false)} className="h-9 rounded-xl border border-border px-3 text-xs font-semibold">Batal</button><button type="button" disabled={busy !== null || !rangeStart || !rangeEnd} onClick={() => void requestRecovery()} className="inline-flex h-9 items-center gap-2 rounded-xl bg-brand-primary px-3 text-xs font-semibold text-white disabled:opacity-50">{busy === "recovery" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Buat permintaan</button></div>
          </div>
        </div>
      ) : null}
    </div>
  );
}