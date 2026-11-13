// EMP-011 Package 1 acceptance against a real schema.
// Synthetic employees and files only; every test runs inside one rolled-back transaction.

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import { registerEmployeeDocumentRoutes } from "../src/modules/employee-documents/routes.js";
import { registerDecisionDocumentRoutes } from "../src/modules/employment/decision-document-routes.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

/** The routes own their transactions; BEGIN/COMMIT/ROLLBACK become savepoints of the test's. */
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

const PDF = Buffer.from("%PDF-1.7\nsynthetic scan\n%%EOF");
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const file = (bytes: Buffer, contentType = "application/pdf") => ({ contentType, contentBase64: bytes.toString("base64") });
const READ = ["employee_documents.read"];
const HC = ["employee_documents.read", "employee_documents.manage"];
const SECRET_NUMBER = "3201012345678901";

describe.skipIf(!allowed)("EMP-011 employee documents", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let principal: AuthPrincipal | null;
  let permissions: string[];
  let clock: Date;
  const people = {} as Record<"hc" | "aisyah" | "bilal" | "manager", { employeeId: string; accountId: string }>;
  const tag = `Dok${randomUUID().slice(0, 6)}`;

  async function insertEmployee(name: string) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO employees(id, employee_number, full_name, status, started_on) VALUES ($1,$2,$3,'active','2020-01-06')`,
      [id, `DK-${id.slice(0, 8)}`, name],
    );
    return id;
  }

  async function insertAccount(employeeId: string) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1,$2,$3,'EMPLOYEE','active')`,
      [id, employeeId, `doc-${id}@example.invalid`],
    );
    return id;
  }

  function actAs(who: keyof typeof people | null, granted: string[] = []) {
    principal = who ? { id: people[who].accountId, email: `${who}@example.invalid`, principalType: "EMPLOYEE" } : null;
    permissions = granted;
  }

  const call = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as never });

  async function hcUpload(who: keyof typeof people, body: Record<string, unknown>) {
    actAs("hc", HC);
    return call("POST", `/admin/employee-documents/employees/${people[who].employeeId}`, body);
  }

  async function events(type?: string) {
    return (await client.query<{ type: string; actor: string | null; employee: string | null; document: string | null; metadata: Record<string, unknown> }>(
      `SELECT event_type AS type, actor_account_id AS actor, employee_id AS employee, document_id AS document, metadata
         FROM employee_document_audit_events
        WHERE ($1::text IS NULL OR event_type = $1)
          AND (employee_id = ANY($2::uuid[]) OR actor_account_id = ANY($3::uuid[]))
        ORDER BY occurred_at`,
      [type ?? null, Object.values(people).map((p) => p.employeeId), Object.values(people).map((p) => p.accountId)],
    )).rows;
  }

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    for (const key of ["hc", "aisyah", "bilal", "manager"] as const) {
      const employeeId = await insertEmployee(`${tag} ${key}`);
      people[key] = { employeeId, accountId: await insertAccount(employeeId) };
    }
    clock = new Date("2026-11-11T03:00:00Z");
    const config = { NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8 } as ApiConfig;
    const auth = {
      getSession: async () => (principal ? { principal, expiresAt: "2099-01-01T00:00:00Z" } : null),
      getAuthorizationContext: async () => ({ organizationPermissions: permissions }),
    };
    app = Fastify({ logger: false });
    const db = savepointPool(client);
    await registerEmployeeDocumentRoutes(app, db, config, auth as never, () => clock);
    await registerDecisionDocumentRoutes(app, db, config, auth as never);
  });

  afterEach(async () => {
    await app?.close();
    await client.query("ROLLBACK");
    client.release();
  });

  it("EMP-011-B/D: HC uploads, the owner reads and downloads, every read and write is audited without personal data", async () => {
    const upload = await hcUpload("aisyah", {
      documentType: "KTP", documentNumber: SECRET_NUMBER, issuer: "Disdukcapil", issuedOn: "2020-02-01", file: file(PDF),
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const document = upload.json();
    expect(document).toMatchObject({ status: "VERIFIED", source: "HC", numberMasked: "••••8901", documentType: "KTP" });
    expect(upload.body).not.toContain(SECRET_NUMBER);
    // D-05: stored encrypted, never in clear.
    const stored = await client.query(`SELECT * FROM employee_documents WHERE id = $1`, [document.id]);
    expect(JSON.stringify(stored.rows[0])).not.toContain(SECRET_NUMBER);
    const storedFile = await client.query(`SELECT ciphertext FROM employee_document_files WHERE employee_document_id = $1`, [document.id]);
    expect(storedFile.rows[0].ciphertext).not.toContain(PDF.toString("base64"));

    actAs("aisyah");
    const mine = await call("GET", "/me/employee-documents");
    expect(mine.statusCode).toBe(200);
    expect(mine.json().items.map((item: { id: string }) => item.id)).toEqual([document.id]);
    expect(mine.json().items[0].notes).toBeUndefined();
    const download = await call("GET", `/me/employee-documents/${document.id}/file`);
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.equals(PDF)).toBe(true);
    expect(download.headers["content-disposition"]).toMatch(/^attachment; filename="KTP-\d{4}-\d{2}-\d{2}\.pdf"$/);
    expect(download.headers["content-security-policy"]).toContain("sandbox");
    expect(download.headers["cache-control"]).toBe("private, no-store");

    actAs("hc", READ);
    expect((await call("GET", `/admin/employee-documents/employees/${people.aisyah.employeeId}`)).statusCode).toBe(200);
    expect((await call("GET", `/admin/employee-documents/${document.id}/file`)).statusCode).toBe(200);

    const trail = await events();
    expect(trail.map((event) => event.type)).toEqual([
      "employee_document.uploaded", "employee_document.file_read", "employee_document.list_read", "employee_document.file_read",
    ]);
    expect(trail[1]).toMatchObject({ actor: people.aisyah.accountId, metadata: { via: "SELF", documentType: "KTP" } });
    expect(trail[3]).toMatchObject({ actor: people.hc.accountId, metadata: { via: "HC" } });
    // D-11: no number, no file name, no names in any audit row.
    const serialized = JSON.stringify(trail);
    expect(serialized).not.toContain(SECRET_NUMBER);
    expect(serialized).not.toContain("8901");
    expect(serialized).not.toContain(tag);
    expect(serialized).not.toContain("Disdukcapil");
  });

  it("EMP-011-B: another employee's document answers 404 everywhere, like a missing one", async () => {
    const document = (await hcUpload("aisyah", { documentType: "IJAZAH", file: file(PDF) })).json();
    actAs("bilal");
    expect((await call("GET", "/me/employee-documents")).json().items).toEqual([]);
    expect((await call("GET", `/me/employee-documents/${document.id}/file`)).statusCode).toBe(404);
    expect((await call("POST", `/me/employee-documents/${document.id}/withdraw`)).statusCode).toBe(404);
    expect((await call("GET", `/me/employee-documents/${randomUUID()}/file`)).statusCode).toBe(404);
    // A manager without the permission (unit roles never carry it) gets 403 on the admin routes.
    actAs("manager", ["employees.read.unit", "employees.read.all", "employment.read"]);
    expect((await call("GET", `/admin/employee-documents/employees/${people.aisyah.employeeId}`)).statusCode).toBe(403);
    expect((await call("GET", `/admin/employee-documents/${document.id}/file`)).statusCode).toBe(403);
    // Refused reads leave no file_read event.
    expect((await events("employee_document.file_read")).length).toBe(0);
  });

  it("EMP-011-E: an employee proposal waits, HC rejects it with a reason, and the content is erased", async () => {
    actAs("aisyah");
    const proposal = await call("POST", "/me/employee-documents", { documentType: "KK", file: file(PNG, "image/png") });
    expect(proposal.statusCode, proposal.body).toBe(201);
    const id = proposal.json().id;
    expect(proposal.json()).toMatchObject({ status: "PENDING_REVIEW", source: "EMPLOYEE" });

    actAs("hc", READ);
    const pending = await call("GET", "/admin/employee-documents/pending");
    expect(pending.json().items.map((item: { id: string }) => item.id)).toContain(id);

    actAs("hc", HC);
    const rejected = await call("POST", `/admin/employee-documents/${id}/reject`, { reason: "Pindaian buram, mohon unggah ulang" });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({ status: "REJECTED", file: { purged: true } });
    const row = await client.query(`SELECT ciphertext, iv, auth_tag, sha256, purged_at FROM employee_document_files WHERE employee_document_id = $1`, [id]);
    expect(row.rows[0]).toMatchObject({ ciphertext: null, iv: null, auth_tag: null, sha256: "0".repeat(64) });
    expect(row.rows[0].purged_at).not.toBeNull();
    expect((await call("GET", `/admin/employee-documents/${id}/file`)).statusCode).toBe(410);
    expect((await call("POST", `/admin/employee-documents/${id}/verify`)).json().code).toBe("EMPLOYEE_DOCUMENT_INVALID_TRANSITION");

    actAs("aisyah");
    const mine = (await call("GET", "/me/employee-documents")).json().items;
    expect(mine[0]).toMatchObject({ id, status: "REJECTED", decisionReason: "Pindaian buram, mohon unggah ulang" });
    expect((await call("GET", `/me/employee-documents/${id}/file`)).statusCode).toBe(404);
    const audit = await events("employee_document.rejected");
    expect(audit[0]!.metadata).toEqual({ documentType: "KK", reasonLength: 34 });
  });

  it("D-14: a verified proposal replaces the document it names; withdraw erases a pending one", async () => {
    const old = (await hcUpload("aisyah", { documentType: "SIM", expiresOn: "2026-12-01", file: file(PDF) })).json();
    actAs("aisyah");
    const renewal = (await call("POST", "/me/employee-documents", {
      documentType: "SIM", expiresOn: "2031-12-01", replacesDocumentId: old.id, file: file(PDF),
    })).json();
    const other = (await call("POST", "/me/employee-documents", { documentType: "NPWP", file: file(PDF) })).json();
    expect((await call("POST", `/me/employee-documents/${other.id}/withdraw`)).json()).toEqual({ id: other.id, status: "WITHDRAWN" });
    expect((await call("GET", `/me/employee-documents/${other.id}/file`)).statusCode).toBe(404);

    actAs("hc", HC);
    const verified = await call("POST", `/admin/employee-documents/${renewal.id}/verify`);
    expect(verified.json()).toMatchObject({ status: "VERIFIED", expiresOn: "2031-12-01" });
    const history = (await call("GET", `/admin/employee-documents/employees/${people.aisyah.employeeId}?includeHistory=true`)).json();
    const statuses = Object.fromEntries(history.items.map((item: { id: string; status: string }) => [item.id, item.status]));
    expect(statuses).toEqual({ [old.id]: "REPLACED", [renewal.id]: "VERIFIED", [other.id]: "WITHDRAWN" });
    const current = (await call("GET", `/admin/employee-documents/employees/${people.aisyah.employeeId}`)).json();
    expect(current.items.map((item: { id: string }) => item.id)).toEqual([renewal.id]);
    // The replaced file stays as history and can still be read by HC.
    expect((await call("GET", `/admin/employee-documents/${old.id}/file`)).statusCode).toBe(200);
  });

  it("D-13: removing a document erases its content for good and keeps the metadata", async () => {
    const document = (await hcUpload("bilal", { documentType: "KTP", file: file(PDF) })).json();
    actAs("hc", HC);
    expect((await call("POST", `/admin/employee-documents/${document.id}/remove`, { reason: "salah" })).statusCode).toBe(200);
    expect((await call("GET", `/admin/employee-documents/${document.id}/file`)).statusCode).toBe(410);
    expect((await call("POST", `/admin/employee-documents/${document.id}/remove`, { reason: "lagi lagi" })).statusCode).toBe(409);
    actAs("bilal");
    expect((await call("GET", "/me/employee-documents")).json().items).toEqual([]);
    const removed = await events("employee_document.removed");
    expect(removed[0]!.metadata).toEqual({ documentType: "KTP", previousStatus: "VERIFIED", reasonLength: 5 });
  });

  it("EMP-011-F: the expiry worklist holds soon and past expiries of active managed employees", async () => {
    const soon = (await hcUpload("aisyah", { documentType: "SIM", expiresOn: "2026-12-01", file: file(PDF) })).json();
    const past = (await hcUpload("bilal", { documentType: "SKCK", expiresOn: "2026-10-01", file: file(PDF) })).json();
    const later = (await hcUpload("bilal", { documentType: "PASPOR", expiresOn: "2027-09-01", file: file(PDF) })).json();
    const resigned = (await hcUpload("manager", { documentType: "SIM", expiresOn: "2026-11-20", file: file(PDF) })).json();
    await client.query(`UPDATE employees SET status = 'resigned' WHERE id = $1`, [people.manager.employeeId]);
    actAs("hc", READ);
    const list = async (withinDays: number) => (await call("GET", `/admin/employee-documents/expiring?withinDays=${withinDays}&pageSize=100`)).json();
    const ids = (body: { items: Array<{ id: string }> }) => body.items.map((item) => item.id);
    const sixty = await list(60);
    expect(ids(sixty)).toEqual(expect.arrayContaining([soon.id, past.id]));
    expect(ids(sixty)).not.toContain(later.id);
    expect(ids(sixty)).not.toContain(resigned.id);
    const pastRow = sixty.items.find((item: { id: string }) => item.id === past.id);
    expect(pastRow).toMatchObject({ expired: true, daysLeft: -41, typeLabel: "SKCK" });
    expect(ids(await list(30))).toContain(soon.id);
    expect(ids(await list(30))).not.toContain(later.id);
    const paged = (await call("GET", "/admin/employee-documents/expiring?withinDays=60&pageSize=1")).json();
    expect(paged.items.length).toBe(1);
    expect(paged.pagination.total).toBeGreaterThanOrEqual(2);
    const audit = await events("employee_document.worklist_read");
    expect(audit[0]!.metadata).toMatchObject({ view: "EXPIRING", withinDays: 60 });
  });

  it("EMP-011-H: five open proposals at most; employees outside HCIS management are read-only", async () => {
    actAs("aisyah");
    for (let index = 0; index < 5; index += 1) {
      expect((await call("POST", "/me/employee-documents", { documentType: "SERTIFIKAT", file: file(PDF) })).statusCode).toBe(201);
    }
    const sixth = await call("POST", "/me/employee-documents", { documentType: "SERTIFIKAT", file: file(PDF) });
    expect(sixth.statusCode).toBe(409);
    expect(sixth.json().code).toBe("EMPLOYEE_DOCUMENT_PENDING_LIMIT");
    // Withdrawing and re-uploading does not escape the daily limit (10 per 24 hours).
    const mine = (await call("GET", "/me/employee-documents")).json().items as Array<{ id: string }>;
    for (const document of mine) await call("POST", `/me/employee-documents/${document.id}/withdraw`);
    for (let index = 0; index < 5; index += 1) {
      const next = await call("POST", "/me/employee-documents", { documentType: "SERTIFIKAT", file: file(PDF) });
      expect(next.statusCode).toBe(201);
      await call("POST", `/me/employee-documents/${next.json().id}/withdraw`);
    }
    const eleventh = await call("POST", "/me/employee-documents", { documentType: "SERTIFIKAT", file: file(PDF) });
    expect(eleventh.statusCode).toBe(429);
    expect(eleventh.json().code).toBe("EMPLOYEE_DOCUMENT_RATE_LIMITED");

    await client.query(`UPDATE employees SET management_scope = 'OUTSIDE_HCIS', management_scope_reason = 'BUMY',
              management_scope_marked_at = now(), management_scope_marked_by_account_id = $2,
              management_scope_note = 'Sintetis' WHERE id = $1`,
      [people.bilal.employeeId, people.hc.accountId]);
    expect((await hcUpload("bilal", { documentType: "KTP", file: file(PDF) })).json().code).toBe("EMPLOYEE_OUTSIDE_HCIS_READ_ONLY");
    actAs("bilal");
    expect((await call("POST", "/me/employee-documents", { documentType: "KTP", file: file(PDF) })).statusCode).toBe(409);
    expect((await call("GET", "/me/employee-documents")).json().canPropose).toBe(false);
  });

  it("§5.2: metadata rules, edits audited by field name only", async () => {
    const missingExpiry = await hcUpload("aisyah", { documentType: "PASPOR", file: file(PDF) });
    expect(missingExpiry.statusCode).toBe(400);
    expect(missingExpiry.json()).toMatchObject({ code: "EMPLOYEE_DOCUMENT_INVALID", field: "expiresOn" });
    const active = await hcUpload("aisyah", { documentType: "KTP", file: file(Buffer.from("%PDF-1.4 /OpenAction << /JavaScript (x) >>")) });
    expect(active.json().code).toBe("EMPLOYEE_DOCUMENT_FILE_ACTIVE_CONTENT");
    const document = (await hcUpload("aisyah", { documentType: "NPWP", file: file(PDF) })).json();
    actAs("hc", HC);
    const edited = await call("PATCH", `/admin/employee-documents/${document.id}`, { documentNumber: "12.345.678.9-012.345", notes: "Asli di map HC" });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json()).toMatchObject({ numberMasked: "••••2345", notes: "Asli di map HC" });
    const cleared = await call("PATCH", `/admin/employee-documents/${document.id}`, { documentNumber: null });
    expect(cleared.json().numberMasked).toBeNull();
    const updates = await events("employee_document.updated");
    expect(updates.map((event) => event.metadata.changedFields)).toEqual([["documentNumber", "notes"], ["documentNumber"]]);
    expect(JSON.stringify(updates.map((event) => event.metadata))).not.toContain("345");
  });

  it("EMP-011-G: a register document carries one current file, attached, replaced and read with audit", async () => {
    await client.query(
      `INSERT INTO employment_rollout_settings (id, mode, reason) VALUES (1, 'SHADOW', 'EMP-011 test')
       ON CONFLICT (id) DO UPDATE SET mode = 'SHADOW'`,
    );
    const documentId = randomUUID();
    await client.query(
      `INSERT INTO employment_decision_documents
         (id, document_kind, document_number, signed_on, pk_type, employee_id, contract_from, contract_to, category)
       VALUES ($1, 'PERJANJIAN_KERJA', $2, '2026-07-01', 'PK_BARU', $3, '2026-07-01', '2027-06-30', 'KONTRAK')`,
      [documentId, `${tag}/PK/2026`, people.aisyah.employeeId],
    );
    const url = `/admin/decision-documents/${documentId}/file`;
    actAs("hc", ["employment.read"]);
    expect((await call("PUT", url, file(PDF))).statusCode).toBe(403);
    expect((await call("GET", url)).statusCode).toBe(404);
    actAs("hc", ["employment.read", "employment.manage"]);
    expect((await call("PUT", url, file(PDF))).statusCode).toBe(200);
    expect((await call("PUT", url, file(PNG, "image/png"))).statusCode).toBe(200);
    const detail = (await call("GET", `/admin/decision-documents/${documentId}`)).json();
    expect(detail.file).toMatchObject({ contentType: "image/png", byteSize: PNG.length });
    const download = await call("GET", url);
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.equals(PNG)).toBe(true);
    expect(download.headers["content-disposition"]).toMatch(/^attachment; filename="PK-\d{4}-\d{2}-\d{2}\.png"$/);
    const files = await client.query(
      `SELECT replaced_at IS NULL AS current FROM employee_document_files WHERE decision_document_id = $1 ORDER BY created_at`,
      [documentId],
    );
    expect(files.rows.map((row) => row.current).sort()).toEqual([false, true]);
    const audit = await client.query<{ action: string; payload: Record<string, unknown> }>(
      `SELECT action, payload FROM employment_audit_events WHERE entity_id = $1 ORDER BY occurred_at, action`,
      [documentId],
    );
    expect(audit.rows.map((row) => row.action).sort()).toEqual([
      "employment.document.file_attached", "employment.document.file_read", "employment.document.file_replaced",
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain(tag);
  });
});
