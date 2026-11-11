// NOTIF-003 §6: an employee's reminder preferences (WhatsApp on/off per rule). Ownership, not a
// permission: the account comes from the session and only its own rows are read or written.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { AUTH_COOKIE_NAME, AuthService, readCookie } from "../auth/service.js";
import { whatsappEnabled } from "./domain.js";
import { REMINDER_RULES, findReminderRule } from "./rules.js";

const ruleParams = z.object({ ruleKey: z.string().max(100) });
const preferenceBody = z.object({ whatsapp: z.boolean() });

function send(reply: FastifyReply, status: number, body: unknown) {
  reply.header("Cache-Control", "no-store");
  return reply.status(status).send(body);
}

export async function registerReminderRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
  injectedAuth?: Pick<AuthService, "getSession">,
) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required for reminder routes");
  const auth = injectedAuth ?? new AuthService(
    pool, config.AUTH_ENCRYPTION_KEY, config.AUTH_SESSION_TTL_HOURS, config.NODE_ENV === "production",
  );

  /** D-14: an active employee account; the same rule decides who receives reminders. */
  async function requireSelf(request: FastifyRequest, reply: FastifyReply) {
    const session = await auth.getSession(readCookie(request.headers.cookie, AUTH_COOKIE_NAME));
    if (!session) {
      await send(reply, 401, { code: "UNAUTHENTICATED", message: "Sesi tidak ditemukan atau sudah berakhir." });
      return null;
    }
    const result = await pool.query<{ accountId: string }>(
      `SELECT account.id AS "accountId"
         FROM accounts account
         JOIN employees employee ON employee.id = account.employee_id
        WHERE account.id = $1 AND account.principal_type = 'EMPLOYEE' AND account.status = 'active'
          AND employee.status = 'active' AND employee.removed_at IS NULL`,
      [session.principal.id],
    );
    if (!result.rows[0]) {
      await send(reply, 403, { code: "EMPLOYEE_LINK_REQUIRED", message: "Pengingat hanya tersedia untuk akun pegawai aktif." });
      return null;
    }
    return result.rows[0].accountId;
  }

  async function preferences(accountId: string) {
    const stored = await pool.query<{ ruleKey: string; whatsappEnabled: boolean }>(
      `SELECT rule_key AS "ruleKey", whatsapp_enabled AS "whatsappEnabled" FROM reminder_preferences WHERE account_id = $1`,
      [accountId],
    );
    const byRule = new Map(stored.rows.map((row) => [row.ruleKey, row.whatsappEnabled]));
    // Bounded: the rule catalog in code. Every rule is listed, relevant or not, so the list does not
    // reveal which roles the account holds.
    return REMINDER_RULES.map((rule) => ({
      ruleKey: rule.key,
      label: rule.label,
      description: rule.description,
      inApp: true,
      whatsapp: whatsappEnabled(rule.defaultWhatsApp, byRule.get(rule.key)),
      whatsappDefault: rule.defaultWhatsApp,
    }));
  }

  app.get("/me/reminders/preferences", async (request, reply) => {
    const accountId = await requireSelf(request, reply);
    if (!accountId) return;
    return send(reply, 200, { items: await preferences(accountId) });
  });

  app.put("/me/reminders/preferences/:ruleKey", async (request, reply) => {
    const accountId = await requireSelf(request, reply);
    if (!accountId) return;
    const params = ruleParams.safeParse(request.params);
    const rule = params.success ? findReminderRule(params.data.ruleKey) : null;
    if (!rule) return send(reply, 404, { code: "REMINDER_RULE_NOT_FOUND", message: "Jenis pengingat tidak dikenal." });
    const body = preferenceBody.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "INVALID_REMINDER_PREFERENCE", message: "Pilih nyala atau mati." });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Make the row exist (holding the rule default), then lock it, so two first saves serialize.
      await client.query(
        `INSERT INTO reminder_preferences (account_id, rule_key, whatsapp_enabled) VALUES ($1,$2,$3)
         ON CONFLICT (account_id, rule_key) DO NOTHING`,
        [accountId, rule.key, rule.defaultWhatsApp],
      );
      const before = await client.query<{ whatsappEnabled: boolean }>(
        `SELECT whatsapp_enabled AS "whatsappEnabled" FROM reminder_preferences
          WHERE account_id = $1 AND rule_key = $2 FOR UPDATE`,
        [accountId, rule.key],
      );
      const previous = whatsappEnabled(rule.defaultWhatsApp, before.rows[0]?.whatsappEnabled);
      await client.query(
        `UPDATE reminder_preferences SET whatsapp_enabled = $3, updated_at = now() WHERE account_id = $1 AND rule_key = $2`,
        [accountId, rule.key, body.data.whatsapp],
      );
      if (previous !== body.data.whatsapp) {
        await client.query(
          `INSERT INTO reminder_audit_events (id, event_type, account_id, rule_key, metadata)
           VALUES ($1, 'reminder.preference.changed', $2, $3, $4::jsonb)`,
          [randomUUID(), accountId, rule.key, JSON.stringify({ whatsapp: { from: previous, to: body.data.whatsapp } })],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return send(reply, 200, { items: await preferences(accountId) });
  });
}
