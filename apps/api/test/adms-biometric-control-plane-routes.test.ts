import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerAdmsBiometricControlPlaneRoutes } from "../src/modules/attendance/adms/biometric-control-plane-routes.js";

const deviceId = "00000000-0000-4000-8000-000000000951";
const accountId = "00000000-0000-4000-8000-000000000952";

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://biometric-control-plane-test",
  AUTH_MODE: "local" as const,
  AUTH_ENCRYPTION_KEY: "99".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
  BIOMETRIC_COLLECTION_ENABLED: "0" as const,
};

function createPool(principalType: "SUPER_ADMIN" | "EMPLOYEE" = "SUPER_ADMIN") {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('SELECT DISTINCT role_permission.permission_key AS "permissionKey"')) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM auth_sessions s")) {
      return {
        rows: [{
          sessionId: "00000000-0000-4000-8000-000000000953",
          accountId,
          email: "admin@example.invalid",
          principalType,
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("UPDATE auth_sessions SET last_seen_at")) return { rows: [], rowCount: 1 };
    if (sql === "SELECT id FROM attendance_adms_devices WHERE id = $1") {
      return { rows: [{ id: deviceId }], rowCount: 1 };
    }
    if (sql.includes("FROM attendance_biometric_credentials c") && sql.includes("count(DISTINCT c.employee_id)")) {
      return {
        rows: [{
          totalCount: 0,
          activeCount: 0,
          retiredCount: 0,
          destroyedCount: 0,
          employeeCount: 0,
          fingerprintCount: 0,
          faceCount: 0,
          palmCount: 0,
          bioPhotoCount: 0,
          lifecycleReviewRequiredCount: 0,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM attendance_biometric_device_states")) {
      return {
        rows: [{
          unknownCount: 0,
          missingCount: 0,
          presentCount: 0,
          staleCount: 0,
          conflictCount: 0,
          pendingCount: 0,
          succeededCount: 0,
          failedCount: 0,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("biometric_collection_enabled AS \"deviceCollectionEnabled\"")) {
      return {
        rows: [{
          id: deviceId,
          serialNumber: "SYNTH-BIO-DEVICE",
          displayName: "Synthetic Device",
          model: "Synthetic",
          firmwareVersion: "test",
          lifecycle: "active",
          deviceCollectionEnabled: false,
        }],
        rowCount: 1,
      };
    }
    throw new Error(`Unexpected SQL in biometric control plane route test: ${sql}`);
  });
  const connect = vi.fn();
  return { pool: { query, connect } as unknown as Pool, query, connect };
}

describe("ATT-005 biometric control plane routes", () => {
  it("returns safe fail-closed readiness metadata to SUPER_ADMIN", async () => {
    const { pool } = createPool();
    const app = Fastify({ logger: false });
    await registerAdmsBiometricControlPlaneRoutes(app, pool, config);

    const response = await app.inject({
      method: "GET",
      url: `/admin/attendance/adms/biometric-control-plane?deviceId=${deviceId}`,
      headers: { cookie: "hcis_session=test-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      item: {
        rawPayloadExposed: false,
        collection: { globalEnabled: false, deviceEnabled: false, effectiveEnabled: false },
        keyring: { configured: false, ready: false, configuredKeyCount: 0 },
        retention: { automaticDestructionEnabled: false, masterDestroyEnabled: false },
      },
    });
    const serialized = response.body;
    expect(serialized).not.toContain("ciphertext");
    expect(serialized).not.toContain("payloadSha256");
    expect(serialized).not.toContain("encryptionKeyId");
    await app.close();
  });

  it("rejects employee principals before reading vault metadata", async () => {
    const { pool, query } = createPool("EMPLOYEE");
    const app = Fastify({ logger: false });
    await registerAdmsBiometricControlPlaneRoutes(app, pool, config);

    const response = await app.inject({
      method: "GET",
      url: `/admin/attendance/adms/biometric-control-plane?deviceId=${deviceId}`,
      headers: { cookie: "hcis_session=test-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("FROM attendance_biometric_credentials"))).toBe(false);
    await app.close();
  });

  it("blocks re-encryption while maintenance keyring is absent without opening a DB transaction", async () => {
    const { pool, connect } = createPool();
    const app = Fastify({ logger: false });
    await registerAdmsBiometricControlPlaneRoutes(app, pool, config);

    const response = await app.inject({
      method: "POST",
      url: "/admin/attendance/adms/biometric-control-plane/reencrypt",
      headers: { cookie: "hcis_session=test-token" },
      payload: { confirmation: "REENCRYPT_VAULT", limit: 25 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "BIOMETRIC_KEYRING_NOT_READY" });
    expect(connect).not.toHaveBeenCalled();
    await app.close();
  });
});
