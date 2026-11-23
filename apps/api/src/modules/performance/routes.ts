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
import { assertManagedByHcis, OutsideHcisError } from "../employees/management-scope.js";
import { notifyEmployee } from "../notifications/service.js";
// ORG-011: the classification codes bound to an employment, SUPPORT ones included. The two-slot
// resolver beside it drops SUPPORT, and an office boy's rubric is exactly what must not be lost.
import { bindingsOn } from "../organization/job-classification-resolver.js";
import { resolveLineManager } from "../organization/line-manager.js";
import type { OrganizationWorkflowKey } from "../organization/workflow-keys.js";
import {
  ACTIVE_REVIEW_STATUSES,
  canFinalize,
  canObject,
  canRaterReview,
  CYCLE_KINDS,
  CYCLE_STATUSES,
  DEFAULT_RUBRIC,
  finalScore,
  objectionDueOn,
  PerformancePolicyError,
  predicateFor,
  REVIEW_STATUSES,
  RUBRIC_SCOPES,
  selectRubricVersion,
  trendFrom,
  validateCyclePeriod,
  validateRubric,
  validateScores,
  type CycleKind,
  type CycleStatus,
  type ObjectionStatus,
  type ReviewStatus,
  type Rubric,
  type RubricVersion,
} from "./domain.js";

type Queryable = Pool | PoolClient;

