// LEAVE-009 pure rules. Spec: docs/domain/leave-critical-periods.md §3.

import { describe, expect, it } from "vitest";

import {
  assertCriticalPeriodRange,
  criticalPeriodTreatment,
  matchCriticalPeriods,
  type CriticalPeriodRecord,
} from "../src/modules/leave/domain/critical-period.js";

const UNIT_A = "00000000-0000-4000-8000-00000000000a";
const UNIT_B = "00000000-0000-4000-8000-00000000000b";

function period(overrides: Partial<CriticalPeriodRecord>): CriticalPeriodRecord {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    label: "Ujian Akhir Semester",
    startOn: "2026-12-07",
    endOn: "2026-12-12",
    unitId: null,
    unitName: null,
    isActive: true,
    ...overrides,
  };
}

describe("LEAVE-009 critical period matching", () => {
  it("matches any overlap of the leave range, not only the start date (D-03)", () => {
    const periods = [period({})];
    // Starts before the exam week and ends inside it: legacy's start-date rule missed this.
    expect(matchCriticalPeriods(periods, { unitId: UNIT_A, startOn: "2026-12-03", endOn: "2026-12-08" }))
      .toHaveLength(1);
    expect(matchCriticalPeriods(periods, { unitId: UNIT_A, startOn: "2026-12-12", endOn: "2026-12-14" }))
      .toHaveLength(1);
    expect(matchCriticalPeriods(periods, { unitId: UNIT_A, startOn: "2026-12-13", endOn: "2026-12-14" }))
      .toEqual([]);
    expect(matchCriticalPeriods(periods, { unitId: UNIT_A, startOn: "2026-12-01", endOn: "2026-12-06" }))
      .toEqual([]);
  });

  it("applies foundation-wide periods to everyone and unit periods only to that unit (D-04)", () => {
    const periods = [
      period({ id: "00000000-0000-4000-8000-000000000001" }),
      period({ id: "00000000-0000-4000-8000-000000000002", unitId: UNIT_B, unitName: "SMP", label: "PPDB SMP" }),
    ];
    const forA = matchCriticalPeriods(periods, { unitId: UNIT_A, startOn: "2026-12-08", endOn: "2026-12-08" });
    expect(forA.map((item) => item.scope)).toEqual(["organization"]);
    const forB = matchCriticalPeriods(periods, { unitId: UNIT_B, startOn: "2026-12-08", endOn: "2026-12-08" });
    expect(forB.map((item) => [item.scope, item.label])).toEqual([
      ["organization", "Ujian Akhir Semester"],
      ["unit", "PPDB SMP"],
    ]);
    // An employee without a unit only sees foundation-wide periods.
    expect(matchCriticalPeriods(periods, { unitId: null, startOn: "2026-12-08", endOn: "2026-12-08" }))
      .toHaveLength(1);
  });

  it("ignores inactive periods (D-08)", () => {
    expect(matchCriticalPeriods([period({ isActive: false })], {
      unitId: UNIT_A, startOn: "2026-12-08", endOn: "2026-12-08",
    })).toEqual([]);
  });
});

describe("LEAVE-009 critical period treatment per leave type (D-02)", () => {
  it("reviews annual and planned line-approval leave", () => {
    for (const key of ["annual", "employee_marriage", "child_marriage", "child_circumcision", "hajj"]) {
      expect(criticalPeriodTreatment(key), key).toBe("review");
    }
  });

  it("only records unpaid leave, which HC already decides", () => {
    expect(criticalPeriodTreatment("unpaid")).toBe("record");
  });

  it("never touches special leave rights", () => {
    for (const key of ["sick", "maternity", "miscarriage", "menstrual_rest", "family_death"]) {
      expect(criticalPeriodTreatment(key), key).toBe("none");
    }
  });
});

describe("LEAVE-009 critical period range (D-09)", () => {
  it("accepts one day and exactly 120 days", () => {
    expect(() => assertCriticalPeriodRange("2026-12-07", "2026-12-07")).not.toThrow();
    expect(() => assertCriticalPeriodRange("2026-01-01", "2026-04-30")).not.toThrow();
  });

  it("rejects an end before the start, more than 120 days, and impossible dates", () => {
    expect(() => assertCriticalPeriodRange("2026-12-07", "2026-12-06"))
      .toThrow(expect.objectContaining({ code: "CRITICAL_PERIOD_RANGE_INVALID" }));
    expect(() => assertCriticalPeriodRange("2026-01-01", "2026-05-01"))
      .toThrow(expect.objectContaining({ code: "CRITICAL_PERIOD_TOO_LONG" }));
    expect(() => assertCriticalPeriodRange("2026-02-30", "2026-03-01"))
      .toThrow(expect.objectContaining({ code: "CRITICAL_PERIOD_DATE_INVALID" }));
  });
});
