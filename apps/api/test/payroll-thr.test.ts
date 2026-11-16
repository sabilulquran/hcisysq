// PAY-003-THR engine (docs/domain/payroll-thr.md): eligibility by service, the wage, the
// proportional rule and its rounding, honorarium, adjustments and blockers. Synthetic data only.

import { describe, expect, it } from "vitest";

import type { CompensationProfile, ComponentCode, PayrollPolicy } from "../src/modules/payroll/engine.js";
import { calculateEmployeeThr, proportionalThr, thrEligibility, type ThrPolicy } from "../src/modules/payroll/thr.js";

const scale = (base: number) => Array.from({ length: 28 }, (_, mkg) => base + mkg * 100_000);

const POLICY: PayrollPolicy = {
  salaryScale: { S1: scale(2_000_000) },
  unitBasicMultipliers: {},
  knownUnitRefs: ["unit-pusat"],
  workPatternBasicMultipliers: {},
  teaching: { monthlyHourLimit: 96, overRatePerHour: 10_000, shortRatePerHour: 10_000, weeksPerMonth: 4 },
  performance: {
    defaultBase: 100_000,
    baseByPosition: {},
    annualShare: 0.6,
    monthlyShare: 0.4,
    unratedBelowOneYear: { annualRate: 0, monthlyRate: 0 },
  },
  family: { spouseRate: 0.05, childRate: 0.02 },
  functionalAllowance: { byPosition: { "func-guru": 400_000 }, concurrentStructuralFactor: 0.7, excludedUnits: [], positionsWithoutAllowance: [] },
  positionalAllowance: { byPosition: {}, unitMultipliers: {}, positionsWithoutAllowance: [] },
  overtime: { monthlyHourDivisor: 173 },
  bpjsKesehatan: {
    contributionRate: 0.05,
    extraFamilyRate: 0.01,
    floor: 2_000_000,
    ceiling: 12_000_000,
    coveredChildren: 3,
    fixedAllowanceComponents: ["BASIC", "FUNC"],
  },
  contract: { transportPerAttendance: 15_000, teachingFeePerHour: 15_400 },
  earlyService: { months: 2, netRate: 0.8 },
};

const THR_POLICY: ThrPolicy = {
  fullServiceMonths: 12,
  minimumServiceMonths: 1,
  paymentDeadlineDaysBeforeHoliday: 7,
  terminationGraceDays: 30,
  terminationGraceTermCategories: ["TETAP", "PERCOBAAN"],
  eligibleTermCategories: ["TETAP", "PERCOBAAN", "KONTRAK"],
};

const WAGE: ComponentCode[] = ["BASIC", "PERF", "SPOUSE", "CHILD", "FUNC", "POS", "SPECIAL_QUAL"];

const PROFILE: CompensationProfile = {
  employmentId: "employment-thr",
  category: "PERMANENT",
  education: "S1",
  serviceStartDate: "2020-01-01",
  serviceEndDate: null,
  spouseCount: 1,
  childCount: 0,
  registeredDependants: 0,
  workPattern: null,
  unitRef: null,
  teachingHoursPerWeek: 30,
  functionalPositionRef: "func-guru",
  structuralPositionRef: null,
  specialQualificationTarget: null,
  annualPerformanceRate: null,
  monthlyPerformanceRate: null,
  bpjs: { segment: "PPU_YAYASAN", activeFrom: "2020-01-01", extraFamilyMembersOverride: null },
  bankAccountNumber: "0000000001",
  bankAccountName: "Pegawai Uji",
};

const HOLIDAY = "2027-03-10";
const PAY_DATE = "2027-03-01";

function thr(profile: Partial<CompensationProfile> = {}, adjustment = 0) {
  return calculateEmployeeThr({
    profile: { ...PROFILE, ...profile },
    payDate: PAY_DATE,
    holidayDate: HOLIDAY,
    policy: POLICY,
    thrPolicy: THR_POLICY,
    wageComponents: WAGE,
    adjustment,
  });
}

const amount = (result: ReturnType<typeof thr>, code: string) =>
  result.lines.filter((line) => line.code === code).reduce((total, line) => total + line.amount, 0);

