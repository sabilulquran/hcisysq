// 0068 PAY-003 payroll schema, role and permission guards against real PostgreSQL.
// Runs only against the loopback CI database; every write is rolled back.

import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

describe.skipIf(!allowed)("0068 payroll foundation migration", () => {
  let pool: Pool;
  let client: PoolClient;
  let employeeId: string;
  let employmentId: string;
  let savepoint = 0;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl!, max: 1 });
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    employeeId = randomUUID();
    employmentId = randomUUID();
    await client.query(
      "INSERT INTO employees(id, employee_number, full_name, status) VALUES ($1, $2, 'Synthetic Payroll Test', 'active')",
      [employeeId, `EMP-PAY-${employeeId}`],
    );
    await client.query(
      `INSERT INTO employments(id, employee_id, started_on, start_basis, source, opened_by_action_id)
       VALUES ($1, $2, DATE '2016-07-01', 'RECORDED', 'ACTION', $3)`,
      [employmentId, employeeId, randomUUID()],
    );
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  async function expectSqlError(sql: string, values: unknown[], code: string) {
    const name = `payroll_test_${++savepoint}`;
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

  async function insertProfile(effectiveFrom: string, effectiveTo: string | null) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO payroll_compensation_profiles(id, employment_id, effective_from, effective_to, education)
       VALUES ($1, $2, $3::date, $4::date, 'S1')`,
      [id, employmentId, effectiveFrom, effectiveTo],
    );
    return id;
  }

  async function insertPeriod(periodMonth: string, state = "DRAFT") {
    const id = randomUUID();
    await client.query(
      `INSERT INTO payroll_periods(id, period_month, pay_date, period_start, period_end, cutoff_start, cutoff_end, state)
       VALUES ($1, $2::date, ($2::date + 24), $2::date, (($2::date + interval '1 month')::date - 1),
               ($2::date - 9), ($2::date + 21), $3)`,
      [id, periodMonth, state],
    );
    return id;
  }

  describe("component catalog", () => {
    it("carries every v1 component with a stable code", async () => {
      const { rows } = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM payroll_components",
      );
      expect(Number(rows[0]!.count)).toBe(23);
    });

    it("marks only the fixed allowances that feed the BPJS base", async () => {
      const { rows } = await client.query<{ code: string }>(
        "SELECT code FROM payroll_components WHERE is_fixed_allowance ORDER BY code",
      );
      expect(rows.map((row) => row.code)).toEqual([
        "BASIC",
        "CHILD",
        "FUNC",
        "PERF",
        "POS",
        "SPECIAL_QUAL",
        "SPOUSE",
      ]);
    });

    it("keeps the BPJS allowance out of the PPh21 base, since it nets to zero", async () => {
      const { rows } = await client.query<{ in_pph21_base: boolean }>(
        "SELECT in_pph21_base FROM payroll_components WHERE code = 'BPJS_KES_ALLOW'",
      );
      expect(rows[0]!.in_pph21_base).toBe(false);
    });

    it("refuses a fixed allowance that is not an earning", async () => {
      await expectSqlError(
        `INSERT INTO payroll_components(code, display_name, category, is_fixed_allowance, display_order)
         VALUES ('TEST_BAD', 'Uji', 'DEDUCTION', true, 999)`,
        [],
        "23514",
      );
    });
  });

  describe("versioned policy", () => {
    it("refuses two versions of one policy that cover the same day", async () => {
      await client.query(
        `INSERT INTO payroll_policy_versions(id, policy_key, effective_from, effective_to, payload, source)
         VALUES ($1, 'BPJS_KESEHATAN', DATE '2026-01-01', DATE '2026-12-31', '{}'::jsonb, 'Perpres uji')`,
        [randomUUID()],
      );
      await expectSqlError(
        `INSERT INTO payroll_policy_versions(id, policy_key, effective_from, payload, source)
         VALUES ($1, 'BPJS_KESEHATAN', DATE '2026-06-01', '{}'::jsonb, 'Perpres uji')`,
        [randomUUID()],
        "23P01",
      );
    });

    it("accepts a successor version that starts the day the previous one ends", async () => {
      await client.query(
        `INSERT INTO payroll_policy_versions(id, policy_key, effective_from, effective_to, payload, source)
         VALUES ($1, 'BPJS_KESEHATAN', DATE '2026-01-01', DATE '2026-12-31', '{}'::jsonb, 'uji')`,
        [randomUUID()],
      );
      await client.query(
        `INSERT INTO payroll_policy_versions(id, policy_key, effective_from, payload, source)
         VALUES ($1, 'BPJS_KESEHATAN', DATE '2027-01-01', '{}'::jsonb, 'uji')`,
        [randomUUID()],
      );
    });

    it("requires a source for every policy version", async () => {
      await expectSqlError(
        `INSERT INTO payroll_policy_versions(id, policy_key, effective_from, payload, source)
         VALUES ($1, 'OVERTIME', DATE '2026-01-01', '{}'::jsonb, '  ')`,
        [randomUUID()],
        "23514",
      );
    });
  });

  describe("compensation profile", () => {
    it("refuses two profiles of one employment that cover the same day", async () => {
      await insertProfile("2026-01-01", "2026-12-31");
      await expectSqlError(
        `INSERT INTO payroll_compensation_profiles(id, employment_id, effective_from)
         VALUES ($1, $2, DATE '2026-06-01')`,
        [randomUUID(), employmentId],
        "23P01",
      );
    });

    it("keeps history: a closed row and its successor live side by side", async () => {
      await insertProfile("2025-01-01", "2025-12-31");
      await insertProfile("2026-01-01", null);
      const { rows } = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM payroll_compensation_profiles WHERE employment_id = $1",
        [employmentId],
      );
      expect(Number(rows[0]!.count)).toBe(2);
    });

    it("refuses an extra-family override without a reason", async () => {
      await expectSqlError(
        `INSERT INTO payroll_compensation_profiles(id, employment_id, effective_from, bpjs_extra_family_override)
         VALUES ($1, $2, DATE '2026-01-01', 2)`,
        [randomUUID(), employmentId],
        "23514",
      );
    });

    it("refuses an active BPJS date on an unregistered segment", async () => {
      await expectSqlError(
        `INSERT INTO payroll_compensation_profiles(id, employment_id, effective_from, bpjs_active_from)
         VALUES ($1, $2, DATE '2026-01-01', DATE '2026-01-01')`,
        [randomUUID(), employmentId],
        "23514",
      );
    });
  });

  describe("period", () => {
    it("refuses a second period for the same month", async () => {
      await insertPeriod("2026-09-01");
      await expectSqlError(
        `INSERT INTO payroll_periods(id, period_month, pay_date, period_start, period_end, cutoff_start, cutoff_end)
         VALUES ($1, DATE '2026-09-01', DATE '2026-09-25', DATE '2026-09-01', DATE '2026-09-30', DATE '2026-08-23', DATE '2026-09-22')`,
        [randomUUID()],
        "23P01",
      );
    });

    it("accepts the next month", async () => {
      await insertPeriod("2026-09-01");
      await insertPeriod("2026-10-01");
    });

    it("refuses a period month that is not the first of a month", async () => {
      await expectSqlError(
        `INSERT INTO payroll_periods(id, period_month, pay_date, period_start, period_end, cutoff_start, cutoff_end)
         VALUES ($1, DATE '2026-09-15', DATE '2026-09-25', DATE '2026-09-01', DATE '2026-09-30', DATE '2026-08-23', DATE '2026-09-22')`,
        [randomUUID()],
        "23514",
      );
    });

    it("refuses the same account as submitter and approver", async () => {
      const periodId = await insertPeriod("2026-09-01");
      const { rows } = await client.query<{ id: string }>("SELECT id FROM accounts LIMIT 1");
      const accountId = rows[0]?.id;
      if (!accountId) return;
      await expectSqlError(
        `UPDATE payroll_periods SET submitted_by_account_id = $2, approved_by_account_id = $2 WHERE id = $1`,
        [periodId, accountId],
        "23514",
      );
    });

    it("refuses an unknown state", async () => {
      await expectSqlError(
        `INSERT INTO payroll_periods(id, period_month, pay_date, period_start, period_end, cutoff_start, cutoff_end, state)
         VALUES ($1, DATE '2026-11-01', DATE '2026-11-25', DATE '2026-11-01', DATE '2026-11-30', DATE '2026-10-23', DATE '2026-11-22', 'REOPENED')`,
        [randomUUID()],
        "23514",
      );
    });
  });

  describe("period inputs", () => {
    it("holds one row per employment and input key", async () => {
      const periodId = await insertPeriod("2026-09-01");
      await client.query(
        `INSERT INTO payroll_period_inputs(id, period_id, employment_id, input_key, value, origin)
         VALUES ($1, $2, $3, 'OVERTIME_HOURS', 5, 'ATTENDANCE')`,
        [randomUUID(), periodId, employmentId],
      );
      await expectSqlError(
        `INSERT INTO payroll_period_inputs(id, period_id, employment_id, input_key, value, origin)
         VALUES ($1, $2, $3, 'OVERTIME_HOURS', 7, 'MANUAL')`,
        [randomUUID(), periodId, employmentId],
        "23505",
      );
    });

    it("requires a reason for an adjustment", async () => {
      const periodId = await insertPeriod("2026-09-01");
      await expectSqlError(
        `INSERT INTO payroll_period_inputs(id, period_id, employment_id, input_key, value, origin)
         VALUES ($1, $2, $3, 'ADJUSTMENT', -500000, 'MANUAL')`,
        [randomUUID(), periodId, employmentId],
        "23514",
      );
    });

    it("refuses a proration factor outside the allowed range", async () => {
      const periodId = await insertPeriod("2026-09-01");
      for (const value of [0, 1.5]) {
        await expectSqlError(
          `INSERT INTO payroll_period_inputs(id, period_id, employment_id, input_key, value, origin, reason)
           VALUES ($1, $2, $3, 'PRORATION_FACTOR', $4, 'MANUAL', 'masuk pertengahan bulan')`,
          [randomUUID(), periodId, employmentId, value],
          "23514",
        );
      }
    });
  });

  describe("loans", () => {
    it("deducts a loan at most once per period", async () => {
      const periodId = await insertPeriod("2026-09-01");
      const loanId = randomUUID();
      await client.query(
        `INSERT INTO payroll_loans(id, employee_id, granted_on, principal)
         VALUES ($1, $2, DATE '2026-05-01', 1200000)`,
        [loanId, employeeId],
      );
      await client.query(
        `INSERT INTO payroll_loan_deductions(id, loan_id, period_id, amount) VALUES ($1, $2, $3, 300000)`,
        [randomUUID(), loanId, periodId],
      );
      await expectSqlError(
        `INSERT INTO payroll_loan_deductions(id, loan_id, period_id, amount) VALUES ($1, $2, $3, 300000)`,
        [randomUUID(), loanId, periodId],
        "23505",
      );
    });
  });

  describe("results", () => {
    it("stores one revision per employment and keeps lineage to the previous one", async () => {
      const periodId = await insertPeriod("2026-09-01");
      const first = randomUUID();
      await client.query(
        `INSERT INTO payroll_results(id, period_id, employment_id, revision, gross, deductions, net, payable)
         VALUES ($1, $2, $3, 1, 5000000, 900000, 4100000, 4100000)`,
        [first, periodId, employmentId],
      );
      await expectSqlError(
        `INSERT INTO payroll_results(id, period_id, employment_id, revision, gross, deductions, net, payable)
         VALUES ($1, $2, $3, 1, 1, 0, 1, 1)`,
        [randomUUID(), periodId, employmentId],
        "23505",
      );
      await client.query(
        `INSERT INTO payroll_results(id, period_id, employment_id, revision, previous_result_id, gross, deductions, net, payable)
         VALUES ($1, $2, $3, 2, $4, 5000000, 900000, 4100000, 4100000)`,
        [randomUUID(), periodId, employmentId, first],
      );
    });

    it("refuses a result line for a component the catalog does not know", async () => {
      const periodId = await insertPeriod("2026-09-01");
      const resultId = randomUUID();
      await client.query(
        `INSERT INTO payroll_results(id, period_id, employment_id, gross, deductions, net, payable)
         VALUES ($1, $2, $3, 0, 0, 0, 0)`,
        [resultId, periodId, employmentId],
      );
      await expectSqlError(
        `INSERT INTO payroll_result_lines(id, result_id, component_code, category, amount, display_order)
         VALUES ($1, $2, 'NOT_A_COMPONENT', 'EARNING', 1, 1)`,
        [randomUUID(), resultId],
        "23503",
      );
    });

    it("holds one line per component", async () => {
      const periodId = await insertPeriod("2026-09-01");
      const resultId = randomUUID();
      await client.query(
        `INSERT INTO payroll_results(id, period_id, employment_id, gross, deductions, net, payable)
         VALUES ($1, $2, $3, 0, 0, 0, 0)`,
        [resultId, periodId, employmentId],
      );
      await client.query(
        `INSERT INTO payroll_result_lines(id, result_id, component_code, category, amount, display_order)
         VALUES ($1, $2, 'BASIC', 'EARNING', 3000000, 10)`,
        [randomUUID(), resultId],
      );
      await expectSqlError(
        `INSERT INTO payroll_result_lines(id, result_id, component_code, category, amount, display_order)
         VALUES ($1, $2, 'BASIC', 'EARNING', 1, 10)`,
        [randomUUID(), resultId],
        "23505",
      );
    });
  });

  describe("roles and permissions", () => {
    it("registers every v1 payroll permission", async () => {
      const { rows } = await client.query<{ permission_key: string }>(
        "SELECT permission_key FROM permissions WHERE permission_key LIKE 'payroll.%' ORDER BY permission_key",
      );
      expect(rows.map((row) => row.permission_key)).toEqual([
        "payroll.approve",
        "payroll.calculate",
        "payroll.inputs.manage",
        "payroll.loans.manage",
        "payroll.payments.confirm",
        "payroll.periods.manage",
        "payroll.policies.manage",
        "payroll.profiles.manage",
        "payroll.reopen.approve",
        "payroll.reports.read.organization",
        "payroll.submit",
        "payroll.transfers.read.organization",
      ]);
    });

    it("lets Kepala Human Capital submit but never approve", async () => {
      const { rows } = await client.query<{ permission_key: string }>(
        `SELECT rp.permission_key FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
         WHERE r.role_key = 'human_capital_lead' AND rp.permission_key LIKE 'payroll.%'`,
      );
      const keys = rows.map((row) => row.permission_key);
      expect(keys).toContain("payroll.submit");
      expect(keys).not.toContain("payroll.approve");
      expect(keys).not.toContain("payroll.payments.confirm");
    });

    it("lets Direktur approve but never change a value", async () => {
      const { rows } = await client.query<{ permission_key: string }>(
        `SELECT rp.permission_key FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
         WHERE r.role_key = 'director' AND rp.permission_key LIKE 'payroll.%'`,
      );
      const keys = rows.map((row) => row.permission_key);
      expect(keys).toContain("payroll.approve");
      expect(keys).toContain("payroll.reopen.approve");
      expect(keys).not.toContain("payroll.inputs.manage");
      expect(keys).not.toContain("payroll.profiles.manage");
      expect(keys).not.toContain("payroll.calculate");
    });

    it("separates managing loans from confirming the payment they reduce", async () => {
      const { rows } = await client.query<{ role_key: string; permission_key: string }>(
        `SELECT r.role_key, rp.permission_key FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
         WHERE rp.permission_key IN ('payroll.loans.manage', 'payroll.payments.confirm')`,
      );
      const byRole = new Map<string, string[]>();
      for (const row of rows) {
        byRole.set(row.role_key, [...(byRole.get(row.role_key) ?? []), row.permission_key]);
      }
      for (const [, keys] of byRole) {
        expect(keys).not.toEqual(expect.arrayContaining(["payroll.loans.manage", "payroll.payments.confirm"]));
      }
    });

    it("gives the Foundation Board no payroll permission at all", async () => {
      const { rows } = await client.query<{ permission_key: string }>(
        `SELECT rp.permission_key FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
         WHERE r.role_key = 'foundation_board_viewer' AND rp.permission_key LIKE 'payroll.%'`,
      );
      expect(rows).toEqual([]);
    });

    it("gives only finance the transfer list with bank accounts", async () => {
      const { rows } = await client.query<{ role_key: string }>(
        `SELECT r.role_key FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
         WHERE rp.permission_key = 'payroll.transfers.read.organization'
         ORDER BY r.role_key`,
      );
      expect(rows.map((row) => row.role_key)).toEqual(["finance_lead"]);
    });
  });
});
