import { Clock3, Loader2, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useDeviceAdmin } from "@/components/attendance/device-admin/DeviceAdminContext";
import { listEmployees, type ReferenceOption } from "@/lib/adminEmployees";
import { getAdmsOperations, type OperationsCapability } from "@/lib/admsOperations";
import { capabilityByKey, getAdmsDeviceProfile, operatorCapabilityLabel, updateAdmsDeviceProfile, type AdmsDeviceProfile } from "@/lib/admsOperator";
import { activeTimeSync, setDuplicatePunch, setNtp } from "@/lib/admsPhysicalParity";
import { hasPermission } from "@/lib/authorization";
import { updateAdmsDevice, type AdmsDeviceLifecycle } from "@/lib/attendance";

export function AdminAdmsDeviceSettingsPage() {
  const { deviceId, detail, session, refresh } = useDeviceAdmin();
  const device = detail?.item ?? null;
  const canConfigure = hasPermission(session, "attendance.devices.configure");
  const [profile, setProfile] = useState<AdmsDeviceProfile | null>(null);
  const [capabilities, setCapabilities] = useState<OperationsCapability[]>([]);
  const [units, setUnits] = useState<ReferenceOption[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [timezone, setTimezone] = useState("Asia/Jakarta");
  const [lifecycle, setLifecycle] = useState<AdmsDeviceLifecycle>("active");
  const [organizationalUnitId, setOrganizationalUnitId] = useState("");
  const [worksiteLabel, setWorksiteLabel] = useState("");
  const [areaContext, setAreaContext] = useState("");
  const [duplicateSeconds, setDuplicateSeconds] = useState("");
  const [ntpHost, setNtpHost] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [profileResult, operations, employees] = await Promise.all([
      getAdmsDeviceProfile(deviceId),
      getAdmsOperations(deviceId),
      listEmployees({ page: 1, pageSize: 1 }),
    ]);
    setProfile(profileResult);
    setCapabilities(operations.capabilities);
    setUnits(employees.filters.units);
  }, [deviceId]);

  useEffect(() => {
    if (!device) return;
    setDisplayName(device.displayName ?? "");
    setTimezone(device.timezone);
    setLifecycle(device.lifecycle);
  }, [device]);

  useEffect(() => {
    void load().then(() => setError(null)).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Konfigurasi mesin tidak dapat dimuat.");
    });
  }, [load]);

  useEffect(() => {
    if (!profile) return;
    setOrganizationalUnitId(profile.organizationalUnitId ?? "");
    setWorksiteLabel(profile.worksiteLabel ?? "");
    setAreaContext(profile.areaContext ?? "");
  }, [profile]);

  const timeCapability = useMemo(() => capabilityByKey(capabilities, "time_sync"), [capabilities]);
  const duplicateCapability = useMemo(() => capabilityByKey(capabilities, "duplicate_punch_period"), [capabilities]);
  const ntpCapability = useMemo(() => capabilityByKey(capabilities, "ntp_config"), [capabilities]);

  async function saveIdentity() {
    if (!device || !canConfigure) return;
    setBusy("identity");
    try {
      await Promise.all([
        updateAdmsDevice(deviceId, {
          displayName: displayName.trim() || null,
          timezone: timezone.trim(),
          lifecycle,
        }),
        updateAdmsDeviceProfile(deviceId, {
          organizationalUnitId: organizationalUnitId || null,
          worksiteLabel: worksiteLabel.trim() || null,
          areaContext: areaContext.trim() || null,
        }),
      ]);
      setNotice("Identitas dan lokasi mesin sudah disimpan.");
      setError(null);
      await Promise.all([refresh(), load()]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Konfigurasi mesin tidak dapat disimpan.");
    } finally {
      setBusy(null);
    }
  }

  async function syncTime() {
    if (!device || timeCapability?.state !== "available") return;
    setBusy("time");
    try {
      await activeTimeSync(deviceId, `SYNC TIME ${device.serialNumber}`, "execute");
      setNotice("Sinkronisasi waktu sudah dijadwalkan.");
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Waktu mesin tidak dapat disinkronkan.");
    } finally {
      setBusy(null);
    }
  }

  async function saveDuplicatePeriod() {
    if (!device || duplicateCapability?.state !== "available") return;
    const seconds = Number(duplicateSeconds);
    if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 86400) {
      setError("Jeda absensi ganda harus 0–86400 detik.");
      return;
    }
    setBusy("duplicate");
    try {
      await setDuplicatePunch(deviceId, seconds, `SET DUPLICATE ${device.serialNumber} ${seconds}`, "execute");
      setNotice("Jeda absensi ganda sudah dijadwalkan untuk diterapkan.");
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Jeda absensi ganda tidak dapat disimpan.");
    } finally {
      setBusy(null);
    }
  }

  async function saveTimeSource() {
    if (!device || ntpCapability?.state !== "available" || !ntpHost.trim()) return;
    setBusy("ntp");
    try {
      await setNtp(deviceId, ntpHost.trim(), `SET NTP ${device.serialNumber} ${ntpHost.trim()}`, "execute");
      setNotice("Sumber waktu otomatis sudah dijadwalkan untuk diterapkan.");
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sumber waktu otomatis tidak dapat disimpan.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      {notice ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</div> : null}
      {error ? <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div> : null}

      <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
        <h2 className="text-base font-bold text-brand-heading">Identitas & lokasi</h2>
        <p className="mt-1 text-xs text-muted-foreground">Informasi operasional yang membantu Human Capital mengenali penempatan mesin.</p>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="text-xs font-semibold text-muted-foreground">Nama mesin<input value={displayName} onChange={(e) => setDisplayName(e.target.value)} disabled={!canConfigure} className="mt-1 h-10 w-full rounded-xl border border-border px-3 text-sm disabled:bg-surface" /></label>
          <label className="text-xs font-semibold text-muted-foreground">Serial<input value={device?.serialNumber ?? ""} disabled className="mt-1 h-10 w-full rounded-xl border border-border bg-surface px-3 text-sm text-muted-foreground" /></label>
          <label className="text-xs font-semibold text-muted-foreground">Unit<select value={organizationalUnitId} onChange={(e) => setOrganizationalUnitId(e.target.value)} disabled={!canConfigure} className="mt-1 h-10 w-full rounded-xl border border-border bg-white px-3 text-sm disabled:bg-surface"><option value="">Belum ditentukan</option>{units.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}</select></label>
          <label className="text-xs font-semibold text-muted-foreground">Lokasi kerja<input value={worksiteLabel} onChange={(e) => setWorksiteLabel(e.target.value)} disabled={!canConfigure} placeholder="Contoh: Gedung Utama Lt. 1" className="mt-1 h-10 w-full rounded-xl border border-border px-3 text-sm disabled:bg-surface" /></label>
          <label className="text-xs font-semibold text-muted-foreground">Konteks area<input value={areaContext} onChange={(e) => setAreaContext(e.target.value)} disabled={!canConfigure} placeholder="Opsional" className="mt-1 h-10 w-full rounded-xl border border-border px-3 text-sm disabled:bg-surface" /></label>
          <label className="text-xs font-semibold text-muted-foreground">Zona waktu<input value={timezone} onChange={(e) => setTimezone(e.target.value)} disabled={!canConfigure} className="mt-1 h-10 w-full rounded-xl border border-border px-3 text-sm disabled:bg-surface" /></label>
          <label className="text-xs font-semibold text-muted-foreground">Status<select value={lifecycle} onChange={(e) => setLifecycle(e.target.value as AdmsDeviceLifecycle)} disabled={!canConfigure || device?.lifecycle === "retired"} className="mt-1 h-10 w-full rounded-xl border border-border bg-white px-3 text-sm disabled:bg-surface"><option value="active">Aktif</option><option value="disabled">Dinonaktifkan</option><option value="quarantined">Karantina</option>{device?.lifecycle === "retired" ? <option value="retired">Dipensiunkan</option> : null}</select></label>
        </div>
        <div className="mt-4 flex justify-end"><button type="button" disabled={busy !== null || !canConfigure || !device} onClick={() => void saveIdentity()} className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-4 text-xs font-bold text-white disabled:opacity-50">{busy === "identity" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Simpan konfigurasi</button></div>
      </section>

      <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
        <div className="flex items-center gap-2"><Clock3 className="h-4 w-4 text-brand-primary" /><h2 className="text-base font-bold text-brand-heading">Waktu & absensi</h2></div>
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <div className="rounded-xl border border-border/70 p-4"><div className="text-sm font-bold text-brand-heading">Sinkronkan waktu</div><div className="mt-1 text-xs text-muted-foreground">{operatorCapabilityLabel(timeCapability)}</div><button type="button" disabled={busy !== null || !canConfigure || timeCapability?.state !== "available"} onClick={() => void syncTime()} className="mt-3 h-9 rounded-xl border border-border px-3 text-xs font-semibold disabled:opacity-50">Sinkronkan sekarang</button></div>
          <div className="rounded-xl border border-border/70 p-4"><div className="text-sm font-bold text-brand-heading">Jeda absensi ganda</div><div className="mt-1 text-xs text-muted-foreground">{operatorCapabilityLabel(duplicateCapability)}</div><div className="mt-3 flex gap-2"><input inputMode="numeric" value={duplicateSeconds} onChange={(e) => setDuplicateSeconds(e.target.value.replace(/\D/g, ""))} placeholder="Detik" className="h-9 min-w-0 flex-1 rounded-xl border border-border px-3 text-xs" /><button type="button" disabled={busy !== null || !canConfigure || duplicateCapability?.state !== "available"} onClick={() => void saveDuplicatePeriod()} className="h-9 rounded-xl border border-border px-3 text-xs font-semibold disabled:opacity-50">Terapkan</button></div></div>
          <div className="rounded-xl border border-border/70 p-4"><div className="text-sm font-bold text-brand-heading">Sumber waktu otomatis</div><div className="mt-1 text-xs text-muted-foreground">{operatorCapabilityLabel(ntpCapability)}</div><div className="mt-3 flex gap-2"><input value={ntpHost} onChange={(e) => setNtpHost(e.target.value)} placeholder="Server waktu" className="h-9 min-w-0 flex-1 rounded-xl border border-border px-3 text-xs" /><button type="button" disabled={busy !== null || !canConfigure || ntpCapability?.state !== "available" || !ntpHost.trim()} onClick={() => void saveTimeSource()} className="h-9 rounded-xl border border-border px-3 text-xs font-semibold disabled:opacity-50">Terapkan</button></div></div>
        </div>
      </section>

      <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
        <h2 className="text-base font-bold text-brand-heading">Pengiriman data</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">Mesin ini dikelola untuk presensi dengan pengiriman data ke HCIS. Pengaturan alamat server dan detail protokol tidak ditampilkan pada konfigurasi harian.</p>
        <div className="mt-3 rounded-xl bg-surface p-3 text-xs text-brand-heading">Mode operasional: <strong>Presensi · pengiriman otomatis</strong></div>
      </section>
    </div>
  );
}
