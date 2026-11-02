// CAL-001 Package 1 routes: invitations that block the participants' time, responses, edit
// and cancel by the organizer, and the foundation-wide calendar.
// Spec: docs/domain/meeting-calendar.md §11.
//
// No permission is involved (K-01, §5): every active employee may invite, and detail access is
// ownership — the session's employee is the organizer or has a participant row. Anyone else
// gets 404, the same answer as for a meeting that does not exist.

import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { pageOffset, pageQuerySchema, pagination } from "../../lib/pagination.js";
import { AUTH_COOKIE_NAME, AuthService, readCookie, type AuthPrincipal } from "../auth/service.js";
import {
  allowedActions,
  assertCancellable,
  assertEditable,
  assertRespondable,
  blocksTime,
  CALENDAR_MAX_DAYS,
  CALENDAR_MAX_ITEMS,
  describeIssue,
  formatWibRange,
  inclusiveDays,
  isCalendarDate,
  jakartaDayInterval,
  MAX_PARTICIPANTS,
  MeetingPolicyError,
  normalizeParticipants,
  peopleToCheck,
  projectCalendarMeeting,
  validateMeetingTimes,
  type Availability,
  type CalendarMeetingRow,
  type Interval,
  type MeetingStatus,
  type ParticipantResponse,
  type ParticipantRole,
} from "./domain.js";
import {
  addMeetingEvent,
  cancelReminders,
  checkAvailability,
  enqueueWhatsApp,
  loadActivePeople,
  loadActorEmployee,
  loadNonWorkingDates,
  loadUnavailability,
  lockEmployees,
  MeetingError,
  meetingHref,
  notifyPeople,
  skipQueuedWhatsApp,
  syncReminders,
  type Queryable,
} from "./service.js";
import { normalizeWhatsAppNumber } from "./whatsapp.js";

const instant = z.string().datetime({ offset: true });
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional()
  .transform((value) => (value ? value : null));
const participantIds = z.array(z.string().uuid()).min(1).max(MAX_PARTICIPANTS + 1);
const createBody = z.object({
  title: z.string().trim().min(3).max(200),
  description: optionalText(3000),
  location: optionalText(255),
  startAt: instant,
  endAt: instant,
  participantEmployeeIds: participantIds,
  confidential: z.boolean().default(false),
  notifyWhatsApp: z.boolean().default(true),
});
const updateBody = z.object({
  expectedVersion: z.number().int().min(1),
  title: z.string().trim().min(3).max(200).optional(),
  description: z.string().trim().max(3000).nullable().optional(),
  location: z.string().trim().max(255).nullable().optional(),
  startAt: instant.optional(),
  endAt: instant.optional(),
  participantEmployeeIds: participantIds.optional(),
  confidential: z.boolean().optional(),
  notifyWhatsApp: z.boolean().optional(),
});
const availabilityBody = z.object({
  startAt: instant,
  endAt: instant,
  participantEmployeeIds: z.array(z.string().uuid()).max(MAX_PARTICIPANTS + 1),
  excludeMeetingId: z.string().uuid().nullable().optional(),
});
const cancelBody = z.object({ reason: z.string().trim().min(5).max(500) });
const responseBody = z.object({
  response: z.enum(["ACCEPTED", "DECLINED"]),
  note: z.string().trim().max(500).nullable().optional().transform((value) => (value ? value : null)),
});
const idParams = z.object({ id: z.string().uuid() });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const calendarQuery = z.object({ from: isoDate, to: isoDate });
const listQuery = pageQuerySchema.extend({ tab: z.enum(["upcoming", "past"]).default("upcoming") });
const optionsQuery = z.object({ q: z.string().trim().min(2).max(80) });

const NOT_FOUND = { code: "MEETING_NOT_FOUND", message: "Rapat tidak ditemukan." } as const;

function send(reply: FastifyReply, status: number, body: unknown) {
  reply.header("Cache-Control", "no-store");
  return reply.status(status).send(body);
}

function interval(startAt: string | Date, endAt: string | Date): Interval {
  return { startMs: new Date(startAt).getTime(), endMs: new Date(endAt).getTime() };
}

function withMessages(availability: Availability) {
  return {
    conflicts: availability.conflicts.map((issue) => ({ ...issue, message: describeIssue(issue) })),
    warnings: availability.warnings.map((issue) => ({ ...issue, message: describeIssue(issue) })),
  };
}

function conflictError(availability: Availability) {
  const shaped = withMessages(availability);
  return new MeetingError(409, "MEETING_CONFLICT", shaped.conflicts.map((issue) => issue.message).join(" "), shaped);
}

function knownError(error: unknown): MeetingError | null {
  if (error instanceof MeetingError) return error;
  if (error instanceof MeetingPolicyError) return new MeetingError(error.statusCode, error.code, error.message);
  const database = error as { code?: string; constraint?: string };
  // §6.1: the exclusion constraint caught what the row locks did not (should not happen).
  if (database.code === "23P01" && database.constraint === "meeting_participants_no_overlap") {
    return new MeetingError(409, "MEETING_CONFLICT", "Jadwal salah satu peserta baru saja terisi rapat lain. Periksa ulang ketersediaan.", {
      conflicts: [], warnings: [],
    });
  }
  return null;
}

