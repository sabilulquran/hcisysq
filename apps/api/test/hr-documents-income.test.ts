// DOC-001 Package 2 income letter: pure rules. Synthetic amounts, hand-computed expectations.

import { describe, expect, it } from "vitest";

import {
  averageSen,
  buildIncomeFacts,
  findFigure,
  GROSS_LABELS,
  incomeWindow,
  NET_LABELS,
  parseRupiahToSen,
  senToAmount,
} from "../src/modules/documents/income.js";
import { DocumentError } from "../src/modules/documents/service.js";

describe("DOC-001 D-22 income window", () => {
  it("takes the three full months before the month of issue", () => {
    expect(incomeWindow("2026-11-17")).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect(incomeWindow("2026-11-01")).toEqual(["2026-08", "2026-09", "2026-10"]);
  });

  it("crosses the turn of the year", () => {
    expect(incomeWindow("2027-02-03")).toEqual(["2026-11", "2026-12", "2027-01"]);
    expect(incomeWindow("2027-01-31")).toEqual(["2026-10", "2026-11", "2026-12"]);
  });
});

describe("DOC-001 D-23 slip amounts", () => {
  it("reads the formats the slip paths write, in sen", () => {
    expect(parseRupiahToSen("Rp5.250.000")).toBe(525_000_000n); // PAY-003 formatRupiah
    expect(parseRupiahToSen("Rp 5.250.000")).toBe(525_000_000n);
    expect(parseRupiahToSen("5250000")).toBe(525_000_000n);
    expect(parseRupiahToSen("5.250.000")).toBe(525_000_000n);
    expect(parseRupiahToSen("5,250,000")).toBe(525_000_000n);
    expect(parseRupiahToSen("5.250.000,50")).toBe(525_000_050n);
    expect(parseRupiahToSen("5250000.5")).toBe(525_000_050n);
    expect(parseRupiahToSen("IDR 1.000")).toBe(100_000n); // three digits after one dot are thousands
    expect(parseRupiahToSen("Rp1.000,-")).toBe(100_000n);
  });

  it("refuses what is not an amount rather than guessing", () => {
    for (const value of ["", "-", "lima juta", "5.25.000", "5,250.000,00", "1.2345", "Rp"]) {
      expect(parseRupiahToSen(value), value).toBeNull();
    }
  });

  it("stores whole rupiah, or two decimals when the slip had sen", () => {
    expect(senToAmount(525_000_000n)).toBe("5250000");
    expect(senToAmount(525_000_050n)).toBe("5250000.50");
  });

  it("averages to whole rupiah, half up", () => {
    // (5.000.000 + 5.250.000 + 5.100.000) / 3 = 5.116.666,67 -> 5.116.667
    expect(averageSen([500_000_000n, 525_000_000n, 510_000_000n])).toBe(511_666_700n);
    // (4.500.000 + 4.700.000 + 4.600.001) / 3 = 4.600.000,33 -> 4.600.000
    expect(averageSen([450_000_000n, 470_000_000n, 460_000_100n])).toBe(460_000_000n);
    // (1 + 2) / 2 = 1,5 -> 2
    expect(averageSen([100n, 200n])).toBe(200n);
  });

  it("matches the gross and net lines of every slip path, never the paid-after-factor lines", () => {
    const tetap = [
      { label: "Gaji Pokok", value: "4000000", section: "income" },
      { label: "TOTAL BRUTO GAJI", value: "5000000", section: "summary" },
      { label: "Gaji Neto 80%", value: "3600000", section: "summary" },
      { label: "Gaji  Neto", value: "4500000", section: "summary" },
    ];
    expect(findFigure(tetap, GROSS_LABELS)).toBe(500_000_000n);
    expect(findFigure(tetap, NET_LABELS)).toBe(450_000_000n);
    const pay003 = [
      { label: "Total pendapatan", value: "Rp5.100.000" },
      { label: "Gaji bersih", value: "Rp4.600.001" },
      { label: "Nominal dibayar", value: "Rp2.300.000" },
    ];
    expect(findFigure(pay003, GROSS_LABELS)).toBe(510_000_000n);
    expect(findFigure(pay003, NET_LABELS)).toBe(460_000_100n);
    expect(findFigure([{ label: "Nominal dibayar", value: "1" }], NET_LABELS)).toBeNull();
  });
});

