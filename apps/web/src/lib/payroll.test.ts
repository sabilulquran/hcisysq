import { describe, expect, it } from "vitest";

import {
  formatRupiah,
  payrollActionLabel,
  payrollOperationLabel,
  payrollStateLabel,
  payrollTransfersCsvUrl,
} from "@/lib/payroll";

describe("PAY-003 amounts on screen", () => {
  it("groups thousands the way every other YSQ document does", () => {
    expect(formatRupiah("3000000")).toBe("Rp3.000.000");
    expect(formatRupiah("4087766")).toBe("Rp4.087.766");
  });

  it("leaves a small amount ungrouped", () => {
    expect(formatRupiah("0")).toBe("Rp0");
    expect(formatRupiah("750")).toBe("Rp750");
  });

  it("keeps a negative amount negative, which a reopened period can produce", () => {
    expect(formatRupiah("-250000")).toBe("-Rp250.000");
  });

  it("returns the value untouched when it carries no digits", () => {
    expect(formatRupiah("")).toBe("");
    expect(formatRupiah("—")).toBe("—");
  });

  it("shows only the rupiah of a value that arrives with a fraction", () => {
    // Dropping the separator instead would read 3000000.00 as three hundred
    // million, which is the same amount times a hundred.
    expect(formatRupiah("3000000.00")).toBe("Rp3.000.000");
    expect(formatRupiah("1500,50")).toBe("Rp1.500");
  });
});

describe("PAY-003 period vocabulary", () => {
  it("names every lifecycle state in Indonesian", () => {
    expect(payrollStateLabel("COLLECTING")).toBe("Pengumpulan input");
    expect(payrollStateLabel("PAYMENT_CONFIRMED")).toBe("Pembayaran dikonfirmasi");
    expect(payrollStateLabel("REOPEN_REQUESTED")).toBe("Menunggu keputusan buka ulang");
  });

  it("names every action an operator can be offered", () => {
    expect(payrollActionLabel("calculate")).toBe("Hitung periode");
    expect(payrollActionLabel("approve_reopen")).toBe("Setujui buka ulang");
  });

  it("names the work that is not a lifecycle transition", () => {
    expect(payrollOperationLabel("resolve_attendance")).toBe("Ambil lembur & kehadiran");
    expect(payrollOperationLabel("draft_payslips")).toBe("Siapkan slip");
    expect(payrollOperationLabel("publish_payslips")).toBe("Terbitkan slip");
  });

  it("downloads the CSV the server builds, not one assembled in the browser", () => {
    expect(payrollTransfersCsvUrl("abc-123")).toBe("/api/payroll/periods/abc-123/transfers?format=csv");
  });

  it("escapes a period id rather than pasting it into the path", () => {
    expect(payrollTransfersCsvUrl("a/b c")).toBe("/api/payroll/periods/a%2Fb%20c/transfers?format=csv");
  });
});
