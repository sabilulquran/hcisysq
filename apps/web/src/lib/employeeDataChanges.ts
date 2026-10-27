// EMP-003 P2-4 client (docs/api/employment.openapi.yaml). Who may decide,
// what a payload must contain, and whether an accepted proposal can still be
// written all belong to the API; this module carries the request and the
// Indonesian labels.

import { EmploymentApiError } from "@/lib/employment";

export type DataChangeTarget = "ALAMAT" | "KONTAK" | "KELUARGA" | "PENDIDIKAN" | "KEAHLIAN";
export type DataChangeState = "DIAJUKAN" | "DITERIMA" | "DITOLAK" | "DIBATALKAN";

export const TARGET_LABEL: Record<DataChangeTarget, string> = {
  ALAMAT: "Alamat",
  KONTAK: "Kontak",
  KELUARGA: "Keluarga",
  PENDIDIKAN: "Pendidikan",
  KEAHLIAN: "Keahlian",
};

export const STATE_LABEL: Record<DataChangeState, string> = {
  DIAJUKAN: "Menunggu keputusan",
  DITERIMA: "Diterima",
  DITOLAK: "Ditolak",
  DIBATALKAN: "Dibatalkan",
};

/** The fields a proposal may name, in the order the screens show them. */
export const FIELD_LABEL: Record<string, string> = {
  kind: "Jenis",
  addressLine: "Alamat",
  village: "Desa/kelurahan",
  district: "Kecamatan",
  city: "Kota/kabupaten",
  province: "Provinsi",
  postalCode: "Kode pos",
  validFrom: "Berlaku sejak",
  validTo: "Berakhir pada",
  email: "Email",
  phone: "Telepon",
  relation: "Hubungan",
  fullName: "Nama",
  birthDate: "Tanggal lahir",
  gender: "Jenis kelamin",
  isDependent: "Tanggungan",
  dependentOrder: "Urutan tanggungan",
  isEmergencyContact: "Kontak darurat",
  emergencyPhone: "Telepon darurat",
  emergencyPriority: "Urutan dihubungi",
  level: "Jenjang",
  institutionName: "Lembaga",
  major: "Jurusan",
  startedYear: "Tahun mulai",
  completedYear: "Tahun selesai",
  completionStatus: "Status",
  degreeTitle: "Gelar",
  certificateNumber: "Nomor",
  name: "Nama",
  category: "Kategori",
  proficiency: "Tingkat",
  issuer: "Penerbit",
  issuedOn: "Tanggal terbit",
  expiresOn: "Berlaku sampai",
  archiveReference: "Letak arsip",
  notes: "Catatan",
  source: "Sumber",
};

export interface DataChangeRequest {
  id: string;
  employeeId: string;
  employeeNumber: string;
  fullName: string;
  unitName: string | null;
  submittedByAccountId: string;
  target: DataChangeTarget;
  payload: Record<string, unknown>;
  state: DataChangeState;
  decidedByAccountId: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DataChangeWorklist {
  state: DataChangeState;
  page: number;
  pageSize: number;
  total: number;
  rows: DataChangeRequest[];
}

async function send<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}) },
    ...init,
  });
  if (response.ok) return (await response.json()) as T;
  const body = (await response.json().catch(() => null)) as { code?: string; message?: string } | null;
  throw new EmploymentApiError(
    response.status,
    body?.code ?? "REQUEST_FAILED",
    body?.message ?? "Permintaan tidak dapat diproses.",
  );
}

const request = (requestId: string) => encodeURIComponent(requestId);

export function getMyDataChanges(): Promise<{ rows: DataChangeRequest[] }> {
  return send("/api/employees/me/data-changes");
}

export function submitDataChange(
  target: DataChangeTarget,
  payload: Record<string, unknown>,
): Promise<DataChangeRequest> {
  return send("/api/employees/me/data-changes", { method: "POST", body: JSON.stringify({ target, payload }) });
}

export function cancelMyDataChange(requestId: string): Promise<DataChangeRequest> {
  return send(`/api/employees/me/data-changes/${request(requestId)}/cancel`, { method: "POST" });
}

export function getDataChangeWorklist(
  input: { state?: DataChangeState; unitId?: string; page?: number; pageSize?: number } = {},
): Promise<DataChangeWorklist> {
  const params = new URLSearchParams({
    state: input.state ?? "DIAJUKAN",
    page: String(input.page ?? 1),
    pageSize: String(input.pageSize ?? 25),
  });
  if (input.unitId) params.set("unitId", input.unitId);
  return send(`/api/admin/employees/data-changes?${params.toString()}`);
}

export function acceptDataChange(requestId: string, note?: string | null): Promise<DataChangeRequest> {
  return send(`/api/admin/data-change-requests/${request(requestId)}/accept`, {
    method: "POST",
    body: JSON.stringify({ note: note?.trim() || null }),
  });
}

export function rejectDataChange(requestId: string, reason: string): Promise<DataChangeRequest> {
  return send(`/api/admin/data-change-requests/${request(requestId)}/reject`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

/** "field: value" lines for the summary, with the field names spelled out. */
export function payloadLines(payload: Record<string, unknown>): Array<{ label: string; value: string }> {
  return Object.entries(payload)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([field, value]) => ({
      label: FIELD_LABEL[field] ?? field,
      value: typeof value === "boolean" ? (value ? "Ya" : "Tidak") : String(value),
    }));
}
