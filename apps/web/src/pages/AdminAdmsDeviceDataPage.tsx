import { Loader2, MessageSquareText, Plus, RefreshCw, Tags } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useDeviceAdmin } from "@/components/attendance/device-admin/DeviceAdminContext";
import { listEmployees, type AdminEmployeeListItem } from "@/lib/adminEmployees";
import { hasPermission } from "@/lib/authorization";
import {
  createAdmsDeviceMessage,
  getAdmsOperations,
  listAdmsDeviceMessages,
  listAdmsWorkCodes,
  saveAdmsWorkCode,
  type AdmsDeviceMessageItem,
  type AdmsWorkCodeItem,
  type OperationsCapability,
} from "@/lib/admsOperations";
import { capabilityByKey, operatorCapabilityHint, operatorCapabilityLabel } from "@/lib/admsOperator";
import { syncPhysicalMessage, syncPhysicalWorkCode } from "@/lib/admsPhysicalParity";

function deliveryLabel(value: string) {
  if (value === "succeeded") return "Sinkron";
  if (value === "pending") return "Menunggu mesin";
  if (value === "failed") return "Perlu ditinjau";
  return "Belum dikirim";
}

export function AdminAdmsDeviceDataPage() {
  const { deviceId, session } = useDeviceAdmin();
  const canOperate = hasPermission(session, "attendance.devices.operate");
  const [codes, setCodes] = useState<AdmsWorkCodeItem[]>([]);
  const [messages, setMessages] = useState<AdmsDeviceMessageItem[]>([]);
  const [capabilities, setCapabilities] = useState<OperationsCapability[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [codeName, setCodeName] = useState("");
  const [messageTitle, setMessageTitle] = useState("");
  const [messageText, setMessageText] = useState("");
  const [audience, setAudience] = useState<"public" | "private">("public");
  const [employeeQuery, setEmployeeQuery] = useState("");
  const [employee, setEmployee] = useState<AdminEmployeeListItem | null>(null);
  const [employeeOptions, setEmployeeOptions] = useState<AdminEmployeeListItem[]>([]);

  const load = useCallback(async () => {
    const [operations, work, deviceMessages] = await Promise.all([
      getAdmsOperations(deviceId),
      listAdmsWorkCodes(deviceId),
      listAdmsDeviceMessages(deviceId),
    ]);
    setCapabilities(operations.capabilities);
    setCodes(work.items);
    setMessages(deviceMessages.items);
  }, [deviceId]);

  useEffect(() => {
    setLoading(true);
    void load().then(() => setError(null)).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Data mesin tidak dapat dimuat.");
    }).finally(() => setLoading(false));
  }, [load]);

  useEffect(() => {
    if (audience !== "private" || employeeQuery.trim().length < 2) {
      setEmployeeOptions([]);
      return;
    }
    const timer = window.setTimeout(() => {
      void listEmployees({ q: employeeQuery.trim(), status: "active", pageSize: 10 })
        .then((result) => setEmployeeOptions(result.items))
        .catch(() => setEmployeeOptions([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [audience, employeeQuery]);

  const workCapability = useMemo(() => capabilityByKey(capabilities, "work_code_delivery"), [capabilities]);
  const messageCapability = useMemo(() => capabilityByKey(capabilities, "message_delivery"), [capabilities]);
  const workReady = workCapability?.state === "available";
  const messageReady = messageCapability?.state === "available";

  async function addCode() {
    if (!code.trim() || !codeName.trim()) return;
    setBusy("code:add");
    try {
      await saveAdmsWorkCode({ code: code.trim(), name: codeName.trim(), active: true });
      setCode("");
      setCodeName("");
      setNotice("Kode kegiatan disimpan di HCIS.");
      setError(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Kode kegiatan tidak dapat disimpan.");
    } finally {
      setBusy(null);
    }
  }

  async function sendCode(item: AdmsWorkCodeItem, desiredState: "present" | "absent") {
    if (!workReady || !canOperate) return;
    setBusy(`code:${item.id}`);
    try {
      await syncPhysicalWorkCode(deviceId, item.id, desiredState, "execute");
      setNotice(desiredState === "present" ? "Kode kegiatan dijadwalkan untuk dikirim ke mesin." : "Kode kegiatan dijadwalkan untuk dihapus dari mesin.");
      setError(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Kode kegiatan tidak dapat disinkronkan.");
    } finally {
      setBusy(null);
    }
  }

  async function addMessage() {
    if (!messageTitle.trim() || !messageText.trim() || (audience === "private" && !employee)) return;
    setBusy("message:add");
    try {
      await createAdmsDeviceMessage({
        audience,
        employeeId: audience === "private" ? employee!.id : null,
        title: messageTitle.trim(),
        messageText: messageText.trim(),
      });
      setMessageTitle("");
      setMessageText("");
      setEmployee(null);
      setEmployeeQuery("");
      setNotice("Pesan disimpan di HCIS.");
      setError(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pesan tidak dapat disimpan.");
    } finally {
      setBusy(null);
    }
  }

  async function sendMessage(item: AdmsDeviceMessageItem, desiredState: "present" | "absent") {
    if (!messageReady || !canOperate) return;
    setBusy(`message:${item.id}`);
    try {
      await syncPhysicalMessage(deviceId, item.id, desiredState, "execute");
      setNotice(desiredState === "present" ? "Pesan dijadwalkan untuk dikirim ke mesin." : "Pesan dijadwalkan untuk dihapus dari mesin.");
      setError(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pesan tidak dapat disinkronkan.");
    } finally {
      setBusy(null);
    }
  }

  if (loading && codes.length === 0 && messages.length === 0) {
    return <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Memuat data mesin…</div>;
  }

  return (
    <div className="space-y-5">
      {notice ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</div> : null}
      {error ? <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div> : null}

      <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2"><Tags className="h-4 w-4 text-brand-primary" /><h2 className="font-bold text-brand-heading">Kode kegiatan</h2></div>
            <p className="mt-1 text-xs text-muted-foreground">Kelola kode yang dapat dipilih pada mesin tanpa mengubah aturan payroll atau kehadiran.</p>
          </div>
          <div className="text-right text-xs">
            <div className="font-semibold text-brand-heading">{operatorCapabilityLabel(workCapability)}</div>
            <div className="mt-1 max-w-xs text-muted-foreground">{operatorCapabilityHint(workCapability)}</div>
          </div>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-[9rem_minmax(0,1fr)_auto]">
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Kode" className="h-10 rounded-xl border border-border px-3 text-sm" />
          <input value={codeName} onChange={(e) => setCodeName(e.target.value)} placeholder="Nama kegiatan" className="h-10 rounded-xl border border-border px-3 text-sm" />
          <button type="button" disabled={busy !== null || !code.trim() || !codeName.trim()} onClick={() => void addCode()} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-brand-primary px-4 text-xs font-bold text-white disabled:opacity-50"><Plus className="h-4 w-4" /> Tambah</button>
        </div>
        <div className="mt-4 divide-y divide-border/60 rounded-xl border border-border/70">
          {codes.length === 0 ? <p className="p-4 text-sm text-muted-foreground">Belum ada kode kegiatan.</p> : codes.map((item) => (
            <div key={item.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div><div className="font-semibold text-brand-heading">{item.code} · {item.name}</div><div className="mt-1 text-xs text-muted-foreground">{deliveryLabel(item.deliveryState)}</div></div>
              <div className="flex gap-2">
                <button type="button" disabled={busy !== null || !canOperate || !workReady} onClick={() => void sendCode(item, "present")} className="h-9 rounded-xl border border-border px-3 text-xs font-semibold disabled:opacity-50">Sinkronkan</button>
                <button type="button" disabled={busy !== null || !canOperate || !workReady} onClick={() => void sendCode(item, "absent")} className="h-9 rounded-xl border border-border px-3 text-xs font-semibold disabled:opacity-50">Hapus dari mesin</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2"><MessageSquareText className="h-4 w-4 text-brand-primary" /><h2 className="font-bold text-brand-heading">Pesan untuk mesin</h2></div>
            <p className="mt-1 text-xs text-muted-foreground">Buat pesan untuk semua pengguna atau pegawai tertentu, lalu sinkronkan bila mesin mendukungnya.</p>
          </div>
          <div className="text-right text-xs"><div className="font-semibold text-brand-heading">{operatorCapabilityLabel(messageCapability)}</div><div className="mt-1 max-w-xs text-muted-foreground">{operatorCapabilityHint(messageCapability)}</div></div>
        </div>
        <div className="mt-4 grid gap-2 md:grid-cols-2">
          <input value={messageTitle} onChange={(e) => setMessageTitle(e.target.value)} placeholder="Judul pesan" className="h-10 rounded-xl border border-border px-3 text-sm" />
          <select value={audience} onChange={(e) => { setAudience(e.target.value as "public" | "private"); setEmployee(null); }} className="h-10 rounded-xl border border-border bg-white px-3 text-sm"><option value="public">Semua pengguna</option><option value="private">Pegawai tertentu</option></select>
          <textarea value={messageText} onChange={(e) => setMessageText(e.target.value)} placeholder="Isi pesan" rows={3} className="rounded-xl border border-border p-3 text-sm md:col-span-2" />
          {audience === "private" ? (
            <div className="relative md:col-span-2">
              <input value={employee ? `${employee.fullName} · ${employee.employeeNumber}` : employeeQuery} onChange={(e) => { setEmployee(null); setEmployeeQuery(e.target.value); }} placeholder="Cari pegawai" className="h-10 w-full rounded-xl border border-border px-3 text-sm" />
              {!employee && employeeOptions.length > 0 ? <div className="absolute z-20 mt-1 max-h-48 w-full overflow-auto rounded-xl border border-border bg-white p-1 shadow-lg">{employeeOptions.map((item) => <button key={item.id} type="button" onClick={() => { setEmployee(item); setEmployeeOptions([]); }} className="block w-full rounded-lg px-3 py-2 text-left text-xs hover:bg-surface"><span className="font-semibold">{item.fullName}</span> · {item.employeeNumber}</button>)}</div> : null}
            </div>
          ) : null}
          <div className="md:col-span-2 flex justify-end"><button type="button" disabled={busy !== null || !messageTitle.trim() || !messageText.trim() || (audience === "private" && !employee)} onClick={() => void addMessage()} className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-4 text-xs font-bold text-white disabled:opacity-50"><Plus className="h-4 w-4" /> Simpan pesan</button></div>
        </div>
        <div className="mt-4 divide-y divide-border/60 rounded-xl border border-border/70">
          {messages.length === 0 ? <p className="p-4 text-sm text-muted-foreground">Belum ada pesan.</p> : messages.map((item) => (
            <div key={item.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div><div className="font-semibold text-brand-heading">{item.title}</div><div className="mt-1 text-xs text-muted-foreground">{item.audience === "public" ? "Semua pengguna" : item.employeeName ?? "Pegawai tertentu"} · {deliveryLabel(item.deliveryState)}</div><p className="mt-2 text-sm text-brand-heading">{item.messageText}</p></div>
              <div className="flex shrink-0 gap-2"><button type="button" disabled={busy !== null || !canOperate || !messageReady} onClick={() => void sendMessage(item, "present")} className="h-9 rounded-xl border border-border px-3 text-xs font-semibold disabled:opacity-50">Sinkronkan</button><button type="button" disabled={busy !== null || !canOperate || !messageReady} onClick={() => void sendMessage(item, "absent")} className="h-9 rounded-xl border border-border px-3 text-xs font-semibold disabled:opacity-50">Hapus dari mesin</button></div>
            </div>
          ))}
        </div>
      </section>

      <div className="flex justify-end"><button type="button" onClick={() => void load()} className="inline-flex items-center gap-2 text-xs font-semibold text-muted-foreground"><RefreshCw className="h-3.5 w-3.5" /> Muat ulang data mesin</button></div>
    </div>
  );
}
