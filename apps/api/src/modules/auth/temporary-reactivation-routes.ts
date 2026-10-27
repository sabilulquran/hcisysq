// EMP-005 S5A (spec §8.5.2, D-15): time-boxed reactivation of a former
// employee's HCIS account, and the central guard that keeps such a session to
// the three read-only self-service pages the owner allowed.
//
// Granting needs access.accounts.temporary_reactivate (human_capital_admin
// only). A grant always carries a reason and an expiry of at most 30 days;
// granting to one's own account is refused.

import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { ACCESS_REACTIVATION_PERMISSION } from "./permissions.js";
import {
  MAX_REACTIVATION_DAYS,
  isAllowedWhileReactivated,
  listTemporaryReactivations,
  loadEmploymentAccessState,
} from "./employment-access.js";
import { AUTH_COOKIE_NAME, AuthService, readCookie, type AuthPrincipal } from "./service.js";

const accountParams = z.object({ accountId: z.string().uuid() });
const grantParams = accountParams.extend({ grantId: z.string().uuid() });
const grantBody = z.object({
  reason: z.string().trim().min(10).max(500),
  expiresAt: z.string().datetime(),
});

function send(reply: FastifyReply, status: number, body: unknown) {
  reply.header("Cache-Control", "no-store");
  return reply.status(status).send(body);
}