describe("PAY-003-THR eligibility (T2, T4)", () => {
  it("counts whole months from TMT to the holiday", () => {
    expect(thrEligibility("2027-02-10", HOLIDAY, THR_POLICY)).toEqual({ eligible: true, serviceMonths: 1 });
    expect(thrEligibility("2027-02-11", HOLIDAY, THR_POLICY)).toEqual({
      eligible: false,
      serviceMonths: 0,
      reason: "SERVICE_TOO_SHORT",
    });
    expect(thrEligibility("2026-03-10", HOLIDAY, THR_POLICY)).toMatchObject({ eligible: true, serviceMonths: 12 });
    expect(thrEligibility("2027-04-01", HOLIDAY, THR_POLICY)).toMatchObject({ eligible: false, serviceMonths: 0 });
  });
});

describe("PAY-003-THR proportional rule (T7)", () => {
  it("pays the whole wage from twelve months on", () => {
    expect(proportionalThr(3_123_457, 12, 12)).toBe(3_123_457);
    expect(proportionalThr(3_123_457, 40, 12)).toBe(3_123_457);
  });

  it("pays months/12 below that, rounded up to a whole rupiah with no binary fraction", () => {
    expect(proportionalThr(3_000_000, 1, 12)).toBe(250_000);
    expect(proportionalThr(3_000_000, 11, 12)).toBe(2_750_000);
    // 1 000 001 x 7 / 12 = 583 333.9166..., rounded up.
    expect(proportionalThr(1_000_001, 7, 12)).toBe(583_334);
    // Exactly divisible stays exact: 1 200 000 x 5 / 12 = 500 000.
    expect(proportionalThr(1_200_000, 5, 12)).toBe(500_000);
  });

  it("pays nothing on a wage that is not a positive whole rupiah", () => {
    expect(proportionalThr(0, 12, 12)).toBe(0);
    expect(proportionalThr(-5, 12, 12)).toBe(0);
  });
});

describe("PAY-003-THR calculation (T6, T8, T9)", () => {
  it("pays one month of wages: basic salary and fixed allowances, nothing else", () => {
    const result = thr();
    // MKG 7 on the pay date: 2 000 000 + 7 x 100 000 = 2 700 000; spouse 5% = 135 000; FUNC 400 000.
    // Teaching over hours (120 > 96) and the BPJS allowance are not wages.
    expect(result.monthlyWage).toBe(2_700_000 + 135_000 + 400_000);
    expect(amount(result, "THR")).toBe(3_235_000);
    expect(result.lines.map((line) => line.code)).toEqual(["THR"]);
    expect(result.payable).toBe(3_235_000);
    expect(result.payFactor).toBe(1);
    expect(result.blockers).toEqual([]);
  });

  it("pays a proportional THR below twelve months, without the early-service rate", () => {
    const result = thr({ serviceStartDate: "2026-12-05" });
    // Three whole months to the holiday; MKG 0: 2 000 000 + spouse 100 000 + FUNC 400 000.
    expect(result.serviceMonths).toBe(3);
    expect(amount(result, "THR")).toBe(625_000);
    expect(result.payFactorReason).toBe("none");
  });

  it("adds an authorised adjustment as its own line", () => {
    const plus = thr({}, 50_000);
    expect(amount(plus, "ADJUST_EARN")).toBe(50_000);
    expect(plus.payable).toBe(3_285_000);
    const minus = thr({}, -35_000);
    expect(amount(minus, "ADJUST_DEDUCT")).toBe(35_000);
    expect(minus.payable).toBe(3_200_000);
  });

  it("blocks an honorarium term instead of guessing a monthly wage", () => {
    const result = thr({ category: "HONORARIUM" });
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(["THR_WAGE_BASIS_UNSUPPORTED"]);
    expect(result.payable).toBe(0);
  });

  it("carries a mapping blocker of the regular calculation", () => {
    const result = thr({ functionalPositionRef: "func-tidak-dikenal" });
    expect(result.blockers.map((blocker) => blocker.code)).toContain("POSITION_NOT_MAPPED");
  });

  it("does not carry a monthly blocker that has nothing to do with THR", () => {
    // Ending inside the regular month without proration blocks a salary, not a THR.
    const result = thr({ serviceEndDate: "2027-03-05" });
    expect(result.blockers).toEqual([]);
  });

  it("refuses to pay into a missing account", () => {
    const result = thr({ bankAccountNumber: null });
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(["BANK_ACCOUNT_MISSING"]);
  });

  it("blocks a negative net", () => {
    const result = thr({}, -5_000_000);
    expect(result.blockers.map((blocker) => blocker.code)).toContain("NEGATIVE_NET");
  });
});
