// NOTIF-003 reminder engine (docs/domain/reminders.md §5). Runs inside the API process next to the
// CAL-001 meeting runner and behind the same switch (D-01). Idempotent by construction: a rule runs
// once per Jakarta day (reminder_rule_runs), an occurrence exists once per recipient
// (reminder_occurrences), the in-app event key is unique (NOTIF-004), and WhatsApp deliveries are
// claimed with FOR UPDATE SKIP LOCKED and handed over with a fixed idempotency key.

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";

import type { ApiConfig } from "../../config/env.js";
import { publicOrigin } from "../auth/csrf.js";
import { retryDelayMs } from "../meetings/domain.js";
import {
  createWhatsAppSender,
  normalizeWhatsAppNumber,
  whatsappAllowlist,
  WhatsAppRejectedError,
  WhatsAppRetryableError,
  type WhatsAppSender,
} from "../meetings/whatsapp.js";
import { notifyAccount } from "../notifications/service.js";
import { endOfSendWindow, insideSendWindow, jakartaClock, ruleIsDue, whatsappEnabled } from "./domain.js";
import { REMINDER_RULES, type ReminderRule } from "./rules.js";

const CLAIM_LEASE = "5 minutes";
const DELIVERY_BATCH = 5;

export interface ReminderEngineOptions {
  device?: string | undefined;
  /** CAL-001 K-17 / D-11: NIPs that may receive real WhatsApp; null lifts it. Required on purpose. */
  allowlist: ReadonlySet<string> | null;
  origin: string | null;
  rules?: readonly ReminderRule[];
  now?: () => Date;
}

export interface RuleRunResult {
  ruleKey: string;
  status: "RAN" | "SKIPPED" | "FAILED";
  generated: number;
}

