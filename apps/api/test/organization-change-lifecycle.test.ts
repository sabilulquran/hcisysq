import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerOrganizationAdminRoutes } from "../src/modules/organization/admin-routes.js";

/**
 * ORG-008-3b: a change set can be found again, returned to composing, and discarded, and two people
 * editing the same change set cannot overwrite each other.
 *
 * The pool is mocked by SQL text, as in organization-admin-authorization.test.ts, so these run
 * without PostgreSQL. A real migration run stays part of the release check.
 */

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://organization-lifecycle-test",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

const DRAFT_ID = "00000000-0000-4000-8000-000000000010";

function changeSetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DRAFT_ID,
    name: "Restruktur Sintetis",
    effectiveOn: "2027-01-01",
    status: "VALIDATED",
    baseChangeSetId: null,
    validationReport: { valid: true, issues: [] },
    createdByAccountId: "00000000-0000-4000-8000-000000000002",
    createdAt: new Date("2026-10-15T00:00:00.000Z"),
    validatedAt: new Date("2026-10-15T01:00:00.000Z"),
    publishedAt: null,
    revision: 3,
    ...overrides,
  };
}

type Scenario = {
  changeSets?: Array<Record<string, unknown>>;
  /** Rows affected by the UPDATE under test: 0 means the WHERE clause did not match. */
  updateRowCount?: number;
  revisionAfterBump?: number | null;
};

function createPool(scenario: Scenario = {}) {
  const sqlLog: string[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    sqlLog.push(sql);
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
    // O-7: the open-change-set check runs under a transaction-scoped advisory lock.
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
    if (sql.includes("FROM auth_sessions s")) {
      return {
        rows: [{
          sessionId: "00000000-0000-4000-8000-000000000001",
          accountId: "00000000-0000-4000-8000-000000000002",
          email: "synthetic@example.invalid",
          principalType: "SUPER_ADMIN",
          expiresAt: new Date("2027-01-01T00:00:00.000Z"),
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("UPDATE auth_sessions SET last_seen_at")) return { rows: [], rowCount: 1 };
    if (sql.includes("INSERT INTO organization_audit_events")) return { rows: [], rowCount: 1 };
    if (sql.includes("SET revision = revision + 1") && sql.includes("RETURNING revision")) {
      const next = scenario.revisionAfterBump;
      return next === null || next === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ revision: next }], rowCount: 1 };
    }
    if (sql.includes("UPDATE organization_change_sets")) {
      return { rows: [], rowCount: scenario.updateRowCount ?? 1 };
    }
    if (sql.includes("FROM organization_change_sets")) {
      const rows = scenario.changeSets ?? [];
      if (sql.includes("WHERE id = $1")) {
        const match = rows.find((row) => row.id === (params?.[0] as string));
        return { rows: match ? [match] : [], rowCount: match ? 1 : 0 };
      }
      if (sql.includes("status = ANY($1::text[])")) {
        const statuses = params?.[0] as string[] | null;
        const filtered = statuses ? rows.filter((row) => statuses.includes(row.status as string)) : rows;
        return { rows: filtered, rowCount: filtered.length };
      }
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM organization_") || sql.includes("FROM employees") || sql.includes("FROM accounts")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("DELETE FROM organization_") || sql.includes("INSERT INTO organization_")) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected organization lifecycle SQL: ${sql}`);
  });
  const client = { query, release: vi.fn() };
  const pool = { query, connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, query, sqlLog };
}

