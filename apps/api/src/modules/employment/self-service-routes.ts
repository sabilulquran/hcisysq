// EMP-005 / EMP-006 Package 1 S7 (spec §6.1, §13.4, §13.7, D-17):
//
//  - reversal of the latest recorded action (employment.correct);
//  - the "Kontrak akan berakhir" worklist (employment.read);
//  - an employee's own employment summary, without the notes HC writes about
//    them (their own session, no permission needed).
//
// Recording and reversing stay with the planner; this file authenticates,
// loads, persists and maps failures, exactly like the action routes.

import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import type { EmploymentPermission } from "../auth/permissions.js";
import { AUTH_COOKIE_NAME, AuthService, readCookie, type AuthPrincipal } from "../auth/service.js";
import {
  DEFAULT_EMPLOYMENT_POLICY as policy,
  EmploymentDomainError,
  planEmploymentAction,
  resolveEmployment,
  type EmploymentHistory,
} from "./domain/index.js";
import { STATUS_BY_CODE } from "./action-routes.js";
import { EmploymentVersionConflict, persistAction } from "./infrastructure/postgres-action-store.js";
import {
  getRolloutMode,
  jakartaToday,
  loadHistories,
  loadTimeline,
} from "./infrastructure/postgres-employment-store.js";

const reversalParams = z.object({ actionId: z.string().uuid() });
const reversalBody = z.object({
  reasonCode: z.string().trim().min(3).max(64),
  reasonNote: z.string().trim().max(1000).nullish(),
});
const expiringQuery = z.object({
  withinDays: z.coerce.number().int().min(1).max(365).default(60),
  unitId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

function send(reply: FastifyReply, status: number, body: unknown) {
  reply.header("Cache-Control", "no-store");
  return reply.status(status).send(body);
}

export async function registerEmploymentSelfServiceRoutes(app: FastifyInstance, pool: Pool, config: ApiConfig) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required for employment self-service routes");
  const auth = new AuthService(
    pool,
    config.AUTH_ENCRYPTION_KEY,
    config.AUTH_SESSION_TTL_HOURS,
    config.NODE_ENV === "production",
  );

  async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
    permission: EmploymentPermission,
  ): Promise<{ principal: AuthPrincipal; canCorrect: boolean } | null> {
    const session = await auth.getSession(readCookie(request.headers.cookie, AUTH_COOKIE_NAME));
    if (!session) {
      await send(reply, 401, { code: "UNAUTHENTICATED", message: "Sesi tidak ditemukan atau sudah berakhir." });
      return null;
    }
    const context = await auth.getAuthorizationContext(session.principal);
    if (!context.organizationPermissions.includes(permission)) {
      await send(reply, 403, { code: "EMPLOYMENT_FORBIDDEN", message: "Anda tidak memiliki akses untuk tindakan ini." });
      return null;
    }
    return {
      principal: session.principal,
      canCorrect: context.organizationPermissions.includes("employment.correct"),
    };
  }

  async function employeeOfSession(request: FastifyRequest, reply: FastifyReply): Promise<{ accountId: string; employeeId: string } | null> {
    const session = await auth.getSession(readCookie(request.headers.cookie, AUTH_COOKIE_NAME));
    if (!session) {
      await send(reply, 401, { code: "UNAUTHENTICATED", message: "Sesi tidak ditemukan atau sudah berakhir." });
      return null;
    }
    const result = await pool.query<{ employeeId: string }>(
      `SELECT employee_id AS "employeeId" FROM accounts
       WHERE id = $1 AND principal_type = 'EMPLOYEE' AND employee_id IS NOT NULL`,
      [session.principal.id],
    );
    const employeeId = result.rows[0]?.employeeId;
    if (!employeeId) {
      await send(reply, 403, { code: "EMPLOYEE_ACCOUNT_REQUIRED", message: "Halaman ini hanya untuk akun pegawai." });
      return null;
    }
    return { accountId: session.principal.id, employeeId };
  }

  async function requireMode(reply: FastifyReply, needed: "readable" | "authoritative"): Promise<boolean> {
    const { mode } = await getRolloutMode(pool);
    const ok = needed === "readable" ? mode !== "OFF" : mode === "AUTHORITATIVE";
    if (!ok) {
      await send(reply, 409, { code: "EMPLOYMENT_HISTORY_DISABLED", message: "Riwayat kepegawaian belum diaktifkan." });
      return false;
    }
    return true;
  }

  /**
   * Reverses one recorded action (§6.1). Only the latest one of an employment,
   * by recording order, so history is undone in the order it was written.
   */
  app.post("/admin/employment-actions/:actionId/reversal", async (request, reply) => {
    const session = await authenticate(request, reply, "employment.correct");
    if (!session) return;
    const params = reversalParams.safeParse(request.params);
    const body = reversalBody.safeParse(request.body);
    if (!params.success || !body.success) {
      return send(reply, 400, { code: "EMPLOYMENT_REASON_REQUIRED", message: "Pembatalan wajib disertai alasan." });
    }
    if (!(await requireMode(reply, "authoritative"))) return;

    const target = await pool.query<{ employeeId: string }>(
      `SELECT employee_id AS "employeeId" FROM employment_actions WHERE id = $1`,
      [params.data.actionId],
    );
    const employeeId = target.rows[0]?.employeeId;
    if (!employeeId) {
      return send(reply, 404, { code: "EMPLOYMENT_ACTION_NOT_REVERSIBLE", message: "Tindakan tidak ditemukan." });
    }

    const today = jakartaToday();
    const history = (await loadHistories(pool, [employeeId])).get(employeeId) as EmploymentHistory | undefined;
    if (!history) {
      return send(reply, 404, { code: "EMPLOYMENT_ACTION_NOT_REVERSIBLE", message: "Tindakan tidak ditemukan." });
    }
    const actor = await pool.query<{ employeeId: string }>(
      `SELECT employee_id AS "employeeId" FROM accounts WHERE id = $1 AND employee_id IS NOT NULL`,
      [session.principal.id],
    );

    let plan;
    try {
      plan = planEmploymentAction(
        history,
        { actionType: "REVERSAL", targetActionId: params.data.actionId, reasonCode: body.data.reasonCode },
        policy,
        {
          today,
          actorEmployeeId: actor.rows[0]?.employeeId ?? null,
          canCorrect: session.canCorrect,
          mode: "record",
          newId: randomUUID,
        },
      );
    } catch (error) {
      if (error instanceof EmploymentDomainError) {
        return send(reply, STATUS_BY_CODE[error.code], { code: error.code, message: error.message });
      }
      throw error;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await persistAction(client, {
        plan,
        actorAccountId: session.principal.id,
        idempotencyKey: `reversal-${params.data.actionId}`,
        reasonNote: body.data.reasonNote ?? null,
        acknowledgedWarnings: [],
        today,
      });
      await client.query("COMMIT");
      // Reversing a termination does not bring the account back (D-15, fail
      // closed); access administration reactivates it deliberately.
      return send(reply, 201, {
        actionId: result.actionId,
        reversedActionId: params.data.actionId,
        accountReactivated: false,
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // A failed ROLLBACK must not hide the error that caused it.
      }
      if (error instanceof EmploymentVersionConflict) {
        return send(reply, 409, {
          code: "EMPLOYMENT_VERSION_CONFLICT",
          message: "Data berubah sejak Anda membuka halaman. Muat ulang lalu ulangi.",
        });
      }
      const sqlState = (error as { code?: string } | null)?.code;
      if (sqlState === "23505") {
        return send(reply, 409, {
          code: "EMPLOYMENT_ACTION_NOT_REVERSIBLE",
          message: "Tindakan ini sudah dibatalkan.",
        });
      }
      if (sqlState === "23P01") {
        return send(reply, 409, { code: "EMPLOYMENT_OVERLAP", message: "Periode bertabrakan dengan data yang sudah ada." });
      }
      throw error;
    } finally {
      client.release();
    }
  });

  /** "Kontrak akan berakhir" (§13.4): the fixed terms that need a decision. */
  app.get("/admin/employment/contracts/expiring", async (request, reply) => {
    if (!(await authenticate(request, reply, "employment.read"))) return;
    const query = expiringQuery.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_EMPLOYMENT_REQUEST", message: "Parameter tidak valid." });
    if (!(await requireMode(reply, "readable"))) return;

    const today = jakartaToday();
    const { withinDays, page, pageSize } = query.data;
    const filters = query.data.unitId ? "AND e.organizational_unit_id = $4::uuid" : "";
    const params: unknown[] = [today, withinDays, pageSize * (page - 1) + 0];
    if (query.data.unitId) params.push(query.data.unitId);

    // The term the employee is on now, when it is fixed and ends soon — or has
    // ended with nothing recorded after it (spec §6.2: never auto-terminate).
    const sql = `
      WITH current_term AS (
        SELECT DISTINCT ON (em.employee_id)
               em.employee_id, em.id AS employment_id, t.effective_to, t.category, t.sequence
        FROM employments em
        JOIN employment_terms t ON t.employment_id = em.id AND t.voided_by_action_id IS NULL
        WHERE em.voided_by_action_id IS NULL
          AND em.ended_on IS NULL
          AND t.effective_to IS NOT NULL
          AND t.effective_from <= $1::date
        ORDER BY em.employee_id, t.effective_from DESC, t.sequence DESC
      )
      SELECT ct.employee_id AS "employeeId", e.employee_number AS "employeeNumber", e.full_name AS "fullName",
             u.name AS "unitName", ct.category, ct.effective_to::text AS "endsOn", ct.sequence,
             (ct.effective_to - $1::date)::int AS "daysLeft",
             count(*) OVER ()::int AS "total"
      FROM current_term ct
      JOIN employees e ON e.id = ct.employee_id AND e.removed_at IS NULL
      LEFT JOIN organizational_units u ON u.id = e.organizational_unit_id
      WHERE ct.effective_to <= $1::date + $2::int ${filters}
      ORDER BY ct.effective_to, e.full_name
      LIMIT ${pageSize} OFFSET $3`;
    const result = await pool.query<{
      employeeId: string; employeeNumber: string; fullName: string; unitName: string | null;
      category: string; endsOn: string; sequence: number; daysLeft: number; total: number;
    }>(sql, params);

    return send(reply, 200, {
      date: today,
      withinDays,
      page,
      pageSize,
      total: result.rows[0]?.total ?? 0,
      rows: result.rows.map((row) => ({
        employeeId: row.employeeId,
        employeeNumber: row.employeeNumber,
        fullName: row.fullName,
        unitName: row.unitName,
        category: row.category,
        endsOn: row.endsOn,
        sequence: row.sequence,
        daysLeft: row.daysLeft,
        // A term already past its end is the urgent case (§6.2 flag).
        overdue: row.daysLeft < 0,
      })),
    });
  });

  /**
   * D-17: an employee reads their own employment. Reason notes and the
   * consistency findings HC works with stay out: this is the employee's own
   * record, not HC's working file.
   */
  app.get("/employees/me/employment", async (request, reply) => {
    const me = await employeeOfSession(request, reply);
    if (!me) return;
    if (!(await requireMode(reply, "readable"))) return;

    const today = jakartaToday();
    const history = (await loadHistories(pool, [me.employeeId])).get(me.employeeId);
    if (!history) {
      return send(reply, 200, { date: today, state: "TANPA_DATA", current: null, timeline: [] });
    }
    const resolved = resolveEmployment(history, today, policy);
    const units = await pool.query<{ id: string; name: string }>(
      "SELECT id, name FROM organizational_units WHERE id = ANY($1::uuid[])",
      [history.placements.flatMap((placement) => (placement.unitRef.kind === "LEGACY_UNIT" ? [placement.unitRef.id] : []))],
    );
    const unitName = (id: string | null) => units.rows.find((unit) => unit.id === id)?.name ?? null;
    const placement = resolved.primaryPlacement;

    const timeline = await loadTimeline(pool, me.employeeId);
    return send(reply, 200, {
      date: today,
      state: resolved.state,
      current: {
        category: resolved.term?.category ?? null,
        termFrom: resolved.term?.effectiveFrom ?? null,
        termTo: resolved.term?.effectiveTo ?? null,
        startedOn: resolved.employment?.startedOn ?? null,
        endedOn: resolved.employment?.endedOn ?? null,
        jobTitleLabel: placement?.jobTitleLabel ?? null,
        unitName: placement ? unitName(placement.unitRef.kind === "LEGACY_UNIT" ? placement.unitRef.id : null) : null,
        since: placement?.effectiveFrom ?? null,
        sinceBasis: placement?.effectiveFromBasis ?? null,
      },
      timeline: timeline.map((item) => ({
        actionType: item.actionType,
        effectiveOn: item.effectiveOn,
        state: item.state,
        recordedAt: item.recordedAt,
        documents: item.documents.map((document) => ({ kind: document.kind, number: document.number })),
      })),
    });
  });
}
