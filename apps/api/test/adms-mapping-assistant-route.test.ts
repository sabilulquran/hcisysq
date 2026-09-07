import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerAdmsWave2MappingAssistantRoutes } from "../src/modules/attendance/adms/wave2-mapping-assistant-routes.js";

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://mapping-assistant-test",
  AUTH_MODE: "local" as const,
  AUTH_ENCRYPTION_KEY: "55".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

const deviceId = "00000000-0000-4000-8000-000000000901";

function createPool(principalType: "SUPER_ADMIN" | "EMPLOYEE" = "SUPER_ADMIN") {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('SELECT DISTINCT role_permission.permission_key AS "permissionKey"')) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM auth_sessions s")) {
      return {
        rows: [{
          sessionId: "00000000-0000-4000-8000-000000000100",
          accountId: "00000000-0000-4000-8000-000000000001",
          email: principalType === "SUPER_ADMIN" ? "admin@example.org" : "employee@example.org",
          principalType,
          expiresAt: new Date("2099-08-28T12:00:00.000Z"),
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("UPDATE auth_sessions SET last_seen_at")) return { rows: [], rowCount: 1 };
    if (sql.includes("SELECT id, lifecycle FROM attendance_adms_devices")) {
      return { rows: [{ id: deviceId, lifecycle: "active" }], rowCount: 1 };
    }
    if (sql.includes("WITH raw AS")) {
      return {
        rows: [{
          pin: "205291319",
          eventCount: 2,
          firstEventAt: new Date("2026-08-28T14:20:48.000Z"),
          lastEventAt: new Date("2026-08-29T23:19:26.000Z"),
          rosterDisplayName: "Muhammad Kamal Faza",
          cardNumber: "3576446775",
          privilege: "0",
          verifyMode: null,
          rosterObservedAt: new Date("2026-08-30T01:36:08.000Z"),
          rosterSourceRequestId: "00000000-0000-4000-8000-000000000777",
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM employees e")) {
      return {
        rows: [
          {
            id: "00000000-0000-4000-8000-000000000201",
            employeeNumber: "EMP-201",
            fullName: "Muhammad Kamal Faza",
            unitName: "SDIT",
            positionName: "Guru",
          },
          {
            id: "00000000-0000-4000-8000-000000000202",
            employeeNumber: "EMP-202",
            fullName: "Siti Aminah",
            unitName: "SDIT",
            positionName: "Guru",
          },
        ],
        rowCount: 2,
      };
    }
    throw new Error(`Unexpected SQL in mapping assistant route test: ${sql}`);
  });
  return { pool: { query } as unknown as Pool, query };
}

describe("ATT-005 mapping assistant Admin route", () => {
  it("returns name-only suggestions without mutating mapping state", async () => {
    const { pool, query } = createPool();
    const app = Fastify({ logger: false });
    await registerAdmsWave2MappingAssistantRoutes(app, pool, config);

    const response = await app.inject({
      method: "GET",
      url: `/admin/attendance/adms/devices/${deviceId}/mapping-assistant`,
      headers: { cookie: "hcis_session=test-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      autoMapping: false,
      scoring: { basis: "name_only", candidateLimit: 5, minimumSimilarity: 35 },
      items: [{
        pin: "205291319",
        rosterDisplayName: "Muhammad Kamal Faza",
        requiresUserInfo: false,
        candidates: [{
          employeeNumber: "EMP-201",
          fullName: "Muhammad Kamal Faza",
          similarity: 100,
          matchKind: "exact_name",
        }],
      }],
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO attendance_adms_employee_mappings"))).toBe(false);
    await app.close();
  });

  it("rejects non-Super-Admin principals before reading device inventory", async () => {
    const { pool, query } = createPool("EMPLOYEE");
    const app = Fastify({ logger: false });
    await registerAdmsWave2MappingAssistantRoutes(app, pool, config);

    const response = await app.inject({
      method: "GET",
      url: `/admin/attendance/adms/devices/${deviceId}/mapping-assistant`,
      headers: { cookie: "hcis_session=test-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("attendance_adms_devices"))).toBe(false);
    await app.close();
  });
});
