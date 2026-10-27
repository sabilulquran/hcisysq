// EMP-005 S5A against real PostgreSQL: the SQL a fake pool cannot vouch for —
// migration 0101's constraints, who gets deactivated, and what an expiry does
// to someone who was rehired. Runs only on the loopback CI database; every
// write is rolled back.

import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  deactivateAccountsForEndedEmployment,
  expireTemporaryReactivations,
  isAllowedWhileReactivated,
  loadEmploymentAccessState,
} from "../src/modules/auth/employment-access.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

describe.skipIf(!allowed)("EMP-005 S5A account effects against PostgreSQL", () => {
  let pool: Pool;
  let client: PoolClient;
  let employeeId: string;
  let accountId: string;
  let savepoint = 0;

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    employeeId = randomUUID();
    accountId = randomUUID();
    await client.query(
      "INSERT INTO employees(id, employee_number, full_name, status) VALUES ($1, $2, 'Synthetic Reactivation Test', 'active')",
      [employeeId, `EMP-S5A-${employeeId}`],
    );
    await client.query(
      `INSERT INTO accounts(id, email, principal_type, status, employee_id)
       VALUES ($1, $2, 'EMPLOYEE', 'active', $3)`,
      [accountId, `s5a-${accountId}@example.invalid`, employeeId],
    );
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  async function expectSqlError(sql: string, values: unknown[], code: string) {
    const name = `s5a_test_${++savepoint}`;
    await client.query(`SAVEPOINT ${name}`);
    let caught: unknown;
    try {
      await client.query(sql, values);
    } catch (error) {
      caught = error;
    }
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    expect((caught as { code?: string } | undefined)?.code).toBe(code);
  }

  async function addEmployment(startedOn: string, endedOn: string | null) {
    const employmentId = randomUUID();
    const actionId = randomUUID();
    await client.query(
      `INSERT INTO employments(id, employee_id, staff_type, started_on, start_basis, service_start_on,
         ended_on, end_basis, end_precision, end_reason, source, opened_by_action_id)
       VALUES ($1, $2, 'PENDIDIK', $3, 'RECORDED', $3, $4, $5, $6, $7, 'BASELINE_FROM_MASTER', $8)`,
      [employmentId, employeeId, startedOn, endedOn, endedOn ? "RECORDED" : null, endedOn ? "DAY" : null,
        endedOn ? "KONTRAK_BERAKHIR" : null, actionId],
    );
    await client.query(
      `INSERT INTO employment_actions(id, employee_id, employment_id, action_type, recorded_at)
       VALUES ($1, $2, $3, 'BASELINE', now())`,
      [actionId, employeeId, employmentId],
    );
    return employmentId;
  }

  async function grant(expiresAt: string, reason = "Mengambil slip gaji terakhir") {
    const id = randomUUID();
    await client.query(
      `INSERT INTO account_temporary_reactivations(id, account_id, reason, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [id, accountId, reason, expiresAt],
    );
    return id;
  }

  async function accountStatus(): Promise<string> {
    const result = await client.query<{ status: string }>("SELECT status FROM accounts WHERE id = $1", [accountId]);
    return result.rows[0]!.status;
  }

  describe("migration 0101 constraints", () => {
    it("refuses a window longer than 30 days and one that ends before it starts", async () => {
      await expectSqlError(
        `INSERT INTO account_temporary_reactivations(id, account_id, reason, starts_at, expires_at)
         VALUES ($1, $2, 'Mengambil slip gaji terakhir', now(), now() + interval '31 days')`,
        [randomUUID(), accountId],
        "23514",
      );
      await expectSqlError(
        `INSERT INTO account_temporary_reactivations(id, account_id, reason, starts_at, expires_at)
         VALUES ($1, $2, 'Mengambil slip gaji terakhir', now(), now() - interval '1 day')`,
        [randomUUID(), accountId],
        "23514",
      );
    });

    it("refuses a reason that says nothing", async () => {
      await expectSqlError(
        `INSERT INTO account_temporary_reactivations(id, account_id, reason, expires_at)
         VALUES ($1, $2, 'lupa', now() + interval '7 days')`,
        [randomUUID(), accountId],
        "23514",
      );
    });

    it("allows only one live grant per account", async () => {
      await grant("now() + interval '7 days'".replace(/.*/, new Date(Date.now() + 7 * 86_400_000).toISOString()));
      await expectSqlError(
        `INSERT INTO account_temporary_reactivations(id, account_id, reason, expires_at)
         VALUES ($1, $2, 'Perpanjangan akses sementara', $3)`,
        [randomUUID(), accountId, new Date(Date.now() + 3 * 86_400_000).toISOString()],
        "23505",
      );
    });
  });

  describe("deactivation when an employment ends", () => {
    it("closes the account, its sessions and its activation tokens", async () => {
      await addEmployment("2026-07-01", "2027-09-30");
      const sessionId = randomUUID();
      await client.query(
        `INSERT INTO auth_sessions(id, account_id, token_hash, expires_at)
         VALUES ($1, $2, $3, now() + interval '8 hours')`,
        [sessionId, accountId, sessionId.replace(/-/g, "").padEnd(64, "0")],
      );
      const closed = await deactivateAccountsForEndedEmployment(client, employeeId);
      expect(closed).toEqual([accountId]);
      expect(await accountStatus()).toBe("inactive");
      const session = await client.query<{ revokedAt: Date | null }>(
        'SELECT revoked_at AS "revokedAt" FROM auth_sessions WHERE id = $1',
        [sessionId],
      );
      expect(session.rows[0]?.revokedAt).not.toBeNull();
    });

    it("leaves the account open while another employment still runs", async () => {
      await addEmployment("2026-07-01", "2027-09-30");
      await addEmployment("2027-10-01", null);
      expect(await deactivateAccountsForEndedEmployment(client, employeeId)).toEqual([]);
      expect(await accountStatus()).toBe("active");
    });

    it("leaves a suspended account suspended", async () => {
      await addEmployment("2026-07-01", "2027-09-30");
      await client.query("UPDATE accounts SET status = 'suspended' WHERE id = $1", [accountId]);
      expect(await deactivateAccountsForEndedEmployment(client, employeeId)).toEqual([]);
      expect(await accountStatus()).toBe("suspended");
    });
  });

  describe("expiry of a temporary reactivation", () => {
    it("closes the account once and marks the grant, so a later run does nothing", async () => {
      await addEmployment("2026-07-01", "2027-09-30");
      await client.query(
        `INSERT INTO account_temporary_reactivations(id, account_id, reason, starts_at, expires_at)
         VALUES ($1, $2, 'Mengambil slip gaji terakhir', now() - interval '8 days', now() - interval '1 day')`,
        [randomUUID(), accountId],
      );
      expect(await expireTemporaryReactivations(client)).toContain(accountId);
      expect(await accountStatus()).toBe("inactive");
      // Someone reactivates the account for another reason; the next sweep
      // must not undo that, because the grant is already closed.
      await client.query("UPDATE accounts SET status = 'active' WHERE id = $1", [accountId]);
      expect(await expireTemporaryReactivations(client)).not.toContain(accountId);
      expect(await accountStatus()).toBe("active");
    });

    it("leaves a rehired employee signed in", async () => {
      await addEmployment("2026-07-01", "2027-09-30");
      await addEmployment("2027-11-01", null);
      await client.query(
        `INSERT INTO account_temporary_reactivations(id, account_id, reason, starts_at, expires_at)
         VALUES ($1, $2, 'Mengambil slip gaji terakhir', now() - interval '8 days', now() - interval '1 day')`,
        [randomUUID(), accountId],
      );
      expect(await expireTemporaryReactivations(client)).not.toContain(accountId);
      expect(await accountStatus()).toBe("active");
    });
  });

  describe("the state the guard reads", () => {
    it("reports an ended employment, and an unexpired grant", async () => {
      await addEmployment("2026-07-01", "2027-09-30");
      const before = await loadEmploymentAccessState(client, accountId);
      expect(before.employmentEnded).toBe(true);
      expect(before.reactivationExpiresAt).toBeNull();
      await grant(new Date(Date.now() + 5 * 86_400_000).toISOString());
      const after = await loadEmploymentAccessState(client, accountId);
      expect(after.reactivationExpiresAt).not.toBeNull();
    });

    it("reports nothing to restrict while the employment runs", async () => {
      await addEmployment("2026-07-01", null);
      expect((await loadEmploymentAccessState(client, accountId)).employmentEnded).toBe(false);
    });

    it("ignores a voided employment", async () => {
      const employmentId = await addEmployment("2026-07-01", "2027-09-30");
      const actionId = randomUUID();
      await client.query(
        `INSERT INTO employment_actions(id, employee_id, employment_id, action_type, effective_on, reason_code, reverses_action_id, recorded_at)
         VALUES ($1, $2, $3, 'REVERSAL', '2027-09-30', 'KOREKSI',
                 (SELECT id FROM employment_actions WHERE employment_id = $3 LIMIT 1), now())`,
        [actionId, employeeId, employmentId],
      );
      await client.query("UPDATE employments SET voided_by_action_id = $2 WHERE id = $1", [employmentId, actionId]);
      expect((await loadEmploymentAccessState(client, accountId)).employmentEnded).toBe(false);
    });
  });

  it("opens exactly the three read-only pages the owner allowed", () => {
    expect(isAllowedWhileReactivated("GET", "/payslips")).toBe(true);
    expect(isAllowedWhileReactivated("GET", "/attendance/me")).toBe(true);
    expect(isAllowedWhileReactivated("GET", "/leave/me/requests")).toBe(true);
    expect(isAllowedWhileReactivated("GET", "/employees/me/employment")).toBe(false);
  });
});
