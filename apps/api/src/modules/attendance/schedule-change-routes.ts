import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import type { AuthPrincipal } from "../auth/service.js";
import { jakartaWorkDate, materializeAttendanceResult } from "./engine.js";
import {
  addDays,
  applyScheduleChange,
  planScheduleChange,
  ScheduleChangeError,
  type ScheduleChangeInput,
  type ScheduleChangePlan,
} from "./schedule-changes.js";

// ATT-011-4b §5.3: Perubahan Jadwal routes. Preview plans without writing; apply re-plans under locks and
// refuses on any difference from the preview. Everything needs attendance.schedule.manage.

// A real calendar date: 2026-02-30 would roll over in JavaScript and then fail in PostgreSQL.
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value);
const mondaySchema = dateSchema.refine((value) => new Date(`${value}T00:00:00Z`).getUTCDay() === 1, "Harus hari Senin.");
const scope = {
  employeeIds: z.array(z.string().uuid()).max(500).optional(),
  unitId: z.string().uuid().nullable().optional(),
  excludeEmployeeIds: z.array(z.string().uuid()).max(500).optional(),
  workOnHolidays: z.boolean().optional(),
  note: z.string().trim().max(500).nullable().optional(),
};
const inputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("pattern"), ...scope,
    scheduleTemplateId: z.string().uuid().nullable(),
    from: dateSchema, to: dateSchema.nullable(),
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    untickedDays: z.enum(["off", "keep"]),
  }).strict(),
  z.object({
    kind: z.literal("replacement"), ...scope,
    scheduleTemplateId: z.string().uuid().nullable(),
    from: dateSchema, to: dateSchema,
  }).strict(),
  z.object({
    kind: z.literal("copy"), ...scope,
    sourceWeekStart: mondaySchema,
    targetWeekStarts: z.array(mondaySchema).min(1).max(8),
  }).strict(),
]).superRefine((value, context) => {
  if (!value.employeeIds?.length && !value.unitId) context.addIssue({ code: "custom", message: "Pilih unit atau pegawai." });
  if (value.kind === "replacement" && !value.note) context.addIssue({ code: "custom", message: "Keterangan wajib untuk Ganti jadwal." });
  if (value.kind !== "copy" && value.to !== null && value.to < value.from) context.addIssue({ code: "custom", message: "Tanggal selesai sebelum tanggal mulai." });
  if (value.kind === "pattern" && !value.scheduleTemplateId && value.untickedDays === "keep") {
    context.addIssue({ code: "custom", message: "Pola tanpa shift berarti libur di semua hari; pilih Libur untuk hari lain." });
  }
  if (value.kind === "copy" && new Set(value.targetWeekStarts).size !== value.targetWeekStarts.length) {
    context.addIssue({ code: "custom", message: "Minggu tujuan tidak boleh berulang." });
  }
  if (value.kind === "copy" && value.targetWeekStarts.includes(value.sourceWeekStart)) {
    context.addIssue({ code: "custom", message: "Minggu tujuan tidak boleh sama dengan minggu sumber." });
  }
});
const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

type Authenticate = (request: FastifyRequest, reply: FastifyReply) => Promise<AuthPrincipal | null>;
/** `manage`: attendance.schedule.manage. `read`: that or attendance.reports.read (D-1, read-only calendar). */
export type ScheduleChangeAuth = { manage: Authenticate; read: Authenticate };

const PREVIEW_ROWS = 200;

function invalid(reply: FastifyReply, error: z.ZodError) {
  return reply.status(400).send({
    code: "INVALID_SCHEDULE_CHANGE",
    message: error.issues.find((issue) => issue.code === "custom")?.message ?? "Perubahan jadwal tidak valid.",
  });
}

async function sendChangeError(reply: FastifyReply, error: unknown) {
  // A roster version or idempotency key written meanwhile by another request: the same as a stale preview.
  if ((error as { code?: unknown } | null)?.code === "23505") {
    error = new ScheduleChangeError(409, "SCHEDULE_CHANGED_SINCE_PREVIEW", "Jadwal sudah diubah orang lain. Lihat dampak lagi.");
  }
  if (!(error instanceof ScheduleChangeError)) throw error;
  // §5.5: conflicts change nothing, but are logged (code only, no personal data).
  if (error.statusCode === 409) reply.log.info({ code: error.code }, "schedule change conflict");
  reply.header("Cache-Control", "no-store");
  return reply.status(error.statusCode).send({
    code: error.code, message: error.message, ...(error.details === undefined ? {} : { issues: error.details }),
  });
}

