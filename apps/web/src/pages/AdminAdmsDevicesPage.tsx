import { AlertTriangle, Fingerprint, Loader2, Plus, RefreshCw, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AdmsManagementNav } from "@/components/attendance/adms/AdmsManagementNav";
import { AdminShell } from "@/layouts/AdminShell";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import type { AuthSession } from "@/types/hcis";
import {
  connectivityLabel,
  getAdmsDeviceHealth,
  type AdmsConnectivityStatus,
  type AdmsDeviceHealth,
} from "@/lib/admsAdmin";
import {
  getAdmsMappingLifecycleSummary,
  type AdmsMappingLifecycleSummary,
} from "@/lib/admsMappingSummary";
import {
  claimDetectedAdmsDevice,
  listDetectedAdmsDevices,
  type AdmsDetectedDevice,
} from "@/lib/admsDiagnostics";
import { createAdmsDevice, listAdmsDevices, type AdmsDevice } from "@/lib/attendance";
import { cn } from "@/lib/utils";

function fmt(value: string | null) {
  if (!value) return "Belum pernah";
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "Asia/Jakarta",
  }).format(new Date(value));
}

function connectivityClass(status: AdmsConnectivityStatus) {
  if (status === "online") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "offline") return "border-red-200 bg-red-50 text-red-700";
  return "border-slate-200 bg-slate-100 text-slate-600";
}

function lifecycleLabel(value: AdmsDevice["lifecycle"]) {
  if (value === "active") return "Aktif";
  if (value === "disabled") return "Dinonaktifkan";
  if (value === "quarantined") return "Karantina";
  return "Dipensiunkan";
}

function lifecycleClass(value: AdmsDevice["lifecycle"]) {
  if (value === "active") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (value === "disabled") return "border-slate-200 bg-slate-100 text-slate-700";
  if (value === "retired") return "border-slate-300 bg-slate-100 text-slate-500";
  return "border-amber-200 bg-amber-50 text-amber-800";
}

