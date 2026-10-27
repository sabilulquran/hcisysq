import Fastify from "fastify";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AdminPermission } from "../src/modules/auth/permissions.js";

// ATT-011-3R Perbaikan Absen list (ATT-014 §19.6). Synthetic identifiers only.

const granted = { permissions: [] as AdminPermission[] };

vi.mock("../src/modules/auth/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/auth/service.js")>();
  class FakeAuthService {
    async getSession(token: string | null) {
      if (!token) return null;
      return {
        principal: { id: "00000000-0000-4000-8000-000000018001", email: "hc-corrections@example.invalid", principalType: "SUPER_ADMIN" },
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
  DATABASE_URL: "postgres://attendance-corrections-test",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
} as ApiConfig;

describe("GET /admin/attendance/clarifications (Perbaikan Absen)", () => {
  let app: ReturnType<typeof Fastify>;
  const query = vi.fn<(sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>>(async () => ({
    rows: [{
      id: "00000000-0000-4000-8000-000000018002", workDate: "2026-10-20", kind: "other", mode: "correction", reason: "Mesin mati",
      status: "approved", origin: "hc", employeeName: "Pegawai Sintetis", total: 61, submittedCount: 4,
    }],
  }));

  beforeEach(async () => {
    query.mockClear();
    app = Fastify({ logger: false });
    await registerAttendanceWorkforceRoutes(app, { query, connect: vi.fn() } as unknown as Pool, config, {
      calculationRunner: { kick: vi.fn(), recoverInterrupted: vi.fn(async () => 0), idle: vi.fn(async () => undefined) },
    });
  });

  afterEach(async () => { await app.close(); });

  const get = (search = "") => app.inject({
    method: "GET", url: `/admin/attendance/clarifications${search}`, headers: { cookie: "hcis_session=test-token" },
  });

  it("returns one page with origin, total and the open-request count", async () => {
    granted.permissions = ["attendance.clarification.manage"];
    const response = await get("?status=all&origin=hc&mode=correction&from=2026-10-01&to=2026-10-31&q=sintetis&page=2&pageSize=50");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ page: 2, pageSize: 50, total: 61, totalPages: 2, submittedCount: 4 });
    expect(response.json().items[0]).toMatchObject({ origin: "hc", status: "approved" });
    expect(response.json().items[0]).not.toHaveProperty("total");
    expect(query.mock.calls[0]![1]).toEqual(["all", "hc", "correction", "2026-10-01", "2026-10-31", "sintetis", 50, 50]);
  });

  it("keeps the old default of open requests", async () => {
    granted.permissions = ["attendance.clarification.manage"];
    await get();
    expect(query.mock.calls[0]![1]).toEqual(["submitted", "all", "all", null, null, null, 50, 0]);
  });

  it("opens for either deciding requests or entering corrections, and nobody else", async () => {
    granted.permissions = ["attendance.records.manage"];
    expect((await get()).statusCode).toBe(200);
    granted.permissions = ["attendance.reports.read"];
    expect((await get()).statusCode).toBe(403);
  });

  it("rejects an invalid filter", async () => {
    granted.permissions = ["attendance.clarification.manage"];
    expect((await get("?origin=board")).statusCode).toBe(400);
    expect((await get("?pageSize=1000")).statusCode).toBe(400);
  });
});
