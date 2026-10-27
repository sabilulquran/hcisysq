import Fastify from "fastify";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AdminPermission } from "../src/modules/auth/permissions.js";

// ATT-014 §20.2 tab Pengecualian (R2b). Synthetic identifiers only.

const granted = { permissions: [] as AdminPermission[] };

vi.mock("../src/modules/auth/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/auth/service.js")>();
  class FakeAuthService {
    async getSession(token: string | null) {
      if (!token) return null;
      return {
        principal: { id: "00000000-0000-4000-8000-000000023001", email: "hc-exceptions@example.invalid", principalType: "SUPER_ADMIN" },
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
  DATABASE_URL: "postgres://attendance-exceptions-test",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
} as ApiConfig;

describe("GET /admin/attendance/exceptions", () => {
  let app: ReturnType<typeof Fastify>;
  const query = vi.fn<(sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>>(async () => ({
    rows: [
      { kind: "leave", id: "l", employeeId: "e", employeeNumber: "SYN-1", employeeName: "Pegawai Sintetis", unitName: "SD", startOn: "2026-10-05", endOn: "2026-10-06", type: "sick", mode: null, origin: null, status: "approved", reason: null, total: 2 },
      { kind: "clarification", id: "c", employeeId: "e", employeeNumber: "SYN-1", employeeName: "Pegawai Sintetis", unitName: "SD", startOn: "2026-10-07", endOn: "2026-10-07", type: "lateness", mode: "justification", origin: "hc", status: "approved", reason: "Rapat", total: 2 },
    ],
  }));

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T10:00:00+07:00"));
    query.mockClear();
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
    method: "GET", url: `/admin/attendance/exceptions?${search}`, headers: { cookie: "hcis_session=test-token" },
  });

  it("pages leave and clarifications with the standard envelope and names the leave policy", async () => {
    granted.permissions = ["attendance.reports.read"];
    const response = await get("from=2026-10-01&to=2026-10-26&unitId=00000000-0000-4000-8000-000000023002");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({ page: 1, pageSize: 25, total: 2, pageCount: 1 });
    expect(response.json().items[0]).toMatchObject({ kind: "leave", typeName: "Cuti Sakit" });
    expect(response.json().items[1]).toMatchObject({ kind: "clarification", typeName: null, origin: "hc" });
    expect(response.json().items[0]).not.toHaveProperty("total");
    const values = query.mock.calls[0]![1]!;
    expect(values).toEqual(["2026-10-01", "2026-10-26", null, "00000000-0000-4000-8000-000000023002", 25, 0]);
  });

  it("rejects a page size above the standard and a range above 93 days, and requires reports.read", async () => {
    granted.permissions = ["attendance.reports.read"];
    expect((await get("from=2026-10-01&to=2026-10-26&pageSize=101")).statusCode).toBe(400);
    expect((await get("from=2026-01-01&to=2026-10-26")).statusCode).toBe(422);
    granted.permissions = ["attendance.records.manage"];
    expect((await get("from=2026-10-01&to=2026-10-26")).statusCode).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });
});
