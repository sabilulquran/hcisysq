/**
 * PERF-001 to PAY-003 link (performance-review.md section 11,
 * payroll-calculation-v1.md section 5.5): turns the finalized performance
 * reviews that apply to one pay period into the two performance rates the
 * engine reads.
 *
 * Pure: the caller selects the reviews (FINALIZED only, from CLOSED cycles,
 * MONTHLY of month M-1 and the last ANNUAL cycle closed by the pay date) and
 * passes them in. Nothing here reads a database or a clock, so the same
 * snapshot always gives the same rates.
 */

import type { PayrollBlocker } from "./engine.js";

export type LinkedReview = {
  reviewId: string;
  cycleId: string;
  cycleKind: "MONTHLY" | "ANNUAL";
  /** First day of the cycle, ISO date. */
  cyclePeriodStart: string;
  predicateCode: string;
};

export type LinkedRate = {
  review_id: string;
  cycle_id: string;
  cycle_kind: "MONTHLY" | "ANNUAL";
  cycle_period_start: string;
  predicate: string;
  rate: number | null;
};

/** Stored in the result's input snapshot so the figure can be re-audited (section 11 item 5). */
export type PerformanceLinkTrace = {
  policy_version_id: string;
  monthly: LinkedRate | null;
  annual: LinkedRate | null;
};

export type PerformanceLinkOutcome = {
  /** Null means "no finalized review": the engine falls back to the profile. */
  annualRate: number | null;
  monthlyRate: number | null;
  trace: PerformanceLinkTrace;
  blockers: PayrollBlocker[];
};

const UNMAPPED = (predicate: string, kind: string): PayrollBlocker => ({
  code: "PERFORMANCE_PREDICATE_UNMAPPED",
  message: `Predikat ${predicate} dari penilaian ${kind === "ANNUAL" ? "tahunan" : "bulanan"} tidak ada di kebijakan PERFORMANCE_PERCENT.`,
});

function link(
  review: LinkedReview | null,
  byPredicate: Readonly<Record<string, number>>,
  blockers: PayrollBlocker[],
): { rate: number | null; trace: LinkedRate | null } {
  if (!review) return { rate: null, trace: null };
  const mapped = Object.prototype.hasOwnProperty.call(byPredicate, review.predicateCode)
    ? byPredicate[review.predicateCode]!
    : null;
  // A cycle may carry its own predicate codes (PERF-001 D-06). A code the
  // mapping does not know is not guessed and not silently replaced by the
  // profile: the period stops until HC adds the code to the policy.
  if (mapped === null) blockers.push(UNMAPPED(review.predicateCode, review.cycleKind));
  return {
    rate: mapped,
    trace: {
      review_id: review.reviewId,
      cycle_id: review.cycleId,
      cycle_kind: review.cycleKind,
      cycle_period_start: review.cyclePeriodStart,
      predicate: review.predicateCode,
      rate: mapped,
    },
  };
}

export function resolvePerformanceLink(input: {
  policy: { versionId: string; byPredicate: Readonly<Record<string, number>> };
  monthly: LinkedReview | null;
  annual: LinkedReview | null;
}): PerformanceLinkOutcome {
  const blockers: PayrollBlocker[] = [];
  const monthly = link(input.monthly, input.policy.byPredicate, blockers);
  const annual = link(input.annual, input.policy.byPredicate, blockers);
  return {
    annualRate: annual.rate,
    monthlyRate: monthly.rate,
    trace: { policy_version_id: input.policy.versionId, monthly: monthly.trace, annual: annual.trace },
    blockers,
  };
}

/** First day of the month before the period month, the MONTHLY cycle payroll month M reads. */
export function previousMonthStart(periodStart: string): string {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(periodStart);
  if (!match) throw new Error(`periodStart must be an ISO date, received ${periodStart}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const previousYear = month === 1 ? year - 1 : year;
  const previousMonth = month === 1 ? 12 : month - 1;
  return `${previousYear}-${String(previousMonth).padStart(2, "0")}-01`;
}
