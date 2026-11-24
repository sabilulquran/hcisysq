/**
 * SVC-001: keadaan tiap layanan pegawai, dibaca dari server.
 *
 * Katalog di `employeeServices.ts` memegang nama, penjelasan, dan tautan — hal-hal yang memang
 * milik layar. Apakah sebuah layanan benar-benar terbuka adalah aturan bisnis dan tetap tinggal di
 * server (AGENTS.md §4); berkas ini hanya membacanya. Layanan yang tidak disebut server terbaca
 * terbuka, jadi kegagalan permintaan ini tidak pernah mengunci apa pun secara keliru.
 */
export type EmployeeServiceState = "LOCKED" | "LIMITED";

export interface EmployeeServiceStatus {
  key: string;
  state: EmployeeServiceState;
  code: string;
  /** Untuk pegawai: apa yang belum dapat dilakukan. */
  message: string;
  /** Untuk HC: apa yang membuka layanan ini. */
  requirement: string;
}

export type EmployeeServiceStatusMap = Record<string, EmployeeServiceStatus | undefined>;

export async function getEmployeeServiceStatuses(): Promise<EmployeeServiceStatusMap> {
  const response = await fetch("/api/me/services", {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) return {};
  const body = await response.json().catch(() => null) as { services?: EmployeeServiceStatus[] } | null;
  const map: EmployeeServiceStatusMap = {};
  for (const service of body?.services ?? []) map[service.key] = service;
  return map;
}

export function employeeServiceStatusLabel(status: EmployeeServiceStatus | undefined) {
  if (!status) return null;
  return status.state === "LOCKED" ? "Belum dibuka" : "Sebagian dibuka";
}
