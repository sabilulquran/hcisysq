/**
 * PAY-003 payslip publication (specification sections 6, 7 and 10 item 8).
 *
 * The final result of a period becomes a payslip through the PAY-002 path the
 * employee already reads: the same table, the same label/value lines, the same
 * published_at. Payroll adds nothing to the employee's screen; it only becomes
 * the source of what is on it.
 *
 * A published slip is never edited. When an approved reopen changes what someone
 * was paid, publishing again writes a revision that points at the slip it
 * replaces, and the earlier slip stays readable.
 */

import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { notifyEmployee } from "../notifications/service.js";
import { formatRupiah } from "./reports.js";
import { LATEST_RESULTS_OF_PERIOD, writeAudit } from "./store.js";

/** Drafting is only sensible while the period is paid and not reopened. */
const DRAFTABLE_STATES = ["PAYMENT_CONFIRMED", "PUBLISHED"];

type PayslipLine = { label: string; value: string; section: "identity" | "income" | "deduction" | "summary" };

type ResultRow = {
  resultId: string;
  employeeId: string;
  employeeNumber: string;
  fullName: string;
  gross: string;
  deductions: string;
  net: string;
  payable: string;
  payFactor: string;
  payFactorReason: string;
  blockerCount: number;
};

type LineRow = {
  resultId: string;
  componentCode: string;
  displayName: string;
  category: string;
  amount: string;
  displayOrder: number;
};

/**
 * Builds one employee's slip lines from their result. The order is the component
 * catalog's display order, which is the order the legacy slip used, with the
 * identity and the summary around it.
 */
export function buildPayslipLines(
  result: ResultRow,
  lines: readonly LineRow[],
  period: { periodMonth: string; payDate: string },
  options: { revision?: boolean } = {},
): PayslipLine[] {
  const earnings = lines.filter((line) => line.category === "EARNING");
  const deductions = lines.filter((line) => line.category === "DEDUCTION");

  const payslip: PayslipLine[] = [
    // Section 10 item 8: a revised slip says so, so the employee can tell which
    // one they are looking at.
    ...(options.revision ? [{ label: "Status", value: "Revisi", section: "identity" as const }] : []),
    { label: "NIP", value: result.employeeNumber, section: "identity" },
    { label: "Nama", value: result.fullName, section: "identity" },
    { label: "Periode", value: period.periodMonth.slice(0, 7), section: "identity" },
    { label: "Tanggal gajian", value: period.payDate, section: "identity" },
  ];

  for (const line of earnings) {
    payslip.push({ label: line.displayName, value: formatRupiah(line.amount), section: "income" });
  }
  for (const line of deductions) {
    payslip.push({ label: line.displayName, value: formatRupiah(line.amount), section: "deduction" });
  }

  payslip.push(
    { label: "Total pendapatan", value: formatRupiah(result.gross), section: "summary" },
    { label: "Total potongan", value: formatRupiah(result.deductions), section: "summary" },
    { label: "Gaji bersih", value: formatRupiah(result.net), section: "summary" },
  );

  // The factor only appears when it actually changed the amount, so an ordinary
  // slip is not cluttered with a line saying nothing happened.
  if (result.payFactorReason !== "none") {
    const reason =
      result.payFactorReason === "proration" ? "Prorata" : "Masa kerja awal";
    payslip.push({
      label: `${reason} (${Math.round(Number(result.payFactor) * 100)}%)`,
      value: formatRupiah(result.payable),
      section: "summary",
    });
  }
  payslip.push({ label: "Nominal dibayar", value: formatRupiah(result.payable), section: "summary" });

  return payslip;
}

export type PublicationOutcome =
  | {
      ok: true;
      drafted: number;
      revised: number;
      alreadyCurrent: number;
      /** Employees whose current slip belongs to an import batch; left untouched. */
      importConflicts: string[];
    }
  | {
      ok: false;
      code: "PAYROLL_BLOCKERS_PRESENT" | "PAYROLL_NOTHING_TO_PUBLISH" | "PAYROLL_STATE_CONFLICT";
      blockerCount?: number;
      state?: string;
    };

/**
 * Writes the period's results as payslip drafts. It does not publish them: the
 * PAY-002 publish step stays the one that makes a slip visible, so the people
 * who hold payslips.publish keep that decision.
 */
