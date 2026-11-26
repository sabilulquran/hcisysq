export type BiometricModality = "fingerprint" | "face" | "palm" | "bio_photo";
export type BiometricCapabilityState = "available" | "blocked" | "not_verified";

export interface BiometricCapability {
  key: string;
  label: string;
  state: BiometricCapabilityState;
  reason: string | null;
  deviceCommandRequired: boolean;
}

export interface BiometricControlPlaneSummary {
  rawPayloadExposed: false;
  collection: {
    globalEnabled: boolean;
    deviceEnabled: boolean | null;
    effectiveEnabled: boolean;
  };
  keyring: {
    configured: boolean;
    ready: boolean;
    configuredKeyCount: number;
  };
  vault: {
    totalCount: number;
    activeCount: number;
    retiredCount: number;
    destroyedCount: number;
    employeeCount: number;
    fingerprintCount: number;
    faceCount: number;
    palmCount: number;
    bioPhotoCount: number;
    lifecycleReviewRequiredCount: number;
    rotationRequiredCount: number | null;
  };
  replica: {
    inventorySemantics: "known_replica_state";
    absenceMeansMissing: false;
    unknownCount: number;
    missingCount: number;
    presentCount: number;
    staleCount: number;
    conflictCount: number;
    pendingCount: number;
    succeededCount: number;
    failedCount: number;
  };
  device: {
    id: string;
    serialNumber: string;
    displayName: string | null;
    model: string | null;
    firmwareVersion: string | null;
    lifecycle: string;
  } | null;
  capabilities: BiometricCapability[];
  retention: {
    automaticDestructionEnabled: false;
    inactiveEmployeeAction: "review_only";
    masterDestroyEnabled: false;
    note: string;
  };
}

export interface BiometricCredentialItem {
  id: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  employeeStatus: "active" | "inactive" | "resigned";
  modality: BiometricModality;
  slotIndex: number | null;
  vendorFormat: string;
  vendorVersion: string | null;
  originDeviceId: string | null;
  originDeviceSerial: string | null;
  capturedAt: string | null;
  importedAt: string;
  lifecycle: "active" | "retired" | "destroyed";
  payloadByteLength: number | null;
  envelopeVersion: string;
  lastReencryptedAt: string | null;
  lifecycleReviewRequired: boolean;
}

export interface BiometricCredentialPage {
  rawPayloadExposed: false;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  items: BiometricCredentialItem[];
}

export interface BiometricReplicaItem {
  credentialId: string;
  state: "unknown" | "missing" | "present" | "stale" | "conflict" | "pending" | "succeeded" | "failed";
  deviceVendorFormat: string | null;
  observedAt: string | null;
  lastSyncedAt: string | null;
  lastErrorCode: string | null;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  modality: BiometricModality;
  slotIndex: number | null;
  vaultVendorFormat: string;
  vaultVendorVersion: string | null;
  credentialLifecycle: "active" | "retired" | "destroyed";
}

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as T | { message?: string } | null;
  if (response.ok) return body as T;
  throw new Error((body as { message?: string } | null)?.message ?? "Control plane biometric tidak dapat diproses.");
}

export async function getBiometricControlPlane(deviceId: string) {
  const params = new URLSearchParams({ deviceId });
  const result = await readJson<{ item: BiometricControlPlaneSummary }>(
    await fetch(`/api/admin/attendance/adms/biometric-control-plane?${params}`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    }),
  );
  return result.item;
}

export async function listBiometricCredentials(input: {
  deviceId: string;
  page: number;
  pageSize: number;
  modality?: BiometricModality;
  lifecycleReviewOnly?: boolean;
}) {
  const params = new URLSearchParams({
    originDeviceId: input.deviceId,
    page: String(input.page),
    pageSize: String(input.pageSize),
  });
  if (input.modality) params.set("modality", input.modality);
  if (input.lifecycleReviewOnly) params.set("lifecycleReviewOnly", "true");
  return readJson<BiometricCredentialPage>(
    await fetch(`/api/admin/attendance/adms/biometric-control-plane/credentials?${params}`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    }),
  );
}

