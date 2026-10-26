// PAY-003 v1 payroll period lifecycle routes (specification section 6).
//
// Periods and their transitions only: the calculation itself, the period inputs
// and the reports arrive in their own steps. Every response is no-store, because
// a payroll screen carries pay data (specification section 8).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { AUTH_COOKIE_NAME, AuthService, readCookie, type AuthPrincipal } from "../auth/service.js";
import {
  availableActions,
  decideTransition,
  PERIOD_ACTIONS,
  type PeriodSnapshot,
  type PeriodState,
  type TransitionActor,
} from "./lifecycle.js";
import {
  applyTransition,
  createPeriod,
  getPeriod,
  hasCurrentCalculation,
  listPeriods,
  type PeriodWithCalculation,
} from "./store.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tanggal harus berformat YYYY-MM-DD");
const firstOfMonth = isoDate.refine((value) => value.endsWith("-01"), "Periode harus tanggal 1 bulan tersebut");

const createBody = z.object({
  periodMonth: firstOfMonth,
  payDate: isoDate.optional(),
  cutoffStart: isoDate.optional(),
  cutoffEnd: isoDate.optional(),
  legalEntityKey: z.string().uuid().nullable().optional(),
});

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
});

const periodParams = z.object({ periodId: z.string().uuid() });

const transitionBody = z.object({
  action: z.enum(PERIOD_ACTIONS),
  reason: z.string().trim().max(500).optional(),
});

function send(reply: FastifyReply, status: number, body: unknown) {
  reply.header("Cache-Control", "no-store");
  return reply.status(status).send(body);
}

function snapshotOf(period: PeriodWithCalculation): PeriodSnapshot {
  return {
    state: period.state,
    stateBeforeReopenRequest: period.stateBeforeReopenRequest as PeriodState | null,
    submittedByAccountId: period.submittedByAccountId,
    hasCurrentCalculation: hasCurrentCalculation(period),
    blockerCount: period.blockerCount,
  };
}

