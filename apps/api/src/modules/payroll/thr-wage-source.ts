/**
 * PAY-003-THR T5 (docs/domain/payroll-thr.md section 2.1): the wages an honorarium worker was
 * actually paid, read for the THR average.
 *
 * Holds the SQL only. Which components count, how the average is rounded and what happens when
 * months are missing are decided in thr.ts; this module answers two questions of fact: which
 * monthly periods of the window are approved and what they paid, and whether those periods still
 * stand when the THR period itself is approved.
 */

import type { PoolClient } from "pg";

import type { ThrPaidMonth } from "./thr.js";

/**
 * Section 2.1 H3: a salary period counts as paid from approval on. A period being worked on, or
 * reopened, is not read: its figures are not facts yet.
 */
export const THR_WAGE_SOURCE_STATES: readonly string[] = [
  "APPROVED",
  "PAYMENT_CONFIRMED",
  "PUBLISHED",
  "REOPEN_REQUESTED",
];

/** One approved salary period of the window, and the reopen count its figures were read at. */
export type ThrWageSourcePeriod = { id: string; month: string; reopenCount: number };

export type ThrPaidWages = {
  /** Approved salary periods of the window, oldest first. */
  periods: ThrWageSourcePeriod[];
  /** Latest approved result of each employment in each of those periods. */
  paidByEmployment: Map<string, ThrPaidMonth[]>;
};

/**
 * The approved monthly periods of the `windowLength` calendar months before the THR pay month,
 * for one legal entity, with what they paid the given employments. Earnings only: the average is
 * taken over gross wages (H4).
 *
 * Deliberately takes no row lock. A FOR SHARE here would be held for the whole calculate
 * transaction (minutes on a phone, for a few hundred employees) and would block a reopen or an
 * approval of any of the twelve salary periods for that long. It buys nothing, though not because
 * of snapshot consistency: the transaction runs at READ COMMITTED and this read is two statements,
 * so the periods and their lines come from two snapshots. The guarantee is structural instead. A
 * period in a readable state (APPROVED and beyond) cannot have its results rewritten — the only
 * writer of payroll_results runs for working periods only — and the only way out of those states
 * is a reopen, which increments reopen_count monotonically. Because reopen_count is read first,
 * any reopen that commits afterwards leaves the recorded count stale-low, and the mismatch is
 * caught where it matters: assertThrWageSourcesStand refuses to approve the THR period whose
 * figures it would have changed.
 */
export async function loadThrPaidWages(
  client: Pick<PoolClient, "query">,
  input: {
    legalEntityKey: string | null;
    /** The THR period's pay date; the window ends the month before its month. */
    payDate: string;
    windowLength: number;
    employmentIds: readonly string[];
  },
): Promise<ThrPaidWages> {
  const { rows: periods } = await client.query<ThrWageSourcePeriod>(
    `SELECT p.id, to_char(p.period_month, 'YYYY-MM') AS month, p.reopen_count AS "reopenCount"
     FROM payroll_periods p
     WHERE p.period_kind = 'REGULAR'
       AND p.state = ANY($3::text[])
       AND coalesce(p.legal_entity_key, '00000000-0000-0000-0000-000000000000'::uuid)
           = coalesce($1::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
       AND p.period_month < date_trunc('month', $2::date)::date
       AND p.period_month >= (date_trunc('month', $2::date) - make_interval(months => $4::int))::date
     ORDER BY p.period_month, p.id`,
    [input.legalEntityKey, input.payDate, THR_WAGE_SOURCE_STATES, input.windowLength],
  );

  const paidByEmployment = new Map<string, ThrPaidMonth[]>();
  if (periods.length === 0 || input.employmentIds.length === 0) return { periods, paidByEmployment };

  const monthOf = new Map(periods.map((period) => [period.id, period.month]));
  const { rows } = await client.query<{
    periodId: string;
    employmentId: string;
    payFactor: string;
    earnings: Array<{ code: string; amount: string | number }>;
  }>(
    `SELECT latest.period_id AS "periodId",
            latest.employment_id AS "employmentId",
            latest.pay_factor::text AS "payFactor",
            coalesce((
              SELECT jsonb_agg(jsonb_build_object('code', l.component_code, 'amount', l.amount::text))
              FROM payroll_result_lines l
              WHERE l.result_id = latest.id AND l.category = 'EARNING'
            ), '[]'::jsonb) AS earnings
     FROM payroll_periods source
     JOIN LATERAL (
       -- The last run of the period only, like every other reader of a period's results.
       SELECT DISTINCT ON (r.employment_id) r.*
       FROM payroll_results r
       WHERE r.period_id = source.id
         AND r.calculated_at = (SELECT max(x.calculated_at) FROM payroll_results x WHERE x.period_id = source.id)
       ORDER BY r.employment_id, r.revision DESC
     ) latest ON true
     WHERE source.id = ANY($1::uuid[])
       AND latest.employment_id = ANY($2::uuid[])
     ORDER BY source.period_month, latest.employment_id`,
    [periods.map((period) => period.id), input.employmentIds],
  );
  for (const row of rows) {
    const month = monthOf.get(row.periodId);
    if (!month) continue;
    const paid: ThrPaidMonth = {
      month,
      payFactor: Number(row.payFactor),
      earnings: row.earnings.map((line) => ({ code: line.code, amount: Number(line.amount) })),
    };
    paidByEmployment.set(row.employmentId, [...(paidByEmployment.get(row.employmentId) ?? []), paid]);
  }
  return { periods, paidByEmployment };
}

