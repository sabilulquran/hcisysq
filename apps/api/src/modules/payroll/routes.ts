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
  availableOperations,
  decideTransition,
  defaultCutoffWindow,
  mayReadPeriods,
  monthEnd,
  PERIOD_ACTIONS,
  reasonRequiredActions,
  type PeriodSnapshot,
  type PeriodState,
  type TransitionActor,
} from "./lifecycle.js";
import {
  applyTransition,
  countPeriods,
  createPeriod,
  getPeriod,
  hasCurrentCalculation,
  listEmploymentIdentities,
  listPeriods,
  listTransitions,
  writeAudit,
  type PeriodWithCalculation,
} from "./store.js";
import { applyAttendanceInputs } from "./attendance-inputs.js";
import {
  buildPeriodReport,
  buildTransferList,
  buildVariance,
  previousPeriodId,
  transferListToCsv,
} from "./reports.js";
import { calculatePeriod } from "./calculation.js";
import { draftPayslipsFromPeriod, publishPayslipsOfPeriod } from "./publication.js";
import {
  deleteInput,
  INPUT_KEYS,
  INPUT_ORIGINS,
  listInputs,
  listResults,
  ownEmploymentIds,
  saveInputs,
  type PeriodInputWrite,
} from "./inputs-store.js";

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

const transfersQuery = z.object({ format: z.enum(["json", "csv"]).default("json") });

const inputParams = z.object({
  periodId: z.string().uuid(),
  employmentId: z.string().uuid(),
  inputKey: z.enum(INPUT_KEYS),
});

const inputsBody = z.object({
  inputs: z
    .array(
      z.object({
        employmentId: z.string().uuid(),
        inputKey: z.enum(INPUT_KEYS),
        value: z.number().finite(),
        origin: z.enum(INPUT_ORIGINS).default("MANUAL"),
        reason: z.string().trim().max(500).optional(),
        decisionReference: z.string().trim().max(200).optional(),
      }),
    )
    .min(1)
    .max(2000)
    .superRefine((inputs, ctx) => {
      for (const [index, input] of inputs.entries()) {
        // Mirrors payroll_period_inputs_proration_range in migration 0069, so a
        // value out of range comes back as a 400 rather than a failed INSERT.
        if (input.inputKey === "PRORATION_FACTOR" && !(input.value > 0 && input.value <= 1)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, "value"],
            message: "Faktor prorata harus berada pada rentang 0 < f <= 1.",
          });
        }
        if (input.inputKey === "FULL_PAY_DESPITE_LEAVING" && input.value !== 0 && input.value !== 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, "value"],
            message: "Pernyataan dibayar penuh bernilai 0 atau 1.",
          });
        }
        if (NON_NEGATIVE_INPUTS.includes(input.inputKey) && input.value < 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, "value"],
            message: `Input ${input.inputKey} tidak boleh bernilai negatif.`,
          });
        }
      }
    }),
});

/** Only an adjustment may be negative; the rest are counts, hours or amounts. */
const NON_NEGATIVE_INPUTS: readonly string[] = [
  "OVERTIME_HOURS",
  "CONTRACT_ATTENDANCE_DAYS",
  "CONTRACT_TEACHING_HOURS",
  "CHILD_EDUCATION",
  "PJ_MEDIA",
  "ARREARS",
  "OTHER_INCOME",
  "TEACHING_HOURS_PER_WEEK_OVERRIDE",
  "ANNUAL_PERFORMANCE_OVERRIDE",
  "MONTHLY_PERFORMANCE_OVERRIDE",
];

/** Report readers see a period's figures only from this state onwards (section 6). */
const APPROVED_ONWARDS: readonly string[] = ["APPROVED", "PAYMENT_CONFIRMED", "PUBLISHED", "REOPEN_REQUESTED"];

const RUNNER_PERMISSIONS: readonly string[] = [
  "payroll.periods.manage",
  "payroll.calculate",
  "payroll.inputs.manage",
];

function runsPeriods(actor: TransitionActor): boolean {
  return RUNNER_PERMISSIONS.some((permission) => actor.organizationPermissions.includes(permission));
}

