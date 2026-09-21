import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { AUTH_COOKIE_NAME, AuthService, readCookie, type AuthPrincipal } from "../auth/service.js";

const listSchema = z.object({
  state: z.enum(["all", "unread"]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const idSchema = z.object({ notificationId: z.string().uuid() });

async function authenticate(
  auth: Pick<AuthService, "getSession">,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthPrincipal | null> {
  const token = readCookie(request.headers.cookie, AUTH_COOKIE_NAME);
  const session = await auth.getSession(token);
  if (!session) {
    reply.header("Cache-Control", "no-store");
    await reply.status(401).send({ code: "UNAUTHENTICATED", message: "Sesi tidak ditemukan atau sudah berakhir." });
    return null;
  }
  return session.principal;
}

export async function registerNotificationRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
  injectedAuth?: Pick<AuthService, "getSession">,
) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required for notification routes");
  const auth = injectedAuth ?? new AuthService(
    pool, config.AUTH_ENCRYPTION_KEY, config.AUTH_SESSION_TTL_HOURS, config.NODE_ENV === "production",
  );

  app.get("/notifications/me", async (request, reply) => {
    const principal = await authenticate(auth, request, reply);
    if (!principal) return;
    const query = listSchema.safeParse(request.query);
    if (!query.success) return reply.status(400).send({ code: "INVALID_NOTIFICATION_FILTER", message: "Filter notifikasi tidak valid." });

    const values: unknown[] = [principal.id];
    let stateClause = "";
    if (query.data.state === "unread") stateClause = "AND read_at IS NULL";
    values.push(query.data.limit);
    const items = await pool.query(
      `SELECT id, category, title, body, href,
         read_at AS "readAt", created_at AS "createdAt"
       FROM in_app_notifications
       WHERE recipient_account_id = $1
         ${stateClause}
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      values,
    );
    const unread = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM in_app_notifications
       WHERE recipient_account_id = $1 AND read_at IS NULL`,
      [principal.id],
    );
    reply.header("Cache-Control", "private, no-store");
    return reply.send({ unreadCount: unread.rows[0]?.count ?? 0, items: items.rows });
  });

  app.post("/notifications/:notificationId/read", async (request, reply) => {
    const principal = await authenticate(auth, request, reply);
    if (!principal) return;
    const params = idSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: "INVALID_NOTIFICATION_ID", message: "Notifikasi tidak valid." });
    const changed = await pool.query(
      `UPDATE in_app_notifications
       SET read_at = coalesce(read_at, now())
       WHERE id = $1 AND recipient_account_id = $2
       RETURNING id, read_at AS "readAt"`,
      [params.data.notificationId, principal.id],
    );
    if (!changed.rows[0]) return reply.status(404).send({ code: "NOTIFICATION_NOT_FOUND", message: "Notifikasi tidak ditemukan." });
    reply.header("Cache-Control", "no-store");
    return reply.send(changed.rows[0]);
  });

  app.post("/notifications/read-all", async (request, reply) => {
    const principal = await authenticate(auth, request, reply);
    if (!principal) return;
    const changed = await pool.query(
      `UPDATE in_app_notifications
       SET read_at = now()
       WHERE recipient_account_id = $1 AND read_at IS NULL`,
      [principal.id],
    );
    reply.header("Cache-Control", "no-store");
    return reply.send({ updated: changed.rowCount ?? 0 });
  });
}
