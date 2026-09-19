import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

type ScheduleRow = {
  scheduleTemplateId: string;
  rosterId: string | null;
  isOff: boolean;
  startTime: string | null;
  endTime: string | null;
  lateGraceMinutes: number | null;
  earlyLeaveToleranceMinutes: number | null;
  workLocationId: string | null;
  locationName: string | null;
  latitude: number | null;
  longitude: number | null;
  radiusMeters: number | null;
};

export type ResolvedSchedule = {
  state: "scheduled" | "off" | "configuration_error";
  scheduleTemplateId: string | null;
  rosterId: string | null;
  scheduledStartAt: Date | null;
  scheduledEndAt: Date | null;
  lateGraceMinutes: number;
  earlyLeaveToleranceMinutes: number;
  workLocation: null | {
    id: string;
    name: string;
    latitude: number;
    longitude: number;
    radiusMeters: number;
  };
  reason?: string;
};

export type AttendanceSession = {
  checkInAt: Date;
  checkOutAt: Date | null;
};

export type AttendanceComputation = {
  status: "scheduled" | "pending" | "present" | "late" | "incomplete" | "leave" | "absent" | "off" | "configuration_error";
  firstCheckInAt: Date | null;
  lastCheckOutAt: Date | null;
  workedMinutes: number;
  breakMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  incompleteSession: boolean;
  justified: boolean;
  sessions: AttendanceSession[];
};

type AttendanceEventRow = {
  id: string;
  eventKind: "punch" | "check_in" | "check_out" | "correction";
  occurredAt: Date;
};

type ClarificationRow = {
  id: string;
  mode: "correction" | "justification";
  proposedCheckInAt: Date | null;
  proposedCheckOutAt: Date | null;
};

type LeaveRow = { id: string };

type ResultRow = {
  id: string;
  employeeId: string;
  workDate: string;
  version: number;
  status: AttendanceComputation["status"];
  scheduleTemplateId: string | null;
  rosterId: string | null;
  scheduledStartAt: Date | null;
  scheduledEndAt: Date | null;
  firstCheckInAt: Date | null;
  lastCheckOutAt: Date | null;
  workedMinutes: number;
  breakMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  incompleteSession: boolean;
  justified: boolean;
  inputHash: string;
  createdAt: Date;
};

function isoDateShift(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function jakartaTimestamp(workDate: string, time: string, addDay = false) {
  const date = addDay ? isoDateShift(workDate, 1) : workDate;
  const normalized = time.slice(0, 8);
  return new Date(`${date}T${normalized}+07:00`);
}

function minutesBetween(start: Date, end: Date) {
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 60_000));
}

export function buildSessions(events: readonly AttendanceEventRow[]): AttendanceSession[] {
  const ordered = [...events].sort((a, b) => {
    const delta = a.occurredAt.getTime() - b.occurredAt.getTime();
    return delta !== 0 ? delta : a.id.localeCompare(b.id);
  });
  const sessions: AttendanceSession[] = [];
  let open: Date | null = null;

  for (const event of ordered) {
    if (event.eventKind === "check_in") {
      if (open) sessions.push({ checkInAt: open, checkOutAt: null });
      open = event.occurredAt;
      continue;
    }
    if (event.eventKind === "check_out") {
      if (open) {
        sessions.push({ checkInAt: open, checkOutAt: event.occurredAt });
        open = null;
      } else {
        // A lone explicit checkout is retained as incomplete evidence.
        sessions.push({ checkInAt: event.occurredAt, checkOutAt: null });
      }
      continue;
    }
    // Vendor/raw punch and correction without explicit direction toggle deterministically.
    if (!open) open = event.occurredAt;
    else {
      sessions.push({ checkInAt: open, checkOutAt: event.occurredAt });
      open = null;
    }
  }
  if (open) sessions.push({ checkInAt: open, checkOutAt: null });
  return sessions;
}

