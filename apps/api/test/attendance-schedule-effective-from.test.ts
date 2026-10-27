import Fastify from "fastify";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AdminPermission } from "../src/modules/auth/permissions.js";

// ATT-014 §20.10 shift "Berlaku sejak" and "Mundurkan awal berlaku". Synthetic identifiers only.

const granted = { permissions: [] as AdminPermission[] };

vi.mock("../src/modules/auth/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/auth/service.js")>();
  class FakeAuthService {
    async getSession(token: string | null) {
      if (!token) return null;
      return {
        principal: { id: "00000000-0000-4000-8000-000000021001", email: "hc-shift@example.invalid", principalType: "SUPER_ADMIN" },
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
  DATABASE_URL: "postgres://attendance-shift-test",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
} as ApiConfig;

const SCHEDULE = "00000000-0000-4000-8000-000000021002";
const VERSION = "00000000-0000-4000-8000-000000021003";

describe("shift effective-from", () => {
  let app: ReturnType<typeof Fastify>;
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  let firstVersionFrom = new Date("2026-10-24T05:40:04.000Z");
  const clientQuery = vi.fn(async (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    if (sql.includes("ORDER BY version") && sql.includes("FOR UPDATE")) {
      return { rows: [{ id: VERSION, effectiveFrom: firstVersionFrom, effectiveTo: null }] };
    }
    if (sql.includes("AS at")) {
      return { rows: [{ at: new Date(`${String(values[0])}T00:00:00+07:00`) }] };
    }
    return { rows: [] };
  });
  const connect = vi.fn(async () => ({ query: clientQuery, release: vi.fn() }));

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T10:00:00+07:00"));
    statements.length = 0;
    clientQuery.mockClear();
    connect.mockClear();
    firstVersionFrom = new Date("2026-10-24T05:40:04.000Z");
    granted.permissions = ["attendance.schedule.manage"];
    app = Fastify({ logger: false });
    await registerAttendanceWorkforceRoutes(app, { query: vi.fn(async () => ({ rows: [] })), connect } as unknown as Pool, config, {
      calculationRunner: { kick: vi.fn(), recoverInterrupted: vi.fn(async () => 0), idle: vi.fn(async () => undefined) },
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
  });

  const post = (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url, headers: { cookie: "hcis_session=test-token" }, payload });

  const shift = { name: "SDIT — Half Day", startTime: "07:00", endTime: "12:00", lateGraceMinutes: 1, earlyLeaveToleranceMinutes: 0 };

  it("creates the first version from the chosen date (00:00 WIB) and audits it", async () => {
    const response = await post("/admin/attendance/schedules", { ...shift, effectiveFrom: "2021-07-01" });
    expect(response.statusCode, response.body).toBe(201);
    const version = statements.find((item) => item.sql.includes("INSERT INTO attendance_schedule_versions"))!;
    expect(version.sql).toContain("coalesce(($11::date::timestamp AT TIME ZONE 'Asia/Jakarta'), now())");
    expect(version.values[10]).toBe("2021-07-01");
    const audit = statements.find((item) => item.sql.includes("INSERT INTO access_audit_events"))!;
    expect(JSON.parse(String(audit.values[5]))).toMatchObject({ version: 1, effectiveFrom: "2021-07-01" });
  });

  it("keeps the old behaviour without a date and refuses a future date", async () => {
    await post("/admin/attendance/schedules", shift);
    expect(statements.find((item) => item.sql.includes("INSERT INTO attendance_schedule_versions"))!.values[10]).toBeNull();
    statements.length = 0;
    const future = await post("/admin/attendance/schedules", { ...shift, effectiveFrom: "2026-10-27" });
    expect(future.statusCode).toBe(422);
    expect(future.json().code).toBe("SCHEDULE_EFFECTIVE_FROM_IN_FUTURE");
    expect(statements).toHaveLength(0);
  });

  it("moves the first version earlier, keeping the previous start in the audit", async () => {
    const response = await post(`/admin/attendance/schedules/${SCHEDULE}/backdate`, { effectiveFrom: "2021-07-01", reason: "Shift dipakai sejak Juli 2021" });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ id: SCHEDULE, versionId: VERSION, effectiveFrom: "2021-06-30T17:00:00.000Z" });
    const update = statements.find((item) => item.sql.startsWith("UPDATE attendance_schedule_versions"))!;
    expect(update.values).toEqual([VERSION, new Date("2021-06-30T17:00:00.000Z")]);
    const audit = statements.find((item) => item.sql.includes("INSERT INTO access_audit_events"))!;
    expect(audit.values[2]).toBe("attendance.schedule.backdated");
    expect(JSON.parse(String(audit.values[5]))).toEqual({
      versionId: VERSION, previousEffectiveFrom: "2026-10-24T05:40:04.000Z", effectiveFrom: "2021-06-30T17:00:00.000Z", reason: "Shift dipakai sejak Juli 2021",
    });
    expect(statements.at(-1)?.sql).toBe("COMMIT");
  });

  it("refuses a date that is not earlier, and writes nothing", async () => {
    firstVersionFrom = new Date("2021-06-30T17:00:00.000Z");
    const response = await post(`/admin/attendance/schedules/${SCHEDULE}/backdate`, { effectiveFrom: "2021-07-01", reason: "Ulang" });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("SCHEDULE_BACKDATE_NOT_EARLIER");
    expect(statements.some((item) => item.sql.startsWith("UPDATE"))).toBe(false);
    expect(statements.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("requires a reason, a valid date and attendance.schedule.manage", async () => {
    expect((await post(`/admin/attendance/schedules/${SCHEDULE}/backdate`, { effectiveFrom: "2021-07-01", reason: "" })).statusCode).toBe(400);
    expect((await post(`/admin/attendance/schedules/${SCHEDULE}/backdate`, { effectiveFrom: "1 Juli", reason: "Alasan" })).statusCode).toBe(400);
    granted.permissions = ["attendance.reports.read"];
    expect((await post(`/admin/attendance/schedules/${SCHEDULE}/backdate`, { effectiveFrom: "2021-07-01", reason: "Alasan" })).statusCode).toBe(403);
    expect(connect).not.toHaveBeenCalled();
  });
});
