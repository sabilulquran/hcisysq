// PAY-003 reference data against real PostgreSQL: effective dating really does
// close the row it supersedes, the exclusion constraints really do refuse an
// overlap, and a loan balance counts only what a settled period deducted.
// Runs only against the loopback CI database.

import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createLoan,
  listLoans,
  openCompensationProfile,
  openPolicyVersion,
  setLoanDeductions,
} from "../src/modules/payroll/admin-store.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

describe.skipIf(!allowed)("PAY-003 reference data against PostgreSQL", () => {
  let pool: Pool;
  let actorAccountId: string;
  let employeeId: string;
  let employmentId: string;
  let policyKey: string;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl!, max: 2 });
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    employeeId = randomUUID();
    employmentId = randomUUID();
    const actionId = randomUUID();
    // A key no other suite writes, so suites running side by side never collide
    // on the no-overlap constraint. The store does not care which key it is.
    policyKey = "PPH21_TER";

    const client = await pool.connect();
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO employees(id, employee_number, full_name, status) VALUES ($1, $2, 'Synthetic Admin', 'active')",
      [employeeId, `EMP-ADM-${employeeId}`],
    );
    await client.query(
      `INSERT INTO employments(id, employee_id, legal_entity_key, started_on, start_basis, source, opened_by_action_id)
       VALUES ($1, $2, $3, DATE '2016-07-01', 'RECORDED', 'ACTION', $4)`,
      [employmentId, employeeId, randomUUID(), actionId],
    );
    await client.query(
      `INSERT INTO employment_actions(id, employee_id, employment_id, action_type, effective_on)
       VALUES ($1, $2, $3, 'BASELINE', DATE '2016-07-01')`,
      [actionId, employeeId, employmentId],
    );
    await client.query("COMMIT");
    client.release();

    await pool.query("DELETE FROM payroll_policy_versions WHERE policy_key = $1", [policyKey]);

    const accounts = await pool.query<{ id: string }>("SELECT id FROM accounts LIMIT 1");
    if (accounts.rows[0]) {
      actorAccountId = accounts.rows[0].id;
    } else {
      const actorEmployeeId = randomUUID();
      actorAccountId = randomUUID();
      await pool.query(
        "INSERT INTO employees(id, employee_number, full_name, status) VALUES ($1, $2, 'Synthetic Actor', 'active')",
        [actorEmployeeId, `EMP-ADM-ACTOR-${actorEmployeeId}`],
      );
      await pool.query(
        `INSERT INTO accounts(id, employee_id, email, principal_type, status)
         VALUES ($1, $2, $3, 'EMPLOYEE', 'active')`,
        [actorAccountId, actorEmployeeId, `adm-${actorAccountId}@example.invalid`],
      );
    }
  });

  const policy = (effectiveFrom: string) => ({
    policyKey,
    effectiveFrom,
    payload: { monthlyHourDivisor: 173 },
    source: "uji sintetis",
  });

  describe("policy versions", () => {
    it("closes the open predecessor the day before the successor starts", async () => {
      await openPolicyVersion(pool, policy("2026-01-01"), actorAccountId);
      await openPolicyVersion(pool, policy("2026-07-01"), actorAccountId);

      const { rows } = await pool.query<{ effectiveFrom: string; effectiveTo: string | null }>(
        `SELECT to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom",
                to_char(effective_to, 'YYYY-MM-DD') AS "effectiveTo"
         FROM payroll_policy_versions WHERE policy_key = $1 ORDER BY effective_from`,
        [policyKey],
      );
      expect(rows).toEqual([
        { effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30" },
        { effectiveFrom: "2026-07-01", effectiveTo: null },
      ]);
    });

    it("leaves no gap between one version and the next", async () => {
      await openPolicyVersion(pool, policy("2026-01-01"), actorAccountId);
      await openPolicyVersion(pool, policy("2026-07-01"), actorAccountId);
      const { rows } = await pool.query<{ covered: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM payroll_policy_versions
           WHERE policy_key = $1 AND effective_from <= DATE '2026-06-30'
             AND (effective_to IS NULL OR effective_to >= DATE '2026-06-30')
         ) AS covered`,
        [policyKey],
      );
      expect(rows[0]!.covered).toBe(true);
    });

    it("refuses a version that starts on the same day as the open one", async () => {
      await openPolicyVersion(pool, policy("2026-01-01"), actorAccountId);
      await expect(openPolicyVersion(pool, policy("2026-01-01"), actorAccountId)).rejects.toMatchObject({
        code: "23P01",
      });
    });

    it("refuses a version slipped in before an existing one", async () => {
      await openPolicyVersion(pool, policy("2026-07-01"), actorAccountId);
      await expect(openPolicyVersion(pool, policy("2026-01-01"), actorAccountId)).rejects.toMatchObject({
        code: "23P01",
      });
    });

    it("keeps the earlier version readable, so a past period still resolves", async () => {
      await openPolicyVersion(pool, policy("2026-01-01"), actorAccountId);
      await openPolicyVersion(pool, policy("2026-07-01"), actorAccountId);
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM payroll_policy_versions
         WHERE policy_key = $1 AND effective_from <= DATE '2026-03-25'
           AND (effective_to IS NULL OR effective_to >= DATE '2026-03-25')`,
        [policyKey],
      );
      expect(rows).toHaveLength(1);
    });
  });

  describe("compensation profiles", () => {
    const profile = (effectiveFrom: string) => ({ employmentId, effectiveFrom, education: "S1" });

    it("closes the open predecessor the day before the successor starts", async () => {
      await openCompensationProfile(pool, profile("2026-01-01"), actorAccountId);
      await openCompensationProfile(pool, profile("2026-07-01"), actorAccountId);

      const { rows } = await pool.query<{ effectiveFrom: string; effectiveTo: string | null }>(
        `SELECT to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom",
                to_char(effective_to, 'YYYY-MM-DD') AS "effectiveTo"
         FROM payroll_compensation_profiles WHERE employment_id = $1 ORDER BY effective_from`,
        [employmentId],
      );
      expect(rows).toEqual([
        { effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30" },
        { effectiveFrom: "2026-07-01", effectiveTo: null },
      ]);
    });

    it("refuses a profile slipped in before an existing one", async () => {
      await openCompensationProfile(pool, profile("2026-07-01"), actorAccountId);
      await expect(openCompensationProfile(pool, profile("2026-01-01"), actorAccountId)).rejects.toMatchObject({
        code: "23P01",
      });
    });

    it("refuses an extra-family override with no reason", async () => {
      await expect(
        openCompensationProfile(
          pool,
          { employmentId, effectiveFrom: "2026-01-01", bpjsExtraFamilyOverride: 2 },
          actorAccountId,
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  describe("loan balances", () => {
    async function period(state: string): Promise<string> {
      const periodId = randomUUID();
      const month = `2026-${String(1 + Math.floor(Math.random() * 9)).padStart(2, "0")}-01`;
      await pool.query(
        `INSERT INTO payroll_periods(
           id, legal_entity_key, period_month, pay_date, period_start, period_end, cutoff_start, cutoff_end, state)
         VALUES ($1, $2, $3::date, ($3::date + 24), $3::date, ($3::date + 27), ($3::date - 9), ($3::date + 21), $4)`,
        [periodId, randomUUID(), month, state],
      );
      return periodId;
    }

    it("counts only an instalment from a period that reached approval", async () => {
      const loan = await createLoan(
        pool,
        { employeeId, grantedOn: "2026-05-01", principal: 1_200_000 },
        actorAccountId,
      );
      const collecting = await period("COLLECTING");
      const approved = await period("APPROVED");

      await setLoanDeductions(pool, collecting, [{ loanId: loan.id, amount: 300_000 }], actorAccountId);
      await pool.query(
        `INSERT INTO payroll_loan_deductions(id, loan_id, period_id, amount) VALUES ($1, $2, $3, 200000)`,
        [randomUUID(), loan.id, approved],
      );

      const loans = await listLoans(pool, employeeId);
      expect(loans[0]!.outstanding).toBe("1000000");
    });

    it("refuses an instalment larger than what is left to repay", async () => {
      const loan = await createLoan(
        pool,
        { employeeId, grantedOn: "2026-05-01", principal: 500_000 },
        actorAccountId,
      );
      const approved = await period("APPROVED");
      await pool.query(
        `INSERT INTO payroll_loan_deductions(id, loan_id, period_id, amount) VALUES ($1, $2, $3, 400000)`,
        [randomUUID(), loan.id, approved],
      );
      const collecting = await period("COLLECTING");
      const outcome = await setLoanDeductions(pool, collecting, [{ loanId: loan.id, amount: 200_000 }], actorAccountId);
      expect(outcome).toEqual({ ok: false, code: "PAYROLL_LOAN_EXCEEDS_BALANCE" });
    });

    it("locks the instalments once the period has been calculated", async () => {
      const loan = await createLoan(
        pool,
        { employeeId, grantedOn: "2026-05-01", principal: 500_000 },
        actorAccountId,
      );
      const calculated = await period("CALCULATED");
      const outcome = await setLoanDeductions(pool, calculated, [{ loanId: loan.id, amount: 100_000 }], actorAccountId);
      expect(outcome).toEqual({ ok: false, code: "PAYROLL_LOAN_LOCKED" });
    });

    it("lets finance take an instalment back while the period is still collecting", async () => {
      const loan = await createLoan(
        pool,
        { employeeId, grantedOn: "2026-05-01", principal: 500_000 },
        actorAccountId,
      );
      const collecting = await period("COLLECTING");
      await setLoanDeductions(pool, collecting, [{ loanId: loan.id, amount: 100_000 }], actorAccountId);
      const outcome = await setLoanDeductions(pool, collecting, [{ loanId: loan.id, amount: 0 }], actorAccountId);
      expect(outcome).toEqual({ ok: true, written: 0, removed: 1 });

      const { rows } = await pool.query("SELECT 1 FROM payroll_loan_deductions WHERE loan_id = $1", [loan.id]);
      expect(rows).toHaveLength(0);
    });

    it("refuses an instalment against a closed loan", async () => {
      const loan = await createLoan(
        pool,
        { employeeId, grantedOn: "2026-05-01", principal: 500_000 },
        actorAccountId,
      );
      await pool.query("UPDATE payroll_loans SET closed_at = now() WHERE id = $1", [loan.id]);
      const collecting = await period("COLLECTING");
      const outcome = await setLoanDeductions(pool, collecting, [{ loanId: loan.id, amount: 100_000 }], actorAccountId);
      expect(outcome).toEqual({ ok: false, code: "PAYROLL_LOAN_CLOSED" });
    });
  });
});
