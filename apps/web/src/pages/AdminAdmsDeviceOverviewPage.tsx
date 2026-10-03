import { Activity, Clock3, Fingerprint, Link2, Loader2, MapPin, Radio, RefreshCw, RotateCcw, UsersRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { connectivityLabel, requestAdmsSyncNew } from "@/lib/admsAdmin";
import { requestAdmsReadInformation } from "@/lib/admsDiagnostics";
import { getAdmsOperations, type OperationsCapability } from "@/lib/admsOperations";
import { capabilityByKey, getAdmsDeviceProfile, operatorCapabilityLabel, type AdmsDeviceProfile } from "@/lib/admsOperator";
import { activeTimeSync, rebootDevice } from "@/lib/admsPhysicalParity";
import { hasPermission } from "@/lib/authorization";

import { useDeviceAdmin } from "@/components/attendance/device-admin/DeviceAdminContext";
import { connectivityClass, fmt } from "@/components/attendance/device-admin/DeviceDetailShell";

function lifecycleLabel(value: string | undefined) {
  if (value === "active") return "Aktif";
  if (value === "disabled") return "Dinonaktifkan";
  if (value === "quarantined") return "Karantina";
  if (value === "retired") return "Dipensiunkan";
  return value ?? "Belum diketahui";
}

function SummaryCard({ label, value, helper }: { label: string; value: string | number; helper?: string }) {
  return <div className="rounded-2xl border border-border/70 bg-white p-4 shadow-[var(--shadow-soft)]"><p className="text-xs font-semibold text-muted-foreground">{label}</p><p className="mt-2 text-2xl font-bold tracking-[-0.02em] text-brand-heading">{value}</p>{helper ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{helper}</p> : null}</div>;
}

export function AdminAdmsDeviceOverviewPage() {
  const { deviceId, detail, health, session, refresh } = useDeviceAdmin();
  const [capabilities, setCapabilities] = useState<OperationsCapability[]>([]);
  const [profile, setProfile] = useState<AdmsDeviceProfile | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const canOperate = hasPermission(session, "attendance.devices.operate");

  const loadExtras = useCallback(async () => {
    const [operations, profileResult] = await Promise.all([getAdmsOperations(deviceId), getAdmsDeviceProfile(deviceId)]);
    setCapabilities(operations.capabilities);
    setProfile(profileResult);
  }, [deviceId]);

  useEffect(() => { void loadExtras().catch(() => undefined); }, [loadExtras]);

  const timeCapability = useMemo(() => capabilityByKey(capabilities, "time_sync"), [capabilities]);
  const employeeCapability = useMemo(() => capabilityByKey(capabilities, "user_profile_upsert"), [capabilities]);
  const rebootCapability = useMemo(() => capabilityByKey(capabilities, "reboot"), [capabilities]);

  if (!detail) return null;
  const device = detail.item;
  const activeMappings = detail.mappings.filter((mapping) => !mapping.effectiveTo).length;
  const unmappedPins = detail.observedPins.filter((pin) => !pin.mappingId).length;
  const connectivity = health?.connectivityStatus ?? "unknown";

  async function run(key: string, action: () => Promise<unknown>, success: string) {
    setBusy(key);
    try {
      await action();
      setNotice(success);
      setActionError(null);
      await Promise.all([refresh(), loadExtras()]);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Tindakan tidak dapat diproses.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      {notice ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</div> : null}
      {actionError ? <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{actionError}</div> : null}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Ringkasan kondisi mesin">
        <div className="rounded-2xl border border-border/70 bg-white p-4 shadow-[var(--shadow-soft)]"><div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground"><Radio className="h-4 w-4" /> Status koneksi</div><span className={`mt-3 inline-flex rounded-full border px-2.5 py-1 text-xs font-bold ${connectivityClass(connectivity)}`}>{connectivityLabel(connectivity)}</span><p className="mt-2 text-xs leading-5 text-muted-foreground">Terakhir terhubung {fmt(health?.lastSuccessfulRequestAt ?? device.lastSuccessfulRequestAt)}</p></div>
        <div className="rounded-2xl border border-border/70 bg-white p-4 shadow-[var(--shadow-soft)]"><div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground"><MapPin className="h-4 w-4" /> Lokasi / unit</div><p className="mt-3 text-sm font-bold text-brand-heading">{profile?.worksiteLabel || profile?.areaContext || "Belum diisi"}</p><p className="mt-1 text-xs text-muted-foreground">Atur pada tab Konfigurasi.</p></div>
        <div className="rounded-2xl border border-border/70 bg-white p-4 shadow-[var(--shadow-soft)]"><div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground"><Activity className="h-4 w-4" /> Transaksi terakhir</div><p className="mt-3 text-sm font-bold text-brand-heading">{fmt(health?.lastTransactionActivityAt ?? null)}</p><p className="mt-1 text-xs text-muted-foreground">Aktivitas transaksi terakhir yang tercatat.</p></div>
        <div className="rounded-2xl border border-border/70 bg-white p-4 shadow-[var(--shadow-soft)]"><div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground"><Fingerprint className="h-4 w-4" /> Status mesin</div><p className="mt-3 text-lg font-bold text-brand-heading">{lifecycleLabel(device.lifecycle)}</p><p className="mt-1 text-xs text-muted-foreground">{device.model ?? "Model belum terbaca"} · {device.firmwareVersion ?? "Firmware belum terbaca"}</p></div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard label="Pengguna terhubung" value={activeMappings} helper="Hubungan aktif dan eksplisit ke pegawai HCIS." />
        <SummaryCard label="PIN belum termap" value={unmappedPins} helper="Perlu dihubungkan ke pegawai bila memang valid." />
        <SummaryCard label="Transaksi ringkasan" value={detail.recentEvents.length} helper="Fakta transaksi terbaru pada detail mesin." />
        <SummaryCard label="Masalah aktif" value={unmappedPins + detail.recentQuarantines.length} helper="Mapping atau catatan karantina yang perlu perhatian." />
      </section>

      <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
        <h2 className="text-base font-bold text-brand-heading">Aksi cepat</h2>
        <p className="mt-1 text-xs text-muted-foreground">Tindakan harian yang aman. Fitur yang belum diuji tetap terlihat beserta alasannya.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <button type="button" disabled={busy !== null || !canOperate} onClick={() => void run("info", () => requestAdmsReadInformation(deviceId), "Permintaan pembaruan informasi mesin sudah dibuat.")} className="rounded-xl border border-border p-4 text-left hover:bg-surface disabled:opacity-50"><div className="flex items-center gap-2 font-semibold text-brand-heading">{busy === "info" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Perbarui informasi mesin</div></button>
          <button type="button" disabled={busy !== null || !canOperate} onClick={() => void run("latest", () => requestAdmsSyncNew(deviceId), "Permintaan transaksi terbaru sudah dibuat.")} className="rounded-xl border border-border p-4 text-left hover:bg-surface disabled:opacity-50"><div className="font-semibold text-brand-heading">Ambil transaksi terbaru</div></button>
          <a href={`/admin/attendance/devices/${deviceId}/transactions`} className="rounded-xl border border-border p-4 text-left hover:bg-surface"><div className="font-semibold text-brand-heading">Ambil ulang transaksi…</div><div className="mt-1 text-xs text-muted-foreground">Pilih rentang waktu pada halaman Transaksi.</div></a>
          <button type="button" disabled={busy !== null || !canOperate || timeCapability?.state !== "available"} onClick={() => void run("time", () => activeTimeSync(deviceId, `SYNC TIME ${device.serialNumber}`, "execute"), "Waktu mesin dijadwalkan untuk disinkronkan.")} className="rounded-xl border border-border p-4 text-left hover:bg-surface disabled:opacity-50"><div className="flex items-center gap-2 font-semibold text-brand-heading"><Clock3 className="h-4 w-4" /> Sinkronkan waktu</div><div className="mt-1 text-xs text-muted-foreground">{operatorCapabilityLabel(timeCapability)}</div></button>
          <a href="/admin/attendance/adms/jobs" className={`rounded-xl border border-border p-4 text-left hover:bg-surface ${employeeCapability?.state !== "available" ? "opacity-60" : ""}`}><div className="flex items-center gap-2 font-semibold text-brand-heading"><UsersRound className="h-4 w-4" /> Sinkronkan pegawai</div><div className="mt-1 text-xs text-muted-foreground">{operatorCapabilityLabel(employeeCapability)}</div></a>
          <button type="button" disabled={busy !== null || !canOperate || rebootCapability?.state !== "available"} onClick={() => { if (window.confirm("Mulai ulang mesin? Mesin akan tidak dapat dipakai beberapa saat.")) void run("reboot", () => rebootDevice(deviceId, `REBOOT ${device.serialNumber}`, "execute"), "Mulai ulang mesin sudah dijadwalkan."); }} className="rounded-xl border border-border p-4 text-left hover:bg-surface disabled:opacity-50"><div className="flex items-center gap-2 font-semibold text-brand-heading"><RotateCcw className="h-4 w-4" /> Mulai ulang mesin</div><div className="mt-1 text-xs text-muted-foreground">{operatorCapabilityLabel(rebootCapability)}</div></button>
        </div>
      </section>

      <section className="rounded-2xl border border-border/70 bg-white shadow-[var(--shadow-soft)]">
        <div className="border-b border-border/70 px-5 py-4"><h2 className="text-base font-bold text-brand-heading">Informasi mesin</h2><p className="mt-1 text-xs text-muted-foreground">Identitas dan metadata aman untuk kebutuhan operasional.</p></div>
        <dl className="grid gap-x-8 p-5 sm:grid-cols-2">
          {[
            ["Nama mesin", device.displayName || "Belum diisi"],
            ["Serial", device.serialNumber],
            ["Lokasi", profile?.worksiteLabel || "Belum diisi"],
            ["Konteks area", profile?.areaContext || "Belum diisi"],
            ["Zona waktu", device.timezone],
            ["Model", device.model ?? "Belum terbaca"],
            ["Firmware", device.firmwareVersion ?? "Belum terbaca"],
            ["Terakhir terlihat", fmt(health?.lastSeenAt ?? device.lastSeenAt)],
          ].map(([label, value]) => <div key={label} className="flex items-start justify-between gap-4 border-b border-border/60 py-3 text-sm"><dt className="text-muted-foreground">{label}</dt><dd className="text-right font-semibold text-brand-heading">{value}</dd></div>)}
        </dl>
      </section>

      {unmappedPins > 0 || detail.recentQuarantines.length > 0 ? (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5"><div className="flex gap-3"><Fingerprint className="mt-0.5 h-5 w-5 text-amber-700" /><div><h2 className="text-sm font-bold text-amber-900">Perlu perhatian</h2><div className="mt-2 space-y-1 text-sm leading-6 text-amber-900/80">{unmappedPins > 0 ? <p className="flex items-center gap-2"><Link2 className="h-4 w-4" /> {unmappedPins} PIN belum terhubung ke pegawai HCIS.</p> : null}{detail.recentQuarantines.length > 0 ? <p className="flex items-center gap-2"><UsersRound className="h-4 w-4" /> Ada {detail.recentQuarantines.length} catatan yang perlu ditinjau.</p> : null}</div></div></div></section>
      ) : null}
    </div>
  );
}
