import Fastify from "fastify";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";

// ATT-014 §6.5c (DRAFT) GET /attendance/me/transactions: the HTTP contract. The employee always
// comes from the session, the range is bounded, the read is one query and never writes, and the
// response is not cached. The SQL itself is covered by attendance-my-transactions.postgres.test.ts.
// Synthetic identities.

const EMPLOYEE_ID = "00000000-0000-4000-8000-000000031001";
const OTHER_EMPLOYEE_ID = "00000000-0000-4000-8000-000000031009";
let principalType = "EMPLOYEE";

vi.mock("../src/modules/auth/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/auth/service.js")>();
  class FakeAuthService {
    async getSession(token: string | null) {
      if (!token) return null;
      return {
        principal: { id: "00000000-0000-4000-8000-000000031002", email: "pegawai@example.invalid", principalType },
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      };
    }
    async getAuthorizationContext() {
      return { organizationPermissions: [] };
    }
  }
  return { ...actual, AuthService: FakeAuthService };
});

const { registerAttendanceWorkforceRoutes } = await import("../src/modules/attendance/workforce-routes.js");

const config = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://attendance-my-transactions-test",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
} as ApiConfig;

describe("GET /attendance/me/transactions", () => {
  let app: ReturnType<typeof Fastify>;

  const query = vi.fn<(sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>>(async (sql) => {
    if (sql.includes("JOIN employees employee ON employee.id = account.employee_id")) {
      return { rows: [{ id: EMPLOYEE_ID, fullName: "Pegawai Sintetis", employeeNumber: "SYN-1" }] };
    }
    if (sql.includes("FROM attendance_adms_events event")) {
      return { rows: [
        { occurredAt: new Date("2026-11-12T00:02:00.000Z"), workDate: "2026-11-12", source: "adms", kind: null, deviceName: "Mesin Lobi", reviewState: null, calculatedAt: new Date("2026-11-12T05:00:00.000Z"), afterCalculation: false },
        { occurredAt: new Date("2026-11-12T09:15:00.000Z"), workDate: "2026-11-12", source: "adms", kind: null, deviceName: "Mesin Lobi", reviewState: null, calculatedAt: new Date("2026-11-12T05:00:00.000Z"), afterCalculation: true },
        { occurredAt: new Date("2026-11-13T00:30:00.000Z"), workDate: "2026-11-13", source: "mobile", kind: "check_in", deviceName: null, reviewState: "needs_review", calculatedAt: null, afterCalculation: false },
      ] };
    }
    return { rows: [] };
  });

  beforeEach(async () => {
    principalType = "EMPLOYEE";
    query.mockClear();
    app = Fastify({ logger: false });
    await registerAttendanceWorkforceRoutes(app, { query, connect: vi.fn() } as unknown as Pool, config, {
      calculationRunner: { kick: vi.fn(), recoverInterrupted: vi.fn(async () => 0), idle: vi.fn(async () => undefined) },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const get = (search: string, cookie = true) => app.inject({
    method: "GET",
    url: `/attendance/me/transactions?${search}`,
    headers: cookie ? { cookie: "hcis_session=test-token" } : {},
  });

  it("returns the raw punches with a per-day summary, uncached", async () => {
    const response = await get("from=2026-11-11&to=2026-11-13");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json();
    expect(body.truncated).toBe(false);
    expect(body.items).toHaveLength(3);
    expect(body.items[1]).toEqual({
      occurredAt: "2026-11-12T09:15:00.000Z",
      workDate: "2026-11-12",
      source: "adms",
      kind: null,
      deviceName: "Mesin Lobi",
      reviewState: null,
      afterCalculation: true,
    });
    expect(body.days).toEqual([
      { workDate: "2026-11-12", firstScanAt: "2026-11-12T00:02:00.000Z", lastScanAt: "2026-11-12T09:15:00.000Z", scanCount: 2, calculatedAt: "2026-11-12T05:00:00.000Z", newSinceCalculation: true },
      { workDate: "2026-11-13", firstScanAt: "2026-11-13T00:30:00.000Z", lastScanAt: null, scanCount: 1, calculatedAt: null, newSinceCalculation: false },
    ]);
  });

  it("always reads the signed-in employee, whatever the query says", async () => {
    await get(`from=2026-11-11&to=2026-11-13&employeeId=${OTHER_EMPLOYEE_ID}`);
    const read = query.mock.calls.find(([sql]) => sql.includes("FROM attendance_adms_events event"));
    expect(read?.[1]?.[0]).toBe(EMPLOYEE_ID);
    expect(JSON.stringify(query.mock.calls)).not.toContain(OTHER_EMPLOYEE_ID);
  });

  it("reads once per range and never writes", async () => {
    await get("from=2026-10-14&to=2026-11-13");
    expect(query.mock.calls.filter(([sql]) => sql.includes("FROM attendance_adms_events event"))).toHaveLength(1);
    expect(query.mock.calls.filter(([sql]) => /^\s*(INSERT|UPDATE|DELETE)\s/i.test(sql))).toEqual([]);
  });

  it("rejects a range over 31 days, a reversed range and an impossible date before reading", async () => {
    for (const search of ["from=2026-10-13&to=2026-11-13", "from=2026-11-13&to=2026-11-12", "from=2026-02-30&to=2026-03-01", "from=2026-11-01"]) {
      const response = await get(search);
      expect(response.statusCode, search).toBe(400);
    }
    expect(query.mock.calls.filter(([sql]) => sql.includes("FROM attendance_adms_events event"))).toEqual([]);
  });

  it("needs an employee session", async () => {
    expect((await get("from=2026-11-11&to=2026-11-13", false)).statusCode).toBe(401);
    principalType = "SUPER_ADMIN";
    expect((await get("from=2026-11-11&to=2026-11-13")).statusCode).toBe(403);
  });
});
