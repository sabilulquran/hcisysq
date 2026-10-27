// EMP-005 S5A (spec §8.5, D-15): a former employee's HCIS account closes with
// the employment, and a temporary reactivation opens only three read-only
// self-service pages. Fake pool; synthetic accounts only.

import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  MAX_REACTIVATION_DAYS,
  isAllowedWhileReactivated,
} from "../src/modules/auth/employment-access.js";
import { registerTemporaryReactivationRoutes } from "../src/modules/auth/temporary-reactivation-routes.js";

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://reactivation-test",
  AUTH_MODE: "local" as const,
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ACCOUNT_ID = "00000000-0000-4000-8000-000000000002";
const GRANT_ID = "70000000-0000-4000-8000-000000000001";

type Persona = "anonymous" | "employee" | "hc_admin" | "super_admin";

const PERMISSIONS: Record<Persona, string[]> = {
  anonymous: [],
  employee: [],
  hc_admin: ["access.manage", "access.accounts.temporary_reactivate"],
  // Legacy Super Admin compatibility carries no reactivation permission (D-15).
  super_admin: [],
};

interface PoolOptions {
  employmentEnded?: boolean;
  reactivationExpiresAt?: Date | null;
  endedOn?: string | null;
  accountStatus?: string;
  principalType?: "EMPLOYEE" | "SUPER_ADMIN";
  revokedRowCount?: number;
}

