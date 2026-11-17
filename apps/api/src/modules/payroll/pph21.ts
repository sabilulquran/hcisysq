/**
 * PAY-003 PPh21 TER report for one masa pajak (specification sections 5.3 and 7.2).
 *
 * Pure and deterministic, like the engine: the rows and the policy come in, the
 * report goes out, and nothing here touches a database, a clock or a request.
 *
 * What it reports is what was actually paid (decision D9): the earnings of the
 * final result, scaled by the same pay factor and rounded the same way as the
 * payable. The BPJS Kesehatan allowance nets to nil for the employee and is the
 * premium the yayasan pays for them: it stays out of the base unless
 * PPH21_SETTINGS.employerHealthPremiumTaxable is in force for the masa pajak
 * (owner decision 2026-11-17, sections 5.3 and 7.6), and then it joins the gross
 * whole, outside the pay factor, because the yayasan pays the full month. TER is
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
import {
  DEFAULT_PPH21_SETTINGS,
  normalizePtkpStatus,
  PPH21_NON_PERMANENT_OBJECT_CODE,
  type Pph21Settings,
  type Pph21TerPolicy,
  type TerCategory,
} from "./policy.js";

/**
 * The earning that is the BPJS Kesehatan premium the yayasan pays for the
 * employee. The extra-family 1% (BPJS_KES_EXTRA) is deducted from the employee
 * for real, so it is not an employer-paid premium and is not part of this.
 */
export const EMPLOYER_HEALTH_PREMIUM_COMPONENT = "BPJS_KES_ALLOW";

/**
 * Earnings that are not pay scaled by the pay factor (section 3.1). The premium
 * is counted separately, by employerHealthPremium, when the setting says so.
 */
export const PPH21_EXCLUDED_EARNINGS: readonly string[] = [
  EMPLOYER_HEALTH_PREMIUM_COMPONENT,
  // Penggantian biaya repays an expense the employee already paid; it is not
  // income (section 3.6, REIMB-001 section 9).
  "REIMBURSE",
];

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
  | "NON_PERMANENT_TERMS"
  /** Daily TER (21-100-03) is on, but the month has no attendance days to average over. */
  | "DAILY_DAYS_MISSING"
  /** Average daily gross above the policy ceiling: the Pasal 17 rule applies, not computed in v1. */
  | "DAILY_ABOVE_CEILING"
  /** Daily TER is on, but the person also has a permanent employment this month: monthly TER for the whole gross. */
  | "MIXED_TERMS"
  // PAY-003-THR T10: the month's gross includes a THR paid in it.
  | "INCLUDES_THR";

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
  /** DEDUCTION lines; the annual calculation reads the pension contribution from them. */
  deductions?: ReadonlyArray<{ code: string; amount: number }>;
  /** CONTRACT_ATTENDANCE_DAYS of the period, the divisor of daily TER (section 7.5). */
  attendanceDays?: number | null;
  /** PAY-003-THR T10: which period of the masa pajak the row comes from. Absent means REGULAR. */
  periodKind?: "REGULAR" | "THR";
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
  /** 21-100-01, or 21-100-03 when the row is taxed with daily TER. */
  objectCode: string;
  /** Attendance days the daily TER averaged over, null on monthly TER. */
  attendanceDays: number | null;
  /**
   * The employer-paid BPJS Kesehatan premium inside `gross`; 0 while
   * PPH21_SETTINGS.employerHealthPremiumTaxable is not in force (section 7.6).
   */
  employerHealthPremium: number;
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
    /** Rows taxed with daily TER under 21-100-03. */
    dailyCount: number;
    /** Employer-paid BPJS Kesehatan premium inside `gross`, 0 while the setting is off. */
    employerHealthPremium: number;
    /** Employment results that still carry a blocker: not paid, so not reported. */
    skippedBlockedCount: number;
  };
};

/** Binary floating point would turn 5000000 * 0.0125 into 62499.99999…; keep 15 digits like Excel. */
function clean(value: number): number {
  return Number.isFinite(value) ? Number(value.toPrecision(15)) : value;
}

/** Which optional parts of the PPh21 base are in force for the masa pajak. */
export type Pph21BaseOptions = Pick<Pph21Settings, "employerHealthPremiumTaxable">;

/** The pay actually paid on one employment: earnings less the excluded ones, through the pay factor. */
export function paidEarnings(row: Pick<Pph21SourceRow, "earnings" | "payFactor">): number {
  const earnings = row.earnings
    .filter((line) => !PPH21_EXCLUDED_EARNINGS.includes(line.code))
    .reduce((total, line) => total + line.amount, 0);
  // Same rounding as the payable in engine.finalize: ROUNDUP after the factor,
  // and untouched when there is no factor (specification section 5).
  return row.payFactor === 1 ? earnings : roundUpRupiah(earnings * row.payFactor);
}