export class ReminderEngine {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly sender: WhatsAppSender,
    private readonly options: ReminderEngineOptions,
    private readonly log: { error: (object: unknown, message: string) => void } = { error: () => {} },
  ) {}

  private now() {
    return this.options.now?.() ?? new Date();
  }

  private get rules() {
    return this.options.rules ?? REMINDER_RULES;
  }

  /** One pass: due rules first, then WhatsApp hand-over. Nothing at all outside 06:00–21:00 WIB (D-04). */
  async tick(): Promise<{ runs: RuleRunResult[]; delivered: number }> {
    const now = this.now();
    if (!insideSendWindow(now)) return { runs: [], delivered: 0 };
    const runs: RuleRunResult[] = [];
    for (const rule of this.rules) {
      if (ruleIsDue(rule, now)) runs.push(await this.runRule(rule, now));
    }
    return { runs, delivered: await this.handOverDeliveries() };
  }

  start(intervalMs = 60_000) {
    if (this.timer) return;
    const run = () => {
      if (this.running) return;
      this.running = this.tick()
        .catch((error: unknown) => this.log.error({ error: error instanceof Error ? error.name : typeof error }, "reminder engine tick failed"))
        .finally(() => { this.running = null; });
    };
    this.timer = setInterval(run, intervalMs);
    this.timer.unref();
    setTimeout(run, 7_000).unref();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  /**
   * §5.1–§5.3: claims today's run row first. A second runner blocks on that row until the first
   * commits and then skips. A failed rule records its failure and is not retried the same day (D-05).
   */
  async runRule(rule: ReminderRule, now = this.now()): Promise<RuleRunResult> {
    const runDate = jakartaClock(now).date;
    const client = await this.pool.connect();
    let claimed = false;
    try {
      await client.query("BEGIN");
      const claim = await client.query(
        `INSERT INTO reminder_rule_runs (rule_key, run_date) VALUES ($1, $2::date)
         ON CONFLICT (rule_key, run_date) DO NOTHING RETURNING rule_key`,
        [rule.key, runDate],
      );
      if (!claim.rows[0]) {
        await client.query("COMMIT");
        return { ruleKey: rule.key, status: "SKIPPED", generated: 0 };
      }
      claimed = true;
      const generated = await this.generate(client, rule, runDate, now);
      await client.query(
        `UPDATE reminder_rule_runs SET finished_at = now(), generated = $3 WHERE rule_key = $1 AND run_date = $2::date`,
        [rule.key, runDate, generated],
      );
      await client.query("COMMIT");
      return { ruleKey: rule.key, status: "RAN", generated };
    } catch (error) {
      await client.query("ROLLBACK");
      if (!claimed) throw error;
      // A SQLSTATE or the error's class name only: a database message can quote row values.
      const sqlState = (error as { code?: unknown }).code;
      const errorCode = typeof sqlState === "string" ? `sqlstate_${sqlState}` : error instanceof Error ? error.name : "unknown";
      this.log.error({ ruleKey: rule.key, error: errorCode }, "reminder rule failed");
      await this.pool.query(
        `INSERT INTO reminder_rule_runs (rule_key, run_date, finished_at, generated, error_code)
         VALUES ($1, $2::date, now(), 0, $3)
         ON CONFLICT (rule_key, run_date) DO NOTHING`,
        [rule.key, runDate, errorCode.slice(0, 100)],
      );
      return { ruleKey: rule.key, status: "FAILED", generated: 0 };
    } finally {
      client.release();
    }
  }

  private async generate(client: PoolClient, rule: ReminderRule, today: string, now: Date) {
    const candidates = await rule.generate(client, { today });
    if (!candidates.length) return 0;
    const preferences = await client.query<{ accountId: string; whatsappEnabled: boolean }>(
      `SELECT account_id AS "accountId", whatsapp_enabled AS "whatsappEnabled" FROM reminder_preferences WHERE rule_key = $1`,
      [rule.key],
    );
    const stored = new Map(preferences.rows.map((row) => [row.accountId, row.whatsappEnabled]));
    let created = 0;
    for (const candidate of candidates) {
      const occurrenceId = randomUUID();
      const inserted = await client.query(
        `INSERT INTO reminder_occurrences (id, rule_key, occurrence_key, recipient_account_id, recipient_employee_id, title, href)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (rule_key, occurrence_key, recipient_account_id) DO NOTHING
         RETURNING id`,
        [occurrenceId, rule.key, candidate.occurrenceKey, candidate.accountId, candidate.employeeId, candidate.title, candidate.href],
      );
      if (!inserted.rows[0]) continue;
      created += 1;
      await notifyAccount(client, {
        recipientAccountId: candidate.accountId,
        eventKey: `reminder.${rule.key}.${candidate.occurrenceKey}`,
        category: "system",
        title: candidate.title,
        body: candidate.body,
        href: candidate.href,
        metadata: { reminderRule: rule.key },
      });
      if (candidate.employeeId && whatsappEnabled(rule.defaultWhatsApp, stored.get(candidate.accountId))) {
        await client.query(
          `INSERT INTO reminder_deliveries (id, occurrence_id, employee_id, message_text, expires_at, idempotency_key)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [randomUUID(), occurrenceId, candidate.employeeId, candidate.whatsappText, endOfSendWindow(now),
            `hcis-reminder:${occurrenceId}`],
        );
      }
    }
    return created;
  }

  /** §5.4, the CAL-001 §9.2 pattern: claim with a lease, call Kirim SQ outside a transaction, record. */
  async handOverDeliveries(): Promise<number> {
    if (!insideSendWindow(this.now())) return 0;
    // D-12: past 21:00 WIB of its day a reminder is no longer worth a message.
    await this.pool.query(
      `UPDATE reminder_deliveries SET status = 'SKIPPED', error_code = 'expired', updated_at = now()
        WHERE status = 'QUEUED' AND expires_at <= now()`,
    );
    const claimed = await this.pool.query<{
      id: string; employeeId: string; text: string; expiresAt: Date; idempotencyKey: string; attempts: number;
      ruleKey: string; href: string;
    }>(
      `WITH due AS (
         SELECT id FROM reminder_deliveries
          WHERE status = 'QUEUED' AND next_attempt_at <= now() AND expires_at > now()
          ORDER BY next_attempt_at ASC, id ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE reminder_deliveries delivery
          SET attempts = delivery.attempts + 1, next_attempt_at = now() + interval '${CLAIM_LEASE}', updated_at = now()
         FROM due, reminder_occurrences occurrence
        WHERE delivery.id = due.id AND occurrence.id = delivery.occurrence_id
       RETURNING delivery.id, delivery.employee_id AS "employeeId", delivery.message_text AS text,
                 delivery.expires_at AS "expiresAt", delivery.idempotency_key AS "idempotencyKey", delivery.attempts,
                 occurrence.rule_key AS "ruleKey", occurrence.href`,
      [DELIVERY_BATCH],
    );
    let delivered = 0;
    for (const row of claimed.rows) {
      if (await this.deliver(row)) delivered += 1;
    }
    return delivered;
  }

  private async finish(id: string, status: string, fields: { messageId?: string | null; errorCode?: string | null; retryInMs?: number }) {
    await this.pool.query(
      `UPDATE reminder_deliveries
          SET status = $2, kirim_message_id = COALESCE($3, kirim_message_id), error_code = $4,
              next_attempt_at = CASE WHEN $5::bigint IS NULL THEN next_attempt_at
                                     ELSE now() + ($5::bigint * interval '1 millisecond') END,
              updated_at = now()
        WHERE id = $1 AND status = 'QUEUED'`,
      [id, status, fields.messageId ?? null, fields.errorCode ?? null, fields.retryInMs ?? null],
    );
  }

  private async deliver(row: {
    id: string; employeeId: string; text: string; expiresAt: Date; idempotencyKey: string; attempts: number;
    ruleKey: string; href: string;
  }) {
    const recipient = await this.pool.query<{ phone: string | null; employeeNumber: string | null; active: boolean }>(
      `SELECT employee.phone, employee.employee_number AS "employeeNumber",
              (employee.status = 'active' AND employee.removed_at IS NULL) AS active
         FROM employees employee WHERE employee.id = $1`,
      [row.employeeId],
    );
    const person = recipient.rows[0];
    if (!person?.active) {
      await this.finish(row.id, "SKIPPED", { errorCode: "inactive" });
      return false;
    }
    const to = normalizeWhatsAppNumber(person.phone);
    if (!to) {
      await this.finish(row.id, "SKIPPED", { errorCode: "no_phone" });
      return false;
    }
    if (this.sender.name === "kirim" && this.options.allowlist
      && !(person.employeeNumber && this.options.allowlist.has(person.employeeNumber))) {
      await this.finish(row.id, "SKIPPED", { errorCode: "not_allowlisted" });
      return false;
    }
    try {
      const result = await this.sender.send({
        device: this.options.device,
        to,
        text: this.options.origin ? `${row.text}\n${this.options.origin}${row.href}` : row.text,
        expiresAt: row.expiresAt.toISOString(),
        ref: `rem:${row.ruleKey}`,
        idempotencyKey: row.idempotencyKey,
      });
      await this.finish(row.id, result.dryRun ? "DRY_RUN" : "HANDED_OVER", { messageId: result.id });
      return true;
    } catch (error) {
      if (error instanceof WhatsAppRejectedError) {
        await this.finish(row.id, "FAILED", { errorCode: error.code });
        return false;
      }
      const code = error instanceof WhatsAppRetryableError ? error.code : "unexpected";
      if (!(error instanceof WhatsAppRetryableError)) {
        this.log.error({ error: error instanceof Error ? error.name : typeof error, deliveryId: row.id },
          "reminder WhatsApp hand-over failed unexpectedly");
      }
      const delay = retryDelayMs(row.attempts);
      if (delay === null) await this.finish(row.id, "FAILED", { errorCode: code });
      else await this.finish(row.id, "QUEUED", { errorCode: code, retryInMs: delay });
      return false;
    }
  }
}

/** Starts with the server (not in tests, not in a release candidate), stops on close (D-01). */
export function registerReminderEngine(app: FastifyInstance, pool: Pool, config: ApiConfig) {
  if (config.NODE_ENV === "test" || config.MEETING_RUNNER_ENABLED !== "1") return null;
  const sender = createWhatsAppSender(config, {
    log: (entry) => app.log.info({ whatsapp: entry }, "whatsapp dry run (adapter log)"),
  });
  const engine = new ReminderEngine(
    pool,
    sender,
    { device: config.KIRIM_DEVICE_HCIS, origin: publicOrigin(config), allowlist: whatsappAllowlist(config) },
    app.log,
  );
  app.addHook("onReady", async () => engine.start());
  app.addHook("onClose", async () => engine.stop());
  return engine;
}
