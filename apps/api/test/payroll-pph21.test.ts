// PAY-003 PPh21 TER report: the pure computation, the PPH21_TER policy shape,
// and the CSV. Synthetic data only. The brackets below are deliberately not the
// PP 58/2023 values: statutory tables are policy rows the process owner loads
// and verifies, never constants in code or tests (specification section 10 item 9).

import { describe, expect, it } from "vitest";

import {
  buildPph21Report,
  needsAnnualCalculation,
  reportableGross,
  terCategoryFor,
  terRate,
  terTax,
  type Pph21SourceRow,
} from "../src/modules/payroll/pph21.js";
import { parsePph21TerPolicy, validatePolicyPayload, type Pph21TerPolicy } from "../src/modules/payroll/policy.js";
import { pph21ExclusionFor } from "../src/modules/payroll/initial-load.js";
import { formatTerRate, pph21ReportToCsv, pph21RowNote } from "../src/modules/payroll/reports.js";

/** Round synthetic numbers, obviously not a statutory table. */
const POLICY_PAYLOAD = {
  source: "Tabel uji sintetis (bukan lampiran PP 58/2023)",
  objectCode: "21-100-01",
  ptkpCategory: { "TK/0": "A", "K/0": "A", "K/1": "B", "K/3": "C" },
  categories: {
    A: [
      { upTo: 1_000_000, rate: 0 },
      { upTo: 5_000_000, rate: 0.01 },
      { upTo: null, rate: 0.1 },
    ],
    B: [
      { upTo: 2_000_000, rate: 0 },
      { upTo: null, rate: 0.02 },
    ],
    C: [{ upTo: null, rate: 0.03 }],
  },
};

function policy(): Pph21TerPolicy {
  const parsed = parsePph21TerPolicy(POLICY_PAYLOAD);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.policy;
}

const SEPTEMBER = { periodMonth: "2026-09-01", periodStart: "2026-09-01", periodEnd: "2026-09-30" };

/** One employment; a different employee number is a different person unless employeeId says otherwise. */
function source(overrides: Partial<Pph21SourceRow> = {}): Pph21SourceRow {
  const employeeNumber = overrides.employeeNumber ?? "2016001";
  return {
    employmentId: `employment-${employeeNumber}`,
    employeeId: `person-${employeeNumber}`,
    employeeNumber,
    fullName: "Pegawai Uji",
    ptkpStatus: "TK/0",
    excluded: false,
    exclusionReason: null,
    payFactor: 1,
    blockerCount: 0,
    serviceEndDate: null,
    hasContinuingEmployment: false,
    termCategory: "TETAP",
    earnings: [{ code: "BASIC", amount: 3_000_000 }],
    ...overrides,
  };
}