describe("DOC-001 D-24 income facts", () => {
  const window = ["2026-08", "2026-09", "2026-10"];

  it("lists each month and the averages from three synthetic slips", () => {
    const facts = buildIncomeFacts(window, [
      { period: "2026-08", lines: [{ label: "Total Bruto Gaji", value: "5.000.000" }, { label: "Gaji Neto", value: "4.500.000" }] },
      { period: "2026-09", lines: [{ label: "Total Penghasilan", value: "5250000" }, { label: "Gaji Neto", value: "4700000" }] },
      { period: "2026-10", lines: [{ label: "Total pendapatan", value: "Rp5.100.000" }, { label: "Gaji bersih", value: "Rp4.600.001" }] },
    ]);
    expect(facts).toEqual({
      months: [
        { period: "2026-08", gross: "5000000", net: "4500000", employerBorne: "0", layout: "LEGACY", employerBorneInGross: null },
        { period: "2026-09", gross: "5250000", net: "4700000", employerBorne: "0", layout: "LEGACY", employerBorneInGross: null },
        { period: "2026-10", gross: "5100000", net: "4600001", employerBorne: "0", layout: "LEGACY", employerBorneInGross: null },
      ],
      monthCount: 3,
      averageGross: "5116667",
      averageNet: "4600000",
      averageEmployerBorne: "0",
      mixedLayout: false,
      windowFrom: "2026-08",
      windowTo: "2026-10",
      source: "PAYSLIP_PUBLISHED",
    });
  });

  it("averages over the months that have a slip", () => {
    const facts = buildIncomeFacts(window, [
      { period: "2026-09", lines: [{ label: "Total Bruto Gaji", value: "3000000" }, { label: "Gaji Neto", value: "2800000" }] },
      { period: "2026-10", lines: [{ label: "Total Bruto Gaji", value: "3000001" }, { label: "Gaji Neto", value: "2800001" }] },
    ]);
    // (3.000.000 + 3.000.001) / 2 = 3.000.000,5 -> 3.000.001
    expect(facts).toMatchObject({ monthCount: 2, averageGross: "3000001", averageNet: "2800001" });
  });

  it("refuses with 409 when no slip was published in the window, naming months not amounts", () => {
    try {
      buildIncomeFacts(window, []);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentError);
      expect(error).toMatchObject({ statusCode: 409, code: "DOCUMENT_INCOME_UNAVAILABLE" });
      expect((error as Error).message).toContain("2026-08 sampai 2026-10");
    }
  });

  it("refuses a slip whose figures cannot be read, without quoting any amount", () => {
    try {
      buildIncomeFacts(window, [
        { period: "2026-09", lines: [{ label: "Total Bruto Gaji", value: "7777777" }] },
      ]);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 409, code: "DOCUMENT_INCOME_UNREADABLE" });
      expect((error as Error).message).toContain("2026-09");
      expect((error as Error).message).not.toContain("7777777");
    }
  });
});

/**
 * D-27 (owner decision 2026-11-17): the letter follows the gross of the slip the employee holds,
 * and states the employer-borne BPJS Kesehatan contribution on a line of its own.
 */
