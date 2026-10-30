// EMP-005 S2B: menandai dan melepas tanda "di luar pengelolaan HCIS", dan
// penolakan setiap jalur tulis terhadap baris yang ditandai (spec §8.7).
// Fake pool; data sintetis.
//
// Yang hanya dapat dibuktikan basis data sungguhan — CHECK pasangan alasan,
// penandanya, dan bahwa daftar menyembunyikannya — ada di
// employee-management-scope.integration.test.ts.

import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerEmployeeManagementScopeRoutes } from "../src/modules/employees/employee-management-scope-routes.js";

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://management-scope-test",
  AUTH_MODE: "local" as const,
  AUTH_ENCRYPTION_KEY: "55".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

const EMPLOYEE_ID = "10000000-0000-4000-8000-000000000001";

type Persona = "anonymous" | "employee" | "reader" | "hc";

const PERMISSIONS: Record<Persona, string[]> = {
  anonymous: [],
  employee: [],
  reader: ["employees.read.all"],
  hc: ["employees.read.all", "employees.manage"],
};

interface PoolOptions {
  employeeMissing?: boolean;
  /** What the record's scope is before the request. */
  current?: "MANAGED" | "OUTSIDE_HCIS";
  currentReason?: string;
  currentNote?: string;
  payload?: object;
}

