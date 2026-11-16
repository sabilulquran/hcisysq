// PAY-003 annual PPh21 (Pasal 17) and 1721-A1: the pure calculation, its policy
// shape, the recap CSV and the tax identity seal. Synthetic people only.
//
// The policy below uses the PTKP of PMK 101/2016 and the Pasal 17 layers of UU
// 7/2021 (HPP) so each expected figure can be checked by hand against the law.
// The application never reads them from here: production values are the
// PPH21_ANNUAL policy row the process owner loads and verifies (section 10 item 9).

import { describe, expect, it } from "vitest";

import {
  a1LinesOf,
  annualMonthsOfPeriod,
  buildAnnualSegments,
  emptyA1Lines,
  pasal17Tax,
  positionCost,
  ptkpAmount,
  type AnnualMonth,
} from "../src/modules/payroll/pph21-annual.js";
import { annualRecapToCsv } from "../src/modules/payroll/pph21-annual-store.js";
import type { Pph21SourceRow } from "../src/modules/payroll/pph21.js";
import { parsePph21AnnualPolicy, validatePolicyPayload, type Pph21AnnualPolicy } from "../src/modules/payroll/policy.js";
import {
  maskTaxNumber,
  normalizeTaxNumber,
  openTaxIdentity,
  sealTaxIdentity,
  taxNumberProblem,
} from "../src/modules/payroll/tax-identity.js";

const PAYLOAD = {
  source: "Contoh hitung manual: PTKP PMK 101/2016, tarif Pasal 17 UU 7/2021",
  ptkp: { taxpayer: 54_000_000, married: 4_500_000, perDependent: 4_500_000, maxDependents: 3 },
  positionCost: { rate: 0.05, monthlyCap: 500_000, annualCap: 6_000_000 },
  brackets: [
    { upTo: 60_000_000, rate: 0.05 },
    { upTo: 250_000_000, rate: 0.15 },
    { upTo: 500_000_000, rate: 0.25 },
    { upTo: 5_000_000_000, rate: 0.3 },
    { upTo: null, rate: 0.35 },
  ],
  pkpRoundingUnit: 1000,
  pensionContributionComponents: ["JHT_EMPLOYEE"],
};

function policy(): Pph21AnnualPolicy {
  const parsed = parsePph21AnnualPolicy(PAYLOAD);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.policy;
}

function month(taxPeriod: string, overrides: Partial<AnnualMonth> = {}): AnnualMonth {
  const gross = overrides.gross ?? 10_000_000;
  return {
    taxPeriod,
    employeeId: "person-1",
    employeeNumber: "2016001",
    fullName: "Pegawai Uji",
    ptkpStatus: "TK/0",
    lines: { ...emptyA1Lines(), salary: gross },
    gross,
    pensionContribution: 0,
    terTax: 200_000,
    final: taxPeriod.endsWith("-12"),
    ...overrides,
  };
}

const YEAR = (overrides: (m: string) => Partial<AnnualMonth> = () => ({})) =>
  Array.from({ length: 12 }, (_, i) => {
    const m = `2026-${String(i + 1).padStart(2, "0")}`;
    return month(m, overrides(m));
  });

describe("PPH21_ANNUAL policy", () => {
  it("accepts the shape and is a writable policy key", () => {
    expect(validatePolicyPayload("PPH21_ANNUAL", PAYLOAD)).toEqual({ ok: true });
    expect(policy().withholder).toEqual({ name: "Yayasan Sabilul Qur'an", taxNumber: null });
  });

  it("refuses an open-ended layer before the last one", () => {
    const result = validatePolicyPayload("PPH21_ANNUAL", {
      ...PAYLOAD,
      brackets: [{ upTo: null, rate: 0.05 }, { upTo: null, rate: 0.35 }],
    });
    expect(result.ok).toBe(false);
  });
});

