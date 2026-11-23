// TRAIN-001 R3 routes: instruments, the evaluation plan of a program, respondents (participant,
// supervisor, HC), server-side scoring and the per-program and per-employee recap.
// Spec: docs/domain/training-evaluation.md.
//
// No new permission (E-17): training.read for reads, training.manage for HC writes. Participants
// and supervisors answer by enrolment and assignment from their own session, never a permission;
// anything that is not theirs answers 404.

import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";

import { pageOffset, pageQuerySchema, pagination } from "../../lib/pagination.js";
import type { AuthPrincipal } from "../auth/service.js";
import { jakartaDate } from "../documents/service.js";
import { notifyEmployee } from "../notifications/service.js";
import { resolveLineManager, type ResolvedLineManager } from "../organization/line-manager.js";
import type { OrganizationWorkflowKey } from "../organization/workflow-keys.js";
import {
  ANONYMOUS_COMMENT_THRESHOLD,
  anonymousAggregatesVisible,
  COMPONENT_KINDS,
  componentOpen,
  computeOutcome,
  INSTRUMENT_FOR_COMPONENT,
  INSTRUMENT_KINDS,
  MAX_ACTIVE_COMPONENTS,
  mean,
  normalizeItems,
  publicItems,
  resolveComponent,
  RESPONDENTS,
  scaleMean,
  scoreResponse,
  STAGES,
  stageOpen,
  summarizeForm,
  validateAnswers,
  type Answers,
  type ComponentKind,
  type InstrumentKind,
  type Item,
  type Respondent,
  type Stage,
} from "./evaluation-domain.js";
import { audit, loadSelf, send, TrainingError, type Queryable, type TrainingRouteKit } from "./shared.js";

const TRAINING_WORKFLOW_KEY: OrganizationWorkflowKey = "TRAINING";
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

const idParams = z.object({ id: z.string().uuid() });
const employeeParams = z.object({ employeeId: z.string().uuid() });
const instant = z.string().datetime({ offset: true });
const instrumentBody = z.object({
  kind: z.enum(INSTRUMENT_KINDS),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(1000).nullable().optional(),
  items: z.array(z.unknown()).min(1).max(50),
});
const instrumentPatch = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  items: z.array(z.unknown()).min(1).max(50).optional(),
});
const instrumentListQuery = pageQuerySchema.extend({
  kind: z.enum(INSTRUMENT_KINDS).optional(),
  status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
  q: z.string().trim().max(100).optional(),
});
const planBody = z.object({ passingScore: z.number().int().min(0).max(100) });
const componentBody = z.object({
  kind: z.enum(COMPONENT_KINDS),
  instrumentId: z.string().uuid(),
  title: z.string().trim().min(3).max(200).optional(),
  level: z.number().int().min(1).max(4).nullable().optional(),
  respondent: z.enum(RESPONDENTS).nullable().optional(),
  anonymous: z.boolean().nullable().optional(),
  weight: z.number().int().min(0).max(100).nullable().optional(),
  required: z.boolean().optional(),
  opensAt: instant.nullable().optional(),
  closesAt: instant.nullable().optional(),
});
const componentPatch = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  weight: z.number().int().min(0).max(100).optional(),
  required: z.boolean().optional(),
  opensAt: instant.nullable().optional(),
  closesAt: instant.nullable().optional(),
});
const reasonBody = z.object({ reason: z.string().trim().min(5).max(500) });
const assessorBody = z.object({
  entries: z.array(z.object({ subjectEmployeeId: z.string().uuid(), assessorEmployeeId: z.string().uuid() })).min(1).max(100),
});
const formQuery = z.object({
  stage: z.enum(STAGES).default("SINGLE"),
  subjectEmployeeId: z.string().uuid().optional(),
});
const responseBody = z.object({
  stage: z.enum(STAGES).default("SINGLE"),
  subjectEmployeeId: z.string().uuid().nullable().optional(),
  answers: z.record(z.unknown()),
});

const componentNotFound = () => new TrainingError(404, "TRAINING_EVALUATION_NOT_FOUND", "Evaluasi tidak ditemukan.");
const instrumentNotFound = () => new TrainingError(404, "TRAINING_INSTRUMENT_NOT_FOUND", "Instrumen tidak ditemukan.");
const programNotFound = () => new TrainingError(404, "TRAINING_PROGRAM_NOT_FOUND", "Program pelatihan tidak ditemukan.");

function rows<T extends { total?: number }>(result: { rows: T[] }) {
  return result.rows.map(({ total, ...row }) => { void total; return row; });
}

// ------------------------------------------------------------- assessors

type RaterSource = "DIRECT_MANAGER" | "GOVERNANCE_APPROVER" | "UNRESOLVED";

/**
 * E-14 / §6.1: stores the assessor of each given participant for every active SUPERVISOR component
 * of the program (or only `componentId`), from the shared line-manager resolver (alur TRAINING).
 * An existing row is kept, so re-enrolment never moves it, and nobody already assigned on every
 * component is resolved again. Assessors are notified once per component and call.
 */
export async function assignSupervisorAssessors(
  db: PoolClient,
  input: { programId: string; employeeIds: readonly string[]; actorAccountId: string; componentId?: string },
) {
  if (input.employeeIds.length === 0) return [];
  const components = await db.query<{ id: string; title: string }>(
    `SELECT id, title FROM training_evaluation_components
      WHERE program_id = $1 AND status = 'ACTIVE' AND respondent = 'SUPERVISOR' AND ($2::uuid IS NULL OR id = $2)
      ORDER BY id`,
    [input.programId, input.componentId ?? null],
  );
  if (components.rows.length === 0) return [];
  const existing = await db.query<{ componentId: string; subjectEmployeeId: string }>(
    `SELECT component_id AS "componentId", subject_employee_id AS "subjectEmployeeId"
       FROM training_evaluation_assessors
      WHERE component_id = ANY($1::uuid[]) AND subject_employee_id = ANY($2::uuid[])`,
    [components.rows.map((row) => row.id), input.employeeIds],
  );
  const assigned = new Set(existing.rows.map((row) => `${row.componentId}:${row.subjectEmployeeId}`));
  const today = jakartaDate(new Date());
  const notify = new Map<string, { componentId: string; title: string; assessorEmployeeId: string }>();
  const resolved = new Map<string, ResolvedLineManager>();
  for (const component of components.rows) {
    for (const employeeId of input.employeeIds) {
      if (assigned.has(`${component.id}:${employeeId}`)) continue;
      let rater = resolved.get(employeeId);
      if (!rater) {
        rater = await resolveLineManager(db, { workflowKey: TRAINING_WORKFLOW_KEY, employeeId, effectiveDate: today });
        resolved.set(employeeId, rater);
      }
      const source: RaterSource = rater.source ?? "UNRESOLVED";
      await db.query(
        `INSERT INTO training_evaluation_assessors
           (component_id, subject_employee_id, assessor_employee_id, source, resolution, assigned_by_account_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, NULL)
         ON CONFLICT (component_id, subject_employee_id) DO NOTHING`,
        [component.id, employeeId, rater.employeeId, source, JSON.stringify(rater.snapshot)],
      );
      if (rater.employeeId) {
        notify.set(`${component.id}:${rater.employeeId}`, { componentId: component.id, title: component.title, assessorEmployeeId: rater.employeeId });
      }
    }
  }
  // One notice per assessor and component for this call; a later call (new participant) notifies again.
  const stamp = Date.now();
  for (const item of notify.values()) {
    await notifyEmployee(db, item.assessorEmployeeId, {
      eventKey: `training.evaluation.${item.componentId}.${item.assessorEmployeeId}.${stamp}`, category: "system",
      title: "Penilaian penerapan pelatihan", body: `Anda diminta menilai peserta pada evaluasi ${item.title}.`,
      href: "/app/training?tab=evaluasi", actorAccountId: input.actorAccountId,
    });
  }
  return [...notify.values()];
}

