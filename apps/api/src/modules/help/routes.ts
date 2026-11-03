// HELP-001 Package 1 routes.
// Spec: docs/domain/help-center.md.
//
// Reading needs only an EMPLOYEE session (D-07). help.manage is HC-only: legacy Super Admin
// compatibility never grants it, so the admin routes resolve it from the organization context.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { pageOffset, pageQuerySchema, pagination } from "../../lib/pagination.js";
import type { HelpPermission } from "../auth/permissions.js";
import { AUTH_COOKIE_NAME, AuthService, readCookie, type AuthPrincipal } from "../auth/service.js";
import {
  articleEdit,
  articleInput,
  assertArchivable,
  assertEditable,
  assertFreshVersion,
  assertPublishable,
  assertRestorable,
  contactInput,
  HELP_CONTACT_LIMIT,
  HELP_KINDS,
  HELP_STATUSES,
  HELP_TOPICS,
  HelpError,
  searchClause,
  searchPatterns,
  type HelpStatus,
} from "./domain.js";

type Db = Pick<PoolClient, "query">;

// An empty search box sends `q=`; that means "no search", not a too-short query.
const optionalQuery = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(2).max(100).optional(),
);
const readerQuery = pageQuerySchema.extend({
  q: optionalQuery,
  topic: z.enum(HELP_TOPICS).optional(),
  kind: z.enum(HELP_KINDS).optional(),
});
const adminQuery = readerQuery.extend({ status: z.enum(HELP_STATUSES).optional() });
const idParams = z.object({ id: z.string().uuid() });
const versionBody = z.object({ version: z.number().int().min(1) });
const archiveBody = z.object({ reason: z.string().trim().max(300).optional() });

const ARTICLE_COLUMNS = `
  article.id, article.kind, article.topic, article.title, article.body, article.status,
  article.sort_order AS "sortOrder", article.version, article.origin,
  article.published_at AS "publishedAt", article.archived_at AS "archivedAt",
  article.created_at AS "createdAt", article.updated_at AS "updatedAt"`;
// HELP-001-A: the reader never learns about drafts, origins or versions.
const READER_COLUMNS = `
  article.id, article.kind, article.topic, article.title, article.body,
  article.sort_order AS "sortOrder", article.published_at AS "publishedAt", article.updated_at AS "updatedAt"`;
const READER_CONTACT_COLUMNS = `id, label, channel, value, note, sort_order AS "sortOrder"`;
const CONTACT_COLUMNS = `
  id, label, channel, value, note, sort_order AS "sortOrder", active,
  created_at AS "createdAt", updated_at AS "updatedAt"`;

function send(reply: FastifyReply, status: number, body: unknown) {
  reply.header("Cache-Control", "no-store");
  return reply.status(status).send(body);
}

