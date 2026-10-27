/**
 * PAY-003 payroll reporting (specification section 7).
 *
 * Two reports, deliberately separate:
 *
 *  - the payroll report: totals per unit and per component, read by finance and
 *    the director, with no bank account anywhere in it;
 *  - the transfer list: one row per recipient with the account to pay into, read
 *    by finance alone.
 *
 * Splitting them is the point. One report carrying both would hand account
 * numbers to everyone who may read a total.
 *
 * A third view, the variance against the previous period, is the review screen's
 * own: it compares component totals per employee so a reviewer sees what moved.
 */

import type { Pool } from "pg";

import { quoteCsvCell } from "../../lib/csv.js";

/** Only the latest run of a period counts, as everywhere else. */
const LATEST_RESULTS = `
  SELECT DISTINCT ON (r.employment_id) r.*
  FROM payroll_results r
  WHERE r.period_id = $1
    AND r.calculated_at = (SELECT max(x.calculated_at) FROM payroll_results x WHERE x.period_id = $1)
  ORDER BY r.employment_id, r.revision DESC
`;

export type PeriodReport = {
  totals: {
    employeeCount: number;
    gross: string;
    deductions: string;
    net: string;
    payable: string;
    employerCost: string;
    blockerCount: number;
  };
  byUnit: Array<{ unitRef: string | null; employeeCount: number; payable: string }>;
  byComponent: Array<{ componentCode: string; category: string; employeeCount: number; amount: string }>;
};

export async function buildPeriodReport(pool: Pool, periodId: string): Promise<PeriodReport> {
  const totals = await pool.query<PeriodReport["totals"]>(
    `SELECT count(*)::int AS "employeeCount",
            coalesce(sum(latest.gross), 0)::text AS gross,
            coalesce(sum(latest.deductions), 0)::text AS deductions,
            coalesce(sum(latest.net), 0)::text AS net,
            coalesce(sum(latest.payable), 0)::text AS payable,
            coalesce(sum(latest.employer_cost), 0)::text AS "employerCost",
            coalesce(sum(jsonb_array_length(latest.blockers)), 0)::int AS "blockerCount"
     FROM (${LATEST_RESULTS}) latest`,
    [periodId],
  );

  // The unit comes from the profile the result was calculated from, not from
  // today's profile, so a report of a past period keeps reading as it was paid.
  const byUnit = await pool.query<PeriodReport["byUnit"][number]>(
    `SELECT p.unit_ref AS "unitRef",
            count(*)::int AS "employeeCount",
            coalesce(sum(latest.payable), 0)::text AS payable
     FROM (${LATEST_RESULTS}) latest
     LEFT JOIN payroll_compensation_profiles p ON p.id = latest.compensation_profile_id
     GROUP BY p.unit_ref
     ORDER BY p.unit_ref NULLS FIRST`,
    [periodId],
  );

  const byComponent = await pool.query<PeriodReport["byComponent"][number]>(
    `SELECT l.component_code AS "componentCode",
            l.category,
            count(*)::int AS "employeeCount",
            coalesce(sum(l.amount), 0)::text AS amount
     FROM (${LATEST_RESULTS}) latest
     JOIN payroll_result_lines l ON l.result_id = latest.id
     JOIN payroll_components c ON c.code = l.component_code
     GROUP BY l.component_code, l.category, c.display_order
     ORDER BY c.display_order`,
    [periodId],
  );

  return {
    totals: totals.rows[0] ?? {
      employeeCount: 0,
      gross: "0",
      deductions: "0",
      net: "0",
      payable: "0",
      employerCost: "0",
      blockerCount: 0,
    },
    byUnit: byUnit.rows,
    byComponent: byComponent.rows,
  };
}

export type TransferRow = {
  employeeNumber: string;
  fullName: string;
  unitRef: string | null;
  payable: string;
  bankAccountNumber: string | null;
  bankAccountName: string | null;
  paymentConfirmedAt: string | null;
};

/**
 * The transfer list. Only recipients with something to pay appear: a zero line
 * is not a transfer, and listing an account for it serves nobody.
 */
export async function buildTransferList(pool: Pool, periodId: string): Promise<TransferRow[]> {
  const { rows } = await pool.query<TransferRow>(
    `SELECT emp.employee_number AS "employeeNumber",
            emp.full_name AS "fullName",
            profile.unit_ref AS "unitRef",
            latest.payable::text AS payable,
            profile.bank_account_number AS "bankAccountNumber",
            profile.bank_account_name AS "bankAccountName",
            period.payment_confirmed_at AS "paymentConfirmedAt"
     FROM (${LATEST_RESULTS}) latest
     JOIN employments e ON e.id = latest.employment_id
     JOIN employees emp ON emp.id = e.employee_id
     JOIN payroll_periods period ON period.id = latest.period_id
     LEFT JOIN payroll_compensation_profiles profile ON profile.id = latest.compensation_profile_id
     WHERE latest.payable > 0
     ORDER BY emp.employee_number`,
    [periodId],
  );
  return rows;
}

const TRANSFER_HEADER = [
  "NIP",
  "Nama",
  "Unit",
  "Nominal dibayar",
  "Nomor rekening",
  "Nama pemilik rekening",
  "Konfirmasi bayar",
];