// ------------------------------------------------------------ components

interface ComponentRow {
  id: string;
  programId: string;
  programTitle: string;
  programStatus: string;
  kind: ComponentKind;
  level: number;
  respondent: Respondent;
  title: string;
  instrumentKind: InstrumentKind;
  items: Item[];
  anonymous: boolean;
  weight: number;
  required: boolean;
  opensAt: Date | null;
  closesAt: Date | null;
  status: string;
}

const COMPONENT_SELECT = `
  component.id, component.program_id AS "programId", program.title AS "programTitle", program.status AS "programStatus",
  component.kind, component.level, component.respondent, component.title, component.instrument_kind AS "instrumentKind",
  component.items, component.anonymous, component.weight, component.required, component.opens_at AS "opensAt",
  component.closes_at AS "closesAt", component.status`;

async function loadComponent(db: Queryable, id: string, lock = false): Promise<ComponentRow> {
  const result = await db.query<ComponentRow>(
    `SELECT ${COMPONENT_SELECT}
       FROM training_evaluation_components component
       JOIN training_programs program ON program.id = component.program_id
      WHERE component.id = $1 ${lock ? "FOR UPDATE OF component" : ""}`,
    [id],
  );
  if (!result.rows[0]) throw componentNotFound();
  return result.rows[0];
}

async function lastSessionStart(db: Queryable, programId: string): Promise<number | null> {
  const result = await db.query<{ lastStart: Date | null }>(
    `SELECT max(start_at) AS "lastStart" FROM training_sessions WHERE program_id = $1 AND status = 'SCHEDULED'`,
    [programId],
  );
  return result.rows[0]?.lastStart?.getTime() ?? null;
}

async function participantStatus(db: Queryable, programId: string, employeeId: string): Promise<string | null> {
  const result = await db.query<{ status: string }>(
    `SELECT status FROM training_participants WHERE program_id = $1 AND employee_id = $2`,
    [programId, employeeId],
  );
  return result.rows[0]?.status ?? null;
}

type Actor =
  | { kind: "EMPLOYEE"; accountId: string; employeeId: string }
  | { kind: "HC"; accountId: string; employeeId: string | null };

interface Respondency {
  subjectEmployeeId: string | null;
  respondentEmployeeId: string | null;
  respondentAccountId: string | null;
}

/**
 * §5.3: who may answer this component for which subject. Anything the actor may not answer is a
 * 404, so a component of a program the employee is not in is indistinguishable from none.
 */
async function authorizeRespondent(
  db: Queryable,
  component: ComponentRow,
  actor: Actor,
  subjectEmployeeId: string | null | undefined,
): Promise<Respondency> {
  if (component.respondent === "PARTICIPANT") {
    if (actor.kind !== "EMPLOYEE") throw componentNotFound();
    const status = await participantStatus(db, component.programId, actor.employeeId);
    if (!status || status === "WITHDRAWN") throw componentNotFound();
    return {
      subjectEmployeeId: component.anonymous ? null : actor.employeeId,
      respondentEmployeeId: actor.employeeId,
      respondentAccountId: null,
    };
  }
  if (component.respondent === "SUPERVISOR") {
    if (actor.kind !== "EMPLOYEE" || !subjectEmployeeId) throw componentNotFound();
    const assigned = await db.query(
      `SELECT 1 FROM training_evaluation_assessors assessor
         JOIN training_participants participant
           ON participant.program_id = $3 AND participant.employee_id = assessor.subject_employee_id AND participant.status <> 'WITHDRAWN'
        WHERE assessor.component_id = $1 AND assessor.subject_employee_id = $2 AND assessor.assessor_employee_id = $4`,
      [component.id, subjectEmployeeId, component.programId, actor.employeeId],
    );
    if (!assigned.rows[0]) throw componentNotFound();
    return { subjectEmployeeId, respondentEmployeeId: actor.employeeId, respondentAccountId: null };
  }
  if (actor.kind !== "HC") throw componentNotFound();
  if (component.kind === "RESULT") return { subjectEmployeeId: null, respondentEmployeeId: null, respondentAccountId: actor.accountId };
  if (!subjectEmployeeId) throw new TrainingError(400, "INVALID_TRAINING_RESPONSE", "Pilih peserta yang dinilai.");
  // E-15: HC never assesses themself.
  if (actor.employeeId === subjectEmployeeId) {
    throw new TrainingError(403, "TRAINING_ASSESSOR_SELF", "Penilaian tentang diri sendiri harus diisi staf HC lain.");
  }
  const status = await participantStatus(db, component.programId, subjectEmployeeId);
  if (!status || status === "WITHDRAWN") throw new TrainingError(404, "TRAINING_PARTICIPANT_NOT_FOUND", "Peserta tidak ditemukan.");
  return { subjectEmployeeId, respondentEmployeeId: null, respondentAccountId: actor.accountId };
}

async function assertAnswerable(db: Queryable, component: ComponentRow, stage: Stage, respondency: Respondency) {
  if (!componentOpen({ ...component, programStatus: component.programStatus, nowMs: Date.now() })) {
    throw new TrainingError(409, "TRAINING_COMPONENT_NOT_OPEN", "Evaluasi ini belum dibuka atau sudah ditutup.");
  }
  const existing = await db.query<{ stage: Stage }>(
    `SELECT stage FROM training_evaluation_completions
      WHERE component_id = $1
        AND COALESCE(subject_employee_id, $2::uuid) = COALESCE($3::uuid, $2::uuid)
        AND COALESCE(respondent_employee_id, $2::uuid) = COALESCE($4::uuid, $2::uuid)`,
    [component.id, ZERO_UUID, respondency.subjectEmployeeId, respondency.respondentEmployeeId],
  );
  const stages = new Set(existing.rows.map((row) => row.stage));
  const open = stageOpen({
    kind: component.kind,
    stage,
    programStatus: component.programStatus,
    lastSessionStartMs: component.kind === "PRE_POST_TEST" ? await lastSessionStart(db, component.programId) : null,
    hasPost: stages.has("POST"),
    nowMs: Date.now(),
  });
  if (stages.has(stage)) throw new TrainingError(409, "TRAINING_RESPONSE_EXISTS", "Evaluasi ini sudah Anda isi.");
  if (!open) {
    throw new TrainingError(409, "TRAINING_STAGE_NOT_OPEN", stage === "PRE"
      ? "Pre-test ditutup setelah post-test diisi."
      : stage === "POST" ? "Post-test dibuka setelah sesi terakhir dimulai." : "Tahap evaluasi tidak valid.");
  }
}

async function formFor(db: Queryable, component: ComponentRow, stage: Stage, respondency: Respondency) {
  await assertAnswerable(db, component, stage, respondency);
  const subject = respondency.subjectEmployeeId && component.respondent !== "PARTICIPANT"
    ? (await db.query<{ id: string; fullName: string }>(`SELECT id, full_name AS "fullName" FROM employees WHERE id = $1`, [respondency.subjectEmployeeId])).rows[0] ?? null
    : null;
  return {
    component: {
      id: component.id, title: component.title, kind: component.kind, level: component.level,
      instrumentKind: component.instrumentKind, anonymous: component.anonymous, respondent: component.respondent,
      closesAt: component.closesAt,
    },
    program: { id: component.programId, title: component.programTitle },
    stage,
    subject,
    items: publicItems(component.items),
  };
}

