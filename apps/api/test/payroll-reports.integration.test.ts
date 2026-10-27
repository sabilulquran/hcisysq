// PAY-003 reporting against real PostgreSQL: the report, the transfer list and
// the period comparison, run as SQL rather than matched as strings.
// Runs only against the loopback CI database.

import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  buildPeriodReport,
  buildTransferList,
  buildVariance,
  previousPeriodId,
} from "../src/modules/payroll/reports.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

const THRESHOLD = { relative: 0.1, absolute: 50_000, manualInput: 1_000_000 };

describe.skipIf(!allowed)("PAY-003 reporting against PostgreSQL", () => {
  let pool: Pool;
  let legalEntityKey: string;
  // unit_ref is a uuid reference into the organization model, not a label.
  let unitPusat: string;
  let unitLama: string;
  let unitBaru: string;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl!, max: 2 });
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(() => {
    // Other suites leave payroll rows behind, so each test owns a legal entity
    // and reads only its own periods.
    legalEntityKey = randomUUID();
    unitPusat = randomUUID();
    unitLama = randomUUID();
    unitBaru = randomUUID();
  });

  async function newEmployee(unitRef: string | null, options: { bank?: boolean } = {}) {
    const employeeId = randomUUID();
    const employmentId = randomUUID();
    const actionId = randomUUID();
    const employeeNumber = `EMP-RPT-${employeeId.slice(0, 8)}`;

    const client = await pool.connect();
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO employees(id, employee_number, full_name, status) VALUES ($1, $2, 'Pegawai Laporan', 'active')",
      [employeeId, employeeNumber],
    );
    await client.query(
      `INSERT INTO employments(id, employee_id, legal_entity_key, started_on, start_basis, source, opened_by_action_id)
       VALUES ($1, $2, $3, DATE '2016-07-01', 'RECORDED', 'ACTION', $4)`,
      [employmentId, employeeId, legalEntityKey, actionId],
    );
    await client.query(
      `INSERT INTO employment_actions(id, employee_id, employment_id, action_type, effective_on)
       VALUES ($1, $2, $3, 'BASELINE', DATE '2016-07-01')`,
      [actionId, employeeId, employmentId],
    );
    await client.query("COMMIT");
    client.release();

    const profileId = randomUUID();
    await pool.query(
      `INSERT INTO payroll_compensation_profiles(
         id, employment_id, effective_from, education, unit_ref,
         bank_name, bank_account_number, bank_account_name)
       VALUES ($1, $2, DATE '2016-07-01', 'S1', $3, $4, $5, $6)`,
      [
        profileId,
        employmentId,
        unitRef,
        options.bank === false ? null : "BSI",
        options.bank === false ? null : "0012345678",
        options.bank === false ? null : "Pegawai Laporan",
      ],
    );

    return { employeeId, employmentId, profileId, employeeNumber };
  }

  async function newPeriod(month: string, state: string) {
    const periodId = randomUUID();
    await pool.query(
      `INSERT INTO payroll_periods(
         id, legal_entity_key, period_month, pay_date, period_start, period_end, cutoff_start, cutoff_end, state)
       VALUES ($1, $2, $3::date, ($3::date + 24), $3::date, (($3::date + interval '1 month')::date - 1),
               ($3::date - 9), ($3::date + 21), $4)`,
      [periodId, legalEntityKey, month, state],
    );
    return periodId;
  }

  async function writeResult(
    periodId: string,
    employmentId: string,
    options: {
      profileId?: string | null;
      payable: number;
      lines: Array<{ code: string; category: string; amount: number }>;
      calculatedAt?: string;
    },
  ) {
    const resultId = randomUUID();
    const gross = options.lines
      .filter((line) => line.category === "EARNING")
      .reduce((total, line) => total + line.amount, 0);
    const deductions = options.lines
      .filter((line) => line.category === "DEDUCTION")
      .reduce((total, line) => total + line.amount, 0);
    await pool.query(
      `INSERT INTO payroll_results(
         id, period_id, employment_id, gross, deductions, net, payable,
         input_snapshot, policy_version_ids, compensation_profile_id, calculated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, '["v1"]'::jsonb, $8,
               coalesce($9::timestamptz, now()))`,
      [
        resultId,
        periodId,
        employmentId,
        gross,
        deductions,
        gross - deductions,
        options.payable,
        options.profileId === undefined ? null : options.profileId,
        options.calculatedAt ?? null,
      ],
    );
    for (const [index, line] of options.lines.entries()) {
      await pool.query(
        `INSERT INTO payroll_result_lines(id, result_id, component_code, category, amount, display_order)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), resultId, line.code, line.category, line.amount, (index + 1) * 10],
      );
    }
    return resultId;
  }

  describe("the payroll report", () => {
    it("totals the period and groups it by unit and by component", async () => {
      const periodId = await newPeriod("2026-09-01", "APPROVED");
      const a = await newEmployee(unitPusat);
      const b = await newEmployee(unitPusat);
      await writeResult(periodId, a.employmentId, {
        profileId: a.profileId,
        payable: 3_000_000,
        lines: [
          { code: "BASIC", category: "EARNING", amount: 3_200_000 },
          { code: "LOAN", category: "DEDUCTION", amount: 200_000 },
        ],
      });
      await writeResult(periodId, b.employmentId, {
        profileId: b.profileId,
        payable: 2_500_000,
        lines: [{ code: "BASIC", category: "EARNING", amount: 2_500_000 }],
      });

      const report = await buildPeriodReport(pool, periodId);
      expect(report.totals.employeeCount).toBe(2);
      expect(report.totals.gross).toBe("5700000");
      expect(report.totals.deductions).toBe("200000");
      expect(report.totals.payable).toBe("5500000");
      expect(report.byUnit).toEqual([{ unitRef: unitPusat, employeeCount: 2, payable: "5500000" }]);
      expect(report.byComponent).toEqual([
        { componentCode: "BASIC", category: "EARNING", employeeCount: 2, amount: "5700000" },
        { componentCode: "LOAN", category: "DEDUCTION", employeeCount: 1, amount: "200000" },
      ]);
    });

    it("groups by the unit the result was calculated with, not today's unit", async () => {
      const periodId = await newPeriod("2026-09-01", "APPROVED");
      const employee = await newEmployee(unitLama);
      await writeResult(periodId, employee.employmentId, {
        profileId: employee.profileId,
        payable: 1_000_000,
        lines: [{ code: "BASIC", category: "EARNING", amount: 1_000_000 }],
      });
      // The employee moves unit afterwards.
      await pool.query(
        `UPDATE payroll_compensation_profiles SET effective_to = DATE '2026-09-30' WHERE id = $1`,
        [employee.profileId],
      );
      await pool.query(
        `INSERT INTO payroll_compensation_profiles(id, employment_id, effective_from, education, unit_ref)
         VALUES ($1, $2, DATE '2026-10-01', 'S1', $3)`,
        [randomUUID(), employee.employmentId, unitBaru],
      );

      const report = await buildPeriodReport(pool, periodId);
      expect(report.byUnit).toEqual([{ unitRef: unitLama, employeeCount: 1, payable: "1000000" }]);
    });

    it("falls back to the profile effective on the pay date for a result written before 0080", async () => {
      const periodId = await newPeriod("2026-09-01", "APPROVED");
      const employee = await newEmployee(unitPusat);
      await writeResult(periodId, employee.employmentId, {
        profileId: null,
        payable: 1_000_000,
        lines: [{ code: "BASIC", category: "EARNING", amount: 1_000_000 }],
      });

      const report = await buildPeriodReport(pool, periodId);
      expect(report.byUnit).toEqual([{ unitRef: unitPusat, employeeCount: 1, payable: "1000000" }]);
    });

    it("counts only the last run when a period has been recalculated", async () => {
      const periodId = await newPeriod("2026-09-01", "APPROVED");
      const employee = await newEmployee(unitPusat);
      await writeResult(periodId, employee.employmentId, {
        profileId: employee.profileId,
        payable: 1_000_000,
        lines: [{ code: "BASIC", category: "EARNING", amount: 1_000_000 }],
        calculatedAt: "2026-09-20T00:00:00.000Z",
      });
      const second = await newEmployee(unitPusat);
      await writeResult(periodId, second.employmentId, {
        profileId: second.profileId,
        payable: 2_000_000,
        lines: [{ code: "BASIC", category: "EARNING", amount: 2_000_000 }],
        calculatedAt: "2026-09-21T00:00:00.000Z",
      });

      const report = await buildPeriodReport(pool, periodId);
      expect(report.totals.employeeCount).toBe(1);
      expect(report.totals.payable).toBe("2000000");
    });
  });

  describe("the transfer list", () => {
    it("carries the bank, the account and the holder from the result's profile", async () => {
      const periodId = await newPeriod("2026-09-01", "APPROVED");
      const employee = await newEmployee(unitPusat);
      await writeResult(periodId, employee.employmentId, {
        profileId: employee.profileId,
        payable: 3_000_000,
        lines: [{ code: "BASIC", category: "EARNING", amount: 3_000_000 }],
      });

      const transfers = await buildTransferList(pool, periodId);
      expect(transfers).toHaveLength(1);
      expect(transfers[0]).toMatchObject({
        employeeNumber: employee.employeeNumber,
        bankName: "BSI",
        bankAccountNumber: "0012345678",
        bankAccountName: "Pegawai Laporan",
        payable: "3000000",
      });
    });

    it("leaves out a recipient with nothing to pay", async () => {
      const periodId = await newPeriod("2026-09-01", "APPROVED");
      const employee = await newEmployee(unitPusat);
      await writeResult(periodId, employee.employmentId, {
        profileId: employee.profileId,
        payable: 0,
        lines: [],
      });
      expect(await buildTransferList(pool, periodId)).toEqual([]);
    });

    it("keeps a recipient whose payable went negative, so finance sees it", async () => {
      const periodId = await newPeriod("2026-09-01", "APPROVED");
      const employee = await newEmployee(unitPusat);
      await writeResult(periodId, employee.employmentId, {
        profileId: employee.profileId,
        payable: -250_000,
        lines: [{ code: "ADJUST_DEDUCT", category: "DEDUCTION", amount: 250_000 }],
      });
      const transfers = await buildTransferList(pool, periodId);
      expect(transfers).toHaveLength(1);
      expect(transfers[0]!.payable).toBe("-250000");
    });

    it("writes the payment confirmation as an ISO timestamp, not a local date string", async () => {
      const periodId = await newPeriod("2026-09-01", "PAYMENT_CONFIRMED");
      await pool.query("UPDATE payroll_periods SET payment_confirmed_at = now() WHERE id = $1", [periodId]);
      const employee = await newEmployee(unitPusat);
      await writeResult(periodId, employee.employmentId, {
        profileId: employee.profileId,
        payable: 1_000_000,
        lines: [{ code: "BASIC", category: "EARNING", amount: 1_000_000 }],
      });
      const transfers = await buildTransferList(pool, periodId);
      expect(transfers[0]!.paymentConfirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });
  });

  describe("the period comparison", () => {
    async function twoPeriods() {
      const previous = await newPeriod("2026-08-01", "APPROVED");
      const current = await newPeriod("2026-09-01", "CALCULATED");
      return { previous, current };
    }

    it("finds the previous settled period of the same legal entity", async () => {
      const { previous, current } = await twoPeriods();
      expect(await previousPeriodId(pool, current)).toBe(previous);
    });

    it("ignores an earlier period whose figures are not settled", async () => {
      await newPeriod("2026-08-01", "COLLECTING");
      const current = await newPeriod("2026-09-01", "CALCULATED");
      expect(await previousPeriodId(pool, current)).toBeNull();
    });

    it("reports a component that moved past both thresholds", async () => {
      const { previous, current } = await twoPeriods();
      const employee = await newEmployee(unitPusat);
      await writeResult(previous, employee.employmentId, {
        profileId: employee.profileId,
        payable: 100_000,
        lines: [{ code: "PERF", category: "EARNING", amount: 100_000 }],
      });
      await writeResult(current, employee.employmentId, {
        profileId: employee.profileId,
        payable: 400_000,
        lines: [{ code: "PERF", category: "EARNING", amount: 400_000 }],
      });

      const variances = await buildVariance(pool, current, previous, THRESHOLD);
      expect(variances).toEqual([
        expect.objectContaining({ componentCode: "PERF", delta: "300000", kind: "COMPONENT" }),
      ]);
    });

    it("stays quiet about a component that moved only a little", async () => {
      const { previous, current } = await twoPeriods();
      const employee = await newEmployee(unitPusat);
      await writeResult(previous, employee.employmentId, {
        profileId: employee.profileId,
        payable: 3_000_000,
        lines: [{ code: "BASIC", category: "EARNING", amount: 3_000_000 }],
      });
      await writeResult(current, employee.employmentId, {
        profileId: employee.profileId,
        payable: 3_040_000,
        lines: [{ code: "BASIC", category: "EARNING", amount: 3_040_000 }],
      });
      expect(await buildVariance(pool, current, previous, THRESHOLD)).toEqual([]);
    });

    it("reports a component that appeared from nothing, without dividing by zero", async () => {
      const { previous, current } = await twoPeriods();
      const employee = await newEmployee(unitPusat);
      await writeResult(previous, employee.employmentId, {
        profileId: employee.profileId,
        payable: 3_000_000,
        lines: [{ code: "BASIC", category: "EARNING", amount: 3_000_000 }],
      });
      await writeResult(current, employee.employmentId, {
        profileId: employee.profileId,
        payable: 3_250_000,
        lines: [
          { code: "BASIC", category: "EARNING", amount: 3_000_000 },
          { code: "ARREARS", category: "EARNING", amount: 250_000 },
        ],
      });

      const variances = await buildVariance(pool, current, previous, THRESHOLD);
      expect(variances).toEqual([
        expect.objectContaining({ componentCode: "ARREARS", previousAmount: "0", delta: "250000" }),
      ]);
    });

    it("reports a new employee once, with the whole amount", async () => {
      const { previous, current } = await twoPeriods();
      const existing = await newEmployee(unitPusat);
      await writeResult(previous, existing.employmentId, {
        profileId: existing.profileId,
        payable: 3_000_000,
        lines: [{ code: "BASIC", category: "EARNING", amount: 3_000_000 }],
      });
      await writeResult(current, existing.employmentId, {
        profileId: existing.profileId,
        payable: 3_000_000,
        lines: [{ code: "BASIC", category: "EARNING", amount: 3_000_000 }],
      });

      const joiner = await newEmployee(unitPusat);
      await writeResult(current, joiner.employmentId, {
        profileId: joiner.profileId,
        payable: 4_500_000,
        lines: [
          { code: "BASIC", category: "EARNING", amount: 4_000_000 },
          { code: "PERF", category: "EARNING", amount: 500_000 },
        ],
      });

      const variances = await buildVariance(pool, current, previous, THRESHOLD);
      expect(variances).toEqual([
        {
          employmentId: joiner.employmentId,
          componentCode: null,
          previousAmount: "0",
          currentAmount: "4500000",
          delta: "4500000",
          kind: "NEW_EMPLOYEE",
        },
      ]);
    });

    it("reports a departing employee once, whatever the thresholds say", async () => {
      const { previous, current } = await twoPeriods();
      const leaver = await newEmployee(unitPusat);
      await writeResult(previous, leaver.employmentId, {
        profileId: leaver.profileId,
        payable: 20_000,
        lines: [{ code: "BASIC", category: "EARNING", amount: 20_000 }],
      });

      const variances = await buildVariance(pool, current, previous, THRESHOLD);
      expect(variances).toEqual([
        expect.objectContaining({
          employmentId: leaver.employmentId,
          componentCode: null,
          kind: "LEAVING_EMPLOYEE",
          delta: "-20000",
        }),
      ]);
    });

    it("reports a large manual input, which is a trigger of its own", async () => {
      const { previous, current } = await twoPeriods();
      const employee = await newEmployee(unitPusat);
      await pool.query(
        `INSERT INTO payroll_period_inputs(
           id, period_id, employment_id, input_key, value, origin, reason, decision_reference)
         VALUES ($1, $2, $3, 'ADJUSTMENT', -2500000, 'MANUAL', 'koreksi', 'SK-UJI-002')`,
        [randomUUID(), current, employee.employmentId],
      );

      const variances = await buildVariance(pool, current, previous, THRESHOLD);
      expect(variances).toEqual([
        expect.objectContaining({ componentCode: "ADJUSTMENT", kind: "LARGE_MANUAL_INPUT" }),
      ]);
    });

    it("leaves a manual input below the threshold alone", async () => {
      const { previous, current } = await twoPeriods();
      const employee = await newEmployee(unitPusat);
      await pool.query(
        `INSERT INTO payroll_period_inputs(id, period_id, employment_id, input_key, value, origin, reason)
         VALUES ($1, $2, $3, 'ARREARS', 250000, 'MANUAL', 'rapel kecil')`,
        [randomUUID(), current, employee.employmentId],
      );
      expect(await buildVariance(pool, current, previous, THRESHOLD)).toEqual([]);
    });
  });
});
