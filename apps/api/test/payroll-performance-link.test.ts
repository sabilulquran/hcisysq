// PERF-001 -> PAY-003 link (performance-review.md section 11,
// payroll-calculation-v1.md section 5.5): the versioned PERFORMANCE_PERCENT
// policy, the pure predicate mapping, and how the engine ranks the rates.
// Synthetic values only (AGENTS.md section 8).

import { describe, expect, it } from "vitest";

import {
  calculateEmployeePayroll,
  EMPTY_PERIOD_INPUTS,
  type CompensationProfile,
  type PayrollPolicy,
  type PeriodInputs,
} from "../src/modules/payroll/engine.js";
import { previousMonthStart, resolvePerformanceLink } from "../src/modules/payroll/performance-link.js";
import {
  POLICY_KEYS,
  resolvePolicy,
  validatePolicyPayload,
  type PolicyVersionRow,
} from "../src/modules/payroll/policy.js";

const PAYLOADS: Record<string, unknown> = {
  SALARY_SCALE: { scale: { S1: Array.from({ length: 28 }, (_, mkg) => 2_000_000 + mkg * 100_000) } },
  BASIC_MULTIPLIER: { units: {}, knownUnitRefs: [], workPatterns: { FULL: 1 } },
  TEACHING_HOURS: { monthlyHourLimit: 96, overRatePerHour: 10_000, shortRatePerHour: 10_000, weeksPerMonth: 4 },
  PERFORMANCE: {
    defaultBase: 100_000,
    baseByPosition: { "pos-ga": 150_000 },
    annualShare: 0.6,
    monthlyShare: 0.4,
    unratedBelowOneYear: { annualRate: 0, monthlyRate: 0 },
  },
  FAMILY: { spouseRate: 0.05, childRate: 0.02 },
  FUNCTIONAL_ALLOWANCE: { byPosition: {}, concurrentStructuralFactor: 0.7, excludedUnits: [], positionsWithoutAllowance: [] },
  POSITIONAL_ALLOWANCE: { byPosition: {}, unitMultipliers: {}, positionsWithoutAllowance: [] },
  OVERTIME: { monthlyHourDivisor: 173 },
  BPJS_KESEHATAN: {
    contributionRate: 0.05,
    extraFamilyRate: 0.01,
    floor: 2_878_646,
    ceiling: 12_000_000,
    coveredChildren: 3,
    fixedAllowanceComponents: ["BASIC", "PERF"],
  },
  CONTRACT_RATES: { transportPerAttendance: 15_000, teachingFeePerHour: 15_400 },
  EARLY_SERVICE: { months: 2, netRate: 0.8 },
};

/** DRAFT default mapping proposed in performance-review.md section 11 item 2. */
const MAPPING = { A: 1, B: 0.9, C: 0.75, D: 0.5 };

function rows(extra: PolicyVersionRow[] = []): PolicyVersionRow[] {
  return [
    ...POLICY_KEYS.map((key, index) => ({ id: `version-${index}`, policyKey: key, payload: PAYLOADS[key] })),
    ...extra,
  ];
}

function policyOf(extra: PolicyVersionRow[] = []) {
  const resolved = resolvePolicy(rows(extra));
  if (!resolved.ok) throw new Error(JSON.stringify(resolved.problems));
  return resolved;
}

const PROFILE: CompensationProfile = {
  employmentId: "employment-1",
  category: "PERMANENT",
  education: "S1",
  serviceStartDate: "2016-07-01",
  serviceEndDate: null,
  spouseCount: 0,
  childCount: 0,
  registeredDependants: 0,
  workPattern: null,
  unitRef: null,
  teachingHoursPerWeek: null,
  functionalPositionRef: null,
  structuralPositionRef: null,
  specialQualificationTarget: null,
  annualPerformanceRate: 0.8,
  monthlyPerformanceRate: 0.6,
  bpjs: { segment: "PPU_YAYASAN", activeFrom: "2020-01-01", extraFamilyMembersOverride: null },
  bankAccountNumber: "0000000001",
  bankAccountName: "Pegawai Uji",
};

function run(policy: PayrollPolicy, profile: Partial<CompensationProfile> = {}, inputs: Partial<PeriodInputs> = {}) {
  return calculateEmployeePayroll({
    profile: { ...PROFILE, ...profile },
    inputs: { ...EMPTY_PERIOD_INPUTS, ...inputs },
    payDate: "2026-09-25",
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    policy,
  });
}