describe("building blocks, by hand", () => {
  it("PTKP: TK/0 54 jt, K/0 58,5 jt, K/3 72 jt, K/5 capped at three dependents, K/I/1 not guessed", () => {
    expect(ptkpAmount(policy(), "TK/0")).toBe(54_000_000);
    expect(ptkpAmount(policy(), "k / 0")).toBe(58_500_000);
    expect(ptkpAmount(policy(), "K/3")).toBe(72_000_000);
    expect(ptkpAmount(policy(), "K/5")).toBe(72_000_000);
    expect(ptkpAmount(policy(), "K/I/1")).toBeNull();
    expect(ptkpAmount(policy(), null)).toBeNull();
  });

  it("biaya jabatan: 5% of gross, at most 500 rb per month of the span and 6 jt a year", () => {
    expect(positionCost(policy(), 48_000_000, 6)).toBe(2_400_000); // 5% = 2,4 jt < 3 jt
    expect(positionCost(policy(), 120_000_000, 6)).toBe(3_000_000); // 6 × 500 rb
    expect(positionCost(policy(), 390_000_000, 12)).toBe(6_000_000); // annual cap
    expect(positionCost(policy(), 0, 12)).toBe(0);
  });

  it("Pasal 17 layers: 325,5 jt → 3 jt + 28,5 jt + 18,875 jt = 50,375 jt", () => {
    expect(pasal17Tax(policy(), 60_000_000)).toBe(3_000_000);
    expect(pasal17Tax(policy(), 325_500_000)).toBe(50_375_000);
    expect(pasal17Tax(policy(), 0)).toBe(0);
  });

  it("splits earnings into A1 lines and keeps their sum equal to the paid gross under a pay factor", () => {
    const row = {
      payFactor: 0.8,
      earnings: [
        { code: "BASIC", amount: 3_000_001 },
        { code: "PERF", amount: 1_000_001 },
        { code: "TEACH_FEE", amount: 500_001 },
        { code: "BPJS_KES_ALLOW", amount: 150_000 },
      ],
    };
    const lines = a1LinesOf(row);
    // reportableGross = ROUNDUP(4.500.003 × 0,8) = 3.600.003; floors are 2.400.000 + 800.000 + 400.000 = 3.600.000.
    expect(lines.salary + lines.otherAllowances + lines.honorarium).toBe(3_600_003);
    expect(lines).toMatchObject({ salary: 2_400_003, otherAllowances: 800_000, honorarium: 400_000, insurancePremium: 0 });
  });

  it("honours a policy override of a component's line", () => {
    expect(a1LinesOf({ payFactor: 1, earnings: [{ code: "ARREARS", amount: 100 }] }, { ARREARS: "salary" }).salary).toBe(100);
  });
});

