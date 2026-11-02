import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import {
  computeCompletion,
  decodeCertificate,
  evaluateAvailability,
  jakartaDateRangeInterval,
  validateExternalRecord,
  validateSessionTimes,
  type BusySpan,
} from "../src/modules/training/domain.js";
import { registerTrainingRoutes } from "../src/modules/training/routes.js";

const at = (iso: string) => Date.parse(iso);

describe("TRAIN-001 domain rules", () => {
  it("accepts sessions of 15 minutes to 12 hours (D-17)", () => {
    expect(validateSessionTimes("2026-11-10T08:00:00+07:00", "2026-11-10T08:15:00+07:00").endMs).toBe(at("2026-11-10T01:15:00Z"));
    expect(() => validateSessionTimes("2026-11-10T08:00:00+07:00", "2026-11-10T08:14:00+07:00"))
      .toThrow(expect.objectContaining({ code: "INVALID_TRAINING_SESSION" }));
    expect(() => validateSessionTimes("2026-11-10T08:00:00+07:00", "2026-11-10T20:01:00+07:00")).toThrow();
    expect(() => validateSessionTimes("2026-11-10T08:00:00+07:00", "2026-11-10T07:00:00+07:00")).toThrow();
  });

  it("TRAIN-001-C: blocks overlaps, never touching intervals, and never a session against itself", () => {
    const session = { id: "s1", title: "Tahsin", startMs: at("2026-11-10T02:00:00Z"), endMs: at("2026-11-10T04:00:00Z") };
    const people = [{ employeeId: "a", name: "Aisyah" }, { employeeId: "b", name: "Bilal" }];
    const busy: BusySpan[] = [
      { employeeId: "a", reason: "MEETING_OVERLAP", title: "Rapat", startMs: at("2026-11-10T03:00:00Z"), endMs: at("2026-11-10T05:00:00Z") },
      // Touching the end: not a conflict.
      { employeeId: "b", reason: "IN_TRAINING", title: "Lain", startMs: at("2026-11-10T04:00:00Z"), endMs: at("2026-11-10T05:00:00Z") },
      // The session's own busy row.
      { employeeId: "b", reason: "IN_TRAINING", title: "Tahsin", sessionId: "s1", startMs: session.startMs, endMs: session.endMs },
      { employeeId: "b", reason: "LEAVE_PENDING", title: null, ...jakartaDateRangeInterval("2026-11-10", "2026-11-10") },
      { employeeId: "z", reason: "ON_TRIP", title: null, ...jakartaDateRangeInterval("2026-11-10", "2026-11-10") },
    ];
    const result = evaluateAvailability({ sessions: [session], people, busy, nowMs: at("2026-11-01T00:00:00Z") });
    expect(result.blocks.map((item) => [item.employeeId, item.reason])).toEqual([["a", "MEETING_OVERLAP"]]);
    expect(result.warnings.map((item) => [item.employeeId, item.reason])).toEqual([["b", "LEAVE_PENDING"]]);
  });

  it("turns blocks into warnings for a session that already ended (D-04)", () => {
    const session = { id: null, title: "Susulan", startMs: at("2026-10-01T02:00:00Z"), endMs: at("2026-10-01T04:00:00Z") };
    const result = evaluateAvailability({
      sessions: [session],
      people: [{ employeeId: "a", name: "Aisyah" }],
      busy: [{ employeeId: "a", reason: "ON_LEAVE", title: null, ...jakartaDateRangeInterval("2026-10-01", "2026-10-01") }],
      nowMs: at("2026-11-01T00:00:00Z"),
    });
    expect(result.blocks).toEqual([]);
    expect(result.warnings.map((item) => item.reason)).toEqual(["ON_LEAVE"]);
  });

  it("maps a WIB date to [00:00 WIB, next day 00:00 WIB)", () => {
    expect(jakartaDateRangeInterval("2026-11-10", "2026-11-11")).toEqual({
      startMs: at("2026-11-09T17:00:00Z"), endMs: at("2026-11-11T17:00:00Z"),
    });
  });

  it("D-06/D-07/D-08: attended hours, the threshold and speaker hours", () => {
    const sessions = [
      { id: "s1", startMs: at("2026-11-10T01:00:00Z"), endMs: at("2026-11-10T09:00:00Z"), speakerEmployeeId: "sp" },
      { id: "s2", startMs: at("2026-11-11T01:00:00Z"), endMs: at("2026-11-11T03:00:00Z"), speakerEmployeeId: null },
    ];
    const result = computeCompletion({
      sessions,
      participants: ["full", "eighty", "partial", "none"],
      attendance: [
        { sessionId: "s1", employeeId: "full", status: "PRESENT" },
        { sessionId: "s2", employeeId: "full", status: "PRESENT" },
        { sessionId: "s1", employeeId: "eighty", status: "PRESENT" },
        { sessionId: "s2", employeeId: "eighty", status: "EXCUSED" },
        { sessionId: "s2", employeeId: "partial", status: "PRESENT" },
        { sessionId: "s1", employeeId: "none", status: "ABSENT" },
        // Not a participant: ignored.
        { sessionId: "s1", employeeId: "stranger", status: "PRESENT" },
      ],
      minAttendancePercent: 80,
    });
    expect(result.totalHours).toBe(10);
    expect(result.participants).toEqual([
      { employeeId: "full", attendedHours: 10, attendedAny: true, completed: true },
      { employeeId: "eighty", attendedHours: 8, attendedAny: true, completed: true },
      { employeeId: "partial", attendedHours: 2, attendedAny: true, completed: false },
      { employeeId: "none", attendedHours: 0, attendedAny: false, completed: false },
    ]);
    expect(result.speakers).toEqual([{ employeeId: "sp", hours: 8 }]);
    expect([result.startOn, result.endOn]).toEqual(["2026-11-10", "2026-11-11"]);
  });

  it("D-09: external records end today or earlier with 0.5 to 200 hours in quarters", () => {
    const base = { startOn: "2026-10-01", endOn: "2026-10-02", hours: 12.25, today: "2026-11-02" };
    expect(() => validateExternalRecord(base)).not.toThrow();
    expect(() => validateExternalRecord({ ...base, endOn: "2026-11-03" }))
      .toThrow(expect.objectContaining({ code: "TRAINING_RECORD_FUTURE" }));
    expect(() => validateExternalRecord({ ...base, hours: 0.25 })).toThrow();
    expect(() => validateExternalRecord({ ...base, hours: 1.1 })).toThrow();
    expect(() => validateExternalRecord({ ...base, startOn: "2026-10-03" })).toThrow();
    expect(() => validateExternalRecord({ ...base, startOn: "2025-09-01" })).toThrow();
  });

  it("D-10: checks the file signature and the 2 MB limit", () => {
    const pdf = Buffer.from("%PDF-1.4 sertifikat").toString("base64");
    expect(decodeCertificate("application/pdf", pdf).subarray(0, 5).toString()).toBe("%PDF-");
    expect(() => decodeCertificate("image/png", pdf)).toThrow(expect.objectContaining({ code: "CERTIFICATE_TYPE_MISMATCH" }));
    const big = Buffer.alloc(2_097_153, 0xff).toString("base64");
    expect(() => decodeCertificate("image/jpeg", big)).toThrow(expect.objectContaining({ code: "CERTIFICATE_TOO_LARGE" }));
  });
});