export async function listBiometricReplicaInventory(deviceId: string) {
  return readJson<{ inventorySemantics: "known_replica_state"; rawPayloadExposed: false; items: BiometricReplicaItem[] }>(
    await fetch(`/api/admin/attendance/adms/devices/${deviceId}/biometric-inventory`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    }),
  );
}

export async function reencryptBiometricVault(limit = 25) {
  return readJson<{ rawPayloadExposed: false; processedCount: number; remainingCount: number }>(
    await fetch("/api/admin/attendance/adms/biometric-control-plane/reencrypt", {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: "REENCRYPT_VAULT", limit }),
    }),
  );
}

export function biometricModalityLabel(modality: BiometricModality) {
  if (modality === "fingerprint") return "Sidik jari";
  if (modality === "face") return "Wajah";
  if (modality === "palm") return "Telapak";
  return "Foto biometrik";
}

export function biometricCapabilityStateLabel(state: BiometricCapabilityState) {
  if (state === "available") return "Tersedia";
  if (state === "blocked") return "Diblokir";
  return "Belum terverifikasi";
}

export function biometricCapabilityReason(reason: string | null) {
  if (!reason) return null;
  if (reason === "global_collection_off") return "Koleksi global OFF";
  if (reason === "device_collection_off") return "Koleksi mesin OFF";
  if (reason === "device_not_active") return "Lifecycle mesin tidak aktif";
  if (reason === "device_context_required") return "Pilih konteks mesin";
  if (reason === "biometric_keyring_not_configured") return "Keyring maintenance belum siap";
  if (reason === "physical_protocol_not_verified") return "Protokol fisik belum dibuktikan aman";
  if (reason === "retention_policy_pending") return "Kebijakan retensi/destruction belum disetujui";
  return reason.replaceAll("_", " ");
}

/**
 * What the machine itself reports about one template. The operator comes to the device page for
 * this fact: whether the fingerprint is really on the machine, not whether HCIS has a copy.
 */
export function biometricReplicaLabel(value: BiometricReplicaItem["state"]) {
  if (value === "present" || value === "succeeded") return "Ada di mesin";
  if (value === "pending") return "Sedang disinkronkan";
  if (value === "failed") return "Sinkronisasi gagal";
  if (value === "conflict") return "Berbeda dengan HCIS";
  if (value === "missing") return "Belum ada di mesin";
  if (value === "stale") return "Perlu diperbarui";
  return "Belum diketahui";
}

export interface BiometricTemplateRow {
  key: string;
  label: string;
  slot: number | null;
  /** What HCIS holds. */
  vault: string;
  /** What the machine reports, or null when the machine has said nothing about it. */
  machine: BiometricReplicaItem["state"] | null;
}

/**
 * One row per template, pairing the HCIS side with the machine side. Both are shown because a
 * credential HCIS stores can still be missing from the machine — reading only the vault side
 * reported every template as stored, which is how a failed sync stayed invisible.
 */
export function biometricTemplateRows(
  credentials: BiometricCredentialItem[],
  replicas: BiometricReplicaItem[],
): BiometricTemplateRow[] {
  const byCredential = new Map(replicas.map((replica) => [replica.credentialId, replica]));
  const rows: BiometricTemplateRow[] = credentials.map((credential) => ({
    key: credential.id,
    label: biometricModalityLabel(credential.modality),
    slot: credential.slotIndex,
    vault: credential.lifecycle === "active" ? "Tersimpan di HCIS" : "Tidak aktif di HCIS",
    machine: byCredential.get(credential.id)?.state ?? null,
  }));
  for (const replica of replicas) {
    if (credentials.some((credential) => credential.id === replica.credentialId)) continue;
    rows.push({
      key: `${replica.credentialId}:${replica.state}`,
      label: biometricModalityLabel(replica.modality),
      slot: replica.slotIndex,
      vault: "Tidak ada di HCIS",
      machine: replica.state,
    });
  }
  return rows;
}

/** Templates the machine does not hold as HCIS expects: the count an operator acts on. */
export function biometricAttentionCount(replicas: BiometricReplicaItem[]) {
  return replicas.filter((replica) => replica.state !== "present" && replica.state !== "succeeded").length;
}
