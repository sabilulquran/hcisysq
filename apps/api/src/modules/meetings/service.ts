// CAL-001 Package 1 persistence shared by the routes and the runner: availability sources,
// row locks, history, reminders and the WhatsApp queue. Spec: docs/domain/meeting-calendar.md.

import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { calculateWorkingDays, decodeWorkingWeekdays } from "../leave/domain/working-calendar.js";
import { notifyEmployee } from "../notifications/service.js";
import {
  BLOCKING_LEAVE_STATUSES,
  BLOCKING_TRIP_STATUSES,
  deliveryKey,
  evaluateAvailability,
  jakartaDateRangeInterval,
  jakartaDatesCovering,
  overlaps,
  reminderFireAt,
  REMINDER_RULE_KEY,
  WARNING_LEAVE_STATUSES,
  WARNING_TRIP_STATUSES,
  type Availability,
  type BusyDates,
  type DeliveryEvent,
  type Interval,
} from "./domain.js";
import { normalizeWhatsAppNumber } from "./whatsapp.js";

export type Queryable = Pool | PoolClient;

export class MeetingError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "MeetingError";
  }
}

export interface ActorEmployee {
  id: string;
  fullName: string;
}

/** §5: an EMPLOYEE account linked to an active, non-removed employee; otherwise 403. */
export async function loadActorEmployee(db: Queryable, accountId: string): Promise<ActorEmployee> {
  const result = await db.query<ActorEmployee & { status: string }>(
    `SELECT employee.id, employee.full_name AS "fullName", employee.status
       FROM accounts account
       JOIN employees employee ON employee.id = account.employee_id
      WHERE account.id = $1
        AND account.principal_type = 'EMPLOYEE'
        AND account.status = 'active'
        AND employee.removed_at IS NULL`,
    [accountId],
  );
  const employee = result.rows[0];
  if (!employee || employee.status !== "active") {
    throw new MeetingError(403, "EMPLOYEE_NOT_ACTIVE", "Akun tidak terhubung ke pegawai aktif.");
  }
  return { id: employee.id, fullName: employee.fullName };
}

/**
 * §6.1 step 1: lock every person involved, in ascending id order so two invitations that
 * share people queue behind each other instead of deadlocking.
 */
