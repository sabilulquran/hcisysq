// EMP-005/EMP-006 S2 routes: permission positive/negative cases (EMP-PKG1-X1),
// mode gating, and Super Admin exclusion. Fake pool; synthetic data only.

import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerEmploymentAdminRoutes } from "../src/modules/employment/admin-routes.js";

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://employment-routes-test",
  AUTH_MODE: "local" as const,
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

const EMPLOYEE_ID = "10000000-0000-4000-8000-000000000001";
const EMPLOYMENT_ID = "40000000-0000-4000-8000-000000000001";
const UNIT_ID = "20000000-0000-4000-8000-000000000001";

type Persona = "anonymous" | "employee" | "hc" | "super_admin";

function createPool(persona: Persona, mode: "OFF" | "SHADOW" = "SHADOW") {
  const writes: string[] = [];
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM auth_sessions s")) {
      if (persona === "anonymous") return { rows: [], rowCount: 0 };
      return {
        rows: [{
          sessionId: "00000000-0000-4000-8000-000000000100",
          accountId: "00000000-0000-4000-8000-000000000001",
          email: "persona@example.org",
          principalType: persona === "super_admin" ? "SUPER_ADMIN" : "EMPLOYEE",
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("UPDATE auth_sessions SET last_seen_at")) return { rows: [], rowCount: 1 };
    if (sql.includes('SELECT DISTINCT role_permission.permission_key AS "permissionKey"')) {
      const keys = persona === "hc" ? ["employees.read.all", "employment.read", "employment.manage"] : [];
      return { rows: keys.map((permissionKey) => ({ permissionKey })), rowCount: keys.length };
    }
    if (sql.includes("FROM employment_rollout_settings WHERE id = 1")) {
      if (sql.includes("FOR UPDATE")) return { rows: [{ mode }], rowCount: 1 };
      return mode === "OFF"
        ? { rows: [], rowCount: 0 }
        : { rows: [{ mode, changedAt: new Date("2026-11-01T00:00:00Z") }], rowCount: 1 };
    }
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO employment_rollout_settings") || sql.includes("INSERT INTO employment_audit_events")) {
      writes.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT id FROM employees WHERE id = $1")) return { rows: [{ id: EMPLOYEE_ID }], rowCount: 1 };
    if (sql.includes("FROM employments WHERE")) {
      return {
        rows: [{
          id: EMPLOYMENT_ID, employeeId: EMPLOYEE_ID, legalEntityKey: null, staffType: "PENDIDIK", startedOn: "2019-07-15",
          startBasis: "RECORDED", serviceStartOn: "2019-07-15", endedOn: null, endBasis: null, endPrecision: null, endReason: null,
          voided: false, version: 0,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM employment_terms t")) {
      return {
        rows: [{ id: "t1", employmentId: EMPLOYMENT_ID, employeeId: EMPLOYEE_ID, sequence: 1, category: "TETAP", effectiveFrom: "2019-07-15", effectiveTo: null, contractReference: null, voided: false }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM employment_placements p")) {
      return {
        rows: [{
          id: "p1", employmentId: EMPLOYMENT_ID, employeeId: EMPLOYEE_ID, kind: "PRIMARY", orgNodeKey: null, legacyUnitId: UNIT_ID,
          orgPositionKey: null, legacyPositionId: null, jobTitleLabel: "Guru Kelas", effectiveFrom: "2026-11-01", effectiveTo: null,
          effectiveFromBasis: "BASELINE_ASSUMED", voided: false,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM employment_actions WHERE")) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM organizational_units WHERE id = ANY")) return { rows: [{ id: UNIT_ID, name: "SDIT Sintetis" }], rowCount: 1 };
    if (sql.includes("FROM positions WHERE id = ANY")) return { rows: [], rowCount: 0 };
    throw new Error(`Unexpected SQL in employment routes test: ${sql}`);
  });
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  return { pool, query, writes };
}

async function call(persona: Persona, method: "GET" | "PUT", url: string, options: { mode?: "OFF" | "SHADOW"; payload?: object } = {}) {
  const { pool, writes } = createPool(persona, options.mode);
  const app = Fastify({ logger: false });
  await registerEmploymentAdminRoutes(app, pool, config);
  const response = await app.inject({
    method,
    url,
    headers: persona === "anonymous" ? {} : { cookie: "hcis_session=test-token" },
    ...(options.payload ? { payload: options.payload } : {}),
  });
  await app.close();
  return { response, writes };
}

const READ_ROUTES = [
  `/admin/employees/${EMPLOYEE_ID}/employment`,
  `/admin/employees/${EMPLOYEE_ID}/employment/timeline`,
  "/admin/employment/consistency",
];

describe("EMP-PKG1-X1 employment.read authorization", () => {
  it.each(READ_ROUTES)("denies anonymous, ordinary employees, and Super Admin on %s", async (url) => {
    expect((await call("anonymous", "GET", url)).response.statusCode).toBe(401);
    expect((await call("employee", "GET", url)).response.json()).toMatchObject({ code: "EMPLOYMENT_FORBIDDEN" });
    // Legacy Super Admin compatibility never grants employment.* (spec §9).
    expect((await call("super_admin", "GET", url)).response.statusCode).toBe(403);
  }, 20_000);

  it.each(READ_ROUTES)("returns EMPLOYMENT_HISTORY_DISABLED to HC while mode is OFF on %s", async (url) => {
    const { response } = await call("hc", "GET", url, { mode: "OFF" });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "EMPLOYMENT_HISTORY_DISABLED" });
  });

  it("authorizes before validating the request", async () => {
    expect((await call("employee", "GET", "/admin/employees/not-a-uuid/employment")).response.statusCode).toBe(403);
    expect((await call("hc", "GET", "/admin/employees/not-a-uuid/employment")).response.statusCode).toBe(400);
  });

  it("serves the derived employment summary to HC in SHADOW", async () => {
    const { response } = await call("hc", "GET", `/admin/employees/${EMPLOYEE_ID}/employment?date=2026-11-15`);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      mode: "SHADOW",
      date: "2026-11-15",
      state: "AKTIF",
      current: {
        term: { category: "TETAP" },
        primaryPlacement: { jobTitleLabel: "Guru Kelas", unitName: "SDIT Sintetis", effectiveFromBasis: "BASELINE_ASSUMED" },
      },
    });
  });
});

describe("Rollout mode is governance-only and cannot reach AUTHORITATIVE yet", () => {
  it("denies HC and ordinary employees", async () => {
    expect((await call("hc", "GET", "/admin/employment/rollout")).response.statusCode).toBe(403);
    expect((await call("employee", "PUT", "/admin/employment/rollout", { payload: { mode: "SHADOW", reason: "Uji sintetis SHADOW" } })).response.statusCode).toBe(403);
  });

  it("lets governance read and switch to SHADOW with an audited reason", async () => {
    const read = await call("super_admin", "GET", "/admin/employment/rollout", { mode: "OFF" });
    expect(read.response.json()).toEqual({ mode: "OFF", changedAt: null, availableModes: ["OFF", "SHADOW"] });
    const { response, writes } = await call("super_admin", "PUT", "/admin/employment/rollout", {
      mode: "OFF",
      payload: { mode: "SHADOW", reason: "Review data awal oleh HC" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ from: "OFF", to: "SHADOW" });
    expect(writes).toEqual(["INSERT INTO employment_rollout_settings", "INSERT INTO employment_audit_events"]);
  });

  it("refuses AUTHORITATIVE in this release and a missing reason", async () => {
    const authoritative = await call("super_admin", "PUT", "/admin/employment/rollout", { payload: { mode: "AUTHORITATIVE", reason: "Aktifkan riwayat" } });
    expect(authoritative.response.statusCode).toBe(409);
    expect(authoritative.response.json()).toMatchObject({ code: "EMPLOYMENT_MODE_NOT_AVAILABLE" });
    expect(authoritative.writes).toEqual([]);
    const short = await call("super_admin", "PUT", "/admin/employment/rollout", { payload: { mode: "SHADOW", reason: "x" } });
    expect(short.response.statusCode).toBe(400);
  });
});
