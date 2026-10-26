import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerOrganizationAdminRoutes } from "../src/modules/organization/admin-routes.js";

/**
 * ORG-008-10 (decision O-1 "empat mata", DRAFT default 2026-10-27): whoever composed a change set may
 * not also publish it. Super Admin stays exempt as the audited break-glass account.
 */

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://organization-four-eyes-test",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

const DRAFT_ID = "00000000-0000-4000-8000-000000000010";
const ACTOR = "00000000-0000-4000-8000-000000000002";
const OTHER = "00000000-0000-4000-8000-000000000003";

const DRAFT_ROW = {
  id: DRAFT_ID, name: "Restruktur Sintetis", effectiveOn: "2027-01-01", status: "VALIDATED",
  baseChangeSetId: null, validationReport: { valid: true, issues: [] },
  createdByAccountId: OTHER,
  createdAt: new Date("2026-10-01T00:00:00.000Z"),
  validatedAt: new Date("2026-10-02T00:00:00.000Z"), publishedAt: null, revision: 3,
};

function createPool(options: { composers: string[]; principalType?: "EMPLOYEE" | "SUPER_ADMIN" }) {
  const query = vi.fn(async (sql: string) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
    if (sql.includes('SELECT DISTINCT role_permission.permission_key AS "permissionKey"')) {
      return { rows: [{ permissionKey: "organization.manage" }, { permissionKey: "approvals.policy.manage" }], rowCount: 2 };
    }
    if (sql.includes("FROM auth_sessions s")) {
      return {
        rows: [{
          sessionId: "00000000-0000-4000-8000-000000000001",
          accountId: ACTOR,
          email: "synthetic@example.invalid",
          principalType: options.principalType ?? "EMPLOYEE",
          expiresAt: new Date("2027-01-01T00:00:00.000Z"),
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("UPDATE auth_sessions SET last_seen_at")) return { rows: [], rowCount: 1 };
    if (sql.includes("INSERT INTO organization_audit_events")) return { rows: [], rowCount: 1 };
    // The composers query unions the change set's creator with the audit trail's actors.
    if (sql.includes("UNION") && sql.includes("organization_audit_events")) {
      return { rows: options.composers.map((accountId) => ({ accountId })), rowCount: options.composers.length };
    }
    if (sql.includes("SET status = 'PUBLISHED'")) return { rows: [], rowCount: 1 };
    if (sql.includes("FROM organization_change_sets")) return { rows: [DRAFT_ROW], rowCount: 1 };
    if (sql.includes("FROM organization_") || sql.includes("FROM employees") || sql.includes("FROM accounts")
      || sql.includes("FROM attendance_work_locations")) {
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`Unexpected four-eyes SQL: ${sql}`);
  });
  const client = { query, release: vi.fn() };
  const pool = { query, connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, query };
}

async function call(method: "GET" | "POST", url: string, options: Parameters<typeof createPool>[0]) {
  const { pool, query } = createPool(options);
  const app = Fastify({ logger: false });
  await registerOrganizationAdminRoutes(app, pool, config);
  const response = await app.inject({ method, url, headers: { cookie: "hcis_session=synthetic" } });
  await app.close();
  return { response, query };
}

const publishUrl = `/admin/organization/designer/drafts/${DRAFT_ID}/publish`;
const published = (query: ReturnType<typeof vi.fn>) =>
  query.mock.calls.some(([sql]) => String(sql).includes("SET status = 'PUBLISHED'"));

describe("ORG-008-10 the person who publishes did not compose the change", () => {
  it("refuses a holder of the publish permission who composed the change set, and writes nothing", async () => {
    const { response, query } = await call("POST", publishUrl, { composers: [OTHER, ACTOR] });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "ORGANIZATION_PUBLISH_REQUIRES_SECOND_PERSON" });
    expect(published(query)).toBe(false);
    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });

  it("publishes when someone else composed it", async () => {
    const { response, query } = await call("POST", publishUrl, { composers: [OTHER] });

    expect(response.statusCode).toBe(200);
    expect(published(query)).toBe(true);
  });

  it("leaves Super Admin able to publish as the audited break-glass account", async () => {
    const { response, query } = await call("POST", publishUrl, { composers: [ACTOR], principalType: "SUPER_ADMIN" });

    expect(response.statusCode).toBe(200);
    expect(published(query)).toBe(true);
  });

  it("tells the screen in advance, so it explains instead of offering Terbitkan", async () => {
    const blocked = await call("GET", `/admin/organization/designer?draftId=${DRAFT_ID}`, { composers: [ACTOR] });
    expect(blocked.response.statusCode).toBe(200);
    expect(blocked.response.json()).toMatchObject({ publishBlockedForSelf: true });

    const free = await call("GET", `/admin/organization/designer?draftId=${DRAFT_ID}`, { composers: [OTHER] });
    expect(free.response.json()).toMatchObject({ publishBlockedForSelf: false });
  });
});
