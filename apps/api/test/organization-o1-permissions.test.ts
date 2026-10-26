import { readFile } from "node:fs/promises";

import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  HC_ADMIN_PERMISSIONS,
  HC_LEAD_PERMISSIONS,
  HC_LEAD_ROLE_KEY,
  HC_OPERATIONAL_PERMISSIONS,
} from "../src/modules/auth/permissions.js";
import { canDelegateRole } from "../src/modules/auth/role-assignment.js";
import { registerOrganizationAdminRoutes } from "../src/modules/organization/admin-routes.js";

/**
 * ORG-008-8, decision O-1 (2026-10-16) with the Kepala HC role (owner decision 2026-10-24).
 *
 *   HC administrator   composes every part of a change set, including incumbents, acting holders,
 *                      authority and reporting exceptions — nothing in a draft takes effect.
 *   Kepala HC          the second pair of eyes: publishes, and changes approval policy that takes
 *                      effect (rollout, live direct managers, live unit leave approvers).
 *   HC operator        neither.
 *
 * Authorization review: this file is the matrix. A row that flips is a permission change.
 */

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://organization-o1-test",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

const DRAFT = "00000000-0000-4000-8000-000000000010";
const ITEM = "00000000-0000-4000-8000-000000000020";
const KEY = "00000000-0000-4000-8000-000000000030";
const EMPLOYEE = "00000000-0000-4000-8000-000000000040";

const PERSONAS = {
  hcOperator: [...HC_OPERATIONAL_PERMISSIONS] as string[],
  hcAdmin: [...HC_ADMIN_PERMISSIONS] as string[],
  hcLead: [...HC_LEAD_PERMISSIONS] as string[],
} as const;

type Persona = keyof typeof PERSONAS;

