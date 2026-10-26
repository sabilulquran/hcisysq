import Fastify from "fastify";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AdminPermission } from "../src/modules/auth/permissions.js";
import type { ResolvedSchedule } from "../src/modules/attendance/engine.js";
import { classifyToday, type TodayScan } from "../src/modules/attendance/today.js";

// ATT-014-1 Pantauan Hari Ini. Synthetic employees only.

const DAY_START = new Date("2026-10-26T00:00:00+07:00");
const EMPLOYEE = "00000000-0000-4000-8000-000000014001";

function scheduled(start = "2026-10-26T07:00:00+07:00", end = "2026-10-26T16:00:00+07:00"): ResolvedSchedule {
  return {
    state: "scheduled",
    scheduleTemplateId: "00000000-0000-4000-8000-000000014101",
    scheduleVersionId: "00000000-0000-4000-8000-000000014102",
    rosterId: null,
    scheduledStartAt: new Date(start),
    scheduledEndAt: new Date(end),
    lateGraceMinutes: 1,
    earlyLeaveToleranceMinutes: 0,
    workLocation: null,
  };
}

function off(overrides: Partial<ResolvedSchedule> = {}): ResolvedSchedule {
  return { ...scheduled(), state: "off", scheduleTemplateId: null, scheduleVersionId: null, scheduledStartAt: null, scheduledEndAt: null, ...overrides };
}

function scan(at: string, source: TodayScan["source"] = "adms"): TodayScan {
  return { employeeId: EMPLOYEE, occurredAt: new Date(at), source, deviceId: source === "adms" ? "device-1" : null };
}

function classify(input: Partial<Parameters<typeof classifyToday>[0]> = {}) {
  return classifyToday({
    schedule: scheduled(),
    hasScheduleCoverage: true,
    disposition: null,
    connected: true,
    scans: [],
    dayStart: DAY_START,
    now: new Date("2026-10-26T17:00:00+07:00"),
    ...input,
  });
}

describe("ATT-014-1 classifyToday", () => {
  it("reports a scheduled employee who scanned as scanned, with the start delta", () => {
    const result = classify({ scans: [scan("2026-10-26T07:06:00+07:00")] });
    expect(result).toMatchObject({ dayKind: "scheduled", card: "scanned", fact: "checked_in", startDeltaMinutes: 6 });
    expect(result.firstScanAt?.toISOString()).toBe("2026-10-26T00:06:00.000Z");
  });

  it("keeps the first and last scan of the day", () => {
    const result = classify({ scans: [scan("2026-10-26T16:02:00+07:00"), scan("2026-10-26T06:55:00+07:00")] });
    expect(result).toMatchObject({ card: "scanned", fact: "has_scans", startDeltaMinutes: -5 });
    expect(result.lastScanAt?.toISOString()).toBe("2026-10-26T09:02:00.000Z");
  });

  it("never turns a scheduled day without scans into an absence verdict", () => {
    const result = classify({ now: new Date("2026-10-26T20:00:00+07:00") });
    expect(result).toMatchObject({ dayKind: "scheduled", card: "not_scanned", fact: "no_scan" });
    expect(JSON.stringify(result)).not.toMatch(/absent|late|incomplete/);
  });

  it("says before_shift until the shift starts", () => {
    expect(classify({ now: new Date("2026-10-26T06:30:00+07:00") })).toMatchObject({ card: "not_scanned", fact: "before_shift" });
  });

  it("marks an employee without a machine mapping as not connected instead of not scanned", () => {
    expect(classify({ connected: false })).toMatchObject({ card: "not_connected", fact: "not_connected", connected: false });
  });

  it("treats a mobile clock-in as captured even without a machine mapping", () => {
    const result = classify({ connected: false, scans: [scan("2026-10-26T07:00:00+07:00", "mobile")] });
    expect(result).toMatchObject({ card: "scanned", connected: true });
  });

  it("ignores scans outside the shift window and scans in the future", () => {
    const result = classify({
      now: new Date("2026-10-26T08:00:00+07:00"),
      scans: [scan("2026-10-25T16:00:00+07:00"), scan("2026-10-26T07:02:00+07:00"), scan("2026-10-26T09:00:00+07:00")],
    });
    expect(result.scans).toHaveLength(1);
    expect(result.startDeltaMinutes).toBe(2);
  });

  it("follows the work date for a shift that crosses midnight", () => {
    const result = classify({
      schedule: scheduled("2026-10-26T21:00:00+07:00", "2026-10-27T05:00:00+07:00"),
      now: new Date("2026-10-26T21:10:00+07:00"),
      scans: [scan("2026-10-26T20:55:00+07:00"), scan("2026-10-26T10:00:00+07:00")],
    });
    expect(result).toMatchObject({ card: "scanned", fact: "checked_in", startDeltaMinutes: -5 });
  });

  it("separates a rest day from having no schedule at all", () => {
    expect(classify({ schedule: off({ rosterId: "00000000-0000-4000-8000-000000014103" }) })).toMatchObject({ dayKind: "off", card: "off" });
    expect(classify({ schedule: off(), hasScheduleCoverage: true })).toMatchObject({ dayKind: "off", card: "off" });
    expect(classify({ schedule: off(), hasScheduleCoverage: false })).toMatchObject({ dayKind: "unscheduled", card: "unscheduled" });
  });

  it("surfaces scans from employees who have no schedule", () => {
    const result = classify({ schedule: off(), hasScheduleCoverage: false, scans: [scan("2026-10-26T07:30:00+07:00")] });
    expect(result).toMatchObject({ card: "unscheduled_with_scans", fact: "scan_without_schedule", startDeltaMinutes: null });
  });

  it("keeps a scan on a rest day as a fact without changing the day", () => {
    const result = classify({ schedule: off({ reason: "calendar_holiday" }), scans: [scan("2026-10-26T08:00:00+07:00")] });
    expect(result).toMatchObject({ dayKind: "holiday", card: "off", fact: "scan_on_rest_day" });
  });

  it("shows only final leave decisions", () => {
    expect(classify({ disposition: "leave" })).toMatchObject({ dayKind: "leave", card: "leave" });
    expect(classify({ disposition: "absent" })).toMatchObject({ dayKind: "resolved_absent", card: "leave" });
    expect(classify({ disposition: null })).toMatchObject({ dayKind: "scheduled" });
  });

  it("keeps the engine precedence: an off day stays off even with a leave decision", () => {
    expect(classify({ schedule: off(), disposition: "leave" })).toMatchObject({ dayKind: "off" });
    expect(classify({ schedule: { ...off(), state: "configuration_error" } })).toMatchObject({ card: "configuration_error" });
  });
});

