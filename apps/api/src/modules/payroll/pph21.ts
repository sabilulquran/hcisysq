/**
 * PAY-003 PPh21 TER report for one masa pajak (specification sections 5.3 and 7.2).
 *
 * Pure and deterministic, like the engine: the rows and the policy come in, the
 * report goes out, and nothing here touches a database, a clock or a request.
 *
 * What it reports is what was actually paid (decision D9): the earnings of the
 * final result, less the BPJS Kesehatan allowance whose net effect is nil,
 * scaled by the same pay factor and rounded the same way as the payable. TER is
 * a rate on a person's monthly gross, so one person with two employments in the
 * period is one row whose gross is the sum of both. The rate comes from the
 * category the PTKP status maps to; no table value is written here, they all
 * come from the PPH21_TER policy row.
 *
 * Report only (DRAFT): the figure is not written back into the calculation as
 * a PPH21_EMPLOYER line, so parallel-run results stay comparable until the TER
 * policy has been verified and loaded.
 */

import { roundUpRupiah } from "./engine.js";
import { normalizePtkpStatus, type Pph21TerPolicy, type TerCategory } from "./policy.js";

/** Earnings that do not count towards the PPh21 base (section 3.1). */
export const PPH21_EXCLUDED_EARNINGS: readonly string[] = ["BPJS_KES_ALLOW"];

/**
 * Terms paid per attendance and per teaching hour (section 5.2). Whether their
 * PPh21 belongs under 21-100-01 with monthly TER, or under the rule for pegawai
 * tidak tetap, is the process owner's call; the report only says which rows it is.
 */
export const NON_PERMANENT_TERM_CATEGORIES: readonly string[] = ["KONTRAK_HONORER", "LEPAS"];

export type Pph21Flag =
  | "PTKP_MISSING"
  | "PTKP_CONFLICT"
  | "EXCLUDED"
  | "ANNUAL_CALCULATION_REQUIRED"
  | "NON_PERMANENT_TERMS";

/** One employment's latest result of the period, as the report needs it. */
export type Pph21SourceRow = {
  employmentId: string;
  employeeId: string;
  employeeNumber: string;
  fullName: string;
  ptkpStatus: string | null;
  excluded: boolean;
  exclusionReason: string | null;
  payFactor: number;
  blockerCount: number;
  /** Last day of this employment, ISO date, or null while it runs. */
  serviceEndDate: string | null;
  /** Whether the person holds an employment with the same employer that runs past the period. */
  hasContinuingEmployment: boolean;
  /** EMP-005 term category on the pay date, or null when none resolves. */
  termCategory: string | null;
  earnings: ReadonlyArray<{ code: string; amount: number }>;
};

/** One person on the report. */
export type Pph21Row = {
  employeeId: string;
  employmentIds: string[];
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
  /** YYYY-MM, the masa pajak: the period month (DRAFT). */
  taxPeriod: string;
  objectCode: string;
  /** Reported people first, excluded people last, each in the order given. */
  rows: Pph21Row[];
  totals: {
    /** People reported, that is every row not excluded. */
    employeeCount: number;
    gross: number;
    /** Sum of the rows whose tax could be determined. */
    tax: number;
    excludedCount: number;
    /** Rows without one mapped PTKP status, missing or conflicting. */
    ptkpMissingCount: number;
    annualCalculationCount: number;
    nonPermanentCount: number;
    /** Employment results that still carry a blocker: not paid, so not reported. */
    skippedBlockedCount: number;
  };
};

/** Binary floating point would turn 5000000 * 0.0125 into 62499.99999…; keep 15 digits like Excel. */
function clean(value: number): number {
  return Number.isFinite(value) ? Number(value.toPrecision(15)) : value;
}

/** The gross actually paid on one employment: earnings less the excluded ones, through the pay factor. */
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
 * The final masa pajak of a year, or of a person's service, settles the year with
 * the annual Pasal 17 calculation rather than TER. That calculation is outside v1,
 * so the row keeps its TER figure and says it is not final (DRAFT). Ending one of
 * two employments does not end the person's service while the other continues.
 */