/** CSV for the finance transfer list (specification section 10 item 7). */
export function transferListToCsv(rows: readonly TransferRow[]): string {
  const lines = [TRANSFER_HEADER.map(quoteCsvCell).join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.employeeNumber,
        row.fullName,
        row.unitRef ?? "",
        row.payable,
        row.bankAccountNumber ?? "",
        row.bankAccountName ?? "",
        row.paymentConfirmedAt ?? "",
      ]
        .map((cell) => quoteCsvCell(String(cell)))
        .join(","),
    );
  }
  // A trailing newline, so appending to the file later starts on its own line.
  return `${lines.join("\n")}\n`;
}

export type VarianceRow = {
  employmentId: string;
  componentCode: string | null;
  previousAmount: string;
  currentAmount: string;
  delta: string;
  kind: "COMPONENT" | "NEW_EMPLOYEE" | "LEAVING_EMPLOYEE";
};

export type VarianceThreshold = { relative: number; absolute: number };

/**
 * What moved since the previous period, per employee and component. A component
 * has to clear both an absolute and a relative gap to be reported, so a small
 * component does not fill the screen (specification section 10 item 6).
 *
 * Someone who appears or disappears between the two periods is reported as such
 * rather than as a hundred component changes.
 */
export async function buildVariance(
  pool: Pool,
  periodId: string,
  previousPeriodId: string,
  threshold: VarianceThreshold,
): Promise<VarianceRow[]> {
  const { rows } = await pool.query<VarianceRow>(
    `WITH current_latest AS (
       SELECT DISTINCT ON (r.employment_id) r.*
       FROM payroll_results r
       WHERE r.period_id = $1
         AND r.calculated_at = (SELECT max(x.calculated_at) FROM payroll_results x WHERE x.period_id = $1)
       ORDER BY r.employment_id, r.revision DESC
     ), previous_latest AS (
       SELECT DISTINCT ON (r.employment_id) r.*
       FROM payroll_results r
       WHERE r.period_id = $2
         AND r.calculated_at = (SELECT max(x.calculated_at) FROM payroll_results x WHERE x.period_id = $2)
       ORDER BY r.employment_id, r.revision DESC
     ), current_lines AS (
       SELECT c.employment_id, l.component_code, sum(l.amount) AS amount
       FROM current_latest c JOIN payroll_result_lines l ON l.result_id = c.id
       GROUP BY c.employment_id, l.component_code
     ), previous_lines AS (
       SELECT p.employment_id, l.component_code, sum(l.amount) AS amount
       FROM previous_latest p JOIN payroll_result_lines l ON l.result_id = p.id
       GROUP BY p.employment_id, l.component_code
     ), joined AS (
       SELECT coalesce(c.employment_id, p.employment_id) AS employment_id,
              coalesce(c.component_code, p.component_code) AS component_code,
              coalesce(p.amount, 0) AS previous_amount,
              coalesce(c.amount, 0) AS current_amount
       FROM current_lines c
       FULL OUTER JOIN previous_lines p
         ON p.employment_id = c.employment_id AND p.component_code = c.component_code
     )
     SELECT employment_id AS "employmentId",
            component_code AS "componentCode",
            previous_amount::text AS "previousAmount",
            current_amount::text AS "currentAmount",
            (current_amount - previous_amount)::text AS delta,
            CASE
              WHEN NOT EXISTS (SELECT 1 FROM previous_latest p WHERE p.employment_id = joined.employment_id)
                THEN 'NEW_EMPLOYEE'
              WHEN NOT EXISTS (SELECT 1 FROM current_latest c WHERE c.employment_id = joined.employment_id)
                THEN 'LEAVING_EMPLOYEE'
              ELSE 'COMPONENT'
            END AS kind
     FROM joined
     WHERE abs(current_amount - previous_amount) > $3
       AND (
         previous_amount = 0
         OR abs(current_amount - previous_amount)::numeric / abs(previous_amount) > $4
       )
     ORDER BY employment_id, component_code`,
    [periodId, previousPeriodId, threshold.absolute, threshold.relative],
  );

  // One row per employee for the two lifecycle cases: a new or departing
  // employee is one fact, not one per component they happen to have.
  const seenWholeEmployee = new Set<string>();
  return rows.flatMap((row) => {
    if (row.kind === "COMPONENT") return [row];
    if (seenWholeEmployee.has(row.employmentId)) return [];
    seenWholeEmployee.add(row.employmentId);
    return [{ ...row, componentCode: null }];
  });
}

/** The period immediately before this one, for the same legal entity. */
export async function previousPeriodId(pool: Pool, periodId: string): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT prev.id
     FROM payroll_periods current_period
     JOIN payroll_periods prev
       ON coalesce(prev.legal_entity_key, '00000000-0000-0000-0000-000000000000'::uuid)
          = coalesce(current_period.legal_entity_key, '00000000-0000-0000-0000-000000000000'::uuid)
      AND prev.period_month < current_period.period_month
     WHERE current_period.id = $1
     ORDER BY prev.period_month DESC
     LIMIT 1`,
    [periodId],
  );
  return rows[0]?.id ?? null;
}
