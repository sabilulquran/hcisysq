// LEAVE-010 acceptance against a real schema: the active line approver receives an in-app
// notification, and the requester withdraws a request that still awaits a decision.
// Synthetic employees only; every test runs inside one rolled-back transaction.

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import { AuthService } from "../src/modules/auth/service.js";
import { registerLeaveCriticalPeriodRoutes } from "../src/modules/leave/critical-period-routes.js";
import { encodeWorkingWeekdays } from "../src/modules/leave/domain/working-calendar.js";
import { registerEmployeeLeaveRoutes } from "../src/modules/leave/employee-routes.js";

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

type Person = "requester" | "manager" | "unitApprover" | "other" | "hcAdmin" | "hcReviewer";

// Monday 5 January 2099, 08:00 Jakarta. The leave below is four weeks later, inside JAN_MAR.
const NOW = new Date("2099-01-05T01:00:00Z");
const LEAVE = { startOn: "2099-02-02", endOn: "2099-02-03" };

describe.skipIf(!allowed)("LEAVE-010 approver notification and requester cancellation", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let unitId: string;
  const people = {} as Record<Person, { employeeId: string; accountId: string; cookie: string }>;

  async function grant(who: Person, permissions: string[]) {
    const roleId = randomUUID();
    await client.query(
      "INSERT INTO roles(id, role_key, name, is_system) VALUES ($1, $2, 'Peran sintetis LEAVE-010', false)",
      [roleId, `leave010-${roleId}`],
    );
    for (const permission of permissions) {
      await client.query("INSERT INTO role_permissions(role_id, permission_key) VALUES ($1, $2)", [roleId, permission]);
    }
    await client.query(
      `INSERT INTO account_role_assignments(id, account_id, role_id, scope_type) VALUES ($1, $2, $3, 'organization')`,
      [randomUUID(), people[who].accountId, roleId],
    );
  }

  function call(who: Person, method: "GET" | "POST", url: string, payload?: object) {
    return app.inject({ method, url, headers: { cookie: people[who].cookie }, ...(payload ? { payload } : {}) });
  }

  async function submitAnnual(dates = LEAVE) {
    const response = await call("requester", "POST", "/leave/me/annual/submit", {
      ...dates, reason: "Acara keluarga rahasia", idempotencyKey: randomUUID(),
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string; approvalChain: Array<{ id: string }> };
  }

  async function inbox(who: Person) {
    const rows = await client.query<{ eventKey: string; title: string; body: string; href: string }>(
      `SELECT event_key AS "eventKey", title, body, href FROM in_app_notifications
        WHERE recipient_account_id = $1 ORDER BY created_at, event_key`,
      [people[who].accountId],
    );
    return rows.rows;
  }

  async function statusOf(table: string, requestId: string) {
    const rows = await client.query<{ status: string }>(
      `SELECT status FROM ${table} WHERE leave_request_id = $1 ORDER BY created_at`, [requestId],
    );
    return rows.rows.map((row) => row.status);
  }

  async function cancelEvent(requestId: string) {
    const rows = await client.query<{ actor: string; payload: Record<string, unknown> }>(
      `SELECT actor_account_id AS actor, payload FROM leave_request_events
        WHERE leave_request_id = $1 AND event_type = 'leave.request.cancelled'`,
      [requestId],
    );
    return rows.rows;
  }

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    vi.setSystemTime(NOW);
    client = await pool.connect();
    await client.query("BEGIN");
    const transactionPool = savepointPool(client);
    unitId = randomUUID();
    await client.query(
      "INSERT INTO organizational_units(id, normalized_name, name) VALUES ($1, $2, 'Unit Batal Sintetis')",
      [unitId, `leave010-${unitId}`],
    );
    await client.query(
      `INSERT INTO leave_calendar_settings(singleton, timezone, working_weekday_mask)
       VALUES (true, 'Asia/Jakarta', $1)
       ON CONFLICT (singleton) DO UPDATE SET working_weekday_mask = EXCLUDED.working_weekday_mask`,
      [encodeWorkingWeekdays([1, 2, 3, 4, 5])],
    );
    await client.query("DELETE FROM leave_calendar_exceptions WHERE calendar_date BETWEEN '2099-01-01' AND '2099-03-31'");
    // LEGACY authority resolution is what production runs today.
    await client.query("DELETE FROM organization_rollout_settings");
    await client.query("UPDATE leave_critical_periods SET is_active = false WHERE starts_on <= '2099-03-31' AND ends_on >= '2099-01-01'");

    const config = {
      NODE_ENV: "test", HOST: "127.0.0.1", PORT: 3001, DATABASE_URL: databaseUrl!,
      AUTH_MODE: "local", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8,
    } as ApiConfig;
    const auth = new AuthService(transactionPool, config.AUTH_ENCRYPTION_KEY!, 8, false);
    for (const who of ["manager", "unitApprover", "requester", "other", "hcAdmin", "hcReviewer"] as const) {
      const employeeId = randomUUID();
      await client.query(
        `INSERT INTO employees(id, employee_number, full_name, status, started_on, organizational_unit_id,
                               leave_entitlement_group)
         VALUES ($1, $2, $3, 'active', '2020-01-06', $4, 'non_education')`,
        [employeeId, `L010-${employeeId.slice(0, 8)}`, `Pegawai ${who}`, unitId],
      );
      const accountId = randomUUID();
      await client.query(
        "INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1, $2, $3, 'EMPLOYEE', 'active')",
        [accountId, employeeId, `leave010-${accountId}@example.invalid`],
      );
      const session = await auth.createSessionForAccountId(accountId, {
        ipAddress: "127.0.0.1", userAgent: "rollback-only-leave010-test",
      });
      people[who] = { employeeId, accountId, cookie: session.setCookie.split(";")[0]! };
    }
    await client.query(
      "UPDATE organizational_units SET leave_approver_employee_id = $2 WHERE id = $1",
      [unitId, people.unitApprover.employeeId],
    );
    await client.query(
      "UPDATE employees SET direct_manager_employee_id = $2 WHERE id = ANY($1::uuid[])",
      [[people.requester.employeeId, people.other.employeeId], people.manager.employeeId],
    );
    await grant("hcAdmin", ["leave.configuration.manage"]);
    await grant("hcReviewer", ["leave.validate", "leave.hc.approve"]);

    app = Fastify({ logger: false });
    await registerLeaveCriticalPeriodRoutes(app, transactionPool, config);
    await registerEmployeeLeaveRoutes(app, transactionPool, config);
  });

  afterEach(async () => {
    try { await app?.close(); } finally {
      if (client) { await client.query("ROLLBACK"); client.release(); }
      vi.useRealTimers();
    }
  });

  it("LEAVE-010-A/B: each line approver is notified in-app once, when their step becomes active", async () => {
    const request = await submitAnnual();
    const [first, second] = request.approvalChain;

    const managerInbox = await inbox("manager");
    expect(managerInbox).toEqual([{
      eventKey: `leave.approval.requested.${first!.id}`,
      title: "Pengajuan cuti menunggu persetujuan Anda",
      body: expect.stringMatching(/^Pegawai requester mengajukan Cuti Tahunan .*\(2 hari kerja\)\.$/),
      href: "/app/approvals",
    }]);
    expect(JSON.stringify(managerInbox)).not.toContain("rahasia");
    expect(await inbox("unitApprover")).toEqual([]);

    expect((await call("manager", "POST", `/leave/approvals/${first!.id}/decision`, { decision: "approve" })).statusCode).toBe(200);
    expect((await inbox("unitApprover")).map((row) => row.eventKey)).toEqual([`leave.approval.requested.${second!.id}`]);

    const last = await call("unitApprover", "POST", `/leave/approvals/${second!.id}/decision`, { decision: "approve" });
    expect(last.json().requestStatus).toBe("approved");
    const lineNotifications = await client.query(
      `SELECT 1 FROM in_app_notifications WHERE safe_metadata->>'leaveRequestId' = $1`, [request.id],
    );
    expect(lineNotifications.rowCount).toBe(2);
  });

  it("LEAVE-010-C/E: the requester cancels at the line stage; the approver is told and can no longer decide", async () => {
    const request = await submitAnnual();
    const [first] = request.approvalChain;
    // Planned leave carries an HC task waiting behind the line (Cuti Tanpa Gaji pattern).
    await client.query("UPDATE leave_requests SET hc_handling = 'approve' WHERE id = $1", [request.id]);
    await client.query(
      `INSERT INTO leave_request_hc_tasks(id, leave_request_id, task_kind, status) VALUES ($1, $2, 'approve', 'waiting')`,
      [randomUUID(), request.id],
    );

    const cancelled = await call("requester", "POST", `/leave/me/requests/${request.id}/cancel`, { reason: "Acara ditunda" });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json()).toEqual({ id: request.id, status: "cancelled" });

    const row = await client.query<{ status: string }>("SELECT status FROM leave_requests WHERE id = $1", [request.id]);
    expect(row.rows[0]!.status).toBe("cancelled");
    expect(await statusOf("leave_request_approval_steps", request.id)).toEqual(["cancelled", "cancelled"]);
    expect(await statusOf("leave_request_hc_tasks", request.id)).toEqual(["cancelled"]);
    expect(await cancelEvent(request.id)).toEqual([{
      actor: people.requester.accountId,
      payload: { policyKey: "annual", stage: "line", reason: "Acara ditunda" },
    }]);
    expect((await inbox("manager")).map((item) => item.title)).toEqual([
      "Pengajuan cuti menunggu persetujuan Anda", "Pengajuan cuti dibatalkan",
    ]);

    const managerQueue = await call("manager", "GET", "/leave/approvals");
    expect(managerQueue.json().items.map((item: { requestId: string }) => item.requestId)).not.toContain(request.id);
    const late = await call("manager", "POST", `/leave/approvals/${first!.id}/decision`, { decision: "approve" });
    expect(late.statusCode).toBe(409);
    expect(late.json().code).toBe("REQUEST_NOT_REVIEWABLE");

    const mine = await call("requester", "GET", "/leave/me/summary");
    expect(mine.json().requests.find((item: { id: string }) => item.id === request.id))
      .toMatchObject({ status: "cancelled", canCancel: false });
    // The working days are free again: the same dates can be requested anew.
    await submitAnnual();
  });

  it("LEAVE-010-C: cancelling while HC holds the task closes it and tells HC, not the line", async () => {
    const request = await submitAnnual();
    const [first, second] = request.approvalChain;
    // Cuti Tanpa Gaji pattern: line approval, then an HC approval task.
    await client.query("UPDATE leave_requests SET hc_handling = 'approve' WHERE id = $1", [request.id]);
    await client.query(
      `INSERT INTO leave_request_hc_tasks(id, leave_request_id, task_kind, status) VALUES ($1, $2, 'approve', 'waiting')`,
      [randomUUID(), request.id],
    );
    await call("manager", "POST", `/leave/approvals/${first!.id}/decision`, { decision: "approve" });
    const line = await call("unitApprover", "POST", `/leave/approvals/${second!.id}/decision`, { decision: "approve" });
    expect(line.json()).toMatchObject({ requestStatus: "in_review", hcTaskStatus: "pending" });

    const cancelled = await call("requester", "POST", `/leave/me/requests/${request.id}/cancel`, {});
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(await statusOf("leave_request_hc_tasks", request.id)).toEqual(["cancelled"]);
    expect((await cancelEvent(request.id))[0]!.payload).toEqual({ policyKey: "annual", stage: "hc" });
    const outbox = await client.query(
      `SELECT target_type, target_key FROM leave_notification_outbox
        WHERE leave_request_id = $1 AND event_type = 'leave.request.cancelled'`,
      [request.id],
    );
    expect(outbox.rows).toEqual([{ target_type: "role", target_key: "human_capital" }]);
    expect((await inbox("unitApprover")).map((item) => item.title)).not.toContain("Pengajuan cuti dibatalkan");
  });

  it("LEAVE-010-C: cancelling during the critical-period review closes the review and tells HC", async () => {
    const period = await call("hcAdmin", "POST", "/admin/leave/critical-periods", {
      label: "Ujian Yayasan", startOn: "2099-02-02", endOn: "2099-02-06", unitId: null,
    });
    expect(period.statusCode, period.body).toBe(201);
    const request = await submitAnnual();
    const [first, second] = request.approvalChain;
    await call("manager", "POST", `/leave/approvals/${first!.id}/decision`, { decision: "approve" });
    const line = await call("unitApprover", "POST", `/leave/approvals/${second!.id}/decision`, { decision: "approve" });
    expect(line.json()).toMatchObject({ requestStatus: "in_review", criticalReviewStatus: "pending" });
    const before = await call("requester", "GET", "/leave/me/requests");
    expect(before.json().requests.find((item: { id: string }) => item.id === request.id)).toMatchObject({ canCancel: true });

    const cancelled = await call("requester", "POST", `/leave/me/requests/${request.id}/cancel`, {});
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(await statusOf("leave_request_approval_steps", request.id)).toEqual(["approved", "approved"]);
    expect(await statusOf("leave_request_critical_reviews", request.id)).toEqual(["cancelled"]);
    expect((await cancelEvent(request.id))[0]!.payload).toEqual({ policyKey: "annual", stage: "critical_review" });
    const outbox = await client.query(
      `SELECT target_type, target_key FROM leave_notification_outbox
        WHERE leave_request_id = $1 AND event_type = 'leave.request.cancelled'`,
      [request.id],
    );
    expect(outbox.rows).toEqual([{ target_type: "role", target_key: "human_capital" }]);
    const queue = await call("hcReviewer", "GET", "/leave/hc/critical-reviews");
    expect(queue.json().items.map((item: { requestId: string }) => item.requestId)).not.toContain(request.id);
  });

  it("LEAVE-010-D: only my own request, only while it awaits a decision, only line-approval leave", async () => {
    const request = await submitAnnual();
    const foreign = await call("other", "POST", `/leave/me/requests/${request.id}/cancel`, {});
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().code).toBe("LEAVE_REQUEST_NOT_FOUND");
    expect((await call("requester", "POST", "/leave/me/requests/not-a-uuid/cancel", {})).statusCode).toBe(404);
    const tooLong = await call("requester", "POST", `/leave/me/requests/${request.id}/cancel`, { reason: "x".repeat(501) });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().code).toBe("INVALID_LEAVE_CANCELLATION");

    // Approved leave is post-approval cancellation, which stays with HC.
    const [first, second] = request.approvalChain;
    await call("manager", "POST", `/leave/approvals/${first!.id}/decision`, { decision: "approve" });
    await call("unitApprover", "POST", `/leave/approvals/${second!.id}/decision`, { decision: "approve" });
    const approved = await call("requester", "POST", `/leave/me/requests/${request.id}/cancel`, {});
    expect(approved.statusCode).toBe(409);
    expect(approved.json().code).toBe("LEAVE_REQUEST_NOT_CANCELLABLE");

    // A special leave report (line only notified) is withdrawn through HC.
    const report = randomUUID();
    await client.query(
      `INSERT INTO leave_requests(id, employee_id, policy_key, status, start_on, end_on, working_days,
                                  hc_handling, idempotency_key, line_handling)
       VALUES ($1, $2, 'sick', 'in_review', '2099-03-02', '2099-03-02', 1, 'validate', $3, 'notify')`,
      [report, people.requester.employeeId, randomUUID()],
    );
    const special = await call("requester", "POST", `/leave/me/requests/${report}/cancel`, {});
    expect(special.statusCode).toBe(409);
    expect(special.json().code).toBe("LEAVE_REQUEST_NOT_CANCELLABLE");

    // Twice: the second attempt finds nothing open and changes nothing.
    const again = await submitAnnual({ startOn: "2099-02-09", endOn: "2099-02-09" });
    expect((await call("requester", "POST", `/leave/me/requests/${again.id}/cancel`, {})).statusCode).toBe(200);
    const twice = await call("requester", "POST", `/leave/me/requests/${again.id}/cancel`, {});
    expect(twice.statusCode).toBe(409);
    expect(await cancelEvent(again.id)).toHaveLength(1);
    expect(await cancelEvent(request.id)).toHaveLength(0);
  });
});