async function writeHelpAudit(
  db: Db,
  event: {
    eventType: string;
    articleId?: string | null;
    contactId?: string | null;
    actorAccountId: string;
    reason?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  await db.query(
    `INSERT INTO help_audit_events (id, event_type, article_id, contact_id, actor_account_id, reason, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [
      randomUUID(), event.eventType, event.articleId ?? null, event.contactId ?? null,
      event.actorAccountId, event.reason ?? null, JSON.stringify(event.metadata ?? {}),
    ],
  );
}

/** D-04: every save keeps the whole text of that version. */
async function writeRevision(db: Db, articleId: string, actorAccountId: string, changeNote: string | null) {
  await db.query(
    `INSERT INTO help_article_revisions
       (id, article_id, version, kind, topic, title, body, status, change_note, actor_account_id)
     SELECT $1, id, version, kind, topic, title, body, status, $3, $4 FROM help_articles WHERE id = $2`,
    [randomUUID(), articleId, changeNote, actorAccountId],
  );
}

/** Audit metadata names the article but never carries its body (spec §7). */
function articleMetadata(row: { kind: string; topic: string; title: string; version: number }) {
  return { kind: row.kind, topic: row.topic, title: row.title, version: row.version };
}

export async function registerHelpRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
  injectedAuth?: Pick<AuthService, "getSession" | "getAuthorizationContext">,
) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required for help center routes");
  const auth = injectedAuth ?? new AuthService(
    pool, config.AUTH_ENCRYPTION_KEY, config.AUTH_SESSION_TTL_HOURS, config.NODE_ENV === "production",
  );

  async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<AuthPrincipal | null> {
    const session = await auth.getSession(readCookie(request.headers.cookie, AUTH_COOKIE_NAME));
    if (!session) {
      await send(reply, 401, { code: "UNAUTHENTICATED", message: "Sesi tidak ditemukan atau sudah berakhir." });
      return null;
    }
    return session.principal;
  }

  /** D-07: any employee session reads the help center, linked to an active employee or not. */
  async function requireReader(request: FastifyRequest, reply: FastifyReply) {
    const principal = await authenticate(request, reply);
    if (!principal) return null;
    if (principal.principalType !== "EMPLOYEE") {
      await send(reply, 403, { code: "FORBIDDEN", message: "Pusat Bantuan hanya tersedia untuk pegawai." });
      return null;
    }
    return principal;
  }

  async function requirePermission(request: FastifyRequest, reply: FastifyReply, permission: HelpPermission) {
    const principal = await authenticate(request, reply);
    if (!principal) return null;
    const context = await auth.getAuthorizationContext(principal);
    if (!context.organizationPermissions.includes(permission)) {
      await send(reply, 403, { code: "HELP_FORBIDDEN", message: "Anda tidak memiliki akses untuk mengelola Pusat Bantuan." });
      return null;
    }
    return principal;
  }

  function handleError(reply: FastifyReply, error: unknown) {
    if (error instanceof HelpError) return send(reply, error.statusCode, { code: error.code, message: error.message });
    throw error;
  }

  const notFound = (reply: FastifyReply) =>
    send(reply, 404, { code: "HELP_ARTICLE_NOT_FOUND", message: "Artikel bantuan tidak ditemukan." });

  /** Runs `work` in one transaction and answers with its result; HelpError becomes its response. */
  async function inTransaction(reply: FastifyReply, status: number, work: (client: PoolClient) => Promise<unknown>) {
    const client = await pool.connect();
    let result: unknown;
    try {
      await client.query("BEGIN");
      result = await work(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      return handleError(reply, error);
    } finally {
      client.release();
    }
    return send(reply, status, result);
  }

  async function lockArticle(client: PoolClient, id: string) {
    const found = await client.query<{ status: HelpStatus; version: number; kind: string; topic: string; title: string }>(
      "SELECT status, version, kind, topic, title FROM help_articles WHERE id = $1 FOR UPDATE",
      [id],
    );
    if (!found.rows[0]) throw new HelpError(404, "HELP_ARTICLE_NOT_FOUND", "Artikel bantuan tidak ditemukan.");
    return found.rows[0];
  }

  async function articleList(query: z.infer<typeof adminQuery>, publishedOnly: boolean) {
    const columns = publishedOnly ? READER_COLUMNS : ARTICLE_COLUMNS;
    const values: unknown[] = [];
    const where: string[] = [];
    const add = (value: unknown) => `$${values.push(value)}`;
    if (publishedOnly) where.push("article.status = 'PUBLISHED'");
    else if (query.status) where.push(`article.status = ${add(query.status)}`);
    if (query.topic) where.push(`article.topic = ${add(query.topic)}`);
    if (query.kind) where.push(`article.kind = ${add(query.kind)}`);
    const search = searchClause("article", searchPatterns(query.q), values.length + 1);
    values.push(...search.values);
    where.push(...search.where);
    const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const filterValues = [...values];
    // D-06: title hits first (only when searching), then the topic reading order, then the
    // HC-chosen order.
    const order = [
      ...(search.titleRank ? [`(${search.titleRank}) DESC`] : []),
      `array_position(${add(HELP_TOPICS)}::text[], article.topic)`,
      "article.sort_order", "article.title", "article.id",
    ].join(", ");
    const limit = add(query.pageSize);
    const offset = add(pageOffset(query));
    // ENG-LIST-001: filters run before LIMIT, and total counts the same filter.
    const [items, count] = await Promise.all([
      pool.query(
        `SELECT ${columns} FROM help_articles article ${filter} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
        values,
      ),
      pool.query<{ total: number }>(`SELECT count(*)::int AS total FROM help_articles article ${filter}`, filterValues),
    ]);
    return { items: items.rows, pagination: pagination(query, count.rows[0]?.total ?? 0) };
  }

  // ---------------------------------------------------------------- employee

  app.get("/help/overview", async (request, reply) => {
    if (!(await requireReader(request, reply))) return;
    const [topics, contacts] = await Promise.all([
      pool.query<{ topic: string; faqCount: number; guideCount: number }>(
        `SELECT topic,
                count(*) FILTER (WHERE kind = 'FAQ')::int AS "faqCount",
                count(*) FILTER (WHERE kind = 'GUIDE')::int AS "guideCount"
           FROM help_articles
          WHERE status = 'PUBLISHED'
          GROUP BY topic`,
      ),
      // D-09: bounded at HELP_CONTACT_LIMIT by the create route, so no pagination.
      pool.query(
        `SELECT ${READER_CONTACT_COLUMNS} FROM help_contacts WHERE active ORDER BY sort_order, label, id`,
      ),
    ]);
    const byTopic = new Map(topics.rows.map((row) => [row.topic, row]));
    return send(reply, 200, {
      topics: HELP_TOPICS.map((topic) => ({
        topic,
        faqCount: byTopic.get(topic)?.faqCount ?? 0,
        guideCount: byTopic.get(topic)?.guideCount ?? 0,
      })),
      contacts: contacts.rows,
    });
  });

  app.get("/help/articles", async (request, reply) => {
    if (!(await requireReader(request, reply))) return;
    const query = readerQuery.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_HELP_FILTER", message: "Pencarian atau filter tidak valid." });
    const list = await articleList(query.data, true);
    return send(reply, 200, list);
  });

  app.get("/help/articles/:id", async (request, reply) => {
    if (!(await requireReader(request, reply))) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const found = await pool.query(
      `SELECT ${READER_COLUMNS} FROM help_articles article WHERE article.id = $1 AND article.status = 'PUBLISHED'`,
      [params.data.id],
    );
    if (!found.rows[0]) return notFound(reply);
    return send(reply, 200, found.rows[0]);
  });

  // ---------------------------------------------------------- admin articles

  app.get("/admin/help/articles", async (request, reply) => {
    if (!(await requirePermission(request, reply, "help.manage"))) return;
    const query = adminQuery.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_HELP_FILTER", message: "Pencarian atau filter tidak valid." });
    const [list, counts] = await Promise.all([
      articleList(query.data, false),
      pool.query<{ status: HelpStatus; total: number; seedDrafts: number }>(
        `SELECT status, count(*)::int AS total,
                count(*) FILTER (WHERE origin = 'SEED' AND version = 1)::int AS "seedDrafts"
           FROM help_articles GROUP BY status`,
      ),
    ]);
    const statusCounts = Object.fromEntries(HELP_STATUSES.map((status) => [
      status, counts.rows.find((row) => row.status === status)?.total ?? 0,
    ]));
    return send(reply, 200, {
      ...list,
      counts: {
        ...statusCounts,
        // D-03: initial content HC has not touched yet.
        unreviewedSeed: counts.rows.find((row) => row.status === "DRAFT")?.seedDrafts ?? 0,
      },
    });
  });

  app.post("/admin/help/articles", async (request, reply) => {
    const principal = await requirePermission(request, reply, "help.manage");
    if (!principal) return;
    const body = articleInput.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "INVALID_HELP_ARTICLE", message: "Isi artikel tidak valid." });
    const id = randomUUID();
    return inTransaction(reply, 201, async (client) => {
      await client.query(
        `INSERT INTO help_articles
           (id, kind, topic, title, body, sort_order, origin, created_by_account_id, updated_by_account_id)
         VALUES ($1,$2,$3,$4,$5,$6,'HC',$7,$7)`,
        [id, body.data.kind, body.data.topic, body.data.title, body.data.body, body.data.sortOrder, principal.id],
      );
      await writeRevision(client, id, principal.id, null);
      await writeHelpAudit(client, {
        eventType: "help.article.created",
        articleId: id,
        actorAccountId: principal.id,
        metadata: { ...articleMetadata({ ...body.data, version: 1 }), origin: "HC" },
      });
      return { id, status: "DRAFT", version: 1 };
    });
  });

  app.get("/admin/help/articles/:id", async (request, reply) => {
    if (!(await requirePermission(request, reply, "help.manage"))) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_HELP_ARTICLE_ID", message: "Artikel tidak valid." });
    const found = await pool.query(
      `SELECT ${ARTICLE_COLUMNS} FROM help_articles article WHERE article.id = $1`,
      [params.data.id],
    );
    if (!found.rows[0]) return notFound(reply);
    return send(reply, 200, found.rows[0]);
  });

  app.put("/admin/help/articles/:id", async (request, reply) => {
    const principal = await requirePermission(request, reply, "help.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_HELP_ARTICLE_ID", message: "Artikel tidak valid." });
    const body = articleEdit.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "INVALID_HELP_ARTICLE", message: "Isi artikel tidak valid." });
    return inTransaction(reply, 200, async (client) => {
      const current = await lockArticle(client, params.data.id);
      assertEditable(current.status);
      assertFreshVersion(current.version, body.data.version);
      const version = current.version + 1;
      await client.query(
        `UPDATE help_articles
            SET kind = $2, topic = $3, title = $4, body = $5, sort_order = $6,
                version = $7, updated_by_account_id = $8, updated_at = now()
          WHERE id = $1`,
        [
          params.data.id, body.data.kind, body.data.topic, body.data.title, body.data.body,
          body.data.sortOrder, version, principal.id,
        ],
      );
      await writeRevision(client, params.data.id, principal.id, body.data.changeNote || null);
      await writeHelpAudit(client, {
        eventType: "help.article.edited",
        articleId: params.data.id,
        actorAccountId: principal.id,
        reason: body.data.changeNote || null,
        metadata: { ...articleMetadata({ ...body.data, version }), status: current.status, previousTitle: current.title },
      });
      return { id: params.data.id, status: current.status, version };
    });
  });

  app.post("/admin/help/articles/:id/publish", async (request, reply) => {
    const principal = await requirePermission(request, reply, "help.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_HELP_ARTICLE_ID", message: "Artikel tidak valid." });
    const body = versionBody.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "INVALID_HELP_ARTICLE", message: "Versi artikel wajib dikirim." });
    return inTransaction(reply, 200, async (client) => {
      const current = await lockArticle(client, params.data.id);
      assertPublishable(current.status);
      assertFreshVersion(current.version, body.data.version);
      await client.query(
        `UPDATE help_articles
            SET status = 'PUBLISHED', published_at = now(), updated_by_account_id = $2, updated_at = now()
          WHERE id = $1`,
        [params.data.id, principal.id],
      );
      await writeHelpAudit(client, {
        eventType: "help.article.published",
        articleId: params.data.id,
        actorAccountId: principal.id,
        metadata: articleMetadata(current),
      });
      return { id: params.data.id, status: "PUBLISHED", version: current.version };
    });
  });

  app.post("/admin/help/articles/:id/archive", async (request, reply) => {
    const principal = await requirePermission(request, reply, "help.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_HELP_ARTICLE_ID", message: "Artikel tidak valid." });
    const body = archiveBody.safeParse(request.body ?? {});
    if (!body.success) return send(reply, 400, { code: "INVALID_HELP_ARTICLE", message: "Alasan tidak valid (maksimal 300 karakter)." });
    return inTransaction(reply, 200, async (client) => {
      const current = await lockArticle(client, params.data.id);
      assertArchivable(current.status);
      await client.query(
        `UPDATE help_articles
            SET status = 'ARCHIVED', archived_at = now(), updated_by_account_id = $2, updated_at = now()
          WHERE id = $1`,
        [params.data.id, principal.id],
      );
      await writeHelpAudit(client, {
        eventType: "help.article.archived",
        articleId: params.data.id,
        actorAccountId: principal.id,
        reason: body.data.reason || null,
        metadata: { ...articleMetadata(current), previousStatus: current.status },
      });
      return { id: params.data.id, status: "ARCHIVED", version: current.version };
    });
  });

  app.post("/admin/help/articles/:id/restore", async (request, reply) => {
    const principal = await requirePermission(request, reply, "help.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_HELP_ARTICLE_ID", message: "Artikel tidak valid." });
    return inTransaction(reply, 200, async (client) => {
      const current = await lockArticle(client, params.data.id);
      assertRestorable(current.status);
      await client.query(
        `UPDATE help_articles
            SET status = 'DRAFT', archived_at = NULL, published_at = NULL,
                updated_by_account_id = $2, updated_at = now()
          WHERE id = $1`,
        [params.data.id, principal.id],
      );
      await writeHelpAudit(client, {
        eventType: "help.article.restored",
        articleId: params.data.id,
        actorAccountId: principal.id,
        metadata: articleMetadata(current),
      });
      return { id: params.data.id, status: "DRAFT", version: current.version };
    });
  });

  app.get("/admin/help/articles/:id/revisions", async (request, reply) => {
    if (!(await requirePermission(request, reply, "help.manage"))) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_HELP_ARTICLE_ID", message: "Artikel tidak valid." });
    const query = pageQuerySchema.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_HELP_FILTER", message: "Halaman tidak valid." });
    const exists = await pool.query("SELECT 1 FROM help_articles WHERE id = $1", [params.data.id]);
    if (!exists.rowCount) return notFound(reply);
    const [items, count] = await Promise.all([
      pool.query(
        `SELECT revision.id, revision.version, revision.kind, revision.topic, revision.title, revision.body,
                revision.status, revision.change_note AS "changeNote", revision.created_at AS "createdAt",
                coalesce(employee.full_name, account.email) AS "actorName"
           FROM help_article_revisions revision
           LEFT JOIN accounts account ON account.id = revision.actor_account_id
           LEFT JOIN employees employee ON employee.id = account.employee_id
          WHERE revision.article_id = $1
          ORDER BY revision.version DESC
          LIMIT $2 OFFSET $3`,
        [params.data.id, query.data.pageSize, pageOffset(query.data)],
      ),
      pool.query<{ total: number }>(
        "SELECT count(*)::int AS total FROM help_article_revisions WHERE article_id = $1",
        [params.data.id],
      ),
    ]);
    return send(reply, 200, { items: items.rows, pagination: pagination(query.data, count.rows[0]?.total ?? 0) });
  });

  // ---------------------------------------------------------- admin contacts

  app.get("/admin/help/contacts", async (request, reply) => {
    if (!(await requirePermission(request, reply, "help.manage"))) return;
    // D-09: bounded at HELP_CONTACT_LIMIT, so the whole list is returned.
    const contacts = await pool.query(
      `SELECT ${CONTACT_COLUMNS} FROM help_contacts ORDER BY sort_order, label, id`,
    );
    return send(reply, 200, { items: contacts.rows, limit: HELP_CONTACT_LIMIT });
  });

  app.post("/admin/help/contacts", async (request, reply) => {
    const principal = await requirePermission(request, reply, "help.manage");
    if (!principal) return;
    const body = contactInput.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "INVALID_HELP_CONTACT", message: "Data kontak tidak valid." });
    const id = randomUUID();
    return inTransaction(reply, 201, async (client) => {
      // Serialize concurrent creates so two requests cannot both take the last slot.
      await client.query("LOCK TABLE help_contacts IN SHARE ROW EXCLUSIVE MODE");
      const count = await client.query<{ total: number }>("SELECT count(*)::int AS total FROM help_contacts");
      if ((count.rows[0]?.total ?? 0) >= HELP_CONTACT_LIMIT) {
        throw new HelpError(409, "HELP_CONTACT_LIMIT", `Kontak paling banyak ${HELP_CONTACT_LIMIT}. Hapus atau ubah kontak yang ada.`);
      }
      await client.query(
        `INSERT INTO help_contacts (id, label, channel, value, note, sort_order, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, body.data.label, body.data.channel, body.data.value, body.data.note || null, body.data.sortOrder, body.data.active],
      );
      await writeHelpAudit(client, {
        eventType: "help.contact.created",
        contactId: id,
        actorAccountId: principal.id,
        metadata: { after: contactSnapshot(body.data) },
      });
      return { id };
    });
  });

  app.put("/admin/help/contacts/:id", async (request, reply) => {
    const principal = await requirePermission(request, reply, "help.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_HELP_CONTACT_ID", message: "Kontak tidak valid." });
    const body = contactInput.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "INVALID_HELP_CONTACT", message: "Data kontak tidak valid." });
    return inTransaction(reply, 200, async (client) => {
      const before = await lockContact(client, params.data.id);
      await client.query(
        `UPDATE help_contacts
            SET label = $2, channel = $3, value = $4, note = $5, sort_order = $6, active = $7, updated_at = now()
          WHERE id = $1`,
        [
          params.data.id, body.data.label, body.data.channel, body.data.value, body.data.note || null,
          body.data.sortOrder, body.data.active,
        ],
      );
      await writeHelpAudit(client, {
        eventType: "help.contact.updated",
        contactId: params.data.id,
        actorAccountId: principal.id,
        metadata: { before: contactSnapshot(before), after: contactSnapshot(body.data) },
      });
      return { id: params.data.id };
    });
  });

  app.delete("/admin/help/contacts/:id", async (request, reply) => {
    const principal = await requirePermission(request, reply, "help.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_HELP_CONTACT_ID", message: "Kontak tidak valid." });
    return inTransaction(reply, 200, async (client) => {
      const before = await lockContact(client, params.data.id);
      await client.query("DELETE FROM help_contacts WHERE id = $1", [params.data.id]);
      // HELP-001-G: the deleted contact survives in its audit event.
      await writeHelpAudit(client, {
        eventType: "help.contact.deleted",
        contactId: params.data.id,
        actorAccountId: principal.id,
        metadata: { before: contactSnapshot(before) },
      });
      return { id: params.data.id, deleted: true };
    });
  });

  async function lockContact(client: PoolClient, id: string) {
    const found = await client.query<{
      label: string; channel: string; value: string; note: string | null; sortOrder: number; active: boolean;
    }>(
      `SELECT label, channel, value, note, sort_order AS "sortOrder", active FROM help_contacts WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!found.rows[0]) throw new HelpError(404, "HELP_CONTACT_NOT_FOUND", "Kontak tidak ditemukan.");
    return found.rows[0];
  }

  // ------------------------------------------------------------- admin audit

  app.get("/admin/help/audit-events", async (request, reply) => {
    if (!(await requirePermission(request, reply, "help.manage"))) return;
    const query = pageQuerySchema.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_HELP_FILTER", message: "Halaman tidak valid." });
    const [items, count] = await Promise.all([
      pool.query(
        `SELECT event.id, event.event_type AS "eventType", event.article_id AS "articleId",
                event.contact_id AS "contactId", event.reason, event.metadata,
                event.occurred_at AS "occurredAt",
                coalesce(employee.full_name, account.email) AS "actorName"
           FROM help_audit_events event
           LEFT JOIN accounts account ON account.id = event.actor_account_id
           LEFT JOIN employees employee ON employee.id = account.employee_id
          ORDER BY event.occurred_at DESC, event.id DESC
          LIMIT $1 OFFSET $2`,
        [query.data.pageSize, pageOffset(query.data)],
      ),
      pool.query<{ total: number }>("SELECT count(*)::int AS total FROM help_audit_events"),
    ]);
    return send(reply, 200, { items: items.rows, pagination: pagination(query.data, count.rows[0]?.total ?? 0) });
  });
}

function contactSnapshot(contact: {
  label: string; channel: string; value: string; note?: string | null | undefined; sortOrder: number; active: boolean;
}) {
  return {
    label: contact.label, channel: contact.channel, value: contact.value,
    note: contact.note || null, sortOrder: contact.sortOrder, active: contact.active,
  };
}
