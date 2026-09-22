import { describe, expect, it } from "vitest";

import { employeeShellUser } from "@/lib/employeeIdentity";
import { groupPayslipLines, payslipSourceLabel } from "@/pages/EmployeePayslipsPage";

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

  it("keeps generic lines in the other section and labels source formats clearly", () => {
    const grouped = groupPayslipLines([{ label: "Imported A", value: "opaque" }]);
    expect(grouped.other).toEqual([{ label: "Imported A", value: "opaque" }]);
    expect(payslipSourceLabel("tetap")).toBe("Pegawai Tetap");
    expect(payslipSourceLabel("honorer")).toBe("Honorer");
    expect(payslipSourceLabel("generic")).toBe("Imported");
  });
});
