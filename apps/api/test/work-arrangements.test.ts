import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import { normalActual } from "../src/modules/attendance/calculation-rows.js";
import { evaluateSessions, type ResolvedSchedule } from "../src/modules/attendance/engine.js";
import { daySymbol } from "../src/modules/attendance/report-models.js";
import { registerWorkArrangementRoutes } from "../src/modules/attendance/work-arrangement-routes.js";
import {
  canCancelArrangement,
  datesToRecompute,
  dispositionStatus,
  validateArrangementDates,
} from "../src/modules/attendance/work-arrangements.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";

const TODAY = "2026-11-03";

function code(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return null;
}

describe("ATT-015 date rules", () => {
  it("D-02/D-09: WFH/WFA and a schedule change are one day each", () => {
    expect(code(() => validateArrangementDates({ type: "REMOTE_WORK", startOn: TODAY, endOn: "2026-11-04", today: TODAY })))
      .toBe("ARRANGEMENT_SINGLE_DAY");
    expect(code(() => validateArrangementDates({ type: "SCHEDULE_CHANGE", startOn: "2026-11-04", endOn: "2026-11-05", today: TODAY })))
      .toBe("ARRANGEMENT_SINGLE_DAY");
    expect(validateArrangementDates({ type: "REMOTE_WORK", startOn: TODAY, endOn: TODAY, today: TODAY }).days).toBe(1);
  });

  it("D-04: tugas luar lasts at most 7 days, counted inclusively", () => {
    expect(validateArrangementDates({ type: "FIELD_ASSIGNMENT", startOn: "2026-11-04", endOn: "2026-11-10", today: TODAY }).days).toBe(7);
    expect(code(() => validateArrangementDates({ type: "FIELD_ASSIGNMENT", startOn: "2026-11-04", endOn: "2026-11-11", today: TODAY })))
      .toBe("ARRANGEMENT_TOO_LONG");
  });

  it("D-05: tugas luar up to 7 days back, WFH from today, a schedule change from tomorrow, all within 60 days", () => {
    expect(validateArrangementDates({ type: "FIELD_ASSIGNMENT", startOn: "2026-10-27", endOn: "2026-10-27", today: TODAY }).days).toBe(1);
    expect(code(() => validateArrangementDates({ type: "FIELD_ASSIGNMENT", startOn: "2026-10-26", endOn: "2026-10-26", today: TODAY })))
      .toBe("ARRANGEMENT_DATE_TOO_EARLY");
    expect(code(() => validateArrangementDates({ type: "REMOTE_WORK", startOn: "2026-11-02", endOn: "2026-11-02", today: TODAY })))
      .toBe("ARRANGEMENT_DATE_TOO_EARLY");
    expect(code(() => validateArrangementDates({ type: "SCHEDULE_CHANGE", startOn: TODAY, endOn: TODAY, today: TODAY })))
      .toBe("ARRANGEMENT_DATE_TOO_EARLY");
    expect(code(() => validateArrangementDates({ type: "REMOTE_WORK", startOn: "2027-01-03", endOn: "2027-01-03", today: TODAY })))
      .toBe("ARRANGEMENT_DATE_TOO_LATE");
    expect(code(() => validateArrangementDates({ type: "FIELD_ASSIGNMENT", startOn: "2026-02-30", endOn: "2026-03-01", today: TODAY })))
      .toBe("ARRANGEMENT_DATE_RANGE");
  });

  it("D-10: the employee cancels an approved request only before it starts; HC at any time", () => {
    expect(canCancelArrangement("IN_REVIEW", "2026-11-01", TODAY, "employee")).toBe(true);
    expect(canCancelArrangement("APPROVED", "2026-11-04", TODAY, "employee")).toBe(true);
    expect(canCancelArrangement("APPROVED", TODAY, TODAY, "employee")).toBe(false);
    expect(canCancelArrangement("APPROVED", "2026-11-01", TODAY, "hc")).toBe(true);
    for (const terminal of ["REJECTED", "CANCELLED", "APPLIED"] as const) {
      expect(canCancelArrangement(terminal, "2026-11-10", TODAY, "hc")).toBe(false);
    }
  });

  it("§7.3: only past dates and today are recalculated now", () => {
    expect(datesToRecompute("2026-11-01", "2026-11-05", TODAY)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
    expect(datesToRecompute("2026-11-04", "2026-11-05", TODAY)).toEqual([]);
    expect(dispositionStatus("SCHEDULE_CHANGE")).toBeNull();
  });
});

describe("ATT-015 engine disposition (D-06)", () => {
  const schedule: ResolvedSchedule = {
    state: "scheduled",
    scheduleTemplateId: "s",
    scheduleVersionId: "v",
    rosterId: null,
    scheduledStartAt: new Date("2026-11-02T07:00:00+07:00"),
    scheduledEndAt: new Date("2026-11-02T16:00:00+07:00"),
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

  it("ATT-015-F: a day without punches takes the arrangement status and no time is invented", () => {
    const result = evaluateSessions({ ...base, sessions: [], workArrangement: "field_assignment" });
    expect(result).toMatchObject({ status: "field_assignment", firstCheckInAt: null, lastCheckOutAt: null, workedMinutes: 0, justified: true });
    expect(result.sessions).toEqual([]);
    expect(evaluateSessions({ ...base, sessions: [], workArrangement: "remote_work" }).status).toBe("remote_work");
    expect(evaluateSessions({ ...base, sessions: [] }).status).toBe("absent");
  });

  it("ATT-015-G: punches stand and lateness is justified, not removed", () => {
    const sessions = [{ checkInAt: new Date("2026-11-02T10:00:00+07:00"), checkOutAt: new Date("2026-11-02T15:00:00+07:00") }];
    const result = evaluateSessions({ ...base, sessions, workArrangement: "field_assignment" });
    expect(result).toMatchObject({ status: "late", lateMinutes: 180, earlyLeaveMinutes: 60, lateJustified: true, earlyLeaveJustified: true });
    const incomplete = evaluateSessions({ ...base, sessions: [{ checkInAt: sessions[0]!.checkInAt, checkOutAt: null }], workArrangement: "remote_work" });
    expect(incomplete.status).toBe("incomplete");
  });

  it("ATT-015-H: leave and rest days are decided before the arrangement", () => {
    expect(evaluateSessions({ ...base, sessions: [], attendanceDisposition: "leave", workArrangement: "field_assignment" }).status).toBe("leave");
    expect(evaluateSessions({ ...base, schedule: { ...schedule, state: "off" }, sessions: [], workArrangement: "field_assignment" }).status).toBe("off");
  });

  it("§7.2: Rekap symbols DL and W, and Riil 1", () => {
    expect(daySymbol({ status: "field_assignment", earlyLeaveMinutes: 0 })).toBe("DL");
    expect(daySymbol({ status: "remote_work", earlyLeaveMinutes: 0 })).toBe("W");
    expect(normalActual("field_assignment")).toEqual({ normal: 1, actual: 1 });
    expect(normalActual("remote_work")).toEqual({ normal: 1, actual: 1 });
  });
});

describe("ATT-015 route guards", () => {
  async function appFor(principal: AuthPrincipal | null, permissions: string[] = []) {
    const app = Fastify({ logger: false });
    // Guards answer before any query, so an inert pool proves no data is read.
    await registerWorkArrangementRoutes(app, {} as Pool, { NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32) } as ApiConfig, {
      getSession: async () => (principal ? { principal, expiresAt: "2099-01-01T00:00:00Z" } : null),
      getAuthorizationContext: async () => ({ organizationPermissions: permissions }),
    } as never);
    return app;
  }

  it("answers 401 without a session and 403 to a non-employee on self routes", async () => {
    const anonymous = await appFor(null);
    expect((await anonymous.inject({ method: "GET", url: "/attendance/arrangements/me" })).statusCode).toBe(401);
    const board = await appFor({ id: "b", email: "b@example.invalid", principalType: "FOUNDATION_BOARD" });
    expect((await board.inject({ method: "GET", url: "/attendance/arrangements/approvals" })).statusCode).toBe(403);
    const legacy = await appFor({ id: "s", email: "s@example.invalid", principalType: "SUPER_ADMIN" });
    expect((await legacy.inject({ method: "POST", url: "/attendance/arrangements/me", payload: {} })).statusCode).toBe(403);
  });

  it("ATT-015-K: admin routes need attendance.arrangements.* before validating anything", async () => {
    const employee = { id: "e", email: "e@example.invalid", principalType: "EMPLOYEE" as const };
    const none = await appFor(employee, ["trips.manage", "attendance.schedule.manage"]);
    expect((await none.inject({ method: "GET", url: "/admin/attendance/arrangements" })).statusCode).toBe(403);
    expect((await none.inject({ method: "POST", url: "/admin/attendance/arrangements/not-a-uuid/apply", payload: {} })).statusCode).toBe(403);
    const reader = await appFor(employee, ["attendance.arrangements.read"]);
    expect((await reader.inject({ method: "POST", url: "/admin/attendance/arrangements/not-a-uuid/cancel", payload: {} })).statusCode).toBe(403);
    expect((await reader.inject({ method: "POST", url: "/admin/attendance/arrangements/not-a-uuid/apply", payload: {} })).statusCode).toBe(403);
    expect((await reader.inject({ method: "GET", url: "/admin/attendance/arrangements/not-a-uuid" })).statusCode).toBe(400);
    const manager = await appFor(employee, ["attendance.arrangements.manage"]);
    expect((await manager.inject({ method: "POST", url: "/admin/attendance/arrangements/not-a-uuid/apply", payload: {} })).statusCode).toBe(400);
  });
});
