// DOC-001 / DOC-002 Package 1 acceptance against a real schema.
// Synthetic employees only; every test runs inside one rolled-back transaction.

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import { incomeWindow } from "../src/modules/documents/income.js";
import { registerDocumentRoutes } from "../src/modules/documents/routes.js";
import { jakartaDate } from "../src/modules/documents/service.js";
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
 * Every connect() hands back the same client, so these tests are strictly sequential:
 * they cover transaction boundaries, not concurrency. The row lock that serializes two
 * simultaneous issues is asserted through the schema instead (see the UNIQUE test).
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
    // HC as it issues income letters: documents plus a per-person payroll reader (D-26). Tests
    // that are about the reader narrow this themselves.
    permissions = ["documents.read", "documents.manage", "payroll.results.read.organization"];

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

  it("DOC-001-D: successive issues receive distinct numbers, and UNIQUE backs the row lock", async () => {
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

    // Two concurrent issues cannot be exercised through the savepoint pool, so the schema
    // guarantee is asserted directly: even if the row lock were lost, a shared sequence
    // would be rejected rather than written.
    const unique = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'hr_issued_documents' AND indexdef LIKE 'CREATE UNIQUE%'`,
    );
    const definitions = unique.rows.map((row) => row.indexdef.replace(/\s+/g, " "));
    expect(definitions.some((definition) => /number_code, number_year, number_sequence/.test(definition))).toBe(true);
    expect(definitions.some((definition) => /\(document_number\)/.test(definition))).toBe(true);
  });

  it("DOC-001-E: the snapshot is frozen at issuing time", async () => {
    await addSigner();
    await client.query(`UPDATE employees SET structural_position = 'Guru' WHERE id = $1`, [employeeId]);
    const issued = await approveAndIssue(await submitRequest());
    expect(issued.statusCode, issued.body).toBe(201);
    await client.query(`UPDATE employees SET structural_position = 'Kepala Sekolah' WHERE id = $1`, [employeeId]);
    const letter = await app.inject({ method: "GET", url: `/documents/me/issued/${issued.json().id as string}` });
    expect(letter.json().contentSnapshot.positionTitle).toBe("Guru");
  });

  it("DOC-001-K: the employee opens their own issued letter for printing, audited; others and revoked letters are not served", async () => {
    await addSigner();
    const issued = await approveAndIssue(await submitRequest());
    expect(issued.statusCode, issued.body).toBe(201);
    const id = issued.json().id as string;

    const letter = await app.inject({ method: "GET", url: `/documents/me/issued/${id}` });
    expect(letter.statusCode, letter.body).toBe(200);
    expect(letter.headers["cache-control"]).toBe("no-store");
    expect(letter.json()).toMatchObject({
      id, documentCode: "KETERANGAN_KERJA", status: "ISSUED", documentNumber: issued.json().documentNumber,
      contentSnapshot: { fullName: "Dokumen Primary", purpose: "Keperluan pengajuan beasiswa anak" },
    });
    const audit = await client.query<{ actorAccountId: string; metadata: Record<string, unknown> }>(
      `SELECT actor_account_id AS "actorAccountId", metadata FROM hr_document_audit_events
        WHERE event_type = 'doc.opened' AND issued_document_id = $1`,
      [id],
    );
    expect(audit.rows).toEqual([{ actorAccountId: accountId, metadata: { documentCode: "KETERANGAN_KERJA", documentNumber: issued.json().documentNumber } }]);

    // The list names the letter but carries none of its content (D-20).
    const list = await app.inject({ method: "GET", url: "/documents/me/issued" });
    expect(list.json().items).toEqual([expect.objectContaining({ id, contentSnapshot: { documentLabel: "Surat Keterangan Kerja" } })]);
    expect(list.body).not.toContain("beasiswa");

    // My own warning letter is never served here: its narrative stays on the D-12 read.
    permissions = [...permissions, "documents.discipline.manage"];
    const warning = await app.inject({
      method: "POST",
      url: "/admin/documents/disciplinary",
      payload: {
        employeeId, level: "SP1", subject: "Keterlambatan berulang",
        narrative: "Uraian pelanggaran sintetis untuk pengujian.", effectiveDate: "2026-10-01",
      },
    });
    expect(warning.statusCode, warning.body).toBe(201);
    const warningDocument = await client.query<{ id: string }>(
      `SELECT id FROM hr_issued_documents WHERE employee_id = $1 AND document_kind = 'DISCIPLINARY'`, [employeeId],
    );
    expect((await app.inject({ method: "GET", url: `/documents/me/issued/${warningDocument.rows[0]!.id}` })).statusCode).toBe(404);

    // Another employee's letter answers like a missing one, and writes nothing.
    const otherAccount = randomUUID();
    await client.query(
      `INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1,$2,$3,'EMPLOYEE','active')`,
      [otherAccount, otherEmployeeId, `doc-${otherAccount}@example.invalid`],
    );
    const owner = principal;
    principal = { id: otherAccount, email: "other@example.invalid", principalType: "EMPLOYEE" };
    const foreign = await app.inject({ method: "GET", url: `/documents/me/issued/${id}` });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().code).toBe("DOCUMENT_NOT_FOUND");
    expect((await app.inject({ method: "GET", url: "/documents/me/issued/not-a-uuid" })).statusCode).toBe(404);
    principal = owner;

    await client.query(`UPDATE hr_issued_documents SET status = 'REVOKED', revoked_at = now(), revoke_reason = 'Uji pembatalan surat' WHERE id = $1`, [id]);
    const revoked = await app.inject({ method: "GET", url: `/documents/me/issued/${id}` });
    expect(revoked.statusCode).toBe(409);
    expect(revoked.json().code).toBe("DOCUMENT_REVOKED");
    const count = await client.query(`SELECT 1 FROM hr_document_audit_events WHERE event_type = 'doc.opened' AND employee_id = $1`, [employeeId]);
    expect(count.rowCount).toBe(1);

    // An employee who has left is not served at all.
    await client.query(`UPDATE hr_issued_documents SET status = 'ISSUED' WHERE id = $1`, [id]);
    await client.query(`UPDATE employees SET status = 'inactive' WHERE id = $1`, [employeeId]);
    const left = await app.inject({ method: "GET", url: `/documents/me/issued/${id}` });
    expect(left.statusCode).toBe(403);
    expect(left.json().code).toBe("EMPLOYEE_LINK_REQUIRED");
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

  it("DOC-001-H: a work certificate's snapshot carries no salary facts", async () => {
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
    expect(keys).not.toContain("income");
  });

  // ------------------------------------------------- Package 2: KETERANGAN_PENGHASILAN

  /** Synthetic published slips through an import batch, as PAY-001/PAY-002 writes them. */
  async function insertSlip(
    owner: string,
    period: string,
    lines: Array<{ label: string; value: string; section?: string }>,
    options: { published?: boolean; supersededBy?: string; id?: string } = {},
  ) {
    const batchId = randomUUID();
    await client.query(
      `INSERT INTO payslip_import_batches(id, source_filename, checksum_sha256, status, created_by_account_id)
       VALUES ($1,'sintetis.csv',$2,'published',$3)`,
      [batchId, batchId.replace(/-/g, "").padEnd(64, "0"), accountId],
    );
    const id = options.id ?? randomUUID();
    await client.query(
      `INSERT INTO payslips(id, employee_id, period, lines, source_batch_id, published_at, superseded_by_id)
       VALUES ($1,$2,$3::date,$4::jsonb,$5,$6,$7)`,
      [id, owner, `${period}-01`, JSON.stringify(lines), batchId,
        options.published === false ? null : new Date(), options.supersededBy ?? null],
    );
    return id;
  }

  function slipLines(gross: string, net: string) {
    return [
      { label: "Gaji Pokok", value: "1000000", section: "income" },
      { label: "Total Bruto Gaji", value: gross, section: "summary" },
      { label: "Gaji Neto", value: net, section: "summary" },
    ];
  }

  /** The three months before this Jakarta month, oldest first (D-22), and the month of issue. */
  function windowMonths() {
    const today = jakartaDate(new Date());
    return { months: incomeWindow(today), current: today.slice(0, 7) };
  }

  /** Three official slips: (5.000.000 + 5.250.000 + 5.100.000) / 3 = 5.116.666,67 -> 5.116.667. */
  async function seedOfficialSlips() {
    const { months, current } = windowMonths();
    const ids = [
      await insertSlip(employeeId, months[0]!, slipLines("5.000.000", "4.500.000")),
      // A PAY-003 slip names its lines differently and formats with Rp.
      await insertSlip(employeeId, months[1]!, [
        { label: "Total pendapatan", value: "Rp5.250.000", section: "summary" },
        { label: "Gaji bersih", value: "Rp4.700.000", section: "summary" },
        { label: "Nominal dibayar", value: "Rp2.350.000", section: "summary" },
      ]),
    ];
    // Month three: an earlier slip superseded by its revision; only the revision counts.
    const revisionId = randomUUID();
    await insertSlip(employeeId, months[2]!, slipLines("9.999.999", "9.999.999"), { supersededBy: revisionId });
    ids.push(await insertSlip(employeeId, months[2]!, slipLines("5100000", "4600001"), { id: revisionId }));
    // Ignored: a draft, a slip of the month of issue, an older month, and another employee's slip.
    await insertSlip(employeeId, current, slipLines("8888888", "8888888"));
    await insertSlip(employeeId, incomeWindow(`${months[0]}-01`)[2]!, slipLines("7777777", "7777777"));
    await insertSlip(otherEmployeeId, months[1]!, slipLines("6666666", "6666666"));
    return { months, ids };
  }

  async function requestIncome() {
    const response = await app.inject({
      method: "POST",
      url: "/documents/me/requests",
      payload: { documentCode: "KETERANGAN_PENGHASILAN", purpose: "Pengajuan kredit rumah" },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as string;
  }

  const AMOUNTS = ["5000000", "5250000", "5100000", "4500000", "4700000", "4600001", "5116667", "4600000",
    "5.000.000", "5.250.000", "4.500.000"];

  it("DOC-001-I: the income letter can be requested and freezes the official slip figures at issue", async () => {
    await addSigner();
    const types = await app.inject({ method: "GET", url: "/documents/me/types" });
    expect(types.json().items).toContainEqual({ code: "KETERANGAN_PENGHASILAN", label: "Surat Keterangan Penghasilan" });

    const { months, ids } = await seedOfficialSlips();
    const issued = await approveAndIssue(await requestIncome());
    expect(issued.statusCode, issued.body).toBe(201);
    expect(issued.json().documentNumber).toMatch(/^\d{3}\/SKP\/YSQ\//);
    expect(issued.body).not.toContain("5116667");
    const id = issued.json().id as string;

    const letter = await app.inject({ method: "GET", url: `/documents/me/issued/${id}` });
    expect(letter.statusCode, letter.body).toBe(200);
    expect(letter.headers["cache-control"]).toBe("no-store");
    expect(letter.json().contentSnapshot.income).toEqual({
      months: [
        // D-27: none of these slips carries a block "Ditanggung yayasan".
        { period: months[0], gross: "5000000", net: "4500000", employerBorne: "0", layout: "LEGACY" },
        { period: months[1], gross: "5250000", net: "4700000", employerBorne: "0", layout: "LEGACY" },
        { period: months[2], gross: "5100000", net: "4600001", employerBorne: "0", layout: "LEGACY" },
      ],
      monthCount: 3,
      averageGross: "5116667",
      averageNet: "4600000",
      averageEmployerBorne: "0",
      mixedLayout: false,
      windowFrom: months[0],
      windowTo: months[2],
      source: "PAYSLIP_PUBLISHED",
    });
    // D-15 still holds for everything else in the letter.
    const keys = Object.keys(letter.json().contentSnapshot as Record<string, unknown>);
    for (const forbidden of ["nik", "npwp", "bankAccount", "accountNumber", "address", "salary"]) expect(keys).not.toContain(forbidden);

    // The audit trail and the notification carry ids, codes and periods, never an amount.
    const audit = await client.query<{ eventType: string; reason: string | null; metadata: Record<string, unknown> }>(
      `SELECT event_type AS "eventType", reason, metadata FROM hr_document_audit_events WHERE employee_id = $1`,
      [employeeId],
    );
    const issuedEvent = audit.rows.find((row) => row.eventType === "doc.issued")!;
    expect(issuedEvent.metadata).toEqual({
      documentCode: "KETERANGAN_PENGHASILAN", documentNumber: issued.json().documentNumber,
      payslipIds: ids, incomePeriods: months,
    });
    const notifications = await client.query<{ title: string; body: string; safeMetadata: unknown }>(
      `SELECT title, body, safe_metadata AS "safeMetadata" FROM in_app_notifications WHERE recipient_account_id = $1`,
      [accountId],
    );
    expect(notifications.rows.length).toBeGreaterThan(0);
    const trail = JSON.stringify([audit.rows, notifications.rows]);
    for (const amount of AMOUNTS) expect(trail, amount).not.toContain(amount);

    // The list names the letter only (D-20).
    const list = await app.inject({ method: "GET", url: "/documents/me/issued" });
    for (const amount of AMOUNTS) expect(list.body, amount).not.toContain(amount);

    // DOC-001-E: a later revision of a slip does not change the letter.
    const revision = randomUUID();
    await client.query(`UPDATE payslips SET superseded_by_id = $2 WHERE id = $1`, [ids[0], revision]);
    await insertSlip(employeeId, months[0]!, slipLines("1000000", "900000"), { id: revision });
    const again = await app.inject({ method: "GET", url: `/documents/me/issued/${id}` });
    expect(again.json().contentSnapshot.income.months[0]).toEqual({
      period: months[0],
      gross: "5000000",
      net: "4500000",
      employerBorne: "0",
      layout: "LEGACY",
    });
  });

  it("DOC-001-L: no official slip in the window refuses issue with 409, keeps APPROVED and uses no number", async () => {
    await addSigner();
    const { months, current } = windowMonths();
    // Only slips that do not count: a draft inside the window and one for the month of issue.
    await insertSlip(employeeId, months[1]!, slipLines("5000000", "4500000"), { published: false });
    await insertSlip(employeeId, current, slipLines("5000000", "4500000"));
    const requestId = await requestIncome();
    const issued = await approveAndIssue(requestId);
    expect(issued.statusCode, issued.body).toBe(409);
    expect(issued.json().code).toBe("DOCUMENT_INCOME_UNAVAILABLE");
    expect(issued.json().message).toContain(months[0]);
    const row = await client.query<{ status: string }>(`SELECT status FROM hr_document_requests WHERE id = $1`, [requestId]);
    expect(row.rows[0]?.status).toBe("APPROVED");
    expect(await counterFor("SKP")).toBe(0);

    // A slip whose figures cannot be read is refused too, naming the period, not an amount.
    await insertSlip(employeeId, months[2]!, [{ label: "Total Bruto Gaji", value: "5000000" }]);
    const unreadable = await app.inject({ method: "POST", url: `/admin/documents/requests/${requestId}/issue`, payload: {} });
    expect(unreadable.statusCode, unreadable.body).toBe(409);
    expect(unreadable.json().code).toBe("DOCUMENT_INCOME_UNREADABLE");
    expect(unreadable.body).toContain(months[2]);
    expect(unreadable.body).not.toContain("5000000");
  });

  it("DOC-001-L: HC issues an income letter directly only for an active employee", async () => {
    await addSigner();
    const { months } = windowMonths();
    await insertSlip(otherEmployeeId, months[2]!, slipLines("3000000", "2800000"));
    await client.query(`UPDATE employees SET status = 'resigned' WHERE id = $1`, [otherEmployeeId]);
    const refused = await app.inject({
      method: "POST",
      url: "/admin/documents/issue",
      payload: { employeeId: otherEmployeeId, documentCode: "KETERANGAN_PENGHASILAN", purpose: "Pengajuan kredit" },
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().code).toBe("DOCUMENT_EMPLOYMENT_STATE");

    await client.query(`UPDATE employees SET status = 'active' WHERE id = $1`, [otherEmployeeId]);
    const direct = await app.inject({
      method: "POST",
      url: "/admin/documents/issue",
      payload: { employeeId: otherEmployeeId, documentCode: "KETERANGAN_PENGHASILAN", purpose: "Pengajuan kredit" },
    });
    expect(direct.statusCode, direct.body).toBe(201);
    const snapshot = await client.query<{ income: Record<string, unknown> }>(
      `SELECT content_snapshot->'income' AS income FROM hr_issued_documents WHERE id = $1`, [direct.json().id],
    );
    expect(snapshot.rows[0]?.income).toMatchObject({ monthCount: 1, averageGross: "3000000", averageNet: "2800000" });
  });

  it("DOC-001-N (D-26): issuing or reading someone else's income letter needs a payroll per-person reader", async () => {
    await addSigner();
    await seedOfficialSlips();
    const requestId = await requestIncome();

    // documents.read + documents.manage only (human_capital_admin without payroll figures).
    permissions = ["documents.read", "documents.manage"];
    const approve = await app.inject({ method: "POST", url: `/admin/documents/requests/${requestId}/approve`, payload: {} });
    expect(approve.statusCode, approve.body).toBe(200);
    const skpBefore = await counterFor("SKP");
    const refused = await app.inject({ method: "POST", url: `/admin/documents/requests/${requestId}/issue`, payload: {} });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().code).toBe("DOCUMENT_INCOME_FORBIDDEN");
    for (const amount of AMOUNTS) expect(refused.body).not.toContain(amount);
    // Nothing issued, no number used, the request stays APPROVED for a permitted issuer.
    const state = await client.query(`SELECT status FROM hr_document_requests WHERE id = $1`, [requestId]);
    expect(state.rows[0]).toEqual({ status: "APPROVED" });
    expect(await counterFor("SKP")).toBe(skpBefore);
    const direct = await app.inject({
      method: "POST",
      url: "/admin/documents/issue",
      payload: { employeeId: otherEmployeeId, documentCode: "KETERANGAN_PENGHASILAN", purpose: "Pengajuan kredit" },
    });
    expect(direct.statusCode, direct.body).toBe(403);
    expect(direct.json().code).toBe("DOCUMENT_INCOME_FORBIDDEN");
    // Other letters are unaffected.
    expect((await approveAndIssue(await submitRequest())).statusCode).toBe(201);

    permissions = ["documents.read", "documents.manage", "payroll.inputs.manage"];
    const issued = await app.inject({ method: "POST", url: `/admin/documents/requests/${requestId}/issue`, payload: {} });
    expect(issued.statusCode, issued.body).toBe(201);
    const incomeId = issued.json().id as string;
    // Each of the three payroll readers opens the content.
    for (const reader of ["payroll.results.read.organization", "payroll.calculate", "payroll.inputs.manage"]) {
      permissions = ["documents.read", "documents.manage", reader];
      const read = await app.inject({ method: "GET", url: `/admin/documents/issued/${incomeId}` });
      expect(read.statusCode, reader).toBe(200);
      expect(read.json().contentSnapshot.income.averageGross, reader).toBe("5116667");
    }
    const openedBefore = await client.query(
      `SELECT 1 FROM hr_document_audit_events WHERE event_type = 'doc.opened' AND issued_document_id = $1`,
      [incomeId],
    );

    // A payroll reader alone is not documents.manage: the route itself stays closed.
    permissions = ["documents.read", "payroll.results.read.organization"];
    const noManage = await app.inject({ method: "GET", url: `/admin/documents/issued/${incomeId}` });
    expect(noManage.statusCode).toBe(403);
    expect(noManage.json().code).toBe("DOCUMENT_FORBIDDEN");
    // documents.manage without a payroll reader: refused with its own code, and no doc.opened.
    permissions = ["documents.read", "documents.manage"];
    const noReader = await app.inject({ method: "GET", url: `/admin/documents/issued/${incomeId}` });
    expect(noReader.statusCode).toBe(403);
    expect(noReader.json().code).toBe("DOCUMENT_INCOME_FORBIDDEN");
    for (const amount of AMOUNTS) expect(noReader.body).not.toContain(amount);
    const openedAfter = await client.query(
      `SELECT 1 FROM hr_document_audit_events WHERE event_type = 'doc.opened' AND issued_document_id = $1`,
      [incomeId],
    );
    expect(openedAfter.rowCount).toBe(openedBefore.rowCount);

    // The employee still reads their own letter by ownership, with no permission at all (D-20).
    permissions = [];
    expect((await app.inject({ method: "GET", url: `/documents/me/issued/${incomeId}` })).statusCode).toBe(200);
  });

  it("DOC-001-M: HC reads an issued letter by permission; income content needs documents.manage", async () => {
    await addSigner();
    await seedOfficialSlips();
    const income = await approveAndIssue(await requestIncome());
    expect(income.statusCode, income.body).toBe(201);
    const work = await approveAndIssue(await submitRequest());
    expect(work.statusCode, work.body).toBe(201);
    const incomeId = income.json().id as string;
    const workId = work.json().id as string;

    // The employee themself reads their own income letter by ownership, with no permission (D-20).
    permissions = [];
    expect((await app.inject({ method: "GET", url: `/documents/me/issued/${incomeId}` })).statusCode).toBe(200);

    // HC is another employee account; what it may read depends only on its permissions.
    const hcAccount = randomUUID();
    await client.query(
      `INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1,$2,$3,'EMPLOYEE','active')`,
      [hcAccount, otherEmployeeId, `doc-hc-${hcAccount}@example.invalid`],
    );
    principal = { id: hcAccount, email: "hc@example.invalid", principalType: "EMPLOYEE" };
    // Another employee's self route never serves the letter.
    expect((await app.inject({ method: "GET", url: `/documents/me/issued/${incomeId}` })).statusCode).toBe(404);

    // documents.read + documents.manage + a payroll per-person reader: the full letter, audited, no-store.
    permissions = ["documents.read", "documents.manage", "payroll.calculate"];
    const full = await app.inject({ method: "GET", url: `/admin/documents/issued/${incomeId}` });
    expect(full.statusCode, full.body).toBe(200);
    expect(full.headers["cache-control"]).toBe("no-store");
    expect(full.json()).toMatchObject({ id: incomeId, documentCode: "KETERANGAN_PENGHASILAN", status: "ISSUED" });
    expect(full.json().contentSnapshot.income.averageGross).toBe("5116667");
    expect(full.json()).not.toHaveProperty("employeeId");
    const opened = await client.query<{ actorAccountId: string; metadata: Record<string, unknown> }>(
      `SELECT actor_account_id AS "actorAccountId", metadata FROM hr_document_audit_events
        WHERE event_type = 'doc.opened' AND issued_document_id = $1 AND actor_account_id = $2`,
      [incomeId, hcAccount],
    );
    expect(opened.rows).toEqual([{
      actorAccountId: hcAccount,
      metadata: { documentCode: "KETERANGAN_PENGHASILAN", documentNumber: income.json().documentNumber, surface: "admin" },
    }]);

    // documents.read alone (document_corrector): the register row, a work certificate, not the income letter.
    permissions = ["documents.read", "documents.correct"];
    const denied = await app.inject({ method: "GET", url: `/admin/documents/issued/${incomeId}` });
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json().code).toBe("DOCUMENT_FORBIDDEN");
    for (const amount of AMOUNTS) expect(denied.body).not.toContain(amount);
    expect((await app.inject({ method: "GET", url: `/admin/documents/issued/${workId}` })).statusCode).toBe(200);
    const register = await app.inject({ method: "GET", url: "/admin/documents/register?kind=CERTIFICATE" });
    expect(register.statusCode, register.body).toBe(200);
    expect(register.json().items.map((item: { id: string }) => item.id)).toContain(incomeId);
    for (const amount of AMOUNTS) expect(register.body, amount).not.toContain(amount);
    // ...and may still revoke it: revocation acts on the register, not the content (D-16).
    const revoked = await app.inject({
      method: "POST", url: `/admin/documents/issued/${incomeId}/revoke`, payload: { reason: "Uji pembatalan surat penghasilan" },
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    // The refused read left no doc.opened; only the permitted one did.
    const openings = await client.query(
      `SELECT 1 FROM hr_document_audit_events WHERE event_type = 'doc.opened' AND actor_account_id = $1 AND issued_document_id = $2`,
      [hcAccount, incomeId],
    );
    expect(openings.rowCount).toBe(1);

    // documents.manage without documents.read does not open the route at all; nothing at all is 403.
    permissions = ["documents.manage"];
    expect((await app.inject({ method: "GET", url: `/admin/documents/issued/${incomeId}` })).statusCode).toBe(403);
    permissions = [];
    expect((await app.inject({ method: "GET", url: `/admin/documents/issued/${workId}` })).statusCode).toBe(403);

    // A warning letter, a missing id and a malformed id all answer 404 to HC (D-13).
    permissions = ["documents.read", "documents.manage", "documents.discipline.manage"];
    const warning = await app.inject({
      method: "POST",
      url: "/admin/documents/disciplinary",
      payload: {
        employeeId, level: "SP1", subject: "Keterlambatan berulang",
        narrative: "Uraian pelanggaran sintetis untuk pengujian.", effectiveDate: "2026-10-01",
      },
    });
    expect(warning.statusCode, warning.body).toBe(201);
    const warningDocument = await client.query<{ id: string }>(
      `SELECT id FROM hr_issued_documents WHERE employee_id = $1 AND document_kind = 'DISCIPLINARY'`, [employeeId],
    );
    expect((await app.inject({ method: "GET", url: `/admin/documents/issued/${warningDocument.rows[0]!.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/admin/documents/issued/${randomUUID()}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/admin/documents/issued/not-a-uuid" })).statusCode).toBe(404);
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

  it("DOC-002-D: a revoked letter never reads as still in force", async () => {
    await addSigner();
    permissions = [...permissions, "documents.discipline.manage", "documents.correct"];
    const issue = await app.inject({
      method: "POST",
      url: "/admin/documents/disciplinary",
      payload: {
        employeeId, level: "SP1", subject: "Keterlambatan berulang",
        narrative: "Uraian pelanggaran sintetis untuk pengujian.",
        effectiveDate: "2020-01-06", expiresOn: "2099-01-06",
      },
    });
    expect(issue.statusCode, issue.body).toBe(201);
    const before = await app.inject({ method: "GET", url: "/documents/me/disciplinary" });
    expect((before.json().items as Array<{ active: boolean }>)[0]!.active).toBe(true);

    const documentId = await client.query<{ issuedDocumentId: string }>(
      `SELECT issued_document_id AS "issuedDocumentId" FROM hr_disciplinary_letters WHERE id = $1`,
      [issue.json().id],
    );
    const revoked = await app.inject({
      method: "POST",
      url: `/admin/documents/issued/${documentId.rows[0]!.issuedDocumentId}/revoke`,
      payload: { reason: "Diterbitkan atas pegawai yang keliru" },
    });
    expect(revoked.statusCode, revoked.body).toBe(200);

    const after = await app.inject({ method: "GET", url: "/documents/me/disciplinary" });
    expect((after.json().items as Array<{ active: boolean }>)[0]!.active).toBe(false);
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

  async function issueWarningLetter(level: "SP1" | "SP2" | "SP3" = "SP1") {
    const previous = permissions;
    permissions = [...permissions, "documents.discipline.manage"];
    const issue = await app.inject({
      method: "POST",
      url: "/admin/documents/disciplinary",
      payload: {
        employeeId, level, subject: "Perihal rahasia sintetis",
        narrative: "Uraian rahasia sintetis untuk pengujian register.",
        effectiveDate: "2026-10-01", expiresOn: "2099-01-06",
      },
    });
    permissions = previous;
    expect(issue.statusCode, issue.body).toBe(201);
    const row = await client.query<{ issuedDocumentId: string }>(
      `SELECT issued_document_id AS "issuedDocumentId" FROM hr_disciplinary_letters WHERE id = $1`,
      [issue.json().id],
    );
    return { issuedDocumentId: row.rows[0]!.issuedDocumentId, documentNumber: issue.json().documentNumber as string };
  }

  it("DOC-002-F2: the register lists warning letters without who received them or what they say", async () => {
    await addSigner();
    const letter = await issueWarningLetter();
    // A document_corrector holds documents.read and documents.correct, not discipline.manage.
    permissions = ["documents.read", "documents.correct"];
    const forbiddenList = await app.inject({ method: "GET", url: "/admin/documents/disciplinary" });
    expect(forbiddenList.statusCode).toBe(403);

    const register = await app.inject({ method: "GET", url: "/admin/documents/register?kind=DISCIPLINARY" });
    expect(register.statusCode, register.body).toBe(200);
    const items = register.json().items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: letter.issuedDocumentId, documentKind: "DISCIPLINARY", documentCode: "SP1",
      documentNumber: letter.documentNumber, status: "ISSUED",
      employeeName: null, employeeNumber: null, signer: null, revokedAt: null, revokeReason: null,
    });
    expect(register.body).not.toContain("Dokumen Primary");
    expect(register.body).not.toContain("rahasia sintetis");

    // The certificate register is the default and never mixes the two kinds.
    const certificates = await app.inject({ method: "GET", url: "/admin/documents/register" });
    expect(certificates.json().items).toEqual([]);
    expect(certificates.json().pagination.total).toBe(0);

    permissions = [];
    expect((await app.inject({ method: "GET", url: "/admin/documents/register?kind=DISCIPLINARY" })).statusCode).toBe(403);
    permissions = ["documents.read"];
    expect((await app.inject({ method: "GET", url: "/admin/documents/register?kind=OTHER" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/admin/documents/register?pageSize=101" })).statusCode).toBe(400);
  });

  it("DOC-002-F3/F4: a corrector who cannot read the letter revokes it with a reason, audited, number kept", async () => {
    await addSigner();
    const letter = await issueWarningLetter();
    // Acknowledged first: D-19 says the acknowledgement does not lock the letter.
    const acknowledged = await client.query(
      `UPDATE hr_disciplinary_letters SET acknowledged_at = now() WHERE issued_document_id = $1`,
      [letter.issuedDocumentId],
    );
    expect(acknowledged.rowCount).toBe(1);
    const url = `/admin/documents/issued/${letter.issuedDocumentId}/revoke`;
    const revokedEvents = async () =>
      (await client.query(`SELECT 1 FROM hr_document_audit_events WHERE event_type LIKE '%revoked'`)).rowCount;

    // The HC admin bundle without documents.correct is refused, and nothing changes.
    permissions = ["documents.read", "documents.manage", "documents.discipline.manage"];
    const forbidden = await app.inject({ method: "POST", url, payload: { reason: "Diterbitkan atas pegawai yang keliru" } });
    expect(forbidden.statusCode, forbidden.body).toBe(403);
    expect(forbidden.json().code).toBe("DOCUMENT_FORBIDDEN");

    permissions = ["documents.read", "documents.correct"];
    for (const payload of [{}, { reason: "" }, { reason: "   singkat   " }, { reason: "x".repeat(501) }]) {
      const refused = await app.inject({ method: "POST", url, payload });
      expect(refused.statusCode, JSON.stringify(payload)).toBe(400);
      expect(refused.json().code).toBe("INVALID_DOCUMENT_REVOKE");
    }
    const untouched = await client.query<{ status: string }>(
      `SELECT status FROM hr_issued_documents WHERE id = $1`, [letter.issuedDocumentId],
    );
    expect(untouched.rows[0]!.status).toBe("ISSUED");
    expect(await revokedEvents()).toBe(0);

    const reason = "Diterbitkan atas pegawai yang keliru";
    const revoked = await app.inject({ method: "POST", url, payload: { reason: `  ${reason}  ` } });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.json()).toEqual({ id: letter.issuedDocumentId, status: "REVOKED" });

    const audit = await client.query(
      `SELECT event_type AS "eventType", reason, actor_account_id AS actor, issued_document_id AS issued,
              employee_id AS employee, metadata
         FROM hr_document_audit_events WHERE event_type LIKE '%revoked'`,
    );
    expect(audit.rows).toEqual([{
      eventType: "doc.discipline.revoked", reason, actor: accountId, issued: letter.issuedDocumentId,
      employee: employeeId, metadata: { documentCode: "SP1", documentNumber: letter.documentNumber },
    }]);
    expect(JSON.stringify(audit.rows[0])).not.toContain("rahasia sintetis");

    // The register shows the revocation; the letter and its number are still there.
    const register = await app.inject({ method: "GET", url: "/admin/documents/register?kind=DISCIPLINARY&status=REVOKED" });
    const row = (register.json().items as Array<Record<string, unknown>>)[0]!;
    expect(row).toMatchObject({ documentNumber: letter.documentNumber, status: "REVOKED", revokeReason: reason });
    expect(row.revokedAt).toEqual(expect.any(String));
    const issuedOnly = await app.inject({ method: "GET", url: "/admin/documents/register?kind=DISCIPLINARY&status=ISSUED" });
    expect(issuedOnly.json().pagination.total).toBe(0);

    // A second attempt is a conflict and writes no second event.
    const again = await app.inject({ method: "POST", url, payload: { reason: "Percobaan pembatalan kedua" } });
    expect(again.statusCode).toBe(409);
    expect(await revokedEvents()).toBe(1);

    // D-03: the next letter of the same level takes a new number, never the revoked one.
    const next = await issueWarningLetter();
    expect(next.documentNumber).not.toBe(letter.documentNumber);
    const sequences = await client.query<{ documentNumber: string; status: string }>(
      `SELECT document_number AS "documentNumber", status FROM hr_issued_documents
        WHERE document_kind = 'DISCIPLINARY' ORDER BY number_sequence`,
    );
    expect(sequences.rows).toEqual([
      { documentNumber: letter.documentNumber, status: "REVOKED" },
      { documentNumber: next.documentNumber, status: "ISSUED" },
    ]);
  });

  it("ENG-LIST-001: the register pages with a stable order and a filtered total", async () => {
    await addSigner();
    const numbers: string[] = [];
    for (let index = 0; index < 3; index += 1) numbers.push((await issueWarningLetter()).documentNumber);
    // One issued_at for all three, so only the id tie-breaker keeps the pages apart.
    await client.query(`UPDATE hr_issued_documents SET issued_at = '2026-10-01T03:00:00Z' WHERE document_kind = 'DISCIPLINARY'`);
    const page = async (n: number) => (await app.inject({
      method: "GET", url: `/admin/documents/register?kind=DISCIPLINARY&page=${n}&pageSize=2`,
    })).json() as { items: Array<{ documentNumber: string }>; pagination: Record<string, number> };
    const first = await page(1);
    const second = await page(2);
    expect(first.pagination).toEqual({ page: 1, pageSize: 2, total: 3, pageCount: 2 });
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
    expect([...first.items, ...second.items].map((item) => item.documentNumber).sort()).toEqual([...numbers].sort());
    expect((await page(1)).items).toEqual(first.items);
    const beyond = await page(5);
    expect(beyond.items).toEqual([]);
    expect(beyond.pagination.total).toBe(3);
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

  it("DOC-002-I: Human Capital Admin issues warning letters; only document_corrector revokes", async () => {
    const byRole = await client.query<{ roleKey: string; permissionKey: string }>(
      `SELECT role.role_key AS "roleKey", role_permission.permission_key AS "permissionKey"
         FROM role_permissions role_permission
         JOIN roles role ON role.id = role_permission.role_id
        WHERE role_permission.permission_key LIKE 'documents.%'
        ORDER BY role.role_key, role_permission.permission_key`,
    );
    const grouped = new Map<string, string[]>();
    for (const row of byRole.rows) grouped.set(row.roleKey, [...(grouped.get(row.roleKey) ?? []), row.permissionKey]);
    expect(grouped.get("human_capital_admin")).toEqual([
      "documents.discipline.manage", "documents.manage", "documents.read",
    ]);
    expect(grouped.get("document_corrector")).toEqual(["documents.correct", "documents.read"]);
    // No other role carries any documents.* permission, so no unit-scoped role sees warning letters.
    expect([...grouped.keys()].sort()).toEqual(["document_corrector", "human_capital_admin"]);
  });

  it("D-08: a repeated submission is refused once three are open", async () => {
    await submitRequest("Keperluan pertama untuk keluarga");
    await submitRequest("Keperluan kedua untuk bank");
    await submitRequest("Keperluan ketiga untuk sekolah");
    // Sequential, through the savepoint pool: the limit itself, not the serialization.
    const fourth = await app.inject({
      method: "POST",
      url: "/documents/me/requests",
      payload: { documentCode: "KETERANGAN_KERJA", purpose: "Keperluan keempat yang ditolak" },
    });
    expect(fourth.statusCode, fourth.body).toBe(409);
    const rows = await client.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM hr_document_requests WHERE employee_id = $1`,
      [employeeId],
    );
    expect(rows.rows[0]?.total).toBe(3);
  });
});

/**
 * DOC-001-J needs two real connections, so this suite commits its rows and deletes them
 * afterwards instead of running inside one rolled-back transaction.
 */
describe.skipIf(!allowed)("DOC-001-J concurrent submissions", () => {
  let pool: Pool;
  let app: ReturnType<typeof Fastify>;
  let employeeId: string;
  let accountId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl!, max: 4 });
    employeeId = randomUUID();
    accountId = randomUUID();
    await pool.query(
      `INSERT INTO employees(id, employee_number, full_name, status, started_on)
       VALUES ($1,$2,'Dokumen Konkuren','active','2020-01-06')`,
      [employeeId, `DOC-C-${employeeId.slice(0, 8)}`],
    );
    await pool.query(
      `INSERT INTO accounts(id, employee_id, email, principal_type, status)
       VALUES ($1,$2,$3,'EMPLOYEE','active')`,
      [accountId, employeeId, `doc-c-${accountId}@example.invalid`],
    );
    const config = { NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8 } as ApiConfig;
    app = Fastify({ logger: false });
    await registerDocumentRoutes(app, pool, config, {
      getSession: async () => ({
        principal: { id: accountId, email: "doc-c@example.invalid", principalType: "EMPLOYEE" },
        expiresAt: "2099-01-01T00:00:00Z",
      }),
      getAuthorizationContext: async () => ({ organizationPermissions: [] }),
    } as never);
  });

  afterAll(async () => {
    try {
      await app?.close();
      if (pool) {
        await pool.query("DELETE FROM hr_document_audit_events WHERE employee_id = $1", [employeeId]);
        await pool.query("DELETE FROM hr_document_requests WHERE employee_id = $1", [employeeId]);
        await pool.query("DELETE FROM accounts WHERE id = $1", [accountId]);
        await pool.query("DELETE FROM employees WHERE id = $1", [employeeId]);
      }
    } finally {
      await pool?.end();
    }
  });

  it("refuses the fourth of two simultaneous submissions when two are already open", async () => {
    const submit = (purpose: string) => app.inject({
      method: "POST",
      url: "/documents/me/requests",
      payload: { documentCode: "KETERANGAN_KERJA", purpose },
    });
    for (const purpose of ["Keperluan pertama untuk bank", "Keperluan kedua untuk sekolah"]) {
      expect((await submit(purpose)).statusCode).toBe(201);
    }

    // Two genuinely simultaneous submissions on separate connections: the advisory lock must
    // let exactly one through, because a third open request fills the quota.
    const [first, second] = await Promise.all([
      submit("Keperluan ketiga yang berlomba A"),
      submit("Keperluan ketiga yang berlomba B"),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses, `${first.body} | ${second.body}`).toEqual([201, 409]);

    const rows = await pool.query<{ total: number }>(
      "SELECT count(*)::int AS total FROM hr_document_requests WHERE employee_id = $1",
      [employeeId],
    );
    expect(rows.rows[0]?.total).toBe(3);
  });
});
