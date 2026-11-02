// CAL-001 §9.3 runner (NOTIF-003 first rule): a 60-second loop inside the API process that
// fires due meeting reminders and hands queued WhatsApp messages to Kirim SQ. No separate
// process or cron on Mi8VPS. Rows are claimed with FOR UPDATE SKIP LOCKED, so two runners
// never fire the same reminder or send the same message twice.

import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import type { ApiConfig } from "../../config/env.js";
import { publicOrigin } from "../auth/csrf.js";
import { formatWibRange, retryDelayMs, whatsappText, type DeliveryEvent } from "./domain.js";
import { enqueueWhatsApp, meetingHref, notifyPeople } from "./service.js";
import {
  createWhatsAppSender,
  normalizeWhatsAppNumber,
  WhatsAppRejectedError,
  WhatsAppRetryableError,
  type WhatsAppSender,
} from "./whatsapp.js";

export interface MeetingRunnerOptions {
  device: string;
  /** `https://hcis…` for the link in a message; null leaves the link out. */
  origin: string | null;
  batchSize?: number;
}

export interface TickResult {
  remindersFired: number;
  remindersCancelled: number;
  delivered: number;
}

/** Seconds a claimed delivery stays invisible to other runners while its HTTP call runs. */
const CLAIM_LEASE = "2 minutes";

