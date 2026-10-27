// EMP-005 Package 1 S5: the contract actions (spec §5, §6, §11, §12). HIRE,
// CONTRACT_EXTENSION, CATEGORY_CHANGE and TERMINATION are recorded here; the
// career actions follow in S6 and reversal in S7. Every rule is the planner's;
// this file authenticates, loads history, persists the plan in one transaction,
// and maps a typed domain failure to its HTTP code.
//
// Actions need mode AUTHORITATIVE (spec §8.1): in OFF and SHADOW the register
// and the read screens work, but nothing may be recorded.

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
  addDays,
  applyPlan,
  isIsoDate,
  planEmploymentAction,
  resolveEmployment,
  type ActionInput,
  type ActionPlan,
  type EmploymentFailureCode,
  type EmploymentHistory,
  type PositionRef,
  type UnitRef,
} from "./domain/index.js";
import {
  EmploymentVersionConflict,
  findActionByIdempotencyKey,
  loadDecisionDocumentRefs,
  persistAction,
} from "./infrastructure/postgres-action-store.js";
import { getRolloutMode, jakartaToday, loadHistories } from "./infrastructure/postgres-employment-store.js";

/** HTTP status per typed domain failure (spec §12). */
const STATUS_BY_CODE: Readonly<Record<EmploymentFailureCode, number>> = {
  EMPLOYMENT_FORBIDDEN: 403,
  EMPLOYMENT_SELF_ACTION_FORBIDDEN: 403,
  EMPLOYMENT_EFFECTIVE_DATE_REQUIRED: 400,
  EMPLOYMENT_NOT_ACTIVE: 409,
  EMPLOYMENT_ALREADY_ACTIVE: 409,
  EMPLOYMENT_OVERLAP: 409,
  EMPLOYMENT_ACTION_OUT_OF_ORDER: 409,
  EMPLOYMENT_BACKDATE_NOT_ALLOWED: 403,
  EMPLOYMENT_BACKDATE_REASON_REQUIRED: 400,
  EMPLOYMENT_REFERENCE_INVALID: 422,
  EMPLOYMENT_CROSS_ENTITY_UNSUPPORTED: 422,
  EMPLOYMENT_TERM_END_REQUIRED: 400,
  EMPLOYMENT_TERM_INVALID: 422,
  EMPLOYMENT_REASON_REQUIRED: 400,
  EMPLOYMENT_WARNINGS_NOT_ACKNOWLEDGED: 409,
  EMPLOYMENT_ACTION_NOT_REVERSIBLE: 409,
  EMPLOYMENT_BASELINE_MISSING: 409,
  DECISION_DOCUMENT_REQUIRED: 422,
  DECISION_DOCUMENT_KIND_INVALID: 422,
  DECISION_DOCUMENT_EMPLOYEE_MISMATCH: 422,
  PK_TERM_MISMATCH: 422,
};

const isoDate = z.string().refine(isIsoDate);
const category = z.enum(["TETAP", "KONTRAK", "KONTRAK_HONORER", "MAGANG", "PERCOBAAN", "LEPAS"]);
/**
 * Package 1 records placements against the legacy unit/position tables, the
 * same ones the nine projected `employees` columns point at. ORG-004 stable
 * keys arrive with S6, together with the mapping that keeps those columns
 * filled; accepting them here would quietly null a employee's unit for every
 * legacy consumer, and the import guard would stop import from restoring it.
 */
const placementBody = z.object({
  unitId: z.string().uuid(),
  positionId: z.string().uuid().nullish(),
  jobTitleLabel: z.string().trim().min(1).max(200),
}).strict();

const common = {
  reasonNote: z.string().trim().max(1000).nullish(),
  documentIds: z.array(z.string().uuid()).max(10).optional(),
  acknowledgedWarnings: z.array(z.enum(["BACKDATED", "TERM_GAP", "CONTRACT_DURATION_LONG", "PROBATION_DURATION_LONG"])).optional(),
};

/** Only the four contract actions; career actions arrive with S6. */
const actionBody = z.discriminatedUnion("actionType", [
  z.object({
    actionType: z.literal("HIRE"),
    effectiveOn: isoDate,
    category,
    termEndOn: isoDate.nullish(),
    staffType: z.enum(["PENDIDIK", "KEPENDIDIKAN"]).nullish(),
    contractReference: z.string().trim().max(200).nullish(),
    placement: placementBody,
    ...common,
  }),
  z.object({
    actionType: z.literal("CONTRACT_EXTENSION"),
    effectiveOn: isoDate,
    termEndOn: isoDate,
    contractReference: z.string().trim().max(200).nullish(),
    ...common,
  }),
  z.object({
    actionType: z.literal("CATEGORY_CHANGE"),
    effectiveOn: isoDate,
    category,
    termEndOn: isoDate.nullish(),
    contractReference: z.string().trim().max(200).nullish(),
    ...common,
  }),
  z.object({
    actionType: z.literal("TERMINATION"),
    lastDayOn: isoDate,
    reasonCode: z.enum(["RESIGN", "KONTRAK_BERAKHIR", "PENSIUN", "PEMBERHENTIAN", "MENINGGAL_DUNIA", "LAINNYA"]),
    ...common,
  }),
]);