export async function draftPayslipsFromPeriod(
  pool: Pool,
  periodId: string,
  actorAccountId: string,
): Promise<PublicationOutcome> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const period = await client.query<{ periodMonth: string; payDate: string; state: string }>(
      `SELECT to_char(period_month, 'YYYY-MM-DD') AS "periodMonth",
              to_char(pay_date, 'YYYY-MM-DD') AS "payDate",
              state
       FROM payroll_periods WHERE id = $1 FOR UPDATE`,
      [periodId],
    );
    const periodRow = period.rows[0];
    if (!periodRow) {
      await client.query("ROLLBACK");
      return { ok: false, code: "PAYROLL_NOTHING_TO_PUBLISH" };
    }
    // Under the lock, not before it: an approved reopen that commits between the
    // caller's read and this transaction would otherwise draft slips for a period
    // that has gone back to being worked on.
    if (!DRAFTABLE_STATES.includes(periodRow.state)) {
      await client.query("ROLLBACK");
      return { ok: false, code: "PAYROLL_STATE_CONFLICT", state: periodRow.state };
    }

    const results = await loadResults(client, periodId);
    if (results.length === 0) {
      await client.query("ROLLBACK");
      return { ok: false, code: "PAYROLL_NOTHING_TO_PUBLISH" };
    }

    // Fail closed: a period with a standing blocker is not something to put in
    // front of an employee (specification section 5.4).
    const blockerCount = results.reduce((total, row) => total + row.blockerCount, 0);
    if (blockerCount > 0) {
      await client.query("ROLLBACK");
      return { ok: false, code: "PAYROLL_BLOCKERS_PRESENT", blockerCount };
    }

    const lines = await loadLines(client, periodId);
    const linesByResult = new Map<string, LineRow[]>();
    for (const line of lines) {
      linesByResult.set(line.resultId, [...(linesByResult.get(line.resultId) ?? []), line]);
    }

    let drafted = 0;
    let revised = 0;
    let alreadyCurrent = 0;
    const importConflicts: string[] = [];

    for (const result of results) {
      // Built twice because a revision carries one more line than a first draft,
      // and the comparison below has to be against the shape that would be stored.
      const draftLines = buildPayslipLines(result, linesByResult.get(result.resultId) ?? [], periodRow);
      const revisionLines = buildPayslipLines(result, linesByResult.get(result.resultId) ?? [], periodRow, {
        revision: true,
      });
      const serialized = JSON.stringify(draftLines);

    const existing = await client.query<{
        id: string;
        publishedAt: string | null;
        sourceBatchId: string | null;
        sameLines: boolean;
      }>(
        `SELECT id, published_at AS "publishedAt", source_batch_id AS "sourceBatchId",
                (lines = $3::jsonb OR lines = $4::jsonb) AS "sameLines"
         FROM payslips
         WHERE employee_id = $1 AND period = $2::date AND superseded_by_id IS NULL
         FOR UPDATE`,
        [result.employeeId, periodRow.periodMonth, serialized, JSON.stringify(revisionLines)],
      );
      const current = existing.rows[0];

      if (!current) {
        await client.query(
          `INSERT INTO payslips(id, employee_id, period, lines, source_format, source_batch_id, source_period_id)
           VALUES ($1, $2, $3::date, $4::jsonb, 'generic', NULL, $5)`,
          [randomUUID(), result.employeeId, periodRow.periodMonth, serialized, periodId],
        );
        drafted += 1;
        continue;
      }

      if (current.sourceBatchId !== null) {
        // The current slip belongs to a PAY-001 import batch. Overwriting it
        // would take the slip out of that batch and leave PAY-002 unable to
        // publish it, so the employee is reported and left alone instead.
        importConflicts.push(result.employeeNumber);
        continue;
      }

      if (current.sameLines) {
        // Nothing moved for this employee, so there is nothing to draft again.
        // Compared as jsonb, not as text, so a different key order is not a change.
        alreadyCurrent += 1;
        continue;
      }

      if (current.publishedAt === null) {
        // An unpublished draft is still being prepared, so it is simply updated.
        await client.query(
          `UPDATE payslips SET lines = $2::jsonb, source_period_id = $3 WHERE id = $1`,
          [current.id, serialized, periodId],
        );
        drafted += 1;
        continue;
      }

      // A published slip is a fact. The correction becomes a revision beside it.
      // The old slip steps aside first: only one slip per employee and month may
      // be current, and the reference to the replacement is checked at commit.
      const revisionId = randomUUID();
      await client.query("UPDATE payslips SET superseded_by_id = $2 WHERE id = $1", [current.id, revisionId]);
      await client.query(
        `INSERT INTO payslips(
           id, employee_id, period, lines, source_format, source_batch_id, source_period_id, revision_of)
         VALUES ($1, $2, $3::date, $4::jsonb, 'generic', NULL, $5, $6)`,
        [
          revisionId,
          result.employeeId,
          periodRow.periodMonth,
          JSON.stringify(revisionLines),
          periodId,
          current.id,
        ],
      );
      revised += 1;
    }

    await writeAudit(client, {
      actorAccountId,
      action: "payroll.payslips.drafted",
      periodId,
      payload: {
        drafted,
        revised,
        already_current: alreadyCurrent,
        import_conflicts: importConflicts.length,
      },
    });
    // The payslip module keeps its own trail, and a slip written from payroll
    // belongs on it too.
    await writePayslipAudit(client, actorAccountId, "payslip.payroll.drafted", {
      drafted,
      revised,
      already_current: alreadyCurrent,
    });

    await client.query("COMMIT");
    return { ok: true, drafted, revised, alreadyCurrent, importConflicts };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type PublishOutcome =
  | { ok: true; published: number }
  | { ok: false; code: "PAYROLL_NOTHING_TO_PUBLISH" | "PAYROLL_STATE_CONFLICT"; state?: string };