async function submitResponse(
  client: PoolClient,
  input: { componentId: string; actor: Actor; stage: Stage; subjectEmployeeId: string | null | undefined; answers: unknown },
): Promise<[number, unknown]> {
  // Locking the component serializes its submissions, so pre and post of one person cannot cross.
  const component = await loadComponent(client, input.componentId, true);
  const respondency = await authorizeRespondent(client, component, input.actor, input.subjectEmployeeId);
  await assertAnswerable(client, component, input.stage, respondency);
  const answers = validateAnswers(component.items, input.answers);
  const scored = scoreResponse(component.instrumentKind, component.items, answers);
  const today = jakartaDate(new Date());
  await client.query(
    `INSERT INTO training_evaluation_completions
       (id, component_id, stage, subject_employee_id, respondent_employee_id, respondent_account_id, submitted_on)
     VALUES ($1, $2, $3, $4, $5, $6, $7::date)`,
    [randomUUID(), component.id, input.stage, respondency.subjectEmployeeId, respondency.respondentEmployeeId,
      respondency.respondentAccountId, today],
  );
  const responseId = randomUUID();
  if (component.anonymous) {
    // E-11: no respondent, no subject, no time of day, no audit event.
    await client.query(
      `INSERT INTO training_evaluation_responses (id, component_id, stage, anonymous, answers, submitted_on)
       VALUES ($1, $2, $3, true, $4::jsonb, $5::date)`,
      [responseId, component.id, input.stage, JSON.stringify(answers), today],
    );
    return [201, { anonymous: true, score: null }];
  }
  await client.query(
    `INSERT INTO training_evaluation_responses
       (id, component_id, stage, subject_employee_id, respondent_employee_id, respondent_account_id, anonymous, answers,
        score, points_earned, points_max, submitted_on, submitted_at)
     VALUES ($1, $2, $3, $4, $5, $6, false, $7::jsonb, $8, $9, $10, $11::date, clock_timestamp())`,
    [responseId, component.id, input.stage, respondency.subjectEmployeeId, respondency.respondentEmployeeId,
      respondency.respondentAccountId, JSON.stringify(answers), scored?.score ?? null, scored?.earned ?? null, scored?.max ?? null, today],
  );
  await audit(client, {
    eventType: "training.evaluation.response.submitted", programId: component.programId,
    employeeId: respondency.subjectEmployeeId, actorAccountId: input.actor.accountId,
    metadata: { componentId: component.id, responseId, stage: input.stage, score: scored?.score ?? null },
  });
  // E-16: a test score shows at once; the key never does.
  return [201, {
    id: responseId, anonymous: false,
    score: component.instrumentKind === "TEST" ? scored?.score ?? null : null,
    pointsEarned: component.instrumentKind === "TEST" ? scored?.earned ?? null : null,
    pointsMax: component.instrumentKind === "TEST" ? scored?.max ?? null : null,
  }];
}

// --------------------------------------------------------------- outcome

interface PrePost {
  componentId: string;
  title: string;
  pre: number | null;
  post: number | null;
  gain: number | null;
}

interface OutcomeRow {
  programId: string;
  employeeId: string;
  /** The first pre/post test of the plan; every pre/post test is in `prePost`. */
  pre: number | null;
  post: number | null;
  gain: number | null;
  prePost: PrePost[];
  scores: Record<string, number | null>;
  finalScore: number | null;
  status: string;
  applicationScore: number | null;
  applicationRating: number | null;
}

const gainOf = (pre: number | null, post: number | null) => (pre !== null && post !== null ? Math.round((post - pre) * 100) / 100 : null);

/** §5.4 / §6.2: the outcome of each (program, participant) pair, computed when read (E-09). */
async function outcomesFor(db: Queryable, pairs: ReadonlyArray<{ programId: string; employeeId: string }>): Promise<OutcomeRow[]> {
  if (pairs.length === 0) return [];
  const programIds = [...new Set(pairs.map((pair) => pair.programId))];
  const employeeIds = [...new Set(pairs.map((pair) => pair.employeeId))];
  const programs = await db.query<{ id: string; passingScore: number }>(
    `SELECT id, evaluation_passing_score AS "passingScore" FROM training_programs WHERE id = ANY($1::uuid[])`,
    [programIds],
  );
  const passing = new Map(programs.rows.map((row) => [row.id, row.passingScore]));
  // Plan order, so "the first pre/post test" is stable between requests.
  const components = await db.query<{
    id: string; programId: string; kind: ComponentKind; level: number; weight: number; required: boolean; title: string;
    respondent: Respondent; instrumentKind: InstrumentKind; items: Item[];
  }>(
    `SELECT id, program_id AS "programId", kind, level, weight, required, title, respondent, instrument_kind AS "instrumentKind", items
       FROM training_evaluation_components WHERE program_id = ANY($1::uuid[]) AND status = 'ACTIVE'
      ORDER BY level ASC, created_at ASC, id ASC`,
    [programIds],
  );
  const componentIds = components.rows.map((row) => row.id);
  const byProgram = new Map<string, typeof components.rows>();
  for (const component of components.rows) byProgram.set(component.programId, [...(byProgram.get(component.programId) ?? []), component]);
  // Grouped once by component and person, so each pair reads its own rows directly.
  const finishedStages = new Map<string, Set<Stage>>();
  const responsesOf = new Map<string, Array<{ stage: Stage; score: number | null; answers: Answers }>>();
  if (componentIds.length > 0) {
    const completions = await db.query<{ componentId: string; stage: Stage; subjectEmployeeId: string | null; respondentEmployeeId: string | null }>(
      `SELECT component_id AS "componentId", stage, subject_employee_id AS "subjectEmployeeId", respondent_employee_id AS "respondentEmployeeId"
         FROM training_evaluation_completions
        WHERE component_id = ANY($1::uuid[])
          AND (subject_employee_id = ANY($2::uuid[]) OR respondent_employee_id = ANY($2::uuid[]))`,
      [componentIds, employeeIds],
    );
    const mark = (key: string, stage: Stage) => finishedStages.set(key, (finishedStages.get(key) ?? new Set<Stage>()).add(stage));
    for (const row of completions.rows) {
      if (row.subjectEmployeeId) mark(`${row.componentId}:${row.subjectEmployeeId}:subject`, row.stage);
      if (row.respondentEmployeeId) mark(`${row.componentId}:${row.respondentEmployeeId}:respondent`, row.stage);
    }
    const responses = await db.query<{ componentId: string; stage: Stage; subjectEmployeeId: string; score: string | null; answers: Answers }>(
      `SELECT component_id AS "componentId", stage, subject_employee_id AS "subjectEmployeeId", score, answers
         FROM training_evaluation_responses
        WHERE component_id = ANY($1::uuid[]) AND NOT anonymous AND subject_employee_id = ANY($2::uuid[])`,
      [componentIds, employeeIds],
    );
    for (const row of responses.rows) {
      const key = `${row.componentId}:${row.subjectEmployeeId}`;
      responsesOf.set(key, [...(responsesOf.get(key) ?? []), { stage: row.stage, score: row.score === null ? null : Number(row.score), answers: row.answers }]);
    }
  }
  return pairs.map((pair) => {
    const own = byProgram.get(pair.programId) ?? [];
    const done = new Set<string>();
    const scores = new Map<string, number>();
    const prePost: PrePost[] = [];
    const applicationScores: number[] = [];
    const applicationRatings: number[] = [];
    for (const component of own) {
      // A participant's own answers are found by respondent (anonymous ones have no subject).
      const side = component.respondent === "PARTICIPANT" ? "respondent" : "subject";
      const stages = finishedStages.get(`${component.id}:${pair.employeeId}:${side}`);
      if (stages?.has(component.kind === "PRE_POST_TEST" ? "POST" : "SINGLE")) done.add(component.id);
      const responses = responsesOf.get(`${component.id}:${pair.employeeId}`) ?? [];
      if (component.kind === "PRE_POST_TEST") {
        const pre = responses.find((row) => row.stage === "PRE")?.score ?? null;
        const post = responses.find((row) => row.stage === "POST")?.score ?? null;
        prePost.push({ componentId: component.id, title: component.title, pre, post, gain: gainOf(pre, post) });
      }
      for (const response of responses) {
        if (response.score !== null && (response.stage === "SINGLE" || response.stage === "POST")) {
          if (component.level <= 2) scores.set(component.id, response.score);
          if (component.level === 3 && component.instrumentKind === "RUBRIC") applicationScores.push(response.score);
        }
        if (component.level === 3 && component.instrumentKind === "FORM") {
          const rating = scaleMean(component.items, response.answers);
          if (rating !== null) applicationRatings.push(rating);
        }
      }
    }
    const outcome = computeOutcome({ components: own, done, scores, passingScore: passing.get(pair.programId) ?? 75 });
    const first = prePost[0];
    return {
      programId: pair.programId,
      employeeId: pair.employeeId,
      pre: first?.pre ?? null,
      post: first?.post ?? null,
      gain: first?.gain ?? null,
      prePost,
      scores: Object.fromEntries(own.filter((component) => component.weight > 0).map((component) => [component.id, scores.get(component.id) ?? null])),
      finalScore: outcome.finalScore,
      status: outcome.status,
      applicationScore: mean(applicationScores),
      applicationRating: mean(applicationRatings),
    };
  });
}