describe("annual settlement, by hand", () => {
  it("Desember, TK/0, 10 jt × 12: neto 114 jt, PKP 60 jt, PPh21 setahun 3 jt, TER Jan–Nov 2,2 jt, Desember 800 rb", () => {
    const [segment] = buildAnnualSegments(policy(), YEAR());
    expect(segment).toMatchObject({
      index: 1,
      closed: true,
      startPeriod: "2026-01",
      endPeriod: "2026-12",
      monthCount: 12,
      gross: 120_000_000,
      positionCost: 6_000_000,
      net: 114_000_000,
      ptkp: 54_000_000,
      pkp: 60_000_000,
      annualTax: 3_000_000,
      terWithheld: 2_200_000,
      finalMasaTax: 800_000,
      flags: [],
    });
  });

  it("rounds PKP down to whole thousands: neto 114.000.750 → PKP 60.000.000", () => {
    const months = YEAR((m) => (m === "2026-03" ? { gross: 10_000_750, lines: { ...emptyA1Lines(), salary: 10_000_750 } } : {}));
    const [segment] = buildAnnualSegments(policy(), months);
    // biaya jabatan stays 6 jt (5% of 120.000.750 = 6.000.037 > cap)
    expect(segment!.net).toBe(114_000_750);
    expect(segment!.pkp).toBe(60_000_000);
    expect(segment!.annualTax).toBe(3_000_000);
  });

  it("berhenti Juni, K/2, 8 jt × 6 dengan JHT 100 rb: neto 45 jt < PTKP 67,5 jt, lebih potong 600 rb", () => {
    const months = Array.from({ length: 6 }, (_, i) =>
      month(`2026-0${i + 1}`, {
        ptkpStatus: "K/2",
        gross: 8_000_000,
        lines: { ...emptyA1Lines(), salary: 8_000_000 },
        pensionContribution: 100_000,
        terTax: 120_000,
        final: i === 5,
      }),
    );
    const [segment] = buildAnnualSegments(policy(), months);
    expect(segment).toMatchObject({
      closed: true,
      gross: 48_000_000,
      positionCost: 2_400_000,
      pensionContribution: 600_000,
      net: 45_000_000,
      ptkp: 67_500_000,
      pkp: 0,
      annualTax: 0,
      terWithheld: 600_000,
      finalMasaTax: -600_000,
    });
  });

  it("TK/1, 30 jt × 12 plus THR 30 jt: PKP 325,5 jt, PPh21 setahun 50.375.000", () => {
    const months = YEAR((m) => ({
      ptkpStatus: "TK/1",
      gross: m === "2026-04" ? 60_000_000 : 30_000_000,
      lines: { ...emptyA1Lines(), salary: 30_000_000, bonusThr: m === "2026-04" ? 30_000_000 : 0 },
      terTax: 4_000_000,
    }));
    const [segment] = buildAnnualSegments(policy(), months);
    expect(segment!.lines.bonusThr).toBe(30_000_000);
    expect(segment!.gross).toBe(390_000_000);
    expect(segment!.net).toBe(384_000_000);
    expect(segment!.pkp).toBe(325_500_000);
    expect(segment!.annualTax).toBe(50_375_000);
    expect(segment!.finalMasaTax).toBe(50_375_000 - 44_000_000);
  });

  it("keeps a year that has not reached December open, with no annual figures", () => {
    const [segment] = buildAnnualSegments(policy(), YEAR().slice(0, 10));
    expect(segment).toMatchObject({ closed: false, annualTax: null, finalMasaTax: null, terWithheld: 2_000_000 });
    expect(segment!.flags).toEqual(["OPEN"]);
  });

  it("gives a person who leaves and returns within the year two bukti potong", () => {
    const months = [
      month("2026-01"),
      month("2026-02", { final: true }),
      month("2026-07"),
      month("2026-12"),
    ];
    const segments = buildAnnualSegments(policy(), months);
    expect(segments.map((s) => [s.index, s.startPeriod, s.endPeriod, s.closed])).toEqual([
      [1, "2026-01", "2026-02", true],
      [2, "2026-07", "2026-12", true],
    ]);
  });

  it("follows the PTKP status at the start of the span, and flags a missing one", () => {
    const changed = YEAR((m) => ({ ptkpStatus: m < "2026-06" ? "TK/0" : "K/0" }));
    expect(buildAnnualSegments(policy(), changed)[0]!.ptkp).toBe(54_000_000);
    const [missing] = buildAnnualSegments(policy(), YEAR(() => ({ ptkpStatus: null })));
    expect(missing).toMatchObject({ annualTax: null, finalMasaTax: null });
    expect(missing!.flags).toContain("PTKP_MISSING");
  });

  it("does not settle the final month when an earlier month's TER is unknown", () => {
    const [segment] = buildAnnualSegments(policy(), YEAR((m) => (m === "2026-05" ? { terTax: null } : {})));
    expect(segment).toMatchObject({ annualTax: 3_000_000, terWithheld: null, finalMasaTax: null });
    expect(segment!.flags).toEqual(["PRIOR_TAX_INCOMPLETE"]);
  });
});