export class ThrAverageWageRefusal extends Error {
  constructor(
    readonly code: "PAYROLL_THR_AVERAGE_WAGE_STALE",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Called inside the transaction that approves a THR period. A result whose month of wages is the
 * system's average names the salary periods it read (input_snapshot.thr_average_wage.periods); if
 * one of them has since been reopened, the average rests on figures that are no longer facts, and
 * the approval is refused until the THR period is recalculated. A figure typed by human capital
 * rests on no period and is not checked.
 *
 * This is where the share lock belongs instead of on the calculation: it is taken for the few
 * statements of the approval, and it holds the source periods still between this check and the
 * commit that makes the THR period approved.
 */
export async function assertThrWageSourcesStand(client: Pick<PoolClient, "query">, thrPeriodId: string): Promise<void> {
  const { rows: sources } = await client.query<{ id: string; reopenCount: number }>(
    `SELECT DISTINCT (source ->> 'id')::uuid AS id, (source ->> 'reopenCount')::int AS "reopenCount"
     FROM (
       -- The last run of the THR period only (store.ts LATEST_RESULTS_OF_PERIOD; repeated here
       -- because store.ts imports this module).
       SELECT DISTINCT ON (r.employment_id) r.*
       FROM payroll_results r
       WHERE r.period_id = $1
         AND r.calculated_at = (SELECT max(x.calculated_at) FROM payroll_results x WHERE x.period_id = $1)
       ORDER BY r.employment_id, r.revision DESC
     ) latest
     CROSS JOIN LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(latest.input_snapshot #> '{thr_average_wage,periods}') = 'array'
            THEN latest.input_snapshot #> '{thr_average_wage,periods}' ELSE '[]'::jsonb END
     ) AS source
     WHERE latest.input_snapshot #>> '{thr_average_wage,source}' = 'SYSTEM'`,
    [thrPeriodId],
  );
  if (sources.length === 0) return;

  const { rows: standing } = await client.query<{ id: string; reopenCount: number }>(
    `SELECT p.id, p.reopen_count AS "reopenCount"
     FROM payroll_periods p
     WHERE p.id = ANY($1::uuid[]) AND p.state = ANY($2::text[])
     FOR SHARE OF p`,
    [sources.map((source) => source.id), THR_WAGE_SOURCE_STATES],
  );
  const standingCount = new Map(standing.map((period) => [period.id, period.reopenCount]));
  const stale = sources.filter((source) => standingCount.get(source.id) !== source.reopenCount);
  if (stale.length > 0) {
    throw new ThrAverageWageRefusal(
      "PAYROLL_THR_AVERAGE_WAGE_STALE",
      "Periode gaji yang menjadi dasar rata-rata upah THR sudah dibuka ulang sejak perhitungan terakhir; kembalikan dan hitung ulang periode THR ini sebelum disahkan.",
    );
  }
}
