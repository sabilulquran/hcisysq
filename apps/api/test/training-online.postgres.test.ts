// TRAIN-001 R4 online modules against a real schema, with the in-memory ObjectStorage fake.
// Synthetic employees and synthetic MP4 bytes only; every test runs in one rolled-back transaction.

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import { MemoryObjectStorage } from "../src/lib/object-storage.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import { registerTrainingRoutes } from "../src/modules/training/routes.js";
import { syntheticMp4 } from "./fixtures/synthetic-mp4.js";

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

describe.skipIf(!allowed)("TRAIN-001 R4 online modules", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let storage: MemoryObjectStorage;
  let principal: AuthPrincipal;
  let permissions: string[];
  const people = {} as Record<"hc" | "aisyah" | "bilal" | "outsider", { employeeId: string; accountId: string }>;

  async function insertPerson(name: string) {
    const employeeId = randomUUID();
    await client.query(
      `INSERT INTO employees(id, employee_number, full_name, status, started_on) VALUES ($1,$2,$3,'active','2020-01-06')`,
      [employeeId, `TRO-${employeeId.slice(0, 8)}`, name],
    );
    const accountId = randomUUID();
    await client.query(
      `INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1,$2,$3,'EMPLOYEE','active')`,
      [accountId, employeeId, `tronline-${accountId}@example.invalid`],
    );
    return { employeeId, accountId };
  }

  function actAs(who: keyof typeof people, granted: string[] = []) {
    principal = { id: people[who].accountId, email: `${who}@example.invalid`, principalType: "EMPLOYEE" };
    permissions = granted;
  }

  async function call(method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown, headers: Record<string, string> = {}) {
    return app.inject({ method, url, payload: payload as never, headers });
  }

  async function build(enabled: boolean, limits: Partial<ApiConfig> = {}) {
    await app?.close();
    const config = {
      NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8,
      TRAINING_ONLINE_ENABLED: enabled ? "1" : "0", TRAINING_VIDEO_MAX_BYTES: 10_000, TRAINING_MEDIA_QUOTA_BYTES: 50_000, ...limits,
    } as ApiConfig;
    const auth = {
      getSession: async () => ({ principal, expiresAt: "2099-01-01T00:00:00Z" }),
      getAuthorizationContext: async () => ({ organizationPermissions: permissions }),
    } as never;
    app = Fastify({ logger: false });
    await registerTrainingRoutes(app, savepointPool(client), config, auth, storage);
  }

  /** An online program with Aisyah enrolled and one draft module holding a video and a reading. */
  async function onlineProgram() {
    actAs("hc", HC);
    const program = await call("POST", "/admin/training/programs", { title: "SOP Keuangan Daring", category: "SOP_ADMIN", delivery: "ONLINE" });
    expect(program.statusCode, program.body).toBe(201);
    const programId = program.json().id as string;
    expect((await call("POST", `/admin/training/programs/${programId}/participants`, { employeeIds: [people.aisyah.employeeId] })).statusCode).toBe(200);
    const module = await call("POST", `/admin/training/programs/${programId}/modules`, { title: "Pengantar SOP", creditHours: 1.5 });
    expect(module.statusCode, module.body).toBe(201);
    const moduleId = module.json().id as string;
    const video = (await call("POST", `/admin/training/modules/${moduleId}/materials`, { kind: "VIDEO", title: "Video pengantar" })).json().id as string;
    const text = (await call("POST", `/admin/training/modules/${moduleId}/materials`, { kind: "TEXT", title: "Bacaan SOP", body: "Isi SOP sintetis." })).json().id as string;
    return { programId, moduleId, video, text };
  }

  async function upload(materialId: string, file: Buffer) {
    actAs("hc", HC);
    return call("PUT", `/admin/training/materials/${materialId}/video`, file, { "content-type": "video/mp4" });
  }

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    for (const key of ["hc", "aisyah", "bilal", "outsider"] as const) people[key] = await insertPerson(`Pegawai ${key}`);
    storage = new MemoryObjectStorage();
    await build(true);
  });

  afterEach(async () => {
    try { await app?.close(); } finally {
      if (client) { await client.query("ROLLBACK"); client.release(); }
    }
  });

  it("TRAIN-R4-A: the switch is off by default and refuses everything", async () => {
    await build(false);
    actAs("hc", HC);
    const online = await call("POST", "/admin/training/programs", { title: "Daring", category: "OTHER", delivery: "ONLINE" });
    expect(online.statusCode).toBe(404);
    expect(online.json().code).toBe("TRAINING_ONLINE_DISABLED");
    const classroom = (await call("POST", "/admin/training/programs", { title: "Luring", category: "OTHER" })).json().id as string;
    expect((await call("GET", `/admin/training/programs/${classroom}/modules`)).json().code).toBe("TRAINING_ONLINE_DISABLED");
    expect((await call("GET", "/admin/training/online/storage")).json()).toMatchObject({ enabled: false });
  });

  it("TRAIN-R4-B/G: uploads through the port with size, type and quota checks; published modules lock", async () => {
    const { moduleId, video } = await onlineProgram();
    // Publishing needs every video uploaded.
    expect((await call("POST", `/admin/training/modules/${moduleId}/publish`)).json().code).toBe("TRAINING_VIDEO_MISSING");
    const fake = await upload(video, Buffer.from("%PDF-1.4 bukan video"));
    expect(fake.statusCode).toBe(400);
    expect(fake.json().code).toBe("TRAINING_VIDEO_INVALID");
    expect(storage.objects.size).toBe(0);
    const big = await upload(video, syntheticMp4(60, 20_000));
    expect(big.statusCode).toBe(413);
    expect(storage.objects.size).toBe(0);
    const ok = await upload(video, syntheticMp4(120));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ durationSeconds: 120 });
    const keys = [...storage.objects.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^training\/videos\/[0-9a-f-]+\/[0-9a-f-]+\.mp4$/);
    // A replacement removes the previous object.
    expect((await upload(video, syntheticMp4(100))).statusCode).toBe(200);
    expect(storage.objects.size).toBe(1);
    const row = await client.query(`SELECT object_key, byte_size, sha256 FROM training_materials WHERE id = $1`, [video]);
    expect(row.rows[0].object_key).toBe([...storage.objects.keys()][0]);
    const audit = await client.query(`SELECT metadata FROM training_audit_events WHERE event_type = 'training.material.video_uploaded'`);
    expect(JSON.stringify(audit.rows)).not.toContain("object_key");

    expect((await call("POST", `/admin/training/modules/${moduleId}/publish`)).statusCode).toBe(200);
    expect((await call("POST", `/admin/training/modules/${moduleId}/materials`, { kind: "TEXT", title: "Tambahan", body: "x" })).json().code).toBe("TRAINING_MODULE_LOCKED");
    expect((await upload(video, syntheticMp4(90))).json().code).toBe("TRAINING_MODULE_LOCKED");

    // Quota: a 50 kB quota cannot take another 10 kB video beyond what remains.
    await build(true, { TRAINING_MEDIA_QUOTA_BYTES: 1_000 } as Partial<ApiConfig>);
    const second = await onlineProgram();
    expect((await upload(second.video, syntheticMp4(60, 2_000))).statusCode).toBe(507);
    // Sessions do not belong to an online program.
    actAs("hc", HC);
    const session = await call("POST", `/admin/training/programs/${second.programId}/sessions`, {
      title: "Sesi", startAt: "2030-01-01T08:00:00+07:00", endAt: "2030-01-01T10:00:00+07:00",
    });
    expect(session.json().code).toBe("TRAINING_ONLINE_NO_SESSIONS");
  });

  it("TRAIN-R4-C/D/E/F: enrolled-only range streaming, server credit, quiz, record and yearly hours", async () => {
    const { programId, moduleId, video, text } = await onlineProgram();
    expect((await upload(video, syntheticMp4(100, 5_000))).statusCode).toBe(200);
    actAs("hc", HC);
    const quizInstrument = await call("POST", "/admin/training/instruments", {
      kind: "TEST", title: "Kuis SOP",
      items: [{ type: "TRUE_FALSE", prompt: "Kuitansi wajib dilampirkan.", correct: true }, { type: "SINGLE", prompt: "Batas?", options: ["1 hari", "3 hari"], correct: 1 }],
    });
    expect((await call("PATCH", `/admin/training/modules/${moduleId}`, { quizInstrumentId: quizInstrument.json().id, quizPassingScore: 100 })).statusCode).toBe(200);
    expect((await call("POST", `/admin/training/modules/${moduleId}/publish`)).statusCode).toBe(200);

    // Only enrolled participants get a watch session.
    actAs("outsider");
    expect((await call("POST", `/training/me/materials/${video}/playbacks`)).statusCode).toBe(404);
    actAs("aisyah");
    const playback = await call("POST", `/training/me/materials/${video}/playbacks`);
    expect(playback.statusCode, playback.body).toBe(201);
    const { playbackId, streamUrl } = playback.json() as { playbackId: string; streamUrl: string };
    const url = streamUrl.replace(/^\/api/, "");
    expect((await call("GET", url)).statusCode).toBe(416);
    const part = await call("GET", url, undefined, { range: "bytes=0-99" });
    expect(part.statusCode).toBe(206);
    expect(part.headers["content-range"]).toMatch(/^bytes 0-99\/\d+$/);
    expect(part.headers["cache-control"]).toBe("private, no-store");
    expect(part.headers["content-disposition"]).toBe("inline");
    expect(part.rawPayload.subarray(4, 8).toString("latin1")).toBe("ftyp");
    actAs("bilal");
    expect((await call("GET", url, undefined, { range: "bytes=0-99" })).statusCode).toBe(404);

    // Credit: a jump to the end earns only real time; honest heartbeats earn their seconds.
    actAs("aisyah");
    const beat = async (position: number, secondsAgo: number) => {
      await client.query(`UPDATE training_playbacks SET last_heartbeat_at = clock_timestamp() - ($2 || ' seconds')::interval WHERE id = $1`,
        [playbackId, String(secondsAgo)]);
      return (await call("POST", `/training/me/playbacks/${playbackId}/heartbeat`, { position })).json();
    };
    // 10 s × 1.25 + 2 s from 0 (plus the few milliseconds the request itself takes).
    const jumped = await beat(99, 10);
    expect(jumped.completed).toBe(false);
    expect(jumped.creditedSeconds).toBeGreaterThanOrEqual(14.5);
    expect(jumped.creditedSeconds).toBeLessThan(15);
    // The previous report (99) was past the frontier: skipping earns nothing until watched back.
    expect((await beat(99, 10)).creditedSeconds).toBe(jumped.creditedSeconds);
    await beat(14, 1);
    let state = { creditedSeconds: 0, completed: false };
    for (let position = 24; position < 110; position += 10) state = await beat(Math.min(position, 100), 10);
    expect(state).toMatchObject({ completed: true });

    // The quiz opens only after every material; the reading is still open.
    expect((await call("GET", `/training/me/modules/${moduleId}/quiz`)).json().code).toBe("TRAINING_QUIZ_LOCKED");
    expect((await call("POST", `/training/me/materials/${text}/read`)).json()).toMatchObject({ completed: true, programCompleted: false });
    const quiz = await call("GET", `/training/me/modules/${moduleId}/quiz`);
    expect(quiz.statusCode, quiz.body).toBe(200);
    expect(quiz.body).not.toContain("correct");
    const wrong = await call("POST", `/training/me/modules/${moduleId}/quiz/attempts`, { answers: { q1: true, q2: 0 } });
    expect(wrong.json()).toMatchObject({ score: 50, passed: false, attemptsLeft: 2, programCompleted: false });
    const right = await call("POST", `/training/me/modules/${moduleId}/quiz/attempts`, { answers: { q1: true, q2: 1 } });
    expect(right.json()).toMatchObject({ score: 100, passed: true, best: 100, programCompleted: true });

    const record = await client.query(
      `SELECT hours::float8 AS hours, status, completed, source FROM training_records WHERE program_id = $1 AND employee_id = $2`,
      [programId, people.aisyah.employeeId],
    );
    expect(record.rows).toEqual([{ hours: 1.5, status: "VERIFIED", completed: true, source: "INTERNAL" }]);
    const summary = await call("GET", "/training/me/summary");
    expect(summary.json()).toMatchObject({ internalHours: 1.5, recordCount: 1 });
    const modules = await call("GET", `/training/me/programs/${programId}/modules`);
    expect(modules.json().items[0]).toMatchObject({ completed: true, quiz: { passed: true, best: 100 } });

    // A newer watch session ends the older one.
    const again = (await call("POST", `/training/me/materials/${video}/playbacks`)).json().playbackId as string;
    expect(again).not.toBe(playbackId);
    expect((await call("POST", `/training/me/playbacks/${playbackId}/heartbeat`, { position: 5 })).json().code).toBe("TRAINING_PLAYBACK_ENDED");

    // Closing the program leaves unfinished participants INCOMPLETE without a record.
    actAs("hc", HC);
    expect((await call("POST", `/admin/training/programs/${programId}/participants`, { employeeIds: [people.bilal.employeeId] })).statusCode).toBe(200);
    expect((await call("POST", `/admin/training/programs/${programId}/complete`)).statusCode).toBe(200);
    const statuses = await client.query(`SELECT employee_id, status FROM training_participants WHERE program_id = $1 ORDER BY status`, [programId]);
    expect(statuses.rows.map((row) => row.status)).toEqual(["COMPLETED", "INCOMPLETE"]);
  });

  it("TRAIN-R4-G: HC marks a material complete only with a reason, audited", async () => {
    const { moduleId, video, text } = await onlineProgram();
    expect((await upload(video, syntheticMp4(60))).statusCode).toBe(200);
    expect((await call("POST", `/admin/training/modules/${moduleId}/publish`)).statusCode).toBe(200);
    expect((await call("POST", `/admin/training/materials/${video}/progress/${people.aisyah.employeeId}/complete`, {})).statusCode).toBe(400);
    const done = await call("POST", `/admin/training/materials/${video}/progress/${people.aisyah.employeeId}/complete`, { reason: "Gangguan pemutar di perangkat peserta" });
    expect(done.json()).toMatchObject({ completed: true, programCompleted: false });
    actAs("aisyah");
    expect((await call("POST", `/training/me/materials/${text}/read`)).json().programCompleted).toBe(true);
    const audit = await client.query(`SELECT note, metadata FROM training_audit_events WHERE event_type = 'training.material.completed' ORDER BY occurred_at`);
    expect(audit.rows[0]).toMatchObject({ note: "Gangguan pemutar di perangkat peserta", metadata: { via: "HC_MANUAL" } });
    actAs("hc", ["training.read"]);
    const progress = await call("GET", `/admin/training/programs/${(await client.query(`SELECT program_id FROM training_modules WHERE id = $1`, [moduleId])).rows[0].program_id}/online-progress`);
    expect(progress.json().items[0]).toMatchObject({ participantStatus: "COMPLETED", completedMaterials: 2, materialCount: 2 });
    expect((await call("PUT", `/admin/training/materials/${video}/video`, syntheticMp4(60), { "content-type": "video/mp4" })).statusCode).toBe(403);
  });
});