describe("months from one period", () => {
  const period = { periodMonth: "2026-06-01", periodStart: "2026-06-01", periodEnd: "2026-06-30" };
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
      earnings: [{ code: "BASIC", amount: 5_000_000 }],
      deductions: [{ code: "JHT_EMPLOYEE", amount: 100_000 }, { code: "LOAN", amount: 250_000 }],
      ...overrides,
    };
  }

  it("sums two employments, reads the pension contribution, and marks the month the service ends", () => {
    const months = annualMonthsOfPeriod({
      period,
      rows: [
        row({ hasContinuingEmployment: false, serviceEndDate: "2026-06-15" }),
        row({ employmentId: "employment-2", hasContinuingEmployment: false, earnings: [{ code: "PERF", amount: 1_000_000 }], deductions: [] }),
      ],
      terTaxByEmployee: new Map([["person-1", 90_000]]),
      policy: policy(),
    });
    expect(months).toEqual([
      expect.objectContaining({
        taxPeriod: "2026-06",
        gross: 6_000_000,
        pensionContribution: 100_000,
        terTax: 90_000,
        final: true,
        lines: expect.objectContaining({ salary: 5_000_000, otherAllowances: 1_000_000 }),
      }),
    ]);
  });

  it("leaves out excluded people and blocked employments, and has no TER without a TER report", () => {
    expect(annualMonthsOfPeriod({ period, rows: [row({ excluded: true })], terTaxByEmployee: null, policy: policy() })).toEqual([]);
    expect(annualMonthsOfPeriod({ period, rows: [row({ blockerCount: 1 })], terTaxByEmployee: null, policy: policy() })).toEqual([]);
    expect(annualMonthsOfPeriod({ period, rows: [row()], terTaxByEmployee: null, policy: policy() })[0]!.terTax).toBeNull();
  });
});

describe("recap CSV", () => {
  it("prints NIK/NPWP as text, BOM and CRLF, and a note for an open span", () => {
    const segments = buildAnnualSegments(policy(), [...YEAR(), ...YEAR().slice(0, 3).map((m) => ({ ...m, employeeId: "person-2", employeeNumber: "0201", final: false }))]);
    const csv = annualRecapToCsv(segments, new Map([["person-1", { nik: "3209010101900001", npwp: null }]]));
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1).startsWith(`"NIP","Nama","NIK","NPWP"`)).toBe(true);
    const lines = csv.split("\r\n");
    expect(lines[1]).toContain("'0201");
    expect(lines[1]).toContain("Masa pajak terakhir belum tiba");
    expect(lines[2]).toContain("'3209010101900001");
    expect(lines[2]).toContain(`,"800000","Y",`);
  });
});

describe("tax identity seal", () => {
  const key = "11".repeat(32);
  it("opens only for the same employee and field", () => {
    const sealed = sealTaxIdentity(key, "person-1", "nik", "3209010101900001");
    expect(sealed).not.toContain("3209010101900001");
    expect(openTaxIdentity(key, "person-1", "nik", sealed)).toBe("3209010101900001");
    expect(() => openTaxIdentity(key, "person-2", "nik", sealed)).toThrow();
    expect(() => openTaxIdentity(key, "person-1", "npwp", sealed)).toThrow();
    expect(() => openTaxIdentity("22".repeat(32), "person-1", "nik", sealed)).toThrow();
  });

  it("validates and masks numbers", () => {
    expect(normalizeTaxNumber("01.234.567.8-901.000")).toBe("012345678901000");
    expect(taxNumberProblem("npwp", "012345678901000")).toBeNull();
    expect(taxNumberProblem("nik", "12345")).not.toBeNull();
    expect(taxNumberProblem("nik", "3209010101900001")).toBeNull();
    expect(maskTaxNumber("0001")).toBe("************0001");
    expect(maskTaxNumber(null)).toBeNull();
  });
});
