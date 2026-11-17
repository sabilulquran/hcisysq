/**
 * LOAN-001 Package 2 (employee-loans.md section 9, payroll-calculation-v1.md
 * section 3.5): LOAN-001 instalments deducted through PAY-003.
 *
 * Three moments, each inside the transaction that already owns the period:
 *
 * 1. calculate (only while LOAN_PAYROLL_DEDUCTION_ENABLED=1): every DISBURSED
 *    LOAN-001 loan of someone in the period gets a mirror row in the kasbon
 *    register (payroll_loans.employee_loan_id), and the instalment due in the
 *    period month is proposed as that period's deduction (origin PROPOSED).
 *    A deduction Finance set by hand (origin MANUAL) is never overwritten.
 * 2. approve: every deduction on a mirrored loan becomes one LOAN-001 payment
 *    PAYROLL_DEDUCTION with source (period, loan), unique while ACTIVE, so a
 *    repeat cannot double it. Settlement is driven by the deductions, not by
 *    the switch: whatever the approved slip deducts is what the loan records.
 * 3. approve_reopen: those payments are reversed (D-12) with an automatic
 *    reason; re-approval writes them afresh.
 *
 * No amount is written to an event, notification or audit payload (LOAN-001
 * D-15, payroll-calculation-v1.md section 8).
 */

import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { notifyEmployee } from "../notifications/service.js";

export type ScheduledInstalment = { dueMonth: string; amount: bigint };

/**
 * The part of the instalment due in the period month that is still unpaid
 * under LOAN-001 D-11 (payments fill the oldest instalment first), capped by
 * the balance. Earlier instalments that are overdue are not swept into this
 * month: catching up is Finance's decision, made by hand (section 3.5, DRAFT).
 * Pure and exact: bigint rupiah only.
 */
export function proposedInstalmentDeduction(input: {
  periodMonth: string;
  principal: bigint;
  paidBefore: bigint;
  instalments: readonly ScheduledInstalment[];
}): bigint {
  const month = input.periodMonth.slice(0, 7);
  let dueThrough = 0n;
  let dueThisMonth = 0n;
  for (const instalment of input.instalments) {
    const due = instalment.dueMonth.slice(0, 7);
    if (due <= month) dueThrough += instalment.amount;
    if (due === month) dueThisMonth += instalment.amount;
  }
  const owed = dueThrough - input.paidBefore;
  if (owed <= 0n || dueThisMonth === 0n) return 0n;
  const balance = input.principal - input.paidBefore;
  let proposal = owed < dueThisMonth ? owed : dueThisMonth;
  if (proposal > balance) proposal = balance;
  return proposal > 0n ? proposal : 0n;
}

type LinkedLoanRow = {
  employeeLoanId: string;
  payrollLoanId: string;
  principal: string;
  paidOther: string;
  deductionId: string | null;
  deductionOrigin: string | null;
};

/**
 * Step 1. Called by calculatePeriod with the period row locked.
 *
 * Switched off, the only thing this does is drop proposals this period holds
 * (a proposal made while the switch was on is not Finance's decision), so a
 * period that never saw the switch on is not touched at all.
 */
