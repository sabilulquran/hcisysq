import { describe, expect, it } from "vitest";

import {
  ANNUAL_LEAVE_ENTITLEMENT_DAYS,
  AnnualLeavePolicyError,
  annualLeavePeriodForDate,
  annualLeavePeriodLimitDays,
  annualLeavePeriodMonthRange,
  annualLeaveQuotaScheme,
  assertAnnualLeaveEntitlementGroup,
  calculateAnnualLeaveYearView,
} from "../src/modules/leave/domain/annual-leave-policy.js";
import {
  AnnualLeaveRequestPolicyError,
  validateAnnualLeaveRequest,
} from "../src/modules/leave/domain/annual-leave-request.js";
import {
  LeaveApprovalConfigurationError,
  resolveLeaveLineApprovalChain,
  snapshotResolvedLeaveAuthorities,
} from "../src/modules/leave/domain/approval-chain.js";
import { getLeavePolicy } from "../src/modules/leave/domain/policy-catalog.js";

describe("YSQ annual leave policy", () => {
  it("keeps the annual right at 12 days while only Q4 is usable when eligibility starts in October", () => {
    const view = calculateAnnualLeaveYearView({
      employmentStartedOn: "2025-10-15",
      referenceDate: "2026-10-15",
    });

    expect(view.annualEntitlementDays).toBe(ANNUAL_LEAVE_ENTITLEMENT_DAYS);
    expect(view.annualEntitlementDays).toBe(12);
    expect(view.eligibleFrom).toBe("2026-10-15");
    expect(view.eligible).toBe(true);
    expect(view.currentPeriodKey).toBe("OCT_DEC");
    expect(view.availableNowDays).toBe(3);
    expect(view.eligiblePeriodAllocationDaysInYear).toBe(3);
    expect(view.carryForwardEnabled).toBe(false);

    expect(view.periods.map((period) => [period.key, period.status])).toEqual([
      ["JAN_MAR", "not_eligible"],
      ["APR_JUN", "not_eligible"],
      ["JUL_SEP", "not_eligible"],
      ["OCT_DEC", "current"],
    ]);
  });

  it("shows 12 days/year before eligibility but makes zero days available now", () => {
    const view = calculateAnnualLeaveYearView({
      employmentStartedOn: "2026-10-15",
      referenceDate: "2026-12-01",
    });

    expect(view.annualEntitlementDays).toBe(12);
    expect(view.eligibleFrom).toBe("2027-10-15");
    expect(view.eligible).toBe(false);
    expect(view.availableNowDays).toBe(0);
    expect(view.eligiblePeriodAllocationDaysInYear).toBe(0);
  });

  it("limits the current period to the remaining part of its 3-day bucket", () => {
    const view = calculateAnnualLeaveYearView({
      employmentStartedOn: "2024-01-01",
      referenceDate: "2026-08-20",
      usedDaysByQuarter: { JUL_SEP: 2 },
    });

    expect(view.currentPeriodKey).toBe("JUL_SEP");
    expect(view.availableNowDays).toBe(1);
    expect(view.periods.find((period) => period.key === "JUL_SEP")?.remainingDays).toBe(1);
  });

  it("does not carry unused previous-period quota into the current period", () => {
    const view = calculateAnnualLeaveYearView({
      employmentStartedOn: "2024-01-01",
      referenceDate: "2026-05-10",
      usedDaysByQuarter: { JAN_MAR: 0, APR_JUN: 0 },
    });

    expect(view.availableNowDays).toBe(3);
    expect(view.carryForwardEnabled).toBe(false);
  });

  it("clamps a leap-day employment anniversary to the last valid day of February", () => {
    const view = calculateAnnualLeaveYearView({
      employmentStartedOn: "2024-02-29",
      referenceDate: "2025-02-28",
    });

    expect(view.eligibleFrom).toBe("2025-02-28");
    expect(view.eligible).toBe(true);
  });

  it("rejects individual annual leave for the education entitlement group", () => {
    expect(() => assertAnnualLeaveEntitlementGroup("education")).toThrowError(
      AnnualLeavePolicyError,
    );
    expect(() => assertAnnualLeaveEntitlementGroup("non_education")).not.toThrow();
  });
});