export async function registerPayrollRoutes(app: FastifyInstance, pool: Pool, config: ApiConfig) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required for payroll routes");
  const auth = new AuthService(
    pool,
    config.AUTH_ENCRYPTION_KEY,
    config.AUTH_SESSION_TTL_HOURS,
    config.NODE_ENV === "production",
  );

  /**
   * Returns the signed-in actor and the permissions they hold. Authorization per
   * action is the lifecycle's decision, not this function's, so a reader finds
   * the whole rule in one place.
   */
  async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ principal: AuthPrincipal; actor: TransitionActor } | null> {
    const session = await auth.getSession(readCookie(request.headers.cookie, AUTH_COOKIE_NAME));
    if (!session) {
      await send(reply, 401, { code: "UNAUTHENTICATED", message: "Sesi tidak ditemukan atau sudah berakhir." });
      return null;
    }
    const context = await auth.getAuthorizationContext(session.principal);
    return {
      principal: session.principal,
      actor: {
        accountId: session.principal.id,
        organizationPermissions: context.organizationPermissions,
      },
    };
  }

  async function requirePermission(
    request: FastifyRequest,
    reply: FastifyReply,
    permission: string,
  ): Promise<TransitionActor | null> {
    const authenticated = await authenticate(request, reply);
    if (!authenticated) return null;
    if (!authenticated.actor.organizationPermissions.includes(permission)) {
      await send(reply, 403, {
        code: "PAYROLL_FORBIDDEN",
        message: "Anda tidak memiliki akses untuk tindakan ini.",
      });
      return null;
    }
    return authenticated.actor;
  }

  app.post("/payroll/periods", async (request, reply) => {
    const actor = await requirePermission(request, reply, "payroll.periods.manage");
    if (!actor) return;

    const parsed = createBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return send(reply, 400, {
        code: "PAYROLL_INVALID_PERIOD",
        message: parsed.error.issues[0]?.message ?? "Permintaan tidak valid.",
      });
    }

    const { periodMonth, payDate, cutoffStart, cutoffEnd, legalEntityKey } = parsed.data;
    if (cutoffStart && cutoffEnd && cutoffEnd < cutoffStart) {
      return send(reply, 400, {
        code: "PAYROLL_INVALID_PERIOD",
        message: "Akhir cutoff mendahului awalnya.",
      });
    }

    try {
      const period = await createPeriod(pool, {
        periodMonth,
        payDate,
        cutoffStart,
        cutoffEnd,
        legalEntityKey,
        actorAccountId: actor.accountId,
      });
      return send(reply, 201, { period });
    } catch (error) {
      // The month is guarded by an exclusion constraint, so a duplicate loses the
      // race in the database rather than in a check that could go stale.
      if ((error as { code?: string }).code === "23P01") {
        return send(reply, 409, {
          code: "PAYROLL_PERIOD_EXISTS",
          message: "Periode untuk bulan tersebut sudah ada.",
        });
      }
      throw error;
    }
  });

  app.get("/payroll/periods", async (request, reply) => {
    const actor = await requirePermission(request, reply, "payroll.periods.manage");
    if (!actor) return;

    const parsed = listQuery.safeParse(request.query ?? {});
    if (!parsed.success) {
      return send(reply, 400, { code: "PAYROLL_INVALID_QUERY", message: "Parameter tidak valid." });
    }
    const { page, pageSize } = parsed.data;
    const periods = await listPeriods(pool, pageSize, (page - 1) * pageSize);
    return send(reply, 200, {
      page,
      pageSize,
      periods: periods.map((period) => ({
        ...period,
        hasCurrentCalculation: hasCurrentCalculation(period),
        availableActions: availableActions(snapshotOf(period), actor),
      })),
    });
  });

  app.get("/payroll/periods/:periodId", async (request, reply) => {
    const actor = await requirePermission(request, reply, "payroll.periods.manage");
    if (!actor) return;

    const params = periodParams.safeParse(request.params);
    if (!params.success) {
      return send(reply, 400, { code: "PAYROLL_INVALID_QUERY", message: "Identifier periode tidak valid." });
    }
    const period = await getPeriod(pool, params.data.periodId);
    if (!period) {
      return send(reply, 404, { code: "PAYROLL_PERIOD_NOT_FOUND", message: "Periode tidak ditemukan." });
    }
    return send(reply, 200, {
      period: {
        ...period,
        hasCurrentCalculation: hasCurrentCalculation(period),
        availableActions: availableActions(snapshotOf(period), actor),
      },
    });
  });

  app.post("/payroll/periods/:periodId/transitions", async (request, reply) => {
    const authenticated = await authenticate(request, reply);
    if (!authenticated) return;
    const actor = authenticated.actor;

    const params = periodParams.safeParse(request.params);
    const body = transitionBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return send(reply, 400, {
        code: "PAYROLL_INVALID_TRANSITION",
        message: "Tindakan atau identifier periode tidak valid.",
      });
    }

    const period = await getPeriod(pool, params.data.periodId);
    if (!period) {
      return send(reply, 404, { code: "PAYROLL_PERIOD_NOT_FOUND", message: "Periode tidak ditemukan." });
    }

    const reason = body.data.reason ?? null;
    const decision = decideTransition(body.data.action, snapshotOf(period), actor, reason);
    if (!decision.allowed) {
      const status = decision.refusal.code === "PAYROLL_FORBIDDEN" ? 403 : 409;
      return send(reply, status, decision.refusal);
    }

    // Repeating an action that already happened returns the period unchanged.
    if (decision.alreadyThere) {
      return send(reply, 200, { period, applied: false });
    }

    const result = await applyTransition(pool, {
      periodId: period.id,
      action: body.data.action,
      nextState: decision.nextState,
      auditAction: decision.auditAction,
      actorAccountId: actor.accountId,
      reason,
      expectedVersion: period.version,
      blockerCount: period.blockerCount,
    });

    if (!result.applied) {
      return send(reply, 409, {
        code: "PAYROLL_STATE_CONFLICT",
        message: "Periode berubah saat permintaan ini diproses; muat ulang lalu coba lagi.",
      });
    }

    return send(reply, 200, { period: result.period, applied: true });
  });
}
