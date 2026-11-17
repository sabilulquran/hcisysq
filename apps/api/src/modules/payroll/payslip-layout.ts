/**
 * PAY-003 payslip layout "Ditanggung yayasan" (specification section 7.6, owner
 * decision 2026-11-17).
 *
 * Pure: result lines in, what the slip shows out. The calculation keeps writing
 * the BPJS Kesehatan contribution the yayasan bears as an earning
 * (BPJS_KES_ALLOW) and an equal deduction (BPJS_KES), the way the legacy
 * spreadsheet does, so the parallel run still compares line by line. This file
 * only decides how a slip reads those lines: with the layout on, the pair leaves
 * the income and deduction lists and their totals, and is shown in a block of
 * its own beside PPh21 the yayasan bears. The same amount leaves both totals, so
 * net pay cannot move by a rupiah.
 *
 * The pair is recognised by component code, never by label, and only when both
 * sides are there and equal. Anything else is left where it was: a slip must not
 * guess which of two unequal figures was the employer's.
 */

/** The earning side of the pair: the contribution, paid by the yayasan, shown as income. */
export const HEALTH_ALLOWANCE_COMPONENT = "BPJS_KES_ALLOW";
/** The deduction side of the pair: the same contribution, taken out again. */
export const HEALTH_CONTRIBUTION_COMPONENT = "BPJS_KES";
/** PPh21 the yayasan bears (section 7.5), an EMPLOYER_COST line. */
export const EMPLOYER_PPH21_COMPONENT = "PPH21_EMPLOYER";

export type LayoutLine = { componentCode: string; category: string; amount: string | number };

function sumOf(lines: readonly LayoutLine[], componentCode: string, category: string): bigint {
  return lines
    .filter((line) => line.componentCode === componentCode && line.category === category)
    .reduce((total, line) => total + BigInt(line.amount), 0n);
}

/**
 * The BPJS Kesehatan contribution the yayasan bears on one result, when the slip
 * can tell: the allowance and the contribution are both there and equal. 0
 * otherwise, which leaves the result's lines exactly where they were.
 */
export function employerBorneHealthContribution(lines: readonly LayoutLine[]): bigint {
  const allowance = sumOf(lines, HEALTH_ALLOWANCE_COMPONENT, "EARNING");
  const contribution = sumOf(lines, HEALTH_CONTRIBUTION_COMPONENT, "DEDUCTION");
  return allowance > 0n && allowance === contribution ? allowance : 0n;
}

/** PPh21 the yayasan bears on one result; negative on a final masa pajak that returns over-withheld TER. */
export function employerBornePph21(lines: readonly LayoutLine[]): bigint {
  return sumOf(lines, EMPLOYER_PPH21_COMPONENT, "EMPLOYER_COST");
}

export type PayslipPresentation<Line extends LayoutLine> = {
  /** Lines listed as income, in the order given. */
  income: Line[];
  /** Lines listed as deductions, in the order given. */
  deductions: Line[];
  /** "Total pendapatan" and "Total potongan" as the slip states them. */
  gross: bigint;
  deductionTotal: bigint;
  /** The block "Ditanggung yayasan"; both 0 on the earlier layout. */
  employerHealthContribution: bigint;
  employerPph21: bigint;
};

/**
 * What one slip shows. With `employerBlock` off this is the earlier layout,
 * unchanged: every EARNING as income, every DEDUCTION as a deduction, the
 * result's own totals, and nothing in the block.
 */
export function presentPayslip<Line extends LayoutLine>(
  result: { gross: string | number; deductions: string | number },
  lines: readonly Line[],
  layout: { employerBlock: boolean },
): PayslipPresentation<Line> {
  const pair = layout.employerBlock ? employerBorneHealthContribution(lines) : 0n;
  const moved = pair > 0n;
  return {
    income: lines.filter(
      (line) => line.category === "EARNING" && !(moved && line.componentCode === HEALTH_ALLOWANCE_COMPONENT),
    ),
    deductions: lines.filter(
      (line) => line.category === "DEDUCTION" && !(moved && line.componentCode === HEALTH_CONTRIBUTION_COMPONENT),
    ),
    gross: BigInt(result.gross) - pair,
    deductionTotal: BigInt(result.deductions) - pair,
    employerHealthContribution: pair,
    employerPph21: layout.employerBlock ? employerBornePph21(lines) : 0n,
  };
}
