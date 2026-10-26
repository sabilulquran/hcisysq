import Fastify from "fastify";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import { allowedActionKinds } from "../src/modules/attendance/action-queue.js";
import type { AdminPermission } from "../src/modules/auth/permissions.js";

// ATT-011-3 "Perlu tindakan" queue and one-day detail. Synthetic identifiers only; the queue SQL runs
// against PostgreSQL in attendance-action-queue.postgres.test.ts.

const granted = { permissions: [] as AdminPermission[] };

vi.mock("../src/modules/auth/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/auth/service.js")>();
  class FakeAuthService {
    async getSession(token: string | null) {
      if (!token) return null;
      return {
        principal: { id: "00000000-0000-4000-8000-000000024001", email: "hc-queue@example.invalid", principalType: "SUPER_ADMIN" },
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      };
    }
    async getAuthorizationContext() {
      return { organizationPermissions: [...granted.permissions] };
    }
  }
  return { ...actual, AuthService: FakeAuthService };
});

// The punch read model is faked so the test sees what the route passes it (evidence on or off).
const transactionCalls: Array<{ includeEvidence?: boolean; from: string; to: string }> = [];
vi.mock("../src/modules/attendance/transactions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/attendance/transactions.js")>();
  return {
    ...actual,
    attendanceTransactions: async (_pool: unknown, filter: { includeEvidence?: boolean; from: string; to: string }) => {
      transactionCalls.push(filter);
      const punch = {
        id: "p", employeeId: "00000000-0000-4000-8000-000000024002", employeeNumber: "SYN-1", employeeName: "Pegawai Sintetis",
        unitName: "SD", occurredAt: "2026-10-20T00:05:00.000Z", workDate: "2026-10-20", source: "mobile", correctionBy: null,
        boundary: "check_in", deviceName: null, usedInResult: false, reviewState: "needs_review", geofenceStatus: "outside",
        ...(filter.includeEvidence ? { evidence: { evidenceId: "e", latitude: -6.5, longitude: 106.8, accuracyMeters: 10, distanceMeters: 900, geofenceStatus: "outside", workLocationName: null, radiusMeters: 100 } } : {}),
      };
      const other = { ...punch, id: "q", workDate: "2026-10-21", occurredAt: "2026-10-21T02:00:00.000Z", evidence: undefined };
      return { page: 1, pageSize: 200, total: 2, totalPages: 1, needsReviewTotal: 1, items: [punch, other] };
    },
  };
});

const { registerAttendanceWorkforceRoutes } = await import("../src/modules/attendance/workforce-routes.js");

const config = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://attendance-queue-test",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
} as ApiConfig;

const EMPLOYEE = "00000000-0000-4000-8000-000000024002";

describe("ATT-011-3 action queue kinds", () => {
  it("offers each kind only to accounts that can act on it", () => {
    expect(allowedActionKinds(["attendance.clarification.manage"])).toEqual(["clarification", "mobile_review"]);
    expect(allowedActionKinds(["attendance.reports.read"])).toEqual(["incomplete", "configuration_error"]);
    expect(allowedActionKinds(["attendance.schedule.manage"])).toEqual(["configuration_error"]);
    expect(allowedActionKinds(["attendance.overtime.manage"])).toEqual([]);
  });
});

