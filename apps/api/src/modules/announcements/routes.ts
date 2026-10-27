// NOTIF-002 Package 1 routes.
// Spec: docs/domain/announcements-and-reminders.md.
//
// announcements.* is HC-only: legacy Super Admin compatibility never grants it, so these
// routes resolve the permission from the organization context directly.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { pageOffset, pageQuerySchema, pagination } from "../../lib/pagination.js";
import type { AnnouncementPermission } from "../auth/permissions.js";
import { AUTH_COOKIE_NAME, AuthService, readCookie, type AuthPrincipal } from "../auth/service.js";
import { notifyEmployee } from "../notifications/service.js";
import {
  ANNOUNCEMENT_LEVELS,
  AnnouncementError,
  assertEditable,
  assertPublishable,
  snapshotRecipients,
  visibleState,
  writeAnnouncementAudit,
} from "./service.js";

const audienceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ALL_EMPLOYEES") }),
  z.object({ kind: z.literal("UNIT"), organizationalUnitId: z.string().uuid() }),
]);

const draftBody = z.object({
  title: z.string().trim().min(5).max(200),
  body: z.string().trim().min(10).max(10000),
  level: z.enum(ANNOUNCEMENT_LEVELS).default("NORMAL"),
  audiences: z.array(audienceSchema).min(1).max(50),
  publishAt: z.string().datetime().optional(),
  displayUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
const correctionBody = draftBody.extend({ reason: z.string().trim().min(5).max(500) });
const archiveBody = z.object({ reason: z.string().trim().max(500).optional() });
const idParams = z.object({ id: z.string().uuid() });

function send(reply: FastifyReply, status: number, body: unknown) {
  reply.header("Cache-Control", "no-store");
  return reply.status(status).send(body);
}

export async function registerAnnouncementRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
  injectedAuth?: Pick<AuthService, "getSession" | "getAuthorizationContext">,
) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required for announcement routes");
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

  async function requirePermission(
    request: FastifyRequest,
    reply: FastifyReply,
    permission: AnnouncementPermission,
  ): Promise<AuthPrincipal | null> {
    const principal = await authenticate(request, reply);
    if (!principal) return null;
    const context = await auth.getAuthorizationContext(principal);
    if (!context.organizationPermissions.includes(permission)) {
      await send(reply, 403, { code: "ANNOUNCEMENT_FORBIDDEN", message: "Anda tidak memiliki akses untuk tindakan ini." });
      return null;
    }
    return principal;
  }

  /** Reading one's own announcements is ownership, not a permission. */
  async function requireSelf(request: FastifyRequest, reply: FastifyReply) {
    const principal = await authenticate(request, reply);
    if (!principal) return null;
    if (principal.principalType !== "EMPLOYEE") {
      await send(reply, 403, { code: "FORBIDDEN", message: "Pengumuman pegawai hanya tersedia untuk pegawai." });
      return null;
    }
    const result = await pool.query<{ employeeId: string }>(
      `SELECT account.employee_id AS "employeeId"
         FROM accounts account
         JOIN employees employee ON employee.id = account.employee_id
        WHERE account.id = $1
          AND account.principal_type = 'EMPLOYEE'
          AND account.status = 'active'
          AND employee.status = 'active'
        LIMIT 1`,
      [principal.id],
    );
    const employeeId = result.rows[0]?.employeeId;
    if (!employeeId) {
      await send(reply, 403, {
        code: "EMPLOYEE_LINK_REQUIRED",
        message: "Account employee tidak terhubung ke employee aktif.",
      });
      return null;
    }
    return { principal, employeeId };
  }

  function handleError(reply: FastifyReply, error: unknown) {
    if (error instanceof AnnouncementError) return send(reply, error.statusCode, { code: error.code, message: error.message });
    throw error;
  }

  async function insertDraft(
    client: PoolClient,
    input: z.infer<typeof draftBody>,
    actorAccountId: string,
    supersedesId: string | null,
  ) {
    const id = randomUUID();
    const status = input.publishAt ? "SCHEDULED" : "DRAFT";
    await client.query(
      `INSERT INTO announcements (
         id, title, body, level, status, publish_at, display_until, created_by_account_id, supersedes_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id, input.title, input.body, input.level, status,
        input.publishAt ?? null, input.displayUntil ?? null, actorAccountId, supersedesId,
      ],
    );
    for (const audience of input.audiences) {
      await client.query(
        `INSERT INTO announcement_audiences (id, announcement_id, audience_kind, organizational_unit_id)
         VALUES ($1,$2,$3,$4)`,
        [
          randomUUID(), id, audience.kind,
          audience.kind === "UNIT" ? audience.organizationalUnitId : null,
        ],
      );
    }
    return id;
  }

  // ---------------------------------------------------------------- employee

  app.get("/announcements/me", async (request, reply) => {
    const self = await requireSelf(request, reply);
    if (!self) return;
    const now = new Date();
    // NOTIF-002-A: the recipient snapshot is the filter; there is no audience evaluation
    // at read time, so a later transfer cannot reveal or hide an announcement.
    const result = await pool.query<{
      status: string; publishAt: Date | null; displayUntil: string | null;
      level: string; acknowledgedAt: Date | null;
    }>(
      `SELECT announcement.id, announcement.title, announcement.body, announcement.level,
              announcement.status, announcement.publish_at AS "publishAt",
              to_char(announcement.display_until, 'YYYY-MM-DD') AS "displayUntil",
              announcement.published_at AS "publishedAt",
              recipient.read_at AS "readAt", recipient.acknowledged_at AS "acknowledgedAt"
         FROM announcement_recipients recipient
         JOIN announcements announcement ON announcement.id = recipient.announcement_id
        WHERE recipient.employee_id = $1
        ORDER BY announcement.published_at DESC NULLS LAST, announcement.id DESC
        LIMIT 200`,
      [self.employeeId],
    );
    const items = result.rows
      .map((row) => ({ ...row, visibility: visibleState(row, now) }))
      .filter((row) => row.visibility !== "HIDDEN");
    return send(reply, 200, {
      items,
      // N-05: what still needs the employee's confirmation.
      pendingAcknowledgement: items.filter(
        (row) => row.level === "PENTING" && !row.acknowledgedAt && row.visibility === "PUBLISHED",
      ).length,
    });
  });

  app.post("/announcements/me/:id/read", async (request, reply) => {
    const self = await requireSelf(request, reply);
    if (!self) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_ANNOUNCEMENT_ID", message: "Pengumuman tidak valid." });
    const changed = await pool.query(
      `UPDATE announcement_recipients
          SET read_at = coalesce(read_at, now())
        WHERE announcement_id = $1 AND employee_id = $2
        RETURNING announcement_id AS "announcementId", read_at AS "readAt"`,
      [params.data.id, self.employeeId],
    );
    if (!changed.rows[0]) return send(reply, 404, { code: "ANNOUNCEMENT_NOT_FOUND", message: "Pengumuman tidak ditemukan." });
    return send(reply, 200, changed.rows[0]);
  });

  app.post("/announcements/me/:id/acknowledge", async (request, reply) => {
    const self = await requireSelf(request, reply);
    if (!self) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_ANNOUNCEMENT_ID", message: "Pengumuman tidak valid." });
    // NOTIF-002-D: only a PENTING announcement asks for confirmation, and the employee
    // filter is what stops confirming on someone else's behalf.
    const changed = await pool.query(
      `UPDATE announcement_recipients recipient
          SET acknowledged_at = coalesce(recipient.acknowledged_at, now()),
              read_at = coalesce(recipient.read_at, now())
         FROM announcements announcement
        WHERE announcement.id = recipient.announcement_id
          AND recipient.announcement_id = $1
          AND recipient.employee_id = $2
          AND announcement.level = 'PENTING'
        RETURNING recipient.acknowledged_at AS "acknowledgedAt"`,
      [params.data.id, self.employeeId],
    );
    if (!changed.rows[0]) {
      return send(reply, 404, { code: "ANNOUNCEMENT_NOT_FOUND", message: "Pengumuman tidak ditemukan atau tidak meminta konfirmasi." });
    }
    return send(reply, 200, changed.rows[0]);
  });

  // ------------------------------------------------------------------- admin

  app.get("/admin/announcements", async (request, reply) => {
    if (!(await requirePermission(request, reply, "announcements.read"))) return;
    const query = pageQuerySchema.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_ANNOUNCEMENT_FILTER", message: "Filter tidak valid." });
    const now = new Date();
    const [items, count] = await Promise.all([
      pool.query<{ status: string; publishAt: Date | null; displayUntil: string | null }>(
        `SELECT announcement.id, announcement.title, announcement.level, announcement.status,
                announcement.publish_at AS "publishAt",
                to_char(announcement.display_until, 'YYYY-MM-DD') AS "displayUntil",
                announcement.published_at AS "publishedAt",
                announcement.supersedes_id AS "supersedesId",
                (SELECT count(*)::int FROM announcement_recipients r
                  WHERE r.announcement_id = announcement.id) AS "reach",
                (SELECT count(*)::int FROM announcement_recipients r
                  WHERE r.announcement_id = announcement.id AND r.read_at IS NOT NULL) AS "readCount",
                (SELECT count(*)::int FROM announcement_recipients r
                  WHERE r.announcement_id = announcement.id AND r.acknowledged_at IS NOT NULL) AS "acknowledgedCount"
           FROM announcements announcement
          ORDER BY coalesce(announcement.published_at, announcement.created_at) DESC, announcement.id DESC
          LIMIT $1 OFFSET $2`,
        [query.data.pageSize, pageOffset(query.data)],
      ),
      pool.query<{ total: number }>("SELECT count(*)::int AS total FROM announcements"),
    ]);
    return send(reply, 200, {
      items: items.rows.map((row) => ({ ...row, visibility: visibleState(row, now) })),
      pagination: pagination(query.data, count.rows[0]?.total ?? 0),
    });
  });

  app.post("/admin/announcements", async (request, reply) => {
    const principal = await requirePermission(request, reply, "announcements.manage");
    if (!principal) return;
    const body = draftBody.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "INVALID_ANNOUNCEMENT", message: "Isi pengumuman tidak valid." });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const id = await insertDraft(client, body.data, principal.id, null);
      await writeAnnouncementAudit(client, {
        eventType: "announcement.drafted",
        announcementId: id,
        actorAccountId: principal.id,
        metadata: { level: body.data.level, scheduled: Boolean(body.data.publishAt) },
      });
      await client.query("COMMIT");
      return send(reply, 201, { id });
    } catch (error) {
      await client.query("ROLLBACK");
      return handleError(reply, error);
    } finally {
      client.release();
    }
  });

  app.put("/admin/announcements/:id", async (request, reply) => {
    const principal = await requirePermission(request, reply, "announcements.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_ANNOUNCEMENT_ID", message: "Pengumuman tidak valid." });
    const body = draftBody.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "INVALID_ANNOUNCEMENT", message: "Isi pengumuman tidak valid." });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query<{ status: string }>(
        "SELECT status FROM announcements WHERE id = $1 FOR UPDATE",
        [params.data.id],
      );
      if (!found.rows[0]) {
        await client.query("ROLLBACK");
        return send(reply, 404, { code: "ANNOUNCEMENT_NOT_FOUND", message: "Pengumuman tidak ditemukan." });
      }
      assertEditable(found.rows[0]);
      await client.query(
        `UPDATE announcements
            SET title = $2, body = $3, level = $4, publish_at = $5, display_until = $6,
                status = CASE WHEN $5::timestamptz IS NULL THEN 'DRAFT' ELSE 'SCHEDULED' END,
                updated_at = now()
          WHERE id = $1`,
        [
          params.data.id, body.data.title, body.data.body, body.data.level,
          body.data.publishAt ?? null, body.data.displayUntil ?? null,
        ],
      );
      await client.query("DELETE FROM announcement_audiences WHERE announcement_id = $1", [params.data.id]);
      for (const audience of body.data.audiences) {
        await client.query(
          `INSERT INTO announcement_audiences (id, announcement_id, audience_kind, organizational_unit_id)
           VALUES ($1,$2,$3,$4)`,
          [randomUUID(), params.data.id, audience.kind, audience.kind === "UNIT" ? audience.organizationalUnitId : null],
        );
      }
      await writeAnnouncementAudit(client, {
        eventType: "announcement.edited",
        announcementId: params.data.id,
        actorAccountId: principal.id,
      });
      await client.query("COMMIT");
      return send(reply, 200, { id: params.data.id });
    } catch (error) {
      await client.query("ROLLBACK");
      return handleError(reply, error);
    } finally {
      client.release();
    }
  });

  app.post("/admin/announcements/:id/publish", async (request, reply) => {
    const principal = await requirePermission(request, reply, "announcements.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_ANNOUNCEMENT_ID", message: "Pengumuman tidak valid." });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query<{ status: string; title: string; level: string }>(
        "SELECT status, title, level FROM announcements WHERE id = $1 FOR UPDATE",
        [params.data.id],
      );
      const announcement = found.rows[0];
      if (!announcement) {
        await client.query("ROLLBACK");
        return send(reply, 404, { code: "ANNOUNCEMENT_NOT_FOUND", message: "Pengumuman tidak ditemukan." });
      }
      assertPublishable(announcement);
      const reach = await snapshotRecipients(client, params.data.id);
      await client.query(
        `UPDATE announcements
            SET status = 'PUBLISHED', published_at = now(), published_by_account_id = $2,
                publish_at = coalesce(publish_at, now()), updated_at = now()
          WHERE id = $1`,
        [params.data.id, principal.id],
      );
      // N-01: the notification points at the announcement; it never carries its body.
      const recipients = await client.query<{ employeeId: string }>(
        `SELECT employee_id AS "employeeId" FROM announcement_recipients WHERE announcement_id = $1`,
        [params.data.id],
      );
      for (const recipient of recipients.rows) {
        await notifyEmployee(client, recipient.employeeId, {
          eventKey: `announcement.${params.data.id}`,
          category: "system",
          title: announcement.level === "PENTING" ? "Pengumuman penting" : "Pengumuman baru",
          body: announcement.title,
          href: "/app/announcements",
        });
      }
      await writeAnnouncementAudit(client, {
        eventType: "announcement.published",
        announcementId: params.data.id,
        actorAccountId: principal.id,
        metadata: { reach },
      });
      await client.query("COMMIT");
      return send(reply, 200, { id: params.data.id, reach });
    } catch (error) {
      await client.query("ROLLBACK");
      return handleError(reply, error);
    } finally {
      client.release();
    }
  });

  /** N-06: a correction is a new announcement; the old one becomes SUPERSEDED. */
  app.post("/admin/announcements/:id/correction", async (request, reply) => {
    const principal = await requirePermission(request, reply, "announcements.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_ANNOUNCEMENT_ID", message: "Pengumuman tidak valid." });
    const body = correctionBody.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "INVALID_ANNOUNCEMENT", message: "Isi ralat tidak valid (alasan minimal 5 karakter)." });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query<{ status: string }>(
        "SELECT status FROM announcements WHERE id = $1 FOR UPDATE",
        [params.data.id],
      );
      if (!found.rows[0]) {
        await client.query("ROLLBACK");
        return send(reply, 404, { code: "ANNOUNCEMENT_NOT_FOUND", message: "Pengumuman tidak ditemukan." });
      }
      if (found.rows[0].status !== "PUBLISHED") {
        await client.query("ROLLBACK");
        return send(reply, 409, { code: "ANNOUNCEMENT_NOT_CORRECTABLE", message: "Hanya pengumuman yang sudah terbit yang dapat diralat." });
      }
      const id = await insertDraft(client, body.data, principal.id, params.data.id);
      await client.query("UPDATE announcements SET status = 'SUPERSEDED', updated_at = now() WHERE id = $1", [params.data.id]);
      await writeAnnouncementAudit(client, {
        eventType: "announcement.corrected",
        announcementId: id,
        actorAccountId: principal.id,
        reason: body.data.reason,
        metadata: { supersedes: params.data.id },
      });
      await client.query("COMMIT");
      return send(reply, 201, { id, supersedes: params.data.id });
    } catch (error) {
      await client.query("ROLLBACK");
      return handleError(reply, error);
    } finally {
      client.release();
    }
  });

  app.post("/admin/announcements/:id/archive", async (request, reply) => {
    const principal = await requirePermission(request, reply, "announcements.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_ANNOUNCEMENT_ID", message: "Pengumuman tidak valid." });
    const body = archiveBody.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "INVALID_ANNOUNCEMENT", message: "Alasan tidak valid." });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const changed = await client.query(
        `UPDATE announcements
            SET status = 'ARCHIVED', archived_at = now(), updated_at = now()
          WHERE id = $1 AND status IN ('PUBLISHED', 'SCHEDULED', 'DRAFT')
          RETURNING id`,
        [params.data.id],
      );
      if (!changed.rows[0]) {
        await client.query("ROLLBACK");
        return send(reply, 409, { code: "ANNOUNCEMENT_NOT_ARCHIVABLE", message: "Pengumuman tidak dapat diarsipkan." });
      }
      await writeAnnouncementAudit(client, {
        eventType: "announcement.archived",
        announcementId: params.data.id,
        actorAccountId: principal.id,
        reason: body.data.reason ?? null,
      });
      await client.query("COMMIT");
      return send(reply, 200, { id: params.data.id, status: "ARCHIVED" });
    } catch (error) {
      await client.query("ROLLBACK");
      return handleError(reply, error);
    } finally {
      client.release();
    }
  });

  app.get("/admin/announcements/:id", async (request, reply) => {
    if (!(await requirePermission(request, reply, "announcements.read"))) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_ANNOUNCEMENT_ID", message: "Pengumuman tidak valid." });
    const found = await pool.query<{ status: string; publishAt: Date | null; displayUntil: string | null }>(
      `SELECT announcement.id, announcement.title, announcement.body, announcement.level,
              announcement.status, announcement.publish_at AS "publishAt",
              to_char(announcement.display_until, 'YYYY-MM-DD') AS "displayUntil",
              announcement.published_at AS "publishedAt", announcement.supersedes_id AS "supersedesId"
         FROM announcements announcement
        WHERE announcement.id = $1`,
      [params.data.id],
    );
    if (!found.rows[0]) return send(reply, 404, { code: "ANNOUNCEMENT_NOT_FOUND", message: "Pengumuman tidak ditemukan." });
    const audiences = await pool.query(
      `SELECT audience_kind AS "kind", organizational_unit_id AS "organizationalUnitId"
         FROM announcement_audiences WHERE announcement_id = $1 ORDER BY audience_kind`,
      [params.data.id],
    );
    return send(reply, 200, {
      ...found.rows[0],
      visibility: visibleState(found.rows[0], new Date()),
      audiences: audiences.rows,
    });
  });
}
