import { AlertTriangle, Download, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useDeviceAdmin } from "@/components/attendance/device-admin/DeviceAdminContext";
import {
  activeTimeSync,
  clearPhysicalData,
  deleteBiometric,
  enrollBiometric,
  getPhysicalCapabilityMatrix,
  getWdmsEvidence,
  listFirmwarePackages,
  listPhysicalOperationHistory,
  markCapabilityUnsupportedOrBlocked,
  physicalExportUrls,
  pushUserProfile,
  queryBiometric,
  rebootDevice,
  restoreBiometric,
  setDuplicatePunch,
  setNtp,
  setServer,
  setUserEnabled,
  upgradeFirmware,
  type FirmwarePackageItem,
  type PhysicalCapabilityMatrix,
  type PhysicalMode,
  type PhysicalOperationHistoryItem,
  type WdmsEvidence,
} from "@/lib/admsPhysicalParity";

function fmt(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" }).format(new Date(value));
}

function capabilityClass(state: string) {
  if (state === "verified") return "border-success-line bg-success-soft text-success-ink";
  if (state === "unsupported") return "border-border bg-muted text-foreground";
  if (state === "blocked" || state === "failed") return "border-danger-line bg-danger-soft text-danger-ink";
  if (state === "canary_pending") return "border-warning-line bg-warning-soft text-warning-ink";
  return "border-border bg-surface-raised text-brand-heading";
}

