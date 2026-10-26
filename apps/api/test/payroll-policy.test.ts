import { describe, expect, it } from "vitest";

import { POLICY_KEYS, resolvePolicy, type PolicyVersionRow } from "../src/modules/payroll/policy.js";

/** Synthetic values with the shape of the real policy rows; no production figures. */
const PAYLOADS: Record<string, unknown> = {
  SALARY_SCALE: { scale: { S1: [2_000_000, 2_100_000], SLTA: [1_500_000] } },
  BASIC_MULTIPLIER: {
    units: { "unit-taman": 0.5 },
    knownUnitRefs: ["unit-taman", "unit-pusat"],
    workPatterns: { FULL: 1, HALF_DAY: 0.6 },
  },
  TEACHING_HOURS: { monthlyHourLimit: 96, overRatePerHour: 10_000, shortRatePerHour: 10_000, weeksPerMonth: 4 },
  PERFORMANCE: {
    defaultBase: 100_000,
    baseByPosition: { "pos-ga": 150_000 },
    annualShare: 0.6,
    monthlyShare: 0.4,
    unratedBelowOneYear: { annualRate: 0, monthlyRate: 1 },
  },
  FAMILY: { spouseRate: 0.05, childRate: 0.02 },
  FUNCTIONAL_ALLOWANCE: {
    byPosition: { "func-guru": 400_000 },
    concurrentStructuralFactor: 0.7,
    excludedUnits: ["unit-pesantren"],
    positionsWithoutAllowance: [],
  },
  POSITIONAL_ALLOWANCE: {
    byPosition: { "pos-ga": 600_000 },
    unitMultipliers: { "unit-taman": 0.5 },
    positionsWithoutAllowance: [],
  },
  OVERTIME: { monthlyHourDivisor: 173 },
  BPJS_KESEHATAN: {
    contributionRate: 0.05,
    extraFamilyRate: 0.01,
    floor: 2_878_646,
    ceiling: 12_000_000,
    coveredChildren: 3,
    fixedAllowanceComponents: ["BASIC", "SPOUSE", "CHILD"],
  },
  CONTRACT_RATES: { transportPerAttendance: 15_000, teachingFeePerHour: 15_400 },
  EARLY_SERVICE: { months: 2, netRate: 0.8 },
  VARIANCE_THRESHOLD: { relative: 0.1, absolute: 50_000, manualInput: 1_000_000 },
};

function rows(overrides: Partial<Record<string, unknown>> = {}, omit: string[] = []): PolicyVersionRow[] {
  return POLICY_KEYS.filter((key) => !omit.includes(key)).map((key, index) => ({
    id: `version-${index}`,
    policyKey: key,
    payload: key in overrides ? overrides[key] : PAYLOADS[key],
  }));
}

describe("PAY-003 policy resolution", () => {
  it("builds the policy the engine takes from the versioned rows", () => {
    const resolved = resolvePolicy(rows());
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.policy.bpjsKesehatan.ceiling).toBe(12_000_000);
    expect(resolved.policy.salaryScale.S1).toEqual([2_000_000, 2_100_000]);
    expect(resolved.policy.knownUnitRefs).toEqual(["unit-taman", "unit-pusat"]);
    expect(resolved.versionIds).toHaveLength(POLICY_KEYS.length);
    expect(resolved.variance).toEqual({ relative: 0.1, absolute: 50_000, manualInput: 1_000_000 });
  });

  it("refuses to calculate when a statutory policy is missing for the pay date", () => {
    const resolved = resolvePolicy(rows({}, ["BPJS_KESEHATAN"]));
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.problems).toEqual([
      expect.objectContaining({ policyKey: "BPJS_KESEHATAN", code: "MISSING" }),
    ]);
  });

  it("names every missing policy at once, rather than one per attempt", () => {
    const resolved = resolvePolicy(rows({}, ["FAMILY", "OVERTIME", "EARLY_SERVICE"]));
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.problems.map((problem) => problem.policyKey)).toEqual([
      "FAMILY",
      "OVERTIME",
      "EARLY_SERVICE",
    ]);
  });

  it("refuses two versions of one policy covering the same date", () => {
    const duplicated = [...rows(), { id: "extra", policyKey: "OVERTIME", payload: PAYLOADS.OVERTIME }];
    const resolved = resolvePolicy(duplicated);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.problems).toEqual([
      expect.objectContaining({ policyKey: "OVERTIME", code: "DUPLICATE" }),
    ]);
  });

  it("refuses a payload that does not carry what the engine needs", () => {
    const resolved = resolvePolicy(rows({ FAMILY: { spouseRate: 0.05 } }));
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.problems).toEqual([expect.objectContaining({ policyKey: "FAMILY", code: "INVALID" })]);
  });

  it("refuses a rupiah amount that is not a whole number", () => {
    const resolved = resolvePolicy(rows({ CONTRACT_RATES: { transportPerAttendance: 15_000.5, teachingFeePerHour: 15_400 } }));
    expect(resolved.ok).toBe(false);
  });

  it("refuses a negative rate", () => {
    const resolved = resolvePolicy(rows({ FAMILY: { spouseRate: -0.05, childRate: 0.02 } }));
    expect(resolved.ok).toBe(false);
  });
});
