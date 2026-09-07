import { hasOrganizationPermission } from "../auth/permissions.js";
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { requirePrincipalFromCookie } from "../auth/authorization.js";
import {
  AuthError,
  AuthService,
  type AuthPrincipal,
} from "../auth/service.js";
import {
  ANNUAL_LEAVE_ENTITLEMENT_DAYS,
  ANNUAL_LEAVE_PERIOD_LIMIT_DAYS,
  type AnnualLeavePeriodKey,
  type LeaveEntitlementGroup,
} from "./domain/annual-leave-policy.js";
import {
  AttendanceResolutionPolicyError,
  annualPeriodKeyForDate,
  classifyAdministrationDays,
  evaluateAnnualConversionOffer,
  type AnnualConversionOffer,
} from "./domain/attendance-resolution.js";
import { getLeavePolicy, type LeavePolicyKey } from "./domain/policy-catalog.js";
import { SUPPORTED_SPECIAL_LEAVE_KEYS } from "./domain/special-leave-policy.js";
import {
  calculateWorkingDays,
  decodeWorkingWeekdays,
  WorkingCalendarError,
  type IsoWeekday,
  type LeaveCalendarException,
} from "./domain/working-calendar.js";

const taskParamSchema = z.object({ taskId: z.string().uuid() });
const caseParamSchema = z.object({ caseId: z.string().uuid() });
const administrationDecisionSchema = z.object({
  action: z.enum([
    "validate_all",
    "request_correction",
    "validate_partial",
    "not_validated",
  ]),
  note: z.string().trim().max(1000).nullable().optional(),
  validatedDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(120).optional(),
});
const hcResolutionDecisionSchema = z.object({
  action: z.enum([
    "dispensation",
    "unpaid_absence",
    "manual_review",
    "propose_annual_conversion",
  ]),
  note: z.string().trim().max(1000).nullable().optional(),
});
const employeeConversionDecisionSchema = z.object({
  decision: z.enum(["accept", "reject"]),
  note: z.string().trim().max(1000).nullable().optional(),
});

interface EmployeeActorRow {
  id: string;
  employeeNumber: string;
  fullName: string;
  status: "active" | "inactive" | "resigned";
  unitName: string | null;
  positionName: string | null;
  leaveEntitlementGroup: LeaveEntitlementGroup | null;
  startedOn: string | null;
}

interface CalendarSettingRow {
  workingWeekdayMask: number | null;
}

interface CalendarExceptionRow {
  date: string;
  isWorkingDay: boolean;
}

interface AdministrationQueueRow {
  taskId: string;
  taskStatus: "pending" | "needs_correction";
  requestId: string;
  requesterEmployeeId: string;
  requesterName: string;
  employeeNumber: string;
  unitName: string | null;
  positionName: string | null;
  entitlementGroup: LeaveEntitlementGroup | null;
  policyKey: LeavePolicyKey;
  startOn: string;
  endOn: string;
  workingDays: number;
  reason: string | null;
  evidenceRequirement: "none" | "required" | "required_deferred_allowed" | "conditional";
  taskNote: string | null;
  submittedAt: Date;
  evidence: Array<{
    id: string;
    fileName: string;
    contentType: string;
    byteSize: number;
    createdAt: string;
  }> | null;
}

interface ResolutionCaseRow {
  caseId: string;
  employeeId: string;
  requesterName: string;
  employeeNumber: string;
  unitName: string | null;
  positionName: string | null;
  entitlementGroup: LeaveEntitlementGroup | null;
  startedOn: string | null;
  sourceRequestId: string;
  policyKey: LeavePolicyKey;
  status: "open" | "awaiting_employee" | "resolved";
  proposedResolution: "dispensation" | "unpaid_absence" | "annual_conversion" | "manual_review" | null;
  finalResolution: "dispensation" | "unpaid_absence" | "annual_conversion" | null;
  note: string | null;
  employeeResponseNote: string | null;
  unresolvedDates: string[];
  createdAt: Date;
  updatedAt: Date;
}

class AttendanceResolutionRouteError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AttendanceResolutionRouteError";
  }
}

