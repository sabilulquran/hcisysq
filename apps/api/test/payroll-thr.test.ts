// PAY-003-THR engine (docs/domain/payroll-thr.md): eligibility by service, the wage, the
// proportional rule and its rounding, honorarium, adjustments and blockers. Synthetic data only.

import { describe, expect, it } from "vitest";

import type { CompensationProfile, ComponentCode, PayrollPolicy } from "../src/modules/payroll/engine.js";
import { buildPph21Report, type Pph21SourceRow } from "../src/modules/payroll/pph21.js";
import { parsePph21TerPolicy, parseThrPolicy } from "../src/modules/payroll/policy.js";
import {
  averageMonthlyWage,
  calculateEmployeeThr,
  proportionalThr,
  thrAverageWageMonths,
  thrEligibility,
  type ThrAverageWageSource,
  type ThrPaidMonth,
  type ThrPolicy,
} from "../src/modules/payroll/thr.js";

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

  it("blocks an honorarium term on a policy version without the average-wage rule, instead of guessing", () => {
    // THR_POLICY is the version that predates the 2026-11-17 decision: no averageWageComponents.
    const result = thr({ category: "HONORARIUM" });
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(["THR_AVERAGE_WAGE_INCOMPLETE"]);
    expect(result.lines).toEqual([]);
    expect(result.payable).toBe(0);
  });

  it("refuses an average-wage input typed for a salaried employee", () => {
    const result = calculateEmployeeThr({
      profile: PROFILE,
      payDate: PAY_DATE,
      holidayDate: HOLIDAY,
      policy: POLICY,
      thrPolicy: THR_POLICY,
      wageComponents: WAGE,
      adjustment: 0,
      averageWage: { requiredMonths: [], coveredMonths: [], paid: [], hcInput: 1_000_000 },
    });
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(["INPUT_INVALID"]);
    // The wage still comes from the profile; the typed figure changed nothing.
    expect(result.monthlyWage).toBe(3_235_000);
    expect(result.averageWage).toBeUndefined();
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

// T5, section 2.1: honorarium and daily workers (KONTRAK_HONORER, LEPAS), owner decision 2026-11-17.
describe("PAY-003-THR average wage of honorarium workers (T5, section 2.1)", () => {
  /** The policy version of migration 0167. */
  const THR_POLICY_2026_11_17: ThrPolicy = {
    ...THR_POLICY,
    eligibleTermCategories: ["TETAP", "PERCOBAAN", "KONTRAK", "KONTRAK_HONORER", "LEPAS"],
    averageWageComponents: ["TRANSPORT", "TEACH_FEE", "PJ_MEDIA", "OTHER_INCOME"],
  };

  const HONORARIUM: CompensationProfile = {
    ...PROFILE,
    employmentId: "employment-honorer",
    category: "HONORARIUM",
    serviceStartDate: "2024-07-15",
    functionalPositionRef: null,
    teachingHoursPerWeek: null,
  };

  /** The twelve months before a THR paid in March 2027. */
  const WINDOW = [
    "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08",
    "2026-09", "2026-10", "2026-11", "2026-12", "2027-01", "2027-02",
  ];

  const paidMonth = (month: string, transport: number, teachFee = 0, extra: ThrPaidMonth["earnings"] = []): ThrPaidMonth => ({
    month,
    payFactor: 1,
    earnings: [
      { code: "TRANSPORT", amount: transport },
      ...(teachFee > 0 ? [{ code: "TEACH_FEE", amount: teachFee }] : []),
      ...extra,
    ],
  });

  function honorer(
    source: Partial<ThrAverageWageSource>,
    profile: Partial<CompensationProfile> = {},
    adjustment = 0,
    thrPolicy: ThrPolicy = THR_POLICY_2026_11_17,
  ) {
    const merged = { ...HONORARIUM, ...profile };
    return calculateEmployeeThr({
      profile: merged,
      payDate: PAY_DATE,
      holidayDate: HOLIDAY,
      policy: POLICY,
      thrPolicy,
      wageComponents: WAGE,
      adjustment,
      averageWage: {
        requiredMonths: thrAverageWageMonths(PAY_DATE, merged.serviceStartDate, thrPolicy.fullServiceMonths),
        coveredMonths: [],
        paid: [],
        hcInput: null,
        ...source,
      },
    });
  }

  describe("window (H2)", () => {
    it("is the twelve calendar months before the month the THR is paid in", () => {
      expect(thrAverageWageMonths("2027-03-01", "2020-01-01", 12)).toEqual(WINDOW);
      // Paid in February for the same holiday: the window ends in January.
      expect(thrAverageWageMonths("2027-02-26", "2020-01-01", 12)).toEqual([
        "2026-02", ...WINDOW.slice(0, 11),
      ]);
    });

    it("never reaches before the month service started in", () => {
      expect(thrAverageWageMonths("2027-03-01", "2026-12-20", 12)).toEqual(["2026-12", "2027-01", "2027-02"]);
      expect(thrAverageWageMonths("2027-03-01", "2027-02-05", 12)).toEqual(["2027-02"]);
      // Service started in the THR month itself, or the dates are unusable: no month at all.
      expect(thrAverageWageMonths("2027-03-01", "2027-03-01", 12)).toEqual([]);
      expect(thrAverageWageMonths("bukan-tanggal", "2026-12-20", 12)).toEqual([]);
      expect(thrAverageWageMonths("2027-03-01", "2026-12-20", 0)).toEqual([]);
    });

    it("crosses a year boundary without losing a month", () => {
      expect(thrAverageWageMonths("2027-01-15", "2020-01-01", 3)).toEqual(["2026-10", "2026-11", "2026-12"]);
    });
  });

  it("pays the average of twelve fully covered months to someone with twelve months of service", () => {
    // Eleven months at 1 200 000 and one at 600 000: 13 800 000 / 12 = 1 150 000.
    const paid = WINDOW.map((month, index) => paidMonth(month, index === 4 ? 200_000 : 400_000, index === 4 ? 400_000 : 800_000));
    const result = honorer({ coveredMonths: WINDOW, paid });
    expect(result.blockers).toEqual([]);
    expect(result.averageWage).toMatchObject({
      source: "SYSTEM",
      windowStart: "2026-03",
      windowEnd: "2027-02",
      requiredMonths: 12,
      coveredMonths: 12,
      monthsWithPay: 12,
      systemTotal: 13_800_000,
      systemAverage: 1_150_000,
      monthlyWage: 1_150_000,
    });
    expect(result.monthlyWage).toBe(1_150_000);
    expect(amount(result, "THR")).toBe(1_150_000);
    expect(result.lines.map((line) => line.code)).toEqual(["THR"]);
    expect(result.payable).toBe(1_150_000);
    // The slip reads the service months from the end of the basis (T13).
    expect(result.lines[0]!.basis).toMatch(/^rata-rata upah 1150000 \(sistem, 12 bulan\), masa kerja \d+ bulan$/);
  });

  it("divides by every required month, a covered month without pay included", () => {
    // Ten months paid 600 000, two covered months with no result at all: 6 000 000 / 12.
    const paid = WINDOW.slice(0, 10).map((month) => paidMonth(month, 600_000));
    const result = honorer({ coveredMonths: WINDOW, paid });
    expect(result.averageWage).toMatchObject({ source: "SYSTEM", coveredMonths: 12, monthsWithPay: 10, systemAverage: 500_000 });
    expect(amount(result, "THR")).toBe(500_000);
  });

  it("pays a proportional THR on the average of the months in service below twelve months", () => {
    // TMT 20 December 2026: two whole months to the holiday; December, January, February are averaged.
    const months = ["2026-12", "2027-01", "2027-02"];
    const paid = [paidMonth("2026-12", 300_000), paidMonth("2027-01", 900_000), paidMonth("2027-02", 900_000)];
    const result = honorer({ coveredMonths: months, paid }, { serviceStartDate: "2026-12-20" });
    expect(result.serviceMonths).toBe(2);
    expect(result.averageWage).toMatchObject({ source: "SYSTEM", requiredMonths: 3, coveredMonths: 3, systemAverage: 700_000 });
    // 700 000 x 2 / 12 = 116 666.67, rounded up.
    expect(amount(result, "THR")).toBe(116_667);
    expect(result.lines[0]!.basis).toBe("rata-rata upah 700000 (sistem, 3 bulan) x 2/12, masa kerja 2 bulan");
  });

  it("blocks a partly covered window without a typed figure, and pays nothing", () => {
    const covered = WINDOW.slice(9);
    const paid = covered.map((month) => paidMonth(month, 900_000));
    const result = honorer({ coveredMonths: covered, paid });
    expect(result.blockers).toEqual([
      {
        code: "THR_AVERAGE_WAGE_INCOMPLETE",
        message:
          "Rata-rata upah belum lengkap: sistem mencakup 3 dari 12 bulan yang diminta; isi input rata-rata upah THR pegawai ini.",
      },
    ]);
    expect(result.lines).toEqual([]);
    expect(result.payable).toBe(0);
    expect(result.monthlyWage).toBe(0);
    // The partial figure is kept as a reference for the reviewer, never used as the basis.
    expect(result.averageWage).toMatchObject({
      source: "NONE",
      requiredMonths: 12,
      coveredMonths: 3,
      systemTotal: 2_700_000,
      systemAverage: null,
      partialAverage: 900_000,
      monthlyWage: 0,
    });
  });

  it("takes the figure human capital typed when the window is only partly covered", () => {
    const covered = WINDOW.slice(9);
    const paid = covered.map((month) => paidMonth(month, 900_000));
    const result = honorer({ coveredMonths: covered, paid, hcInput: 1_050_000 });
    expect(result.blockers).toEqual([]);
    expect(result.averageWage).toMatchObject({
      source: "HC_INPUT",
      coveredMonths: 3,
      systemAverage: null,
      partialAverage: 900_000,
      monthlyWage: 1_050_000,
    });
    expect(amount(result, "THR")).toBe(1_050_000);
    expect(result.lines[0]!.basis).toMatch(/^rata-rata upah 1050000 \(input HC\), masa kerja \d+ bulan$/);
  });

  it("lets the typed figure stand in when the system holds no month at all", () => {
    const result = honorer({ hcInput: 800_000 }, { serviceStartDate: "2026-09-01" });
    // Six whole months of service: 800 000 x 6 / 12.
    expect(result.serviceMonths).toBe(6);
    expect(result.averageWage).toMatchObject({ source: "HC_INPUT", requiredMonths: 6, coveredMonths: 0, partialAverage: null });
    expect(amount(result, "THR")).toBe(400_000);
  });

  it("uses the typed figure over a fully covered system average, and keeps the system figure beside it", () => {
    const paid = WINDOW.map((month) => paidMonth(month, 1_000_000));
    const result = honorer({ coveredMonths: WINDOW, paid, hcInput: 1_100_000 });
    expect(result.averageWage).toMatchObject({ source: "HC_INPUT", systemAverage: 1_000_000, monthlyWage: 1_100_000 });
    expect(amount(result, "THR")).toBe(1_100_000);
  });

  it("refuses a typed figure that is not a positive whole rupiah", () => {
    for (const hcInput of [0, -5, 1_000_000.5]) {
      const paid = WINDOW.map((month) => paidMonth(month, 1_000_000));
      const result = honorer({ coveredMonths: WINDOW, paid, hcInput });
      expect(result.blockers.map((blocker) => blocker.code)).toEqual(["INPUT_INVALID"]);
      expect(result.payable).toBe(0);
    }
  });

  it("blocks when no month of service lies before the THR month", () => {
    // TMT 5 February 2027, THR paid in February: one month of service at the holiday, nothing to average.
    const result = calculateEmployeeThr({
      profile: { ...HONORARIUM, serviceStartDate: "2027-02-05" },
      payDate: "2027-02-26",
      holidayDate: HOLIDAY,
      policy: POLICY,
      thrPolicy: THR_POLICY_2026_11_17,
      wageComponents: WAGE,
      adjustment: 0,
      averageWage: {
        requiredMonths: thrAverageWageMonths("2027-02-26", "2027-02-05", 12),
        coveredMonths: [],
        paid: [],
        hcInput: null,
      },
    });
    expect(result.serviceMonths).toBe(1);
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(["THR_AVERAGE_WAGE_INCOMPLETE"]);
    expect(result.blockers[0]!.message).toContain("Belum ada bulan penggajian");
  });

  it("counts honorarium pay only: THR, reimbursement, adjustments and other one-offs stay out", () => {
    const paid = WINDOW.map((month) =>
      paidMonth(month, 300_000, 500_000, [
        { code: "PJ_MEDIA", amount: 60_000 },
        { code: "OTHER_INCOME", amount: 40_000 },
        // None of these is a wage received (H4).
        { code: "THR", amount: 5_000_000 },
        { code: "REIMBURSE", amount: 750_000 },
        { code: "ADJUST_EARN", amount: 250_000 },
        { code: "ARREARS", amount: 125_000 },
        { code: "OVERTIME", amount: 99_000 },
        { code: "BPJS_KES_ALLOW", amount: 88_000 },
      ]),
    );
    const result = honorer({ coveredMonths: WINDOW, paid });
    // 300 000 + 500 000 + 60 000 + 40 000 each month.
    expect(result.averageWage).toMatchObject({ systemTotal: 10_800_000, systemAverage: 900_000 });
    expect(amount(result, "THR")).toBe(900_000);
  });

  it("counts the THR wage components of a month paid on a salary basis, through its pay factor", () => {
    // Eleven honorarium months and one month as salaried staff in early service (80%):
    // BASIC 2 000 000 + FUNC 400 000 = 2 400 000 x 0.8 = 1 920 000; overtime is not a wage.
    const paid = [
      ...WINDOW.slice(0, 11).map((month) => paidMonth(month, 1_000_000)),
      {
        month: "2027-02",
        payFactor: 0.8,
        earnings: [
          { code: "BASIC", amount: 2_000_000 },
          { code: "FUNC", amount: 400_000 },
          { code: "OVERTIME", amount: 300_000 },
        ],
      },
    ];
    const result = honorer({ coveredMonths: WINDOW, paid });
    // (11 000 000 + 1 920 000) / 12 = 1 076 666.67, rounded up.
    expect(result.averageWage).toMatchObject({ systemTotal: 12_920_000, systemAverage: 1_076_667 });
  });

  it("ignores a result of a month that is not covered or not required", () => {
    const covered = WINDOW;
    const paid = [
      ...WINDOW.map((month) => paidMonth(month, 600_000)),
      // Outside the window: before it, and the THR month itself.
      paidMonth("2026-02", 9_000_000),
      paidMonth("2027-03", 9_000_000),
    ];
    const result = honorer({ coveredMonths: [...covered, "2026-02", "2027-03"], paid });
    expect(result.averageWage).toMatchObject({ coveredMonths: 12, systemTotal: 7_200_000, systemAverage: 600_000 });
  });

  it("rounds the average up to a whole rupiah without a binary fraction", () => {
    const source = (total: number, months: string[]): ThrAverageWageSource => ({
      requiredMonths: months,
      coveredMonths: months,
      paid: [paidMonth(months[0]!, total)],
      hcInput: null,
    });
    const counted = ["TRANSPORT"];
    // 10 000 001 / 12 = 833 333.4166..., rounded up; an exact quotient stays exact.
    expect(averageMonthlyWage(source(10_000_001, WINDOW), counted).systemAverage).toBe(833_334);
    expect(averageMonthlyWage(source(10_000_008, WINDOW), counted).systemAverage).toBe(833_334);
    expect(averageMonthlyWage(source(12_000_000, WINDOW), counted).systemAverage).toBe(1_000_000);
    // 0.1 + 0.2 territory: 3 x 0.1 would not be 0.3, but integers divide exactly.
    expect(averageMonthlyWage(source(1_000_000, WINDOW.slice(0, 3)), counted).systemAverage).toBe(333_334);
    expect(averageMonthlyWage(source(999_999, WINDOW.slice(0, 3)), counted).systemAverage).toBe(333_333);
    // A large total stays exact: 12 x 123 456 789 + 1.
    expect(averageMonthlyWage(source(1_481_481_469, WINDOW), counted).systemAverage).toBe(123_456_790);
    // Nothing paid in a fully covered window is an average of zero, not a missing one.
    expect(averageMonthlyWage({ ...source(0, WINDOW), paid: [] }, counted)).toMatchObject({
      source: "SYSTEM", systemAverage: 0, monthsWithPay: 0, monthlyWage: 0,
    });
  });

  it("pays nothing, without a blocker, when the fully covered average is zero", () => {
    const result = honorer({ coveredMonths: WINDOW, paid: [] });
    expect(result.blockers).toEqual([]);
    expect(result.lines).toEqual([]);
    expect(result.payable).toBe(0);
  });

  it("adds an authorised adjustment and still refuses a missing account", () => {
    const paid = WINDOW.map((month) => paidMonth(month, 1_000_000));
    const plus = honorer({ coveredMonths: WINDOW, paid }, {}, 50_000);
    expect(amount(plus, "ADJUST_EARN")).toBe(50_000);
    expect(plus.payable).toBe(1_050_000);
    const noAccount = honorer({ coveredMonths: WINDOW, paid }, { bankAccountName: null });
    expect(noAccount.blockers.map((blocker) => blocker.code)).toEqual(["BANK_ACCOUNT_MISSING"]);
  });

  it("calculates a mixed population, each on its own basis", () => {
    const paid = WINDOW.map((month) => paidMonth(month, 400_000, 800_000));
    const results = [
      thr(),
      thr({ employmentId: "employment-baru", serviceStartDate: "2026-12-05" }),
      honorer({ coveredMonths: WINDOW, paid }),
      honorer({ coveredMonths: WINDOW.slice(9), paid: paid.slice(9) }, { employmentId: "employment-honorer-baru-di-sistem" }),
    ];
    expect(results.map((result) => amount(result, "THR"))).toEqual([3_235_000, 625_000, 1_200_000, 0]);
    expect(results.map((result) => result.blockers.map((blocker) => blocker.code))).toEqual([
      [], [], [], ["THR_AVERAGE_WAGE_INCOMPLETE"],
    ]);
    // Only honorarium rows carry the average-wage trace.
    expect(results.map((result) => result.averageWage?.source ?? null)).toEqual([null, null, "SYSTEM", "NONE"]);
  });

  it("accepts the policy version of migration 0167 and the one before it", () => {
    const row = (payload: unknown) => [{ id: "versi", policyKey: "THR", payload }];
    const current = parseThrPolicy(row(THR_POLICY_2026_11_17));
    expect(current.ok && current.policy.averageWageComponents).toEqual(["TRANSPORT", "TEACH_FEE", "PJ_MEDIA", "OTHER_INCOME"]);
    const earlier = parseThrPolicy(row(THR_POLICY));
    expect(earlier.ok && earlier.policy.averageWageComponents).toBeUndefined();
    expect(parseThrPolicy(row({ ...THR_POLICY_2026_11_17, averageWageComponents: [] })).ok).toBe(false);
  });

  // T10: the THR joins the month's gross and is taxed with monthly TER, honorarium workers included
  // (owner decision 2026-11-17: they stay on monthly TER; the daily-TER switch is off).
  it("is taxed with the salary of its month on monthly TER", () => {
    const ter = parsePph21TerPolicy({
      source: "uji sintetis",
      objectCode: "21-100-01",
      ptkpCategory: { "TK/0": "A" },
      categories: {
        A: [{ upTo: 5_400_000, rate: 0 }, { upTo: 5_650_000, rate: 0.0025 }, { upTo: null, rate: 0.01 }],
        B: [{ upTo: null, rate: 0 }],
        C: [{ upTo: null, rate: 0 }],
      },
    });
    if (!ter.ok) throw new Error(ter.message);
    const paid = WINDOW.map((month) => paidMonth(month, 2_000_000, 2_600_000));
    const thrResult = honorer({ coveredMonths: WINDOW, paid });
    expect(amount(thrResult, "THR")).toBe(4_600_000);

    const base: Omit<Pph21SourceRow, "earnings" | "periodKind"> = {
      employmentId: HONORARIUM.employmentId,
      employeeId: "pegawai-honorer",
      employeeNumber: "H-001",
      fullName: "Honorer Uji",
      ptkpStatus: "TK/0",
      excluded: false,
      exclusionReason: null,
      payFactor: 1,
      blockerCount: 0,
      serviceEndDate: null,
      hasContinuingEmployment: true,
      termCategory: "KONTRAK_HONORER",
    };
    const report = buildPph21Report({
      period: { periodMonth: "2027-03-01", periodStart: "2027-03-01", periodEnd: "2027-03-31" },
      policy: ter.policy,
      rows: [
        { ...base, periodKind: "REGULAR", earnings: [{ code: "TRANSPORT", amount: 2_000_000 }, { code: "TEACH_FEE", amount: 2_600_000 }] },
        { ...base, periodKind: "THR", earnings: thrResult.lines.map((line) => ({ code: line.code, amount: line.amount })) },
      ],
    });
    expect(report.rows).toHaveLength(1);
    // 4 600 000 salary alone is below the first bracket; with the THR the month is 9 200 000 at 1%.
    expect(report.rows[0]).toMatchObject({
      gross: 9_200_000,
      rate: 0.01,
      tax: 92_000,
      objectCode: "21-100-01",
      attendanceDays: null,
    });
    expect(report.rows[0]!.flags).toEqual(expect.arrayContaining(["INCLUDES_THR", "NON_PERMANENT_TERMS"]));
  });
});
