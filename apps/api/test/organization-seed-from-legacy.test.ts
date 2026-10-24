import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerOrganizationAdminRoutes } from "../src/modules/organization/admin-routes.js";
import type { OrganizationSnapshot } from "../src/modules/organization/domain.js";
import {
  buildSeedFromLegacy,
  type LegacyEmployeeRow,
  type LegacyUnitRow,
} from "../src/modules/organization/seed-from-legacy.js";

/**
 * ORG-008-7 (decision O-3): a first change set built from what HCIS already records, so the
 * structure does not have to be retyped (gap S-1). Nothing is inferred from a job title, nothing is
 * published, and rollout is never touched.
 */

const EFFECTIVE_ON = "2027-01-01";

const CHANGE_SET: OrganizationSnapshot["changeSet"] = {
  id: "change-set", name: "Usulan dari data lama", effectiveOn: EFFECTIVE_ON, status: "DRAFT",
  baseChangeSetId: null, validationReport: { valid: false, issues: [], checkedAt: "" },
  createdByAccountId: "actor", createdAt: "2026-10-24T00:00:00Z",
  validatedAt: null, publishedAt: null, revision: 0,
};

const SDIT = "unit-sdit";
const SOCIAL = "unit-social";

function unit(id: string, name: string, leaveApproverEmployeeId: string | null = null): LegacyUnitRow {
  return { id, name, leaveApproverEmployeeId };
}

function employee(
  id: string,
  organizationalUnitId: string | null,
  directManagerEmployeeId: string | null = null,
): LegacyEmployeeRow {
  return { id, organizationalUnitId, directManagerEmployeeId };
}

function seed(units: LegacyUnitRow[], employees: LegacyEmployeeRow[]) {
  return buildSeedFromLegacy({ changeSet: CHANGE_SET, units, employees });
}

