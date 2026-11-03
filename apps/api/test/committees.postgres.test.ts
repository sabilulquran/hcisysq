// ORG-012 Package 1 acceptance against a real schema.
// Synthetic accounts only; every test runs inside one rolled-back transaction.

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import { registerCommitteeRoutes } from "../src/modules/committees/routes.js";
import { registerDocumentRoutes } from "../src/modules/documents/routes.js";
import { jakartaDate } from "../src/modules/documents/service.js";

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

type Who = "hc" | "chair" | "secretary" | "member" | "outsider";

describe.skipIf(!allowed)("ORG-012 committees", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let principal: AuthPrincipal;
  let permissions: string[];
  const people = {} as Record<Who, { employeeId: string; accountId: string }>;
  const HC = ["committees.read", "committees.manage"];
  const today = jakartaDate(new Date());
  const year = Number(today.slice(0, 4));

  async function insertEmployee(name: string, structural: string | null = null, status = "active") {
    const id = randomUUID();
    await client.query(
      `INSERT INTO employees(id, employee_number, full_name, status, structural_position, started_on, phone)
       VALUES ($1,$2,$3,$4,$5,'2020-01-06','081200000000')`,
      [id, `PAN-${id.slice(0, 8)}`, name, status, structural],
    );
    return id;
  }

  function actAs(who: Who, granted: string[] = []) {
    principal = { id: people[who].accountId, email: `${who}@example.invalid`, principalType: "EMPLOYEE" };
    permissions = granted;
  }

  async function call(method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) {
    return app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) });
  }

  async function createCommittee(overrides: Record<string, unknown> = {}) {
    actAs("hc", HC);
    const response = await call("POST", "/admin/committees", {
      name: "Panitia Wisuda Tahfizh", category: "GRADUATION", organizer: "SMP Sabilul Qur'an",
      startOn: today, endOn: `${year}-12-31`, ...overrides,
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string; version: number };
  }

  async function version(id: string) {
    return (await client.query<{ version: number }>("SELECT version FROM committees WHERE id = $1", [id])).rows[0]!.version;
  }

  async function addMember(id: string, who: Who, role: string, section?: string) {
    actAs("hc", HC);
    const response = await call("POST", `/admin/committees/${id}/members`, {
      employeeId: people[who].employeeId, role, section, version: await version(id),
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string };
  }

  // D-09: the Direktur is the signer that needs no structure; the Ketua Yayasan has its own test.
  async function activate(id: string, decree: Record<string, unknown> = { mode: "ISSUE", signer: "DIRECTOR" }) {
    actAs("hc", HC);
    return call("POST", `/admin/committees/${id}/activate`, { version: await version(id), decree });
  }

  async function staffed() {
    const committee = await createCommittee();
    const chair = await addMember(committee.id, "chair", "CHAIR");
    const secretary = await addMember(committee.id, "secretary", "SECRETARY");
    const member = await addMember(committee.id, "member", "SECTION_COORDINATOR", "Seksi Acara");
    return { id: committee.id, chair: chair.id, secretary: secretary.id, member: member.id };
  }

  async function counter() {
    const result = await client.query<{ lastSequence: number }>(
      "SELECT last_sequence AS \"lastSequence\" FROM hr_document_number_counters WHERE number_code = 'SKP' AND number_year = $1",
      [year],
    );
    return result.rows[0]?.lastSequence ?? 0;
  }

  async function auditCount(id: string) {
    return (await client.query<{ total: number }>(
      "SELECT count(*)::int AS total FROM committee_audit_events WHERE committee_id = $1", [id],
    )).rows[0]!.total;
  }

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    for (const who of ["hc", "chair", "secretary", "member", "outsider"] as const) {
      const employeeId = await insertEmployee(`Pegawai ${who}`);
      const accountId = randomUUID();
      await client.query(
        "INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1,$2,$3,'EMPLOYEE','active')",
        [accountId, employeeId, `pan-${who}-${accountId}@example.invalid`],
      );
      people[who] = { employeeId, accountId };
    }
    actAs("hc", HC);
    const config = { NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8 } as ApiConfig;
    const auth = {
      getSession: async () => ({ principal, expiresAt: "2099-01-01T00:00:00Z" }),
      getAuthorizationContext: async () => ({ organizationPermissions: permissions }),
    } as never;
    app = Fastify({ logger: false });
    await registerCommitteeRoutes(app, savepointPool(client), config, auth);
    await registerDocumentRoutes(app, savepointPool(client), config, auth);
  });

  afterEach(async () => {
    try { await app?.close(); } finally {
      if (client) { await client.query("ROLLBACK"); client.release(); }
    }
  });

  it("ORG-012-B/C: activation needs a complete line-up, a missing signer takes no number, and the decree is numbered SKP", async () => {
    const committee = await createCommittee();
    await addMember(committee.id, "chair", "CHAIR");
    const before = await counter();
    const notReady = await activate(committee.id);
    expect(notReady.statusCode).toBe(409);
    expect(notReady.json()).toMatchObject({ code: "COMMITTEE_NOT_READY" });
    expect(notReady.json().problems).toHaveLength(1);

    await addMember(committee.id, "secretary", "SECRETARY");
    // No Ketua Yayasan and no Direktur in this schema yet.
    for (const signer of ["FOUNDATION_CHAIR", "DIRECTOR"]) {
      const unsigned = await activate(committee.id, { mode: "ISSUE", signer });
      expect(unsigned.statusCode, unsigned.body).toBe(409);
      expect(unsigned.json().code).toBe("DOCUMENT_SIGNER_UNAVAILABLE");
    }
    // D-09: the Kepala HCM is copied, no longer a signer or a fallback.
    await insertEmployee("Kepala HCM Sintetis", "Kepala Human Capital Management");
    expect((await activate(committee.id)).json().code).toBe("DOCUMENT_SIGNER_UNAVAILABLE");
    expect(await counter()).toBe(before);
    expect((await client.query("SELECT status FROM committees WHERE id = $1", [committee.id])).rows[0].status).toBe("DRAFT");

    await insertEmployee("Direktur Sintetis", "Direktur");
    const issued = await activate(committee.id);
    expect(issued.statusCode, issued.body).toBe(200);
    expect(issued.json().decreeNumber).toMatch(/^\d{3}\/SKP\/YSQ\/[IVX]+\/\d{4}$/);
    expect(await counter()).toBe(before + 1);
    const register = await client.query(
      `SELECT document.document_kind, document.employee_id, document.status, document.content_snapshot
         FROM committees committee JOIN hr_issued_documents document ON document.id = committee.issued_document_id
        WHERE committee.id = $1`,
      [committee.id],
    );
    expect(register.rows[0]).toMatchObject({ document_kind: "COMMITTEE", employee_id: people.chair.employeeId, status: "ISSUED" });
    expect(register.rows[0].content_snapshot.carbonCopies).toEqual(["Kepala Human Capital Management"]);
    // §5.4: the snapshot carries names, units and roles only.
    expect(Object.keys(register.rows[0].content_snapshot.members[0]).sort()).toEqual(["fullName", "role", "section", "unitName"]);

    // A second committee gets the next number.
    const second = await createCommittee({ name: "Panitia Ujian Akhir" });
    await addMember(second.id, "secretary", "CHAIR");
    await addMember(second.id, "member", "MEMBER");
    const next = await activate(second.id);
    expect(next.statusCode, next.body).toBe(200);
    expect(next.json().decreeNumber).not.toBe(issued.json().decreeNumber);

    // D-17: everyone on the activated committee is told.
    const notified = await client.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM in_app_notifications WHERE event_key = $1`,
      [`committee.${committee.id}.activated`],
    );
    expect(notified.rows[0]!.total).toBe(2);
  });

  it("ORG-012-C: an external decree is recorded without touching the register; locked fields stay locked", async () => {
    const committee = await staffed();
    const before = await counter();
    const response = await activate(committee.id, { mode: "EXTERNAL", number: "045/SK-KS/SMP/X/2026", date: today });
    expect(response.statusCode, response.body).toBe(200);
    expect(await counter()).toBe(before);
    const row = (await client.query("SELECT decree_mode, issued_document_id FROM committees WHERE id = $1", [committee.id])).rows[0];
    expect(row).toEqual({ decree_mode: "EXTERNAL", issued_document_id: null });

    actAs("hc", HC);
    const base = { name: "Panitia Wisuda Tahfizh", category: "GRADUATION", organizer: "SMP Sabilul Qur'an", startOn: today };
    const renamed = await call("PATCH", `/admin/committees/${committee.id}`, {
      ...base, name: "Panitia Wisuda Akbar", endOn: `${year}-12-31`, version: await version(committee.id),
    });
    expect(renamed.statusCode).toBe(409);
    expect(renamed.json()).toMatchObject({ code: "COMMITTEE_FIELD_LOCKED", fields: ["name"] });
    // D-10: the end date may still move.
    const shortened = await call("PATCH", `/admin/committees/${committee.id}`, {
      ...base, endOn: today, version: await version(committee.id),
    });
    expect(shortened.statusCode, shortened.body).toBe(200);
  });

  it("ORG-012-E/H: one chair; a new chair demotes the old one; a decreed committee keeps a chair", async () => {
    const committee = await staffed();
    const audits = await auditCount(committee.id);
    actAs("hc", HC);
    const transfer = await call("PATCH", `/admin/committees/${committee.id}/members/${committee.secretary}`, {
      role: "CHAIR", version: await version(committee.id),
    });
    expect(transfer.statusCode, transfer.body).toBe(200);
    const roles = await client.query<{ id: string; role: string }>(
      "SELECT id, role FROM committee_members WHERE committee_id = $1 AND left_on IS NULL", [committee.id],
    );
    const byId = Object.fromEntries(roles.rows.map((row) => [row.id, row.role]));
    expect(byId[committee.secretary]).toBe("CHAIR");
    expect(byId[committee.chair]).toBe("MEMBER");
    // Transfer writes two events: the demotion and the promotion.
    expect(await auditCount(committee.id)).toBe(audits + 2);

    // Adding a member as CHAIR also transfers.
    const outsider = await addMember(committee.id, "outsider", "CHAIR");
    const chairs = await client.query<{ id: string }>(
      "SELECT id FROM committee_members WHERE committee_id = $1 AND role = 'CHAIR' AND left_on IS NULL", [committee.id],
    );
    expect(chairs.rows.map((row) => row.id)).toEqual([outsider.id]);

    await insertEmployee("Direktur Sintetis", "Direktur");
    expect((await activate(committee.id)).statusCode).toBe(200);
    // D-17: after activation, the chair a transfer demotes is told.
    const newChair = await addMember(committee.id, "hc", "CHAIR");
    const told = await client.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM in_app_notifications WHERE recipient_account_id = $1 AND event_key LIKE $2`,
      [people.outsider.accountId, `committee.${committee.id}.member.${outsider.id}.demoted.%`],
    );
    expect(told.rows[0]!.total).toBe(1);
    actAs("hc", HC);
    const demote = await call("PATCH", `/admin/committees/${committee.id}/members/${newChair.id}`, {
      role: "MEMBER", version: await version(committee.id),
    });
    expect(demote.json().code).toBe("COMMITTEE_CHAIR_REQUIRED");
    const end = await call("POST", `/admin/committees/${committee.id}/members/${newChair.id}/end`, { version: await version(committee.id) });
    expect(end.json().code).toBe("COMMITTEE_CHAIR_REQUIRED");
  });

  it("ORG-012-K: writes carry the version they read; duplicates and inactive employees are refused", async () => {
    const committee = await staffed();
    actAs("hc", HC);
    const stale = await call("POST", `/admin/committees/${committee.id}/members`, {
      employeeId: people.outsider.employeeId, role: "MEMBER", version: 1,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("COMMITTEE_STALE");
    const duplicate = await call("POST", `/admin/committees/${committee.id}/members`, {
      employeeId: people.member.employeeId, role: "MEMBER", version: await version(committee.id),
    });
    expect(duplicate.json().code).toBe("COMMITTEE_DUPLICATE_MEMBER");
    const resigned = await insertEmployee("Pegawai Keluar", null, "resigned");
    const inactive = await call("POST", `/admin/committees/${committee.id}/members`, {
      employeeId: resigned, role: "MEMBER", version: await version(committee.id),
    });
    expect(inactive.json().code).toBe("COMMITTEE_EMPLOYEE_NOT_ACTIVE");
  });

  it("ORG-012-F/J: members see activated committees only; others get 404; meeting groups exclude the caller", async () => {
    const committee = await staffed();
    actAs("member");
    expect((await call("GET", `/me/committees/${committee.id}`)).statusCode).toBe(404);
    expect((await call("GET", "/me/committees")).json().items).toEqual([]);
    expect((await call("GET", "/me/committees/meeting-groups")).json().items).toEqual([]);

    await activate(committee.id, { mode: "EXTERNAL", number: "045/SK-KS/SMP/X/2026", date: today });
    actAs("member");
    const list = (await call("GET", "/me/committees?scope=current")).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id: committee.id, role: "SECTION_COORDINATOR", section: "Seksi Acara", decreeNumber: "045/SK-KS/SMP/X/2026" });
    const detail = (await call("GET", `/me/committees/${committee.id}`)).json();
    expect(detail.members).toHaveLength(3);
    // D-15: no employee numbers of other members.
    expect(detail.members[0].employeeNumber).toBeUndefined();
    expect(detail.members[0].endReason).toBeUndefined();
    expect(detail.myMemberIds).toEqual([committee.member]);

    const groups = (await call("GET", "/me/committees/meeting-groups")).json();
    expect(groups.items).toHaveLength(1);
    expect(groups.items[0].members.map((member: { id: string }) => member.id).sort())
      .toEqual([people.chair.employeeId, people.secretary.employeeId].sort());
    expect(groups.items[0].members[0]).toMatchObject({ hasAccount: true, hasWhatsApp: true });

    actAs("outsider");
    expect((await call("GET", `/me/committees/${committee.id}`)).statusCode).toBe(404);

    // An ended member keeps the committee in history and leaves the meeting group.
    actAs("hc", HC);
    const end = await call("POST", `/admin/committees/${committee.id}/members/${committee.member}/end`, {
      version: await version(committee.id), reason: "Pindah tugas ke unit lain",
    });
    expect(end.statusCode, end.body).toBe(200);
    actAs("member");
    expect((await call("GET", "/me/committees?scope=current")).json().items).toEqual([]);
    expect((await call("GET", "/me/committees?scope=history")).json().items).toHaveLength(1);
    expect((await call("GET", "/me/committees/meeting-groups")).json().items).toEqual([]);
    // D-15: another member never reads why someone's duty ended; HC does.
    actAs("chair");
    const seen = (await call("GET", `/me/committees/${committee.id}`)).json();
    expect(seen.members.find((member: { id: string }) => member.id === committee.member).endReason).toBeUndefined();
    actAs("hc", ["committees.read"]);
    const hc = (await call("GET", `/admin/committees/${committee.id}`)).json();
    expect(hc.members.find((member: { id: string }) => member.id === committee.member).endReason).toBe("Pindah tugas ke unit lain");
  });

  it("D-04/D-11: a member added late to a past committee joins inside its period and counts in its year", async () => {
    const past = await createCommittee({ name: "Panitia Ujian Lalu", category: "EXAM", startOn: `${year - 1}-03-01`, endOn: `${year - 1}-03-10` });
    await addMember(past.id, "chair", "CHAIR");
    await addMember(past.id, "secretary", "MEMBER");
    expect((await activate(past.id, { mode: "EXTERNAL", number: "007/SK/UJIAN/III/LALU", date: `${year - 1}-02-25` })).statusCode).toBe(200);
    await addMember(past.id, "outsider", "MEMBER");
    const joined = await client.query<{ joinedOn: string }>(
      `SELECT to_char(joined_on, 'YYYY-MM-DD') AS "joinedOn" FROM committee_members WHERE committee_id = $1 AND employee_id = $2`,
      [past.id, people.outsider.employeeId],
    );
    expect(joined.rows[0]!.joinedOn).toBe(`${year - 1}-03-10`);
    actAs("hc", HC);
    expect((await call("POST", `/admin/committees/${past.id}/complete`, { version: await version(past.id) })).statusCode).toBe(200);
    const recap = (await call("GET", `/admin/committees/participation?year=${year - 1}&q=outsider`)).json();
    expect(recap.items.map((row: { employeeId: string }) => row.employeeId)).toEqual([people.outsider.employeeId]);
  });

  it("ORG-012-D: cancelling a decreed committee revokes its decree and closes every membership", async () => {
    const committee = await staffed();
    await insertEmployee("Direktur Sintetis", "Direktur");
    expect((await activate(committee.id)).statusCode).toBe(200);
    // D-12: the DOC-001 register cannot revoke a committee decree on its own.
    const documentId = (await client.query("SELECT issued_document_id FROM committees WHERE id = $1", [committee.id])).rows[0].issued_document_id;
    actAs("hc", ["documents.correct"]);
    const direct = await call("POST", `/admin/documents/issued/${documentId}/revoke`, { reason: "Dicoba dibatalkan lewat register." });
    expect(direct.statusCode).toBe(409);
    expect(direct.json().code).toBe("DOCUMENT_NOT_REVOCABLE");
    actAs("hc", HC);
    const cancelled = await call("POST", `/admin/committees/${committee.id}/cancel`, {
      version: await version(committee.id), reason: "Kegiatan ditiadakan oleh yayasan.",
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const document = await client.query(
      `SELECT document.status, document.revoke_reason FROM committees committee
         JOIN hr_issued_documents document ON document.id = committee.issued_document_id WHERE committee.id = $1`,
      [committee.id],
    );
    expect(document.rows[0]).toEqual({ status: "REVOKED", revoke_reason: "Kegiatan ditiadakan oleh yayasan." });
    const open = await client.query("SELECT 1 FROM committee_members WHERE committee_id = $1 AND left_on IS NULL", [committee.id]);
    expect(open.rowCount).toBe(0);
    const events = await client.query<{ event_type: string }>(
      "SELECT event_type FROM hr_document_audit_events WHERE metadata->>'committeeId' = $1 ORDER BY occurred_at, event_type",
      [committee.id],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual(["doc.issued", "doc.revoked"]);
    // Final: nothing more can be written.
    const again = await call("POST", `/admin/committees/${committee.id}/complete`, { version: await version(committee.id) });
    expect(again.json().code).toBe("COMMITTEE_CLOSED");
    // Members still see it, labelled cancelled, in their history.
    actAs("chair");
    const history = (await call("GET", "/me/committees?scope=history")).json();
    expect(history.items[0]).toMatchObject({ id: committee.id, status: "CANCELLED" });
  });

  it("ORG-012-I: the recap counts active and completed committees of the year only", async () => {
    await insertEmployee("Direktur Sintetis", "Direktur");
    const done = await staffed();
    expect((await activate(done.id)).statusCode).toBe(200);
    actAs("hc", HC);
    expect((await call("POST", `/admin/committees/${done.id}/complete`, { version: await version(done.id) })).statusCode).toBe(200);

    const running = await createCommittee({ name: "Panitia Ramadhan", category: "RAMADAN" });
    await addMember(running.id, "chair", "CHAIR");
    await addMember(running.id, "outsider", "MEMBER");
    expect((await activate(running.id)).statusCode).toBe(200);

    const cancelled = await createCommittee({ name: "Panitia Batal" });
    await addMember(cancelled.id, "chair", "CHAIR");
    await addMember(cancelled.id, "member", "MEMBER");
    expect((await activate(cancelled.id)).statusCode).toBe(200);
    actAs("hc", HC);
    await call("POST", `/admin/committees/${cancelled.id}/cancel`, { version: await version(cancelled.id), reason: "Kegiatan ditiadakan oleh yayasan." });

    const draft = await createCommittee({ name: "Panitia Draf" });
    await addMember(draft.id, "chair", "CHAIR");

    actAs("hc", ["committees.read"]);
    const recap = (await call("GET", `/admin/committees/participation?year=${year}&q=Pegawai`)).json();
    const chairRow = recap.items.find((row: { employeeId: string }) => row.employeeId === people.chair.employeeId);
    expect(chairRow).toMatchObject({ total: 2, asChair: 2, asCore: 2, ongoing: 1 });
    const memberRow = recap.items.find((row: { employeeId: string }) => row.employeeId === people.member.employeeId);
    expect(memberRow).toMatchObject({ total: 1, asChair: 0, ongoing: 0 });
    expect(recap.pagination.total).toBe(recap.items.length);
    expect((await call("GET", `/admin/committees/participation?year=${year - 3}&q=Pegawai`)).json().items).toEqual([]);

    // The per-employee detail lists the cancelled committee too, flagged, but never the draft.
    const detail = (await call("GET", `/admin/committees/participation/${people.chair.employeeId}?year=${year}`)).json();
    expect(detail.items.map((row: { status: string }) => row.status).sort()).toEqual(["ACTIVE", "CANCELLED", "COMPLETED"]);

    const list = (await call("GET", `/admin/committees?year=${year}&q=Panitia&pageSize=2`)).json();
    expect(list.items).toHaveLength(2);
    expect(list.pagination.total).toBeGreaterThanOrEqual(4);
    expect(list.items[0].status).toBe("DRAFT");
  });

  it("ORG-012-G: the whole lifecycle never writes to structure, employment or approval tables", async () => {
    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          AND (table_name LIKE 'organization\\_%' OR table_name LIKE 'employment\\_%' OR table_name LIKE '%approval%'
               OR table_name IN ('organizational_units', 'positions', 'employees'))`,
    );
    const snapshot = async () => {
      const counts: Record<string, number> = {};
      for (const { table_name: table } of tables.rows) {
        counts[table] = (await client.query<{ total: number }>(`SELECT count(*)::int AS total FROM "${table}"`)).rows[0]!.total;
      }
      return counts;
    };
    await insertEmployee("Direktur Sintetis", "Direktur");
    const before = await snapshot();
    const committee = await staffed();
    expect((await activate(committee.id)).statusCode).toBe(200);
    actAs("hc", HC);
    await call("POST", `/admin/committees/${committee.id}/members/${committee.member}/end`, { version: await version(committee.id) });
    await call("POST", `/admin/committees/${committee.id}/complete`, { version: await version(committee.id) });
    expect(await snapshot()).toEqual(before);
    expect(tables.rows.length).toBeGreaterThan(5);
  });

  /** D-09: the Ketua Yayasan seat as production holds it, "Ketua" in Dewan Pengurus held by an
   * Organ Yayasan account (ORG-013), in a structure published today. */
  async function seatFoundationChair(holder: { accountId?: string; employeeId?: string }) {
    const changeSetId = randomUUID();
    const nodeKey = randomUUID();
    await client.query(
      `INSERT INTO organization_change_sets (id, name, effective_on, status, created_by_account_id, validated_at, published_at)
       VALUES ($1,'Struktur sintetis ORG-012',current_date,'PUBLISHED',$2, now(), now())`,
      [changeSetId, people.hc.accountId],
    );
    await client.query(
      `INSERT INTO organization_nodes (id, change_set_id, stable_key, name, node_type, effective_from)
       VALUES ($1,$2,$3,'Dewan Pengurus','BOARD',current_date - 30)`,
      [randomUUID(), changeSetId, nodeKey],
    );
    const positionKey = randomUUID();
    await client.query(
      `INSERT INTO organization_positions (id, change_set_id, stable_key, node_key, title, holder_source, effective_from)
       VALUES ($1,$2,$3,$4,'Ketua',$5,current_date - 30)`,
      [randomUUID(), changeSetId, positionKey, nodeKey, holder.accountId ? "ACCOUNT" : "EMPLOYEE"],
    );
    await client.query(
      `INSERT INTO organization_incumbencies (id, change_set_id, position_key, employee_id, account_id, kind, effective_from)
       VALUES ($1,$2,$3,$4,$5,'PRIMARY',current_date - 30)`,
      [randomUUID(), changeSetId, positionKey, holder.employeeId ?? null, holder.accountId ?? null],
    );
  }

  it("D-09: Ketua Yayasan by default, Direktur by choice, Kepala HCM in Tembusan; an earlier SK keeps its signer", async () => {
    // An SK issued before the rule: signed by the Kepala HCM, no Tembusan in its snapshot.
    await insertEmployee("Direktur Sintetis", "Direktur");
    const earlier = await staffed();
    expect((await activate(earlier.id)).statusCode).toBe(200);
    await client.query(
      `UPDATE hr_issued_documents
          SET signer = '{"title":"Kepala Human Capital Management","name":"Kepala HCM Lama"}'::jsonb,
              content_snapshot = content_snapshot - 'carbonCopies'
        WHERE id = (SELECT issued_document_id FROM committees WHERE id = $1)`,
      [earlier.id],
    );

    const boardAccount = randomUUID();
    await client.query(
      "INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1,NULL,$2,'FOUNDATION_BOARD','active')",
      [boardAccount, `ketua-${boardAccount}@example.invalid`],
    );
    await seatFoundationChair({ accountId: boardAccount });

    const committee = await createCommittee({ name: "Panitia Ramadhan" });
    await addMember(committee.id, "chair", "CHAIR");
    await addMember(committee.id, "member", "MEMBER");
    actAs("hc", HC);
    const draft = (await call("GET", `/admin/committees/${committee.id}`)).json();
    expect(draft.decreeSignerOptions).toEqual([
      { signer: "FOUNDATION_CHAIR", title: "Ketua Yayasan", available: true, name: null, nameRequired: true },
      { signer: "DIRECTOR", title: "Direktur", available: true, name: "Direktur Sintetis", nameRequired: false },
    ]);

    // The account has no name in HCIS, so HC types it; without it nothing is numbered.
    const before = await counter();
    const nameless = await activate(committee.id, { mode: "ISSUE" });
    expect(nameless.statusCode, nameless.body).toBe(400);
    expect(nameless.json().code).toBe("INVALID_COMMITTEE");
    expect(await counter()).toBe(before);

    const issued = await activate(committee.id, { mode: "ISSUE", signerName: "  Ketua Yayasan Sintetis " });
    expect(issued.statusCode, issued.body).toBe(200);
    const detail = (await call("GET", `/admin/committees/${committee.id}`)).json();
    expect(detail.decreeSigner).toEqual({ title: "Ketua Yayasan", name: "Ketua Yayasan Sintetis" });
    expect(detail.decreeSnapshot.carbonCopies).toEqual(["Kepala Human Capital Management"]);
    expect(detail.decreeSignerOptions).toBeNull();
    const audit = await client.query(
      "SELECT metadata FROM committee_audit_events WHERE committee_id = $1 AND event_type = 'committee.activated'",
      [committee.id],
    );
    expect(audit.rows[0].metadata).toMatchObject({ signerTitle: "Ketua Yayasan", signerName: "Ketua Yayasan Sintetis" });
    const docAudit = await client.query(
      `SELECT metadata FROM hr_document_audit_events WHERE issued_document_id = $1 AND event_type = 'doc.issued'`,
      [issued.json().issuedDocumentId],
    );
    expect(docAudit.rows[0].metadata).toMatchObject({ source: "ORG-012", signerTitle: "Ketua Yayasan" });

    // The next draft is offered the name the seat signed with last time.
    const next = await createCommittee({ name: "Panitia Ujian Akhir" });
    await addMember(next.id, "secretary", "CHAIR");
    await addMember(next.id, "member", "MEMBER");
    actAs("hc", HC);
    expect((await call("GET", `/admin/committees/${next.id}`)).json().decreeSignerOptions[0])
      .toMatchObject({ signer: "FOUNDATION_CHAIR", name: "Ketua Yayasan Sintetis", nameRequired: true });

    // The earlier SK is a snapshot: still the Kepala HCM, still without Tembusan.
    const old = (await call("GET", `/admin/committees/${earlier.id}`)).json();
    expect(old.decreeSigner).toEqual({ title: "Kepala Human Capital Management", name: "Kepala HCM Lama" });
    expect(old.decreeSnapshot.carbonCopies).toBeUndefined();
  });

  it("D-09: an employee holding the seat signs under their own name and never signs as the committee chair", async () => {
    await seatFoundationChair({ employeeId: people.chair.employeeId });
    const committee = await staffed();
    actAs("hc", HC);
    const options = (await call("GET", `/admin/committees/${committee.id}`)).json().decreeSignerOptions;
    expect(options[0]).toMatchObject({ signer: "FOUNDATION_CHAIR", available: false, name: "Pegawai chair", nameRequired: false });
    const selfSigned = await activate(committee.id, { mode: "ISSUE", signer: "FOUNDATION_CHAIR", signerName: "Nama Lain" });
    expect(selfSigned.statusCode, selfSigned.body).toBe(409);
    expect(selfSigned.json().code).toBe("DOCUMENT_SIGNER_UNAVAILABLE");

    // Same seat, a committee chaired by someone else: the employee's own name wins over a typed one.
    const other = await createCommittee({ name: "Panitia Wisuda Kedua" });
    await addMember(other.id, "secretary", "CHAIR");
    await addMember(other.id, "member", "MEMBER");
    const issued = await activate(other.id, { mode: "ISSUE", signerName: "Nama Lain" });
    expect(issued.statusCode, issued.body).toBe(200);
    actAs("hc", HC);
    expect((await call("GET", `/admin/committees/${other.id}`)).json().decreeSigner)
      .toEqual({ title: "Ketua Yayasan", name: "Pegawai chair" });
  });

  it("history pages the audit trail newest first", async () => {
    const committee = await staffed();
    actAs("hc", ["committees.read"]);
    const page = (await call("GET", `/admin/committees/${committee.id}/history?pageSize=2`)).json();
    expect(page.pagination.total).toBe(4);
    expect(page.items).toHaveLength(2);
    expect(page.items[0].eventType).toBe("committee.member.added");
    const detail = (await call("GET", `/admin/committees/${committee.id}`)).json();
    expect(detail.members.map((member: { role: string }) => member.role)).toEqual(["CHAIR", "SECRETARY", "SECTION_COORDINATOR"]);
    expect(detail.members[0].employeeNumber).toMatch(/^PAN-/);
  });
});
