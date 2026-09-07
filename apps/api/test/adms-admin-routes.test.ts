import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerAdmsAdminRoutes } from "../src/modules/attendance/adms/admin-routes.js";

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://adms-admin-test",
  AUTH_MODE: "local" as const,
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

function createPool(principalType: "EMPLOYEE" | "SUPER_ADMIN") {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('SELECT DISTINCT role_permission.permission_key AS "permissionKey"')) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM auth_sessions s")) {
      return {
        rows: [
          {
            sessionId: "00000000-0000-4000-8000-000000000100",
            accountId: "00000000-0000-4000-8000-000000000001",
            email: principalType === "SUPER_ADMIN" ? "admin@example.org" : "employee@example.org",
            principalType,
            expiresAt: new Date("2099-08-28T12:00:00.000Z"),
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("UPDATE auth_sessions SET last_seen_at")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM attendance_adms_devices d")) {
      return {
        rows: [
          {
            id: "00000000-0000-4000-8000-000000000200",
            serialNumber: "SPK7245000738",
            displayName: "Synthetic Fingerprint",
            lifecycle: "active",
            timezone: "Asia/Jakarta",
            model: null,
            firmwareVersion: null,
            firstSeenAt: null,
            lastSeenAt: null,
            lastSuccessfulRequestAt: null,
            lastIp: null,
            createdAt: new Date("2026-08-28T00:00:00.000Z"),
            updatedAt: new Date("2026-08-28T00:00:00.000Z"),
            activeMappingCount: 0,
            unmappedPinCount: 0,
          },
        ],
        rowCount: 1,
      };
    }
    throw new Error(`Unexpected SQL in ADMS admin test: ${sql}`);
  });
  return { pool: { query } as unknown as Pool, query };
}

describe("ATT-004 ADMS admin authorization", () => {
  it("allows Super Admin to list machine registry", async () => {
    const { pool } = createPool("SUPER_ADMIN");
    const app = Fastify({ logger: false });
    await registerAdmsAdminRoutes(app, pool, config);

    const response = await app.inject({
      method: "GET",
      url: "/admin/attendance/adms/devices",
      headers: { cookie: "hcis_session=test-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json().items[0]).toMatchObject({
      serialNumber: "SPK7245000738",
      lifecycle: "active",
    });
    await app.close();
  });

  it("rejects employee principals before device data is queried", async () => {
    const { pool, query } = createPool("EMPLOYEE");
    const app = Fastify({ logger: false });
    await registerAdmsAdminRoutes(app, pool, config);

    const response = await app.inject({
      method: "GET",
      url: "/admin/attendance/adms/devices",
      headers: { cookie: "hcis_session=test-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("FROM attendance_adms_devices d")),
    ).toBe(false);
    await app.close();
  });
});
