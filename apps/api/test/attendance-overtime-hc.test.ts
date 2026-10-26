import Fastify from "fastify";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import { dayTypeFor } from "../src/modules/attendance/engine.js";
import type { AdminPermission } from "../src/modules/auth/permissions.js";

// ATT-011-6a overtime rules and HC monitoring. Synthetic identifiers only.

const granted = { permissions: [] as AdminPermission[] };

vi.mock("../src/modules/auth/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/auth/service.js")>();
  class FakeAuthService {
    async getSession(token: string | null) {
      if (!token) return null;
      return {
        principal: { id: "00000000-0000-4000-8000-000000025001", email: "hc-overtime@example.invalid", principalType: "SUPER_ADMIN" },
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
  NODE_ENV: "test", HOST: "127.0.0.1", PORT: 3001, DATABASE_URL: "postgres://attendance-overtime-test",
  AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8,
} as ApiConfig;

const EMPLOYEE = "00000000-0000-4000-8000-000000025002";

describe("ATT-011-6a kind of day", () => {
  it("keeps a holiday a holiday even when scheduled, and a day without schedule a rest day", () => {
    expect(dayTypeFor("scheduled", false)).toBe("working_day");
    expect(dayTypeFor("off", false)).toBe("rest_day");
    expect(dayTypeFor("scheduled", true)).toBe("public_holiday");
    expect(dayTypeFor("off", true)).toBe("public_holiday");
  });
});

describe("ATT-011-6a overtime routes", () => {
  let app: ReturnType<typeof Fastify>;
  let dayTotal = 0;
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const respond = async (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    if (sql.includes("SELECT id FROM employees WHERE id = $1 AND status = 'active'")) return { rows: [{ id: EMPLOYEE }] };
    if (sql.includes("coalesce(sum(CASE WHEN status = 'approved'")) return { rows: [{ minutes: dayTotal }] };
    if (sql.includes("FROM attendance_overtime_requests") && sql.includes("FOR UPDATE")) {
      return { rows: [{ employeeId: EMPLOYEE, workDate: "2026-10-20", requestedMinutes: 120 }] };
    }
    if (sql.includes("WITH filtered AS")) {
      return { rows: [{ id: "o", employeeName: "Pegawai Sintetis", workDate: "2026-10-20", status: "submitted", dayType: "rest_day", scanOutsideScheduleMinutes: 240, initiatedBy: "employee", total: 31 }] };
    }
    return { rows: [] };
  };
  const query = vi.fn(respond);
  const clientQuery = vi.fn(respond);
  const connect = vi.fn(async () => ({ query: clientQuery, release: vi.fn() }));

  beforeEach(async () => {
    statements.length = 0;
    dayTotal = 0;
    granted.permissions = ["attendance.overtime.manage", "employees.manage"];
    app = Fastify({ logger: false });
    await registerAttendanceWorkforceRoutes(app, { query, connect } as unknown as Pool, config, {
      calculationRunner: { kick: vi.fn(), recoverInterrupted: vi.fn(async () => 0), idle: vi.fn(async () => undefined) },
    });
  });

  afterEach(async () => { await app.close(); });

  const call = (method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers: { cookie: "hcis_session=test-token" }, ...(payload ? { payload } : {}) });

  it("refuses overtime that would take the day past 24 hours, and writes nothing", async () => {
    dayTotal = 1400;
    const response = await call("POST", "/admin/attendance/overtime", { employeeId: EMPLOYEE, workDate: "2026-10-20", requestedMinutes: 60 });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("OVERTIME_DAY_TOTAL_INVALID");
    expect(statements.some((item) => item.sql.includes("INSERT INTO attendance_overtime_requests"))).toBe(false);
    expect(statements.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("audits an HC-entered request in access_audit_events", async () => {
    const response = await call("POST", "/admin/attendance/overtime", { employeeId: EMPLOYEE, workDate: "2026-10-20", requestedMinutes: 60 });
    expect(response.statusCode, response.body).toBe(201);
    const audit = statements.find((item) => item.sql.includes("INSERT INTO access_audit_events"))!;
    expect(audit.values[2]).toBe("attendance.overtime.submitted");
    expect(JSON.parse(String(audit.values[5]))).toMatchObject({ initiatedBy: "hc", requestedMinutes: 60 });
  });

  it("checks the 24-hour total again on approval, counting the approved minutes", async () => {
    dayTotal = 1400;
    const response = await call("POST", "/admin/attendance/overtime/00000000-0000-4000-8000-000000025003/decision", { decision: "approve", approvedMinutes: 60 });
    expect(response.statusCode).toBe(422);
    const sum = statements.find((item) => item.sql.includes("coalesce(sum(CASE WHEN status = 'approved'"))!;
    expect(sum.values[2]).toBe("00000000-0000-4000-8000-000000025003");
  });

  it("pages the HC list with the kind of day and scan facts, and folds rejected+cancelled into one tab", async () => {
    const response = await call("GET", "/admin/attendance/overtime?status=closed&page=2");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ page: 2, pageSize: 25, total: 31, pageCount: 2 });
    expect(response.json().items[0]).toMatchObject({ dayType: "rest_day", scanOutsideScheduleMinutes: 240 });
    expect(response.json().items[0]).not.toHaveProperty("total");
    const list = statements.find((item) => item.sql.includes("WITH filtered AS"))!;
    expect(list.values).toEqual([["rejected", "cancelled"], null, 25, 25]);
    expect((await call("GET", "/admin/attendance/overtime?pageSize=101")).statusCode).toBe(400);
  });
});
