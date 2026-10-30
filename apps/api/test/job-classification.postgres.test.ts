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
    // occurred_at defaults to now(), which is the transaction timestamp, so three writes in
    // one test share it. The claim is that each change is recorded, not what order they sort in.
    const events = await client.query<{ action: string; actor: string | null }>(
      `SELECT action, actor_account_id AS actor FROM job_classification_audit_events
        WHERE entity_code = $1`,
      [codes.functional()],
    );
    expect(events.rows.map((row) => row.action).sort()).toEqual([
      "job_classification.amended",
      "job_classification.created",
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
    // The guard refuses an empty permission set even for a SUPER_ADMIN principal. That legacy
    // Super Admin compatibility never puts these keys into the context in the first place is a
    // property of ADMIN_PERMISSIONS, asserted in job-classification.test.ts.
    permissions = [];
    const list = await app.inject({ method: "GET", url: "/admin/job-classifications" });
    expect(list.statusCode, list.body).toBe(403);
    const grades = await app.inject({ method: "GET", url: "/admin/job-grades" });
    expect(grades.statusCode, grades.body).toBe(403);
  });

  it("ORG-011-K: a code is never resurrected after deactivation", async () => {
    await post("/admin/job-classifications", {
      code: codes.functional(), name: "Guru", family: "FUNCTIONAL", effectiveFrom: "2026-01-01",
    });
    await post(`/admin/job-classifications/${codes.functional()}/deactivation`, {
      endOn: "2026-06-30", reason: "Jabatan dihapus dari struktur",
    });
    // Reusing the code with a different meaning would silently re-point versioned payroll
    // policy that still stores the old code verbatim.
    const revived = await post("/admin/job-classifications", {
      code: codes.functional(), name: "Staf Tata Usaha", family: "SUPPORT", effectiveFrom: "2026-07-01",
    });
    expect(revived.statusCode, revived.body).toBe(409);
    expect(revived.json().code).toBe("CLASSIFICATION_CODE_IN_USE");
  });

  it("ORG-011-L: refuses to write behind a version that already starts later", async () => {
    await post("/admin/job-classifications", {
      code: codes.functional(), name: "Guru", family: "FUNCTIONAL", effectiveFrom: "2026-01-01",
    });
    await post(`/admin/job-classifications/${codes.functional()}/amendments`, {
      effectiveFrom: "2026-07-01", name: "Guru Kelas",
    });

    // Amending in May would open a second range that runs past July and overlap it.
    const behind = await post(`/admin/job-classifications/${codes.functional()}/amendments`, {
      effectiveFrom: "2026-05-01", name: "Guru Madya",
    });
    expect(behind.statusCode, behind.body).toBe(409);
    expect(behind.json().code).toBe("CLASSIFICATION_HAS_LATER_VERSION");

    // Closing in May would leave the July version to revive the code after a gap.
    const closed = await post(`/admin/job-classifications/${codes.functional()}/deactivation`, {
      endOn: "2026-05-31", reason: "Jabatan dihapus dari struktur",
    });
    expect(closed.statusCode, closed.body).toBe(409);
    expect(closed.json().code).toBe("CLASSIFICATION_HAS_LATER_VERSION");

    // The catalog is untouched by both refusals.
    const rows = await client.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM job_classifications WHERE code = $1`,
      [codes.functional()],
    );
    expect(rows.rows[0]!.total).toBe(2);
  });

  it("ORG-011-M: an amendment must start after the running version, not on its first day", async () => {
    await post("/admin/job-grades", {
      code: codes.grade(), name: "Golongan III", rankOrder: 3, effectiveFrom: "2026-01-01",
    });
    const sameDay = await post(`/admin/job-grades/${codes.grade()}/amendments`, {
      effectiveFrom: "2026-01-01", name: "Golongan IIIA",
    });
    expect(sameDay.statusCode, sameDay.body).toBe(409);
    expect(sameDay.json().code).toBe("GRADE_SAME_DAY_AMEND");
  });

  it("ORG-011-N: a grade amends and closes once nothing names it", async () => {
    await post("/admin/job-grades", {
      code: codes.grade(), name: "Golongan III", rankOrder: 3, effectiveFrom: "2026-01-01",
    });
    const amended = await post(`/admin/job-grades/${codes.grade()}/amendments`, {
      effectiveFrom: "2026-07-01", name: "Golongan IIIA", rankOrder: 4,
    });
    expect(amended.statusCode, amended.body).toBe(200);
    expect(amended.json().grade.rankOrder).toBe(4);

    const closed = await post(`/admin/job-grades/${codes.grade()}/deactivation`, {
      endOn: "2026-12-31", reason: "Golongan tidak dipakai lagi",
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json().grade.active).toBe(false);

    const events = await client.query<{ action: string }>(
      `SELECT action FROM job_classification_audit_events WHERE entity_code = $1`,
      [codes.grade()],
    );
    expect(events.rows.map((row) => row.action).sort()).toEqual([
      "job_grade.amended", "job_grade.created", "job_grade.deactivated",
    ]);
  });

  it("ORG-011-O: the default list shows one version per code; includeHistory shows all", async () => {
    await post("/admin/job-classifications", {
      code: codes.functional(), name: "Guru", family: "FUNCTIONAL", effectiveFrom: "2026-01-01",
    });
    await post(`/admin/job-classifications/${codes.functional()}/amendments`, {
      effectiveFrom: "2026-07-01", name: "Guru Kelas",
    });

    const onDate = await app.inject({
      method: "GET", url: "/admin/job-classifications?onDate=2026-03-01&family=FUNCTIONAL&pageSize=100",
    });
    const current = (onDate.json().classifications as Array<{ code: string; name: string }>)
      .filter((row) => row.code === codes.functional());
    expect(current).toHaveLength(1);
    expect(current[0]!.name).toBe("Guru");

    // "false" must stay false: a query string carries words, not booleans.
    const explicitFalse = await app.inject({
      method: "GET",
      url: "/admin/job-classifications?onDate=2026-03-01&family=FUNCTIONAL&pageSize=100&includeHistory=false",
    });
    expect((explicitFalse.json().classifications as Array<{ code: string }>)
      .filter((row) => row.code === codes.functional())).toHaveLength(1);
    expect(explicitFalse.json().includeHistory).toBe(false);

    const history = await app.inject({
      method: "GET", url: "/admin/job-classifications?family=FUNCTIONAL&pageSize=100&includeHistory=true",
    });
    expect((history.json().classifications as Array<{ code: string }>)
      .filter((row) => row.code === codes.functional())).toHaveLength(2);
  });

  it("ORG-011-Q: a malformed request is a 400, never a 500", async () => {
    // The AUTH-011 persona matrix posts {} to every route and requires no 500, so a bad body
    // must be answered here rather than falling through to the global error handler.
    for (const url of [
      "/admin/job-grades",
      `/admin/job-grades/${codes.grade()}/amendments`,
      `/admin/job-grades/${codes.grade()}/deactivation`,
      "/admin/job-classifications",
      `/admin/job-classifications/${codes.functional()}/amendments`,
      `/admin/job-classifications/${codes.functional()}/deactivation`,
    ]) {
      const response = await post(url, {});
      expect(response.statusCode, `${url}: ${response.body}`).toBe(400);
    }

    // A lower-case code would not survive the schema check either.
    const badCode = await post("/admin/job-classifications", {
      code: "func guru", name: "Guru", family: "FUNCTIONAL", effectiveFrom: "2026-01-01",
    });
    expect(badCode.statusCode, badCode.body).toBe(400);

    const badDate = await app.inject({
      method: "GET", url: "/admin/job-classifications?onDate=01-01-2026",
    });
    expect(badDate.statusCode, badDate.body).toBe(400);
  });

  it("ORG-011-P: migration 0110 grants the catalog to Human Capital only", async () => {
    const granted = await client.query<{ roleKey: string; permissionKey: string }>(
      `SELECT role.role_key AS "roleKey", grant_row.permission_key AS "permissionKey"
         FROM role_permissions grant_row
         JOIN roles role ON role.id = grant_row.role_id
        WHERE grant_row.permission_key LIKE 'job_classifications.%'
        ORDER BY role.role_key, grant_row.permission_key`,
    );
    expect(granted.rows).toEqual([
      { roleKey: "human_capital_admin", permissionKey: "job_classifications.manage" },
      { roleKey: "human_capital_admin", permissionKey: "job_classifications.read" },
    ]);
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
    const grades = await app.inject({ method: "GET", url: "/admin/job-grades?page=1&pageSize=2" });
    expect(grades.statusCode, grades.body).toBe(200);
    expect(grades.json().pagination.pageSize).toBe(2);
    expect(page.statusCode, page.body).toBe(200);
    const body = page.json();
    expect(body.classifications).toHaveLength(2);
    expect(body.pagination.total).toBeGreaterThanOrEqual(3);
    expect(body.pagination.pageSize).toBe(2);
  });
});