async function call(
  scenario: Scenario,
  method: "GET" | "POST",
  url: string,
  options: { payload?: unknown; headers?: Record<string, string> } = {},
) {
  const { pool, query, sqlLog } = createPool(scenario);
  const app = Fastify({ logger: false });
  await registerOrganizationAdminRoutes(app, pool, config);
  const response = await app.inject({
    method,
    url,
    headers: { cookie: "hcis_session=synthetic", ...options.headers },
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
  await app.close();
  return { response, query, sqlLog };
}

function auditPayloads(query: ReturnType<typeof vi.fn>) {
  return query.mock.calls
    .filter(([sql]) => String(sql).includes("INSERT INTO organization_audit_events"))
    .map(([, params]) => ({
      action: (params as unknown[])[2] as string,
      payload: JSON.parse((params as unknown[])[6] as string) as Record<string, unknown>,
    }));
}

describe("ORG-008-3b change sets can be found again", () => {
  it("lists change sets, including discarded ones, so history stays visible", async () => {
    const { response } = await call(
      { changeSets: [changeSetRow(), changeSetRow({ id: "other", status: "DISCARDED" })] },
      "GET",
      "/admin/organization/designer/drafts",
    );

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(2);
    expect(response.json().items[0]).toMatchObject({ name: "Restruktur Sintetis", revision: 3 });
  });

  it("filters by status when asked", async () => {
    const { response } = await call(
      { changeSets: [changeSetRow(), changeSetRow({ id: "other", status: "DISCARDED" })] },
      "GET",
      "/admin/organization/designer/drafts?status=DISCARDED",
    );

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([expect.objectContaining({ status: "DISCARDED" })]);
  });

  it("rejects a status filter it does not know", async () => {
    const { response } = await call({}, "GET", "/admin/organization/designer/drafts?status=WHATEVER");
    expect(response.statusCode).toBe(400);
  });
});

describe("ORG-008-3b one change set open at a time (O-7)", () => {
  it("refuses a second open change set and names the one already open", async () => {
    const { response, query } = await call(
      { changeSets: [changeSetRow({ status: "DRAFT" })] },
      "POST",
      "/admin/organization/designer/drafts",
      { payload: { name: "Perubahan Kedua", effectiveOn: "2027-06-01" } },
    );

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "ORGANIZATION_DRAFT_ALREADY_OPEN",
      details: { changeSetId: DRAFT_ID, name: "Restruktur Sintetis", status: "DRAFT" },
    });
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO organization_change_sets"))).toBe(false);
  });

  it("does not count a discarded or published change set as open", async () => {
    const { response } = await call(
      {
        changeSets: [
          changeSetRow({ id: "discarded", status: "DISCARDED" }),
          changeSetRow({ id: "published", status: "PUBLISHED", publishedAt: new Date("2026-10-01T00:00:00.000Z") }),
        ],
      },
      "POST",
      "/admin/organization/designer/drafts",
      { payload: { name: "Perubahan Baru", effectiveOn: "2027-06-01" } },
    );

    expect(response.statusCode).not.toBe(409);
  });
});

describe("ORG-008-3b reopen and discard", () => {
  it("returns a validated change set to composing and records the audit event", async () => {
    const { response, query } = await call(
      { changeSets: [changeSetRow()], updateRowCount: 1 },
      "POST",
      `/admin/organization/designer/drafts/${DRAFT_ID}/reopen`,
    );

    expect(response.statusCode).toBe(200);
    const update = query.mock.calls.find(([sql]) => String(sql).includes("SET status = 'DRAFT'"));
    expect(update).toBeDefined();
    // The validation report is cleared, so the change has to be checked again before publishing.
    expect(String(update?.[0])).toContain("validation_report = '{}'::jsonb");
    expect(auditPayloads(query).map((item) => item.action)).toContain("organization.draft.reopened");
  });

  it("refuses to reopen a change set that is not validated", async () => {
    const { response } = await call(
      { changeSets: [changeSetRow({ status: "DRAFT", validatedAt: null })], updateRowCount: 0 },
      "POST",
      `/admin/organization/designer/drafts/${DRAFT_ID}/reopen`,
    );

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "ORGANIZATION_DRAFT_NOT_REOPENABLE" });
  });

  it("discards a change set without deleting it, keeping the reason in the audit event", async () => {
    const { response, query } = await call(
      { changeSets: [changeSetRow()], updateRowCount: 1 },
      "POST",
      `/admin/organization/designer/drafts/${DRAFT_ID}/discard`,
      { payload: { reason: "Dibatalkan oleh Human Capital" } },
    );

    expect(response.statusCode).toBe(200);
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("DELETE FROM organization_change_sets"))).toBe(false);
    const discarded = auditPayloads(query).find((item) => item.action === "organization.draft.discarded");
    expect(discarded?.payload).toMatchObject({
      previousStatus: "VALIDATED",
      reason: "Dibatalkan oleh Human Capital",
    });
  });

  it("refuses to discard a published change set", async () => {
    const { response } = await call(
      {
        changeSets: [changeSetRow({ status: "PUBLISHED", publishedAt: new Date("2026-10-01T00:00:00.000Z") })],
        updateRowCount: 0,
      },
      "POST",
      `/admin/organization/designer/drafts/${DRAFT_ID}/discard`,
    );

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "ORGANIZATION_DRAFT_NOT_DISCARDABLE" });
  });

  it("answers 404 for a change set that does not exist", async () => {
    const { response } = await call({ changeSets: [] }, "POST",
      `/admin/organization/designer/drafts/${DRAFT_ID}/discard`);
    expect(response.statusCode).toBe(404);
  });
});

