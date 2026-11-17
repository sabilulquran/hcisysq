// PAY-003 §7.5: PPh21 borne by the yayasan (PPH21_EMPLOYER, P6) and daily TER for
// pegawai tidak tetap (21-100-03, P10). Both switches default off. Synthetic
// people and obviously synthetic TER tables; Pasal 17/PTKP as in the annual test,
// so the final-masa figure can be checked by hand.

import { describe, expect, it } from "vitest";

import { buildPph21Report, type Pph21SourceRow } from "../src/modules/payroll/pph21.js";
import { buildAnnualSegments, emptyA1Lines, type AnnualMonth } from "../src/modules/payroll/pph21-annual.js";
import { dailyTaxedEmployees } from "../src/modules/payroll/pph21-annual-store.js";
import { employerPph21Lines } from "../src/modules/payroll/pph21-employer.js";
import {
  DEFAULT_PPH21_SETTINGS,
  parsePph21AnnualPolicy,
  parsePph21Settings,
  parsePph21TerPolicy,
  validatePolicyPayload,
  type Pph21Settings,
} from "../src/modules/payroll/policy.js";
import { employerCostSummary } from "../src/modules/payroll/reports.js";

const TER = (() => {
  const parsed = parsePph21TerPolicy({
    source: "Tabel uji sintetis",
    objectCode: "21-100-01",
    ptkpCategory: { "TK/0": "A" },
    categories: {
      A: [{ upTo: 5_000_000, rate: 0 }, { upTo: null, rate: 0.02 }],
      B: [{ upTo: null, rate: 0.02 }],
      C: [{ upTo: null, rate: 0.03 }],
    },
  });
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.policy;
})();

const ANNUAL = (() => {
  const parsed = parsePph21AnnualPolicy({
    source: "Contoh hitung manual",
    ptkp: { taxpayer: 54_000_000, married: 4_500_000, perDependent: 4_500_000, maxDependents: 3 },
    positionCost: { rate: 0.05, monthlyCap: 500_000, annualCap: 6_000_000 },
    brackets: [{ upTo: 60_000_000, rate: 0.05 }, { upTo: 250_000_000, rate: 0.15 }, { upTo: null, rate: 0.25 }],
    pkpRoundingUnit: 1000,
  });
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.policy;
})();

function settings(payload: Partial<Pph21Settings>): Pph21Settings {
  const parsed = parsePph21Settings({ source: "uji", ...payload });
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.settings;
}

const DAILY = {
  objectCode: "21-100-03" as const,
  brackets: [{ upTo: 450_000, rate: 0 }, { upTo: null, rate: 0.005 }],
  dailyCeiling: 2_500_000,
};

const JUNE = { periodMonth: "2026-06-01", periodStart: "2026-06-01", periodEnd: "2026-06-30" };
const DECEMBER = { periodMonth: "2026-12-01", periodStart: "2026-12-01", periodEnd: "2026-12-31" };

function row(overrides: Partial<Pph21SourceRow> = {}): Pph21SourceRow {
  return {
    employmentId: "employment-1",
    employeeId: "person-1",
    employeeNumber: "2016001",
    fullName: "Pegawai Uji",
    ptkpStatus: "TK/0",
    excluded: false,
    exclusionReason: null,
    payFactor: 1,
    blockerCount: 0,
    serviceEndDate: null,
    hasContinuingEmployment: true,
    termCategory: "TETAP",
    earnings: [{ code: "BASIC", amount: 10_000_000 }],
    deductions: [],
    attendanceDays: null,
    ...overrides,
  };
}

const HONORER = row({
  employmentId: "employment-2",
  employeeId: "person-2",
  employeeNumber: "2016002",
  ptkpStatus: null,
  termCategory: "KONTRAK_HONORER",
  earnings: [{ code: "TRANSPORT", amount: 300_000 }, { code: "TEACH_FEE", amount: 10_700_000 }],
  attendanceDays: 20,
});

