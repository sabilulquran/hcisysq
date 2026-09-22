import { AlertTriangle, Loader2, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useDeviceAdmin } from "@/components/attendance/device-admin/DeviceAdminContext";
import {
  getAdmsTelemetry,
  updateAdmsConnectivityPolicy,
  updateAdmsReconciliationPolicy,
  type AdmsTelemetry,
} from "@/lib/admsDiagnostics";
import { listAdmsDevices, updateAdmsDevice, type AdmsDevice, type AdmsDeviceLifecycle } from "@/lib/attendance";
import { retireAdmsDevice } from "@/lib/admsManagement";
import { hasPermission } from "@/lib/authorization";

function lifecycleLabel(value: AdmsDeviceLifecycle) {
  if (value === "active") return "Aktif";
  if (value === "disabled") return "Dinonaktifkan";
  if (value === "quarantined") return "Karantina";
  return "Dipensiunkan";
}

async function getConnectivityOverride(deviceId: string) {
  const response = await fetch(`/api/admin/attendance/adms/devices/${deviceId}/health`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  const body = await response.json().catch(() => null) as {
    item?: { connectivityTimeoutOverrideSeconds?: number | null };
    message?: string;
  } | null;
  if (!response.ok) throw new Error(body?.message ?? "Pengaturan koneksi tidak dapat dimuat.");
  return body?.item?.connectivityTimeoutOverrideSeconds ?? null;
}

export function AdminAdmsDeviceSettingsPage() {
  const { deviceId, detail, health, refresh, session } = useDeviceAdmin();
  const device = detail?.item ?? null;
  const [telemetry, setTelemetry] = useState<AdmsTelemetry | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [timezone, setTimezone] = useState("Asia/Jakarta");
  const [lifecycle, setLifecycle] = useState<AdmsDeviceLifecycle>("active");
  const [timeout, setTimeout] = useState("");
  const [reconciliationEnabled, setReconciliationEnabled] = useState(false);
  const [reconciliationInterval, setReconciliationInterval] = useState("1440");
  const [reconciliationLookback, setReconciliationLookback] = useState("48");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retireOpen, setRetireOpen] = useState(false);
  const [retirementNote, setRetirementNote] = useState("");
  const [replacementDeviceId, setReplacementDeviceId] = useState("");
  const [replacementDevices, setReplacementDevices] = useState<AdmsDevice[]>([]);
  const canConfigure = hasPermission(session, "attendance.devices.configure");

  const loadPolicies = useCallback(async () => {
    const [result, timeoutOverride] = await Promise.all([
      getAdmsTelemetry(deviceId),
      getConnectivityOverride(deviceId),
    ]);
    setTelemetry(result);
    setTimeout(timeoutOverride === null ? "" : String(timeoutOverride));
    setReconciliationEnabled(result.reconciliationEnabled);
    setReconciliationInterval(String(result.reconciliationIntervalMinutes));
    setReconciliationLookback(String(result.reconciliationLookbackHours));
  }, [deviceId]);

  useEffect(() => {
    if (!device) return;
    setDisplayName(device.displayName ?? "");
    setTimezone(device.timezone);
    setLifecycle(device.lifecycle);
  }, [device]);

  useEffect(() => {
    void loadPolicies().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Pengaturan mesin tidak dapat dimuat.");
    });
  }, [loadPolicies]);

  const saveIdentity = useCallback(async () => {
    if (!device) return;
    if (lifecycle !== device.lifecycle) {
      const message = lifecycle === "active"
        ? `Aktifkan kembali mesin ${device.serialNumber}?`
        : `Ubah lifecycle mesin ${device.serialNumber} menjadi ${lifecycleLabel(lifecycle)}? Perintah operasional dapat dibatasi oleh lifecycle ini.`;
      if (!window.confirm(message)) return;
    }
    setBusy("identity");
    try {
      await updateAdmsDevice(deviceId, {
        displayName: displayName.trim() || null,
        timezone: timezone.trim(),
        ...(device.lifecycle === "retired" ? {} : { lifecycle }),
      });
      await refresh();
      setNotice("Identitas dan lifecycle mesin sudah disimpan.");
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pengaturan mesin tidak dapat disimpan.");
    } finally {
      setBusy(null);
    }
  }, [device, deviceId, displayName, lifecycle, refresh, timezone]);

  const saveConnectivity = useCallback(async () => {
    const parsed = timeout.trim() === "" ? null : Number(timeout);
    if (parsed !== null && (!Number.isInteger(parsed) || parsed < 30 || parsed > 3600)) {
      setError("Timeout koneksi harus 30–3600 detik, atau kosong untuk mode adaptif.");
      return;
    }
    setBusy("connectivity");
    try {
      await updateAdmsConnectivityPolicy(deviceId, parsed);
      await Promise.all([refresh(), loadPolicies()]);
      setNotice(parsed === null ? "Timeout koneksi kembali ke mode adaptif." : `Timeout koneksi disimpan ${parsed} detik.`);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Timeout koneksi tidak dapat disimpan.");
    } finally {
      setBusy(null);
    }
  }, [deviceId, loadPolicies, refresh, timeout]);

  const saveReconciliation = useCallback(async () => {
    const intervalMinutes = Number(reconciliationInterval);
    const lookbackHours = Number(reconciliationLookback);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 60 || intervalMinutes > 10080) {
      setError("Interval pemeriksaan harus 60–10080 menit.");
      return;
    }
    if (!Number.isInteger(lookbackHours) || lookbackHours < 1 || lookbackHours > 744) {
      setError("Rentang pemeriksaan ke belakang harus 1–744 jam.");
      return;
    }
    setBusy("reconciliation");
    try {
      await updateAdmsReconciliationPolicy(deviceId, {
        enabled: reconciliationEnabled,
        intervalMinutes,
        lookbackHours,
      });
      await loadPolicies();
      setNotice("Pengaturan rekonsiliasi transaksi sudah disimpan.");
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pengaturan rekonsiliasi tidak dapat disimpan.");
    } finally {
      setBusy(null);
    }
  }, [deviceId, loadPolicies, reconciliationEnabled, reconciliationInterval, reconciliationLookback]);


  const openRetirement = useCallback(async () => {
    setRetirementNote("");
    setReplacementDeviceId("");
    setRetireOpen(true);
    try {
      const result = await listAdmsDevices();
      setReplacementDevices(result.items.filter((item) => item.id !== deviceId && item.lifecycle !== "retired"));
    } catch {
      setReplacementDevices([]);
    }
  }, [deviceId]);

  const retireDevice = useCallback(async () => {
    if (!device || retirementNote.trim().length < 5) {
      setError("Alasan pensiun mesin minimal 5 karakter.");
      return;
    }
    setBusy("retire");
    try {
      await retireAdmsDevice(deviceId, {
        note: retirementNote.trim(),
        replacementDeviceId: replacementDeviceId || null,
      });
      setRetireOpen(false);
      await refresh();
      setNotice("Mesin sudah dipensiunkan. Riwayat dan evidence lama tetap tersimpan.");
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Mesin tidak dapat dipensiunkan.");
    } finally {
      setBusy(null);
    }
  }, [device, deviceId, refresh, replacementDeviceId, retirementNote]);

  return (
    <div className="space-y-4">
      {notice ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs leading-5 text-emerald-800">{notice}</div> : null}
      {error ? <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs leading-5 text-red-800">{error}</div> : null}

      <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
        <h2 className="text-base font-bold text-brand-heading">Identitas mesin</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">Pengaturan registry HCIS. Serial mesin tidak dapat diubah dari halaman ini.</p>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="text-xs font-semibold text-muted-foreground">Nama mesin<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-border px-3 text-sm text-brand-heading outline-none focus:border-brand-primary" /></label>
          <label className="text-xs font-semibold text-muted-foreground">Serial<input value={device?.serialNumber ?? ""} disabled className="mt-1 h-10 w-full rounded-xl border border-border bg-surface px-3 font-mono text-sm text-muted-foreground" /></label>
          <label className="text-xs font-semibold text-muted-foreground">Timezone<input value={timezone} onChange={(event) => setTimezone(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-border px-3 text-sm text-brand-heading outline-none focus:border-brand-primary" /></label>
          <label className="text-xs font-semibold text-muted-foreground">Lifecycle<select value={lifecycle} disabled={device?.lifecycle === "retired"} onChange={(event) => setLifecycle(event.target.value as AdmsDeviceLifecycle)} className="mt-1 h-10 w-full rounded-xl border border-border bg-white px-3 text-sm text-brand-heading disabled:bg-surface"><option value="active">Aktif</option><option value="disabled">Dinonaktifkan</option><option value="quarantined">Karantina</option>{device?.lifecycle === "retired" ? <option value="retired">Dipensiunkan</option> : null}</select></label>
        </div>
        <div className="mt-4 flex justify-end"><button type="button" disabled={busy !== null || !device} onClick={() => void saveIdentity()} className="inline-flex h-9 items-center gap-2 rounded-xl bg-brand-primary px-4 text-xs font-bold text-white disabled:opacity-50">{busy === "identity" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Simpan pengaturan</button></div>
      </section>

      <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
        <h2 className="text-base font-bold text-brand-heading">Deteksi koneksi</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">Kosongkan override agar HCIS menyesuaikan batas offline dari pola request mesin yang teramati.</p>
        <div className="mt-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
          <div className="rounded-xl bg-surface p-3 text-xs"><div className="text-muted-foreground">Timeout efektif saat ini</div><div className="mt-1 font-bold text-brand-heading">{health?.effectiveConnectivityTimeoutSeconds ? `${health.effectiveConnectivityTimeoutSeconds} detik` : "Belum cukup data"}</div></div>
          <label className="text-xs font-semibold text-muted-foreground">Override timeout (detik)<input inputMode="numeric" value={timeout} onChange={(event) => setTimeout(event.target.value.replace(/\D/g, ""))} placeholder="Kosong = adaptif" className="mt-1 h-10 w-full rounded-xl border border-border px-3 text-sm text-brand-heading" /></label>
          <button type="button" disabled={busy !== null} onClick={() => void saveConnectivity()} className="h-10 rounded-xl border border-border bg-white px-4 text-xs font-semibold hover:bg-surface disabled:opacity-50">Simpan</button>
        </div>
      </section>

      <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
        <h2 className="text-base font-bold text-brand-heading">Rekonsiliasi transaksi</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">Pemeriksaan berkala meminta ulang rentang transaksi untuk mengurangi risiko gap. Ini tidak membuat expected count atau menyimpulkan status kehadiran.</p>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <label className="flex items-center gap-2 text-xs font-semibold text-brand-heading"><input type="checkbox" checked={reconciliationEnabled} onChange={(event) => setReconciliationEnabled(event.target.checked)} /> Aktifkan rekonsiliasi</label>
          <label className="text-xs font-semibold text-muted-foreground">Interval (menit)<input inputMode="numeric" value={reconciliationInterval} onChange={(event) => setReconciliationInterval(event.target.value.replace(/\D/g, ""))} className="mt-1 h-10 w-full rounded-xl border border-border px-3 text-sm text-brand-heading" /></label>
          <label className="text-xs font-semibold text-muted-foreground">Lihat ke belakang (jam)<input inputMode="numeric" value={reconciliationLookback} onChange={(event) => setReconciliationLookback(event.target.value.replace(/\D/g, ""))} className="mt-1 h-10 w-full rounded-xl border border-border px-3 text-sm text-brand-heading" /></label>
        </div>
        <div className="mt-4 flex items-center justify-between gap-4"><div className="text-[11px] text-muted-foreground">Terakhir diminta: {telemetry?.reconciliationLastRequestedAt ? new Date(telemetry.reconciliationLastRequestedAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }) : "belum pernah"}</div><button type="button" disabled={busy !== null || !telemetry} onClick={() => void saveReconciliation()} className="h-9 rounded-xl border border-border bg-white px-4 text-xs font-semibold hover:bg-surface disabled:opacity-50">Simpan rekonsiliasi</button></div>
      </section>

      <div className="flex gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs leading-5 text-amber-900"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>Operasi destruktif, perubahan PIN aktual, reset mesin, serta pengelolaan payload biometrik tidak tersedia di Pengaturan biasa.</span></div>
      {canConfigure && device?.lifecycle !== "retired" ? (
        <section className="rounded-2xl border border-red-200 bg-red-50 p-5">
          <div className="flex items-start justify-between gap-4">
            <div><h2 className="text-base font-bold text-red-900">Pensiunkan mesin</h2><p className="mt-1 text-xs leading-5 text-red-800">Gunakan saat mesin sudah tidak dipakai atau diganti. Riwayat transaksi, mapping, audit, dan evidence tidak dihapus.</p></div>
            <button type="button" onClick={() => void openRetirement()} className="inline-flex h-9 items-center gap-2 rounded-xl border border-red-300 bg-white px-3 text-xs font-bold text-red-800"><Trash2 className="h-3.5 w-3.5" />Pensiunkan</button>
          </div>
        </section>
      ) : null}

      {retireOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4" role="dialog" aria-modal="true" aria-labelledby="retire-device-title">
          <div className="w-full max-w-xl rounded-2xl bg-white p-5 shadow-xl">
            <h2 id="retire-device-title" className="font-bold text-brand-heading">Pensiunkan {device?.displayName || device?.serialNumber}</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Status ini final untuk alur biasa. Capability fisik mesin pengganti tidak diwariskan.</p>
            <label className="mt-4 block text-xs font-semibold text-muted-foreground">Alasan<textarea value={retirementNote} onChange={(event) => setRetirementNote(event.target.value)} rows={3} className="mt-1 w-full rounded-xl border border-border p-3 text-sm text-brand-heading" placeholder="Contoh: mesin rusak dan diganti unit baru" /></label>
            <label className="mt-4 block text-xs font-semibold text-muted-foreground">Mesin pengganti (opsional)<select value={replacementDeviceId} onChange={(event) => setReplacementDeviceId(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-border bg-white px-3 text-sm text-brand-heading"><option value="">Tidak ada / belum ditentukan</option>{replacementDevices.map((item) => <option key={item.id} value={item.id}>{item.displayName || item.serialNumber} · {item.serialNumber}</option>)}</select></label>
            <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setRetireOpen(false)} disabled={busy === "retire"} className="h-9 rounded-xl border border-border px-3 text-xs font-semibold">Batal</button><button type="button" onClick={() => void retireDevice()} disabled={busy === "retire" || retirementNote.trim().length < 5} className="inline-flex h-9 items-center gap-2 rounded-xl bg-red-700 px-4 text-xs font-bold text-white disabled:opacity-50">{busy === "retire" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}Pensiunkan mesin</button></div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
