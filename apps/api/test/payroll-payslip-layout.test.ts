// PAY-003 section 7.6 (owner decision 2026-11-17): the payslip block "Ditanggung
// yayasan". Pure functions only: result lines in, what the slip shows out.
// Synthetic people and figures.

import { describe, expect, it } from "vitest";

import {
  employerBorneHealthContribution,
  employerBornePph21,
  presentPayslip,
} from "../src/modules/payroll/payslip-layout.js";
import {
  DEFAULT_PAYSLIP_LAYOUT,
  parsePayslipLayoutPolicy,
  validatePolicyPayload,
} from "../src/modules/payroll/policy.js";
import { buildPayslipLines } from "../src/modules/payroll/publication.js";
import { payslipTotalsOf } from "../src/modules/payroll/reports.js";
import { buildIncomeFacts } from "../src/modules/documents/income.js";

type Line = {
  resultId: string;
  componentCode: string;
  displayName: string;
  category: string;
  amount: string;
  displayOrder: number;
};

const line = (componentCode: string, displayName: string, category: string, amount: number, displayOrder: number): Line => ({
  resultId: "r1",
  componentCode,
  displayName,
  category,
  amount: String(amount),
  displayOrder,
});

// Gaji pokok 4.000.000 + tunjangan kinerja 100.000 = 4.100.000 hak pegawai.
// Iuran BPJS Kesehatan 5% = 205.000 ditanggung yayasan (pendapatan sekaligus potongan di hasil),
// anggota keluarga tambahan 1% = 41.000 dan kasbon 300.000 benar-benar dipotong.
const LINES: Line[] = [
  line("BASIC", "Gaji pokok", "EARNING", 4_000_000, 10),
  line("PERF", "Tunjangan kinerja", "EARNING", 100_000, 30),
  line("BPJS_KES_ALLOW", "Tunjangan BPJS Kesehatan", "EARNING", 205_000, 100),
  line("LOAN", "Potongan kasbon", "DEDUCTION", 300_000, 200),
  line("BPJS_KES", "Iuran BPJS Kesehatan", "DEDUCTION", 205_000, 210),
  line("BPJS_KES_EXTRA", "Iuran anggota keluarga tambahan", "DEDUCTION", 41_000, 220),
];
const PPH21 = line("PPH21_EMPLOYER", "PPh21 ditanggung yayasan", "EMPLOYER_COST", 43_050, 300);

const RESULT = {
  resultId: "r1",
  employeeId: "e1",
  employeeNumber: "2016001",
  fullName: "Pegawai Uji",
  gross: "4305000",
  deductions: "546000",
  net: "3759000",
  payable: "3759000",
  payFactor: "1.0000",
  payFactorReason: "none",
  blockerCount: 0,
};
const PERIOD = { periodMonth: "2026-12-01", payDate: "2026-12-24" };

const rupiah = (value: string) => Number(value.replace(/^(-?)Rp/, "$1").replace(/\./g, ""));
const valueOf = (lines: ReturnType<typeof buildPayslipLines>, label: string) =>
  lines.find((entry) => entry.label === label)?.value;

describe("PAYSLIP_LAYOUT policy", () => {
  it("is the earlier layout without a version, and a writable key with one", () => {
    expect(DEFAULT_PAYSLIP_LAYOUT.employerBlock).toBe(false);
    expect(validatePolicyPayload("PAYSLIP_LAYOUT", { source: "Keputusan owner uji", employerBlock: true })).toEqual({ ok: true });
    expect(parsePayslipLayoutPolicy({ source: "Keputusan owner uji" })).toMatchObject({ ok: true, layout: { employerBlock: false } });
    expect(parsePayslipLayoutPolicy({ source: "Keputusan owner uji", employerBlock: true })).toMatchObject({
      ok: true,
      layout: { employerBlock: true },
    });
  });

  it("refuses a payload without its source or with a switch that is not a boolean", () => {
    expect(validatePolicyPayload("PAYSLIP_LAYOUT", { employerBlock: true }).ok).toBe(false);
    expect(parsePayslipLayoutPolicy({ source: "uji sintetis", employerBlock: "ya" }).ok).toBe(false);
  });
});