export function evaluateSessions(input: {
  schedule: ResolvedSchedule;
  sessions: AttendanceSession[];
  approvedLeave: boolean;
  justified: boolean;
  now?: Date;
}): AttendanceComputation {
  const now = input.now ?? new Date();
  if (input.schedule.state === "configuration_error") {
    return emptyComputation("configuration_error", input.justified);
  }
  if (input.schedule.state === "off") {
    return emptyComputation("off", input.justified);
  }
  if (input.approvedLeave) {
    return emptyComputation("leave", input.justified);
  }
  const scheduledStart = input.schedule.scheduledStartAt;
  const scheduledEnd = input.schedule.scheduledEndAt;
  if (!scheduledStart || !scheduledEnd) {
    return emptyComputation("configuration_error", input.justified);
  }

  const complete = input.sessions.filter((session) => session.checkOutAt);
  const first = input.sessions[0]?.checkInAt ?? null;
  const lastComplete = complete.at(-1)?.checkOutAt ?? null;
  const workedMinutes = complete.reduce(
    (total, session) => total + minutesBetween(session.checkInAt, session.checkOutAt!),
    0,
  );
  let breakMinutes = 0;
  for (let index = 1; index < complete.length; index += 1) {
    const previous = complete[index - 1]!;
    const current = complete[index]!;
    breakMinutes += minutesBetween(previous.checkOutAt!, current.checkInAt);
  }
  const incompleteSession = input.sessions.some((session) => !session.checkOutAt);

  if (!first) {
    if (now < scheduledStart) return emptyComputation("scheduled", input.justified);
    if (now <= scheduledEnd) return emptyComputation("pending", input.justified);
    return emptyComputation("absent", input.justified);
  }

  const graceEnd = new Date(scheduledStart.getTime() + input.schedule.lateGraceMinutes * 60_000);
  const lateMinutes = first > graceEnd ? minutesBetween(graceEnd, first) : 0;
  const toleratedEnd = new Date(
    scheduledEnd.getTime() - input.schedule.earlyLeaveToleranceMinutes * 60_000,
  );
  const earlyLeaveMinutes = lastComplete && lastComplete < toleratedEnd
    ? minutesBetween(lastComplete, toleratedEnd)
    : 0;

  let status: AttendanceComputation["status"] = "present";
  if (incompleteSession) status = "incomplete";
  else if (lateMinutes > 0) status = "late";

  return {
    status,
    firstCheckInAt: first,
    lastCheckOutAt: lastComplete,
    workedMinutes,
    breakMinutes,
    lateMinutes,
    earlyLeaveMinutes,
    incompleteSession,
    justified: input.justified,
    sessions: input.sessions,
  };
}

function emptyComputation(
  status: AttendanceComputation["status"],
  justified: boolean,
): AttendanceComputation {
  return {
    status,
    firstCheckInAt: null,
    lastCheckOutAt: null,
    workedMinutes: 0,
    breakMinutes: 0,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    incompleteSession: false,
    justified,
    sessions: [],
  };
}

