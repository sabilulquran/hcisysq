// REWARD-001 Package 1 acceptance against a real schema (§11). Synthetic people and a fake
// Al-Qur'an source; every test runs inside one rolled-back transaction.

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import type { MonthlyScoreboardReader, ScoreboardRead } from "../src/modules/rewards/quran-scoreboard-client.js";
import { registerRewardRoutes } from "../src/modules/rewards/routes.js";

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

type Who = "lead" | "hcAdmin" | "a" | "b" | "c" | "d" | "e" | "plain";
const CONFIG = { NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32) } as ApiConfig;
const UNIT_1 = `hcis:org-node:${randomUUID()}`;
const UNIT_2 = `hcis:org-node:${randomUUID()}`;
const UNKNOWN_PERSON = `hcis:employee:${randomUUID()}`;

describe.skipIf(!allowed)("REWARD-001 award rounds", () => {
  let pool: Pool;
  let client: PoolClient;
  let principal: AuthPrincipal | null;
  let permissions: string[];
  let clock: Date;
  let sourceAnswer: (month: string) => ScoreboardRead;
  const people = {} as Record<Who, { employeeId: string; accountId: string; nip: string }>;
  const MANAGE = ["reward.read", "reward.manage"];

  const reader: MonthlyScoreboardReader = { read: async (month) => sourceAnswer(month) };

  async function appWith(source: MonthlyScoreboardReader | null) {
    const app = Fastify({ logger: false });
    const handle = await registerRewardRoutes(app, savepointPool(client), CONFIG, {
      reader: source,
      now: () => clock,
      auth: {
        getSession: async () => (principal ? { principal, expiresAt: "2099-01-01T00:00:00Z" } : null),
        getAuthorizationContext: async () => ({ organizationPermissions: permissions }),
      } as never,
    });
    return { app, handle };
  }

  function actAs(who: Who, granted: string[] = []) {
    principal = { id: people[who].accountId, email: `${who}@example.invalid`, principalType: "EMPLOYEE" };
    permissions = granted;
  }

  const ref = (who: Who) => `hcis:employee:${people[who].employeeId}`;
  const entry = (personId: string, rank: number, pages: number, labels: string[] = []) => ({
    personId, unitId: null, rank, pages, activeDays: 20, khatam: rank === 1 ? 1 : 0, labels,
  });

  function snapshot(month: string): ScoreboardRead {
    return {
      status: "AVAILABLE",
      snapshot: {
        schemaVersion: 1,
        month,
        snapshotVersion: `synthetic-${month}-v1`,
        finalizedAt: "2026-11-02T17:00:00.000Z",
        directory: { version: "sha256:synthetic", asOf: "2026-11-02T16:00:00.000Z", stale: true },
        scopes: [
          { scope: "FOUNDATION", unitId: null, entries: [
            entry(ref("lead"), 1, 300.5, ["AUTO"]), entry(ref("a"), 2, 250), entry(ref("b"), 3, 200, ["SELF_REPORTED"]),
            entry(ref("c"), 4, 150),
          ] },
          { scope: "UNIT", unitId: UNIT_1, entries: [entry(ref("a"), 1, 250), entry(ref("d"), 2, 90)] },
          { scope: "UNIT", unitId: UNIT_2, entries: [entry(UNKNOWN_PERSON, 1, 80), entry(ref("e"), 2, 70)] },
        ],
      } as never,
    };
  }

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl });
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    clock = new Date("2026-11-10T03:00:00Z");
    sourceAnswer = snapshot;
    for (const who of ["lead", "hcAdmin", "a", "b", "c", "d", "e", "plain"] as Who[]) {
      const employeeId = randomUUID();
      const accountId = randomUUID();
      const nip = `RWD-${employeeId.slice(0, 8)}`;
      await client.query(
        `INSERT INTO employees(id, employee_number, full_name, status, started_on) VALUES ($1, $2, $3, 'active', '2020-01-06')`,
        [employeeId, nip, `Pegawai Sintetis ${who.toUpperCase()}`],
      );
      await client.query(
        `INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1, $2, $3, 'EMPLOYEE', 'active')`,
        [accountId, employeeId, `rwd-${accountId}@example.invalid`],
      );
      people[who] = { employeeId, accountId, nip };
    }
    for (const [who, roleKey] of [["lead", "human_capital_lead"], ["hcAdmin", "human_capital_admin"]] as const) {
      await client.query(
        `INSERT INTO account_role_assignments(id, account_id, role_id, scope_type)
         SELECT $1, $2, id, 'organization' FROM roles WHERE role_key = $3`,
        [randomUUID(), people[who].accountId, roleKey],
      );
    }
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  async function candidates(app: Awaited<ReturnType<typeof appWith>>["app"], roundId: string) {
    actAs("lead", MANAGE);
    const detail = await app.inject({ method: "GET", url: `/admin/rewards/rounds/${roundId}` });
    expect(detail.statusCode, detail.body).toBe(200);
    const body = detail.json();
    const byEmployee = (who: Who) => body.candidates.find((candidate: { employeeId: string }) => candidate.employeeId === people[who].employeeId);
    return { body, byEmployee };
  }

  it("builds, decides, publishes, revokes and verifies a round end to end", async () => {
    const { app } = await appWith(reader);

    actAs("plain");
    expect((await app.inject({ method: "GET", url: "/admin/rewards/rounds" })).statusCode).toBe(403);

    actAs("lead", MANAGE);
    const created = await app.inject({ method: "POST", url: "/admin/rewards/rounds", payload: { month: "2026-10" } });
    expect(created.statusCode, created.body).toBe(201);
    const roundId = created.json().id as string;
    expect(created.json().candidates).toBe(5);
    expect((await app.inject({ method: "POST", url: "/admin/rewards/rounds", payload: { month: "2026-10" } })).json().code)
      .toBe("REWARD_ROUND_EXISTS");
    // A month that is not final yet is refused before the source is asked.
    expect((await app.inject({ method: "POST", url: "/admin/rewards/rounds", payload: { month: "2026-11" } })).json().code)
      .toBe("REWARD_PERIOD_NOT_FINAL");

    const { body, byEmployee } = await candidates(app, roundId);
    expect(body.status).toBe("PENDING_DECISION");
    expect(body.directoryStale).toBe(true);
    expect(body.sourceKind).toBe("QURAN_API");
    // R-03/R-07: lead, A, B for the foundation; A's unit seat falls to D; the unknown person is unresolved.
    expect(body.candidates.map((candidate: { category: string; seat: number; status: string }) => `${candidate.category}:${candidate.seat}:${candidate.status}`))
      .toEqual(expect.arrayContaining(["FOUNDATION:1:CANDIDATE", "FOUNDATION:2:CANDIDATE", "FOUNDATION:3:CANDIDATE", "UNIT:1:CANDIDATE", "UNIT:1:UNRESOLVED"]));
    expect(byEmployee("d").unitRef).toBe(UNIT_1);
    expect(byEmployee("lead").labels).toEqual(["AUTO"]);
    expect(byEmployee("lead").pages).toBe(300.5);
    const unresolved = body.candidates.find((candidate: { status: string }) => candidate.status === "UNRESOLVED");
    expect(unresolved.unresolvedReason).toBe("UNKNOWN_PERSON");
    // The Kepala HCM is notified that candidates are ready.
    expect((await client.query(
      "SELECT 1 FROM in_app_notifications WHERE recipient_account_id = $1 AND event_key = $2",
      [people.lead.accountId, `reward.round.${roundId}.created`],
    )).rowCount).toBe(1);

    const decide = (who: Who, granted: string[], candidateId: string, action: "award" | "decline" | "next-rank", reason?: string) => {
      actAs(who, granted);
      return app.inject({ method: "POST", url: `/admin/rewards/candidates/${candidateId}/${action}`, payload: reason ? { reason } : {} });
    };

    // R-09: nobody decides about themselves; the HC admin decides the Kepala HCM's candidacy only.
    expect((await decide("lead", MANAGE, byEmployee("lead").id, "award")).json().code).toBe("REWARD_SELF_DECISION");
    expect((await decide("hcAdmin", ["reward.read", "reward.import"], byEmployee("a").id, "award")).json().code).toBe("REWARD_FORBIDDEN");
    expect((await decide("plain", [], byEmployee("a").id, "award")).statusCode).toBe(403);
    expect((await decide("hcAdmin", ["reward.read", "reward.import"], byEmployee("lead").id, "award")).statusCode).toBe(200);
    // §11.2: nothing can be added from outside the snapshot, and an unresolved seat cannot be awarded.
    expect((await decide("lead", MANAGE, unresolved.id, "award")).json().code).toBe("REWARD_CANDIDATE_UNRESOLVED");

    expect((await decide("lead", MANAGE, byEmployee("a").id, "award")).statusCode).toBe(200);
    expect((await decide("lead", MANAGE, byEmployee("b").id, "decline", "x")).statusCode).toBe(400);
    expect((await decide("lead", MANAGE, byEmployee("b").id, "decline", "Sebagian besar catatan mandiri")).statusCode).toBe(200);
    // A seat that is not vacated cannot be refilled.
    expect((await decide("lead", MANAGE, byEmployee("a").id, "next-rank")).json().code).toBe("REWARD_CANDIDATE_LOCKED");

    actAs("lead", MANAGE);
    const notReady = await app.inject({ method: "POST", url: `/admin/rewards/rounds/${roundId}/publish` });
    expect(notReady.json().code).toBe("REWARD_ROUND_NOT_READY");

    // R-08: B's seat goes to C (rank 4) from the same snapshot, once.
    const replaced = await decide("lead", MANAGE, byEmployee("b").id, "next-rank");
    expect(replaced.statusCode, replaced.body).toBe(201);
    expect((await decide("lead", MANAGE, byEmployee("b").id, "next-rank")).json().code).toBe("REWARD_CANDIDATE_LOCKED");
    expect((await decide("lead", MANAGE, byEmployee("b").id, "award")).json().code).toBe("REWARD_CANDIDATE_LOCKED");
    const afterReplace = await candidates(app, roundId);
    expect(afterReplace.byEmployee("c")).toMatchObject({ seat: 3, rank: 4, replacesCandidateId: byEmployee("b").id });
    // The unknown person's unit seat goes to E.
    expect((await decide("lead", MANAGE, unresolved.id, "next-rank")).statusCode).toBe(201);
    const filled = await candidates(app, roundId);
    for (const who of ["c", "d", "e"] as Who[]) {
      expect((await decide("lead", MANAGE, filled.byEmployee(who).id, "award")).statusCode, who).toBe(200);
    }
    // Decisions can change while pending, and are audited as changes.
    expect((await decide("lead", MANAGE, filled.byEmployee("e").id, "decline", "Uji perubahan keputusan")).statusCode).toBe(200);
    expect((await decide("lead", MANAGE, filled.byEmployee("e").id, "award")).statusCode).toBe(200);

    actAs("lead", MANAGE);
    const published = await app.inject({ method: "POST", url: `/admin/rewards/rounds/${roundId}/publish` });
    expect(published.statusCode, published.body).toBe(200);
    expect(published.json().awards).toBe(5);

    const final = await candidates(app, roundId);
    expect(final.body.status).toBe("PUBLISHED");
    expect(final.body.outbox.every((item: { status: string }) => item.status === "DONE")).toBe(true);
    expect(final.body.awards.every((award: { certificateReady: boolean }) => award.certificateReady)).toBe(true);
    expect(final.body.viewer.decidableCandidateIds).toEqual([]);
    // §4.3: a published round is final.
    expect((await decide("lead", MANAGE, filled.byEmployee("d").id, "decline", "Terlambat diubah")).json().code).toBe("REWARD_CANDIDATE_LOCKED");
    actAs("lead", MANAGE);
    expect((await app.inject({ method: "POST", url: `/admin/rewards/rounds/${roundId}/cancel`, payload: { reason: "Uji batal setelah terbit" } })).json().code)
      .toBe("REWARD_ROUND_NOT_CANCELLABLE");

    // NOTIF-002 announcement with names and categories, never a score (R-12).
    const announcement = await client.query<{ title: string; body: string; status: string }>(
      "SELECT title, body, status FROM announcements WHERE id = $1",
      [final.body.announcementId],
    );
    expect(announcement.rows[0]!.status).toBe("PUBLISHED");
    expect(announcement.rows[0]!.title).toBe("Penerima Penghargaan Tilawah Oktober 2026");
    expect(announcement.rows[0]!.body).toContain("Pegawai Sintetis A");
    expect(announcement.rows[0]!.body).not.toMatch(/300|250|halaman/);
    // NOTIF-004 notification to a recipient.
    expect((await client.query(
      "SELECT 1 FROM in_app_notifications WHERE recipient_account_id = $1 AND event_key LIKE 'reward.award.%'",
      [people.a.accountId],
    )).rowCount).toBe(1);

    // The employee's own history and certificate; someone else's reads as missing.
    actAs("a");
    const mine = await app.inject({ method: "GET", url: "/me/rewards" });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().items).toHaveLength(1);
    const awardId = mine.json().items[0].id as string;
    expect(mine.json().items[0]).toMatchObject({ status: "ACTIVE", certificateReady: true, monthLabel: "Oktober 2026" });
    const certificate = await app.inject({ method: "GET", url: `/me/rewards/${awardId}/certificate` });
    expect(certificate.statusCode).toBe(200);
    expect(certificate.headers["content-type"]).toBe("application/pdf");
    expect(certificate.rawPayload.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    actAs("b");
    expect((await app.inject({ method: "GET", url: `/me/rewards/${awardId}/certificate` })).statusCode).toBe(404);

    // Everyone sees the recipients, without numbers.
    const recipients = await app.inject({ method: "GET", url: "/rewards/recipients?month=2026-10" });
    expect(recipients.statusCode).toBe(200);
    expect(recipients.json().pagination.total).toBe(5);
    expect(JSON.stringify(recipients.json())).not.toMatch(/pages|rank|activeDays/);

    // Public check, then revocation (§4.3).
    const code = (await client.query<{ code: string }>("SELECT verification_code AS code FROM reward_awards WHERE id = $1", [awardId])).rows[0]!.code;
    principal = null;
    const valid = await app.inject({ method: "GET", url: `/public/rewards/verify/${code.toLowerCase()}` });
    expect(valid.json()).toMatchObject({ status: "VALID", recipientName: "Pegawai Sintetis A", month: "2026-10" });
    expect(Object.keys(valid.json()).sort()).toEqual(["categoryLabel", "month", "monthLabel", "recipientName", "status"]);
    actAs("lead", MANAGE);
    expect((await app.inject({ method: "POST", url: `/admin/rewards/awards/${awardId}/revoke`, payload: { reason: "Koreksi data papan skor" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/admin/rewards/awards/${awardId}/revoke`, payload: { reason: "Koreksi data papan skor" } })).json().code)
      .toBe("REWARD_AWARD_ALREADY_REVOKED");
    principal = null;
    expect((await app.inject({ method: "GET", url: `/public/rewards/verify/${code}` })).json().status).toBe("REVOKED");
    actAs("a");
    expect((await app.inject({ method: "GET", url: `/me/rewards/${awardId}/certificate` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/rewards/recipients?month=2026-10" })).json().pagination.total).toBe(4);

    // §11.3: every state change left an audit event.
    const events = (await client.query<{ type: string }>(
      "SELECT event_type AS type FROM reward_audit_events WHERE round_id = $1",
      [roundId],
    )).rows.map((row) => row.type);
    for (const type of [
      "reward.round.created", "reward.candidate.awarded", "reward.candidate.declined", "reward.candidate.replacement_added",
      "reward.candidate.decision_changed", "reward.round.published", "reward.award.revoked",
    ]) {
      expect(events, type).toContain(type);
    }
    actAs("hcAdmin", ["reward.read", "reward.import"]);
    const trail = await app.inject({ method: "GET", url: `/admin/rewards/rounds/${roundId}/events?pageSize=5` });
    expect(trail.statusCode).toBe(200);
    expect(trail.json().pagination.total).toBe(events.length);
    expect(trail.json().items).toHaveLength(5);
  });

  it("a cancelled round frees the month; an unavailable source leaves no half-built round", async () => {
    const { app } = await appWith(reader);
    actAs("lead", MANAGE);
    const roundId = (await app.inject({ method: "POST", url: "/admin/rewards/rounds", payload: { month: "2026-10" } })).json().id;
    expect((await app.inject({ method: "POST", url: `/admin/rewards/rounds/${roundId}/cancel`, payload: { reason: "Uji batal" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/admin/rewards/rounds", payload: { month: "2026-10" } })).statusCode).toBe(201);

    sourceAnswer = () => ({ status: "UNAVAILABLE", failure: "UNREACHABLE", httpStatus: null });
    const failed = await app.inject({ method: "POST", url: "/admin/rewards/rounds", payload: { month: "2026-08" } });
    expect(failed.statusCode).toBe(409);
    expect(failed.json().code).toBe("REWARD_SOURCE_UNAVAILABLE");
    expect((await client.query("SELECT 1 FROM reward_rounds WHERE month = '2026-08'")).rowCount).toBe(0);
    const source = await app.inject({ method: "GET", url: "/admin/rewards/source" });
    expect(source.json()).toMatchObject({ status: "UNAVAILABLE", manualImportOpen: false });

    // The manual path is closed while the source is configured.
    actAs("hcAdmin", ["reward.read", "reward.import"]);
    const closed = await app.inject({
      method: "POST", url: "/admin/rewards/imports",
      payload: { month: "2026-09", note: "Uji impor", csv: "cakupan,peringkat,nip,halaman,hari_aktif,khatam,label\nYAYASAN,1,X,1,1,0," },
    });
    expect(closed.json().code).toBe("REWARD_MANUAL_IMPORT_CLOSED");
  });

  it("the scheduler retries hourly for 3 days, then stops and tells the Kepala HCM", async () => {
    const { handle } = await appWith(reader);
    sourceAnswer = () => ({ status: "UNAVAILABLE", failure: "HTTP_ERROR", httpStatus: 503 });
    clock = new Date("2026-08-02T22:00:00Z"); // 3 Aug 05:00 WIB: not due yet
    expect((await handle.tick()).outcome).toBe("NOT_DUE");
    clock = new Date("2026-08-03T00:00:00Z");
    expect(await handle.tick()).toMatchObject({ month: "2026-07", outcome: "UNAVAILABLE" });
    expect((await handle.tick()).outcome).toBe("WAITING");
    clock = new Date("2026-08-06T01:00:00Z");
    expect((await handle.tick()).outcome).toBe("EXHAUSTED");
    expect((await handle.tick()).outcome).toBe("WAITING");
    expect((await client.query(
      "SELECT 1 FROM in_app_notifications WHERE recipient_account_id = $1 AND event_key = 'reward.fetch.2026-07.exhausted'",
      [people.lead.accountId],
    )).rowCount).toBe(1);
    expect((await client.query("SELECT 1 FROM reward_rounds WHERE month = '2026-07'")).rowCount).toBe(0);

    // A source that answers builds the round on the next due tick, with the system as actor.
    clock = new Date("2026-11-03T00:00:00Z");
    sourceAnswer = snapshot;
    expect((await handle.tick()).outcome).toBe("CREATED");
    const round = await client.query<{ createdBy: string | null }>(
      `SELECT created_by_account_id AS "createdBy" FROM reward_rounds WHERE month = '2026-10' AND status = 'PENDING_DECISION'`,
    );
    expect(round.rows[0]!.createdBy).toBeNull();
    expect((await handle.tick()).outcome).toBe("ROUND_EXISTS");
  });

  it("R-14 DRAFT: HC imports a CSV snapshot while the source is not configured; the importer cannot decide", async () => {
    const { app } = await appWith(null);
    actAs("lead", MANAGE);
    expect((await app.inject({ method: "GET", url: "/admin/rewards/source" })).json()).toMatchObject({
      status: "NOT_CONFIGURED", manualImportOpen: true,
    });
    expect((await app.inject({ method: "POST", url: "/admin/rewards/rounds", payload: { month: "2026-10" } })).json().code)
      .toBe("REWARD_SOURCE_NOT_CONFIGURED");

    const header = "cakupan,peringkat,nip,halaman,hari_aktif,khatam,label";
    actAs("hcAdmin", ["reward.read", "reward.import"]);
    const bad = await app.inject({
      method: "POST", url: "/admin/rewards/imports",
      payload: { month: "2026-10", note: "Rekap manual Oktober", csv: `${header}\nYAYASAN,1,TIDAK-ADA,10,3,0,\nSMPIT-TIDAK-ADA,1,${people.a.nip},5,2,0,` },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().problems.map((problem: { message: string }) => problem.message).join(" ")).toMatch(/Unit .* tidak dikenal.*NIP TIDAK-ADA|NIP TIDAK-ADA/);
    expect((await client.query("SELECT 1 FROM reward_rounds WHERE month = '2026-10'")).rowCount).toBe(0);

    const csv = [
      header,
      `YAYASAN,1,${people.a.nip},120.5,25,1,otomatis`,
      `YAYASAN,2,${people.b.nip},100,20,0,`,
      `YAYASAN,3,${people.hcAdmin.nip},90,20,0,mandiri`,
      `YAYASAN,4,${people.c.nip},80,18,0,`,
    ].join("\n");
    const imported = await app.inject({ method: "POST", url: "/admin/rewards/imports", payload: { month: "2026-10", note: "Rekap manual Oktober", csv } });
    expect(imported.statusCode, imported.body).toBe(201);
    expect(imported.json()).toMatchObject({ rows: 4, candidates: 3 });
    const roundId = imported.json().id as string;

    const { body, byEmployee } = await candidates(app, roundId);
    expect(body).toMatchObject({ sourceKind: "MANUAL_IMPORT", importRowCount: 4, importNote: "Rekap manual Oktober" });
    expect(body.snapshotVersion).toMatch(/^manual:sha256:[0-9a-f]{64}$/);
    expect(byEmployee("b").labels).toEqual([]);

    // The importer may not decide on the snapshot they supplied, even holding reward.manage.
    actAs("hcAdmin", ["reward.read", "reward.import", "reward.manage"]);
    const own = await app.inject({ method: "POST", url: `/admin/rewards/candidates/${byEmployee("a").id}/award` });
    expect(own.json().code).toBe("REWARD_IMPORTER_DECISION");
    actAs("lead", MANAGE);
    expect((await app.inject({ method: "POST", url: `/admin/rewards/candidates/${byEmployee("a").id}/award` })).statusCode).toBe(200);
    expect((await client.query(
      "SELECT 1 FROM reward_audit_events WHERE event_type = 'reward.snapshot.imported' AND import_id = $1",
      [imported.json().importId],
    )).rowCount).toBe(1);
  });
});
