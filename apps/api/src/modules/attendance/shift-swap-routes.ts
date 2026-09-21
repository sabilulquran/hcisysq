import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { requirePermissionsFromCookie, requirePrincipalFromCookie } from "../auth/authorization.js";
import type { AdminPermission } from "../auth/permissions.js";
import { AuthError, AuthService, type AuthPrincipal } from "../auth/service.js";
import { notifyEmployee } from "../notifications/service.js";
import {
  jakartaWorkDate,
  materializeAttendanceResult,
  resolveSchedule,
  type ResolvedSchedule,
} from "./engine.js";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const createSchema = z.object({
  counterpartEmployeeId: z.string().uuid(),
  workDate: dateSchema,
  note: z.string().trim().max(2000).nullable().optional(),
});
const counterpartDecisionSchema = z.object({
  decision: z.enum(["accept", "reject"]),
  note: z.string().trim().max(2000).nullable().optional(),
});
const hcDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(2000).nullable().optional(),
});
const employeeListSchema = z.object({
  status: z.enum([
    "all",
    "active",
    "awaiting_counterpart",
    "awaiting_hc",
    "approved",
    "rejected_by_counterpart",
    "rejected_by_hc",
    "cancelled",
  ]).default("all"),
});
const adminListSchema = z.object({
  status: z.enum([
    "all",
    "awaiting_counterpart",
    "awaiting_hc",
    "approved",
    "rejected_by_counterpart",
    "rejected_by_hc",
    "cancelled",
  ]).default("awaiting_hc"),
});

type EmployeeIdentity = {
  id: string;
  fullName: string;
  employeeNumber: string;
  unitId: string | null;
  unitName: string | null;
};

type ShiftSwapRow = {
  id: string;
  requesterEmployeeId: string;
  counterpartEmployeeId: string;
  workDate: string;
  requesterScheduleTemplateId: string;
  requesterScheduleVersionId: string;
  requesterRosterId: string | null;
  requesterScheduledStartAt: Date;
  requesterScheduledEndAt: Date;
  counterpartScheduleTemplateId: string;
  counterpartScheduleVersionId: string;
  counterpartRosterId: string | null;
  counterpartScheduledStartAt: Date;
  counterpartScheduledEndAt: Date;
  note: string | null;
  status: string;
  counterpartDecision: string | null;
  counterpartDecisionNote: string | null;
  counterpartDecidedAt: Date | null;
  hcDecision: string | null;
  hcDecisionNote: string | null;
  hcDecidedAt: Date | null;
  publishedRosterId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

class ShiftSwapError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = "ShiftSwapError";
  }
}

async function authenticate(
  auth: AuthService,
  request: FastifyRequest,
  reply: FastifyReply,
  expected: "EMPLOYEE" | AdminPermission,
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

async function employeeForAccount(db: Pool | PoolClient, accountId: string): Promise<EmployeeIdentity> {
  const result = await db.query<EmployeeIdentity>(
    `SELECT employee.id, employee.full_name AS "fullName",
       employee.employee_number AS "employeeNumber",
       employee.organizational_unit_id AS "unitId", unit.name AS "unitName"
     FROM accounts account
     JOIN employees employee ON employee.id = account.employee_id
     LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
     WHERE account.id = $1
       AND account.principal_type = 'EMPLOYEE'
       AND account.status = 'active'
       AND employee.status = 'active'`,
    [accountId],
  );
  const employee = result.rows[0];
  if (!employee) {
    throw new ShiftSwapError(403, "EMPLOYEE_NOT_ACTIVE", "Akun tidak terhubung ke pegawai aktif.");
  }
  return employee;
}

function scheduleSnapshot(schedule: ResolvedSchedule) {
  if (
    schedule.state !== "scheduled" ||
    !schedule.scheduleTemplateId ||
    !schedule.scheduleVersionId ||
    !schedule.scheduledStartAt ||
    !schedule.scheduledEndAt
  ) {
    throw new ShiftSwapError(
      409,
      "SHIFT_SWAP_SCHEDULE_NOT_ELIGIBLE",
      "Tukar shift hanya tersedia ketika kedua pegawai mempunyai jadwal kerja yang valid.",
    );
  }
  return {
    scheduleTemplateId: schedule.scheduleTemplateId,
    scheduleVersionId: schedule.scheduleVersionId,
    rosterId: schedule.rosterId,
    scheduledStartAt: schedule.scheduledStartAt,
    scheduledEndAt: schedule.scheduledEndAt,
  };
}

function ensureBeforeEarliestShift(
  left: { scheduledStartAt: Date },
  right: { scheduledStartAt: Date },
  now = new Date(),
) {
  const earliest = Math.min(left.scheduledStartAt.getTime(), right.scheduledStartAt.getTime());
  if (now.getTime() >= earliest) {
    throw new ShiftSwapError(
      409,
      "SHIFT_SWAP_CUTOFF_PASSED",
      "Tukar shift harus selesai sebelum waktu mulai shift paling awal.",
    );
  }
}

function activeStatusesSql() {
  return "('awaiting_counterpart','awaiting_hc')";
}

async function lockParticipants(
  client: PoolClient,
  employeeIds: readonly string[],
  workDate: string,
) {
  const keys = [...employeeIds]
    .sort()
    .map((employeeId) => `shift-swap:${employeeId}:${workDate}`);
  for (const key of keys) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
  }
}

