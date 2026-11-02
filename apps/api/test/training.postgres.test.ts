// TRAIN-001 Package 1 acceptance against a real schema.
// Synthetic employees only; every test runs inside one rolled-back transaction.

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import { registerTrainingRoutes } from "../src/modules/training/routes.js";

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

function addDays(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** `HH:MM` on a WIB date as an ISO instant with offset. */
function wib(date: string, time: string): string {
  return `${date}T${time}:00+07:00`;
}

const PDF = Buffer.from("%PDF-1.4\nSertifikat sintetis TRAIN-001\n%%EOF").toString("base64");
const HC = ["training.read", "training.manage"];

describe.skipIf(!allowed)("TRAIN-001 training records", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let principal: AuthPrincipal;
  let permissions: string[];
  const people = {} as Record<"hc" | "aisyah" | "bilal" | "citra" | "speaker" | "outsider", { employeeId: string; accountId: string }>;
  const today = jakartaToday();
  const future = addDays(today, 10);
  const past = addDays(today, -10);

  async function insertEmployee(name: string) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO employees(id, employee_number, full_name, status, started_on) VALUES ($1,$2,$3,'active','2020-01-06')`,
      [id, `TRN-${id.slice(0, 8)}`, name],
    );
    return id;
  }

  async function insertAccount(employeeId: string) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1,$2,$3,'EMPLOYEE','active')`,
      [id, employeeId, `train-${id}@example.invalid`],
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

  async function program(title = "Tahsin Guru Angkatan 1", extra: Record<string, unknown> = {}) {
    actAs("hc", HC);
    const response = await call("POST", "/admin/training/programs", { title, category: "QURANIC", ...extra });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as string;
  }

  async function session(programId: string, date: string, from: string, to: string, extra: Record<string, unknown> = {}) {
    actAs("hc", HC);
    return call("POST", `/admin/training/programs/${programId}/sessions`, {
      title: `Sesi ${from}`, startAt: wib(date, from), endAt: wib(date, to), ...extra,
    });
  }

  async function enroll(programId: string, ...who: Array<keyof typeof people>) {
    actAs("hc", HC);
    return call("POST", `/admin/training/programs/${programId}/participants`, {
      employeeIds: who.map((key) => people[key].employeeId),
    });
  }

  async function events(type: string) {
    return (await client.query<{ actor: string | null }>(
      `SELECT actor_account_id AS actor FROM training_audit_events WHERE event_type = $1`, [type],
    )).rows;
  }

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    for (const key of ["hc", "aisyah", "bilal", "citra", "speaker", "outsider"] as const) {
      const employeeId = await insertEmployee(`Pegawai ${key}`);
      people[key] = { employeeId, accountId: await insertAccount(employeeId) };
    }
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

  it("TRAIN-001-A/B: participants see their program; others get 404; admin needs training.*", async () => {
    const id = await program();
    expect((await session(id, future, "08:00", "10:00")).statusCode).toBe(201);
    expect((await enroll(id, "aisyah")).statusCode).toBe(200);

    actAs("aisyah");
    const mine = await call("GET", "/training/me/programs");
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json().items.map((item: { id: string }) => item.id)).toEqual([id]);
    const detail = await call("GET", `/training/me/programs/${id}`);
    expect(detail.json().sessions).toHaveLength(1);
    expect(detail.json().participantStatus).toBe("ENROLLED");

    actAs("outsider");
    expect((await call("GET", `/training/me/programs/${id}`)).statusCode).toBe(404);
    expect((await call("GET", "/admin/training/programs")).statusCode).toBe(403);

    actAs("hc", ["training.read"]);
    expect((await call("GET", "/admin/training/programs")).json().pagination.total).toBeGreaterThanOrEqual(1);
    expect((await call("POST", `/admin/training/programs/${id}/cancel`, { reason: "Tidak jadi diadakan" })).statusCode).toBe(403);
  });

  it("TRAIN-001-C: blocks other training, approved leave and approved trips; warns on pending ones", async () => {
    const first = await program("Pedagogi Dasar");
    expect((await session(first, future, "08:00", "10:00")).statusCode).toBe(201);
    expect((await enroll(first, "aisyah")).statusCode).toBe(200);

    // Another program at the same time cannot take Aisyah.
    const second = await program("Pengasuhan Asrama");
    expect((await session(second, future, "09:00", "11:00")).statusCode).toBe(201);
    const clash = await enroll(second, "aisyah");
    expect(clash.statusCode, clash.body).toBe(409);
    expect(clash.json().code).toBe("TRAINING_CONFLICT");
    expect(clash.json().conflicts[0]).toMatchObject({ employeeId: people.aisyah.employeeId, reason: "IN_TRAINING" });

    // Touching is not overlapping.
    const third = await program("SOP Keuangan");
    expect((await session(third, future, "10:00", "11:00")).statusCode).toBe(201);
    expect((await enroll(third, "aisyah")).statusCode).toBe(200);

    // Approved leave blocks; leave in review only warns.
    await client.query(
      `INSERT INTO leave_requests(id, employee_id, policy_key, status, start_on, end_on, working_days, hc_handling, idempotency_key)
       VALUES ($1,$2,'annual','approved',$3,$3,1,'none',$4), ($5,$6,'annual','in_review',$3,$3,1,'none',$7)`,
      [randomUUID(), people.bilal.employeeId, future, randomUUID(), randomUUID(), people.citra.employeeId, randomUUID()],
    );
    const leave = await enroll(first, "bilal");
    expect(leave.statusCode).toBe(409);
    expect(leave.json().conflicts[0]).toMatchObject({ reason: "ON_LEAVE", title: null });
    const pending = await enroll(first, "citra");
    expect(pending.statusCode, pending.body).toBe(200);
    expect(pending.json().warnings.map((item: { reason: string }) => item.reason)).toEqual(["LEAVE_PENDING"]);

    // Moving a session onto an approved trip of an enrolled participant is refused.
    await client.query(
      `INSERT INTO business_trip_requests(id, employee_id, destination, purpose, start_on, end_on, status, idempotency_key)
       VALUES ($1,$2,'Bandung','Rapat koordinasi mitra',$3,$3,'APPROVED',$4)`,
      [randomUUID(), people.aisyah.employeeId, addDays(future, 1), randomUUID()],
    );
    const sessions = await call("GET", `/admin/training/programs/${first}`);
    const sessionId = sessions.json().sessions[0].id as string;
    const moved = await call("PATCH", `/admin/training/sessions/${sessionId}`, {
      startAt: wib(addDays(future, 1), "08:00"), endAt: wib(addDays(future, 1), "10:00"),
    });
    expect(moved.statusCode, moved.body).toBe(409);
    expect(moved.json().conflicts.map((item: { reason: string }) => item.reason)).toEqual(["ON_TRIP"]);

    // The preview reports the same without saving.
    const preview = await call("POST", "/admin/training/availability", {
      programId: first, startAt: wib(addDays(future, 1), "08:00"), endAt: wib(addDays(future, 1), "10:00"),
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().blocks.map((item: { reason: string }) => item.reason)).toEqual(["ON_TRIP"]);

    // An internal speaker is checked too.
    const speakerClash = await session(second, future, "08:30", "09:00", { speakerEmployeeId: people.aisyah.employeeId });
    expect(speakerClash.statusCode).toBe(409);
  });

  it("TRAIN-001-C §7.1: a blocking CAL-001 meeting refuses the session; a confidential one hides its title", async () => {
    // Before CAL-001 migration 0117 lands, stand in for its two tables with only the columns
    // TRAIN-001 reads; afterwards the real tables take the same rows.
    const present = (await client.query<{ present: boolean }>(
      `SELECT to_regclass('public.meeting_participants') IS NOT NULL AS present`,
    )).rows[0]!.present;
    if (!present) {
      await client.query(`CREATE TABLE meetings (
        id uuid PRIMARY KEY, organizer_employee_id uuid, title text, start_at timestamptz, end_at timestamptz,
        status text, confidential boolean, idempotency_key uuid, created_by_account_id uuid)`);
      await client.query(`CREATE TABLE meeting_participants (
        meeting_id uuid, employee_id uuid, role text, response text, busy tstzrange, blocks_time boolean)`);
    }
    const meeting = async (title: string, confidential: boolean, from: string, to: string) => {
      const id = randomUUID();
      await client.query(
        `INSERT INTO meetings(id, organizer_employee_id, title, start_at, end_at, status, confidential, idempotency_key, created_by_account_id)
         VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6,$7,$8)`,
        [id, people.aisyah.employeeId, title, wib(future, from), wib(future, to), confidential, randomUUID(), people.aisyah.accountId],
      );
      await client.query(
        `INSERT INTO meeting_participants(meeting_id, employee_id, role, response, busy, blocks_time)
         VALUES ($1,$2,'ORGANIZER','ACCEPTED',tstzrange($3::timestamptz,$4::timestamptz,'[)'),true)`,
        [id, people.aisyah.employeeId, wib(future, from), wib(future, to)],
      );
    };
    await meeting("Rapat Kurikulum", false, "08:00", "09:00");
    await meeting("Rapat Rahasia", true, "13:00", "14:00");

    const id = await program("Kajian Pegawai");
    expect((await enroll(id, "aisyah")).statusCode).toBe(200);
    const open = await session(id, future, "08:30", "10:00");
    expect(open.statusCode).toBe(409);
    expect(open.json().conflicts[0]).toMatchObject({ reason: "MEETING_OVERLAP", title: "Rapat Kurikulum" });
    const secret = await session(id, future, "13:30", "15:00");
    expect(secret.json().conflicts[0]).toMatchObject({ reason: "MEETING_OVERLAP", title: null });
    expect((await session(id, future, "09:00", "10:00")).statusCode).toBe(201);
  });

  it("review fixes: program-internal overlap, partial session edit, departed participants, hours of leavers", async () => {
    const id = await program("Orientasi Pegawai Baru");
    const first = await session(id, future, "08:00", "10:00", { location: "Aula" });
    expect(first.statusCode).toBe(201);
    // Two sessions of one program never overlap, even with nobody enrolled yet.
    expect((await session(id, future, "09:00", "11:00")).json().code).toBe("TRAINING_SESSION_OVERLAP");
    expect((await session(id, future, "10:00", "11:00")).statusCode).toBe(201);

    // A title-only edit keeps the location.
    expect((await call("PATCH", `/admin/training/sessions/${first.json().id}`, { title: "Sesi pembuka" })).statusCode).toBe(200);
    const kept = await client.query<{ location: string | null }>(`SELECT location FROM training_sessions WHERE id = $1`, [first.json().id]);
    expect(kept.rows[0]!.location).toBe("Aula");

    // A participant who later leaves does not block rescheduling.
    expect((await enroll(id, "aisyah", "bilal")).statusCode).toBe(200);
    await client.query(`UPDATE employees SET status = 'inactive' WHERE id = $1`, [people.bilal.employeeId]);
    const moved = await call("PATCH", `/admin/training/sessions/${first.json().id}`, {
      startAt: wib(addDays(future, 2), "08:00"), endAt: wib(addDays(future, 2), "10:00"),
    });
    expect(moved.statusCode, moved.body).toBe(200);

    // Verified hours of someone who has left still appear in that year's summary.
    await client.query(
      `INSERT INTO training_records(id, employee_id, source, role, title, category, organizer, start_on, end_on, hours, status, idempotency_key)
       VALUES ($1,$2,'EXTERNAL','PARTICIPANT','Seminar Lama','OTHER','Mitra',$3,$3,4,'VERIFIED',$4)`,
      [randomUUID(), people.bilal.employeeId, past, randomUUID()],
    );
    const hours = await call("GET", `/admin/training/hours?year=${past.slice(0, 4)}&q=Pegawai bilal`);
    expect(hours.json().items).toEqual([expect.objectContaining({ employeeId: people.bilal.employeeId, totalHours: 4 })]);
  });

  it("review fixes: a 2 MB certificate fits the body limit and any filename downloads", async () => {
    actAs("aisyah");
    const big = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(2_000_000, 0x20)]).toString("base64");
    const created = await call("POST", "/training/me/records", {
      title: "Diklat Panjang", category: "OTHER", organizer: "Lembaga Mitra",
      startOn: addDays(today, -3), endOn: addDays(today, -3), hours: 8, idempotencyKey: randomUUID(),
      certificate: { fileName: "Sertifikat – تحفيظ.pdf", contentType: "application/pdf", contentBase64: big },
    });
    expect(created.statusCode, created.body.slice(0, 200)).toBe(201);
    const download = await call("GET", `/training/me/records/${created.json().id}/certificate`);
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toContain("filename*=UTF-8''Sertifikat%20%E2%80%93");
    expect(download.rawPayload.length).toBe(2_000_009);
  });

  it("TRAIN-001-D/E: capacity, and attendance only for enrolled participants after the start", async () => {
    const id = await program("Orientasi", { capacity: 1 });
    const upcoming = await session(id, future, "08:00", "09:00");
    expect((await enroll(id, "aisyah")).statusCode).toBe(200);
    const full = await enroll(id, "bilal");
    expect(full.statusCode).toBe(409);
    expect(full.json().code).toBe("TRAINING_CAPACITY_FULL");

    const early = await call("PUT", `/admin/training/sessions/${upcoming.json().id}/attendance`, {
      entries: [{ employeeId: people.aisyah.employeeId, status: "PRESENT" }],
    });
    expect(early.json().code).toBe("TRAINING_SESSION_NOT_STARTED");

    const held = await session(id, past, "08:00", "09:00");
    expect(held.statusCode, held.body).toBe(201);
    const stranger = await call("PUT", `/admin/training/sessions/${held.json().id}/attendance`, {
      entries: [{ employeeId: people.bilal.employeeId, status: "PRESENT" }],
    });
    expect(stranger.json().code).toBe("TRAINING_NOT_PARTICIPANT");
  });

  it("TRAIN-001-F/G/J/K: closing computes hours, creates records, locks the program and frees time", async () => {
    const id = await program("Tahsin Guru");
    // Sessions recorded after the fact (D-04): 8 hours with an internal speaker, then 2 hours.
    const s1 = await session(id, addDays(past, -1), "08:00", "16:00", { speakerEmployeeId: people.speaker.employeeId });
    const s2 = await session(id, past, "08:00", "10:00");
    expect([s1.statusCode, s2.statusCode]).toEqual([201, 201]);
    expect((await enroll(id, "aisyah", "bilal", "citra")).statusCode).toBe(200);

    const mark = (sessionId: string, entries: Array<[keyof typeof people, string]>) =>
      call("PUT", `/admin/training/sessions/${sessionId}/attendance`, {
        entries: entries.map(([who, status]) => ({ employeeId: people[who].employeeId, status })),
      });
    expect((await mark(s1.json().id, [["aisyah", "PRESENT"], ["bilal", "ABSENT"], ["citra", "ABSENT"]])).statusCode).toBe(200);
    const early = await call("POST", `/admin/training/programs/${id}/complete`);
    expect(early.json()).toMatchObject({ code: "TRAINING_ATTENDANCE_INCOMPLETE", missing: 3 });
    expect((await mark(s2.json().id, [["aisyah", "PRESENT"], ["bilal", "PRESENT"], ["citra", "EXCUSED"]])).statusCode).toBe(200);

    const done = await call("POST", `/admin/training/programs/${id}/complete`);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ status: "COMPLETED", totalHours: 10, records: 3 });

    const records = (await client.query<{ employeeId: string; role: string; hours: string; completed: boolean | null }>(
      `SELECT employee_id AS "employeeId", role, hours::text AS hours, completed FROM training_records WHERE program_id = $1`, [id],
    )).rows;
    const byId = (key: keyof typeof people, role = "PARTICIPANT") =>
      records.find((row) => row.employeeId === people[key].employeeId && row.role === role);
    expect(byId("aisyah")).toMatchObject({ hours: "10.00", completed: true });
    expect(byId("bilal")).toMatchObject({ hours: "2.00", completed: false });
    expect(byId("citra")).toBeUndefined();
    expect(byId("speaker", "SPEAKER")).toMatchObject({ hours: "8.00", completed: null });

    actAs("aisyah");
    const summary = await call("GET", `/training/me/summary?year=${addDays(past, -1).slice(0, 4)}`);
    expect(summary.json()).toMatchObject({ totalHours: 10, internalHours: 10, recordCount: 1 });

    actAs("hc", HC);
    const hours = await call("GET", `/admin/training/hours?year=${past.slice(0, 4)}&q=Pegawai citra`);
    expect(hours.json().items).toEqual([expect.objectContaining({ employeeId: people.citra.employeeId, totalHours: 0 })]);

    // Locked (D-12).
    expect((await enroll(id, "outsider")).json().code).toBe("TRAINING_PROGRAM_CLOSED");
    expect((await call("POST", `/admin/training/programs/${id}/cancel`, { reason: "Salah input program" })).statusCode).toBe(409);

    // Cancelling another program frees its participants' time (D-13).
    const other = await program("Workshop Asesmen");
    await session(other, future, "13:00", "15:00");
    await enroll(other, "bilal");
    const busyBefore = await client.query(`SELECT 1 FROM training_employee_busy WHERE program_id = $1`, [other]);
    expect(busyBefore.rowCount).toBe(1);
    expect((await call("POST", `/admin/training/programs/${other}/cancel`, { reason: "Narasumber berhalangan hadir" })).statusCode).toBe(200);
    expect((await client.query(`SELECT 1 FROM training_employee_busy WHERE program_id = $1`, [other])).rowCount).toBe(0);

    expect(await events("training.program.completed")).toEqual([{ actor: people.hc.accountId }]);
    expect((await events("training.record.created")).length).toBe(3);
  });

  it("TRAIN-001-H/I: external records, idempotent replay, verification and private certificates", async () => {
    actAs("aisyah");
    const base = {
      title: "Diklat Tahfidz Nasional", category: "QURANIC", organizer: "Lembaga Mitra",
      startOn: addDays(today, -5), endOn: addDays(today, -4), hours: 16, idempotencyKey: randomUUID(),
    };
    expect((await call("POST", "/training/me/records", { ...base, endOn: addDays(today, 1), idempotencyKey: randomUUID() })).json().code)
      .toBe("TRAINING_RECORD_FUTURE");
    const fake = await call("POST", "/training/me/records", {
      ...base, idempotencyKey: randomUUID(), certificate: { fileName: "a.png", contentType: "image/png", contentBase64: PDF },
    });
    expect(fake.json().code).toBe("CERTIFICATE_TYPE_MISMATCH");

    const created = await call("POST", "/training/me/records", {
      ...base, certificate: { fileName: "sertifikat.pdf", contentType: "application/pdf", contentBase64: PDF },
    });
    expect(created.statusCode, created.body).toBe(201);
    const recordId = created.json().id as string;
    const replay = await call("POST", "/training/me/records", base);
    expect(replay.json()).toMatchObject({ id: recordId, idempotentReplay: true });

    const stored = await client.query<{ ciphertext: string }>(`SELECT ciphertext FROM training_certificates WHERE record_id = $1`, [recordId]);
    expect(stored.rows[0]!.ciphertext).not.toContain("PDF");
    const download = await call("GET", `/training/me/records/${recordId}/certificate`);
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.toString("base64")).toBe(PDF);
    expect(download.headers["cache-control"]).toBe("private, no-store");

    actAs("bilal");
    expect((await call("GET", `/training/me/records/${recordId}/certificate`)).statusCode).toBe(404);
    expect((await call("POST", `/training/me/records/${recordId}/withdraw`)).statusCode).toBe(404);

    actAs("hc", ["training.read"]);
    expect((await call("GET", `/admin/training/records/${recordId}/certificate`)).statusCode).toBe(200);
    const queue = await call("GET", "/admin/training/records?status=SUBMITTED");
    expect(queue.json().items.map((item: { id: string }) => item.id)).toContain(recordId);

    actAs("hc", HC);
    expect((await call("POST", `/admin/training/records/${recordId}/verify`)).statusCode).toBe(200);
    expect((await call("POST", `/admin/training/records/${recordId}/verify`)).json().code).toBe("TRAINING_RECORD_NOT_PENDING");
    const detail = await call("GET", `/admin/training/records/${recordId}`);
    expect(detail.json().events.map((event: { eventType: string }) => event.eventType))
      .toEqual(["training.record.submitted", "training.certificate.uploaded", "training.record.verified"]);

    actAs("aisyah");
    expect((await call("POST", `/training/me/records/${recordId}/certificate`, {
      fileName: "baru.pdf", contentType: "application/pdf", contentBase64: PDF,
    })).json().code).toBe("TRAINING_RECORD_NOT_EDITABLE");
    expect((await call("GET", "/training/me/summary")).json().externalHours).toBe(Number(today.slice(0, 4)) === Number(base.endOn.slice(0, 4)) ? 16 : 0);

    const second = await call("POST", "/training/me/records", { ...base, title: "Seminar Parenting", idempotencyKey: randomUUID() });
    actAs("hc", HC);
    expect((await call("POST", `/admin/training/records/${second.json().id}/reject`, { reason: "x" })).statusCode).toBe(400);
    expect((await call("POST", `/admin/training/records/${second.json().id}/reject`, { reason: "Sertifikat belum ada" })).statusCode).toBe(200);
    const notice = await client.query(
      `SELECT 1 FROM in_app_notifications WHERE event_key = $1`, [`training.record.${second.json().id}.rejected`],
    );
    expect(notice.rowCount).toBe(1);
  });
});
