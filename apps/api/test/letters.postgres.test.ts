// DOC-003 Package 1 acceptance against a real schema (docs/domain/outgoing-letter-register.md §9).
// Synthetic accounts only; the main suite runs inside one rolled-back transaction, the concurrency
// suite commits its own rows and deletes them afterwards.

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import { registerLetterRoutes } from "../src/modules/documents/letter-routes.js";
import { formatLetterNumber, letterPeriodKey } from "../src/modules/documents/letters.js";
import { jakartaDate } from "../src/modules/documents/service.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

const config = { NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8 } as ApiConfig;
const today = jakartaDate(new Date());
const year = today.slice(0, 4);
const month = today.slice(0, 7);
const CRLF = "\r\n";
/** The export starts with a UTF-8 byte-order mark (U+FEFF). */
const stripBom = (body: string) => (body.charCodeAt(0) === 0xfeff ? body.slice(1) : body);

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

describe("DOC-003 letter number format", () => {
  it("D-02/D-04: formats the legacy pattern from the Jakarta calendar", () => {
    expect(formatLetterNumber("UND", 7, "SDIT", "2026-11-11")).toBe("UND.007/SDIT/XI/2026");
    expect(formatLetterNumber("SK", 1234, "YSQ", "2027-01-02")).toBe("SK.1234/YSQ/I/2027");
    expect(letterPeriodKey("YEARLY", "2026-11-11")).toBe("2026");
    expect(letterPeriodKey("MONTHLY", "2026-11-11")).toBe("2026-11");
  });
});

type Who = "hc" | "clerk" | "colleague" | "outsider";