function createPool(persona: Persona, options: PoolOptions = {}) {
  const writes: string[] = [];
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM auth_sessions s")) {
      if (persona === "anonymous") return { rows: [], rowCount: 0 };
      return {
        rows: [{
          sessionId: "00000000-0000-4000-8000-000000000100",
          accountId: persona === "hc_admin" ? OTHER_ACCOUNT_ID : ACCOUNT_ID,
          email: "persona@example.org",
          principalType: persona === "super_admin" ? "SUPER_ADMIN" : "EMPLOYEE",
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
    if (sql.includes("WITH account_employee AS")) {
      return {
        rows: [{
          employmentEnded: options.employmentEnded ?? false,
          reactivationExpiresAt: options.reactivationExpiresAt ?? null,
        }],
        rowCount: 1,
      };
    }
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM accounts a WHERE a.id = $1 FOR UPDATE OF a")) {
      return {
        rows: [{
          id: ACCOUNT_ID,
          status: options.accountStatus ?? "inactive",
          principalType: options.principalType ?? "EMPLOYEE",
          endedOn: options.endedOn === undefined ? "2027-09-30" : options.endedOn,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM account_temporary_reactivations")) return { rows: [], rowCount: 0 };
    if (sql.includes("UPDATE account_temporary_reactivations")) {
      writes.push("REVOKE grant");
      return { rows: [{ id: GRANT_ID }], rowCount: options.revokedRowCount ?? 1 };
    }
    if (sql.includes("INSERT INTO account_temporary_reactivations")) {
      writes.push("INSERT grant");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE accounts SET status")) {
      writes.push(`SET account ${sql.includes("'active'") ? "active" : "inactive"}`);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE auth_sessions SET revoked_at")) {
      writes.push("REVOKE sessions");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO access_audit_events")) {
      writes.push("INSERT audit");
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL in reactivation test: ${sql}`);
  });
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  return { pool, writes, query };
}

async function call(
  persona: Persona,
  method: "GET" | "POST",
  url: string,
  options: PoolOptions & { payload?: object } = {},
) {
  const { pool, writes } = createPool(persona, options);
  const app = Fastify({ logger: false });
  await registerTemporaryReactivationRoutes(app, pool, config);
  const response = await app.inject({
    method,
    url,
    headers: persona === "anonymous" ? {} : { cookie: "hcis_session=test-token" },
    ...(options.payload ? { payload: options.payload } : {}),
  });
  await app.close();
  return { response, writes };
}

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

const GRANT_URL = `/admin/access/accounts/${ACCOUNT_ID}/temporary-reactivations`;

describe("EMP-005 D-15 granting a temporary reactivation", () => {
  it("is refused to anonymous, ordinary employees and Super Admin", async () => {
    const payload = { reason: "Mengambil slip gaji terakhir", expiresAt: inDays(7) };
    expect((await call("anonymous", "POST", GRANT_URL, { payload })).response.statusCode).toBe(401);
    expect((await call("employee", "POST", GRANT_URL, { payload })).response.statusCode).toBe(403);
    expect((await call("super_admin", "POST", GRANT_URL, { payload })).response.statusCode).toBe(403);
  }, 20_000);

  it("grants with a reason and an expiry, reactivating the account", async () => {
    const { response, writes } = await call("hc_admin", "POST", GRANT_URL, {
      payload: { reason: "Menyelesaikan serah terima pekerjaan", expiresAt: inDays(7) },
    });
    expect(response.statusCode).toBe(201);
    expect(writes).toEqual(["REVOKE grant", "INSERT grant", "SET account active", "INSERT audit"]);
  });

  it("refuses an expiry beyond the maximum, a past expiry, and a short reason", async () => {
    for (const payload of [
      { reason: "Mengambil slip gaji terakhir", expiresAt: inDays(MAX_REACTIVATION_DAYS + 1) },
      { reason: "Mengambil slip gaji terakhir", expiresAt: inDays(-1) },
      { reason: "lupa", expiresAt: inDays(7) },
    ]) {
      const { response, writes } = await call("hc_admin", "POST", GRANT_URL, { payload });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "REACTIVATION_EXPIRY_REQUIRED" });
      expect(writes).toEqual([]);
    }
  });

  it("refuses granting to one's own account", async () => {
    const { response, writes } = await call("hc_admin", "POST", `/admin/access/accounts/${OTHER_ACCOUNT_ID}/temporary-reactivations`, {
      payload: { reason: "Mengambil slip gaji terakhir", expiresAt: inDays(7) },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "REACTIVATION_SELF_FORBIDDEN" });
    expect(writes).toEqual([]);
  });

  it("refuses an account whose employment has not ended, and a suspended one", async () => {
    const payload = { reason: "Mengambil slip gaji terakhir", expiresAt: inDays(7) };
    const active = await call("hc_admin", "POST", GRANT_URL, { endedOn: null, payload });
    expect(active.response.json()).toMatchObject({ code: "REACTIVATION_NOT_APPLICABLE" });
    const suspended = await call("hc_admin", "POST", GRANT_URL, { accountStatus: "suspended", payload });
    expect(suspended.response.json()).toMatchObject({ code: "REACTIVATION_NOT_APPLICABLE" });
    expect(active.writes).toEqual([]);
    expect(suspended.writes).toEqual([]);
  });

  it("revokes early, closing the account and its sessions", async () => {
    const { response, writes } = await call("hc_admin", "POST", `${GRANT_URL}/${GRANT_ID}/revoke`);
    expect(response.statusCode).toBe(200);
    expect(writes).toEqual(["REVOKE grant", "SET account inactive", "REVOKE sessions", "INSERT audit"]);
  });

  it("answers 404 when there is no live grant to revoke", async () => {
    const { response } = await call("hc_admin", "POST", `${GRANT_URL}/${GRANT_ID}/revoke`, { revokedRowCount: 0 });
    expect(response.statusCode).toBe(404);
  });
});

describe("EMP-005 §8.5 fail-closed guard", () => {
  it("refuses every request once the employment ended and no grant exists", async () => {
    const { response } = await call("employee", "GET", "/payslips", { employmentEnded: true });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "EMPLOYMENT_ENDED" });
  });

  it("lets a reactivated account read only the allowlisted pages", async () => {
    const options = { employmentEnded: true, reactivationExpiresAt: new Date(Date.now() + 86_400_000) };
    // Not registered here, so passing the guard ends in 404 rather than 403.
    expect((await call("employee", "GET", "/payslips", options)).response.statusCode).toBe(404);
    const denied = await call("employee", "GET", "/employees/me/employment", options);
    expect(denied.response.statusCode).toBe(403);
    expect(denied.response.json()).toMatchObject({ code: "EMPLOYMENT_ENDED_READ_ONLY" });
  });

  it("leaves a current employee untouched", async () => {
    const { response } = await call("employee", "GET", "/payslips", { employmentEnded: false });
    expect(response.statusCode).toBe(404);
  });
});

describe("EMP-005 D-15 allowlist", () => {
  it("allows only own payslips, attendance history and leave history, read-only", () => {
    for (const url of ["/payslips", "/payslips/abc", "/attendance/me", "/attendance/me/workforce",
      "/attendance/resolutions/me", "/leave/me/requests", "/leave/me/summary", "/payslips?page=2"]) {
      expect(isAllowedWhileReactivated("GET", url), url).toBe(true);
    }
    for (const url of ["/employees/me/employment", "/leave/me/annual/submit", "/notifications/me",
      "/attendance/mobile/clock", "/admin/employees"]) {
      expect(isAllowedWhileReactivated("GET", url), url).toBe(false);
    }
    expect(isAllowedWhileReactivated("POST", "/payslips")).toBe(false);
    expect(isAllowedWhileReactivated("POST", "/leave/me/annual/submit")).toBe(false);
    // Signing out stays possible.
    expect(isAllowedWhileReactivated("POST", "/auth/logout")).toBe(true);
  });
});
