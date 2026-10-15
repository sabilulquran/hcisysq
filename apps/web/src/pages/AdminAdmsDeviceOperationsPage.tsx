import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileUp,
  Loader2,
  MessageSquareText,
  RefreshCw,
  Search,
  ShieldAlert,
  Tags,
  Trash2,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { PaginationBar } from "@/components/PaginationBar";
import { useDeviceAdmin } from "@/components/attendance/device-admin/DeviceAdminContext";
import { listEmployees, type AdminEmployeeListItem } from "@/lib/adminEmployees";
import {
  admsTransactionExportUrl,
  clearAdmsPendingCommands,
  createAdmsDeviceMessage,
  getAdmsOperations,
  importAdmsOfflineAttlog,
  listAdmsDeviceMessages,
  listAdmsOfflineImports,
  listAdmsWorkCodes,
  saveAdmsWorkCode,
  setAdmsDeviceMessageTarget,
  setAdmsWorkCodeTarget,
  type AdmsDeviceMessageItem,
  type AdmsOfflineImportItem,
  type AdmsOperationsSummary,
  type AdmsWorkCodeItem,
  type OperationsCapabilityState,
} from "@/lib/admsOperations";

const PAGE_SIZE = 8;

function stateLabel(state: string) {
  if (state === "available") return "Siap digunakan";
  if (state === "not_verified") return "Perlu pengujian perangkat";
  return "Belum dapat digunakan";
}

function stateClass(state: string) {
  if (state === "available") return "bg-emerald-50 text-emerald-700";
  if (state === "not_verified") return "bg-slate-100 text-slate-700";
  return "bg-amber-50 text-amber-800";
}

function deliveryLabel(state: AdmsWorkCodeItem["deliveryState"]) {
  if (state === "pending") return "Menunggu dikirim ke mesin";
  if (state === "succeeded") return "Sudah ada di mesin";
  if (state === "failed") return "Gagal dikirim";
  return "Belum dikirim ke mesin";
}

function fmt(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
  }).format(new Date(value));
}

/**
 * `data` is the operator-facing Data Mesin tab (ATT-012 §4): only Kode kegiatan and Pesan,
 * in user language. `technical` adds offline import, pending-queue cleanup, and the
 * capability evidence used by Diagnostik teknis.
 */
