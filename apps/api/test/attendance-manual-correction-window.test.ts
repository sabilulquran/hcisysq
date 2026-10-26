import Fastify from "fastify";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AdminPermission } from "../src/modules/auth/permissions.js";
import { manualCorrectionWindowError } from "../src/modules/attendance/manual-correction-window.js";

// Koreksi HC: corrected times must belong to the selected work date. Synthetic identifiers only.

describe("Koreksi HC work-date window", () => {
  const check = (checkInAt: string | null, checkOutAt: string | null, workDate = "2026-10-20") =>
    manualCorrectionWindowError({ workDate, checkInAt, checkOutAt });

  it("accepts times on the work date in Asia/Jakarta", () => {
    expect(check("2026-10-20T07:02:00+07:00", "2026-10-20T16:05:00+07:00")).toBeNull();
    expect(check("2026-10-20T07:02:00+07:00", null)).toBeNull();
    expect(check(null, "2026-10-20T16:05:00+07:00")).toBeNull();
    // 00:30 WIB on 20 October is still 19 October in UTC.
    expect(check("2026-10-19T17:30:00Z", null)).toBeNull();
  });

  it("accepts a check-out on the next day for a shift that crosses midnight", () => {
    expect(check("2026-10-20T21:00:00+07:00", "2026-10-21T05:00:00+07:00")).toBeNull();
    expect(check(null, "2026-10-21T05:00:00+07:00")).toBeNull();
  });

  it("rejects a check-in from another date (the reported 20 vs 26 October case)", () => {
    expect(check("2026-10-26T08:00:00+07:00", null)).toBe("CHECK_IN_OUTSIDE_WORK_DATE");
    expect(check("2026-10-21T00:10:00+07:00", null)).toBe("CHECK_IN_OUTSIDE_WORK_DATE");
  });

  it("rejects a check-out two days later or before the work date", () => {
    expect(check(null, "2026-10-26T16:00:00+07:00")).toBe("CHECK_OUT_OUTSIDE_WORK_DATE");
    expect(check(null, "2026-10-19T23:00:00+07:00")).toBe("CHECK_OUT_OUTSIDE_WORK_DATE");
  });

  it("rejects a check-out before the check-in or more than 24 hours after it", () => {
    expect(check("2026-10-20T16:00:00+07:00", "2026-10-20T07:00:00+07:00")).toBe("CHECK_OUT_BEFORE_CHECK_IN");
    expect(check("2026-10-20T07:00:00+07:00", "2026-10-20T07:00:00+07:00")).toBe("CHECK_OUT_BEFORE_CHECK_IN");
    expect(check("2026-10-20T01:00:00+07:00", "2026-10-21T02:00:00+07:00")).toBe("CHECK_OUT_BEFORE_CHECK_IN");
  });
});

const granted = { permissions: [] as AdminPermission[] };

vi.mock("../src/modules/auth/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/auth/service.js")>();
  class FakeAuthService {
    async getSession(token: string | null) {
      if (!token) return null;
      return {
        principal: { id: "00000000-0000-4000-8000-000000015001", email: "hc-correction@example.invalid", principalType: "SUPER_ADMIN" },
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
  DATABASE_URL: "postgres://manual-correction-test",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
} as ApiConfig;

describe("POST /admin/attendance/manual-corrections window check", () => {
  let app: ReturnType<typeof Fastify>;
  const query = vi.fn(async () => ({ rows: [] }));
  const connect = vi.fn();

  beforeEach(async () => {
    query.mockClear();
    connect.mockClear();
    granted.permissions = ["attendance.records.manage"];
    app = Fastify({ logger: false });
    await registerAttendanceWorkforceRoutes(app, { query, connect } as unknown as Pool, config, {
      calculationRunner: { kick: vi.fn(), recoverInterrupted: vi.fn(async () => 0), idle: vi.fn(async () => undefined) },
    });
  });

  afterEach(async () => { await app.close(); });

  const post = (payload: Record<string, unknown>) => app.inject({
    method: "POST",
    url: "/admin/attendance/manual-corrections",
    headers: { cookie: "hcis_session=test-token" },
    payload: {
      employeeId: "00000000-0000-4000-8000-000000015002",
      workDate: "2026-10-20",
      checkInAt: null,
      checkOutAt: null,
      reason: "Mesin mati",
      ...payload,
    },
  });

  it("rejects a check-in on another date with 422 and writes nothing", async () => {
    const response = await post({ checkInAt: "2026-10-26T01:00:00.000Z" });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("CHECK_IN_OUTSIDE_WORK_DATE");
    expect(query).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects a check-out before the check-in", async () => {
    const response = await post({ checkInAt: "2026-10-20T09:00:00.000Z", checkOutAt: "2026-10-20T01:00:00.000Z" });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("CHECK_OUT_BEFORE_CHECK_IN");
    expect(query).not.toHaveBeenCalled();
  });

  it("lets a valid overnight correction through to the employee lookup", async () => {
    const response = await post({ checkInAt: "2026-10-20T14:00:00.000Z", checkOutAt: "2026-10-20T22:00:00.000Z" });
    // The synthetic pool has no employee, so the request stops at 404 after the window check passed.
    expect(response.statusCode).toBe(404);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("still checks the permission first", async () => {
    granted.permissions = ["attendance.reports.read"];
    const response = await post({ checkInAt: "2026-10-26T01:00:00.000Z" });
    expect(response.statusCode).toBe(403);
  });
});
