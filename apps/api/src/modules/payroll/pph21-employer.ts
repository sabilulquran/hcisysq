/**
 * PAY-003 PPH21_EMPLOYER: PPh21 borne by the yayasan, as an EMPLOYER_COST line
 * on the result (specification section 7.5, decision P6).
 *
 * Pure: the period's rows, the TER table, the switches and, for a final masa
 * pajak, the earlier months of the year come in; the line per employment goes
 * out. Written only when PPH21_SETTINGS.employerBorne is on, which it is not by
 * default, so parallel-run results stay exactly as they were.
 *
 * The amount is the tax the monthly report computes for the person: daily TER
 * under 21-100-03 for a pegawai tidak tetap when P10 is on, monthly TER under
 * 21-100-01 otherwise, and on the final masa pajak the annual Pasal 17
 * settlement (annual tax less the TER of the earlier months, negative when TER
 * took too much). The line sits on the person's first paid employment. Borne
 * tax is not grossed up into the employee's income (DRAFT).
 */

import { buildPph21Report, type Pph21SourceRow } from "./pph21.js";
import { annualMonthsOfPeriod, buildAnnualSegments, type AnnualMonth } from "./pph21-annual.js";
import {
  PPH21_NON_PERMANENT_OBJECT_CODE,
  type Pph21AnnualPolicy,
  type Pph21Settings,
  type Pph21TerPolicy,
} from "./policy.js";

export type EmployerPph21Line = { amount: number; basis: string };

export function employerPph21Lines(input: {
  period: { periodMonth: string; periodStart: string; periodEnd: string };
  terPolicy: Pph21TerPolicy;
  settings: Pph21Settings;
  rows: readonly Pph21SourceRow[];
  /** The annual policy and the final-period months of the year before this one, or null without a policy. */
  annual: { policy: Pph21AnnualPolicy; priorMonths: readonly AnnualMonth[] } | null;
}): Map<string, EmployerPph21Line> {
  const lines = new Map<string, EmployerPph21Line>();
  if (!input.settings.employerBorne) return lines;

  const report = buildPph21Report({ period: input.period, policy: input.terPolicy, rows: input.rows, settings: input.settings });
  for (const row of report.rows) {
    if (row.flags.includes("EXCLUDED") || row.tax === null) continue;
    const employmentId = row.employmentIds[0];
    if (employmentId === undefined) continue;

    let amount = row.tax;
    let basis = `TER ${row.objectCode}`;
    if (row.objectCode === PPH21_NON_PERMANENT_OBJECT_CODE) {
      basis = `TER harian ${row.objectCode}`;
    } else if (row.flags.includes("ANNUAL_CALCULATION_REQUIRED")) {
      basis = "TER; perhitungan tahunan belum lengkap";
      if (input.annual) {
        const own = input.rows.filter((source) => source.employeeId === row.employeeId);
        const current = annualMonthsOfPeriod({
          period: input.period,
          rows: own,
          terTaxByEmployee: new Map([[row.employeeId, row.tax]]),
          policy: input.annual.policy,
        });
        const prior = input.annual.priorMonths.filter((month) => month.employeeId === row.employeeId);
        const segments = buildAnnualSegments(input.annual.policy, [...prior, ...current]);
        const last = segments[segments.length - 1];
        if (last && last.closed && last.finalMasaTax !== null) {
          amount = last.finalMasaTax;
          basis = "Pasal 17 masa pajak terakhir";
        }
      }
    }
    if (amount !== 0) lines.set(employmentId, { amount, basis });
  }
  return lines;
}
