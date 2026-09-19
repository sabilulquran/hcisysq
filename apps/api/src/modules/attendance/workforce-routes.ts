import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { requirePermissionsFromCookie, requirePrincipalFromCookie } from "../auth/authorization.js";
import { AuthError, AuthService, type AuthPrincipal } from "../auth/service.js";
import type { AdminPermission } from "../auth/permissions.js";
import {
  haversineDistanceMeters,
  jakartaWorkDate,
  materializeAttendanceResult,
  resolveSchedule,
} from "./engine.js";
import { attendanceDailyReadModel, buildAttendanceReport, type AttendanceReportType } from "./reporting.js";
import {
  decryptMobileAttendancePhoto,
  encryptMobileAttendancePhoto,
  restrictedMediaReady,
} from "./restricted-media-crypto.js";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const clockSchema = z.object({
  action: z.enum(["check_in", "check_out"]),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyMeters: z.number().nonnegative().max(100000),
  photoBase64: z.string().min(4),
});
const clarificationSchema = z.object({
  workDate: dateSchema,
  kind: z.enum([
    "missing_check_in", "missing_check_out", "machine_issue", "lateness",
    "early_leave", "outside_geofence", "other",
  ]),
  mode: z.enum(["correction", "justification"]),
  reason: z.string().trim().min(1).max(2000),
  proposedCheckInAt: z.string().datetime({ offset: true }).nullable().optional(),
  proposedCheckOutAt: z.string().datetime({ offset: true }).nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.mode === "correction" && !value.proposedCheckInAt && !value.proposedCheckOutAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Correction membutuhkan usulan waktu." });
  }
});
const decisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(2000).nullable().optional(),
});
const workLocationSchema = z.object({
  name: z.string().trim().min(1).max(160),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusMeters: z.number().int().min(10).max(5000),
});
const workLocationPatchSchema = workLocationSchema.partial().extend({
  active: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, "Perubahan lokasi kosong.");
const scheduleTemplateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  startTime: z.string().regex(/^\d{2}:\d{2}(?::\d{2})?$/),
  endTime: z.string().regex(/^\d{2}:\d{2}(?::\d{2})?$/),
  endDayOffset: z.number().int().min(0).max(1).default(0),
  lateGraceMinutes: z.number().int().min(0).max(240).default(0),
  earlyLeaveToleranceMinutes: z.number().int().min(0).max(240).default(0),
  workLocationId: z.string().uuid().nullable().optional(),
});
const scheduleTemplatePatchSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  startTime: z.string().regex(/^\d{2}:\d{2}(?::\d{2})?$/).optional(),
  endTime: z.string().regex(/^\d{2}:\d{2}(?::\d{2})?$/).optional(),
  endDayOffset: z.number().int().min(0).max(1).optional(),
  lateGraceMinutes: z.number().int().min(0).max(240).optional(),
  earlyLeaveToleranceMinutes: z.number().int().min(0).max(240).optional(),
  workLocationId: z.string().uuid().nullable().optional(),
  active: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, "Perubahan jadwal kosong.");
const assignmentSchema = z.object({
  employeeId: z.string().uuid(),
  scheduleTemplateId: z.string().uuid(),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  effectiveFrom: dateSchema,
  effectiveTo: dateSchema.nullable().optional(),
});
const rosterSchema = z.object({ weekStart: dateSchema });
const rosterEntrySchema = z.object({
  employeeId: z.string().uuid(),
  workDate: dateSchema,
  scheduleTemplateId: z.string().uuid().nullable(),
  isOff: z.boolean(),
  note: z.string().trim().max(500).nullable().optional(),
});
const scheduleRangeSchema = z.object({ from: dateSchema, to: dateSchema });
const rosterQuerySchema = z.object({ weekStart: dateSchema });
const clarificationAdminQuerySchema = z.object({
  status: z.enum(["all", "submitted", "approved", "rejected", "cancelled"]).default("submitted"),
});
const mobileEvidenceQuerySchema = z.object({
  date: dateSchema.optional(),
  reviewState: z.enum(["all", "accepted", "needs_review"]).default("all"),
});
const attendanceStatusSchema = z.enum([
  "scheduled", "pending", "present", "late", "incomplete", "leave",
  "absent", "off", "configuration_error",
]);
const reportQuerySchema = z.object({
  type: z.enum(["detail", "period", "unit", "sessions", "scans", "schedule", "overtime"]).default("detail"),
  date: dateSchema.optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  employeeId: z.string().uuid().optional(),
  unitId: z.string().uuid().optional(),
  status: attendanceStatusSchema.optional(),
  scheduleId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  source: z.enum(["adms", "mobile", "manual"]).optional(),
  deviceId: z.string().uuid().optional(),
}).superRefine((value, ctx) => {
  const from = value.from ?? value.date;
  const to = value.to ?? value.date;
  if (!from || !to) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Tanggal laporan wajib diisi." });
});
const overtimeInputSchema = z.object({
  workDate: dateSchema,
  requestedMinutes: z.number().int().min(1).max(1440),
  note: z.string().trim().max(2000).nullable().optional(),
});
const adminOvertimeInputSchema = overtimeInputSchema.extend({ employeeId: z.string().uuid() });
const overtimeDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  approvedMinutes: z.number().int().min(0).max(1440).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
});
const manualCorrectionSchema = z.object({
  employeeId: z.string().uuid(),
  workDate: dateSchema,
  checkInAt: z.string().datetime({ offset: true }).nullable(),
  checkOutAt: z.string().datetime({ offset: true }).nullable(),
  reason: z.string().trim().min(3).max(1000),
}).superRefine((value, ctx) => {
  if (!value.checkInAt && !value.checkOutAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Minimal satu batas waktu wajib diisi." });
  }
});

class WorkforceAttendanceError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = "WorkforceAttendanceError";
  }
}

async function authenticate(
  auth: AuthService,
  request: FastifyRequest,
  reply: FastifyReply,
  expected: "EMPLOYEE" | AdminPermission | readonly AdminPermission[],
): Promise<AuthPrincipal | null> {
  try {
    return expected === "EMPLOYEE"
      ? await requirePrincipalFromCookie(auth, request.headers.cookie, "EMPLOYEE")
      : await requirePermissionsFromCookie(auth, request.headers.cookie, expected);
  } catch (error) {
    if (error instanceof AuthError) {
      reply.header("Cache-Control", "no-store");
      await reply.status(error.statusCode).send({ code: error.code, message: error.message });
      return null;
    }
    throw error;
  }
}

