// PAY-003 calculation against real PostgreSQL: who is in the period, what gets
// stored, and whether a period that moved on can still be written to.
// Runs only against the loopback CI database; everything is created in a
// disposable schema and dropped afterwards.

import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { clearOwnPeriods } from "./support/payroll-cleanup.js";

import { setLoanDeductions } from "../src/modules/payroll/admin-store.js";
import { calculatePeriod } from "../src/modules/payroll/calculation.js";
import { settleEmployeeLoanDeductions } from "../src/modules/payroll/employee-loan-link.js";
import { listResults } from "../src/modules/payroll/inputs-store.js";
import { draftPayslipsFromPeriod } from "../src/modules/payroll/publication.js";
import { parsePph21TerPolicy } from "../src/modules/payroll/policy.js";
import { buildPph21Report } from "../src/modules/payroll/pph21.js";
import {
  buildTransferList,
  findPph21Settings,
  loadPph21MonthSources,
  loadPph21SourceRows,
} from "../src/modules/payroll/reports.js";
import { applyTransition, getPeriod, hasCurrentCalculation } from "../src/modules/payroll/store.js";
import { createSyntheticActor } from "./support/synthetic-actor.js";

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

    // A fresh actor of this suite: a borrowed account could be another suite's
    // (see support/synthetic-actor.ts).
    actorAccountId = await createSyntheticActor(pool, "CALC");
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

    it("reads only the latest closed ANNUAL cycle, and closes on the Asia/Jakarta date", async () => {
      const older = await newEmployment({ category: "TETAP" });
      const boundary = await newEmployment({ category: "TETAP" });
      // A review only in an older annual cycle is not reached for (K3).
      const olderCycle = await cycle("ANNUAL", "2029-07-01", "CLOSED", "2030-07-02T03:00:00Z");
      await review(olderCycle, older.employeeId, "FINALIZED", "A");
      // Closed 24 March 17:30 UTC = 25 March 00:30 WIB: the pay date itself, so it counts.
      const latest = await cycle("ANNUAL", ANNUAL_START, "CLOSED", "2031-03-24T17:30:00Z");
      await review(latest, boundary.employeeId, "FINALIZED", "C");
      await switchLink(true);
      try {
        await calculatePeriod(pool, linkPeriod(), actorAccountId, 0);
        expect(await perfOf(older.employmentId)).toBe(0);
        // 0.75 x 100000 x 60 %.
        expect(await perfOf(boundary.employmentId)).toBe(45_000);

        // 25 March 17:30 UTC = 26 March WIB: after the pay date, so the older cycle is the latest.
        await pool.query("UPDATE performance_cycles SET closed_at = '2031-03-25T17:30:00Z' WHERE id = $1", [latest]);
        await calculatePeriod(pool, linkPeriod(), actorAccountId, 0);
        expect(await perfOf(older.employmentId)).toBe(60_000);
        expect(await perfOf(boundary.employmentId)).toBe(0);
      } finally {
        await pool.query("DELETE FROM performance_reviews WHERE cycle_id = $1", [olderCycle]);
        await pool.query("DELETE FROM performance_cycles WHERE id = $1", [olderCycle]);
      }
    });

    it("leaves honorarium staff alone: no PERF and no blocker from their review", async () => {
      const { employmentId, employeeId } = await newEmployment({ category: "KONTRAK_HONORER" });
      await review(await cycle("MONTHLY", MONTHLY_START, "CLOSED", "2031-03-03T03:00:00Z"), employeeId, "FINALIZED", "Z");
      await switchLink(true);
      await calculatePeriod(pool, linkPeriod(), actorAccountId, 0);
      const result = await latestResult(employmentId);
      expect(result.blockers.map((blocker) => blocker.code)).not.toContain("PERFORMANCE_PREDICATE_UNMAPPED");
      expect(Object.keys(result.snapshot)).not.toContain("performance_link");
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

  // LOAN-001 Package 2 (employee-loans.md section 9, specification section
  // 3.5): instalments proposed by the calculation, settled on approval,
  // reversed on reopen. Payroll March 2031, far from any other suite.
  describe("LOAN-001 deduction", () => {
    let loanPeriodId: string;

    const loanPeriod = () => ({
      id: loanPeriodId,
      legalEntityKey,
      periodStart: "2031-03-01",
      periodEnd: "2031-03-31",
      payDate: "2031-03-25",
    });

    /** A disbursed LOAN-001 loan: Rp1.000.000 over 3 months from March 2031 (D-07). */
    async function disbursedLoan(employeeId: string): Promise<string> {
      const id = randomUUID();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO employee_loans(
             id, employee_id, principal_amount, tenor_months, purpose, status, idempotency_key,
             final_decided_at, disbursed_on, disbursement_method, first_due_month,
             disbursed_by_account_id, disbursed_at)
           VALUES ($1, $2, 1000000, 3, 'Keperluan uji sintetis', 'DISBURSED', $3,
                   now(), DATE '2031-02-10', 'TRANSFER', DATE '2031-03-01', $4, now())`,
          [id, employeeId, randomUUID(), actorAccountId],
        );
        await client.query(
          `INSERT INTO employee_loan_instalments(id, loan_id, sequence, due_month, amount)
           VALUES ($1, $4, 1, DATE '2031-03-01', 333000),
                  ($2, $4, 2, DATE '2031-04-01', 333000),
                  ($3, $4, 3, DATE '2031-05-01', 334000)`,
          [randomUUID(), randomUUID(), randomUUID(), id],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return id;
    }

    /** A cash repayment recorded outside payroll, as the LOAN-001 route writes it. */
    async function cashPayment(loanId: string, amount: number) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO employee_loan_payments(
             id, loan_id, amount, paid_on, method, idempotency_key, recorded_by_account_id)
           VALUES ($1, $2, $3, DATE '2031-03-05', 'CASH', $4, $5)`,
          [randomUUID(), loanId, amount, randomUUID(), actorAccountId],
        );
        await client.query("UPDATE employee_loans SET paid_total = paid_total + $2 WHERE id = $1", [loanId, amount]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    async function loanState(loanId: string) {
      const loan = await pool.query<{ paidTotal: string; status: string }>(
        `SELECT paid_total::text AS "paidTotal", status FROM employee_loans WHERE id = $1`,
        [loanId],
      );
      const payments = await pool.query<{ amount: string; status: string; method: string; source: string | null }>(
        `SELECT amount::text AS amount, status, method, source_payroll_period_id AS source
         FROM employee_loan_payments WHERE loan_id = $1 ORDER BY recorded_at`,
        [loanId],
      );
      return { ...loan.rows[0]!, payments: payments.rows };
    }

    async function loanLine(employmentId: string): Promise<number> {
      const { rows } = await pool.query<{ amount: string }>(
        `SELECT l.amount FROM payroll_result_lines l JOIN payroll_results r ON r.id = l.result_id
         WHERE r.period_id = $1 AND r.employment_id = $2 AND l.component_code = 'LOAN'
           AND r.revision = (SELECT max(revision) FROM payroll_results WHERE period_id = $1 AND employment_id = $2)`,
        [loanPeriodId, employmentId],
      );
      return rows.reduce((total, row) => total + Number(row.amount), 0);
    }

    async function moveTo(state: string, extra = "") {
      await pool.query(`UPDATE payroll_periods SET state = $2 ${extra} WHERE id = $1`, [loanPeriodId, state]);
    }

    async function transition(action: "approve" | "approve_reopen", nextState: "APPROVED" | "COLLECTING") {
      const current = (await getPeriod(pool, loanPeriodId))!;
      return applyTransition(pool, {
        periodId: loanPeriodId,
        action,
        nextState,
        auditAction: action === "approve" ? "payroll.period.approved" : "payroll.reopen.approved",
        actorAccountId,
        reason: null,
        expectedVersion: current.version,
        blockerCount: 0,
        fromState: current.state,
      });
    }

    beforeEach(async () => {
      loanPeriodId = randomUUID();
      ownedPeriodIds.push(loanPeriodId);
      await pool.query(
        `INSERT INTO payroll_periods(
           id, legal_entity_key, period_month, pay_date, period_start, period_end, cutoff_start, cutoff_end, state)
         VALUES ($1, $2, DATE '2031-03-01', DATE '2031-03-25', DATE '2031-03-01', DATE '2031-03-31',
                 DATE '2031-02-23', DATE '2031-03-22', 'COLLECTING')`,
        [loanPeriodId, legalEntityKey],
      );
    });

    it("switched off, a LOAN-001 loan is not mirrored and nothing is deducted", async () => {
      const { employmentId, employeeId } = await newEmployment({ category: "TETAP" });
      const loanId = await disbursedLoan(employeeId);
      await calculatePeriod(pool, loanPeriod(), actorAccountId, 0);
      expect(await loanLine(employmentId)).toBe(0);
      const mirror = await pool.query("SELECT 1 FROM payroll_loans WHERE employee_loan_id = $1", [loanId]);
      expect(mirror.rows).toHaveLength(0);
    });

    it("proposes the instalment, settles it once on approval, reverses on reopen, settles again", async () => {
      const { employmentId, employeeId } = await newEmployment({ category: "TETAP" });
      const loanId = await disbursedLoan(employeeId);

      await calculatePeriod(pool, loanPeriod(), actorAccountId, 0, { employeeLoanDeduction: true });
      await calculatePeriod(pool, loanPeriod(), actorAccountId, 0, { employeeLoanDeduction: true });
      expect(await loanLine(employmentId)).toBe(333_000);
      const deductions = await pool.query<{ origin: string }>(
        `SELECT d.origin FROM payroll_loan_deductions d JOIN payroll_loans l ON l.id = d.loan_id
         WHERE l.employee_loan_id = $1 AND d.period_id = $2`,
        [loanId, loanPeriodId],
      );
      expect(deductions.rows.map((row) => row.origin)).toEqual(["PROPOSED"]);
      // Nothing is paid while the period is only calculated.
      expect((await loanState(loanId)).paidTotal).toBe("0");

      await moveTo("SUBMITTED");
      expect((await transition("approve", "APPROVED")).applied).toBe(true);
      let state = await loanState(loanId);
      expect(state.paidTotal).toBe("333000");
      expect(state.payments).toEqual([
        { amount: "333000", status: "ACTIVE", method: "PAYROLL_DEDUCTION", source: loanPeriodId },
      ]);

      // Idempotent: settling the same approved period again writes nothing.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const again = await settleEmployeeLoanDeductions(
          client,
          { id: loanPeriodId, periodMonth: "2031-03-01", payDate: "2031-03-25" },
          actorAccountId,
        );
        await client.query("COMMIT");
        expect(again.settled).toBe(0);
      } finally {
        client.release();
      }

      await moveTo("REOPEN_REQUESTED", ", state_before_reopen_request = 'APPROVED'");
      expect((await transition("approve_reopen", "COLLECTING")).applied).toBe(true);
      state = await loanState(loanId);
      expect(state.paidTotal).toBe("0");
      expect(state.payments.map((payment) => payment.status)).toEqual(["REVERSED"]);

      await calculatePeriod(pool, loanPeriod(), actorAccountId, (await getPeriod(pool, loanPeriodId))!.version, {
        employeeLoanDeduction: true,
      });
      expect(await loanLine(employmentId)).toBe(333_000);
      await moveTo("SUBMITTED");
      expect((await transition("approve", "APPROVED")).applied).toBe(true);
      state = await loanState(loanId);
      expect(state.paidTotal).toBe("333000");
      expect(state.payments.map((payment) => payment.status)).toEqual(["REVERSED", "ACTIVE"]);

      const audit = await pool.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM payroll_audit_events WHERE period_id = $1 AND action = 'payroll.period.approved'`,
        [loanPeriodId],
      );
      expect(audit.rows[0]!.payload.loan_payments_settled).toBe(1);
      expect(JSON.stringify(audit.rows.map((row) => row.payload))).not.toContain("333000");
    });

    it("counts a cash repayment first and keeps Finance's own figure, including a skipped month", async () => {
      const prepaid = await newEmployment({ category: "TETAP" });
      const prepaidLoan = await disbursedLoan(prepaid.employeeId);
      await cashPayment(prepaidLoan, 400_000);
      const manual = await newEmployment({ category: "TETAP" });
      const manualLoan = await disbursedLoan(manual.employeeId);

      await calculatePeriod(pool, loanPeriod(), actorAccountId, 0, { employeeLoanDeduction: true });
      // March is covered by the cash payment: no deduction at all.
      expect(await loanLine(prepaid.employmentId)).toBe(0);
      expect(await loanLine(manual.employmentId)).toBe(333_000);

      const mirror = await pool.query<{ id: string }>("SELECT id FROM payroll_loans WHERE employee_loan_id = $1", [manualLoan]);
      expect((await setLoanDeductions(pool, loanPeriodId, [{ loanId: mirror.rows[0]!.id, amount: 0 }], actorAccountId)).ok).toBe(true);
      await calculatePeriod(pool, loanPeriod(), actorAccountId, (await getPeriod(pool, loanPeriodId))!.version, {
        employeeLoanDeduction: true,
      });
      expect(await loanLine(manual.employmentId)).toBe(0);

      await moveTo("SUBMITTED");
      expect((await transition("approve", "APPROVED")).applied).toBe(true);
      expect((await loanState(manualLoan)).payments).toEqual([]);
      expect((await loanState(prepaidLoan)).paidTotal).toBe("400000");
    });

    it("refuses approval when the loan balance moved after the calculation", async () => {
      const { employeeId } = await newEmployment({ category: "TETAP" });
      const loanId = await disbursedLoan(employeeId);
      await calculatePeriod(pool, loanPeriod(), actorAccountId, 0, { employeeLoanDeduction: true });
      await cashPayment(loanId, 900_000);

      await moveTo("SUBMITTED");
      const result = await transition("approve", "APPROVED");
      expect(result.applied).toBe(false);
      expect(result.refusal?.code).toBe("PAYROLL_LOAN_BALANCE_CHANGED");
      expect((await getPeriod(pool, loanPeriodId))!.state).toBe("SUBMITTED");
      expect((await loanState(loanId)).payments.map((payment) => payment.method)).toEqual(["CASH"]);
    });

    it("re-derives proposals: one left behind by an earlier run is neither settled nor blocking", async () => {
      const leaver = await newEmployment({ category: "TETAP" });
      const leaverLoan = await disbursedLoan(leaver.employeeId);
      const prepaid = await newEmployment({ category: "TETAP" });
      const prepaidLoan = await disbursedLoan(prepaid.employeeId);
      await calculatePeriod(pool, loanPeriod(), actorAccountId, 0, { employeeLoanDeduction: true });
      expect(await loanLine(leaver.employmentId)).toBe(333_000);

      // The leaver drops out of the run; the other repays in cash after the calculation.
      await pool.query("UPDATE employments SET legal_entity_key = $2 WHERE id = $1", [leaver.employmentId, randomUUID()]);
      await cashPayment(prepaidLoan, 700_000);
      const outcome = await calculatePeriod(pool, loanPeriod(), actorAccountId, 0, { employeeLoanDeduction: true });
      expect(outcome.blockerCount).toBe(0);
      expect(await loanLine(prepaid.employmentId)).toBe(0);
      const left = await pool.query(
        "SELECT 1 FROM payroll_loan_deductions WHERE period_id = $1 AND origin = 'PROPOSED'",
        [loanPeriodId],
      );
      expect(left.rows).toHaveLength(0);

      await moveTo("SUBMITTED");
      expect((await transition("approve", "APPROVED")).applied).toBe(true);
      expect((await loanState(leaverLoan)).payments).toEqual([]);
      expect((await loanState(prepaidLoan)).payments.map((payment) => payment.method)).toEqual(["CASH"]);
    });

    it("drops its own proposals when the switch is turned off again", async () => {
      const { employmentId, employeeId } = await newEmployment({ category: "TETAP" });
      await disbursedLoan(employeeId);
      await calculatePeriod(pool, loanPeriod(), actorAccountId, 0, { employeeLoanDeduction: true });
      expect(await loanLine(employmentId)).toBe(333_000);
      await calculatePeriod(pool, loanPeriod(), actorAccountId, (await getPeriod(pool, loanPeriodId))!.version);
      expect(await loanLine(employmentId)).toBe(0);
    });
  });

  // REIMB-001 section 9 (specification section 3.6): reimbursements handed to
  // payroll, paid outside the pay factor, settled on approval, carried through
  // a reopen. Payroll June 2031, far from any other suite.
  describe("REIMB-001 payroll handoff", () => {
    let reimbursementPeriodId: string;
    // Claims are global rows another suite's register test counts, so every
    // claim this suite writes is removed again (append-only triggers stood down
    // for the cleanup only, as the payroll cleanup does).
    const ownClaims: string[] = [];

    afterAll(async () => {
      if (ownClaims.length === 0) return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL session_replication_role = replica");
        for (const table of ["reimbursement_payroll_handoffs", "reimbursement_payments", "reimbursement_events", "reimbursement_items"]) {
          await client.query(`DELETE FROM ${table} WHERE claim_id = ANY($1::uuid[])`, [ownClaims]);
        }
        await client.query("DELETE FROM reimbursement_claims WHERE id = ANY($1::uuid[])", [ownClaims]);
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    });

    const reimbursementPeriod = () => ({
      id: reimbursementPeriodId,
      legalEntityKey,
      periodStart: "2031-06-01",
      periodEnd: "2031-06-30",
      payDate: "2031-06-25",
    });

    /** A VERIFIED claim of Rp250.000 handed to payroll June 2031, as the REIMB-001 route writes it. */
    async function handedOffClaim(employeeId: string, amount = 250_000): Promise<{ claimId: string; handoffId: string }> {
      const claimId = randomUUID();
      const handoffId = randomUUID();
      ownClaims.push(claimId);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO reimbursement_claims(id, employee_id, title, status, claimed_total, idempotency_key)
           VALUES ($1, $2, 'Klaim uji sintetis', 'DRAFT', $3, $4)`,
          [claimId, employeeId, amount, randomUUID()],
        );
        await client.query(
          `INSERT INTO reimbursement_items(id, claim_id, line_no, category, expense_date, description, amount)
           VALUES ($1, $2, 1, 'TRANSPORT', DATE '2031-05-10', 'Transport uji', $3)`,
          [randomUUID(), claimId, amount],
        );
        await client.query(
          // Dated in 2031: the register suite summarises today's claims across the shared database.
          "UPDATE reimbursement_claims SET status = 'APPROVED', submitted_at = TIMESTAMPTZ '2031-05-12 03:00Z', final_decided_at = TIMESTAMPTZ '2031-05-13 03:00Z' WHERE id = $1",
          [claimId],
        );
        await client.query("UPDATE reimbursement_items SET approved_amount = amount WHERE claim_id = $1", [claimId]);
        await client.query(
          `UPDATE reimbursement_claims SET status = 'VERIFIED', verified_total = $2,
                  verified_by_account_id = $3, verified_at = TIMESTAMPTZ '2031-05-14 03:00Z' WHERE id = $1`,
          [claimId, amount, actorAccountId],
        );
        await client.query(
          `INSERT INTO reimbursement_payroll_handoffs(
             id, claim_id, payroll_month, amount, status, idempotency_key, created_by_account_id)
           VALUES ($1, $2, DATE '2031-06-01', $3, 'PENDING', $4, $5)`,
          [handoffId, claimId, amount, randomUUID(), actorAccountId],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return { claimId, handoffId };
    }

    async function claimState(claimId: string) {
      const claim = await pool.query<{ status: string }>("SELECT status FROM reimbursement_claims WHERE id = $1", [claimId]);
      const payments = await pool.query<{ amount: string; method: string; payrollMonth: string }>(
        `SELECT amount::text AS amount, method, to_char(payroll_month, 'YYYY-MM') AS "payrollMonth"
         FROM reimbursement_payments WHERE claim_id = $1`,
        [claimId],
      );
      const handoffs = await pool.query<{ status: string }>(
        "SELECT status FROM reimbursement_payroll_handoffs WHERE claim_id = $1 ORDER BY created_at",
        [claimId],
      );
      return {
        status: claim.rows[0]!.status,
        payments: payments.rows,
        handoffs: handoffs.rows.map((row) => row.status),
      };
    }

    async function latest(employmentId: string) {
      const { rows } = await pool.query<{ payable: string; net: string; reimburse: string | null }>(
        `SELECT r.payable::text AS payable, r.net::text AS net,
                (SELECT l.amount::text FROM payroll_result_lines l
                 WHERE l.result_id = r.id AND l.component_code = 'REIMBURSE') AS reimburse
         FROM payroll_results r WHERE r.period_id = $1 AND r.employment_id = $2
         ORDER BY r.revision DESC LIMIT 1`,
        [reimbursementPeriodId, employmentId],
      );
      return rows[0]!;
    }

    async function transition(action: "approve" | "approve_reopen", nextState: "APPROVED" | "COLLECTING") {
      const current = (await getPeriod(pool, reimbursementPeriodId))!;
      return applyTransition(pool, {
        periodId: reimbursementPeriodId,
        action,
        nextState,
        auditAction: action === "approve" ? "payroll.period.approved" : "payroll.reopen.approved",
        actorAccountId,
        reason: null,
        expectedVersion: current.version,
        blockerCount: 0,
        fromState: current.state,
      });
    }

    async function recalculate(enabled = true) {
      return calculatePeriod(
        pool,
        reimbursementPeriod(),
        actorAccountId,
        (await getPeriod(pool, reimbursementPeriodId))!.version,
        enabled ? { reimbursementHandoff: true } : {},
      );
    }

    beforeEach(async () => {
      reimbursementPeriodId = randomUUID();
      ownedPeriodIds.push(reimbursementPeriodId);
      await pool.query(
        `INSERT INTO payroll_periods(
           id, legal_entity_key, period_month, pay_date, period_start, period_end, cutoff_start, cutoff_end, state)
         VALUES ($1, $2, DATE '2031-06-01', DATE '2031-06-25', DATE '2031-06-01', DATE '2031-06-30',
                 DATE '2031-05-23', DATE '2031-06-22', 'COLLECTING')`,
        [reimbursementPeriodId, legalEntityKey],
      );
    });

    it("switched off, a handed-off claim is not read and the result is unchanged", async () => {
      const { employmentId, employeeId } = await newEmployment({ category: "TETAP" });
      const { claimId } = await handedOffClaim(employeeId);
      await recalculate(false);
      const result = await latest(employmentId);
      expect(result.reimburse).toBeNull();
      const snapshot = await pool.query<{ inputs: Record<string, unknown> }>(
        "SELECT input_snapshot -> 'inputs' AS inputs FROM payroll_results WHERE period_id = $1",
        [reimbursementPeriodId],
      );
      expect(Object.keys(snapshot.rows[0]!.inputs)).not.toContain("reimbursement");
      expect((await claimState(claimId)).status).toBe("VERIFIED");
    });

    it("pays in full outside the early-service factor, settles once, survives a reopen", async () => {
      // Started in May 2031: under two months of service, so the net is paid at 80 %.
      const { employmentId, employeeId } = await newEmployment({ category: "TETAP", startedOn: "2031-05-01" });
      const { claimId } = await handedOffClaim(employeeId);

      await recalculate();
      let result = await latest(employmentId);
      expect(result.reimburse).toBe("250000");
      // payable = ROUNDUP((net - 250000) x 0.8) + 250000, exactly.
      expect(Number(result.payable)).toBe(Math.ceil((Number(result.net) - 250_000) * 0.8) + 250_000);

      await pool.query("UPDATE payroll_periods SET state = 'SUBMITTED' WHERE id = $1", [reimbursementPeriodId]);
      expect((await transition("approve", "APPROVED")).applied).toBe(true);
      let state = await claimState(claimId);
      expect(state).toEqual({
        status: "PAID",
        payments: [{ amount: "250000", method: "PAYROLL", payrollMonth: "2031-06" }],
        handoffs: ["SETTLED"],
      });

      await pool.query(
        "UPDATE payroll_periods SET state = 'REOPEN_REQUESTED', state_before_reopen_request = 'APPROVED' WHERE id = $1",
        [reimbursementPeriodId],
      );
      expect((await transition("approve_reopen", "COLLECTING")).applied).toBe(true);
      state = await claimState(claimId);
      // The payment is immutable and stays; the handoff is reversed and carried forward.
      expect(state.status).toBe("PAID");
      expect(state.payments).toHaveLength(1);
      expect(state.handoffs).toEqual(["REVERSED", "PENDING"]);

      await recalculate();
      result = await latest(employmentId);
      expect(result.reimburse).toBe("250000");
      await pool.query("UPDATE payroll_periods SET state = 'SUBMITTED' WHERE id = $1", [reimbursementPeriodId]);
      expect((await transition("approve", "APPROVED")).applied).toBe(true);
      state = await claimState(claimId);
      expect(state.payments).toHaveLength(1);
      expect(state.handoffs).toEqual(["REVERSED", "SETTLED"]);

      const audit = await pool.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM payroll_audit_events WHERE period_id = $1 AND action = 'payroll.period.approved'`,
        [reimbursementPeriodId],
      );
      expect(audit.rows.map((row) => row.payload.reimbursements_settled)).toEqual([1, 1]);
      expect(JSON.stringify(audit.rows.map((row) => row.payload))).not.toContain("250000");
    });

    it("refuses approval when the slip and the handoffs disagree", async () => {
      const { employeeId } = await newEmployment({ category: "TETAP" });
      const { claimId, handoffId } = await handedOffClaim(employeeId);
      await recalculate();
      // Finance withdraws the claim after the calculation, as paying it in cash does.
      await pool.query(
        `UPDATE reimbursement_payroll_handoffs
            SET status = 'WITHDRAWN', period_id = NULL, closed_at = now(),
                closed_by_account_id = $2, close_reason = 'Dibayar di luar payroll oleh Keuangan.'
          WHERE id = $1`,
        [handoffId, actorAccountId],
      );
      await pool.query("UPDATE payroll_periods SET state = 'SUBMITTED' WHERE id = $1", [reimbursementPeriodId]);
      const outcome = await transition("approve", "APPROVED");
      expect(outcome.applied).toBe(false);
      expect(outcome.refusal?.code).toBe("PAYROLL_REIMBURSEMENT_CHANGED");
      expect((await claimState(claimId)).payments).toEqual([]);
    });

    it("refuses approval for a handoff made after the last calculation", async () => {
      const { employeeId } = await newEmployment({ category: "TETAP" });
      await recalculate();
      const { claimId } = await handedOffClaim(employeeId);
      await pool.query("UPDATE payroll_periods SET state = 'SUBMITTED' WHERE id = $1", [reimbursementPeriodId]);
      const outcome = await transition("approve", "APPROVED");
      expect(outcome.refusal?.code).toBe("PAYROLL_REIMBURSEMENT_CHANGED");
      expect((await claimState(claimId)).status).toBe("VERIFIED");
    });

    it("refuses re-approval when a reopened period no longer pays a claim it already paid", async () => {
      await newEmployment({ category: "TETAP" });
      const { employmentId, employeeId } = await newEmployment({ category: "TETAP" });
      const { claimId } = await handedOffClaim(employeeId);
      await recalculate();
      await pool.query("UPDATE payroll_periods SET state = 'SUBMITTED' WHERE id = $1", [reimbursementPeriodId]);
      expect((await transition("approve", "APPROVED")).applied).toBe(true);
      await pool.query(
        "UPDATE payroll_periods SET state = 'REOPEN_REQUESTED', state_before_reopen_request = 'APPROVED' WHERE id = $1",
        [reimbursementPeriodId],
      );
      expect((await transition("approve_reopen", "COLLECTING")).applied).toBe(true);
      // The employee drops out of the recalculated run.
      await pool.query("UPDATE employments SET legal_entity_key = $2 WHERE id = $1", [employmentId, randomUUID()]);
      await recalculate();
      await pool.query("UPDATE payroll_periods SET state = 'SUBMITTED' WHERE id = $1", [reimbursementPeriodId]);
      expect((await transition("approve", "APPROVED")).refusal?.code).toBe("PAYROLL_REIMBURSEMENT_CHANGED");
      expect((await claimState(claimId)).payments).toHaveLength(1);
    });

    it("releases a handoff when its employee leaves the run", async () => {
      // Someone stays, so the second run writes results of its own.
      await newEmployment({ category: "TETAP" });
      const { employmentId, employeeId } = await newEmployment({ category: "TETAP" });
      const { handoffId } = await handedOffClaim(employeeId);
      await recalculate();
      await pool.query("UPDATE employments SET legal_entity_key = $2 WHERE id = $1", [employmentId, randomUUID()]);
      await recalculate();
      const bound = await pool.query<{ periodId: string | null }>(
        `SELECT period_id AS "periodId" FROM reimbursement_payroll_handoffs WHERE id = $1`,
        [handoffId],
      );
      expect(bound.rows[0]!.periodId).toBeNull();
      await pool.query("UPDATE payroll_periods SET state = 'SUBMITTED' WHERE id = $1", [reimbursementPeriodId]);
      expect((await transition("approve", "APPROVED")).applied).toBe(true);
    });
  });

  // PAY-003 section 7.6 (owner decision 2026-11-17). In this file for the same reason as THR
  // below: the monthly policy rows are this suite's. November 2037 is a month of its own, with
  // PPH21_SETTINGS effective only in it, so no other test calculates or reports under it.
  //
  // No PPH21_TER row is written here: that key belongs to payroll-admin.integration, which
  // clears it before each of its tests and opens open-ended versions of it. The TER table is
  // handed to the pure report in memory instead, and the PPH21_EMPLOYER line computed from
  // that same report is covered by hand in payroll-pph21-employer.test.ts.
  describe("employer-paid BPJS Kesehatan premium in the PPh21 base (section 7.6)", () => {
    const MONTH = "2037-11";
    const TER = (() => {
      const parsed = parsePph21TerPolicy({
        source: "Tabel uji sintetis",
        objectCode: "21-100-01",
        ptkpCategory: { "TK/0": "A" },
        // 4.100.000 of pay is in the first layer; with the 205.000 premium the gross is not.
        categories: {
          A: [{ upTo: 4_200_000, rate: 0.01 }, { upTo: null, rate: 0.1 }],
          B: [{ upTo: null, rate: 0.02 }],
          C: [{ upTo: null, rate: 0.03 }],
        },
      });
      if (!parsed.ok) throw new Error(parsed.message);
      return parsed.policy;
    })();

    async function runMonth(settings: Record<string, unknown> | null) {
      const settingsId = randomUUID();
      if (settings) {
        await pool.query(
          `INSERT INTO payroll_policy_versions(id, policy_key, effective_from, effective_to, payload, source)
           VALUES ($1, 'PPH21_SETTINGS', DATE '2037-11-01', DATE '2037-11-30', $2::jsonb, 'uji sintetis')`,
          [settingsId, JSON.stringify({ source: "uji sintetis", ...settings })],
        );
      }
      try {
        const { employmentId, employeeId } = await newEmployment({ category: "TETAP" });
        await pool.query(
          `UPDATE payroll_compensation_profiles
              SET ptkp_status = 'TK/0', bpjs_segment = 'PPU_YAYASAN', bpjs_active_from = DATE '2016-07-01'
            WHERE employment_id = $1`,
          [employmentId],
        );
        const monthPeriodId = randomUUID();
        ownedPeriodIds.push(monthPeriodId);
        await pool.query(
          `INSERT INTO payroll_periods(id, legal_entity_key, period_month, pay_date, period_start, period_end,
             cutoff_start, cutoff_end, state)
           VALUES ($1, $2, DATE '2037-11-01', DATE '2037-11-25', DATE '2037-11-01', DATE '2037-11-30',
                   DATE '2037-10-23', DATE '2037-11-22', 'COLLECTING')`,
          [monthPeriodId, legalEntityKey],
        );
        const reportPeriod = { periodMonth: `${MONTH}-01`, periodStart: `${MONTH}-01`, periodEnd: `${MONTH}-30` };
        const outcome = await calculatePeriod(
          pool,
          { id: monthPeriodId, legalEntityKey, periodStart: reportPeriod.periodStart, periodEnd: reportPeriod.periodEnd, payDate: `${MONTH}-25` },
          actorAccountId,
          0,
        );
        expect(outcome.policyProblems).toEqual([]);
        const result = await pool.query<{ gross: string; deductions: string; net: string; payable: string; employerCost: string }>(
          `SELECT gross::text, deductions::text, net::text, payable::text, employer_cost::text AS "employerCost"
           FROM payroll_results WHERE period_id = $1`,
          [monthPeriodId],
        );
        const lines = await pool.query<{ code: string; category: string; amount: string }>(
          `SELECT l.component_code AS code, l.category, l.amount::text AS amount
           FROM payroll_result_lines l JOIN payroll_results r ON r.id = l.result_id
           WHERE r.period_id = $1 ORDER BY l.display_order`,
          [monthPeriodId],
        );
        // The monthly report as the route builds it: the stored lines through the SQL loader,
        // and the settings in force on the pay date.
        const found = await findPph21Settings(pool, `${MONTH}-25`);
        if (!found.ok) throw new Error(found.message);
        const report = buildPph21Report({
          period: reportPeriod,
          policy: TER,
          rows: await loadPph21SourceRows(pool, monthPeriodId),
          settings: found.settings,
        });
        return {
          result: result.rows[0]!,
          lines: lines.rows,
          settingsVersionId: found.versionId,
          expectedSettingsId: settingsId,
          row: report.rows.find((entry) => entry.employeeId === employeeId)!,
        };
      } finally {
        await pool.query("DELETE FROM payroll_policy_versions WHERE id = $1", [settingsId]);
      }
    }

    // MKG 21 on the synthetic scale: gaji pokok 4.100.000, iuran 5% = 205.000 borne by the yayasan.
    const PAY_LINES = [
      { code: "BASIC", category: "EARNING", amount: "4100000" },
      { code: "BPJS_KES_ALLOW", category: "EARNING", amount: "205000" },
      { code: "BPJS_KES", category: "DEDUCTION", amount: "205000" },
    ];
    const PAY = { gross: "4305000", deductions: "205000", net: "4100000", payable: "4100000", employerCost: "0" };

    it("keeps the allowance out of the PPh21 gross while no settings version is in force: 4.100.000 x 1%", async () => {
      const { result, lines, row, settingsVersionId } = await runMonth(null);
      expect(settingsVersionId).toBeNull();
      expect(lines).toEqual(PAY_LINES);
      expect(result).toEqual(PAY);
      expect(row).toMatchObject({ gross: 4_100_000, rate: 0.01, tax: 41_000, employerHealthPremium: 0 });
    });

    it("stays out under a version that says nothing about the premium", async () => {
      const { row } = await runMonth({ nonPermanentDailyTer: false });
      expect(row).toMatchObject({ gross: 4_100_000, tax: 41_000, employerHealthPremium: 0 });
    });

    it("joins the PPh21 gross once a version makes it taxable: 4.305.000 x 10%, and the pay does not move", async () => {
      const { result, lines, row, settingsVersionId, expectedSettingsId } = await runMonth({
        employerHealthPremiumTaxable: true,
      });
      expect(settingsVersionId).toBe(expectedSettingsId);
      // The stored lines, gross, deductions, net and payable are exactly those without the setting.
      expect(lines).toEqual(PAY_LINES);
      expect(result).toEqual(PAY);
      expect(row).toMatchObject({ gross: 4_305_000, rate: 0.1, tax: 430_500, employerHealthPremium: 205_000 });
    });
  });

  // PAY-003-THR (docs/domain/payroll-thr.md). In this file rather than one of its own because the
  // monthly policy rows it needs are this suite's, and two files writing them would collide.
  describe("PAY-003-THR", () => {
    const HOLIDAY = "2026-09-30";
    const THR_PAY_DATE = "2026-09-20";
    let thrPeriodId: string;

    async function ensureThrPolicy() {
      await pool.query(
        `INSERT INTO payroll_policy_versions(id, policy_key, effective_from, payload, source)
         SELECT $1, 'THR', DATE '2026-01-01', $2::jsonb, 'uji sintetis'
         WHERE NOT EXISTS (SELECT 1 FROM payroll_policy_versions WHERE policy_key = 'THR')`,
        [
          randomUUID(),
          JSON.stringify({
            fullServiceMonths: 12,
            minimumServiceMonths: 1,
            paymentDeadlineDaysBeforeHoliday: 7,
            terminationGraceDays: 30,
            terminationGraceTermCategories: ["TETAP", "PERCOBAAN"],
            eligibleTermCategories: ["TETAP", "PERCOBAAN", "KONTRAK"],
          }),
        ],
      );
    }

    async function newThrPeriod(payDate = THR_PAY_DATE): Promise<string> {
      const id = randomUUID();
      ownedPeriodIds.push(id);
      await pool.query(
        `INSERT INTO payroll_periods(
           id, legal_entity_key, period_month, pay_date, period_start, period_end, cutoff_start, cutoff_end, state,
           period_kind, holiday_date, holiday_name)
         VALUES ($1, $2, DATE '2026-09-01', $3::date, DATE '2026-09-01', DATE '2026-09-30',
                 DATE '2026-09-01', DATE '2026-09-30', 'COLLECTING', 'THR', $4::date, 'Hari Raya Uji')`,
        [id, legalEntityKey, payDate, HOLIDAY],
      );
      return id;
    }

    const thrPeriod = (id: string, payDate = THR_PAY_DATE) => ({
      id,
      legalEntityKey,
      periodStart: "2026-09-01",
      periodEnd: "2026-09-30",
      payDate,
      kind: "THR" as const,
      holidayDate: HOLIDAY,
    });

    beforeEach(async () => {
      await ensureThrPolicy();
      thrPeriodId = await newThrPeriod();
    });

    it("sits beside the monthly period of the same month, one THR per month", async () => {
      await expect(newThrPeriod()).rejects.toMatchObject({ code: "23P01" });
      await expect(
        pool.query(
          `INSERT INTO payroll_periods(id, legal_entity_key, period_month, pay_date, period_start, period_end,
             cutoff_start, cutoff_end, period_kind, holiday_date, holiday_name)
           VALUES ($1, $2, DATE '2026-10-01', DATE '2026-10-20', DATE '2026-10-01', DATE '2026-10-31',
             DATE '2026-10-01', DATE '2026-10-31', 'THR', DATE '2026-10-15', 'Terlambat')`,
          [randomUUID(), legalEntityKey],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("pays the people active on the holiday, and PKWTT that ended within the grace days", async () => {
      const permanent = await newEmployment({ category: "TETAP" });
      const probationLeft = await newEmployment({
        category: "PERCOBAAN", startedOn: "2026-01-02", endedOn: "2026-09-10", endBasis: "RECORDED",
      });
      const contractLeft = await newEmployment({
        category: "KONTRAK", startedOn: "2026-01-02", endedOn: "2026-09-10", endBasis: "RECORDED",
      });
      const honorarium = await newEmployment({ category: "KONTRAK_HONORER" });
      const tooNew = await newEmployment({ category: "TETAP", startedOn: "2026-09-15" });

      const outcome = await calculatePeriod(pool, thrPeriod(thrPeriodId), actorAccountId, 0);
      expect(outcome.policyProblems).toEqual([]);
      expect(outcome.notEligibleCount).toBe(1);

      const { rows } = await pool.query<{ employmentId: string; payable: string; blockers: unknown[] }>(
        `SELECT employment_id AS "employmentId", payable::text, blockers FROM payroll_results WHERE period_id = $1`,
        [thrPeriodId],
      );
      const byEmployment = new Map(rows.map((row) => [row.employmentId, row]));
      expect([...byEmployment.keys()].sort()).toEqual([permanent.employmentId, probationLeft.employmentId].sort());
      // Ten years of service: one month of wages, the 3 000 000 basic salary of MKG 10.
      expect(byEmployment.get(permanent.employmentId)!.payable).toBe("3000000");
      // Eight whole months: (2 000 000 basic + 40 000 unrated monthly PERF) x 8 / 12.
      expect(byEmployment.get(probationLeft.employmentId)!.payable).toBe("1360000");
      expect(byEmployment.has(contractLeft.employmentId)).toBe(false);
      expect(byEmployment.has(honorarium.employmentId)).toBe(false);
      expect(byEmployment.has(tooNew.employmentId)).toBe(false);

      const lines = await pool.query<{ code: string }>(
        `SELECT DISTINCT l.component_code AS code FROM payroll_result_lines l
         JOIN payroll_results r ON r.id = l.result_id WHERE r.period_id = $1`,
        [thrPeriodId],
      );
      expect(lines.rows.map((row) => row.code)).toEqual(["THR"]);

      const audit = await pool.query<{ payload: Record<string, unknown> }>(
        "SELECT payload FROM payroll_audit_events WHERE period_id = $1 AND action = 'payroll.period.calculated'",
        [thrPeriodId],
      );
      expect(audit.rows[0]!.payload).toMatchObject({ period_kind: "THR", not_eligible_count: 1, employee_count: 2 });
    });

    it("bears the THR's PPh21 as the increment over the salary of the same month (T10, PPH21_SETTINGS on)", async () => {
      // A month of its own, with TER and the switch effective only in it, so no other suite's
      // PPH21_TER or PPH21_SETTINGS rows overlap.
      const month = "2035-05";
      const policyIds = [randomUUID(), randomUUID()];
      await pool.query(
        `INSERT INTO payroll_policy_versions(id, policy_key, effective_from, effective_to, payload, source)
         VALUES ($1, 'PPH21_TER', DATE '2035-05-01', DATE '2035-05-31', $3::jsonb, 'uji sintetis'),
                ($2, 'PPH21_SETTINGS', DATE '2035-05-01', DATE '2035-05-31', $4::jsonb, 'uji sintetis')`,
        [
          policyIds[0],
          policyIds[1],
          JSON.stringify({
            source: "Tabel uji sintetis",
            objectCode: "21-100-01",
            ptkpCategory: { "TK/0": "A" },
            categories: {
              A: [{ upTo: 5_000_000, rate: 0.01 }, { upTo: null, rate: 0.1 }],
              B: [{ upTo: null, rate: 0.02 }],
              C: [{ upTo: null, rate: 0.03 }],
            },
          }),
          JSON.stringify({ source: "uji", employerBorne: true }),
        ],
      );
      try {
        const { employmentId } = await newEmployment({ category: "TETAP" });
        await pool.query("UPDATE payroll_compensation_profiles SET ptkp_status = 'TK/0' WHERE employment_id = $1", [
          employmentId,
        ]);
        const salaryId = randomUUID();
        const thrId = randomUUID();
        ownedPeriodIds.push(salaryId, thrId);
        await pool.query(
          `INSERT INTO payroll_periods(id, legal_entity_key, period_month, pay_date, period_start, period_end,
             cutoff_start, cutoff_end, state, period_kind, holiday_date, holiday_name)
           VALUES ($1, $3, DATE '2035-05-01', DATE '2035-05-25', DATE '2035-05-01', DATE '2035-05-31',
                   DATE '2035-04-23', DATE '2035-05-22', 'COLLECTING', 'REGULAR', NULL, NULL),
                  ($2, $3, DATE '2035-05-01', DATE '2035-05-20', DATE '2035-05-01', DATE '2035-05-31',
                   DATE '2035-05-01', DATE '2035-05-31', 'COLLECTING', 'THR', DATE '2035-05-30', 'Hari Raya Uji')`,
          [salaryId, thrId, legalEntityKey],
        );
        const base = { legalEntityKey, periodStart: `${month}-01`, periodEnd: `${month}-31` };
        await calculatePeriod(pool, { ...base, id: salaryId, payDate: `${month}-25` }, actorAccountId, 0);
        await calculatePeriod(
          pool,
          { ...base, id: thrId, payDate: `${month}-20`, kind: "THR", holidayDate: `${month}-30` },
          actorAccountId,
          0,
        );
        const line = async (periodId: string) =>
          (await pool.query<{ amount: string }>(
            `SELECT l.amount::text AS amount FROM payroll_result_lines l
             JOIN payroll_results r ON r.id = l.result_id
             WHERE r.period_id = $1 AND l.component_code = 'PPH21_EMPLOYER'`,
            [periodId],
          )).rows[0]?.amount;
        // MKG 18: salary 3 800 000 alone is 1% (38 000). With the 3 800 000 THR the month is
        // 7 600 000 at 10% (760 000); the THR period bears the difference.
        expect(await line(salaryId)).toBe("38000");
        expect(await line(thrId)).toBe("722000");
      } finally {
        await pool.query("DELETE FROM payroll_policy_versions WHERE id = ANY($1::uuid[])", [policyIds]);
      }
    });

    it("refuses a pay date later than the policy allows before the holiday", async () => {
      await pool.query("UPDATE payroll_periods SET pay_date = DATE '2026-09-25' WHERE id = $1", [thrPeriodId]);
      const outcome = await calculatePeriod(pool, thrPeriod(thrPeriodId, "2026-09-25"), actorAccountId, 0);
      expect(outcome.thrPayDateLate).toEqual({ latestPayDate: "2026-09-23" });
      const { rows } = await pool.query("SELECT 1 FROM payroll_results WHERE period_id = $1", [thrPeriodId]);
      expect(rows).toHaveLength(0);
    });

    it("drafts a THR slip beside the salary slip of the same month, and taxes both in one masa pajak", async () => {
      const { employeeId } = await newEmployment({ category: "TETAP" });
      await calculatePeriod(pool, period(), actorAccountId, 0);
      await calculatePeriod(pool, thrPeriod(thrPeriodId), actorAccountId, 0);
      await pool.query("UPDATE payroll_periods SET state = 'PAYMENT_CONFIRMED' WHERE id = ANY($1::uuid[])", [
        [periodId, thrPeriodId],
      ]);

      expect(await draftPayslipsFromPeriod(pool, periodId, actorAccountId)).toMatchObject({ ok: true, drafted: 1 });
      expect(await draftPayslipsFromPeriod(pool, thrPeriodId, actorAccountId)).toMatchObject({ ok: true, drafted: 1 });
      const slips = await pool.query<{ kind: string; lines: Array<{ label: string; value: string }> }>(
        "SELECT kind, lines FROM payslips WHERE employee_id = $1 AND superseded_by_id IS NULL ORDER BY kind",
        [employeeId],
      );
      expect(slips.rows.map((row) => row.kind)).toEqual(["REGULAR", "THR"]);
      expect(slips.rows[1]!.lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: "Jenis", value: "THR Hari Raya Uji" }),
          expect.objectContaining({ label: "Tunjangan Hari Raya" }),
        ]),
      );

      const month = await loadPph21MonthSources(pool, periodId);
      expect(month.periods.map((entry) => entry.kind)).toEqual(["REGULAR", "THR"]);
      const mine = month.rows.filter((row) => row.employeeId === employeeId);
      expect(mine.map((row) => row.periodKind).sort()).toEqual(["REGULAR", "THR"]);
    });

    // T5, section 2.1 (owner decision 2026-11-17): honorarium and daily workers are paid THR on
    // the average of what the approved salary periods actually paid them. These tests pay a THR
    // in March 2027, so they read the policy version migration 0167 opened.
    describe("honorarium and daily workers (T5)", () => {
      const HOLIDAY_2027 = "2027-03-10";
      const THR_PAY_DATE_2027 = "2027-03-01";
      /** The twelve months before the THR month. */
      const WINDOW = [
        "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08",
        "2026-09", "2026-10", "2026-11", "2026-12", "2027-01", "2027-02",
      ];
      let thr2027Id: string;

      const monthEndOf = (month: string) => {
        const [year, monthNumber] = month.split("-").map(Number) as [number, number];
        return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
      };

      /**
       * One salary period of the month, really calculated from PKWT attendance days and teaching
       * hours (15 000 per day, 15 400 per hour on the synthetic rates), then put in `state`.
       */
      async function salaryMonth(
        month: string,
        pay: ReadonlyArray<{ employmentId: string; days: number; hours?: number }>,
        state = "APPROVED",
      ): Promise<string> {
        // The suite's own September 2026 period sits in the window; it is this month's period.
        let id = periodId;
        if (month !== "2026-09") {
          id = randomUUID();
          ownedPeriodIds.push(id);
          await pool.query(
            `INSERT INTO payroll_periods(
               id, legal_entity_key, period_month, pay_date, period_start, period_end, cutoff_start, cutoff_end, state)
             VALUES ($1, $2, $3::date, ($3::date + 24), $3::date, $4::date, $3::date, ($3::date + 21), 'COLLECTING')`,
            [id, legalEntityKey, `${month}-01`, monthEndOf(month)],
          );
        }
        for (const row of pay) {
          await pool.query(
            `INSERT INTO payroll_period_inputs(id, period_id, employment_id, input_key, value, origin)
             VALUES ($1, $3, $4, 'CONTRACT_ATTENDANCE_DAYS', $5, 'ATTENDANCE'),
                    ($2, $3, $4, 'CONTRACT_TEACHING_HOURS', $6, 'MANUAL')`,
            [randomUUID(), randomUUID(), id, row.employmentId, row.days, row.hours ?? 0],
          );
        }
        const outcome = await calculatePeriod(
          pool,
          { id, legalEntityKey, periodStart: `${month}-01`, periodEnd: monthEndOf(month), payDate: `${month}-25` },
          actorAccountId,
          0,
        );
        expect(outcome.policyProblems).toEqual([]);
        expect(outcome.blockerCount).toBe(0);
        await pool.query("UPDATE payroll_periods SET state = $2 WHERE id = $1", [id, state]);
        return id;
      }

      const thr2027 = () => ({
        id: thr2027Id,
        legalEntityKey,
        periodStart: "2027-03-01",
        periodEnd: "2027-03-31",
        payDate: THR_PAY_DATE_2027,
        kind: "THR" as const,
        holidayDate: HOLIDAY_2027,
      });

      async function calculateThr2027() {
        return calculatePeriod(pool, thr2027(), actorAccountId, (await getPeriod(pool, thr2027Id))!.version);
      }

      type ThrRow = {
        employmentId: string;
        payable: string;
        blockers: Array<{ code: string; message: string }>;
        averageWage: Record<string, unknown> | null;
        lineCodes: string[];
      };

      async function thrRows(): Promise<Map<string, ThrRow>> {
        const { rows } = await pool.query<ThrRow>(
          `SELECT DISTINCT ON (r.employment_id)
                  r.employment_id AS "employmentId", r.payable::text, r.blockers,
                  r.input_snapshot -> 'thr_average_wage' AS "averageWage",
                  coalesce((SELECT array_agg(l.component_code ORDER BY l.display_order)
                            FROM payroll_result_lines l WHERE l.result_id = r.id), ARRAY[]::text[]) AS "lineCodes"
           FROM payroll_results r WHERE r.period_id = $1
           ORDER BY r.employment_id, r.revision DESC`,
          [thr2027Id],
        );
        return new Map(rows.map((row) => [row.employmentId, row]));
      }

      async function typeAverageWage(employmentId: string, value: number) {
        await pool.query(
          `INSERT INTO payroll_period_inputs(
             id, period_id, employment_id, input_key, value, origin, reason, decision_reference, recorded_by_account_id)
           VALUES ($1, $2, $3, 'THR_AVERAGE_WAGE', $4, 'MANUAL', 'HCIS belum mencakup 12 bulan', 'Rekap honor uji', $5)`,
          [randomUUID(), thr2027Id, employmentId, value, actorAccountId],
        );
      }

      beforeEach(async () => {
        thr2027Id = randomUUID();
        ownedPeriodIds.push(thr2027Id);
        await pool.query(
          `INSERT INTO payroll_periods(
             id, legal_entity_key, period_month, pay_date, period_start, period_end, cutoff_start, cutoff_end, state,
             period_kind, holiday_date, holiday_name)
           VALUES ($1, $2, DATE '2027-03-01', $3::date, DATE '2027-03-01', DATE '2027-03-31',
                   DATE '2027-03-01', DATE '2027-03-31', 'COLLECTING', 'THR', $4::date, 'Idul Fitri Uji')`,
          [thr2027Id, legalEntityKey, THR_PAY_DATE_2027, HOLIDAY_2027],
        );
      });

      it("pays the average of the approved months: twelve of them, or the months in service", async () => {
        const permanent = await newEmployment({ category: "TETAP" });
        const honorarium = await newEmployment({ category: "KONTRAK_HONORER" });
        // TMT 20 December 2026: two whole months at the holiday; December to February are averaged.
        const daily = await newEmployment({ category: "LEPAS", startedOn: "2026-12-20" });
        // Ended before the holiday: the grace days are for PKWTT only (H7).
        const dailyLeft = await newEmployment({
          category: "LEPAS", startedOn: "2026-01-05", endedOn: "2027-03-05", endBasis: "RECORDED",
        });

        const dailyDays: Record<string, number> = { "2026-12": 8, "2027-01": 22, "2027-02": 20 };
        for (const month of WINDOW) {
          await salaryMonth(month, [
            // 20 days and 50 hours pay 1 070 000; July pays 10 days only, 150 000.
            month === "2026-07"
              ? { employmentId: honorarium.employmentId, days: 10 }
              : { employmentId: honorarium.employmentId, days: 20, hours: 50 },
            ...(dailyDays[month] ? [{ employmentId: daily.employmentId, days: dailyDays[month]! }] : []),
          ]);
        }

        const outcome = await calculateThr2027();
        expect(outcome.policyProblems).toEqual([]);
        expect(outcome.blockerCount).toBe(0);
        expect(outcome.employeeCount).toBe(3);

        const rows = await thrRows();
        expect([...rows.keys()].sort()).toEqual(
          [permanent.employmentId, honorarium.employmentId, daily.employmentId].sort(),
        );
        expect(rows.has(dailyLeft.employmentId)).toBe(false);
        // Permanent staff are untouched by the decision: the 3 000 000 basic salary of MKG 10.
        expect(rows.get(permanent.employmentId)).toMatchObject({ payable: "3000000", averageWage: null });
        // (11 x 1 070 000 + 150 000) / 12 = 993 333.33, rounded up.
        expect(rows.get(honorarium.employmentId)).toMatchObject({ payable: "993334", lineCodes: ["THR"] });
        expect(rows.get(honorarium.employmentId)!.averageWage).toMatchObject({
          source: "SYSTEM",
          windowStart: "2026-03",
          windowEnd: "2027-02",
          requiredMonths: 12,
          coveredMonths: 12,
          monthsWithPay: 12,
          systemTotal: 11_920_000,
          systemAverage: 993_334,
          monthlyWage: 993_334,
          hcInput: null,
        });
        expect((rows.get(honorarium.employmentId)!.averageWage!.periods as unknown[]).length).toBe(12);
        // (120 000 + 330 000 + 300 000) / 3 = 250 000; x 2 / 12 = 41 666.67, rounded up.
        expect(rows.get(daily.employmentId)).toMatchObject({ payable: "41667" });
        expect(rows.get(daily.employmentId)!.averageWage).toMatchObject({
          source: "SYSTEM", windowStart: "2026-12", requiredMonths: 3, coveredMonths: 3, systemAverage: 250_000,
        });

        // Aggregates only on the audit trail.
        const audit = await pool.query<{ payload: Record<string, unknown> }>(
          "SELECT payload FROM payroll_audit_events WHERE period_id = $1 AND action = 'payroll.period.calculated'",
          [thr2027Id],
        );
        expect(audit.rows[0]!.payload).toMatchObject({
          period_kind: "THR",
          thr_average_wage_count: 2,
          thr_average_wage_hc_input_count: 0,
          thr_average_wage_incomplete_count: 0,
        });

        // The results route reads the trace beside each row; a salaried row carries none.
        const listed = await listResults(pool, thr2027Id);
        const listedByEmployment = new Map(listed.results.map((row) => [row.employmentId, row]));
        expect(listedByEmployment.get(honorarium.employmentId)!.thrAverageWage).toMatchObject({ source: "SYSTEM" });
        expect(listedByEmployment.get(permanent.employmentId)!.thrAverageWage).toBeNull();

        // Slip, transfer list and the PPh21 sources work for them as for everyone else.
        await pool.query("UPDATE payroll_periods SET state = 'PAYMENT_CONFIRMED' WHERE id = $1", [thr2027Id]);
        expect(await draftPayslipsFromPeriod(pool, thr2027Id, actorAccountId)).toMatchObject({ ok: true, drafted: 3 });
        const slip = await pool.query<{ kind: string; lines: Array<{ label: string; value: string }> }>(
          "SELECT kind, lines FROM payslips WHERE employee_id = $1 AND source_period_id = $2",
          [honorarium.employeeId, thr2027Id],
        );
        expect(slip.rows[0]!.kind).toBe("THR");
        expect(slip.rows[0]!.lines).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ label: "Jenis", value: "THR Idul Fitri Uji" }),
            expect.objectContaining({ label: "Masa kerja", value: "128 bulan" }),
            expect.objectContaining({ label: "Tunjangan Hari Raya" }),
          ]),
        );
        const transfers = await buildTransferList(pool, thr2027Id);
        expect(transfers.map((row) => row.payable).sort()).toEqual(["3000000", "41667", "993334"]);
        const sources = await loadPph21MonthSources(pool, thr2027Id);
        expect(sources.rows.find((row) => row.employmentId === honorarium.employmentId)).toMatchObject({
          periodKind: "THR",
          termCategory: "KONTRAK_HONORER",
          blockerCount: 0,
          earnings: [{ code: "THR", amount: 993_334 }],
        });
      }, 60_000);

      it("blocks a partly covered window instead of guessing, then takes the figure human capital typed", async () => {
        const permanent = await newEmployment({ category: "TETAP" });
        const honorarium = await newEmployment({ category: "KONTRAK_HONORER" });
        const pay = [{ employmentId: honorarium.employmentId, days: 20, hours: 50 }];
        for (const month of ["2026-12", "2027-01", "2027-02"]) await salaryMonth(month, pay);
        // Calculated but never approved: its figures are not facts, so the month is not covered.
        await salaryMonth("2026-11", [{ employmentId: honorarium.employmentId, days: 25, hours: 99 }], "CALCULATED");

        const blocked = await calculateThr2027();
        expect(blocked.blockerCount).toBe(1);
        let rows = await thrRows();
        expect(rows.get(honorarium.employmentId)).toMatchObject({ payable: "0", lineCodes: [] });
        expect(rows.get(honorarium.employmentId)!.blockers).toEqual([
          {
            code: "THR_AVERAGE_WAGE_INCOMPLETE",
            message:
              "Rata-rata upah belum lengkap: sistem mencakup 3 dari 12 bulan yang diminta; isi input rata-rata upah THR pegawai ini.",
          },
        ]);
        // The partial figure is stored as a reference for the screen, not used.
        expect(rows.get(honorarium.employmentId)!.averageWage).toMatchObject({
          source: "NONE",
          requiredMonths: 12,
          coveredMonths: 3,
          systemTotal: 3_210_000,
          systemAverage: null,
          partialAverage: 1_070_000,
          monthlyWage: 0,
        });
        expect(rows.get(permanent.employmentId)).toMatchObject({ payable: "3000000" });

        await typeAverageWage(honorarium.employmentId, 1_000_000);
        const typed = await calculateThr2027();
        expect(typed.blockerCount).toBe(0);
        rows = await thrRows();
        expect(rows.get(honorarium.employmentId)).toMatchObject({ payable: "1000000", blockers: [], lineCodes: ["THR"] });
        expect(rows.get(honorarium.employmentId)!.averageWage).toMatchObject({
          source: "HC_INPUT", hcInput: 1_000_000, coveredMonths: 3, partialAverage: 1_070_000, monthlyWage: 1_000_000,
        });
        const audit = await pool.query<{ payload: Record<string, unknown> }>(
          `SELECT payload FROM payroll_audit_events
           WHERE period_id = $1 AND action = 'payroll.period.calculated' ORDER BY occurred_at DESC LIMIT 1`,
          [thr2027Id],
        );
        expect(audit.rows[0]!.payload).toMatchObject({
          thr_average_wage_count: 1, thr_average_wage_hc_input_count: 1, thr_average_wage_incomplete_count: 0,
        });

        // Typed for someone paid a salary: refused, not left unused on the period.
        await typeAverageWage(permanent.employmentId, 2_000_000);
        await calculateThr2027();
        rows = await thrRows();
        expect(rows.get(permanent.employmentId)!.blockers.map((blocker) => blocker.code)).toEqual(["INPUT_INVALID"]);
      }, 60_000);

      it("refuses to approve a THR whose average rests on a salary period reopened since", async () => {
        const honorarium = await newEmployment({ category: "KONTRAK_HONORER", startedOn: "2026-12-01" });
        const sourceIds: string[] = [];
        for (const month of ["2026-12", "2027-01", "2027-02"]) {
          sourceIds.push(await salaryMonth(month, [{ employmentId: honorarium.employmentId, days: 20 }]));
        }
        expect((await calculateThr2027()).blockerCount).toBe(0);
        // Three whole months of service on an average of 300 000: 300 000 x 3 / 12.
        expect((await thrRows()).get(honorarium.employmentId)).toMatchObject({ payable: "75000" });

        const approve = async () => {
          const current = (await getPeriod(pool, thr2027Id))!;
          return applyTransition(pool, {
            periodId: thr2027Id,
            action: "approve",
            nextState: "APPROVED",
            auditAction: "payroll.period.approved",
            actorAccountId,
            reason: null,
            expectedVersion: current.version,
            blockerCount: 0,
            fromState: current.state,
          });
        };

        await pool.query("UPDATE payroll_periods SET state = 'SUBMITTED' WHERE id = $1", [thr2027Id]);
        // January is reopened and approved again: its figures may no longer be the ones read.
        await pool.query(
          "UPDATE payroll_periods SET reopen_count = reopen_count + 1 WHERE id = $1",
          [sourceIds[1]],
        );
        const refused = await approve();
        expect(refused.applied).toBe(false);
        expect(refused.refusal?.code).toBe("PAYROLL_THR_AVERAGE_WAGE_STALE");
        expect((await getPeriod(pool, thr2027Id))!.state).toBe("SUBMITTED");

        // Recalculated against the periods as they stand now, the same THR is approved.
        await pool.query("UPDATE payroll_periods SET state = 'CALCULATED' WHERE id = $1", [thr2027Id]);
        expect((await calculateThr2027()).blockerCount).toBe(0);
        await pool.query("UPDATE payroll_periods SET state = 'SUBMITTED' WHERE id = $1", [thr2027Id]);
        expect((await approve()).applied).toBe(true);
        expect((await getPeriod(pool, thr2027Id))!.state).toBe("APPROVED");
      }, 60_000);
    });
  });
});
