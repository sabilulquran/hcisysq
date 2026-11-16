// ORG-011 Package 4: export, audited CSV import, change history and the per-employee view.
// Synthetic catalog entries and employees only; every test runs inside one rolled-back transaction.

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

/**
 * The routes own their transactions; map them onto savepoints of the outer one. The import
 * also sets its own per-row savepoints, which pass straight through.
 */
function savepointPool(client: PoolClient): Pool {
  let depth = 0;
  const run = async (text: string, values?: unknown[]) => {
    const statement = String(text).trim().toUpperCase();
    if (statement.startsWith("ROLLBACK TO") || statement.startsWith("RELEASE") || statement.startsWith("SAVEPOINT")) {
      return client.query(text, values);
    }
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

describe.skipIf(!allowed)("ORG-011 Package 4 catalog I/O", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let permissions: string[];
  let principal: AuthPrincipal;
  let suffix: string;

  const code = (stem: string) => `${stem}_${suffix}`;

  function importCsv(kind: "CLASSIFICATION" | "GRADE", csv: string, dryRun: boolean) {
    return app.inject({
      method: "POST", url: "/admin/job-classification-imports",
      payload: { kind, csv, dryRun, fileName: "sintetis.csv" },
    });
  }

  async function countCodes(codes: string[]) {
    const result = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM job_classifications WHERE code = ANY($1::text[])", [codes],
    );
    return Number(result.rows[0]!.count);
  }

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    suffix = randomUUID().slice(0, 8).toUpperCase().replace(/[^A-Z0-9]/g, "X");
    const accountId = randomUUID();
    await client.query(
      `INSERT INTO accounts (
         id, employee_id, email, principal_type, status,
         mfa_secret_ciphertext, mfa_secret_iv, mfa_secret_tag, mfa_enabled_at
       ) VALUES ($1, NULL, $2, 'SUPER_ADMIN', 'active', 'synthetic', 'synthetic', 'synthetic', now())`,
      [accountId, `org011io-${accountId}@example.invalid`],
    );
    principal = { id: accountId, email: "org011io@example.invalid", principalType: "SUPER_ADMIN" };
    permissions = ["job_classifications.read", "job_classifications.manage"];
    const config = { NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8 } as ApiConfig;
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

  it("ORG-011-IO1: a dry run reports every row and writes nothing, not even audit", async () => {
    const csv = [
      "code,name,family,grade_code,effective_from",
      `${code("FUNC")},Guru Sintetis,FUNCTIONAL,,2026-01-01`,
      `${code("STRUCT")},Kepala Sintetis,STRUCTURAL,,2026-01-01`,
    ].join("\r\n");
    const auditBefore = await client.query("SELECT count(*) FROM job_classification_audit_events");
    const response = await importCsv("CLASSIFICATION", csv, true);
    expect(response.statusCode, response.body).toBe(200);
    const report = response.json().report;
    expect(report).toMatchObject({ dryRun: true, applied: false, summary: { rows: 2, create: 2, error: 0 } });
    expect(report.rows.map((row: { line: number }) => row.line)).toEqual([2, 3]);
    expect(await countCodes([code("FUNC"), code("STRUCT")])).toBe(0);
    const auditAfter = await client.query("SELECT count(*) FROM job_classification_audit_events");
    expect(auditAfter.rows[0]).toEqual(auditBefore.rows[0]);
  });

  it("ORG-011-IO2: an applied import writes rows with per-row and batch audit events", async () => {
    await importCsv("GRADE", `code,name,rank_order,effective_from\n${code("G")},Golongan Sintetis,1,2026-01-01\n`, false);
    const csv = [
      "code,name,family,grade_code,effective_from,catatan",
      `${code("FUNC")},"Guru, Sintetis",FUNCTIONAL,${code("G")},2026-01-01,kolom tambahan diabaikan`,
    ].join("\n");
    const response = await importCsv("CLASSIFICATION", csv, false);
    expect(response.statusCode, response.body).toBe(200);
    const report = response.json().report;
    expect(report).toMatchObject({ applied: true, summary: { create: 1, error: 0 } });

    const row = await client.query("SELECT name, grade_code FROM job_classifications WHERE code = $1", [code("FUNC")]);
    expect(row.rows).toEqual([{ name: "Guru, Sintetis", grade_code: code("G") }]);

    const events = await client.query<{ action: string; payload: Record<string, unknown> }>(
      `SELECT action, payload FROM job_classification_audit_events
        WHERE payload->>'importId' = $1 ORDER BY occurred_at, action`,
      [report.importId],
    );
    const actions = events.rows.map((event) => event.action).sort();
    expect(actions).toEqual(["job_classification.created", "job_classification.imported"]);
    const batch = events.rows.find((event) => event.action === "job_classification.imported")!;
    expect(batch.payload).toMatchObject({ fileName: "sintetis.csv", create: 1, rows: 1 });
    expect(String(batch.payload.sha256)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ORG-011-IO3: one bad row rejects the whole file with 422 and leaves the catalog untouched", async () => {
    const csv = [
      "code,name,family,grade_code,effective_from",
      `${code("FUNC")},Guru Sintetis,FUNCTIONAL,,2026-01-01`,
      `${code("BAD")},Salah Rumpun,MANAGERIAL,,2026-01-01`,
      `func_lower_${suffix},Kode huruf kecil,FUNCTIONAL,,2026-01-01`,
      `${code("FUNC")},Duplikat,FUNCTIONAL,,2026-01-01`,
      `${code("DATE")},Tanggal salah,FUNCTIONAL,,2026-02-30`,
      `${code("ZERO")},Tahun nol,FUNCTIONAL,,0000-01-01`,
      `${code("GRADE")},Golongan tidak ada,FUNCTIONAL,NOPE_${suffix},2026-01-01`,
    ].join("\n");
    const response = await importCsv("CLASSIFICATION", csv, false);
    expect(response.statusCode, response.body).toBe(422);
    const report = response.json().report;
    expect(report.applied).toBe(false);
    expect(report.rows.map((row: { errorCode?: string }) => row.errorCode ?? row)).toEqual([
      expect.objectContaining({ outcome: "CREATE" }),
      "IMPORT_INVALID_FAMILY",
      "IMPORT_INVALID_CODE",
      "IMPORT_DUPLICATE_CODE",
      "IMPORT_INVALID_DATE",
      "IMPORT_INVALID_DATE",
      "GRADE_NOT_EFFECTIVE",
    ]);
    expect(await countCodes([code("FUNC")])).toBe(0);
  });

  it("ORG-011-IO4: re-importing identical rows is UNCHANGED, a changed name amends from its date", async () => {
    const first = `code,name,family,grade_code,effective_from\n${code("FUNC")},Guru,FUNCTIONAL,,2026-01-01\n`;
    expect((await importCsv("CLASSIFICATION", first, false)).json().report.summary.create).toBe(1);
    const again = await importCsv("CLASSIFICATION", first, false);
    expect(again.json().report).toMatchObject({ applied: true, summary: { unchanged: 1, create: 0, amend: 0 } });

    const amended = await importCsv(
      "CLASSIFICATION", `code,name,family,grade_code,effective_from\n${code("FUNC")},Guru Kelas,FUNCTIONAL,,2026-07-01\n`, false,
    );
    expect(amended.json().report.summary.amend).toBe(1);
    const versions = await client.query(
      `SELECT name, to_char(effective_to,'YYYY-MM-DD') AS "to" FROM job_classifications
        WHERE code = $1 ORDER BY effective_from`, [code("FUNC")],
    );
    expect(versions.rows).toEqual([{ name: "Guru", to: "2026-06-30" }, { name: "Guru Kelas", to: null }]);

    // Codes are permanent: a retired code cannot come back through a file either.
    await app.inject({
      method: "POST", url: `/admin/job-classifications/${code("FUNC")}/deactivation`,
      payload: { endOn: "2026-12-31", reason: "Penutupan sintetis" },
    });
    const revived = await importCsv(
      "CLASSIFICATION", `code,name,family,grade_code,effective_from\n${code("FUNC")},Guru,FUNCTIONAL,,2027-02-01\n`, false,
    );
    expect(revived.statusCode).toBe(422);
    expect(revived.json().report.rows[0].errorCode).toBe("CLASSIFICATION_CODE_IN_USE");

    // Nor by amending inside the closed version's own range, which would reopen it forever.
    const reopened = await importCsv(
      "CLASSIFICATION", `code,name,family,grade_code,effective_from\n${code("FUNC")},Guru Baru,FUNCTIONAL,,2026-09-01\n`, false,
    );
    expect(reopened.statusCode).toBe(422);
    expect(reopened.json().report.rows[0].errorCode).toBe("CLASSIFICATION_DEACTIVATED");
    const open = await client.query("SELECT 1 FROM job_classifications WHERE code = $1 AND effective_to IS NULL", [code("FUNC")]);
    expect(open.rowCount).toBe(0);
  });

  it("ORG-011-IO5: refuses a file without the required columns or with too many rows", async () => {
    const missing = await importCsv("CLASSIFICATION", "code,name\nA,B\n", true);
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe("IMPORT_MISSING_COLUMNS");

    const rows = ["code,name,rank_order,effective_from"];
    for (let index = 0; index < 1001; index += 1) rows.push(`G${index}_${suffix},Golongan,1,2026-01-01`);
    const tooMany = await importCsv("GRADE", rows.join("\n"), true);
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().code).toBe("IMPORT_TOO_MANY_ROWS");

    const longName = await app.inject({
      method: "POST", url: "/admin/job-classification-imports",
      payload: { kind: "GRADE", csv: `code,name,rank_order,effective_from\nG_${suffix},Golongan,1,2026-01-01\n`, dryRun: true, fileName: "x".repeat(300) },
    });
    expect(longName.statusCode, longName.body).toBe(200);

    const unclosed = await importCsv("GRADE", 'code,name,rank_order,effective_from\n"G,x,1,2026-01-01\n', true);
    expect(unclosed.json().code).toBe("IMPORT_CSV_MALFORMED");
  });

  it("ORG-011-IO6: export round-trips through import and guards spreadsheet formulas", async () => {
    await importCsv("CLASSIFICATION", [
      "code,name,family,grade_code,effective_from",
      `${code("FUNC")},=Guru Sintetis,FUNCTIONAL,,2026-01-01`,
    ].join("\n"), false);
    const exported = await app.inject({ method: "GET", url: "/admin/job-classifications/export?onDate=2026-06-01" });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-type"]).toContain("text/csv");
    expect(exported.headers["content-disposition"]).toContain("klasifikasi-jabatan-2026-06-01.csv");
    expect(exported.body).toContain(`"${code("FUNC")}","'=Guru Sintetis","FUNCTIONAL"`);

    const reimported = await importCsv("CLASSIFICATION", exported.body, true);
    const mine = reimported.json().report.rows.find((row: { code: string }) => row.code === code("FUNC"));
    // The guard apostrophe is removed on import, so the name compares equal and nothing changes.
    expect(mine.outcome).toBe("UNCHANGED");

    const grades = await app.inject({ method: "GET", url: "/admin/job-grades/export?includeHistory=true" });
    expect(grades.statusCode).toBe(200);
    expect(grades.body.split("\r\n")[0]).toBe('﻿"code","name","rank_order","effective_from","effective_to","active"');
  });

  it("ORG-011-IO7: change history lists catalog events filtered by code, with the actor", async () => {
    await app.inject({
      method: "POST", url: "/admin/job-classifications",
      payload: { code: code("FUNC"), name: "Guru", family: "FUNCTIONAL", effectiveFrom: "2026-01-01" },
    });
    await app.inject({
      method: "POST", url: `/admin/job-classifications/${code("FUNC")}/amendments`,
      payload: { effectiveFrom: "2026-07-01", name: "Guru Kelas" },
    });
    const response = await app.inject({
      method: "GET", url: `/admin/job-classification-audit-events?entityCode=${code("FUNC")}`,
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.pagination.total).toBe(2);
    // Both writes share one test transaction and so one now(); the order between them is not
    // asserted here, only that each event is listed once under the code.
    expect(body.events.map((event: { action: string }) => event.action).sort())
      .toEqual(["job_classification.amended", "job_classification.created"]);
    expect(body.events[0].actorName).toBe(`org011io-${principal.id}@example.invalid`);
    expect((await app.inject({ method: "GET", url: "/admin/job-classification-audit-events?pageSize=101" })).statusCode).toBe(400);
  });

  it("ORG-011-IO8: the employee view shows slots, SUPPORT bindings and resolver blockers as data", async () => {
    const employeeId = randomUUID();
    await client.query(
      `INSERT INTO employees (id, employee_number, full_name, status) VALUES ($1,$2,'Pegawai Sintetis','active')`,
      [employeeId, `ORG011IO-${employeeId.slice(0, 8)}`],
    );
    const employmentId = randomUUID();
    const openingAction = randomUUID();
    await client.query(
      `INSERT INTO employments(id, employee_id, staff_type, started_on, start_basis, service_start_on, source, opened_by_action_id)
       VALUES ($1,$2,'PENDIDIK','2026-01-01'::date,'RECORDED','2026-01-01'::date,'BASELINE_FROM_MASTER',$3)`,
      [employmentId, employeeId, openingAction],
    );
    await client.query(
      `INSERT INTO employment_actions(id, employee_id, employment_id, action_type, recorded_at) VALUES ($1,$2,$3,'BASELINE', now())`,
      [openingAction, employeeId, employmentId],
    );
    for (const [value, family] of [[code("FUNC"), "FUNCTIONAL"], [code("SUP"), "SUPPORT"], [code("FUNC2"), "FUNCTIONAL"]] as const) {
      await client.query(
        `INSERT INTO job_classifications (id, code, name, family, effective_from) VALUES ($1,$2,$3,$4,'2026-01-01')`,
        [randomUUID(), value, `Nama ${value}`, family],
      );
    }
    const place = async (kind: "PRIMARY" | "ADDITIONAL", classification: string) => {
      await client.query(
        `INSERT INTO employment_placements (id, employment_id, kind, org_node_key, job_title_label, effective_from,
           effective_from_basis, opened_by_action_id, job_classification_code)
         VALUES ($1,$2,$3,$4,'Jabatan sintetis','2026-01-01','RECORDED',$5,$6)`,
        [randomUUID(), employmentId, kind, randomUUID(), openingAction, classification],
      );
    };
    await place("PRIMARY", code("FUNC"));
    await place("ADDITIONAL", code("SUP"));

    const url = `/admin/employees/${employeeId}/job-classifications?onDate=2026-06-01`;
    const ok = await app.inject({ method: "GET", url });
    expect(ok.statusCode, ok.body).toBe(200);
    const [employment] = ok.json().employments;
    expect(employment.error).toBeNull();
    expect(employment.slots).toEqual({
      functional: { code: code("FUNC"), name: `Nama ${code("FUNC")}`, gradeCode: null, source: "PLACEMENT" },
      structural: null,
    });
    expect(employment.bindings.map((binding: { code: string; family: string }) => [binding.code, binding.family]).sort())
      .toEqual([[code("FUNC"), "FUNCTIONAL"], [code("SUP"), "SUPPORT"]].sort());

    // Two functional codes at once: the payroll blocker is reported, not thrown as a 500.
    await place("ADDITIONAL", code("FUNC2"));
    const ambiguous = (await app.inject({ method: "GET", url })).json().employments[0];
    expect(ambiguous.slots).toBeNull();
    expect(ambiguous.error.code).toBe("CLASSIFICATION_AMBIGUOUS");

    expect((await app.inject({ method: "GET", url: `/admin/employees/${randomUUID()}/job-classifications` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/admin/employees/bukan-uuid/job-classifications" })).statusCode).toBe(400);
  });

  it("ORG-011-IO9: read cannot import, and neither permission is implied by the other routes", async () => {
    permissions = ["job_classifications.read"];
    const refused = await importCsv("GRADE", "code,name,rank_order,effective_from\nG,x,1,2026-01-01\n", true);
    expect(refused.statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/admin/job-grades/export" })).statusCode).toBe(200);

    permissions = [];
    for (const url of [
      "/admin/job-classifications/export", "/admin/job-grades/export",
      "/admin/job-classification-audit-events", `/admin/employees/${randomUUID()}/job-classifications`,
    ]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(403);
    }
  });
});
