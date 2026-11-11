// PAY-003 PPh21 TER report against real PostgreSQL: the rows the report is built
// from, the per-person exclusion of migration 0142, and its write path.
// Runs only against the loopback CI database. Synthetic data only. It writes no
// PPH21_TER policy row: another suite owns that key, and the policy lookup is
// covered by the route test.

import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { openCompensationProfile } from "../src/modules/payroll/admin-store.js";
import { loadPph21SourceRows } from "../src/modules/payroll/reports.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

describe.skipIf(!allowed)("PAY-003 PPh21 report against PostgreSQL", () => {
  let pool: Pool;
  let legalEntityKey: string;
  let actorAccountId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl!, max: 2 });
    const actorEmployeeId = randomUUID();
    actorAccountId = randomUUID();
    await pool.query(
      "INSERT INTO employees(id, employee_number, full_name, status) VALUES ($1, $2, 'Synthetic PPh21 Actor', 'active')",
      [actorEmployeeId, `EMP-PPH-ACTOR-${actorEmployeeId.slice(0, 8)}`],
    );
    await pool.query(
      `INSERT INTO accounts(id, employee_id, email, principal_type, status)
       VALUES ($1, $2, $3, 'EMPLOYEE', 'active')`,
      [actorAccountId, actorEmployeeId, `pph21-${actorAccountId}@example.invalid`],
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(() => {
    legalEntityKey = randomUUID();
  });

  async function newEmployee(options: { endedOn?: string | null; ptkpStatus?: string | null } = {}) {
    const employeeId = randomUUID();
    const employmentId = randomUUID();
    const actionId = randomUUID();
    const employeeNumber = `EMP-PPH-${employeeId.slice(0, 8)}`;
    const endedOn = options.endedOn ?? null;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO employees(id, employee_number, full_name, status) VALUES ($1, $2, 'Pegawai PPh21', 'active')",
        [employeeId, employeeNumber],
      );
      await client.query(
        `INSERT INTO employments(
           id, employee_id, legal_entity_key, started_on, start_basis, ended_on, end_basis,
           end_precision, end_reason, source, opened_by_action_id)
         VALUES ($1, $2, $3, DATE '2016-07-01', 'RECORDED', $4::date, $5, $6, $7, 'ACTION', $8)`,
        [
          employmentId,
          employeeId,
          legalEntityKey,
          endedOn,
          endedOn === null ? null : "RECORDED",
          endedOn === null ? null : "DAY",
          endedOn === null ? null : "RESIGN",
          actionId,
        ],
      );
      await client.query(
        `INSERT INTO employment_actions(id, employee_id, employment_id, action_type, effective_on)
         VALUES ($1, $2, $3, 'BASELINE', DATE '2016-07-01')`,
        [actionId, employeeId, employmentId],
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    const profileId = randomUUID();
    await pool.query(
      `INSERT INTO payroll_compensation_profiles(id, employment_id, effective_from, education, ptkp_status)
       VALUES ($1, $2, DATE '2016-07-01', 'S1', $3)`,
      [profileId, employmentId, options.ptkpStatus === undefined ? "TK/0" : options.ptkpStatus],
    );
    return { employmentId, profileId, employeeNumber };
  }

  async function newPeriod(month: string) {
    const periodId = randomUUID();
    await pool.query(
      `INSERT INTO payroll_periods(
         id, legal_entity_key, period_month, pay_date, period_start, period_end, cutoff_start, cutoff_end, state)
       VALUES ($1, $2, $3::date, ($3::date + 24), $3::date, (($3::date + interval '1 month')::date - 1),
               ($3::date - 9), ($3::date + 21), 'APPROVED')`,
      [periodId, legalEntityKey, month],
    );
    return periodId;
  }

  async function writeResult(
    periodId: string,
    employmentId: string,
    options: {
      profileId: string | null;
      payFactor?: number;
      blockers?: Array<{ code: string; message: string }>;
      lines: Array<{ code: string; category: string; amount: number }>;
      calculatedAt?: string;
      previousResultId?: string;
    },
  ): Promise<string> {
    const resultId = randomUUID();
    const gross = options.lines.filter((l) => l.category === "EARNING").reduce((t, l) => t + l.amount, 0);
    const deductions = options.lines.filter((l) => l.category === "DEDUCTION").reduce((t, l) => t + l.amount, 0);
    const payFactor = options.payFactor ?? 1;
    await pool.query(
      `INSERT INTO payroll_results(
         id, period_id, employment_id, revision, previous_result_id, gross, deductions, net, payable, pay_factor,
         pay_factor_reason, blockers, input_snapshot, policy_version_ids, compensation_profile_id, calculated_at)
       VALUES ($1, $2, $3, $4, $14, $5, $6, $7, $8, $9, $10, $11::jsonb, '{}'::jsonb, '["v1"]'::jsonb, $12,
               $13::timestamptz)`,
      [
        resultId,
        periodId,
        employmentId,
        options.previousResultId ? 2 : 1,
        gross,
        deductions,
        gross - deductions,
        Math.ceil((gross - deductions) * payFactor),
        payFactor,
        payFactor === 1 ? "none" : "proration",
        JSON.stringify(options.blockers ?? []),
        options.profileId,
        options.calculatedAt ?? "2026-09-20T00:00:00.000Z",
        options.previousResultId ?? null,
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

  describe("report rows", () => {
    it("reads earnings, factor, blockers and the PTKP status of the calculated profile", async () => {
      const periodId = await newPeriod("2026-09-01");
      const employee = await newEmployee({ ptkpStatus: "K/1" });
      await writeResult(periodId, employee.employmentId, {
        profileId: employee.profileId,
        payFactor: 0.5,
        blockers: [{ code: "LOAN_EXCEEDS_BALANCE", message: "uji" }],
        lines: [
          { code: "BASIC", category: "EARNING", amount: 3_000_000 },
          { code: "BPJS_KES_ALLOW", category: "EARNING", amount: 150_000 },
          { code: "BPJS_KES", category: "DEDUCTION", amount: 150_000 },
        ],
      });

      const rows = await loadPph21SourceRows(pool, periodId);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row).toMatchObject({
        employmentId: employee.employmentId,
        employeeNumber: employee.employeeNumber,
        fullName: "Pegawai PPh21",
        ptkpStatus: "K/1",
        excluded: false,
        exclusionReason: null,
        payFactor: 0.5,
        blockerCount: 1,
        serviceEndDate: null,
      });
      // Earnings only, as numbers; the report itself leaves out BPJS_KES_ALLOW.
      expect(row.earnings.sort((a, b) => a.code.localeCompare(b.code))).toEqual([
        { code: "BASIC", amount: 3_000_000 },
        { code: "BPJS_KES_ALLOW", amount: 150_000 },
      ]);
    });

    it("reads the exclusion of the profile the result was calculated from, not a later one", async () => {
      const periodId = await newPeriod("2026-09-01");
      const employee = await newEmployee();
      await pool.query(
        `UPDATE payroll_compensation_profiles
         SET pph21_report_excluded = true, pph21_report_exclusion_reason = 'Dilaporkan pemberi kerja lain'
         WHERE id = $1`,
        [employee.profileId],
      );
      await writeResult(periodId, employee.employmentId, {
        profileId: employee.profileId,
        lines: [{ code: "BASIC", category: "EARNING", amount: 2_000_000 }],
      });
      // A later profile stops the exclusion; the September report is unchanged.
      await pool.query(`UPDATE payroll_compensation_profiles SET effective_to = DATE '2026-09-30' WHERE id = $1`, [
        employee.profileId,
      ]);
      await pool.query(
        `INSERT INTO payroll_compensation_profiles(id, employment_id, effective_from, education, ptkp_status)
         VALUES ($1, $2, DATE '2026-10-01', 'S1', 'TK/0')`,
        [randomUUID(), employee.employmentId],
      );

      const [row] = await loadPph21SourceRows(pool, periodId);
      expect(row).toMatchObject({ excluded: true, exclusionReason: "Dilaporkan pemberi kerja lain" });
    });

    it("reports the end of an employment, and only the latest run of each employee", async () => {
      const periodId = await newPeriod("2026-09-01");
      const leaving = await newEmployee({ endedOn: "2026-09-15" });
      const first = await writeResult(periodId, leaving.employmentId, {
        profileId: leaving.profileId,
        lines: [{ code: "BASIC", category: "EARNING", amount: 9_999_999 }],
        calculatedAt: "2026-09-19T00:00:00.000Z",
      });
      await writeResult(periodId, leaving.employmentId, {
        profileId: leaving.profileId,
        previousResultId: first,
        lines: [{ code: "BASIC", category: "EARNING", amount: 1_500_000 }],
        calculatedAt: "2026-09-20T00:00:00.000Z",
      });

      const rows = await loadPph21SourceRows(pool, periodId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ serviceEndDate: "2026-09-15", earnings: [{ code: "BASIC", amount: 1_500_000 }] });
    });

    it("answers a period without results with no rows", async () => {
      expect(await loadPph21SourceRows(pool, await newPeriod("2026-09-01"))).toEqual([]);
    });
  });

  describe("migration 0142", () => {
    it("defaults an existing profile to reported, with no reason", async () => {
      const employee = await newEmployee();
      const { rows } = await pool.query(
        `SELECT pph21_report_excluded, pph21_report_exclusion_reason FROM payroll_compensation_profiles WHERE id = $1`,
        [employee.profileId],
      );
      expect(rows[0]).toEqual({ pph21_report_excluded: false, pph21_report_exclusion_reason: null });
    });

    it("refuses an exclusion without a reason, blank included", async () => {
      const employee = await newEmployee();
      for (const reason of [null, "   "]) {
        await expect(
          pool.query(
            `UPDATE payroll_compensation_profiles
             SET pph21_report_excluded = true, pph21_report_exclusion_reason = $2 WHERE id = $1`,
            [employee.profileId, reason],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "payroll_compensation_profiles_pph21_exclusion_needs_reason",
        });
      }
    });
  });

  describe("profile write path", () => {
    async function profileOf(employmentId: string, effectiveFrom: string) {
      const { rows } = await pool.query<{ excluded: boolean; reason: string | null; ptkp: string | null }>(
        `SELECT pph21_report_excluded AS excluded, pph21_report_exclusion_reason AS reason, ptkp_status AS ptkp
         FROM payroll_compensation_profiles WHERE employment_id = $1 AND effective_from = $2::date`,
        [employmentId, effectiveFrom],
      );
      return rows[0];
    }

    it("opens an exclusion, carries it forward, and drops the reason when reported again", async () => {
      const employee = await newEmployee();
      const opened = await openCompensationProfile(
        pool,
        {
          employmentId: employee.employmentId,
          effectiveFrom: "2027-01-01",
          pph21ReportExcluded: true,
          pph21ReportExclusionReason: "Dilaporkan pemberi kerja lain",
        },
        actorAccountId,
      );
      expect(opened).toMatchObject({
        pph21ReportExcluded: true,
        pph21ReportExclusionReason: "Dilaporkan pemberi kerja lain",
        ptkpStatus: "TK/0",
      });

      // A profile that says nothing about it carries the exclusion and reason.
      await openCompensationProfile(
        pool,
        { employmentId: employee.employmentId, effectiveFrom: "2027-02-01", bankName: "BSI" },
        actorAccountId,
      );
      expect(await profileOf(employee.employmentId, "2027-02-01")).toEqual({
        excluded: true,
        reason: "Dilaporkan pemberi kerja lain",
        ptkp: "TK/0",
      });

      // Reporting again drops the reason instead of carrying a stale one.
      await openCompensationProfile(
        pool,
        { employmentId: employee.employmentId, effectiveFrom: "2027-03-01", pph21ReportExcluded: false },
        actorAccountId,
      );
      expect(await profileOf(employee.employmentId, "2027-03-01")).toEqual({ excluded: false, reason: null, ptkp: "TK/0" });
    });

    it("refuses an exclusion with no reason given or carried", async () => {
      const employee = await newEmployee();
      await expect(
        openCompensationProfile(
          pool,
          { employmentId: employee.employmentId, effectiveFrom: "2027-01-01", pph21ReportExcluded: true },
          actorAccountId,
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("audits whether the profile excludes the person, without the reason", async () => {
      const employee = await newEmployee();
      await openCompensationProfile(
        pool,
        {
          employmentId: employee.employmentId,
          effectiveFrom: "2027-01-01",
          pph21ReportExcluded: true,
          pph21ReportExclusionReason: "Alasan rahasia uji",
        },
        actorAccountId,
      );
      const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM payroll_audit_events
         WHERE action = 'payroll.profile.opened' AND employment_id = $1`,
        [employee.employmentId],
      );
      expect(rows.map((row) => row.payload)).toEqual([{ effective_from: "2027-01-01", pph21_report_excluded: true }]);
      expect(JSON.stringify(rows)).not.toContain("Alasan rahasia uji");
    });
  });
});