export async function syncEmployeeLoanDeductions(
  client: PoolClient,
  period: { id: string; periodMonth: string },
  employeeIds: readonly string[],
  actorAccountId: string,
  enabled: boolean,
): Promise<{ proposed: number; mirrored: number }> {
  if (!enabled) {
    await client.query(
      "DELETE FROM payroll_loan_deductions WHERE period_id = $1 AND origin = 'PROPOSED'",
      [period.id],
    );
    return { proposed: 0, mirrored: 0 };
  }
  // Every proposal is derived afresh. A proposal left over from an earlier run
  // (the employee has since left the run, or the loan was paid off in cash)
  // would otherwise survive with no slip line behind it and be settled on
  // approval, or block the period against a zero balance.
  await client.query(
    "DELETE FROM payroll_loan_deductions WHERE period_id = $1 AND origin = 'PROPOSED'",
    [period.id],
  );
  if (employeeIds.length === 0) return { proposed: 0, mirrored: 0 };

  // Lock the LOAN-001 loans first, in id order, so a manual payment recorded
  // in the same instant waits for this run and the balance read below holds.
  await client.query(
    `SELECT id FROM employee_loans
     WHERE employee_id = ANY($1::uuid[]) AND status = 'DISBURSED'
     ORDER BY id FOR UPDATE`,
    [employeeIds],
  );

  const mirrored = await client.query(
    `INSERT INTO payroll_loans(
       id, employee_id, granted_on, principal, instalment, note, recorded_by_account_id, employee_loan_id)
     SELECT gen_random_uuid(), loan.employee_id, loan.disbursed_on, loan.principal_amount,
            (SELECT i.amount FROM employee_loan_instalments i WHERE i.loan_id = loan.id ORDER BY i.sequence LIMIT 1),
            'LOAN-001', $2, loan.id
     FROM employee_loans loan
     WHERE loan.employee_id = ANY($1::uuid[]) AND loan.status = 'DISBURSED'
     ON CONFLICT (employee_loan_id) DO NOTHING`,
    [employeeIds, actorAccountId],
  );

  const { rows } = await client.query<LinkedLoanRow>(
    `SELECT loan.id AS "employeeLoanId", mirror.id AS "payrollLoanId",
            loan.principal_amount::text AS principal,
            (loan.paid_total - coalesce((
               SELECT sum(p.amount) FROM employee_loan_payments p
               WHERE p.loan_id = loan.id AND p.status = 'ACTIVE' AND p.source_payroll_period_id = $2
             ), 0))::text AS "paidOther",
            d.id AS "deductionId", d.origin AS "deductionOrigin"
     FROM employee_loans loan
     JOIN payroll_loans mirror ON mirror.employee_loan_id = loan.id
     LEFT JOIN payroll_loan_deductions d ON d.loan_id = mirror.id AND d.period_id = $2
     WHERE loan.employee_id = ANY($1::uuid[]) AND loan.status = 'DISBURSED'
     ORDER BY loan.id`,
    [employeeIds, period.id],
  );

  let proposed = 0;
  for (const row of rows) {
    if (row.deductionOrigin === "MANUAL") continue;
    const instalments = await client.query<{ dueMonth: string; amount: string }>(
      `SELECT to_char(due_month, 'YYYY-MM-DD') AS "dueMonth", amount::text AS amount
       FROM employee_loan_instalments WHERE loan_id = $1 ORDER BY sequence`,
      [row.employeeLoanId],
    );
    const amount = proposedInstalmentDeduction({
      periodMonth: period.periodMonth,
      principal: BigInt(row.principal),
      paidBefore: BigInt(row.paidOther),
      instalments: instalments.rows.map((instalment) => ({
        dueMonth: instalment.dueMonth,
        amount: BigInt(instalment.amount),
      })),
    });
    if (amount === 0n) {
      if (row.deductionId) await client.query("DELETE FROM payroll_loan_deductions WHERE id = $1", [row.deductionId]);
      continue;
    }
    await client.query(
      `INSERT INTO payroll_loan_deductions(id, loan_id, period_id, amount, recorded_by_account_id, origin)
       VALUES ($1, $2, $3, $4::bigint, $5, 'PROPOSED')
       ON CONFLICT (loan_id, period_id) DO UPDATE SET
         amount = EXCLUDED.amount, recorded_by_account_id = EXCLUDED.recorded_by_account_id, recorded_at = now()
       WHERE payroll_loan_deductions.origin = 'PROPOSED'`,
      [randomUUID(), row.payrollLoanId, period.id, amount.toString(), actorAccountId],
    );
    proposed += 1;
  }
  return { proposed, mirrored: mirrored.rowCount ?? 0 };
}

export class LoanSettlementRefusal extends Error {
  constructor(
    readonly code: "PAYROLL_LOAN_BALANCE_CHANGED",
    message: string,
  ) {
    super(message);
  }
}

type SettlementRow = {
  employeeLoanId: string;
  employeeId: string;
  amount: string;
  principal: string;
  paidTotal: string;
  status: string;
  existingPaymentId: string | null;
  approverIsBorrower: boolean | null;
};

async function addLoanEvent(
  client: PoolClient,
  loanId: string,
  actorAccountId: string,
  eventType: string,
  note: string | null,
  metadata: Record<string, string | number | null>,
) {
  await client.query(
    `INSERT INTO employee_loan_events (id, loan_id, event_type, actor_account_id, note, metadata, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, clock_timestamp())`,
    [randomUUID(), loanId, eventType, actorAccountId, note, JSON.stringify(metadata)],
  );
}

