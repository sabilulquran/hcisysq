// PERF-001 Package 1 acceptance against a real schema.
// Synthetic employees only; every test runs inside one rolled-back transaction.

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import { DEFAULT_RUBRIC } from "../src/modules/performance/domain.js";
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
    const unitId = randomUUID();
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
    expect(added.json()).toEqual({ added: 2, readded: 0, alreadyIn: 0, withoutRater: 1 });

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

    // PERF-001-A: the employee does not see the result before it is validated.
    actAs("employee");
    const pending = await app.inject({ method: "GET", url: `/performance/me/${reviewId}` });
    expect(pending.json()).toMatchObject({ status: "HC_VALIDATION", finalScore: null, predicateCode: null, rating: null });

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
      "performance.review.finalized", "performance.review.acknowledged",
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
    const detail = await app.inject({ method: "GET", url: `/admin/performance/reviews/${own}` });
    expect(detail.json()).toMatchObject({ status: "HC_VALIDATION", finalScore: null, predicateCode: null, rating: null, allowedActions: [] });
    const table = await app.inject({ method: "GET", url: `/admin/performance/cycles/${cycleId}/reviews?employeeId=${people.hc.employeeId}` });
    expect(table.json().items[0]).toMatchObject({ predicateCode: null, finalScore: null });
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
