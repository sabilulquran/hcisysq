// PERF-001 Package 1 acceptance against a real schema.
// Synthetic employees only; every test runs inside one rolled-back transaction.

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import { DEFAULT_RUBRIC, objectionDueOn } from "../src/modules/performance/domain.js";
import { registerPerformanceRoutes } from "../src/modules/performance/routes.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

/** The routes own their transactions; BEGIN/COMMIT/ROLLBACK become savepoints of the test's. */
function savepointPool(client: PoolClient): Pool {
  let depth = 0;
  const run = async (text: string, values?: unknown[]) => {
    const statement = String(text).trim().toUpperCase();
    if (statement.startsWith("BEGIN")) return client.query(`SAVEPOINT test_sp_${++depth}`);
    if (statement.startsWith("COMMIT")) {
      const name = `test_sp_${depth}`;
      depth -= 1;
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    if (statement.startsWith("ROLLBACK")) {
      const name = `test_sp_${depth}`;
      depth -= 1;
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    return client.query(text, values);
  };
  const handle = { query: run, release: () => {} };
  return { query: run, connect: async () => handle } as unknown as Pool;
}

function jakartaToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

/** First and last day of the month `offset` months from today's Jakarta month. */
function month(offset: number) {
  const today = jakartaToday();
  const first = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 + offset, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
  return { start: first.toISOString().slice(0, 10), end: last.toISOString().slice(0, 10) };
}

const all = (score: number) => Object.fromEntries(DEFAULT_RUBRIC.indicators.map((item) => [item.code, score]));
const HC = ["performance.read", "performance.manage"];

describe.skipIf(!allowed)("PERF-001 performance review", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let principal: AuthPrincipal;
  let permissions: string[];
  let unitId: string;
  const people = {} as Record<"hc" | "manager" | "employee" | "other" | "outsider", { employeeId: string; accountId: string }>;

  async function insertEmployee(name: string, unitId: string) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO employees(id, employee_number, full_name, status, started_on, organizational_unit_id)
       VALUES ($1,$2,$3,'active','2020-01-06',$4)`,
      [id, `PERF-${id.slice(0, 8)}`, name, unitId],
    );
    return id;
  }

  async function insertAccount(employeeId: string) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1,$2,$3,'EMPLOYEE','active')`,
      [id, employeeId, `perf-${id}@example.invalid`],
    );
    return id;
  }

  function actAs(who: keyof typeof people, granted: string[] = []) {
    principal = { id: people[who].accountId, email: `${who}@example.invalid`, principalType: "EMPLOYEE" };
    permissions = granted;
  }

  async function createCycle(offset = 0, overrides: Record<string, unknown> = {}) {
    const { start, end } = month(offset);
    actAs("hc", HC);
    return app.inject({
      method: "POST",
      url: "/admin/performance/cycles",
      payload: { name: `Penilaian ${start.slice(0, 7)}`, kind: "MONTHLY", periodStart: start, periodEnd: end, selfDueOn: end, reviewDueOn: end, ...overrides },
    });
  }

  async function openCycleWith(offset: number, who: Array<keyof typeof people>) {
    const created = await createCycle(offset);
    expect(created.statusCode, created.body).toBe(201);
    const cycleId = created.json().id as string;
    const added = await app.inject({
      method: "POST", url: `/admin/performance/cycles/${cycleId}/participants`,
      payload: { employeeIds: who.map((key) => people[key].employeeId) },
    });
    expect(added.statusCode, added.body).toBe(200);
    expect((await app.inject({ method: "POST", url: `/admin/performance/cycles/${cycleId}/open` })).statusCode).toBe(200);
    const reviews = await client.query<{ id: string; employeeId: string }>(
      `SELECT id, employee_id AS "employeeId" FROM performance_reviews WHERE cycle_id = $1`,
      [cycleId],
    );
    const reviewOf = (key: keyof typeof people) => reviews.rows.find((row) => row.employeeId === people[key].employeeId)!.id;
    return { cycleId, reviewOf };
  }

  /**
   * ORG-011: a live employment with one placement carrying a job classification code, which is
   * what D-20 resolves a participant's rubric from. No catalog row is needed: the binding reads
   * the code off the placement.
   */
  async function bindJob(employeeId: string, classificationCode: string) {
    const employmentId = randomUUID();
    const actionId = randomUUID();
    await client.query(
      `INSERT INTO employments(id, employee_id, staff_type, started_on, start_basis, service_start_on, source, opened_by_action_id)
       VALUES ($1, $2, 'PENDIDIK', '2020-01-06'::date, 'RECORDED', '2020-01-06'::date, 'BASELINE_FROM_MASTER', $3)`,
      [employmentId, employeeId, actionId],
    );
    await client.query(
      `INSERT INTO employment_actions(id, employee_id, employment_id, action_type, recorded_at)
       VALUES ($1, $2, $3, 'BASELINE', now())`,
      [actionId, employeeId, employmentId],
    );
    await client.query(
      `INSERT INTO employment_placements
         (id, employment_id, kind, legacy_unit_id, job_title_label, effective_from, effective_from_basis,
          opened_by_action_id, job_classification_code)
       VALUES ($1, $2, 'PRIMARY', $3, 'Jabatan sintetis', '2020-01-06'::date, 'RECORDED', $4, $5)`,
      [randomUUID(), employmentId, unitId, actionId, classificationCode],
    );
  }

  /**
   * D-17: HC may not finalize while the employee could still object. The employee accepting the
   * score closes that window, which is what most of these scenarios want before validating.
   */
  async function waiveObjection(reviewId: string, who: keyof typeof people = "employee") {
    actAs(who);
    return app.inject({ method: "POST", url: `/performance/me/${reviewId}/objection/waive` });
  }

  async function reviewRow(id: string) {
    return (await client.query<{ status: string; predicateCode: string | null; finalScore: string | null; raterEmployeeId: string | null }>(
      `SELECT status, predicate_code AS "predicateCode", final_score AS "finalScore", rater_employee_id AS "raterEmployeeId"
         FROM performance_reviews WHERE id = $1`,
      [id],
    )).rows[0]!;
  }

  async function selfAssess(reviewId: string, scores = all(3)) {
    actAs("employee");
    return app.inject({ method: "POST", url: `/performance/me/${reviewId}/self-assessment`, payload: { scores, note: "Capaian bulan ini" } });
  }

  async function rate(reviewId: string, scores = all(4), who: keyof typeof people = "manager") {
    actAs(who);
    return app.inject({
      method: "POST", url: `/performance/team/${reviewId}/rating`,
      payload: { scores, strengths: "Teliti", improvements: "Laporan tepat waktu", note: null },
    });
  }

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    unitId = randomUUID();
    await client.query(
      "INSERT INTO organizational_units(id, normalized_name, name) VALUES ($1,$2,'Unit Kinerja Sintetis')",
      [unitId, `unit-perf-${unitId}`],
    );
    for (const key of ["hc", "manager", "employee", "other", "outsider"] as const) {
      const employeeId = await insertEmployee(`Pegawai Kinerja ${key}`, unitId);
      people[key] = { employeeId, accountId: await insertAccount(employeeId) };
    }
    await client.query("UPDATE employees SET direct_manager_employee_id = $2 WHERE id = $1", [people.employee.employeeId, people.manager.employeeId]);
    actAs("hc", HC);

    const config = { NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8 } as ApiConfig;
    const auth = {
      getSession: async () => ({ principal, expiresAt: "2099-01-01T00:00:00Z" }),
      getAuthorizationContext: async () => ({ organizationPermissions: permissions }),
    } as never;
    app = Fastify({ logger: false });
    await registerPerformanceRoutes(app, savepointPool(client), config, auth);
  });

  afterEach(async () => {
    try { await app?.close(); } finally {
      if (client) { await client.query("ROLLBACK"); client.release(); }
    }
  });

  it("migration 0121 grants performance.* to human_capital_admin only", async () => {
    const rows = await client.query<{ roleKey: string; permissionKey: string }>(
      `SELECT role.role_key AS "roleKey", grant_.permission_key AS "permissionKey"
         FROM role_permissions grant_ JOIN roles role ON role.id = grant_.role_id
        WHERE grant_.permission_key LIKE 'performance.%'
        ORDER BY grant_.permission_key`,
    );
    expect(rows.rows).toEqual([
      { roleKey: "human_capital_admin", permissionKey: "performance.manage" },
      { roleKey: "human_capital_admin", permissionKey: "performance.read" },
    ]);
  });

  it("PERF-001-A/B/C/D/I: the whole cycle from self-assessment to acknowledgement", async () => {
    const created = await createCycle(0);
    expect(created.statusCode, created.body).toBe(201);
    const cycleId = created.json().id as string;
    const added = await app.inject({
      method: "POST", url: `/admin/performance/cycles/${cycleId}/participants`,
      payload: { employeeIds: [people.employee.employeeId, people.other.employeeId] },
    });
    expect(added.json()).toEqual({ added: 2, readded: 0, alreadyIn: 0, withoutRater: 1, withoutJobRubric: 0 });

    const reviews = await app.inject({ method: "GET", url: `/admin/performance/cycles/${cycleId}/reviews?raterMissing=false` });
    expect(reviews.json().pagination.total).toBe(1);
    const reviewId = reviews.json().items[0].id as string;
    expect(reviews.json().items[0]).toMatchObject({ raterEmployeeId: people.manager.employeeId, raterSource: "DIRECT_MANAGER" });

    // DRAFT cycles are invisible to the employee and refuse their actions.
    actAs("employee");
    expect((await app.inject({ method: "GET", url: "/performance/me" })).json().items).toEqual([]);
    expect((await app.inject({ method: "GET", url: `/performance/me/${reviewId}` })).statusCode).toBe(404);
    const early = await selfAssess(reviewId);
    expect(early.json().code).toBe("PERFORMANCE_CYCLE_NOT_OPEN");

    actAs("hc", HC);
    expect((await app.inject({ method: "POST", url: `/admin/performance/cycles/${cycleId}/open` })).json()).toMatchObject({ status: "OPEN", participants: 2 });
    // PERF-001-B: a later change of manager does not move the snapshotted rater.
    await client.query("UPDATE employees SET direct_manager_employee_id = $2 WHERE id = $1", [people.employee.employeeId, people.outsider.employeeId]);
    expect((await reviewRow(reviewId)).raterEmployeeId).toBe(people.manager.employeeId);

    // PERF-001-C: the rater waits for the self-assessment while its deadline has not passed.
    const tooEarly = await rate(reviewId);
    expect(tooEarly.statusCode).toBe(409);
    expect(tooEarly.json().code).toBe("PERFORMANCE_RATING_NOT_ALLOWED");

    expect((await selfAssess(reviewId, { ...all(3), TASK_RESULT: 5 })).statusCode).toBe(400);
    const self = await selfAssess(reviewId);
    expect(self.statusCode, self.body).toBe(200);
    expect((await selfAssess(reviewId)).json().code).toBe("PERFORMANCE_SELF_NOT_ALLOWED");

    // PERF-001-C: somebody else is not the rater and cannot even see the review.
    actAs("outsider");
    expect((await app.inject({ method: "GET", url: `/performance/team/${reviewId}` })).statusCode).toBe(404);
    expect((await rate(reviewId, all(4), "outsider")).statusCode).toBe(404);
    actAs("other");
    expect((await app.inject({ method: "GET", url: `/performance/me/${reviewId}` })).statusCode).toBe(404);

    actAs("manager");
    const queue = await app.inject({ method: "GET", url: "/performance/team" });
    expect(queue.json().items.map((item: { id: string }) => item.id)).toEqual([reviewId]);
    const teamDetail = await app.inject({ method: "GET", url: `/performance/team/${reviewId}` });
    expect(teamDetail.json().selfAssessment.scores).toEqual(all(3));
    expect(teamDetail.json().allowedActions).toEqual(["rate"]);

    // PERF-001-D: computed by the server; 30×4 + 20×3 + 20×4 + 15×3 + 15×3 = 3.50 → A.
    const rated = await rate(reviewId, { TASK_RESULT: 4, DISCIPLINE: 3, AKHLAK: 4, TEAMWORK: 3, INITIATIVE: 3 });
    expect(rated.json()).toMatchObject({ status: "HC_VALIDATION", finalScore: 3.5, predicateCode: "A" });

    // PERF-001-A, as D-17 amends it: the employee reads the score once it reaches HC, because
    // that is what they may object to, and not one step earlier.
    actAs("employee");
    const pending = await app.inject({ method: "GET", url: `/performance/me/${reviewId}` });
    expect(pending.json()).toMatchObject({ status: "HC_VALIDATION", finalScore: 3.5, predicateCode: "A" });
    expect(pending.json().allowedActions).toEqual(["object", "waive-objection"]);

    // D-17: validation waits while the employee may still object.
    actAs("hc", HC);
    const tooSoon = await app.inject({ method: "POST", url: `/admin/performance/reviews/${reviewId}/finalize` });
    expect(tooSoon.statusCode).toBe(409);
    expect(tooSoon.json().code).toBe("PERFORMANCE_OBJECTION_WINDOW_OPEN");
    expect((await waiveObjection(reviewId)).statusCode).toBe(200);

    actAs("hc", HC);
    const finalized = await app.inject({ method: "POST", url: `/admin/performance/reviews/${reviewId}/finalize` });
    expect(finalized.statusCode, finalized.body).toBe(200);
    expect((await app.inject({ method: "POST", url: `/admin/performance/reviews/${reviewId}/finalize` })).json().code)
      .toBe("PERFORMANCE_NOT_IN_VALIDATION");

    actAs("employee");
    const result = await app.inject({ method: "GET", url: `/performance/me/${reviewId}` });
    expect(result.json()).toMatchObject({ status: "FINALIZED", finalScore: 3.5, predicateCode: "A", predicateLabel: "Sangat baik", trend: "FIRST" });
    expect(result.json().rating.strengths).toBe("Teliti");
    expect(result.json().allowedActions).toEqual(["acknowledge"]);
    const ack = await app.inject({ method: "POST", url: `/performance/me/${reviewId}/acknowledge`, payload: { comment: "Terima kasih" } });
    expect(ack.statusCode, ack.body).toBe(200);
    expect((await app.inject({ method: "POST", url: `/performance/me/${reviewId}/acknowledge`, payload: {} })).json().code)
      .toBe("PERFORMANCE_NOT_ACKNOWLEDGEABLE");

    // PERF-001-I: every transition has an actor; no indicator score is copied into history.
    actAs("hc", HC);
    const detail = await app.inject({ method: "GET", url: `/admin/performance/reviews/${reviewId}` });
    expect(detail.json().events.map((event: { eventType: string }) => event.eventType)).toEqual([
      "performance.review.added", "performance.review.self_submitted", "performance.review.rated",
      "performance.review.objection_waived", "performance.review.finalized", "performance.review.acknowledged",
    ]);
    const events = await client.query<{ actor: string | null; metadata: Record<string, unknown> }>(
      `SELECT actor_account_id AS actor, metadata FROM performance_events WHERE cycle_id = $1`,
      [cycleId],
    );
    expect(events.rows.every((row) => row.actor)).toBe(true);
    expect(JSON.stringify(events.rows.map((row) => row.metadata))).not.toContain("TASK_RESULT");

    const cycle = await app.inject({ method: "GET", url: `/admin/performance/cycles/${cycleId}` });
    expect(cycle.json().recap).toMatchObject({ participants: 2, raterMissing: 1 });
    expect(cycle.json().recap.byPredicate.find((item: { code: string }) => item.code === "A").count).toBe(1);

    const history = await app.inject({ method: "GET", url: `/admin/performance/employees/${people.employee.employeeId}/reviews` });
    expect(history.json().items).toHaveLength(1);
  });

  it("PERF-001-F: validation is never by the rater; returning clears the predicate for a new rating", async () => {
    const { reviewOf } = await openCycleWith(0, ["employee"]);
    const reviewId = reviewOf("employee");
    expect((await selfAssess(reviewId)).statusCode).toBe(200);
    expect((await rate(reviewId, all(2))).json().predicateCode).toBe("C");

    actAs("manager", HC);
    const own = await app.inject({ method: "POST", url: `/admin/performance/reviews/${reviewId}/finalize` });
    expect(own.statusCode).toBe(403);
    expect(own.json().code).toBe("PERFORMANCE_SELF_VALIDATION");

    actAs("hc", HC);
    expect((await app.inject({ method: "POST", url: `/admin/performance/reviews/${reviewId}/return`, payload: { reason: "pendek" } })).statusCode).toBe(400);
    const returned = await app.inject({
      method: "POST", url: `/admin/performance/reviews/${reviewId}/return`, payload: { reason: "Mohon tinjau ulang nilai disiplin" },
    });
    expect(returned.statusCode, returned.body).toBe(200);
    expect(await reviewRow(reviewId)).toMatchObject({ status: "MANAGER_REVIEW", predicateCode: null, finalScore: null });

    actAs("manager");
    const prefill = await app.inject({ method: "GET", url: `/performance/team/${reviewId}` });
    expect(prefill.json().rating.scores).toEqual(all(2));
    expect(prefill.json().events.at(-1)).toMatchObject({ eventType: "performance.review.returned", note: "Mohon tinjau ulang nilai disiplin" });
    expect((await rate(reviewId, all(3))).json().predicateCode).toBe("B");

    // The employee never sees HC's calibration note.
    actAs("employee");
    const own_ = await app.inject({ method: "GET", url: `/performance/me/${reviewId}` });
    expect(own_.json().events.map((event: { eventType: string }) => event.eventType)).not.toContain("performance.review.returned");
  });

  it("D-01/D-14: HC assigns a rater, removes and re-adds a participant", async () => {
    const { cycleId, reviewOf } = await openCycleWith(0, ["other"]);
    const reviewId = reviewOf("other");
    actAs("hc", HC);
    const self = await app.inject({
      method: "POST", url: `/admin/performance/reviews/${reviewId}/rater`,
      payload: { raterEmployeeId: people.other.employeeId, reason: "Penilai sementara" },
    });
    expect(self.json().code).toBe("PERFORMANCE_RATER_INVALID");
    const assigned = await app.inject({
      method: "POST", url: `/admin/performance/reviews/${reviewId}/rater`,
      payload: { raterEmployeeId: people.manager.employeeId, reason: "Atasan belum tercatat di struktur" },
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
    expect((await reviewRow(reviewId)).raterEmployeeId).toBe(people.manager.employeeId);

    const removed = await app.inject({ method: "POST", url: `/admin/performance/reviews/${reviewId}/remove`, payload: { reason: "Mutasi ke yayasan lain" } });
    expect(removed.statusCode, removed.body).toBe(200);
    actAs("other");
    expect((await app.inject({ method: "GET", url: `/performance/me/${reviewId}` })).statusCode).toBe(404);

    actAs("hc", HC);
    const readded = await app.inject({
      method: "POST", url: `/admin/performance/cycles/${cycleId}/participants`, payload: { employeeIds: [people.other.employeeId] },
    });
    expect(readded.json()).toMatchObject({ added: 0, readded: 1 });
    expect((await reviewRow(reviewId)).status).toBe("SELF_ASSESSMENT");
    const again = await app.inject({
      method: "POST", url: `/admin/performance/cycles/${cycleId}/participants`, payload: { employeeIds: [people.other.employeeId] },
    });
    expect(again.json()).toMatchObject({ added: 0, alreadyIn: 1 });

    await client.query("UPDATE employees SET status = 'inactive' WHERE id = $1", [people.outsider.employeeId]);
    const inactive = await app.inject({
      method: "POST", url: `/admin/performance/cycles/${cycleId}/participants`, payload: { employeeIds: [people.outsider.employeeId] },
    });
    expect(inactive.json().code).toBe("PERFORMANCE_EMPLOYEE_NOT_ACTIVE");
  });

  it("PERF-001-G: a past cycle closes only without pending validation; unfinished reviews become UNRATED", async () => {
    const { cycleId, reviewOf } = await openCycleWith(-1, ["employee", "other"]);
    actAs("hc", HC);
    await app.inject({
      method: "POST", url: `/admin/performance/reviews/${reviewOf("other")}/rater`,
      payload: { raterEmployeeId: people.manager.employeeId, reason: "Atasan belum tercatat" },
    });
    // D-08: the self-assessment deadline has passed, so the rater rates without one.
    const rated = await rate(reviewOf("employee"), all(1));
    expect(rated.json()).toMatchObject({ status: "HC_VALIDATION", predicateCode: "D" });

    actAs("hc", HC);
    const blocked = await app.inject({ method: "POST", url: `/admin/performance/cycles/${cycleId}/close` });
    expect(blocked.json().code).toBe("PERFORMANCE_CYCLE_HAS_PENDING_VALIDATION");
    expect((await waiveObjection(reviewOf("employee"))).statusCode).toBe(200);
    actAs("hc", HC);
    expect((await app.inject({ method: "POST", url: `/admin/performance/reviews/${reviewOf("employee")}/finalize` })).statusCode).toBe(200);
    const closed = await app.inject({ method: "POST", url: `/admin/performance/cycles/${cycleId}/close` });
    expect(closed.json()).toMatchObject({ status: "CLOSED", finalized: 1, unrated: 1 });
    expect((await reviewRow(reviewOf("other"))).status).toBe("UNRATED");
    expect((await rate(reviewOf("other"))).json().code).toBe("PERFORMANCE_CYCLE_NOT_OPEN");

    actAs("hc", HC);
    const filtered = await app.inject({ method: "GET", url: `/admin/performance/cycles/${cycleId}/reviews?predicate=D` });
    expect(filtered.json().pagination.total).toBe(1);
    const searched = await app.inject({ method: "GET", url: `/admin/performance/cycles/${cycleId}/reviews?q=kinerja%20other` });
    expect(searched.json().items.map((item: { employeeId: string }) => item.employeeId)).toEqual([people.other.employeeId]);
  });

  it("PERF-001-E/G/K: a cycle cannot close before its last day, is frozen once open, and owns its period", async () => {
    // Next month, so the check holds on the last day of the current month too.
    const { cycleId } = await openCycleWith(1, ["employee"]);
    actAs("hc", HC);
    expect((await app.inject({ method: "POST", url: `/admin/performance/cycles/${cycleId}/close` })).json().code)
      .toBe("PERFORMANCE_CYCLE_NOT_ENDED");
    expect((await app.inject({ method: "PATCH", url: `/admin/performance/cycles/${cycleId}`, payload: { name: "Nama baru" } })).json().code)
      .toBe("PERFORMANCE_CYCLE_LOCKED");
    const duplicate = await createCycle(1);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe("PERFORMANCE_CYCLE_PERIOD_TAKEN");

    const next = await createCycle(2);
    const nextId = next.json().id as string;
    const badRubric = await app.inject({
      method: "PATCH", url: `/admin/performance/cycles/${nextId}`,
      payload: { rubric: { ...DEFAULT_RUBRIC, indicators: DEFAULT_RUBRIC.indicators.slice(1) } },
    });
    expect(badRubric.json().code).toBe("PERFORMANCE_RUBRIC_INVALID");
    expect((await app.inject({ method: "POST", url: `/admin/performance/cycles/${nextId}/open` })).json().code).toBe("PERFORMANCE_CYCLE_EMPTY");
    expect((await app.inject({ method: "POST", url: `/admin/performance/cycles/${nextId}/cancel`, payload: { reason: "Salah membuat periode" } })).statusCode).toBe(200);
    expect((await createCycle(2)).statusCode).toBe(201);

    const list = await app.inject({ method: "GET", url: "/admin/performance/cycles?pageSize=2" });
    expect(list.json().pagination).toMatchObject({ pageSize: 2, total: 3 });
  });

  it("D-07: an HC admin who is a participant cannot steer or preview their own review", async () => {
    const { cycleId, reviewOf } = await openCycleWith(0, ["hc", "employee"]);
    const own = reviewOf("hc");
    await client.query("UPDATE performance_reviews SET rater_employee_id = $2, rater_source = 'HC_ASSIGNED' WHERE id = $1", [own, people.manager.employeeId]);
    actAs("hc");
    expect((await app.inject({ method: "POST", url: `/performance/me/${own}/self-assessment`, payload: { scores: all(3) } })).statusCode).toBe(200);
    expect((await rate(own, all(2))).statusCode).toBe(200);

    actAs("hc", HC);
    // D-17: they read their own review exactly as its employee does — score included, now that
    // it is with HC — but every HC action on it stays closed to them.
    const detail = await app.inject({ method: "GET", url: `/admin/performance/reviews/${own}` });
    expect(detail.json()).toMatchObject({ status: "HC_VALIDATION", finalScore: 2, predicateCode: "C" });
    expect(detail.json().allowedActions).toEqual(["object", "waive-objection"]);
    const table = await app.inject({ method: "GET", url: `/admin/performance/cycles/${cycleId}/reviews?employeeId=${people.hc.employeeId}` });
    expect(table.json().items[0]).toMatchObject({ predicateCode: "C" });
    for (const [url, payload] of [
      [`/admin/performance/reviews/${own}/finalize`, {}],
      [`/admin/performance/reviews/${own}/remove`, { reason: "Keluar sendiri" }],
    ] as const) {
      const response = await app.inject({ method: "POST", url, payload });
      expect(response.statusCode, url).toBe(403);
      expect(response.json().code).toBe("PERFORMANCE_SELF_VALIDATION");
    }

    // A colleague removes it; the actor still cannot revive it to start over.
    await client.query("UPDATE performance_reviews SET status = 'REMOVED', final_score = NULL, predicate_code = NULL, predicate_label = NULL WHERE id = $1", [own]);
    const readd = await app.inject({ method: "POST", url: `/admin/performance/cycles/${cycleId}/participants`, payload: { employeeIds: [people.hc.employeeId] } });
    expect(readd.statusCode).toBe(403);

    // Rater notes stay limited to HC's return reasons.
    const other = reviewOf("employee");
    await app.inject({ method: "POST", url: `/admin/performance/reviews/${other}/rater`, payload: { raterEmployeeId: people.outsider.employeeId, reason: "Konflik kepentingan" } });
    actAs("outsider");
    const raterView = await app.inject({ method: "GET", url: `/performance/team/${other}` });
    expect(raterView.json().events.find((event: { eventType: string }) => event.eventType === "performance.review.rater_assigned").note).toBeNull();
  });

  it("D-19: migration 0175 seeds version 1, and the database refuses a rubric that does not add up to 100", async () => {
    const seeded = await client.query<{ version: number; scope: string; total: string }>(
      `SELECT version, scope, performance_rubric_weight_total(payload)::text AS total
         FROM performance_rubric_versions ORDER BY version ASC LIMIT 1`,
    );
    expect(seeded.rows[0]).toMatchObject({ version: 1, scope: "DEFAULT", total: "100" });
    // The seeded payload is exactly the rubric the code has been using, so nothing moved.
    const payload = await client.query<{ payload: typeof DEFAULT_RUBRIC }>(
      "SELECT payload FROM performance_rubric_versions WHERE version = 1",
    );
    expect(payload.rows[0]!.payload).toEqual(DEFAULT_RUBRIC);

    // A refused statement aborts the transaction, so each one runs inside its own savepoint.
    async function refused(sql: string, params: unknown[] = []) {
      await client.query("SAVEPOINT refused_statement");
      try {
        await client.query(sql, params);
        throw new Error(`statement was accepted but should not be: ${sql}`);
      } catch (cause) {
        await client.query("ROLLBACK TO SAVEPOINT refused_statement");
        return cause as { code?: string };
      } finally {
        await client.query("RELEASE SAVEPOINT refused_statement");
      }
    }

    const insert = `INSERT INTO performance_rubric_versions (id, version, scope, name, effective_from, payload, source)
       VALUES (gen_random_uuid(), 99, 'DEFAULT', 'Rubrik tidak sah', '2026-12-01'::date,
               jsonb_build_object('indicators', $1::jsonb, 'predicates', '[]'::jsonb), 'uji')`;
    // 90, not 100; a payload with no indicators at all; and a weight that is not a number.
    for (const indicators of [[{ code: "A", weight: 90 }], [], [{ code: "A", weight: "seratus" }]]) {
      expect((await refused(insert, [JSON.stringify(indicators)])).code, JSON.stringify(indicators)).toBe("23514");
    }

    // Append-only: a version is never edited or deleted, only superseded.
    expect((await refused("UPDATE performance_rubric_versions SET source = 'diubah' WHERE version = 1")).code).toBe("23514");
    expect((await refused("DELETE FROM performance_rubric_versions WHERE version = 1")).code).toBe("23514");
  });

  it("PERF-001-L/D-18: a semester cycle follows the school calendar and owns its period", async () => {
    actAs("hc", HC);
    const bad = await app.inject({
      method: "POST", url: "/admin/performance/cycles",
      payload: { name: "Semester salah", kind: "SEMESTER", periodStart: "2026-04-01", periodEnd: "2026-09-30", selfDueOn: "2026-09-30", reviewDueOn: "2026-09-30" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe("PERFORMANCE_PERIOD_INVALID");

    const ganjil = await app.inject({
      method: "POST", url: "/admin/performance/cycles",
      payload: { name: "Penilaian semester ganjil 2026", kind: "SEMESTER", periodStart: "2026-07-01", periodEnd: "2026-12-31", selfDueOn: "2026-12-20", reviewDueOn: "2026-12-31" },
    });
    expect(ganjil.statusCode, ganjil.body).toBe(201);
    // D-19: a cycle created without its own rubric records the DEFAULT version it copied.
    expect(ganjil.json().rubricVersion).toBe(1);
    // D-02 still holds for the new kind: one non-cancelled cycle per kind and period.
    const twice = await app.inject({
      method: "POST", url: "/admin/performance/cycles",
      payload: { name: "Penilaian semester ganjil 2026 (lagi)", kind: "SEMESTER", periodStart: "2026-07-01", periodEnd: "2026-12-31", selfDueOn: "2026-12-20", reviewDueOn: "2026-12-31" },
    });
    expect(twice.json().code).toBe("PERFORMANCE_CYCLE_PERIOD_TAKEN");
    // An annual cycle starting the same day is a different kind and is accepted.
    const annual = await app.inject({
      method: "POST", url: "/admin/performance/cycles",
      payload: { name: "Penilaian tahun ajaran 2026/2027", kind: "ANNUAL", periodStart: "2026-07-01", periodEnd: "2027-06-30", selfDueOn: "2027-06-20", reviewDueOn: "2027-06-30" },
    });
    expect(annual.statusCode, annual.body).toBe(201);
  });

  it("PERF-001-M/N D-20: each job group is scored against its own rubric, and a later version leaves existing reviews alone", async () => {
    const suffix = randomUUID().slice(0, 8).toUpperCase().replace(/[^A-Z0-9]/g, "X");
    const tahfizh = `GURU_TAHFIZH_${suffix}`;
    await bindJob(people.employee.employeeId, tahfizh);

    actAs("hc", HC);
    // Akhlak weighs more for a guru tahfizh than in the default rubric (the owner's example).
    const akhlakHeavy = {
      indicators: [
        { code: "TASK_RESULT", label: "Hasil kerja", description: "", weight: 40 },
        { code: "AKHLAK", label: "Akhlak dan adab", description: "", weight: 60 },
      ],
      predicates: DEFAULT_RUBRIC.predicates,
    };
    const rejected = await app.inject({
      method: "POST", url: "/admin/performance/rubric-versions",
      payload: { name: "Rubrik guru tahfizh", scope: "JOB_GROUP", effectiveFrom: "2026-11-18", source: "Keputusan owner 18 Nov 2026", ...akhlakHeavy },
    });
    // A JOB_GROUP version must name the jobs it covers.
    expect(rejected.statusCode).toBe(400);

    const created = await app.inject({
      method: "POST", url: "/admin/performance/rubric-versions",
      payload: {
        name: "Rubrik guru tahfizh", scope: "JOB_GROUP", effectiveFrom: "2026-11-18",
        source: "Keputusan owner 18 Nov 2026", jobClassificationCodes: [tahfizh], ...akhlakHeavy,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const scopedVersion = created.json().version as number;

    // Weights that do not add up to 100 never reach the database.
    const unbalanced = await app.inject({
      method: "POST", url: "/admin/performance/rubric-versions",
      payload: {
        name: "Rubrik tidak seimbang", scope: "DEFAULT", effectiveFrom: "2026-11-18", source: "uji",
        indicators: [{ code: "TASK_RESULT", label: "Hasil kerja", description: "", weight: 99 }],
        predicates: DEFAULT_RUBRIC.predicates,
      },
    });
    expect(unbalanced.json().code).toBe("PERFORMANCE_RUBRIC_INVALID");

    // A version that would start before the newest one would move a day already scored.
    const backdated = await app.inject({
      method: "POST", url: "/admin/performance/rubric-versions",
      payload: { name: "Rubrik mundur", scope: "DEFAULT", effectiveFrom: "2026-11-04", source: "uji", ...DEFAULT_RUBRIC },
    });
    expect(backdated.json().code).toBe("PERFORMANCE_RUBRIC_VERSION_BACKDATED");

    const { cycleId, reviewOf } = await openCycleWith(0, ["employee", "other"]);
    const mine = reviewOf("employee");
    const theirs = reviewOf("other");
    actAs("hc", HC);
    const detail = await app.inject({ method: "GET", url: `/admin/performance/reviews/${mine}` });
    expect(detail.json().rubricVersion).toBe(scopedVersion);
    expect(detail.json().rubric.indicators.map((item: { code: string }) => item.code)).toEqual(["TASK_RESULT", "AKHLAK"]);
    // The colleague has no classification at all and still gets scored, on the DEFAULT version.
    const other = await app.inject({ method: "GET", url: `/admin/performance/reviews/${theirs}` });
    expect(other.json().rubricVersion).toBe(1);
    expect(other.json().rubric).toEqual(DEFAULT_RUBRIC);

    const recap = await app.inject({ method: "GET", url: `/admin/performance/cycles/${cycleId}` });
    expect(recap.json().recap.byRubricVersion.map((item: { version: number }) => item.version).sort())
      .toEqual([1, scopedVersion]);

    // The employee is held to this review's rubric just as the rater is.
    expect((await selfAssess(mine, all(3))).json().code).toBe("PERFORMANCE_SCORES_INVALID");
    expect((await selfAssess(mine, { TASK_RESULT: 3, AKHLAK: 4 })).statusCode).toBe(200);
    // The rater likewise: the default five indicators do not fit this rubric.
    expect((await rate(mine, all(4))).json().code).toBe("PERFORMANCE_SCORES_INVALID");
    // 40x4 + 60x3 = 340 -> 3.40, which is B under the same predicate bands.
    const rated = await rate(mine, { TASK_RESULT: 4, AKHLAK: 3 });
    expect(rated.json()).toMatchObject({ finalScore: 3.4, predicateCode: "B" });

    // A rubric added now does not reach a review that already exists.
    actAs("hc", HC);
    const newer = await app.inject({
      method: "POST", url: "/admin/performance/rubric-versions",
      payload: {
        name: "Rubrik guru tahfizh, revisi", scope: "JOB_GROUP", effectiveFrom: "2026-11-18",
        source: "uji", jobClassificationCodes: [tahfizh],
        indicators: [{ code: "AKHLAK", label: "Akhlak dan adab", description: "", weight: 100 }],
        predicates: DEFAULT_RUBRIC.predicates,
      },
    });
    expect(newer.statusCode, newer.body).toBe(201);
    const after = await app.inject({ method: "GET", url: `/admin/performance/reviews/${mine}` });
    expect(after.json()).toMatchObject({ rubricVersion: scopedVersion, finalScore: 3.4 });

    const versions = await app.inject({ method: "GET", url: "/admin/performance/rubric-versions" });
    expect(versions.json().defaultVersion).toBe(1);
    expect(versions.json().items[0]).toMatchObject({ scope: "JOB_GROUP", jobClassificationCodes: [tahfizh] });
  });

  it("D-20: a rubric corrected while the cycle is still DRAFT reaches the participants already added", async () => {
    const created = await createCycle(0);
    const cycleId = created.json().id as string;
    const added = await app.inject({
      method: "POST", url: `/admin/performance/cycles/${cycleId}/participants`,
      payload: { employeeIds: [people.employee.employeeId] },
    });
    expect(added.statusCode, added.body).toBe(200);
    const reviewId = (await client.query<{ id: string }>(
      "SELECT id FROM performance_reviews WHERE cycle_id = $1", [cycleId],
    )).rows[0]!.id;

    // The sequence from the review: HC adds everyone, then spots a wrong weight and fixes it.
    const corrected = {
      ...DEFAULT_RUBRIC,
      indicators: [
        { code: "TASK_RESULT", label: "Hasil kerja", description: "", weight: 50 },
        { code: "AKHLAK", label: "Akhlak dan adab", description: "", weight: 50 },
      ],
    };
    expect((await app.inject({ method: "PATCH", url: `/admin/performance/cycles/${cycleId}`, payload: { rubric: corrected } })).statusCode).toBe(200);
    // Until the cycle opens the review still carries the rubric it was added with.
    expect((await client.query<{ rubric: typeof DEFAULT_RUBRIC }>(
      "SELECT rubric FROM performance_reviews WHERE id = $1", [reviewId],
    )).rows[0]!.rubric).toEqual(DEFAULT_RUBRIC);

    const opened = await app.inject({ method: "POST", url: `/admin/performance/cycles/${cycleId}/open` });
    expect(opened.statusCode, opened.body).toBe(200);
    // Opening re-freezes it, so nobody is scored against the weights HC already corrected.
    const detail = await app.inject({ method: "GET", url: `/admin/performance/reviews/${reviewId}` });
    expect(detail.json().rubric.indicators.map((item: { code: string; weight: number }) => [item.code, item.weight]))
      .toEqual([["TASK_RESULT", 50], ["AKHLAK", 50]]);
    // A cycle rubric HC typed belongs to no version, and the review follows it.
    expect(detail.json().rubricVersion).toBeNull();
    expect(detail.json().events.map((event: { eventType: string }) => event.eventType))
      .toContain("performance.review.rubric_refrozen");

    // 50x4 + 50x2 = 300 -> 3.00, which only the corrected rubric can produce.
    expect((await selfAssess(reviewId, { TASK_RESULT: 3, AKHLAK: 3 })).statusCode).toBe(200);
    expect((await rate(reviewId, { TASK_RESULT: 4, AKHLAK: 2 })).json()).toMatchObject({ finalScore: 3, predicateCode: "B" });
  });

  it("PERF-001-O/D-17: the employee objects once, HC decides, and nothing is finalized meanwhile", async () => {
    const { cycleId, reviewOf } = await openCycleWith(0, ["employee"]);
    const reviewId = reviewOf("employee");
    expect((await selfAssess(reviewId)).statusCode).toBe(200);

    // Too early: there is no score to object to yet.
    actAs("employee");
    const early = await app.inject({
      method: "POST", url: `/performance/me/${reviewId}/objection`, payload: { reason: "Nilai belum ada sama sekali" },
    });
    expect(early.json().code).toBe("PERFORMANCE_OBJECTION_NOT_ALLOWED");

    const rated = await rate(reviewId, all(2));
    expect(rated.json()).toMatchObject({ predicateCode: "C" });
    expect(rated.json().objectionDueOn).toBe(objectionDueOn(jakartaToday()));

    actAs("employee");
    expect((await app.inject({ method: "POST", url: `/performance/me/${reviewId}/objection`, payload: { reason: "pendek" } })).statusCode).toBe(400);
    const objected = await app.inject({
      method: "POST", url: `/performance/me/${reviewId}/objection`,
      payload: { reason: "Dua kelas tambahan yang saya ampu belum dihitung pada hasil kerja." },
    });
    expect(objected.statusCode, objected.body).toBe(200);
    // One objection per cycle, whichever way the employee tries to use it again.
    expect((await app.inject({ method: "POST", url: `/performance/me/${reviewId}/objection`, payload: { reason: "Alasan kedua yang panjang" } })).json().code)
      .toBe("PERFORMANCE_OBJECTION_ALREADY_RAISED");
    expect((await waiveObjection(reviewId)).json().code).toBe("PERFORMANCE_OBJECTION_ALREADY_RAISED");

    actAs("hc", HC);
    // Neither validating nor returning may step over an open objection.
    for (const [url, payload] of [
      [`/admin/performance/reviews/${reviewId}/finalize`, {}],
      [`/admin/performance/reviews/${reviewId}/return`, { reason: "Mohon tinjau ulang nilai disiplin" }],
    ] as const) {
      const blocked = await app.inject({ method: "POST", url, payload });
      expect(blocked.statusCode, url).toBe(409);
      expect(blocked.json().code).toBe("PERFORMANCE_OBJECTION_OPEN");
    }
    const recap = await app.inject({ method: "GET", url: `/admin/performance/cycles/${cycleId}` });
    expect(recap.json().recap.objectionsOpen).toBe(1);
    const filtered = await app.inject({ method: "GET", url: `/admin/performance/cycles/${cycleId}/reviews?objection=OPEN` });
    expect(filtered.json().pagination.total).toBe(1);

    // D-07: the rater does not decide an objection against their own score.
    actAs("manager", HC);
    const byRater = await app.inject({
      method: "POST", url: `/admin/performance/reviews/${reviewId}/objection/reject`, payload: { reason: "Nilai saya sudah benar" },
    });
    expect(byRater.statusCode).toBe(403);
    expect(byRater.json().code).toBe("PERFORMANCE_SELF_VALIDATION");

    // Upheld: back to the rater, with the result cleared, exactly as a return does.
    actAs("hc", HC);
    expect((await app.inject({ method: "POST", url: `/admin/performance/reviews/${reviewId}/objection/uphold`, payload: { reason: "ya" } })).statusCode).toBe(400);
    const upheld = await app.inject({
      method: "POST", url: `/admin/performance/reviews/${reviewId}/objection/uphold`,
      payload: { reason: "Kelas tambahan memang belum masuk; penilai menilai ulang." },
    });
    expect(upheld.statusCode, upheld.body).toBe(200);
    expect(await reviewRow(reviewId)).toMatchObject({ status: "MANAGER_REVIEW", predicateCode: null, finalScore: null });
    expect((await app.inject({ method: "POST", url: `/admin/performance/reviews/${reviewId}/objection/reject`, payload: { reason: "Sudah diputuskan sebelumnya" } })).json().code)
      .toBe("PERFORMANCE_NOT_IN_VALIDATION");

    // PERF-001-P: the rater learns the score comes back, never what was written about them.
    actAs("manager");
    const raterView = await app.inject({ method: "GET", url: `/performance/team/${reviewId}` });
    expect(raterView.json().objection).toMatchObject({ status: "UPHELD", reason: null, decisionReason: null });
    expect(JSON.stringify(raterView.json())).not.toContain("Kelas tambahan");
    expect(JSON.stringify(raterView.json())).not.toContain("menilai ulang");

    // The objection is spent, so re-rating opens no new window and writes no due date at all.
    const rerated = await rate(reviewId, all(3));
    expect(rerated.json()).toMatchObject({ predicateCode: "B", objectionDueOn: null });
    expect((await client.query<{ dueOn: string | null }>(
      `SELECT to_char(objection_due_on, 'YYYY-MM-DD') AS "dueOn" FROM performance_reviews WHERE id = $1`, [reviewId],
    )).rows[0]!.dueOn).toBeNull();
    actAs("employee");
    const again = await app.inject({
      method: "POST", url: `/performance/me/${reviewId}/objection`, payload: { reason: "Masih belum sesuai menurut saya" },
    });
    expect(again.json().code).toBe("PERFORMANCE_OBJECTION_ALREADY_RAISED");
    const mine = await app.inject({ method: "GET", url: `/performance/me/${reviewId}` });
    expect(mine.json().objection).toMatchObject({ status: "UPHELD" });
    expect(mine.json().objection.decisionReason).toContain("menilai ulang");
    expect(mine.json().allowedActions).toEqual([]);

    // A decided objection no longer holds the result, so HC validates without waiting the window out.
    actAs("hc", HC);
    const finalized = await app.inject({ method: "POST", url: `/admin/performance/reviews/${reviewId}/finalize` });
    expect(finalized.statusCode, finalized.body).toBe(200);
    const history = await app.inject({ method: "GET", url: `/admin/performance/reviews/${reviewId}` });
    expect(history.json().events.map((event: { eventType: string }) => event.eventType)).toContain("performance.review.objected");
    expect(history.json().events.find((event: { eventType: string }) => event.eventType === "performance.review.objection_upheld").note)
      .toContain("menilai ulang");
  });

  it("D-17: an objection is refused once the window has closed", async () => {
    const { reviewOf } = await openCycleWith(0, ["employee"]);
    const reviewId = reviewOf("employee");
    expect((await selfAssess(reviewId)).statusCode).toBe(200);
    expect((await rate(reviewId)).statusCode).toBe(200);
    // Move the window into the past, as the clock would.
    await client.query("UPDATE performance_reviews SET objection_due_on = current_date - 1 WHERE id = $1", [reviewId]);

    actAs("employee");
    const late = await app.inject({
      method: "POST", url: `/performance/me/${reviewId}/objection`, payload: { reason: "Terlambat mengajukan keberatan" },
    });
    expect(late.statusCode).toBe(409);
    expect(late.json().code).toBe("PERFORMANCE_OBJECTION_WINDOW_CLOSED");
    expect((await app.inject({ method: "GET", url: `/performance/me/${reviewId}` })).json().allowedActions).toEqual([]);

    // With the window closed and no objection raised, HC validates as before.
    actAs("hc", HC);
    expect((await app.inject({ method: "POST", url: `/admin/performance/reviews/${reviewId}/finalize` })).statusCode).toBe(200);
  });

  it("D-17: removing a participant clears an objection nobody could decide, and re-adding starts clean", async () => {
    const { cycleId, reviewOf } = await openCycleWith(0, ["employee"]);
    const reviewId = reviewOf("employee");
    expect((await selfAssess(reviewId)).statusCode).toBe(200);
    expect((await rate(reviewId, all(2))).statusCode).toBe(200);
    actAs("employee");
    expect((await app.inject({
      method: "POST", url: `/performance/me/${reviewId}/objection`,
      payload: { reason: "Nilai disiplin tidak sesuai catatan kehadiran saya." },
    })).statusCode).toBe(200);

    actAs("hc", HC);
    expect((await app.inject({ method: "GET", url: `/admin/performance/cycles/${cycleId}` })).json().recap.objectionsOpen).toBe(1);
    const removed = await app.inject({
      method: "POST", url: `/admin/performance/reviews/${reviewId}/remove`, payload: { reason: "Mutasi ke yayasan lain" },
    });
    expect(removed.statusCode, removed.body).toBe(200);
    // Neither decision is possible on a removed review, so it must not keep being counted.
    expect((await app.inject({ method: "GET", url: `/admin/performance/cycles/${cycleId}` })).json().recap.objectionsOpen).toBe(0);
    expect((await app.inject({ method: "GET", url: `/admin/performance/cycles/${cycleId}/reviews?objection=OPEN` })).json().pagination.total).toBe(0);

    const readded = await app.inject({
      method: "POST", url: `/admin/performance/cycles/${cycleId}/participants`, payload: { employeeIds: [people.employee.employeeId] },
    });
    expect(readded.json()).toMatchObject({ readded: 1 });
    // The previous round's objection must leave nothing behind: no status, no window, no reasons.
    const row = (await client.query<{
      status: string | null; dueOn: string | null; reason: string | null; decisionReason: string | null;
      raisedAt: string | null; decidedAt: string | null; decidedBy: string | null;
    }>(
      `SELECT objection_status AS status, to_char(objection_due_on, 'YYYY-MM-DD') AS "dueOn",
              objection_reason AS reason, objection_decision_reason AS "decisionReason",
              objection_raised_at AS "raisedAt", objection_decided_at AS "decidedAt",
              objection_decided_by_account_id AS "decidedBy"
         FROM performance_reviews WHERE id = $1`,
      [reviewId],
    )).rows[0]!;
    expect(row).toEqual({
      status: null, dueOn: null, reason: null, decisionReason: null, raisedAt: null, decidedAt: null, decidedBy: null,
    });
    expect((await app.inject({ method: "GET", url: `/admin/performance/reviews/${reviewId}` })).json().objection).toBeNull();

    // And the revived review behaves like a fresh one: a window opens, and HC must wait for it.
    expect((await selfAssess(reviewId)).statusCode).toBe(200);
    const rated = await rate(reviewId, all(3));
    expect(rated.json().objectionDueOn).toBe(objectionDueOn(jakartaToday()));
    actAs("hc", HC);
    expect((await app.inject({ method: "POST", url: `/admin/performance/reviews/${reviewId}/finalize` })).json().code)
      .toBe("PERFORMANCE_OBJECTION_WINDOW_OPEN");
    actAs("employee");
    expect((await app.inject({
      method: "POST", url: `/performance/me/${reviewId}/objection`, payload: { reason: "Keberatan baru pada putaran ini." },
    })).statusCode).toBe(200);
  });

  it("adds every active employee at once and skips those already in", async () => {
    const created = await createCycle(2);
    const cycleId = created.json().id as string;
    await app.inject({ method: "POST", url: `/admin/performance/cycles/${cycleId}/participants`, payload: { employeeIds: [people.employee.employeeId] } });
    const bulk = await app.inject({ method: "POST", url: `/admin/performance/cycles/${cycleId}/participants`, payload: { allActive: true } });
    expect(bulk.statusCode, bulk.body).toBe(200);
    expect(bulk.json().alreadyIn).toBe(1);
    expect(bulk.json().added).toBeGreaterThanOrEqual(4);
  });
});
