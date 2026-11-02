// TRAIN-001 Package 1 routes: training programs, sessions with time blocking, participants,
// attendance, training records, certificates and the hours summary.
// Spec: docs/domain/training.md.
//
// training.* is HC-only: legacy Super Admin compatibility never grants it, so the admin routes
// resolve the permission from the organization context directly, like trips.* and documents.*.
// Employee access is ownership (the session's employee), never a permission.

import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { pageOffset, pageQuerySchema, pagination } from "../../lib/pagination.js";
import { decryptSecret, encryptSecret } from "../auth/crypto.js";
import type { TrainingPermission } from "../auth/permissions.js";
import { AUTH_COOKIE_NAME, AuthService, readCookie, type AuthPrincipal } from "../auth/service.js";
import { jakartaDate } from "../documents/service.js";
import { notifyEmployee } from "../notifications/service.js";
import {
  ATTENDANCE_STATUSES,
  CERTIFICATE_CONTENT_TYPES,
  CertificateError,
  computeCompletion,
  decodeCertificate,
  DEFAULT_ORGANIZER,
  evaluateAvailability,
  jakartaDateOf,
  jakartaDateRangeInterval,
  MAX_ENROLL_BATCH,
  MAX_SESSIONS_PER_PROGRAM,
  PROGRAM_STATUSES,
  RECORD_STATUSES,
  TRAINING_CATEGORIES,
  TrainingPolicyError,
  validateExternalRecord,
  validateSessionTimes,
  type AttendanceStatus,
  type BusySpan,
  type Conflict,
  type Interval,
  type ProgramStatus,
} from "./domain.js";

type Queryable = Pool | PoolClient;

const idParams = z.object({ id: z.string().uuid() });
const participantParams = z.object({ id: z.string().uuid(), employeeId: z.string().uuid() });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const instant = z.string().datetime({ offset: true });
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional()
  .transform((value) => (value ? value : null));

const programBody = z.object({
  title: z.string().trim().min(3).max(200),
  category: z.enum(TRAINING_CATEGORIES),
  description: optionalText(2000),
  organizer: z.string().trim().min(3).max(200).nullable().optional(),
  capacity: z.number().int().min(1).max(500).nullable().optional(),
  minAttendancePercent: z.number().int().min(50).max(100).optional(),
});
const programPatch = programBody.partial();
const programReason = z.object({ reason: z.string().trim().min(10).max(500) });
const shortReason = z.object({ reason: z.string().trim().min(5).max(500) });
const sessionBody = z.object({
  title: z.string().trim().min(3).max(200),
  startAt: instant,
  endAt: instant,
  location: optionalText(200),
  speakerEmployeeId: z.string().uuid().nullable().optional(),
  speakerName: z.string().trim().min(2).max(150).nullable().optional(),
}).refine((value) => !(value.speakerEmployeeId && value.speakerName), { message: "speaker" });
const sessionPatch = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  startAt: instant.optional(),
  endAt: instant.optional(),
  location: optionalText(200),
  speakerEmployeeId: z.string().uuid().nullable().optional(),
  speakerName: z.string().trim().min(2).max(150).nullable().optional(),
}).refine((value) => !(value.speakerEmployeeId && value.speakerName), { message: "speaker" })
  .refine((value) => (value.startAt === undefined) === (value.endAt === undefined), { message: "times" });
const enrollBody = z.object({ employeeIds: z.array(z.string().uuid()).min(1).max(MAX_ENROLL_BATCH) });
const attendanceBody = z.object({
  entries: z.array(z.object({
    employeeId: z.string().uuid(),
    status: z.enum(ATTENDANCE_STATUSES),
    note: optionalText(300),
  })).min(1).max(100),
});
const availabilityBody = z.object({
  programId: z.string().uuid(),
  sessionId: z.string().uuid().optional(),
  startAt: instant.optional(),
  endAt: instant.optional(),
  speakerEmployeeId: z.string().uuid().nullable().optional(),
  employeeIds: z.array(z.string().uuid()).min(1).max(MAX_ENROLL_BATCH).optional(),
}).refine((value) => (value.startAt === undefined) === (value.endAt === undefined), { message: "times" });
const certificateBody = z.object({
  fileName: z.string().trim().min(1).max(180),
  contentType: z.enum(CERTIFICATE_CONTENT_TYPES),
  contentBase64: z.string().min(1).max(3_000_000),
});
const externalBody = z.object({
  title: z.string().trim().min(3).max(200),
  category: z.enum(TRAINING_CATEGORIES),
  organizer: z.string().trim().min(3).max(200),
  description: optionalText(2000),
  startOn: isoDate,
  endOn: isoDate,
  hours: z.number(),
  certificate: certificateBody.nullable().optional(),
  idempotencyKey: z.string().uuid(),
});
const yearSchema = z.coerce.number().int().min(2000).max(2100);
const programListQuery = pageQuerySchema.extend({
  status: z.enum(PROGRAM_STATUSES).optional(),
  q: z.string().trim().max(100).optional(),
});
const participantListQuery = pageQuerySchema.extend({ q: z.string().trim().max(100).optional() });
const recordListQuery = pageQuerySchema.extend({
  status: z.enum(RECORD_STATUSES).optional(),
  source: z.enum(["INTERNAL", "EXTERNAL"]).optional(),
  employeeId: z.string().uuid().optional(),
  year: yearSchema.optional(),
});
const myRecordQuery = pageQuerySchema.extend({ year: yearSchema.optional() });
const hoursQuery = pageQuerySchema.extend({ year: yearSchema.optional(), q: z.string().trim().max(100).optional() });
const yearQuery = z.object({ year: yearSchema.optional() });
const optionsQuery = z.object({ q: z.string().trim().min(2).max(100) });

class TrainingError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "TrainingError";
  }
}

function send(reply: FastifyReply, status: number, body: unknown) {
  reply.header("Cache-Control", "no-store");
  return reply.status(status).send(body);
}

function currentYear(): number {
  return Number(jakartaDate(new Date()).slice(0, 4));
}

function knownError(error: unknown): TrainingError | null {
  if (error instanceof TrainingError) return error;
  if (error instanceof TrainingPolicyError || error instanceof CertificateError) {
    return new TrainingError(error.statusCode, error.code, error.message);
  }
  return null;
}

