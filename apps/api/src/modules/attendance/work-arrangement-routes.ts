// ATT-015 Package 1 routes: tugas luar, WFH/WFA and schedule change requests, APR-001 approval,
// HC application of schedule changes. Spec: docs/domain/attendance-remote-and-schedule-requests.md.
//
// attendance.arrangements.* is HC-only: legacy Super Admin compatibility never grants it, so the admin
// routes resolve the permission from the organization context directly, like trips.*. Employee and
// approver access is ownership (the session's employee, the snapshotted step), never a permission.
//
// Nothing here writes attendance_events (spec §1.1). An approved tugas luar or WFH/WFA is read by the
// engine as a disposition; after COMMIT the affected past dates are recalculated (§7.3).

import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { pageOffset, pageQuerySchema, pagination } from "../../lib/pagination.js";
import type { WorkArrangementPermission } from "../auth/permissions.js";
import { AUTH_COOKIE_NAME, AuthService, readCookie, type AuthPrincipal } from "../auth/service.js";
import { LeaveApprovalConfigurationError } from "../leave/domain/approval-chain.js";
import {
  decideLeaveApprovalStep,
  LeaveWorkflowError,
  type LeaveApprovalStepState,
} from "../leave/domain/request-workflow.js";
import { LeaveOrganizationAuthorityError, resolveLeaveAuthorities } from "../leave/organization-authority.js";
import { notifyEmployee } from "../notifications/service.js";
import { jakartaWorkDate, materializeAttendanceResult, resolveSchedule } from "./engine.js";
import {
  ARRANGEMENT_STATUSES,
  ARRANGEMENT_TYPE_LABELS,
  ARRANGEMENT_TYPES,
  ArrangementPolicyError,
  approvalRequestStatus,
  canCancelArrangement,
  datesToRecompute,
  DISPOSITION_TYPES,
  OCCUPYING_STATUSES,
  validateArrangementDates,
  type ArrangementCanceller,
  type ArrangementStatus,
  type ArrangementType,
} from "./work-arrangements.js";

type Queryable = Pool | PoolClient;

/** D-01 DRAFT: ORG-004 rollout key; without a rollout row the mode is LEGACY. */
const WORKFLOW_KEY = "WORK_ARRANGEMENT";
/** §11: the active shift list is configuration data; more than this is refused, never cut. */
const MAX_SCHEDULE_OPTIONS = 200;
const NOTIFY_HREF = "/app/attendance/arrangements";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const baseBody = z.object({ startOn: isoDate, endOn: isoDate });
const requestBody = z.discriminatedUnion("type", [
  baseBody.extend({ type: z.literal("FIELD_ASSIGNMENT"), location: z.string().trim().min(3).max(200) }),
  baseBody.extend({ type: z.literal("REMOTE_WORK"), location: z.string().trim().min(3).max(200) }),
  baseBody.extend({ type: z.literal("SCHEDULE_CHANGE"), scheduleTemplateId: z.string().uuid() }),
]);
// The preview runs before the employee wrote the location, so it does not ask for it.
const previewBody = z.discriminatedUnion("type", [
  baseBody.extend({ type: z.literal("FIELD_ASSIGNMENT") }),
  baseBody.extend({ type: z.literal("REMOTE_WORK") }),
  baseBody.extend({ type: z.literal("SCHEDULE_CHANGE"), scheduleTemplateId: z.string().uuid() }),
]);
const submitBody = z.intersection(
  requestBody,
  z.object({ purpose: z.string().trim().min(10).max(1000), idempotencyKey: z.string().uuid() }),
);
const idParams = z.object({ id: z.string().uuid() });
const stepParams = z.object({ stepId: z.string().uuid() });
const decisionBody = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approve"), note: z.string().trim().max(1000).nullable().optional() }),
  z.object({ decision: z.literal("reject"), note: z.string().trim().min(5).max(1000) }),
]);
const employeeCancelBody = z.object({ reason: z.string().trim().min(5).max(500) });
const hcCancelBody = z.object({ reason: z.string().trim().min(10).max(500) });
const listQuery = pageQuerySchema.extend({
  status: z.enum(ARRANGEMENT_STATUSES).optional(),
  type: z.enum(ARRANGEMENT_TYPES).optional(),
});
const adminListQuery = listQuery.extend({ employeeId: z.string().uuid().optional() });
const scheduleOptionsQuery = z.object({ workDate: isoDate });

class ArrangementError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = "ArrangementError";
  }
}

interface EmployeeContext {
  id: string;
  fullName: string;
  directManagerEmployeeId: string | null;
  unitApproverEmployeeId: string | null;
}

interface ChainStep {
  employeeId: string;
  name: string;
  sources: string[];
}

interface ShiftOption {
  id: string;
  versionId: string;
  name: string;
  startTime: string;
  endTime: string;
  endDayOffset: number;
}

/** What a schedule change replaces, kept on the request so HC can tell when it went stale (D-09). */
interface ScheduleSnapshot {
  scheduleTemplateId: string;
  scheduleVersionId: string | null;
  scheduleName: string | null;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  requestedScheduleName: string;
  requestedStartAt: string;
}

type RequestInput = z.infer<typeof previewBody>;

function send(reply: FastifyReply, status: number, body: unknown) {
  reply.header("Cache-Control", "no-store");
  return reply.status(status).send(body);
}

function today(): string {
  return jakartaWorkDate(new Date());
}

