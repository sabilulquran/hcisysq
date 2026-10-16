import { useCallback, useEffect, useState } from "react";

import { useDeviceAdmin } from "@/components/attendance/device-admin/DeviceAdminContext";
import {
  enableAttendancePhotoCanary,
  getPhysicalCapabilityMatrix,
  syncPhysicalMessage,
  syncPhysicalWorkCode,
  uploadFirmwarePackage,
  type PhysicalCapabilityMatrix,
  type PhysicalMode,
} from "@/lib/admsPhysicalParity";

export function AdminAdmsDevicePhysicalDeliveryPanel() {
  const { deviceId, detail } = useDeviceAdmin();
  const serial = detail?.item.serialNumber ?? "";
  const model = detail?.item.model ?? "";
  const [matrix, setMatrix] = useState<PhysicalCapabilityMatrix | null>(null);
  const [workCodeId, setWorkCodeId] = useState("");
  const [messageId, setMessageId] = useState("");
  const [attendancePhotoConfirmation, setAttendancePhotoConfirmation] = useState("");
  const [firmwareVersion, setFirmwareVersion] = useState("");
  const [firmwareFile, setFirmwareFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadMatrix = useCallback(async () => {
    setMatrix(await getPhysicalCapabilityMatrix(deviceId));
  }, [deviceId]);

  useEffect(() => {
    void loadMatrix().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Capability evidence tidak dapat dimuat.");
    });
  }, [loadMatrix]);

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

  async function run(work: () => Promise<unknown>, message: string) {
    setBusy(true);
    try {
      await work();
      setNotice(message);
      setError(null);
      await loadMatrix();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Operasi physical delivery gagal.");
    } finally {
      setBusy(false);
    }
  }

  const workMode = modeFor("work_code_delivery");
  const messageMode = modeFor("message_delivery");
  const attendancePhotoPhrase = serial ? `ENABLE ATTPHOTO CANARY ${serial}` : "";

  return (
    <section className="mt-4 rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]" id="physical-delivery-controls">
      <h3 className="text-sm font-bold text-brand-heading">Physical delivery controls</h3>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        Gunakan ID catalog HCIS yang sudah dibuat pada workspace di atas. Semua action tetap typed dan target-device explicit. Capability yang belum verified berjalan sebagai canary; setelah verified, aksi berikutnya memakai execute dan backend tetap memverifikasi state lagi.
      </p>
      {notice ? <div className="mt-3 rounded-xl border border-success-line bg-success-soft p-3 text-xs text-success-ink">{notice}</div> : null}
      {error ? <div className="mt-3 rounded-xl border border-danger-line bg-danger-soft p-3 text-xs text-danger-ink">{error}</div> : null}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border p-4">
          <div className="flex items-center justify-between gap-2"><div className="text-xs font-bold">Work Code delivery</div><span className="rounded-full bg-muted px-2 py-1 text-[10px] font-semibold">{stateFor("work_code_delivery")} · {workMode}</span></div>
          <input value={workCodeId} onChange={(event) => setWorkCodeId(event.target.value.trim())} placeholder="Work Code UUID" className="mt-2 h-9 w-full rounded-xl border border-border px-3 text-sm" />
          <div className="mt-2 flex gap-2">
            <button type="button" disabled={busy || !workCodeId || actionLocked("work_code_delivery")} onClick={() => void run(() => syncPhysicalWorkCode(deviceId, workCodeId, "present", workMode), `Work Code upsert ${workMode} di-queue.`)} className="h-9 rounded-xl border border-border px-3 text-xs font-semibold disabled:opacity-50">{workMode === "execute" ? "Upsert" : "Canary upsert"}</button>
            <button type="button" disabled={busy || !workCodeId || actionLocked("work_code_delivery")} onClick={() => void run(() => syncPhysicalWorkCode(deviceId, workCodeId, "absent", workMode), `Work Code delete ${workMode} di-queue.`)} className="h-9 rounded-xl border border-border px-3 text-xs font-semibold disabled:opacity-50">{workMode === "execute" ? "Delete" : "Canary delete"}</button>
          </div>
        </div>

        <div className="rounded-xl border border-border p-4">
          <div className="flex items-center justify-between gap-2"><div className="text-xs font-bold">Public/private message delivery</div><span className="rounded-full bg-muted px-2 py-1 text-[10px] font-semibold">{stateFor("message_delivery")} · {messageMode}</span></div>
          <input value={messageId} onChange={(event) => setMessageId(event.target.value.trim())} placeholder="Message UUID" className="mt-2 h-9 w-full rounded-xl border border-border px-3 text-sm" />
          <div className="mt-2 flex gap-2">
            <button type="button" disabled={busy || !messageId || actionLocked("message_delivery")} onClick={() => void run(() => syncPhysicalMessage(deviceId, messageId, "present", messageMode), `Message delivery ${messageMode} di-queue.`)} className="h-9 rounded-xl border border-border px-3 text-xs font-semibold disabled:opacity-50">{messageMode === "execute" ? "Deliver" : "Canary deliver"}</button>
            <button type="button" disabled={busy || !messageId || actionLocked("message_delivery")} onClick={() => void run(() => syncPhysicalMessage(deviceId, messageId, "absent", messageMode), `Message delete ${messageMode} di-queue.`)} className="h-9 rounded-xl border border-border px-3 text-xs font-semibold disabled:opacity-50">{messageMode === "execute" ? "Delete" : "Canary delete"}</button>
          </div>
        </div>

        <div className="rounded-xl border border-border p-4">
          <div className="flex items-center justify-between gap-2"><div className="text-xs font-bold">Attendance photo ingress</div><span className="rounded-full bg-muted px-2 py-1 text-[10px] font-semibold">{stateFor("attendance_photo")} · canary only</span></div>
          <div className="mt-2 font-mono text-[10px] text-muted-foreground">{attendancePhotoPhrase}</div>
          <input value={attendancePhotoConfirmation} onChange={(event) => setAttendancePhotoConfirmation(event.target.value)} placeholder="Ketik phrase attendance-photo persis" className="mt-2 h-9 w-full rounded-xl border border-border px-3 text-sm" />
          <button type="button" disabled={busy || !serial || actionLocked("attendance_photo") || attendancePhotoConfirmation !== attendancePhotoPhrase} onClick={() => { const confirmation = attendancePhotoConfirmation; setAttendancePhotoConfirmation(""); void run(() => enableAttendancePhotoCanary(deviceId, confirmation), "Attendance-photo canary dibuka untuk target device."); }} className="mt-3 h-9 rounded-xl border border-border px-3 text-xs font-semibold disabled:opacity-50">Enable one-device canary</button>
          <p className="mt-2 text-[11px] text-muted-foreground">Attendance-photo tetap canary-only, dikunci saat pending/unsupported/blocked, dan membutuhkan human-entered phrase. Backend juga menolak bila restricted-media keyring belum siap; upload disimpan terenkripsi.</p>
        </div>

        <div className="rounded-xl border border-warning-line bg-warning-soft/40 p-4">
          <div className="text-xs font-bold text-warning-ink">Firmware package upload</div>
          <div className="mt-1 text-[11px] text-warning-ink">Target model dikunci ke model device saat ini: <span className="font-mono">{model || "belum terobservasi"}</span>.</div>
          <input value={firmwareVersion} onChange={(event) => setFirmwareVersion(event.target.value.trim())} placeholder="Target firmware version" className="mt-2 h-9 w-full rounded-xl border border-warning-line bg-surface-raised px-3 text-sm" />
          <input type="file" onChange={(event) => setFirmwareFile(event.target.files?.[0] ?? null)} className="mt-2 block w-full text-xs" />
          <button type="button" disabled={busy || !model || !firmwareVersion || !firmwareFile} onClick={() => void run(() => uploadFirmwarePackage({ file: firmwareFile!, targetModel: model, targetVersion: firmwareVersion }), "Firmware package tersimpan. Muat ulang panel parity untuk memilih package pada upgrade." )} className="mt-3 h-9 rounded-xl bg-warning-ink px-3 text-xs font-semibold text-surface-raised disabled:opacity-50">Upload model-bound package</button>
          <p className="mt-2 text-[11px] text-warning-ink">Upload package tidak mengirim command device. Upgrade tetap explicit-target, canary-first, dan hanya berpindah ke execute setelah capability verified.</p>
        </div>
      </div>
    </section>
  );
}
