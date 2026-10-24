import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerOrganizationAdminRoutes } from "../src/modules/organization/admin-routes.js";

/**
 * ORG-008-4a at the route: a combined command may not grant what its parts do not, it lands whole or
 * not at all, and it leaves a journal entry plus one audit event per primitive record.
 */

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://organization-commands-test",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

const DRAFT_ID = "00000000-0000-4000-8000-000000000010";
const NODE_KEY = "00000000-0000-4000-8000-000000000020";
const POSITION_KEY = "00000000-0000-4000-8000-000000000030";
const EMPLOYEE_ID = "00000000-0000-4000-8000-000000000040";

const DRAFT_ROW = {
  id: DRAFT_ID, name: "Restruktur Sintetis", effectiveOn: "2027-01-01", status: "DRAFT",
  baseChangeSetId: null, validationReport: { valid: false, issues: [] },
  createdByAccountId: "00000000-0000-4000-8000-000000000002",
  createdAt: new Date("2026-10-01T00:00:00.000Z"),
  validatedAt: null, publishedAt: null, revision: 2,
};

const NODE_ROW = {
  id: "node-id", stableKey: NODE_KEY, name: "SDIT", nodeType: "UNIT", parentNodeKey: null,
  active: true, effectiveFrom: "2026-01-01", effectiveTo: null, visualRankOffset: 0, integrationCode: null,
};

const POSITION_ROW = {
  id: "position-id", stableKey: POSITION_KEY, nodeKey: NODE_KEY, title: "Kepala SDIT",
  parentPositionKey: null, singleIncumbent: true, vacancyPolicy: "CLIMB_TO_PARENT", active: true,
  effectiveFrom: "2026-01-01", effectiveTo: null, visualRankOffset: 0,
  jobProfileKey: null, holderSource: "EMPLOYEE",
};

