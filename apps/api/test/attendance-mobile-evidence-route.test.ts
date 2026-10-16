import Fastify from "fastify";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AdminPermission } from "../src/modules/auth/permissions.js";

// ATT-006 HC mobile evidence review list. Every request authenticates as one
// synthetic account whose organization permissions are set per test; the pool
// is a stub that records the evidence query so placeholders can be checked.
const granted = { permissions: [] as AdminPermission[] };

vi.mock("../src/modules/auth/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/auth/service.js")>();
  class FakeAuthService {
    async getSession(token: string | null) {
      if (!token) return null;
      return {
        principal: {
          id: "00000000-0000-4000-8000-000000009101",
          email: "hc-reviewer@example.invalid",
          principalType: "SUPER_ADMIN",
        },
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      };
    }
    async getAuthorizationContext() {
      return { organizationPermissions: [...granted.permissions] };
    }
  }
  return { ...actual, AuthService: FakeAuthService };
});

const { registerAttendanceWorkforceRoutes } = await import("../src/modules/attendance/workforce-routes.js");

const config = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://mobile-evidence-route-test",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
} as ApiConfig;

const syntheticRow = {
  id: "00000000-0000-4000-8000-000000009102",
  action: "check_in",
  reviewState: "needs_review",
  employeeName: "Synthetic Evidence Employee",
};

function createPool() {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM attendance_mobile_evidence evidence")) {
      return { rows: [syntheticRow], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return { pool: { query, connect: vi.fn() } as unknown as Pool, query };
}

function evidenceCall(query: ReturnType<typeof createPool>["query"]) {
  const call = query.mock.calls.find(([sql]) => String(sql).includes("FROM attendance_mobile_evidence evidence"));
  expect(call).toBeDefined();
  const [sql, values] = call as [string, unknown[]];
  const where = sql.match(/WHERE[\s\S]*?ORDER BY/)?.[0] ?? "";
  return { sql, values, where };
}

function placeholders(where: string) {
  return [...where.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
}

describe("ATT-006 GET /admin/attendance/mobile-evidence filters", () => {
  let app: ReturnType<typeof Fastify>;
  let pool: ReturnType<typeof createPool>;

  beforeEach(async () => {
    granted.permissions = ["attendance.clarification.manage"];
    pool = createPool();
    app = Fastify({ logger: false });
    await registerAttendanceWorkforceRoutes(app, pool.pool, config);
  });

  afterEach(async () => {
    await app.close();
  });

  async function list(search: string) {
    return app.inject({
      method: "GET",
      url: `/admin/attendance/mobile-evidence${search}`,
      headers: { cookie: "hcis_session=synthetic-token" },
    });
  }

  it("returns all evidence without a WHERE clause when no filter is given", async () => {
    const response = await list("");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json().items).toHaveLength(1);
    const { sql, values, where } = evidenceCall(pool.query);
    expect(where).toBe("");
    expect(sql).not.toMatch(/\bWHERE\b/);
    expect(values).toEqual([]);
  });

  it("binds the Jakarta date filter as a $1 placeholder", async () => {
    const response = await list("?date=2099-01-05");
    expect(response.statusCode, response.body).toBe(200);
    const { values, where } = evidenceCall(pool.query);
    expect(where).toContain("(evidence.created_at AT TIME ZONE 'Asia/Jakarta')::date = $1::date");
    expect(where).not.toMatch(/=\s*\d+::date/);
    expect(placeholders(where)).toEqual([1]);
    expect(values).toEqual(["2099-01-05"]);
  });

  it.each(["needs_review", "accepted"] as const)("binds reviewState=%s as a $1 placeholder", async (reviewState) => {
    const response = await list(`?reviewState=${reviewState}`);
    expect(response.statusCode, response.body).toBe(200);
    const { values, where } = evidenceCall(pool.query);
    expect(where).toContain("evidence.review_state = $1");
    expect(where).not.toMatch(/review_state\s*=\s*\d/);
    expect(placeholders(where)).toEqual([1]);
    expect(values).toEqual([reviewState]);
  });

  it("does not filter on review state when reviewState=all", async () => {
    const response = await list("?reviewState=all");
    expect(response.statusCode, response.body).toBe(200);
    const { values, where } = evidenceCall(pool.query);
    expect(where).toBe("");
    expect(values).toEqual([]);
  });

  it("numbers combined date and reviewState placeholders in bind order", async () => {
    const response = await list("?date=2099-01-05&reviewState=needs_review");
    expect(response.statusCode, response.body).toBe(200);
    const { values, where } = evidenceCall(pool.query);
    expect(where).toContain("::date = $1::date");
    expect(where).toContain("evidence.review_state = $2");
    expect(placeholders(where)).toEqual([1, 2]);
    expect(values).toEqual(["2099-01-05", "needs_review"]);
  });

  it.each(["?date=05-01-2099", "?reviewState=pending"])(
    "rejects invalid filter %s before querying evidence",
    async (search) => {
      const response = await list(search);
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("INVALID_MOBILE_EVIDENCE_FILTER");
      expect(pool.query).not.toHaveBeenCalled();
    },
  );

  it("returns 403 without attendance.clarification.manage and never reads evidence", async () => {
    granted.permissions = ["attendance.reports.read", "attendance.records.manage"];
    const response = await list("?reviewState=needs_review");
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("FORBIDDEN");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("returns 401 without a session", async () => {
    const response = await app.inject({ method: "GET", url: "/admin/attendance/mobile-evidence" });
    expect(response.statusCode).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
