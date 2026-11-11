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
import { calculationPairs } from "../src/modules/attendance/calculation-runner.js";
import { resolveOvertimeApprover } from "../src/modules/attendance/overtime-approver.js";
import { activeEmployees } from "../src/modules/attendance/reporting.js";
import { AuthService } from "../src/modules/auth/service.js";
import { loadBoardAggregates } from "../src/modules/board/aggregates.js";
import { registerEmploymentAdminRoutes } from "../src/modules/employment/admin-routes.js";
import { encodeWorkingWeekdays } from "../src/modules/leave/domain/working-calendar.js";
import { registerEmployeeLeaveRoutes } from "../src/modules/leave/employee-routes.js";
import { registerPlannedLeaveRoutes } from "../src/modules/leave/planned-leave-routes.js";
import { registerSpecialLeaveRoutes } from "../src/modules/leave/special-leave-routes.js";
import { PostgresOrganizationRepository } from "../src/modules/organization/repository.js";

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

describe.skipIf(!allowed)("EMP-005 S2B-b: consumers leave a record outside HCIS management out", () => {
  let pool: Pool;
  let client: PoolClient;
  let transactionPool: Pool;
  let app: ReturnType<typeof Fastify>;
  let unitId: string;
  const people = {} as Record<Person, { employeeId: string; accountId: string; cookie: string }>;

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
    await grant("hc", ["employment.read"]);

    app = Fastify({ logger: false });
    await registerEmployeeLeaveRoutes(app, transactionPool, config);
    await registerPlannedLeaveRoutes(app, transactionPool, config);
    await registerSpecialLeaveRoutes(app, transactionPool, config);
    await registerEmploymentAdminRoutes(app, transactionPool, config);
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
});
