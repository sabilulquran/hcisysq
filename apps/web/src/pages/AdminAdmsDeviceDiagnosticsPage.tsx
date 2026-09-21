import { AlertTriangle, Database, Fingerprint, Info, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useDeviceAdmin } from "@/components/attendance/device-admin/DeviceAdminContext";
import { hasPermission } from "@/lib/authorization";
import { commandStatusLabel } from "@/lib/admsAdmin";
import {
  getAdmsBiometricInventory,
  getAdmsBiometricPolicy,
  getAdmsReconciliation,
  getAdmsSafeLogs,
  getAdmsTelemetry,
  listAdmsBiometricCredentials,
  requestAdmsReadInformation,
  type AdmsBiometricCredentialResponse,
  type AdmsBiometricInventoryResponse,
  type AdmsBiometricPolicy,
  type AdmsReconciliationResponse,
  type AdmsSafeLogs,
  type AdmsTelemetry,
} from "@/lib/admsDiagnostics";

function fmt(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "Asia/Jakarta",
  }).format(new Date(value));
}

function displayObserved(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function modalityLabel(value: string) {
  if (value === "fingerprint") return "Fingerprint";
  if (value === "face") return "Face";
  if (value === "palm") return "Palm";
  if (value === "bio_photo") return "Bio-photo";
  return value;
}

export function AdminAdmsDeviceDiagnosticsPage() {
  const { deviceId, detail, session, sessionResolved } = useDeviceAdmin();
  const device = detail?.item ?? null;
  const canOperate = hasPermission(session, "attendance.devices.operate");
  const canBiometrics = hasPermission(session, "attendance.devices.biometrics");
  const [telemetry, setTelemetry] = useState<AdmsTelemetry | null>(null);
  const [reconciliation, setReconciliation] = useState<AdmsReconciliationResponse | null>(null);
  const [logs, setLogs] = useState<AdmsSafeLogs | null>(null);
  const [biometricPolicy, setBiometricPolicy] = useState<AdmsBiometricPolicy | null>(null);
  const [credentials, setCredentials] = useState<AdmsBiometricCredentialResponse | null>(null);
  const [inventory, setInventory] = useState<AdmsBiometricInventoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [nextTelemetry, nextReconciliation, nextLogs] = await Promise.all([
      getAdmsTelemetry(deviceId),
      getAdmsReconciliation(deviceId),
      getAdmsSafeLogs(deviceId),
    ]);
    setTelemetry(nextTelemetry);
    setReconciliation(nextReconciliation);
    setLogs(nextLogs);

    if (canBiometrics) {
      const [nextPolicy, nextCredentials, nextInventory] = await Promise.all([
        getAdmsBiometricPolicy(deviceId),
        listAdmsBiometricCredentials(deviceId),
        getAdmsBiometricInventory(deviceId),
      ]);
      setBiometricPolicy(nextPolicy);
      setCredentials(nextCredentials);
      setInventory(nextInventory);
    } else {
      setBiometricPolicy(null);
      setCredentials(null);
      setInventory(null);
    }
  }, [canBiometrics, deviceId]);

  useEffect(() => {
    setLoading(true);
    void load()
      .then(() => setError(null))
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Diagnostik mesin tidak dapat dimuat.");
      })
      .finally(() => setLoading(false));
  }, [load]);

  const refresh = useCallback(async () => {
    setBusy("refresh");
    try {
      await load();
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Diagnostik mesin tidak dapat dimuat ulang.");
    } finally {
      setBusy(null);
    }
  }, [load]);

  const readInformation = useCallback(async () => {
    if (device?.lifecycle !== "active") return;
    setBusy("info");
    try {
      const result = await requestAdmsReadInformation(deviceId);
      setNotice(`Perintah C:${result.item.commandNumber} untuk membaca informasi mesin sudah dibuat.`);
      setError(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Permintaan informasi mesin tidak dapat dibuat.");
    } finally {
      setBusy(null);
    }
  }, [device?.lifecycle, deviceId, load]);

  if (loading) {
    return (
      <div className="flex min-h-64 items-center justify-center gap-2 rounded-2xl border border-border/70 bg-white text-sm text-muted-foreground shadow-[var(--shadow-soft)]">
        <Loader2 className="h-4 w-4 animate-spin" /> Memuat diagnostik teknis…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-slate-300 bg-slate-950 p-5 text-slate-100 shadow-[var(--shadow-soft)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-400">Area teknis · operator ADMS berizin</div>
            <h2 className="mt-1 text-base font-bold">Diagnostik mesin</h2>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-300">
              Protocol evidence, canary, reconciliation, dan log aman untuk mesin pada URL. Metadata biometrik hanya dimuat bila account memiliki izin biometrik terpisah.
            </p>
          </div>
          <button type="button" disabled={busy !== null} onClick={() => void refresh()} className="inline-flex h-9 items-center gap-2 rounded-xl border border-slate-700 px-3 text-xs font-semibold hover:bg-slate-900 disabled:opacity-50">
            <RefreshCw className={`h-3.5 w-3.5 ${busy === "refresh" ? "animate-spin" : ""}`} /> Muat ulang diagnostik
          </button>
        </div>
      </section>

      {notice ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs leading-5 text-emerald-800">{notice}</div> : null}
      {error ? <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs leading-5 text-red-800">{error}</div> : null}

      <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-bold text-brand-heading"><Info className="h-4 w-4" /> Telemetry & INFO</div>
            <p className="mt-1 text-xs text-muted-foreground">Metadata transport dan INFO yang pernah teramati; tidak memuat template biometric.</p>
          </div>
          <button type="button" disabled={busy !== null || device?.lifecycle !== "active" || !canOperate} onClick={() => void readInformation()} className="h-9 rounded-xl border border-border px-3 text-xs font-semibold hover:bg-surface disabled:opacity-50">
            {busy === "info" ? "Mengirim…" : "Baca informasi mesin"}
          </button>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Model" value={telemetry?.model ?? "—"} />
          <Stat label="Firmware" value={telemetry?.firmwareVersion ?? "—"} />
          <Stat label="IP terakhir" value={telemetry?.lastIp ?? "—"} mono />
          <Stat label="Request sukses terakhir" value={fmt(telemetry?.lastSuccessfulRequestAt ?? null)} />
        </div>
        <details className="mt-4 rounded-xl border border-border/70">
          <summary className="cursor-pointer p-3 text-xs font-semibold text-brand-heading">Field transport / INFO teramati</summary>
          <div className="grid gap-2 border-t border-border/70 p-3 md:grid-cols-2">
            {Object.entries({ ...(telemetry?.transportObserved ?? {}), ...(telemetry?.infoObserved ?? {}) }).map(([key, value]) => (
              <div key={key} className="grid grid-cols-[10rem_minmax(0,1fr)] gap-2 text-[11px]">
                <span className="font-mono text-muted-foreground">{key}</span><span className="break-all text-brand-heading">{displayObserved(value)}</span>
              </div>
            ))}
          </div>
        </details>
      </section>

      <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
        <div className="flex items-center gap-2 text-sm font-bold text-brand-heading"><Database className="h-4 w-4" /> Rekonsiliasi & log aman</div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">Coverage hanya berdasarkan fakta yang persisted. Expected count dan jumlah duplicate tidak direkayasa.</p>
        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          <div className="rounded-xl border border-border/70 p-4">
            <div className="text-xs font-bold text-brand-heading">Rekonsiliasi terbaru</div>
            <div className="mt-3 space-y-2">
              {(reconciliation?.items ?? []).slice(0, 8).map((item) => (
                <div key={item.commandId} className="rounded-lg bg-surface p-3 text-[11px]">
                  <div className="flex justify-between gap-3"><span className="font-mono font-bold">C:{item.commandNumber}</span><span>{commandStatusLabel(item.status)}</span></div>
                  <div className="mt-1 text-muted-foreground">{fmt(item.requestedRangeStart)} – {fmt(item.requestedRangeEnd)}</div>
                  <div className="mt-1">Persisted {item.currentPersistedCount} · sejak delivery {item.persistedSinceDeliveryCount} · ATTLOG req {item.attlogRequestCount}</div>
                </div>
              ))}
              {(reconciliation?.items.length ?? 0) === 0 ? <div className="text-xs text-muted-foreground">Belum ada evidence rekonsiliasi.</div> : null}
            </div>
          </div>
          <div className="rounded-xl border border-border/70 p-4">
            <div className="text-xs font-bold text-brand-heading">Ringkasan log</div>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
              <Stat label="Request journal" value={String(logs?.requests.length ?? 0)} />
              <Stat label="Command event" value={String(logs?.commandEvents.length ?? 0)} />
              <Stat label="Quarantine" value={String(logs?.quarantines.length ?? 0)} />
              <Stat label="Admin audit" value={String(logs?.adminAudit.length ?? 0)} />
            </dl>
            <div className="mt-3 rounded-lg bg-surface p-3 text-[11px] leading-5 text-muted-foreground">Raw request body exposed: <strong className="text-brand-heading">{logs?.rawRequestBodiesExposed ? "YA" : "TIDAK"}</strong></div>
          </div>
        </div>
      </section>

      {canBiometrics ? (
        <section className="rounded-2xl border border-amber-200 bg-white p-5 shadow-[var(--shadow-soft)]">
          <div className="flex gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-bold text-brand-heading">Biometric control plane</h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">Hanya metadata credential/replica yang ditampilkan. Payload vendor, ciphertext, IV, auth tag, hash, password, dan key material tidak pernah dirender.</p>
            </div>
          </div>
          <div className="mt-4 rounded-xl bg-amber-50 p-4">
            <div className="text-xs">
              <div className="font-bold text-amber-950">Gate koleksi · observasi saja pada tahap ini</div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-amber-900">
                <span>global <strong>{biometricPolicy?.globalCollectionEnabled ? "ON" : "OFF"}</strong></span>
                <span>device <strong>{biometricPolicy?.deviceCollectionEnabled ? "ON" : "OFF"}</strong></span>
                <span>effective <strong>{biometricPolicy?.effectiveCollectionEnabled ? "ON" : "OFF"}</strong></span>
              </div>
              <div className="mt-2 flex gap-2 text-[11px] leading-5 text-amber-900"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> UI redesign ini tidak menyediakan tombol untuk menyalakan biometric collection. Aktivasi tetap menunggu approval hardware/privacy/key canary terpisah.</div>
            </div>
          </div>
          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            <div className="rounded-xl border border-border/70 p-4">
              <div className="flex items-center gap-2 text-xs font-bold text-brand-heading"><Fingerprint className="h-4 w-4" /> Vault metadata</div>
              <div className="mt-3 space-y-2">
                {(credentials?.items ?? []).slice(0, 20).map((item) => (
                  <div key={item.id} className="rounded-lg bg-surface p-3 text-[11px]">
                    <div className="font-semibold text-brand-heading">{item.employeeName} · {item.employeeNumber}</div>
                    <div className="mt-1 text-muted-foreground">{modalityLabel(item.modality)} · slot {item.slotIndex ?? "—"} · {item.vendorFormat} · source PIN {item.sourcePin ?? "—"}</div>
                  </div>
                ))}
                {(credentials?.items.length ?? 0) === 0 ? <div className="text-xs text-muted-foreground">Belum ada metadata credential untuk origin device ini.</div> : null}
              </div>
            </div>
            <div className="rounded-xl border border-border/70 p-4">
              <div className="text-xs font-bold text-brand-heading">Replica state</div>
              <div className="mt-3 space-y-2">
                {(inventory?.items ?? []).slice(0, 20).map((item) => (
                  <div key={item.credentialId} className="rounded-lg bg-surface p-3 text-[11px]">
                    <div className="flex justify-between gap-2"><span className="font-semibold text-brand-heading">{item.employeeName}</span><span>{item.state}</span></div>
                    <div className="mt-1 text-muted-foreground">{modalityLabel(item.modality)} · slot {item.slotIndex ?? "—"} · last sync {fmt(item.lastSyncedAt)}</div>
                  </div>
                ))}
                {(inventory?.items.length ?? 0) === 0 ? <div className="text-xs text-muted-foreground">Belum ada state replica credential untuk mesin ini.</div> : null}
              </div>
            </div>
          </div>
        </section>
      ) : sessionResolved ? (
        <section className="rounded-2xl border border-border/70 bg-surface p-5 text-xs leading-5 text-muted-foreground">
          <div className="font-bold text-brand-heading">Biometric control plane tidak ditampilkan</div>
          <p className="mt-1">
            Metadata fingerprint/face/palm memerlukan izin biometrik terpisah. Akses ADMS standar tetap dapat memakai telemetry, rekonsiliasi, log aman, transaksi, mapping, dan operasi non-destruktif.
          </p>
        </section>
      ) : null}
    </div>
  );
}

function Stat({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl bg-surface p-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`mt-1 break-all text-xs font-semibold text-brand-heading ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}