describe("ATT-011-3 routes", () => {
  let app: ReturnType<typeof Fastify>;
  const query = vi.fn<(sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>>(async (sql, values) => {
    if (sql.includes("GROUP BY kind")) return { rows: [{ kind: "clarification", n: 1 }] };
    if (sql.includes("joined AS")) {
      return { rows: [{ kind: "clarification", id: "c", employeeId: EMPLOYEE, employeeNumber: "SYN-1", employeeName: "Pegawai Sintetis", unitName: "SD", workDate: "2026-10-20", detail: "lateness", mode: "justification", reason: "Ban bocor", occurredAt: null, total: 1 }] };
    }
    if (sql.includes("FROM employees employee LEFT JOIN")) return { rows: [{ id: EMPLOYEE, employeeNumber: "SYN-1", fullName: "Pegawai Sintetis", unitName: "SD" }] };
    if (sql.includes("SELECT 1 FROM employees WHERE id = $1")) return { rows: values?.[0] === EMPLOYEE ? [{ known: 1 }] : [] };
    return { rows: [] };
  });
  const clientQuery = vi.fn(async () => ({ rows: [] }));
  const connect = vi.fn(async () => ({ query: clientQuery, release: vi.fn() }));

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T10:00:00+07:00"));
    query.mockClear();
    clientQuery.mockClear();
    connect.mockClear();
    app = Fastify({ logger: false });
    await registerAttendanceWorkforceRoutes(app, { query, connect } as unknown as Pool, config, {
      calculationRunner: { kick: vi.fn(), recoverInterrupted: vi.fn(async () => 0), idle: vi.fn(async () => undefined) },
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
  });

  const call = (method: "GET" | "POST", url: string) => app.inject({ method, url, headers: { cookie: "hcis_session=test-token" } });

  it("lists the queue for the kinds this account may act on, last 31 days by default", async () => {
    granted.permissions = ["attendance.clarification.manage"];
    const response = await call("GET", "/admin/attendance/action-queue");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ total: 1, kinds: ["clarification", "mobile_review"], counts: { clarification: 1 } });
    const values = query.mock.calls.find(([sql]) => !sql.includes("GROUP BY kind"))![1]!;
    expect(values.slice(0, 5)).toEqual(["2026-09-26", "2026-10-26", null, ["clarification", "mobile_review"], "2026-10-24"]);
  });

  it("refuses accounts without any queue permission", async () => {
    granted.permissions = ["attendance.overtime.manage"];
    expect((await call("GET", "/admin/attendance/action-queue")).statusCode).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it("returns one day; GPS only with attendance.clarification.manage, never provenance or photos", async () => {
    transactionCalls.length = 0;
    granted.permissions = ["attendance.reports.read"];
    const response = await call("GET", `/admin/attendance/daily/${EMPLOYEE}/2026-10-20`);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ employee: { fullName: "Pegawai Sintetis" }, workDate: "2026-10-20", result: null, leave: [], overtime: [] });
    // The next day is read for overnight shifts, but an unrelated next-day punch is not shown.
    expect(transactionCalls.at(-1)).toMatchObject({ from: "2026-10-20", to: "2026-10-21", includeEvidence: false });
    expect(body.punches).toHaveLength(1);
    expect(body.punches[0]).not.toHaveProperty("evidence");
    expect(JSON.stringify(body)).not.toMatch(/latitude|ciphertext|photo_|sourceSummary/);

    granted.permissions = ["attendance.clarification.manage"];
    const reviewer = (await call("GET", `/admin/attendance/daily/${EMPLOYEE}/2026-10-20`)).json();
    expect(transactionCalls.at(-1)).toMatchObject({ includeEvidence: true });
    expect(reviewer.punches[0].evidence).toMatchObject({ latitude: -6.5 });

    expect((await call("GET", `/admin/attendance/daily/${EMPLOYEE}/20-10-2026`)).statusCode).toBe(400);
    granted.permissions = ["attendance.overtime.manage"];
    expect((await call("GET", `/admin/attendance/daily/${EMPLOYEE}/2026-10-20`)).statusCode).toBe(403);
  });

  it("asks the employee for a clarification within the window and audits it", async () => {
    granted.permissions = ["attendance.records.manage"];
    const response = await call("POST", `/admin/attendance/daily/${EMPLOYEE}/2026-10-20/request-clarification`);
    expect(response.statusCode, response.body).toBe(200);
    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql));
    expect(sqls.some((sql) => sql.includes("FROM accounts account"))).toBe(true);
    expect(sqls.some((sql) => sql.includes("INSERT INTO access_audit_events"))).toBe(true);
    expect(sqls.at(-1)).toBe("COMMIT");
    expect((await call("POST", `/admin/attendance/daily/${EMPLOYEE}/2026-10-10/request-clarification`)).statusCode).toBe(422);
    granted.permissions = ["attendance.reports.read"];
    expect((await call("POST", `/admin/attendance/daily/${EMPLOYEE}/2026-10-20/request-clarification`)).statusCode).toBe(403);
    granted.permissions = ["attendance.records.manage"];
    clientQuery.mockClear();
    const unknown = await call("POST", "/admin/attendance/daily/00000000-0000-4000-8000-000000024999/2026-10-20/request-clarification");
    expect(unknown.statusCode).toBe(404);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