// Route: one synthetic account whose permissions are set per test; the pool answers by SQL shape.
const granted = { permissions: [] as AdminPermission[] };

vi.mock("../src/modules/auth/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/auth/service.js")>();
  class FakeAuthService {
    async getSession(token: string | null) {
      if (!token) return null;
      return {
        principal: { id: "00000000-0000-4000-8000-000000014201", email: "hc-today@example.invalid", principalType: "SUPER_ADMIN" },
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
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://attendance-today-test",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
} as ApiConfig;

const SCANNED = "00000000-0000-4000-8000-000000014011";
const NOT_SCANNED = "00000000-0000-4000-8000-000000014012";

function createPool() {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM employees employee")) {
      return {
        rows: [SCANNED, NOT_SCANNED].map((employeeId, index) => ({
          employeeId, employeeNumber: `SYN-${index}`, employeeName: `Pegawai Sintetis ${index}`, unitId: null, unitName: "Unit Sintetis",
        })),
      };
    }
    if (sql.includes("FROM attendance_adms_events event")) {
      return { rows: [{ employeeId: SCANNED, occurredAt: new Date("2026-10-26T06:50:00+07:00"), source: "adms", deviceId: "device-1" }] };
    }
    if (sql.includes("FROM attendance_adms_employee_mappings")) return { rows: [{ employeeId: SCANNED }, { employeeId: NOT_SCANNED }] };
    if (sql.includes("FROM attendance_schedule_assignments assignment")) {
      return {
        rows: [{
          scheduleTemplateId: "00000000-0000-4000-8000-000000014101", scheduleVersionId: "00000000-0000-4000-8000-000000014102",
          rosterId: null, isOff: false, startTime: "07:00:00", endTime: "16:00:00", endDayOffset: 0,
          lateGraceMinutes: 1, earlyLeaveToleranceMinutes: 0, workLocationId: null, locationName: null,
          latitude: null, longitude: null, radiusMeters: null,
        }],
      };
    }
    if (sql.includes("FROM attendance_schedule_assignments")) return { rows: [{ employeeId: SCANNED }, { employeeId: NOT_SCANNED }] };
    if (sql.includes("FROM attendance_schedule_templates")) return { rows: [{ id: "00000000-0000-4000-8000-000000014101", name: "SDIT — Hari Penuh" }] };
    if (sql.includes("WITH latest_roster") || sql.includes("FROM leave_calendar_exceptions") || sql.includes("WITH candidates")) {
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return { pool: { query, connect: vi.fn() } as unknown as Pool, query };
}

describe("ATT-014-1 GET /admin/attendance/today", () => {
  let app: ReturnType<typeof Fastify>;
  let pool: ReturnType<typeof createPool>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T17:00:00+07:00"));
    granted.permissions = ["attendance.reports.read"];
    pool = createPool();
    app = Fastify({ logger: false });
    await registerAttendanceWorkforceRoutes(app, pool.pool, config);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
  });

  const get = (url = "/admin/attendance/today") =>
    app.inject({ method: "GET", url, headers: { cookie: "hcis_session=test-token" } });

  it("returns today's facts and never an attendance verdict", async () => {
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json();
    expect(body.date).toBe("2026-10-26");
    expect(body.summary).toMatchObject({ scanned: 1, not_scanned: 1 });
    const scanned = body.items.find((item: { employeeId: string }) => item.employeeId === SCANNED);
    expect(scanned).toMatchObject({ card: "scanned", scheduleName: "SDIT — Hari Penuh", scanCount: 1, startDeltaMinutes: -10, sources: ["adms"] });
    const waiting = body.items.find((item: { employeeId: string }) => item.employeeId === NOT_SCANNED);
    expect(waiting).toMatchObject({ card: "not_scanned", fact: "no_scan", firstScanAt: null });
    expect(JSON.stringify(body)).not.toMatch(/"(absent|late|incomplete)"/);
  });

  it("only reads: no statement writes to the database", async () => {
    await get();
    const writes = pool.query.mock.calls.filter(([sql]) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(String(sql)));
    expect(writes).toEqual([]);
  });

  it("rejects an account without attendance.reports.read", async () => {
    granted.permissions = ["attendance.clarification.manage"];
    const response = await get();
    expect(response.statusCode).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("rejects an invalid filter before reading employee data", async () => {
    const response = await get("/admin/attendance/today?unitId=not-a-uuid");
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("INVALID_ATTENDANCE_TODAY_QUERY");
    expect(pool.query).not.toHaveBeenCalled();
  });
});
