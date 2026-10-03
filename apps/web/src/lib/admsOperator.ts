import type { OperationsCapability } from "@/lib/admsOperations";

export interface AdmsDeviceProfile {
  id: string;
  serialNumber: string;
  lifecycle: string;
  timezone: string;
  organizationalUnitId: string | null;
  areaContext: string | null;
  worksiteLabel: string | null;
  heartbeatIntervalSeconds: number;
  desiredPushProtocolVersion: string | null;
}

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as T | { message?: string } | null;
  if (response.ok) return body as T;
  throw new Error((body as { message?: string } | null)?.message ?? "Pengaturan mesin tidak dapat diproses.");
}

export async function getAdmsDeviceProfile(deviceId: string) {
  const result = await readJson<{ item: AdmsDeviceProfile }>(
    await fetch(`/api/admin/attendance/adms/devices/${deviceId}/wdms-profile`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    }),
  );
  return result.item;
}

export async function updateAdmsDeviceProfile(
  deviceId: string,
  input: Partial<Pick<AdmsDeviceProfile, "organizationalUnitId" | "areaContext" | "worksiteLabel">>,
) {
  const result = await readJson<{ item: AdmsDeviceProfile }>(
    await fetch(`/api/admin/attendance/adms/devices/${deviceId}/wdms-profile`, {
      method: "PATCH",
      credentials: "include",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return result.item;
}

export function capabilityByKey(items: OperationsCapability[], key: string) {
  return items.find((item) => item.key === key) ?? null;
}

export function operatorCapabilityLabel(capability: OperationsCapability | null) {
  if (!capability || capability.state === "not_verified") return "Perlu pengujian perangkat";
  if (capability.state === "blocked") {
    return /tidak didukung/i.test(capability.reason) ? "Tidak didukung mesin ini" : "Belum dapat digunakan";
  }
  return "Siap digunakan";
}

export function operatorCapabilityHint(capability: OperationsCapability | null) {
  if (!capability || capability.state === "not_verified") {
    return "Fitur tersedia di HCIS, tetapi mesin ini belum mempunyai bukti pengujian yang diperlukan.";
  }
  if (capability.state === "blocked") {
    return /tidak didukung/i.test(capability.reason)
      ? "Hasil pengujian menunjukkan mesin ini tidak mendukung fitur tersebut."
      : "Fitur ini sedang dinonaktifkan untuk mesin ini.";
  }
  return "Fitur sudah lolos pengujian pada mesin ini.";
}