export class MeetingRunner {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly sender: WhatsAppSender,
    private readonly options: MeetingRunnerOptions,
    private readonly log: { error: (object: unknown, message: string) => void } = { error: () => {} },
  ) {}

  /** One pass: reminders first, so a reminder queued now is handed over in the same pass. */
  async tick(): Promise<TickResult> {
    const reminders = await this.fireDueReminders();
    const delivered = await this.handOverDeliveries();
    return { ...reminders, delivered };
  }

  start(intervalMs = 60_000) {
    if (this.timer) return;
    const run = () => {
      if (this.running) return;
      this.running = this.tick()
        .catch((error: unknown) => this.log.error({ err: error }, "meeting runner tick failed"))
        .finally(() => { this.running = null; });
    };
    this.timer = setInterval(run, intervalMs);
    this.timer.unref();
    setTimeout(run, 5_000).unref();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  /**
   * §9.3: re-checks at fire time that the meeting is still active and not started and that the
   * person is still in it and has not declined (the legacy defect fired reminders for cancelled
   * agendas). `fired_at` is set in the same transaction as the notification.
   */
  async fireDueReminders(): Promise<{ remindersFired: number; remindersCancelled: number }> {
    const client = await this.pool.connect();
    let fired = 0;
    let cancelled = 0;
    try {
      await client.query("BEGIN");
      const due = await client.query<{
        id: string; meetingId: string; employeeId: string; eligible: boolean; title: string; startAt: Date; endAt: Date;
        location: string | null; version: number; organizerName: string;
      }>(
        `SELECT reminder.id, reminder.meeting_id AS "meetingId", reminder.employee_id AS "employeeId",
                (meeting.status = 'ACTIVE' AND meeting.start_at > now()
                  AND participant.employee_id IS NOT NULL AND participant.response <> 'DECLINED') AS eligible,
                meeting.title, meeting.start_at AS "startAt", meeting.end_at AS "endAt", meeting.location,
                meeting.version, organizer.full_name AS "organizerName"
           FROM meeting_reminders reminder
           JOIN meetings meeting ON meeting.id = reminder.meeting_id
           JOIN employees organizer ON organizer.id = meeting.organizer_employee_id
           LEFT JOIN meeting_participants participant
             ON participant.meeting_id = reminder.meeting_id AND participant.employee_id = reminder.employee_id
          WHERE reminder.fired_at IS NULL AND reminder.cancelled_at IS NULL AND reminder.fire_at <= now()
          ORDER BY reminder.fire_at ASC, reminder.id ASC
          LIMIT $1
          FOR UPDATE OF reminder SKIP LOCKED`,
        [this.options.batchSize ?? 100],
      );
      for (const reminder of due.rows) {
        if (!reminder.eligible) {
          await client.query(`UPDATE meeting_reminders SET cancelled_at = now() WHERE id = $1`, [reminder.id]);
          cancelled += 1;
          continue;
        }
        const startMs = reminder.startAt.getTime();
        await notifyPeople(client, [reminder.employeeId], {
          eventKey: () => `meeting.${reminder.meetingId}.reminder.${startMs}`,
          title: "Rapat mulai 30 menit lagi",
          body: `"${reminder.title}", ${formatWibRange(startMs, reminder.endAt.getTime())}${reminder.location ? ` di ${reminder.location}` : ""}.`,
          href: meetingHref(reminder.meetingId),
          actorAccountId: null,
        });
        // K-14: the WhatsApp reminder goes out whenever there is a number.
        await enqueueWhatsApp(client, {
          meetingId: reminder.meetingId, employeeIds: [reminder.employeeId], event: "reminder", version: reminder.version,
        });
        await client.query(`UPDATE meeting_reminders SET fired_at = now() WHERE id = $1`, [reminder.id]);
        fired += 1;
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return { remindersFired: fired, remindersCancelled: cancelled };
  }

  /**
   * §9.2: claims due rows with a short lease (attempts + 1), calls Kirim SQ outside any
   * transaction, then records the outcome. A crash mid-call leaves the row to be retried after
   * the lease with the same idempotency key, which Kirim SQ deduplicates.
   */
  async handOverDeliveries(): Promise<number> {
    const claimed = await this.pool.query<{
      id: string; meetingId: string; employeeId: string; event: DeliveryEvent; idempotencyKey: string; attempts: number;
    }>(
      `WITH due AS (
         SELECT id FROM meeting_notification_deliveries
          WHERE status = 'QUEUED' AND next_attempt_at <= now()
          ORDER BY next_attempt_at ASC, id ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE meeting_notification_deliveries delivery
          SET attempts = delivery.attempts + 1, next_attempt_at = now() + interval '${CLAIM_LEASE}', updated_at = now()
         FROM due WHERE delivery.id = due.id
       RETURNING delivery.id, delivery.meeting_id AS "meetingId", delivery.employee_id AS "employeeId",
                 delivery.event, delivery.idempotency_key AS "idempotencyKey", delivery.attempts`,
      [this.options.batchSize ?? 20],
    );
    let delivered = 0;
    for (const row of claimed.rows) {
      if (await this.deliver(row)) delivered += 1;
    }
    return delivered;
  }

  private async finish(id: string, status: string, fields: { messageId?: string | null; errorCode?: string | null; retryInMs?: number }) {
    await this.pool.query(
      `UPDATE meeting_notification_deliveries
          SET status = $2, kirim_message_id = COALESCE($3, kirim_message_id), error_code = $4,
              next_attempt_at = CASE WHEN $5::bigint IS NULL THEN next_attempt_at
                                     ELSE now() + ($5::bigint * interval '1 millisecond') END,
              updated_at = now()
        WHERE id = $1 AND status = 'QUEUED'`,
      [id, status, fields.messageId ?? null, fields.errorCode ?? null, fields.retryInMs ?? null],
    );
  }

  private async deliver(row: { id: string; meetingId: string; employeeId: string; event: DeliveryEvent; idempotencyKey: string; attempts: number }) {
    const facts = await this.pool.query<{
      title: string; startAt: Date; endAt: Date; location: string | null; status: string; started: boolean;
      organizerName: string; phone: string | null; attending: boolean;
    }>(
      `SELECT meeting.title, meeting.start_at AS "startAt", meeting.end_at AS "endAt", meeting.location, meeting.status,
              meeting.start_at <= now() AS started, organizer.full_name AS "organizerName", recipient.phone,
              EXISTS (SELECT 1 FROM meeting_participants participant
                       WHERE participant.meeting_id = meeting.id AND participant.employee_id = recipient.id
                         AND participant.response <> 'DECLINED') AS attending
         FROM meetings meeting
         JOIN employees organizer ON organizer.id = meeting.organizer_employee_id
         JOIN employees recipient ON recipient.id = $2
        WHERE meeting.id = $1`,
      [row.meetingId, row.employeeId],
    );
    const meeting = facts.rows[0];
    if (!meeting) return false;
    // kedaluwarsa = startAt (§9.2): nothing is sent once the meeting has started.
    if (meeting.started) {
      await this.finish(row.id, "SKIPPED", { errorCode: "expired" });
      return false;
    }
    const aboutAttendance = row.event === "invited" || row.event === "rescheduled" || row.event === "reminder";
    if (aboutAttendance && (meeting.status !== "ACTIVE" || !meeting.attending)) {
      await this.finish(row.id, "SKIPPED", { errorCode: "superseded" });
      return false;
    }
    const to = normalizeWhatsAppNumber(meeting.phone);
    if (!to) {
      await this.finish(row.id, "SKIPPED", { errorCode: "no_phone" });
      return false;
    }
    const startMs = meeting.startAt.getTime();
    try {
      const result = await this.sender.send({
        device: this.options.device,
        to,
        text: whatsappText(row.event, {
          title: meeting.title,
          startMs,
          endMs: meeting.endAt.getTime(),
          location: meeting.location,
          organizerName: meeting.organizerName,
          link: this.options.origin ? `${this.options.origin}${meetingHref(row.meetingId)}` : null,
        }),
        expiresAt: meeting.startAt.toISOString(),
        ref: `cal:${row.meetingId}:${row.event}`,
        idempotencyKey: row.idempotencyKey,
      });
      await this.finish(row.id, result.dryRun ? "DRY_RUN" : "HANDED_OVER", { messageId: result.id });
      return true;
    } catch (error) {
      if (error instanceof WhatsAppRetryableError) {
        const delay = retryDelayMs(row.attempts);
        if (delay === null) await this.finish(row.id, "FAILED", { errorCode: error.code });
        else await this.finish(row.id, "QUEUED", { errorCode: error.code, retryInMs: delay });
        return false;
      }
      if (error instanceof WhatsAppRejectedError) {
        await this.finish(row.id, "FAILED", { errorCode: error.code });
        return false;
      }
      throw error;
    }
  }
}

/** Starts the runner with the server (not in tests), and stops it on close. */
export function registerMeetingRunner(app: FastifyInstance, pool: Pool, config: ApiConfig) {
  if (config.NODE_ENV === "test" || config.MEETING_RUNNER_ENABLED !== "1") return null;
  const sender = createWhatsAppSender(config, {
    log: (entry) => app.log.info({ whatsapp: entry }, "whatsapp dry run (adapter log)"),
  });
  const runner = new MeetingRunner(pool, sender, { device: config.KIRIM_DEVICE_HCIS, origin: publicOrigin(config) }, app.log);
  app.addHook("onReady", async () => runner.start());
  app.addHook("onClose", async () => runner.stop());
  return runner;
}
