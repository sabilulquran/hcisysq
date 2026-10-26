import { describe, expect, it } from "vitest";

import {
  bpjsContributionBase,
  calculateEmployeePayroll,
  deriveExtraFamilyMembers,
  detectComponentVariance,
  EMPTY_PERIOD_INPUTS,
  monthsOfService,
  resolveBasicSalary,
  roundRupiah,
  roundUpRupiah,
  summarizePeriod,
  yearsOfService,
  type CompensationProfile,
  type EmployeePayrollInput,
  type PayrollBlockerCode,
  type PayrollPolicy,
  type PeriodInputs,
} from "../src/modules/payroll/engine.js";

/**
 * Synthetic policy: the shape of the real one, with invented amounts. No
 * production salary scale, employee or payslip data belongs in a fixture
 * (AGENTS.md section 8).
 */
const scale = (base: number) => Array.from({ length: 28 }, (_, mkg) => base + mkg * 100_000);

const POLICY: PayrollPolicy = {
  salaryScale: { S1: scale(2_000_000), SLTA: scale(1_500_000) },
  unitBasicMultipliers: { "unit-taman": 0.5 },
  workPatternBasicMultipliers: { HALF_DAY: 0.6, HALF_DAY_II: 0.65 },
  teaching: { monthlyHourLimit: 96, overRatePerHour: 10_000, shortRatePerHour: 10_000, weeksPerMonth: 4 },
  performance: {
    defaultBase: 100_000,
    baseByPosition: { "pos-ga": 150_000 },
    annualShare: 0.6,
    monthlyShare: 0.4,
  },
  family: { spouseRate: 0.05, childRate: 0.02 },
  functionalAllowance: {
    byPosition: { "func-guru": 400_000 },
    concurrentStructuralFactor: 0.7,
    excludedUnits: ["unit-pesantren"],
  },
  positionalAllowance: { byPosition: { "pos-ga": 600_000 }, unitMultipliers: { "unit-taman": 0.5 } },
  overtime: { monthlyHourDivisor: 173 },
  bpjsKesehatan: {
    contributionRate: 0.05,
    extraFamilyRate: 0.01,
    floor: 2_878_646,
    ceiling: 12_000_000,
    coveredChildren: 3,
    fixedAllowanceComponents: ["BASIC", "SPOUSE", "CHILD", "FUNC", "POS", "PERF", "SPECIAL_QUAL"],
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
  bpjs: { segment: "BELUM_TERDAFTAR", activeFrom: null, extraFamilyMembersOverride: null },
  bankAccountNumber: "0000000001",
  bankAccountName: "Pegawai Uji",
};

function run(
  profile: Partial<CompensationProfile> = {},
  inputs: Partial<PeriodInputs> = {},
  payDate = "2026-09-25",
) {
  const input: EmployeePayrollInput = {
    profile: { ...PROFILE, ...profile },
    inputs: { ...EMPTY_PERIOD_INPUTS, ...inputs },
    payDate,
    periodStart: `${payDate.slice(0, 7)}-01`,
    periodEnd: `${payDate.slice(0, 7)}-30`,
    policy: POLICY,
  };
  return calculateEmployeePayroll(input);
}

function amountOf(result: ReturnType<typeof run>, code: string): number {
  return result.lines.filter((line) => line.code === code).reduce((total, l) => total + l.amount, 0);
}

function blockerCodes(result: ReturnType<typeof run>): PayrollBlockerCode[] {
  return result.blockers.map((blocker) => blocker.code);
}

describe("PAY-003 rounding", () => {
  it("rounds up away from zero to a whole rupiah", () => {
    expect(roundUpRupiah(1_000_000.01)).toBe(1_000_001);
    expect(roundUpRupiah(1_000_000)).toBe(1_000_000);
    expect(roundUpRupiah(-1_000_000.01)).toBe(-1_000_001);
  });

  it("rounds half away from zero like the legacy spreadsheet", () => {
    expect(roundRupiah(100.5)).toBe(101);
    expect(roundRupiah(-100.5)).toBe(-101);
    expect(roundRupiah(100.4)).toBe(100);
  });
});

describe("PAY-003 service length", () => {
  it("counts whole months in Asia/Jakarta calendar dates", () => {
    expect(monthsOfService("2026-08-01", "2026-09-25")).toBe(1);
    expect(monthsOfService("2026-08-26", "2026-09-25")).toBe(0);
    expect(monthsOfService("2026-07-25", "2026-09-25")).toBe(2);
  });

  it("never returns a negative term when the pay date precedes the start", () => {
    expect(monthsOfService("2027-01-01", "2026-09-25")).toBe(0);
    expect(yearsOfService("2027-01-01", "2026-09-25")).toBe(0);
  });
});

describe("PAY-003 basic salary", () => {
  it("reads the scale by education and MKG", () => {
    const resolved = resolveBasicSalary({ ...PROFILE }, POLICY, "2026-09-25");
    expect(resolved.ok && resolved.amount).toBe(scale(2_000_000)[10]);
  });

  it("blocks MKG 28, one step past the end of the table", () => {
    const resolved = resolveBasicSalary(
      { ...PROFILE, serviceStartDate: "1998-01-01" },
      POLICY,
      "2026-09-25",
    );
    expect(resolved.ok).toBe(false);
    expect(!resolved.ok && resolved.blocker.code).toBe("MKG_OUT_OF_SCALE");
  });

  it("accepts MKG 0 and MKG 27, the ends of the table", () => {
    for (const [start, mkg] of [
      ["2026-09-01", 0],
      ["1999-01-01", 27],
    ] as const) {
      const resolved = resolveBasicSalary({ ...PROFILE, serviceStartDate: start }, POLICY, "2026-09-25");
      expect(resolved.ok && resolved.amount).toBe(scale(2_000_000)[mkg]);
    }
  });

  it("blocks an education level the policy does not map", () => {
    const resolved = resolveBasicSalary({ ...PROFILE, education: "S2_S3" }, POLICY, "2026-09-25");
    expect(!resolved.ok && resolved.blocker.code).toBe("EDUCATION_NOT_MAPPED");
  });

  it("multiplies the unit and the work pattern together", () => {
    const resolved = resolveBasicSalary(
      { ...PROFILE, unitRef: "unit-taman", workPattern: "HALF_DAY" },
      POLICY,
      "2026-09-25",
    );
    expect(resolved.ok && resolved.amount).toBe(Math.ceil(scale(2_000_000)[10]! * 0.5 * 0.6));
  });
});

describe("PAY-003 teaching hours", () => {
  it("renders neither component when the profile has no teaching hours", () => {
    const result = run();
    expect(result.lines.some((line) => line.code === "TEACH_OVER" || line.code === "TEACH_SHORT")).toBe(
      false,
    );
  });

  it("pays nothing extra and deducts nothing at exactly the monthly limit", () => {
    const result = run({ teachingHoursPerWeek: 24 });
    expect(amountOf(result, "TEACH_OVER")).toBe(0);
    expect(amountOf(result, "TEACH_SHORT")).toBe(0);
  });

  it("pays the excess above the limit", () => {
    const result = run({ teachingHoursPerWeek: 26 });
    expect(amountOf(result, "TEACH_OVER")).toBe(8 * 10_000);
  });

  it("deducts the shortfall below the limit", () => {
    const result = run({ teachingHoursPerWeek: 20 });
    expect(amountOf(result, "TEACH_SHORT")).toBe(16 * 10_000);
  });

  it("lets a period override beat the profile", () => {
    const result = run({ teachingHoursPerWeek: 20 }, { teachingHoursPerWeekOverride: 26 });
    expect(amountOf(result, "TEACH_OVER")).toBe(8 * 10_000);
    expect(amountOf(result, "TEACH_SHORT")).toBe(0);
  });
});

describe("PAY-003 allowances", () => {
  it("splits the performance allowance 60 percent annual and 40 percent monthly", () => {
    const result = run({ annualPerformanceRate: 1, monthlyPerformanceRate: 0.5 });
    expect(amountOf(result, "PERF")).toBe(Math.ceil(100_000 * 0.6 + 0.5 * 100_000 * 0.4));
  });

  it("uses the position base where the policy sets one", () => {
    const result = run({ structuralPositionRef: "pos-ga", annualPerformanceRate: 1, monthlyPerformanceRate: 1 });
    expect(amountOf(result, "PERF")).toBe(150_000);
  });

  it("pays family allowances per spouse and per child without a cap", () => {
    const result = run({ spouseCount: 1, childCount: 5 });
    const basic = amountOf(result, "BASIC");
    expect(amountOf(result, "SPOUSE")).toBe(Math.ceil(basic * 0.05));
    expect(amountOf(result, "CHILD")).toBe(Math.ceil(basic * 5 * 0.02));
  });

  it("cuts the functional allowance to 70 percent when a structural position is held too", () => {
    const result = run({ functionalPositionRef: "func-guru", structuralPositionRef: "pos-ga" });
    expect(amountOf(result, "FUNC")).toBe(Math.ceil(400_000 * 0.7));
  });

  it("pays no functional allowance in an excluded unit", () => {
    const result = run({ functionalPositionRef: "func-guru", unitRef: "unit-pesantren" });
    expect(amountOf(result, "FUNC")).toBe(0);
  });

  it("scales the positional allowance by the unit multiplier", () => {
    const result = run({ structuralPositionRef: "pos-ga", unitRef: "unit-taman" });
    expect(amountOf(result, "POS")).toBe(300_000);
  });

  it("divides basic salary by 173 for one overtime hour", () => {
    const result = run({}, { overtimeHours: 3 });
    const basic = amountOf(result, "BASIC");
    expect(amountOf(result, "OVERTIME")).toBe(Math.ceil((basic / 173) * 3));
  });
});

describe("PAY-003 special qualification top-up", () => {
  it("tops the earnings up to the target", () => {
    const result = run({ specialQualificationTarget: 5_000_000 });
    const basic = amountOf(result, "BASIC");
    expect(amountOf(result, "SPECIAL_QUAL")).toBe(5_000_000 - basic);
  });

  it("blocks a negative top-up until an adjustment is set", () => {
    const result = run({ specialQualificationTarget: 1_000_000 });
    expect(blockerCodes(result)).toContain("SPECIAL_QUALIFICATION_NEGATIVE");
    expect(amountOf(result, "SPECIAL_QUAL")).toBe(0);
  });

  it("clears the blocker once an adjustment carries the difference", () => {
    const result = run({ specialQualificationTarget: 1_000_000 }, { adjustment: -500_000 });
    expect(blockerCodes(result)).not.toContain("SPECIAL_QUALIFICATION_NEGATIVE");
    expect(amountOf(result, "ADJUST_DEDUCT")).toBe(500_000);
  });
});

describe("PAY-003 BPJS Kesehatan", () => {
  const insured = {
    bpjs: { segment: "PPU_YAYASAN" as const, activeFrom: "2020-01-01", extraFamilyMembersOverride: null },
  };

  it("leaves the employee net unchanged: the allowance equals the contribution", () => {
    const result = run(insured);
    expect(amountOf(result, "BPJS_KES_ALLOW")).toBe(amountOf(result, "BPJS_KES"));
  });

  it("lifts a base below the regional minimum wage to the floor", () => {
    const base = bpjsContributionBase([{ code: "BASIC", category: "EARNING", amount: 1_000_000 }], POLICY);
    expect(base).toBe(POLICY.bpjsKesehatan.floor);
  });

  it("caps a base above the ceiling", () => {
    const base = bpjsContributionBase([{ code: "BASIC", category: "EARNING", amount: 30_000_000 }], POLICY);
    expect(base).toBe(POLICY.bpjsKesehatan.ceiling);
  });

  it("keeps variable components out of the contribution base", () => {
    const base = bpjsContributionBase(
      [
        { code: "BASIC", category: "EARNING", amount: 5_000_000 },
        { code: "TEACH_OVER", category: "EARNING", amount: 500_000 },
        { code: "OVERTIME", category: "EARNING", amount: 400_000 },
      ],
      POLICY,
    );
    expect(base).toBe(5_000_000);
  });

  it("charges nothing for a PBI member", () => {
    const result = run({
      bpjs: { segment: "PBI", activeFrom: "2020-01-01", extraFamilyMembersOverride: null },
    });
    expect(amountOf(result, "BPJS_KES")).toBe(0);
  });

  it("charges nothing before the membership is active", () => {
    const result = run({
      bpjs: { segment: "PPU_YAYASAN", activeFrom: "2026-10-01", extraFamilyMembersOverride: null },
    });
    expect(amountOf(result, "BPJS_KES")).toBe(0);
  });

  it("derives extra family members beyond the spouse and three children", () => {
    expect(
      deriveExtraFamilyMembers({ ...PROFILE, spouseCount: 1, childCount: 4, registeredDependants: 5 }, POLICY),
    ).toBe(1);
    expect(
      deriveExtraFamilyMembers({ ...PROFILE, spouseCount: 1, childCount: 4, registeredDependants: 6 }, POLICY),
    ).toBe(2);
    expect(
      deriveExtraFamilyMembers({ ...PROFILE, spouseCount: 1, childCount: 2, registeredDependants: 3 }, POLICY),
    ).toBe(0);
  });

  it("charges one percent of the base per extra family member", () => {
    const result = run({ ...insured, spouseCount: 1, childCount: 4, registeredDependants: 5 });
    expect(amountOf(result, "BPJS_KES_EXTRA")).toBe(Math.round(result.bpjsBase * 0.01));
  });
});

describe("PAY-003 pay factor", () => {
  it("pays 80 percent of net below two months of service", () => {
    const result = run({ serviceStartDate: "2026-09-01" });
    expect(result.payFactorReason).toBe("early_service");
    expect(result.payable).toBe(Math.ceil(result.net * 0.8));
  });

  it("pays the full net from the third month", () => {
    const result = run({ serviceStartDate: "2026-07-01" });
    expect(result.payFactorReason).toBe("none");
    expect(result.payable).toBe(result.net);
  });

  it("lets proration replace the early-service rate rather than compound with it", () => {
    const result = run({ serviceStartDate: "2026-09-10" }, { prorationFactor: 0.5 });
    expect(result.payFactorReason).toBe("proration");
    expect(result.payable).toBe(Math.ceil(result.net * 0.5));
  });

  it("blocks a proration factor outside the allowed range", () => {
    expect(blockerCodes(run({}, { prorationFactor: 0 }))).toContain("PRORATION_FACTOR_INVALID");
    expect(blockerCodes(run({}, { prorationFactor: 1.2 }))).toContain("PRORATION_FACTOR_INVALID");
  });
});

describe("PAY-003 blockers", () => {
  it("blocks an employee whose service starts after the pay date", () => {
    expect(blockerCodes(run({ serviceStartDate: "2026-10-01" }))).toContain("SERVICE_NOT_STARTED");
  });

  it("blocks someone leaving mid-period with neither proration nor a full-pay statement", () => {
    expect(blockerCodes(run({ serviceEndDate: "2026-09-15" }))).toContain("LEAVING_WITHOUT_PRORATION");
    expect(blockerCodes(run({ serviceEndDate: "2026-09-15" }, { fullPayDespiteLeaving: true }))).not.toContain(
      "LEAVING_WITHOUT_PRORATION",
    );
  });

  it("blocks a loan deduction above the outstanding balance", () => {
    expect(blockerCodes(run({}, { loanDeduction: 600_000, loanOutstanding: 500_000 }))).toContain(
      "LOAN_EXCEEDS_BALANCE",
    );
    expect(blockerCodes(run({}, { loanDeduction: 500_000, loanOutstanding: 500_000 }))).not.toContain(
      "LOAN_EXCEEDS_BALANCE",
    );
  });

  it("blocks a negative net", () => {
    const result = run({}, { childEducationDeduction: 99_000_000, loanOutstanding: 0 });
    expect(blockerCodes(result)).toContain("NEGATIVE_NET");
  });

  it("blocks a missing bank account for anyone who is paid", () => {
    expect(blockerCodes(run({ bankAccountNumber: null }))).toContain("BANK_ACCOUNT_MISSING");
  });
});

describe("PAY-003 contract employees", () => {
  const contract = { category: "CONTRACT" as const, education: null };

  it("pays transport per attendance and a fee per teaching hour", () => {
    const result = run(contract, { contractAttendanceDays: 20, contractTeachingHours: 30 });
    expect(amountOf(result, "TRANSPORT")).toBe(20 * 15_000);
    expect(amountOf(result, "TEACH_FEE")).toBe(30 * 15_400);
    expect(result.gross).toBe(20 * 15_000 + 30 * 15_400);
  });

  it("pays no basic salary, allowance or BPJS contribution", () => {
    const result = run(contract, { contractAttendanceDays: 20 });
    for (const code of ["BASIC", "PERF", "SPOUSE", "CHILD", "FUNC", "POS", "BPJS_KES"]) {
      expect(amountOf(result, code)).toBe(0);
    }
  });

  it("never applies the early-service rate, which would cut the pay twice", () => {
    const result = run({ ...contract, serviceStartDate: "2026-09-01" }, { contractAttendanceDays: 10 });
    expect(result.payFactorReason).toBe("none");
    expect(result.payable).toBe(result.net);
  });

  it("still blocks a loan deduction above the balance", () => {
    const result = run(contract, {
      contractAttendanceDays: 20,
      loanDeduction: 100_000,
      loanOutstanding: 50_000,
    });
    expect(blockerCodes(result)).toContain("LOAN_EXCEEDS_BALANCE");
  });
});

describe("PAY-003 golden case", () => {
  /**
   * A whole permanent-employee slip, every component at once, so a change in any
   * rounding step or component order shows up as a single visible diff.
   */
  it("produces the same slip for the same snapshot", () => {
    const result = run(
      {
        serviceStartDate: "2016-07-01",
        spouseCount: 1,
        childCount: 2,
        registeredDependants: 4,
        teachingHoursPerWeek: 26,
        functionalPositionRef: "func-guru",
        structuralPositionRef: "pos-ga",
        annualPerformanceRate: 1,
        monthlyPerformanceRate: 0.9,
        bpjs: { segment: "PPU_YAYASAN", activeFrom: "2020-01-01", extraFamilyMembersOverride: null },
      },
      {
        overtimeHours: 5,
        arrears: 250_000,
        pjMediaIncentive: 120_000,
        childEducationDeduction: 400_000,
        loanDeduction: 300_000,
        loanOutstanding: 1_200_000,
      },
    );

    expect(result.lines).toEqual([
      { code: "BASIC", category: "EARNING", amount: 3_000_000 },
      { code: "TEACH_OVER", category: "EARNING", amount: 80_000 },
      { code: "PERF", category: "EARNING", amount: 144_000 },
      { code: "SPOUSE", category: "EARNING", amount: 150_000 },
      { code: "CHILD", category: "EARNING", amount: 120_000 },
      { code: "FUNC", category: "EARNING", amount: 280_000 },
      { code: "POS", category: "EARNING", amount: 600_000 },
      { code: "OVERTIME", category: "EARNING", amount: 86_706, basis: "5 jam" },
      { code: "BPJS_KES_ALLOW", category: "EARNING", amount: 214_700 },
      { code: "ARREARS", category: "EARNING", amount: 250_000 },
      { code: "PJ_MEDIA", category: "EARNING", amount: 120_000 },
      { code: "LOAN", category: "DEDUCTION", amount: 300_000 },
      { code: "BPJS_KES", category: "DEDUCTION", amount: 214_700 },
      { code: "BPJS_KES_EXTRA", category: "DEDUCTION", amount: 42_940 },
      { code: "CHILD_EDU", category: "DEDUCTION", amount: 400_000 },
    ]);
    expect(result.bpjsBase).toBe(4_294_000);
    expect(result.extraFamilyMembers).toBe(1);
    expect(result.gross).toBe(5_045_406);
    expect(result.deductions).toBe(957_640);
    expect(result.net).toBe(4_087_766);
    expect(result.payable).toBe(4_087_766);
    expect(result.blockers).toEqual([]);
  });
});

describe("PAY-003 period summary and variance", () => {
  it("adds up only aggregate totals", () => {
    const totals = summarizePeriod([run(), run({ employmentId: "employment-2" })]);
    expect(totals.employeeCount).toBe(2);
    expect(totals.gross).toBe(run().gross * 2);
    expect(totals.blockerCount).toBe(0);
  });

  it("warns only when both the relative and the absolute gap are exceeded", () => {
    const threshold = { relative: 0.1, absolute: 50_000, manualInput: 1_000_000 };
    const quiet = detectComponentVariance(
      [{ code: "BASIC", category: "EARNING", amount: 3_040_000 }],
      [{ code: "BASIC", category: "EARNING", amount: 3_000_000 }],
      threshold,
    );
    expect(quiet).toEqual([]);

    const loud = detectComponentVariance(
      [{ code: "PERF", category: "EARNING", amount: 400_000 }],
      [{ code: "PERF", category: "EARNING", amount: 100_000 }],
      threshold,
    );
    expect(loud).toHaveLength(1);
    expect(loud[0]?.code).toBe("COMPONENT_VARIANCE");
  });

  it("warns about a component that appears out of nowhere", () => {
    const warnings = detectComponentVariance(
      [{ code: "ARREARS", category: "EARNING", amount: 2_000_000 }],
      [],
      { relative: 0.1, absolute: 50_000, manualInput: 1_000_000 },
    );
    expect(warnings).toHaveLength(1);
  });
});
