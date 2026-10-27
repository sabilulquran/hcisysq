/**
 * PAY-003 period input storage (specification section 4).
 *
 * Every input records who entered it, where it came from, and the reason and
 * decision the specification requires for the ones that change pay by hand.
 */

import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { LATEST_RESULTS_OF_PERIOD, writeAudit } from "./store.js";

export const INPUT_KEYS = [
  "OVERTIME_HOURS",
  "CONTRACT_ATTENDANCE_DAYS",
  "CONTRACT_TEACHING_HOURS",
  "CHILD_EDUCATION",
  "PJ_MEDIA",
  "ARREARS",
  "ADJUSTMENT",
  "PRORATION_FACTOR",
  "FULL_PAY_DESPITE_LEAVING",
  "OTHER_INCOME",
  "TEACHING_HOURS_PER_WEEK_OVERRIDE",
  "ANNUAL_PERFORMANCE_OVERRIDE",
  "MONTHLY_PERFORMANCE_OVERRIDE",
] as const;

export type InputKey = (typeof INPUT_KEYS)[number];

export const INPUT_ORIGINS = ["ATTENDANCE", "MANUAL", "IMPORT"] as const;
export type InputOrigin = (typeof INPUT_ORIGINS)[number];

export type PeriodInputRow = {
  employmentId: string;
  inputKey: InputKey;
  value: string;
  origin: InputOrigin;
  reason: string | null;
  decisionReference: string | null;
  recordedAt: string;
};

export type PeriodInputWrite = {
  employmentId: string;
  inputKey: InputKey;
  value: number;
  origin: InputOrigin;
  reason?: string | null | undefined;
  decisionReference?: string | null | undefined;
};

export async function listInputs(pool: Pool, periodId: string): Promise<PeriodInputRow[]> {
  const { rows } = await pool.query<PeriodInputRow>(
    `SELECT employment_id AS "employmentId", input_key AS "inputKey", value, origin,
            reason, decision_reference AS "decisionReference", recorded_at AS "recordedAt"
     FROM payroll_period_inputs
     WHERE period_id = $1
     ORDER BY employment_id, input_key`,
    [periodId],
  );
  return rows;
}

/**
 * Writes the inputs of one period. Each row replaces the value for its
 * employment and key, so sending the same batch twice leaves the same state
 * rather than doubling anything.
 */
export async function saveInputs(
  pool: Pool,
  periodId: string,
  writes: readonly PeriodInputWrite[],
  actorAccountId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const write of writes) {
      await client.query(
        `INSERT INTO payroll_period_inputs(
           id, period_id, employment_id, input_key, value, origin, reason, decision_reference, recorded_by_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (period_id, employment_id, input_key) DO UPDATE SET
           value = EXCLUDED.value,
           origin = EXCLUDED.origin,
           reason = EXCLUDED.reason,
           decision_reference = EXCLUDED.decision_reference,
           recorded_by_account_id = EXCLUDED.recorded_by_account_id,
           recorded_at = now()`,
        [
          randomUUID(),
          periodId,
          write.employmentId,
          write.inputKey,
          write.value,
          write.origin,
          write.reason ?? null,
          write.decisionReference ?? null,
          actorAccountId,
        ],
      );
    }
    await writeAudit(client, {
      actorAccountId,
      action: "payroll.period.inputs_recorded",
      periodId,
      payload: {
        row_count: writes.length,
        input_keys: [...new Set(writes.map((write) => write.inputKey))].sort(),
      },
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteInput(
  pool: Pool,
  periodId: string,
  employmentId: string,
  inputKey: InputKey,
  actorAccountId: string,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rowCount } = await client.query(
      `DELETE FROM payroll_period_inputs
       WHERE period_id = $1 AND employment_id = $2 AND input_key = $3`,
      [periodId, employmentId, inputKey],
    );
    if (rowCount === 0) {
      await client.query("ROLLBACK");
      return false;
    }
    await writeAudit(client, {
      actorAccountId,
      action: "payroll.period.input_removed",
      periodId,
      employmentId,
      payload: { input_key: inputKey },
    });
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The employment rows that belong to the signed-in account's own employee
 * record. Nobody may record their own period inputs (specification section 2).
 */
export async function ownEmploymentIds(pool: Pool, accountId: string): Promise<Set<string>> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT e.id
     FROM employments e
     JOIN accounts a ON a.employee_id = e.employee_id
     WHERE a.id = $1`,
    [accountId],
  );
  return new Set(rows.map((row) => row.id));
}

export type ResultRow = {
  employmentId: string;
  revision: number;
  gross: string;
  deductions: string;
  net: string;
  payable: string;
  employerCost: string;
  payFactor: string;
  payFactorReason: string;
  bpjsBase: string;
  blockers: unknown;
  calculatedAt: string;
};

export type ResultLineRow = {
  employmentId: string;
  componentCode: string;
  category: string;
  amount: string;
  basis: string | null;
  displayOrder: number;
};

/** The latest revision of every employee in a period, with its lines. */
export async function listResults(
  pool: Pool,
  periodId: string,
): Promise<{ results: ResultRow[]; lines: ResultLineRow[] }> {
  const results = await pool.query<ResultRow>(
    `SELECT latest.employment_id AS "employmentId", latest.revision, latest.gross, latest.deductions,
            latest.net, latest.payable, latest.employer_cost AS "employerCost",
            latest.pay_factor AS "payFactor", latest.pay_factor_reason AS "payFactorReason",
            latest.bpjs_base AS "bpjsBase", latest.blockers, latest.calculated_at AS "calculatedAt"
     FROM (${LATEST_RESULTS_OF_PERIOD}) latest
     ORDER BY latest.employment_id`,
    [periodId],
  );
  const lines = await pool.query<ResultLineRow>(
    `SELECT latest.employment_id AS "employmentId", l.component_code AS "componentCode",
            l.category, l.amount, l.basis, l.display_order AS "displayOrder"
     FROM (${LATEST_RESULTS_OF_PERIOD}) latest
     JOIN payroll_result_lines l ON l.result_id = latest.id
     ORDER BY latest.employment_id, l.display_order`,
    [periodId],
  );
  return { results: results.rows, lines: lines.rows };
}
