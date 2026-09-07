import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  buildAdmsRecoveryChunks,
  registerAdmsWave1RecoveryRoutes,
} from "../src/modules/attendance/adms/wave1-recovery-routes.js";

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://adms-long-recovery-test",
  AUTH_MODE: "local" as const,
  AUTH_ENCRYPTION_KEY: "44".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
  BIOMETRIC_COLLECTION_ENABLED: "0" as const,
};

const deviceId = "00000000-0000-4000-8000-000000000901";

describe("ATT-005 bounded long-range recovery planning", () => {
  it("splits an inclusive range into non-overlapping chunks no longer than 31 days", () => {
    const chunks = buildAdmsRecoveryChunks(
      new Date("2026-01-01T00:00:00.750Z"),
      new Date("2026-03-15T12:00:00.900Z"),
      31,
    );

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({
      sequence: 1,
      startAt: new Date("2026-01-01T00:00:00.000Z"),
      endAt: new Date("2026-01-31T23:59:59.000Z"),
    });
    expect(chunks[1]?.startAt.getTime() - chunks[0]!.endAt.getTime()).toBe(1_000);
    expect(chunks[2]?.endAt).toEqual(new Date("2026-03-15T12:00:00.000Z"));

    for (const chunk of chunks) {
      expect(chunk.endAt.getTime()).toBeGreaterThanOrEqual(chunk.startAt.getTime());
      expect(chunk.endAt.getTime() - chunk.startAt.getTime()).toBeLessThan(31 * 86_400_000);
    }
  });

  it("rejects employee principals before recovery data is queried", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT DISTINCT role_permission.permission_key AS "permissionKey"')) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM auth_sessions s")) {
        return {
          rows: [
            {
              sessionId: "00000000-0000-4000-8000-000000000100",
              accountId: "00000000-0000-4000-8000-000000000001",
              email: "employee@example.org",
              principalType: "EMPLOYEE",
              expiresAt: new Date("2099-08-31T00:00:00.000Z"),
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE auth_sessions SET last_seen_at")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL in recovery authorization test: ${sql}`);
    });
    const pool = { query } as unknown as Pool;
    const app = Fastify({ logger: false });
    await registerAdmsWave1RecoveryRoutes(app, pool, config);

    const response = await app.inject({
      method: "GET",
      url: `/admin/attendance/adms/devices/${deviceId}/recovery-jobs`,
      headers: { cookie: "hcis_session=test-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("attendance_adms_recovery_jobs"))).toBe(false);
    await app.close();
  });
});