async function ensureNoActiveConflict(
  db: Pool | PoolClient,
  employeeIds: readonly string[],
  workDate: string,
  excludeRequestId?: string,
) {
  const result = await db.query<{ id: string }>(
    `SELECT id
     FROM attendance_shift_swap_requests
     WHERE work_date = $1::date
       AND status IN ${activeStatusesSql()}
       AND (
         requester_employee_id = ANY($2::uuid[])
         OR counterpart_employee_id = ANY($2::uuid[])
       )
       AND ($3::uuid IS NULL OR id <> $3::uuid)
     LIMIT 1`,
    [workDate, employeeIds, excludeRequestId ?? null],
  );
  if (result.rows[0]) {
    throw new ShiftSwapError(
      409,
      "SHIFT_SWAP_ACTIVE_CONFLICT",
      "Salah satu pegawai sudah mempunyai pengajuan tukar shift aktif pada tanggal tersebut.",
    );
  }
}

async function insertAudit(
  db: Pool | PoolClient,
  actorAccountId: string,
  action: string,
  entityId: string,
  payload: Record<string, unknown>,
) {
  await db.query(
    `INSERT INTO access_audit_events (
       id, actor_account_id, action, entity_type, entity_id, payload
     ) VALUES ($1, $2, $3, 'attendance_shift_swap', $4, $5::jsonb)`,
    [randomUUID(), actorAccountId, action, entityId, JSON.stringify(payload)],
  );
}

async function sendError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof ShiftSwapError)) throw error;
  reply.header("Cache-Control", "no-store");
  return reply.status(error.statusCode).send({ code: error.code, message: error.message });
}

function rowResponse(row: Record<string, unknown>) {
  const date = (value: unknown) => value instanceof Date ? value.toISOString() : value ?? null;
  return {
    ...row,
    requesterScheduledStartAt: date(row.requesterScheduledStartAt),
    requesterScheduledEndAt: date(row.requesterScheduledEndAt),
    counterpartScheduledStartAt: date(row.counterpartScheduledStartAt),
    counterpartScheduledEndAt: date(row.counterpartScheduledEndAt),
    counterpartDecidedAt: date(row.counterpartDecidedAt),
    hcDecidedAt: date(row.hcDecidedAt),
    createdAt: date(row.createdAt),
    updatedAt: date(row.updatedAt),
  };
}

const requestSelect = `
  SELECT request.id,
    request.requester_employee_id AS "requesterEmployeeId",
    requester.employee_number AS "requesterEmployeeNumber",
    requester.full_name AS "requesterName",
    requester_unit.name AS "requesterUnitName",
    request.counterpart_employee_id AS "counterpartEmployeeId",
    counterpart.employee_number AS "counterpartEmployeeNumber",
    counterpart.full_name AS "counterpartName",
    counterpart_unit.name AS "counterpartUnitName",
    request.work_date::text AS "workDate",
    request.requester_schedule_template_id AS "requesterScheduleTemplateId",
    request.requester_schedule_version_id AS "requesterScheduleVersionId",
    requester_version.name AS "requesterScheduleName",
    request.requester_roster_id AS "requesterRosterId",
    request.requester_scheduled_start_at AS "requesterScheduledStartAt",
    request.requester_scheduled_end_at AS "requesterScheduledEndAt",
    request.counterpart_schedule_template_id AS "counterpartScheduleTemplateId",
    request.counterpart_schedule_version_id AS "counterpartScheduleVersionId",
    counterpart_version.name AS "counterpartScheduleName",
    request.counterpart_roster_id AS "counterpartRosterId",
    request.counterpart_scheduled_start_at AS "counterpartScheduledStartAt",
    request.counterpart_scheduled_end_at AS "counterpartScheduledEndAt",
    request.note, request.status,
    request.counterpart_decision AS "counterpartDecision",
    request.counterpart_decision_note AS "counterpartDecisionNote",
    request.counterpart_decided_at AS "counterpartDecidedAt",
    request.hc_decision AS "hcDecision",
    request.hc_decision_note AS "hcDecisionNote",
    request.hc_decided_at AS "hcDecidedAt",
    request.published_roster_id AS "publishedRosterId",
    request.created_at AS "createdAt",
    request.updated_at AS "updatedAt"
  FROM attendance_shift_swap_requests request
  JOIN employees requester ON requester.id = request.requester_employee_id
  LEFT JOIN organizational_units requester_unit ON requester_unit.id = requester.organizational_unit_id
  JOIN employees counterpart ON counterpart.id = request.counterpart_employee_id
  LEFT JOIN organizational_units counterpart_unit ON counterpart_unit.id = counterpart.organizational_unit_id
  JOIN attendance_schedule_versions requester_version
    ON requester_version.id = request.requester_schedule_version_id
  JOIN attendance_schedule_versions counterpart_version
    ON counterpart_version.id = request.counterpart_schedule_version_id
`;