describe("PAY-003 PPH21_TER policy shape", () => {
  it("accepts a complete table", () => {
    expect(validatePolicyPayload("PPH21_TER", POLICY_PAYLOAD)).toEqual({ ok: true });
  });

  it("requires the legal source inside the payload", () => {
    expect(validatePolicyPayload("PPH21_TER", { ...POLICY_PAYLOAD, source: undefined }).ok).toBe(false);
    expect(validatePolicyPayload("PPH21_TER", { ...POLICY_PAYLOAD, source: " " }).ok).toBe(false);
  });

  it("accepts only the monthly permanent-employee object code", () => {
    const result = validatePolicyPayload("PPH21_TER", { ...POLICY_PAYLOAD, objectCode: "21-100-02" });
    expect(result.ok).toBe(false);
  });

  it("refuses a category outside A, B and C, and a missing table", () => {
    expect(validatePolicyPayload("PPH21_TER", { ...POLICY_PAYLOAD, ptkpCategory: { "TK/0": "D" } }).ok).toBe(false);
    const twoTables = { A: POLICY_PAYLOAD.categories.A, B: POLICY_PAYLOAD.categories.B };
    expect(validatePolicyPayload("PPH21_TER", { ...POLICY_PAYLOAD, categories: twoTables }).ok).toBe(false);
  });

  it("refuses an empty PTKP mapping, and a status listed twice in different spelling", () => {
    expect(validatePolicyPayload("PPH21_TER", { ...POLICY_PAYLOAD, ptkpCategory: {} }).ok).toBe(false);
    const duplicate = validatePolicyPayload("PPH21_TER", {
      ...POLICY_PAYLOAD,
      ptkpCategory: { "TK/0": "A", "tk / 0": "B" },
    });
    expect(duplicate).toMatchObject({ ok: false, message: expect.stringContaining("lebih dari sekali") });
  });

  it("requires the last bracket, and only the last, to be open-ended", () => {
    const closed = { ...POLICY_PAYLOAD, categories: { ...POLICY_PAYLOAD.categories, C: [{ upTo: 9_000_000, rate: 0.03 }] } };
    expect(validatePolicyPayload("PPH21_TER", closed)).toMatchObject({
      ok: false,
      message: expect.stringContaining("categories.C.0.upTo"),
    });
    const openEarly = {
      ...POLICY_PAYLOAD,
      categories: { ...POLICY_PAYLOAD.categories, B: [{ upTo: null, rate: 0 }, { upTo: null, rate: 0.02 }] },
    };
    expect(validatePolicyPayload("PPH21_TER", openEarly).ok).toBe(false);
  });

  it("requires the brackets to rise", () => {
    const unordered = {
      ...POLICY_PAYLOAD,
      categories: {
        ...POLICY_PAYLOAD.categories,
        A: [{ upTo: 5_000_000, rate: 0.01 }, { upTo: 5_000_000, rate: 0.02 }, { upTo: null, rate: 0.1 }],
      },
    };
    expect(validatePolicyPayload("PPH21_TER", unordered)).toMatchObject({
      ok: false,
      message: expect.stringContaining("naik berurutan"),
    });
  });

  it("refuses a rate outside 0..1 and a bound that is not whole rupiah", () => {
    const tooHigh = { ...POLICY_PAYLOAD, categories: { ...POLICY_PAYLOAD.categories, C: [{ upTo: null, rate: 1.5 }] } };
    expect(validatePolicyPayload("PPH21_TER", tooHigh).ok).toBe(false);
    const fractional = {
      ...POLICY_PAYLOAD,
      categories: { ...POLICY_PAYLOAD.categories, B: [{ upTo: 2_000_000.5, rate: 0 }, { upTo: null, rate: 0.02 }] },
    };
    expect(validatePolicyPayload("PPH21_TER", fractional).ok).toBe(false);
  });
});

describe("PAY-003 PPh21 brackets", () => {
  it("takes the first bracket whose upper bound reaches the gross, inclusive", () => {
    expect(terRate(policy(), "A", 1_000_000)).toBe(0);
    expect(terRate(policy(), "A", 1_000_001)).toBe(0.01);
    expect(terRate(policy(), "A", 5_000_000)).toBe(0.01);
  });

  it("uses the open-ended bracket above the last bound", () => {
    expect(terRate(policy(), "A", 5_000_001)).toBe(0.1);
    expect(terRate(policy(), "C", 0)).toBe(0.03);
  });

  it("rounds the tax down to a whole rupiah", () => {
    expect(terTax(1_234_567, 0.01)).toBe(12_345);
    // 0.07 * 100000 is 7000.000000000001 in binary floating point, and a
    // product just under a whole rupiah must not lose one either.
    expect(terTax(100_000, 0.07)).toBe(7_000);
    expect(terTax(5_000_000, 0.0125)).toBe(62_500);
  });

  it("charges nothing on a gross of zero or less", () => {
    expect(terTax(0, 0.1)).toBe(0);
    expect(terTax(-5_000, 0.1)).toBe(0);
  });

  it("matches a PTKP status regardless of spacing and case", () => {
    expect(terCategoryFor(policy(), "k / 1")).toBe("B");
    expect(terCategoryFor(policy(), "K/3")).toBe("C");
    expect(terCategoryFor(policy(), "K/2")).toBeNull();
    expect(terCategoryFor(policy(), null)).toBeNull();
    expect(terCategoryFor(policy(), "  ")).toBeNull();
  });
});

describe("PAY-003 PPh21 gross actually paid", () => {
  it("counts every earning except the BPJS Kesehatan allowance", () => {
    expect(
      reportableGross({
        payFactor: 1,
        earnings: [
          { code: "BASIC", amount: 3_000_000 },
          { code: "PERF", amount: 400_000 },
          { code: "BPJS_KES_ALLOW", amount: 150_000 },
        ],
      }),
    ).toBe(3_400_000);
  });

  it("scales by the pay factor and rounds up, the way the payable is", () => {
    expect(reportableGross({ payFactor: 0.8, earnings: [{ code: "BASIC", amount: 3_000_001 }] })).toBe(2_400_001);
    expect(reportableGross({ payFactor: 0.3333, earnings: [{ code: "BASIC", amount: 1_000_000 }] })).toBe(333_300);
    expect(reportableGross({ payFactor: 0.5, earnings: [{ code: "BASIC", amount: 1_000_001 }] })).toBe(500_001);
  });

  it("leaves the gross untouched without a factor", () => {
    expect(reportableGross({ payFactor: 1, earnings: [{ code: "TRANSPORT", amount: 270_000 }] })).toBe(270_000);
  });
});

