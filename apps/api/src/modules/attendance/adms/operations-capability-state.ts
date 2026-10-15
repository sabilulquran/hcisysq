import type { Pool, PoolClient } from "pg";

import type { PhysicalCapabilityKey } from "./physical-parity-protocol.js";

export type PhysicalCapabilityState =
  | "documented"
  | "canary_pending"
  | "verified"
  | "failed"
  | "unsupported"
  | "blocked";

export type OperationsCapabilityState = "available" | "not_verified" | "blocked";
export type OperationsExecution = "device" | "hcis_only" | "blocked";

export type PhysicalCapabilitySnapshot = {
  capabilityKey: PhysicalCapabilityKey;
  state: PhysicalCapabilityState;
  lastResultCode: number | null;
  verifiedAt: Date | null;
};

export type OperationsCapability = {
  key: string;
  label: string;
  state: OperationsCapabilityState;
  execution: OperationsExecution;
  reason: string;
};

type PhysicalSummarySpec = {
  key: string;
  physicalKey: PhysicalCapabilityKey;
  label: string;
  unverifiedReason: string;
};

const BASE_CAPABILITIES: OperationsCapability[] = [
  { key: "cancel_pending_commands", label: "Bersihkan command pending", state: "available", execution: "hcis_only", reason: "Hanya command yang belum pernah delivered yang dibatalkan di HCIS." },
  { key: "transaction_export", label: "Export transaksi CSV", state: "available", execution: "hcis_only", reason: "Export membaca fakta raw yang sudah durable." },
  { key: "offline_attlog_import", label: "Import ATTLOG offline", state: "available", execution: "hcis_only", reason: "Parser, dedupe, quarantine, provenance, dan projection memakai invariant ingress yang sama." },
  { key: "work_code_catalog", label: "Katalog Work Code", state: "available", execution: "hcis_only", reason: "Work Code bersifat policy-neutral dan dapat dikelola di HCIS." },
  { key: "message_catalog", label: "Katalog pesan perangkat", state: "available", execution: "hcis_only", reason: "Pesan dapat direncanakan di HCIS tanpa mengirim command." },
];

const PHYSICAL_SUMMARY: PhysicalSummarySpec[] = [
  {
    key: "user_profile_upsert",
    physicalKey: "user_profile_upsert",
    label: "Kirim atau perbarui pegawai di mesin",
    unverifiedReason: "Pengiriman data pegawai belum lolos pengujian perangkat pada mesin ini.",
  },
  {
    key: "user_enable_disable",
    physicalKey: "user_enable_disable",
    label: "Aktifkan atau nonaktifkan pegawai di mesin",
    unverifiedReason: "Perubahan status pegawai belum lolos pengujian perangkat pada mesin ini.",
  },
  {
    key: "work_code_delivery",
    physicalKey: "work_code_delivery",
    label: "Distribusi Work Code ke mesin",
    unverifiedReason: "Typed Work Code delivery tersedia, tetapi belum mempunyai bukti physical canary yang verified pada mesin ini.",
  },
  {
    key: "message_delivery",
    physicalKey: "message_delivery",
    label: "Kirim/hapus pesan di mesin",
    unverifiedReason: "Typed message delivery tersedia, tetapi belum mempunyai bukti physical canary yang verified pada mesin ini.",
  },
  {
    key: "time_sync",
    physicalKey: "time_sync",
    label: "Sinkron waktu/timezone",
    unverifiedReason: "Typed time-sync tersedia, tetapi belum mempunyai bukti physical canary yang verified pada mesin ini.",
  },
  {
    key: "duplicate_punch_period",
    physicalKey: "duplicate_punch_period",
    label: "Duplicate-punch period",
    unverifiedReason: "Typed duplicate-punch configuration tersedia, tetapi belum mempunyai bukti physical canary yang verified pada mesin ini.",
  },
  {
    key: "reboot",
    physicalKey: "reboot",
    label: "Reboot mesin",
    unverifiedReason: "Typed reboot tersedia, tetapi belum mempunyai bukti physical canary yang verified pada mesin ini.",
  },
  {
    key: "ntp_config",
    physicalKey: "ntp_config",
    label: "Sumber waktu otomatis",
    unverifiedReason: "Pengaturan sumber waktu otomatis belum lolos pengujian perangkat pada mesin ini.",
  },
  {
    key: "firmware_upgrade",
    physicalKey: "firmware_upgrade",
    label: "Upgrade firmware",
    unverifiedReason: "Model-bound firmware workflow tersedia, tetapi belum mempunyai bukti physical canary yang verified pada mesin ini.",
  },
  {
    key: "clear_attendance",
    physicalKey: "clear_attendance",
    label: "Hapus attendance di mesin",
    unverifiedReason: "Typed break-glass clear-attendance tersedia, tetapi execute normal tetap ditahan sampai physical canary verified; raw HCIS tidak ikut dihapus.",
  },
  {
    key: "clear_photo_cache",
    physicalKey: "clear_photo_cache",
    label: "Hapus photo/cache di mesin",
    unverifiedReason: "Typed break-glass clear-photo tersedia, tetapi execute normal tetap ditahan sampai physical canary verified.",
  },
  {
    key: "selected_biometric_delete",
    physicalKey: "biometric_delete",
    label: "Hapus biometrik terpilih di mesin",
    unverifiedReason: "Typed device-side biometric delete tersedia, tetapi tetap biometric-gated dan belum mempunyai bukti physical canary yang verified pada mesin ini.",
  },
  {
    key: "clear_all_data",
    physicalKey: "clear_all_data",
    label: "Hapus seluruh data mesin",
    unverifiedReason: "Typed break-glass clear-all tersedia, tetapi execute normal tetap ditahan sampai physical canary verified dan HCIS raw history tetap dipertahankan.",
  },
];