/**
 * Publishes the period's drafts. This is the PAY-002 decision, not payroll's, so
 * the route asks for payslips.publish: the batch publish path is batch-scoped and
 * cannot see a slip that came from a period, which is why payroll needs its own
 * door rather than a second source column on a batch.
 */
export async function publishPayslipsOfPeriod(
  pool: Pool,
  periodId: string,
  actorAccountId: string,
): Promise<PublishOutcome> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const period = await client.query<{ state: string; periodMonth: string }>(
      `SELECT state, to_char(period_month, 'YYYY-MM') AS "periodMonth"
       FROM payroll_periods WHERE id = $1 FOR UPDATE`,
      [periodId],
    );
    const periodRow = period.rows[0];
    if (!periodRow) {
      await client.query("ROLLBACK");
      return { ok: false, code: "PAYROLL_NOTHING_TO_PUBLISH" };
    }
    if (!DRAFTABLE_STATES.includes(periodRow.state)) {
      await client.query("ROLLBACK");
      return { ok: false, code: "PAYROLL_STATE_CONFLICT", state: periodRow.state };
    }

    const published = await client.query<{ id: string; employeeId: string }>(
      `UPDATE payslips
          SET published_at = now(), published_by_account_id = $2
        WHERE source_period_id = $1
          AND published_at IS NULL
          AND superseded_by_id IS NULL
      RETURNING id, employee_id AS "employeeId"`,
      [periodId, actorAccountId],
    );

    if (published.rows.length === 0) {
      await client.query("ROLLBACK");
      return { ok: false, code: "PAYROLL_NOTHING_TO_PUBLISH" };
    }

    for (const slip of published.rows) {
      await notifyEmployee(client, slip.employeeId, {
        eventKey: `payslip:${slip.id}:published`,
        category: "payslip",
        title: "Slip gaji tersedia",
        body: `Slip gaji periode ${periodRow.periodMonth} sudah dipublikasikan.`,
        href: "/app/payslips",
        actorAccountId,
        metadata: { payslipId: slip.id, period: periodRow.periodMonth },
      });
    }

    await writeAudit(client, {
      actorAccountId,
      action: "payroll.payslips.published",
      periodId,
      payload: { published: published.rows.length },
    });
    await writePayslipAudit(client, actorAccountId, "payslip.payroll.published", {
      published: published.rows.length,
    });

    await client.query("COMMIT");
    return { ok: true, published: published.rows.length };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** A row on the payslip module's own audit trail, so slip history stays in one place. */
async function writePayslipAudit(
  client: PoolClient,
  actorAccountId: string,
  action: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO payslip_audit_events(id, actor_account_id, action, payload)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [randomUUID(), actorAccountId, action, JSON.stringify(payload)],
  );
}

/** The latest revision of the latest run, which is what the period actually pays. */
async function loadResults(client: PoolClient, periodId: string): Promise<ResultRow[]> {
  const { rows } = await client.query<ResultRow>(
    `SELECT latest.id AS "resultId",
            e.employee_id AS "employeeId",
            emp.employee_number AS "employeeNumber",
            emp.full_name AS "fullName",
            latest.gross::text AS gross,
            latest.deductions::text AS deductions,
            latest.net::text AS net,
            latest.payable::text AS payable,
            latest.pay_factor::text AS "payFactor",
            latest.pay_factor_reason AS "payFactorReason",
            jsonb_array_length(latest.blockers) AS "blockerCount"
     FROM (${LATEST_RESULTS_OF_PERIOD}) latest
     JOIN employments e ON e.id = latest.employment_id
     JOIN employees emp ON emp.id = e.employee_id
     ORDER BY emp.employee_number`,
    [periodId],
  );
  return rows;
}

async function loadLines(client: PoolClient, periodId: string): Promise<LineRow[]> {
  const { rows } = await client.query<LineRow>(
    `SELECT l.result_id AS "resultId",
            l.component_code AS "componentCode",
            c.display_name AS "displayName",
            l.category,
            l.amount::text AS amount,
            l.display_order AS "displayOrder"
     FROM (${LATEST_RESULTS_OF_PERIOD}) latest
     JOIN payroll_result_lines l ON l.result_id = latest.id
     JOIN payroll_components c ON c.code = l.component_code
     ORDER BY l.result_id, c.display_order`,
    [periodId],
  );
  return rows;
}
