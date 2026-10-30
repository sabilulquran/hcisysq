// ORG-011 Package 1 acceptance against a real schema.
// Synthetic catalog entries only; every test runs inside one rolled-back transaction.

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import { registerJobClassificationRoutes } from "../src/modules/organization/job-classification-routes.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

/** The routes own their transactions; map them onto savepoints of the outer one. */
function savepointPool(client: PoolClient): Pool {
  let depth = 0;
  const run = async (text: string, values?: unknown[]) => {
    const statement = String(text).trim().toUpperCase();
    if (statement.startsWith("BEGIN")) return client.query(`SAVEPOINT test_sp_${++depth}`);
    if (statement.startsWith("COMMIT")) {
      const name = `test_sp_${depth}`;
      depth -= 1;
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    if (statement.startsWith("ROLLBACK")) {
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

describe.skipIf(!allowed)("ORG-011 job classification catalog", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let permissions: string[];
  let principal: AuthPrincipal;
  let suffix: string;

  const codes = {
    grade: () => `G${suffix}`,
    functional: () => `FUNC_${suffix}`,
    structural: () => `STRUCT_${suffix}`,
  };

  function post(url: string, payload: Record<string, unknown>) {
    return app.inject({ method: "POST", url, payload });
  }

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    // Codes are globally unique over a date range, so each test uses its own.
    suffix = randomUUID().slice(0, 8).toUpperCase().replace(/[^A-Z0-9]/g, "X");

    // A Super Admin row carries MFA enrolment; the schema refuses one without it.
    const accountId = randomUUID();
    await client.query(
      `INSERT INTO accounts (
         id, employee_id, email, principal_type, status,
         mfa_secret_ciphertext, mfa_secret_iv, mfa_secret_tag, mfa_enabled_at
       ) VALUES ($1, NULL, $2, 'SUPER_ADMIN', 'active', 'synthetic', 'synthetic', 'synthetic', now())`,
      [accountId, `org011-${accountId}@example.invalid`],
    );
    principal = { id: accountId, email: "org011@example.invalid", principalType: "SUPER_ADMIN" };
    permissions = ["job_classifications.read", "job_classifications.manage"];

    const config = {
      NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8,
    } as ApiConfig;
    app = Fastify({ logger: false });
    await registerJobClassificationRoutes(app, savepointPool(client), config, {
      getSession: async () => ({ principal, expiresAt: "2099-01-01T00:00:00Z" }),
      getAuthorizationContext: async () => ({ organizationPermissions: permissions }),
    } as never);
  });

  afterEach(async () => {
    try { await app?.close(); } finally {
      if (client) { await client.query("ROLLBACK"); client.release(); }
    }
  });

  it("ORG-011-A: creates a classification and resolves it on a date", async () => {
    const created = await post("/admin/job-classifications", {
      code: codes.functional(), name: "Guru", family: "FUNCTIONAL", effectiveFrom: "2026-01-01",
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().classification.gradeCode).toBeNull();

    const onDate = await app.inject({
      method: "GET", url: `/admin/job-classifications/${codes.functional()}?onDate=2026-06-01`,
    });
    expect(onDate.statusCode, onDate.body).toBe(200);
    expect(onDate.json().classification.name).toBe("Guru");

    // Before its first day the code simply does not exist, rather than resolving to the
    // nearest version: a payroll period in 2025 must not borrow a 2026 classification.
    const before = await app.inject({
      method: "GET", url: `/admin/job-classifications/${codes.functional()}?onDate=2025-12-31`,
    });
    expect(before.statusCode).toBe(404);
    expect(before.json().code).toBe("CLASSIFICATION_NOT_EFFECTIVE");
  });

  it("ORG-011-B: an amendment supersedes without leaving a gap or an overlap", async () => {
    await post("/admin/job-classifications", {
      code: codes.functional(), name: "Guru", family: "FUNCTIONAL", effectiveFrom: "2026-01-01",
    });
    const amended = await post(`/admin/job-classifications/${codes.functional()}/amendments`, {
      effectiveFrom: "2026-07-01", name: "Guru Kelas",
    });
    expect(amended.statusCode, amended.body).toBe(200);

    const rows = await client.query<{ name: string; from: string; to: string | null }>(
      `SELECT name, to_char(effective_from,'YYYY-MM-DD') AS "from",
              to_char(effective_to,'YYYY-MM-DD') AS "to"
         FROM job_classifications WHERE code = $1 ORDER BY effective_from`,
      [codes.functional()],
    );
    expect(rows.rows).toEqual([
      { name: "Guru", from: "2026-01-01", to: "2026-06-30" },
      { name: "Guru Kelas", from: "2026-07-01", to: null },
    ]);

    // The old name is still what June resolves to, which is what makes a paid period
    // explainable after the catalog moves on.
    const june = await app.inject({
      method: "GET", url: `/admin/job-classifications/${codes.functional()}?onDate=2026-06-30`,
    });
    expect(june.json().classification.name).toBe("Guru");
  });

  it("ORG-011-C: refuses a second version that would overlap an existing one", async () => {
    await post("/admin/job-classifications", {
      code: codes.functional(), name: "Guru", family: "FUNCTIONAL", effectiveFrom: "2026-01-01",
    });
    const duplicate = await post("/admin/job-classifications", {
      code: codes.functional(), name: "Guru Lain", family: "FUNCTIONAL", effectiveFrom: "2026-05-01",
    });
    expect(duplicate.statusCode, duplicate.body).toBe(409);
    expect(duplicate.json().code).toBe("CLASSIFICATION_CODE_IN_USE");
  });

  it("ORG-011-D: a classification may only name a grade effective on its own first day", async () => {
    await post("/admin/job-grades", {
      code: codes.grade(), name: "Golongan III", rankOrder: 3, effectiveFrom: "2026-06-01",
    });
    const tooEarly = await post("/admin/job-classifications", {
      code: codes.structural(), name: "Kepala Unit", family: "STRUCTURAL",
      gradeCode: codes.grade(), effectiveFrom: "2026-01-01",
    });
    expect(tooEarly.statusCode, tooEarly.body).toBe(400);
    expect(tooEarly.json().code).toBe("GRADE_NOT_EFFECTIVE");

    const inRange = await post("/admin/job-classifications", {
      code: codes.structural(), name: "Kepala Unit", family: "STRUCTURAL",
      gradeCode: codes.grade(), effectiveFrom: "2026-06-01",
    });
    expect(inRange.statusCode, inRange.body).toBe(201);
  });

  it("ORG-011-E: refuses to close a grade that classifications still name", async () => {
    await post("/admin/job-grades", {
      code: codes.grade(), name: "Golongan III", rankOrder: 3, effectiveFrom: "2026-01-01",
    });
    await post("/admin/job-classifications", {
      code: codes.structural(), name: "Kepala Unit", family: "STRUCTURAL",
      gradeCode: codes.grade(), effectiveFrom: "2026-01-01",
    });
    const blocked = await post(`/admin/job-grades/${codes.grade()}/deactivation`, {
      endOn: "2026-06-30", reason: "Golongan tidak dipakai lagi",
    });
    expect(blocked.statusCode, blocked.body).toBe(409);
    expect(blocked.json().code).toBe("GRADE_STILL_REFERENCED");
  });

  it("ORG-011-F: deactivation keeps the history readable", async () => {
    await post("/admin/job-classifications", {
      code: codes.functional(), name: "Guru", family: "FUNCTIONAL", effectiveFrom: "2026-01-01",
    });
    const closed = await post(`/admin/job-classifications/${codes.functional()}/deactivation`, {
      endOn: "2026-06-30", reason: "Jabatan dihapus dari struktur",
    });
    expect(closed.statusCode, closed.body).toBe(200);

    // Gone from today onward, still resolvable for a period that ran while it existed.
    const after = await app.inject({
      method: "GET", url: `/admin/job-classifications/${codes.functional()}?onDate=2026-07-01`,
    });
    expect(after.statusCode).toBe(404);
    const during = await app.inject({
      method: "GET", url: `/admin/job-classifications/${codes.functional()}?onDate=2026-03-01`,
    });
    expect(during.statusCode, during.body).toBe(200);
  });

  it("ORG-011-G: every catalog change writes an audit event", async () => {
    await post("/admin/job-classifications", {
      code: codes.functional(), name: "Guru", family: "FUNCTIONAL", effectiveFrom: "2026-01-01",
    });
    await post(`/admin/job-classifications/${codes.functional()}/amendments`, {
      effectiveFrom: "2026-07-01", name: "Guru Kelas",
    });
    await post(`/admin/job-classifications/${codes.functional()}/deactivation`, {
      endOn: "2026-12-31", reason: "Jabatan dihapus dari struktur",
    });
    const events = await client.query<{ action: string; actor: string | null }>(
      `SELECT action, actor_account_id AS actor FROM job_classification_audit_events
        WHERE entity_code = $1 ORDER BY occurred_at, action`,
      [codes.functional()],
    );
    expect(events.rows.map((row) => row.action)).toEqual([
      "job_classification.created",
      "job_classification.amended",
      "job_classification.deactivated",
    ]);
    expect(events.rows.every((row) => row.actor === principal.id)).toBe(true);
  });

  it("ORG-011-H: job_classifications.read alone cannot change the catalog", async () => {
    permissions = ["job_classifications.read"];
    const create = await post("/admin/job-classifications", {
      code: codes.functional(), name: "Guru", family: "FUNCTIONAL", effectiveFrom: "2026-01-01",
    });
    expect(create.statusCode, create.body).toBe(403);
    expect(create.json().code).toBe("JOB_CLASSIFICATION_FORBIDDEN");

    const list = await app.inject({ method: "GET", url: "/admin/job-classifications" });
    expect(list.statusCode, list.body).toBe(200);
  });

  it("ORG-011-I: no catalog permission means no read either", async () => {
    // A Super Admin principal without the permission still gets nothing: ORG-011 is HC-only
    // and legacy Super Admin compatibility must not reach it.
    permissions = [];
    const list = await app.inject({ method: "GET", url: "/admin/job-classifications" });
    expect(list.statusCode, list.body).toBe(403);
    const grades = await app.inject({ method: "GET", url: "/admin/job-grades" });
    expect(grades.statusCode, grades.body).toBe(403);
  });

  it("ORG-011-J: the list is paginated with a true total (ENG-LIST-001)", async () => {
    for (let index = 0; index < 3; index += 1) {
      const created = await post("/admin/job-classifications", {
        code: `${codes.functional()}_${index}`, name: `Jabatan ${index}`,
        family: "SUPPORT", effectiveFrom: "2026-01-01",
      });
      expect(created.statusCode, created.body).toBe(201);
    }
    const page = await app.inject({
      method: "GET", url: "/admin/job-classifications?page=1&pageSize=2&onDate=2026-02-01&family=SUPPORT",
    });
    expect(page.statusCode, page.body).toBe(200);
    const body = page.json();
    expect(body.classifications).toHaveLength(2);
    expect(body.pagination.total).toBeGreaterThanOrEqual(3);
    expect(body.pagination.pageSize).toBe(2);
  });
});
