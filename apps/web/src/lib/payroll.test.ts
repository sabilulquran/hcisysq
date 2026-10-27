import { describe, expect, it } from "vitest";

import {
  formatRupiah,
  payrollActionLabel,
  payrollActionNeedsReason,
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

  it("asks for a reason exactly where the specification does", () => {
    expect(payrollActionNeedsReason("return")).toBe(true);
    expect(payrollActionNeedsReason("request_reopen")).toBe(true);
    expect(payrollActionNeedsReason("reject_reopen")).toBe(true);
    for (const action of ["start_collecting", "calculate", "submit", "approve", "confirm_payment", "publish", "approve_reopen"] as const) {
      expect(payrollActionNeedsReason(action)).toBe(false);
    }
  });

  it("downloads the CSV the server builds, not one assembled in the browser", () => {
    expect(payrollTransfersCsvUrl("abc-123")).toBe("/api/payroll/periods/abc-123/transfers?format=csv");
  });

  it("escapes a period id rather than pasting it into the path", () => {
    expect(payrollTransfersCsvUrl("a/b c")).toBe("/api/payroll/periods/a%2Fb%20c/transfers?format=csv");
  });
});
