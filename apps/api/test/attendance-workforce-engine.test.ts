import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  applyBoundaryCorrections,
  buildSessions,
  evaluateSessions,
  haversineDistanceMeters,
  resolveSchedule,
  type ResolvedSchedule,
} from "../src/modules/attendance/engine.js";

function scheduled(overrides: Partial<ResolvedSchedule> = {}): ResolvedSchedule {
  return {
    state: "scheduled",
    scheduleTemplateId: "00000000-0000-4000-8000-000000000001",
    scheduleVersionId: "00000000-0000-4000-8000-000000000101",
    rosterId: null,
    scheduledStartAt: new Date("2026-09-19T01:00:00.000Z"),
    scheduledEndAt: new Date("2026-09-19T09:00:00.000Z"),
    lateGraceMinutes: 10,
    earlyLeaveToleranceMinutes: 0,
    workLocation: null,
    ...overrides,
  };
}

describe("ATT-003 schedule resolution", () => {
  it("keeps overnight shift work date on the start date", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM attendance_rosters")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM leave_calendar_exceptions")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM attendance_schedule_assignments")) {
        return {
          rows: [{
            scheduleTemplateId: "00000000-0000-4000-8000-000000000001",
            scheduleVersionId: "00000000-0000-4000-8000-000000000101",
            rosterId: null,
            isOff: false,
            startTime: "22:00:00",
            endTime: "06:00:00",
            endDayOffset: 1,
            lateGraceMinutes: 5,
            earlyLeaveToleranceMinutes: 0,
            workLocationId: null,
            locationName: null,
            latitude: null,
            longitude: null,
            radiusMeters: null,
          }],
          rowCount: 1,
        };
      }
      throw new Error("Unexpected SQL");
    });
    const resolved = await resolveSchedule({ query } as unknown as Pool, "employee", "2026-09-19");
    expect(resolved.scheduledStartAt?.toISOString()).toBe("2026-09-19T15:00:00.000Z");
    expect(resolved.scheduledEndAt?.toISOString()).toBe("2026-09-19T23:00:00.000Z");
  });

  it("uses only the latest published roster version for the week", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("WITH latest_roster")) {
        return {
          rows: [{
            scheduleTemplateId: "00000000-0000-4000-8000-000000000009",
            scheduleVersionId: "00000000-0000-4000-8000-000000000109",
            rosterId: "00000000-0000-4000-8000-000000000010",
            isOff: false,
            startTime: "09:00:00",
            endTime: "17:00:00",
            endDayOffset: 0,
            lateGraceMinutes: 0,
            earlyLeaveToleranceMinutes: 0,
            workLocationId: null,
            locationName: null,
            latitude: null,
            longitude: null,
            radiusMeters: null,
          }],
          rowCount: 1,
        };
      }
      throw new Error("Resolver should stop after the latest published roster override");
    });
    const resolved = await resolveSchedule({ query } as unknown as Pool, "employee", "2026-09-19");
    expect(resolved.rosterId).toBe("00000000-0000-4000-8000-000000000010");
    expect(resolved.scheduledStartAt?.toISOString()).toBe("2026-09-19T02:00:00.000Z");
  });

  it("falls back to default assignment when latest published roster has no override cell", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("WITH latest_roster")) {
        return {
          rows: [{
            scheduleTemplateId: null,
            scheduleVersionId: null,
            rosterId: "00000000-0000-4000-8000-000000000010",
            isOff: false,
            startTime: null,
            endTime: null,
            lateGraceMinutes: null,
            earlyLeaveToleranceMinutes: null,
            workLocationId: null,
            locationName: null,
            latitude: null,
            longitude: null,
            radiusMeters: null,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM leave_calendar_exceptions")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM attendance_schedule_assignments")) {
        return {
          rows: [{
            scheduleTemplateId: "default",
            scheduleVersionId: "default-version",
            rosterId: null,
            isOff: false,
            startTime: "08:00:00",
            endTime: "16:00:00",
            endDayOffset: 0,
            lateGraceMinutes: 0,
            earlyLeaveToleranceMinutes: 0,
            workLocationId: null,
            locationName: null,
            latitude: null,
            longitude: null,
            radiusMeters: null,
          }],
          rowCount: 1,
        };
      }
      throw new Error("Unexpected SQL");
    });
    const resolved = await resolveSchedule({ query } as unknown as Pool, "employee", "2026-09-19");
    expect(resolved.scheduleTemplateId).toBe("default");
    expect(resolved.rosterId).toBeNull();
  });

  it("treats a non-working calendar exception as off when no roster overrides it", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM attendance_rosters")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM leave_calendar_exceptions")) return { rows: [{ isWorkingDay: false }], rowCount: 1 };
      throw new Error("Default assignment should not be read on a holiday");
    });
    const resolved = await resolveSchedule({ query } as unknown as Pool, "employee", "2026-09-19");
    expect(resolved.state).toBe("off");
    expect(resolved.reason).toBe("calendar_holiday");
  });

  it("fails closed when default assignments are ambiguous", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM attendance_rosters")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM leave_calendar_exceptions")) return { rows: [], rowCount: 0 };
      return {
        rows: [
          { scheduleTemplateId: "a", isOff: false, startTime: "08:00:00", endTime: "16:00:00" },
          { scheduleTemplateId: "b", isOff: false, startTime: "09:00:00", endTime: "17:00:00" },
        ],
        rowCount: 2,
      };
    });
    const resolved = await resolveSchedule({ query } as unknown as Pool, "employee", "2026-09-19");
    expect(resolved.state).toBe("configuration_error");
    expect(resolved.reason).toBe("ambiguous_default_assignment");
  });
});