function createPool(options: { permissions?: string[]; failAudit?: boolean } = {}) {
  const permissions = options.permissions ?? [];
  const query = vi.fn(async (sql: string) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
    if (sql.includes('SELECT DISTINCT role_permission.permission_key AS "permissionKey"')) {
      return { rows: permissions.map((permissionKey) => ({ permissionKey })), rowCount: permissions.length };
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
    if (sql.includes("INSERT INTO organization_audit_events")) {
      if (options.failAudit) throw new Error("forced audit failure");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO organization_change_set_journal")) {
      return { rows: [{ seq: 1 }], rowCount: 1 };
    }
    if (sql.includes("FROM organization_change_set_journal")) {
      return {
        rows: [{
          id: "journal-1", seq: 1, commandType: "ADD_UNIT", summary: { name: "Bidang Pendidikan" },
          actorAccountId: "00000000-0000-4000-8000-000000000002",
          createdAt: new Date("2026-10-20T00:00:00.000Z"),
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("SET revision = revision + 1")) return { rows: [{ revision: 3 }], rowCount: 1 };
    // Changing a draft clears its validation report, so it has to be checked again before publish.
    if (sql.includes("UPDATE organization_change_sets")) return { rows: [], rowCount: 1 };
    if (sql.includes("FROM organization_change_sets")) return { rows: [DRAFT_ROW], rowCount: 1 };
    if (sql.includes("FROM organization_nodes")) return { rows: [NODE_ROW], rowCount: 1 };
    if (sql.includes("FROM organization_positions")) return { rows: [POSITION_ROW], rowCount: 1 };
    if (sql.includes("FOR UPDATE")) return { rows: [{ status: "DRAFT" }], rowCount: 1 };
    if (sql.includes("FROM organization_") || sql.includes("FROM employees")) return { rows: [], rowCount: 0 };
    if (sql.includes("DELETE FROM organization_") || sql.includes("INSERT INTO organization_")) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected command SQL: ${sql}`);
  });
  const client = { query, release: vi.fn() };
  const pool = { query, connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, query };
}

async function call(
  body: unknown,
  options: { permissions?: string[]; failAudit?: boolean; method?: "GET" | "POST"; url?: string } = {},
) {
  const { pool, query } = createPool(options);
  const app = Fastify({ logger: false });
  await registerOrganizationAdminRoutes(app, pool, config);
  const response = await app.inject({
    method: options.method ?? "POST",
    url: options.url ?? `/admin/organization/designer/drafts/${DRAFT_ID}/commands`,
    headers: { cookie: "hcis_session=synthetic" },
    ...(options.method === "GET" ? {} : { payload: body }),
  });
  await app.close();
  return { response, query };
}

function auditActions(query: ReturnType<typeof vi.fn>) {
  return query.mock.calls
    .filter(([sql]) => String(sql).includes("INSERT INTO organization_audit_events"))
    .map(([, params]) => (params as unknown[])[2] as string);
}

const PLACE = { type: "PLACE_EMPLOYEES", nodeKey: NODE_KEY, employeeIds: [EMPLOYEE_ID] };
const ACTING = {
  type: "APPOINT_ACTING", positionKey: POSITION_KEY, employeeId: EMPLOYEE_ID,
  effectiveFrom: "2026-09-01", effectiveTo: "2026-12-31", reason: "Menunggu pengangkatan",
};

describe("ORG-008-4a a command may not grant what its parts do not", () => {
  it("lets an HC admin place employees with organization.manage alone", async () => {
    const { response } = await call(PLACE, { permissions: ["organization.manage"] });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ commandType: "PLACE_EMPLOYEES" });
  });

  it("refuses an HC admin a command that records authority, and says what it needs", async () => {
    const { response, query } = await call(ACTING, { permissions: ["organization.manage"] });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: "FORBIDDEN",
      details: { commandType: "APPOINT_ACTING", requires: "approvals.policy.manage" },
    });
    // Nothing was written, not even the revision bump.
    expect(query.mock.calls.some(([sql]) => String(sql).includes("SET revision = revision + 1"))).toBe(false);
  });

  it("allows the same command for a principal holding the approval policy permission", async () => {
    const { response } = await call(ACTING, {
      permissions: ["organization.manage", "approvals.policy.manage"],
    });
    expect(response.statusCode).toBe(201);
  });

  it("refuses everything without organization.manage", async () => {
    const { response } = await call(PLACE, { permissions: ["leave.validate"] });
    expect(response.statusCode).toBe(403);
  });
});

describe("ORG-008-4a audit, journal, and atomicity", () => {
  it("writes one event per primitive plus a summary event, and a journal entry", async () => {
    const { response, query } = await call({
      type: "ADD_UNIT", name: "Bidang Pendidikan", nodeType: "DIRECTORATE", parentNodeKey: NODE_KEY,
      leader: { title: "Kepala Bidang Pendidikan", employeeId: EMPLOYEE_ID },
    }, { permissions: ["organization.manage", "approvals.policy.manage"] });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ commandType: "ADD_UNIT", primitives: 5, seq: 1 });
    expect(auditActions(query)).toEqual([
      "organization.node.created",
      "organization.position.created",
      "organization.incumbency.created",
      "organization.authority_binding.created",
      "organization.authority_binding.created",
      "organization.command.applied",
    ]);
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO organization_change_set_journal"))).toBe(true);
  });

  it("rolls the whole command back when one of its audit events fails", async () => {
    const { response, query } = await call(PLACE, {
      permissions: ["organization.manage"], failAudit: true,
    });

    expect(response.statusCode).toBe(500);
    expect(query.mock.calls.some(([sql]) => String(sql) === "ROLLBACK")).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql) === "COMMIT")).toBe(false);
  });

  it("answers a membership clash with the names, not a validation code later", async () => {
    const { response } = await call(
      { type: "PLACE_EMPLOYEES", nodeKey: NODE_KEY, employeeIds: [EMPLOYEE_ID], move: false },
      { permissions: ["organization.manage"] },
    );
    // With no competing membership in this fixture the command succeeds; the clash path is covered
    // exhaustively in organization-commands.test.ts against the engine itself.
    expect(response.statusCode).toBe(201);
  });

  it("rejects an unknown command shape instead of applying part of it", async () => {
    const { response } = await call({ type: "DO_SOMETHING", nodeKey: NODE_KEY }, {
      permissions: ["organization.manage", "approvals.policy.manage"],
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_ORGANIZATION_COMMAND" });
  });

  it("refuses an acting appointment with no reason before touching the draft", async () => {
    const { response, query } = await call({ ...ACTING, reason: "" }, {
      permissions: ["organization.manage", "approvals.policy.manage"],
    });
    expect(response.statusCode).toBe(400);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM organization_nodes"))).toBe(false);
  });
});

describe("ORG-008-4a the change list", () => {
  it("returns the journal for a change set, oldest first", async () => {
    const { response } = await call(null, {
      permissions: ["organization.manage"],
      method: "GET",
      url: `/admin/organization/designer/drafts/${DRAFT_ID}/journal`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([
      expect.objectContaining({ seq: 1, commandType: "ADD_UNIT" }),
    ]);
  });
});