function safeDownloadName(value: string) {
  return value.replace(/[\r\n"\\]/g, "_");
}

const notFound = () => new TrainingError(404, "TRAINING_PROGRAM_NOT_FOUND", "Program pelatihan tidak ditemukan.");
const recordNotFound = () => new TrainingError(404, "TRAINING_RECORD_NOT_FOUND", "Catatan pelatihan tidak ditemukan.");

async function audit(
  db: Queryable,
  input: {
    eventType: string;
    actorAccountId: string | null;
    programId?: string | null;
    sessionId?: string | null;
    recordId?: string | null;
    employeeId?: string | null;
    note?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  // clock_timestamp(), not now(): events written in one transaction keep their order.
  await db.query(
    `INSERT INTO training_audit_events
       (id, event_type, program_id, session_id, record_id, employee_id, actor_account_id, note, metadata, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, clock_timestamp())`,
    [
      randomUUID(), input.eventType, input.programId ?? null, input.sessionId ?? null, input.recordId ?? null,
      input.employeeId ?? null, input.actorAccountId, input.note ?? null, JSON.stringify(input.metadata ?? {}),
    ],
  );
}

async function loadSelf(db: Queryable, accountId: string, lock = false): Promise<{ id: string; fullName: string }> {
  const result = await db.query<{ id: string; fullName: string; status: string }>(
    `SELECT employee.id, employee.full_name AS "fullName", employee.status
       FROM accounts account
       JOIN employees employee ON employee.id = account.employee_id
      WHERE account.id = $1 AND account.principal_type = 'EMPLOYEE' AND account.status = 'active'
        AND employee.removed_at IS NULL
      ${lock ? "FOR UPDATE OF employee" : ""}`,
    [accountId],
  );
  const employee = result.rows[0];
  if (!employee || employee.status !== "active") {
    throw new TrainingError(403, "EMPLOYEE_NOT_ACTIVE", "Akun tidak terhubung ke pegawai aktif.");
  }
  return employee;
}

interface ProgramRow {
  id: string;
  title: string;
  category: string;
  organizer: string;
  capacity: number | null;
  minAttendancePercent: number;
  status: ProgramStatus;
}

async function lockProgram(db: Queryable, id: string, requireActive = true): Promise<ProgramRow> {
  const result = await db.query<ProgramRow>(
    `SELECT id, title, category, organizer, capacity, min_attendance_percent AS "minAttendancePercent", status
       FROM training_programs WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const program = result.rows[0];
  if (!program) throw notFound();
  if (requireActive && program.status !== "ACTIVE") {
    throw new TrainingError(409, "TRAINING_PROGRAM_CLOSED", "Program pelatihan sudah ditutup atau dibatalkan.");
  }
  return program;
}

/**
 * §7.2: lock every person involved, in id order, before computing availability. CAL-001 locks
 * the same rows, so a meeting and a session for one person cannot both pass the check.
 */
async function lockPeople(db: Queryable, ids: readonly string[]) {
  const unique = [...new Set(ids)].sort();
  if (unique.length === 0) return [];
  const result = await db.query<{ id: string; fullName: string; status: string }>(
    `SELECT id, full_name AS "fullName", status FROM employees
      WHERE id = ANY($1::uuid[]) AND removed_at IS NULL
      ORDER BY id ASC FOR UPDATE`,
    [unique],
  );
  const inactive = unique.filter((id) => !result.rows.some((row) => row.id === id && row.status === "active"));
  if (inactive.length > 0) {
    throw new TrainingError(409, "TRAINING_EMPLOYEE_NOT_ACTIVE", "Pegawai yang dipilih harus pegawai aktif.", { employeeIds: inactive });
  }
  return result.rows.map((row) => ({ employeeId: row.id, name: row.fullName }));
}

/** §7.1 sources, reduced to intervals for `evaluateAvailability`. */
async function loadBusy(db: Queryable, employeeIds: readonly string[], window: Interval): Promise<BusySpan[]> {
  if (employeeIds.length === 0) return [];
  const from = new Date(window.startMs).toISOString();
  const to = new Date(window.endMs).toISOString();
  const spans: BusySpan[] = [];
  const training = await db.query<{ employeeId: string; sessionId: string; title: string; startAt: Date; endAt: Date }>(
    `SELECT employee_id AS "employeeId", session_id AS "sessionId", title,
            lower(busy) AS "startAt", upper(busy) AS "endAt"
       FROM training_employee_busy
      WHERE employee_id = ANY($1::uuid[]) AND busy && tstzrange($2::timestamptz, $3::timestamptz, '[)')`,
    [employeeIds, from, to],
  );
  for (const row of training.rows) {
    spans.push({
      employeeId: row.employeeId, reason: "IN_TRAINING", sessionId: row.sessionId, title: row.title,
      startMs: row.startAt.getTime(), endMs: row.endAt.getTime(),
    });
  }
  // CAL-001 migration 0117 may not be applied yet; the source turns on by itself once it is.
  const calendar = await db.query<{ present: boolean }>(
    `SELECT to_regclass('public.meeting_participants') IS NOT NULL AS present`,
  );
  if (calendar.rows[0]?.present) {
    const meetings = await db.query<{ employeeId: string; title: string; confidential: boolean; startAt: Date; endAt: Date }>(
      `SELECT participant.employee_id AS "employeeId", meeting.title, meeting.confidential,
              lower(participant.busy) AS "startAt", upper(participant.busy) AS "endAt"
         FROM meeting_participants participant
         JOIN meetings meeting ON meeting.id = participant.meeting_id
        WHERE participant.blocks_time AND participant.employee_id = ANY($1::uuid[])
          AND participant.busy && tstzrange($2::timestamptz, $3::timestamptz, '[)')`,
      [employeeIds, from, to],
    );
    for (const row of meetings.rows) {
      spans.push({
        employeeId: row.employeeId, reason: "MEETING_OVERLAP", title: row.confidential ? null : row.title,
        startMs: row.startAt.getTime(), endMs: row.endAt.getTime(),
      });
    }
  }
  const firstDate = jakartaDateOf(window.startMs);
  const lastDate = jakartaDateOf(window.endMs - 1);
  const dated = await db.query<{ employeeId: string; source: string; status: string; startOn: string; endOn: string }>(
    `SELECT employee_id AS "employeeId", 'leave' AS source, status,
            to_char(start_on, 'YYYY-MM-DD') AS "startOn", to_char(end_on, 'YYYY-MM-DD') AS "endOn"
       FROM leave_requests
      WHERE employee_id = ANY($1::uuid[]) AND status IN ('approved', 'in_review')
        AND start_on <= $3::date AND end_on >= $2::date
     UNION ALL
     SELECT employee_id, 'trip', status, to_char(start_on, 'YYYY-MM-DD'), to_char(end_on, 'YYYY-MM-DD')
       FROM business_trip_requests
      WHERE employee_id = ANY($1::uuid[]) AND status IN ('APPROVED', 'ISSUED', 'IN_REVIEW')
        AND start_on <= $3::date AND end_on >= $2::date`,
    [employeeIds, firstDate, lastDate],
  );
  for (const row of dated.rows) {
    const reason = row.source === "leave"
      ? (row.status === "approved" ? "ON_LEAVE" : "LEAVE_PENDING")
      : (row.status === "IN_REVIEW" ? "TRIP_PENDING" : "ON_TRIP");
    // Never the leave type, leave reason or trip destination (§7.1).
    spans.push({ employeeId: row.employeeId, reason, title: null, ...jakartaDateRangeInterval(row.startOn, row.endOn) });
  }
  return spans;
}

interface CheckedSession extends Interval {
  id: string | null;
  title: string;
}

/** Throws 409 TRAINING_CONFLICT on a block; returns the warnings otherwise. */
async function assertAvailable(
  db: Queryable,
  sessions: readonly CheckedSession[],
  people: ReadonlyArray<{ employeeId: string; name: string }>,
): Promise<Conflict[]> {
  const result = await checkAvailability(db, sessions, people);
  if (result.blocks.length > 0) {
    throw new TrainingError(409, "TRAINING_CONFLICT", "Jadwal bentrok dengan kegiatan lain pegawai.", { conflicts: result.blocks });
  }
  return result.warnings;
}

async function checkAvailability(
  db: Queryable,
  sessions: readonly CheckedSession[],
  people: ReadonlyArray<{ employeeId: string; name: string }>,
) {
  if (sessions.length === 0 || people.length === 0) return { blocks: [], warnings: [] };
  const window = {
    startMs: Math.min(...sessions.map((session) => session.startMs)),
    endMs: Math.max(...sessions.map((session) => session.endMs)),
  };
  const busy = await loadBusy(db, people.map((person) => person.employeeId), window);
  return evaluateAvailability({ sessions, people, busy, nowMs: Date.now() });
}

async function scheduledSessions(db: Queryable, programId: string): Promise<CheckedSession[]> {
  const result = await db.query<{ id: string; title: string; startAt: Date; endAt: Date }>(
    `SELECT id, title, start_at AS "startAt", end_at AS "endAt"
       FROM training_sessions WHERE program_id = $1 AND status = 'SCHEDULED'
      ORDER BY start_at ASC`,
    [programId],
  );
  return result.rows.map((row) => ({ id: row.id, title: row.title, startMs: row.startAt.getTime(), endMs: row.endAt.getTime() }));
}

async function enrolledIds(db: Queryable, programId: string): Promise<string[]> {
  const result = await db.query<{ employeeId: string }>(
    `SELECT employee_id AS "employeeId" FROM training_participants WHERE program_id = $1 AND status = 'ENROLLED'`,
    [programId],
  );
  return result.rows.map((row) => row.employeeId);
}

async function notifyMany(
  db: Queryable,
  employeeIds: readonly string[],
  input: { eventKey: (employeeId: string) => string; title: string; body: string; href: string; actorAccountId: string },
) {
  for (const employeeId of employeeIds) {
    await notifyEmployee(db, employeeId, {
      eventKey: input.eventKey(employeeId), category: "system", title: input.title, body: input.body,
      href: input.href, actorAccountId: input.actorAccountId,
    });
  }
}

const wib = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
});

const PROGRAM_COLUMNS = `
  program.id, program.title, program.category, program.description, program.organizer, program.capacity,
  program.min_attendance_percent AS "minAttendancePercent", program.status, program.cancel_reason AS "cancelReason",
  program.created_at AS "createdAt", program.closed_at AS "closedAt",
  (SELECT count(*)::int FROM training_participants participant
    WHERE participant.program_id = program.id AND participant.status <> 'WITHDRAWN') AS "participantCount",
  (SELECT count(*)::int FROM training_sessions session
    WHERE session.program_id = program.id AND session.status = 'SCHEDULED') AS "sessionCount",
  (SELECT min(session.start_at) FROM training_sessions session
    WHERE session.program_id = program.id AND session.status = 'SCHEDULED') AS "firstSessionAt",
  (SELECT max(session.end_at) FROM training_sessions session
    WHERE session.program_id = program.id AND session.status = 'SCHEDULED') AS "lastSessionEndAt"`;

const SESSION_COLUMNS = `
  session.id, session.program_id AS "programId", session.title, session.start_at AS "startAt", session.end_at AS "endAt",
  session.location, session.speaker_employee_id AS "speakerEmployeeId",
  COALESCE(speaker.full_name, session.speaker_name) AS "speakerName", session.status,
  session.cancel_reason AS "cancelReason"`;

const RECORD_COLUMNS = `
  record.id, record.employee_id AS "employeeId", record.source, record.role, record.program_id AS "programId",
  record.title, record.category, record.organizer, record.description,
  to_char(record.start_on, 'YYYY-MM-DD') AS "startOn", to_char(record.end_on, 'YYYY-MM-DD') AS "endOn",
  record.hours::float8 AS hours, record.completed, record.status, record.reject_reason AS "rejectReason",
  record.decided_at AS "decidedAt", record.created_at AS "createdAt",
  certificate.id AS "certificateId", certificate.original_filename AS "certificateFileName",
  certificate.content_type AS "certificateContentType", certificate.byte_size AS "certificateByteSize"`;

export async function registerTrainingRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
  injectedAuth?: Pick<AuthService, "getSession" | "getAuthorizationContext">,
) {
  const encryptionKey = config.AUTH_ENCRYPTION_KEY;
  if (!encryptionKey) throw new Error("AUTH_ENCRYPTION_KEY is required for training routes");
  const auth = injectedAuth ?? new AuthService(
    pool, encryptionKey, config.AUTH_SESSION_TTL_HOURS, config.NODE_ENV === "production",
  );

  async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<AuthPrincipal | null> {
    const session = await auth.getSession(readCookie(request.headers.cookie, AUTH_COOKIE_NAME));
    if (!session) {
      await send(reply, 401, { code: "UNAUTHENTICATED", message: "Sesi tidak ditemukan atau sudah berakhir." });
      return null;
    }
    return session.principal;
  }

  async function requireEmployee(request: FastifyRequest, reply: FastifyReply): Promise<AuthPrincipal | null> {
    const principal = await authenticate(request, reply);
    if (!principal) return null;
    if (principal.principalType !== "EMPLOYEE") {
      await send(reply, 403, { code: "FORBIDDEN", message: "Pelatihan hanya tersedia untuk pegawai." });
      return null;
    }
    return principal;
  }

  async function requirePermission(
    request: FastifyRequest,
    reply: FastifyReply,
    permission: TrainingPermission,
  ): Promise<AuthPrincipal | null> {
    const principal = await authenticate(request, reply);
    if (!principal) return null;
    const context = await auth.getAuthorizationContext(principal);
    if (!context.organizationPermissions.includes(permission)) {
      await send(reply, 403, { code: "TRAINING_FORBIDDEN", message: "Anda tidak memiliki akses untuk tindakan ini." });
      return null;
    }
    return principal;
  }

  async function handle(reply: FastifyReply, work: () => Promise<unknown>) {
    try {
      return await work();
    } catch (error) {
      const known = knownError(error);
      if (!known) throw error;
      return send(reply, known.statusCode, { code: known.code, message: known.message, ...known.details });
    }
  }

  async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Runs `work` in one transaction and answers only after COMMIT succeeded. */
  async function transact(reply: FastifyReply, work: (client: PoolClient) => Promise<[number, unknown]>) {
    return handle(reply, async () => {
      const [status, body] = await inTransaction(work);
      return send(reply, status, body);
    });
  }

  function invalid(reply: FastifyReply, code: string, message: string) {
    return send(reply, 400, { code, message });
  }

  async function storeCertificate(
    client: PoolClient,
    input: { recordId: string; employeeId: string; actorAccountId: string; file: z.infer<typeof certificateBody> },
  ) {
    const bytes = decodeCertificate(input.file.contentType, input.file.contentBase64);
    const encrypted = encryptSecret(bytes.toString("base64"), encryptionKey!);
    const id = randomUUID();
    await client.query(
      `INSERT INTO training_certificates
         (id, record_id, original_filename, content_type, byte_size, ciphertext, iv, auth_tag, uploaded_by_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, input.recordId, input.file.fileName, input.file.contentType, bytes.length,
        encrypted.ciphertext, encrypted.iv, encrypted.tag, input.actorAccountId],
    );
    // D-10: the previous certificate stays stored as evidence; the record points to the new one.
    await client.query(`UPDATE training_records SET certificate_id = $2, updated_at = now() WHERE id = $1`, [input.recordId, id]);
    await audit(client, {
      eventType: "training.certificate.uploaded", recordId: input.recordId, employeeId: input.employeeId,
      actorAccountId: input.actorAccountId,
      metadata: { certificateId: id, contentType: input.file.contentType, byteSize: bytes.length },
    });
    return { id, fileName: input.file.fileName, contentType: input.file.contentType, byteSize: bytes.length };
  }

  async function sendCertificate(reply: FastifyReply, recordId: string, ownerEmployeeId: string | null) {
    const result = await pool.query<{
      fileName: string; contentType: string; ciphertext: string; iv: string; authTag: string;
    }>(
      `SELECT certificate.original_filename AS "fileName", certificate.content_type AS "contentType",
              certificate.ciphertext, certificate.iv, certificate.auth_tag AS "authTag"
         FROM training_records record
         JOIN training_certificates certificate ON certificate.id = record.certificate_id
        WHERE record.id = $1 AND ($2::uuid IS NULL OR record.employee_id = $2)`,
      [recordId, ownerEmployeeId],
    );
    const certificate = result.rows[0];
    if (!certificate) return send(reply, 404, { code: "TRAINING_CERTIFICATE_NOT_FOUND", message: "Sertifikat tidak ditemukan." });
    const base64 = decryptSecret({ ciphertext: certificate.ciphertext, iv: certificate.iv, tag: certificate.authTag }, encryptionKey!);
    reply.header("Cache-Control", "private, no-store");
    reply.header("Content-Type", certificate.contentType);
    reply.header("Content-Disposition", `attachment; filename="${safeDownloadName(certificate.fileName)}"`);
    return reply.send(Buffer.from(base64, "base64"));
  }

  async function hoursSummary(db: Queryable, employeeId: string, year: number) {
    const result = await db.query(
      `SELECT $2::int AS year,
              COALESCE(sum(hours) FILTER (WHERE role = 'PARTICIPANT'), 0)::float8 AS "totalHours",
              COALESCE(sum(hours) FILTER (WHERE role = 'PARTICIPANT' AND source = 'INTERNAL'), 0)::float8 AS "internalHours",
              COALESCE(sum(hours) FILTER (WHERE role = 'PARTICIPANT' AND source = 'EXTERNAL'), 0)::float8 AS "externalHours",
              COALESCE(sum(hours) FILTER (WHERE role = 'SPEAKER'), 0)::float8 AS "speakerHours",
              count(*) FILTER (WHERE role = 'PARTICIPANT')::int AS "recordCount"
         FROM training_records
        WHERE employee_id = $1 AND status = 'VERIFIED' AND extract(year FROM end_on) = $2`,
      [employeeId, year],
    );
    return result.rows[0];
  }

  // ---------------------------------------------------------------- employee

  app.get("/training/me/summary", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const query = yearQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, "INVALID_TRAINING_FILTER", "Filter tidak valid.");
    return handle(reply, async () => {
      const self = await loadSelf(pool, principal.id);
      return send(reply, 200, await hoursSummary(pool, self.id, query.data.year ?? currentYear()));
    });
  });

  app.get("/training/me/records", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const query = myRecordQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, "INVALID_TRAINING_FILTER", "Filter tidak valid.");
    return handle(reply, async () => {
      const self = await loadSelf(pool, principal.id);
      const result = await pool.query<{ total: number }>(
        `SELECT ${RECORD_COLUMNS}, count(*) OVER ()::int AS total
           FROM training_records record
           LEFT JOIN training_certificates certificate ON certificate.id = record.certificate_id
          WHERE record.employee_id = $1 AND ($2::int IS NULL OR extract(year FROM record.end_on) = $2)
          ORDER BY record.end_on DESC, record.created_at DESC, record.id DESC
          LIMIT $3 OFFSET $4`,
        [self.id, query.data.year ?? null, query.data.pageSize, pageOffset(query.data)],
      );
      return send(reply, 200, {
        items: result.rows.map(({ total, ...row }) => { void total; return row; }),
        pagination: pagination(query.data, result.rows[0]?.total ?? 0),
      });
    });
  });

  app.post("/training/me/records", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const body = externalBody.safeParse(request.body);
    if (!body.success) return invalid(reply, "INVALID_TRAINING_RECORD", "Data pelatihan eksternal tidak lengkap atau tidak valid.");
    return transact(reply, async (client) => {
      // Locking the employee row serializes this employee's submissions (idempotency replay).
      const self = await loadSelf(client, principal.id, true);
      const replay = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM training_records WHERE employee_id = $1 AND idempotency_key = $2`,
        [self.id, body.data.idempotencyKey],
      );
      if (replay.rows[0]) return [200, { ...replay.rows[0], idempotentReplay: true }];
      validateExternalRecord({ ...body.data, today: jakartaDate(new Date()) });
      const id = randomUUID();
      await client.query(
        `INSERT INTO training_records
           (id, employee_id, source, role, title, category, organizer, description, start_on, end_on, hours, status, idempotency_key)
         VALUES ($1, $2, 'EXTERNAL', 'PARTICIPANT', $3, $4, $5, $6, $7::date, $8::date, $9, 'SUBMITTED', $10)`,
        [id, self.id, body.data.title, body.data.category, body.data.organizer, body.data.description,
          body.data.startOn, body.data.endOn, body.data.hours, body.data.idempotencyKey],
      );
      await audit(client, {
        eventType: "training.record.submitted", recordId: id, employeeId: self.id, actorAccountId: principal.id,
        metadata: { hours: body.data.hours },
      });
      const certificate = body.data.certificate
        ? await storeCertificate(client, { recordId: id, employeeId: self.id, actorAccountId: principal.id, file: body.data.certificate })
        : null;
      return [201, { id, status: "SUBMITTED", certificate, idempotentReplay: false }];
    });
  });

  app.post("/training/me/records/:id/withdraw", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_TRAINING_RECORD_ID", "Catatan pelatihan tidak valid.");
    return transact(reply, async (client) => {
      const self = await loadSelf(client, principal.id);
      const found = await client.query<{ status: string }>(
        `SELECT status FROM training_records WHERE id = $1 AND employee_id = $2 AND source = 'EXTERNAL' FOR UPDATE`,
        [params.data.id, self.id],
      );
      if (!found.rows[0]) throw recordNotFound();
      if (found.rows[0].status !== "SUBMITTED") {
        throw new TrainingError(409, "TRAINING_RECORD_NOT_PENDING", "Catatan ini sudah diputus Human Capital.");
      }
      await client.query(`UPDATE training_records SET status = 'WITHDRAWN', updated_at = now() WHERE id = $1`, [params.data.id]);
      await audit(client, { eventType: "training.record.withdrawn", recordId: params.data.id, employeeId: self.id, actorAccountId: principal.id });
      return [200, { id: params.data.id, status: "WITHDRAWN" }];
    });
  });

  app.post("/training/me/records/:id/certificate", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_TRAINING_RECORD_ID", "Catatan pelatihan tidak valid.");
    const body = certificateBody.safeParse(request.body);
    if (!body.success) return invalid(reply, "INVALID_CERTIFICATE", "Sertifikat tidak valid.");
    return transact(reply, async (client) => {
      const self = await loadSelf(client, principal.id);
      const found = await client.query<{ status: string; source: string }>(
        `SELECT status, source FROM training_records WHERE id = $1 AND employee_id = $2 FOR UPDATE`,
        [params.data.id, self.id],
      );
      const record = found.rows[0];
      if (!record) throw recordNotFound();
      if (record.source !== "EXTERNAL" || record.status !== "SUBMITTED") {
        throw new TrainingError(409, "TRAINING_RECORD_NOT_EDITABLE", "Sertifikat hanya dapat dilampirkan pada pengajuan eksternal yang belum diputus.");
      }
      const certificate = await storeCertificate(client, {
        recordId: params.data.id, employeeId: self.id, actorAccountId: principal.id, file: body.data,
      });
      return [201, certificate];
    });
  });

  app.get("/training/me/records/:id/certificate", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_TRAINING_RECORD_ID", "Catatan pelatihan tidak valid.");
    return handle(reply, async () => {
      const self = await loadSelf(pool, principal.id);
      // TRAIN-001-A: another employee's certificate is indistinguishable from a missing one.
      return sendCertificate(reply, params.data.id, self.id);
    });
  });

  app.get("/training/me/programs", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const query = pageQuerySchema.safeParse(request.query);
    if (!query.success) return invalid(reply, "INVALID_TRAINING_FILTER", "Filter tidak valid.");
    return handle(reply, async () => {
      const self = await loadSelf(pool, principal.id);
      const result = await pool.query<{ total: number }>(
        `SELECT ${PROGRAM_COLUMNS}, participant.status AS "participantStatus",
                participant.attended_hours::float8 AS "attendedHours",
                (SELECT min(session.start_at) FROM training_sessions session
                  WHERE session.program_id = program.id AND session.status = 'SCHEDULED' AND session.end_at > now()) AS "nextSessionAt",
                count(*) OVER ()::int AS total
           FROM training_participants participant
           JOIN training_programs program ON program.id = participant.program_id
          WHERE participant.employee_id = $1 AND participant.status <> 'WITHDRAWN'
          ORDER BY (program.status = 'ACTIVE') DESC, program.created_at DESC, program.id DESC
          LIMIT $2 OFFSET $3`,
        [self.id, query.data.pageSize, pageOffset(query.data)],
      );
      return send(reply, 200, {
        items: result.rows.map(({ total, ...row }) => { void total; return row; }),
        pagination: pagination(query.data, result.rows[0]?.total ?? 0),
      });
    });
  });

  app.get("/training/me/programs/:id", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_TRAINING_PROGRAM_ID", "Program pelatihan tidak valid.");
    return handle(reply, async () => {
      const self = await loadSelf(pool, principal.id);
      const program = await pool.query(
        `SELECT ${PROGRAM_COLUMNS}, participant.status AS "participantStatus",
                participant.attended_hours::float8 AS "attendedHours"
           FROM training_participants participant
           JOIN training_programs program ON program.id = participant.program_id
          WHERE participant.program_id = $1 AND participant.employee_id = $2 AND participant.status <> 'WITHDRAWN'`,
        [params.data.id, self.id],
      );
      if (!program.rows[0]) throw notFound();
      // D-17 bounds a program to 50 sessions, so the list is bounded.
      const sessions = await pool.query(
        `SELECT ${SESSION_COLUMNS}, attendance.status AS "myAttendance"
           FROM training_sessions session
           LEFT JOIN employees speaker ON speaker.id = session.speaker_employee_id
           LEFT JOIN training_attendance attendance ON attendance.session_id = session.id AND attendance.employee_id = $2
          WHERE session.program_id = $1
          ORDER BY session.start_at ASC, session.id ASC`,
        [params.data.id, self.id],
      );
      return send(reply, 200, { ...program.rows[0], sessions: sessions.rows });
    });
  });

  // ---------------------------------------------------------------- HC: programs

  app.get("/admin/training/programs", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.read");
    if (!principal) return;
    const query = programListQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, "INVALID_TRAINING_FILTER", "Filter tidak valid.");
    const q = query.data.q ? `%${query.data.q}%` : null;
    const result = await pool.query<{ total: number }>(
      `SELECT ${PROGRAM_COLUMNS}, count(*) OVER ()::int AS total
         FROM training_programs program
        WHERE ($1::text IS NULL OR program.status = $1) AND ($2::text IS NULL OR program.title ILIKE $2)
        ORDER BY (program.status = 'ACTIVE') DESC, program.created_at DESC, program.id DESC
        LIMIT $3 OFFSET $4`,
      [query.data.status ?? null, q, query.data.pageSize, pageOffset(query.data)],
    );
    return send(reply, 200, {
      items: result.rows.map(({ total, ...row }) => { void total; return row; }),
      pagination: pagination(query.data, result.rows[0]?.total ?? 0),
    });
  });

  app.post("/admin/training/programs", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.manage");
    if (!principal) return;
    const body = programBody.safeParse(request.body);
    if (!body.success) return invalid(reply, "INVALID_TRAINING_PROGRAM", "Judul (3–200 karakter) atau kategori program tidak valid.");
    return transact(reply, async (client) => {
      const id = randomUUID();
      await client.query(
        `INSERT INTO training_programs
           (id, title, category, description, organizer, capacity, min_attendance_percent, status, created_by_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', $8)`,
        [id, body.data.title, body.data.category, body.data.description, body.data.organizer ?? DEFAULT_ORGANIZER,
          body.data.capacity ?? null, body.data.minAttendancePercent ?? 80, principal.id],
      );
      await audit(client, { eventType: "training.program.created", programId: id, actorAccountId: principal.id });
      return [201, { id, status: "ACTIVE" }];
    });
  });

  app.get("/admin/training/programs/:id", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.read");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_TRAINING_PROGRAM_ID", "Program pelatihan tidak valid.");
    return handle(reply, async () => {
      const program = await pool.query(`SELECT ${PROGRAM_COLUMNS} FROM training_programs program WHERE program.id = $1`, [params.data.id]);
      if (!program.rows[0]) throw notFound();
      // D-17 bounds a program to 50 sessions, so the list is bounded.
      const sessions = await pool.query(
        `SELECT ${SESSION_COLUMNS},
                (SELECT count(*)::int FROM training_attendance attendance
                  WHERE attendance.session_id = session.id AND attendance.status = 'PRESENT') AS "presentCount",
                (SELECT count(*)::int FROM training_attendance attendance
                  WHERE attendance.session_id = session.id) AS "recordedCount"
           FROM training_sessions session
           LEFT JOIN employees speaker ON speaker.id = session.speaker_employee_id
          WHERE session.program_id = $1
          ORDER BY session.start_at ASC, session.id ASC`,
        [params.data.id],
      );
      const counts = await pool.query<{ status: string; count: number }>(
        `SELECT status, count(*)::int AS count FROM training_participants WHERE program_id = $1 GROUP BY status`,
        [params.data.id],
      );
      return send(reply, 200, {
        ...program.rows[0],
        sessions: sessions.rows,
        participantsByStatus: Object.fromEntries(counts.rows.map((row) => [row.status, row.count])),
      });
    });
  });

  app.patch("/admin/training/programs/:id", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_TRAINING_PROGRAM_ID", "Program pelatihan tidak valid.");
    const body = programPatch.safeParse(request.body);
    if (!body.success) return invalid(reply, "INVALID_TRAINING_PROGRAM", "Data program tidak valid.");
    return transact(reply, async (client) => {
      await lockProgram(client, params.data.id);
      if (body.data.capacity) {
        const enrolled = (await enrolledIds(client, params.data.id)).length;
        if (body.data.capacity < enrolled) {
          throw new TrainingError(409, "TRAINING_CAPACITY_BELOW_ENROLLED", `Kuota tidak boleh di bawah ${enrolled} peserta terdaftar.`);
        }
      }
      const changed = Object.keys(body.data);
      await client.query(
        `UPDATE training_programs
            SET title = COALESCE($2, title), category = COALESCE($3, category),
                description = CASE WHEN $4 THEN $5 ELSE description END,
                organizer = COALESCE($6, organizer),
                capacity = CASE WHEN $7 THEN $8::int ELSE capacity END,
                min_attendance_percent = COALESCE($9, min_attendance_percent), updated_at = now()
          WHERE id = $1`,
        [params.data.id, body.data.title ?? null, body.data.category ?? null,
          "description" in body.data, body.data.description ?? null, body.data.organizer ?? null,
          "capacity" in body.data, body.data.capacity ?? null, body.data.minAttendancePercent ?? null],
      );
      await audit(client, { eventType: "training.program.updated", programId: params.data.id, actorAccountId: principal.id, metadata: { fields: changed } });
      return [200, { id: params.data.id }];
    });
  });

  app.post("/admin/training/programs/:id/cancel", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_TRAINING_PROGRAM_ID", "Program pelatihan tidak valid.");
    const body = programReason.safeParse(request.body);
    if (!body.success) return invalid(reply, "INVALID_TRAINING_CANCEL", "Alasan pembatalan minimal 10 karakter.");
    return transact(reply, async (client) => {
      const program = await lockProgram(client, params.data.id);
      const participants = await enrolledIds(client, program.id);
      await client.query(
        `UPDATE training_programs SET status = 'CANCELLED', cancel_reason = $2, closed_at = now(), updated_at = now() WHERE id = $1`,
        [program.id, body.data.reason],
      );
      // D-13: every scheduled session goes with it, which frees the participants' time.
      await client.query(
        `UPDATE training_sessions SET status = 'CANCELLED', cancel_reason = $2, updated_at = now()
          WHERE program_id = $1 AND status = 'SCHEDULED'`,
        [program.id, body.data.reason],
      );
      await audit(client, { eventType: "training.program.cancelled", programId: program.id, actorAccountId: principal.id, note: body.data.reason });
      await notifyMany(client, participants, {
        eventKey: () => `training.program.${program.id}.cancelled`,
        title: "Pelatihan dibatalkan",
        body: `Program ${program.title} dibatalkan oleh Human Capital.`,
        href: "/app/training", actorAccountId: principal.id,
      });
      return [200, { id: program.id, status: "CANCELLED" }];
    });
  });

  app.post("/admin/training/programs/:id/complete", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_TRAINING_PROGRAM_ID", "Program pelatihan tidak valid.");
    return transact(reply, async (client) => {
      const program = await lockProgram(client, params.data.id);
      const sessions = await client.query<{ id: string; startAt: Date; endAt: Date; speakerEmployeeId: string | null }>(
        `SELECT id, start_at AS "startAt", end_at AS "endAt", speaker_employee_id AS "speakerEmployeeId"
           FROM training_sessions WHERE program_id = $1 AND status = 'SCHEDULED'`,
        [program.id],
      );
      if (sessions.rows.length === 0) {
        throw new TrainingError(409, "TRAINING_NO_SESSIONS", "Program belum memiliki sesi terjadwal.");
      }
      if (sessions.rows.some((session) => session.endAt.getTime() > Date.now())) {
        throw new TrainingError(409, "TRAINING_SESSIONS_NOT_FINISHED", "Masih ada sesi yang belum selesai.");
      }
      const participants = await enrolledIds(client, program.id);
      const attendance = await client.query<{ sessionId: string; employeeId: string; status: AttendanceStatus }>(
        `SELECT attendance.session_id AS "sessionId", attendance.employee_id AS "employeeId", attendance.status
           FROM training_attendance attendance
           JOIN training_sessions session ON session.id = attendance.session_id
           JOIN training_participants participant
             ON participant.program_id = session.program_id AND participant.employee_id = attendance.employee_id
          WHERE session.program_id = $1 AND session.status = 'SCHEDULED' AND participant.status = 'ENROLLED'`,
        [program.id],
      );
      const missing = participants.length * sessions.rows.length - attendance.rows.length;
      if (missing > 0) {
        throw new TrainingError(409, "TRAINING_ATTENDANCE_INCOMPLETE", `Masih ada ${missing} kehadiran yang belum dicatat.`, { missing });
      }
      const result = computeCompletion({
        sessions: sessions.rows.map((session) => ({
          id: session.id, startMs: session.startAt.getTime(), endMs: session.endAt.getTime(),
          speakerEmployeeId: session.speakerEmployeeId,
        })),
        participants,
        attendance: attendance.rows,
        minAttendancePercent: program.minAttendancePercent,
      });
      const recorded: string[] = [];
      const insertRecord = async (employeeId: string, role: "PARTICIPANT" | "SPEAKER", hours: number, completed: boolean | null) => {
        const recordId = randomUUID();
        await client.query(
          `INSERT INTO training_records
             (id, employee_id, source, role, program_id, title, category, organizer, start_on, end_on, hours, completed, status,
              decided_by_account_id, decided_at)
           VALUES ($1, $2, 'INTERNAL', $3, $4, $5, $6, $7, $8::date, $9::date, $10, $11, 'VERIFIED', $12, now())`,
          [recordId, employeeId, role, program.id, program.title, program.category, program.organizer,
            result.startOn, result.endOn, hours, completed, principal.id],
        );
        await audit(client, {
          eventType: "training.record.created", programId: program.id, recordId, employeeId, actorAccountId: principal.id,
          metadata: { role, hours, completed },
        });
        recorded.push(employeeId);
      };
      for (const participant of result.participants) {
        await client.query(
          `UPDATE training_participants SET status = $3, attended_hours = $4, updated_at = now()
            WHERE program_id = $1 AND employee_id = $2`,
          [program.id, participant.employeeId, participant.completed ? "COMPLETED" : "INCOMPLETE", participant.attendedHours],
        );
        // D-08: attending at least one session earns a record; none earns nothing.
        if (participant.attendedAny) await insertRecord(participant.employeeId, "PARTICIPANT", participant.attendedHours, participant.completed);
      }
      for (const speaker of result.speakers) await insertRecord(speaker.employeeId, "SPEAKER", speaker.hours, null);
      await client.query(
        `UPDATE training_programs SET status = 'COMPLETED', closed_at = now(), updated_at = now() WHERE id = $1`,
        [program.id],
      );
      await audit(client, {
        eventType: "training.program.completed", programId: program.id, actorAccountId: principal.id,
        metadata: {
          totalHours: result.totalHours,
          completed: result.participants.filter((participant) => participant.completed).length,
          incomplete: result.participants.filter((participant) => !participant.completed).length,
          records: recorded.length,
        },
      });
      await notifyMany(client, [...new Set(recorded)], {
        eventKey: () => `training.program.${program.id}.completed`,
        title: "Catatan pelatihan tersimpan",
        body: `Program ${program.title} selesai dan tercatat di riwayat pelatihan Anda.`,
        href: "/app/training", actorAccountId: principal.id,
      });
      return [200, { id: program.id, status: "COMPLETED", totalHours: result.totalHours, participants: result.participants, records: recorded.length }];
    });
  });

  // ---------------------------------------------------------------- HC: sessions

  app.post("/admin/training/programs/:id/sessions", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_TRAINING_PROGRAM_ID", "Program pelatihan tidak valid.");
    const body = sessionBody.safeParse(request.body);
    if (!body.success) return invalid(reply, "INVALID_TRAINING_SESSION", "Judul, waktu, atau narasumber sesi tidak valid.");
    return transact(reply, async (client) => {
      const program = await lockProgram(client, params.data.id);
      const interval = validateSessionTimes(body.data.startAt, body.data.endAt);
      const count = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM training_sessions WHERE program_id = $1 AND status = 'SCHEDULED'`,
        [program.id],
      );
      if ((count.rows[0]?.count ?? 0) >= MAX_SESSIONS_PER_PROGRAM) {
        throw new TrainingError(409, "TRAINING_SESSION_LIMIT", `Satu program paling banyak ${MAX_SESSIONS_PER_PROGRAM} sesi.`);
      }
      const speaker = body.data.speakerEmployeeId ?? null;
      const people = await lockPeople(client, [...await enrolledIds(client, program.id), ...(speaker ? [speaker] : [])]);
      const warnings = await assertAvailable(client, [{ id: null, title: body.data.title, ...interval }], people);
      const id = randomUUID();
      await client.query(
        `INSERT INTO training_sessions
           (id, program_id, title, start_at, end_at, location, speaker_employee_id, speaker_name, status)
         VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7, $8, 'SCHEDULED')`,
        [id, program.id, body.data.title, body.data.startAt, body.data.endAt, body.data.location, speaker, body.data.speakerName ?? null],
      );
      await audit(client, {
        eventType: "training.session.created", programId: program.id, sessionId: id, actorAccountId: principal.id,
        metadata: { startAt: body.data.startAt, endAt: body.data.endAt, warnings: warnings.length },
      });
      return [201, { id, status: "SCHEDULED", warnings }];
    });
  });

  app.patch("/admin/training/sessions/:id", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_TRAINING_SESSION_ID", "Sesi pelatihan tidak valid.");
    const body = sessionPatch.safeParse(request.body);
    if (!body.success) return invalid(reply, "INVALID_TRAINING_SESSION", "Judul, waktu, atau narasumber sesi tidak valid.");
    return transact(reply, async (client) => {
      const found = await client.query<{
        programId: string; title: string; startAt: Date; endAt: Date; status: string;
        speakerEmployeeId: string | null; speakerName: string | null;
      }>(
        `SELECT program_id AS "programId", title, start_at AS "startAt", end_at AS "endAt", status,
                speaker_employee_id AS "speakerEmployeeId", speaker_name AS "speakerName"
           FROM training_sessions WHERE id = $1`,
        [params.data.id],
      );
      const current = found.rows[0];
      if (!current) throw new TrainingError(404, "TRAINING_SESSION_NOT_FOUND", "Sesi pelatihan tidak ditemukan.");
      const program = await lockProgram(client, current.programId);
      if (current.status !== "SCHEDULED") throw new TrainingError(409, "TRAINING_SESSION_CANCELLED", "Sesi ini sudah dibatalkan.");
      const timesChanged = body.data.startAt !== undefined
        && (Date.parse(body.data.startAt) !== current.startAt.getTime() || Date.parse(body.data.endAt!) !== current.endAt.getTime());
      if (timesChanged) {
        const marked = await client.query(`SELECT 1 FROM training_attendance WHERE session_id = $1 LIMIT 1`, [params.data.id]);
        if (marked.rows[0]) {
          throw new TrainingError(409, "TRAINING_SESSION_HAS_ATTENDANCE", "Waktu sesi tidak dapat diubah setelah kehadiran dicatat.");
        }
      }
      const interval = timesChanged
        ? validateSessionTimes(body.data.startAt!, body.data.endAt!)
        : { startMs: current.startAt.getTime(), endMs: current.endAt.getTime() };
      const speakerSent = "speakerEmployeeId" in body.data || "speakerName" in body.data;
      const speaker = speakerSent ? body.data.speakerEmployeeId ?? null : current.speakerEmployeeId;
      const speakerName = speakerSent ? body.data.speakerName ?? null : current.speakerName;
      const title = body.data.title ?? current.title;
      let warnings: Conflict[] = [];
      if (timesChanged || speaker !== current.speakerEmployeeId) {
        const people = await lockPeople(client, [...await enrolledIds(client, program.id), ...(speaker ? [speaker] : [])]);
        warnings = await assertAvailable(client, [{ id: params.data.id, title, ...interval }], people);
      }
      await client.query(
        `UPDATE training_sessions
            SET title = $2, start_at = $3, end_at = $4, location = CASE WHEN $5 THEN $6 ELSE location END,
                speaker_employee_id = $7, speaker_name = $8, updated_at = now()
          WHERE id = $1`,
        [params.data.id, title, new Date(interval.startMs).toISOString(), new Date(interval.endMs).toISOString(),
          "location" in body.data, body.data.location ?? null, speaker, speakerName],
      );
      await audit(client, {
        eventType: "training.session.updated", programId: program.id, sessionId: params.data.id, actorAccountId: principal.id,
        metadata: { fields: Object.keys(body.data), timesChanged, warnings: warnings.length },
      });
      if (timesChanged) {
        const stamp = Date.now();
        await notifyMany(client, await enrolledIds(client, program.id), {
          eventKey: () => `training.session.${params.data.id}.rescheduled.${stamp}`,
          title: "Jadwal pelatihan berubah",
          body: `${program.title} — ${title} kini ${wib.format(new Date(interval.startMs))} WIB.`,
          href: `/app/training?program=${program.id}`, actorAccountId: principal.id,
        });
      }
      return [200, { id: params.data.id, warnings }];
    });
  });

  app.post("/admin/training/sessions/:id/cancel", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_TRAINING_SESSION_ID", "Sesi pelatihan tidak valid.");
    const body = shortReason.safeParse(request.body);
    if (!body.success) return invalid(reply, "INVALID_TRAINING_CANCEL", "Alasan pembatalan minimal 5 karakter.");
    return transact(reply, async (client) => {
      const found = await client.query<{ programId: string; title: string; status: string }>(
        `SELECT program_id AS "programId", title, status FROM training_sessions WHERE id = $1`,
        [params.data.id],
      );
      const session = found.rows[0];
      if (!session) throw new TrainingError(404, "TRAINING_SESSION_NOT_FOUND", "Sesi pelatihan tidak ditemukan.");
      const program = await lockProgram(client, session.programId);
      if (session.status !== "SCHEDULED") throw new TrainingError(409, "TRAINING_SESSION_CANCELLED", "Sesi ini sudah dibatalkan.");
      await client.query(
        `UPDATE training_sessions SET status = 'CANCELLED', cancel_reason = $2, updated_at = now() WHERE id = $1`,
        [params.data.id, body.data.reason],
      );
      await audit(client, {
        eventType: "training.session.cancelled", programId: program.id, sessionId: params.data.id,
        actorAccountId: principal.id, note: body.data.reason,
      });
      await notifyMany(client, await enrolledIds(client, program.id), {
        eventKey: () => `training.session.${params.data.id}.cancelled`,
        title: "Sesi pelatihan dibatalkan",
        body: `${program.title} — ${session.title} dibatalkan.`,
        href: `/app/training?program=${program.id}`, actorAccountId: principal.id,
      });
      return [200, { id: params.data.id, status: "CANCELLED" }];
    });
  });

  // ---------------------------------------------------------------- HC: participants

  app.get("/admin/training/programs/:id/participants", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.read");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_TRAINING_PROGRAM_ID", "Program pelatihan tidak valid.");
    const query = participantListQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, "INVALID_TRAINING_FILTER", "Filter tidak valid.");
    const q = query.data.q ? `%${query.data.q}%` : null;
    const result = await pool.query<{ total: number }>(
      `SELECT participant.employee_id AS "employeeId", employee.full_name AS "fullName",
              employee.employee_number AS "employeeNumber", unit.name AS "unitName",
              participant.status, participant.withdraw_reason AS "withdrawReason",
              participant.attended_hours::float8 AS "attendedHours", participant.enrolled_at AS "enrolledAt",
              (SELECT count(*)::int FROM training_attendance attendance
                 JOIN training_sessions session ON session.id = attendance.session_id
                WHERE session.program_id = participant.program_id AND session.status = 'SCHEDULED'
                  AND attendance.employee_id = participant.employee_id AND attendance.status = 'PRESENT') AS "presentSessions",
              count(*) OVER ()::int AS total
         FROM training_participants participant
         JOIN employees employee ON employee.id = participant.employee_id
         LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
        WHERE participant.program_id = $1
          AND ($2::text IS NULL OR employee.full_name ILIKE $2 OR employee.employee_number ILIKE $2)
        ORDER BY (participant.status = 'WITHDRAWN') ASC, employee.full_name ASC, participant.employee_id ASC
        LIMIT $3 OFFSET $4`,
      [params.data.id, q, query.data.pageSize, pageOffset(query.data)],
    );
    return send(reply, 200, {
      items: result.rows.map(({ total, ...row }) => { void total; return row; }),
      pagination: pagination(query.data, result.rows[0]?.total ?? 0),
    });
  });

  app.post("/admin/training/programs/:id/participants", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_TRAINING_PROGRAM_ID", "Program pelatihan tidak valid.");
    const body = enrollBody.safeParse(request.body);
    if (!body.success) return invalid(reply, "INVALID_TRAINING_PARTICIPANTS", `Pilih 1 sampai ${MAX_ENROLL_BATCH} pegawai.`);
    return transact(reply, async (client) => {
      const program = await lockProgram(client, params.data.id);
      const requested = [...new Set(body.data.employeeIds)];
      const existing = await client.query<{ employeeId: string; status: string }>(
        `SELECT employee_id AS "employeeId", status FROM training_participants WHERE program_id = $1 AND employee_id = ANY($2::uuid[])`,
        [program.id, requested],
      );
      const alreadyEnrolled = existing.rows.filter((row) => row.status === "ENROLLED").map((row) => row.employeeId);
      const toEnroll = requested.filter((id) => !alreadyEnrolled.includes(id));
      if (toEnroll.length === 0) return [200, { enrolled: [], alreadyEnrolled, warnings: [] }];
      const enrolledNow = (await enrolledIds(client, program.id)).length;
      if (program.capacity !== null && enrolledNow + toEnroll.length > program.capacity) {
        throw new TrainingError(409, "TRAINING_CAPACITY_FULL", `Kuota program ${program.capacity} peserta; tersisa ${Math.max(0, program.capacity - enrolledNow)}.`);
      }
      const people = await lockPeople(client, toEnroll);
      const warnings = await assertAvailable(client, await scheduledSessions(client, program.id), people);
      for (const employeeId of toEnroll) {
        await client.query(
          `INSERT INTO training_participants (program_id, employee_id, status, enrolled_by_account_id)
           VALUES ($1, $2, 'ENROLLED', $3)
           ON CONFLICT (program_id, employee_id) DO UPDATE
             SET status = 'ENROLLED', withdraw_reason = NULL, enrolled_by_account_id = $3, enrolled_at = now(), updated_at = now()`,
          [program.id, employeeId, principal.id],
        );
        await audit(client, { eventType: "training.participant.enrolled", programId: program.id, employeeId, actorAccountId: principal.id });
      }
      const stamp = Date.now();
      await notifyMany(client, toEnroll, {
        eventKey: (employeeId) => `training.program.${program.id}.enrolled.${employeeId}.${stamp}`,
        title: "Anda terdaftar di pelatihan",
        body: `Anda didaftarkan sebagai peserta ${program.title}.`,
        href: `/app/training?program=${program.id}`, actorAccountId: principal.id,
      });
      return [200, { enrolled: toEnroll, alreadyEnrolled, warnings }];
    });
  });

  app.post("/admin/training/programs/:id/participants/:employeeId/withdraw", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.manage");
    if (!principal) return;
    const params = participantParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_TRAINING_PARTICIPANT", "Peserta tidak valid.");
    const body = shortReason.safeParse(request.body);
    if (!body.success) return invalid(reply, "INVALID_TRAINING_WITHDRAW", "Alasan minimal 5 karakter.");
    return transact(reply, async (client) => {
      const program = await lockProgram(client, params.data.id);
      const changed = await client.query(
        `UPDATE training_participants SET status = 'WITHDRAWN', withdraw_reason = $3, updated_at = now()
          WHERE program_id = $1 AND employee_id = $2 AND status = 'ENROLLED'`,
        [program.id, params.data.employeeId, body.data.reason],
      );
      if (changed.rowCount === 0) throw new TrainingError(404, "TRAINING_PARTICIPANT_NOT_FOUND", "Peserta terdaftar tidak ditemukan.");
      await audit(client, {
        eventType: "training.participant.withdrawn", programId: program.id, employeeId: params.data.employeeId,
        actorAccountId: principal.id, note: body.data.reason,
      });
      return [200, { programId: program.id, employeeId: params.data.employeeId, status: "WITHDRAWN" }];
    });
  });

  // ---------------------------------------------------------------- HC: attendance

  app.get("/admin/training/sessions/:id/attendance", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.read");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_TRAINING_SESSION_ID", "Sesi pelatihan tidak valid.");
    const query = pageQuerySchema.safeParse(request.query);
    if (!query.success) return invalid(reply, "INVALID_TRAINING_FILTER", "Filter tidak valid.");
    return handle(reply, async () => {
      const session = await pool.query(
        `SELECT ${SESSION_COLUMNS} FROM training_sessions session
           LEFT JOIN employees speaker ON speaker.id = session.speaker_employee_id
          WHERE session.id = $1`,
        [params.data.id],
      );
      if (!session.rows[0]) throw new TrainingError(404, "TRAINING_SESSION_NOT_FOUND", "Sesi pelatihan tidak ditemukan.");
      const result = await pool.query<{ total: number }>(
        `SELECT participant.employee_id AS "employeeId", employee.full_name AS "fullName",
                employee.employee_number AS "employeeNumber", participant.status AS "participantStatus",
                attendance.status, attendance.note, attendance.recorded_at AS "recordedAt",
                count(*) OVER ()::int AS total
           FROM training_sessions session
           JOIN training_participants participant ON participant.program_id = session.program_id
           JOIN employees employee ON employee.id = participant.employee_id
           LEFT JOIN training_attendance attendance
             ON attendance.session_id = session.id AND attendance.employee_id = participant.employee_id
          WHERE session.id = $1 AND participant.status <> 'WITHDRAWN'
          ORDER BY employee.full_name ASC, participant.employee_id ASC
          LIMIT $2 OFFSET $3`,
        [params.data.id, query.data.pageSize, pageOffset(query.data)],
      );
      return send(reply, 200, {
        session: session.rows[0],
        items: result.rows.map(({ total, ...row }) => { void total; return row; }),
        pagination: pagination(query.data, result.rows[0]?.total ?? 0),
      });
    });
  });

  app.put("/admin/training/sessions/:id/attendance", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_TRAINING_SESSION_ID", "Sesi pelatihan tidak valid.");
    const body = attendanceBody.safeParse(request.body);
    if (!body.success) return invalid(reply, "INVALID_TRAINING_ATTENDANCE", "Daftar hadir tidak valid (1–100 baris).");
    return transact(reply, async (client) => {
      const found = await client.query<{ programId: string; status: string; startAt: Date }>(
        `SELECT program_id AS "programId", status, start_at AS "startAt" FROM training_sessions WHERE id = $1`,
        [params.data.id],
      );
      const session = found.rows[0];
      if (!session) throw new TrainingError(404, "TRAINING_SESSION_NOT_FOUND", "Sesi pelatihan tidak ditemukan.");
      // Locking the program serializes attendance with closing it (§6.5).
      const program = await lockProgram(client, session.programId);
      if (session.status !== "SCHEDULED") throw new TrainingError(409, "TRAINING_SESSION_CANCELLED", "Sesi ini sudah dibatalkan.");
      if (session.startAt.getTime() > Date.now()) {
        throw new TrainingError(409, "TRAINING_SESSION_NOT_STARTED", "Kehadiran dicatat setelah sesi dimulai.");
      }
      const ids = body.data.entries.map((entry) => entry.employeeId);
      if (new Set(ids).size !== ids.length) return [400, { code: "INVALID_TRAINING_ATTENDANCE", message: "Satu pegawai hanya satu baris." }];
      const enrolled = new Set(await enrolledIds(client, program.id));
      const outsiders = ids.filter((id) => !enrolled.has(id));
      if (outsiders.length > 0) {
        throw new TrainingError(409, "TRAINING_NOT_PARTICIPANT", "Kehadiran hanya untuk peserta terdaftar.", { employeeIds: outsiders });
      }
      for (const entry of body.data.entries) {
        await client.query(
          `INSERT INTO training_attendance (session_id, employee_id, status, note, recorded_by_account_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (session_id, employee_id) DO UPDATE
             SET status = EXCLUDED.status, note = EXCLUDED.note,
                 recorded_by_account_id = EXCLUDED.recorded_by_account_id, recorded_at = now()`,
          [params.data.id, entry.employeeId, entry.status, entry.note, principal.id],
        );
      }
      const tally = (status: AttendanceStatus) => body.data.entries.filter((entry) => entry.status === status).length;
      await audit(client, {
        eventType: "training.attendance.recorded", programId: program.id, sessionId: params.data.id, actorAccountId: principal.id,
        metadata: { present: tally("PRESENT"), absent: tally("ABSENT"), excused: tally("EXCUSED") },
      });
      return [200, { sessionId: params.data.id, recorded: body.data.entries.length }];
    });
  });

  app.post("/admin/training/availability", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.manage");
    if (!principal) return;
    const body = availabilityBody.safeParse(request.body);
    if (!body.success) return invalid(reply, "INVALID_TRAINING_AVAILABILITY", "Permintaan cek jadwal tidak valid.");
    return handle(reply, async () => {
      const program = await pool.query<{ id: string }>(`SELECT id FROM training_programs WHERE id = $1`, [body.data.programId]);
      if (!program.rows[0]) throw notFound();
      // A preview only: the binding check runs again when the change is saved (§7.1).
      const sessions = body.data.startAt
        ? [{ id: body.data.sessionId ?? null, title: "Sesi", ...validateSessionTimes(body.data.startAt, body.data.endAt!) }]
        : await scheduledSessions(pool, body.data.programId);
      const ids = body.data.employeeIds
        ?? [...await enrolledIds(pool, body.data.programId), ...(body.data.speakerEmployeeId ? [body.data.speakerEmployeeId] : [])];
      const names = await pool.query<{ employeeId: string; name: string }>(
        `SELECT id AS "employeeId", full_name AS name FROM employees WHERE id = ANY($1::uuid[]) AND removed_at IS NULL`,
        [[...new Set(ids)]],
      );
      return send(reply, 200, await checkAvailability(pool, sessions, names.rows));
    });
  });

  // ---------------------------------------------------------------- HC: records

  app.get("/admin/training/records", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.read");
    if (!principal) return;
    const query = recordListQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, "INVALID_TRAINING_FILTER", "Filter tidak valid.");
    const result = await pool.query<{ total: number }>(
      `SELECT ${RECORD_COLUMNS}, employee.full_name AS "employeeName", employee.employee_number AS "employeeNumber",
              count(*) OVER ()::int AS total
         FROM training_records record
         JOIN employees employee ON employee.id = record.employee_id
         LEFT JOIN training_certificates certificate ON certificate.id = record.certificate_id
        WHERE ($1::text IS NULL OR record.status = $1) AND ($2::text IS NULL OR record.source = $2)
          AND ($3::uuid IS NULL OR record.employee_id = $3) AND ($4::int IS NULL OR extract(year FROM record.end_on) = $4)
        ORDER BY record.created_at DESC, record.id DESC
        LIMIT $5 OFFSET $6`,
      [query.data.status ?? null, query.data.source ?? null, query.data.employeeId ?? null, query.data.year ?? null,
        query.data.pageSize, pageOffset(query.data)],
    );
    return send(reply, 200, {
      items: result.rows.map(({ total, ...row }) => { void total; return row; }),
      pagination: pagination(query.data, result.rows[0]?.total ?? 0),
    });
  });

  app.get("/admin/training/records/:id", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.read");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_TRAINING_RECORD_ID", "Catatan pelatihan tidak valid.");
    return handle(reply, async () => {
      const record = await pool.query(
        `SELECT ${RECORD_COLUMNS}, employee.full_name AS "employeeName", employee.employee_number AS "employeeNumber",
                unit.name AS "unitName"
           FROM training_records record
           JOIN employees employee ON employee.id = record.employee_id
           LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
           LEFT JOIN training_certificates certificate ON certificate.id = record.certificate_id
          WHERE record.id = $1`,
        [params.data.id],
      );
      if (!record.rows[0]) throw recordNotFound();
      // A record has a handful of events (submitted, certificate, decision), so the list is bounded.
      const events = await pool.query(
        `SELECT event.id, event.event_type AS "eventType", event.occurred_at AS "occurredAt", event.note,
                actor.full_name AS "actorName"
           FROM training_audit_events event
           LEFT JOIN accounts account ON account.id = event.actor_account_id
           LEFT JOIN employees actor ON actor.id = account.employee_id
          WHERE event.record_id = $1
          ORDER BY event.occurred_at ASC, event.id ASC`,
        [params.data.id],
      );
      return send(reply, 200, { ...record.rows[0], events: events.rows });
    });
  });

  async function decide(
    request: FastifyRequest,
    reply: FastifyReply,
    decision: "VERIFIED" | "REJECTED",
  ) {
    const principal = await requirePermission(request, reply, "training.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_TRAINING_RECORD_ID", "Catatan pelatihan tidak valid.");
    const body = decision === "REJECTED" ? shortReason.safeParse(request.body) : { success: true as const, data: { reason: null } };
    if (!body.success) return invalid(reply, "INVALID_TRAINING_REJECT", "Alasan penolakan minimal 5 karakter.");
    return transact(reply, async (client) => {
      const found = await client.query<{ employeeId: string; status: string; title: string }>(
        `SELECT employee_id AS "employeeId", status, title FROM training_records
          WHERE id = $1 AND source = 'EXTERNAL' FOR UPDATE`,
        [params.data.id],
      );
      const record = found.rows[0];
      if (!record) throw recordNotFound();
      if (record.status !== "SUBMITTED") {
        throw new TrainingError(409, "TRAINING_RECORD_NOT_PENDING", "Catatan ini tidak sedang menunggu verifikasi.");
      }
      await client.query(
        `UPDATE training_records
            SET status = $2, reject_reason = $3, decided_by_account_id = $4, decided_at = now(), updated_at = now()
          WHERE id = $1`,
        [params.data.id, decision, body.data.reason, principal.id],
      );
      await audit(client, {
        eventType: decision === "VERIFIED" ? "training.record.verified" : "training.record.rejected",
        recordId: params.data.id, employeeId: record.employeeId, actorAccountId: principal.id, note: body.data.reason,
      });
      await notifyEmployee(client, record.employeeId, {
        eventKey: `training.record.${params.data.id}.${decision.toLowerCase()}`,
        category: "system",
        title: decision === "VERIFIED" ? "Pelatihan eksternal diverifikasi" : "Pelatihan eksternal ditolak",
        body: decision === "VERIFIED"
          ? `${record.title} tercatat di riwayat pelatihan Anda.`
          : `${record.title} ditolak: ${body.data.reason}`,
        href: "/app/training", actorAccountId: principal.id,
      });
      return [200, { id: params.data.id, status: decision }];
    });
  }

  app.post("/admin/training/records/:id/verify", (request, reply) => decide(request, reply, "VERIFIED"));
  app.post("/admin/training/records/:id/reject", (request, reply) => decide(request, reply, "REJECTED"));

  app.post("/admin/training/records/:id/certificate", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_TRAINING_RECORD_ID", "Catatan pelatihan tidak valid.");
    const body = certificateBody.safeParse(request.body);
    if (!body.success) return invalid(reply, "INVALID_CERTIFICATE", "Sertifikat tidak valid.");
    return transact(reply, async (client) => {
      const found = await client.query<{ employeeId: string; status: string; source: string }>(
        `SELECT employee_id AS "employeeId", status, source FROM training_records WHERE id = $1 FOR UPDATE`,
        [params.data.id],
      );
      const record = found.rows[0];
      if (!record) throw recordNotFound();
      if (record.source !== "INTERNAL" || record.status !== "VERIFIED") {
        throw new TrainingError(409, "TRAINING_RECORD_NOT_EDITABLE", "Human Capital melampirkan sertifikat pada catatan pelatihan internal.");
      }
      return [201, await storeCertificate(client, {
        recordId: params.data.id, employeeId: record.employeeId, actorAccountId: principal.id, file: body.data,
      })];
    });
  });

  app.get("/admin/training/records/:id/certificate", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.read");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_TRAINING_RECORD_ID", "Catatan pelatihan tidak valid.");
    return sendCertificate(reply, params.data.id, null);
  });

  app.get("/admin/training/hours", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.read");
    if (!principal) return;
    const query = hoursQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, "INVALID_TRAINING_FILTER", "Filter tidak valid.");
    const year = query.data.year ?? currentYear();
    const q = query.data.q ? `%${query.data.q}%` : null;
    // TRAIN-001-J: every active employee appears, including those without any hours.
    const result = await pool.query<{ total: number }>(
      `SELECT employee.id AS "employeeId", employee.full_name AS "fullName", employee.employee_number AS "employeeNumber",
              unit.name AS "unitName",
              COALESCE(sum(record.hours) FILTER (WHERE record.role = 'PARTICIPANT'), 0)::float8 AS "totalHours",
              COALESCE(sum(record.hours) FILTER (WHERE record.role = 'PARTICIPANT' AND record.source = 'INTERNAL'), 0)::float8 AS "internalHours",
              COALESCE(sum(record.hours) FILTER (WHERE record.role = 'PARTICIPANT' AND record.source = 'EXTERNAL'), 0)::float8 AS "externalHours",
              COALESCE(sum(record.hours) FILTER (WHERE record.role = 'SPEAKER'), 0)::float8 AS "speakerHours",
              count(record.id) FILTER (WHERE record.role = 'PARTICIPANT')::int AS "recordCount",
              count(*) OVER ()::int AS total
         FROM employees employee
         LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
         LEFT JOIN training_records record
           ON record.employee_id = employee.id AND record.status = 'VERIFIED' AND extract(year FROM record.end_on) = $1
        WHERE employee.status = 'active' AND employee.removed_at IS NULL
          AND ($2::text IS NULL OR employee.full_name ILIKE $2 OR employee.employee_number ILIKE $2)
        GROUP BY employee.id, unit.name
        ORDER BY employee.full_name ASC, employee.id ASC
        LIMIT $3 OFFSET $4`,
      [year, q, query.data.pageSize, pageOffset(query.data)],
    );
    return send(reply, 200, {
      year,
      items: result.rows.map(({ total, ...row }) => { void total; return row; }),
      pagination: pagination(query.data, result.rows[0]?.total ?? 0),
    });
  });

  app.get("/admin/training/employee-options", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.manage");
    if (!principal) return;
    const query = optionsQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, "INVALID_TRAINING_FILTER", "Ketik minimal 2 huruf.");
    // ENG-LIST-001 typeahead: at most 20 matches; the caller narrows the query for more.
    const result = await pool.query(
      `SELECT employee.id, employee.full_name AS "fullName", employee.employee_number AS "employeeNumber",
              unit.name AS "unitName"
         FROM employees employee
         LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
        WHERE employee.status = 'active' AND employee.removed_at IS NULL
          AND (employee.full_name ILIKE $1 OR employee.employee_number ILIKE $1)
        ORDER BY employee.full_name ASC, employee.id ASC
        LIMIT 20`,
      [`%${query.data.q}%`],
    );
    return send(reply, 200, { items: result.rows });
  });
}
