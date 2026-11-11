/**
 * PAY-003 PPh21 TER report for one masa pajak (specification sections 5.3 and 7).
 *
 * Pure and deterministic, like the engine: the rows and the policy come in, the
 * report goes out, and nothing here touches a database, a clock or a request.
 *
 * What it reports is what was actually paid (decision D9): the earnings of the
 * final result, less the BPJS Kesehatan allowance whose net effect is nil,
 * scaled by the same pay factor and rounded the same way as the payable. The
 * TER rate comes from the category the PTKP status maps to; no table value is
 * written here, they all come from the PPH21_TER policy row.
 *
 * Report only (DRAFT): the figure is not written back into the calculation as
 * a PPH21_EMPLOYER line, so parallel-run results stay comparable until the TER
 * policy has been verified and loaded.
 */

import { roundUpRupiah } from "./engine.js";
import { normalizePtkpStatus, type Pph21TerPolicy, type TerCategory } from "./policy.js";

/** Earnings that do not count towards the PPh21 base (section 3.1). */
export const PPH21_EXCLUDED_EARNINGS: readonly string[] = ["BPJS_KES_ALLOW"];

export type Pph21Flag = "PTKP_MISSING" | "EXCLUDED" | "ANNUAL_CALCULATION_REQUIRED";

/** One employee's latest result of the period, as the report needs it. */
export type Pph21SourceRow = {
  employmentId: string;
  employeeNumber: string;
  fullName: string;
  ptkpStatus: string | null;
  excluded: boolean;
  exclusionReason: string | null;
  payFactor: number;
  blockerCount: number;
  /** Last day of the employment, ISO date, or null while it runs. */
  serviceEndDate: string | null;
  earnings: ReadonlyArray<{ code: string; amount: number }>;
};

export type Pph21Row = {
  employmentId: string;
  employeeNumber: string;
  fullName: string;
  ptkpStatus: string | null;
  terCategory: TerCategory | null;
  gross: number;
  rate: number | null;
  tax: number | null;
  flags: Pph21Flag[];
  exclusionReason: string | null;
};

export type Pph21Report = {
  /** YYYY-MM, the masa pajak. */
  taxPeriod: string;
  objectCode: string;
  rows: Pph21Row[];
  totals: {
    /** Rows reported, that is every row not excluded. */
    employeeCount: number;
    gross: number;
    /** Sum of the rows whose tax could be determined. */
    tax: number;
    excludedCount: number;
    ptkpMissingCount: number;
    annualCalculationCount: number;
    /** Results that still carry a blocker: not paid, so not reported. */
    skippedBlockedCount: number;
  };
};

/** Binary floating point would turn 5000000 * 0.0125 into 62499.99999…; keep 15 digits like Excel. */
function clean(value: number): number {
  return Number.isFinite(value) ? Number(value.toPrecision(15)) : value;
}

/** The gross actually paid: earnings less the excluded ones, through the pay factor. */
export function reportableGross(row: Pick<Pph21SourceRow, "earnings" | "payFactor">): number {
  const earnings = row.earnings
    .filter((line) => !PPH21_EXCLUDED_EARNINGS.includes(line.code))
    .reduce((total, line) => total + line.amount, 0);
  // Same rounding as the payable in engine.finalize: ROUNDUP after the factor,
  // and untouched when there is no factor (specification section 5).
  return row.payFactor === 1 ? earnings : roundUpRupiah(earnings * row.payFactor);
}

/** First bracket whose upper bound reaches the gross; null upper bound has none. */
export function terRate(policy: Pph21TerPolicy, category: TerCategory, gross: number): number {
  const brackets = policy.categories[category];
  const bracket = brackets.find((candidate) => candidate.upTo === null || gross <= candidate.upTo);
  // The schema makes the last bracket open-ended, so one is always found.
  return (bracket ?? brackets[brackets.length - 1]!).rate;
}

/** PPh21 for one month: gross times the TER rate, down to a whole rupiah (DRAFT). */
export function terTax(gross: number, rate: number): number {
  if (gross <= 0) return 0;
  return Math.floor(clean(gross * rate));
}

export function terCategoryFor(policy: Pph21TerPolicy, ptkpStatus: string | null): TerCategory | null {
  if (ptkpStatus === null || ptkpStatus.trim().length === 0) return null;
  const wanted = normalizePtkpStatus(ptkpStatus);
  for (const [status, category] of Object.entries(policy.ptkpCategory)) {
    if (normalizePtkpStatus(status) === wanted) return category;
  }
  return null;
}

/**
 * The final masa pajak of a year, or of an employment, settles the year with the
 * annual Pasal 17 calculation rather than TER. That calculation is outside v1, so
 * the row keeps its TER figure and says it is not final (DRAFT).
 */
export function needsAnnualCalculation(
  period: { periodMonth: string; periodStart: string; periodEnd: string },
  serviceEndDate: string | null,
): boolean {
  if (period.periodMonth.slice(5, 7) === "12") return true;
  return serviceEndDate !== null && serviceEndDate >= period.periodStart && serviceEndDate <= period.periodEnd;
}

export function buildPph21Report(input: {
  period: { periodMonth: string; periodStart: string; periodEnd: string };
  policy: Pph21TerPolicy;
  rows: readonly Pph21SourceRow[];
}): Pph21Report {
  const { period, policy } = input;
  const rows: Pph21Row[] = [];
  let skippedBlockedCount = 0;

  for (const source of input.rows) {
    // A result with a blocker was not paid, so there is nothing to report on it.
    if (source.blockerCount > 0) {
      skippedBlockedCount += 1;
      continue;
    }
    const gross = reportableGross(source);
    const flags: Pph21Flag[] = [];
    const category = terCategoryFor(policy, source.ptkpStatus);
    let rate: number | null = null;
    let tax: number | null = null;

    if (source.excluded) {
      flags.push("EXCLUDED");
    } else if (category === null) {
      flags.push("PTKP_MISSING");
    } else {
      rate = terRate(policy, category, gross);
      tax = terTax(gross, rate);
    }
    if (needsAnnualCalculation(period, source.serviceEndDate)) flags.push("ANNUAL_CALCULATION_REQUIRED");

    rows.push({
      employmentId: source.employmentId,
      employeeNumber: source.employeeNumber,
      fullName: source.fullName,
      ptkpStatus: source.ptkpStatus,
      terCategory: source.excluded ? null : category,
      gross,
      rate,
      tax,
      flags,
      exclusionReason: source.excluded ? source.exclusionReason : null,
    });
  }

  const reported = rows.filter((row) => !row.flags.includes("EXCLUDED"));
  return {
    taxPeriod: period.periodMonth.slice(0, 7),
    objectCode: policy.objectCode,
    rows,
    totals: {
      employeeCount: reported.length,
      gross: reported.reduce((total, row) => total + row.gross, 0),
      tax: reported.reduce((total, row) => total + (row.tax ?? 0), 0),
      excludedCount: rows.length - reported.length,
      ptkpMissingCount: rows.filter((row) => row.flags.includes("PTKP_MISSING")).length,
      annualCalculationCount: reported.filter((row) => row.flags.includes("ANNUAL_CALCULATION_REQUIRED")).length,
      skippedBlockedCount,
    },
  };
}