export function AdminAdmsDevicesPage() {
  const [devices, setDevices] = useState<AdmsDevice[]>([]);
  const [healthById, setHealthById] = useState<Record<string, AdmsDeviceHealth>>({});
  const [mappingSummaryById, setMappingSummaryById] = useState<Record<string, AdmsMappingLifecycleSummary>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<AdmsConnectivityStatus | "all">("all");
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [detected, setDetected] = useState<AdmsDetectedDevice[]>([]);
  const [detectedLoading, setDetectedLoading] = useState(false);
  const [onboardingBusy, setOnboardingBusy] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [session, setSession] = useState<AuthSession | null>(null);
  const [sessionResolved, setSessionResolved] = useState(false);
  const canConfigure = hasPermission(session, "attendance.devices.configure");

  const load = useCallback(async (initial: boolean) => {
    if (initial) setLoading(true);
    else setRefreshing(true);

    try {
      const response = await listAdmsDevices();
      const [healthResults, mappingSummaryResults] = await Promise.all([
        Promise.allSettled(
          response.items.map(async (device) => [device.id, await getAdmsDeviceHealth(device.id)] as const),
        ),
        Promise.allSettled(
          response.items.map(async (device) => [device.id, await getAdmsMappingLifecycleSummary(device.id)] as const),
        ),
      ]);
      const healthEntries = healthResults.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      const mappingSummaryEntries = mappingSummaryResults.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      setDevices(response.items);
      setHealthById(Object.fromEntries(healthEntries));
      setMappingSummaryById(Object.fromEntries(mappingSummaryEntries));
      setLastRefreshedAt(new Date());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Daftar mesin fingerprint tidak dapat dimuat.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
    const timer = window.setInterval(() => void load(false), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    let active = true;
    void getCurrentSession()
      .then((value) => { if (active) setSession(value); })
      .catch(() => { if (active) setSession(null); })
      .finally(() => { if (active) setSessionResolved(true); });
    return () => { active = false; };
  }, []);

  const summary = useMemo(() => {
    let online = 0;
    let offline = 0;
    let unknown = 0;
    let attention = 0;
    for (const device of devices) {
      const connectivity = healthById[device.id]?.connectivityStatus ?? "unknown";
      const mappingSummary = mappingSummaryById[device.id];
      if (connectivity === "online") online += 1;
      else if (connectivity === "offline") offline += 1;
      else unknown += 1;
      if (
        connectivity === "offline"
        || device.lifecycle !== "active"
        || (device.unmappedPinCount ?? 0) > 0
        || !mappingSummary
        || mappingSummary.reviewRequiredCount > 0
      ) attention += 1;
    }
    return { online, offline, unknown, attention };
  }, [devices, healthById, mappingSummaryById]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase("id-ID");
    return devices.filter((device) => {
      const connectivity = healthById[device.id]?.connectivityStatus ?? "unknown";
      if (status !== "all" && connectivity !== status) return false;
      if (!needle) return true;
      return [device.displayName ?? "", device.serialNumber, device.lastIp ?? ""]
        .some((value) => value.toLocaleLowerCase("id-ID").includes(needle));
    });
  }, [devices, healthById, search, status]);

  const openOnboarding = useCallback(async () => {
    setAddOpen(true);
    setDetectedLoading(true);
    try {
      const result = await listDetectedAdmsDevices();
      setDetected(result.items.filter((item) => item.status === "detected"));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Mesin yang terdeteksi belum dapat dimuat.");
      setDetected([]);
    } finally {
      setDetectedLoading(false);
    }
  }, []);

  const claim = useCallback(async (item: AdmsDetectedDevice) => {
    if (!window.confirm(`Tambahkan mesin terdeteksi ${item.serialNumber} ke registry HCIS? Mesin baru akan dibuat dalam kondisi dinonaktifkan sampai ditinjau.`)) return;
    setOnboardingBusy(`claim:${item.id}`);
    try {
      const result = await claimDetectedAdmsDevice(item.id, displayName.trim() || null);
      window.location.href = `/admin/attendance/devices/${result.item.id}/settings`;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Mesin terdeteksi tidak dapat ditambahkan.");
    } finally {
      setOnboardingBusy(null);
    }
  }, [displayName]);

  const registerManual = useCallback(async () => {
    const serial = serialNumber.trim();
    if (!serial) return;
    if (!window.confirm(`Daftarkan serial ${serial} secara manual? Gunakan ini hanya bila serial mesin sudah dipastikan benar.`)) return;
    setOnboardingBusy("manual");
    try {
      const result = await createAdmsDevice({
        serialNumber: serial,
        displayName: displayName.trim() || null,
        timezone: "Asia/Jakarta",
      });
      window.location.href = `/admin/attendance/devices/${result.item.id}/settings`;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Mesin tidak dapat diregistrasi.");
    } finally {
      setOnboardingBusy(null);
    }
  }, [displayName, serialNumber]);

  return (
    <AdminShell
      active="attendance-adms"
      title="Mesin Fingerprint"
      description="Pantau kondisi mesin, lalu buka satu mesin untuk mengelola pengguna, transaksi, perintah, dan pengaturan dalam konteks yang sama."
    >
      <AdmsManagementNav active="devices" />
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-muted-foreground">
          <span>{devices.length} mesin</span>
          <span aria-hidden="true">·</span>
          <span className="text-emerald-700">{summary.online} online</span>
          <span aria-hidden="true">·</span>
          <span className={summary.offline > 0 ? "text-red-700" : undefined}>{summary.offline} offline</span>
          {summary.unknown > 0 ? <><span aria-hidden="true">·</span><span>{summary.unknown} belum diketahui</span></> : null}
          <span aria-hidden="true">·</span>
          <span className={summary.attention > 0 ? "text-amber-700" : undefined}>{summary.attention} perlu perhatian</span>
        </div>
        {canConfigure ? (
          <button type="button" onClick={() => void openOnboarding()} className="inline-flex h-9 items-center gap-2 rounded-xl bg-brand-primary px-4 text-xs font-bold text-white">
            <Plus className="h-3.5 w-3.5" /> Tambah mesin
          </button>
        ) : sessionResolved ? (
          <span className="rounded-xl bg-surface px-3 py-2 text-[11px] font-semibold text-muted-foreground">Mode baca saja · tambah/claim mesin memerlukan izin konfigurasi</span>
        ) : null}
      </div>

      <section className="rounded-2xl border border-border/70 bg-white shadow-[var(--shadow-soft)]">
        <div className="flex flex-col gap-3 border-b border-border/70 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-1 flex-col gap-3 sm:flex-row">
            <label className="relative block min-w-0 flex-1 sm:max-w-sm">
              <span className="sr-only">Cari mesin</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Cari nama, serial, atau IP"
                className="h-10 w-full rounded-xl border border-border bg-white pl-9 pr-3 text-sm outline-none transition focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/15"
              />
            </label>
            <label className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
              <span>Status</span>
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value as AdmsConnectivityStatus | "all")}
                className="h-10 rounded-xl border border-border bg-white px-3 text-sm font-medium text-brand-heading outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/15"
              >
                <option value="all">Semua</option>
                <option value="online">Online</option>
                <option value="offline">Offline</option>
                <option value="unknown">Belum diketahui</option>
              </select>
            </label>
          </div>
          <div className="flex items-center justify-between gap-3 lg:justify-end">
            <span className="text-[11px] text-muted-foreground">
              {lastRefreshedAt ? `Diperbarui ${lastRefreshedAt.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}` : "Belum diperbarui"}
            </span>
            <button
              type="button"
              onClick={() => void load(false)}
              disabled={refreshing || loading}
              className="inline-flex h-9 items-center gap-2 rounded-xl border border-border px-3 text-xs font-semibold text-brand-heading hover:bg-surface disabled:opacity-60"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} aria-hidden="true" />
              {refreshing ? "Memuat..." : "Muat ulang"}
            </button>
          </div>
        </div>

        {error ? (
          <div className="m-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">{error}</div>
        ) : null}

        {loading ? (
          <div className="p-8 text-center text-sm text-muted-foreground">Memuat daftar mesin...</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center">
            <Fingerprint className="mx-auto h-7 w-7 text-muted-foreground" aria-hidden="true" />
            <p className="mt-3 text-sm font-semibold text-brand-heading">Tidak ada mesin yang sesuai.</p>
            <p className="mt-1 text-xs text-muted-foreground">Ubah pencarian atau filter status.</p>
          </div>
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[880px] text-left text-sm">
                <thead className="bg-surface text-[11px] font-bold uppercase tracking-[0.08em] text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Mesin</th>
                    <th className="px-4 py-3">Serial</th>
                    <th className="px-4 py-3">IP terakhir</th>
                    <th className="px-4 py-3">Aktivitas terakhir</th>
                    <th className="px-4 py-3">Mapping</th>
                    <th className="px-4 py-3">Lifecycle</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/70">
                  {filtered.map((device) => {
                    const health = healthById[device.id];
                    const connectivity = health?.connectivityStatus ?? "unknown";
                    const mappingSummary = mappingSummaryById[device.id];
                    const mappingReviewCount = mappingSummary?.reviewRequiredCount ?? null;
                    return (
                      <tr key={device.id} className="hover:bg-surface/70">
                        <td className="px-4 py-3"><span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-bold ${connectivityClass(connectivity)}`}>{connectivityLabel(connectivity)}</span></td>
                        <td className="px-4 py-3"><a href={`/admin/attendance/devices/${device.id}`} className="font-bold text-brand-heading hover:text-brand-primary-deep hover:underline">{device.displayName?.trim() || "Mesin tanpa nama"}</a></td>
                        <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{device.serialNumber}</td>
                        <td className="px-4 py-3 text-muted-foreground">{health?.lastIp ?? device.lastIp ?? "—"}</td>
                        <td className="px-4 py-3 text-muted-foreground">{fmt(health?.lastSeenAt ?? device.lastSeenAt)}</td>
                        <td className="px-4 py-3">
                          <div className="font-semibold text-brand-heading">{device.activeMappingCount ?? 0} terhubung</div>
                          {(device.unmappedPinCount ?? 0) > 0 ? <div className="mt-0.5 flex items-center gap-1 text-xs text-amber-700"><AlertTriangle className="h-3.5 w-3.5" /> {device.unmappedPinCount} belum terhubung</div> : null}
                          {mappingReviewCount === null ? <div className="mt-0.5 text-xs text-muted-foreground">Status lifecycle mapping belum diketahui</div> : null}
                          {mappingReviewCount !== null && mappingReviewCount > 0 ? <div className="mt-0.5 flex items-center gap-1 text-xs font-semibold text-orange-800"><AlertTriangle className="h-3.5 w-3.5" /> {mappingReviewCount} hubungan perlu ditinjau</div> : null}
                        </td>
                        <td className="px-4 py-3"><span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${lifecycleClass(device.lifecycle)}`}>{lifecycleLabel(device.lifecycle)}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="divide-y divide-border/70 md:hidden">
              {filtered.map((device) => {
                const health = healthById[device.id];
                const connectivity = health?.connectivityStatus ?? "unknown";
                const mappingSummary = mappingSummaryById[device.id];
                const mappingReviewCount = mappingSummary?.reviewRequiredCount ?? null;
                return (
                  <a key={device.id} href={`/admin/attendance/devices/${device.id}`} className="block p-4 hover:bg-surface/70">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0"><p className="truncate font-bold text-brand-heading">{device.displayName?.trim() || "Mesin tanpa nama"}</p><p className="mt-1 truncate font-mono text-xs text-muted-foreground">{device.serialNumber}</p></div>
                      <span className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-bold ${connectivityClass(connectivity)}`}>{connectivityLabel(connectivity)}</span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>Aktivitas {fmt(health?.lastSeenAt ?? device.lastSeenAt)}</span>
                      <span>{device.activeMappingCount ?? 0} mapping</span>
                      {(device.unmappedPinCount ?? 0) > 0 ? <span className="text-amber-700">{device.unmappedPinCount} PIN perlu ditinjau</span> : null}
                      {mappingReviewCount === null ? <span>Status lifecycle mapping belum diketahui</span> : null}
                      {mappingReviewCount !== null && mappingReviewCount > 0 ? <span className="font-semibold text-orange-800">{mappingReviewCount} hubungan pegawai perlu ditinjau</span> : null}
                    </div>
                  </a>
                );
              })}
            </div>
          </>
        )}
      </section>

      {addOpen && canConfigure ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4" role="dialog" aria-modal="true" aria-labelledby="add-device-title">
          <div className="max-h-[88vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div><h2 id="add-device-title" className="text-base font-bold text-brand-heading">Tambah mesin</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">Utamakan mesin yang sudah terdeteksi dari traffic ADMS. Registrasi manual tersedia sebagai fallback saat serial sudah diverifikasi.</p></div>
              <button type="button" onClick={() => setAddOpen(false)} className="rounded-lg p-2 hover:bg-surface" aria-label="Tutup"><X className="h-4 w-4" /></button>
            </div>

            <label className="mt-4 block text-xs font-semibold text-muted-foreground">Nama mesin (opsional)<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Contoh: SDIT Tahfizh" className="mt-1 h-10 w-full rounded-xl border border-border px-3 text-sm text-brand-heading" /></label>

            <div className="mt-5">
              <div className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">Terdeteksi otomatis</div>
              {detectedLoading ? <div className="mt-2 flex items-center gap-2 rounded-xl bg-surface p-4 text-xs text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Memuat mesin terdeteksi…</div> : detected.length === 0 ? <div className="mt-2 rounded-xl border border-dashed border-border p-4 text-xs text-muted-foreground">Tidak ada mesin baru yang menunggu untuk ditambahkan.</div> : (
                <div className="mt-2 space-y-2">{detected.map((item) => <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 p-3"><div><div className="font-mono text-sm font-bold text-brand-heading">{item.serialNumber}</div><div className="mt-1 text-[11px] text-muted-foreground">IP {item.lastIp ?? "—"} · terakhir {fmt(item.lastSeenAt)} · {item.observedCount} request</div></div><button type="button" disabled={onboardingBusy !== null} onClick={() => void claim(item)} className="h-9 rounded-xl bg-brand-primary px-3 text-xs font-bold text-white disabled:opacity-50">{onboardingBusy === `claim:${item.id}` ? "Menambahkan…" : "Tambahkan"}</button></div>)}</div>
              )}
            </div>

            <div className="mt-5 border-t border-border/70 pt-5">
              <div className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">Registrasi manual</div>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row"><input value={serialNumber} onChange={(event) => setSerialNumber(event.target.value)} placeholder="Serial mesin, contoh SPK7245000738" className="h-10 min-w-0 flex-1 rounded-xl border border-border px-3 font-mono text-sm text-brand-heading" /><button type="button" disabled={onboardingBusy !== null || !serialNumber.trim()} onClick={() => void registerManual()} className="h-10 rounded-xl border border-border bg-white px-4 text-xs font-semibold hover:bg-surface disabled:opacity-50">{onboardingBusy === "manual" ? "Mendaftarkan…" : "Daftarkan manual"}</button></div>
            </div>
          </div>
        </div>
      ) : null}
    </AdminShell>
  );
}
