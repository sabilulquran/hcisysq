import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { pageQuerySchema } from "../../lib/pagination.js";
import { requireAnyPermissionFromCookie, requirePermissionsFromCookie, requirePrincipalFromCookie } from "../auth/authorization.js";
import { AuthError, AuthService, type AuthPrincipal } from "../auth/service.js";
import { notifyEmployee } from "../notifications/service.js";
import type { AdminPermission } from "../auth/permissions.js";
import {
  haversineDistanceMeters,
  jakartaWorkDate,
  materializeAttendanceResult,
  resolveSchedule,
} from "./engine.js";
import { ACTION_QUEUE_PERMISSIONS, allowedActionKinds, attendanceActionQueue, type ActionKind } from "./action-queue.js";
import { attendanceCalculationRows } from "./calculation-rows.js";
import {
  createCalculationRunner,
  RUN_COLUMNS,
  validateCalculationRange,
  type CalculationRun,
  type CalculationRunner,
} from "./calculation-runner.js";
import { listAttendanceCorrections } from "./corrections.js";
import { attendanceExceptions } from "./exceptions.js";
import { LEAVE_POLICY_CATALOG } from "../leave/domain/policy-catalog.js";
import { listOvertimeForHc } from "./overtime-list.js";
import { CLARIFICATION_LOOKBACK_DAYS, clarificationDateAllowed, manualCorrectionWindowError, manualCorrectionWindowMessages } from "./manual-correction-window.js";
import { REPORT_MODELS, buildPunchTable, buildReportTable, isPunchModel, reportCsv, reportXlsx, type ReportModel } from "./report-models.js";
import { attendanceDailyReadModel, buildAttendanceReport, type AttendanceReportType } from "./reporting.js";
import {
  decryptMobileAttendancePhoto,
  encryptMobileAttendancePhoto,
  restrictedMediaReady,
} from "./restricted-media-crypto.js";
import { attendanceTodayReadModel } from "./today.js";
import { jakartaBusinessDate } from "../organization/jakarta-date.js";
import { attendanceTransactions } from "./transactions.js";
import { unattributedPins, unscheduledEmployees } from "./unscheduled.js";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
// §13: a print or export larger than this asks the operator to narrow the scope (DRAFT, tune on Mi8VPS).
const REPORT_ROW_LIMIT = 50_000;
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
// ATT-013: blocks 2-3 of a shift, on the same day as block 1.
const workdayWeightSchema = z.number().gt(0).max(1).multipleOf(0.01);
const extraBlocksSchema = z.array(z.object({
  startTime: z.string().regex(/^\d{2}:\d{2}(?::\d{2})?$/),
  endTime: z.string().regex(/^\d{2}:\d{2}(?::\d{2})?$/),
  // D-13-6 "Hitungan hari"; when every block has one they must add up to 1,00.
  workdayWeight: workdayWeightSchema.optional(),
})).max(2);

const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/**
 * ATT-013 (attendance-multi-block-schedule.md §4.1): blocks in order on one day, Jeda Antarblok at least
 * 30 minutes (D-13-2), at most 20 hours of blocks, and day shares that are all given or all left out and
 * then add up to 1,00 (D-13-6). The message names the block.
 */
export function scheduleBlocksError(
  first: { startTime: string; endTime: string; endDayOffset: number; workdayWeight?: number | null },
  extra: ReadonlyArray<{ startTime: string; endTime: string; workdayWeight?: number | null | undefined }>,
) {
  if (extra.length === 0) return null;
  if (first.endDayOffset !== 0 || first.endTime <= first.startTime) return "Shift dengan beberapa blok tidak boleh melewati tengah malam.";
  let previousEnd = minutesOf(first.endTime);
  let total = previousEnd - minutesOf(first.startTime);
  for (const [index, block] of extra.entries()) {
    const start = minutesOf(block.startTime);
    const end = minutesOf(block.endTime);
    if (end <= start) return `Blok ${index + 2} harus selesai setelah mulai, pada hari yang sama.`;
    if (start - previousEnd < 30) return `Jeda sebelum blok ${index + 2} minimal 30 menit; jeda lebih pendek adalah istirahat di dalam satu blok.`;
    total += end - start;
    previousEnd = end;
  }
  if (total > 20 * 60) return "Total seluruh blok tidak boleh lebih dari 20 jam.";
  const weights = [first.workdayWeight, ...extra.map((block) => block.workdayWeight)];
  const given = weights.filter((weight) => weight !== undefined && weight !== null);
  if (given.length > 0 && given.length < weights.length) return "Isi Hitungan hari untuk semua blok, atau kosongkan semuanya.";
  if (given.length && Math.round(given.reduce((sum, weight) => sum + Number(weight), 0) * 100) !== 100) {
    return "Jumlah Hitungan hari seluruh blok harus 1,00.";
  }
  return null;
}

async function writeVersionBlocks(
  client: PoolClient,
  versionId: string,
  blocks: ReadonlyArray<{ startTime: string; endTime: string; workdayWeight?: number | null | undefined }>,
  firstBlockWorkdayWeight: number | null = null,
) {
  if (blocks.length && firstBlockWorkdayWeight !== null) {
    await client.query("UPDATE attendance_schedule_versions SET first_block_workday_weight = $2 WHERE id = $1", [versionId, firstBlockWorkdayWeight]);
  }
  for (const [index, block] of blocks.entries()) {
    await client.query(
      `INSERT INTO attendance_schedule_version_blocks (id, schedule_version_id, sequence, start_time, end_time, workday_weight)
       VALUES ($1, $2, $3, $4::time, $5::time, $6)`,
      [randomUUID(), versionId, index + 2, block.startTime, block.endTime, block.workdayWeight ?? null],
    );
  }
}

const scheduleTemplateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  startTime: z.string().regex(/^\d{2}:\d{2}(?::\d{2})?$/),
  endTime: z.string().regex(/^\d{2}:\d{2}(?::\d{2})?$/),
  endDayOffset: z.number().int().min(0).max(1).optional(),
  lateGraceMinutes: z.number().int().min(0).max(240).default(0),
  earlyLeaveToleranceMinutes: z.number().int().min(0).max(240).default(0),
  workLocationId: z.string().uuid().nullable().optional(),
  // ATT-014 §20.10: the date the shift's meaning applies from (00:00 WIB); default is the moment of creation.
  effectiveFrom: dateSchema.optional(),
  extraBlocks: extraBlocksSchema.default([]),
  firstBlockWorkdayWeight: workdayWeightSchema.optional(),
});
const scheduleBackdateSchema = z.object({
  effectiveFrom: dateSchema,
  reason: z.string().trim().min(3).max(500),
});
const scheduleTemplatePatchSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  startTime: z.string().regex(/^\d{2}:\d{2}(?::\d{2})?$/).optional(),
  endTime: z.string().regex(/^\d{2}:\d{2}(?::\d{2})?$/).optional(),
  endDayOffset: z.number().int().min(0).max(1).optional(),
  lateGraceMinutes: z.number().int().min(0).max(240).optional(),
  earlyLeaveToleranceMinutes: z.number().int().min(0).max(240).optional(),
  extraBlocks: extraBlocksSchema.optional(),
  firstBlockWorkdayWeight: workdayWeightSchema.optional(),
  workLocationId: z.string().uuid().nullable().optional(),
  active: z.boolean().optional(),
  // ATT-011-4 §4.2: the date (WIB) a change of hours applies from; today (from now) or later, default now.
  effectiveFrom: dateSchema.optional(),
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
  origin: z.enum(["all", "employee", "hc"]).default("all"),
  mode: z.enum(["all", "correction", "justification"]).default("all"),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(200).default(50),
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

const OVERTIME_DAY_LIMIT_MINUTES = 24 * 60;

/**
 * ATT-011-6a §7.6: overtime of one employee on one day may not add up to more than 24 hours. Counts
 * approved and waiting requests (other than `excludeId`) plus the minutes being added.
 */
async function assertOvertimeDayTotal(
  db: Pick<PoolClient, "query">,
  employeeId: string,
  workDate: string,
  addMinutes: number,
  excludeId: string | null = null,
) {
  const total = await db.query<{ minutes: number }>(
    `SELECT coalesce(sum(CASE WHEN status = 'approved' THEN coalesce(approved_minutes, 0) ELSE requested_minutes END), 0)::int AS minutes
     FROM attendance_overtime_requests
     WHERE employee_id = $1 AND work_date = $2::date AND status IN ('submitted', 'approved')
       AND ($3::uuid IS NULL OR id <> $3)`,
    [employeeId, workDate, excludeId],
  );
  if ((total.rows[0]?.minutes ?? 0) + addMinutes > OVERTIME_DAY_LIMIT_MINUTES) {
    throw new WorkforceAttendanceError(422, "OVERTIME_DAY_TOTAL_INVALID", "Total lembur satu hari tidak boleh lebih dari 24 jam.");
  }
}

