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
        { period: "2026-08", gross: "5000000", net: "4500000" },
        { period: "2026-09", gross: "5250000", net: "4700000" },
        { period: "2026-10", gross: "5100000", net: "4600001" },
      ],
      monthCount: 3,
      averageGross: "5116667",
      averageNet: "4600000",
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
