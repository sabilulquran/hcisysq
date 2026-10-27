// Paket 2 P2-2 adapter (spec docs/domain/employment-administration-package2.md
// §4.1, §4.2, §5.6, §7.5). Aturan ada di ../domain/employee-profile.ts; berkas
// ini hanya membaca dan menulis baris serta mencatat audit dalam transaksi yang
// sama. Kolom DATE dibaca sebagai teks agar tanggalnya tidak bergeser zona.

import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type { EducationValues, SkillValues, VerificationStatus } from "../domain/employee-profile.js";

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
  table: ProfileTable,
  recordId: string,
  reason: string,
): Promise<void> {
  await client.query(
    `UPDATE ${table} SET voided_at = now(), voided_reason = $2, updated_at = now() WHERE id = $1`,
    [recordId, reason],
  );
}

/** Mengunci baris untuk baca-ubah-tulis; null bila catatannya tidak ada. */
export async function lockProfileRecord(
  client: PoolClient,
  table: ProfileTable,
  recordId: string,
): Promise<{ employeeId: string; voidedAt: Date | null } | null> {
  const result = await client.query<{ employeeId: string; voidedAt: Date | null }>(
    `SELECT employee_id AS "employeeId", voided_at AS "voidedAt" FROM ${table} WHERE id = $1 FOR UPDATE`,
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
  const filters = input.unitId ? "AND e.organizational_unit_id = $4::uuid" : "";
  const params: unknown[] = [input.today, input.withinDays, input.pageSize * (input.page - 1)];
  if (input.unitId) params.push(input.unitId);
  const from = `
    FROM employee_skills s
    JOIN employees e ON e.id = s.employee_id AND e.removed_at IS NULL
    LEFT JOIN organizational_units u ON u.id = e.organizational_unit_id
    WHERE s.kind = 'SERTIFIKAT'
      AND s.voided_at IS NULL
      AND s.expires_on IS NOT NULL
      AND s.expires_on <= $1::date + $2::int ${filters}`;

  const [rows, count] = await Promise.all([
    db.query<ExpiringCertificate>(
      `SELECT s.id AS "recordId", s.employee_id AS "employeeId", e.employee_number AS "employeeNumber",
              e.full_name AS "fullName", u.name AS "unitName", s.name, s.issuer,
              s.expires_on::text AS "expiresOn", (s.expires_on - $1::date)::int AS "daysLeft",
              s.verification_status AS "verificationStatus"
       ${from}
       ORDER BY s.expires_on, e.full_name, s.id
       LIMIT ${input.pageSize} OFFSET $3`,
      params,
    ),
    db.query<{ total: number }>(
      `SELECT count(*)::int AS total ${from}`,
      input.unitId ? [input.today, input.withinDays, 0, input.unitId] : [input.today, input.withinDays, 0],
    ),
  ]);
  return { total: count.rows[0]?.total ?? 0, rows: rows.rows };
}