/**
 * Step 2. Called by applyTransition("approve") inside its transaction. Throws
 * LoanSettlementRefusal when a loan no longer has room for the deduction (a
 * cash payment or a reversal happened after the calculation); the director
 * then returns the period and HC recalculates. Nothing is capped silently: the
 * slip and the loan must show the same figure.
 */
export async function settleEmployeeLoanDeductions(
  client: PoolClient,
  period: { id: string; periodMonth: string; payDate: string },
  actorAccountId: string,
): Promise<{ settled: number }> {
  const { rows } = await client.query<SettlementRow>(
    `SELECT loan.id AS "employeeLoanId", loan.employee_id AS "employeeId", d.amount::text AS amount,
            loan.principal_amount::text AS principal, loan.paid_total::text AS "paidTotal", loan.status,
            (SELECT p.id FROM employee_loan_payments p
             WHERE p.loan_id = loan.id AND p.source_payroll_period_id = $1 AND p.status = 'ACTIVE') AS "existingPaymentId",
            loan.employee_id = (SELECT a.employee_id FROM accounts a WHERE a.id = $2) AS "approverIsBorrower"
     FROM payroll_loan_deductions d
     JOIN payroll_loans mirror ON mirror.id = d.loan_id AND mirror.employee_loan_id IS NOT NULL
     JOIN employee_loans loan ON loan.id = mirror.employee_loan_id
     WHERE d.period_id = $1
       -- Only what a slip of this period actually deducted: the employee has a
       -- result in the period. A deduction for someone the period does not pay
       -- produced no LOAN line, so it must not become a loan payment either.
       AND EXISTS (
         SELECT 1 FROM payroll_results r JOIN employments e ON e.id = r.employment_id
         WHERE r.period_id = $1 AND e.employee_id = loan.employee_id)
     ORDER BY loan.id
     FOR UPDATE OF loan`,
    [period.id, actorAccountId],
  );

  const month = period.periodMonth.slice(0, 7);
  let settled = 0;
  for (const row of rows) {
    // Idempotent: the period already settled this loan.
    if (row.existingPaymentId) continue;
    const amount = BigInt(row.amount);
    // A MANUAL zero is Finance skipping the month: nothing was deducted.
    if (amount === 0n) continue;
    const balance = BigInt(row.principal) - BigInt(row.paidTotal);
    if (row.status !== "DISBURSED" || amount > balance) {
      throw new LoanSettlementRefusal(
        "PAYROLL_LOAN_BALANCE_CHANGED",
        "Sisa pinjaman pegawai berubah setelah periode dihitung; kembalikan periode lalu hitung ulang.",
      );
    }
    const paidAfter = BigInt(row.paidTotal) + amount;
    const status = paidAfter === BigInt(row.principal) ? "PAID_OFF" : "DISBURSED";
    const paymentId = randomUUID();
    await client.query(
      `INSERT INTO employee_loan_payments (
         id, loan_id, amount, paid_on, method, reference, note, idempotency_key,
         recorded_by_account_id, recorded_at, source_payroll_period_id)
       -- The pay date, but never a future date: approval can come before payday,
       -- and LOAN-001 never records a payment ahead of today (D-10).
       VALUES ($1, $2, $3::bigint, LEAST($4::date, (now() AT TIME ZONE 'Asia/Jakarta')::date),
               'PAYROLL_DEDUCTION', $5, $6, $7, $8, clock_timestamp(), $9)`,
      [
        paymentId,
        row.employeeLoanId,
        amount.toString(),
        period.payDate,
        `Payroll ${month}`,
        "Dicatat otomatis saat periode payroll disahkan.",
        randomUUID(),
        actorAccountId,
        period.id,
      ],
    );
    await client.query(
      `UPDATE employee_loans
          SET paid_total = $2::bigint, status = $3,
              paid_off_at = CASE WHEN $3 = 'PAID_OFF' THEN now() ELSE NULL END, updated_at = now()
        WHERE id = $1`,
      [row.employeeLoanId, paidAfter.toString(), status],
    );
    await addLoanEvent(client, row.employeeLoanId, actorAccountId, "loan.payment.recorded", null, {
      paymentId,
      method: "PAYROLL_DEDUCTION",
      paidOn: period.payDate,
      source: "payroll",
      payrollPeriodId: period.id,
      // D-14 cannot apply (the payment follows an approved slip), so the case
      // where the approving director settles their own loan is marked instead.
      approverIsBorrower: row.approverIsBorrower ? 1 : 0,
    });
    if (status === "PAID_OFF") {
      await addLoanEvent(client, row.employeeLoanId, actorAccountId, "loan.paid_off", null, {});
    }
    await notifyEmployee(client, row.employeeId, {
      eventKey: `loan.payment.${paymentId}`,
      category: "system",
      title: status === "PAID_OFF" ? "Pinjaman lunas" : "Potongan cicilan pinjaman dicatat",
      body: status === "PAID_OFF"
        ? "Pinjaman Anda tercatat lunas lewat potongan gaji."
        : `Cicilan pinjaman Anda dipotong dari gaji ${month}. Lihat sisa pinjaman di detail.`,
      href: `/app/loans?loan=${row.employeeLoanId}`,
      actorAccountId,
    });
    settled += 1;
  }
  return { settled };
}

