import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import { pageOffset, pageQuerySchema, pagination } from "../../lib/pagination.js";
import type { AuthPrincipal } from "../auth/service.js";
import { PostgresOrganizationRepository } from "../organization/repository.js";
import { searchPositions } from "../organization/structure-lookups.js";
import { jakartaWorkDate, materializeAttendanceResult } from "./engine.js";
import { DEFAULT_OVERTIME_POLICY, overtimePolicyOn } from "./overtime-rules.js";

// ATT-011-6b-3 Pengaturan > Aturan lembur (§7.7, §7.8). Everything needs attendance.policy.manage.
// Rules are added and ended, never edited or deleted (the table refuses it too); thresholds are new
// effective-dated versions. Both are audited in access_audit_events.

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value);

type Authenticate = (request: FastifyRequest, reply: FastifyReply) => Promise<AuthPrincipal | null>;

class OvertimeRuleError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

const addDays = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

const RULE_COLUMNS = `rule.id, rule.target_kind AS "targetKind", rule.target_ref AS "targetRef", rule.target_label AS "targetLabel",
  rule.effect, rule.reason_label AS "reasonLabel", rule.effective_from::text AS "effectiveFrom",
  rule.effective_to::text AS "effectiveTo", rule.created_at AS "createdAt", rule.ended_at AS "endedAt",
  rule.end_reason AS "endReason", creator.full_name AS "createdByName", ender.full_name AS "endedByName"`;
const RULE_JOINS = `LEFT JOIN accounts creator_account ON creator_account.id = rule.created_by_account_id
  LEFT JOIN employees creator ON creator.id = creator_account.employee_id
  LEFT JOIN accounts ender_account ON ender_account.id = rule.ended_by_account_id
  LEFT JOIN employees ender ON ender.id = ender_account.employee_id`;

