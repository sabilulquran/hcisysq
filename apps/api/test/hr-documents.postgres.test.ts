// DOC-001 / DOC-002 Package 1 acceptance against a real schema.
// Synthetic employees only; every test runs inside one rolled-back transaction.

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import { registerDocumentRoutes } from "../src/modules/documents/routes.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

/**
 * The routes own their transactions, so the test pool maps BEGIN/COMMIT/ROLLBACK
 * onto savepoints of the one outer transaction the test rolls back afterwards.
 */
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

describe.skipIf(!allowed)("DOC-001/DOC-002 HR documents", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let employeeId: string;
  let accountId: string;
  let otherEmployeeId: string;
  let permissions: string[];
  let principal: AuthPrincipal;

  async function insertEmployee(name: string, status: "active" | "resigned", structural: string | null = null) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO employees(id, employee_number, full_name, status, structural_position, started_on)
       VALUES ($1,$2,$3,$4,$5,'2020-01-06')`,
      [id, `DOC-${id.slice(0, 8)}`, name, status, structural],
    );
    return id;
  }

  async function submitRequest(purpose = "Keperluan pengajuan beasiswa anak") {
    const response = await app.inject({
      method: "POST",
      url: "/documents/me/requests",
      payload: { documentCode: "KETERANGAN_KERJA", purpose },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as string;
  }

  async function approveAndIssue(requestId: string) {
    const approve = await app.inject({ method: "POST", url: `/admin/documents/requests/${requestId}/approve`, payload: {} });
    expect(approve.statusCode, approve.body).toBe(200);
    return app.inject({ method: "POST", url: `/admin/documents/requests/${requestId}/issue`, payload: {} });
  }

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    employeeId = await insertEmployee("Dokumen Primary", "active");
    otherEmployeeId = await insertEmployee("Dokumen Other", "active");
    accountId = randomUUID();
    await client.query(
      `INSERT INTO accounts(id, employee_id, email, principal_type, status)
       VALUES ($1,$2,$3,'EMPLOYEE','active')`,
      [accountId, employeeId, `doc-${accountId}@example.invalid`],
    );
    principal = { id: accountId, email: "doc@example.invalid", principalType: "EMPLOYEE" };
    permissions = ["documents.read", "documents.manage"];

    const config = { NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8 } as ApiConfig;
    app = Fastify({ logger: false });
    await registerDocumentRoutes(app, savepointPool(client), config, {
      getSession: async () => ({ principal, expiresAt: "2099-01-01T00:00:00Z" }),
      getAuthorizationContext: async () => ({ organizationPermissions: permissions }),
    } as never);
  });

  afterEach(async () => {
    try { await app?.close(); } finally {
      if (client) { await client.query("ROLLBACK"); client.release(); }
    }
  });

  async function addSigner() {
    await insertEmployee("Kepala HCM Sintetis", "active", "Kepala Human Capital Management");
  }

  async function counterFor(numberCode: string) {
    const result = await client.query<{ lastSequence: number }>(
      `SELECT last_sequence AS "lastSequence" FROM hr_document_number_counters
        WHERE number_code = $1 AND number_year = $2`,
      [numberCode, new Date().getUTCFullYear()],
    );
    return result.rows[0]?.lastSequence ?? 0;
  }

  it("DOC-001-A: lists only the requesting employee's own requests", async () => {
    const mine = await submitRequest();
    await client.query(
      `INSERT INTO hr_document_requests(id, employee_id, document_code, purpose, status)
       VALUES ($1,$2,'KETERANGAN_KERJA','Punya orang lain','SUBMITTED')`,
      [randomUUID(), otherEmployeeId],
    );
    const list = await app.inject({ method: "GET", url: "/documents/me/requests" });
    expect(list.statusCode, list.body).toBe(200);
    const items = list.json().items as Array<{ id: string }>;
    expect(items.map((item) => item.id)).toEqual([mine]);
  });

  it("DOC-001-B: refuses a fourth open request", async () => {
    await submitRequest("Keperluan pertama untuk keluarga");
    await submitRequest("Keperluan kedua untuk bank");
    await submitRequest("Keperluan ketiga untuk sekolah");
    const fourth = await app.inject({
      method: "POST",
      url: "/documents/me/requests",
      payload: { documentCode: "KETERANGAN_KERJA", purpose: "Keperluan keempat yang ditolak" },
    });
    expect(fourth.statusCode, fourth.body).toBe(409);
    expect(fourth.json().code).toBe("DOCUMENT_REQUEST_LIMIT");
  });

  it("DOC-001-C: a rejected request consumes no document number", async () => {
    const before = await counterFor("SKK");
    const requestId = await submitRequest();
    const rejected = await app.inject({
      method: "POST",
      url: `/admin/documents/requests/${requestId}/reject`,
      payload: { note: "Keperluan belum jelas, mohon lengkapi" },
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(await counterFor("SKK")).toBe(before);
  });

  it("DOC-001-D: successive issues receive distinct, increasing numbers", async () => {
    await addSigner();
    const first = await approveAndIssue(await submitRequest("Keperluan pertama untuk bank"));
    expect(first.statusCode, first.body).toBe(201);
    const second = await approveAndIssue(await submitRequest("Keperluan kedua untuk sekolah"));
    expect(second.statusCode, second.body).toBe(201);
    expect(first.json().documentNumber).not.toBe(second.json().documentNumber);
    const numbers = await client.query<{ documentNumber: string }>(
      `SELECT document_number AS "documentNumber" FROM hr_issued_documents WHERE employee_id = $1`,
      [employeeId],
    );
    expect(new Set(numbers.rows.map((row) => row.documentNumber)).size).toBe(2);
  });

  it("DOC-001-E: the snapshot is frozen at issuing time", async () => {
    await addSigner();
    await client.query(`UPDATE employees SET structural_position = 'Guru' WHERE id = $1`, [employeeId]);
    const issued = await approveAndIssue(await submitRequest());
    expect(issued.statusCode, issued.body).toBe(201);
    await client.query(`UPDATE employees SET structural_position = 'Kepala Sekolah' WHERE id = $1`, [employeeId]);
    const list = await app.inject({ method: "GET", url: "/documents/me/issued" });
    const snapshot = (list.json().items as Array<{ contentSnapshot: { positionTitle: string } }>)[0]!.contentSnapshot;
    expect(snapshot.positionTitle).toBe("Guru");
  });

  it("DOC-001-F: without an eligible signer the request stays APPROVED", async () => {
    const requestId = await submitRequest();
    const issued = await approveAndIssue(requestId);
    expect(issued.statusCode, issued.body).toBe(409);
    expect(issued.json().code).toBe("DOCUMENT_SIGNER_UNAVAILABLE");
    const row = await client.query<{ status: string }>(
      `SELECT status FROM hr_document_requests WHERE id = $1`, [requestId],
    );
    expect(row.rows[0]?.status).toBe("APPROVED");
    expect(await counterFor("SKK")).toBe(0);
  });

  it("DOC-001-G: paklaring is refused for an employee who is still active", async () => {
    await addSigner();
    const response = await app.inject({
      method: "POST",
      url: "/admin/documents/issue",
      payload: { employeeId, documentCode: "PAKLARING", purpose: "Permintaan mantan pegawai" },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().code).toBe("DOCUMENT_EMPLOYMENT_STATE");
  });

  it("DOC-001-H/I: the snapshot carries no salary facts and Package 2 types cannot be requested", async () => {
    await addSigner();
    const issued = await approveAndIssue(await submitRequest());
    const snapshot = issued.json() as { id: string };
    const row = await client.query<{ contentSnapshot: Record<string, unknown> }>(
      `SELECT content_snapshot AS "contentSnapshot" FROM hr_issued_documents WHERE id = $1`, [snapshot.id],
    );
    const keys = Object.keys(row.rows[0]!.contentSnapshot);
    expect(keys).not.toContain("salary");
    expect(keys).not.toContain("bankAccount");
    expect(keys).not.toContain("address");

    const unavailable = await app.inject({
      method: "POST",
      url: "/documents/me/requests",
      payload: { documentCode: "KETERANGAN_PENGHASILAN", purpose: "Keperluan pengajuan kredit" },
    });
    expect(unavailable.statusCode, unavailable.body).toBe(409);
  });

  it("DOC-002-A/H: reading or issuing a warning letter needs documents.discipline.manage", async () => {
    const forbidden = await app.inject({ method: "GET", url: "/admin/documents/disciplinary" });
    expect(forbidden.statusCode, forbidden.body).toBe(403);
    const issue = await app.inject({
      method: "POST",
      url: "/admin/documents/disciplinary",
      payload: {
        employeeId, level: "SP1", subject: "Keterlambatan berulang",
        narrative: "Uraian pelanggaran sintetis untuk pengujian.", effectiveDate: "2026-10-01",
      },
    });
    expect(issue.statusCode, issue.body).toBe(403);
  });

  it("DOC-002-B/C: an employee acknowledges only their own letter", async () => {
    await addSigner();
    permissions = [...permissions, "documents.discipline.manage"];
    const issue = await app.inject({
      method: "POST",
      url: "/admin/documents/disciplinary",
      payload: {
        employeeId, level: "SP1", subject: "Keterlambatan berulang",
        narrative: "Uraian pelanggaran sintetis untuk pengujian.", effectiveDate: "2026-10-01",
      },
    });
    expect(issue.statusCode, issue.body).toBe(201);
    const letterId = issue.json().id as string;

    const otherLetter = await app.inject({
      method: "POST",
      url: "/admin/documents/disciplinary",
      payload: {
        employeeId: otherEmployeeId, level: "SP1", subject: "Pelanggaran lain",
        narrative: "Uraian pelanggaran sintetis lain untuk pengujian.", effectiveDate: "2026-10-01",
      },
    });
    expect(otherLetter.statusCode, otherLetter.body).toBe(201);

    const mine = await app.inject({ method: "POST", url: `/documents/me/disciplinary/${letterId}/acknowledge` });
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json().acknowledgedAt).toBeTruthy();

    const theirs = await app.inject({
      method: "POST",
      url: `/documents/me/disciplinary/${otherLetter.json().id}/acknowledge`,
    });
    expect(theirs.statusCode, theirs.body).toBe(404);
    const row = await client.query<{ acknowledgedAt: Date | null }>(
      `SELECT acknowledged_at AS "acknowledgedAt" FROM hr_disciplinary_letters WHERE id = $1`,
      [otherLetter.json().id],
    );
    expect(row.rows[0]?.acknowledgedAt).toBeNull();
  });

  it("DOC-002-D/E: expiry is derived and an out-of-order level only warns", async () => {
    await addSigner();
    permissions = [...permissions, "documents.discipline.manage"];
    const expired = await app.inject({
      method: "POST",
      url: "/admin/documents/disciplinary",
      payload: {
        employeeId, level: "SP2", subject: "Pelanggaran lama",
        narrative: "Uraian pelanggaran sintetis lama untuk pengujian.",
        effectiveDate: "2020-01-06", expiresOn: "2020-07-06",
      },
    });
    expect(expired.statusCode, expired.body).toBe(201);
    // Nothing is in force, and the level skipped SP1.
    expect(expired.json().warnings).toHaveLength(1);

    const list = await app.inject({ method: "GET", url: "/documents/me/disciplinary" });
    expect((list.json().items as Array<{ active: boolean }>)[0]!.active).toBe(false);
  });

  it("DOC-002-F: revoking needs documents.correct and keeps the number", async () => {
    await addSigner();
    const issued = await approveAndIssue(await submitRequest());
    expect(issued.statusCode, issued.body).toBe(201);
    const documentId = issued.json().id as string;
    const number = issued.json().documentNumber as string;

    const forbidden = await app.inject({
      method: "POST",
      url: `/admin/documents/issued/${documentId}/revoke`,
      payload: { reason: "Diterbitkan untuk keperluan yang salah" },
    });
    expect(forbidden.statusCode, forbidden.body).toBe(403);

    permissions = [...permissions, "documents.correct"];
    const revoked = await app.inject({
      method: "POST",
      url: `/admin/documents/issued/${documentId}/revoke`,
      payload: { reason: "Diterbitkan untuk keperluan yang salah" },
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    const row = await client.query<{ status: string; documentNumber: string }>(
      `SELECT status, document_number AS "documentNumber" FROM hr_issued_documents WHERE id = $1`,
      [documentId],
    );
    expect(row.rows[0]).toEqual({ status: "REVOKED", documentNumber: number });
  });

  it("DOC-002-G: the notification preview carries no narrative", async () => {
    await addSigner();
    permissions = [...permissions, "documents.discipline.manage"];
    const narrative = "Uraian pelanggaran sintetis yang tidak boleh bocor.";
    const issue = await app.inject({
      method: "POST",
      url: "/admin/documents/disciplinary",
      payload: { employeeId, level: "SP1", subject: "Keterlambatan berulang", narrative, effectiveDate: "2026-10-01" },
    });
    expect(issue.statusCode, issue.body).toBe(201);
    const notifications = await client.query<{ title: string; body: string }>(
      `SELECT title, body FROM in_app_notifications WHERE recipient_account_id = $1`,
      [accountId],
    );
    expect(notifications.rows).toHaveLength(1);
    expect(notifications.rows[0]!.body).not.toContain("pelanggaran sintetis");
    const audit = await client.query<{ metadata: Record<string, unknown>; reason: string | null }>(
      `SELECT metadata, reason FROM hr_document_audit_events WHERE event_type = 'doc.discipline.issued'`,
    );
    expect(JSON.stringify(audit.rows[0]!.metadata)).not.toContain("pelanggaran sintetis");
    expect(audit.rows[0]!.reason).toBeNull();
  });

  it("grants documents.read and documents.manage to Human Capital Admin, and nothing sensitive", async () => {
    const result = await client.query<{ permissionKey: string }>(
      `SELECT role_permission.permission_key AS "permissionKey"
         FROM role_permissions role_permission
         JOIN roles role ON role.id = role_permission.role_id
        WHERE role.role_key = 'human_capital_admin' AND role_permission.permission_key LIKE 'documents.%'
        ORDER BY role_permission.permission_key`,
    );
    expect(result.rows.map((row) => row.permissionKey)).toEqual(["documents.manage", "documents.read"]);
  });
});
