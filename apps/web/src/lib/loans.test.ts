import { describe, expect, it } from "vitest";

import { formatRupiah, loanStatusLabel, parseRupiahInput } from "@/lib/loans";

describe("LOAN-001 rupiah input", () => {
  it("reads whole rupiah written with or without thousands dots", () => {
    expect(parseRupiahInput("1.500.000")).toBe(1_500_000);
    expect(parseRupiahInput("Rp 1500000")).toBe(1_500_000);
    expect(parseRupiahInput(" rp.250.000 ")).toBe(250_000);
  });

  it("refuses fractions, commas, signs and empty input instead of rounding them", () => {
    // A decimal point must never be read as a thousands dot: "50000.00" is not five million.
    for (const text of [
      "1.500.000,50", "1500000.5e0", "-1000", "0", "", "satu juta", "1,5 juta", "12345678901234",
      "50000.00", "1.5", "1.50.000", "1500.000.0",
    ]) {
      expect(parseRupiahInput(text), text).toBeNull();
    }
  });

  it("formats amounts and labels states in Indonesian", () => {
    expect(formatRupiah(1_500_000)).toMatch(/^Rp1\.500\.000$/);
    expect(loanStatusLabel("PAID_OFF")).toBe("Lunas");
    expect(loanStatusLabel("UNKNOWN")).toBe("UNKNOWN");
  });
});
