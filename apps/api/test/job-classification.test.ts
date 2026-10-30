// ORG-011 pure date helpers. No database, synthetic data only.

import { describe, expect, it } from "vitest";

import {
  ADMIN_PERMISSIONS, HC_ADMIN_PERMISSIONS, JOB_CLASSIFICATION_PERMISSIONS,
} from "../src/modules/auth/permissions.js";
import { coversDate, jakartaDate, previousDay } from "../src/modules/organization/job-classification-service.js";

describe("ORG-011 effective dating", () => {
  it("closes the previous version the day before the amendment takes effect", () => {
    expect(previousDay("2026-11-01")).toBe("2026-10-31");
    // Across a month and a leap day, so an amendment on the 1st never leaves a gap.
    expect(previousDay("2027-01-01")).toBe("2026-12-31");
    expect(previousDay("2028-03-01")).toBe("2028-02-29");
  });

  it("treats both ends of an effective range as inclusive", () => {
    const row = { effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31" };
    expect(coversDate(row, "2026-01-01")).toBe(true);
    expect(coversDate(row, "2026-12-31")).toBe(true);
    expect(coversDate(row, "2025-12-31")).toBe(false);
    expect(coversDate(row, "2027-01-01")).toBe(false);
  });

  it("lets an open-ended version run forever", () => {
    const row = { effectiveFrom: "2026-01-01", effectiveTo: null };
    expect(coversDate(row, "2099-06-30")).toBe(true);
    expect(coversDate(row, "2025-12-31")).toBe(false);
  });

  it("reads today on the Jakarta calendar", () => {
    // 2026-10-30T23:00Z is already 31 October in Jakarta; a catalog lookup must not
    // resolve yesterday's version for an operator working in the evening.
    expect(jakartaDate(new Date("2026-10-30T23:00:00Z"))).toBe("2026-10-31");
    expect(jakartaDate(new Date("2026-10-30T16:00:00Z"))).toBe("2026-10-30");
  });
});

describe("ORG-011 permission placement", () => {
  it("keeps the catalog out of legacy Super Admin compatibility", () => {
    // ADMIN_PERMISSIONS is what a legacy Super Admin receives without an explicit assignment.
    // ORG-011 is HC-only, so neither key may ever appear there (ADR-0004 §Compliance).
    for (const key of JOB_CLASSIFICATION_PERMISSIONS) {
      expect(ADMIN_PERMISSIONS as readonly string[]).not.toContain(key);
      expect(HC_ADMIN_PERMISSIONS as readonly string[]).toContain(key);
    }
  });
});