interface MeetingRow {
  id: string;
  organizerEmployeeId: string;
  title: string;
  description: string | null;
  location: string | null;
  startAt: Date;
  endAt: Date;
  status: MeetingStatus;
  confidential: boolean;
  notifyWhatsApp: boolean;
  version: number;
}

const MEETING_COLUMNS = `
  meeting.id, meeting.organizer_employee_id AS "organizerEmployeeId", meeting.title, meeting.description,
  meeting.location, meeting.start_at AS "startAt", meeting.end_at AS "endAt", meeting.status,
  meeting.confidential, meeting.notify_whatsapp AS "notifyWhatsApp", meeting.version`;

/** Locks the meeting and returns it with the actor's own row; null when the actor is not in it. */
async function lockMeetingFor(client: PoolClient, meetingId: string, employeeId: string) {
  const found = await client.query<MeetingRow>(
    // NO KEY UPDATE: see lockEmployees — the runner's foreign-key checks must not wait on it.
    `SELECT ${MEETING_COLUMNS} FROM meetings meeting WHERE meeting.id = $1 FOR NO KEY UPDATE`,
    [meetingId],
  );
  const meeting = found.rows[0];
  if (!meeting) return null;
  const own = await client.query<{ role: ParticipantRole; response: ParticipantResponse; responseNote: string | null }>(
    `SELECT role, response, response_note AS "responseNote"
       FROM meeting_participants WHERE meeting_id = $1 AND employee_id = $2`,
    [meetingId, employeeId],
  );
  if (!own.rows[0]) return null;
  return { meeting, own: own.rows[0] };
}

function state(meeting: MeetingRow) {
  return {
    status: meeting.status,
    startMs: meeting.startAt.getTime(),
    endMs: meeting.endAt.getTime(),
    organizerEmployeeId: meeting.organizerEmployeeId,
  };
}

async function loadMeetingDetail(db: Queryable, meetingId: string, viewerEmployeeId: string) {
  const found = await db.query<MeetingRow & {
    organizerName: string; cancelReason: string | null; cancelledAt: Date | null; createdAt: Date;
    myRole: ParticipantRole; myResponse: ParticipantResponse; myResponseNote: string | null;
  }>(
    `SELECT ${MEETING_COLUMNS}, organizer.full_name AS "organizerName",
            meeting.cancel_reason AS "cancelReason", meeting.cancelled_at AS "cancelledAt",
            meeting.created_at AS "createdAt",
            mine.role AS "myRole", mine.response AS "myResponse", mine.response_note AS "myResponseNote"
       FROM meetings meeting
       JOIN employees organizer ON organizer.id = meeting.organizer_employee_id
       JOIN meeting_participants mine ON mine.meeting_id = meeting.id AND mine.employee_id = $2
      WHERE meeting.id = $1`,
    [meetingId, viewerEmployeeId],
  );
  const meeting = found.rows[0];
  if (!meeting) return null;
  const isOrganizer = meeting.myRole === "ORGANIZER";
  const [participants, events] = await Promise.all([
    // Bounded by K-09 (at most 200 attendees plus the organizer), so not paged.
    db.query<{
      employeeId: string; name: string; unitName: string | null; role: ParticipantRole; response: ParticipantResponse;
      responseNote: string | null; respondedAt: Date | null; hasAccount: boolean; phone: string | null;
    }>(
      `SELECT participant.employee_id AS "employeeId", employee.full_name AS name, unit.name AS "unitName",
              participant.role, participant.response, participant.response_note AS "responseNote",
              participant.responded_at AS "respondedAt", employee.phone,
              EXISTS (SELECT 1 FROM accounts account
                       WHERE account.employee_id = employee.id AND account.principal_type = 'EMPLOYEE'
                         AND account.status = 'active') AS "hasAccount"
         FROM meeting_participants participant
         JOIN employees employee ON employee.id = participant.employee_id
         LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
        WHERE participant.meeting_id = $1
        ORDER BY (participant.role = 'ORGANIZER') DESC, employee.full_name ASC, employee.id ASC`,
      [meetingId],
    ),
    db.query(
      `SELECT event.id, event.event_type AS "eventType", event.occurred_at AS "occurredAt",
              actor.full_name AS "actorName"
         FROM meeting_events event
         LEFT JOIN accounts account ON account.id = event.actor_account_id
         LEFT JOIN employees actor ON actor.id = account.employee_id
        WHERE event.meeting_id = $1
        ORDER BY event.occurred_at ASC, event.id ASC`,
      [meetingId],
    ),
  ]);
  const unavailable = meeting.status === "ACTIVE"
    ? await loadUnavailability(db, participants.rows.map((row) => row.employeeId), interval(meeting.startAt, meeting.endAt))
    : new Map<string, "LEAVE" | "TRIP">();
  const { myRole, myResponse, myResponseNote, ...rest } = meeting;
  return {
    ...rest,
    me: { role: myRole, response: myResponse, responseNote: myResponseNote },
    ...allowedActions(state(meeting), { employeeId: viewerEmployeeId, role: myRole }, Date.now()),
    participants: participants.rows.map(({ phone, responseNote, hasAccount, ...row }) => ({
      ...row,
      // I-04: response notes, account and WhatsApp flags are for the organizer (§12); K-08: so is
      // whether someone is away on leave or a trip (a participant still sees their own).
      responseNote: isOrganizer || row.employeeId === viewerEmployeeId ? responseNote : null,
      hasAccount: isOrganizer ? hasAccount : null,
      hasWhatsApp: isOrganizer ? normalizeWhatsAppNumber(phone) !== null : null,
      unavailableReason: isOrganizer || row.employeeId === viewerEmployeeId ? unavailable.get(row.employeeId) ?? null : null,
    })),
    events: events.rows,
  };
}

