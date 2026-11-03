// PERF-001 Package 1 routes: cycles, self-assessment, rating by the structural line manager,
// HC validation, history and recap. Spec: docs/domain/performance-review.md.
//
// performance.* is HC-only: legacy Super Admin compatibility never grants it, so the admin routes
// resolve the permission from the organization context directly, like trips.*. Employee and rater
// access is ownership (the session's employee, the snapshotted rater), never a permission.
//
// Lock order everywhere: cycle, then review. Closing a cycle takes the cycle FOR UPDATE; every
// review transition takes it FOR SHARE, so a rating cannot land in a cycle that is being closed.

import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { pageOffset, pageQuerySchema, pagination } from "../../lib/pagination.js";
import type { PerformancePermission } from "../auth/permissions.js";
import { AUTH_COOKIE_NAME, AuthService, readCookie, type AuthPrincipal } from "../auth/service.js";
import { jakartaDate } from "../documents/service.js";
import { notifyEmployee } from "../notifications/service.js";
import {
  OrganizationAuthorityResolver,
  OrganizationResolutionError,
  OrganizationRolloutService,
  PostgresOrganizationRepository,
} from "../organization/index.js";
import {
  ACTIVE_REVIEW_STATUSES,
  canRaterReview,
  CYCLE_KINDS,
  CYCLE_STATUSES,
  DEFAULT_RUBRIC,
  finalScore,
  PerformancePolicyError,
  predicateFor,
  REVIEW_STATUSES,
  trendFrom,
  validateCyclePeriod,
  validateRubric,
  validateScores,
  type CycleKind,
  type CycleStatus,
  type ReviewStatus,
  type Rubric,
} from "./domain.js";

type Queryable = Pool | PoolClient;

/** D-01 DRAFT: ORG-004 rollout key; without a rollout row the mode is LEGACY. */
const PERFORMANCE_WORKFLOW_KEY = "PERF";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const code = z.string().trim().min(1).max(40);
const rubricSchema = z.object({
  indicators: z.array(z.object({
    code,
    label: z.string().trim().min(2).max(80),
    description: z.string().trim().max(300).default(""),
    weight: z.number(),
  })).min(1).max(20),
  predicates: z.array(z.object({
    code,
    label: z.string().trim().min(1).max(40),
    minScore: z.number(),
  })).min(2).max(6),
});
const cycleFields = {
  name: z.string().trim().min(3).max(120),
  kind: z.enum(CYCLE_KINDS),
  periodStart: isoDate,
  periodEnd: isoDate,
  selfDueOn: isoDate,
  reviewDueOn: isoDate,
};
const createCycleBody = z.object({ ...cycleFields, rubric: rubricSchema.optional() });
const patchCycleBody = z.object({
  name: cycleFields.name.optional(),
  kind: cycleFields.kind.optional(),
  periodStart: isoDate.optional(),
  periodEnd: isoDate.optional(),
  selfDueOn: isoDate.optional(),
  reviewDueOn: isoDate.optional(),
  rubric: rubricSchema.optional(),
});
const participantsBody = z.union([
  z.object({ employeeIds: z.array(z.string().uuid()).min(1).max(100) }).strict(),
  z.object({ allActive: z.literal(true) }).strict(),
]);
const scoresSchema = z.record(z.string(), z.number());
const selfBody = z.object({ scores: scoresSchema, note: z.string().trim().max(2000).nullable().optional() });
const ratingBody = z.object({
  scores: scoresSchema,
  strengths: z.string().trim().max(2000).nullable().optional(),
  improvements: z.string().trim().max(2000).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
});
const acknowledgeBody = z.object({ comment: z.string().trim().max(1000).nullable().optional() });
const reasonBody = z.object({ reason: z.string().trim().min(5).max(500) });
const cancelCycleBody = z.object({ reason: z.string().trim().min(10).max(500) });
const returnBody = z.object({ reason: z.string().trim().min(10).max(1000) });
const raterBody = z.object({ raterEmployeeId: z.string().uuid(), reason: z.string().trim().min(5).max(500) });
const idParams = z.object({ id: z.string().uuid() });
const employeeParams = z.object({ employeeId: z.string().uuid() });
const cycleListQuery = pageQuerySchema.extend({ status: z.enum(CYCLE_STATUSES).optional() });
const reviewStatusQuery = pageQuerySchema.extend({ status: z.enum(REVIEW_STATUSES).optional() });
const adminReviewQuery = reviewStatusQuery.extend({
  predicate: code.optional(),
  employeeId: z.string().uuid().optional(),
  raterMissing: z.enum(["true", "false"]).optional(),
  q: z.string().trim().min(2).max(100).optional(),
});

class PerformanceError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = "PerformanceError";
  }
}

const NOT_FOUND = () => new PerformanceError(404, "PERFORMANCE_REVIEW_NOT_FOUND", "Penilaian kinerja tidak ditemukan.");
const CYCLE_NOT_FOUND = () => new PerformanceError(404, "PERFORMANCE_CYCLE_NOT_FOUND", "Siklus penilaian tidak ditemukan.");
const CYCLE_NOT_OPEN = () => new PerformanceError(409, "PERFORMANCE_CYCLE_NOT_OPEN", "Siklus penilaian ini sedang tidak dibuka.");

function send(reply: FastifyReply, status: number, body: unknown) {
  reply.header("Cache-Control", "no-store");
  return reply.status(status).send(body);
}

function today(): string {
  return jakartaDate(new Date());
}

function knownError(error: unknown): PerformanceError | null {
  if (error instanceof PerformanceError) return error;
  if (error instanceof PerformancePolicyError) return new PerformanceError(400, error.code, error.message);
  const database = error as { code?: string; constraint?: string };
  if (database?.code === "23505" && database.constraint === "performance_cycles_period_idx") {
    return new PerformanceError(409, "PERFORMANCE_CYCLE_PERIOD_TAKEN", "Periode ini sudah memiliki siklus penilaian dengan jenis yang sama.");
  }
  return null;
}

async function loadEmployee(db: Queryable, accountId: string): Promise<{ id: string; fullName: string }> {
  const result = await db.query<{ id: string; fullName: string; status: string }>(
    `SELECT employee.id, employee.full_name AS "fullName", employee.status
       FROM accounts account
       JOIN employees employee ON employee.id = account.employee_id
      WHERE account.id = $1 AND account.principal_type = 'EMPLOYEE' AND account.status = 'active'
        AND employee.removed_at IS NULL`,
    [accountId],
  );
  const employee = result.rows[0];
  if (!employee || employee.status !== "active") {
    throw new PerformanceError(403, "EMPLOYEE_NOT_ACTIVE", "Akun tidak terhubung ke pegawai aktif.");
  }
  return employee;
}

interface ResolvedRater {
  employeeId: string | null;
  source: "DIRECT_MANAGER" | "GOVERNANCE_APPROVER" | null;
  snapshot: Record<string, unknown>;
}

/**
 * D-01: the line manager from the same resolver as APR-001 and overtime (ORG-002 data while the
 * PERF workflow is LEGACY, the ORG-004 structure when it is STRUCTURE). An unresolved rater is not
 * an error here: the review is stored without one and HC assigns it.
 */
