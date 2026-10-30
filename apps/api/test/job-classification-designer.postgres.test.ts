// ORG-011 Package 3: binding a classification to a seat through the designer.
// Synthetic structure and catalog only; each test rolls back.

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import { registerOrganizationAdminRoutes } from "../src/modules/organization/admin-routes.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

/**
 * The routes own their transactions; map them onto savepoints of the outer one.
 *
 * The designer routes build their own AuthService, so the session lookup and the permission
 * lookup are answered synthetically here while every other statement hits the real schema.
 * Who may reach these routes is already covered by organization-o1-permissions.test.ts; what
 * this file tests is what they write.
 */
function savepointPool(client: PoolClient, accountId: string): Pool {
  let depth = 0;
  const run = async (text: string, values?: unknown[]) => {
    const statement = String(text).trim().toUpperCase();
    if (String(text).includes("FROM auth_sessions s")) {
      return {
        rows: [{
          sessionId: "00000000-0000-4000-8000-000000000001",
          accountId,
          email: "org011d@example.invalid",
          principalType: "SUPER_ADMIN",
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        }],
        rowCount: 1,
      } as never;
    }
    if (String(text).includes("UPDATE auth_sessions SET last_seen_at")) {
      return { rows: [], rowCount: 1 } as never;
    }
    if (String(text).includes('SELECT DISTINCT role_permission.permission_key AS "permissionKey"')) {
      return { rows: [{ permissionKey: "organization.manage" }], rowCount: 1 } as never;
    }
    // The designer nests transactions: a route opens one and the repository opens another
    // when it sees a pool it can connect to. Track the savepoints as a stack and ignore a
    // stray COMMIT or ROLLBACK, or the depth counter goes negative and Postgres is asked to
    // release a savepoint that was never taken.
    if (statement.startsWith("BEGIN")) {
      depth += 1;
      return client.query(`SAVEPOINT test_sp_${depth}`);
    }
    if (statement.startsWith("COMMIT")) {
      if (depth === 0) return { rows: [], rowCount: 0 } as never;
      const name = `test_sp_${depth}`;
      depth -= 1;
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    if (statement.startsWith("ROLLBACK")) {
      if (depth === 0) return { rows: [], rowCount: 0 } as never;
      const name = `test_sp_${depth}`;
      depth -= 1;
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    return client.query(text, values);
  };
  const handle = { query: run, release: () => {} };
  return { query: run, connect: async () => handle } as unknown as Pool;
}

describe.skipIf(!allowed)("ORG-011 designer classification binding", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let accountId: string;
  let draftId: string;
  let nodeId: string;
  let nodeKey: string;
  let code: string;

  const effectiveOn = "2026-09-01";

  const cookie = { cookie: "hcis_session=synthetic" };

  async function post(url: string, payload: Record<string, unknown>) {
    return app.inject({ method: "POST", url, payload, headers: cookie });
  }

  async function createPosition(payload: Record<string, unknown>) {
    return post(`/admin/organization/designer/drafts/${draftId}/positions`, {
      nodeKey, title: "Kursi sintetis", ...payload,
    });
  }

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    code = `FUNC_${randomUUID().slice(0, 8).toUpperCase().replace(/[^A-Z0-9]/g, "X")}`;

    accountId = randomUUID();
    await client.query(
      `INSERT INTO accounts (id, employee_id, email, principal_type, status,
         mfa_secret_ciphertext, mfa_secret_iv, mfa_secret_tag, mfa_enabled_at)
       VALUES ($1, NULL, $2, 'SUPER_ADMIN', 'active', 'synthetic', 'synthetic', 'synthetic', now())`,
      [accountId, `org011d-${accountId}@example.invalid`],
    );
    await client.query(
      `INSERT INTO job_classifications (id, code, name, family, effective_from)
       VALUES ($1,$2,'Guru','FUNCTIONAL','2026-01-01'::date)`,
      [randomUUID(), code],
    );

    draftId = randomUUID();
    await client.query(
      `INSERT INTO organization_change_sets (id, name, effective_on, status, created_by_account_id)
       VALUES ($1,'Draf sintetis ORG-011',$2::date,'DRAFT',$3)`,
      [draftId, effectiveOn, accountId],
    );
    nodeId = randomUUID();
    nodeKey = randomUUID();
    await client.query(
      `INSERT INTO organization_nodes (id, change_set_id, stable_key, name, node_type, effective_from)
       VALUES ($1,$2,$3,'Unit sintetis','UNIT',$4::date)`,
      [nodeId, draftId, nodeKey, effectiveOn],
    );

    const config = {
      NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8,
    } as ApiConfig;
    app = Fastify({ logger: false });
    await registerOrganizationAdminRoutes(app, savepointPool(client, accountId), config);
  });

  afterEach(async () => {
    try { await app?.close(); } finally {
      if (client) { await client.query("ROLLBACK"); client.release(); }
    }
  });

  it("ORG-011-D1: a seat can be created carrying a classification", async () => {
    const created = await createPosition({ jobClassificationCode: code });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().jobClassificationCode).toBe(code);

    const stored = await client.query<{ code: string | null }>(
      `SELECT job_classification_code AS code FROM organization_positions WHERE id = $1`,
      [created.json().id],
    );
    expect(stored.rows[0]?.code).toBe(code);
  });

  it("ORG-011-D2: a seat defaults to no classification", async () => {
    const created = await createPosition({});
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().jobClassificationCode).toBeNull();
  });

  it("ORG-011-D3: a classification not in force on the change set date is refused", async () => {
    // The catalog is effective-dated and lives outside the change set, so a seat may only
    // name a classification that exists on the day the change set takes effect.
    await client.query(
      `UPDATE job_classifications SET effective_from = '2026-12-01'::date WHERE code = $1`,
      [code],
    );
    const created = await createPosition({ jobClassificationCode: code });
    expect(created.statusCode, created.body).toBe(400);
    expect(created.json().code).toBe("ORGANIZATION_CLASSIFICATION_NOT_EFFECTIVE");

    const rows = await client.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM organization_positions WHERE change_set_id = $1`,
      [draftId],
    );
    expect(rows.rows[0]!.total).toBe(0);
  });

  it("ORG-011-D4: an unknown classification code is refused", async () => {
    const created = await createPosition({ jobClassificationCode: "FUNC_TIDAK_ADA" });
    expect(created.statusCode, created.body).toBe(400);
    expect(created.json().code).toBe("ORGANIZATION_CLASSIFICATION_NOT_EFFECTIVE");
  });

  it("ORG-011-D5: a seat's classification can be changed and cleared", async () => {
    const created = await createPosition({});
    const positionId = created.json().id as string;
    const url = `/admin/organization/designer/drafts/${draftId}/positions/${positionId}`;

    const set = await app.inject({ method: "PATCH", url, payload: { jobClassificationCode: code }, headers: cookie });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().jobClassificationCode).toBe(code);

    // Clearing it means the seat says nothing and a placement decides on its own.
    const cleared = await app.inject({ method: "PATCH", url, payload: { jobClassificationCode: null }, headers: cookie });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json().jobClassificationCode).toBeNull();

    const stored = await client.query<{ code: string | null }>(
      `SELECT job_classification_code AS code FROM organization_positions WHERE id = $1`,
      [positionId],
    );
    expect(stored.rows[0]?.code).toBeNull();
  });

  it("ORG-011-D6: a patch naming a classification out of force is refused and changes nothing", async () => {
    const created = await createPosition({ jobClassificationCode: code });
    const positionId = created.json().id as string;
    await client.query(
      `UPDATE job_classifications SET effective_to = '2026-02-28'::date WHERE code = $1`,
      [code],
    );
    const patched = await app.inject({
      method: "PATCH",
      url: `/admin/organization/designer/drafts/${draftId}/positions/${positionId}`,
      payload: { title: "Judul baru", jobClassificationCode: code },
      headers: cookie,
    });
    expect(patched.statusCode, patched.body).toBe(400);

    // The title must not have been written either: the whole patch is refused.
    const stored = await client.query<{ title: string }>(
      `SELECT title FROM organization_positions WHERE id = $1`, [positionId],
    );
    expect(stored.rows[0]?.title).toBe("Kursi sintetis");
  });

  it("ORG-011-D7: a classification change is not reported as a visual-only change", async () => {
    // The regression this guards: classification stays out of the routing fingerprint on
    // purpose, so without its own fingerprint an operator who also nudged the layout would be
    // told the revision is cosmetic while an allowance moved underneath it.
    const base = randomUUID();
    await client.query(
      `INSERT INTO organization_change_sets
         (id, name, effective_on, status, created_by_account_id, validated_at, published_at)
       VALUES ($1,'Basis sintetis','2026-01-01'::date,'PUBLISHED',$2, now(), now())`,
      [base, accountId],
    );
    const positionKey = randomUUID();
    await client.query(
      `INSERT INTO organization_nodes (id, change_set_id, stable_key, name, node_type, effective_from)
       VALUES ($1,$2,$3,'Unit sintetis','UNIT','2026-01-01'::date)`,
      [randomUUID(), base, nodeKey],
    );
    await client.query(
      `INSERT INTO organization_positions
         (id, change_set_id, stable_key, node_key, title, effective_from, visual_rank_offset)
       VALUES ($1,$2,$3,$4,'Kursi sintetis','2026-01-01'::date,0)`,
      [randomUUID(), base, positionKey, nodeKey],
    );

    const revision = randomUUID();
    await client.query(
      `INSERT INTO organization_change_sets
         (id, name, effective_on, status, created_by_account_id, base_change_set_id)
       VALUES ($1,'Revisi sintetis','2026-09-01'::date,'DRAFT',$2,$3)`,
      [revision, accountId, base],
    );
    await client.query(
      `INSERT INTO organization_nodes (id, change_set_id, stable_key, name, node_type, effective_from)
       VALUES ($1,$2,$3,'Unit sintetis','UNIT','2026-01-01'::date)`,
      [randomUUID(), revision, nodeKey],
    );
    // Same seat, nudged layout only: that alone is a visual-only revision.
    const revisedPosition = randomUUID();
    await client.query(
      `INSERT INTO organization_positions
         (id, change_set_id, stable_key, node_key, title, effective_from, visual_rank_offset)
       VALUES ($1,$2,$3,$4,'Kursi sintetis','2026-01-01'::date,3)`,
      [revisedPosition, revision, positionKey, nodeKey],
    );

    const visual = await app.inject({
      method: "GET", url: `/admin/organization/designer/drafts/${revision}/impact`, headers: cookie,
    });
    expect(visual.statusCode, visual.body).toBe(200);
    expect(visual.json().visualOnlyChanges).toHaveLength(1);
    expect(visual.json().compensationImpact).toBe(false);

    // Now the same revision also moves the seat's classification.
    await client.query(
      `UPDATE organization_positions SET job_classification_code = $2 WHERE id = $1`,
      [revisedPosition, code],
    );
    const both = await app.inject({
      method: "GET", url: `/admin/organization/designer/drafts/${revision}/impact`, headers: cookie,
    });
    expect(both.statusCode, both.body).toBe(200);
    expect(both.json().compensationImpact).toBe(true);
    expect(both.json().visualOnlyChanges).toHaveLength(0);
  });
  it("ORG-011-D8: a patch that says nothing about the classification keeps it", async () => {
    // The guard is `"jobClassificationCode" in body.data`, which holds only because zod's
    // .partial() leaves a defaulted key absent. If that ever changes, every title edit would
    // silently clear the seat's classification, so lock it here.
    const created = await createPosition({ jobClassificationCode: code });
    const positionId = created.json().id as string;
    const patched = await app.inject({
      method: "PATCH",
      url: `/admin/organization/designer/drafts/${draftId}/positions/${positionId}`,
      payload: { title: "Judul baru" },
      headers: cookie,
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json().jobClassificationCode).toBe(code);

    const stored = await client.query<{ code: string | null; title: string }>(
      `SELECT job_classification_code AS code, title FROM organization_positions WHERE id = $1`,
      [positionId],
    );
    expect(stored.rows[0]).toEqual({ code, title: "Judul baru" });
  });

  it("ORG-011-D9: a malformed classification code is a validation error, not a catalog lookup", async () => {
    const created = await createPosition({ jobClassificationCode: "func guru" });
    expect(created.statusCode, created.body).toBe(400);
    expect(created.json().code).toBe("INVALID_ORGANIZATION_POSITION");
  });

  it("ORG-011-D10: validation refuses to pass a seat whose classification has lapsed", async () => {
    // A change set cloned from a published base carries its seats to a new effective date,
    // and the catalog can close after the seat was written. Neither goes through the write
    // path again, so validation is the last place to catch it before publish.
    const created = await createPosition({ jobClassificationCode: code });
    expect(created.statusCode, created.body).toBe(201);

    const before = await post(`/admin/organization/designer/drafts/${draftId}/validate`, {});
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json().issues.some((row: { code: string }) => row.code === "JOB_CLASSIFICATION_NOT_EFFECTIVE"))
      .toBe(false);

    await client.query(
      `UPDATE job_classifications SET effective_to = '2026-02-28'::date, active = false WHERE code = $1`,
      [code],
    );
    const after = await post(`/admin/organization/designer/drafts/${draftId}/validate`, {});
    expect(after.statusCode, after.body).toBe(200);
    expect(after.json().valid).toBe(false);
    expect(after.json().issues.some((row: { code: string }) => row.code === "JOB_CLASSIFICATION_NOT_EFFECTIVE"))
      .toBe(true);
  });
});