describe("ORG-008-7 what carries over from the old data", () => {
  it("creates one unit per imported unit, already linked to it", () => {
    const { snapshot, summary } = seed([unit(SDIT, "SDIT"), unit(SOCIAL, "Divisi Sosial")], []);

    expect(summary.units).toBe(2);
    expect(snapshot.nodes.map((node) => node.name)).toEqual(["SDIT", "Divisi Sosial"]);
    // ORG-008-6 (O-9): the link is known for free here, and overtime notification needs it.
    expect(snapshot.nodes.map((node) => node.legacyUnitId)).toEqual([SDIT, SOCIAL]);
    // The imported list is flat and carries no parent, so the proposal is flat too.
    expect(snapshot.nodes.every((node) => node.parentNodeKey === null)).toBe(true);
  });

  it("places every active employee who has a unit, and counts the ones who do not", () => {
    const { snapshot, summary } = seed(
      [unit(SDIT, "SDIT")],
      [employee("employee-ahmad", SDIT), employee("employee-citra", null)],
    );

    expect(summary.placements).toBe(1);
    expect(summary.employeesWithoutUnit).toBe(1);
    expect(snapshot.memberships).toHaveLength(1);
    expect(snapshot.memberships[0]).toMatchObject({ employeeId: "employee-ahmad", isPrimary: true });
  });

  it("carries the unit's recorded leave approver over as a seat and a binding", () => {
    const { snapshot, summary } = seed([unit(SDIT, "SDIT", "employee-hasan")], []);

    expect(summary.unitApprovers).toBe(1);
    expect(snapshot.positions[0]?.title).toBe("Penyetuju cuti SDIT");
    expect(snapshot.incumbencies[0]).toMatchObject({ employeeId: "employee-hasan", kind: "PRIMARY" });
    expect(snapshot.authorityBindings[0]).toMatchObject({ bindingType: "UNIT_APPROVER" });
  });

  it("makes one shared manager the unit's leader", () => {
    const { snapshot, summary } = seed(
      [unit(SDIT, "SDIT")],
      [
        employee("employee-ahmad", SDIT, "employee-hasan"),
        employee("employee-budi", SDIT, "employee-hasan"),
      ],
    );

    expect(summary.unitLeaders).toBe(1);
    expect(summary.reportingExceptions).toBe(0);
    expect(snapshot.positions[0]?.title).toBe("Pemimpin SDIT");
    expect(snapshot.authorityBindings[0]).toMatchObject({ bindingType: "LEADER" });
    expect(snapshot.incumbencies[0]?.employeeId).toBe("employee-hasan");
  });

  it("keeps different managers as per-employee exceptions, which is what the old data says", () => {
    const { snapshot, summary } = seed(
      [unit(SDIT, "SDIT")],
      [
        employee("employee-ahmad", SDIT, "employee-hasan"),
        employee("employee-budi", SDIT, "employee-yusuf"),
      ],
    );

    expect(summary.unitLeaders).toBe(0);
    expect(summary.reportingExceptions).toBe(2);
    // Pointing at the person as ORG-002 records it, rather than inventing a seat for them.
    expect(snapshot.reportingOverrides[0]).toMatchObject({
      employeeId: "employee-ahmad", managerEmployeeId: "employee-hasan", managerPositionKey: null,
    });
    expect(snapshot.reportingOverrides[0]?.reason).toContain("tinjau sebelum diterbitkan");
  });

  it("does not make someone the leader of a unit they are a member of", () => {
    // Everyone reports to Hasan, and Hasan is in the unit: making him its leader would make him his
    // own manager, which the resolver refuses. It stays an exception for the reviewer to arrange.
    const { snapshot, summary } = seed(
      [unit(SDIT, "SDIT")],
      [
        employee("employee-ahmad", SDIT, "employee-hasan"),
        employee("employee-hasan", SDIT, "employee-hasan"),
      ],
    );

    expect(summary.unitLeaders).toBe(0);
    expect(snapshot.authorityBindings.filter((item) => item.bindingType === "LEADER")).toHaveLength(0);
    // Hasan manages himself in the old data; that is counted, not copied.
    expect(summary.employeesWithoutManager).toBe(1);
    expect(snapshot.reportingOverrides).toHaveLength(1);
  });

  it("counts an employee with no recorded manager instead of guessing one", () => {
    const { snapshot, summary } = seed(
      [unit(SDIT, "SDIT")],
      [employee("employee-ahmad", SDIT, null), employee("employee-budi", SDIT, "employee-hasan")],
    );

    expect(summary.employeesWithoutManager).toBe(1);
    expect(summary.unitLeaders).toBe(0);
    expect(snapshot.reportingOverrides).toHaveLength(1);
  });

  it("invents no title beyond the two it derives from the unit's own name (invariant I-7)", () => {
    const { snapshot } = seed(
      [unit(SDIT, "SDIT", "employee-hasan")],
      [employee("employee-ahmad", SDIT, "employee-yusuf"), employee("employee-budi", SDIT, "employee-yusuf")],
    );

    expect(snapshot.positions.map((position) => position.title).sort())
      .toEqual(["Pemimpin SDIT", "Penyetuju cuti SDIT"]);
    for (const position of snapshot.positions) {
      expect(position.title).toContain("SDIT");
    }
  });

  it("produces nothing at all from no legacy data, rather than a skeleton", () => {
    const { snapshot, summary } = seed([], []);
    expect(snapshot.nodes).toEqual([]);
    expect(summary).toMatchObject({ units: 0, placements: 0, unitApprovers: 0, unitLeaders: 0 });
  });
});

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://organization-seed-test",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