async function resolveRater(db: Queryable, employeeId: string, effectiveDate: string): Promise<ResolvedRater> {
  const legacy = await db.query<{ directManagerEmployeeId: string | null }>(
    `SELECT direct_manager_employee_id AS "directManagerEmployeeId" FROM employees WHERE id = $1`,
    [employeeId],
  );
  const repository = new PostgresOrganizationRepository(db);
  const rollout = new OrganizationRolloutService(repository, new OrganizationAuthorityResolver(repository));
  let result;
  try {
    result = await rollout.resolveAuthorities({
      workflowKey: PERFORMANCE_WORKFLOW_KEY,
      requesterEmployeeId: employeeId,
      effectiveDate,
      legacy: { directManagerEmployeeId: legacy.rows[0]?.directManagerEmployeeId ?? null, unitApproverEmployeeId: null },
      authorityRequirement: "LINE_AND_UNIT",
    });
  } catch (error) {
    if (error instanceof OrganizationResolutionError) {
      return { employeeId: null, source: null, snapshot: { unresolved: error.code, effectiveDate } };
    }
    throw error;
  }
  const sourcesOf = (authority: (typeof result.authorities)[number]) => authority.sources ?? [authority.source];
  const authority = result.authorities.find((item) => sourcesOf(item).includes("DIRECT_MANAGER"))
    ?? result.authorities.find((item) => sourcesOf(item).includes("GOVERNANCE_APPROVER"));
  const base = { mode: result.mode, authoritativeSource: result.authoritativeSource, effectiveDate };
  if (!authority || authority.employeeId === employeeId) {
    return { employeeId: null, source: null, snapshot: { ...base, unresolved: "DIRECT_MANAGER_MISSING" } };
  }
  const active = await db.query("SELECT 1 FROM employees WHERE id = $1 AND status = 'active' AND removed_at IS NULL", [authority.employeeId]);
  if (!active.rows[0]) {
    return { employeeId: null, source: null, snapshot: { ...base, unresolved: "RATER_NOT_ACTIVE" } };
  }
  return {
    employeeId: authority.employeeId,
    source: sourcesOf(authority).includes("DIRECT_MANAGER") ? "DIRECT_MANAGER" : "GOVERNANCE_APPROVER",
    snapshot: { ...base, source: authority.source, path: authority.path, incumbentKind: authority.incumbentKind },
  };
}

async function addEvent(
  db: PoolClient,
  input: { cycleId: string; reviewId?: string | null; actorAccountId: string | null; eventType: string; note?: string | null; metadata?: Record<string, unknown> },
) {
  // clock_timestamp(), not now(): events written in one transaction keep their order.
  await db.query(
    `INSERT INTO performance_events (id, cycle_id, review_id, event_type, actor_account_id, note, metadata, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, clock_timestamp())`,
    [randomUUID(), input.cycleId, input.reviewId ?? null, input.eventType, input.actorAccountId, input.note ?? null,
      JSON.stringify(input.metadata ?? {})],
  );
}

interface CycleRow {
  id: string;
  name: string;
  kind: CycleKind;
  periodStart: string;
  periodEnd: string;
  selfDueOn: string;
  reviewDueOn: string;
  status: CycleStatus;
  rubric: Rubric;
}

const CYCLE_COLUMNS = `
  cycle.id, cycle.name, cycle.kind, cycle.status,
  to_char(cycle.period_start, 'YYYY-MM-DD') AS "periodStart", to_char(cycle.period_end, 'YYYY-MM-DD') AS "periodEnd",
  to_char(cycle.self_due_on, 'YYYY-MM-DD') AS "selfDueOn", to_char(cycle.review_due_on, 'YYYY-MM-DD') AS "reviewDueOn"`;

async function loadCycle(db: Queryable, id: string, lock: "" | "FOR UPDATE" | "FOR SHARE" = ""): Promise<CycleRow> {
  const result = await db.query<CycleRow>(
    `SELECT ${CYCLE_COLUMNS}, cycle.rubric FROM performance_cycles cycle WHERE cycle.id = $1 ${lock}`,
    [id],
  );
  const cycle = result.rows[0];
  if (!cycle) throw CYCLE_NOT_FOUND();
  return cycle;
}

interface LockedReview {
  id: string;
  cycleId: string;
  employeeId: string;
  status: ReviewStatus;
  raterEmployeeId: string | null;
  predicateCode: string | null;
}

/**
 * Locks the review's cycle (FOR SHARE, or FOR UPDATE) and then the review. `owner` narrows the
 * review to the session's employee or to the snapshotted rater, so somebody else's review is a 404.
 */
async function lockReview(
  db: PoolClient,
  id: string,
  owner: { employeeId?: string; raterEmployeeId?: string } = {},
): Promise<{ review: LockedReview; cycle: CycleRow }> {
  const cycleId = await db.query<{ cycleId: string }>(
    `SELECT cycle_id AS "cycleId" FROM performance_reviews
      WHERE id = $1 AND ($2::uuid IS NULL OR employee_id = $2) AND ($3::uuid IS NULL OR rater_employee_id = $3)`,
    [id, owner.employeeId ?? null, owner.raterEmployeeId ?? null],
  );
  if (!cycleId.rows[0]) throw NOT_FOUND();
  const cycle = await loadCycle(db, cycleId.rows[0].cycleId, "FOR SHARE");
  const found = await db.query<LockedReview>(
    `SELECT id, cycle_id AS "cycleId", employee_id AS "employeeId", status,
            rater_employee_id AS "raterEmployeeId", predicate_code AS "predicateCode"
       FROM performance_reviews
      WHERE id = $1 AND ($2::uuid IS NULL OR employee_id = $2) AND ($3::uuid IS NULL OR rater_employee_id = $3)
      FOR UPDATE`,
    [id, owner.employeeId ?? null, owner.raterEmployeeId ?? null],
  );
  if (!found.rows[0]) throw NOT_FOUND();
  return { review: found.rows[0], cycle };
}

type View = "employee" | "rater" | "hc";

/** Employees see their own history without HC's calibration notes (spec §9). */
const EMPLOYEE_VISIBLE_EVENTS = [
  "performance.review.added", "performance.review.readded", "performance.review.self_submitted",
  "performance.review.finalized", "performance.review.acknowledged", "performance.review.unrated",
];

const REVIEW_COLUMNS = `
  review.id, review.status, review.cycle_id AS "cycleId",
  cycle.name AS "cycleName", cycle.kind AS "cycleKind", cycle.status AS "cycleStatus",
  to_char(cycle.period_start, 'YYYY-MM-DD') AS "periodStart", to_char(cycle.period_end, 'YYYY-MM-DD') AS "periodEnd",
  to_char(cycle.self_due_on, 'YYYY-MM-DD') AS "selfDueOn", to_char(cycle.review_due_on, 'YYYY-MM-DD') AS "reviewDueOn",
  review.employee_id AS "employeeId", employee.full_name AS "employeeName", employee.employee_number AS "employeeNumber",
  unit.name AS "unitName",
  review.rater_employee_id AS "raterEmployeeId", rater.full_name AS "raterName", review.rater_source AS "raterSource",
  (rater_account.status = 'active') AS "raterAccountReady",
  review.self_submitted_at AS "selfSubmittedAt", review.rated_at AS "ratedAt",
  review.finalized_at AS "finalizedAt", review.acknowledged_at AS "acknowledgedAt", review.trend`;