// ----------------------------------------------------------------- routes

export function registerTrainingEvaluationRoutes(app: FastifyInstance, kit: TrainingRouteKit) {
  const { pool, requireEmployee, requirePermission, handle, transact, invalid, canManage } = kit;

  async function hcActor(db: Queryable, principal: AuthPrincipal): Promise<Actor> {
    const account = await db.query<{ employeeId: string | null }>(`SELECT employee_id AS "employeeId" FROM accounts WHERE id = $1`, [principal.id]);
    return { kind: "HC", accountId: principal.id, employeeId: account.rows[0]?.employeeId ?? null };
  }

  // ---------------------------------------------------------------- employee

  app.get("/training/me/evaluation/tasks", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const query = pageQuerySchema.safeParse(request.query);
    if (!query.success) return invalid(reply, "INVALID_TRAINING_FILTER", "Filter tidak valid.");
    return handle(reply, async () => {
      const self = await loadSelf(pool, principal.id);
      // §5.3 in SQL so the page is cut after every rule: open window, stage, not yet answered.
      const result = await pool.query<{ total: number }>(
        `WITH tasks AS (
           SELECT component.id AS "componentId", component.title, component.kind, component.level, component.anonymous,
                  stage.value AS stage, program.id AS "programId", program.title AS "programTitle",
                  NULL::uuid AS "subjectEmployeeId", NULL::text AS "subjectName", 'PARTICIPANT' AS "as",
                  component.closes_at AS "closesAt"
             FROM training_evaluation_components component
             JOIN training_programs program ON program.id = component.program_id AND program.status <> 'CANCELLED'
             JOIN training_participants participant
               ON participant.program_id = program.id AND participant.employee_id = $1 AND participant.status <> 'WITHDRAWN'
             CROSS JOIN LATERAL unnest(CASE WHEN component.kind = 'PRE_POST_TEST' THEN ARRAY['PRE', 'POST'] ELSE ARRAY['SINGLE'] END) AS stage(value)
            WHERE component.status = 'ACTIVE' AND component.respondent = 'PARTICIPANT'
              AND (component.opens_at IS NULL OR component.opens_at <= now())
              AND (component.closes_at IS NULL OR component.closes_at > now())
              AND NOT EXISTS (SELECT 1 FROM training_evaluation_completions done
                               WHERE done.component_id = component.id AND done.respondent_employee_id = $1
                                 AND (done.stage = stage.value OR (stage.value = 'PRE' AND done.stage = 'POST')))
              AND (stage.value <> 'POST' OR program.status = 'COMPLETED'
                   OR COALESCE((SELECT max(session.start_at) FROM training_sessions session
                                 WHERE session.program_id = program.id AND session.status = 'SCHEDULED'), '-infinity') <= now())
           UNION ALL
           SELECT component.id, component.title, component.kind, component.level, component.anonymous,
                  'SINGLE', program.id, program.title, subject.id, subject.full_name, 'SUPERVISOR', component.closes_at
             FROM training_evaluation_assessors assessor
             JOIN training_evaluation_components component ON component.id = assessor.component_id
             JOIN training_programs program ON program.id = component.program_id AND program.status <> 'CANCELLED'
             JOIN training_participants participant
               ON participant.program_id = program.id AND participant.employee_id = assessor.subject_employee_id
              AND participant.status <> 'WITHDRAWN'
             JOIN employees subject ON subject.id = assessor.subject_employee_id
            WHERE assessor.assessor_employee_id = $1 AND component.status = 'ACTIVE'
              AND (component.opens_at IS NULL OR component.opens_at <= now())
              AND (component.closes_at IS NULL OR component.closes_at > now())
              AND NOT EXISTS (SELECT 1 FROM training_evaluation_completions done
                               WHERE done.component_id = component.id AND done.subject_employee_id = assessor.subject_employee_id
                                 AND done.respondent_employee_id = $1)
         )
         SELECT *, count(*) OVER ()::int AS total FROM tasks
          ORDER BY "closesAt" ASC NULLS LAST, "programTitle" ASC, title ASC, stage DESC, "subjectName" ASC NULLS FIRST, "componentId"
          LIMIT $2 OFFSET $3`,
        [self.id, query.data.pageSize, pageOffset(query.data)],
      );
      return send(reply, 200, { items: rows(result), pagination: pagination(query.data, result.rows[0]?.total ?? 0) });
    });
  });

  app.get("/training/me/evaluation/components/:id/form", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    const query = formQuery.safeParse(request.query);
    if (!params.success || !query.success) return invalid(reply, "INVALID_TRAINING_EVALUATION", "Evaluasi tidak valid.");
    return handle(reply, async () => {
      const self = await loadSelf(pool, principal.id);
      const component = await loadComponent(pool, params.data.id);
      const actor: Actor = { kind: "EMPLOYEE", accountId: principal.id, employeeId: self.id };
      const respondency = await authorizeRespondent(pool, component, actor, query.data.subjectEmployeeId);
      return send(reply, 200, await formFor(pool, component, query.data.stage, respondency));
    });
  });

  app.post("/training/me/evaluation/components/:id/responses", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    const body = responseBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "INVALID_TRAINING_RESPONSE", "Jawaban tidak valid.");
    return transact(reply, async (client) => {
      const self = await loadSelf(client, principal.id);
      return submitResponse(client, {
        componentId: params.data.id, actor: { kind: "EMPLOYEE", accountId: principal.id, employeeId: self.id },
        stage: body.data.stage, subjectEmployeeId: body.data.subjectEmployeeId, answers: body.data.answers,
      });
    });
  });

  async function employeeOutcomes(employeeId: string, query: z.infer<typeof pageQuerySchema>) {
    const programs = await pool.query<{ programId: string; title: string; status: string; participantStatus: string; total: number }>(
      `SELECT program.id AS "programId", program.title, program.status, participant.status AS "participantStatus",
              count(*) OVER ()::int AS total
         FROM training_participants participant
         JOIN training_programs program ON program.id = participant.program_id
        WHERE participant.employee_id = $1 AND participant.status <> 'WITHDRAWN' AND program.status <> 'CANCELLED'
          AND EXISTS (SELECT 1 FROM training_evaluation_components component
                       WHERE component.program_id = program.id AND component.status = 'ACTIVE')
        ORDER BY program.created_at DESC, program.id DESC
        LIMIT $2 OFFSET $3`,
      [employeeId, query.pageSize, pageOffset(query)],
    );
    const outcomes = await outcomesFor(pool, programs.rows.map((row) => ({ programId: row.programId, employeeId })));
    return {
      items: programs.rows.map(({ total, ...row }, position) => {
        void total;
        const { programId, employeeId: _employee, ...outcome } = outcomes[position]!;
        void programId; void _employee;
        return { ...row, ...outcome };
      }),
      pagination: pagination(query, programs.rows[0]?.total ?? 0),
    };
  }

  app.get("/training/me/evaluation/results", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const query = pageQuerySchema.safeParse(request.query);
    if (!query.success) return invalid(reply, "INVALID_TRAINING_FILTER", "Filter tidak valid.");
    return handle(reply, async () => {
      const self = await loadSelf(pool, principal.id);
      return send(reply, 200, await employeeOutcomes(self.id, query.data));
    });
  });

  // ---------------------------------------------------------------- HC: instruments

  app.get("/admin/training/instruments", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.read");
    if (!principal) return;
    const query = instrumentListQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, "INVALID_TRAINING_FILTER", "Filter tidak valid.");
    const q = query.data.q ? `%${query.data.q}%` : null;
    const result = await pool.query<{ total: number }>(
      `SELECT instrument.id, instrument.kind, instrument.title, instrument.description, instrument.is_system AS "isSystem",
              instrument.status, jsonb_array_length(instrument.items)::int AS "itemCount", instrument.created_at AS "createdAt",
              instrument.updated_at AS "updatedAt",
              (SELECT count(*)::int FROM training_evaluation_components component WHERE component.instrument_id = instrument.id) AS "usedBy",
              count(*) OVER ()::int AS total
         FROM training_instruments instrument
        WHERE ($1::text IS NULL OR instrument.kind = $1) AND ($2::text IS NULL OR instrument.status = $2)
          AND ($3::text IS NULL OR instrument.title ILIKE $3)
        ORDER BY instrument.is_system DESC, instrument.created_at DESC, instrument.id DESC
        LIMIT $4 OFFSET $5`,
      [query.data.kind ?? null, query.data.status ?? null, q, query.data.pageSize, pageOffset(query.data)],
    );
    return send(reply, 200, { items: rows(result), pagination: pagination(query.data, result.rows[0]?.total ?? 0) });
  });

  app.post("/admin/training/instruments", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.manage");
    if (!principal) return;
    const body = instrumentBody.safeParse(request.body);
    if (!body.success) return invalid(reply, "INVALID_TRAINING_INSTRUMENT", "Jenis, judul, atau butir instrumen tidak valid.");
    return transact(reply, async (client) => {
      const items = normalizeItems(body.data.kind, body.data.items);
      const id = randomUUID();
      await client.query(
        `INSERT INTO training_instruments (id, kind, title, description, items, created_by_account_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [id, body.data.kind, body.data.title, body.data.description || null, JSON.stringify(items), principal.id],
      );
      await audit(client, {
        eventType: "training.instrument.created", actorAccountId: principal.id,
        metadata: { instrumentId: id, kind: body.data.kind, itemCount: items.length },
      });
      return [201, { id, kind: body.data.kind, itemCount: items.length }];
    });
  });

  app.get("/admin/training/instruments/:id", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.read");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_TRAINING_INSTRUMENT_ID", "Instrumen tidak valid.");
    return handle(reply, async () => {
      const result = await pool.query(
        `SELECT id, kind, title, description, items, is_system AS "isSystem", status, created_at AS "createdAt", updated_at AS "updatedAt"
           FROM training_instruments WHERE id = $1`,
        [params.data.id],
      );
      const instrument = result.rows[0] as { items: Item[] } | undefined;
      if (!instrument) throw instrumentNotFound();
      // Keys only for those who write tests; a read-only holder may be a participant too.
      return send(reply, 200, (await canManage(principal)) ? instrument : { ...instrument, items: publicItems(instrument.items) });
    });
  });

  async function lockInstrument(client: PoolClient, id: string) {
    const found = await client.query<{ kind: InstrumentKind; isSystem: boolean; status: string }>(
      `SELECT kind, is_system AS "isSystem", status FROM training_instruments WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const instrument = found.rows[0];
    if (!instrument) throw instrumentNotFound();
    if (instrument.isSystem) throw new TrainingError(409, "TRAINING_INSTRUMENT_SYSTEM", "Instrumen standar dari sistem tidak dapat diubah.");
    return instrument;
  }

  app.patch("/admin/training/instruments/:id", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    const body = instrumentPatch.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "INVALID_TRAINING_INSTRUMENT", "Perubahan instrumen tidak valid.");
    return transact(reply, async (client) => {
      const instrument = await lockInstrument(client, params.data.id);
      if (instrument.status !== "ACTIVE") throw new TrainingError(409, "TRAINING_INSTRUMENT_ARCHIVED", "Instrumen sudah diarsipkan.");
      // E-03: components keep their own copy, so editing never changes an existing plan or score.
      const items = body.data.items ? normalizeItems(instrument.kind, body.data.items) : null;
      await client.query(
        `UPDATE training_instruments
            SET title = COALESCE($2, title),
                description = CASE WHEN $3::boolean THEN $4 ELSE description END,
                items = COALESCE($5::jsonb, items), updated_at = now()
          WHERE id = $1`,
        [params.data.id, body.data.title ?? null, body.data.description !== undefined, body.data.description || null,
          items ? JSON.stringify(items) : null],
      );
      await audit(client, {
        eventType: "training.instrument.updated", actorAccountId: principal.id,
        metadata: { instrumentId: params.data.id, fields: Object.keys(body.data), itemCount: items?.length ?? null },
      });
      return [200, { id: params.data.id }];
    });
  });

  app.post("/admin/training/instruments/:id/archive", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_TRAINING_INSTRUMENT_ID", "Instrumen tidak valid.");
    return transact(reply, async (client) => {
      const instrument = await lockInstrument(client, params.data.id);
      if (instrument.status === "ARCHIVED") return [200, { id: params.data.id, status: "ARCHIVED" }];
      await client.query(`UPDATE training_instruments SET status = 'ARCHIVED', updated_at = now() WHERE id = $1`, [params.data.id]);
      await audit(client, { eventType: "training.instrument.archived", actorAccountId: principal.id, metadata: { instrumentId: params.data.id } });
      return [200, { id: params.data.id, status: "ARCHIVED" }];
    });
  });

  // ---------------------------------------------------------------- HC: plan

  app.patch("/admin/training/programs/:id/evaluation", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    const body = planBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "INVALID_TRAINING_PLAN", "Nilai minimal lulus 0 sampai 100.");
    return transact(reply, async (client) => {
      const found = await client.query<{ status: string; passingScore: number }>(
        `SELECT status, evaluation_passing_score AS "passingScore" FROM training_programs WHERE id = $1 FOR UPDATE`,
        [params.data.id],
      );
      const program = found.rows[0];
      if (!program) throw programNotFound();
      if (program.status === "CANCELLED") throw new TrainingError(409, "TRAINING_PROGRAM_CLOSED", "Program sudah dibatalkan.");
      await client.query(
        `UPDATE training_programs SET evaluation_passing_score = $2, updated_at = now() WHERE id = $1`,
        [params.data.id, body.data.passingScore],
      );
      await audit(client, {
        eventType: "training.evaluation.plan.updated", programId: params.data.id, actorAccountId: principal.id,
        metadata: { from: program.passingScore, to: body.data.passingScore },
      });
      return [200, { id: params.data.id, passingScore: body.data.passingScore }];
    });
  });

  app.get("/admin/training/programs/:id/evaluation/components", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.read");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_TRAINING_PROGRAM_ID", "Program pelatihan tidak valid.");
    return handle(reply, async () => {
      const program = await pool.query<{ passingScore: number }>(
        `SELECT evaluation_passing_score AS "passingScore" FROM training_programs WHERE id = $1`,
        [params.data.id],
      );
      if (!program.rows[0]) throw programNotFound();
      // E-18 bounds active components to 20; archived ones are listed too, capped at 100 (ENG-LIST-001 bounded).
      const result = await pool.query(
        `SELECT component.id, component.kind, component.level, component.respondent, component.title,
                component.instrument_id AS "instrumentId", component.instrument_kind AS "instrumentKind", component.items,
                component.anonymous, component.weight, component.required, component.opens_at AS "opensAt",
                component.closes_at AS "closesAt", component.status, component.archive_reason AS "archiveReason",
                component.created_at AS "createdAt",
                (SELECT count(*)::int FROM training_evaluation_completions done WHERE done.component_id = component.id) AS "responseCount",
                (SELECT count(*)::int FROM training_evaluation_assessors assessor
                  WHERE assessor.component_id = component.id AND assessor.assessor_employee_id IS NULL) AS "unassignedCount"
           FROM training_evaluation_components component
          WHERE component.program_id = $1
          ORDER BY (component.status = 'ACTIVE') DESC, component.level ASC, component.created_at ASC, component.id ASC
          LIMIT 100`,
        [params.data.id],
      );
      const withKeys = await canManage(principal);
      return send(reply, 200, {
        passingScore: program.rows[0].passingScore,
        items: withKeys ? result.rows : result.rows.map((row: { items: Item[] }) => ({ ...row, items: publicItems(row.items) })),
      });
    });
  });

  app.post("/admin/training/programs/:id/evaluation/components", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    const body = componentBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "INVALID_TRAINING_COMPONENT", "Komponen evaluasi tidak valid.");
    return transact(reply, async (client) => {
      const found = await client.query<{ title: string; status: string }>(
        `SELECT title, status FROM training_programs WHERE id = $1 FOR UPDATE`,
        [params.data.id],
      );
      const program = found.rows[0];
      if (!program) throw programNotFound();
      if (program.status === "CANCELLED") throw new TrainingError(409, "TRAINING_PROGRAM_CLOSED", "Program sudah dibatalkan.");
      const instrument = (await client.query<{ kind: InstrumentKind; title: string; items: Item[]; status: string }>(
        `SELECT kind, title, items, status FROM training_instruments WHERE id = $1`,
        [body.data.instrumentId],
      )).rows[0];
      if (!instrument) throw instrumentNotFound();
      if (instrument.status !== "ACTIVE" || instrument.kind !== INSTRUMENT_FOR_COMPONENT[body.data.kind]) {
        throw new TrainingError(409, "TRAINING_INSTRUMENT_MISMATCH", "Instrumen tidak aktif atau jenisnya tidak cocok dengan komponen.");
      }
      const resolved = resolveComponent({ ...body.data, instrumentKind: instrument.kind });
      if (body.data.opensAt && body.data.closesAt && Date.parse(body.data.closesAt) <= Date.parse(body.data.opensAt)) {
        throw new TrainingError(400, "INVALID_TRAINING_COMPONENT", "Waktu tutup harus sesudah waktu buka.");
      }
      const active = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM training_evaluation_components WHERE program_id = $1 AND status = 'ACTIVE'`,
        [params.data.id],
      );
      if ((active.rows[0]?.count ?? 0) >= MAX_ACTIVE_COMPONENTS) {
        throw new TrainingError(409, "TRAINING_COMPONENT_LIMIT", `Paling banyak ${MAX_ACTIVE_COMPONENTS} komponen aktif per program.`);
      }
      const id = randomUUID();
      const title = body.data.title ?? instrument.title;
      await client.query(
        `INSERT INTO training_evaluation_components
           (id, program_id, kind, level, respondent, title, instrument_id, instrument_kind, items, anonymous, weight,
            required, opens_at, closes_at, created_by_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15)`,
        [id, params.data.id, body.data.kind, resolved.level, resolved.respondent, title, body.data.instrumentId, instrument.kind,
          JSON.stringify(instrument.items), resolved.anonymous, resolved.weight, body.data.required ?? true,
          body.data.opensAt ?? null, body.data.closesAt ?? null, principal.id],
      );
      await audit(client, {
        eventType: "training.evaluation.component.created", programId: params.data.id, actorAccountId: principal.id,
        metadata: { componentId: id, kind: body.data.kind, level: resolved.level, respondent: resolved.respondent, weight: resolved.weight },
      });
      const participants = (await client.query<{ employeeId: string }>(
        `SELECT employee_id AS "employeeId" FROM training_participants WHERE program_id = $1 AND status <> 'WITHDRAWN' ORDER BY employee_id`,
        [params.data.id],
      )).rows.map((row) => row.employeeId);
      if (resolved.respondent === "SUPERVISOR") {
        await assignSupervisorAssessors(client, { programId: params.data.id, employeeIds: participants, actorAccountId: principal.id, componentId: id });
      }
      if (resolved.respondent === "PARTICIPANT") {
        for (const employeeId of participants) {
          await notifyEmployee(client, employeeId, {
            eventKey: `training.evaluation.${id}.${employeeId}`, category: "system", title: "Evaluasi pelatihan perlu diisi",
            body: `${title} untuk program ${program.title}.`, href: "/app/training?tab=evaluasi", actorAccountId: principal.id,
          });
        }
      }
      return [201, { id, ...resolved }];
    });
  });

  app.patch("/admin/training/evaluation/components/:id", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    const body = componentPatch.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "INVALID_TRAINING_COMPONENT", "Perubahan komponen tidak valid.");
    return transact(reply, async (client) => {
      const component = await loadComponent(client, params.data.id, true);
      if (component.status !== "ACTIVE") throw new TrainingError(409, "TRAINING_COMPONENT_ARCHIVED", "Komponen sudah diarsipkan.");
      if (body.data.weight !== undefined && body.data.weight !== component.weight) {
        resolveComponent({ kind: component.kind, instrumentKind: component.instrumentKind, level: component.level,
          respondent: component.respondent, anonymous: component.anonymous, weight: body.data.weight });
        const answered = await client.query(`SELECT 1 FROM training_evaluation_completions WHERE component_id = $1 LIMIT 1`, [component.id]);
        if (answered.rows[0]) throw new TrainingError(409, "TRAINING_COMPONENT_LOCKED", "Bobot terkunci setelah ada respons.");
      }
      const opensAt = body.data.opensAt === undefined ? component.opensAt?.toISOString() ?? null : body.data.opensAt;
      const closesAt = body.data.closesAt === undefined ? component.closesAt?.toISOString() ?? null : body.data.closesAt;
      if (opensAt && closesAt && Date.parse(closesAt) <= Date.parse(opensAt)) {
        throw new TrainingError(400, "INVALID_TRAINING_COMPONENT", "Waktu tutup harus sesudah waktu buka.");
      }
      await client.query(
        `UPDATE training_evaluation_components
            SET title = COALESCE($2, title), weight = COALESCE($3, weight), required = COALESCE($4, required),
                opens_at = $5, closes_at = $6, updated_at = now()
          WHERE id = $1`,
        [component.id, body.data.title ?? null, body.data.weight ?? null, body.data.required ?? null, opensAt, closesAt],
      );
      await audit(client, {
        eventType: "training.evaluation.component.updated", programId: component.programId, actorAccountId: principal.id,
        metadata: { componentId: component.id, fields: Object.keys(body.data) },
      });
      return [200, { id: component.id }];
    });
  });

  app.post("/admin/training/evaluation/components/:id/archive", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    const body = reasonBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "INVALID_TRAINING_REASON", "Alasan 5 sampai 500 huruf.");
    return transact(reply, async (client) => {
      const component = await loadComponent(client, params.data.id, true);
      if (component.status !== "ACTIVE") throw new TrainingError(409, "TRAINING_COMPONENT_ARCHIVED", "Komponen sudah diarsipkan.");
      await client.query(
        `UPDATE training_evaluation_components SET status = 'ARCHIVED', archive_reason = $2, updated_at = now() WHERE id = $1`,
        [component.id, body.data.reason],
      );
      await audit(client, {
        eventType: "training.evaluation.component.archived", programId: component.programId, actorAccountId: principal.id,
        note: body.data.reason, metadata: { componentId: component.id },
      });
      return [200, { id: component.id, status: "ARCHIVED" }];
    });
  });

  // ---------------------------------------------------------------- HC: assessors

  app.get("/admin/training/evaluation/components/:id/assessors", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.read");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    const query = pageQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return invalid(reply, "INVALID_TRAINING_FILTER", "Filter tidak valid.");
    return handle(reply, async () => {
      const component = await loadComponent(pool, params.data.id);
      const result = await pool.query<{ total: number }>(
        `SELECT participant.employee_id AS "subjectEmployeeId", subject.full_name AS "subjectName",
                subject.employee_number AS "subjectNumber", assessor.assessor_employee_id AS "assessorEmployeeId",
                rater.full_name AS "assessorName", COALESCE(assessor.source, 'UNRESOLVED') AS source,
                EXISTS (SELECT 1 FROM training_evaluation_completions done
                         WHERE done.component_id = $1 AND done.subject_employee_id = participant.employee_id) AS answered,
                count(*) OVER ()::int AS total
           FROM training_participants participant
           JOIN employees subject ON subject.id = participant.employee_id
           LEFT JOIN training_evaluation_assessors assessor
             ON assessor.component_id = $1 AND assessor.subject_employee_id = participant.employee_id
           LEFT JOIN employees rater ON rater.id = assessor.assessor_employee_id
          WHERE participant.program_id = $2 AND participant.status <> 'WITHDRAWN'
          ORDER BY subject.full_name ASC, participant.employee_id ASC
          LIMIT $3 OFFSET $4`,
        [component.id, component.programId, query.data.pageSize, pageOffset(query.data)],
      );
      return send(reply, 200, {
        respondent: component.respondent,
        items: rows(result),
        pagination: pagination(query.data, result.rows[0]?.total ?? 0),
      });
    });
  });

  app.put("/admin/training/evaluation/components/:id/assessors", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    const body = assessorBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "INVALID_TRAINING_ASSESSORS", "Penilai tidak valid.");
    return transact(reply, async (client) => {
      const component = await loadComponent(client, params.data.id, true);
      if (component.status !== "ACTIVE" || component.respondent !== "SUPERVISOR") {
        throw new TrainingError(409, "TRAINING_COMPONENT_NOT_SUPERVISOR", "Penilai hanya untuk komponen aktif yang diisi atasan.");
      }
      for (const entry of body.data.entries) {
        if (entry.assessorEmployeeId === entry.subjectEmployeeId) {
          throw new TrainingError(409, "TRAINING_ASSESSOR_SELF", "Peserta tidak dapat menilai dirinya sendiri.");
        }
        const status = await participantStatus(client, component.programId, entry.subjectEmployeeId);
        if (!status || status === "WITHDRAWN") throw new TrainingError(404, "TRAINING_PARTICIPANT_NOT_FOUND", "Peserta tidak ditemukan.");
        const active = await client.query(
          `SELECT 1 FROM employees WHERE id = $1 AND status = 'active' AND removed_at IS NULL`,
          [entry.assessorEmployeeId],
        );
        if (!active.rows[0]) throw new TrainingError(409, "TRAINING_EMPLOYEE_NOT_ACTIVE", "Penilai harus pegawai aktif.");
        const answered = await client.query(
          `SELECT 1 FROM training_evaluation_completions WHERE component_id = $1 AND subject_employee_id = $2`,
          [component.id, entry.subjectEmployeeId],
        );
        if (answered.rows[0]) throw new TrainingError(409, "TRAINING_RESPONSE_EXISTS", "Penilaian peserta ini sudah diisi.");
        await client.query(
          `INSERT INTO training_evaluation_assessors
             (component_id, subject_employee_id, assessor_employee_id, source, resolution, assigned_by_account_id, updated_at)
           VALUES ($1, $2, $3, 'HC_ASSIGNED', '{}'::jsonb, $4, now())
           ON CONFLICT (component_id, subject_employee_id) DO UPDATE
             SET assessor_employee_id = EXCLUDED.assessor_employee_id, source = 'HC_ASSIGNED',
                 assigned_by_account_id = EXCLUDED.assigned_by_account_id, updated_at = now()`,
          [component.id, entry.subjectEmployeeId, entry.assessorEmployeeId, principal.id],
        );
        await audit(client, {
          eventType: "training.evaluation.assessor.assigned", programId: component.programId, employeeId: entry.subjectEmployeeId,
          actorAccountId: principal.id, metadata: { componentId: component.id, assessorEmployeeId: entry.assessorEmployeeId },
        });
        await notifyEmployee(client, entry.assessorEmployeeId, {
          eventKey: `training.evaluation.${component.id}.${entry.assessorEmployeeId}.${entry.subjectEmployeeId}`, category: "system",
          title: "Penilaian penerapan pelatihan", body: `Anda diminta menilai peserta pada evaluasi ${component.title}.`,
          href: "/app/training?tab=evaluasi", actorAccountId: principal.id,
        });
      }
      return [200, { assigned: body.data.entries.length }];
    });
  });

  // ---------------------------------------------------------------- HC: answering

  app.get("/admin/training/evaluation/components/:id/form", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    const query = formQuery.safeParse(request.query);
    if (!params.success || !query.success) return invalid(reply, "INVALID_TRAINING_EVALUATION", "Evaluasi tidak valid.");
    return handle(reply, async () => {
      const component = await loadComponent(pool, params.data.id);
      const respondency = await authorizeRespondent(pool, component, await hcActor(pool, principal), query.data.subjectEmployeeId);
      return send(reply, 200, await formFor(pool, component, query.data.stage, respondency));
    });
  });

  app.post("/admin/training/evaluation/components/:id/responses", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    const body = responseBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "INVALID_TRAINING_RESPONSE", "Jawaban tidak valid.");
    return transact(reply, async (client) => submitResponse(client, {
      componentId: params.data.id, actor: await hcActor(client, principal), stage: body.data.stage,
      subjectEmployeeId: body.data.subjectEmployeeId, answers: body.data.answers,
    }));
  });

  // ---------------------------------------------------------------- HC: recap

  app.get("/admin/training/evaluation/components/:id/comments", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.read");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    const query = pageQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return invalid(reply, "INVALID_TRAINING_FILTER", "Filter tidak valid.");
    return handle(reply, async () => {
      const component = await loadComponent(pool, params.data.id);
      const textItems = component.items.filter((item) => item.type === "TEXT").map((item) => item.id);
      const count = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM training_evaluation_responses WHERE component_id = $1`,
        [component.id],
      );
      const responses = count.rows[0]?.count ?? 0;
      // E-11: anonymous comments only once the component has closed with enough answers, so neither
      // a lone answer nor the difference between two reads can single anyone out.
      if (component.anonymous && !anonymousAggregatesVisible({
        responses, status: component.status, programStatus: component.programStatus, closesAt: component.closesAt, nowMs: Date.now(),
      })) {
        return send(reply, 200, {
          hidden: true, threshold: ANONYMOUS_COMMENT_THRESHOLD, items: [], pagination: pagination(query.data, 0),
        });
      }
      const result = await pool.query<{ total: number }>(
        `SELECT item.key AS "itemId", item.value #>> '{}' AS text,
                ${component.anonymous ? "NULL::text" : "subject.full_name"} AS "subjectName",
                response.submitted_on AS "submittedOn", count(*) OVER ()::int AS total
           FROM training_evaluation_responses response
           CROSS JOIN LATERAL jsonb_each(response.answers) AS item(key, value)
           LEFT JOIN employees subject ON subject.id = response.subject_employee_id
          WHERE response.component_id = $1 AND item.key = ANY($2::text[]) AND jsonb_typeof(item.value) = 'string'
          ORDER BY ${component.anonymous ? "md5(response.id::text || item.key)" : "response.submitted_at DESC, response.id"}
          LIMIT $3 OFFSET $4`,
        [component.id, textItems, query.data.pageSize, pageOffset(query.data)],
      );
      return send(reply, 200, { hidden: false, items: rows(result), pagination: pagination(query.data, result.rows[0]?.total ?? 0) });
    });
  });

  app.get("/admin/training/programs/:id/evaluation/summary", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.read");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_TRAINING_PROGRAM_ID", "Program pelatihan tidak valid.");
    return handle(reply, async () => {
      const program = await pool.query<{ passingScore: number; status: string }>(
        `SELECT evaluation_passing_score AS "passingScore", status FROM training_programs WHERE id = $1`,
        [params.data.id],
      );
      if (!program.rows[0]) throw programNotFound();
      const programStatus = program.rows[0].status;
      const participants = (await pool.query<{ employeeId: string }>(
        `SELECT employee_id AS "employeeId" FROM training_participants WHERE program_id = $1 AND status <> 'WITHDRAWN'`,
        [params.data.id],
      )).rows.map((row) => row.employeeId);
      const components = await pool.query<{
        id: string; kind: ComponentKind; level: number; respondent: Respondent; title: string; instrumentKind: InstrumentKind;
        items: Item[]; anonymous: boolean; weight: number; status: string; closesAt: Date | null;
      }>(
        `SELECT id, kind, level, respondent, title, instrument_kind AS "instrumentKind", items, anonymous, weight, status,
                closes_at AS "closesAt"
           FROM training_evaluation_components WHERE program_id = $1 AND status = 'ACTIVE'
          ORDER BY level ASC, created_at ASC, id ASC`,
        [params.data.id],
      );
      // Aggregate over every response of at most 20 components; bounded by the program's participants.
      const responses = components.rows.length === 0 ? [] : (await pool.query<{
        componentId: string; stage: Stage; subjectEmployeeId: string | null; score: string | null; answers: Answers;
      }>(
        `SELECT component_id AS "componentId", stage, subject_employee_id AS "subjectEmployeeId", score, answers
           FROM training_evaluation_responses WHERE component_id = ANY($1::uuid[])`,
        [components.rows.map((row) => row.id)],
      )).rows;
      const assessors = await pool.query<{ componentId: string; count: number }>(
        `SELECT assessor.component_id AS "componentId", count(*)::int AS count
           FROM training_evaluation_assessors assessor
           JOIN training_participants participant
             ON participant.program_id = $1 AND participant.employee_id = assessor.subject_employee_id AND participant.status <> 'WITHDRAWN'
          GROUP BY assessor.component_id`,
        [params.data.id],
      );
      const current = new Set(participants);
      const items = components.rows.map((component) => {
        // Named answers of withdrawn participants stay stored but leave the aggregates, as in the results.
        const own = responses.filter((row) => row.componentId === component.id
          && (row.subjectEmployeeId === null || current.has(row.subjectEmployeeId)));
        const expected = component.kind === "RESULT" ? 1
          : component.respondent === "SUPERVISOR" ? assessors.rows.find((row) => row.componentId === component.id)?.count ?? 0
            : participants.length;
        const scoresOf = (stage: Stage) => own.filter((row) => row.stage === stage && row.score !== null).map((row) => Number(row.score));
        const base = {
          id: component.id, kind: component.kind, level: component.level, respondent: component.respondent, title: component.title,
          anonymous: component.anonymous, weight: component.weight, expected,
        };
        if (component.kind === "PRE_POST_TEST") {
          const pre = new Map(own.filter((row) => row.stage === "PRE").map((row) => [row.subjectEmployeeId, Number(row.score)]));
          const gains = own.filter((row) => row.stage === "POST" && pre.has(row.subjectEmployeeId))
            .map((row) => Number(row.score) - pre.get(row.subjectEmployeeId)!);
          return {
            ...base, submittedPre: scoresOf("PRE").length, submitted: scoresOf("POST").length,
            averagePre: mean(scoresOf("PRE")), averagePost: mean(scoresOf("POST")), averageGain: mean(gains), pairs: gains.length,
          };
        }
        const single = own.filter((row) => row.stage === "SINGLE");
        // E-11: anonymous distributions follow the same rule as anonymous comments.
        const hidden = component.anonymous && !anonymousAggregatesVisible({
          responses: single.length, status: component.status, programStatus, closesAt: component.closesAt, nowMs: Date.now(),
        });
        return {
          ...base,
          submitted: single.length,
          hidden,
          averageScore: component.instrumentKind === "FORM" ? null : mean(scoresOf("SINGLE")),
          items: component.instrumentKind === "TEST" || hidden ? undefined : summarizeForm(component.items, single.map((row) => row.answers)),
        };
      });
      return send(reply, 200, { passingScore: program.rows[0].passingScore, participantCount: participants.length, components: items });
    });
  });

  app.get("/admin/training/programs/:id/evaluation/results", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.read");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    const query = pageQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return invalid(reply, "INVALID_TRAINING_FILTER", "Filter tidak valid.");
    return handle(reply, async () => {
      const exists = await pool.query(`SELECT 1 FROM training_programs WHERE id = $1`, [params.data.id]);
      if (!exists.rows[0]) throw programNotFound();
      const participants = await pool.query<{ employeeId: string; fullName: string; employeeNumber: string; participantStatus: string; total: number }>(
        `SELECT participant.employee_id AS "employeeId", employee.full_name AS "fullName", employee.employee_number AS "employeeNumber",
                participant.status AS "participantStatus", count(*) OVER ()::int AS total
           FROM training_participants participant
           JOIN employees employee ON employee.id = participant.employee_id
          WHERE participant.program_id = $1 AND participant.status <> 'WITHDRAWN'
          ORDER BY employee.full_name ASC, participant.employee_id ASC
          LIMIT $2 OFFSET $3`,
        [params.data.id, query.data.pageSize, pageOffset(query.data)],
      );
      const outcomes = await outcomesFor(pool, participants.rows.map((row) => ({ programId: params.data.id, employeeId: row.employeeId })));
      return send(reply, 200, {
        items: participants.rows.map(({ total, ...row }, position) => {
          void total;
          const { programId, employeeId: _employee, ...outcome } = outcomes[position]!;
          void programId; void _employee;
          return { ...row, ...outcome };
        }),
        pagination: pagination(query.data, participants.rows[0]?.total ?? 0),
      });
    });
  });

  app.get("/admin/training/employees/:employeeId/evaluation", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.read");
    if (!principal) return;
    const params = employeeParams.safeParse(request.params);
    const query = pageQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return invalid(reply, "INVALID_TRAINING_FILTER", "Filter tidak valid.");
    return handle(reply, async () => {
      const employee = await pool.query<{ id: string; fullName: string; employeeNumber: string }>(
        `SELECT id, full_name AS "fullName", employee_number AS "employeeNumber" FROM employees WHERE id = $1 AND removed_at IS NULL`,
        [params.data.employeeId],
      );
      if (!employee.rows[0]) throw new TrainingError(404, "EMPLOYEE_NOT_FOUND", "Pegawai tidak ditemukan.");
      return send(reply, 200, { employee: employee.rows[0], ...(await employeeOutcomes(params.data.employeeId, query.data)) });
    });
  });
}