async function audit(db: Pick<PoolClient, "query">, actorAccountId: string, action: string, entityType: string, entityId: string, payload: Record<string, unknown>) {
  await db.query(
    `INSERT INTO access_audit_events (id, actor_account_id, action, entity_type, entity_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [randomUUID(), actorAccountId, action, entityType, entityId, JSON.stringify(payload)],
  );
}

const RECALCULATION_LIMIT = 500;

/**
 * A rule changes which days count overtime from `from` on. Days up to today with approved overtime of the
 * people the rule touches are calculated again so the overtime minutes follow (§7.8); later days are
 * calculated anyway. Added rule: days it now excludes. Ended rule: days whose latest result it excluded.
 * Runs after the rule is committed; a failure is reported, never turned into an error for the rule itself
 * (the day is calculated again by the next Kalkulasi).
 */
async function recalculateApprovedOvertime(pool: Pool, ruleId: string, from: string, change: "added" | "ended") {
  const today = jakartaWorkDate();
  if (from > today) return { recalculatedDays: 0, recalculationIncomplete: false };
  try {
    const days = await pool.query<{ employeeId: string; workDate: string }>(
      `SELECT DISTINCT request.employee_id AS "employeeId", request.work_date::text AS "workDate"
       FROM attendance_overtime_requests request
       WHERE request.status = 'approved' AND request.work_date BETWEEN $1::date AND $2::date
         AND CASE WHEN $4::text = 'added'
           THEN attendance_overtime_excluding_rule(request.employee_id, request.work_date) = $3::uuid
           ELSE EXISTS (
             SELECT 1 FROM attendance_result_versions version
             WHERE version.employee_id = request.employee_id AND version.work_date = request.work_date
               AND version.safe_metadata->>'overtimeExcludedByRuleId' = $3::text)
         END
       ORDER BY 2, 1
       LIMIT ${RECALCULATION_LIMIT + 1}`,
      [from, today, ruleId, change],
    );
    const rows = days.rows.slice(0, RECALCULATION_LIMIT);
    for (const day of rows) await materializeAttendanceResult(pool, day.employeeId, day.workDate);
    return { recalculatedDays: rows.length, recalculationIncomplete: days.rows.length > RECALCULATION_LIMIT };
  } catch {
    return { recalculatedDays: 0, recalculationIncomplete: true };
  }
}

export function registerOvertimeRuleRoutes(app: FastifyInstance, pool: Pool, manage: Authenticate) {
  const fail = (reply: FastifyReply, error: unknown) => {
    if (!(error instanceof OvertimeRuleError)) throw error;
    reply.header("Cache-Control", "no-store");
    return reply.status(error.statusCode).send({ code: error.code, message: error.message });
  };

  app.get("/admin/attendance/overtime-policy", async (request, reply) => {
    if (!(await manage(request, reply))) return;
    const query = pageQuerySchema.safeParse(request.query);
    if (!query.success) return reply.status(400).send({ code: "INVALID_OVERTIME_POLICY_QUERY", message: "Filter aturan lembur tidak valid." });
    const today = jakartaWorkDate();
    const [current, total, items] = await Promise.all([
      overtimePolicyOn(pool, today),
      pool.query<{ total: number }>("SELECT count(*)::int AS total FROM attendance_overtime_policy_versions"),
      pool.query(
        `SELECT version.id, version.effective_from::text AS "effectiveFrom",
           version.daily_warning_minutes AS "dailyWarningMinutes", version.weekly_warning_minutes AS "weeklyWarningMinutes",
           version.reason, version.created_at AS "createdAt", creator.full_name AS "createdByName"
         FROM attendance_overtime_policy_versions version
         LEFT JOIN accounts account ON account.id = version.created_by_account_id
         LEFT JOIN employees creator ON creator.id = account.employee_id
         ORDER BY version.effective_from DESC, version.created_at DESC, version.id DESC
         LIMIT $1 OFFSET $2`,
        [query.data.pageSize, pageOffset(query.data)],
      ),
    ]);
    reply.header("Cache-Control", "no-store");
    return reply.send({
      current, defaults: DEFAULT_OVERTIME_POLICY,
      ...pagination(query.data, total.rows[0]?.total ?? 0), items: items.rows,
    });
  });

  app.put("/admin/attendance/overtime-policy", async (request, reply) => {
    const principal = await manage(request, reply);
    if (!principal) return;
    const body = z.object({
      effectiveFrom: dateSchema,
      dailyWarningMinutes: z.number().int().min(1).max(1440),
      weeklyWarningMinutes: z.number().int().min(1).max(10080),
      reason: z.string().trim().max(1000).nullable().optional(),
    }).strict().safeParse(request.body);
    if (!body.success) return reply.status(400).send({ code: "INVALID_OVERTIME_POLICY", message: "Batas peringatan lembur tidak valid." });
    try {
      // Effective-dated: a new value starts today or later; past warnings stay as they were shown.
      if (body.data.effectiveFrom < jakartaWorkDate()) {
        throw new OvertimeRuleError(422, "OVERTIME_POLICY_DATE_IN_PAST", "Batas baru hanya dapat berlaku mulai hari ini atau sesudahnya.");
      }
      const id = randomUUID();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const previous = await overtimePolicyOn(client, body.data.effectiveFrom);
        await client.query(
          `INSERT INTO attendance_overtime_policy_versions (
             id, effective_from, daily_warning_minutes, weekly_warning_minutes, reason, created_by_account_id
           ) VALUES ($1, $2::date, $3, $4, $5, $6)`,
          [id, body.data.effectiveFrom, body.data.dailyWarningMinutes, body.data.weeklyWarningMinutes, body.data.reason ?? null, principal.id],
        );
        await audit(client, principal.id, "attendance.overtime_policy.updated", "attendance_overtime_policy_version", id, {
          effectiveFrom: body.data.effectiveFrom,
          dailyWarningMinutes: body.data.dailyWarningMinutes, weeklyWarningMinutes: body.data.weeklyWarningMinutes,
          previous: { id: previous.id, dailyWarningMinutes: previous.dailyWarningMinutes, weeklyWarningMinutes: previous.weeklyWarningMinutes, source: previous.source },
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      reply.header("Cache-Control", "no-store");
      return reply.send({ id, effectiveFrom: body.data.effectiveFrom, dailyWarningMinutes: body.data.dailyWarningMinutes, weeklyWarningMinutes: body.data.weeklyWarningMinutes });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get("/admin/attendance/overtime-eligibility-rules", async (request, reply) => {
    if (!(await manage(request, reply))) return;
    const query = pageQuerySchema.extend({
      status: z.enum(["current", "ended", "all"]).default("current"),
      // ORG-008 (O-8): which rules point at a position, before that position is closed or moved.
      positionKey: z.string().uuid().optional(),
    }).safeParse(request.query);
    if (!query.success) return reply.status(400).send({ code: "INVALID_OVERTIME_RULE_QUERY", message: "Filter aturan lembur tidak valid." });
    const today = jakartaWorkDate();
    // current = applies today or later; ended = its last day has passed.
    const where = `WHERE ($1::text = 'all'
        OR ($1::text = 'current' AND (rule.effective_to IS NULL OR rule.effective_to >= $2::date))
        OR ($1::text = 'ended' AND rule.effective_to < $2::date))
      AND ($3::text IS NULL OR (rule.target_kind = 'position' AND rule.target_ref = $3::text))`;
    const values = [query.data.status, today, query.data.positionKey ?? null];
    const [count, rows] = await Promise.all([
      pool.query<{ total: number }>(`SELECT count(*)::int AS total FROM attendance_overtime_eligibility_rules rule ${where}`, values),
      pool.query(
        `SELECT ${RULE_COLUMNS},
           CASE WHEN rule.effective_to IS NOT NULL AND rule.effective_to < $2::date THEN 'ended'
                WHEN rule.effective_from > $2::date THEN 'scheduled' ELSE 'active' END AS state
         FROM attendance_overtime_eligibility_rules rule
         ${RULE_JOINS}
         ${where}
         ORDER BY (rule.effective_to IS NULL) DESC, rule.effective_from DESC, rule.created_at DESC, rule.id
         LIMIT $4 OFFSET $5`,
        [...values, query.data.pageSize, pageOffset(query.data)],
      ),
    ]);
    // O-8: whether a position rule still points at an active position of the structure in force today.
    const snapshot = await new PostgresOrganizationRepository(pool).loadEffectiveSnapshot(today);
    const activeKeys = new Set(snapshot ? searchPositions(snapshot, { asOf: today, limit: Number.MAX_SAFE_INTEGER }).map((item) => item.stableKey) : []);
    reply.header("Cache-Control", "no-store");
    return reply.send({
      ...pagination(query.data, count.rows[0]?.total ?? 0),
      items: rows.rows.map((row: Record<string, unknown>) => ({
        ...row,
        targetActive: row.targetKind === "position" ? activeKeys.has(String(row.targetRef)) : null,
      })),
    });
  });

  // Typeahead for the rule target: positions of the structure in force (stable key), or system roles.
  app.get("/admin/attendance/overtime-eligibility-rules/targets", async (request, reply) => {
    if (!(await manage(request, reply))) return;
    const query = z.object({
      kind: z.enum(["position", "role"]).default("position"),
      q: z.string().trim().max(120).optional(),
    }).safeParse(request.query);
    if (!query.success) return reply.status(400).send({ code: "INVALID_OVERTIME_RULE_QUERY", message: "Filter aturan lembur tidak valid." });
    reply.header("Cache-Control", "no-store");
    if (query.data.kind === "role") {
      const roles = await pool.query<{ key: string; label: string }>(
        `SELECT role_key AS key, name AS label FROM roles
         WHERE ($1::text IS NULL OR name ILIKE '%' || $1 || '%' OR role_key ILIKE '%' || $1 || '%')
         ORDER BY name, role_key LIMIT 50`,
        [query.data.q ? query.data.q.replace(/[\\%_]/g, (character) => `\\${character}`) : null],
      );
      return reply.send({ kind: "role", items: roles.rows.map((row) => ({ ...row, detail: row.key })) });
    }
    const today = jakartaWorkDate();
    const snapshot = await new PostgresOrganizationRepository(pool).loadEffectiveSnapshot(today);
    const items = snapshot ? searchPositions(snapshot, { q: query.data.q, asOf: today, limit: 50 }) : [];
    return reply.send({
      kind: "position",
      items: items.map((item) => ({ key: item.stableKey, label: item.title, detail: item.unitPath.join(" › ") })),
    });
  });

  app.post("/admin/attendance/overtime-eligibility-rules", async (request, reply) => {
    const principal = await manage(request, reply);
    if (!principal) return;
    const body = z.object({
      targetKind: z.enum(["position", "role"]),
      targetRef: z.string().trim().min(1).max(120),
      reasonLabel: z.string().trim().min(3).max(200),
      effectiveFrom: dateSchema,
    }).strict().safeParse(request.body);
    if (!body.success) return reply.status(400).send({ code: "INVALID_OVERTIME_RULE", message: "Aturan lembur tidak valid." });
    const id = randomUUID();
    try {
      const today = jakartaWorkDate();
      if (body.data.effectiveFrom < today) {
        throw new OvertimeRuleError(422, "OVERTIME_RULE_DATE_IN_PAST", "Aturan baru hanya dapat berlaku mulai hari ini atau sesudahnya.");
      }
      let targetLabel: string;
      if (body.data.targetKind === "position") {
        const key = z.string().uuid().safeParse(body.data.targetRef);
        const snapshot = key.success ? await new PostgresOrganizationRepository(pool).loadEffectiveSnapshot(body.data.effectiveFrom) : null;
        const found = snapshot ? searchPositions(snapshot, { asOf: body.data.effectiveFrom, limit: Number.MAX_SAFE_INTEGER }).find((item) => item.stableKey === body.data.targetRef) : undefined;
        if (!found) throw new OvertimeRuleError(422, "OVERTIME_RULE_TARGET_NOT_FOUND", "Jabatan tidak ditemukan pada struktur yang berlaku di tanggal itu.");
        targetLabel = [found.title, found.unitPath.join(" › ")].filter(Boolean).join(" — ");
      } else {
        const role = await pool.query<{ name: string }>("SELECT name FROM roles WHERE role_key = $1", [body.data.targetRef]);
        if (!role.rows[0]) throw new OvertimeRuleError(422, "OVERTIME_RULE_TARGET_NOT_FOUND", "Peran tidak ditemukan.");
        targetLabel = `Peran ${role.rows[0].name}`;
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const open = await client.query(
          `SELECT 1 FROM attendance_overtime_eligibility_rules
           WHERE target_kind = $1 AND target_ref = $2 AND effective_to IS NULL FOR UPDATE`,
          [body.data.targetKind, body.data.targetRef],
        );
        if (open.rows[0]) throw new OvertimeRuleError(409, "OVERTIME_RULE_ALREADY_OPEN", "Sudah ada aturan berjalan untuk jabatan/peran ini. Akhiri dulu aturan itu.");
        await client.query(
          `INSERT INTO attendance_overtime_eligibility_rules (
             id, target_kind, target_ref, target_label, reason_label, effective_from, created_by_account_id
           ) VALUES ($1, $2, $3, $4, $5, $6::date, $7)`,
          [id, body.data.targetKind, body.data.targetRef, targetLabel, body.data.reasonLabel, body.data.effectiveFrom, principal.id],
        );
        await audit(client, principal.id, "attendance.overtime_rule.created", "attendance_overtime_eligibility_rule", id, {
          targetKind: body.data.targetKind, targetRef: body.data.targetRef, targetLabel,
          reasonLabel: body.data.reasonLabel, effectiveFrom: body.data.effectiveFrom,
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        if ((error as { code?: string }).code === "23505") throw new OvertimeRuleError(409, "OVERTIME_RULE_ALREADY_OPEN", "Sudah ada aturan berjalan untuk jabatan/peran ini. Akhiri dulu aturan itu.");
        throw error;
      } finally {
        client.release();
      }
      const recalculation = await recalculateApprovedOvertime(pool, id, body.data.effectiveFrom, "added");
      reply.header("Cache-Control", "no-store");
      return reply.status(201).send({
        id, targetKind: body.data.targetKind, targetRef: body.data.targetRef, targetLabel,
        reasonLabel: body.data.reasonLabel, effectiveFrom: body.data.effectiveFrom, effectiveTo: null, ...recalculation,
      });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post("/admin/attendance/overtime-eligibility-rules/:ruleId/end", async (request, reply) => {
    const principal = await manage(request, reply);
    if (!principal) return;
    const params = z.object({ ruleId: z.string().uuid() }).safeParse(request.params);
    const body = z.object({
      // Last day the rule still applies. Default: yesterday (overtime counts again from today), or the
      // day before it starts when it has not started yet (it never applied).
      lastDay: dateSchema.optional(),
      reason: z.string().trim().min(3).max(1000),
    }).strict().safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ code: "INVALID_OVERTIME_RULE_END", message: "Alasan mengakhiri aturan wajib diisi." });
    let lastDay = "";
    try {
      const today = jakartaWorkDate();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const current = await client.query<{ effectiveFrom: string; effectiveTo: string | null; targetKind: string; targetRef: string; targetLabel: string }>(
          `SELECT effective_from::text AS "effectiveFrom", effective_to::text AS "effectiveTo", target_kind AS "targetKind",
             target_ref AS "targetRef", target_label AS "targetLabel"
           FROM attendance_overtime_eligibility_rules WHERE id = $1 FOR UPDATE`,
          [params.data.ruleId],
        );
        const rule = current.rows[0];
        if (!rule) throw new OvertimeRuleError(404, "OVERTIME_RULE_NOT_FOUND", "Aturan lembur tidak ditemukan.");
        if (rule.effectiveTo !== null) throw new OvertimeRuleError(409, "OVERTIME_RULE_ALREADY_ENDED", "Aturan ini sudah diakhiri.");
        // Ending never rewrites the past beyond yesterday: overtime of earlier days stays as it was judged.
        const earliest = [addDays(rule.effectiveFrom, -1), addDays(today, -1)].sort().at(-1)!;
        lastDay = body.data.lastDay ?? earliest;
        if (lastDay < earliest) {
          throw new OvertimeRuleError(422, "OVERTIME_RULE_END_TOO_EARLY", `Tanggal terakhir aturan paling awal ${earliest}.`);
        }
        await client.query(
          `UPDATE attendance_overtime_eligibility_rules
           SET effective_to = $2::date, ended_at = now(), ended_by_account_id = $3, end_reason = $4
           WHERE id = $1`,
          [params.data.ruleId, lastDay, principal.id, body.data.reason],
        );
        await audit(client, principal.id, "attendance.overtime_rule.ended", "attendance_overtime_eligibility_rule", params.data.ruleId, {
          targetKind: rule.targetKind, targetRef: rule.targetRef, targetLabel: rule.targetLabel,
          effectiveFrom: rule.effectiveFrom, lastDay, reason: body.data.reason,
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      const recalculation = await recalculateApprovedOvertime(pool, params.data.ruleId, addDays(lastDay, 1), "ended");
      reply.header("Cache-Control", "no-store");
      return reply.send({ id: params.data.ruleId, effectiveTo: lastDay, ...recalculation });
    } catch (error) {
      return fail(reply, error);
    }
  });
}