describe("YSQ annual leave request validation", () => {
  it("accepts a normal request inside the active 3-day period", () => {
    const result = validateAnnualLeaveRequest({
      entitlementGroup: "non_education",
      employmentStartedOn: "2024-01-01",
      submittedOn: "2026-08-01",
      leaveStartOn: "2026-08-10",
      leaveEndOn: "2026-08-11",
      requestedWorkingDays: 2,
      usedDaysByQuarter: { JUL_SEP: 1 },
    });

    expect(result.annualEntitlementDays).toBe(12);
    expect(result.periodKey).toBe("JUL_SEP");
    expect(result.periodLimitDays).toBe(3);
    expect(result.availableDaysBeforeRequest).toBe(2);
    expect(result.availableDaysAfterRequest).toBe(0);
    expect(result.noticeDays).toBe(9);
  });

  it("blocks annual leave before the 12-month eligibility date", () => {
    expect(() =>
      validateAnnualLeaveRequest({
        entitlementGroup: "non_education",
        employmentStartedOn: "2025-10-15",
        submittedOn: "2026-09-25",
        leaveStartOn: "2026-10-10",
        leaveEndOn: "2026-10-10",
        requestedWorkingDays: 1,
      }),
    ).toThrowError(AnnualLeaveRequestPolicyError);
  });

  it("blocks a request that misses H-7", () => {
    expect(() =>
      validateAnnualLeaveRequest({
        entitlementGroup: "non_education",
        employmentStartedOn: "2024-01-01",
        submittedOn: "2026-08-05",
        leaveStartOn: "2026-08-10",
        leaveEndOn: "2026-08-10",
        requestedWorkingDays: 1,
      }),
    ).toThrowError(AnnualLeaveRequestPolicyError);
  });

  it("blocks usage beyond the current period's remaining quota", () => {
    expect(() =>
      validateAnnualLeaveRequest({
        entitlementGroup: "non_education",
        employmentStartedOn: "2024-01-01",
        submittedOn: "2026-08-01",
        leaveStartOn: "2026-08-10",
        leaveEndOn: "2026-08-12",
        requestedWorkingDays: 2,
        usedDaysByQuarter: { JUL_SEP: 2 },
      }),
    ).toThrowError(AnnualLeaveRequestPolicyError);
  });

  it("requires a split when one request crosses two quota periods", () => {
    expect(() =>
      validateAnnualLeaveRequest({
        entitlementGroup: "non_education",
        employmentStartedOn: "2024-01-01",
        submittedOn: "2026-09-20",
        leaveStartOn: "2026-09-29",
        leaveEndOn: "2026-10-02",
        requestedWorkingDays: 3,
      }),
    ).toThrowError(AnnualLeaveRequestPolicyError);
  });
});

/**
 * LEAVE-003 R2: 3 working days per three-month period become 6 per calendar semester, by leave
 * date. The annual right stays 12. 2027-01-01 is the proposed effective date; some cases below put
 * the change mid-year to prove the rule also holds when it does not land on 1 January.
 */
