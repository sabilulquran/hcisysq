import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerAdmsWave1OpsRoutes } from "../src/modules/attendance/adms/wave1-ops-routes.js";

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://adms-wave1-ops-test",
  AUTH_MODE: "local" as const,
  AUTH_ENCRYPTION_KEY: "22".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

const deviceId = "00000000-0000-4000-8000-000000000501";

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
    if (sql.includes("metadata -> 'transportObserved'")) {
      return {
        rows: [
          {
            deviceId,
            model: "K40",
            firmwareVersion: "ZMM510-NF28VA-Ver2.0.16",
            transportObserved: { pushver: "3.1.2", language: "69", observedAt: "2026-08-28T17:00:00.000Z" },
            firstSeenAt: new Date("2026-08-28T16:00:00.000Z"),
            lastSeenAt: new Date("2026-08-28T17:00:00.000Z"),
            lastSuccessfulRequestAt: new Date("2026-08-28T17:00:00.000Z"),
            lastIp: "203.0.113.20",
          },
        ],
        rowCount: 1,
      };
    }
    if (sql === "SELECT id FROM attendance_adms_devices WHERE id = $1") {
      return { rows: [{ id: deviceId }], rowCount: 1 };
    }
    if (sql.includes("coverage.\"currentPersistedCount\"")) {
      return {
        rows: [
          {
            commandId: "00000000-0000-4000-8000-000000000601",
            commandNumber: "12",
            status: "succeeded",
            requestedRangeStart: new Date("2026-08-01T00:00:00.000Z"),
            requestedRangeEnd: new Date("2026-08-02T00:00:00.000Z"),
            deliveredAt: new Date("2026-08-28T16:30:00.000Z"),
            completedAt: new Date("2026-08-28T16:31:00.000Z"),
            createdAt: new Date("2026-08-28T16:29:00.000Z"),
            currentPersistedCount: 24,
            persistedSinceDeliveryCount: 6,
            firstOccurredAt: new Date("2026-08-01T01:00:00.000Z"),
            lastOccurredAt: new Date("2026-08-01T23:00:00.000Z"),
            attlogRequestCount: 2,
          },
        ],
        rowCount: 1,
      };
    }
    throw new Error(`Unexpected SQL in ADMS Wave 1 ops test: ${sql}`);
  });
  return { pool: { query } as unknown as Pool, query };
}

describe("ATT-005 Wave 1 operations", () => {
  it("exposes only safe registered-device transport telemetry to Super Admin", async () => {
    const { pool } = createPool("SUPER_ADMIN");
    const app = Fastify({ logger: false });
    await registerAdmsWave1OpsRoutes(app, pool, config);

    const response = await app.inject({
      method: "GET",
      url: `/admin/attendance/adms/devices/${deviceId}/telemetry`,
      headers: { cookie: "hcis_session=test-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json().item).toMatchObject({
      deviceId,
      lastIp: "203.0.113.20",
      transportObserved: { pushver: "3.1.2" },
    });
    await app.close();
  });

  it("counts persisted and duplicate-only ATTLOG request evidence within each command delivery window", async () => {
    const { pool, query } = createPool("SUPER_ADMIN");
    const app = Fastify({ logger: false });
    await registerAdmsWave1OpsRoutes(app, pool, config);

    const response = await app.inject({
      method: "GET",
      url: `/admin/attendance/adms/devices/${deviceId}/reconciliation`,
      headers: { cookie: "hcis_session=test-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      coverageBasis: "persisted_range",
      expectedCount: null,
      duplicatesObserved: null,
      items: [{
        currentPersistedCount: 24,
        persistedSinceDeliveryCount: 6,
        attlogRequestCount: 2,
      }],
    });

    const reconciliationSql = query.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes("coverage.\"currentPersistedCount\""));

    expect(reconciliationSql).toContain("SELECT min(c2.delivered_at) AS \"nextDeliveredAt\"");
    expect(reconciliationSql).toContain("r.received_at < next_delivery.\"nextDeliveredAt\"");
    expect(reconciliationSql).toContain("e.source_request_id = r.id");
    expect(reconciliationSql).toContain("q.reason = 'DUPLICATE_EXACT'");
    expect(reconciliationSql).toContain("q.details ->> 'eventIdentityHash'");
    expect(reconciliationSql).toContain("duplicate_event.event_identity_hash");
    expect(reconciliationSql).toContain("duplicate_event.occurred_at >= c.requested_range_start");
    expect(reconciliationSql).toContain("duplicate_event.occurred_at <= c.requested_range_end");
    await app.close();
  });

  it("rejects employee principals before telemetry is queried", async () => {
    const { pool, query } = createPool("EMPLOYEE");
    const app = Fastify({ logger: false });
    await registerAdmsWave1OpsRoutes(app, pool, config);

    const response = await app.inject({
      method: "GET",
      url: `/admin/attendance/adms/devices/${deviceId}/telemetry`,
      headers: { cookie: "hcis_session=test-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("transportObserved")),
    ).toBe(false);
    await app.close();
  });
});
