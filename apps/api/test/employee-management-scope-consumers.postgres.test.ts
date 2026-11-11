// EMP-005 S2B-b (spec §8.7, EMP-005-L) against real PostgreSQL: every consumer
// of the active-employee population leaves a record marked "di luar
// pengelolaan HCIS" out, an unmarked record is unchanged, and the history of a
// marked record stays readable.
// Loopback CI database only; synthetic people; every write is rolled back.

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import { attendanceCalculationRows } from "../src/modules/attendance/calculation-rows.js";
import { calculationPairs } from "../src/modules/attendance/calculation-runner.js";
import { resolveOvertimeApprover } from "../src/modules/attendance/overtime-approver.js";
import { activeEmployees } from "../src/modules/attendance/reporting.js";
import { planScheduleChange } from "../src/modules/attendance/schedule-changes.js";
import { registerWorkArrangementRoutes } from "../src/modules/attendance/work-arrangement-routes.js";
import { registerAttendanceWorkforceRoutes } from "../src/modules/attendance/workforce-routes.js";
import { AuthService, type AuthPrincipal } from "../src/modules/auth/service.js";
import { loadBoardAggregates } from "../src/modules/board/aggregates.js";
import { registerEmploymentAdminRoutes } from "../src/modules/employment/admin-routes.js";
import { registerLeaveAdminRoutes } from "../src/modules/leave/admin-routes.js";
import { encodeWorkingWeekdays } from "../src/modules/leave/domain/working-calendar.js";
import { registerEmployeeLeaveRoutes } from "../src/modules/leave/employee-routes.js";
import { registerPlannedLeaveRoutes } from "../src/modules/leave/planned-leave-routes.js";
import { registerLeavePostponementRoutes } from "../src/modules/leave/postponement-routes.js";
import { registerSpecialLeaveRoutes } from "../src/modules/leave/special-leave-routes.js";
import { registerLoanRoutes } from "../src/modules/loans/routes.js";
import type { OrganizationSnapshot } from "../src/modules/organization/domain.js";
import { OrganizationAuthorityResolver } from "../src/modules/organization/resolver.js";
import { PostgresOrganizationRepository } from "../src/modules/organization/repository.js";
import { registerTripRoutes } from "../src/modules/trips/routes.js";

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
    if (statement.startsWith("BEGIN")) return client.query(`SAVEPOINT s2b_sp_${++depth}`);
    if (statement.startsWith("COMMIT")) {
      const name = `s2b_sp_${depth}`;
      depth -= 1;
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    if (statement.startsWith("ROLLBACK")) {
      const name = `s2b_sp_${depth}`;
      depth -= 1;
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    return client.query(text, values);
  };
  const handle = { query: run, release: () => {} };
  return { query: run, connect: async () => handle } as unknown as Pool;
}

type Person = "requester" | "manager" | "unitApprover" | "hc";

// Monday 5 January 2099, 08:00 Jakarta; the leave is four weeks later.
const NOW = new Date("2099-01-05T01:00:00Z");
const LEAVE = { startOn: "2099-02-02", endOn: "2099-02-03" };
const OUTSIDE = "EMPLOYEE_OUTSIDE_HCIS_READ_ONLY";
const LATER = { startOn: "2099-02-09", endOn: "2099-02-10" };
const PDF = Buffer.from("%PDF-1.4\n% synthetic S2B-b evidence\n").toString("base64");

/** A one-team ORG-004 structure: the head leads the team, the director sits above it. */
function structure(input: {
  staff: string; head: string; director: string; headPolicy?: "CLIMB_TO_PARENT" | "BLOCK";
}): OrganizationSnapshot {
  const from = "2026-01-01";
  const period = { effectiveFrom: from, effectiveTo: null };
  const policy = input.headPolicy ?? "CLIMB_TO_PARENT";
  return {
    changeSet: {
      id: "s2b-b-structure", name: "Struktur sintetis", effectiveOn: from, status: "PUBLISHED", baseChangeSetId: null,
      validationReport: { valid: true, issues: [] }, createdByAccountId: "admin", createdAt: `${from}T00:00:00.000Z`,
      validatedAt: `${from}T00:00:00.000Z`, publishedAt: `${from}T00:00:00.000Z`,
    },
    nodes: [
      { id: "n-root", stableKey: "node-root", name: "Root", nodeType: "team", parentNodeKey: null, active: true, visualRankOffset: 0, integrationCode: null, ...period },
      { id: "n-team", stableKey: "node-team", name: "Team", nodeType: "team", parentNodeKey: "node-root", active: true, visualRankOffset: 0, integrationCode: null, ...period },
    ],
    jobProfiles: [],
    positions: [
      { id: "p-dir", stableKey: "position-director", nodeKey: "node-root", title: "Direktur", parentPositionKey: null, singleIncumbent: true, vacancyPolicy: "CLIMB_TO_PARENT", active: true, visualRankOffset: 0, ...period },
      { id: "p-head", stableKey: "position-head", nodeKey: "node-team", title: "Kepala", parentPositionKey: "position-director", singleIncumbent: true, vacancyPolicy: policy, active: true, visualRankOffset: 0, ...period },
    ],
    memberships: [{ id: "m-staff", employeeId: input.staff, nodeKey: "node-team", jobProfileKey: null, isPrimary: true, ...period }],
    incumbencies: [
      { id: "i-head", positionKey: "position-head", employeeId: input.head, kind: "PRIMARY", reason: null, ...period },
      { id: "i-dir", positionKey: "position-director", employeeId: input.director, kind: "PRIMARY", reason: null, ...period },
    ],
    authorityBindings: [
      { id: "b-leader", subjectKind: "NODE", subjectKey: "node-team", bindingType: "LEADER", targetPositionKey: "position-head", vacancyPolicy: policy, ...period },
    ],
    reportingOverrides: [],
  } as unknown as OrganizationSnapshot;
}

