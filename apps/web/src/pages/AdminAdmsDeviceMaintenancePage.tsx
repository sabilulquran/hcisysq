import { AlertTriangle, Loader2, RefreshCw, RotateCcw, ShieldAlert, Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useDeviceAdmin } from "@/components/attendance/device-admin/DeviceAdminContext";
import { requestAdmsReadInformation } from "@/lib/admsDiagnostics";
import { listAdmsManagementJobs, type AdmsManagementJob } from "@/lib/admsManagement";
import { getAdmsOperations, type OperationsCapability } from "@/lib/admsOperations";
import { capabilityByKey, operatorCapabilityHint, operatorCapabilityLabel } from "@/lib/admsOperator";
import { clearPhysicalData, rebootDevice } from "@/lib/admsPhysicalParity";
import { hasPermission } from "@/lib/authorization";
import { commandStatusLabel } from "@/lib/admsAdmin";

function fmt(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" }).format(new Date(value));
}

export function AdminAdmsDeviceMaintenancePage() {
  const { deviceId, detail, session, refresh } = useDeviceAdmin();
  const device = detail?.item;
  const canOperate = hasPermission(session, "attendance.devices.operate");
  const canDestructive = hasPermission(session, "attendance.devices.destructive");
  const canTechnical = hasPermission(session, "attendance.devices.technical");
  const canFirmware = hasPermission(session, "attendance.devices.firmware");
  const [capabilities, setCapabilities] = useState<OperationsCapability[]>([]);
  const [history, setHistory] = useState<AdmsManagementJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [operations, jobs] = await Promise.all([
      getAdmsOperations(deviceId),
      listAdmsManagementJobs({ deviceId, limit: 20 }),
    ]);
    setCapabilities(operations.capabilities);
    setHistory(jobs.items);
  }, [deviceId]);

  useEffect(() => {
    setLoading(true);
    void load().then(() => setError(null)).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Perawatan mesin tidak dapat dimuat.");
    }).finally(() => setLoading(false));
  }, [load]);

  const rebootCapability = useMemo(() => capabilityByKey(capabilities, "reboot"), [capabilities]);

  async function updateInformation() {
    setBusy("info");
    try {
      await requestAdmsReadInformation(deviceId);
      setNotice("Permintaan pembaruan informasi mesin sudah dibuat.");
      setError(null);
      await Promise.all([load(), refresh()]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Informasi mesin tidak dapat diperbarui.");
    } finally {
      setBusy(null);
    }
  }

  async function reboot() {
    if (!device || rebootCapability?.state !== "available" || !canOperate) return;
    if (!window.confirm(`Mulai ulang ${device.displayName || device.serialNumber}? Mesin akan tidak dapat dipakai beberapa saat.`)) return;
    setBusy("reboot");
    try {
      await rebootDevice(deviceId, `REBOOT ${device.serialNumber}`, "execute");
      setNotice("Mulai ulang mesin sudah dijadwalkan.");
      setError(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Mesin tidak dapat dijadwalkan untuk mulai ulang.");
    } finally {
      setBusy(null);
    }
  }

  async function highRisk(kind: "clear-attendance" | "clear-photo" | "clear-all") {
    if (!device || !canDestructive) return;
    const capabilityKey = kind === "clear-attendance" ? "clear_attendance" : kind === "clear-photo" ? "clear_photo_cache" : "clear_all_data";
    const capability = capabilityByKey(capabilities, capabilityKey);
    if (capability?.state !== "available") return;
    const action = kind === "clear-attendance" ? "Bersihkan transaksi di mesin" : kind === "clear-photo" ? "Bersihkan cache foto" : "Hapus seluruh data mesin";
    const phrase = kind === "clear-attendance" ? `CLEAR ATTENDANCE ${device.serialNumber}` : kind === "clear-photo" ? `CLEAR PHOTO ${device.serialNumber}` : `CLEAR ALL DATA ${device.serialNumber}`;
    const confirmation = window.prompt(`${action} berdampak langsung pada mesin dan tidak menghapus riwayat mentah HCIS. Ketik persis:\n${phrase}`);
    if (confirmation !== phrase) return;
    setBusy(kind);
    try {
      await clearPhysicalData(deviceId, kind, confirmation, "execute");
      setNotice(`${action} sudah dijadwalkan.`);
      setError(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Tindakan tidak dapat dijalankan.");
    } finally {
      setBusy(null);
    }
  }

  if (loading && capabilities.length === 0) {
    return <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Memuat perawatan mesin…</div>;
  }

  const risks = [
    { key: "clear-attendance" as const, capability: "clear_attendance", label: "Bersihkan transaksi di mesin", detail: "Menghapus catatan transaksi pada mesin. Riwayat yang sudah masuk HCIS tetap disimpan." },
    { key: "clear-photo" as const, capability: "clear_photo_cache", label: "Bersihkan cache foto", detail: "Menghapus cache foto pada mesin tanpa menghapus data kehadiran HCIS." },
    { key: "clear-all" as const, capability: "clear_all_data", label: "Hapus seluruh data mesin", detail: "Mengosongkan data mesin. Gunakan hanya untuk pemulihan yang sudah direncanakan." },
  ];

  return (
    <div className="space-y-5">
      {notice ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</div> : null}
      {error ? <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div> : null}

      <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
        <h2 className="font-bold text-brand-heading">Perawatan aman</h2>
        <p className="mt-1 text-xs text-muted-foreground">Tindakan yang umum dibutuhkan saat merawat mesin.</p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <button type="button" disabled={busy !== null || !canOperate} onClick={() => void updateInformation()} className="rounded-xl border border-border p-4 text-left hover:bg-surface disabled:opacity-50"><div className="flex items-center gap-2 font-semibold text-brand-heading"><RefreshCw className="h-4 w-4" /> Perbarui informasi mesin</div><div className="mt-1 text-xs text-muted-foreground">Minta mesin mengirim ulang model, firmware, dan informasi operasional aman.</div></button>
          <button type="button" disabled={busy !== null || !canOperate || rebootCapability?.state !== "available"} onClick={() => void reboot()} className="rounded-xl border border-border p-4 text-left hover:bg-surface disabled:opacity-50"><div className="flex items-center gap-2 font-semibold text-brand-heading"><RotateCcw className="h-4 w-4" /> Mulai ulang mesin</div><div className="mt-1 text-xs text-muted-foreground">{operatorCapabilityLabel(rebootCapability)} · {operatorCapabilityHint(rebootCapability)}</div></button>
        </div>
      </section>

      <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
        <h2 className="font-bold text-brand-heading">Riwayat tindakan</h2>
        <p className="mt-1 text-xs text-muted-foreground">Ringkasan tindakan terbaru tanpa detail protokol mesin.</p>
        <div className="mt-4 divide-y divide-border/60 rounded-xl border border-border/70">
          {history.length === 0 ? <p className="p-4 text-sm text-muted-foreground">Belum ada riwayat tindakan.</p> : history.map((item) => (
            <div key={item.id} className="grid gap-1 p-3 sm:grid-cols-[minmax(0,1fr)_10rem_11rem] sm:items-center"><div className="text-sm font-semibold text-brand-heading">{item.action}</div><div className="text-xs font-semibold">{commandStatusLabel(item.status)}</div><div className="text-xs text-muted-foreground">{fmt(item.completedAt ?? item.createdAt)}</div></div>
          ))}
        </div>
      </section>

      {(canFirmware || canTechnical) ? (
        <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
          <h2 className="font-bold text-brand-heading">Perawatan lanjutan</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {canFirmware ? <span className="rounded-xl border border-border px-3 py-2 text-xs font-semibold">Pembaruan firmware tersedia untuk petugas berizin</span> : null}
            {canTechnical ? <a href={`/admin/attendance/devices/${deviceId}/diagnostics`} className="inline-flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-xs font-semibold hover:bg-surface"><Wrench className="h-3.5 w-3.5" /> Buka diagnostik teknis</a> : null}
          </div>
        </section>
      ) : null}

      {canDestructive ? (
        <section className="rounded-2xl border border-red-200 bg-red-50 p-5">
          <div className="flex gap-3"><ShieldAlert className="mt-0.5 h-5 w-5 text-red-700" /><div><h2 className="font-bold text-red-900">Tindakan berisiko tinggi</h2><p className="mt-1 text-xs leading-5 text-red-800">Setiap tindakan memerlukan izin khusus, konfirmasi dampak, dan tetap tercatat. Jangan gunakan untuk pekerjaan harian.</p></div></div>
          <div className="mt-4 grid gap-3">
            {risks.map((item) => {
              const capability = capabilityByKey(capabilities, item.capability);
              return <div key={item.key} className="flex flex-col gap-3 rounded-xl border border-red-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between"><div><div className="text-sm font-bold text-red-900">{item.label}</div><div className="mt-1 text-xs text-red-800">{item.detail}</div><div className="mt-1 text-[11px] font-semibold text-muted-foreground">{operatorCapabilityLabel(capability)}</div></div><button type="button" disabled={busy !== null || capability?.state !== "available"} onClick={() => void highRisk(item.key)} className="h-9 shrink-0 rounded-xl border border-red-300 px-3 text-xs font-bold text-red-800 disabled:opacity-50">Lanjutkan…</button></div>;
            })}
          </div>
        </section>
      ) : (
        <div className="flex gap-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900"><AlertTriangle className="h-4 w-4 shrink-0" /> Tindakan berisiko tinggi hanya tersedia untuk petugas dengan izin khusus.</div>
      )}
    </div>
  );
}
