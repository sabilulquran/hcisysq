import Fastify from "fastify";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AdminPermission } from "../src/modules/auth/permissions.js";

// ATT-013 shift blocks through the schedule routes. Synthetic identifiers only.

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

describe("ATT-013 schedule blocks", () => {
  let app: ReturnType<typeof Fastify>;
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  let currentBlocks: Array<{ startTime: string; endTime: string }> = [];
  const clientQuery = vi.fn(async (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    if (sql.includes("FOR UPDATE OF schedule")) {
      return { rows: [{ name: "Pesantren Tahfizh", startTime: "04:00:00", endTime: "08:30:00", endDayOffset: 0, lateGraceMinutes: 1, earlyLeaveToleranceMinutes: 0, workLocationId: null, active: true, versionId: "00000000-0000-4000-8000-000000021003" }] };
    }
    if (sql.includes("FROM attendance_schedule_version_blocks block")) return { rows: currentBlocks };
    if (sql.includes("effective_from > clock_timestamp()")) return { rows: [] };
    if (sql.includes("clock_timestamp()")) return { rows: [{ at: new Date("2026-10-26T03:00:00Z") }] };
    if (sql.includes("RETURNING version")) return { rows: [{ version: 1 }] };
    return { rows: [] };
  });
  const connect = vi.fn(async () => ({ query: clientQuery, release: vi.fn() }));

  beforeEach(async () => {
    statements.length = 0;
    currentBlocks = [];
    granted.permissions = ["attendance.schedule.manage"];
    app = Fastify({ logger: false });
    await registerAttendanceWorkforceRoutes(app, { query: vi.fn(async () => ({ rows: [] })), connect } as unknown as Pool, config, {
      calculationRunner: { kick: vi.fn(), recoverInterrupted: vi.fn(async () => 0), idle: vi.fn(async () => undefined) },
    });
  });

  afterEach(async () => { await app.close(); });

  const send = (method: "POST" | "PATCH", url: string, payload: Record<string, unknown>) =>
    app.inject({ method, url, headers: { cookie: "hcis_session=test-token" }, payload });
  const blockInserts = () => statements.filter((item) => item.sql.includes("INSERT INTO attendance_schedule_version_blocks"));

  it("creates a two-block shift and refuses overlapping blocks before any write", async () => {
    const shift = { name: "Pesantren Tahfizh", startTime: "04:00", endTime: "08:30", lateGraceMinutes: 1, earlyLeaveToleranceMinutes: 0 };
    const created = await send("POST", "/admin/attendance/schedules", { ...shift, extraBlocks: [{ startTime: "14:30", endTime: "19:30" }] });
    expect(created.statusCode, created.body).toBe(201);
    expect(blockInserts().map((item) => item.values.slice(2))).toEqual([[2, "14:30", "19:30", null]]);
    statements.length = 0;
    const bad = await send("POST", "/admin/attendance/schedules", { ...shift, extraBlocks: [{ startTime: "08:00", endTime: "10:00" }] });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().code).toBe("SCHEDULE_BLOCKS_INVALID");
    expect(statements).toHaveLength(0);
  });

  it("stores the day share of each block when all are given (D-13-6)", async () => {
    const created = await send("POST", "/admin/attendance/schedules", {
      name: "Pesantren Tahfizh", startTime: "04:00", endTime: "08:30", lateGraceMinutes: 1, earlyLeaveToleranceMinutes: 0,
      firstBlockWorkdayWeight: 0.4, extraBlocks: [{ startTime: "14:30", endTime: "19:30", workdayWeight: 0.6 }],
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(blockInserts()[0]!.values[5]).toBe(0.6);
    const first = statements.find((item) => item.sql.includes("SET first_block_workday_weight"))!;
    expect(first.values[1]).toBe(0.4);
  });

  it("writes a new version when only the block-1 share changes, keeping the block shares", async () => {
    currentBlocks = [{ startTime: "14:30:00", endTime: "19:30:00", workdayWeight: 0.6 } as never];
    const response = await send("PATCH", `/admin/attendance/schedules/${SCHEDULE}`, { firstBlockWorkdayWeight: 0.4 });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().versionId).toBeTruthy();
    expect(blockInserts()[0]!.values[5]).toBe(0.6);
    expect(statements.find((item) => item.sql.includes("SET first_block_workday_weight"))!.values[1]).toBe(0.4);
  });

  it("keeps the current blocks when an edit sends none, and clears them with an empty list", async () => {
    currentBlocks = [{ startTime: "14:30:00", endTime: "19:30:00" }];
    const kept = await send("PATCH", `/admin/attendance/schedules/${SCHEDULE}`, { lateGraceMinutes: 2 });
    expect(kept.statusCode, kept.body).toBe(200);
    expect(blockInserts().map((item) => item.values.slice(2))).toEqual([[2, "14:30:00", "19:30:00", null]]);
    statements.length = 0;
    const cleared = await send("PATCH", `/admin/attendance/schedules/${SCHEDULE}`, { extraBlocks: [] });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(blockInserts()).toHaveLength(0);
    statements.length = 0;
    const bad = await send("PATCH", `/admin/attendance/schedules/${SCHEDULE}`, { extraBlocks: [{ startTime: "07:00", endTime: "09:00" }] });
    expect(bad.statusCode).toBe(422);
    expect(statements.at(-1)?.sql).toBe("ROLLBACK");
    expect(statements.some((item) => item.sql.startsWith("UPDATE"))).toBe(false);
  });
});
