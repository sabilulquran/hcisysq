// LEAVE-009 acceptance against a real schema: HC manages critical periods, Cuti Tahunan in one is
// warned about and recorded, and since D-12 (2026-11-18) the line chain alone decides it.
// Synthetic employees only; every test runs inside one rolled-back transaction.

import Fastify from "fastify";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import { AuthService } from "../src/modules/auth/service.js";
import { registerLeaveCriticalPeriodRoutes } from "../src/modules/leave/critical-period-routes.js";
import { encodeWorkingWeekdays } from "../src/modules/leave/domain/working-calendar.js";
import { registerEmployeeLeaveRoutes } from "../src/modules/leave/employee-routes.js";
import { registerMeetingRoutes } from "../src/modules/meetings/routes.js";

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

type Person = "requester" | "manager" | "unitApprover" | "hcAdmin" | "hcValidator";

// Monday 5 January 2099, 08:00 Jakarta. The leave below is four weeks later, inside JAN_MAR.
const NOW = new Date("2099-01-05T01:00:00Z");
const LEAVE = { startOn: "2099-02-02", endOn: "2099-02-03" };

describe.skipIf(!allowed)("LEAVE-009 critical periods", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let unitId: string;
  let otherUnitId: string;
  const people = {} as Record<Person, { employeeId: string; accountId: string; cookie: string }>;

  async function insertRole(permissions: string[]) {
    const id = randomUUID();
    await client.query(
      "INSERT INTO roles(id, role_key, name, is_system) VALUES ($1, $2, 'Peran sintetis LEAVE-009', false)",
      [id, `leave009-${id}`],
    );
    for (const permission of permissions) {
      await client.query("INSERT INTO role_permissions(role_id, permission_key) VALUES ($1, $2)", [id, permission]);
    }
    return id;
  }

  async function grant(who: Person, permissions: string[]) {
    await client.query(
      `INSERT INTO account_role_assignments(id, account_id, role_id, scope_type)
       VALUES ($1, $2, $3, 'organization')`,
      [randomUUID(), people[who].accountId, await insertRole(permissions)],
    );
  }

  function call(who: Person | null, method: "GET" | "POST" | "PATCH", url: string, payload?: object) {
    return app.inject({
      method, url,
      headers: who ? { cookie: people[who].cookie } : {},
      ...(payload ? { payload } : {}),
    });
  }

  async function createPeriod(payload: Record<string, unknown>) {
    const response = await call("hcAdmin", "POST", "/admin/leave/critical-periods", {
      label: "Ujian Tengah Semester", startOn: "2099-02-02", endOn: "2099-02-06", unitId: null, ...payload,
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string; label: string; isActive: boolean };
  }

  async function submitAnnual() {
    const response = await call("requester", "POST", "/leave/me/annual/submit", {
      ...LEAVE, reason: "Acara keluarga", idempotencyKey: randomUUID(),
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as {
      id: string;
      approvalChain: Array<{ id: string; employeeId: string }>;
    };
  }

  async function approveLine(request: { approvalChain: Array<{ id: string }> }) {
    const [first, second] = request.approvalChain;
    expect((await call("manager", "POST", `/leave/approvals/${first!.id}/decision`, { decision: "approve" })).statusCode)
      .toBe(200);
    const last = await call("unitApprover", "POST", `/leave/approvals/${second!.id}/decision`, { decision: "approve" });
    expect(last.statusCode, last.body).toBe(200);
    return last.json() as { requestStatus: string; hcTaskStatus: string | null };
  }

  async function requestStatus(id: string) {
    const row = await client.query<{ status: string }>("SELECT status FROM leave_requests WHERE id = $1", [id]);
    return row.rows[0]!.status;
  }

  /** D-06/D-12: the matched periods live on the request itself, as the record of what applied. */
  async function recordedPeriods(requestId: string): Promise<Array<{ label: string }> | null> {
    const row = await client.query<{ periods: Array<{ label: string }> | null }>(
      `SELECT validation_summary -> 'criticalPeriods' AS periods FROM leave_requests WHERE id = $1`,
      [requestId],
    );
    return row.rows[0]?.periods ?? null;
  }

  async function reviewRows(requestId: string) {
    const row = await client.query(
      "SELECT id FROM leave_request_critical_reviews WHERE leave_request_id = $1",
      [requestId],
    );
    return row.rowCount ?? 0;
  }

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    vi.setSystemTime(NOW);
    client = await pool.connect();
    await client.query("BEGIN");
    const transactionPool = savepointPool(client);
    unitId = randomUUID();
    otherUnitId = randomUUID();
    for (const [id, name] of [[unitId, "Unit Kritis Sintetis"], [otherUnitId, "Unit Lain Sintetis"]] as const) {
      await client.query(
        "INSERT INTO organizational_units(id, normalized_name, name) VALUES ($1, $2, $3)",
        [id, `leave009-${id}`, name],
      );
    }
    await client.query(
      `INSERT INTO leave_calendar_settings(singleton, timezone, working_weekday_mask)
       VALUES (true, 'Asia/Jakarta', $1)
       ON CONFLICT (singleton) DO UPDATE SET working_weekday_mask = EXCLUDED.working_weekday_mask`,
      [encodeWorkingWeekdays([1, 2, 3, 4, 5])],
    );
    await client.query("DELETE FROM leave_calendar_exceptions WHERE calendar_date BETWEEN '2099-01-01' AND '2099-03-31'");
    // LEGACY authority resolution is what production runs today.
    await client.query("DELETE FROM organization_rollout_settings");

    const config = {
      NODE_ENV: "test", HOST: "127.0.0.1", PORT: 3001, DATABASE_URL: databaseUrl!,
      AUTH_MODE: "local", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8,
    } as ApiConfig;
    const auth = new AuthService(transactionPool, config.AUTH_ENCRYPTION_KEY!, 8, false);
    for (const who of ["manager", "unitApprover", "requester", "hcAdmin", "hcValidator"] as const) {
      const employeeId = randomUUID();
      await client.query(
        `INSERT INTO employees(id, employee_number, full_name, status, started_on, organizational_unit_id,
                               leave_entitlement_group)
         VALUES ($1, $2, $3, 'active', '2020-01-06', $4, 'non_education')`,
        [employeeId, `L009-${employeeId.slice(0, 8)}`, `Pegawai ${who}`, unitId],
      );
      const accountId = randomUUID();
      await client.query(
        "INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1, $2, $3, 'EMPLOYEE', 'active')",
        [accountId, employeeId, `leave009-${accountId}@example.invalid`],
      );
      const session = await auth.createSessionForAccountId(accountId, {
        ipAddress: "127.0.0.1", userAgent: "rollback-only-leave009-test",
      });
      people[who] = { employeeId, accountId, cookie: session.setCookie.split(";")[0]! };
    }
    await client.query(
      "UPDATE organizational_units SET leave_approver_employee_id = $2 WHERE id = $1",
      [unitId, people.unitApprover.employeeId],
    );
    await client.query(
      "UPDATE employees SET direct_manager_employee_id = $2 WHERE id = $1",
      [people.requester.employeeId, people.manager.employeeId],
    );
    await grant("hcAdmin", ["leave.configuration.manage"]);
    await grant("hcValidator", ["leave.validate", "leave.hc.approve"]);

    app = Fastify({ logger: false });
    await registerLeaveCriticalPeriodRoutes(app, transactionPool, config);
    await registerEmployeeLeaveRoutes(app, transactionPool, config);
    await registerMeetingRoutes(app, transactionPool, config);
  });

  afterEach(async () => {
    try { await app?.close(); } finally {
      if (client) { await client.query("ROLLBACK"); client.release(); }
      vi.useRealTimers();
    }
  });

  it("LEAVE-009-A/I: HC Admin manages periods with audit; others are refused", async () => {
    for (const who of ["requester", "hcValidator"] as const) {
      expect((await call(who, "GET", "/admin/leave/critical-periods")).statusCode, who).toBe(403);
      expect((await call(who, "POST", "/admin/leave/critical-periods", {
        label: "PPDB", startOn: "2099-03-02", endOn: "2099-03-06", unitId: null,
      })).statusCode, who).toBe(403);
    }
    expect((await call(null, "GET", "/admin/leave/critical-periods")).statusCode).toBe(401);

    const period = await createPeriod({ label: "PPDB Unit", unitId });
    const tooLong = await call("hcAdmin", "POST", "/admin/leave/critical-periods", {
      label: "Terlalu panjang", startOn: "2099-01-01", endOn: "2099-05-01", unitId: null,
    });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().code).toBe("CRITICAL_PERIOD_TOO_LONG");
    const unknownUnit = await call("hcAdmin", "POST", "/admin/leave/critical-periods", {
      label: "Unit hilang", startOn: "2099-01-01", endOn: "2099-01-02", unitId: randomUUID(),
    });
    expect(unknownUnit.statusCode).toBe(404);

    const edited = await call("hcAdmin", "PATCH", `/admin/leave/critical-periods/${period.id}`, {
      label: "PPDB Gelombang 1", isActive: false,
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json()).toMatchObject({ label: "PPDB Gelombang 1", isActive: false, unitName: "Unit Kritis Sintetis" });

    const active = await call("hcAdmin", "GET", "/admin/leave/critical-periods?status=active");
    expect(active.json().items.map((item: { id: string }) => item.id)).not.toContain(period.id);
    const all = await call("hcAdmin", "GET", "/admin/leave/critical-periods?status=all&year=2099&pageSize=1");
    expect(all.json().pagination).toMatchObject({ page: 1, pageSize: 1, total: 1 });
    expect((await call("hcAdmin", "GET", "/admin/leave/critical-periods?pageSize=101")).statusCode).toBe(400);

    const audit = await client.query<{ action: string }>(
      "SELECT action FROM access_audit_events WHERE entity_type = 'leave_critical_period' AND entity_id = $1 ORDER BY occurred_at, action",
      [period.id],
    );
    expect(audit.rows.map((row) => row.action).sort()).toEqual([
      "leave.critical_period.created",
      "leave.critical_period.deactivated",
      "leave.critical_period.updated",
    ]);
  });

  it("LEAVE-009-B/C/D/E: warns, never blocks, and line approval alone finishes the request (D-12)", async () => {
    await createPeriod({ label: "Ujian Yayasan" });
    await createPeriod({ label: "PPDB unit lain", unitId: otherUnitId });
    const inactive = await createPeriod({ label: "Dibatalkan" });
    await call("hcAdmin", "PATCH", `/admin/leave/critical-periods/${inactive.id}`, { isActive: false });

    const preview = await call("requester", "POST", "/leave/me/annual/preview", LEAVE);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().criticalPeriods.map((item: { label: string }) => item.label)).toEqual(["Ujian Yayasan"]);
    expect(preview.json().criticalReviewRequired).toBeUndefined();

    const request = await submitAnnual();
    // The match is recorded on the request, but no review row and no extra stage is created.
    expect((await recordedPeriods(request.id))!.map((item) => item.label)).toEqual(["Ujian Yayasan"]);
    expect(await reviewRows(request.id)).toBe(0);

    const line = await approveLine(request);
    expect(line).toMatchObject({ requestStatus: "approved", hcTaskStatus: null });
    expect(await requestStatus(request.id)).toBe("approved");

    const mine = await call("requester", "GET", "/leave/me/summary");
    expect(mine.json().requests.find((item: { id: string }) => item.id === request.id))
      .toMatchObject({ status: "approved", currentApproverName: null });

    // The review queue and its decision route are gone with the stage.
    expect((await call("hcValidator", "GET", "/leave/hc/critical-reviews")).statusCode).toBe(404);

    const events = await client.query<{ event_type: string }>(
      "SELECT event_type FROM leave_request_events WHERE leave_request_id = $1",
      [request.id],
    );
    expect(events.rows.map((row) => row.event_type)).not.toContain("leave.critical_review.attached");
    expect(events.rows.map((row) => row.event_type)).toContain("leave.request.approved_step");
  });

  it("LEAVE-009-G: a later edit never changes what a submitted request recorded", async () => {
    const period = await createPeriod({ label: "Pembagian Rapor" });
    const request = await submitAnnual();
    await call("hcAdmin", "PATCH", `/admin/leave/critical-periods/${period.id}`, {
      label: "Diubah setelah pengajuan", isActive: false,
    });

    expect((await recordedPeriods(request.id))!.map((item) => item.label)).toEqual(["Pembagian Rapor"]);
    expect((await approveLine(request)).requestStatus).toBe("approved");
  });

  it("LEAVE-009-D: without a matching period the existing flow is unchanged", async () => {
    await createPeriod({ label: "Bulan lain", startOn: "2099-03-02", endOn: "2099-03-06" });
    const preview = await call("requester", "POST", "/leave/me/annual/preview", LEAVE);
    expect(preview.json()).toMatchObject({ criticalPeriods: [] });
    const request = await submitAnnual();
    expect(await recordedPeriods(request.id)).toBeNull();
    const line = await approveLine(request);
    expect(line).toMatchObject({ requestStatus: "approved" });
  });

  // D-12 data migration. This release deletes the code that would ever decide an open review, so
  // 0174 has to settle whatever production still holds. It already ran on this schema (empty), so
  // the test seeds rows and runs the file again: every statement is written to be re-runnable.
  it("LEAVE-009 D-12: migration 0174 settles reviews left open by the old stage", async () => {
    const migration = await readFile(
      new URL("../migrations/0174_leave_critical_review_retired.sql", import.meta.url),
      "utf8",
    );

    async function seed(input: { requestStatus: string; reviewStatus: "waiting" | "pending"; startOn: string }) {
      const requestId = randomUUID();
      await client.query(
        `INSERT INTO leave_requests (
           id, employee_id, policy_key, status, start_on, end_on, working_days, hc_handling, idempotency_key
         ) VALUES ($1, $2, 'annual', $3, $4::date, $4::date, 1, 'notify', $5)`,
        [requestId, people.requester.employeeId, input.requestStatus, input.startOn, randomUUID()],
      );
      await client.query(
        `INSERT INTO leave_request_critical_reviews (id, leave_request_id, status, period_snapshot)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [
          randomUUID(), requestId, input.reviewStatus,
          JSON.stringify([{ id: randomUUID(), label: "Ujian Lama", startOn: input.startOn, endOn: input.startOn, scope: "organization" }]),
        ],
      );
      return requestId;
    }

    // Line approval finished, HC never decided: the removed stage is the only thing it still waits for.
    const stranded = await seed({ requestStatus: "in_review", reviewStatus: "pending", startOn: "2099-04-06" });
    // Line approval still running: the review never became pending and never will.
    const running = await seed({ requestStatus: "in_review", reviewStatus: "waiting", startOn: "2099-04-07" });
    // Already decided elsewhere: nothing is owed, so the review only ends.
    const rejected = await seed({ requestStatus: "rejected", reviewStatus: "pending", startOn: "2099-04-08" });

    await client.query(migration);

    const reviews = await client.query<{ requestId: string; status: string; actedAt: Date | null }>(
      `SELECT leave_request_id AS "requestId", status, acted_at AS "actedAt"
         FROM leave_request_critical_reviews
        WHERE leave_request_id = ANY($1::uuid[])`,
      [[stranded, running, rejected]],
    );
    const byRequest = new Map(reviews.rows.map((row) => [row.requestId, row]));
    expect(byRequest.get(stranded)).toMatchObject({ status: "approved" });
    expect(byRequest.get(stranded)!.actedAt).not.toBeNull();
    expect(byRequest.get(running)).toMatchObject({ status: "cancelled" });
    expect(byRequest.get(rejected)).toMatchObject({ status: "cancelled" });

    // The stranded request is finished as the HC approval would have finished it (annual leave is
    // hc_handling = notify, so there is no administrative HC task to activate).
    expect(await requestStatus(stranded)).toBe("approved");
    expect(await requestStatus(running)).toBe("in_review");
    expect(await requestStatus(rejected)).toBe("rejected");

    const outbox = await client.query<{ eventType: string; targetType: string }>(
      `SELECT event_type AS "eventType", target_type AS "targetType"
         FROM leave_notification_outbox WHERE leave_request_id = ANY($1::uuid[]) ORDER BY event_type`,
      [[stranded, running, rejected]],
    );
    expect(outbox.rows).toEqual([
      { eventType: "leave.request.approved", targetType: "employee" },
      { eventType: "leave.request.approved.hc_notify", targetType: "role" },
    ]);

    const events = await client.query<{ settledAs: string }>(
      `SELECT payload ->> 'settledAs' AS "settledAs" FROM leave_request_events
        WHERE leave_request_id = ANY($1::uuid[]) AND event_type = 'leave.critical_review.retired'`,
      [[stranded, running, rejected]],
    );
    expect(events.rows.map((row) => row.settledAs).sort()).toEqual(["approved", "cancelled", "cancelled"]);

    // Re-running it changes nothing: no review is open any more.
    await client.query(migration);
    const open = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM leave_request_critical_reviews WHERE status IN ('waiting', 'pending')`,
    );
    expect(open.rows[0]!.count).toBe(0);
  });

  it("LEAVE-009-J: the calendar shows foundation-wide and own-unit periods only", async () => {
    await createPeriod({ label: "Ujian Yayasan" });
    await createPeriod({ label: "PPDB unit sendiri", unitId, startOn: "2099-02-09", endOn: "2099-02-13" });
    await createPeriod({ label: "PPDB unit lain", unitId: otherUnitId });
    const calendar = await call("requester", "GET", "/me/calendar?from=2099-02-01&to=2099-02-28");
    expect(calendar.statusCode, calendar.body).toBe(200);
    const periods = calendar.json().items.filter((item: { kind: string }) => item.kind === "critical_period");
    expect(periods.map((item: { label: string }) => item.label)).toEqual(["Ujian Yayasan", "PPDB unit sendiri"]);
  });
});
