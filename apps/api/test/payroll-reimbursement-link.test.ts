// REIMB-001 section 9 / PAY-003 section 3.6: the REIMBURSE component in the
// engine and the PPh21 report. Exact rupiah; synthetic values only.

import { describe, expect, it } from "vitest";

import {
  calculateEmployeePayroll,
  EMPTY_PERIOD_INPUTS,
  type CompensationProfile,
  type PayrollPolicy,
  type PeriodInputs,
} from "../src/modules/payroll/engine.js";
import { PPH21_EXCLUDED_EARNINGS, reportableGross } from "../src/modules/payroll/pph21.js";

const POLICY: PayrollPolicy = {
  salaryScale: { S1: Array.from({ length: 28 }, (_, mkg) => 2_000_000 + mkg * 100_000) },
  unitBasicMultipliers: {},
  knownUnitRefs: [],
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
  functionalAllowance: { byPosition: {}, concurrentStructuralFactor: 0.7, excludedUnits: [], positionsWithoutAllowance: [] },
  positionalAllowance: { byPosition: {}, unitMultipliers: {}, positionsWithoutAllowance: [] },
  overtime: { monthlyHourDivisor: 173 },
  bpjsKesehatan: {
    contributionRate: 0.05,
    extraFamilyRate: 0.01,
    floor: 2_878_646,
    ceiling: 12_000_000,
    coveredChildren: 3,
    fixedAllowanceComponents: ["BASIC"],
  },
  contract: { transportPerAttendance: 15_000, teachingFeePerHour: 15_400 },
  earlyService: { months: 2, netRate: 0.8 },
};

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
  annualPerformanceRate: null,
  monthlyPerformanceRate: null,
  bpjs: { segment: "PPU_YAYASAN", activeFrom: "2020-01-01", extraFamilyMembersOverride: null },
  bankAccountNumber: "0000000001",
  bankAccountName: "Pegawai Uji",
};

function run(profile: Partial<CompensationProfile> = {}, inputs: Partial<PeriodInputs> = {}) {
  return calculateEmployeePayroll({
    profile: { ...PROFILE, ...profile },
    inputs: { ...EMPTY_PERIOD_INPUTS, ...inputs },
    payDate: "2026-09-25",
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    policy: POLICY,
  });
}

const amountOf = (result: ReturnType<typeof run>, code: string) =>
  result.lines.filter((line) => line.code === code).reduce((total, line) => total + line.amount, 0);

describe("PAY-003 REIMBURSE component", () => {
  it("switched off (no reimbursement input), the result is identical", () => {
    expect(run({}, { reimbursement: 0 })).toEqual(run());
    expect(run().lines.map((line) => line.code)).not.toContain("REIMBURSE");
  });

  it("adds the reimbursement to gross, net and payable, rupiah for rupiah", () => {
    const base = run();
    const paid = run({}, { reimbursement: 250_001 });
    expect(amountOf(paid, "REIMBURSE")).toBe(250_001);
    expect(paid.gross - base.gross).toBe(250_001);
    expect(paid.net - base.net).toBe(250_001);
    expect(paid.payable - base.payable).toBe(250_001);
  });

  it("is not a fixed allowance: the BPJS base and contribution do not move", () => {
    const base = run();
    const paid = run({}, { reimbursement: 1_000_000 });
    expect(paid.bpjsBase).toBe(base.bpjsBase);
    expect(amountOf(paid, "BPJS_KES")).toBe(amountOf(base, "BPJS_KES"));
  });

  it("is paid in full outside the early-service factor", () => {
    // MKG 0 on the scale, under two months of service: net at 80 %.
    const early = { serviceStartDate: "2026-08-01" };
    const base = run(early);
    const paid = run(early, { reimbursement: 333_333 });
    expect(base.payFactor).toBe(0.8);
    expect(paid.payable).toBe(base.payable + 333_333);
    expect(paid.payable).toBe(Math.ceil((paid.net - 333_333) * 0.8) + 333_333);
  });

  it("is paid in full outside a proration factor", () => {
    const base = run({}, { prorationFactor: 0.5 });
    const paid = run({}, { prorationFactor: 0.5, reimbursement: 100_000 });
    expect(paid.payable).toBe(base.payable + 100_000);
  });

  it("is paid to honorarium staff too", () => {
    const honor = { category: "HONORARIUM" as const };
    const paid = run(honor, { contractAttendanceDays: 10, reimbursement: 75_000 });
    expect(paid.payable).toBe(10 * 15_000 + 75_000);
  });

  it("refuses a negative or fractional input", () => {
    expect(run({}, { reimbursement: -1 }).blockers.map((blocker) => blocker.code)).toContain("INPUT_INVALID");
  });
});

describe("PPh21 report and REIMBURSE", () => {
  it("keeps the reimbursement out of the reportable gross, before and through the pay factor", () => {
    expect(PPH21_EXCLUDED_EARNINGS).toContain("REIMBURSE");
    const earnings = [
      { code: "BASIC", amount: 3_000_000 },
      { code: "REIMBURSE", amount: 250_000 },
    ];
    expect(reportableGross({ earnings, payFactor: 1 })).toBe(3_000_000);
    expect(reportableGross({ earnings, payFactor: 0.8 })).toBe(2_400_000);
  });
});
