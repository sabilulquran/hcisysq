import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerOrganizationAdminRoutes } from "../src/modules/organization/admin-routes.js";

/**
 * ORG-008-4b at the route: published structure can only be deactivated, nothing goes while
 * something still points at it, and the refusal says what points at it.
 */

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://organization-corrections-test",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

const DRAFT_ID = "00000000-0000-4000-8000-000000000010";
const NODE_ID = "00000000-0000-4000-8000-000000000011";
const NODE_KEY = "00000000-0000-4000-8000-000000000020";
const POSITION_ID = "00000000-0000-4000-8000-000000000012";
const POSITION_KEY = "00000000-0000-4000-8000-000000000030";
const BINDING_ID = "00000000-0000-4000-8000-000000000050";

const DRAFT_ROW = {
  id: DRAFT_ID, name: "Restruktur Sintetis", effectiveOn: "2027-01-01", status: "DRAFT",
  baseChangeSetId: null, validationReport: { valid: false, issues: [] },
  createdByAccountId: "00000000-0000-4000-8000-000000000002",
  createdAt: new Date("2026-10-01T00:00:00.000Z"),
  validatedAt: null, publishedAt: null, revision: 1,
};

const NODE_ROW = {
  id: NODE_ID, stableKey: NODE_KEY, name: "Bidang Baru", nodeType: "UNIT", parentNodeKey: null,
  active: true, effectiveFrom: "2027-01-01", effectiveTo: null, visualRankOffset: 0, integrationCode: null,
};

const POSITION_ROW = {
  id: POSITION_ID, stableKey: POSITION_KEY, nodeKey: NODE_KEY, title: "Kepala Bidang Baru",
  parentPositionKey: null, singleIncumbent: true, vacancyPolicy: "CLIMB_TO_PARENT", active: true,
  effectiveFrom: "2027-01-01", effectiveTo: null, visualRankOffset: 0,
  jobProfileKey: null, holderSource: "EMPLOYEE",
};

