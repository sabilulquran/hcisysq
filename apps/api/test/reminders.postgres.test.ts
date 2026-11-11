// NOTIF-003 acceptance against a real schema (docs/domain/reminders.md §9). Synthetic data only.
// The main suite runs in one rolled-back transaction; the concurrency suite commits and cleans up.

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { WhatsAppMessage, WhatsAppSender } from "../src/modules/meetings/whatsapp.js";
import { jakartaClock } from "../src/modules/reminders/domain.js";
import { ReminderEngine } from "../src/modules/reminders/engine.js";
import { registerReminderRoutes } from "../src/modules/reminders/routes.js";
import { REMINDER_RULES, findReminderRule, type ReminderRule } from "../src/modules/reminders/rules.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

/** The engine and routes own their transactions; BEGIN/COMMIT/ROLLBACK become savepoints. */
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

/** 07:30 WIB on the real Jakarta date (Monday when that is a Sunday), so Monday–Saturday digests run. */
function morning(offsetDays = 0): Date {
  const base = new Date(Date.now() + offsetDays * 86_400_000);
  let date = jakartaClock(base).date;
  if (jakartaClock(new Date(`${date}T12:00:00+07:00`)).weekday === 0) {
    date = jakartaClock(new Date(Date.parse(`${date}T12:00:00+07:00`) + 86_400_000)).date;
  }
  return new Date(`${date}T07:30:00+07:00`);
}