export async function resolveSchedule(
  db: Pool | PoolClient,
  employeeId: string,
  workDate: string,
): Promise<ResolvedSchedule> {
  const roster = await db.query<ScheduleRow>(
    `SELECT
       entry.schedule_template_id AS "scheduleTemplateId",
       roster.id AS "rosterId",
       entry.is_off AS "isOff",
       schedule.start_time::text AS "startTime",
       schedule.end_time::text AS "endTime",
       schedule.late_grace_minutes AS "lateGraceMinutes",
       schedule.early_leave_tolerance_minutes AS "earlyLeaveToleranceMinutes",
       location.id AS "workLocationId",
       location.name AS "locationName",
       location.latitude,
       location.longitude,
       location.radius_meters AS "radiusMeters"
     FROM attendance_rosters roster
     JOIN attendance_roster_entries entry ON entry.roster_id = roster.id
     LEFT JOIN attendance_schedule_templates schedule ON schedule.id = entry.schedule_template_id
     LEFT JOIN attendance_work_locations location ON location.id = schedule.work_location_id
     WHERE roster.status = 'PUBLISHED'
       AND entry.employee_id = $1
       AND entry.work_date = $2::date
     ORDER BY roster.version DESC
     LIMIT 2`,
    [employeeId, workDate],
  );
  if (roster.rows.length > 1) {
    return { ...baseSchedule(), state: "configuration_error", reason: "multiple_published_rosters" };
  }
  if (roster.rows[0]) return mapScheduleRow(roster.rows[0], workDate);

  const assigned = await db.query<ScheduleRow>(
    `SELECT
       assignment.schedule_template_id AS "scheduleTemplateId",
       NULL::uuid AS "rosterId",
       false AS "isOff",
       schedule.start_time::text AS "startTime",
       schedule.end_time::text AS "endTime",
       schedule.late_grace_minutes AS "lateGraceMinutes",
       schedule.early_leave_tolerance_minutes AS "earlyLeaveToleranceMinutes",
       location.id AS "workLocationId",
       location.name AS "locationName",
       location.latitude,
       location.longitude,
       location.radius_meters AS "radiusMeters"
     FROM attendance_schedule_assignments assignment
     JOIN attendance_schedule_templates schedule ON schedule.id = assignment.schedule_template_id
     LEFT JOIN attendance_work_locations location ON location.id = schedule.work_location_id
     WHERE assignment.employee_id = $1
       AND $2::date >= assignment.effective_from
       AND (assignment.effective_to IS NULL OR $2::date <= assignment.effective_to)
       AND (assignment.weekday_mask & (1 << (extract(isodow from $2::date)::int - 1))) <> 0
       AND schedule.active = true
     ORDER BY assignment.effective_from DESC
     LIMIT 2`,
    [employeeId, workDate],
  );
  if (assigned.rows.length > 1) {
    return { ...baseSchedule(), state: "configuration_error", reason: "ambiguous_default_assignment" };
  }
  if (!assigned.rows[0]) return { ...baseSchedule(), state: "off" };
  return mapScheduleRow(assigned.rows[0], workDate);
}

function baseSchedule(): Omit<ResolvedSchedule, "state"> {
  return {
    scheduleTemplateId: null,
    rosterId: null,
    scheduledStartAt: null,
    scheduledEndAt: null,
    lateGraceMinutes: 0,
    earlyLeaveToleranceMinutes: 0,
    workLocation: null,
  };
}

function mapScheduleRow(row: ScheduleRow, workDate: string): ResolvedSchedule {
  if (row.isOff) return { ...baseSchedule(), state: "off", rosterId: row.rosterId };
  if (!row.startTime || !row.endTime) {
    return { ...baseSchedule(), state: "configuration_error", reason: "missing_schedule_template" };
  }
  const overnight = row.endTime <= row.startTime;
  const location = row.workLocationId && row.locationName !== null && row.latitude !== null &&
    row.longitude !== null && row.radiusMeters !== null
    ? {
        id: row.workLocationId,
        name: row.locationName,
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        radiusMeters: Number(row.radiusMeters),
      }
    : null;
  return {
    state: "scheduled",
    scheduleTemplateId: row.scheduleTemplateId,
    rosterId: row.rosterId,
    scheduledStartAt: jakartaTimestamp(workDate, row.startTime),
    scheduledEndAt: jakartaTimestamp(workDate, row.endTime, overnight),
    lateGraceMinutes: row.lateGraceMinutes ?? 0,
    earlyLeaveToleranceMinutes: row.earlyLeaveToleranceMinutes ?? 0,
    workLocation: location,
  };
}

async function normalizeAdmsForWindow(
  client: PoolClient,
  employeeId: string,
  start: Date,
  end: Date,
) {
  await client.query(
    `INSERT INTO attendance_events (
       id, employee_id, source, event_kind, occurred_at, received_at, source_reference, safe_metadata
     )
     SELECT
       gen_random_uuid(), mapping.employee_id, 'adms', 'punch', event.occurred_at,
       event.received_at, 'adms:' || event.id::text,
       jsonb_build_object('admsEventId', event.id, 'deviceId', event.device_id)
     FROM attendance_adms_events event
     JOIN attendance_adms_employee_mappings mapping
       ON mapping.device_id = event.device_id
      AND mapping.pin = event.pin
      AND event.occurred_at >= mapping.effective_from
      AND (mapping.effective_to IS NULL OR event.occurred_at < mapping.effective_to)
     WHERE mapping.employee_id = $1
       AND event.occurred_at BETWEEN $2 AND $3
     ON CONFLICT (source_reference) DO NOTHING`,
    [employeeId, start, end],
  );
}