describe("PPH21_SETTINGS policy", () => {
  it("defaults both switches off and needs the daily table when P10 is on", () => {
    expect(settings({})).toMatchObject({
      employerBorne: false,
      employerHealthPremiumTaxable: false,
      nonPermanentDailyTer: false,
      daily: null,
    });
    expect(validatePolicyPayload("PPH21_SETTINGS", { source: "uji", nonPermanentDailyTer: true }).ok).toBe(false);
    expect(validatePolicyPayload("PPH21_SETTINGS", { source: "uji", nonPermanentDailyTer: true, daily: DAILY }).ok).toBe(true);
    expect(DEFAULT_PPH21_SETTINGS.employerBorne).toBe(false);
  });
});

describe("daily TER for pegawai tidak tetap (P10)", () => {
  it("leaves honorer on monthly TER 21-100-01 while the switch is off", () => {
    const report = buildPph21Report({ period: JUNE, policy: TER, rows: [HONORER] });
    // No PTKP: monthly TER cannot be computed, exactly as before §7.5.
    expect(report.rows[0]).toMatchObject({ objectCode: "21-100-01", tax: null });
    expect(report.rows[0]!.flags).toContain("PTKP_MISSING");
  });

  it("11 jt over 20 days = 550 rb a day, above 450 rb → 0,5% × 11 jt = 55.000 under 21-100-03, no PTKP needed", () => {
    const report = buildPph21Report({
      period: JUNE,
      policy: TER,
      rows: [HONORER, row()],
      settings: settings({ nonPermanentDailyTer: true, daily: DAILY }),
    });
    const honorer = report.rows.find((r) => r.employeeId === "person-2")!;
    expect(honorer).toMatchObject({ objectCode: "21-100-03", rate: 0.005, tax: 55_000, attendanceDays: 20, terCategory: null });
    expect(honorer.flags).toEqual(["NON_PERMANENT_TERMS"]);
    // The permanent employee is untouched: 10 jt in category A → 2% = 200.000.
    expect(report.rows.find((r) => r.employeeId === "person-1")).toMatchObject({ objectCode: "21-100-01", tax: 200_000 });
    expect(report.totals).toMatchObject({ dailyCount: 1, tax: 255_000 });
  });

  it("is 0 at or below 450 rb a day: 9 jt over 20 days", () => {
    const report = buildPph21Report({
      period: JUNE,
      policy: TER,
      rows: [{ ...HONORER, earnings: [{ code: "TEACH_FEE", amount: 9_000_000 }] }],
      settings: settings({ nonPermanentDailyTer: true, daily: DAILY }),
    });
    expect(report.rows[0]).toMatchObject({ rate: 0, tax: 0 });
  });

  it("flags missing days and an average above the ceiling instead of guessing", () => {
    const on = settings({ nonPermanentDailyTer: true, daily: DAILY });
    const noDays = buildPph21Report({ period: JUNE, policy: TER, rows: [{ ...HONORER, attendanceDays: 0 }], settings: on });
    expect(noDays.rows[0]!.flags).toContain("DAILY_DAYS_MISSING");
    const high = buildPph21Report({ period: JUNE, policy: TER, rows: [{ ...HONORER, attendanceDays: 2 }], settings: on });
    expect(high.rows[0]!.flags).toContain("DAILY_ABOVE_CEILING");
    expect(high.rows[0]!.tax).toBeNull();
  });

  it("keeps a person with a permanent and an honorer employment on monthly TER for the whole gross", () => {
    const on = settings({ nonPermanentDailyTer: true, daily: DAILY });
    const mixed = [row(), { ...HONORER, employeeId: "person-1", employmentId: "employment-9" }];
    const report = buildPph21Report({ period: JUNE, policy: TER, rows: mixed, settings: on });
    // 10 jt + 11 jt = 21 jt in category A → 2% = 420.000 under 21-100-01, never divided by 20 days.
    expect(report.rows[0]).toMatchObject({ objectCode: "21-100-01", gross: 21_000_000, tax: 420_000, attendanceDays: null });
    expect(report.rows[0]!.flags).toEqual(expect.arrayContaining(["MIXED_TERMS", "NON_PERMANENT_TERMS"]));
    expect(dailyTaxedEmployees(mixed, on).size).toBe(0);
  });

  it("never asks for an annual settlement on a daily-taxed row, and leaves it out of the annual months", () => {
    const report = buildPph21Report({
      period: DECEMBER,
      policy: TER,
      rows: [HONORER],
      settings: settings({ nonPermanentDailyTer: true, daily: DAILY }),
    });
    expect(report.rows[0]!.flags).not.toContain("ANNUAL_CALCULATION_REQUIRED");
    expect([...dailyTaxedEmployees([HONORER, row()], settings({ nonPermanentDailyTer: true, daily: DAILY }))]).toEqual(["person-2"]);
    expect(dailyTaxedEmployees([HONORER], DEFAULT_PPH21_SETTINGS).size).toBe(0);
  });
});