const REVIEW_JOINS = `
  JOIN performance_cycles cycle ON cycle.id = review.cycle_id
  JOIN employees employee ON employee.id = review.employee_id
  LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
  LEFT JOIN employees rater ON rater.id = review.rater_employee_id
  LEFT JOIN accounts rater_account ON rater_account.employee_id = rater.id AND rater_account.principal_type = 'EMPLOYEE'`;

/**
 * The result columns; an employee sees them only once the review is FINALIZED (D-09). In the HC
 * views `viewerParam` names the viewer's employee id, so an HC admin who is a participant does not
 * see their own result early either.
 */
function resultColumns(view: View, viewerParam?: string) {
  const visible = view === "employee"
    ? "review.status = 'FINALIZED'"
    : view === "hc" && viewerParam
      ? `(review.status = 'FINALIZED' OR review.employee_id IS DISTINCT FROM ${viewerParam}::uuid)`
      : "TRUE";
  return `
    CASE WHEN ${visible} THEN review.final_score::float8 END AS "finalScore",
    CASE WHEN ${visible} THEN review.predicate_code END AS "predicateCode",
    CASE WHEN ${visible} THEN review.predicate_label END AS "predicateLabel"`;
}

function listItem({ total, ...row }: Record<string, unknown> & { total?: number }) {
  void total;
  return row;
}

async function employeeIdOf(db: Queryable, accountId: string): Promise<string | null> {
  const result = await db.query<{ employeeId: string | null }>(`SELECT employee_id AS "employeeId" FROM accounts WHERE id = $1`, [accountId]);
  return result.rows[0]?.employeeId ?? null;
}

async function loadReviewDetail(
  db: Queryable,
  id: string,
  view: View,
  owner: { employeeId?: string; raterEmployeeId?: string; viewerEmployeeId?: string | null } = {},
) {
  const found = await db.query<Record<string, unknown> & {
    status: ReviewStatus; cycleStatus: CycleStatus; selfDueOn: string; rubric: Rubric;
    selfScores: unknown; selfNote: string | null; raterScores: unknown; strengths: string | null;
    improvements: string | null; raterNote: string | null; acknowledgementComment: string | null;
  }>(
    `SELECT ${REVIEW_COLUMNS}, ${resultColumns(view, "$5")}, cycle.rubric,
            review.self_scores AS "selfScores", review.self_note AS "selfNote",
            review.rater_scores AS "raterScores", review.strengths, review.improvements, review.rater_note AS "raterNote",
            review.acknowledgement_comment AS "acknowledgementComment", review.removed_reason AS "removedReason"
       FROM performance_reviews review
       ${REVIEW_JOINS}
      WHERE review.id = $1
        AND ($2::uuid IS NULL OR review.employee_id = $2)
        AND ($3::uuid IS NULL OR review.rater_employee_id = $3)
        AND ($4::boolean OR cycle.status IN ('OPEN', 'CLOSED'))`,
    // $5 exists only in the HC query: an unreferenced parameter has no type and fails in PostgreSQL.
    [id, owner.employeeId ?? null, owner.raterEmployeeId ?? null, view === "hc", ...(view === "hc" ? [owner.viewerEmployeeId ?? null] : [])],
  );
  const row = found.rows[0];
  if (!row) return null;
  // An HC admin reading their own review gets the employee's view of it (PERF-001-A, D-07).
  const viewer = view === "hc" ? owner.viewerEmployeeId ?? null : null;
  const ownReview = viewer !== null && row.employeeId === viewer;
  const viewerIsRater = viewer !== null && row.raterEmployeeId === viewer;
  const restricted = view === "employee" || ownReview;
  // HC sees every note; the rater only HC's return reasons; the employee none (spec §9).
  const events = await db.query(
    `SELECT event.id, event.event_type AS "eventType", event.occurred_at AS "occurredAt",
            CASE WHEN $3::boolean OR ($4::boolean AND event.event_type = 'performance.review.returned') THEN event.note END AS note,
            event.metadata, actor.full_name AS "actorName"
       FROM performance_events event
       LEFT JOIN accounts account ON account.id = event.actor_account_id
       LEFT JOIN employees actor ON actor.id = account.employee_id
      WHERE event.review_id = $1 AND ($2::text[] IS NULL OR event.event_type = ANY($2::text[]))
      ORDER BY event.occurred_at ASC, event.id ASC`,
    [id, restricted ? EMPLOYEE_VISIBLE_EVENTS : null, view === "hc" && !ownReview, view === "rater"],
  );
  const { rubric, selfScores, selfNote, raterScores, strengths, improvements, raterNote, ...rest } = row;
  const showRating = !restricted || row.status === "FINALIZED";
  const open = row.cycleStatus === "OPEN";
  const date = today();
  const allowedActions = view === "employee"
    ? [
        ...(open && row.status === "SELF_ASSESSMENT" ? ["self-assessment"] : []),
        ...(row.status === "FINALIZED" && !row.acknowledgedAt ? ["acknowledge"] : []),
      ]
    : view === "rater"
      ? (open && canRaterReview({ status: row.status, selfDueOn: row.selfDueOn, today: date }) ? ["rate"] : [])
      : ownReview
        ? []
        : [
            ...(open && row.status === "HC_VALIDATION" && !viewerIsRater ? ["finalize", "return"] : []),
            ...((open || row.cycleStatus === "DRAFT") && ["SELF_ASSESSMENT", "MANAGER_REVIEW"].includes(row.status) ? ["assign-rater"] : []),
            ...((open || row.cycleStatus === "DRAFT") && ACTIVE_REVIEW_STATUSES.includes(row.status) ? ["remove"] : []),
          ];
  return {
    ...rest,
    rubric,
    selfAssessment: selfScores ? { scores: selfScores, note: selfNote } : null,
    rating: showRating && raterScores ? { scores: raterScores, strengths, improvements, note: raterNote } : null,
    allowedActions,
    events: events.rows,
  };
}

