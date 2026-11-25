import { describe, expect, it } from "vitest";

import { annualQuotaHint, formatQuotaDate } from "@/lib/employeeLeave";

/**
 * LEAVE-003 R2: enforcement follows the leave date, so the hint must never let today's rule speak
 * for dates after the change without saying so.
 */
describe("annualQuotaHint", () => {
  it("names the semester boundary under the semester rule", () => {
    const hint = annualQuotaHint({ quotaScheme: "SEMESTER", periodLimitDays: 6 });
    expect(hint).toContain("6 hari kerja per semester");
    expect(hint).toContain("30 Juni-1 Juli");
    expect(hint).not.toContain("berpindah ke per semester");
  });

  it("names the three-month boundary under the quarter rule", () => {
    const hint = annualQuotaHint({ quotaScheme: "QUARTER", periodLimitDays: 3 });
    expect(hint).toContain("3 hari kerja per periode tiga bulan");
    expect(hint).toContain("satu periode");
  });

  it("warns that the rule changes when the effective date is still ahead", () => {
    const hint = annualQuotaHint({
      quotaScheme: "QUARTER",
      periodLimitDays: 3,
      semesterEffectiveFrom: "2027-01-01",
      referenceDate: "2026-12-20",
    });
    expect(hint).toContain("3 hari kerja per periode tiga bulan");
    expect(hint).toContain("Untuk tanggal cuti mulai 1 Januari 2027");
    expect(hint).toContain("bukan tanggal pengajuan");
  });

  it("says nothing about a change that has already happened or was never scheduled", () => {
    expect(
      annualQuotaHint({
        quotaScheme: "SEMESTER",
        periodLimitDays: 6,
        semesterEffectiveFrom: "2027-01-01",
        referenceDate: "2027-01-15",
      }),
    ).not.toContain("Untuk tanggal cuti mulai");

    expect(
      annualQuotaHint({
        quotaScheme: "QUARTER",
        periodLimitDays: 3,
        semesterEffectiveFrom: null,
        referenceDate: "2026-12-20",
      }),
    ).not.toContain("Untuk tanggal cuti mulai");

    // The effective date is today: the rule already applies, so there is nothing to announce.
    expect(
      annualQuotaHint({
        quotaScheme: "SEMESTER",
        periodLimitDays: 6,
        semesterEffectiveFrom: "2027-01-01",
        referenceDate: "2027-01-01",
      }),
    ).not.toContain("Untuk tanggal cuti mulai");
  });

  it("falls back to the raw value for a date it cannot read", () => {
    expect(formatQuotaDate("2027-01-01")).toBe("1 Januari 2027");
    expect(formatQuotaDate("bukan-tanggal")).toBe("bukan-tanggal");
  });
});