describe("PAY-003 PPh21 final masa pajak", () => {
  it("marks December, whose PPh21 is settled by the annual calculation", () => {
    const december = { periodMonth: "2026-12-01", periodStart: "2026-12-01", periodEnd: "2026-12-31" };
    expect(needsAnnualCalculation(december, [null], false)).toBe(true);
    expect(needsAnnualCalculation(december, [null], true)).toBe(true);
  });

  it("marks service that ends inside the period, on either edge", () => {
    expect(needsAnnualCalculation(SEPTEMBER, ["2026-09-01"], false)).toBe(true);
    expect(needsAnnualCalculation(SEPTEMBER, ["2026-09-30"], false)).toBe(true);
  });

  it("does not mark an employment that ends while another continues past the period", () => {
    expect(needsAnnualCalculation(SEPTEMBER, ["2026-09-15", null], true)).toBe(false);
  });

  it("leaves an employment that ends later, or ended before, unmarked", () => {
    expect(needsAnnualCalculation(SEPTEMBER, ["2026-10-01"], false)).toBe(false);
    expect(needsAnnualCalculation(SEPTEMBER, ["2026-08-31"], false)).toBe(false);
    expect(needsAnnualCalculation(SEPTEMBER, [null], false)).toBe(false);
  });
});

describe("PAY-003 PPh21 report", () => {
  it("reports gross, rate and tax per employee, with totals", () => {
    const report = buildPph21Report({
      period: SEPTEMBER,
      policy: policy(),
      rows: [
        source({ employeeNumber: "1", earnings: [{ code: "BASIC", amount: 3_000_000 }] }),
        source({ employeeNumber: "2", ptkpStatus: "K/1", earnings: [{ code: "BASIC", amount: 4_000_000 }] }),
      ],
    });
    expect(report.taxPeriod).toBe("2026-09");
    expect(report.objectCode).toBe("21-100-01");
    expect(report.rows.map((row) => [row.terCategory, row.gross, row.rate, row.tax, row.flags])).toEqual([
      ["A", 3_000_000, 0.01, 30_000, []],
      ["B", 4_000_000, 0.02, 80_000, []],
    ]);
    expect(report.totals).toEqual({
      employeeCount: 2,
      gross: 7_000_000,
      tax: 110_000,
      excludedCount: 0,
      ptkpMissingCount: 0,
      annualCalculationCount: 0,
      nonPermanentCount: 0,
      skippedBlockedCount: 0,
    });
  });

  it("taxes one person with two employments in the period on their combined gross", () => {
    const report = buildPph21Report({
      period: SEPTEMBER,
      policy: policy(),
      rows: [
        // Each alone stays in the zero bracket of category A (up to 1.000.000);
        // together they cross it, which is the point of adding them up first.
        source({
          employmentId: "first",
          employeeId: "same-person",
          serviceEndDate: "2026-09-15",
          hasContinuingEmployment: true,
          earnings: [{ code: "BASIC", amount: 600_000 }],
        }),
        source({
          employmentId: "second",
          employeeId: "same-person",
          hasContinuingEmployment: true,
          earnings: [{ code: "BASIC", amount: 700_000 }],
        }),
      ],
    });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      employeeId: "same-person",
      employmentIds: ["first", "second"],
      gross: 1_300_000,
      rate: 0.01,
      tax: 13_000,
      // The first employment ended, but the person still works here.
      flags: [],
    });
    expect(report.totals).toMatchObject({ employeeCount: 1, gross: 1_300_000, tax: 13_000, annualCalculationCount: 0 });
    expect(pph21RowNote(report.rows[0]!)).toContain("Bruto gabungan 2 employment");
  });

  it("leaves a blocked employment out of the combined gross but keeps the paid one", () => {
    const report = buildPph21Report({
      period: SEPTEMBER,
      policy: policy(),
      rows: [
        source({ employmentId: "first", employeeId: "p", blockerCount: 1, earnings: [{ code: "BASIC", amount: 9_000_000 }] }),
        source({ employmentId: "second", employeeId: "p", earnings: [{ code: "BASIC", amount: 2_000_000 }] }),
      ],
    });
    expect(report.rows[0]).toMatchObject({ employmentIds: ["second"], gross: 2_000_000 });
    expect(report.totals.skippedBlockedCount).toBe(1);
  });

  it("refuses to pick between two different PTKP statuses of one person", () => {
    const report = buildPph21Report({
      period: SEPTEMBER,
      policy: policy(),
      rows: [
        source({ employmentId: "first", employeeId: "p", ptkpStatus: "TK/0" }),
        source({ employmentId: "second", employeeId: "p", ptkpStatus: "K/1" }),
      ],
    });
    expect(report.rows[0]).toMatchObject({ flags: ["PTKP_CONFLICT"], tax: null, ptkpStatus: "TK/0 / K/1" });
    expect(report.totals.ptkpMissingCount).toBe(1);
  });

  it("flags honorer and lepas terms without changing the rule applied", () => {
    const report = buildPph21Report({
      period: SEPTEMBER,
      policy: policy(),
      rows: [
        source({ employeeNumber: "1", termCategory: "KONTRAK_HONORER" }),
        source({ employeeNumber: "2", termCategory: "LEPAS" }),
        source({ employeeNumber: "3", termCategory: "KONTRAK" }),
        source({ employeeNumber: "4", termCategory: null }),
      ],
    });
    expect(report.rows.map((row) => row.flags)).toEqual([["NON_PERMANENT_TERMS"], ["NON_PERMANENT_TERMS"], [], []]);
    // Still taxed with monthly TER under 21-100-01 until the owner decides otherwise.
    expect(report.rows[0]).toMatchObject({ rate: 0.01, tax: 30_000 });
    expect(report.totals.nonPermanentCount).toBe(2);
    expect(pph21RowNote(report.rows[0]!)).toContain("21-100-01");
  });

  it("puts excluded people after everyone reported", () => {
    const report = buildPph21Report({
      period: SEPTEMBER,
      policy: policy(),
      rows: [
        source({ employeeNumber: "1", excluded: true, exclusionReason: "Uji" }),
        source({ employeeNumber: "2" }),
        source({ employeeNumber: "3" }),
      ],
    });
    expect(report.rows.map((row) => row.employeeNumber)).toEqual(["2", "3", "1"]);
  });

  it("excludes the person when any of their profiles says so", () => {
    const report = buildPph21Report({
      period: SEPTEMBER,
      policy: policy(),
      rows: [
        source({ employmentId: "first", employeeId: "p" }),
        source({ employmentId: "second", employeeId: "p", excluded: true, exclusionReason: "Uji" }),
      ],
    });
    expect(report.rows[0]).toMatchObject({ flags: ["EXCLUDED"], exclusionReason: "Uji", gross: 6_000_000 });
    expect(report.totals.employeeCount).toBe(0);
  });

  it("flags a missing or unmapped PTKP status and leaves its tax empty", () => {
    const report = buildPph21Report({
      period: SEPTEMBER,
      policy: policy(),
      rows: [source({ ptkpStatus: null }), source({ employeeNumber: "2", ptkpStatus: "K/9" })],
    });
    expect(report.rows.every((row) => row.tax === null && row.rate === null)).toBe(true);
    expect(report.rows.every((row) => row.flags.includes("PTKP_MISSING"))).toBe(true);
    // Still reported: the gap is in the data, not a reason to leave them out.
    expect(report.totals).toMatchObject({ employeeCount: 2, gross: 6_000_000, tax: 0, ptkpMissingCount: 2 });
  });

  it("keeps an excluded person on the list with the reason, out of the totals", () => {
    const report = buildPph21Report({
      period: SEPTEMBER,
      policy: policy(),
      rows: [
        source(),
        source({ employeeNumber: "2", excluded: true, exclusionReason: "Dilaporkan pemberi kerja lain" }),
      ],
    });
    const excluded = report.rows[1]!;
    expect(excluded.flags).toEqual(["EXCLUDED"]);
    expect(excluded.tax).toBeNull();
    expect(excluded.terCategory).toBeNull();
    expect(excluded.exclusionReason).toBe("Dilaporkan pemberi kerja lain");
    expect(report.totals).toMatchObject({ employeeCount: 1, gross: 3_000_000, tax: 30_000, excludedCount: 1 });
  });

  it("drops a result that still carries a blocker, since nobody paid it", () => {
    const report = buildPph21Report({
      period: SEPTEMBER,
      policy: policy(),
      rows: [source(), source({ employeeNumber: "2", blockerCount: 1 })],
    });
    expect(report.rows).toHaveLength(1);
    expect(report.totals.skippedBlockedCount).toBe(1);
  });

  it("still shows the TER figure of a final masa pajak, labelled as not final", () => {
    const report = buildPph21Report({
      period: SEPTEMBER,
      policy: policy(),
      rows: [source({ serviceEndDate: "2026-09-15", payFactor: 0.5, earnings: [{ code: "BASIC", amount: 3_000_000 }] })],
    });
    expect(report.rows[0]).toMatchObject({ gross: 1_500_000, rate: 0.01, tax: 15_000, flags: ["ANNUAL_CALCULATION_REQUIRED"] });
    expect(report.totals.annualCalculationCount).toBe(1);
  });

  it("answers an empty period with an empty report", () => {
    const report = buildPph21Report({ period: SEPTEMBER, policy: policy(), rows: [] });
    expect(report.rows).toEqual([]);
    expect(report.totals).toMatchObject({ employeeCount: 0, gross: 0, tax: 0 });
  });
});