describe("ATT-007 attendance evaluation", () => {
  it("builds multiple work sessions from raw punches", () => {
    const sessions = buildSessions([
      { id: "1", eventKind: "punch", occurredAt: new Date("2026-09-19T01:00:00Z") },
      { id: "2", eventKind: "punch", occurredAt: new Date("2026-09-19T05:00:00Z") },
      { id: "3", eventKind: "punch", occurredAt: new Date("2026-09-19T06:00:00Z") },
      { id: "4", eventKind: "punch", occurredAt: new Date("2026-09-19T10:00:00Z") },
    ]);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.checkOutAt?.toISOString()).toBe("2026-09-19T05:00:00.000Z");
    expect(sessions[1]?.checkInAt.toISOString()).toBe("2026-09-19T06:00:00.000Z");
  });

  it("applies correction boundaries without creating synthetic extra sessions", () => {
    const base = buildSessions([
      { id: "a", eventKind: "punch", occurredAt: new Date("2026-09-19T01:00:00Z") },
      { id: "b", eventKind: "punch", occurredAt: new Date("2026-09-19T05:00:00Z") },
      { id: "c", eventKind: "punch", occurredAt: new Date("2026-09-19T06:00:00Z") },
      { id: "d", eventKind: "punch", occurredAt: new Date("2026-09-19T10:00:00Z") },
    ]);
    const corrected = applyBoundaryCorrections(base, [{
      proposedCheckInAt: new Date("2026-09-19T00:55:00Z"),
      proposedCheckOutAt: new Date("2026-09-19T10:05:00Z"),
    }]);

    expect(corrected).toHaveLength(2);
    expect(corrected[0]?.checkInAt.toISOString()).toBe("2026-09-19T00:55:00.000Z");
    expect(corrected[0]?.checkOutAt?.toISOString()).toBe("2026-09-19T05:00:00.000Z");
    expect(corrected[1]?.checkInAt.toISOString()).toBe("2026-09-19T06:00:00.000Z");
    expect(corrected[1]?.checkOutAt?.toISOString()).toBe("2026-09-19T10:05:00.000Z");
  });

  it("calculates worked time and breaks from complete sessions", () => {
    const result = evaluateSessions({
      schedule: scheduled({ scheduledEndAt: new Date("2026-09-19T10:00:00Z") }),
      sessions: [
        { checkInAt: new Date("2026-09-19T01:00:00Z"), checkOutAt: new Date("2026-09-19T05:00:00Z") },
        { checkInAt: new Date("2026-09-19T06:00:00Z"), checkOutAt: new Date("2026-09-19T10:00:00Z") },
      ],
      attendanceDisposition: null,
      lateJustified: false,
      earlyLeaveJustified: false,
      outsideGeofenceJustified: false,
      overtimeMinutes: 0,
      now: new Date("2026-09-19T11:00:00Z"),
    });
    expect(result.workedMinutes).toBe(480);
    expect(result.breakMinutes).toBe(60);
    expect(result.status).toBe("present");
  });

  it("keeps lateness factual even when justification is approved", () => {
    const result = evaluateSessions({
      schedule: scheduled(),
      sessions: [{
        checkInAt: new Date("2026-09-19T01:20:00Z"),
        checkOutAt: new Date("2026-09-19T09:00:00Z"),
      }],
      attendanceDisposition: null,
      lateJustified: true,
      earlyLeaveJustified: false,
      outsideGeofenceJustified: false,
      overtimeMinutes: 0,
      now: new Date("2026-09-19T10:00:00Z"),
    });
    expect(result.status).toBe("late");
    expect(result.lateMinutes).toBe(10);
    expect(result.justified).toBe(true);
    expect(result.lateJustified).toBe(true);
    expect(result.earlyLeaveJustified).toBe(false);
  });

  it("does not let lateness justification excuse early leave", () => {
    const result = evaluateSessions({
      schedule: scheduled(),
      sessions: [{
        checkInAt: new Date("2026-09-19T01:20:00Z"),
        checkOutAt: new Date("2026-09-19T08:00:00Z"),
      }],
      attendanceDisposition: null,
      lateJustified: true,
      earlyLeaveJustified: false,
      outsideGeofenceJustified: false,
      overtimeMinutes: 0,
      now: new Date("2026-09-19T10:00:00Z"),
    });
    expect(result.lateJustified).toBe(true);
    expect(result.earlyLeaveJustified).toBe(false);
    expect(result.earlyLeaveMinutes).toBe(60);
  });

  it("carries only explicitly approved overtime minutes", () => {
    const result = evaluateSessions({
      schedule: scheduled(),
      sessions: [{
        checkInAt: new Date("2026-09-19T01:00:00Z"),
        checkOutAt: new Date("2026-09-19T10:00:00Z"),
      }],
      attendanceDisposition: null,
      lateJustified: false,
      earlyLeaveJustified: false,
      outsideGeofenceJustified: false,
      overtimeMinutes: 45,
      now: new Date("2026-09-19T11:00:00Z"),
    });
    expect(result.overtimeMinutes).toBe(45);
  });

  it("approved leave prevents a false absence", () => {
    const result = evaluateSessions({
      schedule: scheduled(),
      sessions: [],
      attendanceDisposition: "leave",
      lateJustified: false,
      earlyLeaveJustified: false,
      outsideGeofenceJustified: false,
      overtimeMinutes: 0,
      now: new Date("2026-09-19T12:00:00Z"),
    });
    expect(result.status).toBe("leave");
  });
});

describe("ATT-006 geofence distance", () => {
  it("returns zero for identical coordinates and a positive distance otherwise", () => {
    expect(haversineDistanceMeters({ latitude: -6.7, longitude: 108.55 }, { latitude: -6.7, longitude: 108.55 })).toBe(0);
    expect(haversineDistanceMeters({ latitude: -6.7, longitude: 108.55 }, { latitude: -6.701, longitude: 108.55 })).toBeGreaterThan(100);
  });
});
