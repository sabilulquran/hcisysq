/**
 * PAY-003 PPh21 for the final masa pajak: the annual Pasal 17 calculation and
 * the bukti potong 1721-A1 it produces (specification section 7.4; PP 58/2023,
 * PMK 168/2023).
 *
 * Pure and deterministic, like pph21.ts: the months come in, the segments go
 * out, and nothing here touches a database, a clock or a request.
 *
 * During the year each month is taxed with TER (pph21.ts). The final masa pajak
 * of a year (December) or of a person's service (the month the employment ends)
 * settles the whole span instead: the year's gross, less biaya jabatan and the
 * employee's own pension contribution, less PTKP, taxed with the Pasal 17
 * layers; what TER already took in the earlier months of the span is subtracted,
 * and the remainder (negative when TER took too much) is the final month's tax.
 *
 * One span is one bukti potong. A person who leaves and returns within the year
 * has two spans, each closed by its own final masa (DRAFT).
 */

import type { A1LineKey, Pph21AnnualPolicy } from "./policy.js";
import { A1_LINE_KEYS, normalizePtkpStatus } from "./policy.js";
import { needsAnnualCalculation, PPH21_EXCLUDED_EARNINGS, reportableGross, type Pph21SourceRow } from "./pph21.js";

/**
 * Default A1 line per EARNING component (DRAFT). Unlisted earnings are
 * "tunjangan lainnya, uang lembur dan sejenisnya"; the policy may override any.
 */
export const DEFAULT_A1_LINE_BY_COMPONENT: Readonly<Record<string, A1LineKey>> = {
  BASIC: "salary",
  TEACH_FEE: "honorarium",
  PJ_MEDIA: "honorarium",
  THR: "bonusThr",
  BONUS: "bonusThr",
};

export type A1Lines = Record<A1LineKey, number>;

export function emptyA1Lines(): A1Lines {
  return Object.fromEntries(A1_LINE_KEYS.map((key) => [key, 0])) as A1Lines;
}

/** Binary floating point would turn 5000000 * 0.0125 into 62499.99999…; keep 15 digits like Excel. */
function clean(value: number): number {
  return Number.isFinite(value) ? Number(value.toPrecision(15)) : value;
}

/**
 * One employment's paid earnings split into A1 lines. The lines add up to
 * exactly reportableGross: with a pay factor each line is scaled and rounded
 * down, and the rupiah the rounding leaves goes to the largest line.
 */
export function a1LinesOf(
  row: Pick<Pph21SourceRow, "earnings" | "payFactor">,
  lineByComponent: Readonly<Record<string, A1LineKey>> = {},
): A1Lines {
  const lines = emptyA1Lines();
  for (const earning of row.earnings) {
    if (PPH21_EXCLUDED_EARNINGS.includes(earning.code)) continue;
    const line = lineByComponent[earning.code] ?? DEFAULT_A1_LINE_BY_COMPONENT[earning.code] ?? "otherAllowances";
    lines[line] += row.payFactor === 1 ? earning.amount : Math.floor(clean(earning.amount * row.payFactor));
  }
  const target = reportableGross(row);
  const sum = A1_LINE_KEYS.reduce((total, key) => total + lines[key], 0);
  if (sum !== target) {
    const largest = A1_LINE_KEYS.reduce((best, key) => (lines[key] > lines[best] ? key : best), A1_LINE_KEYS[0]);
    lines[largest] += target - sum;
  }
  return lines;
}

/**
 * The employee's own pension / JHT contribution on one employment. The pay factor
 * scales net pay (engine.finalize), so the deduction actually taken is the stored
 * amount times the factor; it is rounded down, never deducting more than was taken (DRAFT).
 */
export function pensionContributionOf(
  deductions: ReadonlyArray<{ code: string; amount: number }>,
  components: readonly string[],
  payFactor = 1,
): number {
  const total = deductions.filter((line) => components.includes(line.code)).reduce((sum, line) => sum + line.amount, 0);
  return payFactor === 1 ? total : Math.floor(clean(total * payFactor));
}

/**
 * PTKP for a status written "TK/n" or "K/n" (no spaces, any case), with n
 * capped at the policy's maximum. Any other form, "K/I/n" included, is not
 * guessed: it answers null and the segment is flagged (DRAFT).
 */
export function ptkpAmount(policy: Pph21AnnualPolicy, status: string | null): number | null {
  if (status === null) return null;
  const match = /^(TK|K)\/(\d{1,2})$/.exec(normalizePtkpStatus(status));
  if (!match) return null;
  const dependents = Math.min(Number(match[2]), policy.ptkp.maxDependents);
  return policy.ptkp.taxpayer + (match[1] === "K" ? policy.ptkp.married : 0) + dependents * policy.ptkp.perDependent;
}

