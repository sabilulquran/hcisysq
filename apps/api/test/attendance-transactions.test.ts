import Fastify from "fastify";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AdminPermission } from "../src/modules/auth/permissions.js";

// ATT-014 §19.1 Data Transaksi route. Synthetic identifiers only; the SQL itself is exercised against
// PostgreSQL in attendance-calculation.postgres.test.ts.

const granted = { permissions: [] as AdminPermission[] };

vi.mock("../src/modules/auth/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/auth/service.js")>();
  class FakeAuthService {
    async getSession(token: string | null) {
      if (!token) return null;
      return {
        principal: { id: "00000000-0000-4000-8000-000000016001", email: "hc-transactions@example.invalid", principalType: "SUPER_ADMIN" },
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
  DATABASE_URL: "postgres://attendance-transactions-test",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
} as ApiConfig;

describe("GET /admin/attendance/transactions", () => {
  let app: ReturnType<typeof Fastify>;
  const query = vi.fn<(sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>>(async () => ({
    rows: [{
      id: "00000000-0000-4000-8000-000000016002", employeeId: "00000000-0000-4000-8000-000000016003",
      employeeNumber: "SYN-1", employeeName: "Pegawai Sintetis", unitName: "Unit Sintetis",
      occurredAt: new Date("2026-10-20T00:05:00.000Z"), workDate: "2026-10-20", source: "adms",
      correctionBy: null, boundary: null, deviceName: "Mesin Sintetis", usedInResult: false, total: 61,
    }],
  }));

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T10:00:00+07:00"));
    query.mockClear();
    granted.permissions = ["attendance.reports.read"];
    app = Fastify({ logger: false });
    await registerAttendanceWorkforceRoutes(app, { query, connect: vi.fn() } as unknown as Pool, config, {
      calculationRunner: { kick: vi.fn(), recoverInterrupted: vi.fn(async () => 0), idle: vi.fn(async () => undefined) },
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
  });

  const get = (search: string) => app.inject({
    method: "GET", url: `/admin/attendance/transactions?${search}`, headers: { cookie: "hcis_session=test-token" },
  });

  it("returns one page of punches with the total and no internal counter", async () => {
    const response = await get("from=2026-10-01&to=2026-10-26&source=adms&page=2&pageSize=50");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json();
    expect(body).toMatchObject({ page: 2, pageSize: 50, total: 61, totalPages: 2 });
    expect(body.items[0]).toMatchObject({ source: "adms", deviceName: "Mesin Sintetis", occurredAt: "2026-10-20T00:05:00.000Z" });
    expect(body.items[0]).not.toHaveProperty("total");
    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain("FROM attendance_adms_events event");
    expect(values).toEqual([null, null, "2026-10-01", "2026-10-26", "adms", 50, 50]);
  });

  it("only reads", async () => {
    await get("from=2026-10-01&to=2026-10-26");
    const writes = query.mock.calls.filter(([sql]) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(String(sql)));
    expect(writes).toEqual([]);
  });

  it("rejects a bad filter, more than 93 days, and a future date before reading", async () => {
    expect((await get("from=2026-10-01&to=2026-10-26&source=everything")).statusCode).toBe(400);
    expect((await get("from=2026-10-01&to=2026-10-26&pageSize=1000")).statusCode).toBe(400);
    expect((await get("from=2026-07-01&to=2026-10-26")).statusCode).toBe(422);
    expect((await get("from=2026-10-26&to=2026-10-27")).statusCode).toBe(422);
    expect(query).not.toHaveBeenCalled();
  });

  it("requires attendance.reports.read", async () => {
    granted.permissions = ["attendance.calculation.run"];
    expect((await get("from=2026-10-01&to=2026-10-26")).statusCode).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });
});