describe("recognising what the yayasan bears", () => {
  it("takes the pair by component code when both sides are there and equal", () => {
    expect(employerBorneHealthContribution(LINES)).toBe(205_000n);
  });

  it("recognises nothing when one side is missing or the two differ, rather than guess", () => {
    const withoutDeduction = LINES.filter((entry) => entry.componentCode !== "BPJS_KES");
    const withoutAllowance = LINES.filter((entry) => entry.componentCode !== "BPJS_KES_ALLOW");
    const unequal = LINES.map((entry) => (entry.componentCode === "BPJS_KES" ? { ...entry, amount: "246000" } : entry));
    expect(employerBorneHealthContribution(withoutDeduction)).toBe(0n);
    expect(employerBorneHealthContribution(withoutAllowance)).toBe(0n);
    expect(employerBorneHealthContribution(unequal)).toBe(0n);
    expect(employerBorneHealthContribution([])).toBe(0n);
  });

  it("does not take a line of the same code in the wrong category for the pair", () => {
    const miscategorised = LINES.map((entry) =>
      entry.componentCode === "BPJS_KES" ? { ...entry, category: "EMPLOYER_COST" } : entry,
    );
    expect(employerBorneHealthContribution(miscategorised)).toBe(0n);
  });

  it("reads PPh21 the yayasan bears from its employer-cost line, negative included", () => {
    expect(employerBornePph21([...LINES, PPH21])).toBe(43_050n);
    expect(employerBornePph21([...LINES, { ...PPH21, amount: "-600000" }])).toBe(-600_000n);
    expect(employerBornePph21(LINES)).toBe(0n);
  });
});

describe("slip totals", () => {
  it("is the calculation's own totals on the earlier layout", () => {
    const shown = presentPayslip(RESULT, [...LINES, PPH21], { employerBlock: false });
    expect(shown).toMatchObject({
      gross: 4_305_000n,
      deductionTotal: 546_000n,
      employerHealthContribution: 0n,
      employerPph21: 0n,
    });
    expect(shown.income.map((entry) => entry.componentCode)).toEqual(["BASIC", "PERF", "BPJS_KES_ALLOW"]);
    expect(shown.deductions.map((entry) => entry.componentCode)).toEqual(["LOAN", "BPJS_KES", "BPJS_KES_EXTRA"]);
  });

  it("drops the pair from both totals with the block layout, so net cannot move", () => {
    const shown = presentPayslip(RESULT, [...LINES, PPH21], { employerBlock: true });
    expect(shown).toMatchObject({
      gross: 4_100_000n,
      deductionTotal: 341_000n,
      employerHealthContribution: 205_000n,
      employerPph21: 43_050n,
    });
    // Gross is what the employee is entitled to; the extra-family 1% stays a real deduction.
    expect(shown.income.map((entry) => entry.componentCode)).toEqual(["BASIC", "PERF"]);
    expect(shown.deductions.map((entry) => entry.componentCode)).toEqual(["LOAN", "BPJS_KES_EXTRA"]);
    expect(shown.gross - shown.deductionTotal).toBe(BigInt(RESULT.net));
  });

  it("keeps net equal on both layouts for any pair size", () => {
    for (const pair of [1, 144_000, 600_000]) {
      const lines = LINES.map((entry) =>
        entry.componentCode === "BPJS_KES_ALLOW" || entry.componentCode === "BPJS_KES"
          ? { ...entry, amount: String(pair) }
          : entry,
      );
      const result = { gross: String(4_100_000 + pair), deductions: String(341_000 + pair) };
      const earlier = presentPayslip(result, lines, { employerBlock: false });
      const block = presentPayslip(result, lines, { employerBlock: true });
      expect(block.gross - block.deductionTotal).toBe(earlier.gross - earlier.deductionTotal);
      expect(block.gross).toBe(4_100_000n);
    }
  });

  it("leaves an unrecognised pair where it was: totals and lists untouched", () => {
    const unequal = LINES.map((entry) => (entry.componentCode === "BPJS_KES" ? { ...entry, amount: "246000" } : entry));
    const shown = presentPayslip({ gross: "4305000", deductions: "587000" }, unequal, { employerBlock: true });
    expect(shown).toMatchObject({ gross: 4_305_000n, deductionTotal: 587_000n, employerHealthContribution: 0n });
    expect(shown.income).toHaveLength(3);
    expect(shown.deductions).toHaveLength(3);
  });
});