export async function materializeAttendanceResult(
  pool: Pool,
  employeeId: string,
  workDate: string,
  now = new Date(),
): Promise<ResultRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`attendance-result:${employeeId}:${workDate}`],
    );
    const schedule = await resolveSchedule(client, employeeId, workDate);
    if (schedule.scheduledStartAt && schedule.scheduledEndAt) {
      await normalizeAdmsForWindow(
        client,
        employeeId,
        new Date(schedule.scheduledStartAt.getTime() - 6 * 60 * 60_000),
        new Date(schedule.scheduledEndAt.getTime() + 6 * 60 * 60_000),
      );
    }

    const clarifications = await client.query<ClarificationRow>(
      `SELECT id, mode,
         proposed_check_in_at AS "proposedCheckInAt",
         proposed_check_out_at AS "proposedCheckOutAt"
       FROM attendance_clarifications
       WHERE employee_id = $1 AND work_date = $2::date AND status = 'approved'
       ORDER BY created_at, id`,
      [employeeId, workDate],
    );
    const justified = clarifications.rows.some((item) => item.mode === "justification");

    const leave = await client.query<LeaveRow>(
      `SELECT id
       FROM leave_requests
       WHERE employee_id = $1
         AND status = 'approved'
         AND $2::date BETWEEN start_on AND end_on
       ORDER BY final_decided_at DESC NULLS LAST, submitted_at DESC
       LIMIT 1`,
      [employeeId, workDate],
    );

    const events: AttendanceEventRow[] = [];
    if (schedule.scheduledStartAt && schedule.scheduledEndAt) {
      const eventRows = await client.query<AttendanceEventRow>(
        `SELECT id, event_kind AS "eventKind", occurred_at AS "occurredAt"
         FROM attendance_events
         WHERE employee_id = $1
           AND occurred_at BETWEEN $2 AND $3
         ORDER BY occurred_at, id`,
        [
          employeeId,
          new Date(schedule.scheduledStartAt.getTime() - 6 * 60 * 60_000),
          new Date(schedule.scheduledEndAt.getTime() + 6 * 60 * 60_000),
        ],
      );
      events.push(...eventRows.rows);
    }
    for (const clarification of clarifications.rows) {
      if (clarification.mode !== "correction") continue;
      if (clarification.proposedCheckInAt) {
        events.push({
          id: `clarification:${clarification.id}:in`,
          eventKind: "check_in",
          occurredAt: clarification.proposedCheckInAt,
        });
      }
      if (clarification.proposedCheckOutAt) {
        events.push({
          id: `clarification:${clarification.id}:out`,
          eventKind: "check_out",
          occurredAt: clarification.proposedCheckOutAt,
        });
      }
    }

    const sessions = buildSessions(events);
    const computed = evaluateSessions({
      schedule,
      sessions,
      approvedLeave: Boolean(leave.rows[0]),
      justified,
      now,
    });
    const input = {
      schedule: {
        state: schedule.state,
        scheduleTemplateId: schedule.scheduleTemplateId,
        rosterId: schedule.rosterId,
        start: schedule.scheduledStartAt?.toISOString() ?? null,
        end: schedule.scheduledEndAt?.toISOString() ?? null,
        lateGraceMinutes: schedule.lateGraceMinutes,
        earlyLeaveToleranceMinutes: schedule.earlyLeaveToleranceMinutes,
      },
      events: events.map((event) => [event.id, event.eventKind, event.occurredAt.toISOString()]),
      clarifications: clarifications.rows.map((item) => item.id),
      leave: leave.rows[0]?.id ?? null,
      computed: {
        status: computed.status,
        workedMinutes: computed.workedMinutes,
        breakMinutes: computed.breakMinutes,
        lateMinutes: computed.lateMinutes,
        earlyLeaveMinutes: computed.earlyLeaveMinutes,
        incompleteSession: computed.incompleteSession,
        justified: computed.justified,
      },
    };
    const inputHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");

    const existing = await client.query<ResultRow>(
      `SELECT
         id, employee_id AS "employeeId", work_date::text AS "workDate", version, status,
         schedule_template_id AS "scheduleTemplateId", roster_id AS "rosterId",
         scheduled_start_at AS "scheduledStartAt", scheduled_end_at AS "scheduledEndAt",
         first_check_in_at AS "firstCheckInAt", last_check_out_at AS "lastCheckOutAt",
         worked_minutes AS "workedMinutes", break_minutes AS "breakMinutes",
         late_minutes AS "lateMinutes", early_leave_minutes AS "earlyLeaveMinutes",
         incomplete_session AS "incompleteSession", justified, input_hash AS "inputHash",
         created_at AS "createdAt"
       FROM attendance_result_versions
       WHERE employee_id = $1 AND work_date = $2::date AND input_hash = $3
       LIMIT 1`,
      [employeeId, workDate, inputHash],
    );
    if (existing.rows[0]) {
      await client.query("COMMIT");
      return existing.rows[0];
    }

    const versionResult = await client.query<{ version: number }>(
      `SELECT coalesce(max(version), 0)::int + 1 AS version
       FROM attendance_result_versions
       WHERE employee_id = $1 AND work_date = $2::date`,
      [employeeId, workDate],
    );
    const result = await client.query<ResultRow>(
      `INSERT INTO attendance_result_versions (
         id, employee_id, work_date, version, status, schedule_template_id, roster_id,
         scheduled_start_at, scheduled_end_at, first_check_in_at, last_check_out_at,
         worked_minutes, break_minutes, late_minutes, early_leave_minutes,
         incomplete_session, justified, input_hash, source_event_ids,
         source_clarification_ids, source_leave_request_id, safe_metadata
       ) VALUES (
         $1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11,
         $12, $13, $14, $15, $16, $17, $18, $19::jsonb, $20::jsonb, $21, $22::jsonb
       )
       RETURNING
         id, employee_id AS "employeeId", work_date::text AS "workDate", version, status,
         schedule_template_id AS "scheduleTemplateId", roster_id AS "rosterId",
         scheduled_start_at AS "scheduledStartAt", scheduled_end_at AS "scheduledEndAt",
         first_check_in_at AS "firstCheckInAt", last_check_out_at AS "lastCheckOutAt",
         worked_minutes AS "workedMinutes", break_minutes AS "breakMinutes",
         late_minutes AS "lateMinutes", early_leave_minutes AS "earlyLeaveMinutes",
         incomplete_session AS "incompleteSession", justified, input_hash AS "inputHash",
         created_at AS "createdAt"`,
      [
        randomUUID(), employeeId, workDate, versionResult.rows[0]?.version ?? 1, computed.status,
        schedule.scheduleTemplateId, schedule.rosterId, schedule.scheduledStartAt, schedule.scheduledEndAt,
        computed.firstCheckInAt, computed.lastCheckOutAt, computed.workedMinutes, computed.breakMinutes,
        computed.lateMinutes, computed.earlyLeaveMinutes, computed.incompleteSession, computed.justified,
        inputHash, JSON.stringify(events.map((event) => event.id)),
        JSON.stringify(clarifications.rows.map((item) => item.id)), leave.rows[0]?.id ?? null,
        JSON.stringify({ sessions: computed.sessions.map((session) => ({
          checkInAt: session.checkInAt.toISOString(),
          checkOutAt: session.checkOutAt?.toISOString() ?? null,
        })) }),
      ],
    );
    await client.query("COMMIT");
    if (!result.rows[0]) throw new Error("Attendance result insert did not return a row");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function haversineDistanceMeters(
  left: { latitude: number; longitude: number },
  right: { latitude: number; longitude: number },
) {
  const earthRadius = 6_371_000;
  const toRad = (value: number) => value * Math.PI / 180;
  const dLat = toRad(right.latitude - left.latitude);
  const dLon = toRad(right.longitude - left.longitude);
  const lat1 = toRad(left.latitude);
  const lat2 = toRad(right.latitude);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function jakartaWorkDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
