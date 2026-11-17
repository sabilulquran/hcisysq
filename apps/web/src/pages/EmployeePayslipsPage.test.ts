import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { employeeShellUser } from "@/lib/employeeIdentity";
import {
  filterPayslipOptions,
  formatPayslipPeriod,
  payslipAutomaticNote,
  payslipInitialSelectorValue,
  groupPayslipLines,
  payslipConfidentialityNotes,
  payslipDetailLines,
  payslipEmployerBlockNote,
  payslipEmployerBlockTitle,
  payslipEmploymentStatusLabel,
  payslipOptionLabel,
  PayslipPaper,
} from "@/pages/EmployeePayslipsPage";
import type { PayslipDetail, PayslipLine } from "@/lib/payslips";

describe("payslip employee identity", () => {
  it("uses the linked employee identity instead of a raw account fallback", () => {
    expect(
      employeeShellUser({
        id: "00000000-0000-4000-8000-000000000101",
        employeeNumber: "SYN-001",
        fullName: "Pegawai Sintetis",
        unitName: "Unit Sintetis",
        positionName: "Staf",
        leaveEntitlementGroup: "non_education",
        startedOn: "2020-01-01",
      }),
    ).toEqual({
      name: "Pegawai Sintetis",
      initials: "PS",
      position: "Staf",
      unit: "Unit Sintetis",
    });
  });
});


describe("payslip operational presentation", () => {
  it("groups imported fixed-payroll lines without deriving values", () => {
    const grouped = groupPayslipLines([
      { label: "Gaji Pokok", value: "Rp 5.000.000", section: "income" },
      { label: "Potongan Kasbon", value: "Rp 250.000", section: "deduction" },
      { label: "Gaji Neto", value: "Rp 4.750.000", section: "summary" },
    ]);
    expect(grouped.income).toHaveLength(1);
    expect(grouped.deduction).toHaveLength(1);
    expect(grouped.summary[0]?.value).toBe("Rp 4.750.000");
  });

  it("keeps generic lines in the other section without inferring employment status", () => {
    const grouped = groupPayslipLines([{ label: "Imported A", value: "opaque" }]);
    expect(grouped.other).toEqual([{ label: "Imported A", value: "opaque" }]);
    expect(payslipEmploymentStatusLabel(null)).toBeNull();
    expect(payslipEmploymentStatusLabel(" Kontrak ")).toBe("Kontrak");
  });
});


// PAY-003 §7.6 (owner decision 2026-11-17): what the yayasan pays on the employee's
// behalf is shown in a block of its own, never among income or deductions.
describe("PAY-003 payslip block Ditanggung yayasan", () => {
  const blockLines: PayslipLine[] = [
    { label: "NIP", value: "2016001", section: "identity" },
    { label: "Gaji pokok", value: "Rp4.000.000", section: "income" },
    { label: "Iuran anggota keluarga tambahan", value: "Rp40.000", section: "deduction" },
    { label: "Total pendapatan", value: "Rp4.000.000", section: "summary" },
    { label: "Total potongan", value: "Rp40.000", section: "summary" },
    { label: "Gaji bersih", value: "Rp3.960.000", section: "summary" },
    { label: "Nominal dibayar", value: "Rp3.960.000", section: "summary" },
    { label: "Iuran BPJS Kesehatan", value: "Rp200.000", section: "employer" },
    { label: "PPh21 ditanggung yayasan", value: "Rp50.000", section: "employer" },
  ];
  const slip = (lines: PayslipLine[]): PayslipDetail => ({
    id: "00000000-0000-4000-8000-000000000501",
    period: "2026-12",
    kind: "REGULAR",
    sourceFormat: "generic",
    employmentStatus: null,
    publishedAt: "2026-12-24T00:00:00.000Z",
    lines,
    signer: { title: "Kepala Human Capital Management", name: "Penanda Tangan Uji" },
  });
  const render = (lines: PayslipLine[]) =>
    renderToStaticMarkup(createElement(PayslipPaper, { payslip: slip(lines), employee: null }));

  it("groups the employer lines apart and keeps them out of the slip detail", () => {
    const grouped = groupPayslipLines(blockLines);
    expect(grouped.employer.map((line) => line.label)).toEqual(["Iuran BPJS Kesehatan", "PPh21 ditanggung yayasan"]);
    expect(grouped.income.map((line) => line.label)).toEqual(["Gaji pokok"]);
    expect(grouped.deduction.map((line) => line.label)).toEqual(["Iuran anggota keluarga tambahan"]);
    expect(payslipDetailLines(blockLines).some((line) => line.section === "employer")).toBe(false);
    expect(payslipDetailLines(blockLines)).toHaveLength(7);
  });

  it("renders the block after the detail, with a note that it is not part of net pay", () => {
    const html = render(blockLines);
    expect(html).toContain(payslipEmployerBlockTitle);
    expect(html).toContain(payslipEmployerBlockNote);
    const detailAt = html.indexOf("Rincian Slip");
    const blockAt = html.indexOf(payslipEmployerBlockTitle);
    expect(detailAt).toBeGreaterThan(-1);
    expect(blockAt).toBeGreaterThan(detailAt);
    // Each employer line appears once, inside the block and not among the detail pairs.
    for (const label of ["Iuran BPJS Kesehatan", "PPh21 ditanggung yayasan"]) {
      expect(html.split(label)).toHaveLength(2);
      expect(html.indexOf(label)).toBeGreaterThan(blockAt);
    }
    expect(html.indexOf("Gaji bersih")).toBeLessThan(blockAt);
    expect(html).toContain("Rp3.960.000");
  });

  it("renders a slip without employer lines exactly as before: no block at all", () => {
    const earlier = blockLines.filter((line) => line.section !== "employer");
    const html = render(earlier);
    expect(html).not.toContain(payslipEmployerBlockTitle);
    expect(html).not.toContain(payslipEmployerBlockNote);
    expect(payslipDetailLines(earlier)).toEqual(earlier);
  });

  it("shows a line of a section this build does not know rather than dropping it", () => {
    const grouped = groupPayslipLines([{ label: "Baris baru", value: "1", section: "future" as never }]);
    expect(grouped.other).toEqual([{ label: "Baris baru", value: "1", section: "future" }]);
  });
});

