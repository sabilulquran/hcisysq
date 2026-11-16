// PAY-003 calculation against real PostgreSQL: who is in the period, what gets
// stored, and whether a period that moved on can still be written to.
// Runs only against the loopback CI database; everything is created in a
// disposable schema and dropped afterwards.

import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { clearOwnPeriods } from "./support/payroll-cleanup.js";

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
  let ownedPeriodIds: string[] = [];
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
    // Only this suite's own rows: test files run in parallel against one
    // database, and clearing the payroll tables wholesale pulls the ground out
    // from under whatever another suite is doing.
    await clearOwnPeriods(pool, ownedPeriodIds);
    ownedPeriodIds = [];
    // Only the keys this suite is about to write: another suite owns a key of
    // its own, and clearing the table would take that with it.
    await pool.query("DELETE FROM payroll_policy_versions WHERE policy_key = ANY($1::text[])", [
      Object.keys(POLICY_PAYLOADS),
    ]);

    for (const [policyKey, payload] of Object.entries(POLICY_PAYLOADS)) {
      await pool.query(
        `INSERT INTO payroll_policy_versions(id, policy_key, effective_from, payload, source)
         VALUES ($1, $2, DATE '2020-01-01', $3::jsonb, 'uji sintetis')`,
        [randomUUID(), policyKey, JSON.stringify(payload)],
      );
    }

    periodId = randomUUID();
    ownedPeriodIds.push(periodId);
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

  it("pays a salaried contract like permanent staff, ignoring any transport days", async () => {
    // Owner decision 2026-11-04: KONTRAK is the full-salary contract; only
    // KONTRAK_HONORER is paid per attendance and per teaching hour.
    const { employmentId } = await newEmployment({ category: "KONTRAK" });
    await pool.query(
      `INSERT INTO payroll_period_inputs(id, period_id, employment_id, input_key, value, origin)
       VALUES ($1, $2, $3, 'CONTRACT_ATTENDANCE_DAYS', 20, 'MANUAL')`,
      [randomUUID(), periodId, employmentId],
    );
    await calculatePeriod(pool, period(), actorAccountId, 0);
    const { rows } = await pool.query<{ gross: string }>("SELECT gross FROM payroll_results WHERE period_id = $1", [periodId]);
    expect(rows[0]!.gross).toBe("3000000");
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

  // PERF-001 -> PAY-003 (performance-review.md section 11, specification
  // section 5.5). Cycles are global rows, so these tests use months far from
  // any other suite: payroll March 2031 reads the MONTHLY cycle of February
  // 2031 and the ANNUAL cycle of school year 2030/2031.
  describe("performance link", () => {
    const LINK_PAY_DATE = "2031-03-25";
    const MONTHLY_START = "2031-02-01";
    const ANNUAL_START = "2030-07-01";
    const RUBRIC = {
      indicators: [{ code: "HASIL", label: "Hasil kerja", weight: 100 }],
      predicates: [
        { code: "A", label: "Sangat baik", minScore: 3.5 },
        { code: "B", label: "Baik", minScore: 2.5 },
        { code: "C", label: "Cukup", minScore: 1.5 },
        { code: "D", label: "Kurang", minScore: 1 },
      ],
    };
    let linkPeriodId: string;

    async function clearCycles() {
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM performance_cycles
         WHERE (kind = 'MONTHLY' AND period_start = ANY($1::date[])) OR (kind = 'ANNUAL' AND period_start = $2::date)`,
        [[MONTHLY_START, "2031-03-01"], ANNUAL_START],
      );
      const ids = rows.map((row) => row.id);
      await pool.query("DELETE FROM performance_events WHERE cycle_id = ANY($1::uuid[])", [ids]);
      await pool.query("DELETE FROM performance_reviews WHERE cycle_id = ANY($1::uuid[])", [ids]);
      await pool.query("DELETE FROM performance_cycles WHERE id = ANY($1::uuid[])", [ids]);
    }

    async function cycle(kind: "MONTHLY" | "ANNUAL", periodStart: string, status: string, closedAt: string | null) {
      const id = randomUUID();
      const periodEnd = kind === "MONTHLY" ? `${periodStart.slice(0, 7)}-28` : "2031-06-30";
      await pool.query(
        `INSERT INTO performance_cycles(
           id, name, kind, period_start, period_end, self_due_on, review_due_on, status, rubric, closed_at)
         VALUES ($1, 'Siklus uji payroll', $2, $3::date, $4::date, $4::date, $4::date, $5, $6::jsonb, $7::timestamptz)`,
        [id, kind, periodStart, periodEnd, status, JSON.stringify(RUBRIC), closedAt],
      );
      return id;
    }

    async function review(cycleId: string, employeeId: string, status: string, predicate: string | null) {
      const id = randomUUID();
      const final = status === "FINALIZED" || status === "HC_VALIDATION";
      await pool.query(
        `INSERT INTO performance_reviews(
           id, cycle_id, employee_id, status, final_score, predicate_code, predicate_label, trend, finalized_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8)`,
        [
          id,
          cycleId,
          employeeId,
          status,
          final ? 3 : null,
          final ? predicate : null,
          status === "FINALIZED" ? "FIRST" : null,
          status === "FINALIZED" ? "2031-03-02T03:00:00Z" : null,
        ],
      );
      return id;
    }

    async function switchLink(
      enabled: boolean | null,
      byPredicate: Record<string, number> = { A: 1, B: 0.9, C: 0.75, D: 0.5 },
    ) {
      await pool.query("DELETE FROM payroll_policy_versions WHERE policy_key = 'PERFORMANCE_PERCENT'");
      if (enabled === null) return;
      await pool.query(
        `INSERT INTO payroll_policy_versions(id, policy_key, effective_from, payload, source)
         VALUES ($1, 'PERFORMANCE_PERCENT', DATE '2031-01-01', $2::jsonb, 'uji sintetis')`,
        [randomUUID(), JSON.stringify({ enabled, byPredicate })],
      );
    }

    const linkPeriod = () => ({
      id: linkPeriodId,
      legalEntityKey,
      periodStart: "2031-03-01",
      periodEnd: "2031-03-31",
      payDate: LINK_PAY_DATE,
    });

    async function perfOf(employmentId: string): Promise<number> {
      const { rows } = await pool.query<{ amount: string }>(
        `SELECT l.amount FROM payroll_result_lines l JOIN payroll_results r ON r.id = l.result_id
         WHERE r.period_id = $1 AND r.employment_id = $2 AND l.component_code = 'PERF'
           AND r.revision = (SELECT max(revision) FROM payroll_results WHERE period_id = $1 AND employment_id = $2)`,
        [linkPeriodId, employmentId],
      );
      return rows.reduce((total, row) => total + Number(row.amount), 0);
    }

    async function latestResult(employmentId: string) {
      const { rows } = await pool.query<{
        snapshot: Record<string, unknown>;
        blockers: Array<{ code: string }>;
        gross: string;
      }>(
        `SELECT input_snapshot AS snapshot, blockers, gross FROM payroll_results
         WHERE period_id = $1 AND employment_id = $2 ORDER BY revision DESC LIMIT 1`,
        [linkPeriodId, employmentId],
      );
      return rows[0]!;
    }

    beforeEach(async () => {
      await clearCycles();
      await switchLink(null);
      linkPeriodId = randomUUID();
      ownedPeriodIds.push(linkPeriodId);
      await pool.query(
        `INSERT INTO payroll_periods(
           id, legal_entity_key, period_month, pay_date, period_start, period_end, cutoff_start, cutoff_end, state)
         VALUES ($1, $2, DATE '2031-03-01', $3::date, DATE '2031-03-01', DATE '2031-03-31',
                 DATE '2031-02-23', DATE '2031-03-22', 'COLLECTING')`,
        [linkPeriodId, legalEntityKey, LINK_PAY_DATE],
      );
    });

    afterAll(async () => {
      await clearCycles();
      await switchLink(null);
    });

    it("switched off, finalized reviews change nothing: same lines and the same snapshot shape", async () => {
      const { employmentId, employeeId } = await newEmployment({ category: "TETAP" });
      await review(await cycle("MONTHLY", MONTHLY_START, "CLOSED", "2031-03-03T03:00:00Z"), employeeId, "FINALIZED", "A");
      await review(await cycle("ANNUAL", ANNUAL_START, "CLOSED", "2031-03-03T03:00:00Z"), employeeId, "FINALIZED", "A");

      await calculatePeriod(pool, linkPeriod(), actorAccountId, 0);
      const absent = await latestResult(employmentId);
      expect(await perfOf(employmentId)).toBe(0);
      expect(Object.keys(absent.snapshot).sort()).toEqual(["inputs", "period_fingerprint"]);
      expect(Object.keys(absent.snapshot.inputs as object)).not.toContain("monthlyPerformanceRateFromReview");

      await switchLink(false);
      await calculatePeriod(pool, linkPeriod(), actorAccountId, 0);
      const disabled = await latestResult(employmentId);
      expect(await perfOf(employmentId)).toBe(0);
      expect(disabled.gross).toBe(absent.gross);
      expect(disabled.snapshot).toEqual(absent.snapshot);
    });

    it("switched on, pays from the FINALIZED reviews and keeps the review, cycle and predicate", async () => {
      const { employmentId, employeeId } = await newEmployment({ category: "TETAP" });
      const monthlyCycle = await cycle("MONTHLY", MONTHLY_START, "CLOSED", "2031-03-03T03:00:00Z");
      const annualCycle = await cycle("ANNUAL", ANNUAL_START, "CLOSED", "2031-03-03T03:00:00Z");
      const monthlyReview = await review(monthlyCycle, employeeId, "FINALIZED", "B");
      const annualReview = await review(annualCycle, employeeId, "FINALIZED", "A");
      await switchLink(true);

      await calculatePeriod(pool, linkPeriod(), actorAccountId, 0);
      // 1 x 100000 x 60 % + 0.9 x 100000 x 40 %.
      expect(await perfOf(employmentId)).toBe(96_000);
      const result = await latestResult(employmentId);
      expect(result.blockers).toEqual([]);
      expect(result.snapshot.performance_link).toMatchObject({
        monthly: { review_id: monthlyReview, cycle_id: monthlyCycle, predicate: "B", rate: 0.9 },
        annual: { review_id: annualReview, cycle_id: annualCycle, predicate: "A", rate: 1 },
      });

      const audit = await pool.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM payroll_audit_events
         WHERE period_id = $1 AND action = 'payroll.period.calculated'`,
        [linkPeriodId],
      );
      expect(audit.rows[0]!.payload).toMatchObject({ performance_link_enabled: true, performance_linked_count: 1 });
      expect(JSON.stringify(audit.rows[0]!.payload)).not.toContain(monthlyReview);
    });

    it("never reads an open cycle, an UNRATED review, or a cycle closed after the pay date", async () => {
      const open = await newEmployment({ category: "TETAP" });
      const unrated = await newEmployment({ category: "TETAP" });
      const monthlyCycle = await cycle("MONTHLY", MONTHLY_START, "OPEN", null);
      await review(monthlyCycle, open.employeeId, "FINALIZED", "A");
      // Closed, but only after the pay date: payroll of March 2031 must not see it.
      const lateAnnual = await cycle("ANNUAL", ANNUAL_START, "CLOSED", "2031-04-02T03:00:00Z");
      await review(lateAnnual, open.employeeId, "FINALIZED", "A");
      await review(lateAnnual, unrated.employeeId, "UNRATED", null);
      await switchLink(true);

      await calculatePeriod(pool, linkPeriod(), actorAccountId, 0);
      expect(await perfOf(open.employmentId)).toBe(0);
      expect(await perfOf(unrated.employmentId)).toBe(0);
      expect((await latestResult(open.employmentId)).snapshot.performance_link).toMatchObject({
        monthly: null,
        annual: null,
      });
    });

    it("falls back to the compensation profile when there is no finalized review", async () => {
      const { employmentId } = await newEmployment({ category: "TETAP" });
      await pool.query(
        `UPDATE payroll_compensation_profiles SET annual_performance_rate = 0.8, monthly_performance_rate = 0.6
         WHERE employment_id = $1`,
        [employmentId],
      );
      await switchLink(true);
      await calculatePeriod(pool, linkPeriod(), actorAccountId, 0);
      // 0.8 x 100000 x 60 % + 0.6 x 100000 x 40 %.
      expect(await perfOf(employmentId)).toBe(72_000);
    });

    it("blocks a predicate the policy does not map", async () => {
      const { employmentId, employeeId } = await newEmployment({ category: "TETAP" });
      await review(await cycle("MONTHLY", MONTHLY_START, "CLOSED", "2031-03-03T03:00:00Z"), employeeId, "FINALIZED", "D");
      await switchLink(true, { A: 1, B: 0.9, C: 0.75 });
      const outcome = await calculatePeriod(pool, linkPeriod(), actorAccountId, 0);
      expect(outcome.blockerCount).toBe(1);
      expect((await latestResult(employmentId)).blockers.map((blocker) => blocker.code)).toContain(
        "PERFORMANCE_PREDICATE_UNMAPPED",
      );
    });
  });
});
