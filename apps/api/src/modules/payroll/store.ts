/**
 * PAY-003 period storage. Holds the SQL; every rule it applies comes from
 * lifecycle.ts, so the decisions stay testable without a database.
 */

import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { defaultCutoffWindow, monthEnd, type PeriodAction, type PeriodState } from "./lifecycle.js";

export type PeriodRow = {
  id: string;
  legalEntityKey: string | null;
  periodMonth: string;
  payDate: string;
  periodStart: string;
  periodEnd: string;
  cutoffStart: string;
  cutoffEnd: string;
  state: PeriodState;
  stateBeforeReopenRequest: PeriodState | null;
  submittedByAccountId: string | null;
  submittedAt: string | null;
  approvedByAccountId: string | null;
  approvedAt: string | null;
  paymentConfirmedAt: string | null;
  publishedAt: string | null;
  reopenCount: number;
  version: number;
};

export type PeriodWithCalculation = PeriodRow & {
  resultCount: number;
  blockerCount: number;
  lastCalculatedAt: string | null;
  lastInputRecordedAt: string | null;
};

const PERIOD_COLUMNS = `
  p.id,
  p.legal_entity_key AS "legalEntityKey",
  to_char(p.period_month, 'YYYY-MM-DD') AS "periodMonth",
  to_char(p.pay_date, 'YYYY-MM-DD') AS "payDate",
  to_char(p.period_start, 'YYYY-MM-DD') AS "periodStart",
  to_char(p.period_end, 'YYYY-MM-DD') AS "periodEnd",
  to_char(p.cutoff_start, 'YYYY-MM-DD') AS "cutoffStart",
  to_char(p.cutoff_end, 'YYYY-MM-DD') AS "cutoffEnd",
  p.state,
  p.state_before_reopen_request AS "stateBeforeReopenRequest",
  p.submitted_by_account_id AS "submittedByAccountId",
  p.submitted_at AS "submittedAt",
  p.approved_by_account_id AS "approvedByAccountId",
  p.approved_at AS "approvedAt",
  p.payment_confirmed_at AS "paymentConfirmedAt",
  p.published_at AS "publishedAt",
  p.reopen_count AS "reopenCount",
  p.version
`;

/**
 * The calculation summary a lifecycle decision needs: how many rows the last run
 * produced, how many blockers stand, and whether any input was recorded after
 * that run (specification section 5.4, the period-level stale-input blocker).
 */
const CALCULATION_SUMMARY = `
  (SELECT count(*)::int FROM payroll_results r WHERE r.period_id = p.id) AS "resultCount",
  (SELECT coalesce(sum(jsonb_array_length(r.blockers)), 0)::int
     FROM payroll_results r WHERE r.period_id = p.id) AS "blockerCount",
  (SELECT max(r.calculated_at) FROM payroll_results r WHERE r.period_id = p.id) AS "lastCalculatedAt",
  (SELECT max(i.recorded_at) FROM payroll_period_inputs i WHERE i.period_id = p.id) AS "lastInputRecordedAt"
`;

export type CreatePeriodInput = {
  periodMonth: string;
  payDate?: string | undefined;
  cutoffStart?: string | undefined;
  cutoffEnd?: string | undefined;
  legalEntityKey?: string | null | undefined;
  actorAccountId: string;
};

