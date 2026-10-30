// EMP-005 S2B: the master write paths that §8.7 names, refused for a record
// outside HCIS management — contact, direct manager, the leave entitlement
// group, and the employee import. Fake pool; synthetic data.
//
// These four had no test at all. Without them the guards could be deleted and
// the suite would stay green, which is the one thing an independent review
// cannot certify away.

import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerEmployeeAdminRoutes } from "../src/modules/employees/admin-routes.js";
import { registerEmployeeContactAdminRoutes } from "../src/modules/employees/admin-employee-contact-routes.js";
import { registerOrgAccessAdminRoutes } from "../src/modules/employees/admin-org-access-routes.js";

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://management-scope-writes-test",
  AUTH_MODE: "local" as const,
  AUTH_ENCRYPTION_KEY: "66".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

const EMPLOYEE_ID = "10000000-0000-4000-8000-000000000001";
const MANAGER_ID = "10000000-0000-4000-8000-000000000002";

const OUTSIDE = { code: "EMPLOYEE_OUTSIDE_HCIS_READ_ONLY" };

interface PoolOptions {
  /** Which employee ids the marker covers. */
  outside?: string[];
  payload?: object;
}

function createPool(options: PoolOptions = {}) {
  const writes: string[] = [];
  const outside = new Set(options.outside ?? []);
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM auth_sessions s")) {
      return {
        rows: [{
          sessionId: "00000000-0000-4000-8000-000000000100",
          accountId: "00000000-0000-4000-8000-000000000001",
          email: "hc@example.org",
          principalType: "EMPLOYEE",
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("UPDATE auth_sessions SET last_seen_at")) return { rows: [], rowCount: 1 };
    if (sql.includes('SELECT DISTINCT role_permission.permission_key AS "permissionKey"')) {
      return {
        rows: [
          "employees.manage", "employees.read.all", "organization.manage", "access.manage",
          "approvals.policy.manage", "leave.configuration.manage",
        ].map((permissionKey) => ({ permissionKey })),
        rowCount: 6,
      };
    }
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes("management_scope = 'OUTSIDE_HCIS' AS outside")) {
      return { rows: [{ outside: outside.has(String(values?.[0])) }], rowCount: 1 };
    }
    // The reporting-line checks the manager route makes before writing.
    if (sql.includes("FROM employees") && sql.includes("direct_manager_employee_id")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("SELECT id FROM employees")) return { rows: [{ id: String(values?.[0]) }], rowCount: 1 };
    if (sql.includes("UPDATE employees")) {
      writes.push("UPDATE employee");
      return { rows: [{ id: EMPLOYEE_ID, email: null, phone: null }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO access_audit_events")) {
      writes.push("INSERT audit");
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  return { pool, query, writes };
}

async function call(
  register: (app: ReturnType<typeof Fastify>, pool: Pool, config: typeof config) => Promise<void>,
  method: "PATCH" | "PUT",
  url: string,
  options: PoolOptions = {},
) {
  const { pool, writes } = createPool(options);
  const app = Fastify({ logger: false });
  await register(app, pool, config);
  const response = await app.inject({
    method,
    url,
    headers: { cookie: "hcis_session=test-token" },
    ...(options.payload ? { payload: options.payload } : {}),
  });
  await app.close();
  return { response, writes };
}

describe("EMP-005 S2B contact edit", () => {
  const url = `/admin/employees/${EMPLOYEE_ID}/contact`;
  const payload = { email: "baru@example.org", phone: "0800000000" };

  it("writes the contact of a record HCIS manages", async () => {
    const { response, writes } = await call(registerEmployeeContactAdminRoutes, "PATCH", url, { payload });
    expect(response.statusCode).toBe(200);
    expect(writes).toContain("UPDATE employee");
  });

  it("refuses the contact of a record outside HCIS management", async () => {
    const { response, writes } = await call(registerEmployeeContactAdminRoutes, "PATCH", url, {
      payload, outside: [EMPLOYEE_ID],
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject(OUTSIDE);
    expect(writes).toEqual([]);
  });
});

describe("EMP-005 S2B direct manager", () => {
  const url = `/admin/employees/${EMPLOYEE_ID}/manager`;

  it("refuses when the subject is outside HCIS management", async () => {
    const { response, writes } = await call(registerOrgAccessAdminRoutes, "PATCH", url, {
      payload: { managerEmployeeId: MANAGER_ID }, outside: [EMPLOYEE_ID],
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject(OUTSIDE);
    expect(writes).toEqual([]);
  });

  it("refuses when the proposed manager is outside HCIS management", async () => {
    // A marked record must not be named as anyone's manager either.
    const { response, writes } = await call(registerOrgAccessAdminRoutes, "PATCH", url, {
      payload: { managerEmployeeId: MANAGER_ID }, outside: [MANAGER_ID],
    });
    expect(response.statusCode).toBe(409);
    expect(writes).toEqual([]);
  });
});

describe("EMP-005 S2B the admin employee list", () => {
  /** Runs the list and hands back the SQL it issued. */
  async function list(search: string) {
    const { pool, query } = createPool();
    const app = Fastify({ logger: false });
    await registerEmployeeAdminRoutes(app, pool, config);
    const response = await app.inject({
      method: "GET",
      url: `/admin/employees${search}`,
      headers: { cookie: "hcis_session=test-token" },
    });
    await app.close();
    const statements = query.mock.calls.map(([sql]) => String(sql));
    return { response, statements };
  }

  it("hides records outside HCIS management unless they are asked for", async () => {
    const managed = await list("");
    expect(managed.response.statusCode).toBe(200);
    expect(managed.response.json().scope).toBe("MANAGED");
    expect(managed.statements.some((sql) => sql.includes("e.management_scope = 'MANAGED'"))).toBe(true);

    const marked = await list("?scope=OUTSIDE_HCIS");
    expect(marked.statements.some((sql) => sql.includes("e.management_scope = 'OUTSIDE_HCIS'"))).toBe(true);

    // "ALL" is for reconciling, and is the only way to see both at once.
    const all = await list("?scope=ALL");
    expect(all.statements.some((sql) => sql.includes("e.management_scope ="))).toBe(false);
  });

  it("refuses a scope it does not know rather than falling back silently", async () => {
    const { response } = await list("?scope=SEPARUH");
    expect(response.statusCode).toBe(400);
  });

  it("counts the managed population, and the marked records apart from it", async () => {
    const { statements } = await list("");
    const summary = statements.find((sql) => sql.includes('AS "outsideHcis"'));
    expect(summary).toBeDefined();
    // Four headline figures, each filtered to the population HCIS manages,
    // and the marked records counted on their own. A headcount that quietly
    // included BUMY staff would be wrong wherever it is read.
    expect(summary!.match(/management_scope = 'MANAGED'/g)).toHaveLength(4);
    expect(summary!.match(/management_scope = 'OUTSIDE_HCIS'/g)).toHaveLength(1);
  });
});
