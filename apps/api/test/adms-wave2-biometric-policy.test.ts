import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerAdmsWave2AdminRoutes } from "../src/modules/attendance/adms/wave2-admin-routes.js";

const deviceId = "00000000-0000-4000-8000-000000000901";
const accountId = "00000000-0000-4000-8000-000000000902";

const baseConfig = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://wave2-policy-test",
  AUTH_MODE: "local" as const,
  AUTH_ENCRYPTION_KEY: "44".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
  BIOMETRIC_COLLECTION_ENABLED: "0" as const,
};

const enabledConfig = {
  ...baseConfig,
  BIOMETRIC_COLLECTION_ENABLED: "1" as const,
  BIOMETRIC_ACTIVE_KEY_ID: "pilot-v1",
  BIOMETRIC_ENCRYPTION_KEYS: JSON.stringify({ "pilot-v1": "77".repeat(32) }),
};

type PolicyState = {
  deviceId: string;
  lifecycle: "active" | "disabled" | "quarantined";
  deviceCollectionEnabled: boolean;
  enabledAt: Date | null;
  enabledByAccountId: string | null;
};

function createPolicyPool(input: {
  principalType?: "EMPLOYEE" | "SUPER_ADMIN";
  lifecycle?: PolicyState["lifecycle"];
  enabled?: boolean;
}) {
  let state: PolicyState = {
    deviceId,
    lifecycle: input.lifecycle ?? "active",
    deviceCollectionEnabled: input.enabled ?? false,
    enabledAt: input.enabled ? new Date("2026-08-29T01:00:00.000Z") : null,
    enabledByAccountId: input.enabled ? accountId : null,
  };

  const rootQuery = vi.fn(async (sql: string) => {
    if (sql.includes('SELECT DISTINCT role_permission.permission_key AS "permissionKey"')) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM auth_sessions s")) {
      return {
        rows: [
          {
            sessionId: "00000000-0000-4000-8000-000000000903",
            accountId,
            email: "admin@example.org",
            principalType: input.principalType ?? "SUPER_ADMIN",
            expiresAt: new Date("2099-08-29T12:00:00.000Z"),
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("UPDATE auth_sessions SET last_seen_at")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("biometric_collection_enabled AS \"deviceCollectionEnabled\"") && !sql.includes("FOR UPDATE")) {
      return { rows: [state], rowCount: 1 };
    }
    throw new Error(`Unexpected root SQL in Wave 2 biometric policy test: ${sql}`);
  });

  const clientQuery = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: null };
    }
    if (sql.includes("FROM attendance_adms_devices") && sql.includes("FOR UPDATE")) {
      return { rows: [state], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE attendance_adms_devices")) {
      const enabled = Boolean(params?.[1]);
      state = {
        ...state,
        deviceCollectionEnabled: enabled,
        enabledAt: enabled ? new Date("2026-08-29T01:30:00.000Z") : null,
        enabledByAccountId: enabled ? String(params?.[2]) : null,
      };
      return { rows: [state], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO attendance_adms_admin_audit_events")) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected client SQL in Wave 2 biometric policy test: ${sql}`);
  });

  const release = vi.fn();
  const connect = vi.fn(async () => ({ query: clientQuery, release }));
  const pool = { query: rootQuery, connect } as unknown as Pool;
  return { pool, rootQuery, clientQuery, connect, getState: () => state };
}

describe("ATT-005 Wave 2 per-device biometric pilot policy", () => {
  it("reports effective collection OFF when the global gate is OFF", async () => {
    const { pool } = createPolicyPool({ enabled: true });
    const app = Fastify({ logger: false });
    await registerAdmsWave2AdminRoutes(app, pool, baseConfig);

    const response = await app.inject({
      method: "GET",
      url: `/admin/attendance/adms/devices/${deviceId}/biometric-collection-policy`,
      headers: { cookie: "hcis_session=test-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      item: {
        deviceId,
        globalCollectionEnabled: false,
        deviceCollectionEnabled: true,
        effectiveCollectionEnabled: false,
      },
    });
    await app.close();
  });

  it("refuses to enable a device while the global biometric gate is OFF", async () => {
    const { pool, clientQuery } = createPolicyPool({ enabled: false });
    const app = Fastify({ logger: false });
    await registerAdmsWave2AdminRoutes(app, pool, baseConfig);

    const response = await app.inject({
      method: "PATCH",
      url: `/admin/attendance/adms/devices/${deviceId}/biometric-collection-policy`,
      headers: { cookie: "hcis_session=test-token" },
      payload: { enabled: true },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "BIOMETRIC_GLOBAL_COLLECTION_DISABLED" });
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE attendance_adms_devices"))).toBe(false);
    await app.close();
  });

  it("refuses to enable biometric collection on a non-active device", async () => {
    const { pool, clientQuery } = createPolicyPool({ lifecycle: "disabled", enabled: false });
    const app = Fastify({ logger: false });
    await registerAdmsWave2AdminRoutes(app, pool, enabledConfig);

    const response = await app.inject({
      method: "PATCH",
      url: `/admin/attendance/adms/devices/${deviceId}/biometric-collection-policy`,
      headers: { cookie: "hcis_session=test-token" },
      payload: { enabled: true },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "ADMS_DEVICE_INACTIVE" });
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE attendance_adms_devices"))).toBe(false);
    await app.close();
  });

  it("enables one active pilot device and writes append-only admin audit evidence", async () => {
    const { pool, clientQuery, getState } = createPolicyPool({ enabled: false });
    const app = Fastify({ logger: false });
    await registerAdmsWave2AdminRoutes(app, pool, enabledConfig);

    const response = await app.inject({
      method: "PATCH",
      url: `/admin/attendance/adms/devices/${deviceId}/biometric-collection-policy`,
      headers: { cookie: "hcis_session=test-token" },
      payload: { enabled: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      item: {
        deviceId,
        lifecycle: "active",
        globalCollectionEnabled: true,
        deviceCollectionEnabled: true,
        effectiveCollectionEnabled: true,
        enabledByAccountId: accountId,
      },
    });
    expect(getState().deviceCollectionEnabled).toBe(true);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO attendance_adms_admin_audit_events"))).toBe(true);
    await app.close();
  });

  it("rejects employee principals before opening a policy transaction", async () => {
    const { pool, connect } = createPolicyPool({ principalType: "EMPLOYEE" });
    const app = Fastify({ logger: false });
    await registerAdmsWave2AdminRoutes(app, pool, enabledConfig);

    const response = await app.inject({
      method: "PATCH",
      url: `/admin/attendance/adms/devices/${deviceId}/biometric-collection-policy`,
      headers: { cookie: "hcis_session=test-token" },
      payload: { enabled: true },
    });

    expect(response.statusCode).toBe(403);
    expect(connect).not.toHaveBeenCalled();
    await app.close();
  });
});