describe("LEAVE-003 R2 semester quota", () => {
  const SEMESTER_FROM = "2027-01-01";

  it("picks the scheme from the leave date, not the submission date", () => {
    expect(annualLeaveQuotaScheme("2026-12-31", SEMESTER_FROM)).toBe("QUARTER");
    expect(annualLeaveQuotaScheme("2027-01-01", SEMESTER_FROM)).toBe("SEMESTER");
    // No effective date at all: the three-month rule governs every date, production included.
    expect(annualLeaveQuotaScheme("2030-07-01", null)).toBe("QUARTER");
  });

  it("maps a date to its quarter or its semester", () => {
    expect(annualLeavePeriodForDate("2027-06-30", "QUARTER")).toBe("APR_JUN");
    expect(annualLeavePeriodForDate("2027-06-30", "SEMESTER")).toBe("JAN_JUN");
    expect(annualLeavePeriodForDate("2027-07-01", "SEMESTER")).toBe("JUL_DEC");
    expect(annualLeavePeriodLimitDays("QUARTER")).toBe(3);
    expect(annualLeavePeriodLimitDays("SEMESTER")).toBe(6);
  });

  it("gives every period its month range, which is what the usage queries bound on", () => {
    // `annualUsageInPeriod` turns these into `start_on >= make_date(y, startMonth, 1)` and
    // `start_on < make_date(y, endMonth, 1) + interval '1 month'`, so December must read as 12.
    expect(annualLeavePeriodMonthRange("JAN_MAR")).toEqual({ startMonth: 1, endMonth: 3 });
    expect(annualLeavePeriodMonthRange("APR_JUN")).toEqual({ startMonth: 4, endMonth: 6 });
    expect(annualLeavePeriodMonthRange("JUL_SEP")).toEqual({ startMonth: 7, endMonth: 9 });
    expect(annualLeavePeriodMonthRange("OCT_DEC")).toEqual({ startMonth: 10, endMonth: 12 });
    expect(annualLeavePeriodMonthRange("JAN_JUN")).toEqual({ startMonth: 1, endMonth: 6 });
    expect(annualLeavePeriodMonthRange("JUL_DEC")).toEqual({ startMonth: 7, endMonth: 12 });
  });

  it("shows four 3-day periods before the effective date and two 6-day periods after it", () => {
    const employee = { employmentStartedOn: "2024-01-01", semesterEffectiveFrom: SEMESTER_FROM };

    const before = calculateAnnualLeaveYearView({ ...employee, referenceDate: "2026-12-15" });
    expect(before.quotaScheme).toBe("QUARTER");
    expect(before.periods.map((period) => [period.key, period.allocationDays])).toEqual([
      ["JAN_MAR", 3],
      ["APR_JUN", 3],
      ["JUL_SEP", 3],
      ["OCT_DEC", 3],
    ]);
    expect(before.currentPeriodKey).toBe("OCT_DEC");
    expect(before.availableNowDays).toBe(3);
    expect(before.eligiblePeriodAllocationDaysInYear).toBe(12);

    const after = calculateAnnualLeaveYearView({ ...employee, referenceDate: "2027-01-15" });
    expect(after.quotaScheme).toBe("SEMESTER");
    expect(after.periods.map((period) => [period.key, period.allocationDays])).toEqual([
      ["JAN_JUN", 6],
      ["JUL_DEC", 6],
    ]);
    expect(after.currentPeriodKey).toBe("JAN_JUN");
    expect(after.availableNowDays).toBe(6);
    // The annual right never moved: 4x3 and 2x6 are both 12.
    expect(after.eligiblePeriodAllocationDaysInYear).toBe(12);
    expect(after.annualEntitlementDays).toBe(12);
  });

  it("reads a semester's usage as the sum of the two quarters the old rule recorded", () => {
    const view = calculateAnnualLeaveYearView({
      employmentStartedOn: "2024-01-01",
      referenceDate: "2027-05-10",
      semesterEffectiveFrom: SEMESTER_FROM,
      // Recorded under the three-month rule; nothing about those rows was rewritten.
      usedDaysByQuarter: { JAN_MAR: 2, APR_JUN: 1 },
    });

    expect(view.quotaScheme).toBe("SEMESTER");
    expect(view.periods.find((period) => period.key === "JAN_JUN")?.usedDays).toBe(3);
    expect(view.availableNowDays).toBe(3);
    // The other semester is untouched: a day is counted in exactly one period.
    expect(view.periods.find((period) => period.key === "JUL_DEC")?.usedDays).toBe(0);
  });

  it("accepts 6 working days in an unused semester and refuses 7", () => {
    const common = {
      entitlementGroup: "non_education" as const,
      employmentStartedOn: "2024-01-01",
      submittedOn: "2027-02-01",
      leaveStartOn: "2027-02-15",
      leaveEndOn: "2027-02-22",
      semesterEffectiveFrom: SEMESTER_FROM,
    };

    const accepted = validateAnnualLeaveRequest({ ...common, requestedWorkingDays: 6 });
    expect(accepted.quotaScheme).toBe("SEMESTER");
    expect(accepted.periodKey).toBe("JAN_JUN");
    expect(accepted.periodLimitDays).toBe(6);
    expect(accepted.availableDaysAfterRequest).toBe(0);

    expect(() =>
      validateAnnualLeaveRequest({ ...common, requestedWorkingDays: 7 }),
    ).toThrowError(AnnualLeaveRequestPolicyError);
  });

  it("counts days already used in the semester, including a request still awaiting a decision", () => {
    expect(() =>
      validateAnnualLeaveRequest({
        entitlementGroup: "non_education",
        employmentStartedOn: "2024-01-01",
        submittedOn: "2027-05-01",
        leaveStartOn: "2027-05-10",
        leaveEndOn: "2027-05-14",
        requestedWorkingDays: 4,
        // These 3 days sit in a request that is still `in_review`; the route counts those too.
        usedDaysByQuarter: { JAN_MAR: 3 },
        semesterEffectiveFrom: SEMESTER_FROM,
      }),
    ).toThrowError(AnnualLeaveRequestPolicyError);

    const fits = validateAnnualLeaveRequest({
      entitlementGroup: "non_education",
      employmentStartedOn: "2024-01-01",
      submittedOn: "2027-05-01",
      leaveStartOn: "2027-05-10",
      leaveEndOn: "2027-05-13",
      requestedWorkingDays: 3,
      usedDaysByQuarter: { JAN_MAR: 3 },
      semesterEffectiveFrom: SEMESTER_FROM,
    });
    expect(fits.usedDaysBeforeRequest).toBe(3);
    expect(fits.availableDaysAfterRequest).toBe(0);
  });

  it("allows one request across the old quarter boundary once the semester rule applies", () => {
    const result = validateAnnualLeaveRequest({
      entitlementGroup: "non_education",
      employmentStartedOn: "2024-01-01",
      submittedOn: "2027-03-15",
      leaveStartOn: "2027-03-29",
      leaveEndOn: "2027-04-02",
      requestedWorkingDays: 5,
      semesterEffectiveFrom: SEMESTER_FROM,
    });

    expect(result.periodKey).toBe("JAN_JUN");
    expect(result.availableDaysAfterRequest).toBe(1);
  });

  it("still refuses one request across 30 June-1 July or the year end", () => {
    const common = {
      entitlementGroup: "non_education" as const,
      employmentStartedOn: "2024-01-01",
      requestedWorkingDays: 3,
      semesterEffectiveFrom: SEMESTER_FROM,
    };

    expect(() =>
      validateAnnualLeaveRequest({
        ...common,
        submittedOn: "2027-12-15",
        leaveStartOn: "2027-12-29",
        leaveEndOn: "2028-01-03",
      }),
    ).toThrowError(AnnualLeaveRequestPolicyError);

    try {
      validateAnnualLeaveRequest({
        ...common,
        submittedOn: "2027-06-15",
        leaveStartOn: "2027-06-29",
        leaveEndOn: "2027-07-02",
      });
      expect.unreachable("a request across the semester boundary must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(AnnualLeaveRequestPolicyError);
      expect((error as AnnualLeaveRequestPolicyError).code).toBe(
        "CROSS_PERIOD_REQUEST_UNSUPPORTED",
      );
      // The message names the boundary the employee has to split on.
      expect((error as Error).message).toContain("30 Juni-1 Juli");
    }
  });

  it("keeps the three-month rule for leave dates before the effective date", () => {
    // Submitted after the rule changed, for dates that still belong to the old rule.
    const result = validateAnnualLeaveRequest({
      entitlementGroup: "non_education",
      employmentStartedOn: "2024-01-01",
      submittedOn: "2027-03-20",
      leaveStartOn: "2027-05-10",
      leaveEndOn: "2027-05-12",
      requestedWorkingDays: 3,
      semesterEffectiveFrom: "2027-07-01",
    });

    expect(result.quotaScheme).toBe("QUARTER");
    expect(result.periodKey).toBe("APR_JUN");
    expect(result.periodLimitDays).toBe(3);
  });

  it("reads a range containing the effective date under one scheme, the start date's", () => {
    // 2027-03-29 is still the old rule, 2027-04-02 the new one. The start date decides, so the
    // request is read as a three-month one and refused for crossing that boundary, rather than
    // being split silently between two rules.
    try {
      validateAnnualLeaveRequest({
        entitlementGroup: "non_education",
        employmentStartedOn: "2024-01-01",
        submittedOn: "2027-03-15",
        leaveStartOn: "2027-03-29",
        leaveEndOn: "2027-04-02",
        requestedWorkingDays: 5,
        semesterEffectiveFrom: "2027-04-01",
      });
      expect.unreachable("the range crosses a three-month boundary under the old rule");
    } catch (error) {
      expect((error as AnnualLeaveRequestPolicyError).code).toBe(
        "CROSS_PERIOD_REQUEST_UNSUPPORTED",
      );
    }

    const insideTheOldPeriod = validateAnnualLeaveRequest({
      entitlementGroup: "non_education",
      employmentStartedOn: "2024-01-01",
      submittedOn: "2027-03-10",
      leaveStartOn: "2027-03-25",
      leaveEndOn: "2027-03-27",
      requestedWorkingDays: 3,
      semesterEffectiveFrom: "2027-03-26",
    });
    expect(insideTheOldPeriod.quotaScheme).toBe("QUARTER");
    expect(insideTheOldPeriod.periodLimitDays).toBe(3);
  });

  it("still caps the year at 12 working days when the rule changes mid-year", () => {
    const employee = {
      entitlementGroup: "non_education" as const,
      employmentStartedOn: "2024-01-01",
      semesterEffectiveFrom: "2027-04-01",
    };

    // Jan-Mar is read under the old rule: 3 days, and no more.
    const firstQuarter = validateAnnualLeaveRequest({
      ...employee,
      submittedOn: "2027-02-01",
      leaveStartOn: "2027-02-15",
      leaveEndOn: "2027-02-17",
      requestedWorkingDays: 3,
    });
    expect(firstQuarter.quotaScheme).toBe("QUARTER");
    expect(firstQuarter.availableDaysAfterRequest).toBe(0);

    // Apr-Jun is read under the new rule, against the whole semester: 6 minus the 3 already used.
    const firstSemesterRemainder = validateAnnualLeaveRequest({
      ...employee,
      submittedOn: "2027-05-01",
      leaveStartOn: "2027-05-10",
      leaveEndOn: "2027-05-12",
      requestedWorkingDays: 3,
      usedDaysByQuarter: { JAN_MAR: 3 },
    });
    expect(firstSemesterRemainder.quotaScheme).toBe("SEMESTER");
    expect(firstSemesterRemainder.periodKey).toBe("JAN_JUN");
    expect(firstSemesterRemainder.availableDaysAfterRequest).toBe(0);

    // A fourth day in the first semester is refused, so the half-year total stays 6.
    expect(() =>
      validateAnnualLeaveRequest({
        ...employee,
        submittedOn: "2027-06-01",
        leaveStartOn: "2027-06-14",
        leaveEndOn: "2027-06-14",
        requestedWorkingDays: 1,
        usedDaysByQuarter: { JAN_MAR: 3, APR_JUN: 3 },
      }),
    ).toThrowError(AnnualLeaveRequestPolicyError);

    // The second semester starts clean at 6.
    const secondSemester = validateAnnualLeaveRequest({
      ...employee,
      submittedOn: "2027-08-01",
      leaveStartOn: "2027-08-16",
      leaveEndOn: "2027-08-23",
      requestedWorkingDays: 6,
      usedDaysByQuarter: { JAN_MAR: 3, APR_JUN: 3 },
    });
    expect(secondSemester.periodKey).toBe("JUL_DEC");
    expect(secondSemester.availableDaysAfterRequest).toBe(0);

    expect(3 + 3 + 6).toBe(ANNUAL_LEAVE_ENTITLEMENT_DAYS);
  });

  /**
   * The order above is the safe one. Requests may be submitted in any order, and booking a
   * later-dated leave before an earlier-dated one is ordinary: the three-month rule must not be
   * blind to semester-rule days already sitting in the other half of the same semester.
   */
  it("caps the semester at 6 even when the three-month rule is applied after it, in any order", () => {
    const employee = {
      entitlementGroup: "non_education" as const,
      employmentStartedOn: "2024-01-01",
      semesterEffectiveFrom: "2027-04-01",
    };

    // Booked first, for May: the semester rule gives all 6 days of Januari-Juni.
    const may = validateAnnualLeaveRequest({
      ...employee,
      submittedOn: "2027-02-01",
      leaveStartOn: "2027-05-10",
      leaveEndOn: "2027-05-17",
      requestedWorkingDays: 6,
    });
    expect(may.quotaScheme).toBe("SEMESTER");
    expect(may.periodKey).toBe("JAN_JUN");

    // Booked second, for March: read under the three-month rule, but the semester is spent.
    expect(() =>
      validateAnnualLeaveRequest({
        ...employee,
        submittedOn: "2027-02-10",
        leaveStartOn: "2027-03-22",
        leaveEndOn: "2027-03-24",
        requestedWorkingDays: 1,
        usedDaysByQuarter: { APR_JUN: 6 },
      }),
    ).toThrowError(AnnualLeaveRequestPolicyError);

    // Four of those six sitting in May still leave only two for March, never the full quarter of 3.
    const march = validateAnnualLeaveRequest({
      ...employee,
      submittedOn: "2027-02-10",
      leaveStartOn: "2027-03-22",
      leaveEndOn: "2027-03-23",
      requestedWorkingDays: 2,
      usedDaysByQuarter: { APR_JUN: 4 },
    });
    expect(march.quotaScheme).toBe("QUARTER");
    expect(march.periodKey).toBe("JAN_MAR");
    expect(march.availableDaysBeforeRequest).toBe(2);
    expect(march.availableDaysAfterRequest).toBe(0);
  });

  it("does not restrict a year that is wholly under the three-month rule", () => {
    // The extra semester cap is 3 + 3, so each quarter keeps its own full 3 days.
    const view = calculateAnnualLeaveYearView({
      employmentStartedOn: "2024-01-01",
      referenceDate: "2027-05-10",
      semesterEffectiveFrom: "2027-07-01",
      usedDaysByQuarter: { JAN_MAR: 3 },
    });

    expect(view.quotaScheme).toBe("QUARTER");
    expect(view.availableNowDays).toBe(3);
    expect(view.periods.find((period) => period.key === "APR_JUN")?.remainingDays).toBe(3);
  });

  it("does not give a mid-year eligible employee a semester they cannot reach", () => {
    const view = calculateAnnualLeaveYearView({
      employmentStartedOn: "2026-10-15",
      referenceDate: "2027-11-01",
      semesterEffectiveFrom: SEMESTER_FROM,
    });

    expect(view.eligibleFrom).toBe("2027-10-15");
    expect(view.quotaScheme).toBe("SEMESTER");
    expect(view.periods.map((period) => [period.key, period.status])).toEqual([
      ["JAN_JUN", "not_eligible"],
      ["JUL_DEC", "current"],
    ]);
    // Jan-Jun ended before eligibility, so only the second semester is usable this year.
    expect(view.availableNowDays).toBe(6);
    expect(view.eligiblePeriodAllocationDaysInYear).toBe(6);
  });
});

describe("YSQ line approval resolution", () => {
  it("routes a layered employee through direct manager then unit approver", () => {
    expect(
      resolveLeaveLineApprovalChain({
        requesterEmployeeId: "guru",
        directManagerEmployeeId: "wakasek-kurikulum",
        unitApproverEmployeeId: "kepala-sdit",
      }),
    ).toEqual([
      { employeeId: "wakasek-kurikulum", sources: ["DIRECT_MANAGER"] },
      { employeeId: "kepala-sdit", sources: ["UNIT_APPROVER"] },
    ]);
  });

  it("deduplicates when direct manager is already the unit approver", () => {
    expect(
      resolveLeaveLineApprovalChain({
        requesterEmployeeId: "guru",
        directManagerEmployeeId: "kepala-sdit",
        unitApproverEmployeeId: "kepala-sdit",
      }),
    ).toEqual([
      {
        employeeId: "kepala-sdit",
        sources: ["DIRECT_MANAGER", "UNIT_APPROVER"],
      },
    ]);
  });

  it("removes requester self-approval for a unit head and keeps the direct manager", () => {
    expect(
      resolveLeaveLineApprovalChain({
        requesterEmployeeId: "kepala-sdit",
        directManagerEmployeeId: "kabid-pendidikan",
        unitApproverEmployeeId: "kepala-sdit",
      }),
    ).toEqual([{ employeeId: "kabid-pendidikan", sources: ["DIRECT_MANAGER"] }]);
  });

  it("fails closed when vacancy has no explicitly configured unit approver", () => {
    expect(() =>
      resolveLeaveLineApprovalChain({
        requesterEmployeeId: "staff",
        directManagerEmployeeId: "koordinator",
        unitApproverEmployeeId: null,
      }),
    ).toThrowError(LeaveApprovalConfigurationError);
  });

  it("fails closed when direct manager is missing", () => {
    expect(() =>
      resolveLeaveLineApprovalChain({
        requesterEmployeeId: "staff",
        directManagerEmployeeId: null,
        unitApproverEmployeeId: "direktur",
      }),
    ).toThrowError(LeaveApprovalConfigurationError);
  });

  it("snapshots configured governance authority without relying on a position title", () => {
    expect(
      snapshotResolvedLeaveAuthorities({
        requesterEmployeeId: "requester",
        authorities: [
          { employeeId: "secretary-incumbent", source: "GOVERNANCE_APPROVER" },
        ],
      }),
    ).toEqual([
      {
        employeeId: "secretary-incumbent",
        sources: ["GOVERNANCE_APPROVER"],
      },
    ]);
  });

  it("defensively removes self approvals and deduplicates structural authorities", () => {
    expect(
      snapshotResolvedLeaveAuthorities({
        requesterEmployeeId: "requester",
        authorities: [
          { employeeId: "requester", source: "UNIT_APPROVER" },
          { employeeId: "director", source: "DIRECT_MANAGER" },
          { employeeId: "director", source: "UNIT_APPROVER" },
        ],
      }),
    ).toEqual([
      {
        employeeId: "director",
        sources: ["DIRECT_MANAGER", "UNIT_APPROVER"],
      },
    ]);
  });
});

describe("YSQ leave policy catalog", () => {
  it("treats HC as notified for annual leave and approver for unpaid leave", () => {
    expect(getLeavePolicy("annual").hcHandling).toBe("notify");
    expect(getLeavePolicy("annual").lineHandling).toBe("approval");
    expect(getLeavePolicy("unpaid").hcHandling).toBe("approve");
    expect(getLeavePolicy("unpaid").lineHandling).toBe("approval");
  });

  it("does not model collective leave as an individual request", () => {
    expect(getLeavePolicy("foundation_collective").requestMode).toBe(
      "organization_event",
    );
    expect(getLeavePolicy("academic_break").requestMode).toBe("organization_event");
  });
});