describe.skipIf(!allowed)("DOC-003 outgoing letter register", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let principal: AuthPrincipal;
  let permissions: string[];
  const people = {} as Record<Who, { employeeId: string; accountId: string }>;
  let issuerId: string;
  let otherIssuerId: string;
  const issuerCode = `T${randomUUID().slice(0, 6).toUpperCase()}`;
  const otherIssuerCode = `U${randomUUID().slice(0, 6).toUpperCase()}`;
  const HC_READ = ["documents.read"];
  const HC = ["documents.read", "documents.manage"];

  function actAs(who: Who, granted: string[] = []) {
    principal = { id: people[who].accountId, email: `${who}@example.invalid`, principalType: "EMPLOYEE" };
    permissions = granted;
  }

  async function call(method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) {
    return app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) });
  }

  async function grant(who: Who, issuer = issuerId) {
    actAs("hc", HC);
    const response = await call("POST", "/admin/letters/grants", {
      employeeId: people[who].employeeId, issuerId: issuer, reason: "Sekretaris unit",
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string };
  }

  async function take(who: Who, overrides: Record<string, unknown> = {}) {
    actAs(who);
    return call("POST", "/letters/me/numbers", {
      issuerId, typeCode: "UND", subject: "Undangan rapat wali santri", recipient: "Wali santri kelas 7", ...overrides,
    });
  }

  async function audit(eventType: string) {
    return (await client.query<{ total: number }>(
      "SELECT count(*)::int AS total FROM letter_audit_events WHERE event_type = $1", [eventType],
    )).rows[0]!.total;
  }

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    for (const who of ["hc", "clerk", "colleague", "outsider"] as const) {
      const employeeId = randomUUID();
      await client.query(
        `INSERT INTO employees(id, employee_number, full_name, status, started_on) VALUES ($1,$2,$3,'active','2020-01-06')`,
        [employeeId, `LTR-${employeeId.slice(0, 8)}`, `Pegawai ${who}`],
      );
      const accountId = randomUUID();
      await client.query(
        "INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1,$2,$3,'EMPLOYEE','active')",
        [accountId, employeeId, `ltr-${who}-${accountId}@example.invalid`],
      );
      people[who] = { employeeId, accountId };
    }
    issuerId = randomUUID();
    otherIssuerId = randomUUID();
    await client.query(
      `INSERT INTO letter_issuers (id, code, name, kind) VALUES ($1,$2,'Unit Uji','OTHER'), ($3,$4,'Unit Lain','OTHER')`,
      [issuerId, issuerCode, otherIssuerId, otherIssuerCode],
    );
    actAs("hc", HC);
    const auth = {
      getSession: async () => ({ principal, expiresAt: "2099-01-01T00:00:00Z" }),
      getAuthorizationContext: async () => ({ organizationPermissions: permissions }),
    } as never;
    app = Fastify({ logger: false });
    await registerLetterRoutes(app, savepointPool(client), config, auth);
  });

  afterEach(async () => {
    try { await app?.close(); } finally {
      if (client) { await client.query("ROLLBACK"); client.release(); }
    }
  });

  it("DOC-003-A: without a grant the number is refused and none is used", async () => {
    const refused = await take("outsider");
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe("LETTER_GRANT_REQUIRED");
    const counters = await client.query("SELECT 1 FROM letter_number_counters WHERE issuer_id = $1", [issuerId]);
    expect(counters.rows).toHaveLength(0);
    actAs("outsider");
    const options = await call("GET", "/letters/me/options");
    expect(options.statusCode).toBe(200);
    expect(options.json().issuers).toEqual([]);
  });

  it("DOC-003-B/L: numbers follow the format, run per issuer, and are audited", async () => {
    await grant("clerk");
    await grant("clerk", otherIssuerId);
    const first = await take("clerk");
    expect(first.statusCode, first.body).toBe(201);
    const roman = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"][Number(today.slice(5, 7)) - 1];
    expect(first.json().letterNumber).toBe(`UND.001/${issuerCode}/${roman}/${year}`);
    expect(first.json()).toMatchObject({ status: "ALLOCATED", letterDate: today, periodKey: year, version: 1 });
    expect((await take("clerk")).json().letterNumber).toBe(`UND.002/${issuerCode}/${roman}/${year}`);
    // Another type and another issuer start at 1 (D-03).
    expect((await take("clerk", { typeCode: "PEM" })).json().letterNumber).toBe(`PEM.001/${issuerCode}/${roman}/${year}`);
    expect((await take("clerk", { issuerId: otherIssuerId })).json().letterNumber).toBe(`UND.001/${otherIssuerCode}/${roman}/${year}`);
    expect(await audit("letter.allocated")).toBeGreaterThanOrEqual(4);
    expect(await audit("letter.grant.created")).toBeGreaterThanOrEqual(2);
  });

  it("DOC-003-D: a refused allocation takes no number", async () => {
    await grant("clerk");
    expect((await take("clerk", { subject: "x" })).statusCode).toBe(400);
    expect((await take("clerk", { typeCode: "NOPE" })).statusCode).toBe(409);
    await client.query("UPDATE letter_types SET active = false WHERE code = 'REK'");
    expect((await take("clerk", { typeCode: "REK" })).json().code).toBe("LETTER_TYPE_INACTIVE");
    await client.query("UPDATE letter_issuers SET active = false WHERE id = $1", [otherIssuerId]);
    await grant("colleague", issuerId);
    const ok = await take("clerk");
    expect(ok.json().sequence).toBe(1);
  });

  it("DOC-003-E: a monthly type numbers per month", async () => {
    await client.query("INSERT INTO letter_types (code, label, reset_period) VALUES ('BLN', 'Bulanan Uji', 'MONTHLY')");
    await grant("clerk");
    const response = await take("clerk", { typeCode: "BLN" });
    expect(response.json()).toMatchObject({ periodKey: month, sequence: 1 });
    // A counter for another month does not move this month's sequence.
    await client.query(
      "INSERT INTO letter_number_counters (issuer_id, type_code, period_key, last_sequence) VALUES ($1,'BLN','1999-01',40)",
      [issuerId],
    );
    expect((await take("clerk", { typeCode: "BLN" })).json().sequence).toBe(2);
  });

  it("DOC-003-F/G: voiding keeps the number; only the owner or documents.manage may edit or void", async () => {
    await grant("clerk");
    await grant("colleague");
    const taken = (await take("clerk")).json() as { id: string; letterNumber: string; version: number };

    actAs("colleague");
    expect((await call("PATCH", `/letters/me/numbers/${taken.id}`, { subject: "Diubah orang lain", version: 1 })).statusCode).toBe(404);
    expect((await call("POST", `/letters/me/numbers/${taken.id}/void`, { reason: "Bukan nomor saya sendiri" })).statusCode).toBe(404);
    // The colleague still sees the shared book (D-13), not as theirs.
    const book = await call("GET", "/letters/me/numbers");
    expect(book.json().items.find((row: { id: string }) => row.id === taken.id)).toMatchObject({ mine: false });

    actAs("clerk");
    const stale = await call("PATCH", `/letters/me/numbers/${taken.id}`, { subject: "Undangan rapat pleno", version: 7 });
    expect(stale.json().code).toBe("LETTER_VERSION_CONFLICT");
    const edited = await call("PATCH", `/letters/me/numbers/${taken.id}`, { subject: "Undangan rapat pleno", version: 1 });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json()).toMatchObject({ subject: "Undangan rapat pleno", letterNumber: taken.letterNumber, version: 2 });
    expect((await call("POST", `/letters/me/numbers/${taken.id}/void`, { reason: "pendek" })).statusCode).toBe(400);
    const voided = await call("POST", `/letters/me/numbers/${taken.id}/void`, { reason: "Rapat dibatalkan oleh kepala unit" });
    expect(voided.statusCode, voided.body).toBe(200);
    expect(voided.json()).toMatchObject({ status: "VOIDED", voidReason: "Rapat dibatalkan oleh kepala unit" });
    expect((await call("POST", `/letters/me/numbers/${taken.id}/void`, { reason: "Rapat dibatalkan oleh kepala unit" })).json().code)
      .toBe("LETTER_NOT_VOIDABLE");
    expect((await call("PATCH", `/letters/me/numbers/${taken.id}`, { subject: "Tidak boleh lagi", version: 3 })).json().code)
      .toBe("LETTER_NOT_EDITABLE");
    // The next number does not reuse the voided sequence.
    expect((await take("clerk")).json().sequence).toBe(2);

    // documents.manage edits and voids anyone's number; documents.read alone does not.
    const other = (await take("colleague")).json() as { id: string };
    actAs("hc", HC_READ);
    expect((await call("POST", `/admin/letters/numbers/${other.id}/void`, { reason: "Dibatalkan oleh Human Capital" })).statusCode).toBe(403);
    actAs("hc", HC);
    expect((await call("PATCH", `/admin/letters/numbers/${other.id}`, { recipient: "Kepala sekolah", version: 1 })).statusCode).toBe(200);
    expect((await call("POST", `/admin/letters/numbers/${other.id}/void`, { reason: "Dibatalkan oleh Human Capital" })).statusCode).toBe(200);
    expect(await audit("letter.voided")).toBeGreaterThanOrEqual(2);
    expect(await audit("letter.updated")).toBeGreaterThanOrEqual(2);
  });

  it("DOC-003-H: the register joins HCIS-issued letters without employee names, paged with the filtered total", async () => {
    await grant("clerk");
    for (let index = 0; index < 3; index += 1) expect((await take("clerk")).statusCode).toBe(201);
    const hcisNumber = `999/SKK/YSQ/I/${year}-${randomUUID().slice(0, 6)}`;
    await client.query(
      `INSERT INTO hr_issued_documents (id, document_kind, document_code, employee_id, number_code, number_year,
         number_sequence, document_number, issued_by_account_id)
       VALUES ($1,'DISCIPLINARY','SP1',$2,'SP1-T',$3,1,$4,$5)`,
      [randomUUID(), people.colleague.employeeId, Number(year), hcisNumber, people.hc.accountId],
    );

    actAs("clerk");
    expect((await call("GET", "/admin/letters/register")).statusCode).toBe(403);
    actAs("hc", HC_READ);
    const book = await call("GET", `/admin/letters/register?source=BOOK&issuerCode=${issuerCode}&pageSize=2`);
    expect(book.statusCode, book.body).toBe(200);
    expect(book.json().pagination).toMatchObject({ total: 3, page: 1, pageSize: 2, pageCount: 2 });
    const second = await call("GET", `/admin/letters/register?source=BOOK&issuerCode=${issuerCode}&pageSize=2&page=2`);
    expect(second.json().items).toHaveLength(1);
    const beyond = await call("GET", `/admin/letters/register?source=BOOK&issuerCode=${issuerCode}&pageSize=2&page=9`);
    expect(beyond.json()).toMatchObject({ items: [], pagination: { total: 3 } });
    const ids = [...book.json().items, ...second.json().items].map((row: { id: string }) => row.id);
    expect(new Set(ids).size).toBe(3);

    const hcis = await call("GET", `/admin/letters/register?source=ALL&q=${encodeURIComponent(hcisNumber)}`);
    expect(hcis.json().pagination.total).toBe(1);
    const row = hcis.json().items[0];
    expect(row).toMatchObject({ source: "HCIS", issuerName: "HCIS", subject: "Surat Peringatan", status: "ACTIVE", recipient: null });
    expect(row.requestedByName).toBeNull();
    expect(JSON.stringify(row)).not.toContain("Pegawai colleague");
    // An issuer filter names a book issuer, so HCIS rows drop out.
    const filtered = await call("GET", `/admin/letters/register?issuerCode=${issuerCode}&q=${encodeURIComponent(hcisNumber)}`);
    expect(filtered.json().pagination.total).toBe(0);
    expect((await call("GET", "/admin/letters/register?pageSize=500")).statusCode).toBe(400);
  });

  it("DOC-003-I: the export is complete, neutralises formulas and is audited", async () => {
    await grant("clerk");
    expect((await take("clerk", { subject: "=HYPERLINK(\"x\")", recipient: "+62 Wali" })).statusCode).toBe(201);
    expect((await take("clerk")).statusCode).toBe(201);
    actAs("hc", HC_READ);
    const response = await call("GET", `/admin/letters/register/export?source=BOOK&issuerCode=${issuerCode}`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    const lines = stripBom(response.body).trim().split(CRLF);
    expect(lines).toHaveLength(3);
    expect(response.body).toContain(`"'=HYPERLINK(""x"")"`);
    expect(response.body).toContain(`"'+62 Wali"`);
    expect(await audit("letter.register.exported")).toBe(1);
  });

  it("DOC-003-J: the starting number only raises the counter", async () => {
    await grant("clerk");
    actAs("hc", HC);
    const raise = (lastSequence: number, periodKey = year) =>
      call("POST", "/admin/letters/counters", { issuerId, typeCode: "UND", periodKey, lastSequence });
    expect((await raise(5, month)).statusCode).toBe(400);
    const raised = await raise(45);
    expect(raised.statusCode, raised.body).toBe(200);
    expect(raised.json()).toMatchObject({ previous: 0, lastSequence: 45 });
    expect((await take("clerk")).json().sequence).toBe(46);
    actAs("hc", HC);
    expect((await raise(46)).json().code).toBe("LETTER_COUNTER_NOT_RAISED");
    expect((await raise(10)).json().code).toBe("LETTER_COUNTER_NOT_RAISED");
    const read = await call("GET", `/admin/letters/counters?issuerId=${issuerId}&typeCode=UND&periodKey=${year}`);
    expect(read.json().lastSequence).toBe(46);
    expect(await audit("letter.counter.raised")).toBe(1);
  });

  it("DOC-003-K: a committee issuer numbers letters only while its committee is active", async () => {
    const committeeId = randomUUID();
    await client.query(
      `INSERT INTO committees (id, name, category, start_on, end_on, created_by_account_id, updated_by_account_id)
       VALUES ($1,'Panitia Uji Nomor','EVENT',$2::date,$2::date,$3,$3)`,
      [committeeId, today, people.hc.accountId],
    );
    actAs("hc", HC);
    const code = `P${randomUUID().slice(0, 6).toUpperCase()}`;
    const created = await call("POST", "/admin/letters/issuers", { code, name: "Panitia Uji", kind: "COMMITTEE", committeeId });
    expect(created.statusCode, created.body).toBe(201);
    expect((await call("POST", "/admin/letters/issuers", { code, name: "Kode ganda", kind: "OTHER" })).json().code)
      .toBe("LETTER_ISSUER_CODE_TAKEN");
    expect((await call("POST", "/admin/letters/issuers", { code: "X1", name: "Unit tanpa unit", kind: "UNIT" })).statusCode).toBe(400);
    const committeeIssuer = created.json().id as string;
    await grant("clerk", committeeIssuer);
    const draft = await take("clerk", { issuerId: committeeIssuer });
    expect(draft.json().code).toBe("LETTER_ISSUER_INACTIVE");
    await client.query(
      `UPDATE committees SET status = 'ACTIVE', decree_mode = 'EXTERNAL', external_decree_number = 'EXT-1',
              external_decree_date = $2::date, activated_at = now() WHERE id = $1`,
      [committeeId, today],
    );
    expect((await take("clerk", { issuerId: committeeIssuer })).statusCode).toBe(201);
  });

  it("DOC-003-M: revoking a grant stops new numbers but keeps the employee's own history", async () => {
    const granted = await grant("clerk");
    const taken = (await take("clerk")).json() as { id: string };
    actAs("hc", HC);
    expect((await call("POST", `/admin/letters/grants/${granted.id}/revoke`, { reason: "Pindah tugas" })).statusCode).toBe(200);
    expect((await call("POST", `/admin/letters/grants/${granted.id}/revoke`, { reason: "Pindah tugas" })).json().code)
      .toBe("LETTER_GRANT_NOT_REVOCABLE");
    expect((await take("clerk")).json().code).toBe("LETTER_GRANT_REQUIRED");
    actAs("clerk");
    const mine = await call("GET", "/letters/me/numbers");
    expect(mine.json().items.map((row: { id: string }) => row.id)).toEqual([taken.id]);
    // A second active grant for the same pair is refused; after revocation a new one is allowed.
    await grant("clerk");
    actAs("hc", HC);
    const duplicate = await call("POST", "/admin/letters/grants", {
      employeeId: people.clerk.employeeId, issuerId, reason: "Sekretaris unit",
    });
    expect(duplicate.json().code).toBe("LETTER_GRANT_EXISTS");
    const grants = await call("GET", `/admin/letters/grants?issuerCode=${issuerCode}&active=false`);
    expect(grants.json().pagination.total).toBe(1);
  });

  it("review fixes: empty HCIS view, locked reset period, removed employee, character lengths, real changes only", async () => {
    await grant("clerk");
    expect((await take("clerk")).statusCode).toBe(201);
    actAs("hc", HC);
    // An HCIS-only view filtered by a book issuer or type is empty, not an error.
    const empty = await call("GET", `/admin/letters/register?source=HCIS&typeCode=UND`);
    expect(empty.statusCode, empty.body).toBe(200);
    expect(empty.json()).toMatchObject({ items: [], pagination: { total: 0 } });
    const emptyExport = await call("GET", `/admin/letters/register/export?source=HCIS&issuerCode=${issuerCode}`);
    expect(emptyExport.statusCode, emptyExport.body).toBe(200);
    expect(stripBom(emptyExport.body).trim().split(CRLF)).toHaveLength(1);

    // D-04: a type with numbers keeps its reset period; one without numbers may change it.
    const locked = await call("PATCH", "/admin/letters/types/UND", { resetPeriod: "MONTHLY" });
    expect(locked.json().code).toBe("LETTER_TYPE_IN_USE");
    expect((await call("PATCH", "/admin/letters/types/UND", { label: "Undangan Rapat" })).statusCode).toBe(200);
    await client.query("INSERT INTO letter_types (code, label) VALUES ('BARU', 'Belum Dipakai')");
    expect((await call("PATCH", "/admin/letters/types/BARU", { resetPeriod: "MONTHLY" })).statusCode).toBe(200);
    expect((await call("PATCH", "/admin/letters/types/BARU", {})).statusCode).toBe(400);
    expect((await call("PATCH", `/admin/letters/issuers/${issuerId}`, {})).statusCode).toBe(400);

    // A collision with an older number is a 409, and nothing is taken.
    await client.query(
      `INSERT INTO letter_numbers (id, issuer_id, type_code, period_key, sequence, letter_number, letter_date, subject, recipient,
         requested_by_employee_id, requested_by_account_id)
       VALUES ($1,$2,'UND','1999',2,$3,$4::date,'Nomor lama','Arsip',$5,$6)`,
      [randomUUID(), issuerId, (await take("clerk")).json().letterNumber.replace(".002/", ".003/"), today,
        people.clerk.employeeId, people.clerk.accountId],
    );
    const collision = await take("clerk");
    expect(collision.statusCode, collision.body).toBe(409);
    expect(collision.json().code).toBe("LETTER_NUMBER_CONFLICT");

    // Lengths count characters, as the database does: two emoji are two characters, not four.
    expect((await take("clerk", { subject: "😀😀" })).statusCode).toBe(400);

    // Only changed fields are audited; an unchanged edit writes nothing.
    const mine = (await take("clerk", { typeCode: "PEM" })).json() as { id: string; subject: string };
    const before = await audit("letter.updated");
    actAs("clerk");
    expect((await call("PATCH", `/letters/me/numbers/${mine.id}`, { subject: mine.subject, version: 1 })).json().version).toBe(1);
    expect(await audit("letter.updated")).toBe(before);
    expect((await call("PATCH", `/letters/me/numbers/${mine.id}`, { recipient: "Kepala sekolah", subject: mine.subject, version: 1 })).statusCode).toBe(200);
    const fields = await client.query<{ metadata: { fields: string[] } }>(
      "SELECT metadata FROM letter_audit_events WHERE event_type = 'letter.updated' AND letter_number_id = $1", [mine.id],
    );
    expect(fields.rows.map((row) => row.metadata.fields)).toEqual([["recipient"]]);

    // A removed employee takes no number even with a grant (D-07).
    await client.query("UPDATE employees SET removed_at = now(), removal_reason = 'Data ganda' WHERE id = $1", [people.clerk.employeeId]);
    expect((await take("clerk")).json().code).toBe("EMPLOYEE_LINK_REQUIRED");

    // Exact code lookup works for any issuer code.
    actAs("hc", HC_READ);
    expect((await call("GET", `/admin/letters/issuers?code=${issuerCode}`)).json().items.map((row: { id: string }) => row.id)).toEqual([issuerId]);
  });

  it("settings need documents.manage; documents.read only reads", async () => {
    actAs("hc", HC_READ);
    expect((await call("GET", "/admin/letters/types")).statusCode).toBe(200);
    expect((await call("GET", `/admin/letters/issuers?q=${issuerCode}`)).json().pagination.total).toBe(1);
    expect((await call("POST", "/admin/letters/types", { code: "ZZ", label: "Uji" })).statusCode).toBe(403);
    expect((await call("GET", "/admin/letters/employee-options?q=Pegawai")).statusCode).toBe(403);
    actAs("hc", HC);
    expect((await call("POST", "/admin/letters/types", { code: "ZZ", label: "Uji", resetPeriod: "MONTHLY" })).statusCode).toBe(201);
    expect((await call("POST", "/admin/letters/types", { code: "ZZ", label: "Uji" })).json().code).toBe("LETTER_TYPE_CODE_TAKEN");
    expect((await call("POST", "/admin/letters/types", { code: "1Z", label: "Diawali angka" })).statusCode).toBe(400);
    expect((await call("PATCH", "/admin/letters/types/ZZ", { active: false })).statusCode).toBe(200);
    expect((await call("PATCH", `/admin/letters/issuers/${issuerId}`, { name: "Unit Uji Baru" })).statusCode).toBe(200);
    const options = await call("GET", "/admin/letters/employee-options?q=Pegawai%20clerk");
    expect(options.json().items.length).toBeGreaterThanOrEqual(1);
    expect(await audit("letter.type.created")).toBe(1);
    expect(await audit("letter.issuer.updated")).toBe(1);
  });
});

