import { describe, expect, it } from "vitest";

import { normalActual } from "../src/modules/attendance/calculation-rows.js";
import {
  applyBusinessTrip,
  applyBusinessTripToBlock,
  evaluateBlocks,
  evaluateSessions,
  type ResolvedSchedule,
} from "../src/modules/attendance/engine.js";
import { daySymbol, SYMBOL_LEGEND } from "../src/modules/attendance/report-models.js";
import { tripDatesToRecompute } from "../src/modules/trips/domain.js";

// TRIP-001 Paket 2 (docs/domain/business-travel.md §9.2): an issued business trip as an attendance
// disposition. Synthetic times, Asia/Jakarta.

const at = (time: string) => new Date(`2026-11-02T${time}:00+07:00`);

const schedule: ResolvedSchedule = {
  state: "scheduled",
  scheduleTemplateId: "s",
  scheduleVersionId: "v",
  rosterId: null,
  scheduledStartAt: at("07:00"),
  scheduledEndAt: at("16:00"),
  lateGraceMinutes: 0,
  earlyLeaveToleranceMinutes: 0,
  workLocation: null,
};

const base = {
  schedule,
  attendanceDisposition: null,
  lateJustified: false,
  earlyLeaveJustified: false,
  outsideGeofenceJustified: false,
  overtimeMinutes: 0,
  now: new Date("2026-11-03T08:00:00+07:00"),
};

describe("TRIP-001 Paket 2 engine disposition", () => {
  it("a scheduled day without punches becomes business_trip and no time is invented", () => {
    const result = evaluateSessions({ ...base, sessions: [], businessTrip: true });
    expect(result).toMatchObject({
      status: "business_trip", firstCheckInAt: null, lastCheckOutAt: null, workedMinutes: 0,
      lateMinutes: 0, earlyLeaveMinutes: 0, justified: true,
    });
    expect(result.sessions).toEqual([]);
    // Without the trip the same day is absent.
    expect(evaluateSessions({ ...base, sessions: [] }).status).toBe("absent");
  });

  it("decides the day as soon as it is covered, even before the shift ends", () => {
    const morning = { ...base, now: at("06:00") };
    expect(evaluateSessions({ ...morning, sessions: [], businessTrip: true }).status).toBe("business_trip");
  });

  it("punches stand: a late, early day reads present with lateness and early leave not counted", () => {
    const sessions = [{ checkInAt: at("10:00"), checkOutAt: at("15:00") }];
    const result = evaluateSessions({ ...base, sessions, businessTrip: true });
    expect(result).toMatchObject({
      status: "present",
      firstCheckInAt: at("10:00"),
      lastCheckOutAt: at("15:00"),
      workedMinutes: 300,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      lateJustified: true,
      earlyLeaveJustified: true,
      outsideGeofenceJustified: true,
    });
    expect(result.sessions).toEqual(sessions);
  });

  it("an incomplete punch is replaced by business_trip while the recorded check-in is kept", () => {
    const result = evaluateSessions({ ...base, sessions: [{ checkInAt: at("07:30"), checkOutAt: null }], businessTrip: true });
    expect(result).toMatchObject({ status: "business_trip", firstCheckInAt: at("07:30"), lastCheckOutAt: null, incompleteSession: true });
  });

  it("approved leave, absence decisions, rest days and broken schedules are decided before the trip", () => {
    expect(evaluateSessions({ ...base, sessions: [], attendanceDisposition: "leave", businessTrip: true }).status).toBe("leave");
    expect(evaluateSessions({ ...base, sessions: [], attendanceDisposition: "absent", businessTrip: true }).status).toBe("absent");
    expect(evaluateSessions({ ...base, schedule: { ...schedule, state: "off" }, sessions: [], businessTrip: true }).status).toBe("off");
    expect(evaluateSessions({ ...base, schedule: { ...schedule, state: "configuration_error" }, sessions: [], businessTrip: true }).status)
      .toBe("configuration_error");
  });

  it("the trip outranks an arrangement on the same day", () => {
    expect(evaluateSessions({ ...base, sessions: [], businessTrip: true, workArrangement: "field_assignment" }).status).toBe("business_trip");
  });

  it("only absent and incomplete are replaced; open and present days keep their status", () => {
    const shell = evaluateSessions({ ...base, sessions: [] });
    for (const status of ["scheduled", "pending", "present"] as const) {
      expect(applyBusinessTrip({ ...shell, status }).status).toBe(status);
    }
    expect(applyBusinessTrip({ ...shell, status: "absent" }).status).toBe("business_trip");
    expect(applyBusinessTrip({ ...shell, status: "incomplete" }).status).toBe("business_trip");
    expect(applyBusinessTrip({ ...shell, status: "late", lateMinutes: 30 })).toMatchObject({ status: "present", lateMinutes: 0 });
  });
});

describe("TRIP-001 Paket 2 on a multi-block day (ATT-013)", () => {
  const blockAt = (time: string) => new Date(`2026-10-20T${time}:00+07:00`);
  const blocks = [
    { sequence: 1, startAt: blockAt("04:00"), endAt: blockAt("08:30"), weight: 0.5 },
    { sequence: 2, startAt: blockAt("14:30"), endAt: blockAt("19:30"), weight: 0.5 },
  ];
  const multi: ResolvedSchedule = {
    ...schedule, scheduledStartAt: blocks[0]!.startAt, scheduledEndAt: blocks[1]!.endAt, lateGraceMinutes: 1, blocks,
  };
  const punch = (id: string, time: string) => ({ id, eventKind: "punch" as const, occurredAt: blockAt(time) });

  it("one block attended late and the other missed: the day is business_trip, the late block counts no lateness", () => {
    const evaluated = evaluateBlocks({
      schedule: multi,
      events: [punch("a", "04:30"), punch("b", "08:31")],
      corrections: [],
      lateJustified: true,
      earlyLeaveJustified: true,
      outsideGeofenceJustified: true,
      overtimeMinutes: 0,
      now: blockAt("23:00"),
    });
    expect(evaluated.computation.status).toBe("incomplete");
    const day = applyBusinessTrip(evaluated.computation);
    expect(day).toMatchObject({ status: "business_trip", lateMinutes: 0, earlyLeaveMinutes: 0 });
    const parts = evaluated.blocks.map(applyBusinessTripToBlock);
    expect(parts.map((part) => [part.status, part.lateMinutes])).toEqual([["present", 0], ["absent", 0]]);
    // The punches are kept as recorded.
    expect(parts[0]!.firstCheckInAt).toEqual(blockAt("04:30"));
  });
});

describe("TRIP-001 Paket 2 reporting and recalculation", () => {
  it("Rekap symbol PD labelled Dinas, and Normal 1 / Riil 1", () => {
    expect(daySymbol({ status: "business_trip", earlyLeaveMinutes: 0 })).toBe("PD");
    expect(SYMBOL_LEGEND).toContainEqual({ symbol: "PD", label: "Dinas" });
    expect(normalActual("business_trip")).toEqual({ normal: 1, actual: 1 });
  });

  it("recalculates only the dates already begun", () => {
    expect(tripDatesToRecompute("2026-11-01", "2026-11-05", "2026-11-03")).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
    expect(tripDatesToRecompute("2026-11-04", "2026-11-05", "2026-11-03")).toEqual([]);
    expect(tripDatesToRecompute("2026-10-30", "2026-11-01", "2026-11-03")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01"]);
  });
});
