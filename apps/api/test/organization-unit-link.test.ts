import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerOrganizationAdminRoutes } from "../src/modules/organization/admin-routes.js";

/**
 * ORG-008-6 (decision O-9, ATT-011 D-11): linking a structural unit to the imported unit that role
 * scopes point at, so "the employee's unit or the unit above it" can be resolved through the
 * structure's own hierarchy. An unlinked branch falls back rather than guessing.
 */

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://organization-unit-link-test",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

const DRAFT_ID = "00000000-0000-4000-8000-000000000010";
const FOUNDATION = "00000000-0000-4000-8000-000000000020";
const SCHOOL = "00000000-0000-4000-8000-000000000021";
const TEAM = "00000000-0000-4000-8000-000000000022";
const LEGACY_FOUNDATION = "00000000-0000-4000-8000-000000000030";
const LEGACY_SCHOOL = "00000000-0000-4000-8000-000000000031";

const PUBLISHED_ROW = {
  id: DRAFT_ID, name: "Struktur Sintetis", effectiveOn: "2026-10-01", status: "PUBLISHED",
  baseChangeSetId: null, validationReport: { valid: true, issues: [] },
  createdByAccountId: "00000000-0000-4000-8000-000000000002",
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  validatedAt: new Date("2026-09-20T00:00:00.000Z"),
  publishedAt: new Date("2026-09-20T00:00:00.000Z"),
  revision: 0,
};

function node(stableKey: string, name: string, parentNodeKey: string | null, legacyUnitId: string | null) {
  return {
    id: `${stableKey}-row`, stableKey, name, nodeType: "UNIT", parentNodeKey, active: true,
    effectiveFrom: "2026-01-01", effectiveTo: null, visualRankOffset: 0,
    integrationCode: null, legacyUnitId,
  };
}

function position(stableKey: string, nodeKey: string, title: string) {
  return {
    id: `${stableKey}-row`, stableKey, nodeKey, title, parentPositionKey: null, singleIncumbent: true,
    vacancyPolicy: "CLIMB_TO_PARENT", active: true, effectiveFrom: "2026-01-01", effectiveTo: null,
    visualRankOffset: 0, jobProfileKey: null, holderSource: "EMPLOYEE",
  };
}

function createPool(options: { nodes?: unknown[]; positions?: unknown[]; staff?: unknown[] } = {}) {
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
    if (sql.includes("FROM account_role_assignments")) {
      const rows = options.staff ?? [];
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM organization_change_sets")) return { rows: [PUBLISHED_ROW], rowCount: 1 };
    if (sql.includes("FROM organization_nodes")) {
      const rows = options.nodes ?? [];
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM organization_positions")) {
      const rows = options.positions ?? [];
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM organization_") || sql.includes("FROM employees")) return { rows: [], rowCount: 0 };
    throw new Error(`Unexpected unit-link SQL: ${sql}`);
  });
  const client = { query, release: vi.fn() };
  const pool = { query, connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, query };
}

async function call(url: string, options: Parameters<typeof createPool>[0] = {}) {
  const { pool, query } = createPool(options);
  const app = Fastify({ logger: false });
  await registerOrganizationAdminRoutes(app, pool, config);
  const response = await app.inject({ method: "GET", url, headers: { cookie: "hcis_session=synthetic" } });
  await app.close();
  return { response, query };
}

/** Team under school under foundation; only the school and foundation are linked. */
const LINKED_TREE = [
  node(FOUNDATION, "Yayasan", null, LEGACY_FOUNDATION),
  node(SCHOOL, "SDIT", FOUNDATION, LEGACY_SCHOOL),
  node(TEAM, "Kurikulum", SCHOOL, null),
];

describe("ORG-008-6 the unit above is resolved through the structure", () => {
  it("walks up from an unlinked team to the units that are linked", async () => {
    const { response } = await call(`/admin/organization/units/${TEAM}/hc-staff`, {
      nodes: LINKED_TREE,
      staff: [{ employeeId: "employee-hc", fullName: "Staf HC Sintetis", roleKey: "human_capital", unitId: LEGACY_SCHOOL, unitName: "SDIT" }],
    });

    expect(response.statusCode).toBe(200);
    // The team itself has no link, so the school answers first, then the foundation above it.
    expect(response.json().linkedUnitIds).toEqual([LEGACY_SCHOOL, LEGACY_FOUNDATION]);
    expect(response.json().fallback).toBe(false);
    expect(response.json().items).toEqual([expect.objectContaining({ fullName: "Staf HC Sintetis" })]);
  });

  it("starts from the unit itself when that one is linked", async () => {
    const { response } = await call(`/admin/organization/units/${SCHOOL}/hc-staff`, { nodes: LINKED_TREE });
    expect(response.json().linkedUnitIds).toEqual([LEGACY_SCHOOL, LEGACY_FOUNDATION]);
  });

  it("says it has to fall back when nothing up the branch is linked", async () => {
    const unlinked = [
      node(FOUNDATION, "Yayasan", null, null),
      node(SCHOOL, "SDIT", FOUNDATION, null),
    ];
    const { response, query } = await call(`/admin/organization/units/${SCHOOL}/hc-staff`, { nodes: unlinked });

    expect(response.json()).toMatchObject({ linkedUnitIds: [], fallback: true, items: [] });
    // No narrower guess is attempted: the staff lookup never runs. Matched on its own filter, not
    // on the table name, because the session's own permission lookup reads the same table.
    expect(query.mock.calls.some(([sql]) => String(sql).includes("assignment.scope_type = 'unit'"))).toBe(false);
  });

  it("does not loop forever if a unit ever points at itself", async () => {
    const cyclic = [{ ...node(SCHOOL, "SDIT", SCHOOL, LEGACY_SCHOOL) }];
    const { response } = await call(`/admin/organization/units/${SCHOOL}/hc-staff`, { nodes: cyclic });
    expect(response.json().linkedUnitIds).toEqual([LEGACY_SCHOOL]);
  });

  it("answers 404 for a unit that is not in the structure", async () => {
    const { response } = await call(`/admin/organization/units/${TEAM}/hc-staff`, { nodes: [node(SCHOOL, "SDIT", null, null)] });
    expect(response.statusCode).toBe(404);
  });
});