const amountOf = (result: ReturnType<typeof run>, code: string) =>
  result.lines.filter((line) => line.code === code).reduce((total, line) => total + line.amount, 0);

const review = (kind: "MONTHLY" | "ANNUAL", predicateCode: string) => ({
  reviewId: `review-${kind}`,
  cycleId: `cycle-${kind}`,
  cycleKind: kind,
  cyclePeriodStart: kind === "MONTHLY" ? "2026-08-01" : "2025-07-01",
  predicateCode,
});

describe("PERFORMANCE_PERCENT policy", () => {
  it("is optional: without a version the link is off and nothing else changes", () => {
    const resolved = policyOf();
    expect(resolved.performancePercent).toBeNull();
    expect(resolved.versionIds).toHaveLength(POLICY_KEYS.length);
  });

  it("reads as off when the version says enabled: false, and is not recorded as used", () => {
    const resolved = policyOf([
      { id: "perf-off", policyKey: "PERFORMANCE_PERCENT", payload: { enabled: false, byPredicate: MAPPING } },
    ]);
    expect(resolved.performancePercent).toBeNull();
    expect(resolved.versionIds).not.toContain("perf-off");
  });

  it("carries the mapping and its version when switched on", () => {
    const resolved = policyOf([
      { id: "perf-on", policyKey: "PERFORMANCE_PERCENT", payload: { enabled: true, byPredicate: MAPPING } },
    ]);
    expect(resolved.performancePercent).toEqual({ versionId: "perf-on", byPredicate: MAPPING });
    expect(resolved.versionIds).toContain("perf-on");
  });

  it("fails closed on a malformed mapping instead of quietly paying the profile figure", () => {
    const resolved = resolvePolicy(
      rows([{ id: "perf-bad", policyKey: "PERFORMANCE_PERCENT", payload: { enabled: true, byPredicate: { A: "100%" } } }]),
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.problems[0]).toMatchObject({ policyKey: "PERFORMANCE_PERCENT", code: "INVALID" });
  });

  it("is validated on the write path", () => {
    expect(validatePolicyPayload("PERFORMANCE_PERCENT", { enabled: false, byPredicate: MAPPING })).toEqual({ ok: true });
    expect(validatePolicyPayload("PERFORMANCE_PERCENT", { enabled: true, byPredicate: {} }).ok).toBe(false);
    expect(validatePolicyPayload("PERFORMANCE_PERCENT", { enabled: true, byPredicate: { A: 2.5 } }).ok).toBe(false);
    expect(validatePolicyPayload("PERFORMANCE_PERCENT", { enabled: true, byPredicate: { A: 0.12345 } }).ok).toBe(false);
    expect(validatePolicyPayload("PERFORMANCE_PERCENT", { enabled: true, byPredicate: { a: 1 } }).ok).toBe(false);
    expect(validatePolicyPayload("PERFORMANCE_PERCENT", { byPredicate: MAPPING }).ok).toBe(false);
    // A minimal "off" version is enough to close the link again.
    expect(validatePolicyPayload("PERFORMANCE_PERCENT", { enabled: false })).toEqual({ ok: true });
    expect(validatePolicyPayload("PERFORMANCE_PERCENT", { enabled: true }).ok).toBe(false);
    expect(validatePolicyPayload("PERFORMANCE_PERCENT", { enabled: true, byPredicate: JSON.parse('{"__proto__": 1}') }).ok).toBe(false);
  });
});