export async function createPeriod(pool: Pool, input: CreatePeriodInput): Promise<PeriodRow> {
  const cutoff = defaultCutoffWindow(input.periodMonth);
  const periodEnd = monthEnd(input.periodMonth);
  // The legacy pay date is the 25th; human capital may move it per period.
  const payDate = input.payDate ?? `${input.periodMonth.slice(0, 7)}-25`;
  const id = randomUUID();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<PeriodRow>(
      `INSERT INTO payroll_periods(
         id, legal_entity_key, period_month, pay_date, period_start, period_end,
         cutoff_start, cutoff_end, created_by_account_id)
       VALUES ($1, $2, $3::date, $4::date, $3::date, $5::date, $6::date, $7::date, $8)
       RETURNING ${PERIOD_COLUMNS.replace(/\bp\./g, "")}`,
      [
        id,
        input.legalEntityKey ?? null,
        input.periodMonth,
        payDate,
        periodEnd,
        input.cutoffStart ?? cutoff.start,
        input.cutoffEnd ?? cutoff.end,
        input.actorAccountId,
      ],
    );
    await writeAudit(client, {
      actorAccountId: input.actorAccountId,
      action: "payroll.period.created",
      periodId: id,
      payload: { period_month: input.periodMonth },
    });
    await client.query("COMMIT");
    return rows[0]!;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listPeriods(pool: Pool, limit: number, offset: number): Promise<PeriodWithCalculation[]> {
  const { rows } = await pool.query<PeriodWithCalculation>(
    `SELECT ${PERIOD_COLUMNS}, ${CALCULATION_SUMMARY}
     FROM payroll_periods p
     ORDER BY p.period_month DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows;
}

export async function getPeriod(pool: Pool, periodId: string): Promise<PeriodWithCalculation | null> {
  const { rows } = await pool.query<PeriodWithCalculation>(
    `SELECT ${PERIOD_COLUMNS}, ${CALCULATION_SUMMARY} FROM payroll_periods p WHERE p.id = $1`,
    [periodId],
  );
  return rows[0] ?? null;
}

/**
 * A calculation counts as current when it exists and no input was recorded after
 * it. A period with no employee at all has nothing to submit, so it is not current.
 */
export function hasCurrentCalculation(period: PeriodWithCalculation): boolean {
  if (period.resultCount === 0 || period.lastCalculatedAt === null) return false;
  if (period.lastInputRecordedAt === null) return true;
  return new Date(period.lastInputRecordedAt) <= new Date(period.lastCalculatedAt);
}

export type AuditEntry = {
  actorAccountId: string | null;
  action: string;
  periodId: string | null;
  employmentId?: string | null;
  /**
   * Identifiers, counts, states and period aggregates only. A per-person amount,
   * a bank account or an identity number is rejected by the schema itself
   * (specification section 8).
   */
  payload: Record<string, unknown>;
};

export async function writeAudit(client: PoolClient, entry: AuditEntry): Promise<void> {
  await client.query(
    `INSERT INTO payroll_audit_events(id, actor_account_id, action, period_id, employment_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      randomUUID(),
      entry.actorAccountId,
      entry.action,
      entry.periodId,
      entry.employmentId ?? null,
      JSON.stringify(entry.payload),
    ],
  );
}

export type ApplyTransitionInput = {
  periodId: string;
  action: PeriodAction;
  nextState: PeriodState;
  auditAction: string;
  actorAccountId: string;
  reason: string | null;
  /** The version the decision was made against; a mismatch means someone else moved first. */
  expectedVersion: number;
  blockerCount: number;
};

export type ApplyTransitionResult = { applied: boolean; period: PeriodRow | null };

/**
 * Writes one transition. The version check makes a concurrent second click a
 * no-op rather than a double move, which is what idempotent means here.
 */
export async function applyTransition(
  pool: Pool,
  input: ApplyTransitionInput,
): Promise<ApplyTransitionResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const assignments: string[] = ["state = $2", "version = version + 1"];
    const values: unknown[] = [input.periodId, input.nextState, input.expectedVersion];

    const push = (fragment: string, value: unknown) => {
      values.push(value);
      assignments.push(fragment.replace("$n", `$${values.length}`));
    };

    switch (input.action) {
      case "submit":
        push("submitted_by_account_id = $n", input.actorAccountId);
        assignments.push("submitted_at = now()");
        break;
      case "approve":
        push("approved_by_account_id = $n", input.actorAccountId);
        assignments.push("approved_at = now()");
        break;
      case "confirm_payment":
        push("payment_confirmed_by_account_id = $n", input.actorAccountId);
        assignments.push("payment_confirmed_at = now()");
        break;
      case "publish":
        assignments.push("published_at = now()");
        break;
      case "request_reopen":
        assignments.push("state_before_reopen_request = state");
        break;
      case "approve_reopen":
        assignments.push("state_before_reopen_request = NULL", "reopen_count = reopen_count + 1");
        break;
      case "reject_reopen":
        assignments.push("state_before_reopen_request = NULL");
        break;
      case "return":
        // A returned period drops the submission, so the next submitter is recorded afresh.
        assignments.push("submitted_by_account_id = NULL", "submitted_at = NULL");
        break;
      default:
        break;
    }

    const { rows } = await client.query<PeriodRow>(
      `UPDATE payroll_periods SET ${assignments.join(", ")}
       WHERE id = $1 AND version = $3
       RETURNING ${PERIOD_COLUMNS.replace(/\bp\./g, "")}`,
      values,
    );

    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return { applied: false, period: null };
    }

    await writeAudit(client, {
      actorAccountId: input.actorAccountId,
      action: input.auditAction,
      periodId: input.periodId,
      payload: {
        state: input.nextState,
        blocker_count: input.blockerCount,
        ...(input.reason === null ? {} : { reason_given: true }),
      },
    });

    await client.query("COMMIT");
    return { applied: true, period: rows[0]! };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
