/**
 * REIMB-001 section 9 (payroll-calculation-v1.md section 3.6): reimbursements
 * handed to payroll, paid as the non-taxable component REIMBURSE.
 *
 * Same shape as the LOAN-001 link (employee-loan-link.ts), three moments inside
 * the transaction that owns the period:
 *
 * 1. calculate (only while REIMBURSEMENT_PAYROLL_HANDOFF_ENABLED=1): PENDING
 *    handoffs of the period month whose employee the period pays are bound to
 *    the period and summed per employee; the engine pays them outside the pay
 *    factor. Handoffs bound earlier but no longer paid are released.
 * 2. approve: every PENDING handoff bound to the period settles. A claim still
 *    VERIFIED becomes PAID with its single immutable PAYROLL payment; a claim
 *    already PAID through this period (a re-approval after reopen) keeps its
 *    payment. The approval is refused when the slips and the handoffs disagree.
 * 3. approve_reopen: settled handoffs are REVERSED and a new PENDING handoff
 *    carries each reimbursement into the recalculation. The payment is never
 *    touched (reimbursement payments are append-only, REIMB-001 D-10).
 *
 * Settlement and reversal follow the data, not the switch. No amount reaches
 * an event, a notification or an audit payload (REIMB-001 D-12, section 8).
 */

import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { notifyEmployee } from "../notifications/service.js";

export class ReimbursementSettlementRefusal extends Error {
  constructor(
    readonly code: "PAYROLL_REIMBURSEMENT_CHANGED",
    message: string,
  ) {
    super(message);
  }
}

async function addClaimEvent(
  client: PoolClient,
  claimId: string,
  actorAccountId: string,
  eventType: string,
  note: string | null,
  metadata: Record<string, string | number | null>,
) {
  await client.query(
    `INSERT INTO reimbursement_events (id, claim_id, event_type, actor_account_id, note, metadata, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, clock_timestamp())`,
    [randomUUID(), claimId, eventType, actorAccountId, note, JSON.stringify(metadata)],
  );
}

/**
 * Step 1. Returns the reimbursement to pay per employee of this period.
 * Switched off it only releases handoffs this period holds (which exist only if
 * it was once on), so a period that never saw the switch on is not touched.
 */
export async function bindReimbursementHandoffs(
  client: PoolClient,
  period: { id: string; periodMonth: string },
  employeeIds: readonly string[],
  enabled: boolean,
): Promise<Map<string, number>> {
  // Release first: someone who left the run since the last calculation must not
  // keep a handoff bound to a period that no longer pays it.
  await client.query(
    `UPDATE reimbursement_payroll_handoffs SET period_id = NULL
     WHERE period_id = $1 AND status = 'PENDING'`,
    [period.id],
  );
  const owed = new Map<string, number>();
  if (!enabled || employeeIds.length === 0) return owed;

  const { rows } = await client.query<{ employeeId: string; amount: string }>(
    `WITH bound AS (
       UPDATE reimbursement_payroll_handoffs h SET period_id = $1
       FROM reimbursement_claims c
       WHERE c.id = h.claim_id
         AND h.status = 'PENDING'
         AND h.period_id IS NULL
         AND h.payroll_month = date_trunc('month', $2::date)::date
         AND c.employee_id = ANY($3::uuid[])
         AND c.status IN ('VERIFIED', 'PAID')
       RETURNING c.employee_id, h.amount
     )
     SELECT employee_id AS "employeeId", sum(amount)::text AS amount FROM bound GROUP BY employee_id`,
    [period.id, period.periodMonth, employeeIds],
  );
  for (const row of rows) owed.set(row.employeeId, Number(row.amount));
  return owed;
}

type BoundHandoff = {
  handoffId: string;
  claimId: string;
  employeeId: string;
  amount: string;
  claimStatus: string;
  verifiedTotal: string | null;
  paymentId: string | null;
  paymentPeriodMonth: string | null;
};

/**
 * Step 2, called by applyTransition("approve"). The slips are the authority:
 * the REIMBURSE lines of the latest results must equal, per employee, the
 * handoffs bound to the period. Any difference (a claim paid in cash or
 * rejected after the calculation) refuses the approval rather than paying a
 * figure the slip does not show.
 */
