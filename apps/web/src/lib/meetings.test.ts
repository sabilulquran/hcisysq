import { describe, expect, it } from "vitest";

import {
  calendarItemLabel,
  formatMeetingRange,
  itemDates,
  itemsByDate,
  jakartaDate,
  jakartaTime,
  monthGrid,
  shiftMonth,
  wibInstant,
  type CalendarItem,
} from "./meetings";

describe("CAL-001 calendar helpers", () => {
  it("builds a Monday-first six-week grid", () => {
    const grid = monthGrid("2026-11");
    expect(grid).toHaveLength(42);
    // 1 November 2026 is a Sunday, so the grid starts on Monday 26 October.
    expect(grid[0]).toEqual({ date: "2026-10-26", inMonth: false });
    expect(grid[6]).toEqual({ date: "2026-11-01", inMonth: true });
    expect(grid.filter((cell) => cell.inMonth)).toHaveLength(30);
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
  });

  it("reads and writes WIB whatever the browser zone", () => {
    expect(wibInstant("2026-11-10", "09:00")).toBe("2026-11-10T02:00:00.000Z");
    expect(jakartaDate("2026-11-09T17:30:00.000Z")).toBe("2026-11-10");
    expect(jakartaTime("2026-11-10T02:00:00.000Z")).toBe("09:00");
    expect(formatMeetingRange("2026-11-10T02:00:00.000Z", "2026-11-10T03:00:00.000Z")).toMatch(/10 November 2026, 09:00–10:00 WIB$/);
  });

  it("places multi-day items on every day and a meeting ending at midnight on one day", () => {
    const leave: CalendarItem = { kind: "leave", id: "l", status: "approved", startOn: "2026-11-10", endOn: "2026-11-12" };
    const lateMeeting: CalendarItem = {
      kind: "meeting", id: "m", title: "Malam", location: null, organizerName: "A", status: "ACTIVE", confidential: false,
      involvesMe: true, myRole: "ORGANIZER", myResponse: "ACCEPTED",
      startAt: wibInstant("2026-11-10", "22:00"), endAt: wibInstant("2026-11-11", "00:00"),
    };
    expect(itemDates(leave)).toEqual(["2026-11-10", "2026-11-11", "2026-11-12"]);
    expect(itemDates(lateMeeting)).toEqual(["2026-11-10"]);
    const busy: CalendarItem = { kind: "busy", id: null, involvesMe: false, startAt: wibInstant("2026-11-10", "08:00"), endAt: wibInstant("2026-11-10", "09:00") };
    const holiday: CalendarItem = { kind: "non_working", date: "2026-11-10", label: "Hari Guru" };
    const byDate = itemsByDate([lateMeeting, busy, leave, holiday]);
    expect(byDate.get("2026-11-10")!.map((item) => item.kind)).toEqual(["non_working", "leave", "busy", "meeting"]);
    expect(calendarItemLabel(busy)).toBe("08:00 Sibuk");
    expect(calendarItemLabel(holiday)).toBe("Hari Guru");
  });

  it("LEAVE-009: spreads a long critical period over the visible month and labels it", () => {
    const period: CalendarItem = {
      kind: "critical_period", id: "c", label: "PPDB", startOn: "2026-01-05", endOn: "2026-04-30", unitName: null,
    };
    const dates = itemDates(period);
    expect(dates[0]).toBe("2026-01-05");
    expect(dates.at(-1)).toBe("2026-04-30");
    expect(calendarItemLabel(period)).toBe("Masa kritis: PPDB");
    const holiday: CalendarItem = { kind: "non_working", date: "2026-04-01", label: "Libur" };
    expect(itemsByDate([period, holiday]).get("2026-04-01")!.map((item) => item.kind)).toEqual(["non_working", "critical_period"]);
  });
});