/** DOC-003-C needs two real connections, so this suite commits its rows and deletes them. */
describe.skipIf(!allowed)("DOC-003-C concurrent allocation", () => {
  let pool: Pool;
  let app: ReturnType<typeof Fastify>;
  const employeeId = randomUUID();
  const accountId = randomUUID();
  const issuerId = randomUUID();
  const grantId = randomUUID();
  const code = `C${randomUUID().slice(0, 6).toUpperCase()}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl!, max: 6 });
    await pool.query(
      `INSERT INTO employees(id, employee_number, full_name, status, started_on) VALUES ($1,$2,'Nomor Konkuren','active','2020-01-06')`,
      [employeeId, `LTR-C-${employeeId.slice(0, 8)}`],
    );
    await pool.query(
      "INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1,$2,$3,'EMPLOYEE','active')",
      [accountId, employeeId, `ltr-c-${accountId}@example.invalid`],
    );
    await pool.query("INSERT INTO letter_issuers (id, code, name, kind) VALUES ($1,$2,'Konkuren','OTHER')", [issuerId, code]);
    await pool.query(
      `INSERT INTO letter_number_grants (id, employee_id, issuer_id, reason, granted_by_account_id) VALUES ($1,$2,$3,'Uji konkuren',$4)`,
      [grantId, employeeId, issuerId, accountId],
    );
    app = Fastify({ logger: false });
    await registerLetterRoutes(app, pool, config, {
      getSession: async () => ({
        principal: { id: accountId, email: "ltr-c@example.invalid", principalType: "EMPLOYEE" },
        expiresAt: "2099-01-01T00:00:00Z",
      }),
      getAuthorizationContext: async () => ({ organizationPermissions: [] }),
    } as never);
  });

  afterAll(async () => {
    try {
      await app?.close();
      if (pool) {
        await pool.query("DELETE FROM letter_audit_events WHERE issuer_id = $1", [issuerId]);
        await pool.query("DELETE FROM letter_numbers WHERE issuer_id = $1", [issuerId]);
        await pool.query("DELETE FROM letter_number_counters WHERE issuer_id = $1", [issuerId]);
        await pool.query("DELETE FROM letter_number_grants WHERE id = $1", [grantId]);
        await pool.query("DELETE FROM letter_issuers WHERE id = $1", [issuerId]);
        await pool.query("DELETE FROM accounts WHERE id = $1", [accountId]);
        await pool.query("DELETE FROM employees WHERE id = $1", [employeeId]);
      }
    } finally {
      await pool?.end();
    }
  });

  it("gives five simultaneous allocations five consecutive numbers with no gap and no duplicate", async () => {
    const responses = await Promise.all(Array.from({ length: 5 }, (_, index) => app.inject({
      method: "POST",
      url: "/letters/me/numbers",
      payload: { issuerId, typeCode: "UND", subject: `Undangan paralel ${index}`, recipient: "Wali santri" },
    })));
    for (const response of responses) expect(response.statusCode, response.body).toBe(201);
    const sequences = responses.map((response) => response.json().sequence as number).sort((a, b) => a - b);
    expect(sequences).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(responses.map((response) => response.json().letterNumber)).size).toBe(5);
  });
});