/** Section 4: these inputs change pay by hand, so they carry a reason. */
const REASON_REQUIRED: readonly string[] = [
  "ADJUSTMENT",
  "ARREARS",
  "PRORATION_FACTOR",
  "FULL_PAY_DESPITE_LEAVING",
];

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

  /** Any one of these permissions is enough. The check runs before the lookup. */
  async function requireAnyPermission(
    request: FastifyRequest,
    reply: FastifyReply,
    permissions: readonly string[],
  ): Promise<TransitionActor | null> {
    const authenticated = await authenticate(request, reply);
    if (!authenticated) return null;
    if (!permissions.some((permission) => authenticated.actor.organizationPermissions.includes(permission))) {
      await send(reply, 403, {
        code: "PAYROLL_FORBIDDEN",
        message: "Anda tidak memiliki akses untuk tindakan ini.",
      });
      return null;
    }
    return authenticated.actor;
  }

  /**
   * Reading a period is open to everyone who has a decision to make about it, not
   * only to whoever runs it. The check comes before the period is looked up, so a
   * 404 never tells an outsider which periods exist.
   */
  async function requireReader(request: FastifyRequest, reply: FastifyReply): Promise<TransitionActor | null> {
    const authenticated = await authenticate(request, reply);
    if (!authenticated) return null;
    if (!mayReadPeriods(authenticated.actor)) {
      await send(reply, 403, {
        code: "PAYROLL_FORBIDDEN",
        message: "Anda tidak memiliki akses untuk tindakan ini.",
      });
      return null;
    }
    return authenticated.actor;
  }

  /**
   * Per-person pay is sensitive, so reading it is itself recorded. The payload
   * carries the scope and a row count, never a figure (specification section 8).
   */
  async function recordSensitiveRead(
    accountId: string,
    periodId: string,
    scope: string,
    rowCount: number,
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await writeAudit(client, {
        actorAccountId: accountId,
        action: "payroll.report.read",
        periodId,
        payload: { scope, row_count: rowCount },
      });
    } finally {
      client.release();
    }
  }

  /**
   * The review threshold, read from policy so the process owner can move it. It
   * is guidance rather than a statutory rule, so its absence falls back to the
   * specification's default instead of refusing the comparison.
   */
  async function varianceThreshold(
    payDate: string,
  ): Promise<{ relative: number; absolute: number; manualInput: number }> {
    const { rows } = await pool.query<{
      payload: { relative?: number; absolute?: number; manualInput?: number };
    }>(
      `SELECT payload FROM payroll_policy_versions
       WHERE policy_key = 'VARIANCE_THRESHOLD'
         AND effective_from <= $1::date
         AND (effective_to IS NULL OR effective_to >= $1::date)
       LIMIT 1`,
      [payDate],
    );
    const payload = rows[0]?.payload;
    // A threshold has to be a non-negative number to mean anything; anything else
    // falls back to the specified default rather than filtering nothing at all.
    const positive = (value: unknown, fallback: number) =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
    return {
      relative: positive(payload?.relative, 0.1),
      absolute: positive(payload?.absolute, 50_000),
      manualInput: positive(payload?.manualInput, 1_000_000),
    };
  }

  function periodView(period: PeriodWithCalculation, actor: TransitionActor) {
    const snapshot = snapshotOf(period);
    return {
      ...period,
      hasCurrentCalculation: hasCurrentCalculation(period),
      availableActions: availableActions(snapshot, actor),
      // The work that is not a lifecycle transition, and which actions carry a
      // reason: a screen must not re-derive either from a state of its own.
      availableOperations: availableOperations(snapshot, actor),
      reasonRequiredActions: reasonRequiredActions(),
    };
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

    // Validate the window that will actually be stored, defaults included: giving
    // only one end would otherwise reach the database and fail its check there.
    const fallback = defaultCutoffWindow(periodMonth);
    const effectiveCutoffStart = cutoffStart ?? fallback.start;
    const effectiveCutoffEnd = cutoffEnd ?? fallback.end;
    if (effectiveCutoffEnd < effectiveCutoffStart) {
      return send(reply, 400, {
        code: "PAYROLL_INVALID_PERIOD",
        message: "Akhir cutoff mendahului awalnya.",
      });
    }
    if (payDate && (payDate < periodMonth || payDate > monthEnd(periodMonth))) {
      return send(reply, 400, {
        code: "PAYROLL_INVALID_PERIOD",
        message: "Tanggal gajian berada di luar bulan periode.",
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
    const actor = await requireReader(request, reply);
    if (!actor) return;

    const parsed = listQuery.safeParse(request.query ?? {});
    if (!parsed.success) {
      return send(reply, 400, { code: "PAYROLL_INVALID_QUERY", message: "Parameter tidak valid." });
    }
    const { page, pageSize } = parsed.data;
    const [periods, total] = await Promise.all([
      listPeriods(pool, pageSize, (page - 1) * pageSize),
      countPeriods(pool),
    ]);
    return send(reply, 200, {
      page,
      pageSize,
      total,
      periods: periods.map((period) => periodView(period, actor)),
    });
  });

  app.get("/payroll/periods/:periodId", async (request, reply) => {
    const actor = await requireReader(request, reply);
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
      period: periodView(period, actor),
      transitions: await listTransitions(pool, period.id),
    });
  });

  app.get("/payroll/periods/:periodId/inputs", async (request, reply) => {
    const actor = await requireReader(request, reply);
    if (!actor) return;
    const params = periodParams.safeParse(request.params);
    if (!params.success) {
      return send(reply, 400, { code: "PAYROLL_INVALID_QUERY", message: "Identifier periode tidak valid." });
    }
    const period = await getPeriod(pool, params.data.periodId);
    if (!period) {
      return send(reply, 404, { code: "PAYROLL_PERIOD_NOT_FOUND", message: "Periode tidak ditemukan." });
    }
    return send(reply, 200, { inputs: await listInputs(pool, period.id) });
  });

  app.put("/payroll/periods/:periodId/inputs", async (request, reply) => {
    const actor = await requirePermission(request, reply, "payroll.inputs.manage");
    if (!actor) return;

    const params = periodParams.safeParse(request.params);
    const body = inputsBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return send(reply, 400, {
        code: "PAYROLL_INVALID_INPUT",
        message: body.success ? "Identifier periode tidak valid." : (body.error.issues[0]?.message ?? "Input tidak valid."),
      });
    }

    const period = await getPeriod(pool, params.data.periodId);
    if (!period) {
      return send(reply, 404, { code: "PAYROLL_PERIOD_NOT_FOUND", message: "Periode tidak ditemukan." });
    }
    // Inputs belong to the collecting phase. Once a period is calculated and on
    // its way to approval, changing them behind the calculation is not an edit
    // but a different period (specification section 6).
    if (period.state !== "COLLECTING" && period.state !== "CALCULATED") {
      return send(reply, 409, {
        code: "PAYROLL_STATE_CONFLICT",
        message: `Input hanya dapat diubah saat periode COLLECTING atau CALCULATED; periode ini ${period.state}.`,
      });
    }

    const missingReason = body.data.inputs.find(
      (input) => REASON_REQUIRED.includes(input.inputKey) && (input.reason ?? "").trim().length === 0,
    );
    if (missingReason) {
      return send(reply, 400, {
        code: "PAYROLL_REASON_REQUIRED",
        message: `Input ${missingReason.inputKey} membutuhkan alasan.`,
      });
    }
    const missingDecision = body.data.inputs.find(
      (input) => input.inputKey === "ADJUSTMENT" && (input.decisionReference ?? "").trim().length === 0,
    );
    if (missingDecision) {
      return send(reply, 400, {
        code: "PAYROLL_DECISION_REQUIRED",
        message: "Penyesuaian gaji membutuhkan referensi keputusan.",
      });
    }

    const own = await ownEmploymentIds(pool, actor.accountId);
    if (body.data.inputs.some((input) => own.has(input.employmentId))) {
      return send(reply, 403, {
        code: "PAYROLL_OWN_RECORD",
        message: "Anda tidak dapat mencatat input periode untuk diri sendiri.",
      });
    }

    try {
      await saveInputs(pool, period.id, body.data.inputs as PeriodInputWrite[], actor.accountId);
    } catch (error) {
      const code = (error as { code?: string }).code;
      // A check or foreign key the request violated is the caller's mistake, not
      // a server fault: an unknown employment, or a value the schema refuses.
      if (code === "23514") {
        return send(reply, 400, { code: "PAYROLL_INVALID_INPUT", message: "Nilai input ditolak oleh aturan periode." });
      }
      if (code === "23503") {
        return send(reply, 404, { code: "PAYROLL_INPUT_NOT_FOUND", message: "Employment tidak ditemukan." });
      }
      throw error;
    }
    return send(reply, 200, { inputs: await listInputs(pool, period.id) });
  });

  app.post("/payroll/periods/:periodId/inputs/from-attendance", async (request, reply) => {
    const actor = await requirePermission(request, reply, "payroll.inputs.manage");
    if (!actor) return;

    const params = periodParams.safeParse(request.params);
    if (!params.success) {
      return send(reply, 400, { code: "PAYROLL_INVALID_INPUT", message: "Identifier periode tidak valid." });
    }
    const period = await getPeriod(pool, params.data.periodId);
    if (!period) {
      return send(reply, 404, { code: "PAYROLL_PERIOD_NOT_FOUND", message: "Periode tidak ditemukan." });
    }
    if (period.state !== "COLLECTING" && period.state !== "CALCULATED") {
      return send(reply, 409, {
        code: "PAYROLL_STATE_CONFLICT",
        message: `Input hanya dapat diubah saat periode COLLECTING atau CALCULATED; periode ini ${period.state}.`,
      });
    }

    // Resolving is an explicit action rather than something the calculation does,
    // because it overwrites whatever is stored for those two keys, including a
    // correction human capital typed by hand.
    const counts = await applyAttendanceInputs(
      pool,
      {
        periodId: period.id,
        cutoffStart: period.cutoffStart,
        cutoffEnd: period.cutoffEnd,
        legalEntityKey: period.legalEntityKey,
      },
      actor.accountId,
    );

    return send(reply, 200, { ...counts, inputs: await listInputs(pool, period.id) });
  });

  app.delete("/payroll/periods/:periodId/inputs/:employmentId/:inputKey", async (request, reply) => {
    const actor = await requirePermission(request, reply, "payroll.inputs.manage");
    if (!actor) return;

    const params = inputParams.safeParse(request.params);
    if (!params.success) {
      return send(reply, 400, { code: "PAYROLL_INVALID_INPUT", message: "Identifier input tidak valid." });
    }
    const period = await getPeriod(pool, params.data.periodId);
    if (!period) {
      return send(reply, 404, { code: "PAYROLL_PERIOD_NOT_FOUND", message: "Periode tidak ditemukan." });
    }
    if (period.state !== "COLLECTING" && period.state !== "CALCULATED") {
      return send(reply, 409, {
        code: "PAYROLL_STATE_CONFLICT",
        message: `Input hanya dapat diubah saat periode COLLECTING atau CALCULATED; periode ini ${period.state}.`,
      });
    }
    const own = await ownEmploymentIds(pool, actor.accountId);
    if (own.has(params.data.employmentId)) {
      return send(reply, 403, {
        code: "PAYROLL_OWN_RECORD",
        message: "Anda tidak dapat mengubah input periode untuk diri sendiri.",
      });
    }

    const removed = await deleteInput(
      pool,
      period.id,
      params.data.employmentId,
      params.data.inputKey,
      actor.accountId,
    );
    if (!removed) {
      return send(reply, 404, { code: "PAYROLL_INPUT_NOT_FOUND", message: "Input tidak ditemukan." });
    }
    return send(reply, 204, null);
  });

  app.get("/payroll/periods/:periodId/results", async (request, reply) => {
    const actor = await requireReader(request, reply);
    if (!actor) return;

    const params = periodParams.safeParse(request.params);
    if (!params.success) {
      return send(reply, 400, { code: "PAYROLL_INVALID_QUERY", message: "Identifier periode tidak valid." });
    }
    const period = await getPeriod(pool, params.data.periodId);
    if (!period) {
      return send(reply, 404, { code: "PAYROLL_PERIOD_NOT_FOUND", message: "Periode tidak ditemukan." });
    }

    // Section 6: the payroll report becomes visible to report readers only once
    // the period is approved. Before that, only the people running the period
    // see the figures they are still working on.
    if (!APPROVED_ONWARDS.includes(period.state) && !runsPeriods(actor)) {
      return send(reply, 409, {
        code: "PAYROLL_NOT_APPROVED_YET",
        message: "Hasil periode baru dapat dibaca setelah periode disahkan.",
      });
    }

    const { results, lines } = await listResults(pool, period.id);
    // Per-person pay is sensitive, so reading it is itself recorded
    // (specification section 2 and section 8).
    const client = await pool.connect();
    try {
      await writeAudit(client, {
        actorAccountId: actor.accountId,
        action: "payroll.report.read",
        periodId: period.id,
        payload: { row_count: results.length, scope: "period_results" },
      });
    } finally {
      client.release();
    }

    return send(reply, 200, { results, lines, employees: await listEmploymentIdentities(pool, period.id) });
  });

  app.get("/payroll/periods/:periodId/report", async (request, reply) => {
    // Section 7 names payroll.reports.read.organization for this report. Holding
    // payroll.approve or payroll.payments.confirm is a decision, not a licence to
    // read the figures; the people running the period see it throughout.
    const actor = await requireAnyPermission(request, reply, [
      "payroll.reports.read.organization",
      ...RUNNER_PERMISSIONS,
    ]);
    if (!actor) return;

    const params = periodParams.safeParse(request.params);
    if (!params.success) {
      return send(reply, 400, { code: "PAYROLL_INVALID_QUERY", message: "Identifier periode tidak valid." });
    }
    const period = await getPeriod(pool, params.data.periodId);
    if (!period) {
      return send(reply, 404, { code: "PAYROLL_PERIOD_NOT_FOUND", message: "Periode tidak ditemukan." });
    }
    if (!APPROVED_ONWARDS.includes(period.state) && !runsPeriods(actor)) {
      return send(reply, 409, {
        code: "PAYROLL_NOT_APPROVED_YET",
        message: "Laporan periode baru dapat dibaca setelah periode disahkan.",
      });
    }

    const report = await buildPeriodReport(pool, period.id);
    await recordSensitiveRead(actor.accountId, period.id, "period_report", report.totals.employeeCount);
    return send(reply, 200, { report });
  });

  app.get("/payroll/periods/:periodId/transfers", async (request, reply) => {
    // The transfer list carries account numbers, so it has a permission of its
    // own and the director does not hold it (specification section 7).
    const actor = await requirePermission(request, reply, "payroll.transfers.read.organization");
    if (!actor) return;

    const params = periodParams.safeParse(request.params);
    const query = transfersQuery.safeParse(request.query ?? {});
    if (!params.success || !query.success) {
      return send(reply, 400, { code: "PAYROLL_INVALID_QUERY", message: "Parameter tidak valid." });
    }
    const period = await getPeriod(pool, params.data.periodId);
    if (!period) {
      return send(reply, 404, { code: "PAYROLL_PERIOD_NOT_FOUND", message: "Periode tidak ditemukan." });
    }
    if (!APPROVED_ONWARDS.includes(period.state)) {
      return send(reply, 409, {
        code: "PAYROLL_NOT_APPROVED_YET",
        message: "Daftar transfer baru tersedia setelah periode disahkan.",
      });
    }

    const transfers = await buildTransferList(pool, period.id);
    await recordSensitiveRead(
      actor.accountId,
      period.id,
      query.data.format === "csv" ? "transfer_list_csv" : "transfer_list",
      transfers.length,
    );

    if (query.data.format === "csv") {
      reply.header("Cache-Control", "no-store");
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header(
        "Content-Disposition",
        `attachment; filename="daftar-transfer-${period.periodMonth.slice(0, 7)}.csv"`,
      );
      return reply.status(200).send(transferListToCsv(transfers));
    }
    return send(reply, 200, { transfers });
  });

  app.get("/payroll/periods/:periodId/variance", async (request, reply) => {
    const actor = await requireAnyPermission(request, reply, [
      "payroll.reports.read.organization",
      ...RUNNER_PERMISSIONS,
    ]);
    if (!actor) return;

    const params = periodParams.safeParse(request.params);
    if (!params.success) {
      return send(reply, 400, { code: "PAYROLL_INVALID_QUERY", message: "Identifier periode tidak valid." });
    }
    const period = await getPeriod(pool, params.data.periodId);
    if (!period) {
      return send(reply, 404, { code: "PAYROLL_PERIOD_NOT_FOUND", message: "Periode tidak ditemukan." });
    }
    if (!APPROVED_ONWARDS.includes(period.state) && !runsPeriods(actor)) {
      return send(reply, 409, {
        code: "PAYROLL_NOT_APPROVED_YET",
        message: "Perbandingan periode baru dapat dibaca setelah periode disahkan.",
      });
    }

    const previousId = await previousPeriodId(pool, period.id);
    if (previousId === null) {
      // The first period has nothing to compare against, which is an answer
      // rather than an error.
      return send(reply, 200, { previousPeriodId: null, threshold: null, variances: [], employees: [] });
    }

    const threshold = await varianceThreshold(period.payDate);
    const variances = await buildVariance(pool, period.id, previousId, threshold);
    await recordSensitiveRead(actor.accountId, period.id, "period_variance", variances.length);
    return send(reply, 200, {
      previousPeriodId: previousId,
      threshold,
      variances,
      employees: await listEmploymentIdentities(pool, period.id),
    });
  });

  app.post("/payroll/periods/:periodId/payslips", async (request, reply) => {
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
    // Section 6: slips are drafted once the payment is confirmed. Drafting them
    // earlier would put a figure in front of an employee that nobody has paid.
    if (period.state !== "PAYMENT_CONFIRMED" && period.state !== "PUBLISHED") {
      return send(reply, 409, {
        code: "PAYROLL_STATE_CONFLICT",
        message: `Slip baru dapat disiapkan setelah pembayaran dikonfirmasi; periode ini ${period.state}.`,
      });
    }

    const outcome = await draftPayslipsFromPeriod(pool, period.id, actor.accountId);
    if (!outcome.ok) {
      return send(reply, 409, {
        code: outcome.code,
        message:
          outcome.code === "PAYROLL_BLOCKERS_PRESENT"
            ? `Periode masih memiliki ${outcome.blockerCount} blocker; slip tidak disiapkan.`
            : outcome.code === "PAYROLL_STATE_CONFLICT"
              ? `Periode berubah menjadi ${outcome.state} saat slip disiapkan; muat ulang lalu coba lagi.`
              : "Periode belum memiliki hasil yang dapat dijadikan slip.",
      });
    }

    // Drafting is where payroll stops. Publishing is a separate call that asks
    // for payslips.publish, so the decision to show a slip stays where PAY-002
    // put it.
    return send(reply, 200, {
      drafted: outcome.drafted,
      revised: outcome.revised,
      alreadyCurrent: outcome.alreadyCurrent,
      importConflicts: outcome.importConflicts,
    });
  });

  app.post("/payroll/periods/:periodId/payslips/publish", async (request, reply) => {
    // payslips.publish, not a payroll permission: showing a slip to an employee
    // is the PAY-002 decision, and payroll does not take it over by calculating.
    const actor = await requirePermission(request, reply, "payslips.publish");
    if (!actor) return;

    const params = periodParams.safeParse(request.params);
    if (!params.success) {
      return send(reply, 400, { code: "PAYROLL_INVALID_QUERY", message: "Identifier periode tidak valid." });
    }

    const outcome = await publishPayslipsOfPeriod(pool, params.data.periodId, actor.accountId);
    if (!outcome.ok) {
      return send(reply, 409, {
        code: outcome.code,
        message:
          outcome.code === "PAYROLL_STATE_CONFLICT"
            ? `Periode berstatus ${outcome.state}; slip hanya dapat diterbitkan setelah pembayaran dikonfirmasi.`
            : "Tidak ada slip draft dari periode ini untuk diterbitkan.",
      });
    }
    return send(reply, 200, { published: outcome.published });
  });

  app.post("/payroll/periods/:periodId/transitions", async (request, reply) => {
    const actor = await requireReader(request, reply);
    if (!actor) return;

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

    // Calculating is the one action that does work of its own before the state
    // moves: the results it writes are what the next transitions are judged on.
    if (body.data.action === "calculate") {
      const outcome = await calculatePeriod(
        pool,
        {
          id: period.id,
          legalEntityKey: period.legalEntityKey,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          payDate: period.payDate,
        },
        actor.accountId,
        period.version,
      );
      if (outcome.conflict) {
        return send(reply, 409, {
          code: "PAYROLL_STATE_CONFLICT",
          message: "Periode berubah saat perhitungan dimulai; muat ulang lalu coba lagi.",
        });
      }
      if (outcome.policyProblems.length > 0) {
        return send(reply, 409, {
          code: "PAYROLL_POLICY_MISSING",
          message: "Kebijakan payroll belum lengkap untuk tanggal gajian periode ini.",
          problems: outcome.policyProblems,
        });
      }
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
      fromState: period.state,
    });

    if (!result.applied) {
      return send(reply, 409, {
        code: "PAYROLL_STATE_CONFLICT",
        message: "Periode berubah saat permintaan ini diproses; muat ulang lalu coba lagi.",
      });
    }

    const refreshed = await getPeriod(pool, period.id);
    return send(reply, 200, {
      period: refreshed ? periodView(refreshed, actor) : result.period,
      applied: true,
    });
  });
}