describe("DOC-001 D-27 employer-borne contribution and mixed windows", () => {
  const window = ["2026-08", "2026-09", "2026-10"];
  const legacy = (period: string, gross: string, net: string) => ({
    period,
    lines: [
      { label: "Tunjangan BPJS Kesehatan", value: "Rp205.000", section: "income" },
      { label: "Iuran BPJS Kesehatan", value: "Rp205.000", section: "deduction" },
      { label: "Total pendapatan", value: gross, section: "summary" },
      { label: "Gaji bersih", value: net, section: "summary" },
    ],
  });
  const block = (period: string, gross: string, net: string, premium = "Rp205.000") => ({
    period,
    lines: [
      { label: "Total pendapatan", value: gross, section: "summary" },
      { label: "Gaji bersih", value: net, section: "summary" },
      { label: "Iuran BPJS Kesehatan", value: premium, section: "employer" },
      { label: "PPh21 ditanggung yayasan", value: "Rp43.050", section: "employer" },
    ],
  });

  it("reads nothing employer-borne from a window of slips on the earlier layout", () => {
    const facts = buildIncomeFacts(window, [
      legacy("2026-08", "Rp4.305.000", "Rp3.759.000"),
      legacy("2026-09", "Rp4.305.000", "Rp3.759.000"),
      legacy("2026-10", "Rp4.305.000", "Rp3.759.000"),
    ]);
    expect(facts.months.every((month) => month.layout === "LEGACY" && month.employerBorne === "0")).toBe(true);
    expect(facts).toMatchObject({ averageGross: "4305000", averageEmployerBorne: "0", mixedLayout: false });
  });

  it("states the contribution per month, and never the PPh21 of the same block", () => {
    const facts = buildIncomeFacts(window, [
      block("2026-08", "Rp4.100.000", "Rp3.759.000"),
      block("2026-09", "Rp4.100.000", "Rp3.759.000"),
      block("2026-10", "Rp4.100.000", "Rp3.759.000"),
    ]);
    expect(facts.months[0]).toEqual({
      period: "2026-08",
      gross: "4100000",
      net: "3759000",
      employerBorne: "205000",
      layout: "EMPLOYER_BLOCK",
      employerBorneInGross: null,
    });
    // 43.050 of PPh21 is in the same block and stays out of the figure.
    expect(facts).toMatchObject({ averageGross: "4100000", averageEmployerBorne: "205000", mixedLayout: false });
  });

  it("flags a window that mixes the two layouts instead of averaging two definitions in silence", () => {
    const facts = buildIncomeFacts(window, [
      legacy("2026-08", "Rp4.305.000", "Rp3.759.000"),
      block("2026-09", "Rp4.100.000", "Rp3.759.000"),
      block("2026-10", "Rp4.100.000", "Rp3.759.000"),
    ]);
    expect(facts.mixedLayout).toBe(true);
    expect(facts.months.map((month) => month.layout)).toEqual(["LEGACY", "EMPLOYER_BLOCK", "EMPLOYER_BLOCK"]);
    // Each month is still exactly what its own slip says; nothing is recomputed.
    expect(facts.months.map((month) => month.gross)).toEqual(["4305000", "4100000", "4100000"]);
    // (205.000 + 205.000) / 3 = 136.666,67 -> 136.667
    expect(facts.averageEmployerBorne).toBe("136667");
  });

  // B1 of the independent review: the block holds two kinds of line, and only the premium one
  // decides which basis the gross is on.
  it("reads a block that holds only PPh21 as the earlier basis, because nothing left the gross", () => {
    const pph21Only = {
      period: "2026-10",
      lines: [
        { label: "Total pendapatan", value: "Rp4.305.000", section: "summary" },
        { label: "Gaji bersih", value: "Rp3.759.000", section: "summary" },
        { label: "PPh21 ditanggung yayasan", value: "Rp43.050", section: "employer" },
      ],
    };
    const facts = buildIncomeFacts(window, [legacy("2026-09", "Rp4.305.000", "Rp3.759.000"), pph21Only]);
    expect(facts.months.map((month) => month.layout)).toEqual(["LEGACY", "LEGACY"]);
    expect(facts).toMatchObject({ mixedLayout: false, averageEmployerBorne: "0" });
  });

  it("keeps a month whose BPJS pair was not recognised on the earlier basis, and says the window is mixed", () => {
    // DRAFT S5: the pair was unequal, so the allowance stayed inside bruto even with the layout on;
    // PPh21 still gives that slip a block. Reading it as the new basis would hide a 205.000 step.
    const unrecognised = {
      period: "2026-10",
      lines: [
        { label: "Tunjangan BPJS Kesehatan", value: "Rp205.000", section: "income" },
        { label: "Iuran BPJS Kesehatan", value: "Rp246.000", section: "deduction" },
        { label: "Total pendapatan", value: "Rp4.305.000", section: "summary" },
        { label: "Gaji bersih", value: "Rp3.718.000", section: "summary" },
        { label: "PPh21 ditanggung yayasan", value: "Rp43.050", section: "employer" },
      ],
    };
    const facts = buildIncomeFacts(window, [block("2026-09", "Rp4.100.000", "Rp3.759.000"), unrecognised]);
    expect(facts.months.map((month) => month.layout)).toEqual(["EMPLOYER_BLOCK", "LEGACY"]);
    expect(facts.mixedLayout).toBe(true);
    // Read from the slip's own allowance line, so the letter can name what sits inside that bruto.
    expect(facts.months[1]!.employerBorneInGross).toBe("205000");
  });

  it("reads the contribution inside a legacy month's gross from that slip's own allowance line", () => {
    const facts = buildIncomeFacts(window, [
      legacy("2026-09", "Rp4.305.000", "Rp3.759.000"),
      block("2026-10", "Rp4.100.000", "Rp3.759.000"),
    ]);
    expect(facts.months[0]!.employerBorneInGross).toBe("205000");
    expect(facts.months[1]!.employerBorneInGross).toBeNull();
  });

  it("sums every allowance line of a legacy month, not only the first", () => {
    // A retro or adjustment month can carry more than one BPJS_KES_ALLOW earning, and the slip
    // lists one line per result line; naming only the first would understate the bracket.
    const retro = {
      period: "2026-09",
      lines: [
        { label: "Tunjangan BPJS Kesehatan", value: "Rp205.000", section: "income" },
        { label: "Tunjangan BPJS Kesehatan", value: "Rp41.000", section: "income" },
        { label: "Total pendapatan", value: "Rp4.346.000", section: "summary" },
        { label: "Gaji bersih", value: "Rp3.759.000", section: "summary" },
      ],
    };
    const facts = buildIncomeFacts(window, [retro, block("2026-10", "Rp4.100.000", "Rp3.759.000")]);
    expect(facts.months[0]!.employerBorneInGross).toBe("246000");
  });

  it("names no amount when one of several allowance lines cannot be read", () => {
    const broken = {
      period: "2026-09",
      lines: [
        { label: "Tunjangan BPJS Kesehatan", value: "Rp205.000", section: "income" },
        { label: "Tunjangan BPJS Kesehatan", value: "menyusul", section: "income" },
        { label: "Total pendapatan", value: "Rp4.346.000", section: "summary" },
        { label: "Gaji bersih", value: "Rp3.759.000", section: "summary" },
      ],
    };
    const facts = buildIncomeFacts(window, [broken, block("2026-10", "Rp4.100.000", "Rp3.759.000")]);
    // Not a refusal: this figure only enriches a sentence, it is not the letter's headline.
    expect(facts.months[0]!.employerBorneInGross).toBeNull();
    expect(facts.months[0]!.gross).toBe("4346000");
  });

  it("leaves the amount unnamed when the legacy slip does not state it the same way", () => {
    // A PAY-001/PAY-002 import names it "Tunjangan BPJS" and lumps the extra family member in.
    const imported = {
      period: "2026-09",
      lines: [
        { label: "Tunjangan BPJS", value: "246.000", section: "income" },
        { label: "Total Bruto Gaji", value: "5.000.000", section: "summary" },
        { label: "Gaji Neto", value: "4.500.000", section: "summary" },
      ],
    };
    const facts = buildIncomeFacts(window, [imported, block("2026-10", "Rp4.100.000", "Rp3.759.000")]);
    expect(facts.months[0]!.employerBorneInGross).toBeNull();
    expect(facts.mixedLayout).toBe(true);
  });

  it("refuses rather than states Rp0 when a block line carries a label it does not know", () => {
    // Item 3 of the review: both label sets come from payroll_components.display_name, so a rename
    // must refuse instead of quietly reporting that the yayasan paid nothing.
    const renamed = {
      period: "2026-09",
      lines: [
        { label: "Total pendapatan", value: "Rp4.100.000", section: "summary" },
        { label: "Gaji bersih", value: "Rp3.759.000", section: "summary" },
        { label: "Premi BPJS Kesehatan", value: "Rp205.000", section: "employer" },
      ],
    };
    try {
      buildIncomeFacts(window, [renamed]);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 409, code: "DOCUMENT_INCOME_UNREADABLE" });
      expect((error as Error).message).toContain("2026-09");
      expect((error as Error).message).not.toContain("205.000");
    }
  });

  it("accepts the refund label the block uses on a final masa pajak", () => {
    const refund = {
      period: "2026-09",
      lines: [
        { label: "Total pendapatan", value: "Rp4.100.000", section: "summary" },
        { label: "Gaji bersih", value: "Rp3.759.000", section: "summary" },
        { label: "Iuran BPJS Kesehatan", value: "Rp205.000", section: "employer" },
        { label: "Pengembalian kelebihan PPh21 ditanggung yayasan", value: "Rp600.000", section: "employer" },
      ],
    };
    const facts = buildIncomeFacts(window, [refund]);
    expect(facts.months[0]).toMatchObject({ employerBorne: "205000", layout: "EMPLOYER_BLOCK" });
  });

  it("is not a mixed window when the block states nothing employer-borne", () => {
    const honorer = {
      period: "2026-10",
      lines: [
        { label: "Total pendapatan", value: "Rp1.840.000", section: "summary" },
        { label: "Gaji bersih", value: "Rp1.840.000", section: "summary" },
      ],
    };
    const facts = buildIncomeFacts(window, [legacy("2026-09", "Rp4.305.000", "Rp3.759.000"), honorer]);
    expect(facts).toMatchObject({ mixedLayout: false, averageEmployerBorne: "0" });
  });

  it("refuses the letter when a block line is there but its amount cannot be read", () => {
    try {
      buildIncomeFacts(window, [block("2026-09", "Rp4.100.000", "Rp3.759.000", "dua ratus ribu")]);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 409, code: "DOCUMENT_INCOME_UNREADABLE" });
      expect((error as Error).message).toContain("2026-09");
      expect((error as Error).message).not.toContain("4.100.000");
    }
  });
});
