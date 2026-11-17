// PAY-003 §7.4: the printable 1721-A1 lays the server's figures out in form order and adds none.
// Synthetic data only.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Pph21A1Paper } from "@/components/payroll/Pph21A1Paper";
import { canAccessAdminPath } from "@/lib/authorization";
import type { Pph21A1Document } from "@/lib/payrollPph21Annual";
import type { AuthSession } from "@/types/hcis";

function a1(finalMasaTax: string): Pph21A1Document {
  return {
    year: 2026,
    objectCode: "21-100-01",
    reference: "HCIS-A1-2026-0016001-1",
    issuedOn: "2027-01-15",
    withholder: { name: "Yayasan Sabilul Qur'an", taxNumber: null },
    employee: { employeeNumber: "0016001", fullName: "Pegawai Uji", position: "Guru", nik: "3209010101900001", npwp: null },
    policy: { versionId: "v1", effectiveFrom: "2026-01-01", source: "Contoh uji" },
    segment: {
      employeeId: "p1",
      employeeNumber: "0016001",
      fullName: "Pegawai Uji",
      index: 1,
      startPeriod: "2026-01",
      endPeriod: "2026-12",
      monthCount: 12,
      closed: true,
      ptkpStatus: "TK/0",
      lines: { salary: "120000000", taxAllowance: "0", otherAllowances: "0", honorarium: "0", insurancePremium: "0", inKind: "0", bonusThr: "0" },
      gross: "120000000",
      positionCost: "6000000",
      pensionContribution: "0",
      deductions: "6000000",
      net: "114000000",
      ptkp: "54000000",
      pkp: "60000000",
      annualTax: "3000000",
      terWithheld: "2200000",
      finalMasaTax,
      flags: [],
      note: "",
    },
    signer: { title: "Kepala Human Capital Management", name: "Penandatangan Uji" },
  };
}

describe("Pph21A1Paper", () => {
  it("prints the identity, every form line and the kurang potong of the final masa", () => {
    const html = renderToStaticMarkup(<Pph21A1Paper a1={a1("800000")} />);
    expect(html).toContain("3209010101900001");
    expect(html).toContain("120.000.000");
    expect(html).toContain("60.000.000");
    expect(html).toContain("3.000.000");
    expect(html).toContain("kurang dipotong");
    expect(html).toContain("800.000");
  });

  it("shows a lebih potong in brackets", () => {
    const html = renderToStaticMarkup(<Pph21A1Paper a1={a1("-600000")} />);
    expect(html).toContain("lebih dipotong");
    expect(html).toContain("(600.000)");
  });
});

describe("annual PPh21 screen access", () => {
  const session = (permissions: string[]): AuthSession => ({
    principal: { id: "synthetic", email: "synthetic@example.invalid", principalType: "EMPLOYEE" },
    expiresAt: "2099-01-01T00:00:00Z",
    authorization: { organizationPermissions: permissions },
  }) as AuthSession;

  it("opens to the per-person readers only", () => {
    for (const permission of ["payroll.results.read.organization", "payroll.calculate", "payroll.inputs.manage"]) {
      expect(canAccessAdminPath(session([permission]), "/admin/payroll/pph21-annual"), permission).toBe(true);
    }
    for (const permission of ["payroll.periods.manage", "payroll.reports.read.organization", "payroll.profiles.manage", "payroll.approve"]) {
      expect(canAccessAdminPath(session([permission]), "/admin/payroll/pph21-annual"), permission).toBe(false);
    }
  });
});