function createPool(options: {
  permissions?: string[];
  published?: boolean;
  positions?: unknown[];
  bindings?: unknown[];
  /** ORG-005-1: null when the work location does not exist. */
  workLocationActive?: boolean | null;
} = {}) {
  const permissions = options.permissions ?? ["organization.manage", "approvals.policy.manage"];
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
    if (sql.includes("SELECT active FROM attendance_work_locations")) {
      return options.workLocationActive === null || options.workLocationActive === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ active: options.workLocationActive }], rowCount: 1 };
    }
    if (sql.includes("AS published")) return { rows: [{ published: options.published === true }], rowCount: 1 };
    if (sql.includes("INSERT INTO organization_audit_events")) return { rows: [], rowCount: 1 };
    if (sql.includes("SET revision = revision + 1")) return { rows: [{ revision: 2 }], rowCount: 1 };
    if (sql.includes("UPDATE organization_change_sets")) return { rows: [], rowCount: 1 };
    if (sql.includes("FROM organization_change_sets")) return { rows: [DRAFT_ROW], rowCount: 1 };
    if (sql.includes("FROM organization_nodes")) return { rows: [NODE_ROW], rowCount: 1 };
    if (sql.includes("FROM organization_positions")) {
      const rows = options.positions ?? [];
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM organization_authority_bindings")) {
      const rows = options.bindings ?? [];
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM organization_") || sql.includes("FROM employees")) return { rows: [], rowCount: 0 };
    if (sql.includes("DELETE FROM organization_") || sql.includes("INSERT INTO organization_")) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected correction SQL: ${sql}`);
  });
  const client = { query, release: vi.fn() };
  const pool = { query, connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, query };
}

async function call(
  method: "DELETE" | "PATCH",
  url: string,
  options: Parameters<typeof createPool>[0] & { payload?: unknown } = {},
) {
  const { pool, query } = createPool(options);
  const app = Fastify({ logger: false });
  await registerOrganizationAdminRoutes(app, pool, config);
  const response = await app.inject({
    method,
    url,
    headers: { cookie: "hcis_session=synthetic" },
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
  await app.close();
  return { response, query };
}

const nodeUrl = `/admin/organization/designer/drafts/${DRAFT_ID}/nodes/${NODE_ID}`;
const positionUrl = `/admin/organization/designer/drafts/${DRAFT_ID}/positions/${POSITION_ID}`;
const bindingUrl = `/admin/organization/designer/drafts/${DRAFT_ID}/authority-bindings/${BINDING_ID}`;

describe("ORG-008-4b deleting an item that was never published", () => {
  it("removes a unit typed in by mistake inside this change set", async () => {
    const { response, query } = await call("DELETE", nodeUrl);

    expect(response.statusCode).toBe(204);
    const audit = query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO organization_audit_events"));
    expect((audit?.[1] as unknown[])[2]).toBe("organization.node.deleted");
  });

  it("refuses to delete published structure and points at deactivating instead", async () => {
    const { response, query } = await call("DELETE", nodeUrl, { published: true });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "ORGANIZATION_ITEM_PUBLISHED",
      details: { deactivateInstead: true },
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM organization_nodes"))).toBe(false);
  });

  it("refuses while something still points at the unit, and names it", async () => {
    const { response } = await call("DELETE", nodeUrl, { positions: [POSITION_ROW] });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "ORGANIZATION_ITEM_IN_USE",
      details: { itemKind: "unit", uses: [{ kind: "POSITION", name: "Kepala Bidang Baru" }] },
    });
  });

  it("removes a position that exists only inside this change set", async () => {
    const { response, query } = await call("DELETE", positionUrl, { positions: [POSITION_ROW] });

    expect(response.statusCode).toBe(204);
    const audit = query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO organization_audit_events"));
    expect((audit?.[1] as unknown[])[2]).toBe("organization.position.deleted");
  });

  it("refuses to delete a published position", async () => {
    const { response } = await call("DELETE", positionUrl, { positions: [POSITION_ROW], published: true });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "ORGANIZATION_ITEM_PUBLISHED",
      details: { itemKind: "jabatan" },
    });
  });

  it("answers 404 for an item that is not in this change set", async () => {
    const { response } = await call(
      "DELETE",
      `/admin/organization/designer/drafts/${DRAFT_ID}/nodes/00000000-0000-4000-8000-0000000000ff`,
    );
    expect(response.statusCode).toBe(404);
  });
});

describe("ORG-008-4b deactivating is refused while something points at the item", () => {
  it("refuses to switch off a unit that still has a position", async () => {
    const { response } = await call("PATCH", nodeUrl, {
      positions: [POSITION_ROW],
      payload: { active: false },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "ORGANIZATION_ITEM_IN_USE" });
  });

  it("allows switching off a unit nothing points at", async () => {
    const { response } = await call("PATCH", nodeUrl, { payload: { active: false } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ active: false });
  });
});

describe("ORG-008-4b correcting authority inside a change set (gap W-1)", () => {
  const draftBinding = {
    id: BINDING_ID, subjectKind: "NODE", subjectKey: NODE_KEY, bindingType: "LEADER",
    targetPositionKey: POSITION_KEY, vacancyPolicy: "CLIMB_TO_PARENT",
    effectiveFrom: "2027-01-01", effectiveTo: null,
  };
  const publishedBinding = { ...draftBinding, effectiveFrom: "2026-01-01" };

  it("deletes a binding created inside this change set", async () => {
    const { response } = await call("DELETE", bindingUrl, { bindings: [draftBinding] });
    expect(response.statusCode).toBe(204);
  });

  it("refuses to delete authority that came from published structure, and offers to end it", async () => {
    const { response } = await call("DELETE", bindingUrl, { bindings: [publishedBinding] });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "ORGANIZATION_ITEM_PUBLISHED",
      details: { endInstead: true },
    });
  });

  it("ends a published binding with an end date", async () => {
    const { response } = await call("PATCH", bindingUrl, {
      bindings: [publishedBinding],
      payload: { effectiveTo: "2026-12-31" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ effectiveTo: "2026-12-31", authorityType: "LEADER" });
  });

  it("refuses an end date before the authority began", async () => {
    const { response } = await call("PATCH", bindingUrl, {
      bindings: [publishedBinding],
      payload: { effectiveTo: "2025-01-01" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "ORGANIZATION_BINDING_PERIOD_INVALID" });
  });

  it("lets an HC admin correct authority inside a change set (ORG-008-8, decision O-1)", async () => {
    const { response } = await call("DELETE", bindingUrl, {
      bindings: [draftBinding],
      permissions: ["organization.manage"],
    });
    expect(response.statusCode).toBe(204);
  });

  it("refuses a session without organization.manage", async () => {
    const { response } = await call("DELETE", bindingUrl, {
      bindings: [draftBinding],
      permissions: ["approvals.policy.manage"],
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("ORG-008 review: manual edits and refusals", () => {
  it("records a manual edit as a line of the change list, so a rebuild cannot drop it silently", async () => {
    const { response, query } = await call("PATCH", nodeUrl, { payload: { name: "Bidang Diganti" } });

    expect(response.statusCode).toBe(200);
    const line = query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO organization_change_set_journal"));
    const params = line?.[1] as unknown[];
    expect(params[2]).toBe("MANUAL_EDIT");
    expect(JSON.parse(params[3] as string)).toEqual({ replayable: false });
    expect(JSON.parse(params[4] as string)).toMatchObject({ action: "node.updated", nodeKey: NODE_KEY, fields: ["name"] });
  });

  it("rolls a refusal back, so the revision it claimed does not move", async () => {
    const { response, query } = await call("DELETE", nodeUrl, { positions: [POSITION_ROW] });

    expect(response.statusCode).toBe(409);
    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes("SET revision = revision + 1"))).toBe(true);
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });
});

describe("ORG-005-1 a unit names the work location it works at", () => {
  const LOCATION = "00000000-0000-4000-8000-000000000070";

  it("links an active location and records it in the change list", async () => {
    const { response, query } = await call("PATCH", nodeUrl, {
      workLocationActive: true, payload: { workLocationId: LOCATION },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ workLocationId: LOCATION });
    const insert = query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO organization_nodes"));
    expect((insert?.[1] as unknown[])[12]).toBe(LOCATION);
    const line = query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO organization_change_set_journal"));
    expect(JSON.parse((line?.[1] as unknown[])[4] as string)).toMatchObject({ action: "node.updated", fields: ["workLocationId"] });
  });

  it("refuses an inactive or unknown location, and rolls back", async () => {
    for (const workLocationActive of [false, null]) {
      const { response, query } = await call("PATCH", nodeUrl, { workLocationActive, payload: { workLocationId: LOCATION } });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "INVALID_WORK_LOCATION" });
      expect(query.mock.calls.map(([sql]) => String(sql))).toContain("ROLLBACK");
    }
  });

  it("clears the link without looking the location up", async () => {
    const { response, query } = await call("PATCH", nodeUrl, { payload: { workLocationId: null } });
    expect(response.statusCode).toBe(200);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("attendance_work_locations"))).toBe(false);
  });
});
