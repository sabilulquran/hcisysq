// PAY-003 calculation against real PostgreSQL: who is in the period, what gets
// stored, and whether a period that moved on can still be written to.
// Runs only against the loopback CI database; everything is created in a
// disposable schema and dropped afterwards.

import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { calculatePeriod } from "../src/modules/payroll/calculation.js";
import { getPeriod, hasCurrentCalculation } from "../src/modules/payroll/store.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

const PAY_DATE = "2026-09-25";

/** Synthetic policy values with the shape of the real ones. */
const POLICY_PAYLOADS: Record<string, unknown> = {
  SALARY_SCALE: { scale: { S1: Array.from({ length: 28 }, (_, mkg) => 2_000_000 + mkg * 100_000) } },
  BASIC_MULTIPLIER: { units: {}, knownUnitRefs: [], workPatterns: { FULL: 1 } },
  TEACHING_HOURS: { monthlyHourLimit: 96, overRatePerHour: 10_000, shortRatePerHour: 10_000, weeksPerMonth: 4 },
  PERFORMANCE: {
    defaultBase: 100_000,
    baseByPosition: {},
    annualShare: 0.6,
    monthlyShare: 0.4,
    unratedBelowOneYear: { annualRate: 0, monthlyRate: 1 },
  },
  FAMILY: { spouseRate: 0.05, childRate: 0.02 },
  FUNCTIONAL_ALLOWANCE: { byPosition: {}, concurrentStructuralFactor: 0.7, excludedUnits: [], positionsWithoutAllowance: [] },
  POSITIONAL_ALLOWANCE: { byPosition: {}, unitMultipliers: {}, positionsWithoutAllowance: [] },
  OVERTIME: { monthlyHourDivisor: 173 },
  BPJS_KESEHATAN: {
    contributionRate: 0.05,
    extraFamilyRate: 0.01,
    floor: 2_878_646,
    ceiling: 12_000_000,
    coveredChildren: 3,
    fixedAllowanceComponents: ["BASIC"],
  },
  CONTRACT_RATES: { transportPerAttendance: 15_000, teachingFeePerHour: 15_400 },
  EARLY_SERVICE: { months: 2, netRate: 0.8 },
};