export async function registerTemporaryReactivationRoutes(app: FastifyInstance, pool: Pool, config: ApiConfig) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required for reactivation routes");
  const auth = new AuthService(
    pool,
    config.AUTH_ENCRYPTION_KEY,
    config.AUTH_SESSION_TTL_HOURS,
    config.NODE_ENV === "production",
  );

  /**
   * EMP-005 §8.5 central guard, fail closed. Runs before every route, so no
   * self-service route can forget it and a late deactivation job cannot widen
   * access: the employment dates decide, not the stored account status.
   *
   * - employment ended, no grant -> the session is refused outright;
   * - employment ended with a valid grant -> only own payslips, own attendance
   *   history and own leave history, read-only (owner, 2026-10-16).
   */
  app.addHook("onRequest", async (request, reply) => {
    const token = readCookie(request.headers.cookie, AUTH_COOKIE_NAME);
    if (!token) return;
    const session = await auth.getSession(token);
    if (!session || session.principal.principalType !== "EMPLOYEE") return;
    const access = await loadEmploymentAccessState(pool, session.principal.id);
    if (!access.employmentEnded) return;
    if (!access.reactivationExpiresAt) {
      return send(reply, 401, {
        code: "EMPLOYMENT_ENDED",
        message: "Hubungan kerja sudah berakhir, sehingga akun HCIS tidak aktif.",
      });
    }
    if (isAllowedWhileReactivated(request.method, request.url)) return;
    return send(reply, 403, {
      code: "EMPLOYMENT_ENDED_READ_ONLY",
      message: "Akses sementara hanya untuk slip gaji, riwayat kehadiran, dan riwayat cuti Anda sendiri.",
    });
  });

  /**
   * HC Admin only: the permission sits outside the legacy Super Admin bundle,
   * so it is checked directly rather than through the admin helper.
   */
  async function authenticateGrantor(request: FastifyRequest, reply: FastifyReply): Promise<AuthPrincipal | null> {
    const session = await auth.getSession(readCookie(request.headers.cookie, AUTH_COOKIE_NAME));
    if (!session) {
      await send(reply, 401, { code: "UNAUTHENTICATED", message: "Sesi tidak ditemukan atau sudah berakhir." });
      return null;
    }
    const context = await auth.getAuthorizationContext(session.principal);
    if (!context.organizationPermissions.includes(ACCESS_REACTIVATION_PERMISSION)) {
      await send(reply, 403, { code: "FORBIDDEN", message: "Akun ini tidak memiliki izin administrasi yang diperlukan." });
      return null;
    }
    return session.principal;
  }

  app.get("/admin/access/accounts/:accountId/temporary-reactivations", async (request, reply) => {
    if (!(await authenticateGrantor(request, reply))) return;
    const params = accountParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_ACCOUNT", message: "Account tidak valid." });
    return send(reply, 200, { items: await listTemporaryReactivations(pool, params.data.accountId) });
  });

  app.post("/admin/access/accounts/:accountId/temporary-reactivations", async (request, reply) => {
    const principal = await authenticateGrantor(request, reply);
    if (!principal) return;
    const params = accountParams.safeParse(request.params);
    const body = grantBody.safeParse(request.body);
    if (!params.success || !body.success) {
      return send(reply, 400, {
        code: "REACTIVATION_EXPIRY_REQUIRED",
        message: "Tentukan alasan dan tanggal berakhir akses (maksimal 30 hari).",
      });
    }
    if (params.data.accountId === principal.id) {
      return send(reply, 403, {
        code: "REACTIVATION_SELF_FORBIDDEN",
        message: "Anda tidak dapat mengaktifkan kembali akun Anda sendiri.",
      });
    }
    const expiresAt = new Date(body.data.expiresAt);
    const now = Date.now();
    if (expiresAt.getTime() <= now || expiresAt.getTime() > now + MAX_REACTIVATION_DAYS * 86_400_000) {
      return send(reply, 400, {
        code: "REACTIVATION_EXPIRY_REQUIRED",
        message: `Tanggal berakhir akses wajib diisi dan paling lama ${MAX_REACTIVATION_DAYS} hari.`,
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const account = await client.query<{ id: string; status: string; principalType: string; endedOn: string | null }>(
        `SELECT a.id, a.status, a.principal_type AS "principalType",
                (SELECT max(e.ended_on)::text FROM employments e
                 WHERE e.employee_id = a.employee_id AND e.voided_by_action_id IS NULL) AS "endedOn"
         FROM accounts a WHERE a.id = $1 FOR UPDATE OF a`,
        [params.data.accountId],
      );
      const row = account.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return send(reply, 404, { code: "ACCOUNT_NOT_FOUND", message: "Account tidak ditemukan." });
      }
      if (row.principalType !== "EMPLOYEE" || row.status === "suspended" || !row.endedOn) {
        await client.query("ROLLBACK");
        return send(reply, 409, {
          code: "REACTIVATION_NOT_APPLICABLE",
          message: "Akun ini tidak memerlukan aktivasi sementara.",
        });
      }
      await client.query(
        `UPDATE account_temporary_reactivations
         SET revoked_at = now(), revoked_by_account_id = $2
         WHERE account_id = $1 AND revoked_at IS NULL`,
        [row.id, principal.id],
      );
      const id = randomUUID();
      await client.query(
        `INSERT INTO account_temporary_reactivations (id, account_id, reason, expires_at, granted_by_account_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, row.id, body.data.reason, expiresAt.toISOString(), principal.id],
      );
      await client.query("UPDATE accounts SET status = 'active', updated_at = now() WHERE id = $1", [row.id]);
      await client.query(
        `INSERT INTO access_audit_events (id, actor_account_id, action, entity_type, entity_id, payload)
         VALUES ($1, $2, 'account.temporary_reactivation.granted', 'account', $3, $4::jsonb)`,
        [randomUUID(), principal.id, row.id, JSON.stringify({ grantId: id, expiresAt: expiresAt.toISOString(), reasonLength: body.data.reason.length })],
      );
      await client.query("COMMIT");
      return send(reply, 201, { id, accountId: row.id, expiresAt: expiresAt.toISOString() });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.post("/admin/access/accounts/:accountId/temporary-reactivations/:grantId/revoke", async (request, reply) => {
    const principal = await authenticateGrantor(request, reply);
    if (!principal) return;
    const params = grantParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_ACCOUNT", message: "Account tidak valid." });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const revoked = await client.query<{ id: string }>(
        `UPDATE account_temporary_reactivations
         SET revoked_at = now(), revoked_by_account_id = $3
         WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL
         RETURNING id`,
        [params.data.grantId, params.data.accountId, principal.id],
      );
      if (revoked.rowCount === 0) {
        await client.query("ROLLBACK");
        return send(reply, 404, { code: "REACTIVATION_NOT_FOUND", message: "Aktivasi sementara tidak ditemukan." });
      }
      await client.query(
        `UPDATE accounts SET status = 'inactive', updated_at = now()
         WHERE id = $1 AND principal_type = 'EMPLOYEE' AND status IN ('invited', 'active')`,
        [params.data.accountId],
      );
      await client.query(
        `UPDATE auth_sessions SET revoked_at = coalesce(revoked_at, now())
         WHERE account_id = $1 AND revoked_at IS NULL`,
        [params.data.accountId],
      );
      await client.query(
        `INSERT INTO access_audit_events (id, actor_account_id, action, entity_type, entity_id, payload)
         VALUES ($1, $2, 'account.temporary_reactivation.revoked', 'account', $3, $4::jsonb)`,
        [randomUUID(), principal.id, params.data.accountId, JSON.stringify({ grantId: params.data.grantId })],
      );
      await client.query("COMMIT");
      return send(reply, 200, { id: params.data.grantId, revoked: true });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}