/**
 * Step 3. Called by applyTransition("approve_reopen"). Reverses, never
 * deletes (LOAN-001 D-12): the history keeps both the payment and its reversal.
 */
export async function reverseEmployeeLoanSettlements(
  client: PoolClient,
  period: { id: string; periodMonth: string },
  actorAccountId: string,
): Promise<{ reversed: number }> {
  const { rows } = await client.query<{
    paymentId: string;
    loanId: string;
    employeeId: string;
    amount: string;
    paidTotal: string;
    status: string;
  }>(
    // Loans before payments, the order the LOAN-001 routes lock in.
    `WITH locked AS (
       SELECT loan.id FROM employee_loans loan
       WHERE loan.id IN (SELECT p.loan_id FROM employee_loan_payments p
                         WHERE p.source_payroll_period_id = $1 AND p.status = 'ACTIVE')
       ORDER BY loan.id FOR UPDATE
     )
     SELECT p.id AS "paymentId", loan.id AS "loanId", loan.employee_id AS "employeeId",
            p.amount::text AS amount,
            loan.paid_total::text AS "paidTotal", loan.status
     FROM employee_loan_payments p
     JOIN employee_loans loan ON loan.id = p.loan_id
     WHERE p.source_payroll_period_id = $1 AND p.status = 'ACTIVE'
       AND loan.id IN (SELECT id FROM locked)
     ORDER BY loan.id
     FOR UPDATE OF p`,
    [period.id],
  );
  const month = period.periodMonth.slice(0, 7);
  const reason = `Periode payroll ${month} dibuka ulang; potongan dicatat lagi saat periode disahkan kembali.`;
  for (const row of rows) {
    // Taking a positive payment away always leaves a balance, so a loan this
    // period had paid off is open again.
    const paidAfter = BigInt(row.paidTotal) - BigInt(row.amount);
    await client.query(
      `UPDATE employee_loan_payments
          SET status = 'REVERSED', reversed_by_account_id = $2, reversed_at = clock_timestamp(), reverse_reason = $3
        WHERE id = $1`,
      [row.paymentId, actorAccountId, reason],
    );
    await client.query(
      `UPDATE employee_loans
          SET paid_total = $2::bigint, status = 'DISBURSED', paid_off_at = NULL, updated_at = now()
        WHERE id = $1`,
      [row.loanId, paidAfter.toString()],
    );
    await addLoanEvent(client, row.loanId, actorAccountId, "loan.payment.reversed", reason, {
      paymentId: row.paymentId,
      previousStatus: row.status,
      source: "payroll",
      payrollPeriodId: period.id,
    });
    await notifyEmployee(client, row.employeeId, {
      eventKey: `loan.payment.${row.paymentId}.reversed`,
      category: "system",
      title: "Potongan cicilan pinjaman dibuka ulang",
      body: `Periode gaji ${month} dibuka ulang; potongan cicilannya dicatat lagi setelah periode disahkan kembali.`,
      href: `/app/loans?loan=${row.loanId}`,
      actorAccountId,
    });
  }
  return { reversed: rows.length };
}