describe("ORG-008-3b concurrent edits are refused, not merged", () => {
  const node = { name: "Unit Sintetis", nodeType: "UNIT", parentNodeKey: null, visualRankOffset: 0 };

  it("refuses a mutation carrying a revision someone else has already moved on from", async () => {
    const { response, query } = await call(
      { changeSets: [changeSetRow({ status: "DRAFT", validatedAt: null, revision: 5 })], revisionAfterBump: null },
      "POST",
      `/admin/organization/designer/drafts/${DRAFT_ID}/nodes`,
      { payload: node, headers: { "if-match": "3" } },
    );

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "ORGANIZATION_DRAFT_CHANGED", details: { revision: 5 } });
    // Nothing was written: the snapshot rewrite never started.
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("DELETE FROM organization_nodes"))).toBe(false);
  });

  it("accepts a mutation carrying the revision the client last read", async () => {
    const { response, query } = await call(
      { changeSets: [changeSetRow({ status: "DRAFT", validatedAt: null, revision: 5 })], revisionAfterBump: 6 },
      "POST",
      `/admin/organization/designer/drafts/${DRAFT_ID}/nodes`,
      { payload: node, headers: { "if-match": "5" } },
    );

    expect(response.statusCode).toBe(201);
    const bump = query.mock.calls.find(([sql]) => String(sql).includes("SET revision = revision + 1"));
    expect(bump?.[1]).toEqual([DRAFT_ID, 5]);
  });

  it("rejects an If-Match that is not a revision number instead of guessing", async () => {
    const { response } = await call(
      { changeSets: [changeSetRow({ status: "DRAFT", validatedAt: null, revision: 5 })] },
      "POST",
      `/admin/organization/designer/drafts/${DRAFT_ID}/nodes`,
      { payload: node, headers: { "if-match": "W/\"abc\"" } },
    );

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_DRAFT_REVISION" });
  });

  it("still serves a client that does not send the header yet", async () => {
    const { response, query } = await call(
      { changeSets: [changeSetRow({ status: "DRAFT", validatedAt: null, revision: 5 })], revisionAfterBump: 6 },
      "POST",
      `/admin/organization/designer/drafts/${DRAFT_ID}/nodes`,
      { payload: node },
    );

    expect(response.statusCode).toBe(201);
    const bump = query.mock.calls.find(([sql]) => String(sql).includes("SET revision = revision + 1"));
    expect(bump?.[1]).toEqual([DRAFT_ID, 5]);
  });
});

describe("ORG-008-3b a discarded change set can never become effective structure", () => {
  it("keeps the effective-structure query restricted to published change sets", async () => {
    const { sqlLog } = await call({ changeSets: [] }, "GET", "/admin/organization/designer?effectiveDate=2026-10-23");
    const effective = sqlLog.find((sql) => sql.includes("effective_on <= $1::date"));
    expect(effective).toBeDefined();
    expect(effective).toContain("status = 'PUBLISHED'");
  });

  it("extends both change-set constraints, so the migration cannot half-apply DISCARDED", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = await readFile(join(here, "../migrations/0062_organization_change_set_lifecycle.sql"), "utf8");

    // 0019 holds two CHECKs: the status list and the lifecycle consistency rule. Extending only the
    // first would make every discard fail against the second.
    expect(sql).toContain("CHECK (status IN ('DRAFT', 'VALIDATED', 'PUBLISHED', 'DISCARDED'))");
    expect(sql).toContain("(status = 'DISCARDED' AND published_at IS NULL)");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0");
    expect(sql).toContain("Rollback/recovery");
  });
});

describe("ORG-008 review: lifecycle refusals", () => {
  it("refuses to check a discarded change set again instead of failing with 500", async () => {
    const { response } = await call(
      { changeSets: [changeSetRow({ status: "DISCARDED", validatedAt: null })] },
      "POST",
      `/admin/organization/designer/drafts/${DRAFT_ID}/validate`,
    );

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "ORGANIZATION_DRAFT_NOT_EDITABLE" });
  });

  it("checks for an open change set under a lock, inside the creating transaction (O-7)", async () => {
    const { response, query } = await call(
      { changeSets: [changeSetRow({ status: "DRAFT" })] },
      "POST",
      "/admin/organization/designer/drafts",
      { payload: { name: "Perubahan Kedua", effectiveOn: "2027-06-01" } },
    );

    expect(response.statusCode).toBe(409);
    const statements = query.mock.calls.map(([sql]) => String(sql));
    const begin = statements.indexOf("BEGIN");
    const lock = statements.findIndex((sql) => sql.includes("pg_advisory_xact_lock"));
    const openCheck = statements.findIndex((sql) => sql.includes("status = ANY($1::text[])"));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThan(begin);
    expect(openCheck).toBeGreaterThan(lock);
    expect(statements).toContain("ROLLBACK");
  });
});
