// LEAVE-008 acceptance against a real schema: the active line approver proposes other dates, the
// requester accepts (a replacement request with a fresh APR-001 snapshot) or declines.
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
import { registerPlannedLeaveRoutes } from "../src/modules/leave/planned-leave-routes.js";
import { registerLeavePostponementRoutes } from "../src/modules/leave/postponement-routes.js";

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

type Person = "requester" | "manager" | "unitApprover" | "other" | "hcAdmin" | "board";

// Monday 5 January 2099, 08:00 Jakarta. All dates below fall inside JAN_MAR (3-day limit).
const NOW = new Date("2099-01-05T01:00:00Z");
const LEAVE = { startOn: "2099-02-02", endOn: "2099-02-03" }; // Mon–Tue, 2 working days
const LATER = { startOn: "2099-02-09", endOn: "2099-02-11" }; // Mon–Wed, 3 working days
const NOTE = "Pekan itu ada akreditasi, mohon geser.";
const PDF = Buffer.from("%PDF-1.4\n% synthetic LEAVE-008 evidence\n").toString("base64");

describe.skipIf(!allowed)("LEAVE-008 leave postponement with proposed alternative dates", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let unitId: string;
  const people = {} as Record<Person, { employeeId: string | null; accountId: string; cookie: string }>;

  async function grant(who: Person, permissions: string[]) {
    const roleId = randomUUID();
    await client.query(
      "INSERT INTO roles(id, role_key, name, is_system) VALUES ($1, $2, 'Peran sintetis LEAVE-008', false)",
      [roleId, `leave008-${roleId}`],
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

  async function postpone(who: Person, stepId: string, dates = LATER, note = NOTE) {
    return call(who, "POST", `/leave/approvals/${stepId}/postpone`, { ...dates, note });
  }

  async function inbox(who: Person) {
    const rows = await client.query<{ eventKey: string; title: string; body: string; href: string }>(
      `SELECT event_key AS "eventKey", title, body, href FROM in_app_notifications
        WHERE recipient_account_id = $1 ORDER BY created_at, event_key`,
      [people[who].accountId],
    );
    return rows.rows;
  }

  async function requestRow(id: string) {
    const rows = await client.query<{ status: string; startOn: string; endOn: string; workingDays: number; replacesRequestId: string | null }>(
      `SELECT status, start_on::text AS "startOn", end_on::text AS "endOn", working_days AS "workingDays",
              replaces_request_id AS "replacesRequestId"
         FROM leave_requests WHERE id = $1`,
      [id],
    );
    return rows.rows[0]!;
  }

  async function statusOf(table: string, requestId: string) {
    const rows = await client.query<{ status: string }>(
      `SELECT status FROM ${table} WHERE leave_request_id = $1 ORDER BY created_at, status`, [requestId],
    );
    return rows.rows.map((row) => row.status);
  }

  async function stepStatuses(requestId: string) {
    const rows = await client.query<{ status: string }>(
      `SELECT status FROM leave_request_approval_steps WHERE leave_request_id = $1 ORDER BY step_order`, [requestId],
    );
    return rows.rows.map((row) => row.status);
  }

  async function events(requestId: string, prefix = "leave.postponement.") {
    const rows = await client.query<{ type: string; actor: string; payload: Record<string, unknown> }>(
      `SELECT event_type AS type, actor_account_id AS actor, payload FROM leave_request_events
        WHERE leave_request_id = $1 AND event_type LIKE $2 ORDER BY occurred_at`,
      [requestId, `${prefix}%`],
    );
    return rows.rows;
  }

  async function myRequest(id: string) {
    const response = await call("requester", "GET", "/leave/me/requests");
    expect(response.statusCode).toBe(200);
    return response.json().requests.find((item: { id: string }) => item.id === id);
  }

  async function availableNow() {
    return (await call("requester", "GET", "/leave/me/summary")).json().annualLeave.availableNowDays as number;
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
      "INSERT INTO organizational_units(id, normalized_name, name) VALUES ($1, $2, 'Unit Tunda Sintetis')",
      [unitId, `leave008-${unitId}`],
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
    for (const who of ["manager", "unitApprover", "requester", "other", "hcAdmin"] as const) {
      const employeeId = randomUUID();
      await client.query(
        `INSERT INTO employees(id, employee_number, full_name, status, started_on, organizational_unit_id,
                               leave_entitlement_group)
         VALUES ($1, $2, $3, 'active', '2020-01-06', $4, 'non_education')`,
        [employeeId, `L008-${employeeId.slice(0, 8)}`, `Pegawai ${who}`, unitId],
      );
      const accountId = randomUUID();
      await client.query(
        "INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1, $2, $3, 'EMPLOYEE', 'active')",
        [accountId, employeeId, `leave008-${accountId}@example.invalid`],
      );
      const session = await auth.createSessionForAccountId(accountId, {
        ipAddress: "127.0.0.1", userAgent: "rollback-only-leave008-test",
      });
      people[who] = { employeeId, accountId, cookie: session.setCookie.split(";")[0]! };
    }
    const boardAccountId = randomUUID();
    await client.query(
      "INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1, NULL, $2, 'FOUNDATION_BOARD', 'active')",
      [boardAccountId, `leave008-board-${boardAccountId}@example.invalid`],
    );
    const boardSession = await auth.createSessionForAccountId(boardAccountId, {
      ipAddress: "127.0.0.1", userAgent: "rollback-only-leave008-test",
    });
    people.board = { employeeId: null, accountId: boardAccountId, cookie: boardSession.setCookie.split(";")[0]! };

    await client.query(
      "UPDATE organizational_units SET leave_approver_employee_id = $2 WHERE id = $1",
      [unitId, people.unitApprover.employeeId],
    );
    await client.query(
      "UPDATE employees SET direct_manager_employee_id = $2 WHERE id = ANY($1::uuid[])",
      [[people.requester.employeeId, people.other.employeeId], people.manager.employeeId],
    );
    await grant("hcAdmin", ["leave.configuration.manage"]);

    app = Fastify({ logger: false });
    await registerLeaveCriticalPeriodRoutes(app, transactionPool, config);
    await registerEmployeeLeaveRoutes(app, transactionPool, config);
    await registerPlannedLeaveRoutes(app, transactionPool, config);
    await registerLeavePostponementRoutes(app, transactionPool, config);
  });

  afterEach(async () => {
    try { await app?.close(); } finally {
      if (client) { await client.query("ROLLBACK"); client.release(); }
      vi.useRealTimers();
    }
  });

  it("LEAVE-008-A/D: the active line approver proposes other dates; the quota is released and the requester is told", async () => {
    const request = await submitAnnual();
    const [first] = request.approvalChain;
    expect(await availableNow()).toBe(1);

    // The original 2 days are left out, so 3 new days fit the 3-day period limit.
    const preview = await call("manager", "POST", `/leave/approvals/${first!.id}/postponement/preview`, LATER);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ workingDays: 3, criticalReviewRequired: false, currentStartOn: LEAVE.startOn });
    expect(await requestRow(request.id)).toMatchObject({ status: "in_review" });

    const proposed = await postpone("manager", first!.id);
    expect(proposed.statusCode, proposed.body).toBe(200);
    const proposal = proposed.json();
    expect(proposal).toMatchObject({
      requestId: request.id, requestStatus: "postponement_proposed", stepStatus: "postponed",
      proposedStartOn: LATER.startOn, proposedEndOn: LATER.endOn, proposedWorkingDays: 3,
    });

    expect(await requestRow(request.id)).toMatchObject({ status: "postponement_proposed", ...LEAVE, workingDays: 2 });
    expect(await stepStatuses(request.id)).toEqual(["postponed", "cancelled"]);
    const step = await client.query(
      `SELECT decision_note, acted_by_account_id FROM leave_request_approval_steps WHERE id = $1`, [first!.id],
    );
    expect(step.rows[0]).toEqual({ decision_note: NOTE, acted_by_account_id: people.manager.accountId });
    expect(await events(request.id)).toEqual([{
      type: "leave.postponement.proposed",
      actor: people.manager.accountId,
      payload: expect.objectContaining({
        proposalId: proposal.proposalId, stepId: first!.id, policyKey: "annual",
        originalStartOn: LEAVE.startOn, proposedStartOn: LATER.startOn, proposedWorkingDays: 3,
      }),
    }]);
    expect(JSON.stringify(await events(request.id))).not.toContain("akreditasi");

    const notified = await inbox("requester");
    expect(notified).toEqual([{
      eventKey: `leave.postponement.proposed.${proposal.proposalId}`,
      title: "Penyetuju mengusulkan tanggal lain",
      body: expect.stringMatching(/^Pegawai manager mengusulkan Cuti Tahunan .*\(3 hari kerja\)/),
      href: "/app/leave",
    }]);
    expect(JSON.stringify(notified)).not.toMatch(/akreditasi|rahasia/);
    const outbox = await client.query(
      `SELECT target_type, target_key FROM leave_notification_outbox
        WHERE leave_request_id = $1 AND event_type = 'leave.postponement.proposed'`,
      [request.id],
    );
    expect(outbox.rows).toEqual([{ target_type: "employee", target_key: people.requester.employeeId }]);

    // D-08: the original holds no quota while it awaits the answer.
    expect(await availableNow()).toBe(3);
    expect(await myRequest(request.id)).toMatchObject({
      status: "postponement_proposed",
      canCancel: false,
      canRespondToPostponement: true,
      postponement: {
        id: proposal.proposalId, status: "proposed", proposedStartOn: LATER.startOn, proposedEndOn: LATER.endOn,
        proposedWorkingDays: 3, note: NOTE, proposedByName: "Pegawai manager",
      },
    });
    const queue = await call("manager", "GET", "/leave/approvals");
    expect(queue.json().items.map((item: { requestId: string }) => item.requestId)).not.toContain(request.id);
  });

  it("LEAVE-008-B/H: only the owner of the active line step may propose, and a postponed step cannot be decided", async () => {
    const request = await submitAnnual();
    const [first, second] = request.approvalChain;

    const foreign = await postpone("other", first!.id);
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().code).toBe("APPROVAL_FORBIDDEN");
    const self = await postpone("requester", first!.id);
    expect(self.statusCode).toBe(403);
    const early = await postpone("unitApprover", second!.id);
    expect(early.statusCode).toBe(409);
    expect(early.json().code).toBe("STEP_NOT_PENDING");
    const previewForeign = await call("other", "POST", `/leave/approvals/${first!.id}/postponement/preview`, LATER);
    expect(previewForeign.statusCode).toBe(403);
    expect((await postpone("manager", randomUUID())).statusCode).toBe(404);
    expect(await requestRow(request.id)).toMatchObject({ status: "in_review" });
    expect(await stepStatuses(request.id)).toEqual(["pending", "waiting"]);

    expect((await postpone("manager", first!.id)).statusCode).toBe(200);
    const late = await call("manager", "POST", `/leave/approvals/${first!.id}/decision`, { decision: "approve" });
    expect(late.statusCode).toBe(409);
    expect(late.json().code).toBe("REQUEST_NOT_REVIEWABLE");
    const twice = await postpone("manager", first!.id, { startOn: "2099-02-16", endOn: "2099-02-16" });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().code).toBe("REQUEST_NOT_REVIEWABLE");
    const cancel = await call("requester", "POST", `/leave/me/requests/${request.id}/cancel`, {});
    expect(cancel.statusCode).toBe(409);
    expect(cancel.json().code).toBe("LEAVE_REQUEST_NOT_CANCELLABLE");

    const proposalId = (await myRequest(request.id)).postponement.id as string;
    const foreignAccept = await call("other", "POST", `/leave/me/postponements/${proposalId}/accept`, { idempotencyKey: randomUUID() });
    expect(foreignAccept.statusCode).toBe(404);
    expect(foreignAccept.json().code).toBe("POSTPONEMENT_NOT_FOUND");
    expect((await call("other", "POST", `/leave/me/postponements/${proposalId}/decline`, {})).statusCode).toBe(404);
    expect((await call("manager", "POST", `/leave/me/postponements/${proposalId}/decline`, {})).statusCode).toBe(404);
  });

  it("LEAVE-008-B: a Foundation Board approver needs the governance capability on its own step", async () => {
    const request = await submitAnnual();
    const [first] = request.approvalChain;
    // A governance step snapshotted for the board account (ORG-013 principal shape).
    await client.query(
      `UPDATE leave_request_approval_steps SET approver_employee_id = NULL, approver_account_id = $2,
              sources = ARRAY['GOVERNANCE_APPROVER']::text[]
        WHERE id = $1`,
      [first!.id, people.board.accountId],
    );
    const without = await postpone("board", first!.id);
    expect(without.statusCode).toBe(403);
    expect(without.json().code).toBe("APPROVAL_FORBIDDEN");
    expect(await requestRow(request.id)).toMatchObject({ status: "in_review" });

    await grant("board", ["leave.governance.approve"]);
    const proposed = await postpone("board", first!.id);
    expect(proposed.statusCode, proposed.body).toBe(200);
    expect((await myRequest(request.id)).postponement.proposedByName).toBe("Penyetuju Pengurus Yayasan");

    const declined = await call("requester", "POST", `/leave/me/postponements/${proposed.json().proposalId}/decline`, {});
    expect(declined.statusCode, declined.body).toBe(200);
    expect((await inbox("board")).map((row) => row.title)).toEqual(["Usulan tanggal cuti ditolak pegawai"]);
  });

  it("LEAVE-008-C: a proposal that breaks the leave rules is refused and changes nothing", async () => {
    const request = await submitAnnual();
    const [first] = request.approvalChain;

    const same = await postpone("manager", first!.id, LEAVE);
    expect(same.json().code).toBe("POSTPONEMENT_DATES_UNCHANGED");
    const past = await postpone("manager", first!.id, { startOn: "2099-01-05", endOn: "2099-01-05" });
    expect(past.json().code).toBe("POSTPONEMENT_DATE_PASSED");
    const tooLong = await postpone("manager", first!.id, { startOn: "2099-02-09", endOn: "2099-02-12" });
    expect(tooLong.statusCode).toBe(409);
    expect(tooLong.json().code).toBe("PERIOD_LIMIT_EXCEEDED");
    const crossPeriod = await postpone("manager", first!.id, { startOn: "2099-03-31", endOn: "2099-04-01" });
    expect(crossPeriod.json().code).toBe("CROSS_PERIOD_REQUEST_UNSUPPORTED");
    const weekend = await postpone("manager", first!.id, { startOn: "2099-02-07", endOn: "2099-02-08" });
    expect(weekend.statusCode).toBe(409);
    const shortNote = await postpone("manager", first!.id, LATER, "ok");
    expect(shortNote.statusCode).toBe(400);
    expect(shortNote.json().code).toBe("INVALID_LEAVE_POSTPONEMENT");
    const badDate = await call("manager", "POST", `/leave/approvals/${first!.id}/postpone`, { startOn: "9 Feb", endOn: LATER.endOn, note: NOTE });
    expect(badDate.statusCode).toBe(400);

    expect(await requestRow(request.id)).toMatchObject({ status: "in_review" });
    expect(await stepStatuses(request.id)).toEqual(["pending", "waiting"]);
    expect(await events(request.id)).toEqual([]);
    const proposals = await client.query("SELECT 1 FROM leave_postponement_proposals WHERE leave_request_id = $1", [request.id]);
    expect(proposals.rowCount).toBe(0);
  });

  it("LEAVE-008-E: accepting submits a replacement with a fresh snapshot and keeps the original untouched", async () => {
    const request = await submitAnnual();
    const [first, second] = request.approvalChain;
    // The unit approver proposes at the second step, after the manager approved the original dates.
    expect((await call("manager", "POST", `/leave/approvals/${first!.id}/decision`, { decision: "approve" })).statusCode).toBe(200);
    const proposed = await postpone("unitApprover", second!.id);
    expect(proposed.statusCode, proposed.body).toBe(200);
    const proposalId = proposed.json().proposalId as string;
    expect(await stepStatuses(request.id)).toEqual(["approved", "postponed"]);

    const key = randomUUID();
    const accepted = await call("requester", "POST", `/leave/me/postponements/${proposalId}/accept`, { idempotencyKey: key });
    expect(accepted.statusCode, accepted.body).toBe(201);
    const body = accepted.json();
    expect(body).toMatchObject({
      proposalId, status: "accepted", requestId: request.id, replacementStatus: "in_review", idempotentReplay: false,
    });
    expect(body.approvalChain.map((step: { name: string }) => step.name)).toEqual(["Pegawai manager", "Pegawai unitApprover"]);

    // The original keeps its dates and history; the replacement carries the new dates.
    expect(await requestRow(request.id)).toMatchObject({ status: "postponed", ...LEAVE, workingDays: 2, replacesRequestId: null });
    expect(await stepStatuses(request.id)).toEqual(["approved", "postponed"]);
    const replacement = await requestRow(body.replacementRequestId);
    expect(replacement).toMatchObject({ status: "in_review", ...LATER, workingDays: 3, replacesRequestId: request.id });
    expect(await stepStatuses(body.replacementRequestId)).toEqual(["pending", "waiting"]);
    const summary = await client.query<{ summary: Record<string, unknown>; reason: string }>(
      `SELECT validation_summary AS summary, reason FROM leave_requests WHERE id = $1`, [body.replacementRequestId],
    );
    expect(summary.rows[0]!.reason).toBe("Acara keluarga rahasia");
    // D-06: notice is measured from the day the original was submitted (database clock).
    const submittedOn = await client.query<{ day: string }>(
      `SELECT (submitted_at AT TIME ZONE 'Asia/Jakarta')::date::text AS day FROM leave_requests WHERE id = $1`, [request.id],
    );
    expect(summary.rows[0]!.summary).toMatchObject({
      noticeReferenceOn: submittedOn.rows[0]!.day, replacesRequestId: request.id, postponementProposalId: proposalId,
    });

    expect(await events(request.id)).toEqual([
      expect.objectContaining({ type: "leave.postponement.proposed", actor: people.unitApprover.accountId }),
      { type: "leave.postponement.accepted", actor: people.requester.accountId, payload: { proposalId, replacementRequestId: body.replacementRequestId } },
    ]);
    expect((await events(body.replacementRequestId, "leave.request.submitted"))[0]!.payload).toMatchObject({
      replacesRequestId: request.id, postponementProposalId: proposalId,
    });
    // The replacement starts the chain again: the manager decides the new dates first.
    expect((await inbox("manager")).map((row) => row.eventKey)).toContain(`leave.approval.requested.${body.approvalChain[0].id}`);
    expect((await inbox("unitApprover")).map((row) => row.title)).toContain("Usulan tanggal cuti diterima");
    expect(await availableNow()).toBe(0);
    expect(await myRequest(request.id)).toMatchObject({
      status: "postponed", canRespondToPostponement: false,
      postponement: { status: "accepted", replacementRequestId: body.replacementRequestId },
    });
    expect(await myRequest(body.replacementRequestId)).toMatchObject({ replacesRequestId: request.id, canCancel: true });

    // Accepting again answers with the same replacement and creates nothing.
    const replay = await call("requester", "POST", `/leave/me/postponements/${proposalId}/accept`, { idempotencyKey: randomUUID() });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ replacementRequestId: body.replacementRequestId, idempotentReplay: true });
    const count = await client.query("SELECT 1 FROM leave_requests WHERE replaces_request_id = $1", [request.id]);
    expect(count.rowCount).toBe(1);
    const decline = await call("requester", "POST", `/leave/me/postponements/${proposalId}/decline`, {});
    expect(decline.statusCode).toBe(409);
    expect(decline.json().code).toBe("POSTPONEMENT_NOT_OPEN");

    // The replacement runs to approval through its own snapshot.
    const [newFirst, newSecond] = body.approvalChain as Array<{ id: string }>;
    await call("manager", "POST", `/leave/approvals/${newFirst!.id}/decision`, { decision: "approve" });
    const final = await call("unitApprover", "POST", `/leave/approvals/${newSecond!.id}/decision`, { decision: "approve" });
    expect(final.json().requestStatus).toBe("approved");
  });

  it("LEAVE-008-E/D-06/D-07: the chain in force at acceptance decides; notice stays with the first submission", async () => {
    const request = await submitAnnual();
    const first = (await postpone("manager", request.approvalChain[0]!.id)).json();
    // The organisation changes before the employee answers: the other employee becomes manager.
    await client.query("UPDATE employees SET direct_manager_employee_id = $2 WHERE id = $1",
      [people.requester.employeeId, people.other.employeeId]);
    const accepted = await call("requester", "POST", `/leave/me/postponements/${first.proposalId}/accept`, { idempotencyKey: randomUUID() });
    expect(accepted.statusCode, accepted.body).toBe(201);
    expect(accepted.json().approvalChain.map((step: { name: string }) => step.name)).toEqual(["Pegawai other", "Pegawai unitApprover"]);

    // Postponed a second time: the notice date is still the original submission day.
    const replacementId = accepted.json().replacementRequestId as string;
    const original = await client.query<{ day: string }>(
      `SELECT (submitted_at AT TIME ZONE 'Asia/Jakarta')::date::text AS day FROM leave_requests WHERE id = $1`, [request.id],
    );
    await client.query("UPDATE leave_requests SET submitted_at = submitted_at + interval '30 days' WHERE id = $1", [replacementId]);
    const second = await postpone("other", accepted.json().approvalChain[0].id, { startOn: "2099-02-16", endOn: "2099-02-17" });
    expect(second.statusCode, second.body).toBe(200);
    const again = await call("requester", "POST", `/leave/me/postponements/${second.json().proposalId}/accept`, { idempotencyKey: randomUUID() });
    expect(again.statusCode, again.body).toBe(201);
    const summary = await client.query<{ summary: { noticeReferenceOn: string; replacesRequestId: string } }>(
      `SELECT validation_summary AS summary FROM leave_requests WHERE id = $1`, [again.json().replacementRequestId],
    );
    expect(summary.rows[0]!.summary).toMatchObject({ noticeReferenceOn: original.rows[0]!.day, replacesRequestId: replacementId });
  });

  it("LEAVE-008-C: a proposal that overlaps another active leave of the requester is refused", async () => {
    const request = await submitAnnual();
    await submitAnnual({ startOn: "2099-02-10", endOn: "2099-02-10" });
    const overlap = await postpone("manager", request.approvalChain[0]!.id, { startOn: "2099-02-09", endOn: "2099-02-10" });
    expect(overlap.statusCode).toBe(409);
    expect(overlap.json().code).toBe("LEAVE_REQUEST_OVERLAP");
    expect(await requestRow(request.id)).toMatchObject({ status: "in_review" });
    // Overlapping the request's own dates is fine: it no longer holds them once postponed.
    const shifted = await postpone("manager", request.approvalChain[0]!.id, { startOn: "2099-02-03", endOn: "2099-02-03" });
    expect(shifted.statusCode, shifted.body).toBe(200);
  });

  it("LEAVE-008-F: acceptance revalidates; a quota used meanwhile refuses it and the proposal stays open", async () => {
    const request = await submitAnnual();
    const [first] = request.approvalChain;
    const proposed = await postpone("manager", first!.id, { startOn: "2099-02-09", endOn: "2099-02-10" });
    expect(proposed.statusCode, proposed.body).toBe(200);
    // While the proposal waits, the employee uses the released quota elsewhere.
    await submitAnnual({ startOn: "2099-02-16", endOn: "2099-02-17" });

    const refused = await call("requester", "POST", `/leave/me/postponements/${proposed.json().proposalId}/accept`, { idempotencyKey: randomUUID() });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("PERIOD_LIMIT_EXCEEDED");
    expect(await requestRow(request.id)).toMatchObject({ status: "postponement_proposed" });
    expect((await myRequest(request.id)).postponement.status).toBe("proposed");

    // Once the proposed start date arrives, it can only be declined.
    vi.setSystemTime(new Date("2099-02-09T01:00:00Z"));
    const passed = await call("requester", "POST", `/leave/me/postponements/${proposed.json().proposalId}/accept`, { idempotencyKey: randomUUID() });
    expect(passed.json().code).toBe("POSTPONEMENT_DATE_PASSED");
  });

  it("LEAVE-008-G: declining ends the original as cancelled and tells the proposer", async () => {
    const request = await submitAnnual();
    const [first] = request.approvalChain;
    const proposalId = (await postpone("manager", first!.id)).json().proposalId as string;

    const tooLong = await call("requester", "POST", `/leave/me/postponements/${proposalId}/decline`, { reason: "x".repeat(501) });
    expect(tooLong.statusCode).toBe(400);
    const declined = await call("requester", "POST", `/leave/me/postponements/${proposalId}/decline`, { reason: "Acara tidak bisa digeser" });
    expect(declined.statusCode, declined.body).toBe(200);
    expect(declined.json()).toMatchObject({ status: "declined", requestStatus: "cancelled", idempotentReplay: false });
    expect(await requestRow(request.id)).toMatchObject({ status: "cancelled", ...LEAVE });
    const row = await client.query(
      `SELECT status, response_note, responded_at IS NOT NULL AS responded FROM leave_postponement_proposals WHERE id = $1`, [proposalId],
    );
    expect(row.rows[0]).toEqual({ status: "declined", response_note: "Acara tidak bisa digeser", responded: true });
    expect((await events(request.id)).map((event) => event.type)).toEqual(["leave.postponement.proposed", "leave.postponement.declined"]);
    const managerInbox = await inbox("manager");
    expect(managerInbox.map((item) => item.title)).toContain("Usulan tanggal cuti ditolak pegawai");
    expect(JSON.stringify(managerInbox)).not.toContain("digeser");

    const replay = await call("requester", "POST", `/leave/me/postponements/${proposalId}/decline`, {});
    expect(replay.json()).toMatchObject({ idempotentReplay: true });
    const accept = await call("requester", "POST", `/leave/me/postponements/${proposalId}/accept`, { idempotencyKey: randomUUID() });
    expect(accept.json().code).toBe("POSTPONEMENT_NOT_OPEN");
    expect(await availableNow()).toBe(3);
  });

  it("LEAVE-008-I: planned leave carries its evidence and a fresh HC task; critical periods are matched again", async () => {
    const period = await call("hcAdmin", "POST", "/admin/leave/critical-periods", {
      label: "Ujian Sintetis", startOn: "2099-02-16", endOn: "2099-02-20", unitId: null,
    });
    expect(period.statusCode, period.body).toBe(201);
    const submitted = await call("requester", "POST", "/leave/planned/me/submit", {
      policyKey: "employee_marriage", ...LEAVE, hasEvidence: true, reason: null, idempotencyKey: randomUUID(),
      evidence: { fileName: "undangan.pdf", contentType: "application/pdf", contentBase64: PDF },
    });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const request = submitted.json() as { id: string; approvalChain: Array<{ id: string }> };

    const preview = await call("manager", "POST", `/leave/approvals/${request.approvalChain[0]!.id}/postponement/preview`, {
      startOn: "2099-02-16", endOn: "2099-02-17",
    });
    expect(preview.json()).toMatchObject({ workingDays: 2, criticalReviewRequired: true });
    const proposed = await postpone("manager", request.approvalChain[0]!.id, { startOn: "2099-02-16", endOn: "2099-02-17" });
    expect(proposed.statusCode, proposed.body).toBe(200);
    expect(await statusOf("leave_request_hc_tasks", request.id)).toEqual(["cancelled"]);
    expect((await inbox("requester"))[0]!.href).toBe("/app/leave/planned");
    const planned = await call("requester", "GET", "/leave/planned/me/summary");
    expect(planned.json().requests.find((item: { id: string }) => item.id === request.id)).toMatchObject({
      status: "postponement_proposed", canRespondToPostponement: true,
    });

    const accepted = await call("requester", "POST", `/leave/me/postponements/${proposed.json().proposalId}/accept`, { idempotencyKey: randomUUID() });
    expect(accepted.statusCode, accepted.body).toBe(201);
    expect(accepted.json().criticalReviewRequired).toBe(true);
    const replacementId = accepted.json().replacementRequestId as string;
    expect(await statusOf("leave_request_hc_tasks", replacementId)).toEqual(["waiting"]);
    expect(await statusOf("leave_request_critical_reviews", replacementId)).toEqual(["waiting"]);
    const evidence = await client.query<{ requestId: string; fileName: string }>(
      `SELECT leave_request_id AS "requestId", original_filename AS "fileName" FROM leave_request_evidence
        WHERE leave_request_id = ANY($1::uuid[]) ORDER BY leave_request_id = $2`,
      [[request.id, replacementId], replacementId],
    );
    expect(evidence.rows).toEqual([
      { requestId: request.id, fileName: "undangan.pdf" },
      { requestId: replacementId, fileName: "undangan.pdf" },
    ]);
  });
});