describe("slip lines", () => {
  it("writes exactly the earlier lines without the layout, PPH21_EMPLOYER line or not", () => {
    const earlier = buildPayslipLines(RESULT, [...LINES, PPH21], PERIOD);
    expect(earlier).toEqual([
      { label: "NIP", value: "2016001", section: "identity" },
      { label: "Nama", value: "Pegawai Uji", section: "identity" },
      { label: "Periode", value: "2026-12", section: "identity" },
      { label: "Tanggal gajian", value: "2026-12-24", section: "identity" },
      { label: "Gaji pokok", value: "Rp4.000.000", section: "income" },
      { label: "Tunjangan kinerja", value: "Rp100.000", section: "income" },
      { label: "Tunjangan BPJS Kesehatan", value: "Rp205.000", section: "income" },
      { label: "Potongan kasbon", value: "Rp300.000", section: "deduction" },
      { label: "Iuran BPJS Kesehatan", value: "Rp205.000", section: "deduction" },
      { label: "Iuran anggota keluarga tambahan", value: "Rp41.000", section: "deduction" },
      { label: "Total pendapatan", value: "Rp4.305.000", section: "summary" },
      { label: "Total potongan", value: "Rp546.000", section: "summary" },
      { label: "Gaji bersih", value: "Rp3.759.000", section: "summary" },
      { label: "Nominal dibayar", value: "Rp3.759.000", section: "summary" },
    ]);
    // An explicit false is the same slip: a redraft of an older period builds what was stored.
    expect(buildPayslipLines(RESULT, [...LINES, PPH21], PERIOD, { employerBlock: false })).toEqual(earlier);
  });

  it("moves BPJS Kesehatan and PPh21 into the block and leaves net pay alone", () => {
    const slip = buildPayslipLines(RESULT, [...LINES, PPH21], PERIOD, { employerBlock: true });
    expect(slip).toEqual([
      { label: "NIP", value: "2016001", section: "identity" },
      { label: "Nama", value: "Pegawai Uji", section: "identity" },
      { label: "Periode", value: "2026-12", section: "identity" },
      { label: "Tanggal gajian", value: "2026-12-24", section: "identity" },
      { label: "Gaji pokok", value: "Rp4.000.000", section: "income" },
      { label: "Tunjangan kinerja", value: "Rp100.000", section: "income" },
      { label: "Potongan kasbon", value: "Rp300.000", section: "deduction" },
      { label: "Iuran anggota keluarga tambahan", value: "Rp41.000", section: "deduction" },
      { label: "Total pendapatan", value: "Rp4.100.000", section: "summary" },
      { label: "Total potongan", value: "Rp341.000", section: "summary" },
      { label: "Gaji bersih", value: "Rp3.759.000", section: "summary" },
      { label: "Nominal dibayar", value: "Rp3.759.000", section: "summary" },
      { label: "Iuran BPJS Kesehatan", value: "Rp205.000", section: "employer" },
      { label: "PPh21 ditanggung yayasan", value: "Rp43.050", section: "employer" },
    ]);
  });

  it("shows the same net pay and payable on both layouts, to the rupiah", () => {
    const earlier = buildPayslipLines(RESULT, [...LINES, PPH21], PERIOD);
    const block = buildPayslipLines(RESULT, [...LINES, PPH21], PERIOD, { employerBlock: true });
    for (const label of ["Gaji bersih", "Nominal dibayar"]) {
      expect(valueOf(block, label)).toBe(valueOf(earlier, label));
    }
    // And on each slip the stated totals still explain the stated net.
    for (const slip of [earlier, block]) {
      expect(rupiah(valueOf(slip, "Total pendapatan")!) - rupiah(valueOf(slip, "Total potongan")!)).toBe(
        rupiah(valueOf(slip, "Gaji bersih")!),
      );
    }
    // The income lines of the block layout add up to its stated total: no hidden 5%.
    const income = block.filter((entry) => entry.section === "income").reduce((total, entry) => total + rupiah(entry.value), 0);
    expect(income).toBe(rupiah(valueOf(block, "Total pendapatan")!));
    const deductions = block
      .filter((entry) => entry.section === "deduction")
      .reduce((total, entry) => total + rupiah(entry.value), 0);
    expect(deductions).toBe(rupiah(valueOf(block, "Total potongan")!));
  });

  it("keeps the pay-factor lines after the totals and the block last", () => {
    const slip = buildPayslipLines(
      { ...RESULT, payFactor: "0.8000", payFactorReason: "early_service", payable: "3007200" },
      LINES,
      PERIOD,
      { employerBlock: true },
    );
    expect(slip.map((entry) => entry.label).slice(-5)).toEqual([
      "Total potongan",
      "Gaji bersih",
      "Masa kerja awal (80%)",
      "Nominal dibayar",
      "Iuran BPJS Kesehatan",
    ]);
    expect(valueOf(slip, "Nominal dibayar")).toBe("Rp3.007.200");
  });

  it("has no block for someone the yayasan pays nothing for: PBI, honorer", () => {
    const honorer: Line[] = [
      line("TRANSPORT", "Transport PKWT", "EARNING", 300_000, 130),
      line("TEACH_FEE", "Honor mengajar PKWT", "EARNING", 1_540_000, 140),
    ];
    const result = { ...RESULT, gross: "1840000", deductions: "0", net: "1840000", payable: "1840000" };
    const block = buildPayslipLines(result, honorer, PERIOD, { employerBlock: true });
    expect(block.some((entry) => entry.section === "employer")).toBe(false);
    expect(block).toEqual(buildPayslipLines(result, honorer, PERIOD));
  });

  it("does not guess when the pair is not there: the lines stay, PPh21 still goes to the block", () => {
    const unequal = [
      ...LINES.map((entry) => (entry.componentCode === "BPJS_KES" ? { ...entry, amount: "246000" } : entry)),
      PPH21,
    ];
    const result = { ...RESULT, deductions: "587000", net: "3718000", payable: "3718000" };
    const slip = buildPayslipLines(result, unequal, PERIOD, { employerBlock: true });
    expect(slip).toContainEqual({ label: "Tunjangan BPJS Kesehatan", value: "Rp205.000", section: "income" });
    expect(slip).toContainEqual({ label: "Iuran BPJS Kesehatan", value: "Rp246.000", section: "deduction" });
    expect(valueOf(slip, "Total pendapatan")).toBe("Rp4.305.000");
    expect(valueOf(slip, "Gaji bersih")).toBe("Rp3.718.000");
    expect(slip.filter((entry) => entry.section === "employer")).toEqual([
      { label: "PPh21 ditanggung yayasan", value: "Rp43.050", section: "employer" },
    ]);
  });

  it("shows a final masa pajak that returns over-withheld tax as it is, and no zero line", () => {
    const refund = buildPayslipLines(RESULT, [...LINES, { ...PPH21, amount: "-600000" }], PERIOD, { employerBlock: true });
    expect(refund).toContainEqual({ label: "PPh21 ditanggung yayasan", value: "-Rp600.000", section: "employer" });
    const zero = buildPayslipLines(RESULT, [...LINES, { ...PPH21, amount: "0" }], PERIOD, { employerBlock: true });
    expect(zero.filter((entry) => entry.section === "employer").map((entry) => entry.label)).toEqual(["Iuran BPJS Kesehatan"]);
  });

  it("carries the block on a revision and on a THR slip", () => {
    const revision = buildPayslipLines(RESULT, [...LINES, PPH21], PERIOD, { revision: true, employerBlock: true });
    expect(revision[0]).toEqual({ label: "Status", value: "Revisi", section: "identity" });
    expect(revision.filter((entry) => entry.section === "employer")).toHaveLength(2);

    const thrLines: Line[] = [
      { ...line("THR", "Tunjangan Hari Raya", "EARNING", 4_100_000, 175) },
      { ...PPH21, amount: "41000" },
    ];
    const thr = buildPayslipLines(
      { ...RESULT, gross: "4100000", deductions: "0", net: "4100000", payable: "4100000" },
      thrLines,
      { ...PERIOD, kind: "THR", holidayDate: "2026-12-25", holidayName: "Hari Raya Uji" },
      { employerBlock: true },
    );
    expect(valueOf(thr, "Total pendapatan")).toBe("Rp4.100.000");
    expect(valueOf(thr, "THR bersih")).toBe("Rp4.100.000");
    expect(thr.filter((entry) => entry.section === "employer")).toEqual([
      { label: "PPh21 ditanggung yayasan", value: "Rp41.000", section: "employer" },
    ]);
  });
});