export async function registerPerformanceRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
  injectedAuth?: Pick<AuthService, "getSession" | "getAuthorizationContext">,
) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required for performance routes");
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
      await send(reply, 403, { code: "FORBIDDEN", message: "Penilaian kinerja hanya tersedia untuk pegawai." });
      return null;
    }
    return principal;
  }

  async function requirePermission(
    request: FastifyRequest,
    reply: FastifyReply,
    permission: PerformancePermission,
  ): Promise<AuthPrincipal | null> {
    const principal = await authenticate(request, reply);
    if (!principal) return null;
    const context = await auth.getAuthorizationContext(principal);
    if (!context.organizationPermissions.includes(permission)) {
      await send(reply, 403, { code: "PERFORMANCE_FORBIDDEN", message: "Anda tidak memiliki akses untuk tindakan ini." });
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

  /** Runs `work` in one transaction and answers only after COMMIT succeeded. */
  async function transact(reply: FastifyReply, work: (client: PoolClient) => Promise<[number, unknown]>) {
    return handle(reply, async () => {
      const [status, body] = await inTransaction(work);
      return send(reply, status, body);
    });
  }

  function invalid(reply: FastifyReply, message = "Permintaan penilaian kinerja tidak valid.") {
    return send(reply, 400, { code: "INVALID_PERFORMANCE_REQUEST", message });
  }

  async function notifyParticipant(client: PoolClient, cycle: CycleRow, employeeId: string, reviewId: string, actorAccountId: string) {
    await notifyEmployee(client, employeeId, {
      eventKey: `performance.${reviewId}.open.${randomUUID()}`,
      category: "system",
      title: "Penilaian kinerja dibuka",
      body: `Isi penilaian diri untuk ${cycle.name} paling lambat ${cycle.selfDueOn}.`,
      href: `/app/performance?review=${reviewId}`,
      actorAccountId,
    });
  }

  // ---------------------------------------------------------------- employee

  app.get("/performance/me", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const query = pageQuerySchema.safeParse(request.query);
    if (!query.success) return invalid(reply, "Filter tidak valid.");
    return handle(reply, async () => {
      const employee = await loadEmployee(pool, principal.id);
      const result = await pool.query<{ total: number }>(
        `SELECT ${REVIEW_COLUMNS}, ${resultColumns("employee")}, count(*) OVER ()::int AS total
           FROM performance_reviews review
           ${REVIEW_JOINS}
          WHERE review.employee_id = $1 AND review.status <> 'REMOVED' AND cycle.status IN ('OPEN', 'CLOSED')
          ORDER BY cycle.period_start DESC, cycle.kind ASC, review.id DESC
          LIMIT $2 OFFSET $3`,
        [employee.id, query.data.pageSize, pageOffset(query.data)],
      );
      return send(reply, 200, { items: result.rows.map(listItem), pagination: pagination(query.data, result.rows[0]?.total ?? 0) });
    });
  });

  app.get("/performance/me/:id", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply);
    return handle(reply, async () => {
      const employee = await loadEmployee(pool, principal.id);
      // PERF-001-A: another employee's review is indistinguishable from a missing one.
      const detail = await loadReviewDetail(pool, params.data.id, "employee", { employeeId: employee.id });
      if (!detail || detail.status === "REMOVED") throw NOT_FOUND();
      return send(reply, 200, detail);
    });
  });

  app.post("/performance/me/:id/self-assessment", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    const body = selfBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "Nilai penilaian diri atau catatan tidak valid.");
    return transact(reply, async (client) => {
      const employee = await loadEmployee(client, principal.id);
      const { review, cycle } = await lockReview(client, params.data.id, { employeeId: employee.id });
      if (review.status === "REMOVED") throw NOT_FOUND();
      if (cycle.status !== "OPEN") throw CYCLE_NOT_OPEN();
      if (review.status !== "SELF_ASSESSMENT") {
        throw new PerformanceError(409, "PERFORMANCE_SELF_NOT_ALLOWED", "Penilaian diri sudah dikirim atau penilai sudah menilai.");
      }
      const scores = validateScores(cycle.rubric, body.data.scores);
      await client.query(
        `UPDATE performance_reviews
            SET status = 'MANAGER_REVIEW', self_scores = $2::jsonb, self_note = $3, self_submitted_at = now(), updated_at = now()
          WHERE id = $1`,
        [review.id, JSON.stringify(scores), body.data.note || null],
      );
      await addEvent(client, { cycleId: cycle.id, reviewId: review.id, actorAccountId: principal.id, eventType: "performance.review.self_submitted" });
      if (review.raterEmployeeId) {
        await notifyEmployee(client, review.raterEmployeeId, {
          eventKey: `performance.${review.id}.self_submitted.${randomUUID()}`,
          category: "system",
          title: "Penilaian kinerja menunggu Anda",
          body: `${employee.fullName} sudah mengirim penilaian diri untuk ${cycle.name}.`,
          href: `/app/performance?tab=team&review=${review.id}`,
          actorAccountId: principal.id,
        });
      }
      return [200, { id: review.id, status: "MANAGER_REVIEW" }];
    });
  });

  app.post("/performance/me/:id/acknowledge", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    const body = acknowledgeBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return invalid(reply, "Tanggapan paling banyak 1000 karakter.");
    return transact(reply, async (client) => {
      const employee = await loadEmployee(client, principal.id);
      const { review, cycle } = await lockReview(client, params.data.id, { employeeId: employee.id });
      if (review.status === "REMOVED" || cycle.status === "DRAFT" || cycle.status === "CANCELLED") throw NOT_FOUND();
      const updated = await client.query(
        `UPDATE performance_reviews
            SET acknowledged_at = now(), acknowledgement_comment = $2, updated_at = now()
          WHERE id = $1 AND status = 'FINALIZED' AND acknowledged_at IS NULL`,
        [review.id, body.data.comment || null],
      );
      if (updated.rowCount !== 1) {
        throw new PerformanceError(409, "PERFORMANCE_NOT_ACKNOWLEDGEABLE", "Hanya hasil yang sudah disahkan dan belum ditandai yang dapat ditandai dibaca.");
      }
      await addEvent(client, {
        cycleId: cycle.id, reviewId: review.id, actorAccountId: principal.id, eventType: "performance.review.acknowledged",
        metadata: { withComment: Boolean(body.data.comment) },
      });
      return [200, { id: review.id, status: "FINALIZED", acknowledged: true }];
    });
  });

  // ------------------------------------------------------------------- rater

  app.get("/performance/team", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const query = reviewStatusQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, "Filter tidak valid.");
    return handle(reply, async () => {
      const employee = await loadEmployee(pool, principal.id);
      const result = await pool.query<{ total: number }>(
        `SELECT ${REVIEW_COLUMNS}, ${resultColumns("rater")}, count(*) OVER ()::int AS total
           FROM performance_reviews review
           ${REVIEW_JOINS}
          WHERE review.rater_employee_id = $1 AND review.status <> 'REMOVED' AND cycle.status IN ('OPEN', 'CLOSED')
            AND ($2::text IS NULL OR review.status = $2)
          ORDER BY (cycle.status = 'OPEN') DESC, cycle.review_due_on ASC, employee.full_name ASC, review.id ASC
          LIMIT $3 OFFSET $4`,
        [employee.id, query.data.status ?? null, query.data.pageSize, pageOffset(query.data)],
      );
      return send(reply, 200, { items: result.rows.map(listItem), pagination: pagination(query.data, result.rows[0]?.total ?? 0) });
    });
  });

  app.get("/performance/team/:id", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply);
    return handle(reply, async () => {
      const employee = await loadEmployee(pool, principal.id);
      const detail = await loadReviewDetail(pool, params.data.id, "rater", { raterEmployeeId: employee.id });
      if (!detail || detail.status === "REMOVED") throw NOT_FOUND();
      return send(reply, 200, detail);
    });
  });

  app.post("/performance/team/:id/rating", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    const body = ratingBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "Nilai, kekuatan, area perbaikan, atau catatan tidak valid.");
    return transact(reply, async (client) => {
      const rater = await loadEmployee(client, principal.id);
      // PERF-001-C: only the snapshotted rater finds the review at all.
      const { review, cycle } = await lockReview(client, params.data.id, { raterEmployeeId: rater.id });
      if (review.status === "REMOVED") throw NOT_FOUND();
      if (cycle.status !== "OPEN") throw CYCLE_NOT_OPEN();
      if (!canRaterReview({ status: review.status, selfDueOn: cycle.selfDueOn, today: today() })) {
        throw new PerformanceError(409, "PERFORMANCE_RATING_NOT_ALLOWED", review.status === "SELF_ASSESSMENT"
          ? `Penilaian dapat dikirim setelah pegawai mengisi penilaian diri atau setelah ${cycle.selfDueOn}.`
          : "Penilaian ini sudah dinilai.");
      }
      const scores = validateScores(cycle.rubric, body.data.scores);
      const score = finalScore(cycle.rubric, scores);
      const predicate = predicateFor(cycle.rubric, score);
      await client.query(
        `UPDATE performance_reviews
            SET status = 'HC_VALIDATION', rater_scores = $2::jsonb, strengths = $3, improvements = $4, rater_note = $5,
                rated_by_account_id = $6, rated_at = now(), final_score = $7, predicate_code = $8, predicate_label = $9,
                updated_at = now()
          WHERE id = $1`,
        [review.id, JSON.stringify(scores), body.data.strengths || null, body.data.improvements || null, body.data.note || null,
          principal.id, score, predicate.code, predicate.label],
      );
      await addEvent(client, {
        cycleId: cycle.id, reviewId: review.id, actorAccountId: principal.id, eventType: "performance.review.rated",
        metadata: { predicateCode: predicate.code, withoutSelfAssessment: review.status === "SELF_ASSESSMENT" },
      });
      return [200, { id: review.id, status: "HC_VALIDATION", finalScore: score, predicateCode: predicate.code, predicateLabel: predicate.label }];
    });
  });

  // ------------------------------------------------------------------- admin

  app.get("/admin/performance/cycles", async (request, reply) => {
    if (!(await requirePermission(request, reply, "performance.read"))) return;
    const query = cycleListQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, "Filter tidak valid.");
    const result = await pool.query<{ total: number }>(
      `SELECT ${CYCLE_COLUMNS},
              (SELECT count(*)::int FROM performance_reviews review
                WHERE review.cycle_id = cycle.id AND review.status <> 'REMOVED') AS "participantCount",
              count(*) OVER ()::int AS total
         FROM performance_cycles cycle
        WHERE ($1::text IS NULL OR cycle.status = $1)
        ORDER BY cycle.period_start DESC, cycle.created_at DESC, cycle.id DESC
        LIMIT $2 OFFSET $3`,
      [query.data.status ?? null, query.data.pageSize, pageOffset(query.data)],
    );
    return send(reply, 200, { items: result.rows.map(listItem), pagination: pagination(query.data, result.rows[0]?.total ?? 0) });
  });

  app.post("/admin/performance/cycles", async (request, reply) => {
    const principal = await requirePermission(request, reply, "performance.manage");
    if (!principal) return;
    const body = createCycleBody.safeParse(request.body);
    if (!body.success) return invalid(reply, "Nama, jenis, tanggal, atau rubrik siklus tidak valid.");
    return transact(reply, async (client) => {
      validateCyclePeriod(body.data);
      const rubric = validateRubric(body.data.rubric ?? DEFAULT_RUBRIC);
      const id = randomUUID();
      await client.query(
        `INSERT INTO performance_cycles (
           id, name, kind, period_start, period_end, self_due_on, review_due_on, status, rubric, created_by_account_id
         ) VALUES ($1, $2, $3, $4::date, $5::date, $6::date, $7::date, 'DRAFT', $8::jsonb, $9)`,
        [id, body.data.name, body.data.kind, body.data.periodStart, body.data.periodEnd, body.data.selfDueOn,
          body.data.reviewDueOn, JSON.stringify(rubric), principal.id],
      );
      await addEvent(client, { cycleId: id, actorAccountId: principal.id, eventType: "performance.cycle.created", metadata: { kind: body.data.kind } });
      return [201, { id, status: "DRAFT" }];
    });
  });

  app.get("/admin/performance/cycles/:id", async (request, reply) => {
    if (!(await requirePermission(request, reply, "performance.read"))) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply);
    return handle(reply, async () => {
      const cycle = await loadCycle(pool, params.data.id);
      const [byStatus, byPredicate, raters, events] = await Promise.all([
        pool.query<{ status: ReviewStatus; count: number }>(
          `SELECT status, count(*)::int AS count FROM performance_reviews WHERE cycle_id = $1 GROUP BY status`,
          [cycle.id],
        ),
        pool.query<{ code: string; count: number }>(
          `SELECT predicate_code AS code, count(*)::int AS count FROM performance_reviews
            WHERE cycle_id = $1 AND status = 'FINALIZED' GROUP BY predicate_code`,
          [cycle.id],
        ),
        pool.query<{ missing: number; notReady: number }>(
          `SELECT count(*) FILTER (WHERE review.rater_employee_id IS NULL)::int AS missing,
                  count(*) FILTER (WHERE review.rater_employee_id IS NOT NULL
                                     AND account.status IS DISTINCT FROM 'active')::int AS "notReady"
             FROM performance_reviews review
             LEFT JOIN accounts account ON account.employee_id = review.rater_employee_id AND account.principal_type = 'EMPLOYEE'
            WHERE review.cycle_id = $1 AND review.status IN ('SELF_ASSESSMENT', 'MANAGER_REVIEW')`,
          [cycle.id],
        ),
        pool.query(
          `SELECT event.id, event.event_type AS "eventType", event.occurred_at AS "occurredAt", event.note, event.metadata,
                  actor.full_name AS "actorName"
             FROM performance_events event
             LEFT JOIN accounts account ON account.id = event.actor_account_id
             LEFT JOIN employees actor ON actor.id = account.employee_id
            WHERE event.cycle_id = $1 AND event.review_id IS NULL
            ORDER BY event.occurred_at ASC, event.id ASC`,
          [cycle.id],
        ),
      ]);
      const statusCounts = Object.fromEntries(REVIEW_STATUSES.map((status) => [status, 0])) as Record<ReviewStatus, number>;
      for (const row of byStatus.rows) statusCounts[row.status] = row.count;
      const predicateCounts = new Map(byPredicate.rows.map((row) => [row.code, row.count]));
      return send(reply, 200, {
        ...cycle,
        recap: {
          participants: REVIEW_STATUSES.filter((status) => status !== "REMOVED").reduce((sum, status) => sum + statusCounts[status], 0),
          byStatus: statusCounts,
          byPredicate: cycle.rubric.predicates.map((predicate) => ({ ...predicate, count: predicateCounts.get(predicate.code) ?? 0 })),
          raterMissing: raters.rows[0]?.missing ?? 0,
          raterAccountNotReady: raters.rows[0]?.notReady ?? 0,
        },
        events: events.rows,
      });
    });
  });

  app.patch("/admin/performance/cycles/:id", async (request, reply) => {
    const principal = await requirePermission(request, reply, "performance.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    const body = patchCycleBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "Perubahan siklus tidak valid.");
    return transact(reply, async (client) => {
      const cycle = await loadCycle(client, params.data.id, "FOR UPDATE");
      // PERF-001-E: the rubric and the period are frozen once the cycle opens.
      if (cycle.status !== "DRAFT") {
        throw new PerformanceError(409, "PERFORMANCE_CYCLE_LOCKED", "Siklus yang sudah dibuka tidak dapat diubah.");
      }
      const next = { ...cycle, ...Object.fromEntries(Object.entries(body.data).filter(([, value]) => value !== undefined)) } as CycleRow;
      validateCyclePeriod(next);
      const rubric = validateRubric(next.rubric);
      await client.query(
        `UPDATE performance_cycles
            SET name = $2, kind = $3, period_start = $4::date, period_end = $5::date, self_due_on = $6::date,
                review_due_on = $7::date, rubric = $8::jsonb, updated_at = now()
          WHERE id = $1`,
        [cycle.id, next.name, next.kind, next.periodStart, next.periodEnd, next.selfDueOn, next.reviewDueOn, JSON.stringify(rubric)],
      );
      await addEvent(client, {
        cycleId: cycle.id, actorAccountId: principal.id, eventType: "performance.cycle.updated",
        metadata: { fields: Object.keys(body.data).filter((key) => body.data[key as keyof typeof body.data] !== undefined) },
      });
      return [200, { id: cycle.id, status: "DRAFT" }];
    });
  });

  app.post("/admin/performance/cycles/:id/participants", async (request, reply) => {
    const principal = await requirePermission(request, reply, "performance.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    const body = participantsBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "Pilih 1 sampai 100 pegawai, atau semua pegawai aktif.");
    return transact(reply, async (client) => {
      const cycle = await loadCycle(client, params.data.id, "FOR UPDATE");
      if (cycle.status !== "DRAFT" && cycle.status !== "OPEN") {
        throw new PerformanceError(409, "PERFORMANCE_CYCLE_LOCKED", "Peserta hanya dapat ditambahkan pada siklus draf atau terbuka.");
      }
      let candidates: string[];
      if ("allActive" in body.data) {
        const active = await client.query<{ id: string }>(
          `SELECT id FROM employees WHERE status = 'active' AND removed_at IS NULL ORDER BY full_name ASC, id ASC`,
        );
        candidates = active.rows.map((row) => row.id);
      } else {
        const ids = [...new Set(body.data.employeeIds)];
        const found = await client.query<{ id: string }>(
          `SELECT id FROM employees WHERE id = ANY($1::uuid[]) AND status = 'active' AND removed_at IS NULL`,
          [ids],
        );
        if (found.rows.length !== ids.length) {
          throw new PerformanceError(409, "PERFORMANCE_EMPLOYEE_NOT_ACTIVE", "Hanya pegawai aktif yang dapat menjadi peserta.");
        }
        candidates = ids;
      }
      const existing = await client.query<{ id: string; employeeId: string; status: ReviewStatus }>(
        `SELECT id, employee_id AS "employeeId", status FROM performance_reviews
          WHERE cycle_id = $1 AND employee_id = ANY($2::uuid[]) FOR UPDATE`,
        [cycle.id, candidates],
      );
      const byEmployee = new Map(existing.rows.map((row) => [row.employeeId, row]));
      // D-07: re-adding restarts a review from scratch, so nobody may do it to their own.
      const actorEmployeeId = await employeeIdOf(client, principal.id);
      if (actorEmployeeId && byEmployee.get(actorEmployeeId)?.status === "REMOVED") {
        throw new PerformanceError(403, "PERFORMANCE_SELF_VALIDATION", "Anda tidak dapat memasukkan kembali penilaian Anda sendiri.");
      }
      const effectiveDate = today() < cycle.periodEnd ? today() : cycle.periodEnd;
      const summary = { added: 0, readded: 0, alreadyIn: 0, withoutRater: 0 };
      for (const employeeId of candidates) {
        const current = byEmployee.get(employeeId);
        if (current && current.status !== "REMOVED") {
          summary.alreadyIn += 1;
          continue;
        }
        const rater = await resolveRater(client, employeeId, effectiveDate);
        if (!rater.employeeId) summary.withoutRater += 1;
        const reviewId = current?.id ?? randomUUID();
        if (current) {
          // D-14: re-adding revives the same review from the start.
          await client.query(
            `UPDATE performance_reviews
                SET status = 'SELF_ASSESSMENT', rater_employee_id = $2, rater_source = $3, rater_snapshot = $4::jsonb,
                    self_scores = NULL, self_note = NULL, self_submitted_at = NULL, rater_scores = NULL, strengths = NULL,
                    improvements = NULL, rater_note = NULL, rated_by_account_id = NULL, rated_at = NULL, final_score = NULL,
                    predicate_code = NULL, predicate_label = NULL, removed_reason = NULL, updated_at = now()
              WHERE id = $1`,
            [reviewId, rater.employeeId, rater.source, JSON.stringify(rater.snapshot)],
          );
          summary.readded += 1;
        } else {
          await client.query(
            `INSERT INTO performance_reviews (id, cycle_id, employee_id, status, rater_employee_id, rater_source, rater_snapshot)
             VALUES ($1, $2, $3, 'SELF_ASSESSMENT', $4, $5, $6::jsonb)`,
            [reviewId, cycle.id, employeeId, rater.employeeId, rater.source, JSON.stringify(rater.snapshot)],
          );
          summary.added += 1;
        }
        await addEvent(client, {
          cycleId: cycle.id, reviewId, actorAccountId: principal.id,
          eventType: current ? "performance.review.readded" : "performance.review.added",
          metadata: { raterEmployeeId: rater.employeeId, raterSource: rater.source, unresolved: rater.snapshot.unresolved ?? null },
        });
        if (cycle.status === "OPEN") await notifyParticipant(client, cycle, employeeId, reviewId, principal.id);
      }
      return [200, summary];
    });
  });

  app.post("/admin/performance/cycles/:id/open", async (request, reply) => {
    const principal = await requirePermission(request, reply, "performance.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply);
    return transact(reply, async (client) => {
      const cycle = await loadCycle(client, params.data.id, "FOR UPDATE");
      if (cycle.status !== "DRAFT") {
        throw new PerformanceError(409, "PERFORMANCE_CYCLE_NOT_DRAFT", "Hanya siklus draf yang dapat dibuka.");
      }
      const participants = await client.query<{ id: string; employeeId: string }>(
        `SELECT id, employee_id AS "employeeId" FROM performance_reviews WHERE cycle_id = $1 AND status = 'SELF_ASSESSMENT'`,
        [cycle.id],
      );
      if (participants.rows.length === 0) {
        throw new PerformanceError(409, "PERFORMANCE_CYCLE_EMPTY", "Tambahkan peserta sebelum membuka siklus.");
      }
      // The stored rubric is re-validated so a cycle never opens on a rubric the rules reject.
      validateRubric(cycle.rubric);
      await client.query(`UPDATE performance_cycles SET status = 'OPEN', opened_at = now(), updated_at = now() WHERE id = $1`, [cycle.id]);
      await addEvent(client, {
        cycleId: cycle.id, actorAccountId: principal.id, eventType: "performance.cycle.opened",
        metadata: { participants: participants.rows.length },
      });
      for (const row of participants.rows) await notifyParticipant(client, cycle, row.employeeId, row.id, principal.id);
      return [200, { id: cycle.id, status: "OPEN", participants: participants.rows.length }];
    });
  });

  app.post("/admin/performance/cycles/:id/close", async (request, reply) => {
    const principal = await requirePermission(request, reply, "performance.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply);
    return transact(reply, async (client) => {
      const cycle = await loadCycle(client, params.data.id, "FOR UPDATE");
      if (cycle.status !== "OPEN") throw CYCLE_NOT_OPEN();
      if (today() < cycle.periodEnd) {
        throw new PerformanceError(409, "PERFORMANCE_CYCLE_NOT_ENDED", `Siklus dapat ditutup mulai ${cycle.periodEnd}.`);
      }
      const pending = await client.query(
        `SELECT 1 FROM performance_reviews WHERE cycle_id = $1 AND status = 'HC_VALIDATION' LIMIT 1`,
        [cycle.id],
      );
      if (pending.rows[0]) {
        throw new PerformanceError(409, "PERFORMANCE_CYCLE_HAS_PENDING_VALIDATION", "Sahkan atau kembalikan semua penilaian yang menunggu pengesahan sebelum menutup siklus.");
      }
      const unrated = await client.query<{ id: string }>(
        `UPDATE performance_reviews SET status = 'UNRATED', updated_at = now()
          WHERE cycle_id = $1 AND status IN ('SELF_ASSESSMENT', 'MANAGER_REVIEW')
          RETURNING id`,
        [cycle.id],
      );
      for (const row of unrated.rows) {
        await addEvent(client, { cycleId: cycle.id, reviewId: row.id, actorAccountId: principal.id, eventType: "performance.review.unrated" });
      }
      const finalized = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM performance_reviews WHERE cycle_id = $1 AND status = 'FINALIZED'`,
        [cycle.id],
      );
      await client.query(`UPDATE performance_cycles SET status = 'CLOSED', closed_at = now(), updated_at = now() WHERE id = $1`, [cycle.id]);
      const summary = { finalized: finalized.rows[0]?.count ?? 0, unrated: unrated.rows.length };
      await addEvent(client, { cycleId: cycle.id, actorAccountId: principal.id, eventType: "performance.cycle.closed", metadata: summary });
      return [200, { id: cycle.id, status: "CLOSED", ...summary }];
    });
  });

  app.post("/admin/performance/cycles/:id/cancel", async (request, reply) => {
    const principal = await requirePermission(request, reply, "performance.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    const body = cancelCycleBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "Alasan pembatalan 10 sampai 500 karakter.");
    return transact(reply, async (client) => {
      const cycle = await loadCycle(client, params.data.id, "FOR UPDATE");
      if (cycle.status !== "DRAFT") {
        throw new PerformanceError(409, "PERFORMANCE_CYCLE_NOT_DRAFT", "Hanya siklus draf yang dapat dibatalkan.");
      }
      await client.query(
        `UPDATE performance_reviews SET status = 'REMOVED', removed_reason = $2, updated_at = now()
          WHERE cycle_id = $1 AND status <> 'REMOVED'`,
        [cycle.id, body.data.reason],
      );
      await client.query(
        `UPDATE performance_cycles SET status = 'CANCELLED', cancel_reason = $2, updated_at = now() WHERE id = $1`,
        [cycle.id, body.data.reason],
      );
      await addEvent(client, { cycleId: cycle.id, actorAccountId: principal.id, eventType: "performance.cycle.cancelled", note: body.data.reason });
      return [200, { id: cycle.id, status: "CANCELLED" }];
    });
  });

  app.get("/admin/performance/cycles/:id/reviews", async (request, reply) => {
    const principal = await requirePermission(request, reply, "performance.read");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    const query = adminReviewQuery.safeParse(request.query);
    if (!params.success || !query.success) return invalid(reply, "Filter tidak valid.");
    const filter = query.data;
    const viewer = await employeeIdOf(pool, principal.id);
    // ENG-LIST-001: every filter runs before LIMIT; the page carries the true total.
    const result = await pool.query<{ total: number }>(
      `SELECT ${REVIEW_COLUMNS}, ${resultColumns("hc", "$9")}, count(*) OVER ()::int AS total
         FROM performance_reviews review
         ${REVIEW_JOINS}
        WHERE review.cycle_id = $1
          AND ($2::text IS NULL OR review.status = $2)
          AND ($3::text IS NULL OR (review.status = 'FINALIZED' AND review.predicate_code = $3
                                    AND review.employee_id IS DISTINCT FROM $9::uuid))
          AND ($4::uuid IS NULL OR review.employee_id = $4)
          AND ($5::boolean IS NULL OR (review.rater_employee_id IS NULL) = $5)
          AND ($6::text IS NULL OR employee.full_name ILIKE '%' || $6 || '%' OR employee.employee_number ILIKE '%' || $6 || '%')
        ORDER BY employee.full_name ASC, review.id ASC
        LIMIT $7 OFFSET $8`,
      [params.data.id, filter.status ?? null, filter.predicate ?? null, filter.employeeId ?? null,
        filter.raterMissing === undefined ? null : filter.raterMissing === "true", filter.q ?? null,
        filter.pageSize, pageOffset(filter), viewer],
    );
    return send(reply, 200, { items: result.rows.map(listItem), pagination: pagination(filter, result.rows[0]?.total ?? 0) });
  });

  app.get("/admin/performance/reviews/:id", async (request, reply) => {
    const principal = await requirePermission(request, reply, "performance.read");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply);
    return handle(reply, async () => {
      const detail = await loadReviewDetail(pool, params.data.id, "hc", { viewerEmployeeId: await employeeIdOf(pool, principal.id) });
      if (!detail) throw NOT_FOUND();
      return send(reply, 200, detail);
    });
  });

  app.get("/admin/performance/employees/:employeeId/reviews", async (request, reply) => {
    const principal = await requirePermission(request, reply, "performance.read");
    if (!principal) return;
    const params = employeeParams.safeParse(request.params);
    const query = pageQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return invalid(reply, "Filter tidak valid.");
    const viewer = await employeeIdOf(pool, principal.id);
    const result = await pool.query<{ total: number }>(
      `SELECT ${REVIEW_COLUMNS}, ${resultColumns("hc", "$4")}, count(*) OVER ()::int AS total
         FROM performance_reviews review
         ${REVIEW_JOINS}
        WHERE review.employee_id = $1 AND cycle.status <> 'CANCELLED'
        ORDER BY cycle.period_start DESC, cycle.kind ASC, review.id DESC
        LIMIT $2 OFFSET $3`,
      [params.data.employeeId, query.data.pageSize, pageOffset(query.data), viewer],
    );
    return send(reply, 200, { items: result.rows.map(listItem), pagination: pagination(query.data, result.rows[0]?.total ?? 0) });
  });

  /**
   * D-07: the validator is never the reviewed employee or the rater, and no HC action (rater,
   * remove, re-add) may touch the actor's own review, which would let them steer their result.
   */
  async function assertNotPartyTo(client: PoolClient, accountId: string, review: LockedReview, rater = true) {
    const employeeId = await employeeIdOf(client, accountId);
    if (employeeId && (employeeId === review.employeeId || (rater && employeeId === review.raterEmployeeId))) {
      throw new PerformanceError(403, "PERFORMANCE_SELF_VALIDATION", "Anda tidak dapat mengubah penilaian Anda sendiri atau mengesahkan yang Anda nilai.");
    }
  }

  app.post("/admin/performance/reviews/:id/finalize", async (request, reply) => {
    const principal = await requirePermission(request, reply, "performance.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply);
    return transact(reply, async (client) => {
      const { review, cycle } = await lockReview(client, params.data.id);
      if (cycle.status !== "OPEN" || review.status !== "HC_VALIDATION") {
        throw new PerformanceError(409, "PERFORMANCE_NOT_IN_VALIDATION", "Penilaian ini tidak sedang menunggu pengesahan.");
      }
      await assertNotPartyTo(client, principal.id, review);
      const scores = await client.query<{ current: number; previous: number | null }>(
        `SELECT review.final_score::float8 AS current,
                (SELECT earlier.final_score::float8
                   FROM performance_reviews earlier
                   JOIN performance_cycles earlier_cycle ON earlier_cycle.id = earlier.cycle_id
                  WHERE earlier.employee_id = review.employee_id AND earlier.status = 'FINALIZED'
                    AND earlier_cycle.kind = $2 AND earlier_cycle.period_start < $3::date
                  ORDER BY earlier_cycle.period_start DESC
                  LIMIT 1) AS previous
           FROM performance_reviews review WHERE review.id = $1`,
        [review.id, cycle.kind, cycle.periodStart],
      );
      const trend = trendFrom(scores.rows[0]!.current, scores.rows[0]!.previous);
      await client.query(
        `UPDATE performance_reviews
            SET status = 'FINALIZED', finalized_by_account_id = $2, finalized_at = now(), trend = $3, updated_at = now()
          WHERE id = $1`,
        [review.id, principal.id, trend],
      );
      await addEvent(client, {
        cycleId: cycle.id, reviewId: review.id, actorAccountId: principal.id, eventType: "performance.review.finalized",
        metadata: { predicateCode: review.predicateCode, trend },
      });
      await notifyEmployee(client, review.employeeId, {
        eventKey: `performance.${review.id}.finalized`,
        category: "system",
        title: "Hasil penilaian kinerja",
        body: `Hasil penilaian kinerja ${cycle.name} sudah disahkan.`,
        href: `/app/performance?review=${review.id}`,
        actorAccountId: principal.id,
      });
      return [200, { id: review.id, status: "FINALIZED", trend }];
    });
  });

  app.post("/admin/performance/reviews/:id/return", async (request, reply) => {
    const principal = await requirePermission(request, reply, "performance.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    const body = returnBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "Alasan pengembalian 10 sampai 1000 karakter.");
    return transact(reply, async (client) => {
      const { review, cycle } = await lockReview(client, params.data.id);
      if (cycle.status !== "OPEN" || review.status !== "HC_VALIDATION") {
        throw new PerformanceError(409, "PERFORMANCE_NOT_IN_VALIDATION", "Penilaian ini tidak sedang menunggu pengesahan.");
      }
      await assertNotPartyTo(client, principal.id, review);
      // The rater's indicator scores stay as the starting point; the result is cleared (D-07).
      await client.query(
        `UPDATE performance_reviews
            SET status = 'MANAGER_REVIEW', final_score = NULL, predicate_code = NULL, predicate_label = NULL,
                rated_by_account_id = NULL, rated_at = NULL, updated_at = now()
          WHERE id = $1`,
        [review.id],
      );
      await addEvent(client, {
        cycleId: cycle.id, reviewId: review.id, actorAccountId: principal.id, eventType: "performance.review.returned",
        note: body.data.reason, metadata: { previousPredicateCode: review.predicateCode },
      });
      if (review.raterEmployeeId) {
        await notifyEmployee(client, review.raterEmployeeId, {
          eventKey: `performance.${review.id}.returned.${randomUUID()}`,
          category: "system",
          title: "Penilaian kinerja dikembalikan",
          body: `Human Capital mengembalikan penilaian ${cycle.name} untuk ditinjau ulang.`,
          href: `/app/performance?tab=team&review=${review.id}`,
          actorAccountId: principal.id,
        });
      }
      return [200, { id: review.id, status: "MANAGER_REVIEW" }];
    });
  });

  app.post("/admin/performance/reviews/:id/rater", async (request, reply) => {
    const principal = await requirePermission(request, reply, "performance.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    const body = raterBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "Pilih penilai dan tulis alasan 5 sampai 500 karakter.");
    return transact(reply, async (client) => {
      const { review, cycle } = await lockReview(client, params.data.id);
      if (!["DRAFT", "OPEN"].includes(cycle.status) || !["SELF_ASSESSMENT", "MANAGER_REVIEW"].includes(review.status)) {
        throw new PerformanceError(409, "PERFORMANCE_RATER_LOCKED", "Penilai hanya dapat diganti sebelum penilaian atasan dikirim.");
      }
      await assertNotPartyTo(client, principal.id, review, false);
      const rater = await client.query(
        `SELECT 1 FROM employees WHERE id = $1 AND status = 'active' AND removed_at IS NULL`,
        [body.data.raterEmployeeId],
      );
      if (!rater.rows[0] || body.data.raterEmployeeId === review.employeeId || body.data.raterEmployeeId === review.raterEmployeeId) {
        throw new PerformanceError(409, "PERFORMANCE_RATER_INVALID", "Penilai harus pegawai aktif lain yang belum menjadi penilai penilaian ini.");
      }
      await client.query(
        `UPDATE performance_reviews
            SET rater_employee_id = $2, rater_source = 'HC_ASSIGNED',
                rater_snapshot = jsonb_build_object('assignedByAccountId', $3::text, 'previousRaterEmployeeId', $4::text),
                updated_at = now()
          WHERE id = $1`,
        [review.id, body.data.raterEmployeeId, principal.id, review.raterEmployeeId],
      );
      await addEvent(client, {
        cycleId: cycle.id, reviewId: review.id, actorAccountId: principal.id, eventType: "performance.review.rater_assigned",
        note: body.data.reason,
        metadata: { previousRaterEmployeeId: review.raterEmployeeId, raterEmployeeId: body.data.raterEmployeeId },
      });
      if (cycle.status === "OPEN") {
        await notifyEmployee(client, body.data.raterEmployeeId, {
          eventKey: `performance.${review.id}.rater.${randomUUID()}`,
          category: "system",
          title: "Anda ditunjuk sebagai penilai",
          body: `Human Capital menunjuk Anda menilai satu pegawai pada ${cycle.name}.`,
          href: `/app/performance?tab=team&review=${review.id}`,
          actorAccountId: principal.id,
        });
      }
      return [200, { id: review.id, raterEmployeeId: body.data.raterEmployeeId }];
    });
  });

  app.post("/admin/performance/reviews/:id/remove", async (request, reply) => {
    const principal = await requirePermission(request, reply, "performance.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    const body = reasonBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "Alasan 5 sampai 500 karakter.");
    return transact(reply, async (client) => {
      const { review, cycle } = await lockReview(client, params.data.id);
      if (!["DRAFT", "OPEN"].includes(cycle.status) || !ACTIVE_REVIEW_STATUSES.includes(review.status)) {
        throw new PerformanceError(409, "PERFORMANCE_NOT_REMOVABLE", "Penilaian yang sudah final atau siklus yang sudah ditutup tidak dapat diubah.");
      }
      await assertNotPartyTo(client, principal.id, review, false);
      // A removed review carries no result: only FINALIZED results ever count (spec §11).
      await client.query(
        `UPDATE performance_reviews
            SET status = 'REMOVED', removed_reason = $2, final_score = NULL, predicate_code = NULL, predicate_label = NULL,
                updated_at = now()
          WHERE id = $1`,
        [review.id, body.data.reason],
      );
      await addEvent(client, {
        cycleId: cycle.id, reviewId: review.id, actorAccountId: principal.id, eventType: "performance.review.removed",
        note: body.data.reason, metadata: { previousStatus: review.status },
      });
      return [200, { id: review.id, status: "REMOVED" }];
    });
  });
}