function jakartaAt(date: string, time: string, dayOffset = 0): Date {
  const base = new Date(`${date}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + dayOffset);
  return new Date(`${base.toISOString().slice(0, 10)}T${time.slice(0, 8)}+07:00`);
}

function knownError(error: unknown): ArrangementError | null {
  if (error instanceof ArrangementError) return error;
  if (error instanceof ArrangementPolicyError
    || error instanceof LeaveApprovalConfigurationError
    || error instanceof LeaveOrganizationAuthorityError
    || error instanceof LeaveWorkflowError) {
    return new ArrangementError(409, error.code, error.message);
  }
  return null;
}

async function loadEmployeeContext(db: Queryable, accountId: string, lock = false): Promise<EmployeeContext> {
  const result = await db.query<EmployeeContext & { status: string }>(
    `SELECT employee.id, employee.full_name AS "fullName", employee.status,
            employee.direct_manager_employee_id AS "directManagerEmployeeId",
            unit.leave_approver_employee_id AS "unitApproverEmployeeId"
       FROM accounts account
       JOIN employees employee ON employee.id = account.employee_id
       LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
      WHERE account.id = $1
        AND account.principal_type = 'EMPLOYEE'
        AND account.status = 'active'
        AND employee.removed_at IS NULL
      ${lock ? "FOR UPDATE OF employee" : ""}`,
    [accountId],
  );
  const employee = result.rows[0];
  if (!employee || employee.status !== "active") {
    throw new ArrangementError(403, "EMPLOYEE_NOT_ACTIVE", "Akun tidak terhubung ke pegawai aktif.");
  }
  return employee;
}

/**
 * APR-001 at submission (D-01), the same resolution as TRIP-001: DIRECT_MANAGER and UNIT_APPROVER become
 * concrete employees, the requester is dropped and duplicates merged; every approver must be an active
 * employee with an active account, or nothing is stored.
 */
async function resolveApprovalChain(db: Queryable, employee: EmployeeContext, effectiveDate: string) {
  const resolution = await resolveLeaveAuthorities(db, {
    workflowKey: WORKFLOW_KEY,
    requesterEmployeeId: employee.id,
    effectiveDate,
    legacy: {
      directManagerEmployeeId: employee.directManagerEmployeeId,
      unitApproverEmployeeId: employee.unitApproverEmployeeId,
    },
    policyChain: "LINE_AND_UNIT",
  });
  const ids = resolution.approvalChain.map((step) => step.employeeId);
  if (ids.some((id) => !id)) {
    throw new ArrangementError(409, "APPROVAL_CHAIN_EMPTY", "Rantai approval hanya dapat berisi pegawai.");
  }
  const actors = await db.query<{ id: string; fullName: string; status: string; accountStatus: string | null }>(
    `SELECT employee.id, employee.full_name AS "fullName", employee.status, account.status AS "accountStatus"
       FROM employees employee
       LEFT JOIN accounts account ON account.employee_id = employee.id AND account.principal_type = 'EMPLOYEE'
      WHERE employee.id = ANY($1::uuid[]) AND employee.removed_at IS NULL`,
    [ids],
  );
  const byId = new Map(actors.rows.map((row) => [row.id, row]));
  const chain: ChainStep[] = resolution.approvalChain.map((step) => {
    const actor = byId.get(step.employeeId!);
    if (!actor || actor.status !== "active") {
      throw new ArrangementError(409, "APPROVER_NOT_ACTIVE", "Rantai approval berisi approver yang tidak aktif.");
    }
    if (actor.accountStatus !== "active") {
      throw new ArrangementError(409, "APPROVER_ACCOUNT_NOT_READY", `Akun approver ${actor.fullName} belum aktif.`);
    }
    return { employeeId: actor.id, name: actor.fullName, sources: step.sources };
  });
  return { chain, context: resolution.context };
}

/** Active shifts with the version valid on the date (§11). */
async function loadShiftOptions(db: Queryable, workDate: string): Promise<ShiftOption[]> {
  const result = await db.query<ShiftOption>(
    `SELECT schedule.id, version.id AS "versionId", coalesce(version.name, schedule.name) AS name,
            version.start_time::text AS "startTime", version.end_time::text AS "endTime",
            coalesce(version.end_day_offset, CASE WHEN version.end_time <= version.start_time THEN 1 ELSE 0 END)::int AS "endDayOffset"
       FROM attendance_schedule_templates schedule
       JOIN LATERAL (
         SELECT candidate.*
           FROM attendance_schedule_versions candidate
          WHERE candidate.schedule_template_id = schedule.id
            AND candidate.effective_from <= (($1::date + time '12:00') AT TIME ZONE 'Asia/Jakarta')
            AND (candidate.effective_to IS NULL OR candidate.effective_to > (($1::date + time '12:00') AT TIME ZONE 'Asia/Jakarta'))
          ORDER BY candidate.version DESC
          LIMIT 1
       ) version ON true
      WHERE schedule.active = true
      ORDER BY name ASC, schedule.id ASC
      LIMIT $2`,
    [workDate, MAX_SCHEDULE_OPTIONS + 1],
  );
  if (result.rows.length > MAX_SCHEDULE_OPTIONS) {
    throw new ArrangementError(409, "SCHEDULE_OPTIONS_TOO_MANY", "Daftar shift aktif terlalu banyak untuk ditampilkan. Hubungi Human Capital.");
  }
  return result.rows;
}

async function shiftNames(db: Queryable, templateIds: string[], workDate: string) {
  if (templateIds.length === 0) return new Map<string, string>();
  const result = await db.query<{ id: string; name: string }>(
    `SELECT schedule.id, coalesce(version.name, schedule.name) AS name
       FROM attendance_schedule_templates schedule
       LEFT JOIN LATERAL (
         SELECT candidate.name FROM attendance_schedule_versions candidate
          WHERE candidate.schedule_template_id = schedule.id
            AND candidate.effective_from <= (($2::date + time '12:00') AT TIME ZONE 'Asia/Jakarta')
            AND (candidate.effective_to IS NULL OR candidate.effective_to > (($2::date + time '12:00') AT TIME ZONE 'Asia/Jakarta'))
          ORDER BY candidate.version DESC LIMIT 1
       ) version ON true
      WHERE schedule.id = ANY($1::uuid[])`,
    [templateIds, workDate],
  );
  return new Map(result.rows.map((row) => [row.id, row.name]));
}

/** D-09: today's resolved schedule and the requested shift, or why the change cannot be asked for. */
async function planScheduleChange(db: Queryable, employeeId: string, workDate: string, scheduleTemplateId: string) {
  const current = await resolveSchedule(db, employeeId, workDate);
  if (current.state !== "scheduled" || !current.scheduleTemplateId) {
    throw new ArrangementError(409, "SCHEDULE_CHANGE_NOT_WORKING_DAY",
      "Ubah jadwal hanya untuk hari kerja yang sudah terjadwal. Perubahan hari libur diatur Human Capital.");
  }
  if (current.scheduleTemplateId === scheduleTemplateId) {
    throw new ArrangementError(409, "SCHEDULE_CHANGE_SAME_SHIFT", "Shift tujuan sama dengan jadwal saat ini.");
  }
  const target = (await loadShiftOptions(db, workDate)).find((option) => option.id === scheduleTemplateId);
  if (!target) {
    throw new ArrangementError(409, "SCHEDULE_CHANGE_SHIFT_NOT_VALID", "Shift tujuan tidak aktif atau tidak berlaku pada tanggal itu.");
  }
  const names = await shiftNames(db, [current.scheduleTemplateId], workDate);
  const snapshot: ScheduleSnapshot = {
    scheduleTemplateId: current.scheduleTemplateId,
    scheduleVersionId: current.scheduleVersionId,
    scheduleName: names.get(current.scheduleTemplateId) ?? null,
    scheduledStartAt: current.scheduledStartAt?.toISOString() ?? null,
    scheduledEndAt: current.scheduledEndAt?.toISOString() ?? null,
    requestedScheduleName: target.name,
    requestedStartAt: jakartaAt(workDate, target.startTime).toISOString(),
  };
  return { current, target, snapshot };
}

/** D-08 and D-09: one employee, one arrangement per day, never on leave or a business trip. */
async function assertNoConflict(db: Queryable, employeeId: string, input: RequestInput) {
  const sameKind = input.type === "SCHEDULE_CHANGE" ? ["SCHEDULE_CHANGE"] : [...DISPOSITION_TYPES];
  const own = await db.query(
    `SELECT 1 FROM attendance_work_arrangement_requests
      WHERE employee_id = $1 AND status = ANY($4::text[]) AND arrangement_type = ANY($5::text[])
        AND start_on <= $3::date AND end_on >= $2::date
      LIMIT 1`,
    [employeeId, input.startOn, input.endOn, [...OCCUPYING_STATUSES], sameKind],
  );
  if (own.rows[0]) {
    throw new ArrangementError(409, "ARRANGEMENT_OVERLAP", input.type === "SCHEDULE_CHANGE"
      ? "Sudah ada permintaan ubah jadwal pada tanggal ini."
      : "Tanggal ini beririsan dengan tugas luar atau WFH/WFA Anda yang lain.");
  }
  const leave = await db.query(
    `SELECT 1 FROM leave_requests
      WHERE employee_id = $1 AND status IN ('in_review', 'approved')
        AND start_on <= $3::date AND end_on >= $2::date
      LIMIT 1`,
    [employeeId, input.startOn, input.endOn],
  );
  if (leave.rows[0]) {
    throw new ArrangementError(409, "ARRANGEMENT_LEAVE_OVERLAP", "Tanggal ini beririsan dengan cuti yang sedang diajukan atau sudah disetujui.");
  }
  const trip = await db.query(
    `SELECT 1 FROM business_trip_requests
      WHERE employee_id = $1 AND status IN ('IN_REVIEW', 'APPROVED', 'ISSUED', 'COMPLETED')
        AND start_on <= $3::date AND end_on >= $2::date
      LIMIT 1`,
    [employeeId, input.startOn, input.endOn],
  );
  if (trip.rows[0]) {
    throw new ArrangementError(409, "ARRANGEMENT_TRIP_OVERLAP", "Tanggal ini beririsan dengan perjalanan dinas Anda.");
  }
  if (input.type === "SCHEDULE_CHANGE") await assertNoActiveShiftSwap(db, employeeId, input.startOn);
}

async function assertNoActiveShiftSwap(db: Queryable, employeeId: string, workDate: string) {
  const swap = await db.query(
    `SELECT 1 FROM attendance_shift_swap_requests
      WHERE work_date = $2::date AND status IN ('awaiting_counterpart', 'awaiting_hc')
        AND (requester_employee_id = $1 OR counterpart_employee_id = $1)
      LIMIT 1`,
    [employeeId, workDate],
  );
  if (swap.rows[0]) {
    throw new ArrangementError(409, "SCHEDULE_CHANGE_SHIFT_SWAP_ACTIVE", "Ada pengajuan tukar shift aktif pada tanggal ini.");
  }
}

/** D-08: meetings never block an arrangement; the preview only names them. */
async function meetingWarnings(db: Queryable, employeeId: string, startOn: string, endOn: string) {
  const result = await db.query<{ title: string; startAt: Date; endAt: Date }>(
    `SELECT meeting.title, meeting.start_at AS "startAt", meeting.end_at AS "endAt"
       FROM meeting_participants participant
       JOIN meetings meeting ON meeting.id = participant.meeting_id
      WHERE participant.employee_id = $1 AND participant.blocks_time
        AND meeting.status = 'ACTIVE'
        AND meeting.start_at < (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Jakarta')
        AND meeting.end_at > ($2::date::timestamp AT TIME ZONE 'Asia/Jakarta')
      ORDER BY meeting.start_at ASC
      LIMIT 20`,
    [employeeId, startOn, endOn],
  );
  return result.rows.map((row) => ({ title: row.title, startAt: row.startAt.toISOString(), endAt: row.endAt.toISOString() }));
}

async function addEvent(
  db: PoolClient,
  requestId: string,
  actorAccountId: string | null,
  eventType: string,
  note: string | null = null,
  metadata: Record<string, unknown> = {},
) {
  // clock_timestamp(), not now(): two events written in one transaction must keep their order.
  await db.query(
    `INSERT INTO attendance_work_arrangement_events (id, request_id, event_type, actor_account_id, note, metadata, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, clock_timestamp())`,
    [randomUUID(), requestId, eventType, actorAccountId, note, JSON.stringify(metadata)],
  );
}

const SUMMARY_COLUMNS = `
  arrangement.id, arrangement.arrangement_type AS type, arrangement.location, arrangement.purpose, arrangement.status,
  to_char(arrangement.start_on, 'YYYY-MM-DD') AS "startOn", to_char(arrangement.end_on, 'YYYY-MM-DD') AS "endOn",
  arrangement.schedule_snapshot->>'scheduleName' AS "currentScheduleName",
  arrangement.schedule_snapshot->>'requestedScheduleName' AS "requestedScheduleName",
  arrangement.submitted_at AS "submittedAt", arrangement.final_decided_at AS "finalDecidedAt",
  arrangement.applied_at AS "appliedAt", approver.full_name AS "currentApproverName"`;
const SUMMARY_JOINS = `
  LEFT JOIN attendance_work_arrangement_approval_steps current_step
    ON current_step.request_id = arrangement.id AND current_step.status = 'pending'
  LEFT JOIN employees approver ON approver.id = current_step.approver_employee_id`;

async function loadDetail(db: Queryable, id: string, ownerEmployeeId: string | null) {
  const found = await db.query(
    `SELECT ${SUMMARY_COLUMNS},
            arrangement.employee_id AS "employeeId", employee.full_name AS "employeeName",
            employee.employee_number AS "employeeNumber", unit.name AS "unitName",
            arrangement.cancel_reason AS "cancelReason", arrangement.applied_roster_id AS "appliedRosterId"
       FROM attendance_work_arrangement_requests arrangement
       JOIN employees employee ON employee.id = arrangement.employee_id
       LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
       ${SUMMARY_JOINS}
      WHERE arrangement.id = $1 AND ($2::uuid IS NULL OR arrangement.employee_id = $2)`,
    [id, ownerEmployeeId],
  );
  const row = found.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const steps = await db.query(
    `SELECT step.id, step.step_order AS "order", step.status, step.sources,
            approver.full_name AS "approverName", step.acted_at AS "actedAt",
            step.decision_note AS "decisionNote"
       FROM attendance_work_arrangement_approval_steps step
       JOIN employees approver ON approver.id = step.approver_employee_id
      WHERE step.request_id = $1
      ORDER BY step.step_order ASC`,
    [id],
  );
  const events = await db.query(
    `SELECT event.id, event.event_type AS "eventType", event.occurred_at AS "occurredAt",
            event.note, event.metadata, actor.full_name AS "actorName"
       FROM attendance_work_arrangement_events event
       LEFT JOIN accounts account ON account.id = event.actor_account_id
       LEFT JOIN employees actor ON actor.id = account.employee_id
      WHERE event.request_id = $1
      ORDER BY event.occurred_at ASC, event.id ASC`,
    [id],
  );
  return { ...row, steps: steps.rows, events: events.rows };
}

function pageOf<T extends { total: number }>(rows: T[], query: { page: number; pageSize: number }) {
  return {
    items: rows.map(({ total, ...row }) => { void total; return row; }),
    pagination: pagination(query, rows[0]?.total ?? 0),
  };
}

type Recompute = { employeeId: string; dates: string[] };

export async function registerWorkArrangementRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
  injectedAuth?: Pick<AuthService, "getSession" | "getAuthorizationContext">,
) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required for work arrangement routes");
  const auth = injectedAuth ?? new AuthService(
    pool, config.AUTH_ENCRYPTION_KEY, config.AUTH_SESSION_TTL_HOURS, config.NODE_ENV === "production",
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
      await send(reply, 403, { code: "FORBIDDEN", message: "Pengajuan tugas luar dan WFH hanya tersedia untuk pegawai." });
      return null;
    }
    return principal;
  }

  async function requirePermission(
    request: FastifyRequest,
    reply: FastifyReply,
    permission: WorkArrangementPermission,
  ): Promise<AuthPrincipal | null> {
    const principal = await authenticate(request, reply);
    if (!principal) return null;
    const context = await auth.getAuthorizationContext(principal);
    if (!context.organizationPermissions.includes(permission)) {
      await send(reply, 403, { code: "ARRANGEMENT_FORBIDDEN", message: "Anda tidak memiliki akses untuk tindakan ini." });
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
      return send(reply, known.statusCode, { code: known.code, message: known.message });
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

  /**
   * Runs `work` in one transaction and answers only after COMMIT succeeded. §7.3: the dates a decision
   * changed are then recalculated one by one; a failed date does not undo the decision, Kalkulasi
   * repairs it, so the answer only reports how many dates were recalculated.
   */
  async function transact(
    reply: FastifyReply,
    work: (client: PoolClient) => Promise<[number, Record<string, unknown>, (Recompute | undefined)?]>,
  ) {
    return handle(reply, async () => {
      const [status, body, recompute] = await inTransaction(work);
      if (!recompute || recompute.dates.length === 0) return send(reply, status, body);
      let recalculated = 0;
      for (const date of recompute.dates) {
        try {
          await materializeAttendanceResult(pool, recompute.employeeId, date);
          recalculated += 1;
        } catch (error) {
          reply.log.warn({ err: error, workDate: date }, "ATT-015 recompute failed; Kalkulasi will repair it");
        }
      }
      return send(reply, status, { ...body, recalculatedDates: recalculated });
    });
  }

  /** D-10. Steps that never ran become `cancelled` rather than disappearing. */
  async function cancelRequest(
    client: PoolClient,
    input: { id: string; ownerEmployeeId: string | null; by: ArrangementCanceller; actorAccountId: string; reason: string },
  ): Promise<[number, Record<string, unknown>, (Recompute | undefined)?]> {
    const found = await client.query<{
      employeeId: string; status: ArrangementStatus; type: ArrangementType; startOn: string; endOn: string;
    }>(
      `SELECT employee_id AS "employeeId", status, arrangement_type AS type,
              to_char(start_on, 'YYYY-MM-DD') AS "startOn", to_char(end_on, 'YYYY-MM-DD') AS "endOn"
         FROM attendance_work_arrangement_requests
        WHERE id = $1 AND ($2::uuid IS NULL OR employee_id = $2)
        FOR UPDATE`,
      [input.id, input.ownerEmployeeId],
    );
    const item = found.rows[0];
    if (!item) throw new ArrangementError(404, "ARRANGEMENT_NOT_FOUND", "Pengajuan tidak ditemukan.");
    const now = today();
    if (!canCancelArrangement(item.status, item.startOn, now, input.by)) {
      throw new ArrangementError(409, "ARRANGEMENT_NOT_CANCELLABLE", item.status === "APPROVED"
        ? "Pengajuan yang sudah disetujui hanya dapat dibatalkan pegawai sebelum tanggal mulai. Hubungi Human Capital."
        : "Pengajuan ini tidak dapat dibatalkan.");
    }
    await client.query(
      `UPDATE attendance_work_arrangement_requests
          SET status = 'CANCELLED', cancelled_by_account_id = $2, cancel_reason = $3, updated_at = now()
        WHERE id = $1`,
      [input.id, input.actorAccountId, input.reason],
    );
    await client.query(
      `UPDATE attendance_work_arrangement_approval_steps SET status = 'cancelled'
        WHERE request_id = $1 AND status IN ('waiting', 'pending')`,
      [input.id],
    );
    await addEvent(client, input.id, input.actorAccountId, "arrangement.request.cancelled", input.reason, {
      by: input.by, previousStatus: item.status,
    });
    if (input.by === "hc") {
      await notifyEmployee(client, item.employeeId, {
        eventKey: `arrangement.${input.id}.cancelled`,
        category: "attendance",
        title: `${ARRANGEMENT_TYPE_LABELS[item.type]} dibatalkan`,
        body: `${ARRANGEMENT_TYPE_LABELS[item.type]} ${item.startOn} dibatalkan oleh Human Capital.`,
        href: `${NOTIFY_HREF}?arrangement=${input.id}`,
        actorAccountId: input.actorAccountId,
      });
    }
    // An approved tugas luar/WFH stops explaining the days it covered (ATT-015-I).
    const recompute = item.status === "APPROVED" && DISPOSITION_TYPES.includes(item.type)
      ? { employeeId: item.employeeId, dates: datesToRecompute(item.startOn, item.endOn, now) }
      : undefined;
    return [200, { id: input.id, status: "CANCELLED" }, recompute];
  }

  /** Steps 3–5 of §5.1, shared by preview and submit. */
  async function validateRequest(db: Queryable, employee: EmployeeContext, input: RequestInput) {
    const submittedOn = today();
    const { days } = validateArrangementDates({ type: input.type, startOn: input.startOn, endOn: input.endOn, today: submittedOn });
    await assertNoConflict(db, employee.id, input);
    const schedule = input.type === "SCHEDULE_CHANGE"
      ? await planScheduleChange(db, employee.id, input.startOn, input.scheduleTemplateId)
      : null;
    const { chain, context } = await resolveApprovalChain(db, employee, submittedOn);
    return { days, schedule, chain, context };
  }

  // ---------------------------------------------------------------- employee

  app.get("/attendance/arrangements/me", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const query = listQuery.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_ARRANGEMENT_FILTER", message: "Filter tidak valid." });
    return handle(reply, async () => {
      const employee = await loadEmployeeContext(pool, principal.id);
      const result = await pool.query<{ total: number }>(
        `SELECT ${SUMMARY_COLUMNS}, count(*) OVER ()::int AS total
           FROM attendance_work_arrangement_requests arrangement
           ${SUMMARY_JOINS}
          WHERE arrangement.employee_id = $1
            AND ($2::text IS NULL OR arrangement.status = $2)
            AND ($3::text IS NULL OR arrangement.arrangement_type = $3)
          ORDER BY arrangement.start_on DESC, arrangement.submitted_at DESC, arrangement.id DESC
          LIMIT $4 OFFSET $5`,
        [employee.id, query.data.status ?? null, query.data.type ?? null, query.data.pageSize, pageOffset(query.data)],
      );
      return send(reply, 200, pageOf(result.rows, query.data));
    });
  });

  app.get("/attendance/arrangements/me/:id", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_ARRANGEMENT_ID", message: "Pengajuan tidak valid." });
    return handle(reply, async () => {
      const employee = await loadEmployeeContext(pool, principal.id);
      // ATT-015-A: another employee's request is indistinguishable from a missing one.
      const detail = await loadDetail(pool, params.data.id, employee.id);
      if (!detail) return send(reply, 404, { code: "ARRANGEMENT_NOT_FOUND", message: "Pengajuan tidak ditemukan." });
      return send(reply, 200, detail);
    });
  });

  app.get("/attendance/arrangements/schedule-options", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const query = scheduleOptionsQuery.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_ARRANGEMENT_DATE", message: "Tanggal tidak valid." });
    return handle(reply, async () => {
      const employee = await loadEmployeeContext(pool, principal.id);
      const current = await resolveSchedule(pool, employee.id, query.data.workDate);
      const options = await loadShiftOptions(pool, query.data.workDate);
      const names = await shiftNames(pool, current.scheduleTemplateId ? [current.scheduleTemplateId] : [], query.data.workDate);
      return send(reply, 200, {
        workDate: query.data.workDate,
        current: {
          state: current.state,
          scheduleTemplateId: current.scheduleTemplateId,
          scheduleName: current.scheduleTemplateId ? names.get(current.scheduleTemplateId) ?? null : null,
          scheduledStartAt: current.scheduledStartAt?.toISOString() ?? null,
          scheduledEndAt: current.scheduledEndAt?.toISOString() ?? null,
        },
        options: options
          .filter((option) => option.id !== current.scheduleTemplateId)
          .map((option) => ({ id: option.id, name: option.name, startTime: option.startTime.slice(0, 5), endTime: option.endTime.slice(0, 5) })),
      });
    });
  });

  app.post("/attendance/arrangements/me/preview", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const body = previewBody.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "INVALID_ARRANGEMENT_REQUEST", message: "Data pengajuan tidak valid." });
    return handle(reply, async () => {
      const employee = await loadEmployeeContext(pool, principal.id);
      const { days, schedule, chain } = await validateRequest(pool, employee, body.data);
      const meetings = body.data.type === "SCHEDULE_CHANGE" ? [] : await meetingWarnings(pool, employee.id, body.data.startOn, body.data.endOn);
      return send(reply, 200, {
        days,
        approvalChain: chain,
        meetings,
        scheduleChange: schedule
          ? { currentScheduleName: schedule.snapshot.scheduleName, requestedScheduleName: schedule.snapshot.requestedScheduleName }
          : null,
      });
    });
  });

  app.post("/attendance/arrangements/me", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const body = submitBody.safeParse(request.body);
    if (!body.success) {
      return send(reply, 400, {
        code: "INVALID_ARRANGEMENT_REQUEST",
        message: "Lokasi (min. 3 karakter), keperluan (min. 10 karakter), shift, atau tanggal tidak valid.",
      });
    }
    return transact(reply, async (client) => {
      // Locking the employee row serializes this employee's submissions, so two clicks cannot both
      // pass the overlap check (D-08).
      const employee = await loadEmployeeContext(client, principal.id, true);
      const replay = await client.query<{ id: string; status: ArrangementStatus }>(
        `SELECT id, status FROM attendance_work_arrangement_requests WHERE employee_id = $1 AND idempotency_key = $2`,
        [employee.id, body.data.idempotencyKey],
      );
      if (replay.rows[0]) return [200, { ...replay.rows[0], idempotentReplay: true }];

      const { days, schedule, chain, context } = await validateRequest(client, employee, body.data);
      const id = randomUUID();
      await client.query(
        `INSERT INTO attendance_work_arrangement_requests (
           id, employee_id, arrangement_type, start_on, end_on, location, purpose, status, idempotency_key,
           approval_snapshot, requested_schedule_template_id, requested_schedule_version_id, schedule_snapshot
         ) VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, 'IN_REVIEW', $8, $9::jsonb, $10, $11, $12::jsonb)`,
        [
          id, employee.id, body.data.type, body.data.startOn, body.data.endOn,
          body.data.type === "SCHEDULE_CHANGE" ? null : body.data.location,
          body.data.purpose, body.data.idempotencyKey,
          JSON.stringify({
            workflowKey: WORKFLOW_KEY,
            steps: chain.map((step) => ({ employeeId: step.employeeId, sources: step.sources })),
            authorityResolution: context,
          }),
          schedule?.target.id ?? null, schedule?.target.versionId ?? null,
          schedule ? JSON.stringify(schedule.snapshot) : null,
        ],
      );
      const steps: Array<{ id: string; employeeId: string; name: string }> = [];
      for (const [index, step] of chain.entries()) {
        const stepId = randomUUID();
        await client.query(
          `INSERT INTO attendance_work_arrangement_approval_steps (id, request_id, step_order, approver_employee_id, sources, status)
           VALUES ($1, $2, $3, $4, $5::text[], $6)`,
          [stepId, id, index + 1, step.employeeId, step.sources, index === 0 ? "pending" : "waiting"],
        );
        steps.push({ id: stepId, employeeId: step.employeeId, name: step.name });
      }
      await addEvent(client, id, principal.id, "arrangement.request.submitted", null, {
        type: body.data.type, days, approvers: steps.length, mode: context.mode,
      });
      const first = steps[0]!;
      await notifyEmployee(client, first.employeeId, {
        eventKey: `arrangement.approval.${first.id}`,
        category: "attendance",
        title: `Persetujuan ${ARRANGEMENT_TYPE_LABELS[body.data.type].toLowerCase()}`,
        body: `${employee.fullName} mengajukan ${ARRANGEMENT_TYPE_LABELS[body.data.type].toLowerCase()} mulai ${body.data.startOn}.`,
        href: "/app/approvals",
        actorAccountId: principal.id,
      });
      return [201, { id, status: "IN_REVIEW", days, approvalChain: steps, idempotentReplay: false }];
    });
  });

  app.post("/attendance/arrangements/me/:id/cancel", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_ARRANGEMENT_ID", message: "Pengajuan tidak valid." });
    const body = employeeCancelBody.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "INVALID_ARRANGEMENT_CANCEL", message: "Alasan pembatalan minimal 5 karakter." });
    return transact(reply, async (client) => {
      const employee = await loadEmployeeContext(client, principal.id);
      return cancelRequest(client, {
        id: params.data.id, ownerEmployeeId: employee.id, by: "employee",
        actorAccountId: principal.id, reason: body.data.reason,
      });
    });
  });

  // ---------------------------------------------------------------- approver

  app.get("/attendance/arrangements/approvals", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const query = pageQuerySchema.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_ARRANGEMENT_FILTER", message: "Filter tidak valid." });
    return handle(reply, async () => {
      const employee = await loadEmployeeContext(pool, principal.id);
      const result = await pool.query<{ total: number }>(
        `SELECT step.id AS "stepId", arrangement.id AS "requestId", step.sources,
                requester.full_name AS "requesterName", requester.employee_number AS "requesterNumber",
                unit.name AS "unitName", arrangement.arrangement_type AS type, arrangement.location, arrangement.purpose,
                arrangement.schedule_snapshot->>'scheduleName' AS "currentScheduleName",
                arrangement.schedule_snapshot->>'requestedScheduleName' AS "requestedScheduleName",
                to_char(arrangement.start_on, 'YYYY-MM-DD') AS "startOn", to_char(arrangement.end_on, 'YYYY-MM-DD') AS "endOn",
                arrangement.submitted_at AS "submittedAt", count(*) OVER ()::int AS total
           FROM attendance_work_arrangement_approval_steps step
           JOIN attendance_work_arrangement_requests arrangement ON arrangement.id = step.request_id
           JOIN employees requester ON requester.id = arrangement.employee_id
           LEFT JOIN organizational_units unit ON unit.id = requester.organizational_unit_id
          WHERE step.approver_employee_id = $1 AND step.status = 'pending' AND arrangement.status = 'IN_REVIEW'
          ORDER BY arrangement.start_on ASC, arrangement.submitted_at ASC, step.id ASC
          LIMIT $2 OFFSET $3`,
        [employee.id, query.data.pageSize, pageOffset(query.data)],
      );
      return send(reply, 200, pageOf(result.rows, query.data));
    });
  });

  app.post("/attendance/arrangements/approvals/:stepId/decision", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = stepParams.safeParse(request.params);
    const body = decisionBody.safeParse(request.body);
    if (!params.success || !body.success) {
      return send(reply, 400, {
        code: "INVALID_APPROVAL_DECISION",
        message: "Keputusan tidak valid. Penolakan wajib disertai alasan minimal 5 karakter.",
      });
    }
    return transact(reply, async (client) => {
      const actor = await loadEmployeeContext(client, principal.id);
      // Lock order request -> step, the same as cancelRequest, so a decision racing a cancellation waits.
      await client.query(
        `SELECT 1 FROM attendance_work_arrangement_requests
          WHERE id = (SELECT request_id FROM attendance_work_arrangement_approval_steps WHERE id = $1)
          FOR UPDATE`,
        [params.data.stepId],
      );
      const found = await client.query<{
        id: string; requestId: string; approverEmployeeId: string; requestStatus: ArrangementStatus;
        requesterEmployeeId: string; type: ArrangementType; startOn: string; endOn: string;
      }>(
        `SELECT step.id, step.request_id AS "requestId", step.approver_employee_id AS "approverEmployeeId",
                arrangement.status AS "requestStatus", arrangement.employee_id AS "requesterEmployeeId",
                arrangement.arrangement_type AS type,
                to_char(arrangement.start_on, 'YYYY-MM-DD') AS "startOn", to_char(arrangement.end_on, 'YYYY-MM-DD') AS "endOn"
           FROM attendance_work_arrangement_approval_steps step
           JOIN attendance_work_arrangement_requests arrangement ON arrangement.id = step.request_id
          WHERE step.id = $1
          FOR UPDATE OF step, arrangement`,
        [params.data.stepId],
      );
      const current = found.rows[0];
      if (!current) throw new ArrangementError(404, "APPROVAL_STEP_NOT_FOUND", "Tahap approval tidak ditemukan.");
      // ATT-015-C: the snapshot owns the step; nothing else grants it.
      if (current.approverEmployeeId !== actor.id) {
        throw new ArrangementError(403, "APPROVAL_FORBIDDEN", "Tahap approval ini bukan milik akun Anda.");
      }
      const all = await client.query<LeaveApprovalStepState>(
        `SELECT id, step_order AS "order", status
           FROM attendance_work_arrangement_approval_steps WHERE request_id = $1 ORDER BY step_order ASC`,
        [current.requestId],
      );
      const decision = decideLeaveApprovalStep({
        requestStatus: approvalRequestStatus(current.requestStatus),
        stepId: current.id,
        decision: body.data.decision,
        steps: all.rows,
      });
      const note = body.data.note ?? null;
      const label = ARRANGEMENT_TYPE_LABELS[current.type];
      await client.query(
        `UPDATE attendance_work_arrangement_approval_steps
            SET status = $2, acted_by_account_id = $3, acted_at = now(), decision_note = $4
          WHERE id = $1`,
        [current.id, decision.decidedStepStatus, principal.id, note],
      );
      if (decision.nextPendingStepId) {
        const next = await client.query<{ approverEmployeeId: string }>(
          `UPDATE attendance_work_arrangement_approval_steps SET status = 'pending' WHERE id = $1
           RETURNING approver_employee_id AS "approverEmployeeId"`,
          [decision.nextPendingStepId],
        );
        await notifyEmployee(client, next.rows[0]!.approverEmployeeId, {
          eventKey: `arrangement.approval.${decision.nextPendingStepId}`,
          category: "attendance",
          title: `Persetujuan ${label.toLowerCase()}`,
          body: `${label} ${current.startOn} menunggu keputusan Anda.`,
          href: "/app/approvals",
          actorAccountId: principal.id,
        });
      }
      const requestStatus: ArrangementStatus = decision.requestStatus === "approved"
        ? "APPROVED"
        : decision.requestStatus === "rejected" ? "REJECTED" : "IN_REVIEW";
      if (requestStatus !== "IN_REVIEW") {
        await client.query(
          `UPDATE attendance_work_arrangement_requests
              SET status = $2, final_decided_at = now(), updated_at = now()
            WHERE id = $1`,
          [current.requestId, requestStatus],
        );
      }
      await addEvent(
        client, current.requestId, principal.id,
        body.data.decision === "reject" ? "arrangement.request.rejected" : "arrangement.approval.approved_step",
        note, { stepId: current.id },
      );
      if (requestStatus === "APPROVED") {
        await addEvent(client, current.requestId, principal.id, "arrangement.request.approved");
      }
      if (requestStatus !== "IN_REVIEW") {
        await notifyEmployee(client, current.requesterEmployeeId, {
          eventKey: `arrangement.${current.requestId}.${requestStatus.toLowerCase()}`,
          category: "attendance",
          title: requestStatus === "APPROVED" ? `${label} disetujui` : `${label} ditolak`,
          body: requestStatus === "REJECTED"
            ? `${label} ${current.startOn} ditolak. Lihat alasannya di riwayat.`
            : current.type === "SCHEDULE_CHANGE"
              ? `Ubah jadwal ${current.startOn} disetujui. Human Capital akan menerapkannya ke jadwal Anda.`
              : `${label} ${current.startOn} disetujui dan tercatat di kehadiran Anda.`,
          href: `${NOTIFY_HREF}?arrangement=${current.requestId}`,
          actorAccountId: principal.id,
        });
      }
      const recompute = requestStatus === "APPROVED" && DISPOSITION_TYPES.includes(current.type)
        ? { employeeId: current.requesterEmployeeId, dates: datesToRecompute(current.startOn, current.endOn, today()) }
        : undefined;
      return [200, {
        requestId: current.requestId,
        requestStatus,
        stepStatus: decision.decidedStepStatus,
        nextPendingStepId: decision.nextPendingStepId,
      }, recompute];
    });
  });

  // ------------------------------------------------------------------- admin

  app.get("/admin/attendance/arrangements", async (request, reply) => {
    if (!(await requirePermission(request, reply, "attendance.arrangements.read"))) return;
    const query = adminListQuery.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_ARRANGEMENT_FILTER", message: "Filter tidak valid." });
    // ENG-LIST-001: filters run before LIMIT; the page carries the true total.
    const result = await pool.query<{ total: number }>(
      `SELECT ${SUMMARY_COLUMNS},
              arrangement.employee_id AS "employeeId", employee.full_name AS "employeeName",
              employee.employee_number AS "employeeNumber", unit.name AS "unitName",
              count(*) OVER ()::int AS total
         FROM attendance_work_arrangement_requests arrangement
         JOIN employees employee ON employee.id = arrangement.employee_id
         LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
         ${SUMMARY_JOINS}
        WHERE ($1::text IS NULL OR arrangement.status = $1)
          AND ($2::text IS NULL OR arrangement.arrangement_type = $2)
          AND ($3::uuid IS NULL OR arrangement.employee_id = $3)
        ORDER BY arrangement.start_on DESC, arrangement.submitted_at DESC, arrangement.id DESC
        LIMIT $4 OFFSET $5`,
      [query.data.status ?? null, query.data.type ?? null, query.data.employeeId ?? null, query.data.pageSize, pageOffset(query.data)],
    );
    return send(reply, 200, pageOf(result.rows, query.data));
  });

  app.get("/admin/attendance/arrangements/:id", async (request, reply) => {
    if (!(await requirePermission(request, reply, "attendance.arrangements.read"))) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_ARRANGEMENT_ID", message: "Pengajuan tidak valid." });
    const detail = await loadDetail(pool, params.data.id, null);
    if (!detail) return send(reply, 404, { code: "ARRANGEMENT_NOT_FOUND", message: "Pengajuan tidak ditemukan." });
    return send(reply, 200, detail);
  });

  app.post("/admin/attendance/arrangements/:id/apply", async (request, reply) => {
    const principal = await requirePermission(request, reply, "attendance.arrangements.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_ARRANGEMENT_ID", message: "Pengajuan tidak valid." });
    return transact(reply, async (client) => {
      const found = await client.query<{
        employeeId: string; employeeStatus: string; status: ArrangementStatus; type: ArrangementType; workDate: string;
        requestedScheduleTemplateId: string; requestedScheduleVersionId: string; snapshot: ScheduleSnapshot;
      }>(
        `SELECT arrangement.employee_id AS "employeeId", employee.status AS "employeeStatus", arrangement.status,
                arrangement.arrangement_type AS type, to_char(arrangement.start_on, 'YYYY-MM-DD') AS "workDate",
                arrangement.requested_schedule_template_id AS "requestedScheduleTemplateId",
                arrangement.requested_schedule_version_id AS "requestedScheduleVersionId",
                arrangement.schedule_snapshot AS snapshot
           FROM attendance_work_arrangement_requests arrangement
           JOIN employees employee ON employee.id = arrangement.employee_id
          WHERE arrangement.id = $1
          FOR UPDATE OF arrangement`,
        [params.data.id],
      );
      const item = found.rows[0];
      if (!item) throw new ArrangementError(404, "ARRANGEMENT_NOT_FOUND", "Pengajuan tidak ditemukan.");
      if (item.type !== "SCHEDULE_CHANGE" || item.status !== "APPROVED") {
        throw new ArrangementError(409, "ARRANGEMENT_NOT_APPLICABLE", "Hanya ubah jadwal yang sudah disetujui yang dapat diterapkan.");
      }
      if (item.employeeStatus !== "active") {
        throw new ArrangementError(409, "ARRANGEMENT_EMPLOYEE_NOT_ACTIVE", "Pegawai ini sudah tidak aktif; batalkan pengajuannya.");
      }
      // The same date lock as a shift swap decision, then the roster-week and employee locks of
      // Perubahan Jadwal (ATT-011-4, sorted like there), all before the stale check: a schedule change
      // committed by HC in between would otherwise be copied and then silently overwritten.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`shift-swap:${item.employeeId}:${item.workDate}`]);
      const week = await client.query<{ weekStart: string }>(
        `SELECT date_trunc('week', $1::date)::date::text AS "weekStart"`,
        [item.workDate],
      );
      for (const key of [`attendance-roster-week:${week.rows[0]!.weekStart}`, `attendance-schedule-employee:${item.employeeId}`].sort()) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
      }
      await assertNoActiveShiftSwap(client, item.employeeId, item.workDate);
      const current = await resolveSchedule(client, item.employeeId, item.workDate);
      if (current.state !== "scheduled"
        || current.scheduleTemplateId !== item.snapshot.scheduleTemplateId
        || current.scheduleVersionId !== item.snapshot.scheduleVersionId) {
        throw new ArrangementError(409, "SCHEDULE_CHANGE_STALE",
          "Jadwal pegawai pada tanggal itu sudah berubah sejak pengajuan. Batalkan dan minta pegawai mengajukan ulang.");
      }
      const target = (await loadShiftOptions(client, item.workDate)).find((option) => option.id === item.requestedScheduleTemplateId);
      if (!target || target.versionId !== item.requestedScheduleVersionId) {
        throw new ArrangementError(409, "SCHEDULE_CHANGE_STALE", "Shift tujuan sudah diubah atau dinonaktifkan sejak pengajuan.");
      }
      const now = new Date();
      const targetStart = jakartaAt(item.workDate, target.startTime);
      if ((current.scheduledStartAt && now >= current.scheduledStartAt) || now >= targetStart) {
        throw new ArrangementError(409, "SCHEDULE_CHANGE_STARTED", "Salah satu shift sudah dimulai; jadwal tidak dapat diubah lagi.");
      }
      const roster = await publishRosterEntry(client, {
        employeeId: item.employeeId,
        workDate: item.workDate,
        scheduleTemplateId: target.id,
        scheduleVersionId: target.versionId,
        note: `ATT-015 ubah jadwal ${params.data.id}`,
        actorAccountId: principal.id,
      });
      await client.query(
        `UPDATE attendance_work_arrangement_requests
            SET status = 'APPLIED', applied_roster_id = $2, applied_at = now(), updated_at = now()
          WHERE id = $1`,
        [params.data.id, roster.rosterId],
      );
      await addEvent(client, params.data.id, principal.id, "arrangement.schedule.applied", null, {
        rosterId: roster.rosterId, rosterVersion: roster.version, weekStart: roster.weekStart,
      });
      await notifyEmployee(client, item.employeeId, {
        eventKey: `arrangement.${params.data.id}.applied`,
        category: "attendance",
        title: "Jadwal Anda diubah",
        body: `Jadwal ${item.workDate} menjadi ${target.name} (${target.startTime.slice(0, 5)}–${target.endTime.slice(0, 5)}).`,
        href: `${NOTIFY_HREF}?arrangement=${params.data.id}`,
        actorAccountId: principal.id,
      });
      return [200, { id: params.data.id, status: "APPLIED", roster }, { employeeId: item.employeeId, dates: datesToRecompute(item.workDate, item.workDate, today()) }];
    });
  });

  app.post("/admin/attendance/arrangements/:id/cancel", async (request, reply) => {
    const principal = await requirePermission(request, reply, "attendance.arrangements.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_ARRANGEMENT_ID", message: "Pengajuan tidak valid." });
    const body = hcCancelBody.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "INVALID_ARRANGEMENT_CANCEL", message: "Alasan pembatalan minimal 10 karakter." });
    return transact(reply, async (client) => cancelRequest(client, {
      id: params.data.id, ownerEmployeeId: null, by: "hc", actorAccountId: principal.id, reason: body.data.reason,
    }));
  });
}

/**
 * D-09, the ATT-008 way: a new published roster version for the week, a copy of the latest one plus this
 * employee's entry for the date. A draft roster for the week refuses, so HC's unfinished work is not lost.
 */
async function publishRosterEntry(
  client: PoolClient,
  input: { employeeId: string; workDate: string; scheduleTemplateId: string; scheduleVersionId: string; note: string; actorAccountId: string },
) {
  const week = await client.query<{ weekStart: string }>(
    `SELECT date_trunc('week', $1::date)::date::text AS "weekStart"`,
    [input.workDate],
  );
  const weekStart = week.rows[0]!.weekStart;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`attendance-roster-week:${weekStart}`]);
  const draft = await client.query(
    `SELECT 1 FROM attendance_rosters WHERE week_start = $1::date AND status = 'DRAFT' LIMIT 1`,
    [weekStart],
  );
  if (draft.rows[0]) {
    throw new ArrangementError(409, "SCHEDULE_CHANGE_ROSTER_DRAFT_EXISTS",
      "Ada draft roster pada minggu ini. Selesaikan atau publish draft tersebut sebelum menerapkan ubah jadwal.");
  }
  const latest = await client.query<{ id: string; version: number }>(
    `SELECT id, version FROM attendance_rosters
      WHERE week_start = $1::date AND status = 'PUBLISHED'
      ORDER BY version DESC LIMIT 1 FOR UPDATE`,
    [weekStart],
  );
  const latestRoster = latest.rows[0] ?? null;
  const version = (latestRoster?.version ?? 0) + 1;
  const rosterId = randomUUID();
  await client.query(
    `INSERT INTO attendance_rosters (id, week_start, version, status, created_by_account_id, published_by_account_id, published_at, updated_at)
     VALUES ($1, $2::date, $3, 'PUBLISHED', $4, $4, now(), now())`,
    [rosterId, weekStart, version, input.actorAccountId],
  );
  if (latestRoster) {
    await client.query(
      `INSERT INTO attendance_roster_entries (roster_id, employee_id, work_date, schedule_template_id, schedule_version_id, is_off, note)
       SELECT $1, employee_id, work_date, schedule_template_id, schedule_version_id, is_off, note
         FROM attendance_roster_entries WHERE roster_id = $2`,
      [rosterId, latestRoster.id],
    );
  }
  await client.query(
    `INSERT INTO attendance_roster_entries (roster_id, employee_id, work_date, schedule_template_id, schedule_version_id, is_off, note)
     VALUES ($1, $2, $3::date, $4, $5, false, $6)
     ON CONFLICT (roster_id, employee_id, work_date) DO UPDATE SET
       schedule_template_id = EXCLUDED.schedule_template_id,
       schedule_version_id = EXCLUDED.schedule_version_id,
       is_off = false,
       note = EXCLUDED.note`,
    [rosterId, input.employeeId, input.workDate, input.scheduleTemplateId, input.scheduleVersionId, input.note],
  );
  return { rosterId, version, weekStart };
}
