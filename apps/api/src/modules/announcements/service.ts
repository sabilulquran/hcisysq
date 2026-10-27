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
 * N-07/N-08: what a reader sees is derived here, never written by a job. A SCHEDULED
 * announcement whose moment has passed reads as published; a published one past its display
 * window reads as archived. The stored status only records what an operator decided.
 */
export function visibleState(
  row: { status: string; publishAt: Date | string | null; displayUntil: string | null },
  now: Date,
): "HIDDEN" | "PUBLISHED" | "ARCHIVED" | "SUPERSEDED" {
  if (row.status === "SUPERSEDED") return "SUPERSEDED";
  if (row.status === "ARCHIVED") return "ARCHIVED";
  if (row.status === "DRAFT") return "HIDDEN";
  if (row.status === "SCHEDULED") {
    const due = row.publishAt ? new Date(row.publishAt).getTime() <= now.getTime() : false;
    if (!due) return "HIDDEN";
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
 */
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