describe("PPH21_EMPLOYER (P6)", () => {
  it("writes nothing while the yayasan does not bear the tax", () => {
    expect(employerPph21Lines({ period: JUNE, terPolicy: TER, settings: DEFAULT_PPH21_SETTINGS, rows: [row()], annual: null }).size).toBe(0);
  });

  it("is the month's TER on the person's first paid employment: 10 jt → 200.000", () => {
    const lines = employerPph21Lines({ period: JUNE, terPolicy: TER, settings: settings({ employerBorne: true }), rows: [row()], annual: null });
    expect([...lines]).toEqual([["employment-1", { amount: 200_000, basis: "TER 21-100-01" }]]);
  });

  it("is the daily TER of a pegawai tidak tetap when both switches are on: 55.000", () => {
    const lines = employerPph21Lines({
      period: JUNE,
      terPolicy: TER,
      settings: settings({ employerBorne: true, nonPermanentDailyTer: true, daily: DAILY }),
      rows: [HONORER],
      annual: null,
    });
    expect(lines.get("employment-2")).toEqual({ amount: 55_000, basis: "TER harian 21-100-03" });
  });

  it("settles December with Pasal 17: TK/0 10 jt × 12 → 3.000.000 − TER 2.200.000 = 800.000", () => {
    const prior: AnnualMonth[] = Array.from({ length: 11 }, (_, i) => ({
      taxPeriod: `2026-${String(i + 1).padStart(2, "0")}`,
      employeeId: "person-1",
      employeeNumber: "2016001",
      fullName: "Pegawai Uji",
      ptkpStatus: "TK/0",
      lines: { ...emptyA1Lines(), salary: 10_000_000 },
      gross: 10_000_000,
      pensionContribution: 0,
      terTax: 200_000,
      final: false,
    }));
    const lines = employerPph21Lines({
      period: DECEMBER,
      terPolicy: TER,
      settings: settings({ employerBorne: true }),
      rows: [row()],
      annual: { policy: ANNUAL, priorMonths: prior },
    });
    expect(lines.get("employment-1")).toEqual({ amount: 800_000, basis: "Pasal 17 masa pajak terakhir" });
    // Same figure as the 1721-A1 of that year.
    const [segment] = buildAnnualSegments(ANNUAL, [...prior, { ...prior[0]!, taxPeriod: "2026-12", final: true }]);
    expect(segment!.finalMasaTax).toBe(800_000);
  });

  it("falls back to the TER figure and says so when the annual policy is missing", () => {
    const lines = employerPph21Lines({ period: DECEMBER, terPolicy: TER, settings: settings({ employerBorne: true }), rows: [row()], annual: null });
    expect(lines.get("employment-1")).toEqual({ amount: 200_000, basis: "TER; perhitungan tahunan belum lengkap" });
  });

  // Owner decision 2026-11-17 (section 7.6): the borne tax is computed on the gross
  // of the monthly report, premium included when its own switch is on.
  const WITH_PREMIUM = [{ code: "BASIC", amount: 10_000_000 }, { code: "BPJS_KES_ALLOW", amount: 500_000 }];

  it("ignores the BPJS Kesehatan allowance while the premium is not taxable: still 200.000", () => {
    const lines = employerPph21Lines({
      period: JUNE,
      terPolicy: TER,
      settings: settings({ employerBorne: true }),
      rows: [row({ earnings: WITH_PREMIUM })],
      annual: null,
    });
    expect(lines.get("employment-1")).toEqual({ amount: 200_000, basis: "TER 21-100-01" });
  });

  it("bears the tax on the premium too once it is taxable: 10,5 jt x 2% = 210.000", () => {
    const lines = employerPph21Lines({
      period: JUNE,
      terPolicy: TER,
      settings: settings({ employerBorne: true, employerHealthPremiumTaxable: true }),
      rows: [row({ earnings: WITH_PREMIUM })],
      annual: null,
    });
    expect(lines.get("employment-1")).toEqual({ amount: 210_000, basis: "TER 21-100-01" });
  });

  it("writes no line for a taxable premium alone: the yayasan must also bear the tax", () => {
    const lines = employerPph21Lines({
      period: JUNE,
      terPolicy: TER,
      settings: settings({ employerHealthPremiumTaxable: true }),
      rows: [row({ earnings: WITH_PREMIUM })],
      annual: null,
    });
    expect(lines.size).toBe(0);
  });

  it("settles December on the gross with the premium: 3.900.000 - TER 11 x 210.000 = 1.590.000", () => {
    // 126 jt gross, biaya jabatan capped at 6 jt, neto 120 jt, PKP 66 jt, Pasal 17 3,9 jt.
    const prior: AnnualMonth[] = Array.from({ length: 11 }, (_, i) => ({
      taxPeriod: `2026-${String(i + 1).padStart(2, "0")}`,
      employeeId: "person-1",
      employeeNumber: "2016001",
      fullName: "Pegawai Uji",
      ptkpStatus: "TK/0",
      lines: { ...emptyA1Lines(), salary: 10_000_000, insurancePremium: 500_000 },
      gross: 10_500_000,
      pensionContribution: 0,
      terTax: 210_000,
      final: false,
    }));
    const lines = employerPph21Lines({
      period: DECEMBER,
      terPolicy: TER,
      settings: settings({ employerBorne: true, employerHealthPremiumTaxable: true }),
      rows: [row({ earnings: WITH_PREMIUM })],
      annual: { policy: ANNUAL, priorMonths: prior },
    });
    expect(lines.get("employment-1")).toEqual({ amount: 1_590_000, basis: "Pasal 17 masa pajak terakhir" });
    // Same figure, and the same line 5, as the 1721-A1 of that year.
    const [segment] = buildAnnualSegments(ANNUAL, [...prior, { ...prior[0]!, taxPeriod: "2026-12", final: true }]);
    expect(segment).toMatchObject({ gross: 126_000_000, annualTax: 3_900_000, finalMasaTax: 1_590_000 });
    expect(segment!.lines.insurancePremium).toBe(6_000_000);
  });

  it("skips excluded people and people without a computable tax", () => {
    const lines = employerPph21Lines({
      period: JUNE,
      terPolicy: TER,
      settings: settings({ employerBorne: true }),
      rows: [row({ excluded: true }), row({ employeeId: "person-3", employmentId: "employment-3", ptkpStatus: null })],
      annual: null,
    });
    expect(lines.size).toBe(0);
  });
});

describe("employer cost summary", () => {
  it("adds the BPJS Kesehatan allowance and PPH21_EMPLOYER", () => {
    expect(
      employerCostSummary([
        { componentCode: "BASIC", amount: "100000000" },
        { componentCode: "BPJS_KES_ALLOW", amount: "1500000" },
        { componentCode: "PPH21_EMPLOYER", amount: "255000" },
      ]),
    ).toEqual({ bpjsKesehatan: "1500000", pph21: "255000", total: "1755000" });
    expect(employerCostSummary([])).toEqual({ bpjsKesehatan: "0", pph21: "0", total: "0" });
  });
});