async function loadActor(
  db: Pool | PoolClient,
  accountId: string,
  lock = false,
): Promise<EmployeeActorRow> {
  const result = await db.query<EmployeeActorRow>(
    `SELECT
      employee.id,
      employee.employee_number AS "employeeNumber",
      employee.full_name AS "fullName",
      employee.status,
      unit.name AS "unitName",
      position.name AS "positionName",
      employee.leave_entitlement_group AS "leaveEntitlementGroup",
      employee.started_on::text AS "startedOn"
    FROM accounts account
    JOIN employees employee ON employee.id = account.employee_id
    LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
    LEFT JOIN positions position ON position.id = employee.position_id
    WHERE account.id = $1
      AND account.principal_type = 'EMPLOYEE'
      AND account.status = 'active'
    ${lock ? "FOR UPDATE OF employee" : ""}`,
    [accountId],
  );
  const actor = result.rows[0];
  if (!actor || actor.status !== "active") {
    throw new AttendanceResolutionRouteError(
      403,
      "EMPLOYEE_NOT_ACTIVE",
      "Akun tidak terhubung ke pegawai aktif.",
    );
  }
  return actor;
}

export async function hasAttendanceResolutionPermission(db: Pool | PoolClient, accountId: string) {
  return hasOrganizationPermission(db, accountId, "attendance.resolution.manage");
}

async function requireHcPermission(db: Pool | PoolClient, principal: AuthPrincipal) {
  if (!(await hasAttendanceResolutionPermission(db, principal.id))) {
    throw new AttendanceResolutionRouteError(
      403,
      "ATTENDANCE_RESOLUTION_FORBIDDEN",
      "Akun ini tidak memiliki penugasan Human Capital aktif pada scope organisasi.",
    );
  }
}

async function loadWorkingCalendar(
  db: Pool | PoolClient,
  startOn: string,
  endOn: string,
): Promise<{ workingWeekdays: IsoWeekday[]; exceptions: LeaveCalendarException[] }> {
  const [settings, exceptions] = await Promise.all([
    db.query<CalendarSettingRow>(
      `SELECT working_weekday_mask AS "workingWeekdayMask"
       FROM leave_calendar_settings
       WHERE singleton = true`,
    ),
    db.query<CalendarExceptionRow>(
      `SELECT calendar_date::text AS date, is_working_day AS "isWorkingDay"
       FROM leave_calendar_exceptions
       WHERE calendar_date BETWEEN $1::date AND $2::date
       ORDER BY calendar_date ASC`,
      [startOn, endOn],
    ),
  ]);
  const workingWeekdays = decodeWorkingWeekdays(settings.rows[0]?.workingWeekdayMask);
  if (!workingWeekdays) {
    throw new AttendanceResolutionRouteError(
      409,
      "LEAVE_CALENDAR_NOT_CONFIGURED",
      "Kalender hari kerja belum dikonfigurasi.",
    );
  }
  return { workingWeekdays, exceptions: exceptions.rows };
}

async function workingDatesForRange(
  db: Pool | PoolClient,
  startOn: string,
  endOn: string,
) {
  const calendar = await loadWorkingCalendar(db, startOn, endOn);
  return calculateWorkingDays(startOn, endOn, calendar).workingDates;
}