function createPool(options: { permissions?: string[]; openDraft?: boolean; published?: boolean } = {}) {
  const permissions = options.permissions ?? ["organization.manage", "approvals.policy.manage"];
  const sqlLog: string[] = [];
  const query = vi.fn(async (sql: string) => {
    sqlLog.push(sql);
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
    if (sql.includes("FROM organizational_units")) {
      return { rows: [{ id: SDIT, name: "SDIT", leaveApproverEmployeeId: null }], rowCount: 1 };
    }
    if (sql.includes("FROM employees")) {
      return {
        rows: [{ id: "employee-ahmad", organizationalUnitId: SDIT, directManagerEmployeeId: null }],
        rowCount: 1,
      };
    }
    if (sql.includes("INSERT INTO organization_change_sets")) {
      return {
        rows: [{
          id: "new-draft", name: "Usulan dari data lama", effectiveOn: EFFECTIVE_ON, status: "DRAFT",
          baseChangeSetId: null, validationReport: {},
          createdByAccountId: "00000000-0000-4000-8000-000000000002",
          createdAt: new Date("2026-10-24T00:00:00.000Z"),
          validatedAt: null, publishedAt: null, revision: 0,
        }],
        rowCount: 1,
      };
    }
    // The row lock replaceDraftSnapshot takes also reads this table, so it is matched first.
    if (sql.includes("FOR UPDATE")) return { rows: [{ status: "DRAFT" }], rowCount: 1 };
    if (sql.includes("FROM organization_change_sets")) {
      if (sql.includes("status = ANY($1::text[])")) {
        return options.openDraft
          ? { rows: [{
              id: "open-draft", name: "Perubahan Lain", effectiveOn: EFFECTIVE_ON, status: "DRAFT",
              baseChangeSetId: null, validationReport: {}, createdByAccountId: "actor",
              createdAt: new Date("2026-10-01T00:00:00.000Z"), validatedAt: null, publishedAt: null, revision: 0,
            }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (sql.includes("effective_on <= $1::date")) {
        return options.published
          ? { rows: [{
              id: "published", name: "Struktur Berlaku", effectiveOn: "2026-10-01", status: "PUBLISHED",
              baseChangeSetId: null, validationReport: {}, createdByAccountId: "actor",
              createdAt: new Date("2026-09-01T00:00:00.000Z"),
              validatedAt: new Date("2026-09-20T00:00:00.000Z"),
              publishedAt: new Date("2026-09-20T00:00:00.000Z"), revision: 0,
            }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM organization_")) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO organization_") || sql.includes("DELETE FROM organization_")
      || sql.includes("UPDATE organization_change_sets")) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected seed SQL: ${sql}`);
  });
  const client = { query, release: vi.fn() };
  const pool = { query, connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, query, sqlLog };
}

async function call(options: Parameters<typeof createPool>[0] = {}) {
  const { pool, query, sqlLog } = createPool(options);
  const app = Fastify({ logger: false });
  await registerOrganizationAdminRoutes(app, pool, config);
  const response = await app.inject({
    method: "POST",
    url: "/admin/organization/designer/drafts/from-legacy",
    headers: { cookie: "hcis_session=synthetic" },
    payload: { name: "Usulan dari data lama", effectiveOn: EFFECTIVE_ON },
  });
  await app.close();
  return { response, query, sqlLog };
}

describe("ORG-008-7 at the route", () => {
  it("creates the change set and reports what it proposed", async () => {
    const { response } = await call();

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      proposal: true,
      summary: { units: 1, placements: 1, employeesWithoutManager: 1 },
    });
  });

  it("never touches rollout", async () => {
    const { sqlLog } = await call();
    expect(sqlLog.some((sql) => sql.includes("organization_rollout_settings"))).toBe(false);
  });

  it("records where the content came from, in the audit and the change list", async () => {
    const { query } = await call();
    const actions = query.mock.calls
      .filter(([sql]) => String(sql).includes("INSERT INTO organization_audit_events"))
      .map(([, params]) => (params as unknown[])[2] as string);

    expect(actions).toContain("organization.draft.seeded_from_legacy");
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO organization_change_set_journal"))).toBe(true);
  });

  it("refuses when a change is already open (decision O-7)", async () => {
    const { response } = await call({ openDraft: true });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "ORGANIZATION_DRAFT_ALREADY_OPEN" });
  });

  it("refuses when a structure is already effective, instead of merging on a guess", async () => {
    const { response } = await call({ published: true });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "ORGANIZATION_STRUCTURE_EXISTS" });
  });

  it("needs the approval permission, because it writes incumbents and authority", async () => {
    const { response } = await call({ permissions: ["organization.manage"] });
    expect(response.statusCode).toBe(403);
  });
});