/** What the preview shows: totals, problems, and per employee how many days or patterns change. */
function previewResponse(plan: ScheduleChangePlan) {
  const perEmployee = new Map<string, number>();
  for (const op of plan.ops) perEmployee.set(op.employeeId, (perEmployee.get(op.employeeId) ?? 0) + 1);
  return {
    fingerprint: plan.fingerprint,
    summary: plan.summary,
    issues: plan.issues,
    holidays: plan.holidays,
    weeks: plan.weeks,
    // §5.3: at most 200 detail rows plus the total.
    employees: plan.employees.slice(0, PREVIEW_ROWS).map((employee) => ({
      id: employee.id, employeeNumber: employee.employeeNumber, fullName: employee.fullName, changes: perEmployee.get(employee.id) ?? 0,
    })),
    employeesTotal: plan.employees.length,
  };
}

export function registerScheduleChangeRoutes(app: FastifyInstance, pool: Pool, authenticate: ScheduleChangeAuth) {
  const manage = authenticate.manage;
  const read = authenticate.read;
  app.post("/admin/attendance/schedule-changes/preview", async (request, reply) => {
    const principal = await manage(request, reply);
    if (!principal) return;
    const body = inputSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    reply.header("Cache-Control", "no-store");
    try {
      return reply.send(previewResponse(await planScheduleChange(pool, body.data as ScheduleChangeInput)));
    } catch (error) {
      return sendChangeError(reply, error);
    }
  });

  app.post("/admin/attendance/schedule-changes", async (request, reply) => {
    const principal = await manage(request, reply);
    if (!principal) return;
    const body = z.object({ change: inputSchema, previewFingerprint: z.string().regex(/^[0-9a-f]{64}$/) }).strict().safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const idempotencyKey = typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : null;
    if (idempotencyKey !== null && (idempotencyKey.length < 8 || idempotencyKey.length > 128)) {
      return reply.status(400).send({ code: "INVALID_IDEMPOTENCY_KEY", message: "Idempotency-Key tidak valid." });
    }
    reply.header("Cache-Control", "no-store");
    const client = await pool.connect();
    let applied: Awaited<ReturnType<typeof applyScheduleChange>>;
    try {
      await client.query("BEGIN");
      applied = await applyScheduleChange(client, body.data.change as ScheduleChangeInput, body.data.previewFingerprint, principal.id, idempotencyKey);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      return sendChangeError(reply, error);
    } finally {
      client.release();
    }
    // §5.3 step 5: only today can already have a result (past dates are refused); refresh it now.
    // Best effort after commit, like the shift swap: a failure leaves the result to the next calculation.
    let recalculated = 0;
    if (!applied.replayed && applied.summary?.from === jakartaWorkDate()) {
      for (const employeeId of applied.employeeIds) {
        try {
          await materializeAttendanceResult(pool, employeeId, applied.summary.from);
          recalculated += 1;
        } catch (error) {
          request.log.warn({ err: error, changeSetId: applied.id }, "schedule change recalculation failed");
        }
      }
    }
    return reply.status(applied.replayed ? 200 : 201).send({ id: applied.id, replayed: applied.replayed, summary: applied.summary, recalculated });
  });

  app.get("/admin/attendance/schedule-changes", async (request, reply) => {
    const principal = await read(request, reply);
    if (!principal) return;
    const query = pageSchema.extend({ employeeId: z.string().uuid().optional() }).safeParse(request.query);
    if (!query.success) return invalid(reply, query.error);
    const { page, pageSize, employeeId } = query.data;
    const result = await pool.query(
      `SELECT change_set.id, change_set.kind, change_set.applied_at AS "appliedAt", change_set.note,
         change_set.scope_summary AS "summary", change_set.reverts_change_set_id AS "revertsChangeSetId",
         account.email AS "requestedBy", count(*) OVER ()::int AS total
       FROM attendance_schedule_change_sets change_set
       LEFT JOIN accounts account ON account.id = change_set.requested_by_account_id
       WHERE $1::uuid IS NULL OR EXISTS (
         SELECT 1 FROM attendance_schedule_change_items item WHERE item.change_set_id = change_set.id AND item.employee_id = $1
       )
       ORDER BY change_set.applied_at DESC, change_set.id DESC
       LIMIT $2 OFFSET $3`,
      [employeeId ?? null, pageSize, (page - 1) * pageSize],
    );
    reply.header("Cache-Control", "no-store");
    return reply.send({
      items: result.rows.map(({ total, ...row }) => { void total; return row; }),
      page, pageSize, total: result.rows[0]?.total ?? (page > 1 ? await countChangeSets(pool, employeeId ?? null) : 0),
    });
  });

  app.get("/admin/attendance/schedule-changes/:changeSetId", async (request, reply) => {
    const principal = await read(request, reply);
    if (!principal) return;
    const params = z.object({ changeSetId: z.string().uuid() }).safeParse(request.params);
    const query = pageSchema.safeParse(request.query);
    if (!params.success) return reply.status(400).send({ code: "INVALID_SCHEDULE_CHANGE", message: "Perubahan jadwal tidak valid." });
    if (!query.success) return invalid(reply, query.error);
    const changeSet = await pool.query(
      `SELECT change_set.id, change_set.kind, change_set.applied_at AS "appliedAt", change_set.note, change_set.input,
         change_set.scope_summary AS "summary", change_set.reverts_change_set_id AS "revertsChangeSetId", account.email AS "requestedBy"
       FROM attendance_schedule_change_sets change_set
       LEFT JOIN accounts account ON account.id = change_set.requested_by_account_id
       WHERE change_set.id = $1`,
      [params.data.changeSetId],
    );
    if (!changeSet.rows[0]) return reply.status(404).send({ code: "SCHEDULE_CHANGE_NOT_FOUND", message: "Perubahan jadwal tidak ditemukan." });
    const { page, pageSize } = query.data;
    const items = await pool.query(
      `SELECT item.sequence, item.action, item.employee_id AS "employeeId", employee.full_name AS "employeeName",
         item.work_date_from::text AS "from", item.work_date_to::text AS "to", item.weekday_mask AS "weekdayMask",
         item.schedule_template_id AS "scheduleTemplateId", schedule.name AS "scheduleName",
         item.before_state AS "before", item.after_state AS "after", count(*) OVER ()::int AS total
       FROM attendance_schedule_change_items item
       JOIN employees employee ON employee.id = item.employee_id
       LEFT JOIN attendance_schedule_templates schedule ON schedule.id = item.schedule_template_id
       WHERE item.change_set_id = $1
       ORDER BY item.sequence
       LIMIT $2 OFFSET $3`,
      [params.data.changeSetId, pageSize, (page - 1) * pageSize],
    );
    reply.header("Cache-Control", "no-store");
    return reply.send({
      ...changeSet.rows[0],
      items: items.rows.map(({ total, ...row }) => { void total; return row; }),
      page, pageSize, total: items.rows[0]?.total ?? (page > 1 ? (await pool.query<{ total: number }>(
        "SELECT count(*)::int AS total FROM attendance_schedule_change_items WHERE change_set_id = $1", [params.data.changeSetId],
      )).rows[0]?.total ?? 0 : 0),
    });
  });

  // §5.1 Jadwal calendar: the schedule in force per employee and date, resolved like the engine
  // (published roster > calendar holiday > pattern), for one page of employees.
  app.get("/admin/attendance/schedule-calendar", async (request, reply) => {
    const principal = await read(request, reply);
    if (!principal) return;
    const query = z.object({
      from: dateSchema, to: dateSchema,
      unitId: z.string().uuid().optional(),
      q: z.string().trim().max(100).optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(50).default(50),
    }).safeParse(request.query);
    if (!query.success) return invalid(reply, query.error);
    const { from, to, unitId, q, page, pageSize } = query.data;
    if (to < from || addDays(from, 41) < to) {
      return reply.status(400).send({ code: "INVALID_SCHEDULE_CALENDAR_RANGE", message: "Rentang kalender 1 sampai 42 hari." });
    }
    const employees = await pool.query<{ id: string; employeeNumber: string; fullName: string; unitName: string | null; total: number }>(
      `SELECT employee.id, employee.employee_number AS "employeeNumber", employee.full_name AS "fullName",
         unit.name AS "unitName", count(*) OVER ()::int AS total
       FROM employees employee
       LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
       WHERE employee.status = 'active'
         AND ($1::uuid IS NULL OR employee.organizational_unit_id = $1)
         AND ($2::text IS NULL OR employee.full_name ILIKE '%' || $2 || '%' OR employee.employee_number ILIKE '%' || $2 || '%')
       ORDER BY employee.full_name, employee.id
       LIMIT $3 OFFSET $4`,
      [unitId ?? null, q ? q.replace(/[\\%_]/g, (character) => `\\${character}`) : null, pageSize, (page - 1) * pageSize],
    );
    const ids = employees.rows.map((row) => row.id);
    const days = await pool.query<{ employeeId: string; date: string; source: string; scheduleTemplateId: string | null; changeSetId: string | null }>(
      `WITH days AS (
         SELECT day::date AS work_date FROM generate_series($2::date, $3::date, interval '1 day') day
       ), rosters AS (
         SELECT DISTINCT ON (week_start) id, week_start, change_set_id
         FROM attendance_rosters
         WHERE status = 'PUBLISHED' AND week_start BETWEEN date_trunc('week', $2::date)::date AND $3::date
         ORDER BY week_start, version DESC
       )
       SELECT person.id AS "employeeId", days.work_date::text AS date,
         CASE
           WHEN entry.roster_id IS NOT NULL AND entry.is_off THEN 'roster_off'
           WHEN entry.roster_id IS NOT NULL THEN 'roster'
           WHEN holiday.calendar_date IS NOT NULL THEN 'holiday'
           WHEN assigned.count > 1 THEN 'conflict'
           WHEN assigned.count = 1 THEN 'pattern'
           ELSE 'off'
         END AS source,
         CASE WHEN entry.roster_id IS NOT NULL THEN entry.schedule_template_id
              WHEN holiday.calendar_date IS NULL AND assigned.count = 1 THEN assigned.template_id END AS "scheduleTemplateId",
         -- A roster cell carried over from an older version is not this change set's doing.
         CASE WHEN entry.roster_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM attendance_schedule_change_items item
                WHERE item.change_set_id = rosters.change_set_id AND item.employee_id = person.id AND item.work_date_from = days.work_date
              ) THEN rosters.change_set_id
              WHEN entry.roster_id IS NULL AND holiday.calendar_date IS NULL AND assigned.count = 1 THEN assigned.change_set_id END AS "changeSetId"
       FROM unnest($1::uuid[]) AS person(id)
       CROSS JOIN days
       LEFT JOIN rosters ON rosters.week_start = date_trunc('week', days.work_date)::date
       LEFT JOIN attendance_roster_entries entry
         ON entry.roster_id = rosters.id AND entry.employee_id = person.id AND entry.work_date = days.work_date
       LEFT JOIN leave_calendar_exceptions holiday ON holiday.calendar_date = days.work_date AND NOT holiday.is_working_day
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS count, (array_agg(assignment.schedule_template_id))[1] AS template_id,
           (array_agg(assignment.change_set_id))[1] AS change_set_id
         FROM attendance_schedule_assignments assignment
         JOIN attendance_schedule_templates schedule ON schedule.id = assignment.schedule_template_id AND schedule.active
         WHERE assignment.employee_id = person.id
           AND days.work_date >= assignment.effective_from
           AND (assignment.effective_to IS NULL OR days.work_date <= assignment.effective_to)
           AND (assignment.weekday_mask & (1 << (extract(isodow from days.work_date)::int - 1))) <> 0
           -- Like the engine: a pattern counts only while its shift has a version valid that day.
           AND EXISTS (
             SELECT 1 FROM attendance_schedule_versions version
             WHERE version.schedule_template_id = assignment.schedule_template_id
               AND version.effective_from <= ((days.work_date + time '12:00') AT TIME ZONE 'Asia/Jakarta')
               AND (version.effective_to IS NULL OR version.effective_to > ((days.work_date + time '12:00') AT TIME ZONE 'Asia/Jakarta'))
           )
       ) assigned ON true
       ORDER BY person.id, days.work_date`,
      [ids, from, to],
    );
    const shifts = await pool.query(
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
    );
    const holidays = await pool.query(
      `SELECT calendar_date::text AS date, label FROM leave_calendar_exceptions
       WHERE NOT is_working_day AND calendar_date BETWEEN $1::date AND $2::date ORDER BY calendar_date`,
      [from, to],
    );
    const byEmployee = new Map<string, typeof days.rows>();
    for (const row of days.rows) byEmployee.set(row.employeeId, [...(byEmployee.get(row.employeeId) ?? []), row]);
    reply.header("Cache-Control", "no-store");
    return reply.send({
      from, to, page, pageSize,
      total: employees.rows[0]?.total ?? (page > 1 ? (await pool.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM employees employee
         WHERE employee.status = 'active' AND ($1::uuid IS NULL OR employee.organizational_unit_id = $1)
           AND ($2::text IS NULL OR employee.full_name ILIKE '%' || $2 || '%' OR employee.employee_number ILIKE '%' || $2 || '%')`,
        [unitId ?? null, q ? q.replace(/[\\%_]/g, (character) => `\\${character}`) : null],
      )).rows[0]?.total ?? 0 : 0),
      employees: employees.rows.map(({ total, ...employee }) => {
        void total;
        return { ...employee, days: (byEmployee.get(employee.id) ?? []).map(({ employeeId, ...day }) => { void employeeId; return day; }) };
      }),
      shifts: shifts.rows,
      holidays: holidays.rows,
    });
  });
}

async function countChangeSets(pool: Pool, employeeId: string | null) {
  const result = await pool.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM attendance_schedule_change_sets change_set
     WHERE $1::uuid IS NULL OR EXISTS (
       SELECT 1 FROM attendance_schedule_change_items item WHERE item.change_set_id = change_set.id AND item.employee_id = $1
     )`,
    [employeeId],
  );
  return result.rows[0]?.total ?? 0;
}
