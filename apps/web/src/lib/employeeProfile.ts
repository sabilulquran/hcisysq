// EMP-007 P2-2 client (docs/api/employment.openapi.yaml). Every rule — the
// years that make sense, the highest level, whether a certificate has lapsed —
// is the API's; this module carries the request and the Indonesian labels.

import { EmploymentApiError } from "@/lib/employment";

export type EducationLevel =
  | "SD" | "SMP" | "SMA_SEDERAJAT" | "D1" | "D2" | "D3" | "D4_S1" | "S2" | "S3" | "PONDOK" | "LAINNYA";
export type CompletionStatus = "SELESAI" | "BELUM_SELESAI" | "TIDAK_SELESAI";
export type VerificationStatus = "DILAPORKAN" | "DIVERIFIKASI";
export type SkillKind = "KEAHLIAN" | "SERTIFIKAT";
export type SkillCategory =
  | "PENGAJARAN" | "KEAGAMAAN" | "ADMINISTRASI" | "TEKNOLOGI" | "BAHASA" | "KESEHATAN_KESELAMATAN" | "LAINNYA";
export type ProficiencyLevel = "DASAR" | "MENENGAH" | "MAHIR";

export const EDUCATION_LEVEL_LABEL: Record<EducationLevel, string> = {
  SD: "SD/MI",
  SMP: "SMP/MTs",
  SMA_SEDERAJAT: "SMA/MA/SMK",
  D1: "D1",
  D2: "D2",
  D3: "D3",
  D4_S1: "D4/S1",
  S2: "S2",
  S3: "S3",
  PONDOK: "Pondok pesantren",
  LAINNYA: "Lainnya",
};

export const COMPLETION_STATUS_LABEL: Record<CompletionStatus, string> = {
  SELESAI: "Selesai",
  BELUM_SELESAI: "Sedang ditempuh",
  TIDAK_SELESAI: "Tidak selesai",
};

export const VERIFICATION_STATUS_LABEL: Record<VerificationStatus, string> = {
  DILAPORKAN: "Dilaporkan pegawai",
  DIVERIFIKASI: "Terverifikasi HC",
};

export const SKILL_KIND_LABEL: Record<SkillKind, string> = {
  KEAHLIAN: "Keahlian",
  SERTIFIKAT: "Sertifikat",
};

export const SKILL_CATEGORY_LABEL: Record<SkillCategory, string> = {
  PENGAJARAN: "Pengajaran",
  KEAGAMAAN: "Keagamaan",
  ADMINISTRASI: "Administrasi",
  TEKNOLOGI: "Teknologi",
  BAHASA: "Bahasa",
  KESEHATAN_KESELAMATAN: "Kesehatan & keselamatan",
  LAINNYA: "Lainnya",
};

export const PROFICIENCY_LABEL: Record<ProficiencyLevel, string> = {
  DASAR: "Dasar",
  MENENGAH: "Menengah",
  MAHIR: "Mahir",
};

interface RecordMeta {
  id: string;
  employeeId: string;
  verificationStatus: VerificationStatus;
  verifiedAt: string | null;
  unverifiedAt: string | null;
  unverifiedReason: string | null;
  voidedAt: string | null;
  voidedReason: string | null;
}

export interface EducationRecord extends RecordMeta {
  level: EducationLevel;
  institutionName: string;
  major: string | null;
  startedYear: number | null;
  completedYear: number | null;
  completionStatus: CompletionStatus;
  degreeTitle: string | null;
  certificateNumber: string | null;
  archiveReference: string | null;
  notes: string | null;
}

export interface SkillRecord extends RecordMeta {
  kind: SkillKind;
  name: string;
  category: SkillCategory;
  proficiency: ProficiencyLevel | null;
  issuer: string | null;
  certificateNumber: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  archiveReference: string | null;
  notes: string | null;
  /** Derived by the API against its own clock; a lapsed certificate is never rewritten. */
  expired: boolean;
}

export interface EducationList {
  rows: EducationRecord[];
  /** Derived from the verified records alone; PONDOK and LAINNYA are not ranked. */
  highestLevel: EducationLevel | null;
}

export interface SkillList {
  rows: SkillRecord[];
  date: string;
}

export interface ExpiringCertificate {
  recordId: string;
  employeeId: string;
  employeeNumber: string;
  fullName: string;
  unitName: string | null;
  name: string;
  issuer: string | null;
  expiresOn: string;
  daysLeft: number;
  verificationStatus: VerificationStatus;
  expired: boolean;
}

export interface ExpiringCertificateList {
  date: string;
  withinDays: number;
  page: number;
  pageSize: number;
  total: number;
  rows: ExpiringCertificate[];
}

export interface EducationInput {
  level: EducationLevel;
  institutionName: string;
  major?: string | null;
  startedYear?: number | null;
  completedYear?: number | null;
  completionStatus: CompletionStatus;
  degreeTitle?: string | null;
  certificateNumber?: string | null;
  archiveReference?: string | null;
  notes?: string | null;
}

export interface SkillInput {
  kind: SkillKind;
  name: string;
  category: SkillCategory;
  proficiency?: ProficiencyLevel | null;
  issuer?: string | null;
  certificateNumber?: string | null;
  issuedOn?: string | null;
  expiresOn?: string | null;
  archiveReference?: string | null;
  notes?: string | null;
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

const employee = (employeeId: string) => encodeURIComponent(employeeId);
const record = (recordId: string) => encodeURIComponent(recordId);

export function getEducation(employeeId: string): Promise<EducationList> {
  return send(`/api/admin/employees/${employee(employeeId)}/education`);
}

export function getSkills(employeeId: string): Promise<SkillList> {
  return send(`/api/admin/employees/${employee(employeeId)}/skills`);
}

export function recordEducation(employeeId: string, input: EducationInput): Promise<EducationRecord> {
  return send(`/api/admin/employees/${employee(employeeId)}/education`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function amendEducation(recordId: string, input: EducationInput): Promise<EducationRecord> {
  return send(`/api/admin/education-records/${record(recordId)}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function recordSkill(employeeId: string, input: SkillInput): Promise<SkillRecord> {
  return send(`/api/admin/employees/${employee(employeeId)}/skills`, { method: "POST", body: JSON.stringify(input) });
}

export function amendSkill(recordId: string, input: SkillInput): Promise<SkillRecord> {
  return send(`/api/admin/skill-records/${record(recordId)}`, { method: "PATCH", body: JSON.stringify(input) });
}

export type ProfileRecordKind = "education" | "skill";

const prefix = (kind: ProfileRecordKind) => (kind === "education" ? "education-records" : "skill-records");

export function setVerification(
  kind: ProfileRecordKind,
  recordId: string,
  input: { verified: boolean; reason?: string | null },
): Promise<EducationRecord | SkillRecord> {
  return send(`/api/admin/${prefix(kind)}/${record(recordId)}/verification`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function voidProfileRecord(
  kind: ProfileRecordKind,
  recordId: string,
  reason: string,
): Promise<{ id: string; voided: true }> {
  return send(`/api/admin/${prefix(kind)}/${record(recordId)}/void`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export function getExpiringCertificates(
  input: { withinDays?: number; unitId?: string; page?: number; pageSize?: number } = {},
): Promise<ExpiringCertificateList> {
  const params = new URLSearchParams({
    withinDays: String(input.withinDays ?? 60),
    page: String(input.page ?? 1),
    pageSize: String(input.pageSize ?? 25),
  });
  if (input.unitId) params.set("unitId", input.unitId);
  return send(`/api/admin/employees/certificates/expiring?${params.toString()}`);
}