describe("PERF-001 predicate mapping", () => {
  const policy = { versionId: "perf-on", byPredicate: MAPPING };

  it("maps both reviews and records which review, cycle and predicate were used", () => {
    const linked = resolvePerformanceLink({ policy, monthly: review("MONTHLY", "B"), annual: review("ANNUAL", "A") });
    expect(linked.monthlyRate).toBe(0.9);
    expect(linked.annualRate).toBe(1);
    expect(linked.blockers).toEqual([]);
    expect(linked.trace).toEqual({
      policy_version_id: "perf-on",
      monthly: {
        review_id: "review-MONTHLY",
        cycle_id: "cycle-MONTHLY",
        cycle_kind: "MONTHLY",
        cycle_period_start: "2026-08-01",
        predicate: "B",
        rate: 0.9,
      },
      annual: {
        review_id: "review-ANNUAL",
        cycle_id: "cycle-ANNUAL",
        cycle_kind: "ANNUAL",
        cycle_period_start: "2025-07-01",
        predicate: "A",
        rate: 1,
      },
    });
  });

  it("returns null rates (profile fallback) when there is no finalized review", () => {
    const linked = resolvePerformanceLink({ policy, monthly: null, annual: null });
    expect(linked).toMatchObject({ monthlyRate: null, annualRate: null, blockers: [] });
    expect(linked.trace).toEqual({ policy_version_id: "perf-on", monthly: null, annual: null });
  });

  it("blocks a predicate the policy does not map rather than guessing", () => {
    const linked = resolvePerformanceLink({ policy, monthly: review("MONTHLY", "E"), annual: null });
    expect(linked.monthlyRate).toBeNull();
    expect(linked.blockers.map((blocker) => blocker.code)).toEqual(["PERFORMANCE_PREDICATE_UNMAPPED"]);
    expect(linked.trace.monthly?.predicate).toBe("E");
  });

  it("does not read inherited object keys as predicates", () => {
    const linked = resolvePerformanceLink({ policy, monthly: review("MONTHLY", "constructor".toUpperCase()), annual: null });
    expect(linked.blockers).toHaveLength(1);
    const proto = resolvePerformanceLink({ policy, monthly: { ...review("MONTHLY", "A"), predicateCode: "toString" }, annual: null });
    expect(proto.monthlyRate).toBeNull();
  });

  it("reads the MONTHLY cycle of the month before the period month", () => {
    expect(previousMonthStart("2026-09-01")).toBe("2026-08-01");
    expect(previousMonthStart("2027-01-01")).toBe("2026-12-01");
  });
});

describe("PAY-003 performance allowance with the link", () => {
  const off = policyOf().policy;

  it("switched off: the result is identical to a calculation without the new inputs", () => {
    const before = run(off);
    const withNulls = run(off, {}, { annualPerformanceRateFromReview: null, monthlyPerformanceRateFromReview: null });
    expect(withNulls).toEqual(before);
    // Profile 80 % annual, 60 % monthly: 0.8*100000*0.6 + 0.6*100000*0.4 = 48000 + 24000.
    expect(amountOf(before, "PERF")).toBe(72_000);
  });

  it("pays from the reviews with exact rupiah: A annual, B monthly", () => {
    const result = run(off, {}, { annualPerformanceRateFromReview: 1, monthlyPerformanceRateFromReview: 0.9 });
    // 1*100000*0.6 + 0.9*100000*0.4 = 60000 + 36000.
    expect(amountOf(result, "PERF")).toBe(96_000);
  });

  it("covers every DRAFT predicate on the position base without a stray rupiah", () => {
    const expected: Record<string, number> = { A: 150_000, B: 135_000, C: 112_500, D: 75_000 };
    for (const [predicate, rate] of Object.entries(MAPPING)) {
      const result = run(
        off,
        { structuralPositionRef: "pos-ga" },
        { annualPerformanceRateFromReview: rate, monthlyPerformanceRateFromReview: rate },
      );
      expect(amountOf(result, "PERF")).toBe(expected[predicate]);
    }
  });

  it("falls back to the profile for the rate without a review", () => {
    const result = run(off, {}, { annualPerformanceRateFromReview: null, monthlyPerformanceRateFromReview: 0.5 });
    // 0.8*100000*0.6 + 0.5*100000*0.4 = 48000 + 20000.
    expect(amountOf(result, "PERF")).toBe(68_000);
  });

  it("lets an HC override for the period win over the review", () => {
    const result = run(
      off,
      {},
      { annualPerformanceRateFromReview: 1, monthlyPerformanceRateFromReview: 1, monthlyPerformanceRateOverride: 0 },
    );
    expect(amountOf(result, "PERF")).toBe(60_000);
  });

  it("below a year of service a monthly review pays the monthly share and no annual share", () => {
    const result = run(
      off,
      { serviceStartDate: "2026-03-01", annualPerformanceRate: null, monthlyPerformanceRate: null },
      { monthlyPerformanceRateFromReview: 0.75 },
    );
    expect(amountOf(result, "PERF")).toBe(30_000);
  });

  it("moves the BPJS base with PERF, since PERF is a fixed allowance", () => {
    const base = run(off);
    const linked = run(off, {}, { annualPerformanceRateFromReview: 1, monthlyPerformanceRateFromReview: 1 });
    expect(linked.bpjsBase - base.bpjsBase).toBe(100_000 - 72_000);
  });
});