describe("PAYSLIP-004 employee navigation and document copy", () => {
  it("builds a searchable period label without a vertical history card dependency", () => {
    const item = {
      id: "00000000-0000-4000-8000-000000000201",
      period: "2026-07",
      sourceFormat: "tetap" as const,
      employmentStatus: "Kontrak",
      publishedAt: "2026-09-22T00:00:00.000Z",
    };
    expect(formatPayslipPeriod(item.period)).toBe("Juli 2026");
    expect(payslipOptionLabel(item)).toBe("Juli 2026 · Kontrak");
  });

  it("retains the three legacy confidentiality notes verbatim", () => {
    expect(payslipConfidentialityNotes).toEqual([
      "Dokumen ini bersifat RAHASIA dan PRIBADI.",
      "Dilarang menyebarluaskan atau menunjukkan isi dokumen ini kepada pihak yang tidak berwenang.",
      "Segala risiko finansial atau hukum akibat penyalahgunaan dokumen menjadi tanggung jawab pribadi pegawai.",
    ]);
  });
});


describe("PAYSLIP-005 visible period picker", () => {
  const options = [
    {
      id: "00000000-0000-4000-8000-000000000301",
      period: "2026-08",
      sourceFormat: "tetap" as const,
      employmentStatus: "Probation",
      publishedAt: "2026-09-22T00:00:00.000Z",
    },
    {
      id: "00000000-0000-4000-8000-000000000302",
      period: "2026-07",
      sourceFormat: "honorer" as const,
      employmentStatus: "Honorer",
      publishedAt: "2026-09-22T00:00:00.000Z",
    },
  ];

  it("shows all options before the employee types a filter", () => {
    expect(filterPayslipOptions(options, "")).toHaveLength(2);
  });

  it("filters visible options by month, year, or master employment status", () => {
    expect(filterPayslipOptions(options, "Agustus")).toEqual([options[0]]);
    expect(filterPayslipOptions(options, "2026")).toHaveLength(2);
    expect(filterPayslipOptions(options, "Honorer")).toEqual([options[1]]);
  });
});


describe("PAYSLIP-006 render and print parity", () => {
  it("starts the period selector empty so the employee chooses from the dropdown", () => {
    expect(payslipInitialSelectorValue).toBe("");
  });

  it("uses the shortened automatic document footer copy", () => {
    expect(payslipAutomaticNote).toBe("Dibuat otomatis oleh HCIS Sabilul Qur'an.");
  });
});


describe("PAYSLIP-007 status and section semantics", () => {
  it("does not manufacture an employment label from payroll source format", () => {
    const item = {
      id: "00000000-0000-4000-8000-000000000401",
      period: "2026-09",
      sourceFormat: "tetap" as const,
      employmentStatus: null,
      publishedAt: "2026-09-22T00:00:00.000Z",
    };
    expect(payslipOptionLabel(item)).toBe("September 2026");
  });

  it("keeps payroll deductions out of the income section", () => {
    const grouped = groupPayslipLines([
      { label: "Gaji Pokok", value: "1", section: "income" },
      { label: "Potongan Kasbon", value: "2", section: "deduction" },
      { label: "Pendidikan Anak", value: "3", section: "deduction" },
      { label: "BPJS", value: "4", section: "deduction" },
      { label: "Kekurangan Jam", value: "5", section: "deduction" },
    ]);
    expect(grouped.income.map((line) => line.label)).toEqual(["Gaji Pokok"]);
    expect(grouped.deduction.map((line) => line.label)).toEqual([
      "Potongan Kasbon",
      "Pendidikan Anak",
      "BPJS",
      "Kekurangan Jam",
    ]);
  });
});
