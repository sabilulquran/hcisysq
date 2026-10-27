// NOTIF-002 Package 1 service: publication, recipient snapshot, derived state, audit.
// Spec: docs/domain/announcements-and-reminders.md.

import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

type QueryTarget = Pool | PoolClient;

export const ANNOUNCEMENT_LEVELS = ["NORMAL", "PENTING"] as const;
export type AnnouncementLevel = (typeof ANNOUNCEMENT_LEVELS)[number];

export class AnnouncementError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = "AnnouncementError";
  }
}

/** Same Jakarta calendar the rest of HCIS reads dates in. */
const JAKARTA_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit",
});

export function jakartaDate(instant: Date): string {
  return JAKARTA_DATE.format(instant);
}

/**
 * N-08: the display window is derived here, never written by a job, so the data is correct
 * without anything having to run.
 *
 * N-07: Package 1 has no auto-publication. A SCHEDULED announcement has no recipients until
 * an operator publishes it, so it stays HIDDEN however long its moment has passed; DUE only
 * tells the operator it is waiting. Treating a passed moment as PUBLISHED would label a row
 * "Terbit" that nobody received.
 */
export function visibleState(
  row: { status: string; publishAt: Date | string | null; displayUntil: string | null },
  now: Date,
): "HIDDEN" | "DUE" | "PUBLISHED" | "ARCHIVED" | "SUPERSEDED" {
  if (row.status === "SUPERSEDED") return "SUPERSEDED";
  if (row.status === "ARCHIVED") return "ARCHIVED";
  if (row.status === "DRAFT") return "HIDDEN";
  if (row.status === "SCHEDULED") {
    const due = row.publishAt ? new Date(row.publishAt).getTime() <= now.getTime() : false;
    return due ? "DUE" : "HIDDEN";
  }
  if (row.displayUntil && row.displayUntil < jakartaDate(now)) return "ARCHIVED";
  return "PUBLISHED";
}

export async function writeAnnouncementAudit(
  db: QueryTarget,
  event: {
    eventType: string;
    announcementId?: string | null;
    actorAccountId?: string | null;
    reason?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  await db.query(
    `INSERT INTO announcement_audit_events (id, event_type, announcement_id, actor_account_id, reason, metadata)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [
      randomUUID(), event.eventType, event.announcementId ?? null, event.actorAccountId ?? null,
      event.reason ?? null, JSON.stringify(event.metadata ?? {}),
    ],
  );
}

/**
 * N-03: freeze the recipient list. Active employees only, matched by the announcement's own
 * audience rules; ON CONFLICT DO NOTHING makes a retried publication idempotent
 * (NOTIF-002-B) rather than duplicating rows.
 *
 * N-06 (D-03 of this spec): a correction inherits the superseded announcement's recipients
 * instead, so the people who read the original are exactly the people who get the ralat.
 */
export async function inheritRecipients(client: PoolClient, announcementId: string, fromId: string) {
  await client.query(
    `INSERT INTO announcement_recipients (id, announcement_id, employee_id)
     SELECT gen_random_uuid(), $1, source.employee_id
       FROM announcement_recipients source
      WHERE source.announcement_id = $2
     ON CONFLICT (announcement_id, employee_id) DO NOTHING`,
    [announcementId, fromId],
  );
}

/** The snapshot's size, which is what reach means; the insert's rowCount is only what it added. */
export async function countRecipients(client: PoolClient, announcementId: string): Promise<number> {
  const result = await client.query<{ total: number }>(
    "SELECT count(*)::int AS total FROM announcement_recipients WHERE announcement_id = $1",
    [announcementId],
  );
  return result.rows[0]?.total ?? 0;
}

/**
 * One set-based insert instead of two statements per recipient: on ~100 employees the loop
 * held the publication transaction open for ~200 round trips, long enough to outlive an HTTP
 * timeout while still committing. It also counts employees without an active account, who
 * are in reach but can receive nothing.
 */
export async function notifyRecipients(
  client: PoolClient,
  announcementId: string,
  title: string,
  body: string,
) {
  await client.query(
    `INSERT INTO in_app_notifications (id, recipient_account_id, event_key, category, title, body, href)
     SELECT gen_random_uuid(), account.id, $2, 'system', $3, $4, '/app/announcements'
       FROM announcement_recipients recipient
       JOIN accounts account ON account.employee_id = recipient.employee_id
       JOIN employees employee ON employee.id = recipient.employee_id
      WHERE recipient.announcement_id = $1
        AND account.principal_type = 'EMPLOYEE'
        AND account.status = 'active'
        AND employee.status = 'active'
     ON CONFLICT (recipient_account_id, event_key) DO NOTHING`,
    [announcementId, `announcement.${announcementId}`, title, body],
  );
}

export async function snapshotRecipients(client: PoolClient, announcementId: string): Promise<number> {
  const result = await client.query(
    `INSERT INTO announcement_recipients (id, announcement_id, employee_id)
     SELECT gen_random_uuid(), $1, employee.id
       FROM employees employee
      WHERE employee.status = 'active'
        AND EXISTS (
          SELECT 1
            FROM announcement_audiences audience
           WHERE audience.announcement_id = $1
             AND (
               audience.audience_kind = 'ALL_EMPLOYEES'
               OR (audience.audience_kind = 'UNIT'
                   AND employee.organizational_unit_id = audience.organizational_unit_id)
             )
        )
     ON CONFLICT (announcement_id, employee_id) DO NOTHING`,
    [announcementId],
  );
  return result.rowCount ?? 0;
}

export function assertPublishable(row: { status: string }) {
  if (row.status === "PUBLISHED") {
    throw new AnnouncementError(409, "ANNOUNCEMENT_ALREADY_PUBLISHED", "Pengumuman ini sudah terbit.");
  }
  if (row.status !== "DRAFT" && row.status !== "SCHEDULED") {
    throw new AnnouncementError(409, "ANNOUNCEMENT_NOT_PUBLISHABLE", "Pengumuman ini tidak dapat diterbitkan lagi.");
  }
}

/** N-06: an issued announcement is never edited in place. */
export function assertEditable(row: { status: string }) {
  if (row.status !== "DRAFT" && row.status !== "SCHEDULED") {
    throw new AnnouncementError(
      409,
      "ANNOUNCEMENT_NOT_EDITABLE",
      "Pengumuman yang sudah terbit tidak dapat diubah; terbitkan ralat.",
    );
  }
}