async function addEvent(
  db: PoolClient,
  requestId: string,
  actorAccountId: string | null,
  eventType: string,
  payload: Record<string, unknown> = {},
) {
  await db.query(
    `INSERT INTO leave_request_events (
      id, leave_request_id, actor_account_id, event_type, payload
    ) VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [randomUUID(), requestId, actorAccountId, eventType, JSON.stringify(payload)],
  );
}

async function enqueueNotification(
  db: PoolClient,
  requestId: string,
  eventType: string,
  targetType: "employee" | "role",
  targetKey: string,
) {
  await db.query(
    `INSERT INTO leave_notification_outbox (
      id, leave_request_id, event_type, target_type, target_key, payload
    ) VALUES ($1, $2, $3, $4, $5, '{}'::jsonb)`,
    [randomUUID(), requestId, eventType, targetType, targetKey],
  );
}

async function annualUsageInPeriod(
  db: Pool | PoolClient,
  employeeId: string,
  periodKey: AnnualLeavePeriodKey,
  year: number,
) {
  const result = await db.query<{ days: number }>(
    `SELECT coalesce(sum(working_days), 0)::int AS days
     FROM leave_requests
     WHERE employee_id = $1
       AND policy_key = 'annual'
       AND status IN ('in_review', 'approved')
       AND annual_period_key = $2
       AND start_on >= make_date($3, 1, 1)
       AND start_on < make_date($3 + 1, 1, 1)`,
    [employeeId, periodKey, year],
  );
  return result.rows[0]?.days ?? 0;
}

async function annualOfferForCase(
  db: Pool | PoolClient,
  item: Pick<
    ResolutionCaseRow,
    "employeeId" | "entitlementGroup" | "startedOn" | "unresolvedDates"
  >,
): Promise<AnnualConversionOffer> {
  const firstDate = item.unresolvedDates[0];
  let usedDays = 0;
  if (firstDate && item.entitlementGroup === "non_education") {
    const periodKey = annualPeriodKeyForDate(firstDate);
    usedDays = await annualUsageInPeriod(
      db,
      item.employeeId,
      periodKey,
      Number(firstDate.slice(0, 4)),
    );
  }
  return evaluateAnnualConversionOffer({
    entitlementGroup: item.entitlementGroup,
    employmentStartedOn: item.startedOn,
    unresolvedDates: item.unresolvedDates,
    usedDaysInPeriod: usedDays,
  });
}

function mapKnownError(error: unknown): AttendanceResolutionRouteError | null {
  if (error instanceof AttendanceResolutionRouteError) return error;
  if (error instanceof AttendanceResolutionPolicyError) {
    return new AttendanceResolutionRouteError(409, error.code, error.message);
  }
  if (error instanceof WorkingCalendarError) {
    return new AttendanceResolutionRouteError(409, error.code, error.message);
  }
  return null;
}

async function sendKnownError(reply: FastifyReply, error: unknown) {
  const known = mapKnownError(error);
  if (!known) throw error;
  return reply.status(known.statusCode).send({ code: known.code, message: known.message });
}

export async function registerAttendanceResolutionRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
) {
  if (!config.AUTH_ENCRYPTION_KEY) {
    throw new Error("AUTH_ENCRYPTION_KEY is required for attendance resolution routes");
  }
  const auth = new AuthService(
    pool,
    config.AUTH_ENCRYPTION_KEY,
    config.AUTH_SESSION_TTL_HOURS,
    config.NODE_ENV === "production",
  );

  async function authenticateEmployee(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthPrincipal | null> {
    try {
      return await requirePrincipalFromCookie(
        auth,
        request.headers.cookie,
        "EMPLOYEE",
      );
    } catch (error) {
      if (error instanceof AuthError) {
        reply.header("Cache-Control", "no-store");
        await reply.status(error.statusCode).send({ code: error.code, message: error.message });
        return null;
      }
      throw error;
    }
  }

  app.get("/leave/hc/administration-queue", async (request, reply) => {
    const principal = await authenticateEmployee(request, reply);
    if (!principal) return;

    try {
      const actor = await loadActor(pool, principal.id);
      await requireHcPermission(pool, principal);
      const result = await pool.query<AdministrationQueueRow>(
        `SELECT
          task.id AS "taskId",
          task.status AS "taskStatus",
          leave_request.id AS "requestId",
          requester.id AS "requesterEmployeeId",
          requester.full_name AS "requesterName",
          requester.employee_number AS "employeeNumber",
          unit.name AS "unitName",
          position.name AS "positionName",
          requester.leave_entitlement_group AS "entitlementGroup",
          leave_request.policy_key AS "policyKey",
          leave_request.start_on::text AS "startOn",
          leave_request.end_on::text AS "endOn",
          leave_request.working_days AS "workingDays",
          leave_request.reason,
          leave_request.evidence_requirement AS "evidenceRequirement",
          task.note AS "taskNote",
          leave_request.submitted_at AS "submittedAt",
          evidence.items AS evidence
        FROM leave_request_hc_tasks task
        JOIN leave_requests leave_request ON leave_request.id = task.leave_request_id
        JOIN employees requester ON requester.id = leave_request.employee_id
        LEFT JOIN organizational_units unit ON unit.id = requester.organizational_unit_id
        LEFT JOIN positions position ON position.id = requester.position_id
        LEFT JOIN LATERAL (
          SELECT json_agg(json_build_object(
            'id', item.id,
            'fileName', item.original_filename,
            'contentType', item.content_type,
            'byteSize', item.byte_size,
            'createdAt', item.created_at
          ) ORDER BY item.created_at ASC) AS items
          FROM leave_request_evidence item
          WHERE item.leave_request_id = leave_request.id
        ) evidence ON true
        WHERE task.task_kind = 'validate'
          AND task.status = 'pending'
          AND leave_request.status = 'in_review'
          AND leave_request.policy_key = ANY($1::text[])
        ORDER BY leave_request.submitted_at ASC`,
        [[...SUPPORTED_SPECIAL_LEAVE_KEYS]],
      );

      const items = await Promise.all(
        result.rows.map(async (item) => ({
          ...item,
          policyName: getLeavePolicy(item.policyKey).name,
          workingDates: await workingDatesForRange(pool, item.startOn, item.endOn),
          evidence: item.evidence ?? [],
          submittedAt: item.submittedAt.toISOString(),
        })),
      );

      reply.header("Cache-Control", "no-store");
      return reply.send({
        actor: {
          id: actor.id,
          fullName: actor.fullName,
          employeeNumber: actor.employeeNumber,
          unitName: actor.unitName,
          positionName: actor.positionName,
        },
        items,
      });
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.post("/leave/hc/tasks/:taskId/administration-decision", async (request, reply) => {
    const principal = await authenticateEmployee(request, reply);
    if (!principal) return;
    const params = taskParamSchema.safeParse(request.params);
    const body = administrationDecisionSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({
        code: "INVALID_ADMINISTRATION_DECISION",
        message: "Hasil pemeriksaan administrasi tidak valid.",
      });
    }
    if (
      ["request_correction", "validate_partial", "not_validated"].includes(body.data.action) &&
      !body.data.note
    ) {
      return reply.status(400).send({
        code: "ADMINISTRATION_NOTE_REQUIRED",
        message: "Catatan wajib diisi untuk hasil ini.",
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await requireHcPermission(client, principal);
      const result = await client.query<{
        taskId: string;
        requestId: string;
        requesterEmployeeId: string;
        taskStatus: string;
        requestStatus: string;
        startOn: string;
        endOn: string;
        evidenceRequirement: string;
      }>(
        `SELECT
          task.id AS "taskId",
          task.leave_request_id AS "requestId",
          leave_request.employee_id AS "requesterEmployeeId",
          task.status AS "taskStatus",
          leave_request.status AS "requestStatus",
          leave_request.start_on::text AS "startOn",
          leave_request.end_on::text AS "endOn",
          leave_request.evidence_requirement AS "evidenceRequirement"
        FROM leave_request_hc_tasks task
        JOIN leave_requests leave_request ON leave_request.id = task.leave_request_id
        WHERE task.id = $1
          AND task.task_kind = 'validate'
          AND leave_request.policy_key = ANY($2::text[])
        FOR UPDATE OF task, leave_request`,
        [params.data.taskId, [...SUPPORTED_SPECIAL_LEAVE_KEYS]],
      );
      const task = result.rows[0];
      if (!task) {
        throw new AttendanceResolutionRouteError(404, "HC_TASK_NOT_FOUND", "Task validasi tidak ditemukan.");
      }
      if (task.taskStatus !== "pending" || task.requestStatus !== "in_review") {
        throw new AttendanceResolutionRouteError(409, "HC_TASK_NOT_PENDING", "Task validasi sudah tidak aktif.");
      }

      if (body.data.action === "request_correction") {
        await client.query(
          `UPDATE leave_request_hc_tasks
           SET status = 'needs_correction', note = $2, acted_by_account_id = $3,
               acted_at = now(), updated_at = now()
           WHERE id = $1`,
          [task.taskId, body.data.note, principal.id],
        );
        await addEvent(client, task.requestId, principal.id, "leave.hc.correction_requested", {
          taskId: task.taskId,
        });
        await enqueueNotification(
          client,
          task.requestId,
          "leave.hc.correction_requested.employee_notify",
          "employee",
          task.requesterEmployeeId,
        );
        await client.query("COMMIT");
        return reply.send({
          requestId: task.requestId,
          requestStatus: "in_review",
          administrationStatus: "pending",
          taskStatus: "needs_correction",
          resolutionCaseId: null,
        });
      }

      if (
        body.data.action !== "not_validated" &&
        ["required", "required_deferred_allowed"].includes(task.evidenceRequirement)
      ) {
        const evidence = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count
           FROM leave_request_evidence
           WHERE leave_request_id = $1`,
          [task.requestId],
        );
        if ((evidence.rows[0]?.count ?? 0) === 0) {
          throw new AttendanceResolutionRouteError(
            409,
            "EVIDENCE_REQUIRED_BEFORE_VALIDATION",
            "Dokumen pendukung belum tersedia. Minta pegawai melengkapi atau tandai administrasi tidak terpenuhi.",
          );
        }
      }

      const workingDates = await workingDatesForRange(client, task.startOn, task.endOn);
      const classification = classifyAdministrationDays({
        workingDates,
        action: body.data.action,
        ...(body.data.validatedDates ? { validatedDates: body.data.validatedDates } : {}),
      });

      for (const date of classification.validatedDates) {
        await client.query(
          `INSERT INTO leave_request_validation_days (
            leave_request_id, calendar_date, status, validated_by_account_id, note
          ) VALUES ($1, $2::date, 'validated', $3, $4)`,
          [task.requestId, date, principal.id, body.data.note ?? null],
        );
      }
      for (const date of classification.unresolvedDates) {
        await client.query(
          `INSERT INTO leave_request_validation_days (
            leave_request_id, calendar_date, status, validated_by_account_id, note
          ) VALUES ($1, $2::date, 'unresolved', $3, $4)`,
          [task.requestId, date, principal.id, body.data.note ?? null],
        );
      }

      await client.query(
        `UPDATE leave_request_hc_tasks
         SET status = 'validated', note = $2, acted_by_account_id = $3,
             acted_at = now(), updated_at = now()
         WHERE id = $1`,
        [task.taskId, body.data.note ?? null, principal.id],
      );
      await client.query(
        `UPDATE leave_requests
         SET status = 'approved',
             administration_status = $2,
             final_decided_at = now(),
             updated_at = now(),
             validation_summary = validation_summary || $3::jsonb
         WHERE id = $1`,
        [
          task.requestId,
          classification.administrationStatus,
          JSON.stringify({
            validatedDates: classification.validatedDates,
            unresolvedDates: classification.unresolvedDates,
          }),
        ],
      );

      let resolutionCaseId: string | null = null;
      if (classification.unresolvedDates.length > 0) {
        resolutionCaseId = randomUUID();
        await client.query(
          `INSERT INTO attendance_resolution_cases (
            id, employee_id, source_leave_request_id, status, note
          ) VALUES ($1, $2, $3, 'open', $4)`,
          [resolutionCaseId, task.requesterEmployeeId, task.requestId, body.data.note ?? null],
        );
        for (const date of classification.unresolvedDates) {
          await client.query(
            `INSERT INTO attendance_resolution_days (
              attendance_resolution_case_id, calendar_date
            ) VALUES ($1, $2::date)`,
            [resolutionCaseId, date],
          );
        }
      }

      await addEvent(client, task.requestId, principal.id, "leave.hc.administration_completed", {
        taskId: task.taskId,
        administrationStatus: classification.administrationStatus,
        unresolvedDates: classification.unresolvedDates,
        resolutionCaseId,
      });
      await enqueueNotification(
        client,
        task.requestId,
        classification.unresolvedDates.length > 0
          ? "leave.hc.administration_unresolved.employee_notify"
          : "leave.hc.validated.employee_notify",
        "employee",
        task.requesterEmployeeId,
      );
      if (resolutionCaseId) {
        await enqueueNotification(
          client,
          task.requestId,
          "attendance.resolution.created.hc_notify",
          "role",
          "human_capital",
        );
      }

      await client.query("COMMIT");
      return reply.send({
        requestId: task.requestId,
        requestStatus: "approved",
        administrationStatus: classification.administrationStatus,
        taskStatus: "validated",
        validatedDates: classification.validatedDates,
        unresolvedDates: classification.unresolvedDates,
        resolutionCaseId,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      return sendKnownError(reply, error);
    } finally {
      client.release();
    }
  });

  async function loadResolutionCases(
    db: Pool | PoolClient,
    whereSql: string,
    values: unknown[] = [],
  ) {
    return db.query<ResolutionCaseRow>(
      `SELECT
        resolution.id AS "caseId",
        employee.id AS "employeeId",
        employee.full_name AS "requesterName",
        employee.employee_number AS "employeeNumber",
        unit.name AS "unitName",
        position.name AS "positionName",
        employee.leave_entitlement_group AS "entitlementGroup",
        employee.started_on::text AS "startedOn",
        leave_request.id AS "sourceRequestId",
        leave_request.policy_key AS "policyKey",
        resolution.status,
        resolution.proposed_resolution AS "proposedResolution",
        resolution.final_resolution AS "finalResolution",
        resolution.note,
        resolution.employee_response_note AS "employeeResponseNote",
        array_agg(day.calendar_date::text ORDER BY day.calendar_date ASC) AS "unresolvedDates",
        resolution.created_at AS "createdAt",
        resolution.updated_at AS "updatedAt"
      FROM attendance_resolution_cases resolution
      JOIN employees employee ON employee.id = resolution.employee_id
      JOIN leave_requests leave_request ON leave_request.id = resolution.source_leave_request_id
      JOIN attendance_resolution_days day ON day.attendance_resolution_case_id = resolution.id
      LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
      LEFT JOIN positions position ON position.id = employee.position_id
      ${whereSql}
      GROUP BY resolution.id, employee.id, unit.name, position.name, leave_request.id
      ORDER BY resolution.created_at ASC`,
      values,
    );
  }

  app.get("/attendance/resolutions/hc", async (request, reply) => {
    const principal = await authenticateEmployee(request, reply);
    if (!principal) return;

    try {
      const actor = await loadActor(pool, principal.id);
      await requireHcPermission(pool, principal);
      const result = await loadResolutionCases(
        pool,
        `WHERE resolution.status IN ('open', 'awaiting_employee')`,
      );
      const items = await Promise.all(
        result.rows.map(async (item) => ({
          ...item,
          policyName: getLeavePolicy(item.policyKey).name,
          annualConversion: await annualOfferForCase(pool, item),
          createdAt: item.createdAt.toISOString(),
          updatedAt: item.updatedAt.toISOString(),
        })),
      );
      reply.header("Cache-Control", "no-store");
      return reply.send({
        actor: {
          id: actor.id,
          fullName: actor.fullName,
          employeeNumber: actor.employeeNumber,
          unitName: actor.unitName,
          positionName: actor.positionName,
        },
        items,
      });
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.post("/attendance/resolutions/hc/:caseId/decision", async (request, reply) => {
    const principal = await authenticateEmployee(request, reply);
    if (!principal) return;
    const params = caseParamSchema.safeParse(request.params);
    const body = hcResolutionDecisionSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({
        code: "INVALID_ATTENDANCE_RESOLUTION",
        message: "Penyelesaian ketidakhadiran tidak valid.",
      });
    }
    if (body.data.action !== "propose_annual_conversion" && !body.data.note) {
      return reply.status(400).send({
        code: "ATTENDANCE_RESOLUTION_NOTE_REQUIRED",
        message: "Catatan penyelesaian wajib diisi.",
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await requireHcPermission(client, principal);
      const result = await loadResolutionCases(
        client,
        `WHERE resolution.id = $1`,
        [params.data.caseId],
      );
      const item = result.rows[0];
      if (!item) {
        throw new AttendanceResolutionRouteError(404, "RESOLUTION_CASE_NOT_FOUND", "Kasus penyelesaian tidak ditemukan.");
      }
      if (item.status !== "open") {
        throw new AttendanceResolutionRouteError(
          409,
          "RESOLUTION_CASE_NOT_OPEN",
          "Kasus ini sedang menunggu pegawai atau sudah diselesaikan.",
        );
      }

      if (body.data.action === "propose_annual_conversion") {
        const offer = await annualOfferForCase(client, item);
        if (!offer.available) {
          throw new AttendanceResolutionRouteError(
            409,
            "ANNUAL_CONVERSION_NOT_AVAILABLE",
            offer.reason ?? "Konversi Cuti Tahunan tidak tersedia.",
          );
        }
        await client.query(
          `UPDATE attendance_resolution_cases
           SET status = 'awaiting_employee',
               proposed_resolution = 'annual_conversion',
               note = $2,
               proposed_by_account_id = $3,
               updated_at = now()
           WHERE id = $1`,
          [item.caseId, body.data.note ?? null, principal.id],
        );
        await addEvent(client, item.sourceRequestId, principal.id, "attendance.resolution.annual_conversion_proposed", {
          caseId: item.caseId,
          unresolvedDates: item.unresolvedDates,
        });
        await enqueueNotification(
          client,
          item.sourceRequestId,
          "attendance.resolution.annual_conversion.employee_action",
          "employee",
          item.employeeId,
        );
        await client.query("COMMIT");
        return reply.send({ caseId: item.caseId, status: "awaiting_employee", proposedResolution: "annual_conversion" });
      }

      if (body.data.action === "manual_review") {
        await client.query(
          `UPDATE attendance_resolution_cases
           SET proposed_resolution = 'manual_review',
               note = $2,
               proposed_by_account_id = $3,
               updated_at = now()
           WHERE id = $1`,
          [item.caseId, body.data.note, principal.id],
        );
        await addEvent(client, item.sourceRequestId, principal.id, "attendance.resolution.manual_review", {
          caseId: item.caseId,
        });
        await client.query("COMMIT");
        return reply.send({ caseId: item.caseId, status: "open", proposedResolution: "manual_review" });
      }

      const finalResolution = body.data.action;
      await client.query(
        `UPDATE attendance_resolution_cases
         SET status = 'resolved',
             proposed_resolution = $2,
             final_resolution = $2,
             note = $3,
             proposed_by_account_id = $4,
             resolved_by_account_id = $4,
             resolved_at = now(),
             updated_at = now()
         WHERE id = $1`,
        [item.caseId, finalResolution, body.data.note, principal.id],
      );
      await addEvent(client, item.sourceRequestId, principal.id, "attendance.resolution.completed", {
        caseId: item.caseId,
        finalResolution,
        unresolvedDates: item.unresolvedDates,
      });
      await enqueueNotification(
        client,
        item.sourceRequestId,
        "attendance.resolution.completed.employee_notify",
        "employee",
        item.employeeId,
      );
      await client.query("COMMIT");
      return reply.send({ caseId: item.caseId, status: "resolved", finalResolution });
    } catch (error) {
      await client.query("ROLLBACK");
      return sendKnownError(reply, error);
    } finally {
      client.release();
    }
  });

  app.get("/attendance/resolutions/me", async (request, reply) => {
    const principal = await authenticateEmployee(request, reply);
    if (!principal) return;

    try {
      const actor = await loadActor(pool, principal.id);
      const result = await loadResolutionCases(
        pool,
        `WHERE resolution.employee_id = $1`,
        [actor.id],
      );
      const items = await Promise.all(
        result.rows.map(async (item) => ({
          ...item,
          policyName: getLeavePolicy(item.policyKey).name,
          annualConversion: await annualOfferForCase(pool, item),
          createdAt: item.createdAt.toISOString(),
          updatedAt: item.updatedAt.toISOString(),
        })),
      );
      reply.header("Cache-Control", "no-store");
      return reply.send({ items });
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.post("/attendance/resolutions/me/:caseId/annual-conversion-decision", async (request, reply) => {
    const principal = await authenticateEmployee(request, reply);
    if (!principal) return;
    const params = caseParamSchema.safeParse(request.params);
    const body = employeeConversionDecisionSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({
        code: "INVALID_ANNUAL_CONVERSION_DECISION",
        message: "Keputusan konversi Cuti Tahunan tidak valid.",
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const actor = await loadActor(client, principal.id, true);
      const result = await loadResolutionCases(
        client,
        `WHERE resolution.id = $1 AND resolution.employee_id = $2`,
        [params.data.caseId, actor.id],
      );
      const item = result.rows[0];
      if (!item) {
        throw new AttendanceResolutionRouteError(404, "RESOLUTION_CASE_NOT_FOUND", "Kasus penyelesaian tidak ditemukan.");
      }
      if (item.status !== "awaiting_employee" || item.proposedResolution !== "annual_conversion") {
        throw new AttendanceResolutionRouteError(
          409,
          "ANNUAL_CONVERSION_NOT_AWAITING",
          "Kasus ini tidak sedang menunggu keputusan konversi Cuti Tahunan.",
        );
      }

      if (body.data.decision === "reject") {
        await client.query(
          `UPDATE attendance_resolution_cases
           SET status = 'open',
               proposed_resolution = NULL,
               employee_response_note = $2,
               employee_decided_at = now(),
               updated_at = now()
           WHERE id = $1`,
          [item.caseId, body.data.note ?? null],
        );
        await addEvent(client, item.sourceRequestId, principal.id, "attendance.resolution.annual_conversion_rejected", {
          caseId: item.caseId,
        });
        await enqueueNotification(
          client,
          item.sourceRequestId,
          "attendance.resolution.employee_rejected.hc_notify",
          "role",
          "human_capital",
        );
        await client.query("COMMIT");
        return reply.send({ caseId: item.caseId, status: "open", decision: "reject" });
      }

      const offer = await annualOfferForCase(client, item);
      if (!offer.available || !offer.periodKey) {
        throw new AttendanceResolutionRouteError(
          409,
          "ANNUAL_CONVERSION_NOT_AVAILABLE",
          offer.reason ?? "Kuota Cuti Tahunan sudah tidak tersedia untuk konversi ini.",
        );
      }

      const annualRequestId = randomUUID();
      await client.query(
        `INSERT INTO leave_requests (
          id, employee_id, policy_key, status, start_on, end_on, working_days,
          reason, annual_period_key, annual_entitlement_days,
          annual_period_limit_days, annual_available_before,
          hc_handling, idempotency_key, line_handling,
          evidence_requirement, emergency_notice, validation_summary,
          administration_status, final_decided_at
        ) VALUES (
          $1, $2, 'annual', 'approved', $3::date, $4::date, $5,
          $6, $7, $8, $9, $10,
          'none', $11, 'none',
          'none', false, $12::jsonb,
          'not_applicable', now()
        )`,
        [
          annualRequestId,
          actor.id,
          item.unresolvedDates[0],
          item.unresolvedDates[item.unresolvedDates.length - 1],
          item.unresolvedDates.length,
          "Konversi administratif untuk penyelesaian ketidakhadiran.",
          offer.periodKey,
          ANNUAL_LEAVE_ENTITLEMENT_DAYS,
          ANNUAL_LEAVE_PERIOD_LIMIT_DAYS,
          offer.remainingDays,
          `attendance-resolution:${item.caseId}`,
          JSON.stringify({
            source: "attendance_resolution",
            sourceCaseId: item.caseId,
            convertedDates: item.unresolvedDates,
          }),
        ],
      );
      await client.query(
        `UPDATE attendance_resolution_cases
         SET status = 'resolved',
             final_resolution = 'annual_conversion',
             employee_response_note = $2,
             employee_decided_at = now(),
             resolved_by_account_id = $3,
             resolved_at = now(),
             updated_at = now()
         WHERE id = $1`,
        [item.caseId, body.data.note ?? null, principal.id],
      );
      await addEvent(client, annualRequestId, principal.id, "leave.annual.administrative_conversion", {
        sourceCaseId: item.caseId,
        sourceLeaveRequestId: item.sourceRequestId,
      });
      await addEvent(client, item.sourceRequestId, principal.id, "attendance.resolution.annual_conversion_completed", {
        caseId: item.caseId,
        annualRequestId,
        convertedDates: item.unresolvedDates,
      });
      await enqueueNotification(
        client,
        item.sourceRequestId,
        "attendance.resolution.annual_conversion.hc_notify",
        "role",
        "human_capital",
      );
      await client.query("COMMIT");
      return reply.send({
        caseId: item.caseId,
        status: "resolved",
        decision: "accept",
        annualRequestId,
        periodKey: offer.periodKey,
        convertedDays: item.unresolvedDates.length,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      return sendKnownError(reply, error);
    } finally {
      client.release();
    }
  });
}