async function employeeForAccount(db: Pool | PoolClient, accountId: string) {
  const result = await db.query<{ id: string; fullName: string; employeeNumber: string }>(
    `SELECT employee.id, employee.full_name AS "fullName", employee.employee_number AS "employeeNumber"
     FROM accounts account
     JOIN employees employee ON employee.id = account.employee_id
     WHERE account.id = $1
       AND account.principal_type = 'EMPLOYEE'
       AND account.status = 'active'
       AND employee.status = 'active'`,
    [accountId],
  );
  const employee = result.rows[0];
  if (!employee) {
    throw new WorkforceAttendanceError(403, "EMPLOYEE_NOT_ACTIVE", "Akun tidak terhubung ke pegawai aktif.");
  }
  return employee;
}

function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function datesBetween(from: string, to: string, maximum: number) {
  if (from > to) throw new WorkforceAttendanceError(400, "INVALID_DATE_RANGE", "Rentang tanggal tidak valid.");
  const items: string[] = [];
  let cursor = from;
  while (cursor <= to) {
    items.push(cursor);
    if (items.length > maximum) {
      throw new WorkforceAttendanceError(400, "DATE_RANGE_TOO_LARGE", `Rentang maksimal ${maximum} hari.`);
    }
    cursor = shiftDate(cursor, 1);
  }
  return items;
}

function mapResult(row: Record<string, unknown> | null | undefined) {
  if (!row) return null;
  const date = (value: unknown) => value instanceof Date ? value.toISOString() : value ?? null;
  return {
    ...row,
    scheduledStartAt: date(row.scheduledStartAt),
    scheduledEndAt: date(row.scheduledEndAt),
    firstCheckInAt: date(row.firstCheckInAt),
    lastCheckOutAt: date(row.lastCheckOutAt),
    createdAt: date(row.createdAt),
  };
}

async function latestResult(db: Pool | PoolClient, employeeId: string, workDate: string) {
  const result = await db.query<Record<string, unknown>>(
    `SELECT
       id, work_date::text AS "workDate", version, status,
       schedule_template_id AS "scheduleTemplateId", schedule_version_id AS "scheduleVersionId", roster_id AS "rosterId",
       scheduled_start_at AS "scheduledStartAt", scheduled_end_at AS "scheduledEndAt",
       first_check_in_at AS "firstCheckInAt", last_check_out_at AS "lastCheckOutAt",
       worked_minutes AS "workedMinutes", break_minutes AS "breakMinutes",
       late_minutes AS "lateMinutes", early_leave_minutes AS "earlyLeaveMinutes",
       incomplete_session AS "incompleteSession", justified,
       late_justified AS "lateJustified", early_leave_justified AS "earlyLeaveJustified",
       outside_geofence_justified AS "outsideGeofenceJustified",
       overtime_minutes AS "overtimeMinutes", created_at AS "createdAt"
     FROM attendance_result_versions
     WHERE employee_id = $1 AND work_date = $2::date
     ORDER BY version DESC LIMIT 1`,
    [employeeId, workDate],
  );
  return mapResult(result.rows[0]);
}

function scheduleResponse(schedule: Awaited<ReturnType<typeof resolveSchedule>>) {
  return {
    ...schedule,
    scheduledStartAt: schedule.scheduledStartAt?.toISOString() ?? null,
    scheduledEndAt: schedule.scheduledEndAt?.toISOString() ?? null,
  };
}

async function resolveMobileWorkDate(pool: Pool, employeeId: string, now: Date) {
  const today = jakartaWorkDate(now);
  for (const workDate of [today, shiftDate(today, -1)]) {
    const schedule = await resolveSchedule(pool, employeeId, workDate);
    if (!schedule.scheduledStartAt || !schedule.scheduledEndAt) continue;
    const start = schedule.scheduledStartAt.getTime() - 6 * 60 * 60_000;
    const end = schedule.scheduledEndAt.getTime() + 6 * 60 * 60_000;
    if (now.getTime() >= start && now.getTime() <= end) return { workDate, schedule };
  }
  return { workDate: today, schedule: await resolveSchedule(pool, employeeId, today) };
}

