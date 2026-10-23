import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerOrganizationAdminRoutes } from "../src/modules/organization/admin-routes.js";

/** ORG-008-4c at the route: it previews by default, and only `apply: true` writes. */

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://organization-rebase-test",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

const DRAFT_ID = "00000000-0000-4000-8000-000000000010";
const BASE_UNIT = "00000000-0000-4000-8000-000000000020";
const NEW_UNIT = "00000000-0000-4000-8000-000000000021";

const DRAFT_ROW = {
  id: DRAFT_ID, name: "Restruktur Sintetis", effectiveOn: "2027-01-01", status: "DRAFT",
  baseChangeSetId: null, validationReport: { valid: false, issues: [] },
  createdByAccountId: "00000000-0000-4000-8000-000000000002",
  createdAt: new Date("2026-10-01T00:00:00.000Z"),
  validatedAt: null, publishedAt: null, revision: 4,
};

const BASE_ROW = {
  ...DRAFT_ROW, id: "00000000-0000-4000-8000-000000000099", status: "PUBLISHED",
  effectiveOn: "2026-10-24", validatedAt: new Date("2026-10-20T00:00:00.000Z"),
  publishedAt: new Date("2026-10-20T00:00:00.000Z"),
};

const BASE_NODE = {
  id: "base-node-id", stableKey: BASE_UNIT, name: "Yayasan", nodeType: "FOUNDATION",
  parentNodeKey: null, active: true, effectiveFrom: "2026-01-01", effectiveTo: null,
  visualRankOffset: 0, integrationCode: null,
};

const JOURNAL = [
  {
    id: "journal-1", seq: 1, commandType: "ADD_UNIT",
    payload: { type: "ADD_UNIT", name: "Bidang Pendidikan", nodeType: "DIRECTORATE", parentNodeKey: BASE_UNIT },
    summary: { nodeKey: NEW_UNIT, name: "Bidang Pendidikan" },
  },
];

function createPool(options: { journal?: unknown[]; nodes?: unknown[] } = {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
    if (sql.includes('SELECT DISTINCT role_permission.permission_key AS "permissionKey"')) {
      return { rows: [{ permissionKey: "organization.manage" }], rowCount: 1 };
    }
    if (sql.includes("FROM auth_sessions s")) {
      return {
        rows: [{
          sessionId: "00000000-0000-4000-8000-000000000001",
          accountId: "00000000-0000-4000-8000-000000000002",
          email: "synthetic@example.invalid",
          principalType: "EMPLOYEE",
          expiresAt: new Date("2027-01-01T00:00:00.000Z"),
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("UPDATE auth_sessions SET last_seen_at")) return { rows: [], rowCount: 1 };
    if (sql.includes("INSERT INTO organization_audit_events")) return { rows: [], rowCount: 1 };
    if (sql.includes("SET revision = revision + 1")) return { rows: [{ revision: 5 }], rowCount: 1 };
    if (sql.includes("FROM organization_change_set_journal")) {
      const rows = options.journal ?? JOURNAL;
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("organization_change_set_journal")) return { rows: [], rowCount: 1 };
    if (sql.includes("UPDATE organization_change_sets")) return { rows: [], rowCount: 1 };
    if (sql.includes("FROM organization_change_sets")) {
      // The effective-structure query asks for a published snapshot; everything else wants the draft.
      if (sql.includes("effective_on <= $1::date")) return { rows: [BASE_ROW], rowCount: 1 };
      return { rows: [DRAFT_ROW], rowCount: 1 };
    }
    if (sql.includes("FROM organization_nodes")) {
      const rows = options.nodes ?? [BASE_NODE];
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM organization_") || sql.includes("FROM employees")) return { rows: [], rowCount: 0 };
    if (sql.includes("DELETE FROM organization_") || sql.includes("INSERT INTO organization_")) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected rebase SQL: ${sql}`);
  });
  const client = { query, release: vi.fn() };
  const pool = { query, connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, query };
}

async function call(url: string, payload: unknown, options: Parameters<typeof createPool>[0] = {}) {
  const { pool, query } = createPool(options);
  const app = Fastify({ logger: false });
  await registerOrganizationAdminRoutes(app, pool, config);
  const response = await app.inject({
    method: "POST", url, headers: { cookie: "hcis_session=synthetic" }, payload,
  });
  await app.close();
  return { response, query };
}

const rebaseUrl = `/admin/organization/designer/drafts/${DRAFT_ID}/rebase`;
const undoUrl = `/admin/organization/designer/drafts/${DRAFT_ID}/journal/1/undo`;

function wrote(query: ReturnType<typeof vi.fn>) {
  return query.mock.calls.some(([sql]) =>
    String(sql).includes("DELETE FROM organization_nodes")
    || String(sql).includes("SET base_change_set_id"));
}

describe("ORG-008-4c rebuilding from newer structure", () => {
  it("previews by default and writes nothing", async () => {
    const { response, query } = await call(rebaseUrl, {});

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      applied: false,
      kept: [{ seq: 1, commandType: "ADD_UNIT" }],
      skipped: [],
    });
    expect(wrote(query)).toBe(false);
  });

  it("writes only when the operator confirms, and records the audit event", async () => {
    const { response, query } = await call(rebaseUrl, { apply: true });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ applied: true });
    expect(wrote(query)).toBe(true);
    const actions = query.mock.calls
      .filter(([sql]) => String(sql).includes("INSERT INTO organization_audit_events"))
      .map(([, params]) => (params as unknown[])[2] as string);
    expect(actions).toContain("organization.draft.rebased");
  });

  it("reports a line that no longer fits, rather than resolving it", async () => {
    // The newer structure no longer has the unit the line was attached to.
    const { response } = await call(rebaseUrl, {}, { nodes: [] });

    expect(response.json()).toMatchObject({
      kept: [],
      skipped: [{ seq: 1, commandType: "ADD_UNIT", code: "ORGANIZATION_NODE_NOT_FOUND" }],
    });
  });
});

describe("ORG-008-4c undoing one line of the change list", () => {
  it("previews the change set without that line", async () => {
    const { response, query } = await call(undoUrl, {});

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ applied: false, kept: [], skipped: [] });
    expect(wrote(query)).toBe(false);
  });

  it("applies the undo on confirmation and audits it", async () => {
    const { response, query } = await call(undoUrl, { apply: true });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ applied: true, kept: [] });
    const actions = query.mock.calls
      .filter(([sql]) => String(sql).includes("INSERT INTO organization_audit_events"))
      .map(([, params]) => (params as unknown[])[2] as string);
    expect(actions).toContain("organization.draft.journal_undone");
  });

  it("answers 404 for a line that is not in the change list", async () => {
    const { response } = await call(
      `/admin/organization/designer/drafts/${DRAFT_ID}/journal/99/undo`, {},
    );
    expect(response.statusCode).toBe(404);
  });
});
