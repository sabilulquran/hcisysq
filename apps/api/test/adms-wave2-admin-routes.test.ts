import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerAdmsWave2AdminRoutes } from "../src/modules/attendance/adms/wave2-admin-routes.js";

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://wave2-admin-test",
  AUTH_MODE: "local" as const,
  AUTH_ENCRYPTION_KEY: "33".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
  BIOMETRIC_COLLECTION_ENABLED: "0" as const,
};

const deviceId = "00000000-0000-4000-8000-000000000801";

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
    if (sql === "SELECT id FROM attendance_adms_devices WHERE id = $1") {
      return { rows: [{ id: deviceId }], rowCount: 1 };
    }
    if (sql.includes("count(m.id)::int AS \"activeMappingCount\"")) {
      return {
        rows: [{ deviceId, activeMappingCount: 3, reviewRequiredCount: 1 }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM attendance_adms_device_roster_entries r")) {
      return {
        rows: [
          {
            id: "00000000-0000-4000-8000-000000000811",
            pin: "0042",
            displayName: "Pegawai Synthetic",
            cardNumber: "00001234",
            privilege: "0",
            verifyMode: "1",
            safeMetadata: {},
            firstSeenAt: new Date("2026-08-28T10:00:00.000Z"),
            lastSeenAt: new Date("2026-08-28T10:05:00.000Z"),
            sourceRequestId: "00000000-0000-4000-8000-000000000812",
            mappingId: null,
            employeeId: null,
            employeeNumber: null,
            employeeName: null,
            employeeStatus: null,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM attendance_adms_employee_mappings m") && sql.includes("emp.status AS \"employeeStatus\"")) {
      return {
        rows: [
          {
            mappingId: "00000000-0000-4000-8000-000000000831",
            pin: "0099",
            employeeId: "00000000-0000-4000-8000-000000000832",
            employeeNumber: "YSQ-0099",
            employeeName: "Pegawai Lifecycle Synthetic",
            employeeStatus: "inactive",
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM attendance_biometric_credentials c")) {
      return {
        rows: [
          {
            id: "00000000-0000-4000-8000-000000000821",
            employeeId: "00000000-0000-4000-8000-000000000822",
            employeeNumber: "YSQ-0042",
            employeeName: "Pegawai Synthetic",
            employeeStatus: "active",
            modality: "fingerprint",
            slotIndex: 3,
            vendorFormat: "zkteco-fp-opaque",
            vendorVersion: null,
            originDeviceId: deviceId,
            originDeviceSerial: "SYNTH-DEVICE",
            sourcePin: "0042",
            capturedAt: null,
            importedAt: new Date("2026-08-28T10:05:00.000Z"),
            lifecycle: "active",
            payloadByteLength: 512,
            safeMetadata: { encoding: "base64" },
            createdAt: new Date("2026-08-28T10:05:00.000Z"),
            updatedAt: new Date("2026-08-28T10:05:00.000Z"),
          },
        ],
        rowCount: 1,
      };
    }
    throw new Error(`Unexpected SQL in Wave 2 Admin test: ${sql}`);
  });
  return { pool: { query } as unknown as Pool, query };
}

describe("ATT-005 Wave 2 metadata-only Admin APIs", () => {
  it("returns passive observed roster semantics plus explicit mapping lifecycle facts", async () => {
    const { pool } = createPool("SUPER_ADMIN");
    const app = Fastify({ logger: false });
    await registerAdmsWave2AdminRoutes(app, pool, config);

    const response = await app.inject({
      method: "GET",
      url: `/admin/attendance/adms/devices/${deviceId}/roster`,
      headers: { cookie: "hcis_session=test-token" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      inventorySemantics: "observed_only",
      completeSnapshot: false,
      mappingLifecycle: {
        semantics: "active_explicit_mappings",
        activeMappingCount: 1,
        reviewRequiredCount: 1,
        items: [
          {
            pin: "0099",
            employeeStatus: "inactive",
          },
        ],
      },
      items: [{ pin: "0042", mappingStatus: "unmapped" }],
    });
    expect(body.note).toContain("Absennya PIN tidak membuktikan user tidak ada di mesin");
    expect(body.note).toContain("active USERINFO reads telah dipensiunkan");
    await app.close();
  });

  it("returns lightweight mapping review counts without roster or biometric data", async () => {
    const { pool, query } = createPool("SUPER_ADMIN");
    const app = Fastify({ logger: false });
    await registerAdmsWave2AdminRoutes(app, pool, config);

    const response = await app.inject({
      method: "GET",
      url: `/admin/attendance/adms/devices/${deviceId}/mapping-lifecycle-summary`,
      headers: { cookie: "hcis_session=test-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      item: { deviceId, activeMappingCount: 3, reviewRequiredCount: 1 },
    });
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("attendance_adms_device_roster_entries")),
    ).toBe(false);
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("attendance_biometric_credentials")),
    ).toBe(false);
    await app.close();
  });

  it("never selects or returns biometric payload envelope/hash/key material", async () => {
    const { pool, query } = createPool("SUPER_ADMIN");
    const app = Fastify({ logger: false });
    await registerAdmsWave2AdminRoutes(app, pool, config);

    const response = await app.inject({
      method: "GET",
      url: "/admin/attendance/adms/biometrics?modality=fingerprint",
      headers: { cookie: "hcis_session=test-token" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ collectionEnabled: false, rawPayloadExposed: false });
    expect(JSON.stringify(body)).not.toMatch(/ciphertext|payloadSha256|authTag|encryptionKeyId|payloadIv/i);

    const biometricSql = query.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes("FROM attendance_biometric_credentials c"));
    expect(biometricSql).toBeDefined();
    expect(biometricSql).not.toMatch(/payload_ciphertext|payload_sha256|payload_iv|payload_auth_tag|encryption_key_id/i);
    await app.close();
  });

  it("rejects employee principals before roster or biometric tables are queried", async () => {
    const { pool, query } = createPool("EMPLOYEE");
    const app = Fastify({ logger: false });
    await registerAdmsWave2AdminRoutes(app, pool, config);

    const response = await app.inject({
      method: "GET",
      url: "/admin/attendance/adms/biometrics",
      headers: { cookie: "hcis_session=test-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("attendance_biometric_credentials")),
    ).toBe(false);
    await app.close();
  });
});
