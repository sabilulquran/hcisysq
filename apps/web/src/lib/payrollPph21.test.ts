// PAY-003 PPh21 report vocabulary on the client, and the PPh21 part of a new
// compensation profile. Synthetic data only.

import { describe, expect, it } from "vitest";

import {
  formatPph21Rate,
  PayrollApiError,
  payrollPph21CsvUrl,
  payrollPph21FlagLabel,
  payrollPph21Refusal,
} from "@/lib/payroll";
import { pph21ProfileFields } from "@/lib/payrollReference";

describe("PAY-003 PPh21 report vocabulary", () => {
  it("downloads the PPh21 CSV the server builds, with the id escaped", () => {
    expect(payrollPph21CsvUrl("abc-123")).toBe("/api/payroll/periods/abc-123/pph21?format=csv");
    expect(payrollPph21CsvUrl("a/b c")).toBe("/api/payroll/periods/a%2Fb%20c/pph21?format=csv");
  });

  it("writes a TER rate with a decimal comma, and a dash when there is none", () => {
    expect(formatPph21Rate(0.0025)).toBe("0,25%");
    expect(formatPph21Rate(0.05)).toBe("5%");
    expect(formatPph21Rate(0)).toBe("0%");
    expect(formatPph21Rate(null)).toBe("—");
  });

  it("names every flag the server sends", () => {
    expect(payrollPph21FlagLabel("PTKP_MISSING")).toBe("PTKP belum terpetakan");
    expect(payrollPph21FlagLabel("EXCLUDED")).toBe("Dikecualikan");
    expect(payrollPph21FlagLabel("ANNUAL_CALCULATION_REQUIRED")).toContain("bukan angka final");
    expect(payrollPph21FlagLabel("PTKP_CONFLICT")).toContain("berbeda");
    expect(payrollPph21FlagLabel("NON_PERMANENT_TERMS")).toContain("Honorer/lepas");
  });

  it("explains the expected refusals instead of raising an alarm", () => {
    expect(payrollPph21Refusal(new PayrollApiError("x", "PAYROLL_NOT_APPROVED_YET"))).toMatchObject({
      tone: "info",
      note: expect.stringContaining("setelah periode disahkan"),
    });
    expect(payrollPph21Refusal(new PayrollApiError("x", "PAYROLL_FORBIDDEN")).tone).toBe("info");
    expect(payrollPph21Refusal(new PayrollApiError("x", "PPH21_TER_POLICY_MISSING"))).toMatchObject({
      tone: "info",
      note: expect.stringContaining("PP 58/2023"),
    });
  });

  it("shows anything else as an error, with the server's message", () => {
    expect(payrollPph21Refusal(new PayrollApiError("Isi kebijakan rusak", "PPH21_TER_POLICY_INVALID"))).toEqual({
      tone: "error",
      note: "Isi kebijakan rusak",
    });
    expect(payrollPph21Refusal(new Error("network")).tone).toBe("error");
  });
});

describe("PAY-003 PPh21 reporting on a new profile", () => {
  it("sends nothing when left alone, so the server carries the current choice", () => {
    expect(pph21ProfileFields("carry", "")).toEqual({ ok: true, fields: {} });
  });

  it("reports someone again without a reason", () => {
    expect(pph21ProfileFields("reported", "lama")).toEqual({ ok: true, fields: { pph21ReportExcluded: false } });
  });

  it("excludes only with a reason, trimmed", () => {
    expect(pph21ProfileFields("excluded", "  ")).toMatchObject({ ok: false });
    expect(pph21ProfileFields("excluded", " Dilaporkan pemberi kerja lain ")).toEqual({
      ok: true,
      fields: { pph21ReportExcluded: true, pph21ReportExclusionReason: "Dilaporkan pemberi kerja lain" },
    });
  });
});