describe("TRAIN-001 route guards", () => {
  async function appFor(principal: AuthPrincipal | null, permissions: string[] = []) {
    const app = Fastify({ logger: false });
    // Guards answer before any query, so an inert pool proves no data is read.
    await registerTrainingRoutes(app, {} as Pool, { NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32) } as ApiConfig, {
      getSession: async () => (principal ? { principal, expiresAt: "2099-01-01T00:00:00Z" } : null),
      getAuthorizationContext: async () => ({ organizationPermissions: permissions }),
    } as never);
    return app;
  }

  it("answers 401 without a session and 403 to a non-employee on self routes", async () => {
    const anonymous = await appFor(null);
    expect((await anonymous.inject({ method: "GET", url: "/training/me/records" })).statusCode).toBe(401);
    expect((await anonymous.inject({ method: "GET", url: "/admin/training/programs" })).statusCode).toBe(401);
    const board = await appFor({ id: "b", email: "b@example.invalid", principalType: "FOUNDATION_BOARD" });
    expect((await board.inject({ method: "GET", url: "/training/me/programs" })).statusCode).toBe(403);
    const legacy = await appFor({ id: "s", email: "s@example.invalid", principalType: "SUPER_ADMIN" }, []);
    expect((await legacy.inject({ method: "POST", url: "/training/me/records", payload: {} })).statusCode).toBe(403);
    expect((await legacy.inject({ method: "GET", url: "/admin/training/hours" })).statusCode).toBe(403);
  });

  it("TRAIN-001-B: reading needs training.read and every write needs training.manage", async () => {
    const employee = { id: "e", email: "e@example.invalid", principalType: "EMPLOYEE" as const };
    const none = await appFor(employee, ["trips.manage", "employees.manage"]);
    for (const url of ["/admin/training/programs", "/admin/training/records", "/admin/training/hours"]) {
      expect((await none.inject({ method: "GET", url })).statusCode).toBe(403);
    }
    const reader = await appFor(employee, ["training.read"]);
    const writes = [
      ["POST", "/admin/training/programs"],
      ["PATCH", "/admin/training/programs/not-a-uuid"],
      ["POST", "/admin/training/programs/not-a-uuid/cancel"],
      ["POST", "/admin/training/programs/not-a-uuid/complete"],
      ["POST", "/admin/training/programs/not-a-uuid/sessions"],
      ["PATCH", "/admin/training/sessions/not-a-uuid"],
      ["POST", "/admin/training/sessions/not-a-uuid/cancel"],
      ["POST", "/admin/training/programs/not-a-uuid/participants"],
      ["POST", "/admin/training/programs/not-a-uuid/participants/not-a-uuid/withdraw"],
      ["PUT", "/admin/training/sessions/not-a-uuid/attendance"],
      ["POST", "/admin/training/availability"],
      ["POST", "/admin/training/records/not-a-uuid/verify"],
      ["POST", "/admin/training/records/not-a-uuid/reject"],
      ["POST", "/admin/training/records/not-a-uuid/certificate"],
      ["GET", "/admin/training/employee-options?q=ab"],
    ] as const;
    for (const [method, url] of writes) {
      expect((await reader.inject({ method, url, payload: {} })).statusCode, `${method} ${url}`).toBe(403);
    }
    expect((await reader.inject({ method: "GET", url: "/admin/training/programs/not-a-uuid" })).statusCode).toBe(400);
    const manager = await appFor(employee, ["training.manage"]);
    expect((await manager.inject({ method: "GET", url: "/admin/training/employee-options?q=a" })).statusCode).toBe(400);
  });
});