describe("consumers of the slip totals", () => {
  it("gives the period report the totals as the slips state them", () => {
    const totals = { gross: "86100000", deductions: "9200000" };
    expect(payslipTotalsOf(totals, false, "4100000")).toEqual({ employerBlock: false, gross: "86100000", deductions: "9200000" });
    expect(payslipTotalsOf(totals, true, "4100000")).toEqual({ employerBlock: true, gross: "82000000", deductions: "5100000" });
    expect(payslipTotalsOf(totals, true, "0")).toEqual({ employerBlock: true, gross: "86100000", deductions: "9200000" });
  });

  it("lets the income certificate read the gross the employee was shown, with the same net", () => {
    const window = ["2026-12"];
    const earlier = buildIncomeFacts(window, [{ period: "2026-12", lines: buildPayslipLines(RESULT, [...LINES, PPH21], PERIOD) }]);
    const block = buildIncomeFacts(window, [
      { period: "2026-12", lines: buildPayslipLines(RESULT, [...LINES, PPH21], PERIOD, { employerBlock: true }) },
    ]);
    expect(earlier.months[0]).toEqual({ period: "2026-12", gross: "4305000", net: "3759000" });
    // DOC-001 D-23: "Total pendapatan" of the published slip, now without the BPJS allowance.
    expect(block.months[0]).toEqual({ period: "2026-12", gross: "4100000", net: "3759000" });
  });
});
