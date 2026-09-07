import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerAdmsWave1AdminRoutes } from "../src/modules/attendance/adms/wave1-admin-routes.js";

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://adms-wave1-test",
  AUTH_MODE: "local" as const,
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

const deviceId = "00000000-0000-4000-8000-000000000501";

function createPool(
  principalType: "EMPLOYEE" | "SUPER_ADMIN",
  rangeTargetLifecycle: "active" | "disabled" | null = null,
) {
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
    if (sql.includes("FROM attendance_adms_detected_devices")) {
      return {
        rows: [
          {
            id: "00000000-0000-4000-8000-000000000300",
            serialNumber: "SYNTHETIC-DEVICE-01",
            status: "detected",
            firstSeenAt: new Date("2026-08-28T10:00:00.000Z"),
            lastSeenAt: new Date("2026-08-28T10:05:00.000Z"),
            lastIp: "203.0.113.10",
            observedCount: 3,
            safeMetadata: {},
            claimedDeviceId: null,
            claimedAt: null,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM attendance_adms_commands") && sql.includes("LIMIT 100")) {
      return {
        rows: [
          {
            id: "00000000-0000-4000-8000-000000000601",
            commandNumber: "17",
            commandType: "sync_new",
            reason: "admin_sync_new",
            status: "succeeded",
            attemptCount: 1,
            requestedRangeStart: null,
            requestedRangeEnd: null,
            expiresAt: new Date("2026-08-29T10:00:00.000Z"),
            deliveredAt: new Date("2026-08-28T10:01:00.000Z"),
            acknowledgedAt: new Date("2026-08-28T10:01:01.000Z"),
            completedAt: new Date("2026-08-28T10:01:02.000Z"),
            returnCode: 0,
            createdAt: new Date("2026-08-28T10:00:00.000Z"),
            updatedAt: new Date("2026-08-28T10:01:02.000Z"),
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("SELECT timezone, lifecycle FROM attendance_adms_devices WHERE id = $1")) {
      return rangeTargetLifecycle === null
        ? { rows: [], rowCount: 0 }
        : {
            rows: [{ timezone: "Asia/Jakarta", lifecycle: rangeTargetLifecycle }],
            rowCount: 1,
          };
    }
    throw new Error(`Unexpected SQL in ADMS Wave 1 admin test: ${sql}`);
  });
  return { pool: { query } as unknown as Pool, query };
}

describe("ATT-005 Wave 1 admin authorization", () => {
  it("allows Super Admin to list detected but untrusted devices", async () => {
    const { pool } = createPool("SUPER_ADMIN");
    const app = Fastify({ logger: false });
    await registerAdmsWave1AdminRoutes(app, pool, config);

    const response = await app.inject({
      method: "GET",
      url: "/admin/attendance/adms/detected-devices",
      headers: { cookie: "hcis_session=test-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json().items[0]).toMatchObject({
      serialNumber: "SYNTHETIC-DEVICE-01",
      status: "detected",
      claimedDeviceId: null,
    });
    await app.close();
  });

  it("rejects employee principals before detected-device data is queried", async () => {
    const { pool, query } = createPool("EMPLOYEE");
    const app = Fastify({ logger: false });
    await registerAdmsWave1AdminRoutes(app, pool, config);

    const response = await app.inject({
      method: "GET",
      url: "/admin/attendance/adms/detected-devices",
      headers: { cookie: "hcis_session=test-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("attendance_adms_detected_devices")),
    ).toBe(false);
    await app.close();
  });

  it("does not select or expose raw protocol payloads in command history", async () => {
    const { pool, query } = createPool("SUPER_ADMIN");
    const app = Fastify({ logger: false });
    await registerAdmsWave1AdminRoutes(app, pool, config);

    const response = await app.inject({
      method: "GET",
      url: `/admin/attendance/adms/devices/${deviceId}/commands`,
      headers: { cookie: "hcis_session=test-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json().items[0]).toMatchObject({
      commandNumber: "17",
      commandType: "sync_new",
      reason: "admin_sync_new",
      returnCode: 0,
    });
    const commandHistorySql = query.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes("FROM attendance_adms_commands") && sql.includes("LIMIT 100"));
    expect(commandHistorySql).toBeDefined();
    expect(commandHistorySql).not.toContain("wire_command");
    expect(commandHistorySql).not.toContain("result_command");
    expect(response.body).not.toContain("wireCommand");
    expect(response.body).not.toContain("resultCommand");
    await app.close();
  });

  it("returns 404 for a missing historical-range target and 409 for an inactive target", async () => {
    const missingPool = createPool("SUPER_ADMIN", null);
    const missingApp = Fastify({ logger: false });
    await registerAdmsWave1AdminRoutes(missingApp, missingPool.pool, config);
    const missing = await missingApp.inject({
      method: "POST",
      url: `/admin/attendance/adms/devices/${deviceId}/transfers/attendance-range`,
      headers: {
        cookie: "hcis_session=test-token",
        "content-type": "application/json",
      },
      payload: {
        startAt: "2026-08-27T00:00:00+07:00",
        endAt: "2026-08-28T00:00:00+07:00",
      },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "ADMS_DEVICE_NOT_FOUND" });
    await missingApp.close();

    const inactivePool = createPool("SUPER_ADMIN", "disabled");
    const inactiveApp = Fastify({ logger: false });
    await registerAdmsWave1AdminRoutes(inactiveApp, inactivePool.pool, config);
    const inactive = await inactiveApp.inject({
      method: "POST",
      url: `/admin/attendance/adms/devices/${deviceId}/transfers/attendance-range`,
      headers: {
        cookie: "hcis_session=test-token",
        "content-type": "application/json",
      },
      payload: {
        startAt: "2026-08-27T00:00:00+07:00",
        endAt: "2026-08-28T00:00:00+07:00",
      },
    });
    expect(inactive.statusCode).toBe(409);
    expect(inactive.json()).toMatchObject({ code: "ADMS_DEVICE_NOT_ACTIVE" });
    await inactiveApp.close();
  });
});
