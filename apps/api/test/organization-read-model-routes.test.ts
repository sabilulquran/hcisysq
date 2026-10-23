import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerOrganizationAdminRoutes } from "../src/modules/organization/admin-routes.js";

/** ORG-008-2 read endpoints: permission, privacy, and that they never write. */

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://organization-read-model-test",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

const EMPLOYEE_ROW = {
  id: "00000000-0000-4000-8000-000000000021",
  employeeNumber: "SYN-001",
  fullName: "Pegawai Sintetis",
  legacyUnitId: null,
  legacyUnitName: "Unit Lama Sintetis",
  legacyDirectManagerEmployeeId: null,
  legacyDirectManagerName: null,
  legacyUnitApproverEmployeeId: null,
  legacyUnitApproverName: null,
};

function createPool(principalType: "SUPER_ADMIN" | "EMPLOYEE", options: { rolloutRows?: unknown[] } = {}) {
  const sqlLog: string[] = [];
  const query = vi.fn(async (sql: string) => {
    sqlLog.push(sql);
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
    if (sql.includes('SELECT DISTINCT role_permission.permission_key AS "permissionKey"')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM auth_sessions s")) {
      return {
        rows: [{
          sessionId: "00000000-0000-4000-8000-000000000001",
          accountId: "00000000-0000-4000-8000-000000000002",
          email: "synthetic@example.invalid",
          principalType,
          expiresAt: new Date("2027-01-01T00:00:00.000Z"),
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("UPDATE auth_sessions SET last_seen_at")) return { rows: [], rowCount: 1 };
    if (sql.includes("count(*)::text AS count FROM organization_rollout_settings")) {
      return { rows: [{ count: String((options.rolloutRows ?? []).length) }], rowCount: 1 };
    }
    if (sql.includes("FROM organization_rollout_settings")) {
      const rows = options.rolloutRows ?? [];
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM employees e")) return { rows: [EMPLOYEE_ROW], rowCount: 1 };
    if (sql.includes("FROM organization_change_sets")) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM organization_") || sql.includes("FROM employees")) return { rows: [], rowCount: 0 };
    throw new Error(`Unexpected read-model SQL: ${sql}`);
  });
  const client = { query, release: vi.fn() };
  const pool = { query, connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, query, sqlLog };
}

async function call(
  principalType: "SUPER_ADMIN" | "EMPLOYEE",
  method: "GET" | "POST",
  url: string,
  options: { rolloutRows?: unknown[]; payload?: unknown } = {},
) {
  const { pool, sqlLog } = createPool(principalType, options);
  const app = Fastify({ logger: false });
  await registerOrganizationAdminRoutes(app, pool, config);
  const response = await app.inject({
    method,
    url,
    headers: { cookie: "hcis_session=synthetic" },
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
  await app.close();
  return { response, sqlLog };
}

const READ_ENDPOINTS: Array<[string, "GET" | "POST", string]> = [
  ["capabilities", "GET", "/admin/organization/capabilities"],
  ["people", "GET", "/admin/organization/people"],
  ["readiness", "GET", "/admin/organization/readiness"],
  ["explanation", "GET", "/admin/organization/explanation?employeeId=00000000-0000-4000-8000-000000000021"],
  ["resolution preview", "POST", "/admin/organization/resolution-preview"],
];

describe("ORG-008-2 permission on every new endpoint", () => {
  it.each(READ_ENDPOINTS)("refuses %s without organization.manage", async (_name, method, url) => {
    const { response } = await call("EMPLOYEE", method, url, {
      payload: method === "POST" ? { employeeId: "00000000-0000-4000-8000-000000000021" } : undefined,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("ORG-008-2 read endpoints never write", () => {
  it.each([
    ["people", "/admin/organization/people?withLegacy=true"],
    ["readiness", "/admin/organization/readiness"],
  ])("answers %s without a single write statement", async (_name, url) => {
    const { response, sqlLog } = await call("SUPER_ADMIN", "GET", url);

    expect(response.statusCode).toBe(200);
    const writes = sqlLog.filter((sql) =>
      /\b(INSERT INTO|DELETE FROM)\b/i.test(sql)
      || /\bUPDATE (organization|employees)/i.test(sql));
    expect(writes).toEqual([]);
    // The comparison report must not touch rollout, which stays an owner decision.
    expect(sqlLog.some((sql) => sql.includes("INSERT INTO organization_rollout_settings"))).toBe(false);
  });

  it("returns only the fields the screens need, and no sensitive employee data", async () => {
    const { response, sqlLog } = await call("SUPER_ADMIN", "GET", "/admin/organization/people?withLegacy=true");

    const body = response.json();
    expect(body.items).toHaveLength(1);
    expect(Object.keys(body.items[0]).sort()).toEqual([
      "directManager", "employeeId", "employeeNumber", "fullName", "issues", "legacy",
      "position", "source", "sourceDetails", "unit", "unitApprover",
    ]);
    const employeeQuery = sqlLog.find((sql) => sql.includes("FROM employees e"));
    for (const forbidden of ["national_id", "nik", "address", "salary", "birth", "phone", "email"]) {
      expect(employeeQuery?.toLowerCase() ?? "").not.toContain(forbidden);
    }
  });

  it("counts every active employee even with no published structure", async () => {
    const { response } = await call("SUPER_ADMIN", "GET", "/admin/organization/readiness");
    expect(response.json()).toMatchObject({ activeEmployees: 1, withoutUnit: 1, unresolvedManager: 1 });
  });
});

describe("ORG-008-2 capabilities drive what a screen may offer", () => {
  it("gives a Super Admin principal every action through legacy compatibility", async () => {
    const { response } = await call("SUPER_ADMIN", "GET", "/admin/organization/capabilities");
    expect(response.json()).toEqual({
      viewStructure: true, composeChange: true, discardChange: true,
      assignIncumbents: true, manageAuthority: true, publish: true, manageRollout: true,
    });
  });
});

describe("ORG-008-2 rollout answers what the banner needs (acceptance ORG-008-K)", () => {
  it("states that nothing is configured, which is the one case LEGACY is a fact", async () => {
    const { response } = await call("SUPER_ADMIN", "GET", "/admin/organization/rollout");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      mode: "LEGACY", workflowKey: "LEAVE", organizationalNodeKey: null,
      configuredRowCount: 0, settings: [],
    });
  });

  it("returns the rows effective today once rollout is configured, not just the newest one", async () => {
    const rows = [
      { workflowKey: "LEAVE", organizationalNodeKey: null, mode: "LEGACY", effectiveFrom: "2026-01-01", effectiveTo: null },
      { workflowKey: "LEAVE", organizationalNodeKey: "00000000-0000-4000-8000-000000000031", mode: "SHADOW", effectiveFrom: "2026-10-01", effectiveTo: null },
    ];
    const { response } = await call("SUPER_ADMIN", "GET", "/admin/organization/rollout", { rolloutRows: rows });

    const body = response.json();
    expect(body.configuredRowCount).toBe(2);
    expect(body.settings).toHaveLength(2);
    expect(body.settings[1]).toMatchObject({ mode: "SHADOW" });
  });
});