/** D-01 DRAFT: ORG-004 rollout key; without a rollout row the mode is LEGACY. */
const PERFORMANCE_WORKFLOW_KEY: OrganizationWorkflowKey = "PERF";

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
// D-17: a real reason, the same length HC's own return reason must have.
const objectionBody = z.object({ reason: z.string().trim().min(10).max(1000) });
const reasonBody = z.object({ reason: z.string().trim().min(5).max(500) });
const cancelCycleBody = z.object({ reason: z.string().trim().min(10).max(500) });
const returnBody = z.object({ reason: z.string().trim().min(10).max(1000) });
const raterBody = z.object({ raterEmployeeId: z.string().uuid(), reason: z.string().trim().min(5).max(500) });
// D-19/D-20: a new rubric version. `effectiveFrom` is the day it starts applying to reviews
// created from then on; `jobClassificationCodes` is the group it covers (empty means DEFAULT).
const jobClassificationCode = z.string().trim().regex(/^[A-Z][A-Z0-9_]{0,47}$/);
const rubricVersionBody = z.object({
  name: z.string().trim().min(3).max(120),
  scope: z.enum(RUBRIC_SCOPES),
  effectiveFrom: isoDate,
  source: z.string().trim().min(1).max(200),
  note: z.string().trim().min(1).max(500).nullable().optional(),
  jobClassificationCodes: z.array(jobClassificationCode).max(50).optional(),
  indicators: rubricSchema.shape.indicators,
  predicates: rubricSchema.shape.predicates,
});
const idParams = z.object({ id: z.string().uuid() });
const employeeParams = z.object({ employeeId: z.string().uuid() });
const cycleListQuery = pageQuerySchema.extend({ status: z.enum(CYCLE_STATUSES).optional() });
const reviewStatusQuery = pageQuerySchema.extend({ status: z.enum(REVIEW_STATUSES).optional() });
const adminReviewQuery = reviewStatusQuery.extend({
  predicate: code.optional(),
  employeeId: z.string().uuid().optional(),
  raterMissing: z.enum(["true", "false"]).optional(),
  objection: z.enum(["OPEN"]).optional(),
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
const NOT_IN_VALIDATION = () =>
  new PerformanceError(409, "PERFORMANCE_NOT_IN_VALIDATION", "Penilaian ini tidak sedang menunggu pengesahan.");
const OBJECTION_OPEN = (message: string) => new PerformanceError(409, "PERFORMANCE_OBJECTION_OPEN", message);

function send(reply: FastifyReply, status: number, body: unknown) {
  reply.header("Cache-Control", "no-store");
  return reply.status(status).send(body);
}

function today(): string {
  return jakartaDate(new Date());
}

function knownError(error: unknown): PerformanceError | null {
  if (error instanceof PerformanceError) return error;
  // EMP-005 S2B §8.7: the shared refusal, answered with this module's envelope.
  if (error instanceof OutsideHcisError) return new PerformanceError(error.statusCode, error.code, error.message);
  if (error instanceof PerformancePolicyError) return new PerformanceError(400, error.code, error.message);
  const database = error as { code?: string; constraint?: string };
  if (database?.code === "23505" && database.constraint === "performance_rubric_versions_version_key") {
    return new PerformanceError(409, "PERFORMANCE_RUBRIC_VERSION_RACE", "Versi rubrik lain baru saja disimpan. Muat ulang daftar lalu simpan kembali.");
  }
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
  rubricVersion: number | null;
}

const CYCLE_COLUMNS = `
  cycle.id, cycle.name, cycle.kind, cycle.status,
  to_char(cycle.period_start, 'YYYY-MM-DD') AS "periodStart", to_char(cycle.period_end, 'YYYY-MM-DD') AS "periodEnd",
  to_char(cycle.self_due_on, 'YYYY-MM-DD') AS "selfDueOn", to_char(cycle.review_due_on, 'YYYY-MM-DD') AS "reviewDueOn",
  cycle.rubric_version AS "rubricVersion"`;

/**
 * D-19/D-20: every rubric version that has already started on `date`, with the job classification
 * codes it covers. The table is append-only and small (one row per rubric decision), so reading
 * the whole in-force set and choosing in the domain rules keeps the choice testable without a
 * database.
 */
async function rubricVersionsInForce(db: Queryable, date: string): Promise<RubricVersion[]> {
  const result = await db.query<RubricVersion>(
    `SELECT version.id, version.version, version.scope, version.name,
            to_char(version.effective_from, 'YYYY-MM-DD') AS "effectiveFrom",
            version.payload AS rubric,
            COALESCE(
              (SELECT array_agg(job.job_classification_code ORDER BY job.job_classification_code)
                 FROM performance_rubric_version_jobs job WHERE job.rubric_version_id = version.id),
              ARRAY[]::text[]
            ) AS "jobCodes"
       FROM performance_rubric_versions version
      WHERE version.effective_from <= $1::date
      ORDER BY version.version ASC`,
    [date],
  );
  return result.rows;
}

/**
 * D-20: the job classification codes bound to an employee on `date`, across every employment they
 * hold then. Codes only — the catalog carries no authority (ADR-0004) and this never reads one.
 */
async function jobCodesOf(db: Queryable, employeeId: string, date: string): Promise<string[]> {
  const employments = await db.query<{ id: string }>(
    `SELECT id FROM employments
      WHERE employee_id = $1 AND voided_by_action_id IS NULL
        AND (started_on IS NULL OR started_on <= $2::date)
        AND (ended_on IS NULL OR ended_on >= $2::date)
      ORDER BY started_on NULLS FIRST, id`,
    [employeeId, date],
  );
  const codes = new Set<string>();
  for (const employment of employments.rows) {
    for (const binding of await bindingsOn(db, employment.id, date)) codes.add(binding.code);
  }
  return [...codes].sort();
}

interface ResolvedRubric {
  rubric: Rubric;
  versionId: string | null;
  version: number | null;
  jobCodes: string[];
}

/**
 * D-20: the rubric one participant is scored against, frozen onto their review. The cycle's own
 * rubric is the last resort: HC may have typed one for this cycle, and before any version exists
 * it is the seeded default.
 */
async function resolveRubricFor(
  db: Queryable, input: { employeeId: string; date: string; versions: RubricVersion[]; cycle: CycleRow },
): Promise<ResolvedRubric> {
  // A cycle whose rubric HC typed (`rubricVersion` null) says what this cycle's everyone-rubric
  // is, so it takes the place of the DEFAULT version rather than losing to it. A JOB_GROUP
  // version is still more specific than any cycle-level statement and still wins.
  const ownRubric = input.cycle.rubricVersion === null;
  const candidates = ownRubric ? input.versions.filter((version) => version.scope === "JOB_GROUP") : input.versions;
  const jobCodes = candidates.some((version) => version.scope === "JOB_GROUP")
    ? await jobCodesOf(db, input.employeeId, input.date)
    : [];
  const chosen = selectRubricVersion(candidates, jobCodes, input.date);
  if (!chosen) return { rubric: input.cycle.rubric, versionId: null, version: null, jobCodes };
  return { rubric: chosen.rubric, versionId: chosen.id, version: chosen.version, jobCodes };
}

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
  /** D-20: the rubric frozen onto this review, which is what its scores are read against. */
  rubric: Rubric;
  objectionStatus: ObjectionStatus | null;
  objectionDueOn: string | null;
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
            rater_employee_id AS "raterEmployeeId", predicate_code AS "predicateCode", rubric,
            objection_status AS "objectionStatus", to_char(objection_due_on, 'YYYY-MM-DD') AS "objectionDueOn"
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
  // D-17: the employee's own objection and what HC decided about it.
  "performance.review.objected", "performance.review.objection_waived",
  "performance.review.objection_upheld", "performance.review.objection_rejected",
];

/**
 * D-17: the one place that refuses an objection, so raising and waiving one answer alike. Each
 * refusal names its own cause: already used, too late, or not with HC at all.
 */
function assertMayObject(review: LockedReview) {
  if (review.objectionStatus !== null) {
    throw new PerformanceError(409, "PERFORMANCE_OBJECTION_ALREADY_RAISED", "Keberatan untuk penilaian ini sudah pernah diajukan.");
  }
  if (review.status !== "HC_VALIDATION" || review.objectionDueOn === null) {
    throw new PerformanceError(409, "PERFORMANCE_OBJECTION_NOT_ALLOWED", "Keberatan hanya dapat diajukan setelah penilai mengirim nilai dan sebelum Human Capital mengesahkannya.");
  }
  if (today() > review.objectionDueOn) {
    throw new PerformanceError(409, "PERFORMANCE_OBJECTION_WINDOW_CLOSED", `Masa keberatan berakhir pada ${review.objectionDueOn}.`);
  }
}

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
  review.finalized_at AS "finalizedAt", review.acknowledged_at AS "acknowledgedAt", review.trend,
  review.rubric_version AS "rubricVersion",
  to_char(review.objection_due_on, 'YYYY-MM-DD') AS "objectionDueOn", review.objection_status AS "objectionStatus"`;
const REVIEW_JOINS = `
  JOIN performance_cycles cycle ON cycle.id = review.cycle_id
  JOIN employees employee ON employee.id = review.employee_id
  LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
  LEFT JOIN employees rater ON rater.id = review.rater_employee_id
  LEFT JOIN accounts rater_account ON rater_account.employee_id = rater.id AND rater_account.principal_type = 'EMPLOYEE'`;

/**
 * The result columns. D-17 (18 Nov 2026) amends D-09 and PERF-001-A: the employee sees the rater's
 * score once it reaches HC (`HC_VALIDATION`), because that is what they may object to; before
 * that there is still nothing to show. In the HC views `viewerParam` names the viewer's employee
 * id, so an HC admin who is a participant sees their own review exactly as the employee does and
 * never earlier.
 */
const EMPLOYEE_RESULT_VISIBLE = "review.status IN ('HC_VALIDATION', 'FINALIZED')";

function resultColumns(view: View, viewerParam?: string) {
  const visible = view === "employee"
    ? EMPLOYEE_RESULT_VISIBLE
    : view === "hc" && viewerParam
      ? `(${EMPLOYEE_RESULT_VISIBLE} OR review.employee_id IS DISTINCT FROM ${viewerParam}::uuid)`
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
    objectionStatus: ObjectionStatus | null; objectionDueOn: string | null; objectionReason: string | null;
    objectionRaisedAt: string | null; objectionDecidedAt: string | null; objectionDecisionReason: string | null;
  }>(
    `SELECT ${REVIEW_COLUMNS}, ${resultColumns(view, "$5")}, review.rubric,
            review.self_scores AS "selfScores", review.self_note AS "selfNote",
            review.rater_scores AS "raterScores", review.strengths, review.improvements, review.rater_note AS "raterNote",
            review.acknowledgement_comment AS "acknowledgementComment", review.removed_reason AS "removedReason",
            review.objection_reason AS "objectionReason", review.objection_raised_at AS "objectionRaisedAt",
            review.objection_decided_at AS "objectionDecidedAt", review.objection_decision_reason AS "objectionDecisionReason"
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
  const {
    rubric, selfScores, selfNote, raterScores, strengths, improvements, raterNote,
    objectionReason, objectionRaisedAt, objectionDecidedAt, objectionDecisionReason, ...rest
  } = row;
  // D-17: the written feedback is part of what the employee may object to, so it opens with the
  // score rather than after validation.
  const showRating = !restricted || row.status === "HC_VALIDATION" || row.status === "FINALIZED";
  const open = row.cycleStatus === "OPEN";
  const date = today();
  const objectionState = {
    status: row.status, objectionStatus: row.objectionStatus, objectionDueOn: row.objectionDueOn, today: date,
  };
  const mayObject = open && canObject(objectionState);
  const mayFinalize = open && canFinalize(objectionState);
  const employeeActions = [
    ...(mayObject ? ["object", "waive-objection"] : []),
    ...(row.status === "FINALIZED" && !row.acknowledgedAt ? ["acknowledge"] : []),
  ];
  const allowedActions = view === "employee"
    ? [...(open && row.status === "SELF_ASSESSMENT" ? ["self-assessment"] : []), ...employeeActions]
    : view === "rater"
      ? (open && canRaterReview({ status: row.status, selfDueOn: row.selfDueOn, today: date }) ? ["rate"] : [])
      : ownReview
        // An HC admin acts on their own review only as its employee: object or waive, never validate.
        ? employeeActions
        : [
            ...(open && row.status === "HC_VALIDATION" && !viewerIsRater && row.objectionStatus === "OPEN"
              ? ["uphold-objection", "reject-objection"] : []),
            ...(mayFinalize && !viewerIsRater ? ["finalize"] : []),
            ...(open && row.status === "HC_VALIDATION" && !viewerIsRater && row.objectionStatus !== "OPEN" ? ["return"] : []),
            ...((open || row.cycleStatus === "DRAFT") && ["SELF_ASSESSMENT", "MANAGER_REVIEW"].includes(row.status) ? ["assign-rater"] : []),
            ...((open || row.cycleStatus === "DRAFT") && ACTIVE_REVIEW_STATUSES.includes(row.status) ? ["remove"] : []),
          ];
  return {
    ...rest,
    rubric,
    selfAssessment: selfScores ? { scores: selfScores, note: selfNote } : null,
    rating: showRating && raterScores ? { scores: raterScores, strengths, improvements, note: raterNote } : null,
    // D-17: the employee reads HC's decision here; the history carries no notes for them (§9).
    // The rater sees that an objection happened and what came of it, never a word of what the
    // employee wrote about them or how HC weighed it: naming the complainant to the person
    // complained about is an invitation to retaliate, and that is what stops people using the
    // route at all. They already learn what they need — that the score comes back to be redone.
    objection: row.objectionStatus
      ? {
          status: row.objectionStatus,
          reason: view === "rater" ? null : objectionReason,
          raisedAt: objectionRaisedAt,
          decidedAt: objectionDecidedAt,
          decisionReason: view === "rater" ? null : objectionDecisionReason,
        }
      : null,
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
      await assertManagedByHcis(client, employee.id);
      const { review, cycle } = await lockReview(client, params.data.id, { employeeId: employee.id });
      if (review.status === "REMOVED") throw NOT_FOUND();
      if (cycle.status !== "OPEN") throw CYCLE_NOT_OPEN();
      if (review.status !== "SELF_ASSESSMENT") {
        throw new PerformanceError(409, "PERFORMANCE_SELF_NOT_ALLOWED", "Penilaian diri sudah dikirim atau penilai sudah menilai.");
      }
      // D-20: the review's own rubric, not the cycle's, since one cycle holds several.
      const scores = validateScores(review.rubric, body.data.scores);
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

  /**
   * D-17: the employee's single objection to the rater's score, raised while HC has not validated
   * it. The score does not change here — HC decides (§7.12) — but an open objection blocks
   * finalization, so a result can never be made final behind the employee's back.
   */
  app.post("/performance/me/:id/objection", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    const body = objectionBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "Alasan keberatan 10 sampai 1000 karakter.");
    return transact(reply, async (client) => {
      const employee = await loadEmployee(client, principal.id);
      const { review, cycle } = await lockReview(client, params.data.id, { employeeId: employee.id });
      if (review.status === "REMOVED") throw NOT_FOUND();
      if (cycle.status !== "OPEN") throw CYCLE_NOT_OPEN();
      assertMayObject(review);
      await client.query(
        `UPDATE performance_reviews
            SET objection_status = 'OPEN', objection_reason = $2, objection_raised_at = now(), updated_at = now()
          WHERE id = $1`,
        [review.id, body.data.reason],
      );
      // The reason stays on the review rather than in the event note: HC reads it from the
      // review, and the history is also what the rater and the employee see (spec §9).
      await addEvent(client, {
        cycleId: cycle.id, reviewId: review.id, actorAccountId: principal.id, eventType: "performance.review.objected",
        metadata: { predicateCode: review.predicateCode },
      });
      return [200, { id: review.id, objectionStatus: "OPEN" }];
    });
  });

  /** D-17: the employee accepts the score and closes their own window, so HC need not wait it out. */
  app.post("/performance/me/:id/objection/waive", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply);
    return transact(reply, async (client) => {
      const employee = await loadEmployee(client, principal.id);
      const { review, cycle } = await lockReview(client, params.data.id, { employeeId: employee.id });
      if (review.status === "REMOVED") throw NOT_FOUND();
      if (cycle.status !== "OPEN") throw CYCLE_NOT_OPEN();
      assertMayObject(review);
      await client.query(
        `UPDATE performance_reviews
            SET objection_status = 'WAIVED', objection_raised_at = now(), updated_at = now()
          WHERE id = $1`,
        [review.id],
      );
      await addEvent(client, {
        cycleId: cycle.id, reviewId: review.id, actorAccountId: principal.id,
        eventType: "performance.review.objection_waived",
      });
      return [200, { id: review.id, objectionStatus: "WAIVED" }];
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
      // D-20: scored against the rubric frozen onto this review when its employee joined.
      const scores = validateScores(review.rubric, body.data.scores);
      const score = finalScore(review.rubric, scores);
      const predicate = predicateFor(review.rubric, score);
      // D-17: the objection window opens on the day the employee can first read this score — but
      // only for an employee who still has an objection to raise. One objection per cycle, so once
      // it has been used (or waived) the window is spent, and a review scored again gets no new
      // date rather than a date that means nothing to whoever reads it through the API.
      const dueOn = review.objectionStatus === null ? objectionDueOn(today()) : null;
      await client.query(
        `UPDATE performance_reviews
            SET status = 'HC_VALIDATION', rater_scores = $2::jsonb, strengths = $3, improvements = $4, rater_note = $5,
                rated_by_account_id = $6, rated_at = now(), final_score = $7, predicate_code = $8, predicate_label = $9,
                objection_due_on = $10::date, updated_at = now()
          WHERE id = $1`,
        [review.id, JSON.stringify(scores), body.data.strengths || null, body.data.improvements || null, body.data.note || null,
          principal.id, score, predicate.code, predicate.label, dueOn],
      );
      await addEvent(client, {
        cycleId: cycle.id, reviewId: review.id, actorAccountId: principal.id, eventType: "performance.review.rated",
        metadata: { predicateCode: predicate.code, withoutSelfAssessment: review.status === "SELF_ASSESSMENT", objectionDueOn: dueOn },
      });
      // The employee is told the score is readable, and until when they may object while that is
      // still open to them. Like every other performance notification it carries no score or
      // predicate (spec §10).
      await notifyEmployee(client, review.employeeId, {
        eventKey: `performance.${review.id}.rated.${randomUUID()}`,
        category: "system",
        title: "Nilai kinerja Anda dapat dilihat",
        body: dueOn
          ? `Penilai sudah mengirim nilai ${cycle.name}. Anda dapat mengajukan keberatan paling lambat ${dueOn}.`
          : `Penilai sudah mengirim nilai ${cycle.name} setelah keberatan Anda diputuskan.`,
        href: `/app/performance?review=${review.id}`,
        actorAccountId: principal.id,
      });
      return [200, {
        id: review.id, status: "HC_VALIDATION", finalScore: score,
        predicateCode: predicate.code, predicateLabel: predicate.label, objectionDueOn: dueOn,
      }];
    });
  });

  // ------------------------------------------------------------------- admin

  /**
   * D-19/D-20: the rubric HC manages, as dated versions, each covering every job or a group of
   * job classification codes. Append-only, so the list is also the history.
   */
  app.get("/admin/performance/rubric-versions", async (request, reply) => {
    if (!(await requirePermission(request, reply, "performance.read"))) return;
    const query = pageQuerySchema.safeParse(request.query);
    if (!query.success) return invalid(reply, "Filter tidak valid.");
    const result = await pool.query<{ total: number }>(
      `SELECT version.id, version.version, version.scope, version.name,
              to_char(version.effective_from, 'YYYY-MM-DD') AS "effectiveFrom",
              version.payload AS rubric, version.source, version.note, version.created_at AS "createdAt",
              author.full_name AS "createdByName",
              COALESCE(
                (SELECT array_agg(job.job_classification_code ORDER BY job.job_classification_code)
                   FROM performance_rubric_version_jobs job WHERE job.rubric_version_id = version.id),
                ARRAY[]::text[]
              ) AS "jobClassificationCodes",
              (SELECT count(*)::int FROM performance_reviews review WHERE review.rubric_version_id = version.id) AS "reviewCount",
              count(*) OVER ()::int AS total
         FROM performance_rubric_versions version
         LEFT JOIN accounts account ON account.id = version.created_by_account_id
         LEFT JOIN employees author ON author.id = account.employee_id
        ORDER BY version.version DESC
        LIMIT $1 OFFSET $2`,
      [query.data.pageSize, pageOffset(query.data)],
    );
    const inForce = await rubricVersionsInForce(pool, today());
    return send(reply, 200, {
      items: result.rows.map(listItem),
      pagination: pagination(query.data, result.rows[0]?.total ?? 0),
      // What a participant with no covered job would be scored against today.
      defaultVersion: selectRubricVersion(inForce, [], today())?.version ?? null,
    });
  });

  app.post("/admin/performance/rubric-versions", async (request, reply) => {
    const principal = await requirePermission(request, reply, "performance.manage");
    if (!principal) return;
    const body = rubricVersionBody.safeParse(request.body);
    if (!body.success) return invalid(reply, "Nama, indikator, predikat, tanggal berlaku, atau cakupan jabatan rubrik tidak valid.");
    const jobCodes = [...new Set(body.data.jobClassificationCodes ?? [])].sort();
    if ((body.data.scope === "JOB_GROUP") !== (jobCodes.length > 0)) {
      return invalid(reply, "Rubrik bercakupan jabatan menyebut minimal satu kode klasifikasi; rubrik dasar tidak menyebut satu pun.");
    }
    return transact(reply, async (client) => {
      // D-19: the same rules a cycle rubric obeys, whole-percent weights summing to 100 included.
      const rubric = validateRubric({ indicators: body.data.indicators, predicates: body.data.predicates });
      // Serializes the version numbering: two HC admins saving at once must not both take n+1.
      const latest = await client.query<{ version: number; effectiveFrom: string }>(
        `SELECT version, to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom" FROM performance_rubric_versions
          ORDER BY version DESC LIMIT 1 FOR UPDATE`,
      );
      const previous = latest.rows[0];
      // A version that starts before the newest one would change which rubric was in force on a
      // day already scored. New rubrics start from the newest start date onward.
      if (previous && body.data.effectiveFrom < previous.effectiveFrom) {
        throw new PerformanceError(409, "PERFORMANCE_RUBRIC_VERSION_BACKDATED",
          `Versi rubrik baru berlaku paling awal ${previous.effectiveFrom}, tanggal berlaku versi terakhir.`);
      }
      const id = randomUUID();
      const version = (previous?.version ?? 0) + 1;
      await client.query(
        `INSERT INTO performance_rubric_versions (
           id, version, scope, name, effective_from, payload, source, note, created_by_account_id
         ) VALUES ($1, $2, $3, $4, $5::date, $6::jsonb, $7, $8, $9)`,
        [id, version, body.data.scope, body.data.name, body.data.effectiveFrom, JSON.stringify(rubric),
          body.data.source, body.data.note || null, principal.id],
      );
      if (jobCodes.length > 0) {
        await client.query(
          `INSERT INTO performance_rubric_version_jobs (rubric_version_id, job_classification_code)
           SELECT $1, code FROM unnest($2::text[]) AS code`,
          [id, jobCodes],
        );
      }
      // The row itself is the audit record: append-only, carrying its author and time (spec §9).
      return [201, { id, version, scope: body.data.scope, effectiveFrom: body.data.effectiveFrom, jobClassificationCodes: jobCodes }];
    });
  });

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
      // D-19: the cycle's own rubric is the fallback for participants no scoped version covers.
      // Unless HC types one here, it is the DEFAULT version in force today, recorded by number.
      const fallback = body.data.rubric
        ? null
        : selectRubricVersion(await rubricVersionsInForce(client, today()), [], today());
      const rubric = validateRubric(body.data.rubric ?? fallback?.rubric ?? DEFAULT_RUBRIC);
      const id = randomUUID();
      await client.query(
        `INSERT INTO performance_cycles (
           id, name, kind, period_start, period_end, self_due_on, review_due_on, status, rubric,
           rubric_version_id, rubric_version, created_by_account_id
         ) VALUES ($1, $2, $3, $4::date, $5::date, $6::date, $7::date, 'DRAFT', $8::jsonb, $9, $10, $11)`,
        [id, body.data.name, body.data.kind, body.data.periodStart, body.data.periodEnd, body.data.selfDueOn,
          body.data.reviewDueOn, JSON.stringify(rubric), fallback?.id ?? null, fallback?.version ?? null, principal.id],
      );
      await addEvent(client, {
        cycleId: id, actorAccountId: principal.id, eventType: "performance.cycle.created",
        metadata: { kind: body.data.kind, rubricVersion: fallback?.version ?? null },
      });
      return [201, { id, status: "DRAFT", rubricVersion: fallback?.version ?? null }];
    });
  });

  app.get("/admin/performance/cycles/:id", async (request, reply) => {
    if (!(await requirePermission(request, reply, "performance.read"))) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply);
    return handle(reply, async () => {
      const cycle = await loadCycle(pool, params.data.id);
      const [byStatus, byPredicate, byRubric, objections, raters, events] = await Promise.all([
        pool.query<{ status: ReviewStatus; count: number }>(
          `SELECT status, count(*)::int AS count FROM performance_reviews WHERE cycle_id = $1 GROUP BY status`,
          [cycle.id],
        ),
        pool.query<{ code: string; count: number }>(
          `SELECT predicate_code AS code, count(*)::int AS count FROM performance_reviews
            WHERE cycle_id = $1 AND status = 'FINALIZED' GROUP BY predicate_code`,
          [cycle.id],
        ),
        pool.query<{ version: number | null; name: string | null; count: number }>(
          // D-20: which rubrics this cycle actually scores against, so HC sees the groups at work.
          `SELECT review.rubric_version AS version, version.name, count(*)::int AS count
             FROM performance_reviews review
             LEFT JOIN performance_rubric_versions version ON version.id = review.rubric_version_id
            WHERE review.cycle_id = $1 AND review.status <> 'REMOVED'
            GROUP BY review.rubric_version, version.name
            ORDER BY count(*) DESC, review.rubric_version NULLS LAST`,
          [cycle.id],
        ),
        pool.query<{ open: number }>(
          // D-17: HC's queue of objections waiting for a decision on this cycle.
          // The status filter is what makes a row written before this release read correctly too.
          `SELECT count(*)::int AS open FROM performance_reviews
            WHERE cycle_id = $1 AND objection_status = 'OPEN' AND status = 'HC_VALIDATION'`,
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
          byRubricVersion: byRubric.rows.map(listItem),
          objectionsOpen: objections.rows[0]?.open ?? 0,
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
                review_due_on = $7::date, rubric = $8::jsonb, updated_at = now(),
                -- D-19: a rubric HC types here is this cycle's own, no longer a version.
                rubric_version_id = CASE WHEN $9::boolean THEN NULL ELSE rubric_version_id END,
                rubric_version = CASE WHEN $9::boolean THEN NULL ELSE rubric_version END
          WHERE id = $1`,
        [cycle.id, next.name, next.kind, next.periodStart, next.periodEnd, next.selfDueOn, next.reviewDueOn,
          JSON.stringify(rubric), body.data.rubric !== undefined],
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
      // FOR KEY SHARE: a candidate cannot be deleted while its review rows are written, so the insert
      // below never meets a vanished employee (an FK 500, seen when suites run in parallel). The key
      // lock is the one the foreign key itself takes: unlike FOR SHARE it does not hold up ordinary
      // updates of every active employee for the length of a bulk add.
      if ("allActive" in body.data) {
        const active = await client.query<{ id: string }>(
          `SELECT id FROM employees WHERE status = 'active' AND removed_at IS NULL ORDER BY full_name ASC, id ASC FOR KEY SHARE`,
        );
        candidates = active.rows.map((row) => row.id);
      } else {
        const ids = [...new Set(body.data.employeeIds)];
        const found = await client.query<{ id: string }>(
          `SELECT id FROM employees WHERE id = ANY($1::uuid[]) AND status = 'active' AND removed_at IS NULL FOR KEY SHARE`,
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
      // D-20: one read of the rubric versions in force, then one rubric per participant from the
      // job they hold on the same effective date the rater is resolved against.
      const versions = await rubricVersionsInForce(client, effectiveDate);
      const summary = { added: 0, readded: 0, alreadyIn: 0, withoutRater: 0, withoutJobRubric: 0 };
      for (const employeeId of candidates) {
        const current = byEmployee.get(employeeId);
        if (current && current.status !== "REMOVED") {
          summary.alreadyIn += 1;
          continue;
        }
        const rater = await resolveLineManager(client, { workflowKey: PERFORMANCE_WORKFLOW_KEY, employeeId, effectiveDate });
        if (!rater.employeeId) summary.withoutRater += 1;
        const resolved = await resolveRubricFor(client, { employeeId, date: effectiveDate, versions, cycle });
        if (resolved.version === null) summary.withoutJobRubric += 1;
        const reviewId = current?.id ?? randomUUID();
        if (current) {
          // D-14: re-adding revives the same review from the start, including its rubric: the
          // employee may have changed jobs since, and the next scoring must use the job they
          // hold now.
          await client.query(
            `UPDATE performance_reviews
                SET status = 'SELF_ASSESSMENT', rater_employee_id = $2, rater_source = $3, rater_snapshot = $4::jsonb,
                    self_scores = NULL, self_note = NULL, self_submitted_at = NULL, rater_scores = NULL, strengths = NULL,
                    improvements = NULL, rater_note = NULL, rated_by_account_id = NULL, rated_at = NULL, final_score = NULL,
                    predicate_code = NULL, predicate_label = NULL, removed_reason = NULL,
                    rubric = $5::jsonb, rubric_version_id = $6, rubric_version = $7,
                    -- D-17: the objection belongs to the round that was removed. Left behind it
                    -- would deny the revived review an objection it never had, hand it a
                    -- validation with no window at all, and show the previous round's reasons.
                    objection_due_on = NULL, objection_raised_at = NULL, objection_reason = NULL,
                    objection_status = NULL, objection_decided_at = NULL,
                    objection_decided_by_account_id = NULL, objection_decision_reason = NULL,
                    updated_at = now()
              WHERE id = $1`,
            [reviewId, rater.employeeId, rater.source, JSON.stringify(rater.snapshot),
              JSON.stringify(resolved.rubric), resolved.versionId, resolved.version],
          );
          summary.readded += 1;
        } else {
          await client.query(
            `INSERT INTO performance_reviews (
               id, cycle_id, employee_id, status, rater_employee_id, rater_source, rater_snapshot,
               rubric, rubric_version_id, rubric_version
             ) VALUES ($1, $2, $3, 'SELF_ASSESSMENT', $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
            [reviewId, cycle.id, employeeId, rater.employeeId, rater.source, JSON.stringify(rater.snapshot),
              JSON.stringify(resolved.rubric), resolved.versionId, resolved.version],
          );
          summary.added += 1;
        }
        await addEvent(client, {
          cycleId: cycle.id, reviewId, actorAccountId: principal.id,
          eventType: current ? "performance.review.readded" : "performance.review.added",
          metadata: {
            raterEmployeeId: rater.employeeId, raterSource: rater.source, unresolved: rater.snapshot.unresolved ?? null,
            // D-20: why this review got this rubric, so a past result stays explainable.
            rubricVersion: resolved.version, jobClassificationCodes: resolved.jobCodes,
          },
        });
        if (cycle.status === "OPEN") await notifyParticipant(client, cycle, employeeId, reviewId, principal.id);
      }
      return [200, summary];
    });
  });

  /**
   * D-20: re-resolve and re-freeze the rubric of every participant who is still in the cycle.
   * Returns how many reviews actually changed, so the audit event says whether anything moved.
   * Only reviews that nobody has scored yet are touched: a rubric must never change under a score
   * that was already given against it.
   */
  async function refreezeRubrics(client: PoolClient, cycle: CycleRow, actorAccountId: string): Promise<number> {
    const effectiveDate = today() < cycle.periodEnd ? today() : cycle.periodEnd;
    const versions = await rubricVersionsInForce(client, effectiveDate);
    const reviews = await client.query<{ id: string; employeeId: string; rubricVersion: number | null; rubric: Rubric }>(
      `SELECT id, employee_id AS "employeeId", rubric_version AS "rubricVersion", rubric
         FROM performance_reviews
        WHERE cycle_id = $1 AND status = 'SELF_ASSESSMENT' AND self_scores IS NULL
        FOR UPDATE`,
      [cycle.id],
    );
    let changed = 0;
    for (const review of reviews.rows) {
      const resolved = await resolveRubricFor(client, { employeeId: review.employeeId, date: effectiveDate, versions, cycle });
      if (resolved.version === review.rubricVersion && JSON.stringify(resolved.rubric) === JSON.stringify(review.rubric)) continue;
      await client.query(
        `UPDATE performance_reviews SET rubric = $2::jsonb, rubric_version_id = $3, rubric_version = $4, updated_at = now()
          WHERE id = $1`,
        [review.id, JSON.stringify(resolved.rubric), resolved.versionId, resolved.version],
      );
      await addEvent(client, {
        cycleId: cycle.id, reviewId: review.id, actorAccountId, eventType: "performance.review.rubric_refrozen",
        metadata: { from: review.rubricVersion, to: resolved.version, jobClassificationCodes: resolved.jobCodes },
      });
      changed += 1;
    }
    return changed;
  }

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
      // D-20: every participant's rubric is frozen again here, because both inputs may have moved
      // since they were added while the cycle was still DRAFT — HC may have corrected a weight on
      // the cycle rubric, and a new rubric version may have started. Opening the cycle is the last
      // moment anything can change, so this is where the freeze is made to stick. Participants
      // added later, while the cycle is already OPEN, keep the rubric resolved at that moment.
      const refrozen = await refreezeRubrics(client, cycle, principal.id);
      await client.query(`UPDATE performance_cycles SET status = 'OPEN', opened_at = now(), updated_at = now() WHERE id = $1`, [cycle.id]);
      await addEvent(client, {
        cycleId: cycle.id, actorAccountId: principal.id, eventType: "performance.cycle.opened",
        metadata: { participants: participants.rows.length, rubricsRefrozen: refrozen },
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
          -- D-17: HC's queue of objections waiting for a decision. Only a review still with HC
          -- can be decided, so only those are ever counted as open.
          AND ($10::text IS NULL OR (review.objection_status = $10 AND review.status = 'HC_VALIDATION'))
        ORDER BY employee.full_name ASC, review.id ASC
        LIMIT $7 OFFSET $8`,
      [params.data.id, filter.status ?? null, filter.predicate ?? null, filter.employeeId ?? null,
        filter.raterMissing === undefined ? null : filter.raterMissing === "true", filter.q ?? null,
        filter.pageSize, pageOffset(filter), viewer, filter.objection ?? null],
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
      if (cycle.status !== "OPEN" || review.status !== "HC_VALIDATION") throw NOT_IN_VALIDATION();
      await assertNotPartyTo(client, principal.id, review);
      // D-17: an open objection, or a window the employee may still use, holds the result back.
      if (review.objectionStatus === "OPEN") {
        throw OBJECTION_OPEN("Putuskan keberatan pegawai sebelum mengesahkan hasil ini.");
      }
      if (!canFinalize({ status: review.status, objectionStatus: review.objectionStatus, objectionDueOn: review.objectionDueOn, today: today() })) {
        throw new PerformanceError(409, "PERFORMANCE_OBJECTION_WINDOW_OPEN",
          `Masa keberatan pegawai berjalan sampai ${review.objectionDueOn}. Hasil dapat disahkan sesudahnya, atau setelah pegawai menerima nilainya.`);
      }
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
      if (cycle.status !== "OPEN" || review.status !== "HC_VALIDATION") throw NOT_IN_VALIDATION();
      await assertNotPartyTo(client, principal.id, review);
      // D-17: an open objection is decided, not bypassed; accepting it is what returns the review.
      if (review.objectionStatus === "OPEN") {
        throw OBJECTION_OPEN("Putuskan keberatan pegawai lebih dulu; keberatan yang diterima mengembalikan penilaian ke penilai.");
      }
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

  /**
   * D-17: HC decides the objection. Accepting it returns the review to the rater exactly as
   * `return` does, because the module's authority model (D-07) is that HC never types a score:
   * an upheld objection is a re-rating by the manager, not a correction by HC. Rejecting it keeps
   * the score and gives the employee HC's reason; the review stays with HC to finalize.
   */
  async function decideObjection(request: FastifyRequest, reply: FastifyReply, decision: "UPHELD" | "REJECTED") {
    const principal = await requirePermission(request, reply, "performance.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    const body = objectionBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "Alasan keputusan keberatan 10 sampai 1000 karakter.");
    return transact(reply, async (client) => {
      const { review, cycle } = await lockReview(client, params.data.id);
      if (cycle.status !== "OPEN" || review.status !== "HC_VALIDATION") throw NOT_IN_VALIDATION();
      if (review.objectionStatus !== "OPEN") {
        throw new PerformanceError(409, "PERFORMANCE_OBJECTION_NOT_OPEN", "Tidak ada keberatan yang sedang menunggu keputusan pada penilaian ini.");
      }
      // D-07: neither the employee being reviewed nor their rater decides their own objection.
      await assertNotPartyTo(client, principal.id, review);
      const upheld = decision === "UPHELD";
      await client.query(
        `UPDATE performance_reviews
            SET objection_status = $2, objection_decided_at = now(), objection_decided_by_account_id = $3,
                objection_decision_reason = $4,
                status = CASE WHEN $5::boolean THEN 'MANAGER_REVIEW' ELSE status END,
                final_score = CASE WHEN $5::boolean THEN NULL ELSE final_score END,
                predicate_code = CASE WHEN $5::boolean THEN NULL ELSE predicate_code END,
                predicate_label = CASE WHEN $5::boolean THEN NULL ELSE predicate_label END,
                rated_by_account_id = CASE WHEN $5::boolean THEN NULL ELSE rated_by_account_id END,
                rated_at = CASE WHEN $5::boolean THEN NULL ELSE rated_at END,
                updated_at = now()
          WHERE id = $1`,
        [review.id, decision, principal.id, body.data.reason, upheld],
      );
      await addEvent(client, {
        cycleId: cycle.id, reviewId: review.id, actorAccountId: principal.id,
        eventType: upheld ? "performance.review.objection_upheld" : "performance.review.objection_rejected",
        note: body.data.reason, metadata: { previousPredicateCode: review.predicateCode },
      });
      await notifyEmployee(client, review.employeeId, {
        eventKey: `performance.${review.id}.objection.${randomUUID()}`,
        category: "system",
        title: upheld ? "Keberatan Anda diterima" : "Keberatan Anda ditolak",
        body: upheld
          ? `Human Capital menerima keberatan Anda pada ${cycle.name}; penilaian dikembalikan ke penilai.`
          : `Human Capital menolak keberatan Anda pada ${cycle.name}. Alasannya ada di detail penilaian.`,
        href: `/app/performance?review=${review.id}`,
        actorAccountId: principal.id,
      });
      if (upheld && review.raterEmployeeId) {
        await notifyEmployee(client, review.raterEmployeeId, {
          eventKey: `performance.${review.id}.objection_rerate.${randomUUID()}`,
          category: "system",
          title: "Penilaian kinerja dikembalikan",
          body: `Human Capital menerima keberatan pegawai pada ${cycle.name}; mohon tinjau ulang nilainya.`,
          href: `/app/performance?tab=team&review=${review.id}`,
          actorAccountId: principal.id,
        });
      }
      return [200, { id: review.id, objectionStatus: decision, status: upheld ? "MANAGER_REVIEW" : "HC_VALIDATION" }];
    });
  }

  app.post("/admin/performance/reviews/:id/objection/uphold", (request, reply) => decideObjection(request, reply, "UPHELD"));
  app.post("/admin/performance/reviews/:id/objection/reject", (request, reply) => decideObjection(request, reply, "REJECTED"));

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
                -- D-17: an objection still waiting on HC can never be decided once the review is
                -- out of the cycle, because both decisions require HC_VALIDATION. Leaving it would
                -- park a count HC cannot clear. Only an OPEN one is cleared: an objection HC
                -- already decided is history, and history stays readable on the row it belongs to.
                objection_due_on = CASE WHEN objection_status = 'OPEN' THEN NULL ELSE objection_due_on END,
                objection_raised_at = CASE WHEN objection_status = 'OPEN' THEN NULL ELSE objection_raised_at END,
                objection_reason = CASE WHEN objection_status = 'OPEN' THEN NULL ELSE objection_reason END,
                objection_status = CASE WHEN objection_status = 'OPEN' THEN NULL ELSE objection_status END,
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
