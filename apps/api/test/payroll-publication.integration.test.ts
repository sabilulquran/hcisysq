// PAY-003 payslip publication against real PostgreSQL: the slip an employee
// reads is written from the final result, a published slip is never edited, and
// a correction after a reopen becomes a revision beside it.
// Runs only against the loopback CI database.

import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { clearOwnPeriods } from "./support/payroll-cleanup.js";

import {
  buildPayslipLines,
  draftPayslipsFromPeriod,
  publishPayslipsOfPeriod,
} from "../src/modules/payroll/publication.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

const RUN_AT = "2026-09-20T00:00:00.000Z";

describe("PAY-003 payslip lines", () => {
  const result = {
    resultId: "r1",
    employeeId: "e1",
    employeeNumber: "2016001",
    fullName: "Pegawai Uji",
    gross: "3200000",
    deductions: "200000",
    net: "3000000",
    payable: "3000000",
    payFactor: "1.0000",
    payFactorReason: "none",
    blockerCount: 0,
  };
  const lines = [
    { resultId: "r1", componentCode: "BASIC", displayName: "Gaji pokok", category: "EARNING", amount: "3200000", displayOrder: 10 },
    { resultId: "r1", componentCode: "LOAN", displayName: "Potongan kasbon", category: "DEDUCTION", amount: "200000", displayOrder: 200 },
  ];
  const period = { periodMonth: "2026-09-01", payDate: "2026-09-25" };

  it("opens with who and which month, then earnings, deductions and the totals", () => {
    expect(buildPayslipLines(result, lines, period)).toEqual([
      { label: "NIP", value: "2016001", section: "identity" },
      { label: "Nama", value: "Pegawai Uji", section: "identity" },
      { label: "Periode", value: "2026-09", section: "identity" },
      { label: "Tanggal gajian", value: "2026-09-25", section: "identity" },
      { label: "Gaji pokok", value: "Rp3.200.000", section: "income" },
      { label: "Potongan kasbon", value: "Rp200.000", section: "deduction" },
      { label: "Total pendapatan", value: "Rp3.200.000", section: "summary" },
      { label: "Total potongan", value: "Rp200.000", section: "summary" },
      { label: "Gaji bersih", value: "Rp3.000.000", section: "summary" },
      { label: "Nominal dibayar", value: "Rp3.000.000", section: "summary" },
    ]);
  });

  it("says why the amount was cut when a factor applied", () => {
    const prorated = buildPayslipLines(
      { ...result, payFactor: "0.5000", payFactorReason: "proration", payable: "1500000" },
      lines,
      period,
    );
    expect(prorated).toContainEqual({ label: "Prorata (50%)", value: "Rp1.500.000", section: "summary" });
  });

  it("names the early-service rate by its own name", () => {
    const early = buildPayslipLines(
      { ...result, payFactor: "0.8000", payFactorReason: "early_service", payable: "2400000" },
      lines,
      period,
    );
    expect(early).toContainEqual({ label: "Masa kerja awal (80%)", value: "Rp2.400.000", section: "summary" });
  });

  it("says nothing about a factor when none applied", () => {
    const plain = buildPayslipLines(result, lines, period);
    expect(plain.some((line) => line.label.includes("Prorata"))).toBe(false);
    expect(plain.some((line) => line.label.includes("Masa kerja awal"))).toBe(false);
  });

  it("marks a revision on the slip itself, so the employee can tell them apart", () => {
    const revision = buildPayslipLines(result, lines, period, { revision: true });
    expect(revision[0]).toEqual({ label: "Status", value: "Revisi", section: "identity" });
    expect(buildPayslipLines(result, lines, period)[0]!.label).toBe("NIP");
  });
});