export async function registerMeetingRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
  injectedAuth?: Pick<AuthService, "getSession">,
) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required for meeting routes");
  const auth = injectedAuth ?? new AuthService(
    pool, config.AUTH_ENCRYPTION_KEY, config.AUTH_SESSION_TTL_HOURS, config.NODE_ENV === "production",
  );

  async function requireEmployee(request: FastifyRequest, reply: FastifyReply): Promise<AuthPrincipal | null> {
    const session = await auth.getSession(readCookie(request.headers.cookie, AUTH_COOKIE_NAME));
    if (!session) {
      await send(reply, 401, { code: "UNAUTHENTICATED", message: "Sesi tidak ditemukan atau sudah berakhir." });
      return null;
    }
    if (session.principal.principalType !== "EMPLOYEE") {
      await send(reply, 403, { code: "FORBIDDEN", message: "Kalender rapat hanya tersedia untuk pegawai." });
      return null;
    }
    return session.principal;
  }

  async function handle(reply: FastifyReply, work: () => Promise<unknown>) {
    try {
      return await work();
    } catch (error) {
      const known = knownError(error);
      if (!known) throw error;
      return send(reply, known.statusCode, { code: known.code, message: known.message, ...known.details });
    }
  }

  async function transact(reply: FastifyReply, work: (client: PoolClient) => Promise<[number, unknown]>) {
    return handle(reply, async () => {
      const client = await pool.connect();
      let result: [number, unknown];
      try {
        await client.query("BEGIN");
        result = await work(client);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return send(reply, result[0], result[1]);
    });
  }

  function invalid(reply: FastifyReply, message = "Data rapat tidak valid.") {
    return send(reply, 400, { code: "INVALID_MEETING", message });
  }

  // ------------------------------------------------------------------ reads

  app.get("/me/calendar", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const query = calendarQuery.safeParse(request.query);
    if (!query.success || !isCalendarDate(query.data.from) || !isCalendarDate(query.data.to) || query.data.to < query.data.from) {
      return send(reply, 400, { code: "INVALID_CALENDAR_RANGE", message: "Rentang tanggal tidak valid." });
    }
    if (inclusiveDays(query.data.from, query.data.to) > CALENDAR_MAX_DAYS) {
      return send(reply, 400, { code: "INVALID_CALENDAR_RANGE", message: `Rentang kalender paling panjang ${CALENDAR_MAX_DAYS} hari.` });
    }
    return handle(reply, async () => {
      const me = await loadActorEmployee(pool, principal.id);
      const { from, to } = query.data;
      const rangeStart = new Date(jakartaDayInterval(from).startMs).toISOString();
      const rangeEnd = new Date(jakartaDayInterval(to).endMs).toISOString();
      const [meetings, leaves, trips, nonWorking] = await Promise.all([
        // K-05: every active meeting of the foundation, plus cancelled ones I was in. The
        // projection below removes what a non-participant may not see; LIMIT is the density
        // guard, never a silent cut (the request fails instead).
        pool.query<Omit<CalendarMeetingRow, "startAt" | "endAt"> & { startAt: Date; endAt: Date }>(
          `SELECT meeting.id, meeting.title, meeting.location, organizer.full_name AS "organizerName",
                  meeting.start_at AS "startAt", meeting.end_at AS "endAt", meeting.status, meeting.confidential,
                  mine.employee_id IS NOT NULL AS "involvesMe", mine.role AS "myRole", mine.response AS "myResponse"
             FROM meetings meeting
             JOIN employees organizer ON organizer.id = meeting.organizer_employee_id
             LEFT JOIN meeting_participants mine ON mine.meeting_id = meeting.id AND mine.employee_id = $1
            WHERE meeting.start_at < $3::timestamptz AND meeting.end_at > $2::timestamptz
              AND (meeting.status = 'ACTIVE' OR mine.employee_id IS NOT NULL)
            ORDER BY meeting.start_at ASC, meeting.id ASC
            LIMIT $4`,
          [me.id, rangeStart, rangeEnd, CALENDAR_MAX_ITEMS + 1],
        ),
        pool.query(
          `SELECT id, status, to_char(start_on, 'YYYY-MM-DD') AS "startOn", to_char(end_on, 'YYYY-MM-DD') AS "endOn"
             FROM leave_requests
            WHERE employee_id = $1 AND status IN ('approved', 'in_review')
              AND start_on <= $3::date AND end_on >= $2::date
            ORDER BY start_on ASC`,
          [me.id, from, to],
        ),
        pool.query(
          `SELECT id, status, destination, to_char(start_on, 'YYYY-MM-DD') AS "startOn", to_char(end_on, 'YYYY-MM-DD') AS "endOn"
             FROM business_trip_requests
            WHERE employee_id = $1 AND status IN ('APPROVED', 'ISSUED', 'IN_REVIEW')
              AND start_on <= $3::date AND end_on >= $2::date
            ORDER BY start_on ASC`,
          [me.id, from, to],
        ),
        loadNonWorkingDates(pool, from, to),
      ]);
      const items = [
        ...meetings.rows.flatMap((row) => {
          const item = projectCalendarMeeting({ ...row, startAt: row.startAt.toISOString(), endAt: row.endAt.toISOString() });
          return item ? [item] : [];
        }),
        ...leaves.rows.map((row) => ({ kind: "leave" as const, ...row })),
        ...trips.rows.map((row) => ({ kind: "trip" as const, ...row })),
        ...nonWorking.map((day) => ({ kind: "non_working" as const, date: day.date, label: day.label })),
      ];
      if (meetings.rows.length > CALENDAR_MAX_ITEMS || items.length > CALENDAR_MAX_ITEMS) {
        return send(reply, 400, {
          code: "RANGE_TOO_DENSE",
          message: "Terlalu banyak kegiatan pada rentang ini. Perkecil rentang tanggal.",
        });
      }
      return send(reply, 200, { from, to, items });
    });
  });

  app.get("/me/meetings", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const query = listQuery.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_MEETING_FILTER", message: "Filter tidak valid." });
    return handle(reply, async () => {
      const me = await loadActorEmployee(pool, principal.id);
      const upcoming = query.data.tab === "upcoming";
      // ENG-LIST-001: the tab filter runs before LIMIT; the page carries the true total.
      const result = await pool.query<{ total: number }>(
        `SELECT meeting.id, meeting.title, meeting.location, meeting.start_at AS "startAt", meeting.end_at AS "endAt",
                meeting.status, meeting.confidential, organizer.full_name AS "organizerName",
                mine.role AS "myRole", mine.response AS "myResponse",
                (SELECT count(*)::int FROM meeting_participants other WHERE other.meeting_id = meeting.id) AS "participantCount",
                count(*) OVER ()::int AS total
           FROM meeting_participants mine
           JOIN meetings meeting ON meeting.id = mine.meeting_id
           JOIN employees organizer ON organizer.id = meeting.organizer_employee_id
          WHERE mine.employee_id = $1 AND (CASE WHEN $2::boolean THEN meeting.end_at > now() ELSE meeting.end_at <= now() END)
          ORDER BY ${upcoming ? "meeting.start_at ASC, meeting.id ASC" : "meeting.start_at DESC, meeting.id DESC"}
          LIMIT $3 OFFSET $4`,
        [me.id, upcoming, query.data.pageSize, pageOffset(query.data)],
      );
      return send(reply, 200, {
        items: result.rows.map(({ total, ...row }) => { void total; return row; }),
        pagination: pagination(query.data, result.rows[0]?.total ?? 0),
      });
    });
  });

  app.get("/me/meetings/participant-options", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const query = optionsQuery.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_PARTICIPANT_SEARCH", message: "Ketik minimal 2 huruf nama pegawai." });
    return handle(reply, async () => {
      const me = await loadActorEmployee(pool, principal.id);
      const pattern = `%${query.data.q.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
      // Typeahead (ENG-LIST-001): 20 matches at most, name and unit only — no e-mail, phone or
      // employee number leaves this endpoint.
      const result = await pool.query<{ id: string; name: string; unitName: string | null; hasAccount: boolean; phone: string | null }>(
        `SELECT employee.id, employee.full_name AS name, unit.name AS "unitName", employee.phone,
                EXISTS (SELECT 1 FROM accounts account
                         WHERE account.employee_id = employee.id AND account.principal_type = 'EMPLOYEE'
                           AND account.status = 'active') AS "hasAccount"
           FROM employees employee
           LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
          WHERE employee.status = 'active' AND employee.removed_at IS NULL AND employee.id <> $1
            AND employee.full_name ILIKE $2 ESCAPE '\\'
          ORDER BY employee.full_name ASC, employee.id ASC
          LIMIT 20`,
        [me.id, pattern],
      );
      return send(reply, 200, {
        items: result.rows.map(({ phone, ...row }) => ({ ...row, hasWhatsApp: normalizeWhatsAppNumber(phone) !== null })),
      });
    });
  });

  app.get("/me/meetings/:id", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 404, NOT_FOUND);
    return handle(reply, async () => {
      const me = await loadActorEmployee(pool, principal.id);
      // CAL-001-I: a meeting I am not in is indistinguishable from a missing one.
      const detail = await loadMeetingDetail(pool, params.data.id, me.id);
      if (!detail) return send(reply, 404, NOT_FOUND);
      return send(reply, 200, detail);
    });
  });

  app.post("/me/meetings/availability", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const body = availabilityBody.safeParse(request.body);
    if (!body.success) return invalid(reply);
    return handle(reply, async () => {
      const me = await loadActorEmployee(pool, principal.id);
      const wanted = interval(body.data.startAt, body.data.endAt);
      // I-12: only future windows; a past one would only serve to look into other people's days.
      validateMeetingTimes({ ...wanted, nowMs: Date.now() });
      const ids = [...new Set(body.data.participantEmployeeIds)].filter((id) => id !== me.id);
      let existing: { participantEmployeeIds: string[]; timeChanged: boolean } | null = null;
      if (body.data.excludeMeetingId) {
        const found = await pool.query<{ startAt: Date; endAt: Date; ids: string[] }>(
          `SELECT meeting.start_at AS "startAt", meeting.end_at AS "endAt",
                  array(SELECT employee_id FROM meeting_participants
                         WHERE meeting_id = meeting.id AND role = 'ATTENDEE')::text[] AS ids
             FROM meetings meeting
            WHERE meeting.id = $1 AND meeting.organizer_employee_id = $2`,
          [body.data.excludeMeetingId, me.id],
        );
        const meeting = found.rows[0];
        if (!meeting) return send(reply, 404, NOT_FOUND);
        existing = {
          participantEmployeeIds: meeting.ids,
          timeChanged: meeting.startAt.getTime() !== wanted.startMs || meeting.endAt.getTime() !== wanted.endMs,
        };
      }
      // A preview only: the binding check runs again, under lock, when the meeting is saved.
      const check = peopleToCheck({ organizerEmployeeId: me.id, participantEmployeeIds: ids, existing });
      const people = await loadActivePeople(pool, check);
      const availability = await checkAvailability(pool, {
        interval: wanted, people, excludeMeetingId: body.data.excludeMeetingId ?? null, viewerEmployeeId: me.id,
      });
      return send(reply, 200, withMessages(availability));
    });
  });

  // ----------------------------------------------------------------- writes

  app.post("/me/meetings", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const key = z.string().uuid().safeParse(request.headers["idempotency-key"]);
    if (!key.success) {
      return send(reply, 400, { code: "IDEMPOTENCY_KEY_REQUIRED", message: "Permintaan membutuhkan header Idempotency-Key (UUID)." });
    }
    const body = createBody.safeParse(request.body);
    if (!body.success) return invalid(reply, "Judul (3–200 karakter), waktu, atau peserta tidak valid.");
    const input = body.data;
    return transact(reply, async (client) => {
      const organizer = await loadActorEmployee(client, principal.id);
      const findReplay = async () => (await client.query<{ id: string; status: MeetingStatus; version: number }>(
        `SELECT id, status, version FROM meetings WHERE organizer_employee_id = $1 AND idempotency_key = $2`,
        [organizer.id, key.data],
      )).rows[0];
      const replay = await findReplay();
      if (replay) return [200, { ...replay, idempotentReplay: true }];

      const nowMs = Date.now();
      const wanted = interval(input.startAt, input.endAt);
      validateMeetingTimes({ ...wanted, nowMs });
      const attendees = normalizeParticipants(organizer.id, input.participantEmployeeIds);
      await lockEmployees(client, [organizer.id, ...attendees]);
      // A double click that raced this one may have committed while we waited for the locks:
      // answer it as a replay rather than as a conflict with itself.
      const raced = await findReplay();
      if (raced) return [200, { ...raced, idempotentReplay: true }];
      const people = await loadActivePeople(client, [organizer.id, ...attendees]);
      const availability = await checkAvailability(client, {
        interval: wanted, people, excludeMeetingId: null, viewerEmployeeId: organizer.id,
      });
      if (availability.conflicts.length > 0) throw conflictError(availability);

      const id = randomUUID();
      const startAt = new Date(wanted.startMs).toISOString();
      const endAt = new Date(wanted.endMs).toISOString();
      await client.query(
        `INSERT INTO meetings (
           id, organizer_employee_id, title, description, location, start_at, end_at, status,
           confidential, notify_whatsapp, idempotency_key, created_by_account_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', $8, $9, $10, $11)`,
        [id, organizer.id, input.title, input.description, input.location, startAt, endAt,
          input.confidential, input.notifyWhatsApp, key.data, principal.id],
      );
      await client.query(
        `INSERT INTO meeting_participants (meeting_id, employee_id, role, response, responded_at, busy, blocks_time)
         SELECT $1::uuid, person.id,
                CASE WHEN person.id = $2::uuid THEN 'ORGANIZER' ELSE 'ATTENDEE' END,
                CASE WHEN person.id = $2::uuid THEN 'ACCEPTED' ELSE 'PENDING' END,
                CASE WHEN person.id = $2::uuid THEN now() END,
                tstzrange($3::timestamptz, $4::timestamptz, '[)'), true
           FROM unnest($5::uuid[]) AS person(id)`,
        [id, organizer.id, startAt, endAt, [organizer.id, ...attendees]],
      );
      await addMeetingEvent(client, id, principal.id, "meeting.created", {
        startAt, endAt, confidential: input.confidential, notifyWhatsApp: input.notifyWhatsApp,
        participantEmployeeIds: attendees,
      });
      const range = formatWibRange(wanted.startMs, wanted.endMs);
      await notifyPeople(client, attendees, {
        eventKey: (employeeId) => `meeting.${id}.invited.${employeeId}.v1`,
        title: "Undangan rapat",
        body: `${organizer.fullName} mengundang Anda ke "${input.title}", ${range}.`,
        href: meetingHref(id),
        actorAccountId: principal.id,
      });
      const whatsapp = input.notifyWhatsApp
        ? await enqueueWhatsApp(client, { meetingId: id, employeeIds: attendees, event: "invited", version: 1 })
        : null;
      await syncReminders(client, id, wanted.startMs, { timeChanged: true, nowMs });
      return [201, {
        id, status: "ACTIVE", version: 1, idempotentReplay: false,
        warnings: withMessages(availability).warnings,
        whatsappWithoutNumber: whatsapp?.withoutNumber ?? [],
      }];
    });
  });

  app.patch("/me/meetings/:id", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 404, NOT_FOUND);
    const body = updateBody.safeParse(request.body);
    if (!body.success) return invalid(reply, "Perubahan rapat tidak valid; sertakan expectedVersion.");
    const input = body.data;
    return transact(reply, async (client) => {
      const actor = await loadActorEmployee(client, principal.id);
      const locked = await lockMeetingFor(client, params.data.id, actor.id);
      if (!locked) throw new MeetingError(404, NOT_FOUND.code, NOT_FOUND.message);
      const { meeting } = locked;
      const nowMs = Date.now();
      assertEditable(state(meeting), actor.id, nowMs);
      if (meeting.version !== input.expectedVersion) {
        throw new MeetingError(409, "MEETING_VERSION_CONFLICT", "Rapat ini baru saja diubah. Muat ulang sebelum menyimpan.", {
          currentVersion: meeting.version,
        });
      }

      const before = await client.query<{ employeeId: string }>(
        `SELECT employee_id AS "employeeId" FROM meeting_participants WHERE meeting_id = $1 AND role = 'ATTENDEE'`,
        [meeting.id],
      );
      const previous = before.rows.map((row) => row.employeeId);
      const attendees = input.participantEmployeeIds
        ? normalizeParticipants(actor.id, input.participantEmployeeIds)
        : previous;
      const wanted = interval(input.startAt ?? meeting.startAt, input.endAt ?? meeting.endAt);
      const timeChanged = wanted.startMs !== meeting.startAt.getTime() || wanted.endMs !== meeting.endAt.getTime();
      validateMeetingTimes({ ...wanted, nowMs, requireFutureStart: timeChanged });
      const added = attendees.filter((id) => !previous.includes(id));
      const removed = previous.filter((id) => !attendees.includes(id));
      const kept = attendees.filter((id) => previous.includes(id));
      const next = {
        title: input.title ?? meeting.title,
        description: input.description === undefined ? meeting.description : input.description || null,
        location: input.location === undefined ? meeting.location : input.location || null,
        confidential: input.confidential ?? meeting.confidential,
        notifyWhatsApp: input.notifyWhatsApp ?? meeting.notifyWhatsApp,
      };
      const changedFields = [
        next.title !== meeting.title ? "title" : null,
        next.description !== meeting.description ? "description" : null,
        next.location !== meeting.location ? "location" : null,
        timeChanged ? "time" : null,
        added.length > 0 || removed.length > 0 ? "participants" : null,
        next.confidential !== meeting.confidential ? "confidential" : null,
        next.notifyWhatsApp !== meeting.notifyWhatsApp ? "notifyWhatsApp" : null,
      ].filter((field): field is string => field !== null);
      if (changedFields.length === 0) return [200, { id: meeting.id, version: meeting.version, warnings: [], whatsappWithoutNumber: [] }];

      await lockEmployees(client, [actor.id, ...attendees, ...removed]);
      await loadActivePeople(client, added);
      const check = peopleToCheck({
        organizerEmployeeId: actor.id,
        participantEmployeeIds: attendees,
        existing: { participantEmployeeIds: previous, timeChanged },
      });
      const people = await loadActivePeople(client, check);
      const availability = await checkAvailability(client, {
        interval: wanted, people, excludeMeetingId: meeting.id, viewerEmployeeId: actor.id,
      });
      if (availability.conflicts.length > 0) throw conflictError(availability);

      const version = meeting.version + 1;
      const startAt = new Date(wanted.startMs).toISOString();
      const endAt = new Date(wanted.endMs).toISOString();
      await client.query(
        `UPDATE meetings
            SET title = $2, description = $3, location = $4, start_at = $5, end_at = $6,
                confidential = $7, notify_whatsapp = $8, version = $9, updated_at = now()
          WHERE id = $1`,
        [meeting.id, next.title, next.description, next.location, startAt, endAt, next.confidential, next.notifyWhatsApp, version],
      );
      if (removed.length > 0) {
        await client.query(`DELETE FROM meeting_participants WHERE meeting_id = $1 AND employee_id = ANY($2::uuid[])`, [meeting.id, removed]);
        await cancelReminders(client, meeting.id, removed);
        await skipQueuedWhatsApp(client, meeting.id, removed, ["invited", "rescheduled", "reminder"], "participant_removed");
      }
      if (timeChanged) {
        // K-11: a new time resets every attendee's answer, so the declined block again.
        await client.query(
          `UPDATE meeting_participants
              SET busy = tstzrange($2::timestamptz, $3::timestamptz, '[)'),
                  response = CASE WHEN role = 'ORGANIZER' THEN response ELSE 'PENDING' END,
                  response_note = CASE WHEN role = 'ORGANIZER' THEN response_note END,
                  responded_at = CASE WHEN role = 'ORGANIZER' THEN responded_at END,
                  blocks_time = true
            WHERE meeting_id = $1`,
          [meeting.id, startAt, endAt],
        );
      }
      if (added.length > 0) {
        await client.query(
          `INSERT INTO meeting_participants (meeting_id, employee_id, role, response, busy, blocks_time)
           SELECT $1::uuid, person.id, 'ATTENDEE', 'PENDING', tstzrange($2::timestamptz, $3::timestamptz, '[)'), true
             FROM unnest($4::uuid[]) AS person(id)`,
          [meeting.id, startAt, endAt, added],
        );
      }
      await syncReminders(client, meeting.id, wanted.startMs, { timeChanged, nowMs });

      await addMeetingEvent(client, meeting.id, principal.id, "meeting.updated", {
        version,
        changedFields,
        ...(timeChanged ? {
          previousStartAt: meeting.startAt.toISOString(), previousEndAt: meeting.endAt.toISOString(), startAt, endAt,
        } : {}),
        ...(next.confidential !== meeting.confidential ? { confidential: next.confidential } : {}),
      });
      for (const employeeId of added) await addMeetingEvent(client, meeting.id, principal.id, "meeting.participant.added", { employeeId, version });
      for (const employeeId of removed) await addMeetingEvent(client, meeting.id, principal.id, "meeting.participant.removed", { employeeId, version });

      const range = formatWibRange(wanted.startMs, wanted.endMs);
      const href = meetingHref(meeting.id);
      await notifyPeople(client, added, {
        eventKey: (employeeId) => `meeting.${meeting.id}.invited.${employeeId}.v${version}`,
        title: "Undangan rapat",
        body: `${actor.fullName} mengundang Anda ke "${next.title}", ${range}.`,
        href, actorAccountId: principal.id,
      });
      await notifyPeople(client, removed, {
        eventKey: (employeeId) => `meeting.${meeting.id}.removed.${employeeId}.v${version}`,
        title: "Anda tidak lagi diundang",
        body: `${actor.fullName} mengeluarkan Anda dari rapat "${meeting.title}".`,
        href: "/app/calendar", actorAccountId: principal.id,
      });
      if (timeChanged) {
        await notifyPeople(client, kept, {
          eventKey: (employeeId) => `meeting.${meeting.id}.rescheduled.${employeeId}.v${version}`,
          title: "Jadwal rapat berubah",
          body: `"${next.title}" dipindah ke ${range}. Mohon konfirmasi kehadiran lagi.`,
          href, actorAccountId: principal.id,
        });
      }
      const withoutNumber: string[] = [];
      if (next.notifyWhatsApp) {
        for (const [event, ids] of [["invited", added], ["removed", removed], ["rescheduled", timeChanged ? kept : []]] as const) {
          const queued = await enqueueWhatsApp(client, {
            meetingId: meeting.id, employeeIds: ids, event, version,
            // Someone no longer invited is told about the meeting as they knew it, never its new
            // title, time or location.
            ...(event === "removed" ? {
              facts: {
                title: meeting.title, startMs: meeting.startAt.getTime(), endMs: meeting.endAt.getTime(),
                location: meeting.location, organizerName: actor.fullName,
              },
            } : {}),
          });
          withoutNumber.push(...queued.withoutNumber);
        }
      }
      return [200, { id: meeting.id, version, warnings: withMessages(availability).warnings, whatsappWithoutNumber: withoutNumber }];
    });
  });

  app.post("/me/meetings/:id/cancel", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 404, NOT_FOUND);
    const body = cancelBody.safeParse(request.body);
    if (!body.success) return invalid(reply, "Alasan pembatalan 5 sampai 500 karakter.");
    return transact(reply, async (client) => {
      const actor = await loadActorEmployee(client, principal.id);
      const locked = await lockMeetingFor(client, params.data.id, actor.id);
      if (!locked) throw new MeetingError(404, NOT_FOUND.code, NOT_FOUND.message);
      const { meeting } = locked;
      assertCancellable(state(meeting), actor.id, Date.now());
      const version = meeting.version + 1;
      await client.query(
        `UPDATE meetings
            SET status = 'CANCELLED', cancel_reason = $2, cancelled_at = now(), cancelled_by_account_id = $3,
                version = $4, updated_at = now()
          WHERE id = $1`,
        [meeting.id, body.data.reason, principal.id, version],
      );
      // CAL-001-D: a cancelled meeting no longer blocks anybody.
      await client.query(`UPDATE meeting_participants SET blocks_time = false WHERE meeting_id = $1`, [meeting.id]);
      await cancelReminders(client, meeting.id, null);
      await skipQueuedWhatsApp(client, meeting.id, null, ["invited", "rescheduled", "reminder"], "meeting_cancelled");
      await addMeetingEvent(client, meeting.id, principal.id, "meeting.cancelled", { version });
      const attendees = await client.query<{ employeeId: string }>(
        `SELECT employee_id AS "employeeId" FROM meeting_participants WHERE meeting_id = $1 AND role = 'ATTENDEE'`,
        [meeting.id],
      );
      const ids = attendees.rows.map((row) => row.employeeId);
      await notifyPeople(client, ids, {
        eventKey: (employeeId) => `meeting.${meeting.id}.cancelled.${employeeId}`,
        title: "Rapat dibatalkan",
        body: `"${meeting.title}" (${formatWibRange(meeting.startAt.getTime(), meeting.endAt.getTime())}) dibatalkan oleh ${actor.fullName}.`,
        href: meetingHref(meeting.id), actorAccountId: principal.id,
      });
      if (meeting.notifyWhatsApp) await enqueueWhatsApp(client, { meetingId: meeting.id, employeeIds: ids, event: "cancelled", version });
      return [200, { id: meeting.id, status: "CANCELLED", version }];
    });
  });

  app.post("/me/meetings/:id/response", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 404, NOT_FOUND);
    const body = responseBody.safeParse(request.body);
    if (!body.success) return invalid(reply, "Jawaban harus Hadir atau Berhalangan; catatan paling panjang 500 karakter.");
    return transact(reply, async (client) => {
      const actor = await loadActorEmployee(client, principal.id);
      const locked = await lockMeetingFor(client, params.data.id, actor.id);
      if (!locked) throw new MeetingError(404, NOT_FOUND.code, NOT_FOUND.message);
      const { meeting, own } = locked;
      assertRespondable(state(meeting), own.role, Date.now());
      const response = body.data.response;
      if (own.response === response && own.responseNote === body.data.note) {
        return [200, { id: meeting.id, response, changed: false }];
      }
      if (own.response === "DECLINED" && response === "ACCEPTED") {
        // §7.3: taking the slot back re-runs §6 for this person only.
        await lockEmployees(client, [actor.id]);
        const availability = await checkAvailability(client, {
          interval: interval(meeting.startAt, meeting.endAt),
          people: [{ employeeId: actor.id, name: actor.fullName }],
          excludeMeetingId: meeting.id,
          viewerEmployeeId: actor.id,
        });
        if (availability.conflicts.length > 0) throw conflictError(availability);
      }
      await client.query(
        `UPDATE meeting_participants
            SET response = $3, response_note = $4, responded_at = now(), blocks_time = $5
          WHERE meeting_id = $1 AND employee_id = $2`,
        [meeting.id, actor.id, response, body.data.note, blocksTime(meeting.status, response)],
      );
      if (response === "DECLINED") {
        await cancelReminders(client, meeting.id, [actor.id]);
        await skipQueuedWhatsApp(client, meeting.id, [actor.id], ["reminder"], "participant_declined");
      } else {
        await syncReminders(client, meeting.id, meeting.startAt.getTime(), { timeChanged: false });
      }
      await addMeetingEvent(client, meeting.id, principal.id, "meeting.participant.responded", {
        employeeId: actor.id, response, previousResponse: own.response,
      });
      if (response === "DECLINED" && own.response !== "DECLINED") {
        await notifyPeople(client, [meeting.organizerEmployeeId], {
          eventKey: () => `meeting.${meeting.id}.declined.${actor.id}.${randomUUID()}`,
          title: "Peserta berhalangan",
          body: `${actor.fullName} berhalangan hadir di "${meeting.title}".`,
          href: meetingHref(meeting.id), actorAccountId: principal.id,
        });
      }
      return [200, { id: meeting.id, response, changed: true }];
    });
  });

}