describe("ORG-008-6 picking a position for the overtime rule (D-10, gap S-4)", () => {
  const positions = [
    position("00000000-0000-4000-8000-000000000040", SCHOOL, "Wakil Kepala"),
    position("00000000-0000-4000-8000-000000000041", TEAM, "Wakil Kepala"),
    position("00000000-0000-4000-8000-000000000042", FOUNDATION, "Direktur"),
  ];

  it("returns the unit path, so two seats with the same title can be told apart", async () => {
    const { response } = await call("/admin/organization/positions/search?q=Wakil", {
      nodes: LINKED_TREE, positions,
    });

    const items = response.json().items;
    expect(items).toHaveLength(2);
    expect(items.map((item: { unitPath: string[] }) => item.unitPath.join(" > "))).toEqual([
      "Yayasan > SDIT",
      "Yayasan > SDIT > Kurikulum",
    ]);
  });

  it("identifies a seat by its stable key, which survives a rename", async () => {
    const { response } = await call("/admin/organization/positions/search?q=Direktur", {
      nodes: LINKED_TREE, positions,
    });
    expect(response.json().items[0]).toMatchObject({
      stableKey: "00000000-0000-4000-8000-000000000042", title: "Direktur",
    });
  });

  it("searches the unit path as well as the title", async () => {
    const { response } = await call("/admin/organization/positions/search?q=Kurikulum", {
      nodes: LINKED_TREE, positions,
    });
    expect(response.json().items).toHaveLength(1);
  });

  it("answers an empty list rather than failing when no structure is published", async () => {
    const { pool } = (() => {
      const query = vi.fn(async (sql: string) => {
        if (sql.includes('SELECT DISTINCT role_permission.permission_key AS "permissionKey"')) {
          return { rows: [{ permissionKey: "organization.manage" }], rowCount: 1 };
        }
        if (sql.includes("FROM auth_sessions s")) {
          return {
            rows: [{
              sessionId: "s", accountId: "a", email: "synthetic@example.invalid",
              principalType: "EMPLOYEE", expiresAt: new Date("2027-01-01T00:00:00.000Z"),
            }],
            rowCount: 1,
          };
        }
        if (sql.includes("UPDATE auth_sessions SET last_seen_at")) return { rows: [], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      });
      return { pool: { query, connect: vi.fn(async () => ({ query, release: vi.fn() })) } as unknown as Pool };
    })();
    const app = Fastify({ logger: false });
    await registerOrganizationAdminRoutes(app, pool, config);
    const response = await app.inject({
      method: "GET", url: "/admin/organization/positions/search",
      headers: { cookie: "hcis_session=synthetic" },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([]);
  });
});

describe("ORG-008-6 the link survives an edit", () => {
  it("writes legacy_unit_id back when the change set is rewritten", async () => {
    // replaceDraftSnapshot names every column it writes, so a new one that is read but not written
    // would be lost on the first edit after a change set is created. This asserts both halves.
    const here = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(join(here, "../src/modules/organization/repository.ts"), "utf8");
    const insert = source.slice(source.indexOf("INSERT INTO organization_nodes"));

    expect(insert.slice(0, 400)).toContain("legacy_unit_id");
    expect(insert.slice(0, 600)).toContain("item.legacyUnitId");
    expect(source).toContain('legacy_unit_id AS "legacyUnitId"');
  });

  it("keeps the column nullable and non-destructive in the migration", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = await readFile(join(here, "../migrations/0064_organization_node_legacy_unit.sql"), "utf8");

    expect(sql).toContain("ADD COLUMN IF NOT EXISTS legacy_unit_id uuid NULL");
    // Removing an imported unit must drop the link, never structure or published history.
    expect(sql).toContain("ON DELETE SET NULL");
    expect(sql).toContain("Rollback/recovery");
  });
});