export async function lockEmployees(client: PoolClient, ids: readonly string[]) {
  const sorted = [...new Set(ids)].sort();
  if (sorted.length === 0) return;
  await client.query(`SELECT id FROM employees WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [sorted]);
}

/** Names of the people to check; refuses anyone who is not an active employee. */
export async function loadActivePeople(db: Queryable, ids: readonly string[]) {
  const result = await db.query<{ id: string; fullName: string; status: string; removed: boolean }>(
    `SELECT id, full_name AS "fullName", status, removed_at IS NOT NULL AS removed
       FROM employees WHERE id = ANY($1::uuid[])`,
    [[...new Set(ids)]],
  );
  const byId = new Map(result.rows.map((row) => [row.id, row]));
  const inactive = ids.filter((id) => {
    const row = byId.get(id);
    return !row || row.status !== "active" || row.removed;
  });
  if (inactive.length > 0) {
    throw new MeetingError(409, "PARTICIPANT_NOT_ACTIVE", "Ada peserta yang bukan pegawai aktif.", {
      employeeIds: inactive,
    });
  }
  return ids.map((id) => ({ employeeId: id, name: byId.get(id)!.fullName }));
}

async function loadDatedBusy(
  db: Queryable,
  ids: readonly string[],
  firstDate: string,
  lastDate: string,
): Promise<{ leaves: BusyDates[]; trips: BusyDates[] }> {
  // CAL-001 reads employee_id, start_on, end_on and status only (the TRIP-001 read contract).
  // Sequential: `db` may be the transaction's client, which runs one query at a time.
  const leaves = await db.query<BusyDates>(
    `SELECT employee_id AS "employeeId", status,
            to_char(start_on, 'YYYY-MM-DD') AS "startOn", to_char(end_on, 'YYYY-MM-DD') AS "endOn"
       FROM leave_requests
      WHERE employee_id = ANY($1::uuid[]) AND status = ANY($4::text[])
        AND start_on <= $3::date AND end_on >= $2::date`,
    [ids, firstDate, lastDate, [...BLOCKING_LEAVE_STATUSES, ...WARNING_LEAVE_STATUSES]],
  );
  const trips = await db.query<BusyDates>(
    `SELECT employee_id AS "employeeId", status,
            to_char(start_on, 'YYYY-MM-DD') AS "startOn", to_char(end_on, 'YYYY-MM-DD') AS "endOn"
       FROM business_trip_requests
      WHERE employee_id = ANY($1::uuid[]) AND status = ANY($4::text[])
        AND start_on <= $3::date AND end_on >= $2::date`,
    [ids, firstDate, lastDate, [...BLOCKING_TRIP_STATUSES, ...WARNING_TRIP_STATUSES]],
  );
  return { leaves: leaves.rows, trips: trips.rows };
}

/** Non-working WIB dates by leave_calendar_*; none while the work week is not configured. */
export async function loadNonWorkingDates(db: Queryable, firstDate: string, lastDate: string) {
  const setting = await db.query<{ mask: number | null }>(
    `SELECT working_weekday_mask AS mask FROM leave_calendar_settings WHERE singleton = true`,
  );
  const exceptions = await db.query<{ date: string; isWorkingDay: boolean; label: string | null }>(
      `SELECT calendar_date::text AS date, is_working_day AS "isWorkingDay", label
         FROM leave_calendar_exceptions WHERE calendar_date BETWEEN $1::date AND $2::date`,
    [firstDate, lastDate],
  );
  const workingWeekdays = decodeWorkingWeekdays(setting.rows[0]?.mask);
  if (!workingWeekdays) return [];
  const { nonWorkingDates } = calculateWorkingDays(firstDate, lastDate, { workingWeekdays, exceptions: exceptions.rows });
  const labels = new Map(exceptions.rows.map((row) => [row.date, row.label]));
  return nonWorkingDates.map((date) => ({ date, label: labels.get(date) ?? null }));
}

/**
 * §6 against the database. `viewerEmployeeId` decides whether the title of a conflicting
 * confidential meeting may be shown (only when the viewer is in that meeting).
 */
export async function checkAvailability(
  db: Queryable,
  input: {
    interval: Interval;
    people: ReadonlyArray<{ employeeId: string; name: string }>;
    excludeMeetingId: string | null;
    viewerEmployeeId: string;
  },
): Promise<Availability> {
  const ids = input.people.map((person) => person.employeeId);
  const { firstDate, lastDate } = jakartaDatesCovering(input.interval);
  const start = new Date(input.interval.startMs).toISOString();
  const end = new Date(input.interval.endMs).toISOString();
  const meetings = ids.length === 0
    ? { rows: [] as Array<{ employeeId: string; meetingId: string; title: string | null; startAt: Date; endAt: Date }> }
    : await db.query<{ employeeId: string; meetingId: string; title: string | null; startAt: Date; endAt: Date }>(
      `SELECT participant.employee_id AS "employeeId", meeting.id AS "meetingId",
              CASE WHEN meeting.confidential AND NOT EXISTS (
                     SELECT 1 FROM meeting_participants viewer
                      WHERE viewer.meeting_id = meeting.id AND viewer.employee_id = $4)
                   THEN NULL ELSE meeting.title END AS title,
              meeting.start_at AS "startAt", meeting.end_at AS "endAt"
         FROM meeting_participants participant
         JOIN meetings meeting ON meeting.id = participant.meeting_id
        WHERE participant.employee_id = ANY($1::uuid[])
          AND participant.blocks_time
          AND meeting.status = 'ACTIVE'
          AND participant.busy && tstzrange($2::timestamptz, $3::timestamptz, '[)')
          AND ($5::uuid IS NULL OR meeting.id <> $5)`,
      [ids, start, end, input.viewerEmployeeId, input.excludeMeetingId],
    );
  const dated = ids.length === 0 ? { leaves: [], trips: [] } : await loadDatedBusy(db, ids, firstDate, lastDate);
  const nonWorking = await loadNonWorkingDates(db, firstDate, lastDate);
  return evaluateAvailability({
    interval: input.interval,
    people: input.people,
    meetings: meetings.rows.map((row) => ({
      employeeId: row.employeeId,
      meetingId: row.meetingId,
      title: row.title,
      startMs: row.startAt.getTime(),
      endMs: row.endAt.getTime(),
    })),
    leaves: dated.leaves,
    trips: dated.trips,
    nonWorkingDates: nonWorking.map((day) => day.date),
  });
}

/** §7.5 (K-08): participants on approved leave or an approved/issued trip during the meeting. */
export async function loadUnavailability(db: Queryable, ids: readonly string[], interval: Interval) {
  const { firstDate, lastDate } = jakartaDatesCovering(interval);
  const { leaves, trips } = await loadDatedBusy(db, ids, firstDate, lastDate);
  const reasons = new Map<string, "LEAVE" | "TRIP">();
  for (const [rows, statuses, reason] of [
    [leaves, BLOCKING_LEAVE_STATUSES, "LEAVE"],
    [trips, BLOCKING_TRIP_STATUSES, "TRIP"],
  ] as const) {
    for (const row of rows) {
      if ((statuses as readonly string[]).includes(row.status) && !reasons.has(row.employeeId)
        && overlaps(interval, jakartaDateRangeInterval(row.startOn, row.endOn))) {
        reasons.set(row.employeeId, reason);
      }
    }
  }
  return reasons;
}

export async function addMeetingEvent(
  db: PoolClient,
  meetingId: string,
  actorAccountId: string | null,
  eventType: string,
  metadata: Record<string, unknown> = {},
) {
  // clock_timestamp(): several events of one transaction keep their order in the history.
  await db.query(
    `INSERT INTO meeting_events (id, meeting_id, event_type, actor_account_id, metadata, occurred_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, clock_timestamp())`,
    [randomUUID(), meetingId, eventType, actorAccountId, JSON.stringify(metadata)],
  );
}

/**
 * §9.3: one pending reminder per person who has not declined, 30 minutes before the start.
 * A reminder that already fired for the same time stays fired; a new time fires again. None
 * at all when the meeting starts in less than 30 minutes.
 */
export async function syncReminders(db: PoolClient, meetingId: string, startMs: number, nowMs = Date.now()) {
  const fireAt = reminderFireAt(startMs, nowMs);
  await db.query(
    `UPDATE meeting_reminders reminder SET cancelled_at = now()
      WHERE reminder.meeting_id = $1 AND reminder.fired_at IS NULL AND reminder.cancelled_at IS NULL
        AND ($2::timestamptz IS NULL OR NOT EXISTS (
              SELECT 1 FROM meeting_participants participant
               WHERE participant.meeting_id = reminder.meeting_id
                 AND participant.employee_id = reminder.employee_id
                 AND participant.response <> 'DECLINED'))`,
    [meetingId, fireAt === null ? null : new Date(fireAt).toISOString()],
  );
  if (fireAt === null) return;
  await db.query(
    `INSERT INTO meeting_reminders (id, meeting_id, employee_id, rule_key, fire_at)
     SELECT gen_random_uuid(), participant.meeting_id, participant.employee_id, $2::text, $3::timestamptz
       FROM meeting_participants participant
      WHERE participant.meeting_id = $1 AND participant.response <> 'DECLINED'
     ON CONFLICT (meeting_id, employee_id, rule_key) DO UPDATE
       SET fire_at = EXCLUDED.fire_at,
           cancelled_at = NULL,
           fired_at = CASE WHEN meeting_reminders.fire_at = EXCLUDED.fire_at THEN meeting_reminders.fired_at ELSE NULL END`,
    [meetingId, REMINDER_RULE_KEY, new Date(fireAt).toISOString()],
  );
}

/** Cancels the not-yet-fired reminders of some people, or of everybody when `employeeIds` is null. */
export async function cancelReminders(db: PoolClient, meetingId: string, employeeIds: readonly string[] | null) {
  await db.query(
    `UPDATE meeting_reminders SET cancelled_at = now()
      WHERE meeting_id = $1 AND fired_at IS NULL AND cancelled_at IS NULL
        AND ($2::uuid[] IS NULL OR employee_id = ANY($2::uuid[]))`,
    [meetingId, employeeIds],
  );
}

/**
 * §9.2: queue one WhatsApp message per person with a usable number; the runner hands it to
 * Kirim SQ after COMMIT, so the request never waits for SQ Hub. Returns who was skipped
 * for lack of a number.
 */
export async function enqueueWhatsApp(
  db: PoolClient,
  input: { meetingId: string; employeeIds: readonly string[]; event: DeliveryEvent; version: number },
) {
  if (input.employeeIds.length === 0) return { queued: 0, withoutNumber: [] as string[] };
  const phones = await db.query<{ id: string; phone: string | null }>(
    `SELECT id, phone FROM employees WHERE id = ANY($1::uuid[])`,
    [[...input.employeeIds]],
  );
  const reachable = phones.rows.filter((row) => normalizeWhatsAppNumber(row.phone) !== null).map((row) => row.id);
  const withoutNumber = input.employeeIds.filter((id) => !reachable.includes(id));
  for (const employeeId of reachable) {
    // A queued invitation is rendered from the current meeting at hand-over, so a change made
    // before it left needs no second message (it would say "berubah" before "undangan").
    await db.query(
      `INSERT INTO meeting_notification_deliveries
         (id, meeting_id, employee_id, event, version, idempotency_key, status)
       SELECT $1::uuid, $2::uuid, $3::uuid, $4::text, $5::integer, $6::text, 'QUEUED'
        WHERE $4::text <> 'rescheduled' OR NOT EXISTS (
          SELECT 1 FROM meeting_notification_deliveries queued
           WHERE queued.meeting_id = $2::uuid AND queued.employee_id = $3::uuid
             AND queued.event = 'invited' AND queued.status = 'QUEUED')
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [randomUUID(), input.meetingId, employeeId, input.event, input.version,
        deliveryKey(input.meetingId, employeeId, input.event, input.version)],
    );
  }
  return { queued: reachable.length, withoutNumber };
}

