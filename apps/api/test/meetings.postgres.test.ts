// CAL-001 Package 1 acceptance against a real schema. Synthetic employees only. The first
// suite runs every test inside one rolled-back transaction; the second commits on purpose,
// because a race (CAL-001-F, two runners) needs two real connections, and cleans up after.

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import { registerMeetingRoutes } from "../src/modules/meetings/routes.js";
import { MeetingRunner } from "../src/modules/meetings/runner.js";
import {
  ClientCredentialsTokenProvider,
  KirimWhatsAppSender,
  LogWhatsAppSender,
  type FetchLike,
} from "../src/modules/meetings/whatsapp.js";

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

function jakartaDate(offsetDays: number): string {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const base = new Date(`${today}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + offsetDays);
  return base.toISOString().slice(0, 10);
}

/** An instant on a WIB date, `HH:MM`. */
function at(date: string, time: string): string {
  return new Date(`${date}T${time}:00+07:00`).toISOString();
}

const config = { NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8 } as ApiConfig;
type Who = "organizer" | "alice" | "bob" | "outsider" | "noAccount";
type Person = { employeeId: string; accountId: string | null; name: string };

async function seedPeople(db: { query: Pool["query"] }, tag: string) {
  const people = {} as Record<Who, Person>;
  const unitId = randomUUID();
  await db.query(
    "INSERT INTO organizational_units(id, normalized_name, name) VALUES ($1,$2,'Unit Rapat Sintetis')",
    [unitId, `unit-meeting-${unitId}`],
  );
  const phones: Record<Who, string | null> = {
    organizer: "081200000001", alice: "081200000002", bob: null, outsider: "081200000004", noAccount: "081200000005",
  };
  for (const who of ["organizer", "alice", "bob", "outsider", "noAccount"] as const) {
    const employeeId = randomUUID();
    const name = `${tag} ${who}`;
    await db.query(
      `INSERT INTO employees(id, employee_number, full_name, status, started_on, organizational_unit_id, phone)
       VALUES ($1,$2,$3,'active','2020-01-06',$4,$5)`,
      [employeeId, `CAL-${employeeId.slice(0, 8)}`, name, unitId, phones[who]],
    );
    let accountId: string | null = null;
    if (who !== "noAccount") {
      accountId = randomUUID();
      await db.query(
        `INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1,$2,$3,'EMPLOYEE','active')`,
        [accountId, employeeId, `cal-${accountId}@example.invalid`],
      );
    }
    people[who] = { employeeId, accountId, name };
  }
  return { people, unitId };
}

describe.skipIf(!allowed)("CAL-001 meeting calendar (PostgreSQL)", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let principal: AuthPrincipal;
  let people: Record<Who, Person>;
  const day = jakartaDate(2);

  function actAs(who: Who) {
    principal = { id: people[who].accountId!, email: `${who}@example.invalid`, principalType: "EMPLOYEE" };
  }

  async function create(overrides: Record<string, unknown> = {}, who: Who = "organizer", key = randomUUID()) {
    actAs(who);
    return app.inject({
      method: "POST",
      url: "/me/meetings",
      headers: { "idempotency-key": key },
      payload: {
        title: "Rapat kurikulum tahfidz",
        description: "Agenda: evaluasi setoran hafalan",
        location: "Ruang guru",
        startAt: at(day, "09:00"),
        endAt: at(day, "10:00"),
        participantEmployeeIds: [people.alice.employeeId, people.bob.employeeId],
        ...overrides,
      },
    });
  }

  async function created(overrides: Record<string, unknown> = {}, who: Who = "organizer") {
    const response = await create(overrides, who);
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string; version: number; warnings: Array<{ reason: string }>; whatsappWithoutNumber: string[] };
  }

  async function respond(id: string, who: Who, response: "ACCEPTED" | "DECLINED", note?: string) {
    actAs(who);
    return app.inject({ method: "POST", url: `/me/meetings/${id}/response`, payload: { response, note } });
  }

  async function detail(id: string, who: Who) {
    actAs(who);
    return app.inject({ method: "GET", url: `/me/meetings/${id}` });
  }

  async function events(id: string) {
    const result = await client.query<{ eventType: string }>(
      `SELECT event_type AS "eventType" FROM meeting_events WHERE meeting_id = $1 ORDER BY occurred_at, id`, [id],
    );
    return result.rows.map((row) => row.eventType);
  }

  async function notifications(who: Who) {
    const result = await client.query<{ title: string; eventKey: string }>(
      `SELECT title, event_key AS "eventKey" FROM in_app_notifications WHERE recipient_account_id = $1 ORDER BY created_at, id`,
      [people[who].accountId],
    );
    return result.rows;
  }

  async function deliveries(id: string) {
    const result = await client.query<{ employeeId: string; event: string; status: string; idempotencyKey: string; errorCode: string | null }>(
      `SELECT employee_id AS "employeeId", event, status, idempotency_key AS "idempotencyKey", error_code AS "errorCode"
         FROM meeting_notification_deliveries WHERE meeting_id = $1 ORDER BY created_at, id`,
      [id],
    );
    return result.rows;
  }

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    ({ people } = await seedPeople(client, `Rapat ${randomUUID().slice(0, 6)}`));
    actAs("organizer");
    app = Fastify({ logger: false });
    await registerMeetingRoutes(app, savepointPool(client), config, {
      getSession: async () => ({ principal, expiresAt: "2099-01-01T00:00:00Z" }),
    } as never);
  });

  afterEach(async () => {
    try { await app?.close(); } finally {
      if (client) { await client.query("ROLLBACK"); client.release(); }
    }
  });

  it("CAL-001-A/J: creates a meeting, notifies attendees in-app, queues WhatsApp, schedules reminders, replays the key", async () => {
    const key = randomUUID();
    const first = await create({ participantEmployeeIds: [people.alice.employeeId, people.bob.employeeId, people.noAccount.employeeId] }, "organizer", key);
    expect(first.statusCode, first.body).toBe(201);
    const meeting = first.json() as { id: string; version: number; whatsappWithoutNumber: string[] };
    expect(meeting.version).toBe(1);
    // Bob has no phone: skipped for WhatsApp and reported to the organizer.
    expect(meeting.whatsappWithoutNumber).toEqual([people.bob.employeeId]);

    expect((await notifications("alice")).map((row) => row.title)).toEqual(["Undangan rapat"]);
    expect((await notifications("bob")).map((row) => row.title)).toEqual(["Undangan rapat"]);
    expect(await notifications("organizer")).toEqual([]);
    expect(await events(meeting.id)).toEqual(["meeting.created"]);

    const queued = await deliveries(meeting.id);
    expect(queued.map((row) => [row.employeeId, row.event, row.status]).sort()).toEqual([
      [people.alice.employeeId, "invited", "QUEUED"],
      [people.noAccount.employeeId, "invited", "QUEUED"],
    ].sort());
    expect(queued[0]!.idempotencyKey).toMatch(new RegExp(`^cal:${meeting.id}:[0-9a-f-]+:invited:1$`));

    const reminders = await client.query(`SELECT employee_id FROM meeting_reminders WHERE meeting_id = $1`, [meeting.id]);
    expect(reminders.rowCount).toBe(4);

    const replay = await create({}, "organizer", key);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ id: meeting.id, idempotentReplay: true });

    const view = await detail(meeting.id, "organizer");
    expect(view.statusCode, view.body).toBe(200);
    const body = view.json();
    expect(body).toMatchObject({ canEdit: true, canCancel: true, canRespond: false, me: { role: "ORGANIZER", response: "ACCEPTED" } });
    const noAccount = body.participants.find((row: { employeeId: string }) => row.employeeId === people.noAccount.employeeId);
    expect(noAccount).toMatchObject({ hasAccount: false, hasWhatsApp: true, response: "PENDING" });
    expect(body.participants.find((row: { employeeId: string }) => row.employeeId === people.bob.employeeId)).toMatchObject({ hasWhatsApp: false });
  });

  it("refuses a missing key, an inactive participant, the organizer as participant and a past start", async () => {
    actAs("organizer");
    const noKey = await app.inject({ method: "POST", url: "/me/meetings", payload: {} });
    expect(noKey.json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    await client.query("UPDATE employees SET status = 'inactive' WHERE id = $1", [people.bob.employeeId]);
    expect((await create()).json()).toMatchObject({ code: "PARTICIPANT_NOT_ACTIVE", employeeIds: [people.bob.employeeId] });
    expect((await create({ participantEmployeeIds: [people.organizer.employeeId] })).json().code).toBe("INVALID_MEETING");
    expect((await create({ startAt: at(jakartaDate(-1), "09:00"), endAt: at(jakartaDate(-1), "10:00"), participantEmployeeIds: [people.alice.employeeId] })).json().code)
      .toBe("MEETING_START_IN_PAST");
  });

  it("CAL-001-B/C: blocks an overlap of any participant or the organizer, accepts touching meetings", async () => {
    const first = await created({ participantEmployeeIds: [people.alice.employeeId] });
    // Bob invites Alice at 09:30: Alice is busy.
    const clash = await create({ startAt: at(day, "09:30"), endAt: at(day, "10:30"), participantEmployeeIds: [people.alice.employeeId] }, "bob");
    expect(clash.statusCode).toBe(409);
    expect(clash.json()).toMatchObject({ code: "MEETING_CONFLICT" });
    expect(clash.json().conflicts).toEqual([expect.objectContaining({
      employeeId: people.alice.employeeId, name: people.alice.name, reason: "MEETING_OVERLAP",
      meetingTitle: "Rapat kurikulum tahfidz", startAt: at(day, "09:00"), endAt: at(day, "10:00"),
    })]);
    expect(clash.json().message).toContain(`${people.alice.name} bentrok dengan "Rapat kurikulum tahfidz" (09:00-10:00).`);

    // The organizer is busy too.
    const own = await create({ startAt: at(day, "09:45"), endAt: at(day, "11:00"), participantEmployeeIds: [people.bob.employeeId] });
    expect(own.json().conflicts[0]).toMatchObject({ employeeId: people.organizer.employeeId, reason: "MEETING_OVERLAP" });

    // Touching 10:00 is fine.
    await created({ startAt: at(day, "10:00"), endAt: at(day, "11:00"), participantEmployeeIds: [people.alice.employeeId] }, "bob");
    expect(first.id).toBeTruthy();
  });

  it("TRAIN-001 §7.3: a scheduled training session blocks the participant", async () => {
    const programId = randomUUID();
    const sessionId = randomUUID();
    await client.query(
      `INSERT INTO training_programs(id, title, category, organizer, status, created_by_account_id)
       VALUES ($1, 'Tahsin Guru', 'QURANIC', 'Yayasan', 'ACTIVE', $2)`,
      [programId, people.organizer.accountId!],
    );
    await client.query(
      `INSERT INTO training_sessions(id, program_id, title, start_at, end_at, status) VALUES ($1, $2, 'Sesi 1', $3, $4, 'SCHEDULED')`,
      [sessionId, programId, at(day, "09:30"), at(day, "11:00")],
    );
    await client.query(
      `INSERT INTO training_participants(program_id, employee_id, status, enrolled_by_account_id) VALUES ($1, $2, 'ENROLLED', $3)`,
      [programId, people.alice.employeeId, people.organizer.accountId!],
    );
    const clash = await create({ participantEmployeeIds: [people.alice.employeeId] });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().conflicts).toEqual([expect.objectContaining({
      employeeId: people.alice.employeeId, reason: "IN_TRAINING", trainingTitle: "Tahsin Guru — Sesi 1",
    })]);
    // Withdrawn from the program: free again.
    await client.query(`UPDATE training_participants SET status = 'WITHDRAWN', withdraw_reason = 'Pindah unit' WHERE program_id = $1`, [programId]);
    expect((await create({ participantEmployeeIds: [people.alice.employeeId] })).statusCode).toBe(201);
  });

  it("CAL-001-B: hides the title of a confidential conflict unless the inviter is in that meeting", async () => {
    await created({ confidential: true, participantEmployeeIds: [people.alice.employeeId] });
    const outsider = await create({ startAt: at(day, "09:15"), endAt: at(day, "09:45"), participantEmployeeIds: [people.alice.employeeId] }, "outsider");
    expect(outsider.json().conflicts[0]).toMatchObject({ employeeId: people.alice.employeeId, meetingTitle: null });
    expect(outsider.json().conflicts[0].startAt).toBeUndefined();
    expect(outsider.body).not.toContain("Rapat kurikulum tahfidz");
    // The preview refuses past windows, which would only serve to look into someone's day.
    actAs("outsider");
    const past = await app.inject({
      method: "POST", url: "/me/meetings/availability",
      payload: { startAt: at(jakartaDate(-1), "09:00"), endAt: at(jakartaDate(-1), "10:00"), participantEmployeeIds: [people.alice.employeeId] },
    });
    expect(past.json().code).toBe("MEETING_START_IN_PAST");

    // Alice herself sees the title of her own confidential meeting.
    const inside = await create({ startAt: at(day, "09:15"), endAt: at(day, "09:45"), participantEmployeeIds: [people.bob.employeeId] }, "alice");
    expect(inside.json().conflicts[0]).toMatchObject({ employeeId: people.alice.employeeId, meetingTitle: "Rapat kurikulum tahfidz" });
  });

  it("CAL-001-D: a cancelled meeting and a declined answer free the time; taking the slot back is re-checked", async () => {
    const first = await created({ participantEmployeeIds: [people.alice.employeeId] });
    expect((await respond(first.id, "alice", "DECLINED", "Mengajar")).statusCode).toBe(200);
    expect((await notifications("organizer")).map((row) => row.title)).toEqual(["Peserta berhalangan"]);
    const reminders = await client.query(`SELECT cancelled_at FROM meeting_reminders WHERE meeting_id = $1 AND employee_id = $2`, [first.id, people.alice.employeeId]);
    expect(reminders.rows[0].cancelled_at).not.toBeNull();

    // Alice is free now; Bob books her.
    const second = await created({ participantEmployeeIds: [people.alice.employeeId] }, "bob");
    const back = await respond(first.id, "alice", "ACCEPTED");
    expect(back.statusCode).toBe(409);
    expect(back.json().conflicts[0]).toMatchObject({ reason: "MEETING_OVERLAP", meetingTitle: "Rapat kurikulum tahfidz" });

    // Bob cancels: his meeting frees everybody, and Alice can accept again.
    actAs("bob");
    const cancelled = await app.inject({ method: "POST", url: `/me/meetings/${second.id}/cancel`, payload: { reason: "Ditunda minggu depan" } });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect((await respond(first.id, "alice", "ACCEPTED")).statusCode).toBe(200);
    expect(await events(second.id)).toEqual(["meeting.created", "meeting.cancelled"]);
    expect(await events(first.id)).toEqual(["meeting.created", "meeting.participant.responded", "meeting.participant.responded"]);
    expect((await notifications("alice")).map((row) => row.title)).toContain("Rapat dibatalkan");
    // The queued invitation for the cancelled meeting is not sent any more.
    expect((await deliveries(second.id)).find((row) => row.event === "invited")).toMatchObject({ status: "SKIPPED", errorCode: "meeting_cancelled" });
  });

  it("CAL-001-E: approved leave and approved trips block; pending ones and non-working days warn", async () => {
    await client.query(
      `INSERT INTO leave_requests(id, employee_id, policy_key, status, start_on, end_on, working_days, hc_handling, idempotency_key)
       VALUES ($1,$2,'annual','approved',$3,$3,1,'none',$4), ($5,$6,'annual','in_review',$3,$3,1,'none',$7)`,
      [randomUUID(), people.alice.employeeId, day, randomUUID(), randomUUID(), people.bob.employeeId, randomUUID()],
    );
    await client.query(
      `INSERT INTO business_trip_requests(id, employee_id, destination, purpose, start_on, end_on, status, idempotency_key)
       VALUES ($1,$2,'Bandung','Rapat koordinasi mitra',$3,$3,'APPROVED',$4), ($5,$6,'Garut','Kunjungan cabang pesantren',$3,$3,'IN_REVIEW',$7)`,
      [randomUUID(), people.outsider.employeeId, day, randomUUID(), randomUUID(), people.noAccount.employeeId, randomUUID()],
    );
    const refused = await create({
      participantEmployeeIds: [people.alice.employeeId, people.bob.employeeId, people.outsider.employeeId, people.noAccount.employeeId],
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().conflicts.map((issue: { employeeId: string; reason: string }) => [issue.employeeId, issue.reason]).sort()).toEqual([
      [people.alice.employeeId, "ON_LEAVE"], [people.outsider.employeeId, "ON_TRIP"],
    ].sort());
    expect(refused.json().warnings.map((issue: { reason: string }) => issue.reason).sort()).toEqual(["LEAVE_PENDING", "TRIP_PENDING"]);
    // Neither the leave type nor the destination leaves the API.
    expect(refused.body).not.toMatch(/annual|Bandung|Garut/);

    // Every weekday a working day except the meeting's: a warning, not a refusal (K-10).
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay() || 7;
    await client.query(`UPDATE leave_calendar_settings SET working_weekday_mask = $1`, [127 & ~(1 << (weekday - 1))]);
    const ok = await created({ participantEmployeeIds: [people.bob.employeeId] });
    expect(ok.warnings.map((issue) => issue.reason).sort()).toEqual(["LEAVE_PENDING", "NON_WORKING_DAY"]);

    // The preview says the same without writing.
    actAs("organizer");
    const preview = await app.inject({
      method: "POST", url: "/me/meetings/availability",
      payload: { startAt: at(day, "13:00"), endAt: at(day, "14:00"), participantEmployeeIds: [people.alice.employeeId] },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().conflicts[0]).toMatchObject({ reason: "ON_LEAVE", message: expect.stringContaining("sedang cuti") });
  });

  it("CAL-001-G: only the organizer edits or cancels, never after the start or after cancelling", async () => {
    const meeting = await created();
    actAs("alice");
    const notMine = await app.inject({ method: "PATCH", url: `/me/meetings/${meeting.id}`, payload: { expectedVersion: 1, title: "Diubah peserta" } });
    expect(notMine.statusCode).toBe(403);
    expect(notMine.json().code).toBe("MEETING_NOT_ORGANIZER");
    actAs("outsider");
    expect((await app.inject({ method: "POST", url: `/me/meetings/${meeting.id}/cancel`, payload: { reason: "Bukan rapat saya" } })).statusCode).toBe(404);

    actAs("organizer");
    const stale = await app.inject({ method: "PATCH", url: `/me/meetings/${meeting.id}`, payload: { expectedVersion: 7, title: "Judul baru" } });
    expect(stale.json()).toMatchObject({ code: "MEETING_VERSION_CONFLICT", currentVersion: 1 });

    await client.query(`UPDATE meetings SET start_at = now() - interval '5 minutes', end_at = now() + interval '55 minutes' WHERE id = $1`, [meeting.id]);
    const started = await app.inject({ method: "PATCH", url: `/me/meetings/${meeting.id}`, payload: { expectedVersion: 1, title: "Judul baru" } });
    expect(started.json().code).toBe("MEETING_ALREADY_STARTED");
    expect((await respond(meeting.id, "alice", "DECLINED")).json().code).toBe("MEETING_ALREADY_STARTED");

    actAs("organizer");
    expect((await app.inject({ method: "POST", url: `/me/meetings/${meeting.id}/cancel`, payload: { reason: "Pemateri sakit" } })).statusCode).toBe(200);
    const again = await app.inject({ method: "POST", url: `/me/meetings/${meeting.id}/cancel`, payload: { reason: "Pemateri sakit" } });
    expect(again.json().code).toBe("MEETING_CANCELLED");
  });

  it("CAL-001-H/J: a new time resets answers and tells everyone; added and removed people are told", async () => {
    const meeting = await created();
    await respond(meeting.id, "alice", "ACCEPTED");
    await respond(meeting.id, "bob", "DECLINED");
    actAs("organizer");
    const edited = await app.inject({
      method: "PATCH", url: `/me/meetings/${meeting.id}`,
      payload: {
        expectedVersion: 1, startAt: at(day, "13:00"), endAt: at(day, "14:30"),
        participantEmployeeIds: [people.alice.employeeId, people.outsider.employeeId],
      },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().version).toBe(2);

    const responses = await client.query<{ employeeId: string; response: string; blocks: boolean }>(
      `SELECT employee_id AS "employeeId", response, blocks_time AS blocks FROM meeting_participants WHERE meeting_id = $1`, [meeting.id],
    );
    const byId = new Map(responses.rows.map((row) => [row.employeeId, row]));
    expect(byId.get(people.alice.employeeId)).toMatchObject({ response: "PENDING", blocks: true });
    expect(byId.get(people.outsider.employeeId)).toMatchObject({ response: "PENDING", blocks: true });
    expect(byId.get(people.organizer.employeeId)).toMatchObject({ response: "ACCEPTED" });
    expect(byId.has(people.bob.employeeId)).toBe(false);

    // Same transaction, same created_at: compare as sets.
    expect((await notifications("alice")).map((row) => row.title).sort()).toEqual(["Jadwal rapat berubah", "Undangan rapat"]);
    expect((await notifications("outsider")).map((row) => row.title)).toEqual(["Undangan rapat"]);
    expect((await notifications("bob")).map((row) => row.title).sort()).toEqual(["Anda tidak lagi diundang", "Undangan rapat"]);
    expect((await detail(meeting.id, "bob")).statusCode).toBe(404);
    expect(await events(meeting.id)).toEqual([
      "meeting.created", "meeting.participant.responded", "meeting.participant.responded",
      "meeting.updated", "meeting.participant.added", "meeting.participant.removed",
    ]);
    const updated = await client.query(`SELECT metadata FROM meeting_events WHERE meeting_id = $1 AND event_type = 'meeting.updated'`, [meeting.id]);
    expect(updated.rows[0].metadata).toMatchObject({ changedFields: ["time", "participants"], previousStartAt: at(day, "09:00"), startAt: at(day, "13:00") });
    // Alice's invitation is still queued, so she gets no separate "rescheduled" message.
    const queue = await deliveries(meeting.id);
    expect(queue.filter((row) => row.employeeId === people.alice.employeeId).map((row) => row.event)).toEqual(["invited"]);
    expect(queue.filter((row) => row.employeeId === people.outsider.employeeId).map((row) => row.event)).toEqual(["invited"]);

    // A title-only edit keeps the answers.
    await respond(meeting.id, "alice", "ACCEPTED");
    actAs("organizer");
    const retitled = await app.inject({ method: "PATCH", url: `/me/meetings/${meeting.id}`, payload: { expectedVersion: 2, title: "Rapat kurikulum (revisi)" } });
    expect(retitled.json().version).toBe(3);
    const alice = await client.query(`SELECT response FROM meeting_participants WHERE meeting_id = $1 AND employee_id = $2`, [meeting.id, people.alice.employeeId]);
    expect(alice.rows[0].response).toBe("ACCEPTED");
  });

  it("CAL-001-I/K: everyone sees the meeting in the calendar, confidential ones as Sibuk; details stay with participants", async () => {
    const open = await created({ participantEmployeeIds: [people.alice.employeeId] });
    const secret = await created({
      title: "Rapat pembinaan pegawai", confidential: true,
      startAt: at(day, "13:00"), endAt: at(day, "14:00"), participantEmployeeIds: [people.alice.employeeId],
    });
    actAs("outsider");
    const calendar = await app.inject({ method: "GET", url: `/me/calendar?from=${day}&to=${day}` });
    expect(calendar.statusCode, calendar.body).toBe(200);
    // K-16: the test config has no Kirim SQ adapter, so the screen must not offer WhatsApp.
    expect(calendar.json().whatsappDelivery).toBe("dry_run");
    const items = calendar.json().items as Array<Record<string, unknown>>;
    expect(items).toContainEqual(expect.objectContaining({
      kind: "meeting", id: null, title: "Rapat kurikulum tahfidz", location: "Ruang guru", organizerName: people.organizer.name, involvesMe: false,
    }));
    expect(items).toContainEqual({ kind: "busy", id: null, startAt: at(day, "13:00"), endAt: at(day, "14:00"), involvesMe: false });
    expect(calendar.body).not.toMatch(/pembinaan|evaluasi setoran|participants/);
    expect((await detail(open.id, "outsider")).statusCode).toBe(404);
    expect((await detail(secret.id, "outsider")).json().code).toBe("MEETING_NOT_FOUND");

    actAs("alice");
    const mine = await app.inject({ method: "GET", url: `/me/calendar?from=${day}&to=${day}` });
    expect(mine.json().items).toContainEqual(expect.objectContaining({ id: secret.id, title: "Rapat pembinaan pegawai", involvesMe: true, myResponse: "PENDING" }));
    const aliceDetail = (await detail(secret.id, "alice")).json();
    // Participants read the description; the organizer-only flags stay hidden from them.
    expect(aliceDetail.description).toBe("Agenda: evaluasi setoran hafalan");
    expect(aliceDetail.participants.every((row: { hasAccount: unknown }) => row.hasAccount === null)).toBe(true);

    // Cancelled: gone for outsiders, struck through for participants.
    actAs("organizer");
    await app.inject({ method: "POST", url: `/me/meetings/${open.id}/cancel`, payload: { reason: "Ditunda minggu depan" } });
    actAs("outsider");
    expect((await app.inject({ method: "GET", url: `/me/calendar?from=${day}&to=${day}` })).json().items
      .filter((item: { kind: string }) => item.kind === "meeting")).toEqual([]);
    actAs("alice");
    expect((await app.inject({ method: "GET", url: `/me/calendar?from=${day}&to=${day}` })).json().items)
      .toContainEqual(expect.objectContaining({ id: open.id, status: "CANCELLED" }));

    const tooLong = await app.inject({ method: "GET", url: `/me/calendar?from=${day}&to=${jakartaDate(60)}` });
    expect(tooLong.json().code).toBe("INVALID_CALENDAR_RANGE");

    const page = await app.inject({ method: "GET", url: "/me/meetings?tab=upcoming&pageSize=1" });
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json().pagination).toMatchObject({ page: 1, pageSize: 1, total: 2, pageCount: 2 });
    expect(page.json().items).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/me/meetings?pageSize=101" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/me/meetings?tab=past" })).json().pagination.total).toBe(0);
  });

  it("participant typeahead: two letters, active employees, no contact data", async () => {
    actAs("organizer");
    expect((await app.inject({ method: "GET", url: "/me/meetings/participant-options?q=a" })).statusCode).toBe(400);
    const tag = people.alice.name.split(" ").slice(0, 2).join(" ");
    const found = await app.inject({ method: "GET", url: `/me/meetings/participant-options?q=${encodeURIComponent(tag)}` });
    expect(found.statusCode, found.body).toBe(200);
    const names = found.json().items.map((item: { name: string }) => item.name);
    expect(names).toContain(people.alice.name);
    expect(names).not.toContain(people.organizer.name);
    expect(found.body).not.toMatch(/0812|example\.invalid|CAL-/);
    expect(found.json().items.find((item: { name: string }) => item.name === people.bob.name)).toMatchObject({ hasAccount: true, hasWhatsApp: false });
    // `%` is literal, not a wildcard.
    expect((await app.inject({ method: "GET", url: "/me/meetings/participant-options?q=%25%25" })).json().items).toEqual([]);
  });

  it("CAL-001-L: the log adapter records DRY_RUN without a network call; the user's request never waits for SQ Hub", async () => {
    const network = vi.fn<FetchLike>();
    const meeting = await created({ participantEmployeeIds: [people.alice.employeeId, people.noAccount.employeeId] });
    expect(network).not.toHaveBeenCalled();
    const runner = new MeetingRunner(savepointPool(client), new LogWhatsAppSender(), { device: "hcis", origin: "https://hcis.example", allowlist: null });
    const tick = await runner.tick();
    expect(tick.delivered).toBe(2);
    expect((await deliveries(meeting.id)).map((row) => row.status)).toEqual(["DRY_RUN", "DRY_RUN"]);
    expect(network).not.toHaveBeenCalled();
  });

  it("CAL-001-L: the kirim adapter retries a failed hand-over with the same idempotency key", async () => {
    const meeting = await created({ participantEmployeeIds: [people.alice.employeeId] });
    const keys: string[] = [];
    const answers = [503, 202];
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.endsWith("/token")) return Response.json({ access_token: "token", expires_in: 300 });
      keys.push((init.headers as Record<string, string>)["idempotency-key"]!);
      const status = answers.shift()!;
      return status === 202 ? Response.json({ id: "kirim-msg-1", status: "antre" }, { status }) : new Response("", { status });
    };
    const sender = new KirimWhatsAppSender(
      "http://127.0.0.1:3302",
      new ClientCredentialsTokenProvider({ tokenUrl: "https://sso.example/token", clientId: "hcis", clientSecret: "s", audience: "sq-hub-kirim" }, fetchImpl),
      fetchImpl,
    );
    const runner = new MeetingRunner(savepointPool(client), sender, { device: "hcis", origin: null, allowlist: null });
    await runner.tick();
    expect(await deliveries(meeting.id)).toEqual([expect.objectContaining({ status: "QUEUED", errorCode: "http_503" })]);
    // The retry is due after a minute; bring it forward.
    await client.query(`UPDATE meeting_notification_deliveries SET next_attempt_at = now() WHERE meeting_id = $1`, [meeting.id]);
    await runner.tick();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    const final = await client.query(`SELECT status, kirim_message_id, attempts FROM meeting_notification_deliveries WHERE meeting_id = $1`, [meeting.id]);
    expect(final.rows[0]).toMatchObject({ status: "HANDED_OVER", kirim_message_id: "kirim-msg-1", attempts: 2 });
  });

  it("CAL-001 K-17: before go-live real WhatsApp reaches only allowlisted employees; the rest are SKIPPED without a call", async () => {
    const meeting = await created({ participantEmployeeIds: [people.alice.employeeId, people.noAccount.employeeId] });
    const sent: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.endsWith("/token")) return Response.json({ access_token: "token", expires_in: 300 });
      sent.push(JSON.parse(init.body as string).to);
      return Response.json({ id: `kirim-${sent.length}`, status: "antre" }, { status: 202 });
    };
    const sender = new KirimWhatsAppSender(
      "http://127.0.0.1:3302",
      new ClientCredentialsTokenProvider({ tokenUrl: "https://sso.example/token", clientId: "hcis-api", clientSecret: "s", audience: "sq-hub-kirim" }, fetchImpl),
      fetchImpl,
    );
    // The allowlist holds NIPs; the phone comes from the employee record.
    const aliceNip = (await client.query<{ nip: string }>(`SELECT employee_number AS nip FROM employees WHERE id = $1`, [people.alice.employeeId])).rows[0]!.nip;
    const runner = new MeetingRunner(savepointPool(client), sender, { origin: null, allowlist: new Set([aliceNip]) });
    await runner.tick();
    expect(sent).toEqual(["+6281200000002"]);
    const rows = await client.query<{ status: string; error_code: string | null }>(
      `SELECT status, error_code FROM meeting_notification_deliveries WHERE meeting_id = $1 ORDER BY status`,
      [meeting.id],
    );
    expect(rows.rows).toEqual([{ status: "HANDED_OVER", error_code: null }, { status: "SKIPPED", error_code: "not_allowlisted" }]);
  });

  it("CAL-001-M: the reminder fires once, 30 minutes ahead, for people still attending", async () => {
    const meeting = await created({ participantEmployeeIds: [people.alice.employeeId, people.bob.employeeId] });
    await respond(meeting.id, "bob", "DECLINED");
    const cancelled = await created({ startAt: at(day, "13:00"), endAt: at(day, "14:00"), participantEmployeeIds: [people.alice.employeeId] });
    actAs("organizer");
    await app.inject({ method: "POST", url: `/me/meetings/${cancelled.id}/cancel`, payload: { reason: "Ditunda minggu depan" } });
    const fireAt = await client.query(`SELECT DISTINCT fire_at FROM meeting_reminders WHERE meeting_id = $1`, [meeting.id]);
    expect(new Date(fireAt.rows[0].fire_at).toISOString()).toBe(new Date(Date.parse(at(day, "09:00")) - 30 * 60_000).toISOString());

    // Make every reminder due now; the cancelled meeting's reminders were cancelled already.
    await client.query(`UPDATE meeting_reminders SET fire_at = now() - interval '1 minute' WHERE meeting_id = ANY($1::uuid[])`, [[meeting.id, cancelled.id]]);
    const runner = new MeetingRunner(savepointPool(client), new LogWhatsAppSender(), { device: "hcis", origin: null, allowlist: null });
    const first = await runner.tick();
    expect(first.remindersFired).toBe(2);
    const second = await runner.tick();
    expect(second.remindersFired).toBe(0);

    const reminderTitles = async (who: Who) => (await notifications(who)).filter((row) => row.title === "Rapat mulai 30 menit lagi");
    expect(await reminderTitles("organizer")).toHaveLength(1);
    expect(await reminderTitles("alice")).toHaveLength(1);
    expect(await reminderTitles("bob")).toHaveLength(0);
    const whatsapp = (await deliveries(meeting.id)).filter((row) => row.event === "reminder");
    expect(whatsapp.map((row) => [row.employeeId, row.status]).sort()).toEqual([
      [people.alice.employeeId, "DRY_RUN"], [people.organizer.employeeId, "DRY_RUN"],
    ].sort());

    // A participant removed after scheduling gets nothing.
    const later = await created({ startAt: at(day, "15:00"), endAt: at(day, "16:00"), participantEmployeeIds: [people.alice.employeeId, people.outsider.employeeId] });
    actAs("organizer");
    await app.inject({ method: "PATCH", url: `/me/meetings/${later.id}`, payload: { expectedVersion: 1, participantEmployeeIds: [people.alice.employeeId] } });
    await client.query(`UPDATE meeting_reminders SET fire_at = now() - interval '1 minute' WHERE meeting_id = $1`, [later.id]);
    await runner.tick();
    expect(await reminderTitles("outsider")).toHaveLength(0);
  });

  it("review: an answer given after the reminder is due but before the runner ticks keeps everyone's reminder", async () => {
    const meeting = await created({ participantEmployeeIds: [people.alice.employeeId, people.bob.employeeId] });
    // The meeting starts in 20 minutes; reminders were due 10 minutes ago and the runner has not run.
    await client.query(
      `UPDATE meetings SET start_at = now() + interval '20 minutes', end_at = now() + interval '80 minutes' WHERE id = $1`, [meeting.id],
    );
    await client.query(`UPDATE meeting_reminders SET fire_at = now() - interval '10 minutes' WHERE meeting_id = $1`, [meeting.id]);
    expect((await respond(meeting.id, "alice", "ACCEPTED")).statusCode).toBe(200);
    expect((await respond(meeting.id, "bob", "DECLINED")).statusCode).toBe(200);
    const pending = await client.query<{ employeeId: string }>(
      `SELECT employee_id AS "employeeId" FROM meeting_reminders WHERE meeting_id = $1 AND fired_at IS NULL AND cancelled_at IS NULL`,
      [meeting.id],
    );
    expect(pending.rows.map((row) => row.employeeId).sort()).toEqual([people.organizer.employeeId, people.alice.employeeId].sort());
  });

  it("review: a removed person's WhatsApp describes the meeting as they knew it; leave and trip flags are the organizer's", async () => {
    const meeting = await created({ confidential: true, participantEmployeeIds: [people.alice.employeeId, people.outsider.employeeId] });
    actAs("organizer");
    const edited = await app.inject({
      method: "PATCH", url: `/me/meetings/${meeting.id}`,
      payload: {
        expectedVersion: 1, title: "Pembinaan pegawai tertutup", location: "Ruang ketua",
        startAt: at(day, "13:00"), endAt: at(day, "14:00"), participantEmployeeIds: [people.alice.employeeId],
      },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const removed = await client.query(
      `SELECT message_facts FROM meeting_notification_deliveries WHERE meeting_id = $1 AND employee_id = $2 AND event = 'removed'`,
      [meeting.id, people.outsider.employeeId],
    );
    expect(removed.rows[0].message_facts).toMatchObject({
      title: "Rapat kurikulum tahfidz", location: "Ruang guru", startMs: Date.parse(at(day, "09:00")),
    });
    const texts: string[] = [];
    const runner = new MeetingRunner(savepointPool(client), {
      name: "log", send: async (message) => { texts.push(message.text); return { id: "x", dryRun: true }; },
    }, { device: "hcis", origin: null, allowlist: null });
    await runner.tick();
    const outsiderText = texts.find((text) => text.includes("tidak lagi diundang"))!;
    expect(outsiderText).toContain("Rapat kurikulum tahfidz");
    expect(outsiderText).not.toMatch(/Pembinaan|Ruang ketua|13:00/);

    await client.query(
      `INSERT INTO leave_requests(id, employee_id, policy_key, status, start_on, end_on, working_days, hc_handling, idempotency_key)
       VALUES ($1,$2,'annual','approved',$3,$3,1,'none',$4)`,
      [randomUUID(), people.alice.employeeId, day, randomUUID()],
    );
    const flag = (body: { participants: Array<{ employeeId: string; unavailableReason: unknown }> }) =>
      body.participants.find((row) => row.employeeId === people.alice.employeeId)!.unavailableReason;
    expect(flag((await detail(meeting.id, "organizer")).json())).toBe("LEAVE");
    expect(flag((await detail(meeting.id, "alice")).json())).toBe("LEAVE");
  });
});

describe.skipIf(!allowed)("CAL-001 races (PostgreSQL, committed and cleaned up)", () => {
  let pool: Pool;
  let people: Record<Who, Person>;
  let unitId: string;
  let principals: Map<string, AuthPrincipal>;
  const day = jakartaDate(3);

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl!, max: 6 });
    ({ people, unitId } = await seedPeople(pool, `Balapan ${randomUUID().slice(0, 6)}`));
    principals = new Map();
  });

  afterAll(async () => {
    const ids = Object.values(people).map((person) => person.employeeId);
    const accounts = Object.values(people).flatMap((person) => (person.accountId ? [person.accountId] : []));
    const meetings = `SELECT meeting_id FROM meeting_participants WHERE employee_id = ANY($1::uuid[])`;
    await pool.query(`DELETE FROM meeting_notification_deliveries WHERE meeting_id IN (${meetings})`, [ids]);
    await pool.query(`DELETE FROM meeting_reminders WHERE meeting_id IN (${meetings})`, [ids]);
    await pool.query(`DELETE FROM meeting_events WHERE meeting_id IN (${meetings})`, [ids]);
    const owned = await pool.query<{ id: string }>(`SELECT id FROM meetings WHERE organizer_employee_id = ANY($1::uuid[])`, [ids]);
    await pool.query(`DELETE FROM meeting_participants WHERE meeting_id = ANY($1::uuid[])`, [owned.rows.map((row) => row.id)]);
    await pool.query(`DELETE FROM meetings WHERE id = ANY($1::uuid[])`, [owned.rows.map((row) => row.id)]);
    await pool.query(`DELETE FROM in_app_notifications WHERE recipient_account_id = ANY($1::uuid[]) OR actor_account_id = ANY($1::uuid[])`, [accounts]);
    await pool.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [accounts]);
    await pool.query(`DELETE FROM employees WHERE id = ANY($1::uuid[])`, [ids]);
    await pool.query(`DELETE FROM organizational_units WHERE id = $1`, [unitId]);
    await pool.end();
  });

  it("CAL-001-F: two simultaneous invitations for the same person and time — exactly one succeeds", async () => {
    const app = Fastify({ logger: false });
    await registerMeetingRoutes(app, pool, config, {
      getSession: async (token: string | null) => ({ principal: principals.get(token ?? "")!, expiresAt: "2099-01-01T00:00:00Z" }),
    } as never);
    for (const who of ["organizer", "outsider"] as const) {
      principals.set(who, { id: people[who].accountId!, email: `${who}@example.invalid`, principalType: "EMPLOYEE" });
    }
    const invite = (who: "organizer" | "outsider") => app.inject({
      method: "POST", url: "/me/meetings",
      headers: { "idempotency-key": randomUUID(), cookie: `hcis_session=${who}` },
      payload: {
        title: `Rapat dari ${who}`, startAt: at(day, "09:00"), endAt: at(day, "10:00"),
        participantEmployeeIds: [people.alice.employeeId],
      },
    });
    const results = await Promise.all([invite("organizer"), invite("outsider")]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([201, 409]);
    expect(results.find((result) => result.statusCode === 409)!.json().code).toBe("MEETING_CONFLICT");
    const blocking = await pool.query(
      `SELECT count(*)::int AS n FROM meeting_participants WHERE employee_id = $1 AND blocks_time`, [people.alice.employeeId],
    );
    expect(blocking.rows[0].n).toBe(1);
    await app.close();
  });

  it("CAL-001-M: two runners at once never fire a reminder twice", async () => {
    const meeting = await pool.query<{ id: string }>(
      `SELECT meeting_id AS id FROM meeting_participants WHERE employee_id = $1 AND blocks_time LIMIT 1`, [people.alice.employeeId],
    );
    const id = meeting.rows[0]!.id;
    await pool.query(`UPDATE meeting_reminders SET fire_at = now() - interval '1 minute' WHERE meeting_id = $1`, [id]);
    const runner = () => new MeetingRunner(pool, new LogWhatsAppSender(), { device: "hcis", origin: null, allowlist: null });
    const [a, b] = await Promise.all([runner().tick(), runner().tick()]);
    expect(a.remindersFired + b.remindersFired).toBe(2);
    const sent = await pool.query(
      `SELECT count(*)::int AS n FROM in_app_notifications WHERE event_key = $1`, [`meeting.${id}.reminder.${Date.parse(at(day, "09:00"))}`],
    );
    expect(sent.rows[0].n).toBe(2);
    const whatsapp = await pool.query(
      `SELECT count(*)::int AS n FROM meeting_notification_deliveries WHERE meeting_id = $1 AND event = 'reminder' AND status = 'DRY_RUN'`, [id],
    );
    expect(whatsapp.rows[0].n).toBe(2);
  });
});
