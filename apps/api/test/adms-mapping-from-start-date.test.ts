import Fastify from "fastify";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AdminPermission } from "../src/modules/auth/permissions.js";

// ADMS-R2c (ATT-014 §20.5): PIN mappings start at the employee's TMT. Synthetic identifiers only.

const granted = { permissions: [] as AdminPermission[] };

vi.mock("../src/modules/auth/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/auth/service.js")>();
  class FakeAuthService {
    async getSession(token: string | null) {
      if (!token) return null;
      return {
        principal: { id: "00000000-0000-4000-8000-000000022001", email: "hc-pin@example.invalid", principalType: "SUPER_ADMIN" },
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      };
    }
    async getAuthorizationContext() {
      return { organizationPermissions: [...granted.permissions] };
    }
  }
  return { ...actual, AuthService: FakeAuthService };
});

const { registerAdmsAdminRoutes } = await import("../src/modules/attendance/adms/admin-routes.js");

const config = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://adms-r2c-test",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
} as ApiConfig;

const DEVICE = "00000000-0000-4000-8000-000000022002";
const EMPLOYEE = "00000000-0000-4000-8000-000000022003";
const MAPPING = "00000000-0000-4000-8000-000000022004";

const planRow = {
  mappingId: MAPPING, deviceId: DEVICE, deviceName: "Synthetic Device", pin: "7", employeeId: EMPLOYEE,
  employeeNumber: "SYN-1", employeeName: "Synthetic Employee", startedOn: "2025-07-01",
  currentFrom: new Date("2026-10-19T04:38:00.000Z"), targetFrom: new Date("2025-06-30T17:00:00.000Z"),
  effectiveTo: null, scansAdded: 120, scansRemoved: 0, overlaps: false,
};

describe("ADMS-R2c mapping from TMT", () => {
  let app: ReturnType<typeof Fastify>;
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  let startedOn: string | null = "2025-07-01";
  const respond = async (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    if (sql.includes("FROM attendance_adms_devices") && sql.includes("WHERE id = $1")) {
      return { rows: [{ id: DEVICE, serialNumber: "SYN", lifecycle: "active", createdAt: new Date(), updatedAt: new Date() }] };
    }
    if (sql.includes("FROM employees WHERE id = $1 FOR UPDATE")) {
      return { rows: [{ id: EMPLOYEE, status: "active", startedOn }] };
    }
    if (sql.includes("SELECT greatest(")) return { rows: [{ effectiveFrom: new Date("2025-06-30T17:00:00.000Z") }] };
    if (sql.includes("INSERT INTO attendance_adms_employee_mappings")) return { rows: [{ id: MAPPING, effectiveFrom: values[4] }] };
    if (sql.includes("WITH base AS")) return { rows: [planRow] };
    return { rows: [] };
  };
  const clientQuery = vi.fn(respond);
  const poolQuery = vi.fn(respond);
  const connect = vi.fn(async () => ({ query: clientQuery, release: vi.fn() }));

  beforeEach(async () => {
    statements.length = 0;
    clientQuery.mockClear();
    poolQuery.mockClear();
    connect.mockClear();
    startedOn = "2025-07-01";
    granted.permissions = ["attendance.devices.operate"];
    app = Fastify({ logger: false });
    await registerAdmsAdminRoutes(app, { query: poolQuery, connect } as unknown as Pool, config);
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url, headers: { cookie: "hcis_session=test-token" }, payload });

  it("creates a mapping from TMT 00:00 WIB instead of now, ignoring a free start", async () => {
    const response = await post(`/admin/attendance/adms/devices/${DEVICE}/mappings`, { pin: "7", employeeId: EMPLOYEE, effectiveFrom: "2026-10-26T00:00:00+07:00" });
    expect(response.statusCode, response.body).toBe(201);
    const start = statements.find((item) => item.sql.includes("SELECT greatest("))!;
    expect(start.values).toEqual(["2025-07-01", DEVICE, "7"]);
    const insert = statements.find((item) => item.sql.includes("INSERT INTO attendance_adms_employee_mappings"))!;
    expect(insert.values[4]).toEqual(new Date("2025-06-30T17:00:00.000Z"));
  });

  it("refuses an employee without TMT", async () => {
    startedOn = null;
    const response = await post(`/admin/attendance/adms/devices/${DEVICE}/mappings`, { pin: "7", employeeId: EMPLOYEE });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("EMPLOYEE_START_DATE_MISSING");
    expect(statements.some((item) => item.sql.includes("INSERT INTO attendance_adms_employee_mappings"))).toBe(false);
  });

  it("previews without writing", async () => {
    const response = await post("/admin/attendance/adms/mappings/align-to-start-date", { mappingIds: [MAPPING] });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ applied: false, summary: { change: 1, scansAdded: 120 } });
    expect(connect).not.toHaveBeenCalled();
    expect(statements.some((item) => /UPDATE|INSERT/.test(item.sql))).toBe(false);
  });

  it("applies with a reason, locking first and auditing the previous start", async () => {
    expect((await post("/admin/attendance/adms/mappings/align-to-start-date", { mappingIds: [MAPPING], apply: true })).statusCode).toBe(400);
    const response = await post("/admin/attendance/adms/mappings/align-to-start-date", { mappingIds: [MAPPING], apply: true, reason: "Sejak TMT" });
    expect(response.statusCode, response.body).toBe(200);
    const sqls = statements.map((item) => item.sql);
    const lock = sqls.findIndex((sql) => sql.includes("FOR UPDATE"));
    const update = sqls.findIndex((sql) => sql.startsWith("UPDATE attendance_adms_employee_mappings"));
    expect(lock).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(lock);
    const audit = statements.find((item) => item.sql.includes("'mapping_aligned_to_start_date'"))!;
    expect(JSON.parse(String(audit.values[4]))).toEqual({ effectiveFrom: "2026-10-19T04:38:00.000Z" });
    expect(JSON.parse(String(audit.values[5]))).toMatchObject({ effectiveFrom: "2025-06-30T17:00:00.000Z", reason: "Sejak TMT" });
    expect(sqls).toContain("COMMIT");
  });

  it("requires attendance.devices.operate", async () => {
    granted.permissions = ["attendance.devices.read"];
    expect((await post("/admin/attendance/adms/mappings/align-to-start-date", { mappingIds: [MAPPING] })).statusCode).toBe(403);
    expect((await post(`/admin/attendance/adms/mappings/${MAPPING}/revert-alignment`, { reason: "Kembalikan" })).statusCode).toBe(403);
    expect(poolQuery).not.toHaveBeenCalled();
  });
});