/** Every query past authorization answers empty, so a route that is allowed ends in 404 or 400. */
function createPool(permissions: string[]) {
  const query = vi.fn(async (sql: string) => {
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
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release: vi.fn() };
  return { query, connect: vi.fn(async () => client) } as unknown as Pool;
}

async function status(persona: Persona, method: string, url: string, payload?: unknown) {
  const app = Fastify({ logger: false });
  await registerOrganizationAdminRoutes(app, createPool(PERSONAS[persona]), config);
  const response = await app.inject({
    method: method as "GET",
    url,
    headers: { cookie: "hcis_session=synthetic" },
    ...(payload === undefined ? {} : { payload }),
  });
  await app.close();
  return response.statusCode;
}

const drafts = `/admin/organization/designer/drafts/${DRAFT}`;

/** Composing inside an unpublished change set. */
const COMPOSE: Array<[string, string, string, unknown]> = [
  ["pejabat & Plt", "PUT", `${drafts}/incumbencies`, { positionKey: KEY, primaryEmployeeId: EMPLOYEE, effectiveFrom: "2027-01-01" }],
  ["kewenangan", "POST", `${drafts}/authority-bindings`,
    { sourceType: "NODE", sourceKey: KEY, authorityType: "LEADER", targetPositionKey: KEY, vacancyPolicy: "CLIMB_TO_PARENT", effectiveFrom: "2027-01-01" }],
  ["atasan khusus", "POST", `${drafts}/reporting-overrides`,
    { employeeId: EMPLOYEE, managerPositionKey: KEY, reason: "Pengecualian sintetis", effectiveFrom: "2027-01-01" }],
  ["hapus kewenangan", "DELETE", `${drafts}/authority-bindings/${ITEM}`, undefined],
  ["akhiri kewenangan", "PATCH", `${drafts}/authority-bindings/${ITEM}`, { effectiveTo: "2027-06-30" }],
  ["perintah Tunjuk Plt", "POST", `${drafts}/commands`,
    { type: "APPOINT_ACTING", positionKey: KEY, employeeId: EMPLOYEE, effectiveFrom: "2027-01-01", effectiveTo: "2027-06-30", reason: "Sintetis" }],
  ["usulan dari data lama", "POST", "/admin/organization/designer/drafts/from-legacy",
    { name: "Usulan sintetis", effectiveOn: "2027-01-01" }],
];

/** What takes effect: only the second pair of eyes. */
const TAKE_EFFECT: Array<[string, string, string, unknown]> = [
  ["terbitkan", "POST", `${drafts}/publish`, undefined],
  ["ubah rollout", "PATCH", "/admin/organization/rollout", { mode: "LEGACY", workflowKey: "LEAVE" }],
];

const DENIED = new Set([401, 403]);

describe("ORG-008-8 HC administrators compose every part of a change set (O-1)", () => {
  it.each(COMPOSE)("HC admin may %s", async (_name, method, url, payload) => {
    expect(DENIED.has(await status("hcAdmin", method, url, payload))).toBe(false);
  });

  it.each(COMPOSE)("HC operator may not %s", async (_name, method, url, payload) => {
    expect(await status("hcOperator", method, url, payload)).toBe(403);
  });
});

describe("ORG-008-8 only the second pair of eyes makes anything take effect", () => {
  it.each(TAKE_EFFECT)("HC admin may not %s", async (_name, method, url, payload) => {
    expect(await status("hcAdmin", method, url, payload)).toBe(403);
  });

  it.each(TAKE_EFFECT)("Kepala HC may %s", async (_name, method, url, payload) => {
    expect(DENIED.has(await status("hcLead", method, url, payload))).toBe(false);
  });

  it.each(TAKE_EFFECT)("HC operator may not %s", async (_name, method, url, payload) => {
    expect(await status("hcOperator", method, url, payload)).toBe(403);
  });

  it("keeps live direct managers and unit leave approvers behind approvals.policy.manage", async () => {
    // These two routes live in other modules; the manifest is their source of truth, and this PR must
    // not loosen them. They are what LEGACY approval routing reads today.
    const manifest = JSON.parse(await readFile(
      new URL("../../../docs/domain/AUTH-011-admin-route-permissions.json", import.meta.url), "utf8",
    )) as Array<{ method: string; url: string; permissions: string[] }>;
    const permissionsOf = (method: string, url: string) =>
      manifest.find((entry) => entry.method === method && entry.url === url)?.permissions;

    expect(permissionsOf("PATCH", "/admin/employees/:employeeId/manager")).toEqual(["approvals.policy.manage"]);
    expect(permissionsOf("PATCH", "/admin/leave/units/:unitId/approver")).toEqual(["approvals.policy.manage"]);
    expect(permissionsOf("POST", "/admin/organization/designer/drafts/:draftId/publish")).toEqual(["approvals.policy.manage"]);
    expect(permissionsOf("PATCH", "/admin/organization/rollout")).toEqual(["approvals.policy.manage"]);
  });

  it("leaves approvals.policy.manage guarding exactly what takes effect, and nothing else", async () => {
    const manifest = JSON.parse(await readFile(
      new URL("../../../docs/domain/AUTH-011-admin-route-permissions.json", import.meta.url), "utf8",
    )) as Array<{ method: string; url: string; permissions: string[] }>;
    const guarded = manifest
      .filter((entry) => entry.permissions.includes("approvals.policy.manage"))
      .map((entry) => `${entry.method} ${entry.url}`)
      .sort();

    expect(guarded).toEqual([
      "PATCH /admin/employees/:employeeId/manager",
      "PATCH /admin/leave/units/:unitId/approver",
      "PATCH /admin/organization/rollout",
      "POST /admin/organization/designer/drafts/:draftId/publish",
    ]);
  });
});

describe("ORG-008-8 the Kepala HC role", () => {
  it("holds exactly organization.manage and approvals.policy.manage", () => {
    expect([...HC_LEAD_PERMISSIONS].sort()).toEqual(["approvals.policy.manage", "organization.manage"]);
  });

  it("holds no operational HC permission, so it is not a back door into day-to-day HC work", () => {
    for (const permission of HC_OPERATIONAL_PERMISSIONS) {
      expect(HC_LEAD_PERMISSIONS as readonly string[]).not.toContain(permission);
    }
  });

  it("does not put approvals.policy.manage into the HC admin bundle, which would collapse the four eyes", () => {
    expect(HC_ADMIN_PERMISSIONS as readonly string[]).not.toContain("approvals.policy.manage");
  });

  it("can be granted through the reviewed path, but never by an HC administrator", () => {
    const role = { roleKey: HC_LEAD_ROLE_KEY, permissions: [...HC_LEAD_PERMISSIONS] };
    // Super Admin holds access.roles.delegate through compatibility, so it may grant the role.
    expect(canDelegateRole(role, true)).toBe(true);
    // Nobody else may; the Super Admin principal check runs before this as well.
    expect(canDelegateRole(role, false)).toBe(false);
  });

  it("is created by migration with no account assigned", async () => {
    const sql = await readFile(new URL("../migrations/0065_human_capital_lead_role.sql", import.meta.url), "utf8");
    const body = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");

    expect(body).toContain("'human_capital_lead'");
    expect(body).toContain("'organization.manage'");
    expect(body).toContain("'approvals.policy.manage'");
    expect(body).not.toMatch(/INSERT INTO account_role_assignments/i);
    expect(sql).toContain("Rollback/recovery");
  });
});