/**
 * The BPJS Kesehatan premium the yayasan paid for one employment, as taxable
 * income: the whole allowance line when the setting is in force, otherwise 0.
 * Not scaled by the pay factor (DRAFT S1): the yayasan pays the full month's
 * contribution even when the salary is prorated or paid at the early-service rate.
 */
export function employerHealthPremium(
  row: Pick<Pph21SourceRow, "earnings">,
  options: Pph21BaseOptions = DEFAULT_PPH21_SETTINGS,
): number {
  if (!options.employerHealthPremiumTaxable) return 0;
  return row.earnings
    .filter((line) => line.code === EMPLOYER_HEALTH_PREMIUM_COMPONENT)
    .reduce((total, line) => total + line.amount, 0);
}

/** The reportable gross of one employment (section 5.3): pay actually paid, plus the taxable premium. */
export function reportableGross(
  row: Pick<Pph21SourceRow, "earnings" | "payFactor">,
  options: Pph21BaseOptions = DEFAULT_PPH21_SETTINGS,
): number {
  return paidEarnings(row) + employerHealthPremium(row, options);
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
  /** PPH21_SETTINGS in force; omitted means both switches off (section 7.5). */
  settings?: Pph21Settings;
}): Pph21Report {
  const { period, policy } = input;
  const settings = input.settings ?? DEFAULT_PPH21_SETTINGS;

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
    const gross = paid.reduce((total, source) => total + reportableGross(source, settings), 0);
    const premium = paid.reduce((total, source) => total + employerHealthPremium(source, settings), 0);
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

    const isNonPermanent = (source: Pph21SourceRow) =>
      source.termCategory !== null && NON_PERMANENT_TERM_CATEGORIES.includes(source.termCategory);
    const nonPermanent = paid.some(isNonPermanent);
    const dailyOn = settings.nonPermanentDailyTer && settings.daily !== null;
    // P10 switched on: a pegawai tidak tetap is taxed per attendance day under
    // 21-100-03, which needs no PTKP and has no annual settlement (section 7.5).
    // Only when every paid employment is non-permanent: a permanent salary in the
    // same month is never divided by honorarium days (review 2026-11-17).
    const daily = dailyOn && paid.every(isNonPermanent) ? settings.daily : null;
    if (dailyOn && nonPermanent && !daily) flags.push("MIXED_TERMS");
    const attendanceDays = daily
      ? paid.reduce((total, source) => total + (source.attendanceDays ?? 0), 0)
      : null;

    let rate: number | null = null;
    let tax: number | null = null;
    if (exclusion) {
      flags.push("EXCLUDED");
    } else if (daily) {
      if (!attendanceDays || attendanceDays <= 0) {
        flags.push("DAILY_DAYS_MISSING");
      } else {
        const perDay = gross / attendanceDays;
        if (daily.dailyCeiling !== null && perDay > daily.dailyCeiling) {
          flags.push("DAILY_ABOVE_CEILING");
        } else {
          rate = (daily.brackets.find((bracket) => bracket.upTo === null || perDay <= bracket.upTo) ??
            daily.brackets[daily.brackets.length - 1]!).rate;
          // Every day falls in the same layer as the average, so gross × rate is
          // the sum of the daily taxes (DRAFT: the average stands for each day).
          tax = terTax(gross, rate);
        }
      }
    } else if (conflicting) {
      flags.push("PTKP_CONFLICT");
    } else if (category === null) {
      flags.push("PTKP_MISSING");
    } else {
      rate = terRate(policy, category, gross);
      tax = terTax(gross, rate);
    }
    if (
      !daily &&
      needsAnnualCalculation(
        period,
        employments.map((source) => source.serviceEndDate),
        employments.some((source) => source.hasContinuingEmployment),
      )
    ) {
      flags.push("ANNUAL_CALCULATION_REQUIRED");
    }
    if (nonPermanent) flags.push("NON_PERMANENT_TERMS");
    if (paid.some((source) => source.periodKind === "THR")) {
      flags.push("INCLUDES_THR");
    }

    rows.push({
      employeeId,
      // One employment appears twice when its salary and its THR share the masa pajak.
      employmentIds: [...new Set(paid.map((source) => source.employmentId))],
      employeeNumber: first.employeeNumber,
      fullName: first.fullName,
      ptkpStatus,
      terCategory: exclusion || daily ? null : category,
      gross,
      rate,
      tax,
      flags,
      exclusionReason: exclusion ? exclusion.exclusionReason : null,
      objectCode: daily ? daily.objectCode : policy.objectCode,
      attendanceDays,
      employerHealthPremium: premium,
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
      dailyCount: reported.filter((row) => row.objectCode === PPH21_NON_PERMANENT_OBJECT_CODE).length,
      employerHealthPremium: reported.reduce((total, row) => total + row.employerHealthPremium, 0),
      skippedBlockedCount,
    },
  };
}