async function currentSameUnitEmployees(
  db: Pool | PoolClient,
  leftEmployeeId: string,
  rightEmployeeId: string,
) {
  const result = await db.query<{ id: string; unitId: string | null }>(
    `SELECT id, organizational_unit_id AS "unitId"
     FROM employees
     WHERE id = ANY($1::uuid[]) AND status = 'active'`,
    [[leftEmployeeId, rightEmployeeId]],
  );
  if (result.rows.length !== 2) {
    throw new ShiftSwapError(409, "SHIFT_SWAP_EMPLOYEE_INACTIVE", "Salah satu pegawai sudah tidak aktif.");
  }
  const [left, right] = result.rows;
  if (!left?.unitId || left.unitId !== right?.unitId) {
    throw new ShiftSwapError(
      409,
      "SHIFT_SWAP_UNIT_CHANGED",
      "Pegawai tidak lagi berada pada unit yang sama.",
    );
  }
}

async function weekStartFor(db: Pool | PoolClient, workDate: string) {
  const result = await db.query<{ weekStart: string }>(
    `SELECT date_trunc('week', $1::date)::date::text AS "weekStart"`,
    [workDate],
  );
  const weekStart = result.rows[0]?.weekStart;
  if (!weekStart) throw new Error("Could not resolve roster week start");
  return weekStart;
}

async function publishSwapRoster(
  client: PoolClient,
  request: ShiftSwapRow,
  actorAccountId: string,
) {
  const weekStart = await weekStartFor(client, request.workDate);
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`attendance-roster-week:${weekStart}`],
  );

  const draft = await client.query<{ id: string }>(
    `SELECT id
     FROM attendance_rosters
     WHERE week_start = $1::date AND status = 'DRAFT'
     LIMIT 1`,
    [weekStart],
  );
  if (draft.rows[0]) {
    throw new ShiftSwapError(
      409,
      "SHIFT_SWAP_ROSTER_DRAFT_EXISTS",
      "Ada draft roster pada minggu ini. Selesaikan atau publish draft tersebut sebelum menyetujui tukar shift.",
    );
  }

  const latest = await client.query<{ id: string; version: number }>(
    `SELECT id, version
     FROM attendance_rosters
     WHERE week_start = $1::date AND status = 'PUBLISHED'
     ORDER BY version DESC
     LIMIT 1
     FOR UPDATE`,
    [weekStart],
  );
  const latestRoster = latest.rows[0] ?? null;
  const nextVersion = (latestRoster?.version ?? 0) + 1;
  const rosterId = randomUUID();

  await client.query(
    `INSERT INTO attendance_rosters (
       id, week_start, version, status,
       created_by_account_id, published_by_account_id, published_at, updated_at
     ) VALUES ($1, $2::date, $3, 'PUBLISHED', $4, $4, now(), now())`,
    [rosterId, weekStart, nextVersion, actorAccountId],
  );

  if (latestRoster) {
    await client.query(
      `INSERT INTO attendance_roster_entries (
         roster_id, employee_id, work_date, schedule_template_id,
         schedule_version_id, is_off, note
       )
       SELECT $1, employee_id, work_date, schedule_template_id,
              schedule_version_id, is_off, note
       FROM attendance_roster_entries
       WHERE roster_id = $2`,
      [rosterId, latestRoster.id],
    );
  }

  await client.query(
    `INSERT INTO attendance_roster_entries (
       roster_id, employee_id, work_date, schedule_template_id,
       schedule_version_id, is_off, note
     ) VALUES
       ($1, $2, $4::date, $5, $6, false, $9),
       ($1, $3, $4::date, $7, $8, false, $10)
     ON CONFLICT (roster_id, employee_id, work_date) DO UPDATE SET
       schedule_template_id = EXCLUDED.schedule_template_id,
       schedule_version_id = EXCLUDED.schedule_version_id,
       is_off = false,
       note = EXCLUDED.note`,
    [
      rosterId,
      request.requesterEmployeeId,
      request.counterpartEmployeeId,
      request.workDate,
      request.counterpartScheduleTemplateId,
      request.counterpartScheduleVersionId,
      request.requesterScheduleTemplateId,
      request.requesterScheduleVersionId,
      `Shift swap ${request.id}: menerima shift counterpart`,
      `Shift swap ${request.id}: menerima shift requester`,
    ],
  );

  return { rosterId, version: nextVersion, weekStart };
}

export async function registerAttendanceShiftSwapRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
) {
  if (!config.AUTH_ENCRYPTION_KEY) {
    throw new Error("AUTH_ENCRYPTION_KEY is required for attendance shift swap routes");
  }
  const auth = new AuthService(
    pool,
    config.AUTH_ENCRYPTION_KEY,
    config.AUTH_SESSION_TTL_HOURS,
    config.NODE_ENV === "production",
  );

  app.get("/attendance/shift-swaps/candidates", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "EMPLOYEE");
    if (!principal) return;
    const query = z.object({ workDate: dateSchema }).safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ code: "INVALID_SHIFT_SWAP_DATE", message: "Tanggal tukar shift tidak valid." });
    }
    try {
      if (query.data.workDate < jakartaWorkDate()) {
        throw new ShiftSwapError(409, "SHIFT_SWAP_DATE_PAST", "Tukar shift tidak dapat diajukan untuk tanggal yang sudah lewat.");
      }
      const requester = await employeeForAccount(pool, principal.id);
      if (!requester.unitId) {
        throw new ShiftSwapError(409, "SHIFT_SWAP_UNIT_REQUIRED", "Pegawai belum memiliki unit organisasi.");
      }
      const requesterSchedule = scheduleSnapshot(
        await resolveSchedule(pool, requester.id, query.data.workDate),
      );
      ensureBeforeEarliestShift(requesterSchedule, requesterSchedule);

      const blocked = await pool.query<{ employeeId: string }>(
        `SELECT requester_employee_id AS "employeeId"
         FROM attendance_shift_swap_requests
         WHERE work_date = $1::date AND status IN ${activeStatusesSql()}
         UNION
         SELECT counterpart_employee_id AS "employeeId"
         FROM attendance_shift_swap_requests
         WHERE work_date = $1::date AND status IN ${activeStatusesSql()}`,
        [query.data.workDate],
      );
      const blockedIds = new Set(blocked.rows.map((item) => item.employeeId));
      const peers = await pool.query<{
        id: string; employeeNumber: string; fullName: string; unitName: string | null;
      }>(
        `SELECT DISTINCT employee.id,
           employee.employee_number AS "employeeNumber",
           employee.full_name AS "fullName",
           unit.name AS "unitName"
         FROM employees employee
         JOIN accounts account
           ON account.employee_id = employee.id
          AND account.principal_type = 'EMPLOYEE'
          AND account.status = 'active'
         LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
         WHERE employee.status = 'active'
           AND employee.organizational_unit_id = $1
           AND employee.id <> $2
         ORDER BY employee.full_name`,
        [requester.unitId, requester.id],
      );

      const candidates = [];
      for (const peer of peers.rows) {
        if (blockedIds.has(peer.id)) continue;
        const resolved = await resolveSchedule(pool, peer.id, query.data.workDate);
        try {
          const schedule = scheduleSnapshot(resolved);
          ensureBeforeEarliestShift(requesterSchedule, schedule);
          if (schedule.scheduleVersionId === requesterSchedule.scheduleVersionId) continue;
          candidates.push({
            ...peer,
            schedule: {
              scheduleTemplateId: schedule.scheduleTemplateId,
              scheduleVersionId: schedule.scheduleVersionId,
              scheduledStartAt: schedule.scheduledStartAt.toISOString(),
              scheduledEndAt: schedule.scheduledEndAt.toISOString(),
            },
          });
        } catch (error) {
          if (error instanceof ShiftSwapError) continue;
          throw error;
        }
      }

      reply.header("Cache-Control", "no-store");
      return reply.send({
        workDate: query.data.workDate,
        requesterSchedule: {
          scheduleTemplateId: requesterSchedule.scheduleTemplateId,
          scheduleVersionId: requesterSchedule.scheduleVersionId,
          scheduledStartAt: requesterSchedule.scheduledStartAt.toISOString(),
          scheduledEndAt: requesterSchedule.scheduledEndAt.toISOString(),
        },
        requesterHasActiveSwap: blockedIds.has(requester.id),
        items: candidates,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/attendance/shift-swaps/me", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "EMPLOYEE");
    if (!principal) return;
    const query = employeeListSchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ code: "INVALID_SHIFT_SWAP_FILTER", message: "Filter tukar shift tidak valid." });
    }
    try {
      const employee = await employeeForAccount(pool, principal.id);
      const values: unknown[] = [employee.id];
      let statusClause = "";
      if (query.data.status === "active") {
        statusClause = `AND request.status IN ${activeStatusesSql()}`;
      } else if (query.data.status !== "all") {
        values.push(query.data.status);
        statusClause = `AND request.status = $${values.length}`;
      }
      const rows = await pool.query<Record<string, unknown>>(
        `${requestSelect}
         WHERE (request.requester_employee_id = $1 OR request.counterpart_employee_id = $1)
         ${statusClause}
         ORDER BY request.work_date DESC, request.created_at DESC
         LIMIT 200`,
        values,
      );
      reply.header("Cache-Control", "no-store");
      return reply.send({
        employeeId: employee.id,
        items: rows.rows.map(rowResponse),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/attendance/shift-swaps", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "EMPLOYEE");
    if (!principal) return;
    const body = createSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ code: "INVALID_SHIFT_SWAP_REQUEST", message: "Pengajuan tukar shift tidak valid." });
    }
    try {
      if (body.data.workDate < jakartaWorkDate()) {
        throw new ShiftSwapError(409, "SHIFT_SWAP_DATE_PAST", "Tukar shift tidak dapat diajukan untuk tanggal yang sudah lewat.");
      }
      const requester = await employeeForAccount(pool, principal.id);
      if (requester.id === body.data.counterpartEmployeeId) {
        throw new ShiftSwapError(400, "SHIFT_SWAP_SELF", "Pegawai tidak dapat menukar shift dengan dirinya sendiri.");
      }

      const client = await pool.connect();
      let id = "";
      try {
        await client.query("BEGIN");
        await lockParticipants(
          client,
          [requester.id, body.data.counterpartEmployeeId],
          body.data.workDate,
        );
        const counterpartResult = await client.query<EmployeeIdentity>(
          `SELECT employee.id, employee.full_name AS "fullName",
             employee.employee_number AS "employeeNumber",
             employee.organizational_unit_id AS "unitId", unit.name AS "unitName"
           FROM employees employee
           JOIN accounts account
             ON account.employee_id = employee.id
            AND account.principal_type = 'EMPLOYEE'
            AND account.status = 'active'
           LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
           WHERE employee.id = $1 AND employee.status = 'active'
           LIMIT 1`,
          [body.data.counterpartEmployeeId],
        );
        const counterpart = counterpartResult.rows[0];
        if (!counterpart) {
          throw new ShiftSwapError(404, "SHIFT_SWAP_COUNTERPART_NOT_FOUND", "Rekan tukar shift aktif tidak ditemukan.");
        }
        if (!requester.unitId || requester.unitId !== counterpart.unitId) {
          throw new ShiftSwapError(409, "SHIFT_SWAP_SAME_UNIT_REQUIRED", "Tukar shift v1 hanya tersedia untuk pegawai dalam unit yang sama.");
        }

        await ensureNoActiveConflict(
          client,
          [requester.id, counterpart.id],
          body.data.workDate,
        );
        const requesterSchedule = scheduleSnapshot(
          await resolveSchedule(client, requester.id, body.data.workDate),
        );
        const counterpartSchedule = scheduleSnapshot(
          await resolveSchedule(client, counterpart.id, body.data.workDate),
        );
        ensureBeforeEarliestShift(requesterSchedule, counterpartSchedule);
        if (requesterSchedule.scheduleVersionId === counterpartSchedule.scheduleVersionId) {
          throw new ShiftSwapError(409, "SHIFT_SWAP_SAME_SCHEDULE", "Kedua pegawai sudah memiliki shift yang sama.");
        }

        id = randomUUID();
        await client.query(
          `INSERT INTO attendance_shift_swap_requests (
             id, requester_employee_id, counterpart_employee_id, work_date,
             requester_schedule_template_id, requester_schedule_version_id, requester_roster_id,
             requester_scheduled_start_at, requester_scheduled_end_at,
             counterpart_schedule_template_id, counterpart_schedule_version_id, counterpart_roster_id,
             counterpart_scheduled_start_at, counterpart_scheduled_end_at,
             note, created_by_account_id
           ) VALUES (
             $1, $2, $3, $4::date,
             $5, $6, $7, $8, $9,
             $10, $11, $12, $13, $14,
             $15, $16
           )`,
          [
            id,
            requester.id,
            counterpart.id,
            body.data.workDate,
            requesterSchedule.scheduleTemplateId,
            requesterSchedule.scheduleVersionId,
            requesterSchedule.rosterId,
            requesterSchedule.scheduledStartAt,
            requesterSchedule.scheduledEndAt,
            counterpartSchedule.scheduleTemplateId,
            counterpartSchedule.scheduleVersionId,
            counterpartSchedule.rosterId,
            counterpartSchedule.scheduledStartAt,
            counterpartSchedule.scheduledEndAt,
            body.data.note ?? null,
            principal.id,
          ],
        );
        await client.query(
          `INSERT INTO attendance_shift_swap_events (
             id, shift_swap_request_id, actor_account_id, event_type, payload
           ) VALUES ($1, $2, $3, 'submitted', $4::jsonb)`,
          [
            randomUUID(),
            id,
            principal.id,
            JSON.stringify({
              requesterScheduleVersionId: requesterSchedule.scheduleVersionId,
              counterpartScheduleVersionId: counterpartSchedule.scheduleVersionId,
            }),
          ],
        );
        await insertAudit(client, principal.id, "attendance.shift_swap.submitted", id, {
          requesterEmployeeId: requester.id,
          counterpartEmployeeId: counterpart.id,
          workDate: body.data.workDate,
        });
        await notifyEmployee(client, counterpart.id, {
          eventKey: `shift-swap:${id}:submitted`,
          category: "attendance",
          title: "Permintaan tukar shift",
          body: `${requester.fullName} meminta tukar shift untuk ${body.data.workDate}.`,
          href: "/app/attendance/shift-swap",
          actorAccountId: principal.id,
          metadata: { shiftSwapId: id, workDate: body.data.workDate },
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return reply.status(201).send({ id, status: "awaiting_counterpart" });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/attendance/shift-swaps/:shiftSwapId/counterpart-decision", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "EMPLOYEE");
    if (!principal) return;
    const params = z.object({ shiftSwapId: z.string().uuid() }).safeParse(request.params);
    const body = counterpartDecisionSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ code: "INVALID_SHIFT_SWAP_DECISION", message: "Keputusan tukar shift tidak valid." });
    }
    try {
      const employee = await employeeForAccount(pool, principal.id);
      const client = await pool.connect();
      let status = "";
      try {
        await client.query("BEGIN");
        const current = await client.query<ShiftSwapRow>(
          `SELECT id,
             requester_employee_id AS "requesterEmployeeId",
             counterpart_employee_id AS "counterpartEmployeeId",
             work_date::text AS "workDate",
             requester_schedule_template_id AS "requesterScheduleTemplateId",
             requester_schedule_version_id AS "requesterScheduleVersionId",
             requester_roster_id AS "requesterRosterId",
             requester_scheduled_start_at AS "requesterScheduledStartAt",
             requester_scheduled_end_at AS "requesterScheduledEndAt",
             counterpart_schedule_template_id AS "counterpartScheduleTemplateId",
             counterpart_schedule_version_id AS "counterpartScheduleVersionId",
             counterpart_roster_id AS "counterpartRosterId",
             counterpart_scheduled_start_at AS "counterpartScheduledStartAt",
             counterpart_scheduled_end_at AS "counterpartScheduledEndAt",
             note, status, counterpart_decision AS "counterpartDecision",
             counterpart_decision_note AS "counterpartDecisionNote",
             counterpart_decided_at AS "counterpartDecidedAt",
             hc_decision AS "hcDecision", hc_decision_note AS "hcDecisionNote",
             hc_decided_at AS "hcDecidedAt", published_roster_id AS "publishedRosterId",
             created_at AS "createdAt", updated_at AS "updatedAt"
           FROM attendance_shift_swap_requests
           WHERE id = $1 AND counterpart_employee_id = $2
           FOR UPDATE`,
          [params.data.shiftSwapId, employee.id],
        );
        const item = current.rows[0];
        if (!item) {
          throw new ShiftSwapError(404, "SHIFT_SWAP_NOT_FOUND", "Pengajuan tukar shift tidak ditemukan.");
        }
        if (item.status !== "awaiting_counterpart") {
          throw new ShiftSwapError(409, "SHIFT_SWAP_ALREADY_DECIDED", "Tahap persetujuan rekan sudah berubah.");
        }
        ensureBeforeEarliestShift(
          { scheduledStartAt: item.requesterScheduledStartAt },
          { scheduledStartAt: item.counterpartScheduledStartAt },
        );
        status = body.data.decision === "accept" ? "awaiting_hc" : "rejected_by_counterpart";
        const counterpartDecision = body.data.decision === "accept" ? "accepted" : "rejected";
        await client.query(
          `UPDATE attendance_shift_swap_requests
           SET status = $2, counterpart_decision = $3,
               counterpart_decided_by_account_id = $4,
               counterpart_decision_note = $5,
               counterpart_decided_at = now(), updated_at = now()
           WHERE id = $1`,
          [item.id, status, counterpartDecision, principal.id, body.data.note ?? null],
        );
        const eventType = body.data.decision === "accept"
          ? "counterpart_accepted"
          : "counterpart_rejected";
        await client.query(
          `INSERT INTO attendance_shift_swap_events (
             id, shift_swap_request_id, actor_account_id, event_type, payload
           ) VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [randomUUID(), item.id, principal.id, eventType, JSON.stringify({ note: body.data.note ?? null })],
        );
        await insertAudit(client, principal.id, `attendance.shift_swap.${eventType}`, item.id, {});
        await notifyEmployee(client, item.requesterEmployeeId, {
          eventKey: `shift-swap:${item.id}:${eventType}`,
          category: "attendance",
          title: body.data.decision === "accept" ? "Rekan menyetujui tukar shift" : "Rekan menolak tukar shift",
          body: body.data.decision === "accept"
            ? `Rekan Anda menyetujui tukar shift ${item.workDate}. Menunggu keputusan Human Capital.`
            : `Rekan Anda menolak tukar shift ${item.workDate}.`,
          href: "/app/attendance/shift-swap",
          actorAccountId: principal.id,
          metadata: { shiftSwapId: item.id, workDate: item.workDate },
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return reply.send({ id: params.data.shiftSwapId, status });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/attendance/shift-swaps/:shiftSwapId/cancel", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "EMPLOYEE");
    if (!principal) return;
    const params = z.object({ shiftSwapId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ code: "INVALID_SHIFT_SWAP_REQUEST", message: "Pengajuan tukar shift tidak valid." });
    }
    try {
      const employee = await employeeForAccount(pool, principal.id);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const changed = await client.query<{ id: string; counterpartEmployeeId: string; workDate: string }>(
          `UPDATE attendance_shift_swap_requests
           SET status = 'cancelled', updated_at = now()
           WHERE id = $1
             AND requester_employee_id = $2
             AND status IN ${activeStatusesSql()}
           RETURNING id, counterpart_employee_id AS "counterpartEmployeeId", work_date::text AS "workDate"`,
          [params.data.shiftSwapId, employee.id],
        );
        if (!changed.rows[0]) {
          throw new ShiftSwapError(409, "SHIFT_SWAP_NOT_CANCELLABLE", "Pengajuan tukar shift tidak dapat dibatalkan.");
        }
        await client.query(
          `INSERT INTO attendance_shift_swap_events (
             id, shift_swap_request_id, actor_account_id, event_type, payload
           ) VALUES ($1, $2, $3, 'cancelled', '{}'::jsonb)`,
          [randomUUID(), params.data.shiftSwapId, principal.id],
        );
        await insertAudit(client, principal.id, "attendance.shift_swap.cancelled", params.data.shiftSwapId, {});
        await notifyEmployee(client, changed.rows[0]!.counterpartEmployeeId, {
          eventKey: `shift-swap:${params.data.shiftSwapId}:cancelled`,
          category: "attendance",
          title: "Tukar shift dibatalkan",
          body: `Pengajuan tukar shift ${changed.rows[0]!.workDate} dibatalkan oleh pemohon.`,
          href: "/app/attendance/shift-swap",
          actorAccountId: principal.id,
          metadata: { shiftSwapId: params.data.shiftSwapId, workDate: changed.rows[0]!.workDate },
        });
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

  app.get("/admin/attendance/shift-swaps", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.shift_swap.manage");
    if (!principal) return;
    const query = adminListSchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ code: "INVALID_SHIFT_SWAP_FILTER", message: "Filter tukar shift tidak valid." });
    }
    const values: unknown[] = [];
    let clause = "";
    if (query.data.status !== "all") {
      values.push(query.data.status);
      clause = `WHERE request.status = $1`;
    }
    const rows = await pool.query<Record<string, unknown>>(
      `${requestSelect}
       ${clause}
       ORDER BY
         CASE request.status WHEN 'awaiting_hc' THEN 0 WHEN 'awaiting_counterpart' THEN 1 ELSE 2 END,
         request.work_date, request.created_at
       LIMIT 500`,
      values,
    );
    reply.header("Cache-Control", "no-store");
    return reply.send({ items: rows.rows.map(rowResponse) });
  });

  app.post("/admin/attendance/shift-swaps/:shiftSwapId/decision", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.shift_swap.manage");
    if (!principal) return;
    const params = z.object({ shiftSwapId: z.string().uuid() }).safeParse(request.params);
    const body = hcDecisionSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ code: "INVALID_SHIFT_SWAP_DECISION", message: "Keputusan tukar shift tidak valid." });
    }

    const client = await pool.connect();
    let approvedRequest: ShiftSwapRow | null = null;
    let roster: { rosterId: string; version: number; weekStart: string } | null = null;
    try {
      await client.query("BEGIN");
      const current = await client.query<ShiftSwapRow>(
        `SELECT id,
           requester_employee_id AS "requesterEmployeeId",
           counterpart_employee_id AS "counterpartEmployeeId",
           work_date::text AS "workDate",
           requester_schedule_template_id AS "requesterScheduleTemplateId",
           requester_schedule_version_id AS "requesterScheduleVersionId",
           requester_roster_id AS "requesterRosterId",
           requester_scheduled_start_at AS "requesterScheduledStartAt",
           requester_scheduled_end_at AS "requesterScheduledEndAt",
           counterpart_schedule_template_id AS "counterpartScheduleTemplateId",
           counterpart_schedule_version_id AS "counterpartScheduleVersionId",
           counterpart_roster_id AS "counterpartRosterId",
           counterpart_scheduled_start_at AS "counterpartScheduledStartAt",
           counterpart_scheduled_end_at AS "counterpartScheduledEndAt",
           note, status, counterpart_decision AS "counterpartDecision",
           counterpart_decision_note AS "counterpartDecisionNote",
           counterpart_decided_at AS "counterpartDecidedAt",
           hc_decision AS "hcDecision", hc_decision_note AS "hcDecisionNote",
           hc_decided_at AS "hcDecidedAt", published_roster_id AS "publishedRosterId",
           created_at AS "createdAt", updated_at AS "updatedAt"
         FROM attendance_shift_swap_requests
         WHERE id = $1
         FOR UPDATE`,
        [params.data.shiftSwapId],
      );
      const item = current.rows[0];
      if (!item) {
        throw new ShiftSwapError(404, "SHIFT_SWAP_NOT_FOUND", "Pengajuan tukar shift tidak ditemukan.");
      }
      if (item.status !== "awaiting_hc" || item.counterpartDecision !== "accepted") {
        throw new ShiftSwapError(409, "SHIFT_SWAP_NOT_AWAITING_HC", "Pengajuan belum siap atau sudah diputuskan.");
      }

      ensureBeforeEarliestShift(
        { scheduledStartAt: item.requesterScheduledStartAt },
        { scheduledStartAt: item.counterpartScheduledStartAt },
      );
      await currentSameUnitEmployees(
        client,
        item.requesterEmployeeId,
        item.counterpartEmployeeId,
      );

      if (body.data.decision === "reject") {
        await client.query(
          `UPDATE attendance_shift_swap_requests
           SET status = 'rejected_by_hc', hc_decision = 'rejected',
               hc_decided_by_account_id = $2, hc_decision_note = $3,
               hc_decided_at = now(), updated_at = now()
           WHERE id = $1`,
          [item.id, principal.id, body.data.note ?? null],
        );
        await client.query(
          `INSERT INTO attendance_shift_swap_events (
             id, shift_swap_request_id, actor_account_id, event_type, payload
           ) VALUES ($1, $2, $3, 'hc_rejected', $4::jsonb)`,
          [randomUUID(), item.id, principal.id, JSON.stringify({ note: body.data.note ?? null })],
        );
        await insertAudit(client, principal.id, "attendance.shift_swap.hc_rejected", item.id, {});
        await notifyEmployee(client, item.requesterEmployeeId, {
          eventKey: `shift-swap:${item.id}:hc_rejected:requester`,
          category: "attendance",
          title: "Tukar shift ditolak Human Capital",
          body: `Tukar shift ${item.workDate} tidak disetujui Human Capital.`,
          href: "/app/attendance/shift-swap",
          actorAccountId: principal.id,
          metadata: { shiftSwapId: item.id, workDate: item.workDate },
        });
        await notifyEmployee(client, item.counterpartEmployeeId, {
          eventKey: `shift-swap:${item.id}:hc_rejected:counterpart`,
          category: "attendance",
          title: "Tukar shift ditolak Human Capital",
          body: `Tukar shift ${item.workDate} tidak disetujui Human Capital.`,
          href: "/app/attendance/shift-swap",
          actorAccountId: principal.id,
          metadata: { shiftSwapId: item.id, workDate: item.workDate },
        });
        await client.query("COMMIT");
        return reply.send({ id: item.id, status: "rejected_by_hc" });
      }

      await lockParticipants(
        client,
        [item.requesterEmployeeId, item.counterpartEmployeeId],
        item.workDate,
      );
      await ensureNoActiveConflict(
        client,
        [item.requesterEmployeeId, item.counterpartEmployeeId],
        item.workDate,
        item.id,
      );

      const requesterCurrent = scheduleSnapshot(
        await resolveSchedule(client, item.requesterEmployeeId, item.workDate),
      );
      const counterpartCurrent = scheduleSnapshot(
        await resolveSchedule(client, item.counterpartEmployeeId, item.workDate),
      );
      if (
        requesterCurrent.scheduleVersionId !== item.requesterScheduleVersionId ||
        counterpartCurrent.scheduleVersionId !== item.counterpartScheduleVersionId
      ) {
        throw new ShiftSwapError(
          409,
          "SHIFT_SWAP_STALE_SCHEDULE",
          "Jadwal salah satu pegawai sudah berubah sejak pengajuan. Buat pengajuan baru.",
        );
      }
      ensureBeforeEarliestShift(requesterCurrent, counterpartCurrent);

      roster = await publishSwapRoster(client, item, principal.id);
      await client.query(
        `UPDATE attendance_shift_swap_requests
         SET status = 'approved', hc_decision = 'approved',
             hc_decided_by_account_id = $2, hc_decision_note = $3,
             hc_decided_at = now(), published_roster_id = $4, updated_at = now()
         WHERE id = $1`,
        [item.id, principal.id, body.data.note ?? null, roster.rosterId],
      );
      await client.query(
        `INSERT INTO attendance_shift_swap_events (
           id, shift_swap_request_id, actor_account_id, event_type, payload
         ) VALUES ($1, $2, $3, 'hc_approved', $4::jsonb)`,
        [
          randomUUID(),
          item.id,
          principal.id,
          JSON.stringify({
            rosterId: roster.rosterId,
            rosterVersion: roster.version,
            note: body.data.note ?? null,
          }),
        ],
      );
      await insertAudit(client, principal.id, "attendance.shift_swap.hc_approved", item.id, {
        rosterId: roster.rosterId,
        rosterVersion: roster.version,
      });
      await notifyEmployee(client, item.requesterEmployeeId, {
        eventKey: `shift-swap:${item.id}:hc_approved:requester`,
        category: "attendance",
        title: "Tukar shift disetujui",
        body: `Tukar shift ${item.workDate} disetujui dan roster baru sudah dipublish.`,
        href: "/app/attendance/shift-swap",
        actorAccountId: principal.id,
        metadata: { shiftSwapId: item.id, workDate: item.workDate, rosterId: roster.rosterId },
      });
      await notifyEmployee(client, item.counterpartEmployeeId, {
        eventKey: `shift-swap:${item.id}:hc_approved:counterpart`,
        category: "attendance",
        title: "Tukar shift disetujui",
        body: `Tukar shift ${item.workDate} disetujui dan roster baru sudah dipublish.`,
        href: "/app/attendance/shift-swap",
        actorAccountId: principal.id,
        metadata: { shiftSwapId: item.id, workDate: item.workDate, rosterId: roster.rosterId },
      });
      approvedRequest = item;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      return sendError(reply, error);
    } finally {
      client.release();
    }

    if (!approvedRequest || !roster) {
      throw new Error("Approved shift swap did not produce roster state");
    }
    const recomputed = await Promise.allSettled([
      materializeAttendanceResult(
        pool,
        approvedRequest.requesterEmployeeId,
        approvedRequest.workDate,
      ),
      materializeAttendanceResult(
        pool,
        approvedRequest.counterpartEmployeeId,
        approvedRequest.workDate,
      ),
    ]);
    return reply.send({
      id: approvedRequest.id,
      status: "approved",
      roster,
      recomputed: recomputed.map((item) => item.status === "fulfilled"),
    });
  });
}