describe.skipIf(!allowed)("PAY-003 calculation against PostgreSQL", () => {
  let pool: Pool;
  let periodId: string;
  let actorAccountId: string;
  // Other suites leave employments behind in the shared CI database, and a
  // payroll period pays everyone in its legal entity. Each test therefore gets
  // its own entity key, which is exactly the filter the production query uses.
  let legalEntityKey: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl!, max: 2 });
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function newEmployment(options: {
    category: string;
    startedOn?: string;
    endedOn?: string | null;
    endBasis?: "RECORDED" | "UNKNOWN" | null;
    withProfile?: boolean;
  }): Promise<{ employmentId: string; employeeId: string }> {
    const employeeId = randomUUID();
    const employmentId = randomUUID();
    const actionId = randomUUID();
    // employments and employment_actions reference each other, and migration 0056
    // defers both constraints, so the pair has to be written in one transaction.
    const client = await pool.connect();
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO employees(id, employee_number, full_name, status) VALUES ($1, $2, 'Synthetic Payroll', 'active')",
      [employeeId, `EMP-CALC-${employeeId}`],
    );
    const endedOn = options.endedOn ?? null;
    const endBasis = options.endBasis ?? null;
    await client.query(
      `INSERT INTO employments(
         id, employee_id, legal_entity_key, started_on, start_basis, ended_on, end_basis,
         end_precision, end_reason, source, opened_by_action_id)
       VALUES ($1, $2, $9, $3::date, 'RECORDED', $4::date, $5, $6, $7, 'ACTION', $8)`,
      [
        employmentId,
        employeeId,
        options.startedOn ?? "2016-07-01",
        endedOn,
        endBasis,
        endBasis === "RECORDED" ? "DAY" : null,
        endBasis === null ? null : "RESIGN",
        actionId,
        legalEntityKey,
      ],
    );
    await client.query(
      `INSERT INTO employment_actions(id, employee_id, employment_id, action_type, effective_on)
       VALUES ($1, $2, $3, 'BASELINE', $4::date)`,
      [actionId, employeeId, employmentId, options.startedOn ?? "2016-07-01"],
    );
    await client.query(
      `INSERT INTO employment_terms(id, employment_id, sequence, category, effective_from, opened_by_action_id)
       VALUES ($1, $2, 1, $3, $4::date, $5)`,
      [randomUUID(), employmentId, options.category, options.startedOn ?? "2016-07-01", actionId],
    );
    if (options.withProfile !== false) {
      await client.query(
        `INSERT INTO payroll_compensation_profiles(
           id, employment_id, effective_from, education, bank_account_number, bank_account_name)
         VALUES ($1, $2, DATE '2016-07-01', 'S1', '0000000001', 'Pegawai Uji')`,
        [randomUUID(), employmentId],
      );
    }
    await client.query("COMMIT");
    client.release();
    return { employmentId, employeeId };
  }

  beforeEach(async () => {
    // A clean slate: this suite owns the payroll tables in the CI database.
    await pool.query("DELETE FROM payroll_result_lines");
    await pool.query("DELETE FROM payroll_results");
    await pool.query("DELETE FROM payroll_loan_deductions");
    await pool.query("DELETE FROM payroll_loans");
    await pool.query("DELETE FROM payroll_period_inputs");
    await pool.query("DELETE FROM payroll_period_transitions");
    await pool.query("DELETE FROM payroll_audit_events");
    await pool.query("DELETE FROM payroll_periods");
    await pool.query("DELETE FROM payroll_policy_versions");
    await pool.query("DELETE FROM payroll_compensation_profiles");

    for (const [policyKey, payload] of Object.entries(POLICY_PAYLOADS)) {
      await pool.query(
        `INSERT INTO payroll_policy_versions(id, policy_key, effective_from, payload, source)
         VALUES ($1, $2, DATE '2020-01-01', $3::jsonb, 'uji sintetis')`,
        [randomUUID(), policyKey, JSON.stringify(payload)],
      );
    }

    periodId = randomUUID();
    legalEntityKey = randomUUID();
    await pool.query(
      `INSERT INTO payroll_periods(
         id, legal_entity_key, period_month, pay_date, period_start, period_end, cutoff_start, cutoff_end, state)
       VALUES ($1, $3, DATE '2026-09-01', $2::date, DATE '2026-09-01', DATE '2026-09-30',
               DATE '2026-08-23', DATE '2026-09-22', 'COLLECTING')`,
      [periodId, PAY_DATE, legalEntityKey],
    );

    const { rows } = await pool.query<{ id: string }>("SELECT id FROM accounts LIMIT 1");
    if (rows[0]) {
      actorAccountId = rows[0].id;
    } else {
      const employeeId = randomUUID();
      actorAccountId = randomUUID();
      await pool.query(
        "INSERT INTO employees(id, employee_number, full_name, status) VALUES ($1, $2, 'Synthetic Actor', 'active')",
        [employeeId, `EMP-ACTOR-${employeeId}`],
      );
      await pool.query(
        `INSERT INTO accounts(id, employee_id, email, principal_type, status)
         VALUES ($1, $2, $3, 'EMPLOYEE', 'active')`,
        [actorAccountId, employeeId, `calc-${actorAccountId}@example.invalid`],
      );
    }
  });

  const period = () => ({
    id: periodId,
    legalEntityKey,
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    payDate: PAY_DATE,
  });

  it("pays the permanent employee and stores the lines the engine produced", async () => {
    const { employmentId } = await newEmployment({ category: "TETAP" });
    const outcome = await calculatePeriod(pool, period(), actorAccountId, 0);
    expect(outcome.conflict).toBe(false);
    expect(outcome.employeeCount).toBe(1);

    const { rows } = await pool.query<{ employmentId: string; gross: string; payable: string; revision: number }>(
      `SELECT employment_id AS "employmentId", gross, payable, revision FROM payroll_results WHERE period_id = $1`,
      [periodId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.employmentId).toBe(employmentId);
    expect(rows[0]!.revision).toBe(1);
    // MKG 10 on the synthetic scale, no allowances configured.
    expect(rows[0]!.gross).toBe("3000000");
    expect(rows[0]!.payable).toBe("3000000");

    const lines = await pool.query<{ componentCode: string }>(
      `SELECT l.component_code AS "componentCode"
       FROM payroll_result_lines l JOIN payroll_results r ON r.id = l.result_id
       WHERE r.period_id = $1`,
      [periodId],
    );
    expect(lines.rows.map((row) => row.componentCode)).toEqual(["BASIC"]);
  });

  it("leaves interns and unclassified rows out of the population entirely", async () => {
    await newEmployment({ category: "MAGANG" });
    await newEmployment({ category: "BELUM_DIKLASIFIKASIKAN" });
    const outcome = await calculatePeriod(pool, period(), actorAccountId, 0);
    expect(outcome.employeeCount).toBe(0);
    expect(outcome.blockerCount).toBe(0);
  });

  it("blocks an employment that ended on a date nobody has resolved", async () => {
    await newEmployment({ category: "TETAP", endBasis: "UNKNOWN", endedOn: null });
    await calculatePeriod(pool, period(), actorAccountId, 0);
    const { rows } = await pool.query<{ blockers: Array<{ code: string }> }>("SELECT blockers FROM payroll_results WHERE period_id = $1", [periodId]);
    expect(rows[0]!.blockers.map((blocker) => blocker.code)).toContain("SERVICE_END_UNRESOLVED");
  });

  it("blocks someone with no compensation profile instead of leaving them out", async () => {
    await newEmployment({ category: "TETAP", withProfile: false });
    const outcome = await calculatePeriod(pool, period(), actorAccountId, 0);
    expect(outcome.employeeCount).toBe(1);
    const { rows } = await pool.query<{ blockers: Array<{ code: string }> }>("SELECT blockers FROM payroll_results WHERE period_id = $1", [periodId]);
    expect(rows[0]!.blockers.map((blocker) => blocker.code)).toContain("PROFILE_MISSING");
  });

  it("deducts the loan instalment and blocks one larger than the balance", async () => {
    const { employmentId, employeeId } = await newEmployment({ category: "TETAP" });
    const loanId = randomUUID();
    await pool.query(
      `INSERT INTO payroll_loans(id, employee_id, granted_on, principal) VALUES ($1, $2, DATE '2026-05-01', 1200000)`,
      [loanId, employeeId],
    );
    await pool.query(
      `INSERT INTO payroll_loan_deductions(id, loan_id, period_id, amount) VALUES ($1, $2, $3, 300000)`,
      [randomUUID(), loanId, periodId],
    );

    await calculatePeriod(pool, period(), actorAccountId, 0);
    const { rows } = await pool.query<{ amount: string }>(
      `SELECT l.amount FROM payroll_result_lines l
       JOIN payroll_results r ON r.id = l.result_id
       WHERE r.employment_id = $1 AND l.component_code = 'LOAN'`,
      [employmentId],
    );
    expect(rows[0]?.amount).toBe("300000");

    const net = await pool.query<{ net: string }>("SELECT net FROM payroll_results WHERE employment_id = $1", [
      employmentId,
    ]);
    expect(net.rows[0]!.net).toBe("2700000");
  });

  it("blocks a loan instalment larger than what is left to repay", async () => {
    const { employeeId } = await newEmployment({ category: "TETAP" });
    const loanId = randomUUID();
    await pool.query(
      `INSERT INTO payroll_loans(id, employee_id, granted_on, principal) VALUES ($1, $2, DATE '2026-05-01', 100000)`,
      [loanId, employeeId],
    );
    await pool.query(
      `INSERT INTO payroll_loan_deductions(id, loan_id, period_id, amount) VALUES ($1, $2, $3, 400000)`,
      [randomUUID(), loanId, periodId],
    );
    await calculatePeriod(pool, period(), actorAccountId, 0);
    const { rows } = await pool.query<{ blockers: Array<{ code: string }> }>("SELECT blockers FROM payroll_results WHERE period_id = $1", [periodId]);
    expect(rows[0]!.blockers.map((blocker) => blocker.code)).toContain("LOAN_EXCEEDS_BALANCE");
  });

  it("writes a new revision with lineage on a recalculation", async () => {
    await newEmployment({ category: "TETAP" });
    await calculatePeriod(pool, period(), actorAccountId, 0);
    await calculatePeriod(pool, period(), actorAccountId, 0);

    const { rows } = await pool.query<{ revision: number; previousResultId: string | null }>(
      `SELECT revision, previous_result_id AS "previousResultId"
       FROM payroll_results WHERE period_id = $1 ORDER BY revision`,
      [periodId],
    );
    expect(rows.map((row) => row.revision)).toEqual([1, 2]);
    expect(rows[0]!.previousResultId).toBeNull();
    expect(rows[1]!.previousResultId).not.toBeNull();
  });

  it("makes the period stale when an input changes, and current again once recalculated", async () => {
    const { employmentId } = await newEmployment({ category: "TETAP" });
    await calculatePeriod(pool, period(), actorAccountId, 0);
    expect(hasCurrentCalculation((await getPeriod(pool, periodId))!)).toBe(true);

    await pool.query(
      `INSERT INTO payroll_period_inputs(id, period_id, employment_id, input_key, value, origin)
       VALUES ($1, $2, $3, 'OVERTIME_HOURS', 5, 'MANUAL')`,
      [randomUUID(), periodId, employmentId],
    );
    expect(hasCurrentCalculation((await getPeriod(pool, periodId))!)).toBe(false);

    await calculatePeriod(pool, period(), actorAccountId, 0);
    expect(hasCurrentCalculation((await getPeriod(pool, periodId))!)).toBe(true);

    await pool.query("DELETE FROM payroll_period_inputs WHERE period_id = $1", [periodId]);
    expect(hasCurrentCalculation((await getPeriod(pool, periodId))!)).toBe(false);
  });

  it("refuses to write into a period that has left its working phase", async () => {
    await newEmployment({ category: "TETAP" });
    await pool.query("UPDATE payroll_periods SET state = 'APPROVED' WHERE id = $1", [periodId]);
    const outcome = await calculatePeriod(pool, period(), actorAccountId, 0);
    expect(outcome.conflict).toBe(true);
    const { rows } = await pool.query("SELECT 1 FROM payroll_results WHERE period_id = $1", [periodId]);
    expect(rows).toHaveLength(0);
  });

  it("refuses to write when the period moved on since the caller read it", async () => {
    await newEmployment({ category: "TETAP" });
    await pool.query("UPDATE payroll_periods SET version = version + 1 WHERE id = $1", [periodId]);
    const outcome = await calculatePeriod(pool, period(), actorAccountId, 0);
    expect(outcome.conflict).toBe(true);
  });

  it("writes nothing at all when a statutory policy is missing for the pay date", async () => {
    await newEmployment({ category: "TETAP" });
    await pool.query("DELETE FROM payroll_policy_versions WHERE policy_key = 'BPJS_KESEHATAN'");
    const outcome = await calculatePeriod(pool, period(), actorAccountId, 0);
    expect(outcome.policyProblems.map((problem) => problem.policyKey)).toEqual(["BPJS_KESEHATAN"]);
    const { rows } = await pool.query("SELECT 1 FROM payroll_results WHERE period_id = $1", [periodId]);
    expect(rows).toHaveLength(0);
  });

  it("keeps the period's figures out of the audit payload", async () => {
    await newEmployment({ category: "TETAP" });
    await calculatePeriod(pool, period(), actorAccountId, 0);
    const { rows } = await pool.query<{ action: string; payload: Record<string, unknown> }>(
      "SELECT action, payload FROM payroll_audit_events WHERE period_id = $1", [periodId],
    );
    expect(rows.map((row) => row.action)).toEqual(["payroll.period.calculated"]);
    for (const forbidden of ["amount", "gross", "net", "payable", "bank_account_number", "nik", "lines"]) {
      expect(Object.keys(rows[0]!.payload)).not.toContain(forbidden);
    }
    expect(rows[0]!.payload.employee_count).toBe(1);
    expect(rows[0]!.payload.gross_total).toBe(3_000_000);
  });

  it("calculates a contract worker from attendance and teaching hours", async () => {
    const { employmentId } = await newEmployment({ category: "KONTRAK_HONORER" });
    await pool.query(
      `INSERT INTO payroll_period_inputs(id, period_id, employment_id, input_key, value, origin)
       VALUES ($1, $2, $3, 'CONTRACT_ATTENDANCE_DAYS', 20, 'ATTENDANCE'),
              ($4, $2, $3, 'CONTRACT_TEACHING_HOURS', 30, 'MANUAL')`,
      [randomUUID(), periodId, employmentId, randomUUID()],
    );
    await calculatePeriod(pool, period(), actorAccountId, 0);
    const { rows } = await pool.query<{ gross: string }>("SELECT gross FROM payroll_results WHERE period_id = $1", [periodId]);
    expect(rows[0]!.gross).toBe(String(20 * 15_000 + 30 * 15_400));
  });
});