describe("PAY-003 PPh21 CSV", () => {
  const report = buildPph21Report({
    period: SEPTEMBER,
    policy: policy(),
    rows: [
      source({ employeeNumber: "0016001", fullName: "Siti Ḥalīmah" }),
      source({ employeeNumber: "2016002", ptkpStatus: null }),
      source({ employeeNumber: "2016003", fullName: "=HYPERLINK(\"x\")", excluded: true, exclusionReason: "Uji" }),
    ],
  });
  const csv = pph21ReportToCsv(report);

  it("starts with a byte order mark and ends every line with CRLF", () => {
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv.split("\r\n")).toHaveLength(5);
  });

  it("names the columns the tax sheet needs, and no NIK or NPWP", () => {
    const header = csv.slice(1).split("\r\n")[0]!;
    expect(header).toBe(
      '"NIP","Nama","Status PTKP","Kategori TER","Penghasilan bruto","Tarif","PPh21","Kode objek","Dilaporkan","Catatan"',
    );
    expect(csv).not.toMatch(/NIK|NPWP/);
  });

  it("keeps a leading zero and a diacritic intact", () => {
    expect(csv).toContain(`"'0016001","Siti Ḥalīmah","TK/0","A","3000000","1%","30000","21-100-01","Y",""`);
  });

  it("explains an empty tax in the note column", () => {
    expect(csv).toContain('"2016002","Pegawai Uji","","","3000000","","","21-100-01","Y","Status PTKP kosong');
  });

  it("neutralises a formula typed into a name", () => {
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).not.toContain(`"=HYPERLINK`);
    expect(csv).toContain(`"21-100-01","N","Dikecualikan dari pelaporan: Uji"`);
  });

  it("lists the excluded person last", () => {
    expect(csv.trimEnd().split("\r\n").at(-1)).toContain('"N"');
  });

  it("writes a rate the way an Indonesian spreadsheet reads it", () => {
    expect(formatTerRate(0.0025)).toBe("0,25%");
    expect(formatTerRate(0.1)).toBe("10%");
    expect(formatTerRate(0)).toBe("0%");
  });

  it("says why a final masa pajak is not final", () => {
    const note = pph21RowNote({
      employeeId: "x",
      employmentIds: ["x"],
      employeeNumber: "1",
      fullName: "x",
      ptkpStatus: "TK/0",
      terCategory: "A",
      gross: 1,
      rate: 0,
      tax: 0,
      flags: ["ANNUAL_CALCULATION_REQUIRED"],
      exclusionReason: null,
    });
    expect(note).toContain("Pasal 17");
  });
});

