// Administrasi kepegawaian Paket 2, langkah P2-1 (spec
// docs/domain/employment-administration-package2.md §4). Aturan murni untuk
// pendidikan, keahlian, keluarga, dan alamat: tidak ada basis data, tidak ada
// HTTP. Basis data menegakkan aturan yang sama lewat CHECK dan EXCLUDE; di
// sini aturan itu berubah menjadi pesan per field, bukan pelanggaran
// constraint yang muncul sebagai 500.

export const EDUCATION_LEVELS = [
  "SD",
  "SMP",
  "SMA_SEDERAJAT",
  "D1",
  "D2",
  "D3",
  "D4_S1",
  "S2",
  "S3",
  "PONDOK",
  "LAINNYA",
] as const;
export type EducationLevel = (typeof EDUCATION_LEVELS)[number];

/**
 * Urutan jenjang untuk menghitung "pendidikan tertinggi" (spec §5.6). `PONDOK`
 * dan `LAINNYA` tidak diberi peringkat: kesetaraannya berbeda antarlembaga,
 * jadi menyetarakannya otomatis akan menyatakan sesuatu yang belum tentu benar
 * (keputusan DRAFT §13).
 */
const LEVEL_RANK: Readonly<Partial<Record<EducationLevel, number>>> = {
  SD: 1,
  SMP: 2,
  SMA_SEDERAJAT: 3,
  D1: 4,
  D2: 5,
  D3: 6,
  D4_S1: 7,
  S2: 8,
  S3: 9,
};

export const COMPLETION_STATUSES = ["SELESAI", "BELUM_SELESAI", "TIDAK_SELESAI"] as const;
export type CompletionStatus = (typeof COMPLETION_STATUSES)[number];