async function insertAudit(
  db: Pool | PoolClient,
  actorAccountId: string,
  action: string,
  entityType: string,
  entityId: string | null,
  payload: Record<string, unknown>,
) {
  await db.query(
    `INSERT INTO access_audit_events (
       id, actor_account_id, action, entity_type, entity_id, payload
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [randomUUID(), actorAccountId, action, entityType, entityId, JSON.stringify(payload)],
  );
}

async function sendError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof WorkforceAttendanceError)) throw error;
  reply.header("Cache-Control", "no-store");
  return reply.status(error.statusCode).send({ code: error.code, message: error.message });
}

export async function registerAttendanceWorkforceRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
) {
  if (!config.AUTH_ENCRYPTION_KEY) {
    throw new Error("AUTH_ENCRYPTION_KEY is required for attendance workforce routes");
  }
  const auth = new AuthService(
    pool,
    config.AUTH_ENCRYPTION_KEY,
    config.AUTH_SESSION_TTL_HOURS,
    config.NODE_ENV === "production",
  );

  app.get("/attendance/me/workforce", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "EMPLOYEE");
    if (!principal) return;
    try {
      const query = z.object({ date: dateSchema.optional() }).safeParse(request.query);
      if (!query.success) throw new WorkforceAttendanceError(400, "INVALID_DATE", "Tanggal tidak valid.");
      const employee = await employeeForAccount(pool, principal.id);
      const workDate = query.data.date ?? jakartaWorkDate();
      const schedule = await resolveSchedule(pool, employee.id, workDate);
      const [result, clarifications, mobile] = await Promise.all([
        latestResult(pool, employee.id, workDate),
        pool.query(
          `SELECT id, work_date::text AS "workDate", kind, mode, reason, status,
             proposed_check_in_at AS "proposedCheckInAt",
             proposed_check_out_at AS "proposedCheckOutAt",
             decision_note AS "decisionNote", created_at AS "createdAt"
           FROM attendance_clarifications
           WHERE employee_id = $1 AND work_date = $2::date
           ORDER BY created_at DESC`,
          [employee.id, workDate],
        ),
        pool.query(
          `SELECT id, action, geofence_status AS "geofenceStatus",
             review_state AS "reviewState", distance_meters AS "distanceMeters",
             accuracy_meters AS "accuracyMeters", created_at AS "createdAt"
           FROM attendance_mobile_evidence
           WHERE employee_id = $1 AND (created_at AT TIME ZONE 'Asia/Jakarta')::date = $2::date
           ORDER BY created_at DESC`,
          [employee.id, workDate],
        ),
      ]);
      reply.header("Cache-Control", "no-store");
      return reply.send({
        employee,
        workDate,
        mobileEnabled: config.MOBILE_ATTENDANCE_ENABLED === "1" && restrictedMediaReady(config),
        schedule: scheduleResponse(schedule),
        result,
        clarifications: clarifications.rows,
        mobileEvidence: mobile.rows,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/attendance/me/schedule", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "EMPLOYEE");
    if (!principal) return;
    try {
      const query = scheduleRangeSchema.safeParse(request.query);
      if (!query.success) throw new WorkforceAttendanceError(400, "INVALID_DATE_RANGE", "Rentang jadwal tidak valid.");
      const employee = await employeeForAccount(pool, principal.id);
      const dates = datesBetween(query.data.from, query.data.to, 31);
      const items = await Promise.all(dates.map(async (workDate) => ({
        workDate,
        schedule: scheduleResponse(await resolveSchedule(pool, employee.id, workDate)),
        result: await latestResult(pool, employee.id, workDate),
      })));
      reply.header("Cache-Control", "no-store");
      return reply.send({ items });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post(
    "/attendance/mobile/clock",
    { bodyLimit: 7 * 1024 * 1024 },
    async (request, reply) => {
      const principal = await authenticate(auth, request, reply, "EMPLOYEE");
      if (!principal) return;
      try {
        if (config.MOBILE_ATTENDANCE_ENABLED !== "1") {
          throw new WorkforceAttendanceError(409, "MOBILE_ATTENDANCE_DISABLED", "Presensi HP belum diaktifkan.");
        }
        if (!restrictedMediaReady(config)) {
          throw new WorkforceAttendanceError(409, "ATTENDANCE_MEDIA_KEYRING_NOT_READY", "Penyimpanan foto aman belum siap.");
        }
        const body = clockSchema.safeParse(request.body);
        const idempotencyKey = request.headers["idempotency-key"];
        if (!body.success || typeof idempotencyKey !== "string" || idempotencyKey.length < 16 || idempotencyKey.length > 128) {
          throw new WorkforceAttendanceError(400, "INVALID_MOBILE_ATTENDANCE", "Evidence presensi HP tidak valid.");
        }
        const employee = await employeeForAccount(pool, principal.id);
        const duplicate = await pool.query<{ id: string; eventId: string }>(
          `SELECT id, event_id AS "eventId"
           FROM attendance_mobile_evidence
           WHERE employee_id = $1 AND idempotency_key = $2`,
          [employee.id, idempotencyKey],
        );
        if (duplicate.rows[0]) {
          const workDate = jakartaWorkDate();
          return reply.send({
            duplicate: true,
            evidenceId: duplicate.rows[0].id,
            result: await latestResult(pool, employee.id, workDate),
          });
        }

        let photo: Buffer;
        try {
          photo = Buffer.from(body.data.photoBase64, "base64");
        } catch {
          throw new WorkforceAttendanceError(400, "INVALID_ATTENDANCE_PHOTO", "Foto kehadiran tidak valid.");
        }
        const now = new Date();
        const { workDate, schedule } = await resolveMobileWorkDate(pool, employee.id, now);
        let workLocationId: string | null = null;
        let distanceMeters: number | null = null;
        let geofenceStatus: "inside" | "outside" | "uncertain_accuracy" | "unassigned_location";
        let reviewState: "accepted" | "needs_review";
        if (!schedule.workLocation) {
          geofenceStatus = "unassigned_location";
          reviewState = "needs_review";
        } else {
          workLocationId = schedule.workLocation.id;
          distanceMeters = haversineDistanceMeters(
            { latitude: body.data.latitude, longitude: body.data.longitude },
            schedule.workLocation,
          );
          if (body.data.accuracyMeters > schedule.workLocation.radiusMeters) {
            geofenceStatus = "uncertain_accuracy";
            reviewState = "needs_review";
          } else if (distanceMeters <= schedule.workLocation.radiusMeters) {
            geofenceStatus = "inside";
            reviewState = "accepted";
          } else {
            geofenceStatus = "outside";
            reviewState = "needs_review";
          }
        }

        const client = await pool.connect();
        let evidenceId: string;
        try {
          await client.query("BEGIN");
          evidenceId = randomUUID();
          const eventId = randomUUID();
          const encrypted = encryptMobileAttendancePhoto(
            photo,
            { evidenceId, employeeId: employee.id, eventId },
            config,
          );
          await client.query(
            `INSERT INTO attendance_events (
               id, employee_id, source, event_kind, occurred_at, received_at,
               source_reference, safe_metadata
             ) VALUES ($1, $2, 'mobile', $3, $4, $4, $5, $6::jsonb)`,
            [
              eventId, employee.id, body.data.action, now,
              `mobile:${employee.id}:${idempotencyKey}`,
              JSON.stringify({ workDate, geofenceStatus, reviewState }),
            ],
          );
          await client.query(
            `INSERT INTO attendance_mobile_evidence (
               id, employee_id, event_id, idempotency_key, action,
               latitude, longitude, accuracy_meters, work_location_id,
               distance_meters, geofence_status, review_state,
               photo_sha256, photo_byte_length, encryption_key_id,
               photo_ciphertext, photo_iv, photo_auth_tag
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               $13, $14, $15, $16, $17, $18
             )`,
            [
              evidenceId, employee.id, eventId, idempotencyKey, body.data.action,
              body.data.latitude, body.data.longitude, body.data.accuracyMeters,
              workLocationId, distanceMeters, geofenceStatus, reviewState,
              encrypted.sha256, encrypted.byteLength, encrypted.keyId,
              encrypted.ciphertext, encrypted.iv, encrypted.authTag,
            ],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
        const result = await materializeAttendanceResult(pool, employee.id, workDate, now);
        reply.header("Cache-Control", "no-store");
        return reply.status(201).send({
          duplicate: false,
          evidenceId,
          workDate,
          geofenceStatus,
          reviewState,
          distanceMeters,
          result: mapResult(result as unknown as Record<string, unknown>),
        });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get("/attendance/mobile/evidence/:evidenceId/photo", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "EMPLOYEE");
    if (!principal) return;
    const params = z.object({ evidenceId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: "INVALID_EVIDENCE_ID", message: "Evidence tidak valid." });
    try {
      const employee = await employeeForAccount(pool, principal.id);
      const evidence = await pool.query<{
        id: string; employeeId: string; eventId: string; ciphertext: Buffer; iv: Buffer;
        authTag: Buffer; keyId: string; sha256: string; byteLength: number;
      }>(
        `SELECT id, employee_id AS "employeeId", event_id AS "eventId",
           photo_ciphertext AS ciphertext, photo_iv AS iv, photo_auth_tag AS "authTag",
           encryption_key_id AS "keyId", photo_sha256 AS sha256,
           photo_byte_length AS "byteLength"
         FROM attendance_mobile_evidence
         WHERE id = $1 AND employee_id = $2`,
        [params.data.evidenceId, employee.id],
      );
      const item = evidence.rows[0];
      if (!item) throw new WorkforceAttendanceError(404, "EVIDENCE_NOT_FOUND", "Evidence tidak ditemukan.");
      const payload = decryptMobileAttendancePhoto(item, {
        evidenceId: item.id,
        employeeId: item.employeeId,
        eventId: item.eventId,
      }, config);
      await insertAudit(pool, principal.id, "attendance.mobile.photo.read", "attendance_mobile_evidence", item.id, { own: true });
      reply.header("Cache-Control", "no-store");
      reply.type("image/jpeg");
      return reply.send(payload);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/attendance/clarifications/me", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "EMPLOYEE");
    if (!principal) return;
    try {
      const employee = await employeeForAccount(pool, principal.id);
      const rows = await pool.query(
        `SELECT id, work_date::text AS "workDate", kind, mode, reason, status,
           proposed_check_in_at AS "proposedCheckInAt",
           proposed_check_out_at AS "proposedCheckOutAt",
           decision_note AS "decisionNote", decided_at AS "decidedAt", created_at AS "createdAt"
         FROM attendance_clarifications
         WHERE employee_id = $1 ORDER BY work_date DESC, created_at DESC LIMIT 100`,
        [employee.id],
      );
      reply.header("Cache-Control", "no-store");
      return reply.send({ items: rows.rows });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/attendance/clarifications", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "EMPLOYEE");
    if (!principal) return;
    try {
      const body = clarificationSchema.safeParse(request.body);
      if (!body.success) throw new WorkforceAttendanceError(400, "INVALID_CLARIFICATION", "Klarifikasi tidak valid.");
      const employee = await employeeForAccount(pool, principal.id);
      const id = randomUUID();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO attendance_clarifications (
             id, employee_id, work_date, kind, mode, reason,
             proposed_check_in_at, proposed_check_out_at
           ) VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8)`,
          [
            id, employee.id, body.data.workDate, body.data.kind, body.data.mode, body.data.reason,
            body.data.proposedCheckInAt ?? null, body.data.proposedCheckOutAt ?? null,
          ],
        );
        await client.query(
          `INSERT INTO attendance_clarification_events (
             id, clarification_id, actor_account_id, event_type, payload
           ) VALUES ($1, $2, $3, 'submitted', '{}'::jsonb)`,
          [randomUUID(), id, principal.id],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return reply.status(201).send({ id, status: "submitted" });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/attendance/clarifications/:clarificationId/cancel", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "EMPLOYEE");
    if (!principal) return;
    const params = z.object({ clarificationId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: "INVALID_CLARIFICATION", message: "Klarifikasi tidak valid." });
    try {
      const employee = await employeeForAccount(pool, principal.id);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const changed = await client.query(
          `UPDATE attendance_clarifications
           SET status = 'cancelled', updated_at = now()
           WHERE id = $1 AND employee_id = $2 AND status = 'submitted'
           RETURNING id`,
          [params.data.clarificationId, employee.id],
        );
        if (!changed.rows[0]) throw new WorkforceAttendanceError(409, "CLARIFICATION_NOT_CANCELLABLE", "Klarifikasi tidak dapat dibatalkan.");
        await client.query(
          `INSERT INTO attendance_clarification_events (
             id, clarification_id, actor_account_id, event_type, payload
           ) VALUES ($1, $2, $3, 'cancelled', '{}'::jsonb)`,
          [randomUUID(), params.data.clarificationId, principal.id],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return reply.status(204).send();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/admin/attendance/clarifications", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.clarification.manage");
    if (!principal) return;
    const query = clarificationAdminQuerySchema.safeParse(request.query);
    if (!query.success) return reply.status(400).send({ code: "INVALID_CLARIFICATION_FILTER", message: "Filter klarifikasi tidak valid." });
    const values: unknown[] = [];
    let statusClause = "";
    if (query.data.status !== "all") {
      values.push(query.data.status);
      statusClause = "WHERE clarification.status = $1";
    }
    const rows = await pool.query(
      `SELECT clarification.id, clarification.work_date::text AS "workDate",
         clarification.kind, clarification.mode, clarification.reason, clarification.status,
         clarification.proposed_check_in_at AS "proposedCheckInAt",
         clarification.proposed_check_out_at AS "proposedCheckOutAt",
         clarification.decision_note AS "decisionNote", clarification.decided_at AS "decidedAt",
         employee.id AS "employeeId", employee.employee_number AS "employeeNumber",
         employee.full_name AS "employeeName", unit.name AS "unitName",
         clarification.created_at AS "createdAt"
       FROM attendance_clarifications clarification
       JOIN employees employee ON employee.id = clarification.employee_id
       LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
       ${statusClause}
       ORDER BY clarification.work_date DESC, clarification.created_at DESC
       LIMIT 500`,
      values,
    );
    reply.header("Cache-Control", "no-store");
    return reply.send({ items: rows.rows });
  });

  app.post("/admin/attendance/clarifications/:clarificationId/decision", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.clarification.manage");
    if (!principal) return;
    const params = z.object({ clarificationId: z.string().uuid() }).safeParse(request.params);
    const body = decisionSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ code: "INVALID_CLARIFICATION_DECISION", message: "Keputusan tidak valid." });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{ employeeId: string; workDate: string }>(
        `SELECT employee_id AS "employeeId", work_date::text AS "workDate"
         FROM attendance_clarifications WHERE id = $1 AND status = 'submitted' FOR UPDATE`,
        [params.data.clarificationId],
      );
      const item = current.rows[0];
      if (!item) throw new WorkforceAttendanceError(409, "CLARIFICATION_ALREADY_DECIDED", "Klarifikasi sudah diputuskan.");
      await client.query(
        `UPDATE attendance_clarifications
         SET status = $2, decided_by_account_id = $3, decision_note = $4,
             decided_at = now(), updated_at = now()
         WHERE id = $1`,
        [params.data.clarificationId, body.data.decision === "approve" ? "approved" : "rejected", principal.id, body.data.note ?? null],
      );
      await client.query(
        `INSERT INTO attendance_clarification_events (
           id, clarification_id, actor_account_id, event_type, payload
         ) VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [randomUUID(), params.data.clarificationId, principal.id, body.data.decision === "approve" ? "approved" : "rejected", JSON.stringify({ note: body.data.note ?? null })],
      );
      await client.query("COMMIT");
      const result = await materializeAttendanceResult(pool, item.employeeId, item.workDate);
      return reply.send({ status: body.data.decision === "approve" ? "approved" : "rejected", result: mapResult(result as unknown as Record<string, unknown>) });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      return sendError(reply, error);
    } finally {
      client.release();
    }
  });

  app.get("/admin/attendance/work-locations", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.schedule.manage");
    if (!principal) return;
    const result = await pool.query(
      `SELECT id, name, latitude, longitude, radius_meters AS "radiusMeters", active
       FROM attendance_work_locations ORDER BY active DESC, name`,
    );
    return reply.send({ items: result.rows });
  });


  app.patch("/admin/attendance/work-locations/:locationId", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.schedule.manage");
    if (!principal) return;
    const params = z.object({ locationId: z.string().uuid() }).safeParse(request.params);
    const body = workLocationPatchSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ code: "INVALID_WORK_LOCATION_UPDATE", message: "Perubahan lokasi kerja tidak valid." });
    }
    const current = await pool.query<{
      name: string; latitude: number; longitude: number; radiusMeters: number; active: boolean;
    }>(
      `SELECT name, latitude, longitude, radius_meters AS "radiusMeters", active
       FROM attendance_work_locations WHERE id = $1`,
      [params.data.locationId],
    );
    const item = current.rows[0];
    if (!item) return reply.status(404).send({ code: "WORK_LOCATION_NOT_FOUND", message: "Lokasi kerja tidak ditemukan." });
    const next = { ...item, ...body.data };
    await pool.query(
      `UPDATE attendance_work_locations
       SET name = $2, latitude = $3, longitude = $4, radius_meters = $5,
           active = $6, updated_at = now()
       WHERE id = $1`,
      [params.data.locationId, next.name, next.latitude, next.longitude, next.radiusMeters, next.active],
    );
    await insertAudit(pool, principal.id, "attendance.work_location.updated", "attendance_work_location", params.data.locationId, {
      fields: Object.keys(body.data),
    });
    return reply.send({ id: params.data.locationId });
  });

  app.post("/admin/attendance/work-locations", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.schedule.manage");
    if (!principal) return;
    const body = workLocationSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ code: "INVALID_WORK_LOCATION", message: "Lokasi kerja tidak valid." });
    const id = randomUUID();
    await pool.query(
      `INSERT INTO attendance_work_locations (
         id, name, latitude, longitude, radius_meters, created_by_account_id
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, body.data.name, body.data.latitude, body.data.longitude, body.data.radiusMeters, principal.id],
    );
    await insertAudit(pool, principal.id, "attendance.work_location.created", "attendance_work_location", id, { radiusMeters: body.data.radiusMeters });
    return reply.status(201).send({ id });
  });

  app.get("/admin/attendance/schedules", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.schedule.manage");
    if (!principal) return;
    const result = await pool.query(
      `SELECT schedule.id, schedule.name, schedule.start_time::text AS "startTime",
         schedule.end_time::text AS "endTime", schedule.late_grace_minutes AS "lateGraceMinutes",
         schedule.early_leave_tolerance_minutes AS "earlyLeaveToleranceMinutes",
         schedule.active, location.id AS "workLocationId", location.name AS "workLocationName"
       FROM attendance_schedule_templates schedule
       LEFT JOIN attendance_work_locations location ON location.id = schedule.work_location_id
       ORDER BY schedule.active DESC, schedule.name`,
    );
    return reply.send({ items: result.rows });
  });


  app.patch("/admin/attendance/schedules/:scheduleId", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.schedule.manage");
    if (!principal) return;
    const params = z.object({ scheduleId: z.string().uuid() }).safeParse(request.params);
    const body = scheduleTemplatePatchSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ code: "INVALID_SCHEDULE_UPDATE", message: "Perubahan jadwal tidak valid." });
    }
    const current = await pool.query<{
      name: string; startTime: string; endTime: string; lateGraceMinutes: number;
      earlyLeaveToleranceMinutes: number; workLocationId: string | null; active: boolean;
    }>(
      `SELECT name, start_time::text AS "startTime", end_time::text AS "endTime",
         late_grace_minutes AS "lateGraceMinutes",
         early_leave_tolerance_minutes AS "earlyLeaveToleranceMinutes",
         work_location_id AS "workLocationId", active
       FROM attendance_schedule_templates WHERE id = $1`,
      [params.data.scheduleId],
    );
    const item = current.rows[0];
    if (!item) return reply.status(404).send({ code: "SCHEDULE_NOT_FOUND", message: "Template jadwal tidak ditemukan." });
    const next = { ...item, ...body.data };
    await pool.query(
      `UPDATE attendance_schedule_templates
       SET name = $2, start_time = $3::time, end_time = $4::time,
           late_grace_minutes = $5, early_leave_tolerance_minutes = $6,
           work_location_id = $7, active = $8, updated_at = now()
       WHERE id = $1`,
      [
        params.data.scheduleId, next.name, next.startTime, next.endTime,
        next.lateGraceMinutes, next.earlyLeaveToleranceMinutes,
        next.workLocationId ?? null, next.active,
      ],
    );
    await insertAudit(pool, principal.id, "attendance.schedule.updated", "attendance_schedule_template", params.data.scheduleId, {
      fields: Object.keys(body.data),
    });
    return reply.send({ id: params.data.scheduleId });
  });

  app.post("/admin/attendance/schedules", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.schedule.manage");
    if (!principal) return;
    const body = scheduleTemplateSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ code: "INVALID_SCHEDULE_TEMPLATE", message: "Template jadwal tidak valid." });
    const id = randomUUID();
    await pool.query(
      `INSERT INTO attendance_schedule_templates (
         id, name, start_time, end_time, late_grace_minutes,
         early_leave_tolerance_minutes, work_location_id, created_by_account_id
       ) VALUES ($1, $2, $3::time, $4::time, $5, $6, $7, $8)`,
      [
        id, body.data.name, body.data.startTime, body.data.endTime,
        body.data.lateGraceMinutes, body.data.earlyLeaveToleranceMinutes,
        body.data.workLocationId ?? null, principal.id,
      ],
    );
    await insertAudit(pool, principal.id, "attendance.schedule.created", "attendance_schedule_template", id, {});
    return reply.status(201).send({ id });
  });


  app.get("/admin/attendance/schedule-assignments", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.schedule.manage");
    if (!principal) return;
    const result = await pool.query(
      `SELECT assignment.id,
         employee.id AS "employeeId", employee.employee_number AS "employeeNumber",
         employee.full_name AS "employeeName", unit.name AS "unitName",
         schedule.id AS "scheduleTemplateId", schedule.name AS "scheduleName",
         assignment.weekday_mask AS "weekdayMask",
         assignment.effective_from::text AS "effectiveFrom",
         assignment.effective_to::text AS "effectiveTo",
         assignment.created_at AS "createdAt"
       FROM attendance_schedule_assignments assignment
       JOIN employees employee ON employee.id = assignment.employee_id
       JOIN attendance_schedule_templates schedule ON schedule.id = assignment.schedule_template_id
       LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
       ORDER BY employee.full_name, assignment.effective_from DESC`,
    );
    reply.header("Cache-Control", "no-store");
    return reply.send({ items: result.rows });
  });

  app.patch("/admin/attendance/schedule-assignments/:assignmentId", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.schedule.manage");
    if (!principal) return;
    const params = z.object({ assignmentId: z.string().uuid() }).safeParse(request.params);
    const body = z.object({ effectiveTo: dateSchema.nullable() }).safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ code: "INVALID_SCHEDULE_ASSIGNMENT_UPDATE", message: "Perubahan assignment tidak valid." });
    }
    const changed = await pool.query(
      `UPDATE attendance_schedule_assignments
       SET effective_to = $2::date
       WHERE id = $1
         AND ($2::date IS NULL OR $2::date >= effective_from)
       RETURNING id`,
      [params.data.assignmentId, body.data.effectiveTo],
    );
    if (!changed.rows[0]) {
      return reply.status(409).send({ code: "SCHEDULE_ASSIGNMENT_UPDATE_REJECTED", message: "Assignment tidak ditemukan atau tanggal akhir sebelum tanggal mulai." });
    }
    await insertAudit(pool, principal.id, "attendance.schedule_assignment.updated", "attendance_schedule_assignment", params.data.assignmentId, {
      effectiveTo: body.data.effectiveTo,
    });
    return reply.send({ id: params.data.assignmentId });
  });

  app.post("/admin/attendance/schedule-assignments", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.schedule.manage");
    if (!principal) return;
    const body = assignmentSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ code: "INVALID_SCHEDULE_ASSIGNMENT", message: "Assignment jadwal tidak valid." });
    const mask = [...new Set(body.data.weekdays)].reduce((value, day) => value | (1 << (day - 1)), 0);
    const id = randomUUID();
    await pool.query(
      `INSERT INTO attendance_schedule_assignments (
         id, employee_id, schedule_template_id, weekday_mask,
         effective_from, effective_to, created_by_account_id
       ) VALUES ($1, $2, $3, $4, $5::date, $6::date, $7)`,
      [id, body.data.employeeId, body.data.scheduleTemplateId, mask, body.data.effectiveFrom, body.data.effectiveTo ?? null, principal.id],
    );
    await insertAudit(pool, principal.id, "attendance.schedule_assignment.created", "attendance_schedule_assignment", id, { employeeId: body.data.employeeId });
    return reply.status(201).send({ id });
  });


  app.get("/admin/attendance/rosters", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.schedule.manage");
    if (!principal) return;
    const query = rosterQuerySchema.safeParse(request.query);
    if (!query.success) return reply.status(400).send({ code: "INVALID_ROSTER_WEEK", message: "Minggu roster tidak valid." });
    const [rosters, entries, employees, schedules] = await Promise.all([
      pool.query(
        `SELECT id, week_start::text AS "weekStart", version, status,
           published_at AS "publishedAt", created_at AS "createdAt", updated_at AS "updatedAt"
         FROM attendance_rosters
         WHERE week_start = $1::date
         ORDER BY version DESC`,
        [query.data.weekStart],
      ),
      pool.query(
        `SELECT entry.roster_id AS "rosterId", entry.employee_id AS "employeeId",
           entry.work_date::text AS "workDate", entry.schedule_template_id AS "scheduleTemplateId",
           entry.is_off AS "isOff", entry.note
         FROM attendance_roster_entries entry
         JOIN attendance_rosters roster ON roster.id = entry.roster_id
         WHERE roster.week_start = $1::date
         ORDER BY roster.version DESC, entry.employee_id, entry.work_date`,
        [query.data.weekStart],
      ),
      pool.query(
        `SELECT employee.id, employee.employee_number AS "employeeNumber",
           employee.full_name AS "employeeName", unit.name AS "unitName",
           assignment.schedule_template_id AS "defaultScheduleId"
         FROM employees employee
         LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
         LEFT JOIN LATERAL (
           SELECT schedule_template_id
           FROM attendance_schedule_assignments a
           WHERE a.employee_id = employee.id
             AND $1::date >= a.effective_from
             AND (a.effective_to IS NULL OR $1::date <= a.effective_to)
           ORDER BY a.effective_from DESC
           LIMIT 1
         ) assignment ON true
         WHERE employee.status = 'active'
         ORDER BY unit.name NULLS LAST, employee.full_name`,
        [query.data.weekStart],
      ),
      pool.query(
        `SELECT id, name, start_time::text AS "startTime", end_time::text AS "endTime", active
         FROM attendance_schedule_templates ORDER BY active DESC, name`,
      ),
    ]);
    reply.header("Cache-Control", "no-store");
    return reply.send({
      weekStart: query.data.weekStart,
      rosters: rosters.rows,
      entries: entries.rows,
      employees: employees.rows,
      schedules: schedules.rows,
    });
  });

  app.post("/admin/attendance/rosters", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.schedule.manage");
    if (!principal) return;
    const body = rosterSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ code: "INVALID_ROSTER", message: "Minggu roster tidak valid." });
    const weekDay = new Date(`${body.data.weekStart}T00:00:00Z`).getUTCDay();
    if (weekDay !== 1) return reply.status(400).send({ code: "ROSTER_WEEK_MUST_START_MONDAY", message: "Roster harus dimulai hari Senin." });
    const version = await pool.query<{ version: number }>(
      `SELECT coalesce(max(version), 0)::int + 1 AS version FROM attendance_rosters WHERE week_start = $1::date`,
      [body.data.weekStart],
    );
    const id = randomUUID();
    await pool.query(
      `INSERT INTO attendance_rosters (id, week_start, version, status, created_by_account_id)
       VALUES ($1, $2::date, $3, 'DRAFT', $4)`,
      [id, body.data.weekStart, version.rows[0]?.version ?? 1, principal.id],
    );
    await pool.query(
      `WITH previous AS (
         SELECT id
         FROM attendance_rosters
         WHERE week_start = $2::date
           AND status = 'PUBLISHED'
           AND id <> $1
         ORDER BY version DESC
         LIMIT 1
       )
       INSERT INTO attendance_roster_entries (
         roster_id, employee_id, work_date, schedule_template_id, is_off, note
       )
       SELECT $1, entry.employee_id, entry.work_date, entry.schedule_template_id, entry.is_off, entry.note
       FROM attendance_roster_entries entry
       JOIN previous ON previous.id = entry.roster_id
       ON CONFLICT DO NOTHING`,
      [id, body.data.weekStart],
    );
    return reply.status(201).send({ id, version: version.rows[0]?.version ?? 1, status: "DRAFT" });
  });

  app.put("/admin/attendance/rosters/:rosterId/entries", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.schedule.manage");
    if (!principal) return;
    const params = z.object({ rosterId: z.string().uuid() }).safeParse(request.params);
    const body = z.object({ entries: z.array(rosterEntrySchema).max(1000) }).safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ code: "INVALID_ROSTER_ENTRIES", message: "Entry roster tidak valid." });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const roster = await client.query<{ weekStart: string; status: string }>(
        `SELECT week_start::text AS "weekStart", status FROM attendance_rosters WHERE id = $1 FOR UPDATE`,
        [params.data.rosterId],
      );
      if (!roster.rows[0] || roster.rows[0].status !== "DRAFT") throw new WorkforceAttendanceError(409, "ROSTER_NOT_DRAFT", "Roster tidak dapat diedit.");
      const weekEnd = shiftDate(roster.rows[0].weekStart, 6);
      for (const entry of body.data.entries) {
        if (entry.workDate < roster.rows[0].weekStart || entry.workDate > weekEnd) {
          throw new WorkforceAttendanceError(400, "ROSTER_DATE_OUTSIDE_WEEK", "Tanggal entry di luar minggu roster.");
        }
        await client.query(
          `INSERT INTO attendance_roster_entries (
             roster_id, employee_id, work_date, schedule_template_id, is_off, note
           ) VALUES ($1, $2, $3::date, $4, $5, $6)
           ON CONFLICT (roster_id, employee_id, work_date) DO UPDATE SET
             schedule_template_id = EXCLUDED.schedule_template_id,
             is_off = EXCLUDED.is_off,
             note = EXCLUDED.note`,
          [params.data.rosterId, entry.employeeId, entry.workDate, entry.scheduleTemplateId, entry.isOff, entry.note ?? null],
        );
      }
      await client.query("COMMIT");
      return reply.send({ updated: body.data.entries.length });
    } catch (error) {
      await client.query("ROLLBACK");
      return sendError(reply, error);
    } finally {
      client.release();
    }
  });


  app.delete("/admin/attendance/rosters/:rosterId/entries/:employeeId/:workDate", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.schedule.manage");
    if (!principal) return;
    const params = z.object({
      rosterId: z.string().uuid(),
      employeeId: z.string().uuid(),
      workDate: dateSchema,
    }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: "INVALID_ROSTER_ENTRY", message: "Entry roster tidak valid." });
    const changed = await pool.query(
      `DELETE FROM attendance_roster_entries entry
       USING attendance_rosters roster
       WHERE entry.roster_id = roster.id
         AND roster.id = $1
         AND roster.status = 'DRAFT'
         AND entry.employee_id = $2
         AND entry.work_date = $3::date
       RETURNING entry.employee_id`,
      [params.data.rosterId, params.data.employeeId, params.data.workDate],
    );
    if (!changed.rows[0]) return reply.status(409).send({ code: "ROSTER_ENTRY_NOT_REMOVABLE", message: "Entry tidak ditemukan atau roster bukan draft." });
    return reply.status(204).send();
  });

  app.post("/admin/attendance/rosters/:rosterId/copy-previous", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.schedule.manage");
    if (!principal) return;
    const params = z.object({ rosterId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: "INVALID_ROSTER", message: "Roster tidak valid." });
    const target = await pool.query<{ weekStart: string; status: string }>(
      `SELECT week_start::text AS "weekStart", status FROM attendance_rosters WHERE id = $1`,
      [params.data.rosterId],
    );
    const roster = target.rows[0];
    if (!roster || roster.status !== "DRAFT") return reply.status(409).send({ code: "ROSTER_NOT_DRAFT", message: "Roster tidak dapat menerima salinan." });
    const previousWeek = shiftDate(roster.weekStart, -7);
    const inserted = await pool.query(
      `WITH source_roster AS (
         SELECT id
         FROM attendance_rosters
         WHERE week_start = $2::date AND status = 'PUBLISHED'
         ORDER BY version DESC LIMIT 1
       )
       INSERT INTO attendance_roster_entries (
         roster_id, employee_id, work_date, schedule_template_id, is_off, note
       )
       SELECT $1, entry.employee_id, (entry.work_date + interval '7 days')::date,
              entry.schedule_template_id, entry.is_off, entry.note
       FROM attendance_roster_entries entry
       JOIN source_roster source ON source.id = entry.roster_id
       ON CONFLICT (roster_id, employee_id, work_date) DO UPDATE SET
         schedule_template_id = EXCLUDED.schedule_template_id,
         is_off = EXCLUDED.is_off,
         note = EXCLUDED.note
       RETURNING employee_id`,
      [params.data.rosterId, previousWeek],
    );
    return reply.send({ copied: inserted.rowCount ?? 0 });
  });

  app.post("/admin/attendance/rosters/:rosterId/publish", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.schedule.manage");
    if (!principal) return;
    const params = z.object({ rosterId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: "INVALID_ROSTER", message: "Roster tidak valid." });
    const changed = await pool.query(
      `UPDATE attendance_rosters
       SET status = 'PUBLISHED', published_by_account_id = $2, published_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'DRAFT'
       RETURNING id`,
      [params.data.rosterId, principal.id],
    );
    if (!changed.rows[0]) return reply.status(409).send({ code: "ROSTER_NOT_DRAFT", message: "Roster tidak dapat dipublikasikan." });
    await insertAudit(pool, principal.id, "attendance.roster.published", "attendance_roster", params.data.rosterId, {});
    return reply.send({ id: params.data.rosterId, status: "PUBLISHED" });
  });


  app.get("/admin/attendance/mobile-evidence", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.clarification.manage");
    if (!principal) return;
    const query = mobileEvidenceQuerySchema.safeParse(request.query);
    if (!query.success) return reply.status(400).send({ code: "INVALID_MOBILE_EVIDENCE_FILTER", message: "Filter evidence mobile tidak valid." });
    const values: unknown[] = [];
    const clauses: string[] = [];
    if (query.data.date) {
      values.push(query.data.date);
      clauses.push(`(evidence.created_at AT TIME ZONE 'Asia/Jakarta')::date = ${values.length}::date`);
    }
    if (query.data.reviewState !== "all") {
      values.push(query.data.reviewState);
      clauses.push(`evidence.review_state = ${values.length}`);
    }
    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    const result = await pool.query(
      `SELECT evidence.id, evidence.action,
         evidence.latitude, evidence.longitude, evidence.accuracy_meters AS "accuracyMeters",
         evidence.distance_meters AS "distanceMeters", evidence.geofence_status AS "geofenceStatus",
         evidence.review_state AS "reviewState", evidence.photo_byte_length AS "photoByteLength",
         evidence.created_at AS "createdAt",
         event.occurred_at AS "occurredAt",
         employee.id AS "employeeId", employee.employee_number AS "employeeNumber",
         employee.full_name AS "employeeName", unit.name AS "unitName",
         location.id AS "workLocationId", location.name AS "workLocationName",
         location.radius_meters AS "radiusMeters"
       FROM attendance_mobile_evidence evidence
       JOIN attendance_events event ON event.id = evidence.event_id
       JOIN employees employee ON employee.id = evidence.employee_id
       LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
       LEFT JOIN attendance_work_locations location ON location.id = evidence.work_location_id
       ${where}
       ORDER BY evidence.created_at DESC
       LIMIT 500`,
      values,
    );
    reply.header("Cache-Control", "no-store");
    return reply.send({ items: result.rows });
  });

  app.get("/admin/attendance/mobile-evidence/:evidenceId/photo", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.clarification.manage");
    if (!principal) return;
    const params = z.object({ evidenceId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: "INVALID_EVIDENCE_ID", message: "Evidence tidak valid." });
    const evidence = await pool.query<{
      id: string; employeeId: string; eventId: string; ciphertext: Buffer; iv: Buffer;
      authTag: Buffer; keyId: string; sha256: string; byteLength: number;
    }>(
      `SELECT id, employee_id AS "employeeId", event_id AS "eventId",
         photo_ciphertext AS ciphertext, photo_iv AS iv, photo_auth_tag AS "authTag",
         encryption_key_id AS "keyId", photo_sha256 AS sha256,
         photo_byte_length AS "byteLength"
       FROM attendance_mobile_evidence WHERE id = $1`,
      [params.data.evidenceId],
    );
    const item = evidence.rows[0];
    if (!item) return reply.status(404).send({ code: "EVIDENCE_NOT_FOUND", message: "Evidence tidak ditemukan." });
    const payload = decryptMobileAttendancePhoto(item, {
      evidenceId: item.id,
      employeeId: item.employeeId,
      eventId: item.eventId,
    }, config);
    await insertAudit(pool, principal.id, "attendance.mobile.photo.read", "attendance_mobile_evidence", item.id, {
      admin: true, employeeId: item.employeeId,
    });
    reply.header("Cache-Control", "no-store");
    reply.type("image/jpeg");
    return reply.send(payload);
  });

  app.post("/admin/attendance/finalize/:date", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.policy.manage");
    if (!principal) return;
    const params = z.object({ date: dateSchema }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: "INVALID_DATE", message: "Tanggal tidak valid." });
    const employees = await pool.query<{ id: string }>("SELECT id FROM employees WHERE status = 'active' ORDER BY id");
    let materialized = 0;
    for (const employee of employees.rows) {
      await materializeAttendanceResult(pool, employee.id, params.data.date);
      materialized += 1;
    }
    await insertAudit(pool, principal.id, "attendance.finalized", "attendance_result", null, { date: params.data.date, materialized });
    return reply.send({ date: params.data.date, materialized });
  });

  app.get("/admin/attendance/report", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.reports.read");
    if (!principal) return;
    const query = reportQuerySchema.safeParse(request.query);
    if (!query.success) return reply.status(400).send({ code: "INVALID_REPORT_QUERY", message: "Filter laporan tidak valid." });
    const values: unknown[] = [query.data.date];
    const statusClause = query.data.status ? "AND latest.status = $2" : "";
    if (query.data.status) values.push(query.data.status);
    const result = await pool.query(
      `SELECT employee.id AS "employeeId", employee.employee_number AS "employeeNumber",
         employee.full_name AS "employeeName", unit.name AS "unitName",
         latest.status, latest.first_check_in_at AS "firstCheckInAt",
         latest.last_check_out_at AS "lastCheckOutAt", latest.worked_minutes AS "workedMinutes",
         latest.late_minutes AS "lateMinutes", latest.early_leave_minutes AS "earlyLeaveMinutes",
         latest.justified
       FROM employees employee
       LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
       LEFT JOIN LATERAL (
         SELECT result.*
         FROM attendance_result_versions result
         WHERE result.employee_id = employee.id AND result.work_date = $1::date
         ORDER BY result.version DESC LIMIT 1
       ) latest ON true
       WHERE employee.status = 'active'
         AND latest.id IS NOT NULL
         ${statusClause}
       ORDER BY unit.name NULLS LAST, employee.full_name`,
      values,
    );
    const summary = result.rows.reduce<Record<string, number>>((accumulator, row: Record<string, unknown>) => {
      const status = String(row.status);
      accumulator[status] = (accumulator[status] ?? 0) + 1;
      return accumulator;
    }, {});
    reply.header("Cache-Control", "no-store");
    return reply.send({ date: query.data.date, summary, items: result.rows });
  });
}