export async function settleReimbursementHandoffs(
  client: PoolClient,
  period: { id: string; periodMonth: string; payDate: string },
  actorAccountId: string,
): Promise<{ settled: number }> {
  const { rows } = await client.query<BoundHandoff>(
    `SELECT h.id AS "handoffId", c.id AS "claimId", c.employee_id AS "employeeId", h.amount::text AS amount,
            c.status AS "claimStatus", c.verified_total::text AS "verifiedTotal",
            pay.id AS "paymentId", to_char(pay.payroll_month, 'YYYY-MM') AS "paymentPeriodMonth"
     FROM reimbursement_payroll_handoffs h
     JOIN reimbursement_claims c ON c.id = h.claim_id
     LEFT JOIN reimbursement_payments pay ON pay.claim_id = c.id
     WHERE h.period_id = $1 AND h.status = 'PENDING'
     ORDER BY c.id
     FOR UPDATE OF c, h`,
    [period.id],
  );
  const slips = await client.query<{ employeeId: string; amount: string }>(
    `SELECT e.employee_id AS "employeeId", sum(l.amount)::text AS amount
     -- The last run only, the same reading the lifecycle and the reports use:
     -- someone who left the population keeps an older revision as history.
     FROM payroll_results r
     JOIN employments e ON e.id = r.employment_id
     JOIN payroll_result_lines l ON l.result_id = r.id AND l.component_code = 'REIMBURSE'
     WHERE r.period_id = $1
       AND r.calculated_at = (SELECT max(x.calculated_at) FROM payroll_results x WHERE x.period_id = $1)
     GROUP BY e.employee_id`,
    [period.id],
  );

  const month = period.periodMonth.slice(0, 7);
  const handedOff = new Map<string, bigint>();
  for (const row of rows) {
    const payable = row.claimStatus === "VERIFIED" && row.verifiedTotal === row.amount;
    const alreadyPaidHere = row.claimStatus === "PAID" && row.paymentPeriodMonth === month;
    if (!payable && !alreadyPaidHere) {
      throw new ReimbursementSettlementRefusal(
        "PAYROLL_REIMBURSEMENT_CHANGED",
        "Klaim reimbursement berubah setelah periode dihitung; kembalikan periode lalu hitung ulang.",
      );
    }
    handedOff.set(row.employeeId, (handedOff.get(row.employeeId) ?? 0n) + BigInt(row.amount));
  }
  const onSlips = new Map(slips.rows.map((row) => [row.employeeId, BigInt(row.amount)]));
  const everyone = new Set([...handedOff.keys(), ...onSlips.keys()]);
  for (const employeeId of everyone) {
    if ((handedOff.get(employeeId) ?? 0n) !== (onSlips.get(employeeId) ?? 0n)) {
      throw new ReimbursementSettlementRefusal(
        "PAYROLL_REIMBURSEMENT_CHANGED",
        "Penggantian biaya di slip tidak sama dengan klaim yang diserahkan; kembalikan periode lalu hitung ulang.",
      );
    }
  }

  for (const row of rows) {
    let paymentId = row.paymentId;
    if (row.claimStatus === "VERIFIED") {
      paymentId = randomUUID();
      await client.query(
        `INSERT INTO reimbursement_payments (
           id, claim_id, amount, paid_on, method, payroll_month, reference, note, idempotency_key,
           recorded_by_account_id)
         VALUES ($1, $2, $3::bigint, LEAST($4::date, (now() AT TIME ZONE 'Asia/Jakarta')::date), 'PAYROLL',
                 date_trunc('month', $5::date)::date, $6, $7, $8, $9)`,
        [
          paymentId,
          row.claimId,
          row.amount,
          period.payDate,
          period.periodMonth,
          `Payroll ${month}`,
          "Dicatat otomatis saat periode payroll disahkan.",
          randomUUID(),
          actorAccountId,
        ],
      );
      await client.query(
        `UPDATE reimbursement_claims SET status = 'PAID', paid_at = now(), updated_at = now() WHERE id = $1`,
        [row.claimId],
      );
      await addClaimEvent(client, row.claimId, actorAccountId, "reimbursement.paid", null, {
        paymentId,
        method: "PAYROLL",
        payrollMonth: month,
        source: "payroll",
        payrollPeriodId: period.id,
      });
      await notifyEmployee(client, row.employeeId, {
        eventKey: `reimbursement.${row.claimId}.paid`,
        category: "system",
        title: "Reimbursement dibayar",
        body: `Klaim reimbursement Anda dibayarkan bersama gaji bulan ${month}.`,
        href: `/app/reimbursements?claim=${row.claimId}`,
        actorAccountId,
      });
    }
    await client.query(
      `UPDATE reimbursement_payroll_handoffs
          SET status = 'SETTLED', settled_at = clock_timestamp(), payment_id = $2
        WHERE id = $1`,
      [row.handoffId, paymentId],
    );
  }
  return { settled: rows.length };
}

/**
 * Step 3, called by applyTransition("approve_reopen"). The payment stays: a
 * reopen revises the slip, it does not undo a payment already made
 * (payroll-calculation-v1.md section 6). What is reversed is the handoff, and a
 * new PENDING handoff keeps the reimbursement on the recalculated slip.
 */
export async function reverseReimbursementHandoffs(
  client: PoolClient,
  period: { id: string; periodMonth: string },
  actorAccountId: string,
): Promise<{ reversed: number }> {
  const { rows } = await client.query<{
    handoffId: string;
    claimId: string;
    amount: string;
    payrollMonth: string;
  }>(
    `SELECT h.id AS "handoffId", h.claim_id AS "claimId", h.amount::text AS amount,
            to_char(h.payroll_month, 'YYYY-MM-DD') AS "payrollMonth"
     FROM reimbursement_payroll_handoffs h
     WHERE h.period_id = $1 AND h.status = 'SETTLED'
     ORDER BY h.claim_id
     FOR UPDATE`,
    [period.id],
  );
  const reason = `Periode payroll ${period.periodMonth.slice(0, 7)} dibuka ulang; penggantian biaya ikut dihitung ulang.`;
  for (const row of rows) {
    await client.query(
      `UPDATE reimbursement_payroll_handoffs
          SET status = 'REVERSED', closed_at = clock_timestamp(), closed_by_account_id = $2, close_reason = $3
        WHERE id = $1`,
      [row.handoffId, actorAccountId, reason],
    );
    await client.query(
      `INSERT INTO reimbursement_payroll_handoffs (
         id, claim_id, payroll_month, amount, status, period_id, idempotency_key, created_by_account_id)
       VALUES ($1, $2, $3::date, $4::bigint, 'PENDING', $5, $6, $7)`,
      [randomUUID(), row.claimId, row.payrollMonth, row.amount, period.id, randomUUID(), actorAccountId],
    );
    await addClaimEvent(client, row.claimId, actorAccountId, "reimbursement.payroll_reopened", reason, {
      handoffId: row.handoffId,
      payrollPeriodId: period.id,
    });
  }
  return { reversed: rows.length };
}