export const VERIFICATION_STATUSES = ["DILAPORKAN", "DIVERIFIKASI"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const SKILL_KINDS = ["KEAHLIAN", "SERTIFIKAT"] as const;
export type SkillKind = (typeof SKILL_KINDS)[number];

export const SKILL_CATEGORIES = [
  "PENGAJARAN",
  "KEAGAMAAN",
  "ADMINISTRASI",
  "TEKNOLOGI",
  "BAHASA",
  "KESEHATAN_KESELAMATAN",
  "LAINNYA",
] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

export const PROFICIENCY_LEVELS = ["DASAR", "MENENGAH", "MAHIR"] as const;
export type ProficiencyLevel = (typeof PROFICIENCY_LEVELS)[number];

export const FAMILY_RELATIONS = ["PASANGAN", "ANAK", "ORANG_TUA", "SAUDARA", "LAINNYA"] as const;
export type FamilyRelation = (typeof FAMILY_RELATIONS)[number];

export const ADDRESS_KINDS = ["DOMISILI", "KTP"] as const;
export type AddressKind = (typeof ADDRESS_KINDS)[number];

export const DATA_CHANGE_TARGETS = ["ALAMAT", "KONTAK", "KELUARGA", "PENDIDIKAN", "KEAHLIAN"] as const;
export type DataChangeTarget = (typeof DATA_CHANGE_TARGETS)[number];

export interface ProfileFailure {
  code: "EMPLOYEE_RECORD_INVALID";
  field: string;
  message: string;
}

export type ProfileValidation<T> = { ok: true; value: T } | { ok: false; failure: ProfileFailure };

function fail(field: string, message: string): { ok: false; failure: ProfileFailure } {
  return { ok: false, failure: { code: "EMPLOYEE_RECORD_INVALID", field, message } };
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function text(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

// ---------------------------------------------------------------- pendidikan

export interface EducationInput {
  level: EducationLevel;
  institutionName: string;
  major?: string | null | undefined;
  startedYear?: number | null | undefined;
  completedYear?: number | null | undefined;
  completionStatus: CompletionStatus;
  degreeTitle?: string | null | undefined;
  certificateNumber?: string | null | undefined;
  archiveReference?: string | null | undefined;
  notes?: string | null | undefined;
}

export interface EducationValues {
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

/** Ijazah yang baru akan terbit boleh dicatat; tahun jauh di depan tidak. */
export function validateEducation(input: EducationInput, thisYear: number): ProfileValidation<EducationValues> {
  const institutionName = text(input.institutionName);
  if (!institutionName) return fail("institutionName", "Nama lembaga wajib diisi.");
  if (!EDUCATION_LEVELS.includes(input.level)) return fail("level", "Pilih jenjang pendidikan.");
  if (!COMPLETION_STATUSES.includes(input.completionStatus)) return fail("completionStatus", "Pilih status penyelesaian.");

  const startedYear = input.startedYear ?? null;
  const completedYear = input.completedYear ?? null;
  for (const [field, year] of [["startedYear", startedYear], ["completedYear", completedYear]] as const) {
    if (year === null) continue;
    if (!Number.isInteger(year) || year < 1900) return fail(field, "Tahun tidak valid.");
    if (year > thisYear + 1) return fail(field, "Tahun tidak boleh lebih dari satu tahun ke depan.");
  }
  if (startedYear !== null && completedYear !== null && completedYear < startedYear) {
    return fail("completedYear", "Tahun selesai tidak boleh sebelum tahun mulai.");
  }
  if (input.completionStatus === "SELESAI" && completedYear === null) {
    return fail("completedYear", "Pendidikan yang selesai wajib menyebut tahun selesai.");
  }

  return {
    ok: true,
    value: {
      level: input.level,
      institutionName,
      major: text(input.major),
      startedYear,
      completedYear,
      completionStatus: input.completionStatus,
      degreeTitle: text(input.degreeTitle),
      certificateNumber: text(input.certificateNumber),
      archiveReference: text(input.archiveReference),
      notes: text(input.notes),
    },
  };
}

export interface EducationRecord {
  level: EducationLevel;
  completionStatus: CompletionStatus;
  verificationStatus: VerificationStatus;
  voided: boolean;
}

/**
 * Pendidikan tertinggi (spec §5.6): hanya catatan yang selesai dan sudah
 * diverifikasi yang dihitung, dan jenjang tanpa peringkat tidak pernah menang.
 * Mengembalikan null bila tidak ada yang memenuhi — bukan tebakan.
 */
export function highestEducationLevel(records: readonly EducationRecord[]): EducationLevel | null {
  let best: { level: EducationLevel; rank: number } | null = null;
  for (const record of records) {
    if (record.voided || record.completionStatus !== "SELESAI" || record.verificationStatus !== "DIVERIFIKASI") continue;
    const rank = LEVEL_RANK[record.level];
    if (rank === undefined) continue;
    if (!best || rank > best.rank) best = { level: record.level, rank };
  }
  return best?.level ?? null;
}

// ------------------------------------------------------------------ keahlian

export interface SkillInput {
  kind: SkillKind;
  name: string;
  category: SkillCategory;
  proficiency?: ProficiencyLevel | null | undefined;
  issuer?: string | null | undefined;
  certificateNumber?: string | null | undefined;
  issuedOn?: string | null | undefined;
  expiresOn?: string | null | undefined;
  archiveReference?: string | null | undefined;
  notes?: string | null | undefined;
}

export interface SkillValues {
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
}

export function validateSkill(input: SkillInput): ProfileValidation<SkillValues> {
  const name = text(input.name);
  if (!name) return fail("name", "Nama keahlian atau sertifikat wajib diisi.");
  if (!SKILL_KINDS.includes(input.kind)) return fail("kind", "Pilih jenis catatan.");
  if (!SKILL_CATEGORIES.includes(input.category)) return fail("category", "Pilih kategori.");
  if (input.proficiency && !PROFICIENCY_LEVELS.includes(input.proficiency)) {
    return fail("proficiency", "Tingkat kemahiran tidak valid.");
  }

  const issuer = text(input.issuer);
  const issuedOn = input.issuedOn ?? null;
  const expiresOn = input.expiresOn ?? null;
  for (const [field, value] of [["issuedOn", issuedOn], ["expiresOn", expiresOn]] as const) {
    if (value !== null && !isIsoDate(value)) return fail(field, "Tanggal tidak valid.");
  }
  if (input.kind === "SERTIFIKAT") {
    if (!issuer) return fail("issuer", "Sertifikat wajib menyebut lembaga penerbit.");
    if (!issuedOn) return fail("issuedOn", "Sertifikat wajib menyebut tanggal terbit.");
  }
  if (issuedOn && expiresOn && expiresOn < issuedOn) {
    return fail("expiresOn", "Masa berlaku tidak boleh berakhir sebelum tanggal terbit.");
  }

  return {
    ok: true,
    value: {
      kind: input.kind,
      name,
      category: input.category,
      proficiency: input.proficiency ?? null,
      issuer,
      certificateNumber: text(input.certificateNumber),
      issuedOn,
      expiresOn,
      archiveReference: text(input.archiveReference),
      notes: text(input.notes),
    },
  };
}

/** Sertifikat yang masa berlakunya lewat: ditandai, tidak diubah (spec §5.3). */
export function isCertificateExpired(expiresOn: string | null, today: string): boolean {
  return expiresOn !== null && expiresOn < today;
}

// ------------------------------------------------------------------- keluarga

export interface FamilyMemberInput {
  relation: FamilyRelation;
  fullName: string;
  birthDate?: string | null | undefined;
  gender?: "L" | "P" | null | undefined;
  isDependent?: boolean | undefined;
  dependentOrder?: number | null | undefined;
  isEmergencyContact?: boolean | undefined;
  emergencyPhone?: string | null | undefined;
  emergencyPriority?: number | null | undefined;
  validFrom: string;
  validTo?: string | null | undefined;
  notes?: string | null | undefined;
}

export interface FamilyMemberValues {
  relation: FamilyRelation;
  fullName: string;
  birthDate: string | null;
  gender: "L" | "P" | null;
  isDependent: boolean;
  dependentOrder: number | null;
  isEmergencyContact: boolean;
  emergencyPhone: string | null;
  emergencyPriority: number | null;
  validFrom: string;
  validTo: string | null;
  notes: string | null;
}

export function validateFamilyMember(input: FamilyMemberInput): ProfileValidation<FamilyMemberValues> {
  const fullName = text(input.fullName);
  if (!fullName) return fail("fullName", "Nama wajib diisi.");
  if (!FAMILY_RELATIONS.includes(input.relation)) return fail("relation", "Pilih hubungan keluarga.");
  if (!isIsoDate(input.validFrom)) return fail("validFrom", "Tanggal mulai berlaku tidak valid.");
  const validTo = input.validTo ?? null;
  if (validTo !== null) {
    if (!isIsoDate(validTo)) return fail("validTo", "Tanggal akhir tidak valid.");
    if (validTo < input.validFrom) return fail("validTo", "Tanggal akhir tidak boleh sebelum tanggal mulai.");
  }
  const birthDate = input.birthDate ?? null;
  if (birthDate !== null && !isIsoDate(birthDate)) return fail("birthDate", "Tanggal lahir tidak valid.");

  const isDependent = input.isDependent === true;
  if (isDependent && birthDate === null) {
    return fail("birthDate", "Tanggungan wajib menyebut tanggal lahir.");
  }
  const dependentOrder = input.dependentOrder ?? null;
  if (dependentOrder !== null && !isDependent) {
    return fail("dependentOrder", "Urutan tanggungan hanya untuk anggota keluarga yang menjadi tanggungan.");
  }

  const isEmergencyContact = input.isEmergencyContact === true;
  const emergencyPhone = text(input.emergencyPhone);
  const emergencyPriority = input.emergencyPriority ?? null;
  if (isEmergencyContact) {
    if (!emergencyPhone) return fail("emergencyPhone", "Kontak darurat wajib menyebut nomor telepon.");
    if (emergencyPriority === null) return fail("emergencyPriority", "Tentukan urutan kontak darurat.");
  }

  return {
    ok: true,
    value: {
      relation: input.relation,
      fullName,
      birthDate,
      gender: input.gender ?? null,
      isDependent,
      dependentOrder,
      isEmergencyContact,
      emergencyPhone: isEmergencyContact ? emergencyPhone : null,
      emergencyPriority: isEmergencyContact ? emergencyPriority : null,
      validFrom: input.validFrom,
      validTo,
      notes: text(input.notes),
    },
  };
}

// --------------------------------------------------------------------- alamat

export interface AddressInput {
  kind: AddressKind;
  addressLine: string;
  village?: string | null | undefined;
  district?: string | null | undefined;
  city: string;
  province?: string | null | undefined;
  postalCode?: string | null | undefined;
  validFrom: string;
  validTo?: string | null | undefined;
  notes?: string | null | undefined;
}

export interface AddressValues {
  kind: AddressKind;
  addressLine: string;
  village: string | null;
  district: string | null;
  city: string;
  province: string | null;
  postalCode: string | null;
  validFrom: string;
  validTo: string | null;
  notes: string | null;
}

export function validateAddress(input: AddressInput): ProfileValidation<AddressValues> {
  const addressLine = text(input.addressLine);
  if (!addressLine) return fail("addressLine", "Alamat wajib diisi.");
  const city = text(input.city);
  if (!city) return fail("city", "Kota atau kabupaten wajib diisi.");
  if (!ADDRESS_KINDS.includes(input.kind)) return fail("kind", "Pilih jenis alamat.");
  if (!isIsoDate(input.validFrom)) return fail("validFrom", "Tanggal mulai berlaku tidak valid.");
  const validTo = input.validTo ?? null;
  if (validTo !== null) {
    if (!isIsoDate(validTo)) return fail("validTo", "Tanggal akhir tidak valid.");
    if (validTo < input.validFrom) return fail("validTo", "Tanggal akhir tidak boleh sebelum tanggal mulai.");
  }
  const postalCode = text(input.postalCode);
  if (postalCode !== null && !/^[0-9]{5}$/.test(postalCode)) {
    return fail("postalCode", "Kode pos terdiri dari lima angka.");
  }

  return {
    ok: true,
    value: {
      kind: input.kind,
      addressLine,
      village: text(input.village),
      district: text(input.district),
      city,
      province: text(input.province),
      postalCode,
      validFrom: input.validFrom,
      validTo,
      notes: text(input.notes),
    },
  };
}

/**
 * Pindah rumah: alamat lama ditutup sehari sebelum yang baru berlaku, bukan
 * dihapus. Mengembalikan tanggal penutupannya, atau null bila tidak perlu
 * ditutup (sudah berakhir sebelum tanggal itu).
 */
export function closingDateFor(current: { validFrom: string; validTo: string | null }, newValidFrom: string): string | null {
  if (current.validTo !== null && current.validTo < newValidFrom) return null;
  const date = new Date(`${newValidFrom}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  const closing = date.toISOString().slice(0, 10);
  return closing < current.validFrom ? null : closing;
}

/** Field yang dicatat sebagai "berubah" di audit; isinya tidak pernah ikut. */
export function changedFields(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): string[] {
  return Object.keys(next).filter((field) => previous[field] !== next[field]);
}
