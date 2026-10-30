// Paket 2 P2-2 adapter (spec docs/domain/employment-administration-package2.md
// §4.1, §4.2, §5.6, §7.5). Aturan ada di ../domain/employee-profile.ts; berkas
// ini hanya membaca dan menulis baris serta mencatat audit dalam transaksi yang
// sama. Kolom DATE dibaca sebagai teks agar tanggalnya tidak bergeser zona.

import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type {
  AddressValues,
  ContactValues,
  DataChangeState,
  DataChangeTarget,
  EducationValues,
  FamilyMemberValues,
  SkillValues,
  VerificationStatus,
} from "../domain/employee-profile.js";

type Db = Pick<Pool, "query"> | PoolClient;

export interface EducationRow extends EducationValues {
  id: string;
  employeeId: string;
  verificationStatus: VerificationStatus;
  verifiedAt: string | null;
  unverifiedAt: string | null;
  unverifiedReason: string | null;
  voidedAt: string | null;
  voidedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SkillRow extends SkillValues {
  id: string;
  employeeId: string;
  verificationStatus: VerificationStatus;
  verifiedAt: string | null;
  unverifiedAt: string | null;
  unverifiedReason: string | null;
  voidedAt: string | null;
  voidedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

const EDUCATION_COLUMNS = `
  id, employee_id AS "employeeId", level, institution_name AS "institutionName", major,
  started_year AS "startedYear", completed_year AS "completedYear", completion_status AS "completionStatus",
  degree_title AS "degreeTitle", certificate_number AS "certificateNumber",
  archive_reference AS "archiveReference", notes,
  verification_status AS "verificationStatus", verified_at AS "verifiedAt",
  unverified_at AS "unverifiedAt", unverified_reason AS "unverifiedReason",
  voided_at AS "voidedAt", voided_reason AS "voidedReason",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

const SKILL_COLUMNS = `
  id, employee_id AS "employeeId", kind, name, category, proficiency, issuer,
  certificate_number AS "certificateNumber", issued_on::text AS "issuedOn", expires_on::text AS "expiresOn",
  archive_reference AS "archiveReference", notes,
  verification_status AS "verificationStatus", verified_at AS "verifiedAt",
  unverified_at AS "unverifiedAt", unverified_reason AS "unverifiedReason",
  voided_at AS "voidedAt", voided_reason AS "voidedReason",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

type Timestamped<T> = Omit<T, "verifiedAt" | "unverifiedAt" | "voidedAt" | "createdAt" | "updatedAt"> & {
  verifiedAt: Date | null;
  unverifiedAt: Date | null;
  voidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function toIso<T extends { verifiedAt: Date | null; unverifiedAt: Date | null; voidedAt: Date | null; createdAt: Date; updatedAt: Date }>(
  row: T,
) {
  return {
    ...row,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    unverifiedAt: row.unverifiedAt?.toISOString() ?? null,
    voidedAt: row.voidedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function audit(
  db: Db,
  event: {
    actorAccountId: string | null;
    action: string;
    entityType: string;
    entityId: string | null;
    employeeId: string | null;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO employee_profile_audit_events (id, actor_account_id, action, entity_type, entity_id, employee_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [randomUUID(), event.actorAccountId, event.action, event.entityType, event.entityId, event.employeeId,
      JSON.stringify(event.payload)],
  );
}

// ---------------------------------------------------------------- pendidikan

export async function listEducation(db: Db, employeeId: string, includeVoided = false): Promise<EducationRow[]> {
  const result = await db.query<Timestamped<EducationRow>>(
    `SELECT ${EDUCATION_COLUMNS} FROM employee_education
     WHERE employee_id = $1 ${includeVoided ? "" : "AND voided_at IS NULL"}
     ORDER BY completed_year DESC NULLS LAST, started_year DESC NULLS LAST, created_at DESC`,
    [employeeId],
  );
  return result.rows.map(toIso);
}

export async function getEducation(db: Db, recordId: string): Promise<EducationRow | null> {
  const result = await db.query<Timestamped<EducationRow>>(
    `SELECT ${EDUCATION_COLUMNS} FROM employee_education WHERE id = $1`,
    [recordId],
  );
  const row = result.rows[0];
  return row ? toIso(row) : null;
}

export async function insertEducation(
  client: PoolClient,
  employeeId: string,
  values: EducationValues,
  actorAccountId: string,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO employee_education
       (id, employee_id, level, institution_name, major, started_year, completed_year, completion_status,
        degree_title, certificate_number, archive_reference, notes, created_by_account_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [id, employeeId, values.level, values.institutionName, values.major, values.startedYear, values.completedYear,
      values.completionStatus, values.degreeTitle, values.certificateNumber, values.archiveReference, values.notes,
      actorAccountId],
  );
  return id;
}

export async function updateEducation(client: PoolClient, recordId: string, values: EducationValues): Promise<void> {
  await client.query(
    `UPDATE employee_education SET level = $2, institution_name = $3, major = $4, started_year = $5,
       completed_year = $6, completion_status = $7, degree_title = $8, certificate_number = $9,
       archive_reference = $10, notes = $11, updated_at = now()
     WHERE id = $1`,
    [recordId, values.level, values.institutionName, values.major, values.startedYear, values.completedYear,
      values.completionStatus, values.degreeTitle, values.certificateNumber, values.archiveReference, values.notes],
  );
}

// ------------------------------------------------------------------ keahlian

export async function listSkills(db: Db, employeeId: string, includeVoided = false): Promise<SkillRow[]> {
  const result = await db.query<Timestamped<SkillRow>>(
    `SELECT ${SKILL_COLUMNS} FROM employee_skills
     WHERE employee_id = $1 ${includeVoided ? "" : "AND voided_at IS NULL"}
     ORDER BY kind, expires_on DESC NULLS LAST, name`,
    [employeeId],
  );
  return result.rows.map(toIso);
}

export async function getSkill(db: Db, recordId: string): Promise<SkillRow | null> {
  const result = await db.query<Timestamped<SkillRow>>(
    `SELECT ${SKILL_COLUMNS} FROM employee_skills WHERE id = $1`,
    [recordId],
  );
  const row = result.rows[0];
  return row ? toIso(row) : null;
}

export async function insertSkill(
  client: PoolClient,
  employeeId: string,
  values: SkillValues,
  actorAccountId: string,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO employee_skills
       (id, employee_id, kind, name, category, proficiency, issuer, certificate_number, issued_on, expires_on,
        archive_reference, notes, created_by_account_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [id, employeeId, values.kind, values.name, values.category, values.proficiency, values.issuer,
      values.certificateNumber, values.issuedOn, values.expiresOn, values.archiveReference, values.notes,
      actorAccountId],
  );
  return id;
}

export async function updateSkill(client: PoolClient, recordId: string, values: SkillValues): Promise<void> {
  await client.query(
    `UPDATE employee_skills SET kind = $2, name = $3, category = $4, proficiency = $5, issuer = $6,
       certificate_number = $7, issued_on = $8, expires_on = $9, archive_reference = $10, notes = $11,
       updated_at = now()
     WHERE id = $1`,
    [recordId, values.kind, values.name, values.category, values.proficiency, values.issuer,
      values.certificateNumber, values.issuedOn, values.expiresOn, values.archiveReference, values.notes],
  );
}

// ------------------------------------------------- verifikasi dan pembatalan

export type ProfileTable = "employee_education" | "employee_skills";

/**
 * Every table in this package carries employee_id and voided_at, so one lock
 * and one void serve them all. Only the two above carry a verification.
 */
export type VoidableTable = ProfileTable | "employee_family_members" | "employee_addresses";

export interface LockedProfileRecord {
  employeeId: string;
  voidedAt: Date | null;
  /** EMP-001: removed from the master, so the record is read-only history. */
  employeeRemoved: boolean;
  /** S2B §8.7: outside HCIS management, so the record is read-only too. */
  employeeOutsideHcis: boolean;
}

/**
 * Memverifikasi atau mencabut verifikasi. Pencabutan tidak menghapus siapa dan
 * kapan memverifikasi (spec §5.2): yang bertambah hanyalah alasan pencabutan.
 */
export async function setVerification(
  client: PoolClient,
  table: ProfileTable,
  recordId: string,
  verified: boolean,
  reason: string | null,
  actorAccountId: string,
): Promise<void> {
  if (verified) {
    await client.query(
      `UPDATE ${table}
       SET verification_status = 'DIVERIFIKASI', verified_at = now(), verified_by_account_id = $2,
           unverified_at = NULL, unverified_reason = NULL, updated_at = now()
       WHERE id = $1`,
      [recordId, actorAccountId],
    );
    return;
  }
  await client.query(
    `UPDATE ${table}
     SET verification_status = 'DILAPORKAN', unverified_at = now(), unverified_reason = $2, updated_at = now()
     WHERE id = $1`,
    [recordId, reason],
  );
}

export async function voidRecord(
  client: PoolClient,
  table: VoidableTable,
  recordId: string,
  reason: string,
): Promise<void> {
  await client.query(
    `UPDATE ${table} SET voided_at = now(), voided_reason = $2, updated_at = now() WHERE id = $1`,
    [recordId, reason],
  );
}

/**
 * Mengunci baris untuk baca-ubah-tulis; null bila catatannya tidak ada.
 *
 * Status pegawainya ikut dibaca di sini. Rute yang dipanggil dengan id catatan
 * tidak pernah menyebut pegawainya, jadi tanpa ini catatan milik pegawai yang
 * sudah dikeluarkan dari master masih bisa diubah padahal membacanya saja
 * sudah ditolak (EMP-001: riwayat itu hanya dapat dibaca). `FOR UPDATE OF`
 * mengunci baris catatannya saja, bukan baris pegawai.
 */
export async function lockProfileRecord(
  client: PoolClient,
  table: VoidableTable,
  recordId: string,
): Promise<LockedProfileRecord | null> {
  const result = await client.query<LockedProfileRecord>(
    `SELECT r.employee_id AS "employeeId", r.voided_at AS "voidedAt",
            (e.removed_at IS NOT NULL) AS "employeeRemoved",
            (e.management_scope = 'OUTSIDE_HCIS') AS "employeeOutsideHcis"
     FROM ${table} r
     JOIN employees e ON e.id = r.employee_id
     WHERE r.id = $1
     FOR UPDATE OF r`,
    [recordId],
  );
  return result.rows[0] ?? null;
}

// --------------------------------------------- sertifikat yang akan berakhir

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
}

/**
 * Sertifikat yang berakhir dalam rentang hari tertentu, termasuk yang sudah
 * lewat — agar HC dapat menjadwalkan sertifikasi ulang (spec §7.5).
 */
export async function listExpiringCertificates(
  db: Db,
  input: { today: string; withinDays: number; unitId: string | null; page: number; pageSize: number },
): Promise<{ total: number; rows: ExpiringCertificate[] }> {
  // Hitungan tidak memakai OFFSET, jadi ia punya daftar parameternya sendiri:
  // menumpang daftar query baris membuat PostgreSQL menolak karena $3 tidak
  // pernah dirujuk, atau karena jumlah parameternya tidak cocok.
  const rowParams: unknown[] = [input.today, input.withinDays, input.pageSize * (input.page - 1)];
  const countParams: unknown[] = [input.today, input.withinDays];
  if (input.unitId) {
    rowParams.push(input.unitId);
    countParams.push(input.unitId);
  }
  const from = (unitIndex: number) => `
    FROM employee_skills s
    JOIN employees e ON e.id = s.employee_id AND e.removed_at IS NULL
    LEFT JOIN organizational_units u ON u.id = e.organizational_unit_id
    WHERE s.kind = 'SERTIFIKAT'
      AND s.voided_at IS NULL
      AND s.expires_on IS NOT NULL
      AND s.expires_on <= $1::date + $2::int
      ${input.unitId ? `AND e.organizational_unit_id = $${unitIndex}::uuid` : ""}`;

  const [rows, count] = await Promise.all([
    db.query<ExpiringCertificate>(
      `SELECT s.id AS "recordId", s.employee_id AS "employeeId", e.employee_number AS "employeeNumber",
              e.full_name AS "fullName", u.name AS "unitName", s.name, s.issuer,
              s.expires_on::text AS "expiresOn", (s.expires_on - $1::date)::int AS "daysLeft",
              s.verification_status AS "verificationStatus"
       ${from(4)}
       ORDER BY s.expires_on, e.full_name, s.id
       LIMIT ${input.pageSize} OFFSET $3`,
      rowParams,
    ),
    db.query<{ total: number }>(
      `SELECT count(*)::int AS total ${from(3)}`,
      countParams,
    ),
  ]);
  return { total: count.rows[0]?.total ?? 0, rows: rows.rows };
}

// ------------------------------------------------------- EMP-009 keluarga

export interface FamilyMemberRow extends FamilyMemberValues {
  id: string;
  employeeId: string;
  voidedAt: string | null;
  voidedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

const FAMILY_COLUMNS = `
  id, employee_id AS "employeeId", relation, full_name AS "fullName", birth_date::text AS "birthDate",
  gender, is_dependent AS "isDependent", dependent_order AS "dependentOrder",
  is_emergency_contact AS "isEmergencyContact", emergency_phone AS "emergencyPhone",
  emergency_priority AS "emergencyPriority", valid_from::text AS "validFrom", valid_to::text AS "validTo",
  notes, voided_at AS "voidedAt", voided_reason AS "voidedReason",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

function toIsoPeriod<T extends { voidedAt: Date | null; createdAt: Date; updatedAt: Date }>(row: T) {
  return {
    ...row,
    voidedAt: row.voidedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type Dated<T> = Omit<T, "voidedAt" | "createdAt" | "updatedAt"> & {
  voidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export async function listFamilyMembers(db: Db, employeeId: string, includeVoided = false): Promise<FamilyMemberRow[]> {
  const result = await db.query<Dated<FamilyMemberRow>>(
    `SELECT ${FAMILY_COLUMNS} FROM employee_family_members
     WHERE employee_id = $1 ${includeVoided ? "" : "AND voided_at IS NULL"}
     ORDER BY is_emergency_contact DESC, emergency_priority NULLS LAST, relation, valid_from DESC, id`,
    [employeeId],
  );
  return result.rows.map(toIsoPeriod);
}

export async function getFamilyMember(db: Db, recordId: string): Promise<FamilyMemberRow | null> {
  const result = await db.query<Dated<FamilyMemberRow>>(
    `SELECT ${FAMILY_COLUMNS} FROM employee_family_members WHERE id = $1`,
    [recordId],
  );
  const row = result.rows[0];
  return row ? toIsoPeriod(row) : null;
}

/**
 * identity_number is deliberately absent from both writes: the column exists
 * so that the owner's decision needs no migration, and nothing may start
 * filling it before column encryption does (spec 8).
 */
export async function insertFamilyMember(
  client: PoolClient,
  employeeId: string,
  values: FamilyMemberValues,
  actorAccountId: string,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO employee_family_members
       (id, employee_id, relation, full_name, birth_date, gender, is_dependent, dependent_order,
        is_emergency_contact, emergency_phone, emergency_priority, valid_from, valid_to, notes,
        created_by_account_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [id, employeeId, values.relation, values.fullName, values.birthDate, values.gender, values.isDependent,
      values.dependentOrder, values.isEmergencyContact, values.emergencyPhone, values.emergencyPriority,
      values.validFrom, values.validTo, values.notes, actorAccountId],
  );
  return id;
}

export async function updateFamilyMember(
  client: PoolClient,
  recordId: string,
  values: FamilyMemberValues,
): Promise<void> {
  await client.query(
    `UPDATE employee_family_members SET relation = $2, full_name = $3, birth_date = $4, gender = $5,
       is_dependent = $6, dependent_order = $7, is_emergency_contact = $8, emergency_phone = $9,
       emergency_priority = $10, valid_from = $11, valid_to = $12, notes = $13, updated_at = now()
     WHERE id = $1`,
    [recordId, values.relation, values.fullName, values.birthDate, values.gender, values.isDependent,
      values.dependentOrder, values.isEmergencyContact, values.emergencyPhone, values.emergencyPriority,
      values.validFrom, values.validTo, values.notes],
  );
}

// --------------------------------------------------------- EMP-003 alamat

export interface AddressRow extends AddressValues {
  id: string;
  employeeId: string;
  voidedAt: string | null;
  voidedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

const ADDRESS_COLUMNS = `
  id, employee_id AS "employeeId", kind, address_line AS "addressLine", village, district, city, province,
  postal_code AS "postalCode", valid_from::text AS "validFrom", valid_to::text AS "validTo", source, notes,
  voided_at AS "voidedAt", voided_reason AS "voidedReason",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

export async function listAddresses(db: Db, employeeId: string, includeVoided = false): Promise<AddressRow[]> {
  const result = await db.query<Dated<AddressRow>>(
    `SELECT ${ADDRESS_COLUMNS} FROM employee_addresses
     WHERE employee_id = $1 ${includeVoided ? "" : "AND voided_at IS NULL"}
     ORDER BY kind, valid_from DESC, id`,
    [employeeId],
  );
  return result.rows.map(toIsoPeriod);
}

export async function getAddress(db: Db, recordId: string): Promise<AddressRow | null> {
  const result = await db.query<Dated<AddressRow>>(
    `SELECT ${ADDRESS_COLUMNS} FROM employee_addresses WHERE id = $1`,
    [recordId],
  );
  const row = result.rows[0];
  return row ? toIsoPeriod(row) : null;
}

/**
 * The address of one kind that is still open, locked for the move that is
 * about to close it.
 *
 * The lock serialises two moves; it does not by itself prevent two current
 * addresses. Under READ COMMITTED the second mover's snapshot predates the
 * first commit, so it sees no open address and tries to insert one anyway —
 * employee_addresses_single_current_excl is what refuses that, as a 409 the
 * operator retries. What the lock buys is that the two moves do not interleave
 * half-applied.
 */
export async function lockOpenAddress(
  client: PoolClient,
  employeeId: string,
  kind: string,
): Promise<{ id: string; validFrom: string; validTo: string | null } | null> {
  const result = await client.query<{ id: string; validFrom: string; validTo: string | null }>(
    `SELECT id, valid_from::text AS "validFrom", valid_to::text AS "validTo"
     FROM employee_addresses
     WHERE employee_id = $1 AND kind = $2 AND voided_at IS NULL AND valid_to IS NULL
     ORDER BY valid_from DESC
     LIMIT 1
     FOR UPDATE`,
    [employeeId, kind],
  );
  return result.rows[0] ?? null;
}

export async function closeAddress(client: PoolClient, recordId: string, on: string): Promise<void> {
  await client.query(
    "UPDATE employee_addresses SET valid_to = $2::date, updated_at = now() WHERE id = $1",
    [recordId, on],
  );
}

export async function insertAddress(
  client: PoolClient,
  employeeId: string,
  values: AddressValues,
  actorAccountId: string,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO employee_addresses
       (id, employee_id, kind, address_line, village, district, city, province, postal_code,
        valid_from, valid_to, source, notes, created_by_account_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [id, employeeId, values.kind, values.addressLine, values.village, values.district, values.city,
      values.province, values.postalCode, values.validFrom, values.validTo, values.source, values.notes,
      actorAccountId],
  );
  return id;
}

export async function updateAddress(client: PoolClient, recordId: string, values: AddressValues): Promise<void> {
  await client.query(
    `UPDATE employee_addresses SET kind = $2, address_line = $3, village = $4, district = $5, city = $6,
       province = $7, postal_code = $8, valid_from = $9, valid_to = $10, source = $11, notes = $12,
       updated_at = now()
     WHERE id = $1`,
    [recordId, values.kind, values.addressLine, values.village, values.district, values.city, values.province,
      values.postalCode, values.validFrom, values.validTo, values.source, values.notes],
  );
}

// ------------------------------------- EMP-003 usulan perubahan data (P2-4)

export interface DataChangeRequestRow {
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

const REQUEST_COLUMNS = `
  r.id, r.employee_id AS "employeeId", e.employee_number AS "employeeNumber", e.full_name AS "fullName",
  u.name AS "unitName", r.submitted_by_account_id AS "submittedByAccountId", r.target, r.payload, r.state,
  r.decided_by_account_id AS "decidedByAccountId", r.decided_at AS "decidedAt", r.decision_note AS "decisionNote",
  r.created_at AS "createdAt", r.updated_at AS "updatedAt"`;

const REQUEST_FROM = `
  FROM employee_data_change_requests r
  JOIN employees e ON e.id = r.employee_id
  LEFT JOIN organizational_units u ON u.id = e.organizational_unit_id`;

type RequestDates<T> = Omit<T, "decidedAt" | "createdAt" | "updatedAt"> & {
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function requestToIso(row: RequestDates<DataChangeRequestRow>): DataChangeRequestRow {
  return {
    ...row,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function insertDataChangeRequest(
  client: PoolClient,
  input: {
    employeeId: string;
    submittedByAccountId: string;
    target: DataChangeTarget;
    payload: Record<string, unknown>;
  },
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO employee_data_change_requests (id, employee_id, submitted_by_account_id, target, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [id, input.employeeId, input.submittedByAccountId, input.target, JSON.stringify(input.payload)],
  );
  return id;
}

export async function getDataChangeRequest(db: Db, requestId: string): Promise<DataChangeRequestRow | null> {
  const result = await db.query<RequestDates<DataChangeRequestRow>>(
    `SELECT ${REQUEST_COLUMNS} ${REQUEST_FROM} WHERE r.id = $1`,
    [requestId],
  );
  const row = result.rows[0];
  return row ? requestToIso(row) : null;
}

export interface LockedDataChangeRequest {
  employeeId: string;
  submittedByAccountId: string;
  target: DataChangeTarget;
  payload: Record<string, unknown>;
  state: DataChangeState;
  /** EMP-001: removed from the master, so nothing may be written for them. */
  employeeRemoved: boolean;
  /** S2B §8.7: outside HCIS management, so the record is read-only. */
  employeeOutsideHcis: boolean;
}

/** Locks the request for the decision; null when there is no such request. */
export async function lockDataChangeRequest(
  client: PoolClient,
  requestId: string,
): Promise<LockedDataChangeRequest | null> {
  const result = await client.query<LockedDataChangeRequest>(
    `SELECT r.employee_id AS "employeeId", r.submitted_by_account_id AS "submittedByAccountId",
            r.target, r.payload, r.state, (e.removed_at IS NOT NULL) AS "employeeRemoved",
            (e.management_scope = 'OUTSIDE_HCIS') AS "employeeOutsideHcis"
     FROM employee_data_change_requests r
     JOIN employees e ON e.id = r.employee_id
     WHERE r.id = $1
     FOR UPDATE OF r`,
    [requestId],
  );
  return result.rows[0] ?? null;
}

export async function decideDataChangeRequest(
  client: PoolClient,
  requestId: string,
  input: { state: DataChangeState; decidedByAccountId: string | null; decisionNote: string | null },
): Promise<void> {
  await client.query(
    `UPDATE employee_data_change_requests
     SET state = $2, decided_by_account_id = $3, decided_at = now(), decision_note = $4, updated_at = now()
     WHERE id = $1`,
    [requestId, input.state, input.decidedByAccountId, input.decisionNote],
  );
}

/** The employee's own proposals, newest first; their own screen is unpaged by design. */
export async function listOwnDataChangeRequests(db: Db, employeeId: string): Promise<DataChangeRequestRow[]> {
  const result = await db.query<RequestDates<DataChangeRequestRow>>(
    `SELECT ${REQUEST_COLUMNS} ${REQUEST_FROM} WHERE r.employee_id = $1 ORDER BY r.created_at DESC, r.id LIMIT 200`,
    [employeeId],
  );
  return result.rows.map(requestToIso);
}

/**
 * HC's worklist. Waiting longest first, because that is the order the spec
 * asks HC to work in (§7.4). Counted separately so a page past the end still
 * reports the real total.
 */
export async function listDataChangeRequests(
  db: Db,
  input: { state: DataChangeState | null; unitId: string | null; page: number; pageSize: number },
): Promise<{ total: number; rows: DataChangeRequestRow[] }> {
  // Each query builds its own clauses and its own parameter list. The count
  // has no OFFSET, so sharing one list would leave it an unreferenced
  // placeholder and PostgreSQL would refuse the statement outright.
  function clauses(firstIndex: number): { where: string; params: unknown[] } {
    const parts: string[] = [];
    const params: unknown[] = [];
    if (input.state) {
      params.push(input.state);
      parts.push(`r.state = $${firstIndex + params.length - 1}`);
    }
    if (input.unitId) {
      params.push(input.unitId);
      parts.push(`e.organizational_unit_id = $${firstIndex + params.length - 1}::uuid`);
    }
    return { where: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params };
  }
  const forRows = clauses(2);
  const forCount = clauses(1);
  // A removed employee's proposals cannot be accepted (the decision refuses
  // with EMPLOYEE_NOT_FOUND), so leaving them in the queue would ask HC to
  // reject each one by hand for a reason that is not theirs.
  const managed = "e.removed_at IS NULL";
  const withManaged = (where: string) => (where ? `${where} AND ${managed}` : `WHERE ${managed}`);

  const [rows, count] = await Promise.all([
    db.query<RequestDates<DataChangeRequestRow>>(
      `SELECT ${REQUEST_COLUMNS} ${REQUEST_FROM} ${withManaged(forRows.where)}
       ORDER BY r.created_at, r.id
       LIMIT ${input.pageSize} OFFSET $1`,
      [input.pageSize * (input.page - 1), ...forRows.params],
    ),
    db.query<{ total: number }>(
      `SELECT count(*)::int AS total ${REQUEST_FROM} ${withManaged(forCount.where)}`,
      forCount.params,
    ),
  ]);
  return { total: count.rows[0]?.total ?? 0, rows: rows.rows.map(requestToIso) };
}

/**
 * Accepting a KONTAK proposal writes the master's own columns — only the ones
 * the proposal named. Writing both unconditionally set the other to NULL,
 * deleting a contact detail nobody had proposed changing.
 */
export async function updateEmployeeContact(
  client: PoolClient,
  employeeId: string,
  values: ContactValues,
): Promise<void> {
  const assignments: string[] = [];
  const params: unknown[] = [employeeId];
  if ("email" in values) {
    params.push(values.email ?? null);
    assignments.push(`email = $${params.length}`);
  }
  if ("phone" in values) {
    params.push(values.phone ?? null);
    assignments.push(`phone = $${params.length}`);
  }
  if (assignments.length === 0) return;
  await client.query(
    `UPDATE employees SET ${assignments.join(", ")}, updated_at = now() WHERE id = $1`,
    params,
  );
}