function shiftDateText(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function mapResult(row: Record<string, unknown> | null | undefined) {
  if (!row) return null;
  const date = (value: unknown) => value instanceof Date ? value.toISOString() : value ?? null;
  const mapped: Record<string, unknown> = {
    ...row,
    scheduledStartAt: date(row.scheduledStartAt),
    scheduledEndAt: date(row.scheduledEndAt),
    firstCheckInAt: date(row.firstCheckInAt),
    lastCheckOutAt: date(row.lastCheckOutAt),
    createdAt: date(row.createdAt),
  };
  return mapped;
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
       overtime_minutes AS "overtimeMinutes", day_type AS "dayType",
       holiday_scheduled_work AS "holidayScheduledWork", created_at AS "createdAt"
     FROM attendance_result_versions
     WHERE employee_id = $1 AND work_date = $2::date
     ORDER BY version DESC LIMIT 1`,
    [employeeId, workDate],
  );
  const mapped = mapResult(result.rows[0]);
  if (!mapped || typeof mapped.id !== "string") return mapped;
  const sessions = await db.query(
    `SELECT sequence, check_in_at AS "checkInAt", check_out_at AS "checkOutAt",
       worked_minutes AS "workedMinutes", complete, source_summary AS "sourceSummary"
     FROM attendance_result_sessions
     WHERE attendance_result_version_id = $1
     ORDER BY sequence`,
    [mapped.id],
  );
  // ATT-013: per-block outcome of a multi-block day (none for a single-block day).
  const blocks = await db.query(
    `SELECT sequence, scheduled_start_at AS "scheduledStartAt", scheduled_end_at AS "scheduledEndAt",
       first_check_in_at AS "firstCheckInAt", last_check_out_at AS "lastCheckOutAt", status,
       late_minutes AS "lateMinutes", early_leave_minutes AS "earlyLeaveMinutes", worked_minutes AS "workedMinutes",
       expected_workday::float8 AS "expectedWorkday", credited_workday::float8 AS "creditedWorkday"
     FROM attendance_result_blocks WHERE attendance_result_version_id = $1 ORDER BY sequence`,
    [mapped.id],
  );
  const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value ?? null);
  return {
    ...mapped,
    blocks: blocks.rows.map((item: Record<string, unknown>) => ({
      ...item,
      scheduledStartAt: iso(item.scheduledStartAt),
      scheduledEndAt: iso(item.scheduledEndAt),
      firstCheckInAt: iso(item.firstCheckInAt),
      lastCheckOutAt: iso(item.lastCheckOutAt),
    })),
    sessions: sessions.rows.map((item: Record<string, unknown>) => ({
      ...item,
      checkInAt: item.checkInAt instanceof Date ? item.checkInAt.toISOString() : item.checkInAt ?? null,
      checkOutAt: item.checkOutAt instanceof Date ? item.checkOutAt.toISOString() : item.checkOutAt ?? null,
    })),
  };
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

/**
 * ORG-005-2 (D-5-7): what still uses a work location — units of the structure effective today or of
 * any structure published to take effect later, and every machine that is not retired. Names only.
 * Runs on the caller's transaction, after the location row is locked.
 */
async function workLocationUses(
  db: PoolClient,
  locationId: string,
): Promise<Array<{ kind: "UNIT" | "DEVICE"; name: string }>> {
  const asOf = jakartaBusinessDate();
  const units = await db.query<{ name: string }>(
    `WITH current_structure AS (
       SELECT id FROM organization_change_sets
       WHERE status = 'PUBLISHED' AND effective_on <= $2::date
       ORDER BY effective_on DESC, published_at DESC, created_at DESC, id DESC
       LIMIT 1
     )
     SELECT DISTINCT node.name
     FROM organization_nodes node
     JOIN organization_change_sets change_set ON change_set.id = node.change_set_id
     WHERE change_set.status = 'PUBLISHED'
       AND node.work_location_id = $1
       AND node.active
       AND (node.effective_to IS NULL OR node.effective_to >= $2::date)
       AND (change_set.effective_on > $2::date OR change_set.id IN (SELECT id FROM current_structure))
     ORDER BY node.name`,
    [locationId, asOf],
  );
  const devices = await db.query<{ name: string }>(
    `SELECT coalesce(display_name, serial_number) AS name FROM attendance_adms_devices
     WHERE work_location_id = $1 AND lifecycle <> 'retired' ORDER BY name`,
    [locationId],
  );
  return [
    ...units.rows.map((row) => ({ kind: "UNIT" as const, name: row.name })),
    ...devices.rows.map((row) => ({ kind: "DEVICE" as const, name: row.name })),
  ];
}

export async function registerAttendanceWorkforceRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
  options: { calculationRunner?: CalculationRunner } = {},
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
  // ATT-014-2: Kalkulasi runs inside this process. On start, runs left running are INTERRUPTED and
  // queued runs continue. Tests inject their own runner and never start the loop implicitly.
  const calculationRunner = options.calculationRunner ?? createCalculationRunner(pool, {
    log: (message, details) => app.log.info(details, message),
  });
  if (config.NODE_ENV !== "test") {
    // Never blocks start-up: a database hiccup here only delays the queue until the next request.
    app.addHook("onReady", async () => {
      try {
        await calculationRunner.recoverInterrupted();
        calculationRunner.kick();
      } catch (error) {
        app.log.error({ error: error instanceof Error ? error.name : "unknown" }, "attendance calculation recovery failed");
      }
    });
  }

  app.get("/attendance/me/workforce", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "EMPLOYEE");
    if (!principal) return;
    try {
      const query = z.object({ date: dateSchema.optional() }).safeParse(request.query);
      if (!query.success) throw new WorkforceAttendanceError(400, "INVALID_DATE", "Tanggal tidak valid.");
      const employee = await employeeForAccount(pool, principal.id);
      const workDate = query.data.date ?? jakartaWorkDate();
      const schedule = await resolveSchedule(pool, employee.id, workDate);
      const [result, clarifications, mobile, overtime] = await Promise.all([
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
        pool.query(
          `SELECT id, work_date::text AS "workDate", requested_minutes AS "requestedMinutes",
             approved_minutes AS "approvedMinutes", note, status,
             decision_note AS "decisionNote", created_at AS "createdAt", decided_at AS "decidedAt"
           FROM attendance_overtime_requests
           WHERE employee_id = $1
           ORDER BY work_date DESC, created_at DESC
           LIMIT 20`,
          [employee.id],
        ),
      ]);
      const enabledByConfig = config.MOBILE_ATTENDANCE_ENABLED === "1";
      const mediaReady = restrictedMediaReady(config);
      const mobileEnabled = enabledByConfig && mediaReady;
      reply.header("Cache-Control", "no-store");
      return reply.send({
        employee,
        workDate,
        mobileEnabled,
        mobileReadiness: {
          captureReady: mobileEnabled,
          captureReason: !enabledByConfig
            ? "runtime_disabled"
            : !mediaReady
              ? "restricted_media_not_ready"
              : "ready",
          scheduleState: schedule.state,
          scheduleReason: schedule.reason ?? null,
          hasWorkLocation: Boolean(schedule.workLocation),
          workLocationId: schedule.workLocation?.id ?? null,
        },
        schedule: scheduleResponse(schedule),
        result,
        clarifications: clarifications.rows,
        mobileEvidence: mobile.rows,
        overtimeRequests: overtime.rows,
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
      if (!clarificationDateAllowed(body.data.workDate)) {
        throw new WorkforceAttendanceError(
          422,
          "CLARIFICATION_DATE_OUT_OF_RANGE",
          `Klarifikasi hanya untuk hari ini dan ${CLARIFICATION_LOOKBACK_DAYS} hari sebelumnya.`,
        );
      }
      if (body.data.mode === "correction") {
        const windowError = manualCorrectionWindowError({
          workDate: body.data.workDate,
          checkInAt: body.data.proposedCheckInAt ?? null,
          checkOutAt: body.data.proposedCheckOutAt ?? null,
        });
        if (windowError) throw new WorkforceAttendanceError(422, windowError, manualCorrectionWindowMessages[windowError]);
      }
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

  // ATT-011-3R Perbaikan Absen: employee requests and HC corrections in one paginated list, readable
  // by whoever may decide requests or enter corrections. Each action keeps its own permission.
  app.get("/admin/attendance/clarifications", async (request, reply) => {
    try {
      await requireAnyPermissionFromCookie(auth, request.headers.cookie, ["attendance.clarification.manage", "attendance.records.manage"]);
    } catch (error) {
      if (error instanceof AuthError) {
        reply.header("Cache-Control", "no-store");
        return reply.status(error.statusCode).send({ code: error.code, message: error.message });
      }
      throw error;
    }
    reply.header("Cache-Control", "no-store");
    const query = clarificationAdminQuerySchema.safeParse(request.query);
    if (!query.success) return reply.status(400).send({ code: "INVALID_CLARIFICATION_FILTER", message: "Filter klarifikasi tidak valid." });
    return reply.send(await listAttendanceCorrections(pool, query.data));
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
      const current = await client.query<{
        employeeId: string; workDate: string; mode: string; proposedCheckInAt: Date | null; proposedCheckOutAt: Date | null;
        administrativeCorrection: boolean;
      }>(
        `SELECT employee_id AS "employeeId", work_date::text AS "workDate", mode,
           proposed_check_in_at AS "proposedCheckInAt", proposed_check_out_at AS "proposedCheckOutAt",
           EXISTS (
             SELECT 1 FROM attendance_clarification_events submitted
             WHERE submitted.clarification_id = attendance_clarifications.id
               AND submitted.event_type = 'submitted'
               AND submitted.payload->>'administrativeCorrection' = 'true'
           ) AS "administrativeCorrection"
         FROM attendance_clarifications WHERE id = $1 AND status = 'submitted' FOR UPDATE`,
        [params.data.clarificationId],
      );
      const item = current.rows[0];
      if (!item) throw new WorkforceAttendanceError(409, "CLARIFICATION_ALREADY_DECIDED", "Klarifikasi sudah diputuskan.");
      // A request submitted before the work-date check existed may carry times from another date:
      // it can only be rejected, so the engine never counts it.
      if (body.data.decision === "approve" && item.mode === "correction") {
        const windowError = manualCorrectionWindowError({
          workDate: item.workDate,
          checkInAt: item.proposedCheckInAt ? new Date(item.proposedCheckInAt).toISOString() : null,
          checkOutAt: item.proposedCheckOutAt ? new Date(item.proposedCheckOutAt).toISOString() : null,
        });
        if (windowError) {
          throw new WorkforceAttendanceError(422, windowError, `${manualCorrectionWindowMessages[windowError]} Tolak pengajuan ini dan minta pegawai mengajukan ulang.`);
        }
      }
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
      // ATT-011-7: the employee hears about the decision on their own request (not on HC corrections).
      if (!item.administrativeCorrection) {
        const approved = body.data.decision === "approve";
        await notifyEmployee(client, item.employeeId, {
          eventKey: `clarification:${params.data.clarificationId}:${approved ? "approved" : "rejected"}`,
          category: "attendance",
          title: approved ? "Klarifikasi disetujui" : "Klarifikasi ditolak",
          body: approved ? `Klarifikasi kehadiran ${item.workDate} disetujui.` : `Klarifikasi kehadiran ${item.workDate} ditolak.`,
          href: "/app/attendance#clarifications",
          actorAccountId: principal.id,
          metadata: { clarificationId: params.data.clarificationId, workDate: item.workDate, status: approved ? "approved" : "rejected" },
        });
      }
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
    // ORG-005-2: the row is locked, so a machine cannot be linked between the in-use check and the
    // switch-off (a link takes a share lock on the same row).
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{
        name: string; latitude: number; longitude: number; radiusMeters: number; active: boolean;
      }>(
        `SELECT name, latitude, longitude, radius_meters AS "radiusMeters", active
         FROM attendance_work_locations WHERE id = $1 FOR UPDATE`,
        [params.data.locationId],
      );
      const item = current.rows[0];
      if (!item) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ code: "WORK_LOCATION_NOT_FOUND", message: "Lokasi kerja tidak ditemukan." });
      }
      // ORG-005-2 (DRAFT D-5-7): a location still named by a published unit or a machine is not
      // switched off; the refusal names what still uses it.
      if (body.data.active === false && item.active) {
        const uses = await workLocationUses(client, params.data.locationId);
        if (uses.length > 0) {
          await client.query("ROLLBACK");
          return reply.status(409).send({
            code: "WORK_LOCATION_IN_USE",
            message: "Lokasi kerja ini masih dipakai unit atau mesin absensi.",
            details: { uses },
          });
        }
      }
      const next = { ...item, ...body.data };
      await client.query(
        `UPDATE attendance_work_locations
         SET name = $2, latitude = $3, longitude = $4, radius_meters = $5,
             active = $6, updated_at = now()
         WHERE id = $1`,
        [params.data.locationId, next.name, next.latitude, next.longitude, next.radiusMeters, next.active],
      );
      await insertAudit(client, principal.id, "attendance.work_location.updated", "attendance_work_location", params.data.locationId, {
        fields: Object.keys(body.data),
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
      `SELECT schedule.id, coalesce(version.name, schedule.name) AS name,
         coalesce(version.start_time, schedule.start_time)::text AS "startTime",
         coalesce(version.end_time, schedule.end_time)::text AS "endTime",
         coalesce(version.end_day_offset, schedule.end_day_offset) AS "endDayOffset",
         coalesce(version.late_grace_minutes, schedule.late_grace_minutes) AS "lateGraceMinutes",
         coalesce(version.early_leave_tolerance_minutes, schedule.early_leave_tolerance_minutes) AS "earlyLeaveToleranceMinutes",
         schedule.active, location.id AS "workLocationId", location.name AS "workLocationName",
         -- ATT-011-4 §4.2: a change that applies from a later date.
         (SELECT json_build_object('version', pending.version, 'effectiveFrom', (pending.effective_from AT TIME ZONE 'Asia/Jakarta')::date::text,
                   'startTime', pending.start_time::text, 'endTime', pending.end_time::text,
                   'lateGraceMinutes', pending.late_grace_minutes, 'earlyLeaveToleranceMinutes', pending.early_leave_tolerance_minutes)
            FROM attendance_schedule_versions pending
            WHERE pending.schedule_template_id = schedule.id AND pending.effective_from > now()
            ORDER BY pending.version DESC LIMIT 1) AS "pendingVersion",
         (SELECT count(DISTINCT assignment.employee_id)::int FROM attendance_schedule_assignments assignment
            WHERE assignment.schedule_template_id = schedule.id
              AND (assignment.effective_to IS NULL OR assignment.effective_to >= (now() AT TIME ZONE 'Asia/Jakarta')::date)) AS "employeeCount",
         version.id AS "currentVersionId", version.version AS "currentVersion",
         (SELECT coalesce(json_agg(json_build_object('startTime', block.start_time::text, 'endTime', block.end_time::text,
                   'workdayWeight', block.workday_weight::float8) ORDER BY block.sequence), '[]'::json)
            FROM attendance_schedule_version_blocks block WHERE block.schedule_version_id = version.id) AS "extraBlocks",
         version.first_block_workday_weight::float8 AS "firstBlockWorkdayWeight",
         (SELECT (min(first.effective_from) AT TIME ZONE 'Asia/Jakarta')::date::text
            FROM attendance_schedule_versions first WHERE first.schedule_template_id = schedule.id) AS "effectiveFrom"
       FROM attendance_schedule_templates schedule
       LEFT JOIN LATERAL (
         SELECT candidate.* FROM attendance_schedule_versions candidate
         WHERE candidate.schedule_template_id = schedule.id AND candidate.effective_from <= now()
           AND (candidate.effective_to IS NULL OR candidate.effective_to > now())
         ORDER BY candidate.version DESC LIMIT 1
       ) version ON true
       LEFT JOIN attendance_work_locations location
         ON location.id = CASE WHEN version.id IS NULL THEN schedule.work_location_id ELSE version.work_location_id END
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

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // ATT-011-4a: fields not in the request come from the version in force now. The template columns
      // only mirror it as of the last change, so a change from a later date leaves them behind.
      const current = await client.query<{
        name: string; startTime: string; endTime: string; endDayOffset: number; lateGraceMinutes: number;
        earlyLeaveToleranceMinutes: number; workLocationId: string | null; active: boolean; versionId: string | null;
      }>(
        `SELECT coalesce(version.name, schedule.name) AS name,
           coalesce(version.start_time, schedule.start_time)::text AS "startTime",
           coalesce(version.end_time, schedule.end_time)::text AS "endTime",
           coalesce(version.end_day_offset, schedule.end_day_offset) AS "endDayOffset",
           coalesce(version.late_grace_minutes, schedule.late_grace_minutes) AS "lateGraceMinutes",
           coalesce(version.early_leave_tolerance_minutes, schedule.early_leave_tolerance_minutes) AS "earlyLeaveToleranceMinutes",
           CASE WHEN version.id IS NULL THEN schedule.work_location_id ELSE version.work_location_id END AS "workLocationId",
           schedule.active, version.id AS "versionId"
         FROM attendance_schedule_templates schedule
         LEFT JOIN LATERAL (
           SELECT candidate.* FROM attendance_schedule_versions candidate
           WHERE candidate.schedule_template_id = schedule.id AND candidate.effective_from <= clock_timestamp()
             AND (candidate.effective_to IS NULL OR candidate.effective_to > clock_timestamp())
           ORDER BY candidate.version DESC LIMIT 1
         ) version ON true
         WHERE schedule.id = $1 FOR UPDATE OF schedule`,
        [params.data.scheduleId],
      );
      const item = current.rows[0];
      if (!item) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ code: "SCHEDULE_NOT_FOUND", message: "Template jadwal tidak ditemukan." });
      }
      const today = jakartaWorkDate();
      if (body.data.effectiveFrom && body.data.effectiveFrom < today) {
        await client.query("ROLLBACK");
        return reply.status(400).send({
          code: "EFFECTIVE_DATE_IN_PAST",
          message: "Perubahan jam shift tidak boleh mundur. Gunakan Koreksi pada Kehadiran untuk hari yang sudah lewat.",
        });
      }
      // §4.2: a shift that still schedules someone today or later cannot be switched off.
      if (body.data.active === false && item.active) {
        const inUse = await client.query<{ employeeNumber: string; employeeName: string; fromDate: string; total: number }>(
          `WITH used AS (
             SELECT assignment.employee_id, greatest(assignment.effective_from, $2::date) AS from_date
             FROM attendance_schedule_assignments assignment
             WHERE assignment.schedule_template_id = $1
               AND (assignment.effective_to IS NULL OR assignment.effective_to >= $2::date)
             UNION ALL
             SELECT entry.employee_id, entry.work_date
             FROM attendance_roster_entries entry
             JOIN attendance_rosters roster ON roster.id = entry.roster_id AND roster.status = 'PUBLISHED'
             WHERE entry.schedule_template_id = $1 AND entry.work_date >= $2::date AND NOT entry.is_off
           ), per_employee AS (
             SELECT employee_id, min(from_date) AS from_date FROM used GROUP BY employee_id
           )
           SELECT employee.employee_number AS "employeeNumber", employee.full_name AS "employeeName",
             per_employee.from_date::text AS "fromDate", count(*) OVER ()::int AS total
           FROM per_employee JOIN employees employee ON employee.id = per_employee.employee_id AND employee.status = 'active'
           ORDER BY employee.full_name LIMIT 20`,
          [params.data.scheduleId, today],
        );
        if (inUse.rows[0]) {
          await client.query("ROLLBACK");
          return reply.status(409).send({
            code: "SCHEDULE_IN_USE",
            message: `Shift masih dipakai ${inUse.rows[0].total} pegawai mulai hari ini. Pindahkan jadwal mereka dulu.`,
            total: inUse.rows[0].total,
            employees: inUse.rows.map(({ total, ...row }) => { void total; return row; }),
          });
        }
      }
      const future = Boolean(body.data.effectiveFrom && body.data.effectiveFrom > today);
      // A change from a later date replaces the scheduled one and builds on it; any other builds on now.
      const scheduled = future ? (await client.query<typeof item>(
        `SELECT id AS "versionId", name, start_time::text AS "startTime", end_time::text AS "endTime",
           end_day_offset AS "endDayOffset", late_grace_minutes AS "lateGraceMinutes",
           early_leave_tolerance_minutes AS "earlyLeaveToleranceMinutes", work_location_id AS "workLocationId", $2::boolean AS active
         FROM attendance_schedule_versions
         WHERE schedule_template_id = $1 AND effective_from > clock_timestamp()
         ORDER BY version DESC LIMIT 1`,
        [params.data.scheduleId, item.active],
      )).rows[0] : undefined;
      const { versionId: baseVersionId, ...base } = scheduled ?? item;
      const next = { ...base, ...body.data } as typeof base;
      if (body.data.endDayOffset === undefined && (body.data.startTime !== undefined || body.data.endTime !== undefined)) {
        next.endDayOffset = next.endTime <= next.startTime ? 1 : 0;
      }
      const semanticChanged = ["name", "startTime", "endTime", "endDayOffset", "lateGraceMinutes", "earlyLeaveToleranceMinutes", "workLocationId", "extraBlocks", "firstBlockWorkdayWeight"]
        .some((key) => Object.prototype.hasOwnProperty.call(body.data, key));
      // ATT-013: without new blocks in the request, a new version keeps the current version's blocks.
      const blocks = body.data.extraBlocks ?? (await client.query<{ startTime: string; endTime: string; workdayWeight: number | null }>(
        `SELECT block.start_time::text AS "startTime", block.end_time::text AS "endTime",
           block.workday_weight::float8 AS "workdayWeight"
         FROM attendance_schedule_version_blocks block
         WHERE block.schedule_version_id = $1
         ORDER BY block.sequence`,
        [baseVersionId],
      )).rows;
      const firstWeight = body.data.firstBlockWorkdayWeight ?? (body.data.extraBlocks ? null : (await client.query<{ weight: number | null }>(
        "SELECT first_block_workday_weight::float8 AS weight FROM attendance_schedule_versions WHERE id = $1",
        [baseVersionId],
      )).rows[0]?.weight ?? null);
      const blocksError = scheduleBlocksError({ ...next, workdayWeight: firstWeight }, blocks);
      if (blocksError) {
        await client.query("ROLLBACK");
        return reply.status(422).send({ code: "SCHEDULE_BLOCKS_INVALID", message: blocksError });
      }

      // A future change leaves the template at the values in force now until it applies; only `active` changes now.
      await client.query(
        `UPDATE attendance_schedule_templates
         SET name = $2, start_time = $3::time, end_time = $4::time, end_day_offset = $5,
             late_grace_minutes = $6, early_leave_tolerance_minutes = $7,
             work_location_id = $8, active = $9, updated_at = now()
         WHERE id = $1`,
        future
          ? [params.data.scheduleId, item.name, item.startTime, item.endTime, item.endDayOffset,
            item.lateGraceMinutes, item.earlyLeaveToleranceMinutes, item.workLocationId ?? null, next.active]
          : [params.data.scheduleId, next.name, next.startTime, next.endTime, next.endDayOffset,
            next.lateGraceMinutes, next.earlyLeaveToleranceMinutes, next.workLocationId ?? null, next.active],
      );

      let versionId: string | null = null;
      let versionNumber: number | null = null;
      let affectedEmployees = 0;
      let replacedVersionIds: string[] = [];
      if (semanticChanged) {
        const atResult = await client.query<{ at: Date }>(
          future ? "SELECT ($1::date::timestamp AT TIME ZONE 'Asia/Jakarta') AS at" : "SELECT clock_timestamp() AS at",
          future ? [body.data.effectiveFrom] : [],
        );
        const effectiveAt = atResult.rows[0]?.at ?? new Date();
        // §4.2: one future version at most; changing again replaces it while nothing uses it yet.
        const pending = await client.query<{ id: string; used: boolean }>(
          `SELECT version.id, EXISTS (SELECT 1 FROM attendance_roster_entries entry WHERE entry.schedule_version_id = version.id)
             OR EXISTS (SELECT 1 FROM attendance_result_versions result WHERE result.schedule_version_id = version.id) AS used
           FROM attendance_schedule_versions version
           WHERE version.schedule_template_id = $1 AND version.effective_from > clock_timestamp()
           FOR UPDATE`,
          [params.data.scheduleId],
        );
        if (pending.rows.length && !future) {
          throw new WorkforceAttendanceError(409, "SCHEDULE_CHANGE_PENDING",
            "Shift ini punya perubahan terjadwal. Ubah dengan tanggal Berlaku mulai setelah hari ini untuk menggantinya.");
        }
        replacedVersionIds = pending.rows.map((row) => row.id);
        for (const row of pending.rows) {
          if (row.used) throw new WorkforceAttendanceError(409, "SCHEDULE_FUTURE_VERSION_IN_USE", "Perubahan shift yang dijadwalkan sudah dipakai jadwal per tanggal dan tidak dapat diganti.");
          await client.query("DELETE FROM attendance_schedule_version_blocks WHERE schedule_version_id = $1", [row.id]);
          await client.query("DELETE FROM attendance_schedule_versions WHERE id = $1", [row.id]);
        }
        if (pending.rows.length) {
          await client.query(
            `UPDATE attendance_schedule_versions SET effective_to = NULL
             WHERE id = (SELECT id FROM attendance_schedule_versions WHERE schedule_template_id = $1 ORDER BY version DESC LIMIT 1)`,
            [params.data.scheduleId],
          );
        }
        const previous = await client.query<{ version: number }>(
          `UPDATE attendance_schedule_versions
           SET effective_to = $2
           WHERE schedule_template_id = $1 AND effective_to IS NULL
           RETURNING version`,
          [params.data.scheduleId, effectiveAt],
        );
        const affected = await client.query<{ count: number }>(
          `SELECT count(DISTINCT employee_id)::int AS count FROM attendance_schedule_assignments
           WHERE schedule_template_id = $1 AND (effective_to IS NULL OR effective_to >= ($2::timestamptz AT TIME ZONE 'Asia/Jakarta')::date)`,
          [params.data.scheduleId, effectiveAt],
        );
        affectedEmployees = affected.rows[0]?.count ?? 0;
        versionNumber = (previous.rows[0]?.version ?? 0) + 1;
        versionId = randomUUID();
        await client.query(
          `INSERT INTO attendance_schedule_versions (
             id, schedule_template_id, version, name, start_time, end_time, end_day_offset,
             late_grace_minutes, early_leave_tolerance_minutes, work_location_id,
             effective_from, created_by_account_id
           ) VALUES ($1, $2, $3, $4, $5::time, $6::time, $7, $8, $9, $10, $11, $12)`,
          [
            versionId, params.data.scheduleId, versionNumber, next.name, next.startTime, next.endTime,
            next.endDayOffset, next.lateGraceMinutes, next.earlyLeaveToleranceMinutes,
            next.workLocationId ?? null, effectiveAt, principal.id,
          ],
        );
        await writeVersionBlocks(client, versionId, blocks, firstWeight);
      }

      await insertAudit(client, principal.id, body.data.active === false && item.active ? "attendance.schedule.deactivated" : "attendance.schedule.updated",
        "attendance_schedule_template", params.data.scheduleId, {
          fields: Object.keys(body.data), versionId, version: versionNumber,
          effectiveFrom: semanticChanged ? (body.data.effectiveFrom ?? today) : null, affectedEmployees,
          ...(replacedVersionIds.length ? { replacedVersionIds } : {}),
        });
      await client.query("COMMIT");
      return reply.send({ id: params.data.scheduleId, versionId, version: versionNumber, effectiveFrom: semanticChanged ? (body.data.effectiveFrom ?? today) : null, affectedEmployees });
    } catch (error) {
      await client.query("ROLLBACK");
      return sendError(reply, error);
    } finally {
      client.release();
    }
  });

  app.post("/admin/attendance/schedules", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.schedule.manage");
    if (!principal) return;
    const body = scheduleTemplateSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ code: "INVALID_SCHEDULE_TEMPLATE", message: "Template jadwal tidak valid." });
    if (body.data.effectiveFrom && body.data.effectiveFrom > jakartaWorkDate()) {
      return reply.status(422).send({ code: "SCHEDULE_EFFECTIVE_FROM_IN_FUTURE", message: "Tanggal berlaku shift tidak boleh di masa depan." });
    }
    const id = randomUUID();
    const versionId = randomUUID();
    const endDayOffset = body.data.endDayOffset ?? (body.data.endTime <= body.data.startTime ? 1 : 0);
    const blocksError = scheduleBlocksError({
      startTime: body.data.startTime, endTime: body.data.endTime, endDayOffset, workdayWeight: body.data.firstBlockWorkdayWeight ?? null,
    }, body.data.extraBlocks);
    if (blocksError) return reply.status(422).send({ code: "SCHEDULE_BLOCKS_INVALID", message: blocksError });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO attendance_schedule_templates (
           id, name, start_time, end_time, end_day_offset, late_grace_minutes,
           early_leave_tolerance_minutes, work_location_id, created_by_account_id
         ) VALUES ($1, $2, $3::time, $4::time, $5, $6, $7, $8, $9)`,
        [
          id, body.data.name, body.data.startTime, body.data.endTime, endDayOffset,
          body.data.lateGraceMinutes, body.data.earlyLeaveToleranceMinutes,
          body.data.workLocationId ?? null, principal.id,
        ],
      );
      await client.query(
        `INSERT INTO attendance_schedule_versions (
           id, schedule_template_id, version, name, start_time, end_time, end_day_offset,
           late_grace_minutes, early_leave_tolerance_minutes, work_location_id, created_by_account_id,
           effective_from
         ) VALUES ($1, $2, 1, $3, $4::time, $5::time, $6, $7, $8, $9, $10,
           coalesce(($11::date::timestamp AT TIME ZONE 'Asia/Jakarta'), now()))`,
        [
          versionId, id, body.data.name, body.data.startTime, body.data.endTime, endDayOffset,
          body.data.lateGraceMinutes, body.data.earlyLeaveToleranceMinutes,
          body.data.workLocationId ?? null, principal.id, body.data.effectiveFrom ?? null,
        ],
      );
      await writeVersionBlocks(client, versionId, body.data.extraBlocks, body.data.firstBlockWorkdayWeight ?? null);
      await insertAudit(client, principal.id, "attendance.schedule.created", "attendance_schedule_template", id, {
        versionId, version: 1, effectiveFrom: body.data.effectiveFrom ?? null, extraBlocks: body.data.extraBlocks,
      });
      await client.query("COMMIT");
      return reply.status(201).send({ id, versionId, version: 1 });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });


  // ATT-014 §20.10 "Mundurkan awal berlaku": moves the start of a shift's first version earlier, so
  // schedule patterns on earlier dates resolve to this shift. Only the first version, only earlier,
  // never in the future; the previous start is kept in the audit event for recovery.
  app.post("/admin/attendance/schedules/:scheduleId/backdate", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.schedule.manage");
    if (!principal) return;
    const params = z.object({ scheduleId: z.string().uuid() }).safeParse(request.params);
    const body = scheduleBackdateSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ code: "INVALID_SCHEDULE_BACKDATE", message: "Tanggal dan alasan wajib diisi." });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const first = await client.query<{ id: string; effectiveFrom: Date; effectiveTo: Date | null }>(
        `SELECT id, effective_from AS "effectiveFrom", effective_to AS "effectiveTo"
         FROM attendance_schedule_versions
         WHERE schedule_template_id = $1
         ORDER BY version
         LIMIT 1
         FOR UPDATE`,
        [params.data.scheduleId],
      );
      const version = first.rows[0];
      if (!version) throw new WorkforceAttendanceError(404, "SCHEDULE_NOT_FOUND", "Shift tidak ditemukan.");
      const target = await client.query<{ at: Date }>(
        "SELECT ($1::date::timestamp AT TIME ZONE 'Asia/Jakarta') AS at",
        [body.data.effectiveFrom],
      );
      const newFrom = target.rows[0]!.at;
      if (new Date(newFrom) >= new Date(version.effectiveFrom)) {
        throw new WorkforceAttendanceError(409, "SCHEDULE_BACKDATE_NOT_EARLIER", "Tanggal baru harus lebih awal dari awal berlaku sekarang.");
      }
      await client.query(
        "UPDATE attendance_schedule_versions SET effective_from = $2 WHERE id = $1",
        [version.id, newFrom],
      );
      await insertAudit(client, principal.id, "attendance.schedule.backdated", "attendance_schedule_template", params.data.scheduleId, {
        versionId: version.id,
        previousEffectiveFrom: new Date(version.effectiveFrom).toISOString(),
        effectiveFrom: new Date(newFrom).toISOString(),
        reason: body.data.reason,
      });
      await client.query("COMMIT");
      return reply.send({ id: params.data.scheduleId, versionId: version.id, effectiveFrom: new Date(newFrom).toISOString() });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      return sendError(reply, error);
    } finally {
      client.release();
    }
  });

  app.get("/admin/attendance/schedule-assignments", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.schedule.manage");
    if (!principal) return;
    const result = await pool.query(
      `SELECT assignment.id,
         employee.id AS "employeeId", employee.employee_number AS "employeeNumber",
         employee.full_name AS "employeeName", unit.name AS "unitName",
         schedule.id AS "scheduleTemplateId", coalesce(version.name, schedule.name) AS "scheduleName",
         assignment.weekday_mask AS "weekdayMask",
         assignment.effective_from::text AS "effectiveFrom",
         assignment.effective_to::text AS "effectiveTo",
         assignment.created_at AS "createdAt"
       FROM attendance_schedule_assignments assignment
       JOIN employees employee ON employee.id = assignment.employee_id
       JOIN attendance_schedule_templates schedule ON schedule.id = assignment.schedule_template_id
       LEFT JOIN LATERAL (
         SELECT candidate.* FROM attendance_schedule_versions candidate
         WHERE candidate.schedule_template_id = schedule.id AND candidate.effective_from <= now()
           AND (candidate.effective_to IS NULL OR candidate.effective_to > now())
         ORDER BY candidate.version DESC LIMIT 1
       ) version ON true
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
           entry.schedule_version_id AS "scheduleVersionId", entry.is_off AS "isOff", entry.note
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
        `SELECT schedule.id, coalesce(version.name, schedule.name) AS name,
           coalesce(version.start_time, schedule.start_time)::text AS "startTime",
           coalesce(version.end_time, schedule.end_time)::text AS "endTime", schedule.active
         FROM attendance_schedule_templates schedule
         LEFT JOIN LATERAL (
           SELECT candidate.* FROM attendance_schedule_versions candidate
           WHERE candidate.schedule_template_id = schedule.id AND candidate.effective_from <= now()
             AND (candidate.effective_to IS NULL OR candidate.effective_to > now())
           ORDER BY candidate.version DESC LIMIT 1
         ) version ON true
         ORDER BY schedule.active DESC, 2`,
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
         roster_id, employee_id, work_date, schedule_template_id, schedule_version_id, is_off, note
       )
       SELECT $1, entry.employee_id, entry.work_date, entry.schedule_template_id, entry.schedule_version_id, entry.is_off, entry.note
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
             schedule_version_id = NULL,
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
         roster_id, employee_id, work_date, schedule_template_id, schedule_version_id, is_off, note
       )
       SELECT $1, entry.employee_id, (entry.work_date + interval '7 days')::date,
              entry.schedule_template_id, NULL, entry.is_off, entry.note
       FROM attendance_roster_entries entry
       JOIN source_roster source ON source.id = entry.roster_id
       ON CONFLICT (roster_id, employee_id, work_date) DO UPDATE SET
         schedule_template_id = EXCLUDED.schedule_template_id,
         schedule_version_id = NULL,
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
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const roster = await client.query<{ id: string }>(
        `SELECT id FROM attendance_rosters WHERE id = $1 AND status = 'DRAFT' FOR UPDATE`,
        [params.data.rosterId],
      );
      if (!roster.rows[0]) throw new WorkforceAttendanceError(409, "ROSTER_NOT_DRAFT", "Roster tidak dapat dipublikasikan.");

      await client.query(
        `UPDATE attendance_roster_entries entry
         SET schedule_version_id = version.id
         FROM attendance_schedule_versions version
         WHERE entry.roster_id = $1
           AND entry.is_off = false
           AND entry.schedule_version_id IS NULL
           AND version.schedule_template_id = entry.schedule_template_id
           AND version.effective_from <= ((entry.work_date + time '12:00') AT TIME ZONE 'Asia/Jakarta')
           AND (version.effective_to IS NULL OR version.effective_to > ((entry.work_date + time '12:00') AT TIME ZONE 'Asia/Jakarta'))`,
        [params.data.rosterId],
      );
      const unresolved = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM attendance_roster_entries
         WHERE roster_id = $1
           AND is_off = false
           AND schedule_version_id IS NULL`,
        [params.data.rosterId],
      );
      if ((unresolved.rows[0]?.count ?? 0) > 0) {
        throw new WorkforceAttendanceError(
          409,
          "ROSTER_SCHEDULE_VERSION_UNRESOLVED",
          "Ada jadwal roster yang belum memiliki versi aktif.",
        );
      }

      await client.query(
        `UPDATE attendance_rosters
         SET status = 'PUBLISHED', published_by_account_id = $2, published_at = now(), updated_at = now()
         WHERE id = $1`,
        [params.data.rosterId, principal.id],
      );
      await insertAudit(client, principal.id, "attendance.roster.published", "attendance_roster", params.data.rosterId, {
        scheduleVersionsPinned: true,
      });
      await client.query("COMMIT");
      return reply.send({ id: params.data.rosterId, status: "PUBLISHED" });
    } catch (error) {
      await client.query("ROLLBACK");
      return sendError(reply, error);
    } finally {
      client.release();
    }
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
      clauses.push(`(evidence.created_at AT TIME ZONE 'Asia/Jakarta')::date = $${values.length}::date`);
    }
    if (query.data.reviewState !== "all") {
      values.push(query.data.reviewState);
      clauses.push(`evidence.review_state = $${values.length}`);
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

  app.get("/attendance/overtime/me", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "EMPLOYEE");
    if (!principal) return;
    try {
      const employee = await employeeForAccount(pool, principal.id);
      const rows = await pool.query(
        `SELECT id, work_date::text AS "workDate", requested_minutes AS "requestedMinutes",
           approved_minutes AS "approvedMinutes", note, status, decision_note AS "decisionNote",
           created_at AS "createdAt", decided_at AS "decidedAt"
         FROM attendance_overtime_requests
         WHERE employee_id = $1
         ORDER BY work_date DESC, created_at DESC
         LIMIT 100`,
        [employee.id],
      );
      reply.header("Cache-Control", "no-store");
      return reply.send({ items: rows.rows });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/attendance/overtime", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "EMPLOYEE");
    if (!principal) return;
    const body = overtimeInputSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ code: "INVALID_OVERTIME_REQUEST", message: "Pengajuan lembur tidak valid." });
    try {
      const employee = await employeeForAccount(pool, principal.id);
      const id = randomUUID();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`overtime:${employee.id}:${body.data.workDate}`]);
        await assertOvertimeDayTotal(client, employee.id, body.data.workDate, body.data.requestedMinutes);
        await client.query(
          `INSERT INTO attendance_overtime_requests (
             id, employee_id, work_date, requested_minutes, note, requested_by_account_id
           ) VALUES ($1, $2, $3::date, $4, $5, $6)`,
          [id, employee.id, body.data.workDate, body.data.requestedMinutes, body.data.note ?? null, principal.id],
        );
        await insertAudit(client, principal.id, "attendance.overtime.submitted", "attendance_overtime_request", id, {
          workDate: body.data.workDate, requestedMinutes: body.data.requestedMinutes, initiatedBy: "employee",
        });
        await client.query(
          `INSERT INTO attendance_overtime_events (
             id, overtime_request_id, actor_account_id, event_type, payload
           ) VALUES ($1, $2, $3, 'submitted', $4::jsonb)`,
          [randomUUID(), id, principal.id, JSON.stringify({ requestedMinutes: body.data.requestedMinutes })],
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

  app.post("/attendance/overtime/:overtimeId/cancel", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "EMPLOYEE");
    if (!principal) return;
    const params = z.object({ overtimeId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: "INVALID_OVERTIME_REQUEST", message: "Pengajuan lembur tidak valid." });
    try {
      const employee = await employeeForAccount(pool, principal.id);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const changed = await client.query(
          `UPDATE attendance_overtime_requests
           SET status = 'cancelled', updated_at = now()
           WHERE id = $1 AND employee_id = $2 AND status = 'submitted'
           RETURNING id`,
          [params.data.overtimeId, employee.id],
        );
        if (!changed.rows[0]) throw new WorkforceAttendanceError(409, "OVERTIME_NOT_CANCELLABLE", "Pengajuan lembur tidak dapat dibatalkan.");
        await insertAudit(client, principal.id, "attendance.overtime.cancelled", "attendance_overtime_request", params.data.overtimeId, {});
        await client.query(
          `INSERT INTO attendance_overtime_events (
             id, overtime_request_id, actor_account_id, event_type, payload
           ) VALUES ($1, $2, $3, 'cancelled', '{}'::jsonb)`,
          [randomUUID(), params.data.overtimeId, principal.id],
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

  // ATT-011-6a §7.4: HC monitors overtime. Each row carries the kind of day of the stored result and the
  // scan time outside the schedule, as information only: it never fills overtime minutes (I-7).
  app.get("/admin/attendance/overtime", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.overtime.manage");
    if (!principal) return;
    const query = pageQuerySchema.extend({
      status: z.enum(["all", "submitted", "approved", "rejected", "cancelled", "closed"]).default("submitted"),
      unitId: z.string().uuid().optional(),
    }).safeParse(request.query);
    if (!query.success) return reply.status(400).send({ code: "INVALID_OVERTIME_FILTER", message: "Filter lembur tidak valid." });
    const statuses = query.data.status === "all" ? null
      : query.data.status === "closed" ? ["rejected", "cancelled"] : [query.data.status];
    reply.header("Cache-Control", "no-store");
    return reply.send(await listOvertimeForHc(pool, {
      page: query.data.page, pageSize: query.data.pageSize, statuses, unitId: query.data.unitId ?? null,
    }));
  });

  app.post("/admin/attendance/overtime", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.overtime.manage");
    if (!principal) return;
    const body = adminOvertimeInputSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ code: "INVALID_OVERTIME_REQUEST", message: "Pengajuan lembur tidak valid." });
    const employee = await pool.query<{ id: string }>("SELECT id FROM employees WHERE id = $1 AND status = 'active'", [body.data.employeeId]);
    if (!employee.rows[0]) return reply.status(404).send({ code: "EMPLOYEE_NOT_FOUND", message: "Pegawai aktif tidak ditemukan." });
    const id = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`overtime:${body.data.employeeId}:${body.data.workDate}`]);
      await assertOvertimeDayTotal(client, body.data.employeeId, body.data.workDate, body.data.requestedMinutes);
      await client.query(
        `INSERT INTO attendance_overtime_requests (
           id, employee_id, work_date, requested_minutes, note, requested_by_account_id
         ) VALUES ($1, $2, $3::date, $4, $5, $6)`,
        [id, body.data.employeeId, body.data.workDate, body.data.requestedMinutes, body.data.note ?? null, principal.id],
      );
      await insertAudit(client, principal.id, "attendance.overtime.submitted", "attendance_overtime_request", id, {
        workDate: body.data.workDate, requestedMinutes: body.data.requestedMinutes, initiatedBy: "hc",
      });
      await client.query(
        `INSERT INTO attendance_overtime_events (
           id, overtime_request_id, actor_account_id, event_type, payload
         ) VALUES ($1, $2, $3, 'submitted', $4::jsonb)`,
        [randomUUID(), id, principal.id, JSON.stringify({ requestedMinutes: body.data.requestedMinutes, createdByHc: true })],
      );
      await client.query("COMMIT");
      return reply.status(201).send({ id, status: "submitted" });
    } catch (error) {
      await client.query("ROLLBACK");
      return sendError(reply, error);
    } finally {
      client.release();
    }
  });

  app.post("/admin/attendance/overtime/:overtimeId/decision", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.overtime.manage");
    if (!principal) return;
    const params = z.object({ overtimeId: z.string().uuid() }).safeParse(request.params);
    const body = overtimeDecisionSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ code: "INVALID_OVERTIME_DECISION", message: "Keputusan lembur tidak valid." });
    const client = await pool.connect();
    let employeeId = "";
    let workDate = "";
    try {
      await client.query("BEGIN");
      const current = await client.query<{ employeeId: string; workDate: string; requestedMinutes: number }>(
        `SELECT employee_id AS "employeeId", work_date::text AS "workDate",
           requested_minutes AS "requestedMinutes"
         FROM attendance_overtime_requests
         WHERE id = $1 AND status = 'submitted'
         FOR UPDATE`,
        [params.data.overtimeId],
      );
      const item = current.rows[0];
      if (!item) throw new WorkforceAttendanceError(409, "OVERTIME_ALREADY_DECIDED", "Pengajuan lembur sudah diputuskan.");
      employeeId = item.employeeId;
      workDate = item.workDate;
      const approvedMinutes = body.data.decision === "approve"
        ? (body.data.approvedMinutes ?? item.requestedMinutes)
        : null;
      if (approvedMinutes !== null && approvedMinutes > item.requestedMinutes) {
        throw new WorkforceAttendanceError(400, "OVERTIME_APPROVED_EXCEEDS_REQUEST", "Menit lembur disetujui tidak boleh melebihi pengajuan.");
      }
      if (approvedMinutes !== null) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`overtime:${item.employeeId}:${item.workDate}`]);
        await assertOvertimeDayTotal(client, item.employeeId, item.workDate, approvedMinutes, params.data.overtimeId);
      }
      const status = body.data.decision === "approve" ? "approved" : "rejected";
      await insertAudit(client, principal.id, `attendance.overtime.${status}`, "attendance_overtime_request", params.data.overtimeId, {
        workDate: item.workDate, requestedMinutes: item.requestedMinutes, approvedMinutes,
      });
      await client.query(
        `UPDATE attendance_overtime_requests
         SET status = $2, approved_minutes = $3, decided_by_account_id = $4,
             decision_note = $5, decided_at = now(), updated_at = now()
         WHERE id = $1`,
        [params.data.overtimeId, status, approvedMinutes, principal.id, body.data.note ?? null],
      );
      await client.query(
        `INSERT INTO attendance_overtime_events (
           id, overtime_request_id, actor_account_id, event_type, payload
         ) VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [randomUUID(), params.data.overtimeId, principal.id, status, JSON.stringify({ approvedMinutes, note: body.data.note ?? null })],
      );
      await notifyEmployee(client, item.employeeId, {
        eventKey: `overtime:${params.data.overtimeId}:${status}`,
        category: "attendance",
        title: status === "approved" ? "Lembur disetujui" : "Lembur ditolak",
        body: status === "approved"
          ? `Pengajuan lembur ${item.workDate} disetujui ${approvedMinutes ?? 0} menit.`
          : `Pengajuan lembur ${item.workDate} ditolak.`,
        href: "/app/attendance",
        actorAccountId: principal.id,
        metadata: { overtimeId: params.data.overtimeId, workDate: item.workDate, status },
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      return sendError(reply, error);
    } finally {
      client.release();
    }
    const result = await materializeAttendanceResult(pool, employeeId, workDate);
    return reply.send({ id: params.data.overtimeId, status: body.data.decision === "approve" ? "approved" : "rejected", result: mapResult(result as unknown as Record<string, unknown>) });
  });

  app.post("/admin/attendance/manual-corrections", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.records.manage");
    if (!principal) return;
    const body = manualCorrectionSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ code: "INVALID_MANUAL_CORRECTION", message: "Koreksi manual tidak valid." });
    const windowError = manualCorrectionWindowError(body.data);
    if (windowError) return reply.status(422).send({ code: windowError, message: manualCorrectionWindowMessages[windowError] });
    const employee = await pool.query<{ id: string }>("SELECT id FROM employees WHERE id = $1 AND status = 'active'", [body.data.employeeId]);
    if (!employee.rows[0]) return reply.status(404).send({ code: "EMPLOYEE_NOT_FOUND", message: "Pegawai aktif tidak ditemukan." });
    const clarificationId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO attendance_clarifications (
           id, employee_id, work_date, kind, mode, reason,
           proposed_check_in_at, proposed_check_out_at, status,
           decided_by_account_id, decision_note, decided_at
         ) VALUES (
           $1, $2, $3::date, 'other', 'correction', $4, $5, $6,
           'approved', $7, 'Koreksi manual oleh administrator', now()
         )`,
        [
          clarificationId, body.data.employeeId, body.data.workDate, body.data.reason,
          body.data.checkInAt, body.data.checkOutAt, principal.id,
        ],
      );
      await client.query(
        `INSERT INTO attendance_clarification_events (
           id, clarification_id, actor_account_id, event_type, payload
         ) VALUES
           ($1, $3, $4, 'submitted', $5::jsonb),
           ($2, $3, $4, 'approved', $5::jsonb)`,
        [
          randomUUID(), randomUUID(), clarificationId, principal.id,
          JSON.stringify({ administrativeCorrection: true, reason: body.data.reason }),
        ],
      );
      await insertAudit(client, principal.id, "attendance.manual_correction.approved", "attendance_clarification", clarificationId, {
        employeeId: body.data.employeeId, workDate: body.data.workDate,
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const result = await materializeAttendanceResult(pool, body.data.employeeId, body.data.workDate);
    return reply.status(201).send({ clarificationId, result: mapResult(result as unknown as Record<string, unknown>) });
  });

  app.get("/admin/attendance/daily", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.reports.read");
    if (!principal) return;
    const query = z.object({
      date: dateSchema,
      employeeId: z.string().uuid().optional(),
      unitId: z.string().uuid().optional(),
    }).safeParse(request.query);
    if (!query.success) return reply.status(400).send({ code: "INVALID_ATTENDANCE_DAILY_QUERY", message: "Tanggal/filter tidak valid." });
    const items = await attendanceDailyReadModel(pool, query.data.date, {
      ...(query.data.employeeId ? { employeeId: query.data.employeeId } : {}),
      ...(query.data.unitId ? { unitId: query.data.unitId } : {}),
    });
    const summary = items.reduce<Record<string, number>>((accumulator, item) => {
      accumulator[item.status] = (accumulator[item.status] ?? 0) + 1;
      return accumulator;
    }, {});
    reply.header("Cache-Control", "no-store");
    return reply.send({ date: query.data.date, summary, items });
  });

  // ATT-014-1 Pantauan Hari Ini: today's scan facts only; never writes results, never a verdict.
  app.get("/admin/attendance/today", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.reports.read");
    if (!principal) return;
    const query = z.object({
      employeeId: z.string().uuid().optional(),
      unitId: z.string().uuid().optional(),
    }).safeParse(request.query);
    if (!query.success) return reply.status(400).send({ code: "INVALID_ATTENDANCE_TODAY_QUERY", message: "Filter tidak valid." });
    const result = await attendanceTodayReadModel(pool, {
      ...(query.data.employeeId ? { employeeId: query.data.employeeId } : {}),
      ...(query.data.unitId ? { unitId: query.data.unitId } : {}),
    });
    reply.header("Cache-Control", "no-store");
    return reply.send(result);
  });

  async function queuePosition(run: Pick<CalculationRun, "id" | "status" | "createdAt">) {
    if (run.status !== "queued") return null;
    const result = await pool.query<{ position: number }>(
      `SELECT count(*)::int AS position FROM attendance_calculation_runs
       WHERE status = 'queued' AND (created_at, id) <= ($1::timestamptz, $2::uuid)`,
      [run.createdAt, run.id],
    );
    return result.rows[0]?.position ?? 1;
  }

  async function presentRun(run: CalculationRun) {
    return {
      id: run.id,
      status: run.status,
      position: await queuePosition(run),
      unitId: run.unitId,
      employeeId: run.employeeId,
      from: run.dateFrom,
      to: run.dateTo,
      totalPairs: run.totalPairs,
      processedPairs: run.processedPairs,
      failedPairs: run.failedPairs,
      uncoveredPairs: run.uncoveredPairs,
      cancelRequested: Boolean(run.cancelRequestedAt),
      errorCode: run.errorCode,
      requestedByAccountId: run.requestedByAccountId,
      createdAt: new Date(run.createdAt).toISOString(),
      startedAt: run.startedAt ? new Date(run.startedAt).toISOString() : null,
      finishedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : null,
    };
  }

  const calculationRangeMessages = {
    INVALID_CALCULATION_RANGE: "Rentang tanggal tidak valid.",
    CALCULATION_RANGE_TOO_LARGE: "Satu kalkulasi maksimal 93 hari. Bagi rentang menjadi beberapa kalkulasi.",
    CALCULATION_DATE_IN_FUTURE: "Tanggal di masa depan belum bisa dikalkulasi.",
  } as const;

  async function requestCalculation(
    reply: FastifyReply,
    principal: AuthPrincipal,
    scope: { unitId?: string | undefined; employeeId?: string | undefined; from: string; to: string },
  ) {
    reply.header("Cache-Control", "no-store");
    const rangeError = validateCalculationRange(scope.from, scope.to);
    if (rangeError) {
      return reply.status(rangeError === "INVALID_CALCULATION_RANGE" ? 400 : 422)
        .send({ code: rangeError, message: calculationRangeMessages[rangeError] });
    }
    const id = randomUUID();
    const inserted = await pool.query<CalculationRun>(
      `INSERT INTO attendance_calculation_runs (id, requested_by_account_id, unit_id, employee_id, date_from, date_to, status)
       VALUES ($1, $2, $3, $4, $5::date, $6::date, 'queued')
       RETURNING ${RUN_COLUMNS}`,
      [id, principal.id, scope.unitId ?? null, scope.employeeId ?? null, scope.from, scope.to],
    );
    const run = inserted.rows[0];
    if (!run) throw new Error("Attendance calculation insert did not return a row");
    await insertAudit(pool, principal.id, "attendance.calculation.requested", "attendance_calculation_run", id, {
      unitId: scope.unitId ?? null, employeeId: scope.employeeId ?? null, from: scope.from, to: scope.to,
    });
    calculationRunner.kick();
    return reply.status(202).send(await presentRun(run));
  }

  async function findRun(id: string) {
    const result = await pool.query<CalculationRun>(`SELECT ${RUN_COLUMNS} FROM attendance_calculation_runs WHERE id = $1`, [id]);
    return result.rows[0] ?? null;
  }

  // ATT-014-2 Kalkulasi: queue a calculation for a scope and range (D-14-1 … D-14-4).
  app.post("/admin/attendance/calculations", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.calculation.run");
    if (!principal) return;
    const body = z.object({
      unitId: z.string().uuid().optional(),
      employeeId: z.string().uuid().optional(),
      from: dateSchema,
      to: dateSchema,
    }).strict().safeParse(request.body);
    if (!body.success) {
      reply.header("Cache-Control", "no-store");
      return reply.status(400).send({ code: "INVALID_CALCULATION_RANGE", message: "Lingkup atau rentang tanggal tidak valid." });
    }
    return requestCalculation(reply, principal, body.data);
  });

  app.get("/admin/attendance/calculations/:id", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.reports.read");
    if (!principal) return;
    reply.header("Cache-Control", "no-store");
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const run = params.success ? await findRun(params.data.id) : null;
    if (!run) return reply.status(404).send({ code: "CALCULATION_NOT_FOUND", message: "Kalkulasi tidak ditemukan." });
    return reply.send(await presentRun(run));
  });

  app.post("/admin/attendance/calculations/:id/cancel", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.calculation.run");
    if (!principal) return;
    reply.header("Cache-Control", "no-store");
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const run = params.success ? await findRun(params.data.id) : null;
    if (!run) return reply.status(404).send({ code: "CALCULATION_NOT_FOUND", message: "Kalkulasi tidak ditemukan." });
    if (run.requestedByAccountId !== principal.id) {
      const context = await auth.getAuthorizationContext(principal);
      if (!context.organizationPermissions.includes("attendance.policy.manage")) {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Hanya pemohon atau pengelola kebijakan yang boleh membatalkan kalkulasi ini." });
      }
    }
    // A queued run is cancelled at once; a running run stops at its next progress checkpoint.
    const updated = await pool.query<CalculationRun>(
      `UPDATE attendance_calculation_runs
       SET status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
           finished_at = CASE WHEN status = 'queued' THEN now() ELSE finished_at END,
           cancel_requested_at = coalesce(cancel_requested_at, now())
       WHERE id = $1 AND status IN ('queued', 'running')
       RETURNING ${RUN_COLUMNS}`,
      [run.id],
    );
    const cancelled = updated.rows[0];
    if (!cancelled) return reply.status(409).send({ code: "CALCULATION_ALREADY_FINISHED", message: "Kalkulasi sudah selesai." });
    if (cancelled.status === "cancelled") {
      await insertAudit(pool, principal.id, "attendance.calculation.cancelled", "attendance_calculation_run", run.id, {
        processedPairs: 0, failedPairs: 0, uncoveredPairs: 0, errorCode: null,
      });
    }
    return reply.send(await presentRun(cancelled));
  });

  // Detail rows for Laporan & Kalkulasi (§6.2, §6.5). Reads stored results only; paginated.
  app.get("/admin/attendance/calculation-rows", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.reports.read");
    if (!principal) return;
    reply.header("Cache-Control", "no-store");
    const query = z.object({
      tab: z.enum(["detail"]).default("detail"),
      unitId: z.string().uuid().optional(),
      employeeId: z.string().uuid().optional(),
      from: dateSchema,
      to: dateSchema,
      status: z.enum([
        "scheduled", "pending", "present", "late", "incomplete", "leave", "absent", "off",
        "configuration_error", "unscheduled", "not_captured", "not_calculated",
      ]).optional(),
      changedOnly: z.enum(["true", "false"]).optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(10).max(200).default(50),
    }).safeParse(request.query);
    if (!query.success) return reply.status(400).send({ code: "INVALID_CALCULATION_ROWS_QUERY", message: "Filter tidak valid." });
    const rangeError = validateCalculationRange(query.data.from, query.data.to);
    if (rangeError) {
      return reply.status(rangeError === "INVALID_CALCULATION_RANGE" ? 400 : 422)
        .send({ code: rangeError, message: calculationRangeMessages[rangeError] });
    }
    const result = await attendanceCalculationRows(
      pool,
      { unitId: query.data.unitId ?? null, employeeId: query.data.employeeId ?? null, from: query.data.from, to: query.data.to },
      {
        ...(query.data.status ? { status: query.data.status } : {}),
        changedOnly: query.data.changedOnly === "true",
        page: query.data.page,
        pageSize: query.data.pageSize,
      },
    );
    return reply.send(result);
  });

  // ATT-014 §20.3 Tanpa Jadwal (R2a): who scans without a schedule, and which machine scans cannot be
  // attributed to an employee yet. Read-only; the PIN part only for attendance.devices.read.
  app.get("/admin/attendance/unscheduled", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.reports.read");
    if (!principal) return;
    reply.header("Cache-Control", "no-store");
    const query = z.object({
      unitId: z.string().uuid().optional(),
      employeeId: z.string().uuid().optional(),
      from: dateSchema,
      to: dateSchema,
      page: z.coerce.number().int().min(1).default(1),
      pinPage: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(10).max(200).default(50),
    }).safeParse(request.query);
    if (!query.success) return reply.status(400).send({ code: "INVALID_UNSCHEDULED_QUERY", message: "Filter tidak valid." });
    const rangeError = validateCalculationRange(query.data.from, query.data.to);
    if (rangeError) {
      return reply.status(rangeError === "INVALID_CALCULATION_RANGE" ? 400 : 422)
        .send({ code: rangeError, message: calculationRangeMessages[rangeError] });
    }
    const scope = {
      from: query.data.from, to: query.data.to,
      unitId: query.data.unitId ?? null, employeeId: query.data.employeeId ?? null,
      pageSize: query.data.pageSize,
    };
    const canSeePins = (await auth.getAuthorizationContext(principal)).organizationPermissions.includes("attendance.devices.read");
    const [employees, pins] = await Promise.all([
      unscheduledEmployees(pool, { ...scope, page: query.data.page }),
      canSeePins ? unattributedPins(pool, { ...scope, page: query.data.pinPage }) : Promise.resolve(null),
    ]);
    return reply.send({ from: scope.from, to: scope.to, employees, pins });
  });

  // ATT-011-3 §6.1 "Perlu tindakan": one queue of what waits for HC, filtered to the kinds this account
  // can act on. Read-only; the actions use their own endpoints and permissions.
  app.get("/admin/attendance/action-queue", async (request, reply) => {
    let held: AdminPermission[];
    try {
      ({ permissions: held } = await requireAnyPermissionFromCookie(auth, request.headers.cookie, ACTION_QUEUE_PERMISSIONS));
    } catch (error) {
      if (error instanceof AuthError) {
        reply.header("Cache-Control", "no-store");
        return reply.status(error.statusCode).send({ code: error.code, message: error.message });
      }
      throw error;
    }
    reply.header("Cache-Control", "no-store");
    const today = jakartaWorkDate();
    const query = pageQuerySchema.extend({
      unitId: z.string().uuid().optional(),
      kind: z.enum(["clarification", "mobile_review", "incomplete", "configuration_error"]).optional(),
      from: dateSchema.optional(),
      to: dateSchema.optional(),
    }).safeParse(request.query);
    if (!query.success) return reply.status(400).send({ code: "INVALID_ACTION_QUEUE_QUERY", message: "Filter tidak valid." });
    // Default: the last 31 days up to today.
    const to = query.data.to ?? today;
    const from = query.data.from ?? shiftDateText(to, -30);
    const rangeError = validateCalculationRange(from, to);
    if (rangeError) {
      return reply.status(rangeError === "INVALID_CALCULATION_RANGE" ? 400 : 422)
        .send({ code: rangeError, message: calculationRangeMessages[rangeError] });
    }
    return reply.send(await attendanceActionQueue(pool, {
      page: query.data.page,
      pageSize: query.data.pageSize,
      from,
      to,
      incompleteBefore: shiftDateText(today, -2),
      unitId: query.data.unitId ?? null,
      kind: (query.data.kind ?? null) as ActionKind | null,
      kinds: allowedActionKinds(held),
    }));
  });

  // ATT-011-3 §6.2 detail of one employee-day: schedule, stored result, every punch, and the requests that
  // touch it. Photos stay behind the evidence endpoint; GPS only with attendance.clarification.manage.
  app.get("/admin/attendance/daily/:employeeId/:workDate", async (request, reply) => {
    let held: AdminPermission[];
    try {
      ({ permissions: held } = await requireAnyPermissionFromCookie(auth, request.headers.cookie, [
        "attendance.reports.read", "attendance.records.manage", "attendance.clarification.manage",
      ]));
    } catch (error) {
      if (error instanceof AuthError) {
        reply.header("Cache-Control", "no-store");
        return reply.status(error.statusCode).send({ code: error.code, message: error.message });
      }
      throw error;
    }
    reply.header("Cache-Control", "no-store");
    const params = z.object({ employeeId: z.string().uuid(), workDate: dateSchema }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: "INVALID_ATTENDANCE_DAY", message: "Pegawai atau tanggal tidak valid." });
    const { employeeId, workDate } = params.data;
    const employee = await pool.query<{ id: string; employeeNumber: string; fullName: string; unitName: string | null }>(
      `SELECT employee.id, employee.employee_number AS "employeeNumber", employee.full_name AS "fullName", unit.name AS "unitName"
       FROM employees employee LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
       WHERE employee.id = $1`,
      [employeeId],
    );
    if (!employee.rows[0]) return reply.status(404).send({ code: "EMPLOYEE_NOT_FOUND", message: "Pegawai tidak ditemukan." });
    const [schedule, result, punches, clarifications, leave, overtime] = await Promise.all([
      resolveSchedule(pool, employeeId, workDate),
      latestResult(pool, employeeId, workDate),
      // The next day too: a shift that ends after midnight has its check-out there.
      attendanceTransactions(pool, {
        employeeId, from: workDate, to: shiftDateText(workDate, 1), page: 1, pageSize: 200,
        includeEvidence: held.includes("attendance.clarification.manage"),
      }),
      pool.query(
        `SELECT id, kind, mode, status, reason, decision_note AS "decisionNote",
           proposed_check_in_at AS "proposedCheckInAt", proposed_check_out_at AS "proposedCheckOutAt", created_at AS "createdAt"
         FROM attendance_clarifications WHERE employee_id = $1 AND work_date = $2::date ORDER BY created_at`,
        [employeeId, workDate],
      ),
      pool.query<{ id: string; policyKey: string; startOn: string; endOn: string }>(
        `SELECT id, policy_key AS "policyKey", start_on::text AS "startOn", end_on::text AS "endOn"
         FROM leave_requests WHERE employee_id = $1 AND status = 'approved' AND $2::date BETWEEN start_on AND end_on`,
        [employeeId, workDate],
      ),
      pool.query(
        `SELECT id, status, requested_minutes AS "requestedMinutes", approved_minutes AS "approvedMinutes", note
         FROM attendance_overtime_requests WHERE employee_id = $1 AND work_date = $2::date ORDER BY created_at`,
        [employeeId, workDate],
      ),
    ]);
    const template = schedule.scheduleVersionId
      ? (await pool.query<{ name: string }>("SELECT name FROM attendance_schedule_versions WHERE id = $1", [schedule.scheduleVersionId])).rows[0]?.name ?? null
      : null;
    const { sessions, ...stored } = (result ?? { sessions: [] }) as Record<string, unknown> & { sessions?: Array<Record<string, unknown>> };
    return reply.send({
      employee: employee.rows[0],
      workDate,
      schedule: { ...scheduleResponse(schedule), name: template },
      // source_summary is technical provenance (ATT-011-1 removed it from screens).
      result: result ? { ...stored, sessions: (sessions ?? []).map(({ sourceSummary, ...session }) => { void sourceSummary; return session; }) } : null,
      // Punches of the work date, plus next-day punches up to 6 hours after a shift's end (engine window).
      punches: punches.items.filter((punch) => punch.workDate === workDate || (
        schedule.scheduledEndAt !== null
          && new Date(punch.occurredAt).getTime() <= schedule.scheduledEndAt.getTime() + 6 * 60 * 60_000
          && shiftDateText(workDate, 1) === punch.workDate
          && schedule.scheduledEndAt.getTime() > new Date(`${shiftDateText(workDate, 1)}T00:00:00+07:00`).getTime()
      )),
      clarifications: clarifications.rows.map((row: Record<string, unknown>) => ({
        ...row,
        proposedCheckInAt: row.proposedCheckInAt instanceof Date ? row.proposedCheckInAt.toISOString() : null,
        proposedCheckOutAt: row.proposedCheckOutAt instanceof Date ? row.proposedCheckOutAt.toISOString() : null,
        createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
      })),
      leave: leave.rows.map((row) => ({ ...row, name: LEAVE_POLICY_CATALOG.find((policy) => policy.key === row.policyKey)?.name ?? row.policyKey })),
      overtime: overtime.rows,
    });
  });

  // ATT-011-3 §6.1 "Minta pegawai klarifikasi": an in-app notification to the employee, audited. Asking
  // twice for the same day sends nothing new (the notification key is per employee and date).
  app.post("/admin/attendance/daily/:employeeId/:workDate/request-clarification", async (request, reply) => {
    let principal: AuthPrincipal;
    try {
      ({ principal } = await requireAnyPermissionFromCookie(auth, request.headers.cookie, ["attendance.clarification.manage", "attendance.records.manage"]));
    } catch (error) {
      if (error instanceof AuthError) {
        reply.header("Cache-Control", "no-store");
        return reply.status(error.statusCode).send({ code: error.code, message: error.message });
      }
      throw error;
    }
    const params = z.object({ employeeId: z.string().uuid(), workDate: dateSchema }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: "INVALID_ATTENDANCE_DAY", message: "Pegawai atau tanggal tidak valid." });
    const { employeeId, workDate } = params.data;
    const known = await pool.query("SELECT 1 FROM employees WHERE id = $1", [employeeId]);
    if (!known.rows[0]) return reply.status(404).send({ code: "EMPLOYEE_NOT_FOUND", message: "Pegawai tidak ditemukan." });
    if (!clarificationDateAllowed(workDate)) {
      return reply.status(422).send({
        code: "CLARIFICATION_DATE_OUT_OF_RANGE",
        message: `Pegawai hanya dapat mengajukan klarifikasi untuk hari ini dan ${CLARIFICATION_LOOKBACK_DAYS} hari sebelumnya. Gunakan Perbaiki jam.`,
      });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const notified = await notifyEmployee(client, employeeId, {
        eventKey: `clarification-request:${employeeId}:${workDate}`,
        category: "attendance",
        title: "Mohon ajukan klarifikasi kehadiran",
        body: `Human Capital meminta klarifikasi untuk kehadiran ${workDate}. Ajukan dari Kehadiran Saya → Riwayat.`,
        href: "/app/attendance#clarifications",
        actorAccountId: principal.id,
        metadata: { workDate },
      });
      await insertAudit(client, principal.id, "attendance.clarification.requested", "employee", employeeId, { workDate });
      await client.query("COMMIT");
      reply.header("Cache-Control", "no-store");
      return reply.send({ notified });
    } catch (error) {
      await client.query("ROLLBACK");
      return sendError(reply, error);
    } finally {
      client.release();
    }
  });

  // ATT-014 §20.2 tab "Pengecualian" (R2b): approved leave and clarifications/corrections in the range.
  app.get("/admin/attendance/exceptions", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.reports.read");
    if (!principal) return;
    reply.header("Cache-Control", "no-store");
    const query = pageQuerySchema.extend({
      unitId: z.string().uuid().optional(),
      employeeId: z.string().uuid().optional(),
      from: dateSchema,
      to: dateSchema,
    }).safeParse(request.query);
    if (!query.success) return reply.status(400).send({ code: "INVALID_EXCEPTIONS_QUERY", message: "Filter tidak valid." });
    const rangeError = validateCalculationRange(query.data.from, query.data.to);
    if (rangeError) {
      return reply.status(rangeError === "INVALID_CALCULATION_RANGE" ? 400 : 422)
        .send({ code: rangeError, message: calculationRangeMessages[rangeError] });
    }
    return reply.send(await attendanceExceptions(pool, { ...query.data, unitId: query.data.unitId ?? null, employeeId: query.data.employeeId ?? null }));
  });

  // ATT-014 §19.1 step ③ Data Transaksi: every punch in scope, read-only and paginated.
  app.get("/admin/attendance/transactions", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.reports.read");
    if (!principal) return;
    reply.header("Cache-Control", "no-store");
    const query = z.object({
      unitId: z.string().uuid().optional(),
      employeeId: z.string().uuid().optional(),
      from: dateSchema,
      to: dateSchema,
      source: z.enum(["adms", "mobile", "manual", "correction"]).optional(),
      reviewState: z.enum(["needs_review"]).optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(10).max(200).default(50),
    }).safeParse(request.query);
    if (!query.success) return reply.status(400).send({ code: "INVALID_TRANSACTIONS_QUERY", message: "Filter tidak valid." });
    const rangeError = validateCalculationRange(query.data.from, query.data.to);
    if (rangeError) {
      return reply.status(rangeError === "INVALID_CALCULATION_RANGE" ? 400 : 422)
        .send({ code: rangeError, message: calculationRangeMessages[rangeError] });
    }
    return reply.send(await attendanceTransactions(pool, {
      from: query.data.from,
      to: query.data.to,
      unitId: query.data.unitId ?? null,
      employeeId: query.data.employeeId ?? null,
      source: query.data.source ?? null,
      reviewState: query.data.reviewState ?? null,
      // ATT-006: GPS and the photo handle only for accounts that may review mobile evidence.
      includeEvidence: (await auth.getAuthorizationContext(principal)).organizationPermissions.includes("attendance.clarification.manage"),
      page: query.data.page,
      pageSize: query.data.pageSize,
    }));
  });

  // ATT-014 §7/§19.2 report models from stored results: preview (json), print document (json,
  // purpose=print), CSV and XLSX. Every print and export is audited without personal data.
  app.get("/admin/attendance/reports/:model", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.reports.read");
    if (!principal) return;
    reply.header("Cache-Control", "no-store");
    const params = z.object({ model: z.enum(Object.keys(REPORT_MODELS) as [ReportModel, ...ReportModel[]]) }).safeParse(request.params);
    if (!params.success) return reply.status(404).send({ code: "REPORT_MODEL_NOT_FOUND", message: "Model laporan tidak dikenal." });
    const query = z.object({
      unitId: z.string().uuid().optional(),
      employeeId: z.string().uuid().optional(),
      from: dateSchema,
      to: dateSchema,
      format: z.enum(["json", "csv", "xlsx"]).default("json"),
      purpose: z.enum(["view", "print"]).default("view"),
    }).safeParse(request.query);
    if (!query.success) return reply.status(400).send({ code: "INVALID_REPORT_QUERY", message: "Filter laporan tidak valid." });
    const rangeError = validateCalculationRange(query.data.from, query.data.to);
    if (rangeError) {
      return reply.status(rangeError === "INVALID_CALCULATION_RANGE" ? 400 : 422)
        .send({ code: rangeError, message: calculationRangeMessages[rangeError] });
    }
    const scope = { unitId: query.data.unitId ?? null, employeeId: query.data.employeeId ?? null, from: query.data.from, to: query.data.to };
    const data = await attendanceCalculationRows(pool, scope, { page: 1, pageSize: REPORT_ROW_LIMIT + 1 });
    if (data.total > REPORT_ROW_LIMIT) {
      return reply.status(422).send({ code: "EXPORT_TOO_LARGE", message: "Laporan terlalu besar. Persempit unit atau rentang tanggal." });
    }
    let table;
    if (isPunchModel(params.data.model)) {
      // Data Transaksi / Data Scan read punches; evidence (GPS, photo) never goes into a report.
      const punches = await attendanceTransactions(pool, {
        ...scope, ...(params.data.model === "scans" ? { source: "adms" as const } : {}), page: 1, pageSize: REPORT_ROW_LIMIT + 1,
      });
      if (punches.total > REPORT_ROW_LIMIT) {
        return reply.status(422).send({ code: "EXPORT_TOO_LARGE", message: "Laporan terlalu besar. Persempit unit atau rentang tanggal." });
      }
      table = buildPunchTable(params.data.model, punches.items);
    } else {
      table = buildReportTable(params.data.model, data.items, scope.from, scope.to);
    }
    const unitName = scope.unitId ? data.items.find((item) => item.unitId === scope.unitId)?.unitName ?? null : null;
    const stamp = (value: Date) => new Intl.DateTimeFormat("id-ID", {
      day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Jakarta",
    }).format(value);
    const longDate = (value: string) => new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
      .format(new Date(`${value}T00:00:00Z`));
    // Identity and meta of the owner-approved print mock-up: unit, employees, filter, work days, and
    // when the data was calculated, separate from when and by whom it was printed.
    const header = {
      scope: scope.employeeId ? `Pegawai: ${data.items[0]?.employeeName ?? "-"}` : `Unit: ${unitName ?? "Semua unit"}`,
      unit: unitName ?? (scope.unitId ? "-" : "Semua unit"),
      employeeCount: new Set(data.items.map((item) => item.employeeId)).size,
      filter: scope.employeeId ? `Satu pegawai (${data.items[0]?.employeeName ?? "-"})` : "Semua pegawai, semua sumber",
      workDays: new Set(data.items.filter((item) => item.normal === 1).map((item) => item.workDate)).size,
      period: `Periode ${longDate(scope.from)} – ${longDate(scope.to)}`,
      calculatedAt: data.lastCalculatedAt ? `${stamp(new Date(data.lastCalculatedAt))} WIB` : "Belum ditarik",
      printedBy: principal.email,
      printedAt: `${stamp(new Date())} WIB`,
    };
    const warnings = {
      notCalculated: data.summary.not_calculated ?? 0,
      changed: data.changedCount,
      provisional: data.items.some((item) => item.provisional),
    };
    if (query.data.format !== "json" || query.data.purpose === "print") {
      await insertAudit(pool, principal.id, "attendance.report.exported", "attendance_report", null, {
        model: params.data.model, format: query.data.format, purpose: query.data.purpose,
        unitId: scope.unitId, employeeId: scope.employeeId, from: scope.from, to: scope.to, rows: data.total,
      });
    }
    const filename = `hcis-kehadiran-${params.data.model}-${scope.from}-${scope.to}`;
    if (query.data.format === "csv") {
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="${filename}.csv"`);
      return reply.send(reportCsv(table));
    }
    if (query.data.format === "xlsx") {
      reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      reply.header("Content-Disposition", `attachment; filename="${filename}.xlsx"`);
      return reply.send(await reportXlsx(table, header));
    }
    return reply.send({ ...table, header, warnings, from: scope.from, to: scope.to });
  });

  // Kept for one release (ATT-014 §10): queues a calculation of every employee for one date.
  app.post("/admin/attendance/finalize/:date", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.calculation.run");
    if (!principal) return;
    const params = z.object({ date: dateSchema }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: "INVALID_DATE", message: "Tanggal tidak valid." });
    return requestCalculation(reply, principal, { from: params.data.date, to: params.data.date });
  });

  app.get("/admin/attendance/report", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.reports.read");
    if (!principal) return;
    const query = reportQuerySchema.safeParse(request.query);
    if (!query.success) return reply.status(400).send({ code: "INVALID_REPORT_QUERY", message: "Filter laporan tidak valid." });
    const from = query.data.from ?? query.data.date!;
    const to = query.data.to ?? query.data.date!;
    try {
      const result = await buildAttendanceReport(pool, {
        type: query.data.type as AttendanceReportType,
        from,
        to,
        ...(query.data.employeeId ? { employeeId: query.data.employeeId } : {}),
        ...(query.data.unitId ? { unitId: query.data.unitId } : {}),
        ...(query.data.status ? { status: query.data.status } : {}),
        ...(query.data.scheduleId ? { scheduleId: query.data.scheduleId } : {}),
        ...(query.data.locationId ? { locationId: query.data.locationId } : {}),
        ...(query.data.source ? { source: query.data.source } : {}),
        ...(query.data.deviceId ? { deviceId: query.data.deviceId } : {}),
      });
      reply.header("Cache-Control", "no-store");
      return reply.send(result);
    } catch (error) {
      if (error instanceof Error && ["INVALID_REPORT_RANGE", "REPORT_RANGE_TOO_LARGE"].includes(error.message)) {
        return reply.status(400).send({ code: error.message, message: "Rentang laporan tidak valid atau terlalu panjang." });
      }
      throw error;
    }
  });}
