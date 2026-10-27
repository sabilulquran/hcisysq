import Fastify from "fastify";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AdminPermission } from "../src/modules/auth/permissions.js";

// ATT-011-4a shift changes from a later date and the in-use guard (§4.2). Synthetic identifiers only.

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

const SCHEDULE = "00000000-0000-4000-8000-000000026002";
const PENDING = "00000000-0000-4000-8000-000000026003";

describe("ATT-011-4a shift versions from a date", () => {
  let app: ReturnType<typeof Fastify>;
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  let pending: Array<{ id: string; used: boolean }> = [];
  let inUse: Array<Record<string, unknown>> = [];
  const CURRENT = "00000000-0000-4000-8000-000000026004";
  let inForce: Record<string, unknown> = {};
  let scheduled: Record<string, unknown> | null = null;
  const clientQuery = vi.fn(async (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    if (sql.includes("FOR UPDATE OF schedule")) return { rows: [inForce] };
    if (sql.includes("effective_from > clock_timestamp()") && sql.includes("LIMIT 1")) return { rows: scheduled ? [scheduled] : [] };
    if (sql.includes("effective_from > clock_timestamp()")) return { rows: pending };
    if (sql.includes("AT TIME ZONE 'Asia/Jakarta') AS at")) return { rows: [{ at: new Date(`${String(values[0])}T00:00:00+07:00`) }] };
    if (sql.includes("clock_timestamp() AS at")) return { rows: [{ at: new Date("2026-10-27T03:00:00Z") }] };
    if (sql.includes("RETURNING version")) return { rows: [{ version: 2 }] };
    if (sql.includes("count(DISTINCT employee_id)")) return { rows: [{ count: 42 }] };
    if (sql.includes("WITH used AS")) return { rows: inUse };
    return { rows: [] };
  });
  const connect = vi.fn(async () => ({ query: clientQuery, release: vi.fn() }));

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T10:00:00+07:00"));
    statements.length = 0;
    pending = [];
    inUse = [];
    inForce = { name: "Regular", startTime: "08:00:00", endTime: "16:00:00", endDayOffset: 0, lateGraceMinutes: 1, earlyLeaveToleranceMinutes: 0, workLocationId: null, active: true, versionId: CURRENT };
    scheduled = null;
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

  const patch = (payload: Record<string, unknown>) => app.inject({
    method: "PATCH", url: `/admin/attendance/schedules/${SCHEDULE}`, headers: { cookie: "hcis_session=test-token" }, payload,
  });
  const versionInsert = () => statements.find((item) => item.sql.includes("INSERT INTO attendance_schedule_versions"));
  const templateUpdate = () => statements.find((item) => item.sql.includes("UPDATE attendance_schedule_templates"))!;

  it("applies a later change from that date at 00:00 WIB and leaves today's hours alone", async () => {
    const response = await patch({ startTime: "07:30", endTime: "15:30", effectiveFrom: "2026-11-01" });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ effectiveFrom: "2026-11-01", affectedEmployees: 42 });
    expect(versionInsert()!.values[10]).toEqual(new Date("2026-10-31T17:00:00.000Z"));
    expect(templateUpdate().values.slice(2, 4)).toEqual(["08:00:00", "16:00:00"]);
    const audit = statements.find((item) => item.sql.includes("INSERT INTO access_audit_events"))!;
    expect(JSON.parse(String(audit.values[5]))).toMatchObject({ effectiveFrom: "2026-11-01", affectedEmployees: 42 });
  });

  it("replaces a pending change that nothing uses, and refuses one that a roster already uses", async () => {
    pending = [{ id: PENDING, used: false }];
    scheduled = { ...inForce, versionId: PENDING, startTime: "07:30:00", endTime: "15:30:00" };
    const replaced = await patch({ lateGraceMinutes: 5, effectiveFrom: "2026-11-02" });
    expect(replaced.statusCode, replaced.body).toBe(200);
    // Delete the pending version, reopen the latest remaining one, then close it at the new date.
    const order = ["DELETE FROM attendance_schedule_versions", "SET effective_to = NULL", "SET effective_to = $2", "INSERT INTO attendance_schedule_versions"]
      .map((fragment) => statements.findIndex((item) => item.sql.includes(fragment)));
    expect(order.every((index, position) => index >= 0 && (position === 0 || index > order[position - 1]!))).toBe(true);
    expect(statements[order[0]!]!.values[0]).toBe(PENDING);
    // A partial change to the scheduled version keeps its hours.
    expect(versionInsert()!.values.slice(4, 8)).toEqual(["07:30:00", "15:30:00", 0, 5]);
    expect(statements.find((item) => item.sql.includes("FROM attendance_schedule_version_blocks block"))!.values).toEqual([PENDING]);
    const audit = statements.find((item) => item.sql.includes("INSERT INTO access_audit_events"))!;
    expect(JSON.parse(String(audit.values[5]))).toMatchObject({ replacedVersionIds: [PENDING] });
    statements.length = 0;
    pending = [{ id: PENDING, used: true }];
    const refused = await patch({ startTime: "07:00", effectiveFrom: "2026-11-02" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("SCHEDULE_FUTURE_VERSION_IN_USE");
    expect(statements.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("builds a later partial change on the version in force, not on the template columns", async () => {
    inForce = { ...inForce, startTime: "07:30:00", endTime: "15:30:00" };
    expect((await patch({ lateGraceMinutes: 5 })).statusCode).toBe(200);
    expect(versionInsert()!.values.slice(4, 8)).toEqual(["07:30:00", "15:30:00", 0, 5]);
    expect(statements.find((item) => item.sql.includes("FROM attendance_schedule_version_blocks block"))!.values).toEqual([CURRENT]);
  });

  it("refuses a change from now while a change from a later date is scheduled", async () => {
    pending = [{ id: PENDING, used: false }];
    const refused = await patch({ lateGraceMinutes: 5 });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("SCHEDULE_CHANGE_PENDING");
    expect(statements.some((item) => item.sql.startsWith("DELETE FROM attendance_schedule_versions"))).toBe(false);
    expect(statements.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("refuses a past date and refuses switching off a shift that is still used", async () => {
    const past = await patch({ startTime: "07:00", effectiveFrom: "2026-10-26" });
    expect(past.statusCode).toBe(400);
    expect(past.json().code).toBe("EFFECTIVE_DATE_IN_PAST");
    inUse = [{ employeeNumber: "SYN-1", employeeName: "Pegawai Sintetis", fromDate: "2026-10-27", total: 42 }];
    const off = await patch({ active: false });
    expect(off.statusCode).toBe(409);
    expect(off.json()).toMatchObject({ code: "SCHEDULE_IN_USE", total: 42, employees: [{ employeeName: "Pegawai Sintetis" }] });
    expect(statements.some((item) => item.sql.startsWith("UPDATE attendance_schedule_templates"))).toBe(false);
  });

  it("switches off an unused shift with a deactivation audit", async () => {
    expect((await patch({ active: false })).statusCode).toBe(200);
    expect(statements.find((item) => item.sql.includes("INSERT INTO access_audit_events"))!.values[2]).toBe("attendance.schedule.deactivated");
  });
});
