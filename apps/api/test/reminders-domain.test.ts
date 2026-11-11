// NOTIF-003 pure rules (docs/domain/reminders.md §3): Jakarta clock, send window, thresholds.

import { describe, expect, it } from "vitest";

import {
  daysBetween,
  dueLabel,
  endOfSendWindow,
  insideSendWindow,
  jakartaClock,
  ruleIsDue,
  thresholdReached,
  whatsappEnabled,
} from "../src/modules/reminders/domain.js";
import { REMINDER_RULES, findReminderRule } from "../src/modules/reminders/rules.js";

const wib = (local: string) => new Date(`${local}+07:00`);

describe("NOTIF-003 domain", () => {
  it("reads the Jakarta calendar, not UTC", () => {
    // 23:30 UTC on 10 November is 06:30 WIB on 11 November, a Wednesday.
    expect(jakartaClock(new Date("2026-11-10T23:30:00Z"))).toEqual({ date: "2026-11-11", hour: 6, minute: 30, weekday: 3 });
  });

  it("D-04: makes and hands over reminders only from 06:00 to before 21:00 WIB", () => {
    expect(insideSendWindow(wib("2026-11-11T05:59:59"))).toBe(false);
    expect(insideSendWindow(wib("2026-11-11T06:00:00"))).toBe(true);
    expect(insideSendWindow(wib("2026-11-11T20:59:59"))).toBe(true);
    expect(insideSendWindow(wib("2026-11-11T21:00:00"))).toBe(false);
    expect(insideSendWindow(wib("2026-11-11T00:00:00"))).toBe(false);
  });

  it("D-12: a message made in the day expires at 21:00 WIB that day", () => {
    expect(endOfSendWindow(wib("2026-11-11T07:05:00")).toISOString()).toBe("2026-11-11T14:00:00.000Z");
  });

  it("D-05: a rule is due at or after its hour, inside the window, on its weekdays", () => {
    const digest = { fireHour: 7, weekdays: [1, 2, 3, 4, 5, 6] };
    expect(ruleIsDue(digest, wib("2026-11-11T06:59:00"))).toBe(false);
    expect(ruleIsDue(digest, wib("2026-11-11T07:00:00"))).toBe(true);
    expect(ruleIsDue(digest, wib("2026-11-11T20:30:00"))).toBe(true);
    expect(ruleIsDue(digest, wib("2026-11-11T21:10:00"))).toBe(false);
    // 15 November 2026 is a Sunday.
    expect(ruleIsDue(digest, wib("2026-11-15T09:00:00"))).toBe(false);
    expect(ruleIsDue({ fireHour: 8 }, wib("2026-11-15T09:00:00"))).toBe(true);
  });

  it("D-06: fires the smallest threshold already reached, never for a past date", () => {
    expect(thresholdReached(61, [60, 30, 7])).toBeNull();
    expect(thresholdReached(60, [60, 30, 7])).toBe(60);
    expect(thresholdReached(45, [60, 30, 7])).toBe(60);
    expect(thresholdReached(20, [60, 30, 7])).toBe(30);
    expect(thresholdReached(7, [60, 30, 7])).toBe(7);
    expect(thresholdReached(0, [60, 30, 7])).toBe(7);
    expect(thresholdReached(-1, [60, 30, 7])).toBeNull();
    expect(thresholdReached(0, [3, 0])).toBe(0);
    expect(thresholdReached(2, [3, 0])).toBe(3);
  });

  it("counts whole days and labels them", () => {
    expect(daysBetween("2026-11-11", "2026-12-11")).toBe(30);
    expect(daysBetween("2026-12-31", "2027-01-01")).toBe(1);
    expect(dueLabel(0)).toBe("hari ini");
    expect(dueLabel(1)).toBe("besok");
    expect(dueLabel(7)).toBe("7 hari lagi");
  });

  it("D-08: a stored preference wins over the rule default", () => {
    expect(whatsappEnabled(true, null)).toBe(true);
    expect(whatsappEnabled(true, false)).toBe(false);
    expect(whatsappEnabled(false, true)).toBe(true);
  });

  it("keeps a catalog of unique, well-formed rule keys within the send window", () => {
    const keys = REMINDER_RULES.map((rule) => rule.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const rule of REMINDER_RULES) {
      expect(rule.key).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(rule.fireHour).toBeGreaterThanOrEqual(6);
      expect(rule.fireHour).toBeLessThan(21);
    }
    expect(findReminderRule("approval.pending_digest")?.defaultWhatsApp).toBe(true);
    expect(findReminderRule("meeting.upcoming")).toBeNull();
  });
});