describe.skipIf(!allowed)("EMP-005 S2B-b: consumers leave a record outside HCIS management out", () => {
  let pool: Pool;
  let client: PoolClient;
  let transactionPool: Pool;
  let app: ReturnType<typeof Fastify>;
  let unitId: string;
  const people = {} as Record<Person, { employeeId: string; accountId: string; cookie: string }>;
  let unitIdRef = "";

  async function mark(who: Person, reason: "BUMY" | "PENGURUS_YAYASAN" = "BUMY") {
    await client.query(
      `UPDATE employees
          SET management_scope = 'OUTSIDE_HCIS', management_scope_reason = $2,
              management_scope_note = 'Dikonfirmasi HC (sintetis)',
              management_scope_marked_at = now(), management_scope_marked_by_account_id = $3
        WHERE id = $1`,
      [people[who].employeeId, reason, people.hc.accountId],
    );
  }

  async function unmark(who: Person) {
    await client.query(
      `UPDATE employees
          SET management_scope = 'MANAGED', management_scope_reason = NULL,
              management_scope_marked_at = NULL, management_scope_marked_by_account_id = NULL
        WHERE id = $1`,
      [people[who].employeeId],
    );
  }

  async function grant(who: Person, permissions: string[]) {
    const roleId = randomUUID();
    await client.query(
      "INSERT INTO roles(id, role_key, name, is_system) VALUES ($1, $2, 'Peran sintetis S2B-b', false)",
      [roleId, `s2b-b-${roleId}`],
    );
    for (const permission of permissions) {
      await client.query("INSERT INTO role_permissions(role_id, permission_key) VALUES ($1, $2)", [roleId, permission]);
    }
    await client.query(
      "INSERT INTO account_role_assignments(id, account_id, role_id, scope_type) VALUES ($1, $2, $3, 'organization')",
      [randomUUID(), people[who].accountId, roleId],
    );
  }

  function call(who: Person, method: "GET" | "POST", url: string, payload?: object) {
    return app.inject({ method, url, headers: { cookie: people[who].cookie }, ...(payload ? { payload } : {}) });
  }

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    vi.setSystemTime(NOW);
    client = await pool.connect();
    await client.query("BEGIN");
    transactionPool = savepointPool(client);
    unitId = randomUUID();
    await client.query(
      "INSERT INTO organizational_units(id, normalized_name, name) VALUES ($1, $2, 'Unit S2B-b Sintetis')",
      [unitId, `s2b-b-${unitId}`],
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
      AUTH_MODE: "local", AUTH_ENCRYPTION_KEY: "12".repeat(32), AUTH_SESSION_TTL_HOURS: 8,
    } as ApiConfig;
    const auth = new AuthService(transactionPool, config.AUTH_ENCRYPTION_KEY!, 8, false);
    for (const who of ["hc", "manager", "unitApprover", "requester"] as const) {
      const employeeId = randomUUID();
      await client.query(
        `INSERT INTO employees(id, employee_number, full_name, status, started_on, organizational_unit_id,
                               leave_entitlement_group)
         VALUES ($1, $2, $3, 'active', '2020-01-06', $4, 'non_education')`,
        [employeeId, `S2BB-${employeeId.slice(0, 8)}`, `Pegawai ${who}`, unitId],
      );
      const accountId = randomUUID();
      await client.query(
        "INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1, $2, $3, 'EMPLOYEE', 'active')",
        [accountId, employeeId, `s2b-b-${accountId}@example.invalid`],
      );
      const session = await auth.createSessionForAccountId(accountId, {
        ipAddress: "127.0.0.1", userAgent: "rollback-only-s2b-b-test",
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
    await grant("hc", [
      "employment.read", "leave.configuration.manage", "approvals.policy.manage",
      "attendance.overtime.manage", "attendance.records.manage",
    ]);

    app = Fastify({ logger: false });
    await registerEmployeeLeaveRoutes(app, transactionPool, config);
    await registerPlannedLeaveRoutes(app, transactionPool, config);
    await registerSpecialLeaveRoutes(app, transactionPool, config);
    await registerEmploymentAdminRoutes(app, transactionPool, config);
    await registerLeaveAdminRoutes(app, transactionPool, config);
    await registerLeavePostponementRoutes(app, transactionPool, config);
    await registerAttendanceWorkforceRoutes(app, transactionPool, config);
    unitIdRef = unitId;
  });

  afterEach(async () => {
    try { await app?.close(); } finally {
      if (client) { await client.query("ROLLBACK"); client.release(); }
      vi.useRealTimers();
    }
  });

  it("Board aggregates count only the population HCIS manages", async () => {
    const before = await loadBoardAggregates(client);
    const unitBefore = before.unitDistribution.find((row) => row.unitName === "Unit S2B-b Sintetis")?.employeeCount;
    expect(unitBefore).toBe(4);

    await mark("requester");
    const after = await loadBoardAggregates(client);
    expect(after.employees.active).toBe(before.employees.active - 1);
    expect(after.employees.total).toBe(before.employees.total - 1);
    expect(after.entitlementGroups.nonEducation).toBe(before.entitlementGroups.nonEducation - 1);
    expect(after.approvalReadiness.activeEmployees).toBe(before.approvalReadiness.activeEmployees - 1);
    // The requester was the one with a direct manager.
    expect(after.approvalReadiness.withDirectManager).toBe(before.approvalReadiness.withDirectManager - 1);
    expect(after.unitDistribution.find((row) => row.unitName === "Unit S2B-b Sintetis")?.employeeCount).toBe(3);
    const statusTotal = (aggregates: typeof before) =>
      aggregates.employmentStatus.reduce((sum, row) => sum + row.employeeCount, 0);
    expect(statusTotal(after)).toBe(statusTotal(before) - 1);
  });

  it("attendance does not expect a marked record to work, and leaves an unmarked one alone", async () => {
    const scope = { unitId, employeeId: null, from: "2026-01-05", to: "2026-01-06" };
    const pairsOf = async () => {
      const { covered, uncovered } = await calculationPairs(client, scope);
      return [...covered, ...uncovered].map((pair) => pair.employeeId);
    };
    expect(new Set(await pairsOf())).toEqual(new Set(Object.values(people).map((person) => person.employeeId)));
    const expected = async () =>
      (await activeEmployees(client as unknown as Pool, { unitId })).map((row) => row.employeeId);
    expect(await expected()).toHaveLength(4);

    await mark("requester");
    expect(await pairsOf()).not.toContain(people.requester.employeeId);
    expect(await pairsOf()).toContain(people.manager.employeeId);
    expect(await expected()).not.toContain(people.requester.employeeId);
    expect(await expected()).toHaveLength(3);
  });

  it("ORG-004 authority resolution treats a marked incumbent as not active", async () => {
    const repository = new PostgresOrganizationRepository(client);
    const context = { effectiveDate: "2099-01-05", workflowKey: "leave.annual" };
    expect(await repository.validate(people.manager.employeeId, context)).toEqual({ eligible: true, reason: null });

    await mark("manager", "PENGURUS_YAYASAN");
    expect(await repository.validate(people.manager.employeeId, context))
      .toEqual({ eligible: false, reason: "EMPLOYEE_NOT_ACTIVE" });
    expect(await repository.validate(people.unitApprover.employeeId, context)).toEqual({ eligible: true, reason: null });
  });

  it("overtime never resolves a marked supervisor", async () => {
    const resolved = await resolveOvertimeApprover(client, people.requester.employeeId, "2099-01-05");
    expect(resolved.supervisorEmployeeId).toBe(people.manager.employeeId);

    await mark("manager");
    await expect(resolveOvertimeApprover(client, people.requester.employeeId, "2099-01-05"))
      .rejects.toMatchObject({ code: "OVERTIME_APPROVER_UNRESOLVED" });
  });

  it("a marked employee files no new leave of any kind, and keeps reading the old ones", async () => {
    const submitted = await call("requester", "POST", "/leave/me/annual/submit", {
      ...LEAVE, reason: "Sebelum ditandai", idempotencyKey: randomUUID(),
    });
    expect(submitted.statusCode, submitted.body).toBe(201);

    await mark("requester");
    const annualPreview = await call("requester", "POST", "/leave/me/annual/preview", { ...LEAVE });
    expect(annualPreview.statusCode).toBe(409);
    expect(annualPreview.json().code).toBe(OUTSIDE);
    const annualSubmit = await call("requester", "POST", "/leave/me/annual/submit", {
      startOn: "2099-02-09", endOn: "2099-02-10", reason: null, idempotencyKey: randomUUID(),
    });
    expect(annualSubmit.statusCode).toBe(409);
    expect(annualSubmit.json().code).toBe(OUTSIDE);

    const planned = await call("requester", "POST", "/leave/planned/me/preview", {
      policyKey: "employee_marriage", startOn: "2099-02-09", endOn: "2099-02-10",
    });
    expect(planned.statusCode).toBe(409);
    expect(planned.json().code).toBe(OUTSIDE);
    const special = await call("requester", "POST", "/leave/special/me/preview", {
      policyKey: "maternity", startOn: "2099-02-09", endOn: "2099-02-10",
    });
    expect(special.statusCode).toBe(409);
    expect(special.json().code).toBe(OUTSIDE);

    // History stays readable, and nothing was written by the refused attempts.
    const history = await call("requester", "GET", "/leave/me/requests");
    expect(history.statusCode, history.body).toBe(200);
    expect(JSON.stringify(history.json())).toContain(submitted.json().id);
    const rows = await client.query("SELECT count(*)::int AS n FROM leave_requests WHERE employee_id = $1", [people.requester.employeeId]);
    expect(rows.rows[0]?.n).toBe(1);
  });

  it("an unmarked employee whose line manager is marked meets the inactive-approver refusal", async () => {
    await mark("manager");
    const preview = await call("requester", "POST", "/leave/me/annual/preview", { ...LEAVE });
    expect(preview.statusCode).toBe(409);
    expect(preview.json().code).toBe("APPROVER_NOT_ACTIVE");
  });

  it("an unmarked employee with unmarked approvers is unaffected", async () => {
    const preview = await call("requester", "POST", "/leave/me/annual/preview", { ...LEAVE });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().approvalChain.map((step: { employeeId: string }) => step.employeeId))
      .toEqual([people.manager.employeeId, people.unitApprover.employeeId]);
  });

  it("the consistency report lists a marked record whose EMPLOYEE account is still invited or active", async () => {
    await client.query(
      `INSERT INTO employment_rollout_settings(id, mode, reason) VALUES (1, 'SHADOW', 'Uji S2B-b sintetis')
       ON CONFLICT (id) DO UPDATE SET mode = 'SHADOW'`,
    );
    // A Pengurus Yayasan board account is never linked to an employee record.
    const boardAccountId = randomUUID();
    await client.query(
      "INSERT INTO accounts(id, email, principal_type, status) VALUES ($1, $2, 'FOUNDATION_BOARD', 'active')",
      [boardAccountId, `s2b-b-board-${boardAccountId}@example.invalid`],
    );
    const report = async () => {
      const response = await call("hc", "GET", "/admin/employment/consistency?code=ACCOUNT_LINKED_TO_OUTSIDE_HCIS_RECORD&pageSize=100");
      expect(response.statusCode, response.body).toBe(200);
      return response.json() as { rows: Array<{ employeeId: string; codes: string[] }> };
    };
    const ours = (rows: Array<{ employeeId: string }>) =>
      rows.map((row) => row.employeeId).filter((id) => Object.values(people).some((person) => person.employeeId === id));

    expect(ours((await report()).rows)).toEqual([]);

    await mark("requester", "PENGURUS_YAYASAN");
    await mark("manager");
    await client.query("UPDATE accounts SET status = 'invited' WHERE id = $1", [people.manager.accountId]);
    let rows = (await report()).rows;
    expect(new Set(ours(rows))).toEqual(new Set([people.requester.employeeId, people.manager.employeeId]));

    // A deactivated account is no longer a finding; nothing was changed by the report itself.
    await client.query("UPDATE accounts SET status = 'inactive' WHERE id = $1", [people.manager.accountId]);
    rows = (await report()).rows;
    expect(ours(rows)).toEqual([people.requester.employeeId]);
    const account = await client.query("SELECT status FROM accounts WHERE id = $1", [people.requester.accountId]);
    expect(account.rows[0]?.status).toBe("active");
    const board = await client.query("SELECT status, employee_id FROM accounts WHERE id = $1", [boardAccountId]);
    expect(board.rows[0]).toEqual({ status: "active", employee_id: null });
  });

  // --- Review follow-up (S2B-b) ---------------------------------------------------------------

  it("a replay of a submission made before the mark still returns the stored request", async () => {
    const idempotencyKey = randomUUID();
    const first = await call("requester", "POST", "/leave/me/annual/submit", { ...LEAVE, reason: null, idempotencyKey });
    expect(first.statusCode, first.body).toBe(201);
    await mark("requester");
    const replay = await call("requester", "POST", "/leave/me/annual/submit", { ...LEAVE, reason: null, idempotencyKey });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({ id: first.json().id, idempotentReplay: true });
    // A fresh key is new leave and is refused.
    const fresh = await call("requester", "POST", "/leave/me/annual/submit", { ...LATER, reason: null, idempotencyKey: randomUUID() });
    expect(fresh.json().code).toBe(OUTSIDE);
  });

  it("planned leave submit: allowed for a managed requester, refused once marked", async () => {
    const body = () => ({
      policyKey: "employee_marriage", ...LEAVE, hasEvidence: true, reason: null, idempotencyKey: randomUUID(),
      evidence: { fileName: "undangan.pdf", contentType: "application/pdf", contentBase64: PDF },
    });
    const allowed = await call("requester", "POST", "/leave/planned/me/submit", body());
    expect(allowed.statusCode, allowed.body).toBe(201);
    await client.query("UPDATE leave_requests SET status = 'cancelled' WHERE id = $1", [allowed.json().id]);
    await mark("requester");
    const refused = await call("requester", "POST", "/leave/planned/me/submit", body());
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe(OUTSIDE);
  });

  it("special leave submit: allowed for a managed requester, refused once marked", async () => {
    const body = () => ({ policyKey: "family_bereavement", startOn: "2099-01-05", endOn: "2099-01-06", hasEvidence: false, reason: null, idempotencyKey: randomUUID() });
    const allowed = await call("requester", "POST", "/leave/special/me/submit", body());
    expect(allowed.statusCode, allowed.body).toBe(201);
    await client.query("UPDATE leave_requests SET status = 'cancelled' WHERE id = $1", [allowed.json().id]);
    await mark("requester");
    const refused = await call("requester", "POST", "/leave/special/me/submit", body());
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe(OUTSIDE);
  });

  it("planned leave never routes to a marked approver, and routes normally to an unmarked one", async () => {
    const preview = () => call("requester", "POST", "/leave/planned/me/preview", { policyKey: "employee_marriage", ...LEAVE, hasEvidence: true });
    const allowed = await preview();
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(allowed.json().approvalChain.map((step: { employeeId: string }) => step.employeeId))
      .toEqual([people.manager.employeeId, people.unitApprover.employeeId]);
    await mark("unitApprover");
    const refused = await preview();
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("APPROVER_NOT_ACTIVE");
  });

  it("LEAVE-008: no other dates are proposed to, or accepted by, a marked requester", async () => {
    const submitted = await call("requester", "POST", "/leave/me/annual/submit", { ...LEAVE, reason: null, idempotencyKey: randomUUID() });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const stepId = submitted.json().approvalChain[0].id as string;
    const propose = () => call("manager", "POST", `/leave/approvals/${stepId}/postpone`, { ...LATER, note: "Ada ujian minggu itu" });

    // Positive: a managed requester receives the proposal and can accept it.
    const proposed = await propose();
    expect(proposed.statusCode, proposed.body).toBe(200);
    const proposalId = proposed.json().proposalId as string;

    // Marked after the proposal: accepting would file new leave, so it is refused.
    await mark("requester");
    const accept = await call("requester", "POST", `/leave/me/postponements/${proposalId}/accept`, { idempotencyKey: randomUUID() });
    expect(accept.statusCode).toBe(409);
    expect(accept.json().code).toBe(OUTSIDE);
    const replacements = await client.query("SELECT count(*)::int AS n FROM leave_requests WHERE employee_id = $1", [people.requester.employeeId]);
    expect(replacements.rows[0]?.n).toBe(1);

    // Unmarked, the same acceptance goes through.
    await unmark("requester");
    const accepted = await call("requester", "POST", `/leave/me/postponements/${proposalId}/accept`, { idempotencyKey: randomUUID() });
    expect(accepted.statusCode, accepted.body).toBe(201);
    expect(accepted.json()).toMatchObject({ status: "accepted", replacementStatus: "in_review" });
  });

  it("LEAVE-008: an approver cannot propose other dates to a marked requester", async () => {
    const submitted = await call("requester", "POST", "/leave/me/annual/submit", { ...LEAVE, reason: null, idempotencyKey: randomUUID() });
    const stepId = submitted.json().approvalChain[0].id as string;
    const preview = await call("manager", "POST", `/leave/approvals/${stepId}/postponement/preview`, LATER);
    expect(preview.statusCode, preview.body).toBe(200);
    await mark("requester");
    const refusedPreview = await call("manager", "POST", `/leave/approvals/${stepId}/postponement/preview`, LATER);
    expect(refusedPreview.json().code).toBe(OUTSIDE);
    const refused = await call("manager", "POST", `/leave/approvals/${stepId}/postpone`, { ...LATER, note: "Ada ujian minggu itu" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe(OUTSIDE);
    const status = await client.query("SELECT status FROM leave_requests WHERE id = $1", [submitted.json().id]);
    expect(status.rows[0]?.status).toBe("in_review");
  });

  it("a marked person's stored attendance result stays readable; no new pair is calculated for them", async () => {
    const workDate = "2026-01-05";
    // A result the engine stored before the mark. A manual event makes the pair "covered".
    await client.query(
      `INSERT INTO attendance_result_versions(id, employee_id, work_date, version, status, input_hash)
       VALUES ($1, $2, $3::date, 1, 'present', $4)`,
      [randomUUID(), people.requester.employeeId, workDate, "a".repeat(64)],
    );
    await mark("requester");
    const scope = { unitId: unitIdRef, employeeId: null, from: workDate, to: "2026-01-06" };
    // The run: nothing for the marked person.
    const run = await calculationPairs(client, scope);
    expect([...run.covered, ...run.uncovered].map((pair) => pair.employeeId)).not.toContain(people.requester.employeeId);
    // The read model: the day with a stored result is still there, the day without one is not.
    const read = await calculationPairs(client, scope, { includeOutsideHcisHistory: true });
    const ours = [...read.covered, ...read.uncovered].filter((pair) => pair.employeeId === people.requester.employeeId);
    expect(ours.map((pair) => pair.workDate)).toEqual([workDate]);
    const rows = await attendanceCalculationRows(client, scope, { page: 1, pageSize: 100 }, new Date("2026-01-07T12:00:00Z"));
    const items = (rows as unknown as { items: Array<{ employeeId: string; workDate: string }> }).items;
    expect(items.filter((item) => item.employeeId === people.requester.employeeId).map((item) => item.workDate)).toEqual([workDate]);
    // An unmarked colleague is read for both days, as before.
    expect(items.filter((item) => item.employeeId === people.manager.employeeId)).toHaveLength(2);
  });

  it("the consistency report flags an employee whose line manager or unit approver is marked", async () => {
    await client.query(
      `INSERT INTO employment_rollout_settings(id, mode, reason) VALUES (1, 'SHADOW', 'Uji S2B-b sintetis')
       ON CONFLICT (id) DO UPDATE SET mode = 'SHADOW'`,
    );
    const flagged = async () => {
      const response = await call("hc", "GET", "/admin/employment/consistency?code=APPROVER_OUTSIDE_HCIS&pageSize=100");
      expect(response.statusCode, response.body).toBe(200);
      const ids = Object.values(people).map((person) => person.employeeId);
      return (response.json() as { rows: Array<{ employeeId: string }> }).rows.map((row) => row.employeeId).filter((id) => ids.includes(id));
    };
    expect(await flagged()).toEqual([]);

    await mark("manager");
    // The requester reports to the manager; everyone in the unit keeps an unmarked unit approver.
    expect(await flagged()).toEqual([people.requester.employeeId]);

    await unmark("manager");
    await mark("unitApprover");
    // Every active managed employee of the unit now has a marked unit approver; the marked one itself is not listed.
    expect(new Set(await flagged())).toEqual(new Set([people.requester.employeeId, people.manager.employeeId, people.hc.employeeId]));
  });

  it("leave configuration and Board readiness count only approvers who can approve", async () => {
    const configuration = async () => {
      const response = await call("hc", "GET", "/admin/leave/configuration");
      expect(response.statusCode, response.body).toBe(200);
      return response.json() as {
        units: Array<{ id: string; approverEmployeeId: string | null; activeEmployeeCount: number }>;
        employees: Array<{ id: string; directManagerEmployeeId: string | null }>;
      };
    };
    const before = await configuration();
    expect(before.units.find((unit) => unit.id === unitIdRef)).toMatchObject({ approverEmployeeId: people.unitApprover.employeeId, activeEmployeeCount: 4 });
    expect(before.employees.find((row) => row.id === people.requester.employeeId)?.directManagerEmployeeId).toBe(people.manager.employeeId);
    const boardBefore = await loadBoardAggregates(client);

    await mark("unitApprover");
    await mark("manager");
    const after = await configuration();
    expect(after.units.find((unit) => unit.id === unitIdRef)).toMatchObject({ approverEmployeeId: null, activeEmployeeCount: 2 });
    expect(after.employees.find((row) => row.id === people.requester.employeeId)?.directManagerEmployeeId).toBeNull();
    expect(after.employees.map((row) => row.id)).not.toContain(people.manager.employeeId);

    const boardAfter = await loadBoardAggregates(client);
    expect(boardAfter.approvalReadiness.withDirectManager).toBe(boardBefore.approvalReadiness.withDirectManager - 1);
    expect(boardAfter.approvalReadiness.unitsWithApprover).toBe(boardBefore.approvalReadiness.unitsWithApprover - 1);
    expect(boardAfter.approvalReadiness.unitsWithoutApprover).toBe(boardBefore.approvalReadiness.unitsWithoutApprover + 1);
  });

  it("a marked employee cannot be set as unit leave approver; an unmarked one can", async () => {
    const set = (employeeId: string) =>
      app.inject({ method: "PATCH", url: `/admin/leave/units/${unitIdRef}/approver`, headers: { cookie: people.hc.cookie }, payload: { employeeId } });
    await mark("manager");
    const refused = await set(people.manager.employeeId);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("UNIT_APPROVER_NOT_ACTIVE");
    const allowed = await set(people.requester.employeeId);
    expect(allowed.statusCode, allowed.body).toBe(200);
  });

  it("HC records no overtime or manual correction for a marked person, and still does for a managed one", async () => {
    const overtime = (who: Person) => call("hc", "POST", "/admin/attendance/overtime", { employeeId: people[who].employeeId, workDate: "2099-01-02", requestedMinutes: 60 });
    const correction = (who: Person) => call("hc", "POST", "/admin/attendance/manual-corrections", {
      employeeId: people[who].employeeId, workDate: "2099-01-02",
      checkInAt: "2099-01-02T07:00:00+07:00", checkOutAt: null, reason: "Mesin mati sintetis",
    });
    const managedOvertime = await overtime("requester");
    expect(managedOvertime.statusCode, managedOvertime.body).toBe(201);
    const managedCorrection = await correction("requester");
    expect(managedCorrection.json().code, managedCorrection.body).not.toBe(OUTSIDE);
    expect(managedCorrection.statusCode).toBeLessThan(300);

    await mark("unitApprover");
    const refusedOvertime = await overtime("unitApprover");
    expect(refusedOvertime.statusCode).toBe(409);
    expect(refusedOvertime.json().code).toBe(OUTSIDE);
    const refusedCorrection = await correction("unitApprover");
    expect(refusedCorrection.statusCode).toBe(409);
    expect(refusedCorrection.json().code).toBe(OUTSIDE);
  });

  it("an overtime request is never reassigned to a marked approver", async () => {
    const submitted = await call("requester", "POST", "/attendance/overtime", { workDate: "2099-01-02", requestedMinutes: 30 });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const reassign = () => call("hc", "POST", `/admin/attendance/overtime/${submitted.json().id}/reassign`, {
      supervisorEmployeeId: people.unitApprover.employeeId, reason: "Atasan cuti panjang",
    });
    await mark("unitApprover");
    const refused = await reassign();
    expect(refused.statusCode).toBe(422);
    expect(refused.json().code).toBe("OVERTIME_APPROVER_INACTIVE");
    await unmark("unitApprover");
    const allowed = await reassign();
    expect(allowed.statusCode, allowed.body).toBe(200);
  });

  it("schedule changes skip a marked person unit-wide and set one aside when named", async () => {
    const now = new Date("2099-01-05T01:00:00Z");
    const pattern = { kind: "pattern" as const, scheduleTemplateId: null, from: "2099-01-12", to: "2099-01-18", weekdays: [1, 2, 3, 4, 5], untickedDays: "keep" as const };
    const unitWide = async () => (await planScheduleChange(client, { ...pattern, unitId: unitIdRef }, now)).employees.map((employee) => employee.id);
    expect(await unitWide()).toContain(people.requester.employeeId);
    await mark("requester");
    expect(await unitWide()).not.toContain(people.requester.employeeId);
    expect(await unitWide()).toContain(people.manager.employeeId);

    const named = await planScheduleChange(client, { ...pattern, employeeIds: [people.requester.employeeId, people.manager.employeeId] }, now);
    expect(named.employees.map((employee) => employee.id)).toEqual([people.manager.employeeId]);
    expect(named.issues).toContainEqual(expect.objectContaining({
      employeeId: people.requester.employeeId, code: "inactive", blocking: false,
      message: "Di luar pengelolaan HCIS; dikecualikan otomatis.",
    }));
  });

  it("STRUCTURE walk: a marked incumbent triggers the vacancy policy like an inactive one", async () => {
    const ids = { staff: people.requester.employeeId, head: people.manager.employeeId, director: people.unitApprover.employeeId };
    const walk = (policy: "CLIMB_TO_PARENT" | "BLOCK") => new OrganizationAuthorityResolver(
      { loadEffectiveSnapshot: async () => structure({ ...ids, headPolicy: policy }) },
      { eligibilityValidator: new PostgresOrganizationRepository(client) },
    ).resolveDirectManager({ requesterEmployeeId: ids.staff, effectiveDate: "2099-01-05" });

    await expect(walk("CLIMB_TO_PARENT")).resolves.toMatchObject({ employeeId: ids.head });
    await mark("manager");
    await expect(walk("CLIMB_TO_PARENT")).resolves.toMatchObject({ employeeId: ids.director });
    await expect(walk("BLOCK")).rejects.toMatchObject({ code: "AUTHORITY_INELIGIBLE" });
  });
});

// Trips, loans and work arrangements take an injected session, so they are exercised here with
// a fake one: the approver checks of APR-001 read a marked approver as not active.
describe.skipIf(!allowed)("EMP-005 S2B-b: APR-001 chains in trips, loans and work arrangements", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let principal: AuthPrincipal;
  const people = {} as Record<"requester" | "manager" | "unitApprover", { employeeId: string; accountId: string }>;

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("DELETE FROM organization_rollout_settings");
    const unitId = randomUUID();
    await client.query("INSERT INTO organizational_units(id, normalized_name, name) VALUES ($1, $2, 'Unit APR S2B-b')", [unitId, `s2b-b-apr-${unitId}`]);
    for (const who of ["manager", "unitApprover", "requester"] as const) {
      const employeeId = randomUUID();
      await client.query(
        `INSERT INTO employees(id, employee_number, full_name, status, started_on, organizational_unit_id)
         VALUES ($1, $2, $3, 'active', '2020-01-06', $4)`,
        [employeeId, `S2BA-${employeeId.slice(0, 8)}`, `Pegawai ${who}`, unitId],
      );
      const accountId = randomUUID();
      await client.query(
        "INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1, $2, $3, 'EMPLOYEE', 'active')",
        [accountId, employeeId, `s2b-b-apr-${accountId}@example.invalid`],
      );
      people[who] = { employeeId, accountId };
    }
    await client.query("UPDATE organizational_units SET leave_approver_employee_id = $2 WHERE id = $1", [unitId, people.unitApprover.employeeId]);
    await client.query("UPDATE employees SET direct_manager_employee_id = $2 WHERE id = $1", [people.requester.employeeId, people.manager.employeeId]);
    principal = { id: people.requester.accountId, email: "requester@example.invalid", principalType: "EMPLOYEE" };
    const config = { NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "13".repeat(32), AUTH_SESSION_TTL_HOURS: 8 } as ApiConfig;
    const auth = {
      getSession: async () => ({ principal, expiresAt: "2099-01-01T00:00:00Z" }),
      getAuthorizationContext: async () => ({ organizationPermissions: [] }),
    } as never;
    const transactionPool = savepointPool(client);
    app = Fastify({ logger: false });
    await registerTripRoutes(app, transactionPool, config, auth);
    await registerLoanRoutes(app, transactionPool, config, auth);
    await registerWorkArrangementRoutes(app, transactionPool, config, auth);
  });

  afterEach(async () => {
    try { await app?.close(); } finally {
      if (client) { await client.query("ROLLBACK"); client.release(); }
    }
  });

  async function markManager() {
    await client.query(
      `UPDATE employees
          SET management_scope = 'OUTSIDE_HCIS', management_scope_reason = 'BUMY',
              management_scope_note = 'Dikonfirmasi HC (sintetis)',
              management_scope_marked_at = now(), management_scope_marked_by_account_id = $2
        WHERE id = $1`,
      [people.manager.employeeId, people.unitApprover.accountId],
    );
  }

  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const inDays = (days: number) => {
    const base = new Date(`${today}T00:00:00Z`);
    base.setUTCDate(base.getUTCDate() + days);
    return base.toISOString().slice(0, 10);
  };
  const previews: Array<[string, () => { url: string; payload: object }]> = [
    ["trips", () => ({ url: "/trips/me/preview", payload: { startOn: inDays(7), endOn: inDays(8) } })],
    ["loans", () => ({ url: "/loans/me/preview", payload: { principal: 1_000_000, tenorMonths: 3 } })],
    ["work arrangements", () => ({ url: "/attendance/arrangements/me/preview", payload: { type: "REMOTE_WORK", startOn: inDays(3), endOn: inDays(3) } })],
  ];

  for (const [flow, request] of previews) {
    it(`${flow}: routes to an unmarked manager, refuses a marked one as not active`, async () => {
      const allowed = await app.inject({ method: "POST", ...request() });
      expect(allowed.statusCode, allowed.body).toBe(200);
      await markManager();
      const refused = await app.inject({ method: "POST", ...request() });
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().code).toBe("APPROVER_NOT_ACTIVE");
    });
  }
});
