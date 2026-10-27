import Fastify from "fastify";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AdminPermission } from "../src/modules/auth/permissions.js";

// ATT-014 §20.3 Tanpa Jadwal route (R2a). Synthetic identifiers only; the SQL runs against PostgreSQL in
// attendance-calculation.postgres.test.ts.

const granted = { permissions: [] as AdminPermission[] };

vi.mock("../src/modules/auth/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/auth/service.js")>();
  class FakeAuthService {
    async getSession(token: string | null) {
      if (!token) return null;
      return {
        principal: { id: "00000000-0000-4000-8000-000000020001", email: "hc-unscheduled@example.invalid", principalType: "SUPER_ADMIN" },
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
  DATABASE_URL: "postgres://attendance-unscheduled-test",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
} as ApiConfig;

describe("GET /admin/attendance/unscheduled", () => {
  let app: ReturnType<typeof Fastify>;
  const query = vi.fn<(sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>>(async (sql) => {
    if (sql.includes("FROM attendance_adms_devices device") || sql.includes("JOIN attendance_adms_devices device ON device.id = pins.device_id")) {
      return { rows: [{ deviceId: "d", deviceName: "Mesin Sintetis", pin: "9", scans: 4, firstScanAt: new Date("2026-10-01T00:00:00Z"), lastScanAt: new Date("2026-10-02T00:00:00Z"), status: "unmapped", mappedEmployeeId: null, mappedEmployeeName: null, mappedEmployeeStartedOn: null, mappingEffectiveFrom: null, total: 1 }] };
    }
    return { rows: [{ employeeId: "e", employeeNumber: "SYN-1", employeeName: "Pegawai Sintetis", unitName: "SD", position: "Guru (Half Day)", days: 5, firstDate: "2026-10-01", lastDate: "2026-10-07", earliestLastScan: "12:01", latestLastScan: "12:34", scheduleStartsOn: null, total: 28 }] };
  });

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
    method: "GET", url: `/admin/attendance/unscheduled?${search}`, headers: { cookie: "hcis_session=test-token" },
  });

  it("lists employees without a schedule and hides PINs from accounts without device rights", async () => {
    granted.permissions = ["attendance.reports.read"];
    const response = await get("from=2026-10-01&to=2026-10-26");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json();
    expect(body.employees).toMatchObject({ total: 28, totalPages: 1 });
    expect(body.employees.items[0]).toMatchObject({ position: "Guru (Half Day)", days: 5 });
    expect(body.employees.items[0]).not.toHaveProperty("total");
    expect(body.pins).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("adds unattributed PINs for accounts that may read devices", async () => {
    granted.permissions = ["attendance.reports.read", "attendance.devices.read"];
    const body = (await get("from=2026-10-01&to=2026-10-26&pinPage=2")).json();
    expect(body.pins.items[0]).toMatchObject({ pin: "9", status: "unmapped", firstScanAt: "2026-10-01T00:00:00.000Z" });
    const pinCall = query.mock.calls.find(([sql]) => sql.includes("pins.device_id"));
    expect(pinCall?.[1]?.slice(4)).toEqual([50, 50]);
  });

  it("only reads, and checks the filter and permission before reading", async () => {
    granted.permissions = ["attendance.reports.read", "attendance.devices.read"];
    await get("from=2026-10-01&to=2026-10-26");
    expect(query.mock.calls.filter(([sql]) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql))).toEqual([]);
    query.mockClear();
    expect((await get("from=2026-07-01&to=2026-10-26")).statusCode).toBe(422);
    expect((await get("from=2026-10-01&to=2026-10-26&pageSize=1000")).statusCode).toBe(400);
    granted.permissions = ["attendance.devices.read"];
    expect((await get("from=2026-10-01&to=2026-10-26")).statusCode).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });
});