export function needsAnnualCalculation(
  period: { periodMonth: string; periodStart: string; periodEnd: string },
  serviceEndDates: ReadonlyArray<string | null>,
  hasContinuingEmployment: boolean,
): boolean {
  if (period.periodMonth.slice(5, 7) === "12") return true;
  if (hasContinuingEmployment) return false;
  return serviceEndDates.some(
    (end) => end !== null && end >= period.periodStart && end <= period.periodEnd,
  );
}

export function buildPph21Report(input: {
  period: { periodMonth: string; periodStart: string; periodEnd: string };
  policy: Pph21TerPolicy;
  rows: readonly Pph21SourceRow[];
}): Pph21Report {
  const { period, policy } = input;

  // One person, in the order their first employment arrives.
  const people = new Map<string, Pph21SourceRow[]>();
  for (const source of input.rows) {
    people.set(source.employeeId, [...(people.get(source.employeeId) ?? []), source]);
  }

  const rows: Pph21Row[] = [];
  let skippedBlockedCount = 0;

  for (const [employeeId, employments] of people) {
    // A result with a blocker was not paid, so there is nothing to report on it.
    const paid = employments.filter((source) => source.blockerCount === 0);
    skippedBlockedCount += employments.length - paid.length;
    if (paid.length === 0) continue;

    const first = paid[0]!;
    const gross = paid.reduce((total, source) => total + reportableGross(source), 0);
    const flags: Pph21Flag[] = [];

    // The exclusion is about the person, so any of their profiles saying so is
    // enough; its reason is the one shown (DRAFT).
    const exclusion = paid.find((source) => source.excluded);

    const statuses = new Map<string, string>();
    for (const source of paid) {
      if (source.ptkpStatus !== null && source.ptkpStatus.trim().length > 0) {
        statuses.set(normalizePtkpStatus(source.ptkpStatus), source.ptkpStatus.trim());
      }
    }
    const conflicting = statuses.size > 1;
    const ptkpStatus = statuses.size === 0 ? null : [...statuses.values()].join(" / ");
    const category = conflicting ? null : terCategoryFor(policy, ptkpStatus);

    let rate: number | null = null;
    let tax: number | null = null;
    if (exclusion) {
      flags.push("EXCLUDED");
    } else if (conflicting) {
      flags.push("PTKP_CONFLICT");
    } else if (category === null) {
      flags.push("PTKP_MISSING");
    } else {
      rate = terRate(policy, category, gross);
      tax = terTax(gross, rate);
    }
    if (
      needsAnnualCalculation(
        period,
        employments.map((source) => source.serviceEndDate),
        employments.some((source) => source.hasContinuingEmployment),
      )
    ) {
      flags.push("ANNUAL_CALCULATION_REQUIRED");
    }
    if (paid.some((source) => source.termCategory !== null && NON_PERMANENT_TERM_CATEGORIES.includes(source.termCategory))) {
      flags.push("NON_PERMANENT_TERMS");
    }

    rows.push({
      employeeId,
      employmentIds: paid.map((source) => source.employmentId),
      employeeNumber: first.employeeNumber,
      fullName: first.fullName,
      ptkpStatus,
      terCategory: exclusion ? null : category,
      gross,
      rate,
      tax,
      flags,
      exclusionReason: exclusion ? exclusion.exclusionReason : null,
    });
  }

  const reported = rows.filter((row) => !row.flags.includes("EXCLUDED"));
  const excluded = rows.filter((row) => row.flags.includes("EXCLUDED"));
  return {
    taxPeriod: period.periodMonth.slice(0, 7),
    objectCode: policy.objectCode,
    rows: [...reported, ...excluded],
    totals: {
      employeeCount: reported.length,
      gross: reported.reduce((total, row) => total + row.gross, 0),
      tax: reported.reduce((total, row) => total + (row.tax ?? 0), 0),
      excludedCount: excluded.length,
      ptkpMissingCount: reported.filter(
        (row) => row.flags.includes("PTKP_MISSING") || row.flags.includes("PTKP_CONFLICT"),
      ).length,
      annualCalculationCount: reported.filter((row) => row.flags.includes("ANNUAL_CALCULATION_REQUIRED")).length,
      nonPermanentCount: reported.filter((row) => row.flags.includes("NON_PERMANENT_TERMS")).length,
      skippedBlockedCount,
    },
  };
}
