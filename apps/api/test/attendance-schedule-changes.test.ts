import Fastify from "fastify";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AdminPermission } from "../src/modules/auth/permissions.js";
import { changeRange, maskOf, mondayOf } from "../src/modules/attendance/schedule-changes.js";

// ATT-011-4b Perubahan Jadwal: permissions (D-1), validation and the date helpers. The planner itself
// runs against PostgreSQL in attendance-schedule-changes.postgres.test.ts. Synthetic identifiers only.

const granted = { permissions: [] as AdminPermission[] };

vi.mock("../src/modules/auth/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/auth/service.js")>();
  class FakeAuthService {
    async getSession(token: string | null) {
      if (!token) return null;
      return {
        principal: { id: "00000000-0000-4000-8000-000000027001", email: "hc-planner@example.invalid", principalType: "SUPER_ADMIN" },
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      };
    }
    async getAuthorizationContext() {
      return { organizationPermissions: [...granted.permissions] };
    }
  }
  return { ...actual, AuthService: FakeAuthService };
});

const { registerAttendanceWorkforceRoutes } = await import("../src/modules/attendance/workforce-routes.js");

const config = {
  NODE_ENV: "test", HOST: "127.0.0.1", PORT: 3001, DATABASE_URL: "postgres://schedule-change-test",
  AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8,
} as ApiConfig;

const EMPLOYEE = "00000000-0000-4000-8000-000000027002";
const SHIFT = "00000000-0000-4000-8000-000000027003";

describe("ATT-011-4b schedule change routes", () => {
  let app: ReturnType<typeof Fastify>;
  const poolQuery = vi.fn(async () => ({ rows: [] }));
  const connect = vi.fn(async () => ({ query: vi.fn(async () => ({ rows: [] })), release: vi.fn() }));

  beforeEach(async () => {
    poolQuery.mockClear();
    connect.mockClear();
    app = Fastify({ logger: false });
    await registerAttendanceWorkforceRoutes(app, { query: poolQuery, connect } as unknown as Pool, config, {
      calculationRunner: { kick: vi.fn(), recoverInterrupted: vi.fn(async () => 0), idle: vi.fn(async () => undefined) },
    });
  });

  afterEach(async () => { await app.close(); });

  const call = (method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers: { cookie: "hcis_session=test-token" }, ...(payload ? { payload } : {}) });
  const pattern = { kind: "pattern", employeeIds: [EMPLOYEE], scheduleTemplateId: SHIFT, from: "2099-01-05", to: null, weekdays: [1, 2, 3, 4, 5], untickedDays: "off" };

  it("lets attendance.reports.read see the calendar and history but not preview or apply (D-1)", async () => {
    granted.permissions = ["attendance.reports.read"];
    expect((await call("GET", "/admin/attendance/schedule-calendar?from=2099-01-05&to=2099-01-11")).statusCode).toBe(200);
    expect((await call("GET", "/admin/attendance/schedule-changes")).statusCode).toBe(200);
    expect((await call("POST", "/admin/attendance/schedule-changes/preview", pattern)).statusCode).toBe(403);
    expect((await call("POST", "/admin/attendance/schedule-changes", { change: pattern, previewFingerprint: "a".repeat(64) })).statusCode).toBe(403);
    expect(connect).not.toHaveBeenCalled();

    granted.permissions = [];
    expect((await call("GET", "/admin/attendance/schedule-calendar?from=2099-01-05&to=2099-01-11")).statusCode).toBe(403);
  });

  it("refuses incomplete or inconsistent changes before reading anything", async () => {
    granted.permissions = ["attendance.schedule.manage"];
    const refused = [
      { ...pattern, employeeIds: [] },
      { ...pattern, to: "2099-01-01" },
      { ...pattern, scheduleTemplateId: null, untickedDays: "keep" },
      { kind: "replacement", employeeIds: [EMPLOYEE], scheduleTemplateId: SHIFT, from: "2099-01-05", to: "2099-01-05" },
      { kind: "copy", employeeIds: [EMPLOYEE], sourceWeekStart: "2099-01-05", targetWeekStarts: ["2099-01-05"] },
      { kind: "copy", employeeIds: [EMPLOYEE], sourceWeekStart: "2099-01-06", targetWeekStarts: ["2099-01-12"] },
      { ...pattern, from: "2099-02-30" },
    ];
    for (const change of refused) {
      const response = await call("POST", "/admin/attendance/schedule-changes/preview", change);
      expect(response.statusCode, JSON.stringify(change)).toBe(400);
    }
    expect((await call("GET", "/admin/attendance/schedule-calendar?from=2099-01-05&to=2099-03-01")).json().code).toBe("INVALID_SCHEDULE_CALENDAR_RANGE");
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it("works out weekday masks, Mondays and the dates a change touches", () => {
    expect(maskOf([1, 2, 3, 4, 5])).toBe(31);
    expect(maskOf([6, 7])).toBe(96);
    expect(mondayOf("2026-11-01")).toBe("2026-10-26");
    expect(changeRange({ kind: "copy", sourceWeekStart: "2026-11-02", targetWeekStarts: ["2026-11-23", "2026-11-09"] }))
      .toEqual({ from: "2026-11-09", to: "2026-11-29", openEnded: false });
    expect(changeRange({ kind: "pattern", scheduleTemplateId: SHIFT, from: "2026-11-02", to: null, weekdays: [1], untickedDays: "off" }))
      .toMatchObject({ from: "2026-11-02", openEnded: true });
  });
});