/** Biaya jabatan: the rate of gross, capped per month of the span and per year. */
export function positionCost(policy: Pph21AnnualPolicy, gross: number, monthCount: number): number {
  if (gross <= 0) return 0;
  return Math.min(
    Math.floor(clean(gross * policy.positionCost.rate)),
    policy.positionCost.monthlyCap * monthCount,
    policy.positionCost.annualCap,
  );
}

/** Pasal 17 layers on PKP, down to a whole rupiah (DRAFT, like TER). */
export function pasal17Tax(policy: Pph21AnnualPolicy, pkp: number): number {
  let tax = 0;
  let lower = 0;
  for (const bracket of policy.brackets) {
    if (pkp <= lower) break;
    const upper = bracket.upTo ?? Number.POSITIVE_INFINITY;
    tax += (Math.min(pkp, upper) - lower) * bracket.rate;
    lower = upper;
  }
  return Math.floor(clean(tax));
}

export type AnnualFlag =
  /** The span has not reached its final masa pajak yet; the figures so far are not a bukti potong. */
  | "OPEN"
  /** No PTKP for the status at the start of the span. */
  | "PTKP_MISSING"
  /** An earlier month's TER tax is unknown (no TER policy, or no PTKP that month). */
  | "PRIOR_TAX_INCOMPLETE"
  /** A period of the year up to the end of the span is not final: its month is missing, so no bukti potong. */
  | "PERIOD_PENDING";

/**
 * A period of the year that is not final (never approved, or reopened) leaves its
 * month out of every span. A span ending on or after such a month may be missing
 * pay and TER, so it is flagged and no bukti potong is made from it until the
 * period is final again (review 2026-11-17).
 */
export function flagPendingPeriods(segments: readonly AnnualSegment[], pendingMonths: readonly string[]): AnnualSegment[] {
  return segments.map((segment) =>
    pendingMonths.some((month) => month <= segment.endPeriod) && !segment.flags.includes("PERIOD_PENDING")
      ? { ...segment, flags: [...segment.flags, "PERIOD_PENDING" as const] }
      : segment,
  );
}

/** One person in one masa pajak, as the annual calculation needs it. */
export type AnnualMonth = {
  /** YYYY-MM, the masa pajak (the period month, P9). */
  taxPeriod: string;
  employeeId: string;
  employeeNumber: string;
  fullName: string;
  ptkpStatus: string | null;
  lines: A1Lines;
  gross: number;
  pensionContribution: number;
  /** The TER tax of that month as the monthly report computed it, or null when it could not. */
  terTax: number | null;
  /** The monthly report's ANNUAL_CALCULATION_REQUIRED: this month closes the span. */
  final: boolean;
};

export type AnnualSegment = {
  employeeId: string;
  employeeNumber: string;
  fullName: string;
  /** 1-based, in order within the year. */
  index: number;
  /** YYYY-MM of the first and last masa pajak of the span. */
  startPeriod: string;
  endPeriod: string;
  monthCount: number;
  closed: boolean;
  /** Status at the start of the span, which PTKP follows (DRAFT). */
  ptkpStatus: string | null;
  lines: A1Lines;
  gross: number;
  positionCost: number;
  pensionContribution: number;
  deductions: number;
  net: number;
  ptkp: number | null;
  pkp: number | null;
  annualTax: number | null;
  /** TER withheld in the span before its final month (all months while still open). */
  terWithheld: number | null;
  /** Tax of the final masa: annual tax less earlier TER; negative is lebih potong. */
  finalMasaTax: number | null;
  flags: AnnualFlag[];
};

/**
 * Splits each person's months into spans and settles every closed span. Months
 * arrive in any order; a person's months are read in masa pajak order.
 */
export function buildAnnualSegments(policy: Pph21AnnualPolicy, months: readonly AnnualMonth[]): AnnualSegment[] {
  const people = new Map<string, AnnualMonth[]>();
  for (const month of months) people.set(month.employeeId, [...(people.get(month.employeeId) ?? []), month]);

  const segments: AnnualSegment[] = [];
  for (const own of people.values()) {
    const ordered = [...own].sort((a, b) => a.taxPeriod.localeCompare(b.taxPeriod));
    let span: AnnualMonth[] = [];
    let index = 0;
    for (const month of ordered) {
      span.push(month);
      if (month.final) {
        segments.push(settle(policy, span, ++index, true));
        span = [];
      }
    }
    if (span.length > 0) segments.push(settle(policy, span, ++index, false));
  }
  return segments.sort(
    (a, b) => a.employeeNumber.localeCompare(b.employeeNumber) || a.index - b.index,
  );
}