export function AdminAdmsDeviceOperationsPage({ mode = "technical" }: { mode?: "data" | "technical" }) {
  const technical = mode === "technical";
  const { deviceId } = useDeviceAdmin();
  const [summary, setSummary] = useState<AdmsOperationsSummary | null>(null);
  const [workCodes, setWorkCodes] = useState<AdmsWorkCodeItem[]>([]);
  const [messages, setMessages] = useState<AdmsDeviceMessageItem[]>([]);
  const [imports, setImports] = useState<AdmsOfflineImportItem[]>([]);
  const [workDeliveryCapability, setWorkDeliveryCapability] = useState<OperationsCapabilityState>("not_verified");
  const [workDeliveryNote, setWorkDeliveryNote] = useState("");
  const [messageDeliveryCapability, setMessageDeliveryCapability] = useState<OperationsCapabilityState>("not_verified");
  const [messageDeliveryNote, setMessageDeliveryNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [workCode, setWorkCode] = useState("");
  const [workCodeName, setWorkCodeName] = useState("");
  const [messageAudience, setMessageAudience] = useState<"public" | "private">("public");
  const [messageTitle, setMessageTitle] = useState("");
  const [messageText, setMessageText] = useState("");
  const [employeeQuery, setEmployeeQuery] = useState("");
  const [employeeResults, setEmployeeResults] = useState<AdminEmployeeListItem[]>([]);
  const [selectedEmployee, setSelectedEmployee] = useState<AdminEmployeeListItem | null>(null);
  const [employeeLoading, setEmployeeLoading] = useState(false);
  const [offlineFile, setOfflineFile] = useState<File | null>(null);
  const [workPage, setWorkPage] = useState(1);
  const [messagePage, setMessagePage] = useState(1);

  const load = useCallback(async () => {
    const [nextSummary, nextWorkCodes, nextMessages, nextImports] = await Promise.all([
      getAdmsOperations(deviceId),
      listAdmsWorkCodes(deviceId),
      listAdmsDeviceMessages(deviceId),
      listAdmsOfflineImports(deviceId),
    ]);
    setSummary(nextSummary);
    setWorkCodes(nextWorkCodes.items);
    setWorkDeliveryCapability(nextWorkCodes.deliveryCapability);
    setWorkDeliveryNote(nextWorkCodes.note);
    setMessages(nextMessages.items);
    setMessageDeliveryCapability(nextMessages.deliveryCapability);
    setMessageDeliveryNote(nextMessages.note);
    setImports(nextImports.items);
  }, [deviceId]);

  useEffect(() => {
    setLoading(true);
    void load()
      .then(() => setError(null))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Workspace operasional tidak dapat dimuat."))
      .finally(() => setLoading(false));
  }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Workspace operasional tidak dapat dimuat ulang.");
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const workTotalPages = Math.max(1, Math.ceil(workCodes.length / PAGE_SIZE));
  const messageTotalPages = Math.max(1, Math.ceil(messages.length / PAGE_SIZE));
  const visibleWorkCodes = useMemo(
    () => workCodes.slice((workPage - 1) * PAGE_SIZE, workPage * PAGE_SIZE),
    [workCodes, workPage],
  );
  const visibleMessages = useMemo(
    () => messages.slice((messagePage - 1) * PAGE_SIZE, messagePage * PAGE_SIZE),
    [messages, messagePage],
  );

  useEffect(() => setWorkPage((page) => Math.min(page, workTotalPages)), [workTotalPages]);
  useEffect(() => setMessagePage((page) => Math.min(page, messageTotalPages)), [messageTotalPages]);

  const submitWorkCode = useCallback(async () => {
    if (!workCode.trim() || !workCodeName.trim()) return;
    setBusy("work-code");
    try {
      await saveAdmsWorkCode({ code: workCode.trim(), name: workCodeName.trim() });
      setWorkCode("");
      setWorkCodeName("");
      setNotice("Kode kegiatan tersimpan di HCIS. Belum ada perubahan yang dikirim ke mesin.");
      setError(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Kode kegiatan tidak dapat disimpan.");
    } finally {
      setBusy(null);
    }
  }, [load, workCode, workCodeName]);

  const updateWorkTarget = useCallback(async (item: AdmsWorkCodeItem, desiredState: "present" | "absent") => {
    setBusy(`work-target:${item.id}`);
    try {
      await setAdmsWorkCodeTarget(deviceId, item.id, desiredState);
      setNotice(`Status rencana ${item.code} diperbarui. Perubahan belum dikirim ke mesin karena fitur perangkat belum siap digunakan.`);
      setError(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Status rencana kode kegiatan tidak dapat diperbarui.");
    } finally {
      setBusy(null);
    }
  }, [deviceId, load]);

  const searchEmployees = useCallback(async () => {
    if (!employeeQuery.trim()) return;
    setEmployeeLoading(true);
    try {
      const result = await listEmployees({ q: employeeQuery.trim(), status: "active", page: 1, pageSize: 10 });
      setEmployeeResults(result.items);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pegawai tidak dapat dicari.");
    } finally {
      setEmployeeLoading(false);
    }
  }, [employeeQuery]);

  const submitMessage = useCallback(async () => {
    if (!messageTitle.trim() || !messageText.trim()) return;
    if (messageAudience === "private" && !selectedEmployee) {
      setError("Pilih pegawai aktif untuk pesan private.");
      return;
    }
    setBusy("message");
    try {
      await createAdmsDeviceMessage({
        audience: messageAudience,
        employeeId: messageAudience === "private" ? selectedEmployee?.id : null,
        title: messageTitle.trim(),
        messageText: messageText.trim(),
      });
      setMessageTitle("");
      setMessageText("");
      setSelectedEmployee(null);
      setEmployeeQuery("");
      setEmployeeResults([]);
      setNotice("Pesan tersimpan di HCIS. Belum ada perubahan yang dikirim ke mesin.");
      setError(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pesan tidak dapat disimpan.");
    } finally {
      setBusy(null);
    }
  }, [load, messageAudience, messageText, messageTitle, selectedEmployee]);

  const updateMessageTarget = useCallback(async (item: AdmsDeviceMessageItem, desiredState: "present" | "absent") => {
    setBusy(`message-target:${item.id}`);
    try {
      await setAdmsDeviceMessageTarget(deviceId, item.id, desiredState);
      setNotice(`Status rencana pesan "${item.title}" diperbarui. Perubahan belum dikirim ke mesin karena fitur perangkat belum siap digunakan.`);
      setError(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Target pesan tidak dapat diperbarui.");
    } finally {
      setBusy(null);
    }
  }, [deviceId, load]);

  const clearPending = useCallback(async () => {
    if (!window.confirm("Batalkan hanya command yang masih pending dan belum pernah delivered? Command delivered/acknowledged tidak akan disentuh.")) return;
    setBusy("clear-pending");
    try {
      const result = await clearAdmsPendingCommands(deviceId);
      setNotice(`${result.cancelledCount} command pending dibatalkan. Command delivered/acknowledged tetap utuh.`);
      setError(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Command pending tidak dapat dibersihkan.");
    } finally {
      setBusy(null);
    }
  }, [deviceId, load]);

  const importOffline = useCallback(async () => {
    if (!offlineFile) return;
    if (!window.confirm(`Import ${offlineFile.name} sebagai ATTLOG offline? File diproses sebagai fakta raw dengan parser/dedupe HCIS dan tidak mengirim command ke mesin.`)) return;
    setBusy("offline-import");
    try {
      const result = await importAdmsOfflineAttlog(deviceId, offlineFile);
      setNotice(`Import selesai: ${result.item.insertedEventCount} fakta baru, ${result.item.duplicateEventCount} duplikat, ${result.item.quarantineCount} quarantine. Device command: 0.`);
      setOfflineFile(null);
      setError(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "ATTLOG offline tidak dapat diimport.");
    } finally {
      setBusy(null);
    }
  }, [deviceId, load, offlineFile]);

  if (loading) {
    return <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Memuat data mesin…</div>;
  }

  const blockedHardware = summary?.capabilities.filter((item) => item.execution === "blocked") ?? [];

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Wrench className="h-5 w-5 text-brand-primary" />
              <h2 className="text-base font-bold text-brand-heading">{technical ? "Operasional WDMS" : "Data Mesin"}</h2>
            </div>
            <p className="mt-1 max-w-4xl text-xs leading-5 text-muted-foreground">
              {technical
                ? "Operasi HCIS-side dan device-side tetap typed tanpa arbitrary command. Status hardware berasal dari physical capability evidence per mesin; capability yang belum verified tetap fail-closed."
                : "Kelola kode kegiatan dan pesan yang direncanakan untuk mesin. Perubahan hanya dikirim saat mesin sudah siap digunakan; HCIS tetap menyimpan status pengiriman secara aman."}
            </p>
          </div>
          <button type="button" onClick={() => void refresh()} disabled={refreshing} className="inline-flex h-9 items-center gap-2 rounded-xl border border-border px-3 text-xs font-semibold disabled:opacity-50">
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} /> Muat ulang
          </button>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl bg-surface p-3"><div className="text-[11px] text-muted-foreground">Tindakan menunggu</div><div className="mt-1 text-xl font-bold text-brand-heading">{summary?.pendingCommandCount ?? 0}</div></div>
          {technical
            ? <div className="rounded-xl bg-surface p-3"><div className="text-[11px] text-muted-foreground">Import offline</div><div className="mt-1 text-xl font-bold text-brand-heading">{imports.length}</div></div>
            : <div className="rounded-xl bg-surface p-3"><div className="text-[11px] text-muted-foreground">Pesan</div><div className="mt-1 text-xl font-bold text-brand-heading">{messages.length}</div></div>}
          <div className="rounded-xl bg-surface p-3"><div className="text-[11px] text-muted-foreground">Kode kegiatan</div><div className="mt-1 text-xl font-bold text-brand-heading">{workCodes.length}</div></div>
          <div className="rounded-xl bg-amber-50 p-3"><div className="text-[11px] text-amber-800">Perlu pengujian perangkat</div><div className="mt-1 text-xl font-bold text-amber-950">{blockedHardware.length}</div></div>
        </div>
        {notice ? <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs leading-5 text-emerald-800">{notice}</div> : null}
        {error ? <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs leading-5 text-red-800">{error}</div> : null}
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
          <div className="flex items-center gap-2"><Tags className="h-4 w-4 text-brand-primary" /><h3 className="text-sm font-bold text-brand-heading">Kode kegiatan</h3></div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs leading-5 text-muted-foreground"><span>{workDeliveryNote}</span><span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${stateClass(workDeliveryCapability)}`}>{stateLabel(workDeliveryCapability)}</span></div>
          <div className="mt-4 grid gap-2 sm:grid-cols-[8rem_minmax(0,1fr)_auto]">
            <input value={workCode} onChange={(event) => setWorkCode(event.target.value.replace(/[^0-9A-Za-z._-]/g, ""))} placeholder="Kode" className="h-9 rounded-xl border border-border px-3 text-sm" />
            <input value={workCodeName} onChange={(event) => setWorkCodeName(event.target.value)} placeholder="Nama kegiatan" className="h-9 rounded-xl border border-border px-3 text-sm" />
            <button type="button" onClick={() => void submitWorkCode()} disabled={busy !== null || !workCode || !workCodeName.trim()} className="h-9 rounded-xl bg-brand-primary px-3 text-xs font-semibold text-white disabled:opacity-50">Simpan</button>
          </div>
          <div className="mt-4 space-y-2">
            {visibleWorkCodes.map((item) => (
              <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 p-3">
                <div><div className="font-mono text-xs font-bold text-brand-heading">{item.code}</div><div className="mt-1 text-xs text-muted-foreground">{item.name} · {deliveryLabel(item.deliveryState)}</div></div>
                <div className="flex gap-2">
                  <button type="button" disabled={busy !== null} onClick={() => void updateWorkTarget(item, "present")} className="h-8 rounded-lg border border-border px-2 text-[11px] font-semibold disabled:opacity-50">Pasang di mesin</button>
                  <button type="button" disabled={busy !== null} onClick={() => void updateWorkTarget(item, "absent")} className="h-8 rounded-lg border border-border px-2 text-[11px] font-semibold disabled:opacity-50">Hapus dari mesin</button>
                </div>
              </div>
            ))}
            {workCodes.length === 0 ? <div className="rounded-xl border border-dashed border-border p-4 text-xs text-muted-foreground">Belum ada kode kegiatan.</div> : null}
          </div>
          {workCodes.length > PAGE_SIZE ? <PaginationBar page={workPage} pageSize={PAGE_SIZE} total={workCodes.length} onPageChange={setWorkPage} /> : null}
        </section>

        <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
          <div className="flex items-center gap-2"><MessageSquareText className="h-4 w-4 text-brand-primary" /><h3 className="text-sm font-bold text-brand-heading">Pesan perangkat</h3></div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs leading-5 text-muted-foreground"><span>{messageDeliveryNote}</span><span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${stateClass(messageDeliveryCapability)}`}>{stateLabel(messageDeliveryCapability)}</span></div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <select value={messageAudience} onChange={(event) => { setMessageAudience(event.target.value as "public" | "private"); setSelectedEmployee(null); }} className="h-9 rounded-xl border border-border px-3 text-sm"><option value="public">Untuk semua pengguna</option><option value="private">Untuk pegawai tertentu</option></select>
            <input value={messageTitle} onChange={(event) => setMessageTitle(event.target.value)} placeholder="Judul" className="h-9 rounded-xl border border-border px-3 text-sm" />
          </div>
          {messageAudience === "private" ? (
            <div className="mt-2">
              {selectedEmployee ? (
                <div className="flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs"><span><strong>{selectedEmployee.fullName}</strong> · {selectedEmployee.employeeNumber}</span><button type="button" onClick={() => setSelectedEmployee(null)} className="font-semibold text-red-700">Ganti</button></div>
              ) : (
                <>
                  <div className="flex gap-2"><input value={employeeQuery} onChange={(event) => setEmployeeQuery(event.target.value)} placeholder="Cari pegawai aktif" className="h-9 min-w-0 flex-1 rounded-xl border border-border px-3 text-sm" /><button type="button" onClick={() => void searchEmployees()} disabled={employeeLoading || !employeeQuery.trim()} className="inline-flex h-9 items-center gap-1 rounded-xl border border-border px-3 text-xs font-semibold disabled:opacity-50">{employeeLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />} Cari</button></div>
                  {employeeResults.length ? <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">{employeeResults.map((employee) => <button key={employee.id} type="button" onClick={() => { setSelectedEmployee(employee); setEmployeeResults([]); }} className="block w-full rounded-lg border border-border/70 p-2 text-left text-xs hover:bg-surface"><strong>{employee.fullName}</strong> · {employee.employeeNumber}</button>)}</div> : null}
                </>
              )}
            </div>
          ) : null}
          <textarea value={messageText} onChange={(event) => setMessageText(event.target.value)} maxLength={500} placeholder="Isi pesan" rows={3} className="mt-2 w-full rounded-xl border border-border p-3 text-sm" />
          <div className="mt-2 flex justify-end"><button type="button" onClick={() => void submitMessage()} disabled={busy !== null || !messageTitle.trim() || !messageText.trim()} className="h-9 rounded-xl bg-brand-primary px-3 text-xs font-semibold text-white disabled:opacity-50">Simpan pesan HCIS</button></div>
          <div className="mt-4 space-y-2">
            {visibleMessages.map((item) => (
              <div key={item.id} className="rounded-xl border border-border/70 p-3">
                <div className="flex items-start justify-between gap-3"><div><div className="text-xs font-bold text-brand-heading">{item.title}</div><div className="mt-1 text-[11px] text-muted-foreground">{item.audience === "private" ? `Untuk ${item.employeeName ?? "pegawai tertentu"}` : "Untuk semua pengguna"} · {deliveryLabel(item.deliveryState)}</div></div><span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-semibold text-slate-700">Tersimpan di HCIS</span></div>
                <p className="mt-2 text-xs leading-5 text-brand-body">{item.messageText}</p>
                <div className="mt-2 flex gap-2"><button type="button" disabled={busy !== null} onClick={() => void updateMessageTarget(item, "present")} className="h-8 rounded-lg border border-border px-2 text-[11px] font-semibold">Tampilkan di mesin</button><button type="button" disabled={busy !== null} onClick={() => void updateMessageTarget(item, "absent")} className="h-8 rounded-lg border border-border px-2 text-[11px] font-semibold">Hapus dari mesin</button></div>
              </div>
            ))}
            {messages.length === 0 ? <div className="rounded-xl border border-dashed border-border p-4 text-xs text-muted-foreground">Belum ada pesan perangkat.</div> : null}
          </div>
          {messages.length > PAGE_SIZE ? <PaginationBar page={messagePage} pageSize={PAGE_SIZE} total={messages.length} onPageChange={setMessagePage} /> : null}
        </section>
      </div>

      {technical ? (
      <>
      <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
        <h3 className="text-sm font-bold text-brand-heading">Transfer data & maintenance aman</h3>
        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          <div className="rounded-xl border border-border/70 p-4"><Download className="h-4 w-4 text-brand-primary" /><div className="mt-2 text-xs font-bold text-brand-heading">Export transaksi CSV</div><p className="mt-1 text-[11px] leading-5 text-muted-foreground">Mengekspor fakta raw durable. Tidak menghitung terlambat, jam kerja, overtime, atau payroll.</p><a href={admsTransactionExportUrl(deviceId)} className="mt-3 inline-flex h-8 items-center rounded-lg border border-border px-3 text-xs font-semibold">Download CSV</a></div>
          <div className="rounded-xl border border-border/70 p-4"><FileUp className="h-4 w-4 text-brand-primary" /><div className="mt-2 text-xs font-bold text-brand-heading">Import ATTLOG offline</div><p className="mt-1 text-[11px] leading-5 text-muted-foreground">Fallback file ≤512 KiB. Parser, dedupe, quarantine, provenance, dan manual-attendance protection tetap sama. Device command = 0.</p><input type="file" accept=".txt,.dat,.log,text/plain" onChange={(event) => setOfflineFile(event.target.files?.[0] ?? null)} className="mt-3 block w-full text-xs" /><button type="button" onClick={() => void importOffline()} disabled={!offlineFile || busy !== null} className="mt-2 h-8 rounded-lg bg-brand-primary px-3 text-xs font-semibold text-white disabled:opacity-50">Import file</button></div>
          <div className="rounded-xl border border-border/70 p-4"><Trash2 className="h-4 w-4 text-brand-primary" /><div className="mt-2 text-xs font-bold text-brand-heading">Bersihkan queue pending</div><p className="mt-1 text-[11px] leading-5 text-muted-foreground">Hanya command berstatus pending yang belum pernah delivered. Delivered/acknowledged tidak disentuh.</p><button type="button" onClick={() => void clearPending()} disabled={busy !== null || (summary?.pendingCommandCount ?? 0) === 0} className="mt-3 h-8 rounded-lg border border-border px-3 text-xs font-semibold disabled:opacity-50">Batalkan {summary?.pendingCommandCount ?? 0} pending</button></div>
        </div>
        {imports.length ? <div className="mt-4"><div className="text-xs font-bold text-brand-heading">Import terakhir</div><div className="mt-2 overflow-x-auto"><table className="w-full min-w-[640px] text-left text-xs"><thead className="bg-surface text-[10px] uppercase text-muted-foreground"><tr><th className="px-3 py-2">File</th><th className="px-3 py-2">Waktu</th><th className="px-3 py-2">Baru</th><th className="px-3 py-2">Duplikat</th><th className="px-3 py-2">Quarantine</th></tr></thead><tbody className="divide-y divide-border/60">{imports.slice(0, 8).map((item) => <tr key={item.id}><td className="px-3 py-2 font-medium">{item.sourceFilename}</td><td className="px-3 py-2">{fmt(item.createdAt)}</td><td className="px-3 py-2">{item.insertedEventCount}</td><td className="px-3 py-2">{item.duplicateEventCount}</td><td className="px-3 py-2">{item.quarantineCount}</td></tr>)}</tbody></table></div></div> : null}
      </section>

      <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
        <div className="flex items-start gap-3"><ShieldAlert className="mt-0.5 h-5 w-5 text-amber-600" /><div><h3 className="text-sm font-bold text-brand-heading">Capability matrix</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">Status ini adalah projection dari physical capability evidence per mesin. “Belum terverifikasi” berarti typed capability belum memiliki canary verified atau hasil terakhir belum cukup; execute normal tetap fail-closed.</p></div></div>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {(summary?.capabilities ?? []).map((capability) => (
            <div key={capability.key} className="rounded-xl border border-border/70 p-3">
              <div className="flex items-center justify-between gap-2"><span className="text-xs font-bold text-brand-heading">{capability.label}</span><span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${stateClass(capability.state)}`}>{stateLabel(capability.state)}</span></div>
              <p className="mt-2 text-[11px] leading-5 text-muted-foreground">{capability.reason}</p>
              <div className="mt-2 flex items-center gap-1 text-[10px] font-semibold text-muted-foreground">{capability.execution === "hcis_only" ? <CheckCircle2 className="h-3 w-3 text-emerald-600" /> : capability.execution === "blocked" ? <AlertTriangle className="h-3 w-3 text-amber-600" /> : <Wrench className="h-3 w-3" />}{capability.execution === "hcis_only" ? "HCIS-side" : capability.execution === "blocked" ? "Tidak executable" : "Device command proven"}</div>
            </div>
          ))}
        </div>
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">Retention operasional tetap policy-gated dan raw ADMS facts tidak dibersihkan otomatis. Status verified hanya berlaku untuk capability dan mesin tersebut; biometric/destructive/firmware tetap mengikuti gate, confirmation, rate-limit, dan physical UAT masing-masing.</div>
      </section>
      </>
      ) : null}
    </div>
  );
}
