// TRAIN-001 R3 evaluation acceptance against a real schema.
// Synthetic employees only; every test runs inside one rolled-back transaction.

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import { STANDARD_REACTION_INSTRUMENT_ID } from "../src/modules/training/evaluation-domain.js";
import { registerTrainingRoutes } from "../src/modules/training/routes.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

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

const HC = ["training.read", "training.manage"];
const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

const TEST_ITEMS = [
  { type: "SINGLE", prompt: "Hukum nun mati bertemu ba?", options: ["Izhar", "Iqlab", "Idgham"], correct: 1, points: 2 },
  { type: "MULTI", prompt: "Huruf qalqalah?", options: ["Qaf", "Tha", "Ba", "Sin"], correct: [0, 1, 2] },
  { type: "TRUE_FALSE", prompt: "Mad thabi'i dua harakat.", correct: true },
  { type: "SHORT", prompt: "Nama tanda waqaf lazim?", accepted: ["Mim"] },
];

describe.skipIf(!allowed)("TRAIN-001 R3 evaluation", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let principal: AuthPrincipal;
  let permissions: string[];
  const people = {} as Record<"hc" | "aisyah" | "bilal" | "citra" | "manager" | "outsider", { employeeId: string; accountId: string }>;

  async function insertEmployee(name: string) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO employees(id, employee_number, full_name, status, started_on) VALUES ($1,$2,$3,'active','2020-01-06')`,
      [id, `TRE-${id.slice(0, 8)}`, name],
    );
    return id;
  }

  async function insertAccount(employeeId: string) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1,$2,$3,'EMPLOYEE','active')`,
      [id, employeeId, `treval-${id}@example.invalid`],
    );
    return id;
  }

  function actAs(who: keyof typeof people, granted: string[] = []) {
    principal = { id: people[who].accountId, email: `${who}@example.invalid`, principalType: "EMPLOYEE" };
    permissions = granted;
  }

  async function call(method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) {
    return app.inject({ method, url, payload: payload as never });
  }

  async function programWith(...who: Array<keyof typeof people>) {
    actAs("hc", HC);
    const created = await call("POST", "/admin/training/programs", { title: "Tahsin Guru R3", category: "QURANIC" });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    const start = new Date(Date.now() + 86_400_000);
    start.setUTCMinutes(0, 0, 0);
    const end = new Date(start.getTime() + 2 * 3_600_000);
    expect((await call("POST", `/admin/training/programs/${id}/sessions`, {
      title: "Sesi tahsin", startAt: start.toISOString(), endAt: end.toISOString(),
    })).statusCode).toBe(201);
    if (who.length > 0) {
      const enrolled = await call("POST", `/admin/training/programs/${id}/participants`, { employeeIds: who.map((key) => people[key].employeeId) });
      expect(enrolled.statusCode, enrolled.body).toBe(200);
    }
    return id;
  }

  async function instrument(kind: "FORM" | "TEST" | "RUBRIC", items: unknown[], title = `Instrumen ${kind}`) {
    actAs("hc", HC);
    const response = await call("POST", "/admin/training/instruments", { kind, title, items });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as string;
  }

  async function component(programId: string, body: Record<string, unknown>) {
    actAs("hc", HC);
    const response = await call("POST", `/admin/training/programs/${programId}/evaluation/components`, body);
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as string;
  }

  /** Moves every scheduled session of the program into the past, as if it already started. */
  async function sessionsStarted(programId: string) {
    await client.query(
      `UPDATE training_sessions SET start_at = now() - interval '3 hours', end_at = now() - interval '1 hour' WHERE program_id = $1`,
      [programId],
    );
  }

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    for (const key of ["hc", "aisyah", "bilal", "citra", "manager", "outsider"] as const) {
      const employeeId = await insertEmployee(`Pegawai ${key}`);
      people[key] = { employeeId, accountId: await insertAccount(employeeId) };
    }
    // Aisyah reports to the manager (ORG-002 legacy line), Bilal has no line manager.
    await client.query(`UPDATE employees SET direct_manager_employee_id = $2 WHERE id = $1`, [people.aisyah.employeeId, people.manager.employeeId]);
    const config = { NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8 } as ApiConfig;
    const auth = {
      getSession: async () => ({ principal, expiresAt: "2099-01-01T00:00:00Z" }),
      getAuthorizationContext: async () => ({ organizationPermissions: permissions }),
    } as never;
    app = Fastify({ logger: false });
    await registerTrainingRoutes(app, savepointPool(client), config, auth);
  });

  afterEach(async () => {
    try { await app?.close(); } finally {
      if (client) { await client.query("ROLLBACK"); client.release(); }
    }
  });

  it("TRAIN-R3-A/D: keys never reach the respondent; pre/post scored on the server with the gain", async () => {
    const programId = await programWith("aisyah", "bilal");
    const testId = await instrument("TEST", TEST_ITEMS);
    const componentId = await component(programId, { kind: "PRE_POST_TEST", instrumentId: testId, weight: 100 });

    actAs("aisyah");
    const tasks = await call("GET", "/training/me/evaluation/tasks");
    expect(tasks.statusCode, tasks.body).toBe(200);
    // Post-test is not open yet: the only session has not started.
    expect(tasks.json().items.map((task: { stage: string }) => task.stage)).toEqual(["PRE"]);

    const form = await call("GET", `/training/me/evaluation/components/${componentId}/form?stage=PRE`);
    expect(form.statusCode, form.body).toBe(200);
    expect(form.body).not.toContain("correct");
    expect(form.body).not.toContain("accepted");
    expect(form.json().items).toHaveLength(4);

    // Pre: q1 right (2), q2 partial = wrong, q3 wrong, q4 right (1) -> 3 of 5 = 60.
    const pre = await call("POST", `/training/me/evaluation/components/${componentId}/responses`, {
      stage: "PRE", answers: { q1: 1, q2: [0, 1], q3: false, q4: "  MIM " },
    });
    expect(pre.statusCode, pre.body).toBe(201);
    expect(pre.json()).toMatchObject({ score: 60, pointsEarned: 3, pointsMax: 5 });
    expect((await call("POST", `/training/me/evaluation/components/${componentId}/responses`, { stage: "PRE", answers: {} })).json().code)
      .toBe("TRAINING_RESPONSE_EXISTS");
    const early = await call("POST", `/training/me/evaluation/components/${componentId}/responses`, { stage: "POST", answers: {} });
    expect(early.statusCode).toBe(409);
    expect(early.json().code).toBe("TRAINING_STAGE_NOT_OPEN");

    await sessionsStarted(programId);
    const post = await call("POST", `/training/me/evaluation/components/${componentId}/responses`, {
      stage: "POST", answers: { q1: 1, q2: [2, 1, 0], q3: true, q4: "mim" },
    });
    expect(post.json()).toMatchObject({ score: 100 });

    // Bilal never took the pre-test; after the post-test it is closed for him.
    actAs("bilal");
    expect((await call("POST", `/training/me/evaluation/components/${componentId}/responses`, {
      stage: "POST", answers: { q1: 0 },
    })).json().score).toBe(0);
    const latePre = await call("POST", `/training/me/evaluation/components/${componentId}/responses`, { stage: "PRE", answers: {} });
    expect(latePre.json().code).toBe("TRAINING_STAGE_NOT_OPEN");

    actAs("hc", ["training.read"]);
    const summary = await call("GET", `/admin/training/programs/${programId}/evaluation/summary`);
    expect(summary.statusCode, summary.body).toBe(200);
    expect(summary.json().components[0]).toMatchObject({ averagePre: 60, averagePost: 50, averageGain: 40, pairs: 1, submitted: 2 });
    const results = await call("GET", `/admin/training/programs/${programId}/evaluation/results`);
    const byName = Object.fromEntries(results.json().items.map((row: { fullName: string }) => [row.fullName, row]));
    expect(byName["Pegawai aisyah"]).toMatchObject({ pre: 60, post: 100, gain: 40, finalScore: 100, status: "PASSED" });
    expect(byName["Pegawai aisyah"].prePost).toEqual([{ componentId, title: "Instrumen TEST", pre: 60, post: 100, gain: 40 }]);
    expect(byName["Pegawai bilal"]).toMatchObject({ pre: null, post: 0, finalScore: 0, status: "FAILED" });

    const audit = await client.query(
      `SELECT metadata FROM training_audit_events WHERE event_type = 'training.evaluation.response.submitted' AND program_id = $1`,
      [programId],
    );
    expect(audit.rows).toHaveLength(3);
    expect(JSON.stringify(audit.rows)).not.toContain("mim");
  });

  it("TRAIN-R3-B/C: reaction is anonymous, once per participant; comments hidden under three responses", async () => {
    const programId = await programWith("aisyah", "bilal", "citra");
    const reactionId = await component(programId, { kind: "REACTION", instrumentId: STANDARD_REACTION_INSTRUMENT_ID });
    const answers = { q1: 5, q2: 4, q3: 4, q4: 3, q5: 5, q6: 5, q7: "Materinya sangat bermanfaat" };

    actAs("outsider");
    expect((await call("GET", `/training/me/evaluation/components/${reactionId}/form`)).statusCode).toBe(404);
    expect((await call("POST", `/training/me/evaluation/components/${reactionId}/responses`, { answers })).statusCode).toBe(404);

    actAs("aisyah");
    const missing = await call("POST", `/training/me/evaluation/components/${reactionId}/responses`, { answers: { q1: 5 } });
    expect(missing.json().code).toBe("INVALID_TRAINING_RESPONSE");
    const first = await call("POST", `/training/me/evaluation/components/${reactionId}/responses`, { answers });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toEqual({ anonymous: true, score: null });
    expect((await call("POST", `/training/me/evaluation/components/${reactionId}/responses`, { answers })).statusCode).toBe(409);

    const stored = await client.query(
      `SELECT subject_employee_id, respondent_employee_id, respondent_account_id, submitted_at FROM training_evaluation_responses WHERE component_id = $1`,
      [reactionId],
    );
    expect(stored.rows).toEqual([{ subject_employee_id: null, respondent_employee_id: null, respondent_account_id: null, submitted_at: null }]);
    const audit = await client.query(
      `SELECT 1 FROM training_audit_events WHERE event_type = 'training.evaluation.response.submitted' AND program_id = $1`, [programId],
    );
    expect(audit.rows).toHaveLength(0);

    actAs("hc", ["training.read"]);
    const hidden = await call("GET", `/admin/training/evaluation/components/${reactionId}/comments`);
    expect(hidden.json()).toMatchObject({ hidden: true, items: [] });

    for (const who of ["bilal", "citra"] as const) {
      actAs(who);
      expect((await call("POST", `/training/me/evaluation/components/${reactionId}/responses`, { answers: { ...answers, q1: 3 } })).statusCode).toBe(201);
    }
    // Three answers, but the window is still open: a fourth answer would show as a difference.
    actAs("hc", ["training.read"]);
    expect((await call("GET", `/admin/training/evaluation/components/${reactionId}/comments`)).json().hidden).toBe(true);
    const open = await call("GET", `/admin/training/programs/${programId}/evaluation/summary`);
    expect(open.json().components[0]).toMatchObject({ hidden: true, submitted: 3 });
    expect(open.json().components[0].items).toBeUndefined();
    actAs("hc", HC);
    expect((await call("PATCH", `/admin/training/evaluation/components/${reactionId}`, { closesAt: hoursFromNow(-0.01) })).statusCode).toBe(200);
    actAs("hc", ["training.read"]);
    const shown = await call("GET", `/admin/training/evaluation/components/${reactionId}/comments`);
    expect(shown.json().hidden).toBe(false);
    expect(shown.json().pagination.total).toBe(3);
    expect(shown.json().items[0].subjectName).toBeNull();
    const summary = await call("GET", `/admin/training/programs/${programId}/evaluation/summary`);
    expect(summary.json().components[0].items[0]).toMatchObject({ average: 3.67, distribution: [0, 0, 2, 0, 1], count: 3 });
  });

  it("TRAIN-R3-E/I: weighted outcome, supervisor assessors, HC rubric, level 3 apart from the pass status", async () => {
    const testId = await instrument("TEST", TEST_ITEMS);
    const rubricId = await instrument("RUBRIC", [
      { type: "CRITERION", prompt: "Makhraj", levels: ["Kurang", "Cukup", "Baik", "Sangat baik"] },
      { type: "CRITERION", prompt: "Kelancaran", levels: ["Kurang", "Cukup", "Baik", "Sangat baik"] },
    ]);
    const formId = await instrument("FORM", [
      { type: "SCALE", prompt: "Menerapkan materi di kelas" },
      { type: "TEXT", prompt: "Catatan", required: false },
    ]);
    // The supervisor component exists before Bilal and Aisyah join: enrolment assigns assessors.
    const bare = await programWith();
    const supervisorForm = await component(bare, { kind: "FORM", instrumentId: formId, level: 3, respondent: "SUPERVISOR" });
    actAs("hc", HC);
    expect((await call("POST", `/admin/training/programs/${bare}/participants`, {
      employeeIds: [people.aisyah.employeeId, people.bilal.employeeId],
    })).statusCode).toBe(200);
    const test = await component(bare, { kind: "TEST", instrumentId: testId, weight: 30 });
    const rubric = await component(bare, { kind: "RUBRIC", instrumentId: rubricId, level: 2, respondent: "HC", weight: 70 });
    expect((await call("PATCH", `/admin/training/programs/${bare}/evaluation`, { passingScore: 80 })).statusCode).toBe(200);

    const assessors = await call("GET", `/admin/training/evaluation/components/${supervisorForm}/assessors`);
    const rowsByName = Object.fromEntries(assessors.json().items.map((row: { subjectName: string }) => [row.subjectName, row]));
    expect(rowsByName["Pegawai aisyah"]).toMatchObject({ assessorEmployeeId: people.manager.employeeId, source: "DIRECT_MANAGER" });
    expect(rowsByName["Pegawai bilal"]).toMatchObject({ assessorEmployeeId: null, source: "UNRESOLVED" });
    // Nobody assesses themself; HC assigns Bilal's assessor.
    const self = await call("PUT", `/admin/training/evaluation/components/${supervisorForm}/assessors`, {
      entries: [{ subjectEmployeeId: people.bilal.employeeId, assessorEmployeeId: people.bilal.employeeId }],
    });
    expect(self.json().code).toBe("TRAINING_ASSESSOR_SELF");
    expect((await call("PUT", `/admin/training/evaluation/components/${supervisorForm}/assessors`, {
      entries: [{ subjectEmployeeId: people.bilal.employeeId, assessorEmployeeId: people.manager.employeeId }],
    })).statusCode).toBe(200);

    // Aisyah: test 3/5 = 60, rubric (4+4)/8 = 100 -> 0.3*60 + 0.7*100 = 88 -> passes 80.
    actAs("aisyah");
    expect((await call("POST", `/training/me/evaluation/components/${test}/responses`, {
      answers: { q1: 1, q4: "mim" },
    })).json().score).toBe(60);
    // The rubric is HC's to fill; for Aisyah it is not there at all.
    expect((await call("GET", `/training/me/evaluation/components/${rubric}/form?subjectEmployeeId=${people.aisyah.employeeId}`)).statusCode).toBe(404);

    actAs("hc", HC);
    const rubricForm = await call("GET", `/admin/training/evaluation/components/${rubric}/form?subjectEmployeeId=${people.aisyah.employeeId}`);
    expect(rubricForm.statusCode, rubricForm.body).toBe(200);
    expect((await call("POST", `/admin/training/evaluation/components/${rubric}/responses`, {
      subjectEmployeeId: people.aisyah.employeeId, answers: { q1: 4, q2: 4 },
    })).statusCode).toBe(201);
    // HC never assesses themself (E-15).
    const own = await call("GET", `/admin/training/evaluation/components/${rubric}/form?subjectEmployeeId=${people.hc.employeeId}`);
    expect(own.statusCode).toBe(403);
    // The weight is locked once answered.
    expect((await call("PATCH", `/admin/training/evaluation/components/${rubric}`, { weight: 50 })).json().code).toBe("TRAINING_COMPONENT_LOCKED");

    // The manager sees both supervisor tasks; Bilal's peer never does.
    actAs("manager");
    const managerTasks = await call("GET", "/training/me/evaluation/tasks");
    expect(managerTasks.json().items.map((task: { subjectName: string }) => task.subjectName).sort()).toEqual(["Pegawai aisyah", "Pegawai bilal"]);
    expect((await call("POST", `/training/me/evaluation/components/${supervisorForm}/responses`, {
      subjectEmployeeId: people.aisyah.employeeId, answers: { q1: 2 },
    })).statusCode).toBe(201);
    actAs("citra");
    expect((await call("POST", `/training/me/evaluation/components/${supervisorForm}/responses`, {
      subjectEmployeeId: people.bilal.employeeId, answers: { q1: 5 },
    })).statusCode).toBe(404);

    actAs("aisyah");
    const mine = await call("GET", "/training/me/evaluation/results");
    expect(mine.statusCode, mine.body).toBe(200);
    // A poor level-3 rating does not change the pass status (E-08).
    expect(mine.json().items[0]).toMatchObject({ finalScore: 88, status: "PASSED", applicationRating: 2 });

    actAs("hc", ["training.read"]);
    const bilal = await call("GET", `/admin/training/employees/${people.bilal.employeeId}/evaluation`);
    expect(bilal.json().items[0]).toMatchObject({ status: "INCOMPLETE" });
    actAs("outsider");
    expect((await call("GET", `/admin/training/employees/${people.bilal.employeeId}/evaluation`)).statusCode).toBe(403);
  });

  it("TRAIN-R3-F/G: components copy the instrument; the system questionnaire and HC writes are guarded", async () => {
    const programId = await programWith("aisyah");
    const formId = await instrument("FORM", [{ type: "SCALE", prompt: "Versi pertama" }]);
    const componentId = await component(programId, { kind: "FORM", instrumentId: formId, level: 1 });
    actAs("hc", HC);
    expect((await call("PATCH", `/admin/training/instruments/${formId}`, { items: [{ type: "SCALE", prompt: "Versi kedua" }] })).statusCode).toBe(200);
    actAs("aisyah");
    const form = await call("GET", `/training/me/evaluation/components/${componentId}/form`);
    expect(form.json().items[0].prompt).toBe("Versi pertama");

    actAs("hc", HC);
    expect((await call("PATCH", `/admin/training/instruments/${STANDARD_REACTION_INSTRUMENT_ID}`, { title: "Ubah" })).json().code)
      .toBe("TRAINING_INSTRUMENT_SYSTEM");
    const mismatch = await call("POST", `/admin/training/programs/${programId}/evaluation/components`, { kind: "TEST", instrumentId: formId });
    expect(mismatch.json().code).toBe("TRAINING_INSTRUMENT_MISMATCH");
    const weightedReaction = await call("POST", `/admin/training/programs/${programId}/evaluation/components`, {
      kind: "REACTION", instrumentId: STANDARD_REACTION_INSTRUMENT_ID, weight: 10,
    });
    expect(weightedReaction.json().code).toBe("INVALID_TRAINING_COMPONENT");
    const badItems = await call("POST", "/admin/training/instruments", { kind: "TEST", title: "Salah", items: [{ type: "SCALE", prompt: "x" }] });
    expect(badItems.json().code).toBe("INVALID_TRAINING_INSTRUMENT");

    // A closed window refuses answers.
    expect((await call("PATCH", `/admin/training/evaluation/components/${componentId}`, {
      opensAt: hoursFromNow(-5), closesAt: hoursFromNow(-1),
    })).statusCode).toBe(200);
    actAs("aisyah");
    expect((await call("POST", `/training/me/evaluation/components/${componentId}/responses`, { answers: { q1: 4 } })).json().code)
      .toBe("TRAINING_COMPONENT_NOT_OPEN");

    actAs("hc", ["training.read"]);
    expect((await call("POST", "/admin/training/instruments", { kind: "FORM", title: "Tanpa izin", items: [{ type: "SCALE", prompt: "x" }] })).statusCode).toBe(403);
    expect((await call("GET", "/admin/training/instruments")).json().items[0].isSystem).toBe(true);
    // A read-only holder may be a participant: no answer keys for them.
    const testId = await instrument("TEST", TEST_ITEMS);
    actAs("hc", ["training.read"]);
    const readOnly = await call("GET", `/admin/training/instruments/${testId}`);
    expect(readOnly.statusCode).toBe(200);
    expect(readOnly.body).not.toContain("correct");
    expect(readOnly.body).not.toContain("accepted");
    actAs("hc", HC);
    expect((await call("GET", `/admin/training/instruments/${testId}`)).body).toContain("correct");
    actAs("hc", ["training.read"]);
    const archived = await call("POST", `/admin/training/evaluation/components/${componentId}/archive`, { reason: "Tidak dipakai" });
    expect(archived.statusCode).toBe(403);

    const created = await client.query(
      `SELECT event_type FROM training_audit_events WHERE event_type LIKE 'training.instrument.%' OR event_type LIKE 'training.evaluation.%'`,
    );
    expect(created.rows.map((row) => row.event_type)).toEqual(expect.arrayContaining([
      "training.instrument.created", "training.instrument.updated", "training.evaluation.component.created", "training.evaluation.component.updated",
    ]));
  });
});