export async function loadPhysicalCapabilitySnapshots(
  db: Pool | PoolClient,
  deviceId: string,
): Promise<Map<PhysicalCapabilityKey, PhysicalCapabilitySnapshot>> {
  const result = await db.query<PhysicalCapabilitySnapshot>(
    `SELECT capability_key AS "capabilityKey", state,
            last_result_code AS "lastResultCode", verified_at AS "verifiedAt"
     FROM attendance_adms_physical_capabilities
     WHERE device_id = $1`,
    [deviceId],
  );
  return new Map(result.rows.map((item) => [item.capabilityKey, item] as const));
}

function failedReason(label: string, snapshot: PhysicalCapabilitySnapshot) {
  const suffix = snapshot.lastResultCode === null ? "" : ` (RC ${snapshot.lastResultCode})`;
  return `${label}: physical canary terakhir gagal${suffix}. Review bukti sebelum retry; execute normal tetap ditahan.`;
}

export function projectPhysicalCapability(
  spec: PhysicalSummarySpec,
  snapshots: Map<PhysicalCapabilityKey, PhysicalCapabilitySnapshot>,
): OperationsCapability {
  const snapshot = snapshots.get(spec.physicalKey);
  const state = snapshot?.state ?? "documented";
  if (state === "verified") {
    return {
      key: spec.key,
      label: spec.label,
      state: "available",
      execution: "device",
      reason: "Sudah lolos pengujian pada mesin ini dan dapat digunakan sesuai izin operator.",
    };
  }
  if (state === "unsupported") {
    return {
      key: spec.key,
      label: spec.label,
      state: "blocked",
      execution: "blocked",
      reason: "Fitur ini tidak didukung mesin ini berdasarkan hasil pengujian yang tersimpan.",
    };
  }
  if (state === "blocked") {
    return {
      key: spec.key,
      label: spec.label,
      state: "blocked",
      execution: "blocked",
      reason: "Fitur ini dinonaktifkan untuk mesin ini.",
    };
  }
  if (state === "canary_pending") {
    return {
      key: spec.key,
      label: spec.label,
      state: "not_verified",
      execution: "blocked",
      reason: "Pengujian perangkat masih berlangsung. Fitur belum dapat digunakan.",
    };
  }
  if (state === "failed" && snapshot) {
    return {
      key: spec.key,
      label: spec.label,
      state: "not_verified",
      execution: "blocked",
      reason: failedReason(spec.label, snapshot),
    };
  }
  return {
    key: spec.key,
    label: spec.label,
    state: "not_verified",
    execution: "blocked",
    reason: spec.unverifiedReason,
  };
}

export function operationsCapabilities(
  snapshots: Map<PhysicalCapabilityKey, PhysicalCapabilitySnapshot>,
): OperationsCapability[] {
  return [
    ...BASE_CAPABILITIES,
    ...PHYSICAL_SUMMARY.map((spec) => projectPhysicalCapability(spec, snapshots)),
  ];
}

export function deliveryCapabilitySummary(
  snapshots: Map<PhysicalCapabilityKey, PhysicalCapabilitySnapshot>,
  capabilityKey: "work_code_delivery" | "message_delivery",
  label: string,
): { state: OperationsCapabilityState; note: string } {
  const snapshot = snapshots.get(capabilityKey);
  const state = snapshot?.state ?? "documented";
  if (state === "verified") {
    return {
      state: "available",
      note: `${label} device delivery sudah mempunyai physical canary verified pada mesin ini. Pengiriman tetap dilakukan hanya melalui kontrol typed dan explicit-target.`,
    };
  }
  if (state === "unsupported") {
    return {
      state: "blocked",
      note: `${label} device delivery diklasifikasikan unsupported berdasarkan evidence mesin ini.`,
    };
  }
  if (state === "blocked") {
    return {
      state: "blocked",
      note: `${label} device delivery diblokir eksplisit pada mesin ini.`,
    };
  }
  if (state === "canary_pending") {
    return {
      state: "not_verified",
      note: `${label} physical canary sedang berjalan atau menunggu result; execute normal tetap ditahan.`,
    };
  }
  if (state === "failed" && snapshot) {
    const suffix = snapshot.lastResultCode === null ? "" : ` (RC ${snapshot.lastResultCode})`;
    return {
      state: "not_verified",
      note: `${label} physical canary terakhir gagal${suffix}; review evidence sebelum retry.`,
    };
  }
  return {
    state: "not_verified",
    note: `${label} typed device delivery tersedia, tetapi belum mempunyai physical canary verified pada mesin ini.`,
  };
}
