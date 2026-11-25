import { describe, expect, it } from "vitest";

import {
  classifyAdministrationDays,
  evaluateAnnualConversionOffer,
} from "../src/modules/leave/domain/attendance-resolution.js";

describe("attendance resolution policy", () => {
  it("creates unresolved dates for partial administration validation", () => {
    expect(
      classifyAdministrationDays({
        action: "validate_partial",
        workingDates: ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"],
        validatedDates: ["2026-09-01", "2026-09-02"],
      }),
    ).toEqual({
      administrationStatus: "partially_validated",
      validatedDates: ["2026-09-01", "2026-09-02"],
      unresolvedDates: ["2026-09-03", "2026-09-04"],
    });
  });

  it("never offers annual conversion to education employees", () => {
    const offer = evaluateAnnualConversionOffer({
      entitlementGroup: "education",
      employmentStartedOn: "2024-01-01",
      unresolvedDates: ["2026-09-03", "2026-09-04"],
      usedDaysInPeriod: 0,
    });
    expect(offer.available).toBe(false);
    expect(offer.reason).toMatch(/non-pendidikan/i);
  });

  it("offers annual conversion when non-education employee is eligible and quota fits", () => {
    const offer = evaluateAnnualConversionOffer({
      entitlementGroup: "non_education",
      employmentStartedOn: "2025-01-10",
      unresolvedDates: ["2026-09-03", "2026-09-04"],
      usedDaysInPeriod: 1,
    });
    expect(offer).toMatchObject({
      available: true,
      periodKey: "JUL_SEP",
      remainingDays: 2,
      requestedDays: 2,
    });
  });

  it("blocks annual conversion when period quota is insufficient", () => {
    const offer = evaluateAnnualConversionOffer({
      entitlementGroup: "non_education",
      employmentStartedOn: "2024-01-10",
      unresolvedDates: ["2026-09-03", "2026-09-04"],
      usedDaysInPeriod: 2,
    });
    expect(offer.available).toBe(false);
    expect(offer.remainingDays).toBe(1);
  });

  /** LEAVE-003 R2: converting attendance dates spends the same quota as a normal request. */
  describe("semester quota", () => {
    const SEMESTER_FROM = "2027-01-01";

    it("converts into the semester period and against the 6-day limit", () => {
      const offer = evaluateAnnualConversionOffer({
        entitlementGroup: "non_education",
        employmentStartedOn: "2024-01-10",
        unresolvedDates: ["2027-02-03", "2027-02-04", "2027-02-05", "2027-02-08"],
        // Recorded in January under the old keys; the semester counts them once.
        usedDaysInPeriod: 2,
        semesterEffectiveFrom: SEMESTER_FROM,
      });

      expect(offer).toMatchObject({
        available: true,
        quotaScheme: "SEMESTER",
        periodKey: "JAN_JUN",
        periodLimitDays: 6,
        remainingDays: 4,
        requestedDays: 4,
      });
    });

    it("accepts dates across the old three-month boundary inside one semester", () => {
      const offer = evaluateAnnualConversionOffer({
        entitlementGroup: "non_education",
        employmentStartedOn: "2024-01-10",
        unresolvedDates: ["2027-03-30", "2027-03-31", "2027-04-01"],
        usedDaysInPeriod: 0,
        semesterEffectiveFrom: SEMESTER_FROM,
      });

      expect(offer).toMatchObject({ available: true, periodKey: "JAN_JUN" });
    });

    it("refuses dates that straddle 30 June and 1 July", () => {
      const offer = evaluateAnnualConversionOffer({
        entitlementGroup: "non_education",
        employmentStartedOn: "2024-01-10",
        unresolvedDates: ["2027-06-30", "2027-07-01"],
        usedDaysInPeriod: 0,
        semesterEffectiveFrom: SEMESTER_FROM,
      });

      expect(offer.available).toBe(false);
      expect(offer.periodKey).toBeNull();
      expect(offer.reason).toMatch(/satu periode/i);
    });

    it("keeps the three-month rule for dates before the effective date", () => {
      const offer = evaluateAnnualConversionOffer({
        entitlementGroup: "non_education",
        employmentStartedOn: "2024-01-10",
        unresolvedDates: ["2026-09-03", "2026-09-04"],
        usedDaysInPeriod: 1,
        semesterEffectiveFrom: SEMESTER_FROM,
      });

      expect(offer).toMatchObject({
        available: true,
        quotaScheme: "QUARTER",
        periodKey: "JUL_SEP",
        periodLimitDays: 3,
        remainingDays: 2,
      });
    });
  });
});