describe.skipIf(!allowed)("PAY-003 payslip publication against PostgreSQL", () => {
  let pool: Pool;
  let legalEntityKey: string;
  let actorAccountId: string;
  let ownedPeriodIds: string[] = [];

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl!, max: 2 });
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    legalEntityKey = randomUUID();
    // Only this suite's own rows: test files run in parallel against one database.
    await clearOwnPeriods(pool, ownedPeriodIds);
    ownedPeriodIds = [];
    const accounts = await pool.query<{ id: string }>("SELECT id FROM accounts LIMIT 1");
    if (accounts.rows[0]) {
      actorAccountId = accounts.rows[0].id;
    } else {
      const employeeId = randomUUID();
      actorAccountId = randomUUID();
      await pool.query(
        "INSERT INTO employees(id, employee_number, full_name, status) VALUES ($1, $2, 'Synthetic Actor', 'active')",
        [employeeId, `EMP-PUB-ACTOR-${employeeId}`],
      );
      await pool.query(
        `INSERT INTO accounts(id, employee_id, email, principal_type, status)
         VALUES ($1, $2, $3, 'EMPLOYEE', 'active')`,
        [actorAccountId, employeeId, `pub-${actorAccountId}@example.invalid`],
      );
    }
  });

  async function newEmployee() {
    const employeeId = randomUUID();
    const employmentId = randomUUID();
    const actionId = randomUUID();
    const client = await pool.connect();
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO employees(id, employee_number, full_name, status) VALUES ($1, $2, 'Pegawai Slip', 'active')",
      [employeeId, `EMP-PUB-${employeeId.slice(0, 8)}`],
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
    return { employeeId, employmentId };
  }

  async function newPeriod(state: string) {
    const periodId = randomUUID();
    ownedPeriodIds.push(periodId);
    await pool.query(
      `INSERT INTO payroll_periods(
         id, legal_entity_key, period_month, pay_date, period_start, period_end, cutoff_start, cutoff_end, state)
       VALUES ($1, $2, DATE '2026-09-01', DATE '2026-09-25', DATE '2026-09-01', DATE '2026-09-30',
               DATE '2026-08-23', DATE '2026-09-22', $3)`,
      [periodId, legalEntityKey, state],
    );
    return periodId;
  }

  async function writeResult(
    periodId: string,
    employmentId: string,
    options: { basic: number; blockers?: unknown[]; runAt?: string; revision?: number },
  ) {
    const resultId = randomUUID();
    await pool.query(
      `INSERT INTO payroll_results(
         id, period_id, employment_id, revision, gross, deductions, net, payable,
         blockers, input_snapshot, policy_version_ids, calculated_at)
       VALUES ($1, $2, $3, $4, $5, 0, $5, $5, $6::jsonb, '{}'::jsonb, '["v1"]'::jsonb, $7::timestamptz)`,
      [
        resultId,
        periodId,
        employmentId,
        options.revision ?? 1,
        options.basic,
        JSON.stringify(options.blockers ?? []),
        options.runAt ?? RUN_AT,
      ],
    );
    await pool.query(
      `INSERT INTO payroll_result_lines(id, result_id, component_code, category, amount, display_order)
       VALUES ($1, $2, 'BASIC', 'EARNING', $3, 10)`,
      [randomUUID(), resultId, options.basic],
    );
    return resultId;
  }

  /** A minimal PAY-001 import batch, so its draft can be left alone on purpose. */
  async function newImportBatch(): Promise<string> {
    const batchId = randomUUID();
    await pool.query(
      `INSERT INTO payslip_import_batches(
         id, source_filename, checksum_sha256, status, row_count, valid_count, created_by_account_id)
       VALUES ($1, 'uji.csv', $2, 'committed', 1, 1, $3)`,
      [batchId, randomUUID().replace(/-/g, ""), actorAccountId],
    );
    return batchId;
  }

  /** Replaces the period's results with a new run, as a recalculation would. */
  async function replaceResult(
    periodId: string,
    employmentId: string,
    basic: number,
    runAt: string,
  ): Promise<void> {
    await pool.query(
      `DELETE FROM payroll_result_lines
       WHERE result_id IN (SELECT id FROM payroll_results WHERE period_id = $1)`,
      [periodId],
    );
    await pool.query("DELETE FROM payroll_results WHERE period_id = $1", [periodId]);
    await writeResult(periodId, employmentId, { basic, runAt });
  }

  async function slipsOf(employeeId: string) {
    const { rows } = await pool.query<{
      id: string;
      lines: Array<{ label: string; value: string }>;
      publishedAt: string | null;
      revisionOf: string | null;
      supersededById: string | null;
      sourcePeriodId: string | null;
      sourceBatchId: string | null;
    }>(
      `SELECT id, lines, published_at AS "publishedAt", revision_of AS "revisionOf",
              superseded_by_id AS "supersededById", source_period_id AS "sourcePeriodId",
              source_batch_id AS "sourceBatchId"
       FROM payslips WHERE employee_id = $1 ORDER BY created_at, id`,
      [employeeId],
    );
    return rows;
  }

  it("writes one draft slip per employee, sourced from the period", async () => {
    const periodId = await newPeriod("PAYMENT_CONFIRMED");
    const employee = await newEmployee();
    await writeResult(periodId, employee.employmentId, { basic: 3_000_000 });

    const outcome = await draftPayslipsFromPeriod(pool, periodId, actorAccountId);
    expect(outcome).toEqual({ ok: true, drafted: 1, revised: 0, alreadyCurrent: 0, importConflicts: [] });

    const slips = await slipsOf(employee.employeeId);
    expect(slips).toHaveLength(1);
    expect(slips[0]!.sourcePeriodId).toBe(periodId);
    expect(slips[0]!.sourceBatchId).toBeNull();
    expect(slips[0]!.publishedAt).toBeNull();
    expect(slips[0]!.lines).toContainEqual({ label: "Gaji pokok", value: "Rp3.000.000", section: "income" });
  });

  it("refuses to draft anything while a blocker stands", async () => {
    const periodId = await newPeriod("PAYMENT_CONFIRMED");
    const employee = await newEmployee();
    await writeResult(periodId, employee.employmentId, {
      basic: 3_000_000,
      blockers: [{ code: "BANK_ACCOUNT_MISSING", message: "Rekening belum terisi." }],
    });

    const outcome = await draftPayslipsFromPeriod(pool, periodId, actorAccountId);
    expect(outcome).toEqual({ ok: false, code: "PAYROLL_BLOCKERS_PRESENT", blockerCount: 1 });
    expect(await slipsOf(employee.employeeId)).toEqual([]);
  });

  it("says plainly when a period has nothing to draft", async () => {
    const periodId = await newPeriod("PAYMENT_CONFIRMED");
    const outcome = await draftPayslipsFromPeriod(pool, periodId, actorAccountId);
    expect(outcome).toEqual({ ok: false, code: "PAYROLL_NOTHING_TO_PUBLISH" });
  });

  it("changes nothing on a second run when nothing moved", async () => {
    const periodId = await newPeriod("PAYMENT_CONFIRMED");
    const employee = await newEmployee();
    await writeResult(periodId, employee.employmentId, { basic: 3_000_000 });

    await draftPayslipsFromPeriod(pool, periodId, actorAccountId);
    const second = await draftPayslipsFromPeriod(pool, periodId, actorAccountId);
    expect(second).toEqual({ ok: true, drafted: 0, revised: 0, alreadyCurrent: 1, importConflicts: [] });
    expect(await slipsOf(employee.employeeId)).toHaveLength(1);
  });

  it("updates a draft that was never published rather than piling up slips", async () => {
    const periodId = await newPeriod("PAYMENT_CONFIRMED");
    const employee = await newEmployee();
    await writeResult(periodId, employee.employmentId, { basic: 3_000_000 });
    await draftPayslipsFromPeriod(pool, periodId, actorAccountId);

    await pool.query("DELETE FROM payroll_result_lines WHERE result_id IN (SELECT id FROM payroll_results WHERE period_id = $1)", [periodId]);
    await pool.query("DELETE FROM payroll_results WHERE period_id = $1", [periodId]);
    await writeResult(periodId, employee.employmentId, { basic: 3_500_000, runAt: "2026-09-21T00:00:00.000Z" });

    const outcome = await draftPayslipsFromPeriod(pool, periodId, actorAccountId);
    expect(outcome).toEqual({ ok: true, drafted: 1, revised: 0, alreadyCurrent: 0, importConflicts: [] });
    const slips = await slipsOf(employee.employeeId);
    expect(slips).toHaveLength(1);
    expect(slips[0]!.lines).toContainEqual({ label: "Gaji pokok", value: "Rp3.500.000", section: "income" });
  });

  it("never edits a published slip: the correction becomes a revision beside it", async () => {
    const periodId = await newPeriod("PAYMENT_CONFIRMED");
    const employee = await newEmployee();
    await writeResult(periodId, employee.employmentId, { basic: 3_000_000 });
    await draftPayslipsFromPeriod(pool, periodId, actorAccountId);

    const published = (await slipsOf(employee.employeeId))[0]!;
    await pool.query("UPDATE payslips SET published_at = now() WHERE id = $1", [published.id]);

    await pool.query("DELETE FROM payroll_result_lines WHERE result_id IN (SELECT id FROM payroll_results WHERE period_id = $1)", [periodId]);
    await pool.query("DELETE FROM payroll_results WHERE period_id = $1", [periodId]);
    await writeResult(periodId, employee.employmentId, { basic: 3_500_000, runAt: "2026-09-22T00:00:00.000Z" });

    const outcome = await draftPayslipsFromPeriod(pool, periodId, actorAccountId);
    expect(outcome).toEqual({ ok: true, drafted: 0, revised: 1, alreadyCurrent: 0, importConflicts: [] });

    const slips = await slipsOf(employee.employeeId);
    expect(slips).toHaveLength(2);
    const original = slips.find((slip) => slip.id === published.id)!;
    const revision = slips.find((slip) => slip.id !== published.id)!;
    // The employee can still read what they were told the first time.
    expect(original.publishedAt).not.toBeNull();
    expect(original.supersededById).toBe(revision.id);
    expect(revision.revisionOf).toBe(published.id);
    expect(revision.publishedAt).toBeNull();
    expect(revision.lines).toContainEqual({ label: "Gaji pokok", value: "Rp3.500.000", section: "income" });
  });

  it("keeps exactly one current slip per employee and month", async () => {
    const periodId = await newPeriod("PAYMENT_CONFIRMED");
    const employee = await newEmployee();
    await writeResult(periodId, employee.employmentId, { basic: 3_000_000 });
    await draftPayslipsFromPeriod(pool, periodId, actorAccountId);
    const first = (await slipsOf(employee.employeeId))[0]!;
    await pool.query("UPDATE payslips SET published_at = now() WHERE id = $1", [first.id]);
    await pool.query("DELETE FROM payroll_result_lines WHERE result_id IN (SELECT id FROM payroll_results WHERE period_id = $1)", [periodId]);
    await pool.query("DELETE FROM payroll_results WHERE period_id = $1", [periodId]);
    await writeResult(periodId, employee.employmentId, { basic: 3_500_000, runAt: "2026-09-22T00:00:00.000Z" });
    await draftPayslipsFromPeriod(pool, periodId, actorAccountId);

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM payslips
       WHERE employee_id = $1 AND period = DATE '2026-09-01' AND superseded_by_id IS NULL`,
      [employee.employeeId],
    );
    expect(rows[0]!.count).toBe("1");
  });

  it("records the drafting without naming an amount", async () => {
    const periodId = await newPeriod("PAYMENT_CONFIRMED");
    const employee = await newEmployee();
    await writeResult(periodId, employee.employmentId, { basic: 3_000_000 });
    await draftPayslipsFromPeriod(pool, periodId, actorAccountId);

    const { rows } = await pool.query<{ action: string; payload: Record<string, unknown> }>(
      "SELECT action, payload FROM payroll_audit_events WHERE period_id = $1",
      [periodId],
    );
    expect(rows.map((row) => row.action)).toEqual(["payroll.payslips.drafted"]);
    expect(rows[0]!.payload).toEqual({ drafted: 1, revised: 0, already_current: 0, import_conflicts: 0 });
  });

  it("refuses to draft for a period that has gone back to being worked on", async () => {
    const periodId = await newPeriod("COLLECTING");
    const employee = await newEmployee();
    await writeResult(periodId, employee.employmentId, { basic: 3_000_000 });
    const outcome = await draftPayslipsFromPeriod(pool, periodId, actorAccountId);
    expect(outcome).toEqual({ ok: false, code: "PAYROLL_STATE_CONFLICT", state: "COLLECTING" });
    expect(await slipsOf(employee.employeeId)).toEqual([]);
  });

  it("leaves an import batch's draft alone and reports the employee instead", async () => {
    const periodId = await newPeriod("PAYMENT_CONFIRMED");
    const employee = await newEmployee();
    await writeResult(periodId, employee.employmentId, { basic: 3_000_000 });

    const batchId = await newImportBatch();
    const importedSlipId = randomUUID();
    await pool.query(
      `INSERT INTO payslips(id, employee_id, period, lines, source_format, source_batch_id)
       VALUES ($1, $2, DATE '2026-09-01', '[{"label":"Impor","value":"Rp1"}]'::jsonb, 'tetap', $3)`,
      [importedSlipId, employee.employeeId, batchId],
    );

    const outcome = await draftPayslipsFromPeriod(pool, periodId, actorAccountId);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.drafted).toBe(0);
    expect(outcome.importConflicts).toHaveLength(1);

    const slips = await slipsOf(employee.employeeId);
    expect(slips).toHaveLength(1);
    // The batch keeps its draft, so PAY-002 can still publish it.
    expect(slips[0]!.sourceBatchId).toBe(batchId);
    expect(slips[0]!.sourcePeriodId).toBeNull();
  });

  it("publishes the period's drafts, and only those", async () => {
    const periodId = await newPeriod("PAYMENT_CONFIRMED");
    const employee = await newEmployee();
    await writeResult(periodId, employee.employmentId, { basic: 3_000_000 });
    await draftPayslipsFromPeriod(pool, periodId, actorAccountId);

    const outcome = await publishPayslipsOfPeriod(pool, periodId, actorAccountId);
    expect(outcome).toEqual({ ok: true, published: 1 });

    const slips = await slipsOf(employee.employeeId);
    expect(slips[0]!.publishedAt).not.toBeNull();
  });

  it("says plainly when there is no draft to publish", async () => {
    const periodId = await newPeriod("PAYMENT_CONFIRMED");
    expect(await publishPayslipsOfPeriod(pool, periodId, actorAccountId)).toEqual({
      ok: false,
      code: "PAYROLL_NOTHING_TO_PUBLISH",
    });
  });

  it("refuses to publish for a period that has gone back to being worked on", async () => {
    const periodId = await newPeriod("PAYMENT_CONFIRMED");
    const employee = await newEmployee();
    await writeResult(periodId, employee.employmentId, { basic: 3_000_000 });
    await draftPayslipsFromPeriod(pool, periodId, actorAccountId);
    await pool.query("UPDATE payroll_periods SET state = 'COLLECTING' WHERE id = $1", [periodId]);

    expect(await publishPayslipsOfPeriod(pool, periodId, actorAccountId)).toEqual({
      ok: false,
      code: "PAYROLL_STATE_CONFLICT",
      state: "COLLECTING",
    });
  });

  it("publishes a revision without touching the slip it replaced", async () => {
    const periodId = await newPeriod("PAYMENT_CONFIRMED");
    const employee = await newEmployee();
    await writeResult(periodId, employee.employmentId, { basic: 3_000_000 });
    await draftPayslipsFromPeriod(pool, periodId, actorAccountId);
    await publishPayslipsOfPeriod(pool, periodId, actorAccountId);

    await replaceResult(periodId, employee.employmentId, 3_500_000, "2026-09-22T00:00:00.000Z");
    await draftPayslipsFromPeriod(pool, periodId, actorAccountId);
    expect(await publishPayslipsOfPeriod(pool, periodId, actorAccountId)).toEqual({ ok: true, published: 1 });

    const slips = await slipsOf(employee.employeeId);
    expect(slips).toHaveLength(2);
    expect(slips.every((slip) => slip.publishedAt !== null)).toBe(true);
    const revision = slips.find((slip) => slip.revisionOf !== null)!;
    expect(revision.lines[0]).toEqual({ label: "Status", value: "Revisi", section: "identity" });
  });

  it("keeps a second reopen a chain rather than a tangle", async () => {
    const periodId = await newPeriod("PAYMENT_CONFIRMED");
    const employee = await newEmployee();
    await writeResult(periodId, employee.employmentId, { basic: 3_000_000 });
    await draftPayslipsFromPeriod(pool, periodId, actorAccountId);
    await publishPayslipsOfPeriod(pool, periodId, actorAccountId);

    await replaceResult(periodId, employee.employmentId, 3_500_000, "2026-09-22T00:00:00.000Z");
    await draftPayslipsFromPeriod(pool, periodId, actorAccountId);
    await publishPayslipsOfPeriod(pool, periodId, actorAccountId);

    await replaceResult(periodId, employee.employmentId, 3_700_000, "2026-09-23T00:00:00.000Z");
    await draftPayslipsFromPeriod(pool, periodId, actorAccountId);

    const slips = await slipsOf(employee.employeeId);
    expect(slips).toHaveLength(3);
    const current = slips.filter((slip) => slip.supersededById === null);
    expect(current).toHaveLength(1);
    expect(current[0]!.revisionOf).not.toBeNull();
  });

  it("shows the employee only the slip that counts", async () => {
    const periodId = await newPeriod("PAYMENT_CONFIRMED");
    const employee = await newEmployee();
    await writeResult(periodId, employee.employmentId, { basic: 3_000_000 });
    await draftPayslipsFromPeriod(pool, periodId, actorAccountId);
    await publishPayslipsOfPeriod(pool, periodId, actorAccountId);
    await replaceResult(periodId, employee.employmentId, 3_500_000, "2026-09-22T00:00:00.000Z");
    await draftPayslipsFromPeriod(pool, periodId, actorAccountId);
    await publishPayslipsOfPeriod(pool, periodId, actorAccountId);

    // The same query the employee's own payslip list runs.
    const { rows } = await pool.query<{ id: string; isRevision: boolean }>(
      `SELECT id, (revision_of IS NOT NULL) AS "isRevision"
       FROM payslips
       WHERE employee_id = $1 AND published_at IS NOT NULL AND superseded_by_id IS NULL`,
      [employee.employeeId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isRevision).toBe(true);
  });

  it("lets a slip step aside and its replacement land in the same transaction", async () => {
    // The mechanics the revision path rests on, on their own: one current slip
    // per employee and month is a partial unique index, so the row being
    // replaced has to leave the index before the replacement enters it.
    const employee = await newEmployee();
    const periodId = await newPeriod("PAYMENT_CONFIRMED");
    const firstId = randomUUID();
    const secondId = randomUUID();
    await pool.query(
      `INSERT INTO payslips(id, employee_id, period, lines, source_format, source_period_id)
       VALUES ($1, $2, DATE '2026-09-01', '[]'::jsonb, 'generic', $3)`,
      [firstId, employee.employeeId, periodId],
    );

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE payslips SET superseded_by_id = $2 WHERE id = $1", [firstId, secondId]);
      await client.query(
        `INSERT INTO payslips(id, employee_id, period, lines, source_format, source_period_id, revision_of)
         VALUES ($1, $2, DATE '2026-09-01', '[]'::jsonb, 'generic', $3, $4)`,
        [secondId, employee.employeeId, periodId, firstId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const slips = await slipsOf(employee.employeeId);
    expect(slips).toHaveLength(2);
    expect(slips.filter((slip) => slip.supersededById === null)).toHaveLength(1);
  });

  it("refuses two current slips for one employee and month", async () => {
    const employee = await newEmployee();
    const periodId = await newPeriod("PAYMENT_CONFIRMED");
    await pool.query(
      `INSERT INTO payslips(id, employee_id, period, lines, source_format, source_period_id)
       VALUES ($1, $2, DATE '2026-09-01', '[]'::jsonb, 'generic', $3)`,
      [randomUUID(), employee.employeeId, periodId],
    );
    await expect(
      pool.query(
        `INSERT INTO payslips(id, employee_id, period, lines, source_format, source_period_id)
         VALUES ($1, $2, DATE '2026-09-01', '[]'::jsonb, 'generic', $3)`,
        [randomUUID(), employee.employeeId, periodId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("refuses a slip that claims both an import batch and a payroll period", async () => {
    const employee = await newEmployee();
    const periodId = await newPeriod("PAYMENT_CONFIRMED");
    // A real batch, so the check constraint is what refuses this and not a
    // foreign key to a batch that never existed.
    const batchId = await newImportBatch();
    await expect(
      pool.query(
        `INSERT INTO payslips(id, employee_id, period, lines, source_format, source_batch_id, source_period_id)
         VALUES ($1, $2, DATE '2026-09-01', '[]'::jsonb, 'generic', $3, $4)`,
        [randomUUID(), employee.employeeId, batchId, periodId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses a slip that claims neither source", async () => {
    const employee = await newEmployee();
    await expect(
      pool.query(
        `INSERT INTO payslips(id, employee_id, period, lines, source_format)
         VALUES ($1, $2, DATE '2026-09-01', '[]'::jsonb, 'generic')`,
        [randomUUID(), employee.employeeId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