describe("PAY-003 PPh21 exclusion on an initial load", () => {
  const inForce = [
    {
      employmentId: "e1",
      effectiveFrom: "2026-01-01",
      pph21ReportExcluded: true,
      pph21ReportExclusionReason: "Dilaporkan pemberi kerja lain",
    },
  ];

  it("carries the exclusion in force when the file says nothing about it", () => {
    expect(pph21ExclusionFor({ effectiveFrom: "2026-10-01" }, inForce, "e1")).toEqual({
      pph21ReportExcluded: true,
      pph21ReportExclusionReason: "Dilaporkan pemberi kerja lain",
    });
  });

  it("follows the file when it says, and drops the reason when reported again", () => {
    expect(pph21ExclusionFor({ effectiveFrom: "2026-10-01", pph21ReportExcluded: false }, inForce, "e1")).toEqual({
      pph21ReportExcluded: false,
      pph21ReportExclusionReason: null,
    });
  });

  it("defaults to reported with no profile in force, or only a later one", () => {
    expect(pph21ExclusionFor({ effectiveFrom: "2025-12-01" }, inForce, "e1").pph21ReportExcluded).toBe(false);
    expect(pph21ExclusionFor({ effectiveFrom: "2026-10-01" }, inForce, "other").pph21ReportExcluded).toBe(false);
  });
});