export function AdminAdmsDevicePhysicalParityPage() {
  const { deviceId } = useDeviceAdmin();
  const [matrix, setMatrix] = useState<PhysicalCapabilityMatrix | null>(null);
  const [evidence, setEvidence] = useState<WdmsEvidence | null>(null);
  const [history, setHistory] = useState<PhysicalOperationHistoryItem[]>([]);
  const [packages, setPackages] = useState<FirmwarePackageItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [duplicateSeconds, setDuplicateSeconds] = useState(2);
  const [employeeId, setEmployeeId] = useState("");
  const [ntpHost, setNtpHost] = useState("pool.ntp.org");
  const [serverHost, setServerHost] = useState("");
  const [serverPort, setServerPort] = useState(80);
  const [serverConfirmation, setServerConfirmation] = useState("");
  const [biometricProtocol, setBiometricProtocol] = useState<"legacy_fingerprint" | "unified">("legacy_fingerprint");
  const [biometricType, setBiometricType] = useState(1);
  const [slotIndex, setSlotIndex] = useState(0);
  const [credentialId, setCredentialId] = useState("");
  const [biometricEnrollConfirmation, setBiometricEnrollConfirmation] = useState("");
  const [biometricCredentialConfirmation, setBiometricCredentialConfirmation] = useState("");
  const [firmwarePackageId, setFirmwarePackageId] = useState("");
  const [firmwareConfirmation, setFirmwareConfirmation] = useState("");
  const [destructiveConfirmation, setDestructiveConfirmation] = useState("");
  const [classificationKey, setClassificationKey] = useState("");
  const [classificationState, setClassificationState] = useState<"unsupported" | "blocked">("unsupported");
  const [classificationNote, setClassificationNote] = useState("");

  const load = useCallback(async () => {
    const [nextMatrix, nextEvidence, nextHistory, nextPackages] = await Promise.all([
      getPhysicalCapabilityMatrix(deviceId),
      getWdmsEvidence(deviceId),
      listPhysicalOperationHistory(deviceId, 100),
      listFirmwarePackages(),
    ]);
    setMatrix(nextMatrix);
    setEvidence(nextEvidence);
    setHistory(nextHistory.items);
    setPackages(nextPackages.items);
    setServerHost(nextMatrix.approvedServerTarget?.host ?? "");
    setServerPort(nextMatrix.approvedServerTarget?.port ?? 80);
    setClassificationKey((current) => current || nextMatrix.capabilities[0]?.key || "");
  }, [deviceId]);

  useEffect(() => {
    setLoading(true);
    void load()
      .then(() => setError(null))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Physical parity tidak dapat dimuat."))
      .finally(() => setLoading(false));
  }, [load]);

  const serial = matrix?.device.serialNumber ?? "";
  const biometricGateReady = Boolean(
    matrix?.biometricGate.globalCollectionEnabled &&
    matrix.biometricGate.deviceCollectionEnabled &&
    matrix.biometricGate.keyringReady,
  );
  const exports = useMemo(() => physicalExportUrls(deviceId), [deviceId]);

  function stateFor(capabilityKey: string) {
    return matrix?.capabilities.find((item) => item.key === capabilityKey)?.state ?? "documented";
  }

  function modeFor(capabilityKey: string): PhysicalMode {
    return stateFor(capabilityKey) === "verified" ? "execute" : "canary";
  }

  function actionLocked(capabilityKey: string) {
    const state = stateFor(capabilityKey);
    return !matrix || state === "canary_pending" || state === "unsupported" || state === "blocked";
  }

  const run = useCallback(async (key: string, mode: PhysicalMode | null, work: () => Promise<{ operationId?: string } | unknown>) => {
    setBusy(key);
    try {
      const result = await work() as { operationId?: string };
      setNotice(result.operationId ? `Operation ${result.operationId} berhasil di-queue sebagai ${mode ?? "physical operation"}.` : "Perubahan tersimpan.");
      setError(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Operasi tidak dapat diproses.");
    } finally {
      setBusy(null);
    }
  }, [load]);

  if (loading && !matrix) {
    return <div className="mt-4 flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Memuat full physical parity…</div>;
  }

  const timeMode = modeFor("time_sync");
  const duplicateMode = modeFor("duplicate_punch_period");
  const userProfileMode = modeFor("user_profile_upsert");
  const userEnabledMode = modeFor("user_enable_disable");
  const ntpMode = modeFor("ntp_config");
  const serverMode = modeFor("server_config");
  const rebootMode = modeFor("reboot");
  const biometricQueryMode = modeFor("biometric_query");
  const biometricEnrollmentMode = modeFor("biometric_enrollment");
  const biometricRestoreMode = modeFor("biometric_restore");
  const biometricDeleteMode = modeFor("biometric_delete");
  const firmwareMode = modeFor("firmware_upgrade");
  const clearAttendanceMode = modeFor("clear_attendance");
  const clearPhotoMode = modeFor("clear_photo_cache");
  const clearAllMode = modeFor("clear_all_data");

  const serverPhrase = serial && serverHost ? `SET SERVER ${serial} ${serverHost}:${serverPort}` : "";
  const enrollPhrase = serial && employeeId ? `ENROLL BIOMETRIC ${serial} ${employeeId}` : "";
  const restorePhrase = serial && credentialId ? `RESTORE BIOMETRIC ${serial} ${credentialId}` : "";
  const deleteBiometricPhrase = serial && credentialId ? `DELETE BIOMETRIC ${serial} ${credentialId}` : "";
  const clearAttendancePhrase = serial ? `CLEAR ATTENDANCE ${serial}` : "";
  const clearPhotoPhrase = serial ? `CLEAR PHOTO ${serial}` : "";
  const clearAllPhrase = serial ? `CLEAR ALL DATA ${serial}` : "";
  const selectedFirmware = packages.find((item) => item.id === firmwarePackageId);
  const firmwarePhrase = serial && selectedFirmware ? `UPGRADE FIRMWARE ${serial} ${selectedFirmware.targetVersion}` : "";

  return (
    <div className="mt-6 space-y-4" id="full-wdms-physical-parity">
      <section className="rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-brand-primary" /><h2 className="text-base font-bold text-brand-heading">Full WDMS Physical Parity</h2></div>
            <p className="mt-1 max-w-4xl text-xs leading-5 text-muted-foreground">Semua action di bawah typed + allowlisted dan tidak ada raw command textarea. Capability yang belum verified hanya dapat masuk canary; setelah verified UI memilih execute, dan backend tetap memverifikasi state per mesin sebelum command dibuat.</p>
          </div>
          <button type="button" disabled={busy !== null} onClick={() => void load()} className="inline-flex h-9 items-center gap-2 rounded-xl border border-border px-3 text-xs font-semibold disabled:opacity-50"><RefreshCw className="h-3.5 w-3.5" /> Muat ulang</button>
        </div>
        {notice ? <div className="mt-4 rounded-xl border border-success-line bg-success-soft p-3 text-xs text-success-ink">{notice}</div> : null}
        {error ? <div className="mt-4 rounded-xl border border-danger-line bg-danger-soft p-3 text-xs text-danger-ink">{error}</div> : null}
      </section>

      <section className="rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
        <h3 className="text-sm font-bold text-brand-heading">Handshake & PUSH evidence</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl bg-surface p-3"><div className="text-[11px] text-muted-foreground">Last registration</div><div className="mt-1 text-xs font-semibold">{fmt(evidence?.evidence.lastRegistrationAt ?? null)}</div></div>
          <div className="rounded-xl bg-surface p-3"><div className="text-[11px] text-muted-foreground">Last heartbeat/getrequest</div><div className="mt-1 text-xs font-semibold">{fmt(evidence?.evidence.lastHeartbeatAt ?? null)}</div></div>
          <div className="rounded-xl bg-surface p-3"><div className="text-[11px] text-muted-foreground">Observed PushProtVer</div><div className="mt-1 font-mono text-xs font-semibold">{evidence?.evidence.observedPushProtocolVersion ?? "—"}</div></div>
          <div className={`rounded-xl p-3 ${evidence?.pushProfile.idleAttendanceOnly ? "bg-success-soft" : "bg-warning-soft"}`}><div className="text-[11px] text-muted-foreground">Idle transfer profile</div><div className="mt-1 text-xs font-semibold">{evidence?.pushProfile.idleAttendanceOnly ? "ATTLOG-only" : "Canary flag aktif"}</div></div>
        </div>
        <div className="mt-3 text-xs leading-5 text-muted-foreground">Base TransFlag: {evidence?.pushProfile.baseTransferFlags.join(" + ") ?? "TransData + AttLog"}. USERINFO reads retired: ya. Arbitrary command: tidak.</div>
      </section>

      <section className="rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
        <h3 className="text-sm font-bold text-brand-heading">Capability matrix</h3>
        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {matrix?.capabilities.map((item) => <div key={item.key} className={`rounded-xl border p-3 ${capabilityClass(item.state)}`}><div className="text-xs font-bold">{item.label}</div><div className="mt-1 font-mono text-[10px]">{item.key}</div><div className="mt-2 text-[11px]">{item.state}{item.lastResultCode === null ? "" : ` · RC ${item.lastResultCode}`}</div></div>)}
        </div>
      </section>

      <section className="rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
        <h3 className="text-sm font-bold text-brand-heading">Low-risk typed operations</h3>
        <p className="mt-1 text-xs text-muted-foreground">Belum verified = canary; verified = execute. Tidak ada command bebas dan `canary_pending` dikunci sampai result terminal. Server ADMS hanya dapat menulis ulang target ingress yang disetujui server.</p>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-border p-4"><div className="flex items-center justify-between gap-2"><div className="text-xs font-bold">Time sync</div><span className="text-[10px] font-semibold text-muted-foreground">{stateFor("time_sync")} · {timeMode}</span></div><div className="mt-2 font-mono text-[10px] text-muted-foreground">SYNC TIME {serial}</div><button type="button" disabled={busy !== null || !serial || actionLocked("time_sync")} onClick={() => void run("time", timeMode, () => activeTimeSync(deviceId, `SYNC TIME ${serial}`, timeMode))} className="mt-3 h-9 rounded-xl bg-brand-primary px-3 text-xs font-semibold text-brand-foreground disabled:opacity-50">{timeMode === "execute" ? "Sinkronkan waktu" : "Canary time sync"}</button></div>
          <div className="rounded-xl border border-border p-4"><div className="flex items-center justify-between gap-2"><div className="text-xs font-bold">Duplicate punch period</div><span className="text-[10px] font-semibold text-muted-foreground">{stateFor("duplicate_punch_period")} · {duplicateMode}</span></div><input type="number" min={0} max={86400} value={duplicateSeconds} onChange={(event) => setDuplicateSeconds(Number(event.target.value))} className="mt-2 h-9 w-full rounded-xl border border-border px-3 text-sm" /><div className="mt-2 font-mono text-[10px] text-muted-foreground">SET DUPLICATE {serial} {duplicateSeconds}</div><button type="button" disabled={busy !== null || !serial || actionLocked("duplicate_punch_period")} onClick={() => void run("duplicate", duplicateMode, () => setDuplicatePunch(deviceId, duplicateSeconds, `SET DUPLICATE ${serial} ${duplicateSeconds}`, duplicateMode))} className="mt-3 h-9 rounded-xl border border-border px-3 text-xs font-semibold disabled:opacity-50">{duplicateMode === "execute" ? "Set duplicate period" : "Canary + restore manually"}</button></div>
          <div className="rounded-xl border border-border p-4 lg:col-span-2"><div className="text-xs font-bold">Explicit employee.id → PIN user lifecycle</div><input value={employeeId} onChange={(event) => { setEmployeeId(event.target.value.trim()); setBiometricEnrollConfirmation(""); }} placeholder="employee UUID (bukan NIP/nama/PIN)" className="mt-2 h-9 w-full rounded-xl border border-border px-3 text-sm" /><div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={busy !== null || !serial || !employeeId || actionLocked("user_profile_upsert")} onClick={() => void run("user-profile", userProfileMode, () => pushUserProfile(deviceId, employeeId, 1, `UPSERT USER ${serial} ${employeeId}`, userProfileMode))} className="h-9 rounded-xl border border-border px-3 text-xs font-semibold disabled:opacity-50">{userProfileMode === "execute" ? "Push profile" : "Canary push profile"}</button><button type="button" disabled={busy !== null || !serial || !employeeId || actionLocked("user_enable_disable")} onClick={() => void run("user-disable", userEnabledMode, () => setUserEnabled(deviceId, employeeId, false, `DISABLE USER ${serial} ${employeeId}`, userEnabledMode))} className="h-9 rounded-xl border border-warning-line bg-warning-soft px-3 text-xs font-semibold text-warning-ink disabled:opacity-50">{userEnabledMode === "execute" ? "Disable non-destructive" : "Canary disable"}</button><button type="button" disabled={busy !== null || !serial || !employeeId || actionLocked("user_enable_disable")} onClick={() => void run("user-enable", userEnabledMode, () => setUserEnabled(deviceId, employeeId, true, `ENABLE USER ${serial} ${employeeId}`, userEnabledMode))} className="h-9 rounded-xl border border-border px-3 text-xs font-semibold disabled:opacity-50">{userEnabledMode === "execute" ? "Enable" : "Canary enable"}</button></div><div className="mt-2 text-[11px] text-muted-foreground">Tidak pernah menggunakan DATA DELETE user; leading-zero PIN tetap berasal dari mapping eksplisit.</div></div>
          <div className="rounded-xl border border-border p-4"><div className="flex items-center justify-between gap-2"><div className="text-xs font-bold">NTP</div><span className="text-[10px] font-semibold text-muted-foreground">{stateFor("ntp_config")} · {ntpMode}</span></div><input value={ntpHost} onChange={(event) => setNtpHost(event.target.value)} className="mt-2 h-9 w-full rounded-xl border border-border px-3 text-sm" /><button type="button" disabled={busy !== null || !serial || !ntpHost || actionLocked("ntp_config")} onClick={() => void run("ntp", ntpMode, () => setNtp(deviceId, ntpHost, `SET NTP ${serial} ${ntpHost}`, ntpMode))} className="mt-3 h-9 rounded-xl border border-border px-3 text-xs font-semibold disabled:opacity-50">{ntpMode === "execute" ? "Set NTP" : "Canary NTP"}</button></div>
          <div className="rounded-xl border border-border p-4"><div className="flex items-center justify-between gap-2"><div className="text-xs font-bold">ADMS server safe rewrite</div><span className="text-[10px] font-semibold text-muted-foreground">{stateFor("server_config")} · {serverMode}</span></div><div className="mt-2 grid grid-cols-[1fr_6rem] gap-2"><input value={serverHost} readOnly aria-label="Approved ADMS server host" className="h-9 rounded-xl border border-border bg-surface px-3 text-sm" /><input type="number" value={serverPort} readOnly aria-label="Approved ADMS server port" className="h-9 rounded-xl border border-border bg-surface px-3 text-sm" /></div><div className="mt-2 font-mono text-[10px] text-muted-foreground">{serverPhrase || "Approved server target belum tersedia"}</div><input value={serverConfirmation} onChange={(event) => setServerConfirmation(event.target.value)} placeholder="Ketik phrase server di atas persis" className="mt-2 h-9 w-full rounded-xl border border-border px-3 text-sm" /><button type="button" disabled={busy !== null || !serial || !serverHost || actionLocked("server_config") || serverConfirmation !== serverPhrase} onClick={() => { const confirmation = serverConfirmation; setServerConfirmation(""); void run("server", serverMode, () => setServer(deviceId, serverHost, serverPort, confirmation, serverMode)); }} className="mt-3 h-9 rounded-xl border border-border px-3 text-xs font-semibold disabled:opacity-50">{serverMode === "execute" ? "Set approved server" : "Canary approved server"}</button><div className="mt-2 text-[11px] text-muted-foreground">Host/port bukan input bebas: API hanya mengembalikan target ingress yang disetujui dan backend menolak target lain pada canary maupun execute.</div></div>
          <div className="rounded-xl border border-border p-4"><div className="flex items-center justify-between gap-2"><div className="text-xs font-bold">Reboot</div><span className="text-[10px] font-semibold text-muted-foreground">{stateFor("reboot")} · {rebootMode}</span></div><button type="button" disabled={busy !== null || !serial || actionLocked("reboot")} onClick={() => void run("reboot", rebootMode, () => rebootDevice(deviceId, `REBOOT ${serial}`, rebootMode))} className="mt-3 h-9 rounded-xl border border-border px-3 text-xs font-semibold disabled:opacity-50">{rebootMode === "execute" ? "Reboot" : "Canary reboot"}</button></div>
        </div>
      </section>

      <section className={`rounded-2xl border p-5 shadow-[var(--shadow-soft)] ${biometricGateReady ? "border-warning-line bg-warning-soft/40" : "border-border bg-muted"}`}>
        <div className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-4 w-4" /><div><h3 className="text-sm font-bold">Biometric maintenance</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">Gate: global {matrix?.biometricGate.globalCollectionEnabled ? "ON" : "OFF"} · device {matrix?.biometricGate.deviceCollectionEnabled ? "ON" : "OFF"} · keyring {matrix?.biometricGate.keyringReady ? "READY" : "NOT READY"}. Raw template/ciphertext/hash/IV/tag/key tidak dirender. Verified capability tidak pernah melewati gate ini. Enrollment/restore/delete juga membutuhkan human-entered phrase.</p></div></div>
        <fieldset disabled={!biometricGateReady || busy !== null} className="mt-4 grid gap-3 disabled:opacity-50 lg:grid-cols-2">
          <div><input value={employeeId} onChange={(event) => { setEmployeeId(event.target.value.trim()); setBiometricEnrollConfirmation(""); }} placeholder="employee UUID" className="h-9 w-full rounded-xl border border-border px-3 text-sm" /><div className="mt-2 grid grid-cols-3 gap-2"><select value={biometricProtocol} onChange={(event) => setBiometricProtocol(event.target.value as "legacy_fingerprint" | "unified")} className="h-9 rounded-xl border border-border px-2 text-xs"><option value="legacy_fingerprint">legacy FP</option><option value="unified">unified</option></select><input type="number" value={biometricType} onChange={(event) => setBiometricType(Number(event.target.value))} className="h-9 rounded-xl border border-border px-2 text-xs" /><input type="number" min={0} max={255} value={slotIndex} onChange={(event) => setSlotIndex(Number(event.target.value))} className="h-9 rounded-xl border border-border px-2 text-xs" /></div><div className="mt-2 flex gap-2"><button type="button" disabled={!employeeId || actionLocked("biometric_query")} onClick={() => void run("bio-query", biometricQueryMode, () => queryBiometric(deviceId, { employeeId, protocol: biometricProtocol, biometricType, slotIndex, mode: biometricQueryMode }))} className="h-9 rounded-xl border border-border px-3 text-xs font-semibold disabled:opacity-50">{biometricQueryMode === "execute" ? "Query" : "Canary query"}</button></div><div className="mt-3 font-mono text-[10px] text-muted-foreground">{enrollPhrase || "Pilih employee UUID untuk enrollment"}</div><input value={biometricEnrollConfirmation} onChange={(event) => setBiometricEnrollConfirmation(event.target.value)} placeholder="Ketik phrase enrollment persis" className="mt-2 h-9 w-full rounded-xl border border-border px-3 text-sm" /><button type="button" disabled={!employeeId || actionLocked("biometric_enrollment") || biometricEnrollConfirmation !== enrollPhrase} onClick={() => { const confirmation = biometricEnrollConfirmation; setBiometricEnrollConfirmation(""); void run("bio-enroll", biometricEnrollmentMode, () => enrollBiometric(deviceId, { employeeId, protocol: biometricProtocol, biometricType, slotIndex, confirmation, mode: biometricEnrollmentMode })); }} className="mt-2 h-9 rounded-xl border border-border px-3 text-xs font-semibold disabled:opacity-50">{biometricEnrollmentMode === "execute" ? "Enroll" : "Canary enroll"}</button></div>
          <div><input value={credentialId} onChange={(event) => { setCredentialId(event.target.value.trim()); setBiometricCredentialConfirmation(""); }} placeholder="credential UUID (vault reference only)" className="h-9 w-full rounded-xl border border-border px-3 text-sm" /><div className="mt-2 space-y-1 font-mono text-[10px] text-muted-foreground"><div>{restorePhrase || "Pilih credential UUID untuk restore"}</div><div>{deleteBiometricPhrase || "Pilih credential UUID untuk delete"}</div></div><input value={biometricCredentialConfirmation} onChange={(event) => setBiometricCredentialConfirmation(event.target.value)} placeholder="Ketik salah satu phrase di atas persis" className="mt-2 h-9 w-full rounded-xl border border-border px-3 text-sm" /><div className="mt-2 flex gap-2"><button type="button" disabled={!credentialId || actionLocked("biometric_restore") || biometricCredentialConfirmation !== restorePhrase} onClick={() => { const confirmation = biometricCredentialConfirmation; setBiometricCredentialConfirmation(""); void run("bio-restore", biometricRestoreMode, () => restoreBiometric(deviceId, credentialId, confirmation, biometricRestoreMode)); }} className="h-9 rounded-xl border border-border px-3 text-xs font-semibold disabled:opacity-50">{biometricRestoreMode === "execute" ? "Restore/distribute" : "Canary restore"}</button><button type="button" disabled={!credentialId || actionLocked("biometric_delete") || biometricCredentialConfirmation !== deleteBiometricPhrase} onClick={() => { const confirmation = biometricCredentialConfirmation; setBiometricCredentialConfirmation(""); void run("bio-delete", biometricDeleteMode, () => deleteBiometric(deviceId, credentialId, confirmation, biometricDeleteMode)); }} className="h-9 rounded-xl border border-danger-line bg-danger-soft px-3 text-xs font-semibold text-danger-ink disabled:opacity-50">{biometricDeleteMode === "execute" ? "Delete selected" : "Canary delete"}</button></div></div>
        </fieldset>
      </section>

      <section className="rounded-2xl border border-warning-line bg-warning-soft/40 p-5 shadow-[var(--shadow-soft)]">
        <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-bold text-warning-ink">Firmware — explicit target, canary first</h3><span className="text-[10px] font-semibold text-warning-ink">{stateFor("firmware_upgrade")} · {firmwareMode}</span></div>
        <select value={firmwarePackageId} onChange={(event) => { setFirmwarePackageId(event.target.value); setFirmwareConfirmation(""); }} className="mt-3 h-9 w-full rounded-xl border border-warning-line bg-surface-raised px-3 text-sm"><option value="">Pilih package yang model-nya cocok…</option>{packages.map((item) => <option key={item.id} value={item.id}>{item.targetModel} → {item.targetVersion} · {item.filename}</option>)}</select>
        {selectedFirmware ? <><div className="mt-2 font-mono text-[10px] text-warning-ink">{firmwarePhrase}</div><input value={firmwareConfirmation} onChange={(event) => setFirmwareConfirmation(event.target.value)} placeholder="Ketik phrase firmware persis" className="mt-2 h-9 w-full rounded-xl border border-warning-line bg-surface-raised px-3 text-sm" /><button type="button" disabled={busy !== null || !serial || actionLocked("firmware_upgrade") || firmwareConfirmation !== firmwarePhrase} onClick={() => { const confirmation = firmwareConfirmation; setFirmwareConfirmation(""); void run("firmware", firmwareMode, () => upgradeFirmware(deviceId, selectedFirmware.id, confirmation, firmwareMode)); }} className="mt-3 h-9 rounded-xl bg-warning-ink px-3 text-xs font-semibold text-surface-raised disabled:opacity-50">{firmwareMode === "execute" ? "Upgrade firmware" : "Queue firmware canary"}</button></> : null}
        <p className="mt-2 text-[11px] text-warning-ink">Tidak ada broadcast. Backend mengikat package ke model mesin dan short-lived download ticket; operator harus mengetik phrase exact sebelum request dikirim.</p>
      </section>

      <section className="rounded-2xl border border-danger-line bg-danger-soft/50 p-5 shadow-[var(--shadow-soft)]">
        <h3 className="text-sm font-bold text-danger-ink">Danger zone / break-glass</h3>
        <p className="mt-1 text-xs leading-5 text-danger-ink">Destructive capability harus paling akhir. Tombol tetap disabled sampai operator mengetik salah satu phrase exact di bawah; backend authorization, DB rate-limit, verified-only execute, dan HCIS raw-history preservation tetap wajib.</p>
        <div className="mt-3 space-y-1 font-mono text-[10px] text-danger-ink"><div>{clearAttendancePhrase}</div><div>{clearPhotoPhrase}</div><div>{clearAllPhrase}</div></div><input value={destructiveConfirmation} onChange={(event) => setDestructiveConfirmation(event.target.value)} placeholder="Ketik salah satu phrase break-glass di atas persis" className="mt-3 h-9 w-full rounded-xl border border-danger-line bg-surface-raised px-3 text-sm" />
        <div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={busy !== null || !serial || actionLocked("clear_attendance") || destructiveConfirmation !== clearAttendancePhrase} onClick={() => { const confirmation = destructiveConfirmation; setDestructiveConfirmation(""); void run("clear-att", clearAttendanceMode, () => clearPhysicalData(deviceId, "clear-attendance", confirmation, clearAttendanceMode)); }} className="h-9 rounded-xl border border-danger-line bg-surface-raised px-3 text-xs font-semibold text-danger-ink disabled:opacity-50">{clearAttendanceMode === "execute" ? "CLEAR ATTENDANCE" : "CANARY CLEAR ATTENDANCE"}</button><button type="button" disabled={busy !== null || !serial || actionLocked("clear_photo_cache") || destructiveConfirmation !== clearPhotoPhrase} onClick={() => { const confirmation = destructiveConfirmation; setDestructiveConfirmation(""); void run("clear-photo", clearPhotoMode, () => clearPhysicalData(deviceId, "clear-photo", confirmation, clearPhotoMode)); }} className="h-9 rounded-xl border border-danger-line bg-surface-raised px-3 text-xs font-semibold text-danger-ink disabled:opacity-50">{clearPhotoMode === "execute" ? "CLEAR PHOTO" : "CANARY CLEAR PHOTO"}</button><button type="button" disabled={busy !== null || !serial || actionLocked("clear_all_data") || destructiveConfirmation !== clearAllPhrase} onClick={() => { const confirmation = destructiveConfirmation; setDestructiveConfirmation(""); void run("clear-all", clearAllMode, () => clearPhysicalData(deviceId, "clear-all", confirmation, clearAllMode)); }} className="h-9 rounded-xl bg-danger-ink px-3 text-xs font-semibold text-surface-raised disabled:opacity-50">{clearAllMode === "execute" ? "CLEAR ALL DATA" : "CANARY CLEAR ALL DATA"}</button></div>
      </section>

      <section className="rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
        <h3 className="text-sm font-bold text-brand-heading">Evidence classification & exports</h3>
        <div className="mt-3 grid gap-2 md:grid-cols-[1fr_10rem_2fr_auto]"><select value={classificationKey} onChange={(event) => setClassificationKey(event.target.value)} className="h-9 rounded-xl border border-border px-2 text-xs">{matrix?.capabilities.map((item) => <option key={item.key} value={item.key}>{item.key}</option>)}</select><select value={classificationState} onChange={(event) => setClassificationState(event.target.value as "unsupported" | "blocked")} className="h-9 rounded-xl border border-border px-2 text-xs"><option value="unsupported">unsupported</option><option value="blocked">blocked</option></select><input value={classificationNote} onChange={(event) => setClassificationNote(event.target.value)} placeholder="Evidence note hasil physical canary" className="h-9 rounded-xl border border-border px-3 text-sm" /><button type="button" disabled={busy !== null || !classificationKey || !classificationNote.trim()} onClick={() => void run("classify", null, () => markCapabilityUnsupportedOrBlocked(deviceId, { capabilityKey: classificationKey, state: classificationState, note: classificationNote.trim(), confirmation: `${classificationState.toUpperCase()} ${classificationKey} ${serial}` }))} className="h-9 rounded-xl border border-border px-3 text-xs font-semibold disabled:opacity-50">Simpan evidence</button></div>
        <div className="mt-4 flex flex-wrap gap-2">{Object.entries(exports).map(([key, href]) => <a key={key} href={href} className="inline-flex h-9 items-center gap-2 rounded-xl border border-border px-3 text-xs font-semibold"><Download className="h-3.5 w-3.5" />{key}</a>)}</div>
      </section>

      <section className="rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
        <h3 className="text-sm font-bold text-brand-heading">Physical operation history</h3>
        <div className="mt-3 overflow-x-auto"><table className="min-w-full text-left text-xs"><thead><tr className="border-b border-border text-muted-foreground"><th className="px-2 py-2">Waktu</th><th className="px-2 py-2">Capability</th><th className="px-2 py-2">Operation</th><th className="px-2 py-2">Mode</th><th className="px-2 py-2">Status</th><th className="px-2 py-2">RC</th></tr></thead><tbody>{history.map((item) => <tr key={item.id} className="border-b border-border/60"><td className="px-2 py-2 whitespace-nowrap">{fmt(item.createdAt)}</td><td className="px-2 py-2 font-mono text-[10px]">{item.capabilityKey}</td><td className="px-2 py-2">{item.operationKey}</td><td className="px-2 py-2">{item.mode}</td><td className="px-2 py-2">{item.status}</td><td className="px-2 py-2">{item.lastReturnCode ?? "—"}</td></tr>)}</tbody></table></div>
        <p className="mt-3 text-[11px] text-muted-foreground">History tidak merender raw wire command, template biometric, ciphertext, IV, auth tag, key ID, maupun firmware token.</p>
      </section>
    </div>
  );
}