/** Queued messages that no longer make sense (cancelled meeting, removed or declined person). */
export async function skipQueuedWhatsApp(
  db: PoolClient,
  meetingId: string,
  employeeIds: readonly string[] | null,
  events: readonly DeliveryEvent[],
  errorCode: string,
) {
  await db.query(
    `UPDATE meeting_notification_deliveries
        SET status = 'SKIPPED', error_code = $4, updated_at = now()
      WHERE meeting_id = $1 AND status = 'QUEUED'
        AND ($2::uuid[] IS NULL OR employee_id = ANY($2::uuid[]))
        AND event = ANY($3::text[])`,
    [meetingId, employeeIds, [...events], errorCode],
  );
}

export function meetingHref(meetingId: string) {
  return `/app/calendar?meeting=${meetingId}`;
}

/** NOTIF-004 in-app, category `system`; people without an active account are skipped (K-13). */
export async function notifyPeople(
  db: PoolClient,
  employeeIds: readonly string[],
  input: { eventKey: (employeeId: string) => string; title: string; body: string; href: string; actorAccountId: string | null },
) {
  for (const employeeId of employeeIds) {
    await notifyEmployee(db, employeeId, {
      eventKey: input.eventKey(employeeId),
      category: "system",
      title: input.title,
      body: input.body,
      href: input.href,
      actorAccountId: input.actorAccountId,
    });
  }
}