type ActionBody = z.infer<typeof actionBody>;

const employeeParams = z.object({ employeeId: z.string().uuid() });

function send(reply: FastifyReply, status: number, body: unknown) {
  reply.header("Cache-Control", "no-store");
  return reply.status(status).send(body);
}

function unitRefOf(placement: z.infer<typeof placementBody>): UnitRef {
  return { kind: "LEGACY_UNIT", id: placement.unitId };
}

function positionRefOf(placement: z.infer<typeof placementBody>): PositionRef | null {
  return placement.positionId ? { kind: "LEGACY_POSITION", id: placement.positionId } : null;
}

export async function registerEmploymentActionRoutes(app: FastifyInstance, pool: Pool, config: ApiConfig) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required for employment action routes");
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

  /** Actions exist only in AUTHORITATIVE (spec §8.1); preview is an action too. */
  async function requireAuthoritative(reply: FastifyReply): Promise<boolean> {
    const { mode } = await getRolloutMode(pool);
    if (mode !== "AUTHORITATIVE") {
      await send(reply, 409, { code: "EMPLOYMENT_HISTORY_DISABLED", message: "Riwayat kepegawaian belum diaktifkan." });
      return false;
    }
    return true;
  }

  /** The employee linked to the acting account, for the self-action guard. */
  async function actorEmployeeId(principal: AuthPrincipal): Promise<string | null> {
    const result = await pool.query<{ employeeId: string }>(
      `SELECT employee_id AS "employeeId" FROM accounts WHERE id = $1 AND employee_id IS NOT NULL`,
      [principal.id],
    );
    return result.rows[0]?.employeeId ?? null;
  }

  function toActionInput(body: ActionBody, documents: Awaited<ReturnType<typeof loadDecisionDocumentRefs>>): ActionInput {
    const shared = {
      reasonNote: body.reasonNote ?? null,
      documents,
      acknowledgedWarnings: body.acknowledgedWarnings ?? [],
    };
    switch (body.actionType) {
      case "HIRE":
        return {
          ...shared,
          actionType: "HIRE",
          effectiveOn: body.effectiveOn,
          category: body.category,
          termEndOn: body.termEndOn ?? null,
          staffType: body.staffType ?? null,
          contractReference: body.contractReference ?? null,
          placement: {
            kind: "PRIMARY",
            unitRef: unitRefOf(body.placement),
            positionRef: positionRefOf(body.placement),
            jobTitleLabel: body.placement.jobTitleLabel,
          },
        };
      case "CONTRACT_EXTENSION":
        return {
          ...shared,
          actionType: "CONTRACT_EXTENSION",
          effectiveOn: body.effectiveOn,
          termEndOn: body.termEndOn,
          contractReference: body.contractReference ?? null,
        };
      case "CATEGORY_CHANGE":
        return {
          ...shared,
          actionType: "CATEGORY_CHANGE",
          effectiveOn: body.effectiveOn,
          category: body.category,
          termEndOn: body.termEndOn ?? null,
          contractReference: body.contractReference ?? null,
        };
      case "TERMINATION":
        return { ...shared, actionType: "TERMINATION", lastDayOn: body.lastDayOn, reasonCode: body.reasonCode };
    }
  }

  function describePlan(plan: ActionPlan, history: EmploymentHistory, today: string) {
    return {
      actionType: plan.actionType,
      effectiveOn: plan.effectiveOn,
      reasonCode: plan.reasonCode,
      warnings: plan.warnings,
      previous: plan.previousSnapshot,
      next: plan.newSnapshot,
      documentIds: plan.documentIds,
      expectedVersion: plan.expectedVersion,
      /** The derived state once the action is recorded, not the current one. */
      state: resolveEmployment(applyPlan(history, plan, new Date().toISOString()), today, policy).state,
      /** EMP-005 D-15: when the employee's login account closes, if at all. */
      accountDeactivation:
        plan.actionType === "TERMINATION" && plan.effectiveOn
          ? { willDeactivate: true, onDate: addDays(plan.effectiveOn, 1) }
          : { willDeactivate: false, onDate: null },
    };
  }

  async function prepare(
    request: FastifyRequest,
    reply: FastifyReply,
    mode: "preview" | "record",
    session: { principal: AuthPrincipal; canCorrect: boolean },
    employeeId: string,
  ): Promise<
    | null
    | {
        plan: ActionPlan;
        history: EmploymentHistory;
        body: ActionBody;
        principal: AuthPrincipal;
        today: string;
      }
  > {
    const params = { data: { employeeId } };
    const body = actionBody.safeParse(request.body);
    if (!body.success) {
      await send(reply, 400, { code: "INVALID_EMPLOYMENT_REQUEST", message: "Data tindakan tidak valid." });
      return null;
    }
    if (!(await requireAuthoritative(reply))) return null;

    // A record removed from the master (EMP-001) is read-only history; an
    // action on it would re-project it as an active employee.
    const employee = await pool.query<{ id: string }>(
      "SELECT id FROM employees WHERE id = $1 AND removed_at IS NULL",
      [params.data.employeeId],
    );
    if (!employee.rows[0]) {
      await send(reply, 404, { code: "EMPLOYEE_NOT_FOUND", message: "Pegawai tidak ditemukan." });
      return null;
    }

    const today = jakartaToday();
    const history =
      (await loadHistories(pool, [params.data.employeeId])).get(params.data.employeeId) ??
      ({ employeeId: params.data.employeeId, employments: [], terms: [], placements: [], actions: [] } satisfies EmploymentHistory);
    if (body.data.actionType !== "HIRE" && history.employments.length === 0) {
      await send(reply, 409, {
        code: "EMPLOYMENT_BASELINE_MISSING",
        message: "Data awal kepegawaian pegawai ini belum tersedia.",
      });
      return null;
    }

    const requestedDocumentIds = body.data.documentIds ?? [];
    const documents = await loadDecisionDocumentRefs(pool, requestedDocumentIds);
    if (documents.length !== requestedDocumentIds.length) {
      await send(reply, 404, { code: "DECISION_DOCUMENT_NOT_FOUND", message: "Dokumen dasar tidak ditemukan." });
      return null;
    }
    try {
      const plan = planEmploymentAction(history, toActionInput(body.data, documents), policy, {
        today,
        actorEmployeeId: await actorEmployeeId(session.principal),
        canCorrect: session.canCorrect,
        mode,
        newId: randomUUID,
      });
      return { plan, history, body: body.data, principal: session.principal, today };
    } catch (error) {
      if (error instanceof EmploymentDomainError) {
        await send(reply, STATUS_BY_CODE[error.code], { code: error.code, message: error.message });
        return null;
      }
      throw error;
    }
  }

  app.post("/admin/employees/:employeeId/employment-actions/preview", async (request, reply) => {
    const session = await authenticate(request, reply, "employment.manage");
    if (!session) return;
    const params = employeeParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_EMPLOYMENT_REQUEST", message: "Pegawai tidak valid." });
    const prepared = await prepare(request, reply, "preview", session, params.data.employeeId);
    if (!prepared) return;
    return send(reply, 200, describePlan(prepared.plan, prepared.history, prepared.today));
  });

  app.post("/admin/employees/:employeeId/employment-actions", async (request, reply) => {
    // Authentication first: the replay lookup reads recorded actions, so it
    // must never answer an unauthenticated caller.
    const session = await authenticate(request, reply, "employment.manage");
    if (!session) return;
    const params = employeeParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_EMPLOYMENT_REQUEST", message: "Pegawai tidak valid." });

    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length < 8) {
      return send(reply, 400, {
        code: "IDEMPOTENCY_KEY_REQUIRED",
        message: "Permintaan tindakan membutuhkan header Idempotency-Key.",
      });
    }
    const replay = await findActionByIdempotencyKey(pool, idempotencyKey);
    if (replay) {
      // The same key for another employee is a client bug; answering "already
      // recorded" would drop that second action without anyone noticing.
      if (replay.employeeId !== params.data.employeeId) {
        return send(reply, 409, {
          code: "IDEMPOTENCY_KEY_CONFLICT",
          message: "Kunci idempotensi ini sudah dipakai untuk pegawai lain.",
        });
      }
      return send(reply, 200, { actionId: replay.id, replayed: true });
    }

    const prepared = await prepare(request, reply, "record", session, params.data.employeeId);
    if (!prepared) return;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await persistAction(client, {
        plan: prepared.plan,
        actorAccountId: prepared.principal.id,
        idempotencyKey,
        reasonNote: prepared.body.reasonNote ?? null,
        acknowledgedWarnings: prepared.body.acknowledgedWarnings ?? [],
        today: prepared.today,
      });
      await client.query("COMMIT");
      return send(reply, 201, {
        actionId: result.actionId,
        replayed: false,
        projection: result.projection,
        deactivatedAccounts: result.deactivatedAccountIds.length,
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
        const existing = await findActionByIdempotencyKey(pool, idempotencyKey);
        if (existing) return send(reply, 200, { actionId: existing.id, replayed: true });
      }
      // The exclusion constraints are the real concurrency defence: two
      // actions racing for the same period lose here, and that is a refusal
      // (spec §12), not a server error.
      if (sqlState === "23P01" || sqlState === "23505") {
        return send(reply, 409, {
          code: "EMPLOYMENT_OVERLAP",
          message: "Periode bertabrakan dengan data yang sudah ada.",
        });
      }
      throw error;
    } finally {
      client.release();
    }
  });
}
