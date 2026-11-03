// HELP-001 Package 1 acceptance against a real schema.
// Synthetic accounts only; every test runs inside one rolled-back transaction.

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import { HELP_TOPICS } from "../src/modules/help/domain.js";
import { registerHelpRoutes } from "../src/modules/help/routes.js";

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

describe.skipIf(!allowed)("HELP-001 help center", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let principal: AuthPrincipal;
  let permissions: string[];
  const accounts = {} as Record<"hc" | "employee", string>;
  const HC = ["help.manage"];
  // A word no seeded article contains, so searches see only this test's rows.
  const marker = `zq${randomUUID().slice(0, 8)}`;

  function actAs(who: keyof typeof accounts, granted: string[] = []) {
    principal = { id: accounts[who], email: `${who}@example.invalid`, principalType: "EMPLOYEE" };
    permissions = granted;
  }

  async function create(overrides: Record<string, unknown> = {}) {
    actAs("hc", HC);
    const response = await app.inject({
      method: "POST",
      url: "/admin/help/articles",
      payload: {
        kind: "FAQ",
        topic: "LEAVE",
        title: `Bagaimana cara mengajukan cuti ${marker}?`,
        body: "Buka menu Cuti & Izin, pilih jenis cuti, isi tanggal, lalu kirim.",
        ...overrides,
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string; version: number };
  }

  async function publish(id: string, version: number) {
    actAs("hc", HC);
    return app.inject({ method: "POST", url: `/admin/help/articles/${id}/publish`, payload: { version } });
  }

  async function auditTypes(articleId: string) {
    const rows = await client.query<{ event_type: string }>(
      "SELECT event_type FROM help_audit_events WHERE article_id = $1 ORDER BY occurred_at, event_type",
      [articleId],
    );
    return rows.rows.map((row) => row.event_type);
  }

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    for (const key of ["hc", "employee"] as const) {
      const employeeId = randomUUID();
      await client.query(
        `INSERT INTO employees(id, employee_number, full_name, status, started_on)
         VALUES ($1,$2,$3,'active','2020-01-06')`,
        [employeeId, `HELP-${employeeId.slice(0, 8)}`, `Pegawai ${key}`],
      );
      const id = randomUUID();
      await client.query(
        `INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1,$2,$3,'EMPLOYEE','active')`,
        [id, employeeId, `help-${key}-${id}@example.invalid`],
      );
      accounts[key] = id;
    }
    actAs("employee");
    const config = { NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8 } as ApiConfig;
    const auth = {
      getSession: async () => ({ principal, expiresAt: "2099-01-01T00:00:00Z" }),
      getAuthorizationContext: async () => ({ organizationPermissions: permissions }),
    } as never;
    app = Fastify({ logger: false });
    await registerHelpRoutes(app, savepointPool(client), config, auth);
  });

  afterEach(async () => {
    try { await app?.close(); } finally {
      if (client) { await client.query("ROLLBACK"); client.release(); }
    }
  });

  it("HELP-001-F: migration 0130 loads the initial content as unreviewed SEED drafts with revision 1", async () => {
    const seeded = await client.query<{ total: number; drafts: number; revisions: number; audits: number; topics: number; guides: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'DRAFT' AND version = 1)::int AS drafts,
              (SELECT count(*)::int FROM help_article_revisions r
                 JOIN help_articles a ON a.id = r.article_id
                WHERE a.origin = 'SEED' AND r.version = 1 AND r.actor_account_id IS NULL) AS revisions,
              (SELECT count(*)::int FROM help_audit_events e
                 JOIN help_articles a ON a.id = e.article_id
                WHERE a.origin = 'SEED' AND e.event_type = 'help.article.created'
                  AND e.metadata->>'origin' = 'SEED') AS audits,
              count(DISTINCT topic)::int AS topics,
              count(*) FILTER (WHERE kind = 'GUIDE')::int AS guides
         FROM help_articles WHERE origin = 'SEED'`,
    );
    const row = seeded.rows[0]!;
    expect(row.total).toBeGreaterThan(40);
    expect(row.drafts).toBe(row.total);
    expect(row.revisions).toBe(row.total);
    expect(row.audits).toBe(row.total);
    // One guide per topic, every topic covered.
    expect(row.topics).toBe(HELP_TOPICS.length);
    expect(row.guides).toBe(HELP_TOPICS.length);

    actAs("hc", HC);
    const admin = await app.inject({ method: "GET", url: "/admin/help/articles?status=DRAFT&pageSize=5" });
    expect(admin.statusCode, admin.body).toBe(200);
    expect(admin.json().counts.unreviewedSeed).toBe(row.total);
    expect(admin.json().items).toHaveLength(5);
    expect(admin.json().pagination.total).toBeGreaterThanOrEqual(row.total);

    // A seeded draft can be edited, published and archived like any other.
    const seed = admin.json().items[0] as { id: string; version: number; kind: string; topic: string; title: string; body: string };
    const edited = await app.inject({
      method: "PUT", url: `/admin/help/articles/${seed.id}`,
      payload: { kind: seed.kind, topic: seed.topic, title: seed.title, body: `${seed.body} Ditinjau HC.`, sortOrder: 10, version: 1 },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect((await publish(seed.id, 2)).statusCode).toBe(200);
  });

  it("HELP-001 §8.1: migration 0137 corrects untouched seed drafts in place and keeps them unreviewed", async () => {
    const corrected = await client.query<{ id: string; version: number; status: string; body: string; revisionBody: string; audits: number }>(
      `SELECT a.id, a.version, a.status, a.body, r.body AS "revisionBody",
              (SELECT count(*)::int FROM help_audit_events e
                WHERE e.article_id = a.id AND e.event_type = 'help.article.seed_corrected'
                  AND e.metadata->>'migration' = '0137' AND e.reason IS NOT NULL) AS audits
         FROM help_articles a
         JOIN help_article_revisions r ON r.article_id = a.id AND r.version = 1
        WHERE a.id = ANY($1::uuid[])
        ORDER BY a.id`,
      [[
        "99431555-85a0-56fd-9546-d9d6bbc390e7", "ed9cc0bb-554b-5ea9-8368-7706e32b7984", "35baba2c-65ce-5758-8849-8f6989a58638",
        "928a0c74-0b29-5415-baf3-a60f52b3b086", "54750e5f-aacd-5103-acc2-5986ba954135", "fad4a383-21b6-58e4-9059-35126b44d2dc",
        "039578d1-10b3-5d5e-8414-2ab0ffd0ed1f",
      ]],
    );
    expect(corrected.rows).toHaveLength(7);
    for (const row of corrected.rows) {
      expect(row, row.id).toMatchObject({ version: 1, status: "DRAFT", audits: 1 });
      expect(row.revisionBody, row.id).toBe(row.body);
      // None of them still describes the closed gaps.
      expect(row.body, row.id).not.toMatch(/belum menyediakan tombol|belum ada notifikasi khusus|walaupun pilihannya sudah tampil/);
    }
    const bodies = corrected.rows.map((row) => row.body).join(" ");
    expect(bodies).toContain("Lihat & cetak");
    expect(bodies).toContain("Batalkan pengajuan");
    expect(bodies).toContain("formulir rapat tidak menampilkan pilihan WhatsApp");
  });

  it("HELP-001-A: a reader sees only published articles, in lists, counts and by id", async () => {
    const draft = await create({ title: `Draf rahasia ${marker} belum terbit` });
    const live = await create({ title: `Cara melihat saldo cuti ${marker}?` });
    expect((await publish(live.id, live.version)).statusCode).toBe(200);

    actAs("employee");
    const list = await app.inject({ method: "GET", url: `/help/articles?q=${marker}` });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items.map((item: { id: string }) => item.id)).toEqual([live.id]);
    expect(list.json().pagination.total).toBe(1);
    expect(list.json().items[0]).not.toHaveProperty("status");
    expect(list.json().items[0]).not.toHaveProperty("version");
    expect((await app.inject({ method: "GET", url: `/help/articles/${draft.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/help/articles/${live.id}` })).statusCode).toBe(200);

    const before = await client.query<{ total: number }>(
      "SELECT count(*)::int AS total FROM help_articles WHERE status = 'PUBLISHED' AND topic = 'LEAVE' AND kind = 'FAQ'",
    );
    const overview = await app.inject({ method: "GET", url: "/help/overview" });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().topics).toHaveLength(HELP_TOPICS.length);
    expect(overview.json().topics.find((topic: { topic: string }) => topic.topic === "LEAVE").faqCount).toBe(before.rows[0]!.total);
  });

  it("HELP-001-E: search needs every word, treats wildcards literally and pages with total", async () => {
    const one = await create({ title: `Lembur di hari libur ${marker}`, topic: "OVERTIME", body: "Ajukan lembur sebelum dikerjakan; atasan menyetujui." });
    const two = await create({ title: `Tukar shift ${marker}`, topic: "ATTENDANCE", body: "Diskon 100% bukan istilah HCIS, ini teks uji lembur." });
    await publish(one.id, 1);
    await publish(two.id, 1);
    actAs("employee");
    const both = await app.inject({ method: "GET", url: `/help/articles?q=${marker}%20lembur` });
    // Title hit on "lembur" ranks first.
    expect(both.json().items.map((item: { id: string }) => item.id)).toEqual([one.id, two.id]);
    const literal = await app.inject({ method: "GET", url: `/help/articles?q=${marker}%20100%25` });
    expect(literal.json().items.map((item: { id: string }) => item.id)).toEqual([two.id]);
    const wildcard = await app.inject({ method: "GET", url: `/help/articles?q=${marker}%20%25%25` });
    expect(wildcard.json().pagination.total).toBe(0);
    const filtered = await app.inject({ method: "GET", url: `/help/articles?q=${marker}&topic=OVERTIME&kind=FAQ` });
    expect(filtered.json().items.map((item: { id: string }) => item.id)).toEqual([one.id]);
    // Equal title rank, so the D-01 topic order decides: Kehadiran (two) before Lembur (one).
    const paged = await app.inject({ method: "GET", url: `/help/articles?q=${marker}&pageSize=1&page=2` });
    expect(paged.json()).toMatchObject({ items: [{ id: one.id }], pagination: { page: 2, pageSize: 1, total: 2, pageCount: 2 } });
  });

  it("HELP-001-C/D/H: revisions, audit, stale versions and transitions", async () => {
    const article = await create();
    const edit = (version: number, title: string) => app.inject({
      method: "PUT", url: `/admin/help/articles/${article.id}`,
      payload: { kind: "FAQ", topic: "LEAVE", title, body: "Isi yang sudah diperbaiki oleh HC untuk pegawai.", version, changeNote: "perbaikan" },
    });
    actAs("hc", HC);
    expect((await edit(1, `Judul kedua ${marker}`)).json()).toMatchObject({ version: 2, status: "DRAFT" });
    // HELP-001-D: a second admin still holding version 1 is refused and nothing changes.
    const stale = await edit(1, `Judul basi ${marker}`);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("HELP_ARTICLE_STALE");
    expect((await publish(article.id, 1)).json().code).toBe("HELP_ARTICLE_STALE");
    expect((await publish(article.id, 2)).statusCode).toBe(200);
    expect((await publish(article.id, 2)).json().code).toBe("HELP_ARTICLE_NOT_PUBLISHABLE");

    actAs("hc", HC);
    // D-04: editing a published article applies at once and keeps it published.
    expect((await edit(2, `Judul ketiga ${marker}`)).json()).toMatchObject({ version: 3, status: "PUBLISHED" });
    const archive = () => app.inject({ method: "POST", url: `/admin/help/articles/${article.id}/archive`, payload: { reason: "tidak relevan" } });
    expect((await archive()).statusCode).toBe(200);
    expect((await archive()).json().code).toBe("HELP_ARTICLE_ALREADY_ARCHIVED");
    expect((await edit(3, `Judul arsip ${marker}`)).json().code).toBe("HELP_ARTICLE_ARCHIVED");
    expect((await publish(article.id, 3)).json().code).toBe("HELP_ARTICLE_NOT_PUBLISHABLE");
    actAs("employee");
    expect((await app.inject({ method: "GET", url: `/help/articles/${article.id}` })).statusCode).toBe(404);
    actAs("hc", HC);
    const restore = () => app.inject({ method: "POST", url: `/admin/help/articles/${article.id}/restore` });
    expect((await restore()).json()).toMatchObject({ status: "DRAFT" });
    expect((await restore()).json().code).toBe("HELP_ARTICLE_NOT_ARCHIVED");

    const revisions = await app.inject({ method: "GET", url: `/admin/help/articles/${article.id}/revisions` });
    expect(revisions.json().items.map((row: { version: number }) => row.version)).toEqual([3, 2, 1]);
    expect(revisions.json().items[0]).toMatchObject({ changeNote: "perbaikan", status: "PUBLISHED" });
    expect(await auditTypes(article.id)).toEqual(expect.arrayContaining([
      "help.article.created", "help.article.edited", "help.article.published",
      "help.article.archived", "help.article.restored",
    ]));
    // Spec §7: audit metadata names the article but never carries its body.
    const metadata = await client.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM help_audit_events WHERE article_id = $1", [article.id],
    );
    expect(metadata.rows.every((row) => !("body" in row.metadata))).toBe(true);

    const history = await app.inject({ method: "GET", url: "/admin/help/audit-events?pageSize=3" });
    expect(history.statusCode).toBe(200);
    expect(history.json().items).toHaveLength(3);
    expect(history.json().pagination.total).toBeGreaterThanOrEqual(6);
  });

  it("HELP-001-G: contacts are bounded, readable by employees when active, and deletion is audited", async () => {
    actAs("hc", HC);
    const add = (index: number, extra: Record<string, unknown> = {}) => app.inject({
      method: "POST", url: "/admin/help/contacts",
      payload: { label: `Layanan HC ${index}`, channel: "EMAIL", value: `hc${index}@example.invalid`, sortOrder: index, ...extra },
    });
    const first = await add(0, { channel: "WHATSAPP", value: "+62 800-0000-0000", note: "Senin–Jumat 08.00–15.00" });
    expect(first.statusCode, first.body).toBe(201);
    const hidden = await add(1, { active: false });
    for (let index = 2; index < 20; index += 1) expect((await add(index)).statusCode).toBe(201);
    const over = await add(20);
    expect(over.statusCode).toBe(409);
    expect(over.json().code).toBe("HELP_CONTACT_LIMIT");

    actAs("employee");
    const overview = await app.inject({ method: "GET", url: "/help/overview" });
    const ids = overview.json().contacts.map((contact: { id: string }) => contact.id);
    expect(ids).toContain(first.json().id);
    expect(ids).not.toContain(hidden.json().id);
    expect(overview.json().contacts[0]).not.toHaveProperty("active");

    actAs("hc", HC);
    const updated = await app.inject({
      method: "PUT", url: `/admin/help/contacts/${first.json().id}`,
      payload: { label: "Layanan HC", channel: "PHONE", value: "0274 000000", active: true, sortOrder: 0 },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const deleted = await app.inject({ method: "DELETE", url: `/admin/help/contacts/${first.json().id}` });
    expect(deleted.statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/admin/help/contacts/${first.json().id}` })).statusCode).toBe(404);
    const audit = await client.query<{ event_type: string; metadata: { before?: { value: string } } }>(
      "SELECT event_type, metadata FROM help_audit_events WHERE contact_id = $1 ORDER BY occurred_at, event_type",
      [first.json().id],
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual(expect.arrayContaining([
      "help.contact.created", "help.contact.updated", "help.contact.deleted",
    ]));
    expect(audit.rows.find((row) => row.event_type === "help.contact.deleted")?.metadata.before?.value).toBe("0274 000000");
  });
});
