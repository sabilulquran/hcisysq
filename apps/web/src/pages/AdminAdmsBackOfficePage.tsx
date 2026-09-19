import {
  AlertTriangle,
  ArrowRight,
  Fingerprint,
  Link2,
  MonitorCog,
  Radio,
  RefreshCw,
  ServerCog,
  UsersRound,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AdminShell } from "@/layouts/AdminShell";
import { getAdmsDeviceHealth, type AdmsDeviceHealth } from "@/lib/admsAdmin";
import { listDetectedAdmsDevices, type AdmsDetectedDevice } from "@/lib/admsDiagnostics";
import {
  getAdmsMappingLifecycleSummary,
  type AdmsMappingLifecycleSummary,
} from "@/lib/admsMappingSummary";
import { listAdmsDevices, type AdmsDevice } from "@/lib/attendance";

function connectivityClass(status: string) {
  if (status === "online") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "offline") return "border-red-200 bg-red-50 text-red-700";
  return "border-slate-200 bg-slate-100 text-slate-600";
}

function lifecycleLabel(value: string) {
  if (value === "active") return "Aktif";
  if (value === "disabled") return "Dinonaktifkan";
  if (value === "quarantined") return "Karantina";
  return value;
}

export function AdminAdmsBackOfficePage() {
  const [devices, setDevices] = useState<AdmsDevice[]>([]);
  const [health, setHealth] = useState<Record<string, AdmsDeviceHealth>>({});
  const [mapping, setMapping] = useState<Record<string, AdmsMappingLifecycleSummary>>({});
  const [detected, setDetected] = useState<AdmsDetectedDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    else setRefreshing(true);
    try {
      const [deviceResult, detectedResult] = await Promise.all([
        listAdmsDevices(),
        listDetectedAdmsDevices(),
      ]);
      const [healthResults, mappingResults] = await Promise.all([
        Promise.allSettled(deviceResult.items.map(async (item) => [item.id, await getAdmsDeviceHealth(item.id)] as const)),
        Promise.allSettled(deviceResult.items.map(async (item) => [item.id, await getAdmsMappingLifecycleSummary(item.id)] as const)),
      ]);
      setDevices(deviceResult.items);
      setDetected(detectedResult.items.filter((item) => item.status === "detected"));
      setHealth(Object.fromEntries(healthResults.flatMap((item) => item.status === "fulfilled" ? [item.value] : [])));
      setMapping(Object.fromEntries(mappingResults.flatMap((item) => item.status === "fulfilled" ? [item.value] : [])));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Back Office ADMS tidak dapat dimuat.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  const summary = useMemo(() => {
    let online = 0;
    let offline = 0;
    let unknown = 0;
    let review = 0;
    let unmapped = 0;
    for (const device of devices) {
      const status = health[device.id]?.connectivityStatus ?? "unknown";
      if (status === "online") online += 1;
      else if (status === "offline") offline += 1;
      else unknown += 1;
      review += mapping[device.id]?.reviewRequiredCount ?? 0;
      unmapped += device.unmappedPinCount ?? 0;
    }
    return { online, offline, unknown, review, unmapped };
  }, [devices, health, mapping]);

  return (
    <AdminShell
      active="attendance-adms"
      title="Back Office ADMS"
      description="Control plane internal YSQ untuk fleet fingerprint, mapping pegawai, transaksi, perintah, dan diagnostik."
    >
      <div className="mb-5 grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-brand-primary/30 bg-brand-primary-pale p-4">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-brand-primary-deep">
            <ServerCog className="h-4 w-4" /> Back Office ADMS
          </div>
          <p className="mt-1 text-sm font-semibold text-brand-heading">Perangkat, mapping, transaksi, command, diagnostics</p>
        </div>
        <a
          href="/admin/attendance/workforce"
          className="rounded-2xl border border-border/70 bg-white p-4 shadow-[var(--shadow-soft)] transition hover:border-brand-primary/40"
        >
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground">
            <Radio className="h-4 w-4" /> Operasional Kehadiran
          </div>
          <p className="mt-1 text-sm font-semibold text-brand-heading">Jadwal, roster, evidence mobile, klarifikasi, laporan</p>
        </a>
      </div>

      {error ? (
        <div className="mb-5 flex gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </div>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        {[
          ["Mesin", devices.length, Fingerprint],
          ["Online", summary.online, Radio],
          ["Offline", summary.offline, MonitorCog],
          ["Belum diketahui", summary.unknown, MonitorCog],
          ["PIN belum mapping", summary.unmapped, Link2],
          ["Perlu review", summary.review + detected.length, AlertTriangle],
        ].map(([label, value, Icon]) => (
          <article key={String(label)} className="rounded-2xl border border-border/70 bg-white p-4 shadow-[var(--shadow-soft)]">
            <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
              <Icon className="h-4 w-4" /> {String(label)}
            </div>
            <p className="mt-2 text-2xl font-bold text-brand-heading">{String(value)}</p>
          </article>
        ))}
      </section>

      <section className="mt-5 rounded-2xl border border-border/70 bg-white shadow-[var(--shadow-soft)]">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 p-4">
          <div>
            <h2 className="font-bold text-brand-heading">Fleet fingerprint</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Buka satu mesin untuk pengguna, biometrik, transaksi, perintah, operasi, pengaturan, dan diagnostik.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void load(false)}
              disabled={refreshing}
              className="inline-flex h-9 items-center gap-2 rounded-xl border border-border px-3 text-xs font-bold disabled:opacity-50"
            >
              <RefreshCw className={refreshing ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
              Muat ulang
            </button>
            <a href="/admin/attendance/devices" className="inline-flex h-9 items-center gap-2 rounded-xl bg-brand-primary px-3 text-xs font-bold text-white">
              Semua mesin <ArrowRight className="h-3.5 w-3.5" />
            </a>
          </div>
        </header>

        {loading ? (
          <div className="p-6 text-sm text-muted-foreground">Memuat fleet ADMS…</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-[900px] w-full text-left text-sm">
              <thead className="bg-surface text-[11px] font-bold uppercase tracking-[0.08em] text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Mesin</th>
                  <th className="px-4 py-3">Koneksi</th>
                  <th className="px-4 py-3">Lifecycle</th>
                  <th className="px-4 py-3">Mapping aktif</th>
                  <th className="px-4 py-3">Belum mapping</th>
                  <th className="px-4 py-3">Review</th>
                  <th className="px-4 py-3">Akses cepat</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {devices.map((device) => {
                  const status = health[device.id]?.connectivityStatus ?? "unknown";
                  const mappingSummary = mapping[device.id];
                  return (
                    <tr key={device.id}>
                      <td className="px-4 py-3">
                        <a href={"/admin/attendance/devices/" + device.id} className="font-bold text-brand-heading hover:underline">
                          {device.displayName?.trim() || device.serialNumber}
                        </a>
                        <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{device.serialNumber}</p>
                      </td>
                      <td className="px-4 py-3">
                        <span className={"inline-flex rounded-full border px-2 py-1 text-xs font-bold " + connectivityClass(status)}>
                          {status === "online" ? "Online" : status === "offline" ? "Offline" : "Belum diketahui"}
                        </span>
                      </td>
                      <td className="px-4 py-3">{lifecycleLabel(device.lifecycle)}</td>
                      <td className="px-4 py-3">{mappingSummary?.activeMappingCount ?? device.activeMappingCount ?? 0}</td>
                      <td className="px-4 py-3">{device.unmappedPinCount ?? 0}</td>
                      <td className="px-4 py-3">{mappingSummary?.reviewRequiredCount ?? "—"}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-2 text-xs font-semibold">
                          <a className="text-brand-primary-deep hover:underline" href={"/admin/attendance/devices/" + device.id + "/users"}>Mapping</a>
                          <a className="text-brand-primary-deep hover:underline" href={"/admin/attendance/devices/" + device.id + "/transactions"}>Transaksi</a>
                          <a className="text-brand-primary-deep hover:underline" href={"/admin/attendance/devices/" + device.id + "/commands"}>Perintah</a>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {devices.length === 0 ? (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">Belum ada mesin terdaftar.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-5 grid gap-4 lg:grid-cols-2">
        <article className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
          <div className="flex items-center gap-2">
            <UsersRound className="h-5 w-5 text-brand-primary-deep" />
            <h2 className="font-bold text-brand-heading">Mesin terdeteksi</h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Traffic ADMS yang belum diklaim ke registry HCIS.</p>
          <div className="mt-4 space-y-2">
            {detected.slice(0, 8).map((item) => (
              <div key={item.id} className="flex items-center justify-between gap-3 rounded-xl border border-border/70 p-3">
                <div>
                  <p className="font-mono text-sm font-bold">{item.serialNumber}</p>
                  <p className="text-xs text-muted-foreground">{item.observedCount} request · {item.lastIp ?? "IP belum diketahui"}</p>
                </div>
                <a href="/admin/attendance/devices" className="text-xs font-bold text-brand-primary-deep hover:underline">Tinjau</a>
              </div>
            ))}
            {detected.length === 0 ? <p className="text-sm text-muted-foreground">Tidak ada mesin baru menunggu claim.</p> : null}
          </div>
        </article>

        <article className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
          <h2 className="font-bold text-brand-heading">Padanan RuangHadir</h2>
          <div className="mt-4 space-y-3 text-sm">
            <div className="rounded-xl bg-surface p-3">
              <p className="font-bold text-brand-heading">Vendor / device cloud</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">Di HCIS: Back Office ADMS ini dan drill-down per mesin.</p>
            </div>
            <div className="rounded-xl bg-surface p-3">
              <p className="font-bold text-brand-heading">Tenant operator</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">Di HCIS: Operasional Kehadiran YSQ. Tidak ada tenant switcher karena HCIS bukan SaaS multi-tenant.</p>
            </div>
          </div>
        </article>
      </section>
    </AdminShell>
  );
}