function createPool(persona: Persona, options: PoolOptions = {}) {
  const writes: string[] = [];
  const audits: Record<string, unknown>[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM auth_sessions s")) {
      if (persona === "anonymous") return { rows: [], rowCount: 0 };
      return {
        rows: [{
          sessionId: "00000000-0000-4000-8000-000000000100",
          accountId: "00000000-0000-4000-8000-000000000001",
          email: "persona@example.org",
          principalType: "EMPLOYEE",
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("UPDATE auth_sessions SET last_seen_at")) return { rows: [], rowCount: 1 };
    if (sql.includes('SELECT DISTINCT role_permission.permission_key AS "permissionKey"')) {
      const keys = PERMISSIONS[persona];
      return { rows: keys.map((permissionKey) => ({ permissionKey })), rowCount: keys.length };
    }
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM employees WHERE id = $1")) {
      if (options.employeeMissing) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          id: EMPLOYEE_ID,
          employeeNumber: "YSQ-0001",
          fullName: "Pegawai Sintetis",
          managementScope: options.current ?? "MANAGED",
          managementScopeReason: options.current === "OUTSIDE_HCIS" ? (options.currentReason ?? "BUMY") : null,
          managementScopeNote: options.current === "OUTSIDE_HCIS" ? (options.currentNote ?? null) : null,
          managementScopeMarkedAt: null,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("UPDATE employees")) {
      writes.push(`SCOPE ${String(values?.[1])}`);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO access_audit_events")) {
      writes.push("INSERT audit");
      audits.push(JSON.parse(String(values?.[3])) as Record<string, unknown>);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL in management scope test: ${sql}`);
  });
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  return { pool, query, writes, audits };
}

async function call(persona: Persona, options: PoolOptions = {}) {
  const { pool, writes, audits, query } = createPool(persona, options);
  const app = Fastify({ logger: false });
  await registerEmployeeManagementScopeRoutes(app, pool, config);
  const response = await app.inject({
    method: "PUT",
    url: `/admin/employees/${EMPLOYEE_ID}/management-scope`,
    headers: persona === "anonymous" ? {} : { cookie: "hcis_session=test-token" },
    ...(options.payload ? { payload: options.payload } : {}),
  });
  await app.close();
  return { response, writes, audits, query };
}

const MARK = { managementScope: "OUTSIDE_HCIS", reason: "BUMY", note: "Staf BUMY, dikonfirmasi HC" };
const UNMARK = { managementScope: "MANAGED", note: "Salah tanda, pegawai yayasan" };

describe("EMP-005 S2B who may mark", () => {
  it("refuses anonymous, an ordinary employee, and an account that may only read", async () => {
    expect((await call("anonymous", { payload: MARK })).response.statusCode).toBe(401);
    expect((await call("employee", { payload: MARK })).response.json()).toMatchObject({ code: "FORBIDDEN" });
    const reader = await call("reader", { payload: MARK });
    expect(reader.response.statusCode).toBe(403);
    expect(reader.writes).toEqual([]);
  });
});

describe("EMP-005 S2B marking", () => {
  it("marks a record with its reason and audits the change", async () => {
    const { response, writes, audits } = await call("hc", { payload: MARK });
    expect(response.statusCode).toBe(200);
    expect(writes).toEqual(["SCOPE OUTSIDE_HCIS", "INSERT audit"]);
    expect(audits[0]).toMatchObject({ from: "MANAGED", to: "OUTSIDE_HCIS", reason: "BUMY" });
    // The note says why in the officer's words; the audit carries its length.
    expect(JSON.stringify(audits[0])).not.toContain("dikonfirmasi HC");
  });

  it("refuses a mark with no reason, and one with a reason we do not know", async () => {
    const noReason = await call("hc", { payload: { managementScope: "OUTSIDE_HCIS", note: "Tanpa alasan" } });
    expect(noReason.response.statusCode).toBe(400);
    expect(noReason.writes).toEqual([]);
    const unknown = await call("hc", { payload: { ...MARK, reason: "LAINNYA" } });
    expect(unknown.response.statusCode).toBe(400);
    expect(unknown.writes).toEqual([]);
  });

  it("refuses a mark with no note, because nobody could explain it later", async () => {
    const { response, writes } = await call("hc", { payload: { managementScope: "OUTSIDE_HCIS", reason: "BUMY" } });
    expect(response.statusCode).toBe(400);
    expect(writes).toEqual([]);
  });

  it("unmarks with a reason, clearing the marker rather than keeping a stale one", async () => {
    const { response, writes, audits } = await call("hc", { current: "OUTSIDE_HCIS", payload: UNMARK });
    expect(response.statusCode).toBe(200);
    expect(writes).toEqual(["SCOPE MANAGED", "INSERT audit"]);
    expect(audits[0]).toMatchObject({ from: "OUTSIDE_HCIS", to: "MANAGED", reason: null });
  });

  it("corrects a wrong reason without unmarking first", async () => {
    // Unmark-then-remark would throw away when the record was first marked
    // and by whom, so a correction has to be allowed in place.
    const { response, writes } = await call("hc", {
      current: "OUTSIDE_HCIS", currentReason: "BUMY", currentNote: MARK.note,
      payload: { ...MARK, reason: "PENGURUS_YAYASAN" },
    });
    expect(response.statusCode).toBe(200);
    expect(writes).toEqual(["SCOPE OUTSIDE_HCIS", "INSERT audit"]);
  });

  it("refuses a reason on an unmark instead of dropping it silently", async () => {
    const { response, writes } = await call("hc", {
      current: "OUTSIDE_HCIS", payload: { ...UNMARK, reason: "BUMY" },
    });
    expect(response.statusCode).toBe(400);
    expect(writes).toEqual([]);
  });

  it("refuses a change that changes nothing, and an unknown employee", async () => {
    const same = await call("hc", {
      current: "OUTSIDE_HCIS", currentReason: "BUMY", currentNote: MARK.note, payload: MARK,
    });
    expect(same.response.statusCode).toBe(409);
    expect(same.response.json()).toMatchObject({ code: "MANAGEMENT_SCOPE_UNCHANGED" });
    expect(same.writes).toEqual([]);

    const missing = await call("hc", { employeeMissing: true, payload: MARK });
    expect(missing.response.statusCode).toBe(404);
    expect(missing.writes).toEqual([]);
  });

  it("locks the record before deciding, so two officers cannot both mark it", async () => {
    const { query } = await call("hc", { payload: MARK });
    const order = query.mock.calls.map(([sql]) => String(sql));
    const begin = order.findIndex((sql) => /^\s*BEGIN/.test(sql));
    const lock = order.findIndex((sql) => sql.includes("FOR UPDATE"));
    const write = order.findIndex((sql) => sql.includes("UPDATE employees"));
    expect(lock).toBeGreaterThan(begin);
    expect(write).toBeGreaterThan(lock);
  });
});