function settle(policy: Pph21AnnualPolicy, span: readonly AnnualMonth[], index: number, closed: boolean): AnnualSegment {
  const first = span[0]!;
  const last = span[span.length - 1]!;
  const lines = emptyA1Lines();
  for (const month of span) for (const key of A1_LINE_KEYS) lines[key] += month.lines[key];
  const gross = span.reduce((total, month) => total + month.gross, 0);
  const pension = span.reduce((total, month) => total + month.pensionContribution, 0);
  const cost = positionCost(policy, gross, span.length);
  const deductions = cost + pension;
  const net = gross - deductions;
  const flags: AnnualFlag[] = [];

  // TER taken before the final month; while open, every month so far.
  const prior = closed ? span.slice(0, -1) : span;
  const terWithheld = prior.some((month) => month.terTax === null)
    ? null
    : prior.reduce((total, month) => total + (month.terTax ?? 0), 0);

  const ptkp = ptkpAmount(policy, first.ptkpStatus);
  let pkp: number | null = null;
  let annualTax: number | null = null;
  let finalMasaTax: number | null = null;

  if (!closed) flags.push("OPEN");
  if (ptkp === null) {
    flags.push("PTKP_MISSING");
  } else if (closed) {
    // PKP rounded down to whole thousands (the policy's unit); never negative.
    pkp = Math.max(0, Math.floor(Math.max(0, net - ptkp) / policy.pkpRoundingUnit) * policy.pkpRoundingUnit);
    annualTax = pasal17Tax(policy, pkp);
  }
  if (closed && terWithheld === null) flags.push("PRIOR_TAX_INCOMPLETE");
  if (annualTax !== null && terWithheld !== null) finalMasaTax = annualTax - terWithheld;

  return {
    employeeId: first.employeeId,
    employeeNumber: last.employeeNumber,
    fullName: last.fullName,
    index,
    startPeriod: first.taxPeriod,
    endPeriod: last.taxPeriod,
    monthCount: span.length,
    closed,
    ptkpStatus: first.ptkpStatus,
    lines,
    gross,
    positionCost: cost,
    pensionContribution: pension,
    deductions,
    net,
    ptkp,
    pkp,
    annualTax,
    terWithheld,
    finalMasaTax,
    flags,
  };
}

/**
 * One approved period's people as AnnualMonth rows. The same rules as the
 * monthly report decide who is in it: blocked employments were not paid, an
 * excluded person is not reported at all, and two employments of one person
 * are one month. The TER tax is the monthly report's figure, null when that
 * report could not compute it (no TER policy, or no PTKP mapping that month).
 */
export function annualMonthsOfPeriod(input: {
  period: { periodMonth: string; periodStart: string; periodEnd: string };
  rows: readonly Pph21SourceRow[];
  /** Tax per employee from the monthly TER report, or null when the report could not be built. */
  terTaxByEmployee: ReadonlyMap<string, number | null> | null;
  /** People taxed with daily TER under 21-100-03 that month: no annual settlement (section 7.5). */
  dailyEmployeeIds?: ReadonlySet<string>;
  policy: Pick<Pph21AnnualPolicy, "lineByComponent" | "pensionContributionComponents">;
}): AnnualMonth[] {
  const people = new Map<string, Pph21SourceRow[]>();
  for (const row of input.rows) people.set(row.employeeId, [...(people.get(row.employeeId) ?? []), row]);

  const months: AnnualMonth[] = [];
  for (const [employeeId, employments] of people) {
    const paid = employments.filter((row) => row.blockerCount === 0);
    if (paid.length === 0 || paid.some((row) => row.excluded)) continue;
    if (input.dailyEmployeeIds?.has(employeeId)) continue;
    const lines = emptyA1Lines();
    let gross = 0;
    let pension = 0;
    for (const row of paid) {
      const own = a1LinesOf(row, input.policy.lineByComponent);
      for (const key of A1_LINE_KEYS) lines[key] += own[key];
      gross += reportableGross(row);
      pension += pensionContributionOf(row.deductions ?? [], input.policy.pensionContributionComponents, row.payFactor);
    }
    const statuses = new Set(
      paid.map((row) => row.ptkpStatus).filter((status): status is string => status !== null && status.trim().length > 0),
    );
    const first = paid[0]!;
    months.push({
      taxPeriod: input.period.periodMonth.slice(0, 7),
      employeeId,
      employeeNumber: first.employeeNumber,
      fullName: first.fullName,
      // Two different statuses in one month are not guessed between.
      ptkpStatus: statuses.size === 1 ? [...statuses][0]!.trim() : null,
      lines,
      gross,
      pensionContribution: pension,
      terTax: input.terTaxByEmployee?.get(employeeId) ?? null,
      final: needsAnnualCalculation(
        input.period,
        employments.map((row) => row.serviceEndDate),
        employments.some((row) => row.hasContinuingEmployment),
      ),
    });
  }
  return months;
}
