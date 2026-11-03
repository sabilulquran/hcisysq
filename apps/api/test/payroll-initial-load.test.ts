// PAY-003-MIG pure helpers: reference resolution, comparison, and the fractional
// salary scale the initial load needs. No database.

import { describe, expect, it } from "vitest";

import { calculateEmployeePayroll, EMPTY_PERIOD_INPUTS, type PayrollPolicy } from "../src/modules/payroll/engine.js";
import {
  canonicalJson,
  parseInitialLoadFile,
  PAYROLL_REF_NAMESPACE,
  positionRef,
  profileMatches,
  resolveSymbols,
  uuidV5,
} from "../src/modules/payroll/initial-load.js";
import { validatePolicyPayload } from "../src/modules/payroll/policy.js";

describe("uuidV5", () => {
  it("matches the RFC 4122 example", () => {
    // DNS namespace, "www.example.com": the value every v5 implementation publishes.
    expect(uuidV5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(
      "2ed6657d-e927-568b-95e1-2665a8aea6a2",
    );
  });

  it("gives one reference per label regardless of spacing and case, and separate ones per slot", () => {
    expect(positionRef("functional", "Guru  Kelas ")).toBe(positionRef("functional", "guru kelas"));
    const noBreakSpace = String.fromCharCode(0xa0);
    expect(positionRef("functional", `Guru${noBreakSpace}Kelas${noBreakSpace}`)).toBe(
      positionRef("functional", "guru kelas"),
    );
    expect(positionRef("functional", "Kepala Unit")).not.toBe(positionRef("structural", "Kepala Unit"));
    expect(PAYROLL_REF_NAMESPACE.functional).not.toBe(PAYROLL_REF_NAMESPACE.structural);
  });
});

describe("resolveSymbols", () => {
  const units = new Map([["taman tahfizh", "11111111-1111-4111-8111-111111111111"]]);

  it("resolves keys and array elements, records what each uuid stood for, and leaves plain values alone", () => {
    const result = resolveSymbols(
      {
        units: { "unit:Taman Tahfizh": 0.5 },
        knownUnitRefs: ["unit:Taman  tahfizh"],
        byPosition: { "functional:Guru Kelas": 100_000 },
        workPatterns: { HALF_DAY: 0.6 },
      },
      units,
    );
    const guru = positionRef("functional", "Guru Kelas");
    expect(result.unknownUnits).toEqual([]);
    expect(result.value).toEqual({
      units: { "11111111-1111-4111-8111-111111111111": 0.5 },
      knownUnitRefs: ["11111111-1111-4111-8111-111111111111"],
      byPosition: { [guru]: 100_000 },
      workPatterns: { HALF_DAY: 0.6 },
    });
    expect(result.refLabels[guru]).toBe("functional:Guru Kelas");
  });

  it("reports a unit it cannot find instead of guessing", () => {
    const result = resolveSymbols({ excludedUnits: ["unit:Pesantren Tahfizh"] }, units);
    expect(result.unknownUnits).toEqual(["Pesantren Tahfizh"]);
  });
});

describe("canonicalJson", () => {
  it("ignores key order, as a jsonb round trip does", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: null } })).toBe(canonicalJson({ a: { c: null, d: [1, 2] }, b: 1 }));
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }));
  });
});

describe("profileMatches", () => {
  const stored = {
    education: "S1",
    workPattern: null,
    unitRef: null,
    functionalPositionRef: null,
    structuralPositionRef: null,
    teachingHoursPerWeek: "24.00",
    spouseCount: 1,
    childCount: 0,
    registeredDependants: 1,
    specialQualificationTarget: null,
    annualPerformanceRate: "1.0000",
    monthlyPerformanceRate: "0.7500",
    bpjsSegment: "BELUM_TERDAFTAR",
    bpjsActiveFrom: null,
    bpjsExtraFamilyOverride: null,
    bpjsExtraFamilyOverrideReason: null,
    bpjsDecisionReference: null,
    ptkpStatus: null,
    pjMediaRatePerContent: null,
    bankName: null,
    bankAccountNumber: null,
    bankAccountName: null,
  };

  it("compares numbers the way the database returns them", () => {
    const desired = { ...stored, teachingHoursPerWeek: 24, annualPerformanceRate: 1, monthlyPerformanceRate: 0.75 };
    expect(profileMatches(stored as never, desired as never)).toBe(true);
    expect(profileMatches(stored as never, { ...desired, childCount: 1 } as never)).toBe(false);
  });
});

describe("parseInitialLoadFile", () => {
  it("refuses a file that is not the expected format", () => {
    expect(() => parseInitialLoadFile({ format: "lain", policies: [] })).toThrow(/PAY-003-MIG\/1/);
  });
});

describe("fractional salary scale (PAY-003-MIG §3.4)", () => {
  it("is accepted, and BASIC still rounds up once, after the multiplier", () => {
    expect(validatePolicyPayload("SALARY_SCALE", { scale: { S1: [1_042_461.558] } }).ok).toBe(true);
    expect(validatePolicyPayload("SALARY_SCALE", { scale: { S1: [-1] } }).ok).toBe(false);

    const policy: PayrollPolicy = {
      salaryScale: { S1: [1_042_461.558] },
      unitBasicMultipliers: {},
      knownUnitRefs: [],
      workPatternBasicMultipliers: { HALF_DAY: 0.6 },
      teaching: { monthlyHourLimit: 96, overRatePerHour: 10_000, shortRatePerHour: 10_000, weeksPerMonth: 4 },
      performance: {
        defaultBase: 100_000,
        baseByPosition: {},
        annualShare: 0.6,
        monthlyShare: 0.4,
        unratedBelowOneYear: { annualRate: 0, monthlyRate: 1 },
      },
      family: { spouseRate: 0.05, childRate: 0.02 },
      functionalAllowance: { byPosition: {}, concurrentStructuralFactor: 0.7, excludedUnits: [], positionsWithoutAllowance: [] },
      positionalAllowance: { byPosition: {}, unitMultipliers: {}, positionsWithoutAllowance: [] },
      overtime: { monthlyHourDivisor: 173 },
      bpjsKesehatan: {
        contributionRate: 0.05,
        extraFamilyRate: 0.01,
        floor: 0,
        ceiling: 12_000_000,
        coveredChildren: 3,
        fixedAllowanceComponents: ["BASIC"],
      },
      contract: { transportPerAttendance: 15_000, teachingFeePerHour: 15_400 },
      earlyService: { months: 2, netRate: 0.8 },
    };
    const result = calculateEmployeePayroll({
      profile: {
        employmentId: "e",
        category: "PERMANENT",
        education: "S1",
        serviceStartDate: "2026-01-01",
        serviceEndDate: null,
        spouseCount: 0,
        childCount: 0,
        registeredDependants: 0,
        workPattern: "HALF_DAY",
        unitRef: null,
        teachingHoursPerWeek: null,
        functionalPositionRef: null,
        structuralPositionRef: null,
        specialQualificationTarget: null,
        annualPerformanceRate: 0,
        monthlyPerformanceRate: 0,
        bpjs: { segment: "BELUM_TERDAFTAR", activeFrom: null, extraFamilyMembersOverride: null },
        bankAccountNumber: "1",
        bankAccountName: "x",
      },
      inputs: EMPTY_PERIOD_INPUTS,
      payDate: "2026-10-28",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      policy,
    });
    // ROUNDUP(1,042,461.558 x 0.6) = 625,477; rounding the scale first would give 625,478.
    expect(result.lines.find((line) => line.code === "BASIC")?.amount).toBe(625_477);
  });
});