function addDays(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

class FakeSender implements WhatsAppSender {
  readonly sent: WhatsAppMessage[] = [];
  constructor(readonly name: "log" | "kirim") {}
  async send(message: WhatsAppMessage) {
    this.sent.push(message);
    return { id: `fake-${this.sent.length}`, dryRun: this.name === "log" };
  }
}

type Who = "approver" | "requester" | "hc" | "plain";

describe.skipIf(!allowed)("NOTIF-003 reminder engine", () => {
  let pool: Pool;
  let client: PoolClient;
  const people = {} as Record<Who, { employeeId: string; accountId: string; nip: string }>;

  async function insertPerson(who: Who) {
    const employeeId = randomUUID();
    const nip = `REM-${employeeId.slice(0, 8)}`;
    await client.query(
      `INSERT INTO employees(id, employee_number, full_name, status, started_on, phone)
       VALUES ($1,$2,$3,'active','2020-01-06','081234567890')`,
      [employeeId, nip, `Pegawai ${who}`],
    );
    const accountId = randomUUID();
    await client.query(
      "INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1,$2,$3,'EMPLOYEE','active')",
      [accountId, employeeId, `rem-${who}-${accountId}@example.invalid`],
    );
    people[who] = { employeeId, accountId, nip };
  }

  function engine(now: Date, options: { sender?: WhatsAppSender; allowlist?: ReadonlySet<string> | null; rules?: readonly ReminderRule[] } = {}) {
    return new ReminderEngine(savepointPool(client), options.sender ?? new FakeSender("log"), {
      allowlist: options.allowlist ?? null,
      origin: "https://hcis.example.test",
      now: () => now,
      rules: options.rules,
    });
  }

  async function occurrences(ruleKey: string, accountId: string) {
    return (await client.query<{ occurrenceKey: string }>(
      `SELECT occurrence_key AS "occurrenceKey" FROM reminder_occurrences WHERE rule_key = $1 AND recipient_account_id = $2 ORDER BY created_at`,
      [ruleKey, accountId],
    )).rows.map((row) => row.occurrenceKey);
  }

  async function inbox(accountId: string, prefix: string) {
    return (await client.query<{ title: string; href: string }>(
      `SELECT title, href FROM in_app_notifications WHERE recipient_account_id = $1 AND event_key LIKE $2`,
      [accountId, `${prefix}%`],
    )).rows;
  }

  async function deliveries(accountId: string) {
    return (await client.query<{ status: string; errorCode: string | null; text: string }>(
      `SELECT delivery.status, delivery.error_code AS "errorCode", delivery.message_text AS text
         FROM reminder_deliveries delivery JOIN reminder_occurrences occurrence ON occurrence.id = delivery.occurrence_id
        WHERE occurrence.recipient_account_id = $1`,
      [accountId],
    )).rows;
  }

  async function pendingTripStep(approver: Who, requester: Who) {
    const requestId = randomUUID();
    const start = addDays(jakartaClock(morning()).date, 10);
    await client.query(
      `INSERT INTO business_trip_requests (id, employee_id, destination, purpose, start_on, end_on, status, idempotency_key)
       VALUES ($1,$2,'Kota Uji','Kunjungan kerja sintetis untuk uji',$3::date,$3::date,'IN_REVIEW',$4)`,
      [requestId, people[requester].employeeId, start, randomUUID()],
    );
    await client.query(
      `INSERT INTO business_trip_approval_steps (id, request_id, step_order, approver_employee_id, sources, status)
       VALUES ($1,$2,1,$3,ARRAY['DIRECT_MANAGER'],'pending')`,
      [randomUUID(), requestId, people[approver].employeeId],
    );
  }

  async function grantPermissions(who: Who, keys: string[]) {
    const roleId = randomUUID();
    await client.query("INSERT INTO roles (id, role_key, name) VALUES ($1,$2,'Peran uji pengingat')", [roleId, `rem_test_${roleId.slice(0, 8)}`]);
    for (const key of keys) {
      await client.query("INSERT INTO permissions (permission_key, description) VALUES ($1,'uji') ON CONFLICT DO NOTHING", [key]);
      await client.query("INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2)", [roleId, key]);
    }
    await client.query(
      `INSERT INTO account_role_assignments (id, account_id, role_id, scope_type, reason) VALUES ($1,$2,$3,'organization','uji')`,
      [randomUUID(), people[who].accountId, roleId],
    );
  }

  async function certificate(who: Who, expiresOn: string) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO employee_skills (id, employee_id, kind, name, category, issuer, issued_on, expires_on)
       VALUES ($1,$2,'SERTIFIKAT','Sertifikat Uji','LAINNYA','Lembaga Uji','2024-01-01',$3::date)`,
      [id, people[who].employeeId, expiresOn],
    );
    return id;
  }

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    for (const who of ["approver", "requester", "hc", "plain"] as const) await insertPerson(who);
  });

  afterEach(async () => {
    if (client) { await client.query("ROLLBACK"); client.release(); }
  });

  it("every rule's query runs against the real schema", async () => {
    const today = jakartaClock(morning()).date;
    for (const rule of REMINDER_RULES) {
      await expect(rule.generate(client, { today }), rule.key).resolves.toBeInstanceOf(Array);
    }
  });

  it("NOTIF-003-A/D: the approval digest counts only that approver's pending steps, once per day", async () => {
    await pendingTripStep("approver", "requester");
    await pendingTripStep("approver", "plain");
    const now = morning();
    const first = await engine(now).tick();
    expect(first.runs.find((run) => run.ruleKey === "approval.pending_digest")?.status).toBe("RAN");
    expect(await occurrences("approval.pending_digest", people.approver.accountId)).toEqual([jakartaClock(now).date]);
    expect(await inbox(people.approver.accountId, "reminder.approval.pending_digest")).toEqual([
      { title: "2 persetujuan menunggu Anda", href: "/app/approvals" },
    ]);
    // Nobody else had a pending step, so nobody else got a digest.
    expect(await occurrences("approval.pending_digest", people.requester.accountId)).toEqual([]);

    const second = await engine(now).tick();
    expect(second.runs.every((run) => run.status === "SKIPPED")).toBe(true);
    // Running the rule again directly (run row gone) still cannot duplicate: occurrences are unique.
    await client.query("DELETE FROM reminder_rule_runs WHERE rule_key = 'approval.pending_digest'");
    await engine(now).runRule(findReminderRule("approval.pending_digest")!, now);
    expect(await inbox(people.approver.accountId, "reminder.approval.pending_digest")).toHaveLength(1);
    expect(await deliveries(people.approver.accountId)).toHaveLength(1);
  });

  it("NOTIF-003-B: nothing is made or handed over outside 06:00–21:00 WIB, and late messages expire", async () => {
    await pendingTripStep("approver", "requester");
    const early = new Date(`${jakartaClock(morning()).date}T05:30:00+07:00`);
    expect(await engine(early).tick()).toEqual({ runs: [], delivered: 0 });
    expect(await occurrences("approval.pending_digest", people.approver.accountId)).toEqual([]);

    const sender = new FakeSender("log");
    const now = morning();
    await engine(now, { sender: new FakeSender("log") }).runRule(findReminderRule("approval.pending_digest")!, now);
    const late = new Date(`${jakartaClock(now).date}T21:30:00+07:00`);
    expect(await engine(late, { sender }).handOverDeliveries()).toBe(0);
    expect(sender.sent).toHaveLength(0);
    // Once 21:00 WIB of its day has passed, a queued message is dropped, not sent the next morning.
    await client.query("UPDATE reminder_deliveries SET expires_at = now() - interval '1 minute'");
    expect(await engine(now, { sender }).handOverDeliveries()).toBe(0);
    expect((await deliveries(people.approver.accountId))[0]).toMatchObject({ status: "SKIPPED", errorCode: "expired" });
  });

  it("NOTIF-003-C/H: thresholds are windows; inactive accounts get nothing", async () => {
    const now = morning();
    const today = jakartaClock(now).date;
    await certificate("plain", addDays(today, 20));
    await certificate("requester", addDays(today, 20));
    await client.query("UPDATE accounts SET status = 'inactive' WHERE id = $1", [people.requester.accountId]);
    const rule = findReminderRule("employee.certificate_expiring")!;

    await engine(now).runRule(rule, now);
    const first = await occurrences(rule.key, people.plain.accountId);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatch(/:30$/);
    expect(await occurrences(rule.key, people.requester.accountId)).toEqual([]);

    // The next day is still inside the 30-day window: no second reminder.
    const tomorrow = new Date(now.getTime() + 86_400_000);
    await engine(tomorrow).runRule(rule, tomorrow);
    expect(await occurrences(rule.key, people.plain.accountId)).toHaveLength(1);

    // Thirteen days later seven are left: the H-7 reminder fires once.
    const later = new Date(now.getTime() + 13 * 86_400_000);
    await engine(later).runRule(rule, later);
    const after = await occurrences(rule.key, people.plain.accountId);
    expect(after).toHaveLength(2);
    expect(after[1]).toMatch(/:7$/);
    expect((await inbox(people.plain.accountId, "reminder.employee.certificate_expiring"))[1]!.title)
      .toBe("Sertifikat Sertifikat Uji berakhir 7 hari lagi");
  });

  it("NOTIF-003-E/I: an HC digest reaches permission holders only and names nobody in WhatsApp", async () => {
    await grantPermissions("hc", ["documents.manage"]);
    const now = morning();
    const requestId = randomUUID();
    await client.query(
      `INSERT INTO hr_document_requests (id, employee_id, document_code, purpose, status, created_at)
       VALUES ($1,$2,'KETERANGAN_KERJA','Keperluan uji pengingat','SUBMITTED',$3::timestamptz - interval '3 days')`,
      [requestId, people.requester.employeeId, now.toISOString()],
    );
    await engine(now).runRule(findReminderRule("documents.request_queue_digest")!, now);
    expect(await occurrences("documents.request_queue_digest", people.hc.accountId)).toHaveLength(1);
    expect(await occurrences("documents.request_queue_digest", people.plain.accountId)).toEqual([]);
    const [delivery] = await deliveries(people.hc.accountId);
    expect(delivery!.text).toMatch(/permintaan surat keterangan menunggu/);
    expect(delivery!.text).not.toContain("Pegawai requester");
  });

  it("NOTIF-003-F: WhatsApp off keeps the in-app reminder and queues nothing; changes are audited and self-only", async () => {
    const config = { NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8 } as ApiConfig;
    let principal = { id: people.approver.accountId, email: "a@example.invalid", principalType: "EMPLOYEE" as const };
    const app = Fastify({ logger: false });
    await registerReminderRoutes(app, savepointPool(client), config, {
      getSession: async () => ({ principal, expiresAt: "2099-01-01T00:00:00Z" }),
    } as never);
    try {
      const listed = await app.inject({ method: "GET", url: "/me/reminders/preferences" });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().items.map((item: { ruleKey: string }) => item.ruleKey)).toEqual(REMINDER_RULES.map((rule) => rule.key));
      const off = await app.inject({ method: "PUT", url: "/me/reminders/preferences/approval.pending_digest", payload: { whatsapp: false } });
      expect(off.statusCode, off.body).toBe(200);
      expect(off.json().items.find((item: { ruleKey: string }) => item.ruleKey === "approval.pending_digest")).toMatchObject({ whatsapp: false, inApp: true });
      // Same value again: no second audit row.
      await app.inject({ method: "PUT", url: "/me/reminders/preferences/approval.pending_digest", payload: { whatsapp: false } });
      expect((await app.inject({ method: "PUT", url: "/me/reminders/preferences/meeting.upcoming", payload: { whatsapp: false } })).statusCode).toBe(404);
      expect((await app.inject({ method: "PUT", url: "/me/reminders/preferences/approval.pending_digest", payload: { whatsapp: "no" } })).statusCode).toBe(400);
      const audits = await client.query("SELECT metadata FROM reminder_audit_events WHERE account_id = $1", [people.approver.accountId]);
      expect(audits.rows).toEqual([{ metadata: { whatsapp: { from: true, to: false } } }]);
      // Another account's preference is untouched.
      expect((await client.query("SELECT 1 FROM reminder_preferences WHERE account_id = $1", [people.plain.accountId])).rows).toEqual([]);

      principal = { id: randomUUID(), email: "x@example.invalid", principalType: "EMPLOYEE" };
      expect((await app.inject({ method: "GET", url: "/me/reminders/preferences" })).statusCode).toBe(403);
    } finally {
      await app.close();
    }

    await pendingTripStep("approver", "requester");
    const now = morning();
    await engine(now).runRule(findReminderRule("approval.pending_digest")!, now);
    expect(await inbox(people.approver.accountId, "reminder.approval.pending_digest")).toHaveLength(1);
    expect(await deliveries(people.approver.accountId)).toEqual([]);
  });

  it("review fixes: closed requests are not counted, long names are clipped, OFF history is silent, same-day opt-out holds", async () => {
    await pendingTripStep("approver", "requester");
    await pendingTripStep("approver", "plain");
    await client.query(
      `UPDATE business_trip_requests SET status = 'CANCELLED', cancel_reason = 'Batal uji'
        WHERE id = (SELECT request_id FROM business_trip_approval_steps WHERE approver_employee_id = $1 LIMIT 1)`,
      [people.approver.employeeId],
    );
    const now = morning();
    await engine(now).runRule(findReminderRule("approval.pending_digest")!, now);
    expect((await inbox(people.approver.accountId, "reminder.approval.pending_digest"))[0]!.title).toBe("1 persetujuan menunggu Anda");

    // A WhatsApp switched off after the reminder was made is still honoured at hand-over.
    await client.query(
      "INSERT INTO reminder_preferences (account_id, rule_key, whatsapp_enabled) VALUES ($1,'approval.pending_digest',false)",
      [people.approver.accountId],
    );
    await client.query("UPDATE reminder_deliveries SET expires_at = now() + interval '1 hour'");
    const kirim = new FakeSender("kirim");
    await engine(now, { sender: kirim, allowlist: null }).handOverDeliveries();
    expect(kirim.sent).toHaveLength(0);
    expect((await deliveries(people.approver.accountId))[0]).toMatchObject({ status: "SKIPPED", errorCode: "opted_out" });

    const today = jakartaClock(now).date;
    await client.query(
      `INSERT INTO employee_skills (id, employee_id, kind, name, category, issuer, issued_on, expires_on)
       VALUES ($1,$2,'SERTIFIKAT',$3,'LAINNYA','Lembaga Uji','2024-01-01',$4::date)`,
      [randomUUID(), people.plain.employeeId, "S".repeat(200), addDays(today, 5)],
    );
    const certificateRun = await engine(now).runRule(findReminderRule("employee.certificate_expiring")!, now);
    expect(certificateRun.status).toBe("RAN");
    const [note] = await inbox(people.plain.accountId, "reminder.employee.certificate_expiring");
    expect([...note!.title].length).toBe(160);

    await client.query("UPDATE employment_rollout_settings SET mode = 'OFF' WHERE id = 1");
    expect(await findReminderRule("employment.term_ending")!.generate(client, { today })).toEqual([]);
  });

  it("D-05: a failing rule is recorded without its message, does not stop the others, and is not retried that day", async () => {
    const broken: ReminderRule = {
      key: "test_reminder.broken", label: "Rusak", description: "Uji", defaultWhatsApp: false, fireHour: 6,
      async generate(db) { await db.query("SELECT * FROM table_that_does_not_exist"); return []; },
    };
    await pendingTripStep("approver", "requester");
    const now = morning();
    const runs = (await engine(now, { rules: [broken, findReminderRule("approval.pending_digest")!] }).tick()).runs;
    expect(runs.map((run) => run.status)).toEqual(["FAILED", "RAN"]);
    const recorded = await client.query(`SELECT error_code FROM reminder_rule_runs WHERE rule_key = 'test_reminder.broken'`);
    expect(recorded.rows).toEqual([{ error_code: "sqlstate_42P01" }]);
    expect((await engine(now, { rules: [broken] }).tick()).runs.map((run) => run.status)).toEqual(["SKIPPED"]);
  });

  it("NOTIF-003-G: the allowlist limits real WhatsApp; the log adapter only records a dry run", async () => {
    await pendingTripStep("approver", "requester");
    await pendingTripStep("plain", "requester");
    const now = morning();
    await engine(now).runRule(findReminderRule("approval.pending_digest")!, now);
    await client.query("UPDATE reminder_deliveries SET expires_at = now() + interval '1 hour'");

    const kirim = new FakeSender("kirim");
    const handed = await engine(now, { sender: kirim, allowlist: new Set([people.approver.nip]) }).handOverDeliveries();
    expect(handed).toBe(1);
    expect(kirim.sent).toHaveLength(1);
    expect(kirim.sent[0]).toMatchObject({ to: "+6281234567890", ref: "rem:approval.pending_digest" });
    expect(kirim.sent[0]!.text).toContain("https://hcis.example.test/app/approvals");
    expect((await deliveries(people.approver.accountId))[0]!.status).toBe("HANDED_OVER");
    expect((await deliveries(people.plain.accountId))[0]).toMatchObject({ status: "SKIPPED", errorCode: "not_allowlisted" });

    await client.query(`DELETE FROM reminder_rule_runs; DELETE FROM reminder_deliveries; DELETE FROM reminder_occurrences`);
    await engine(now).runRule(findReminderRule("approval.pending_digest")!, now);
    await client.query("UPDATE reminder_deliveries SET expires_at = now() + interval '1 hour'");
    const log = new FakeSender("log");
    await engine(now, { sender: log, allowlist: new Set() }).handOverDeliveries();
    expect((await deliveries(people.plain.accountId))[0]!.status).toBe("DRY_RUN");
  });
});

/** NOTIF-003-A under real concurrency: two engines, one rule, separate connections. */
describe.skipIf(!allowed)("NOTIF-003-A concurrent runners", () => {
  let pool: Pool;
  const accountId = randomUUID();
  const employeeId = randomUUID();
  const ruleKey = "test_reminder.concurrency";

  const rule: ReminderRule = {
    key: ruleKey,
    label: "Uji",
    description: "Uji konkuren",
    defaultWhatsApp: true,
    fireHour: 6,
    async generate(_db, { today }) {
      // Slow enough that both runners are inside the rule at once.
      await new Promise((resolve) => setTimeout(resolve, 150));
      return [{ occurrenceKey: today, accountId, employeeId, title: "Uji", body: "Uji", href: "/app/notifications", whatsappText: "Uji" }];
    },
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl!, max: 6 });
    await pool.query(
      `INSERT INTO employees(id, employee_number, full_name, status, started_on) VALUES ($1,$2,'Pengingat Konkuren','active','2020-01-06')`,
      [employeeId, `REM-C-${employeeId.slice(0, 8)}`],
    );
    await pool.query(
      "INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1,$2,$3,'EMPLOYEE','active')",
      [accountId, employeeId, `rem-c-${accountId}@example.invalid`],
    );
  });

  afterAll(async () => {
    try {
      if (pool) {
        await pool.query(`DELETE FROM reminder_deliveries WHERE employee_id = $1`, [employeeId]);
        await pool.query(`DELETE FROM reminder_occurrences WHERE recipient_account_id = $1`, [accountId]);
        await pool.query(`DELETE FROM reminder_rule_runs WHERE rule_key = $1`, [ruleKey]);
        await pool.query(`DELETE FROM in_app_notifications WHERE recipient_account_id = $1`, [accountId]);
        await pool.query("DELETE FROM accounts WHERE id = $1", [accountId]);
        await pool.query("DELETE FROM employees WHERE id = $1", [employeeId]);
      }
    } finally {
      await pool?.end();
    }
  });

  it("runs a rule once when two runners start it together", async () => {
    const now = morning();
    const make = () => new ReminderEngine(pool, new FakeSender("log"), { allowlist: null, origin: null, now: () => now, rules: [rule] });
    const [first, second] = await Promise.all([make().runRule(rule, now), make().runRule(rule, now)]);
    expect([first.status, second.status].sort()).toEqual(["RAN", "SKIPPED"]);
    const rows = await pool.query("SELECT 1 FROM reminder_occurrences WHERE recipient_account_id = $1", [accountId]);
    expect(rows.rows).toHaveLength(1);
    const notes = await pool.query("SELECT 1 FROM in_app_notifications WHERE recipient_account_id = $1", [accountId]);
    expect(notes.rows).toHaveLength(1);
  });
});
