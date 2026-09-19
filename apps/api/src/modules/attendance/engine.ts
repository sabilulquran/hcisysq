import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

type ScheduleRow = {
  scheduleTemplateId: string;
  scheduleVersionId: string | null;
  rosterId: string | null;
  isOff: boolean;
  startTime: string | null;
  endTime: string | null;
  endDayOffset: number | null;
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
  scheduleVersionId: string | null;
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
  lateJustified: boolean;
  earlyLeaveJustified: boolean;
  outsideGeofenceJustified: boolean;
  overtimeMinutes: number;
  sessions: AttendanceSession[];
};

type AttendanceEventRow = {
  id: string;
  eventKind: "punch" | "check_in" | "check_out" | "correction";
  occurredAt: Date;
};

type ClarificationRow = {
  id: string;
  kind: "missing_check_in" | "missing_check_out" | "machine_issue" | "lateness" | "early_leave" | "outside_geofence" | "other";
  mode: "correction" | "justification";
  proposedCheckInAt: Date | null;
  proposedCheckOutAt: Date | null;
};

type LeaveDispositionRow = {
  leaveRequestId: string | null;
  resolutionCaseId: string | null;
  disposition: "leave" | "absent";
};

type OvertimeRow = { id: string; approvedMinutes: number };

type ResultRow = {
  id: string;
  employeeId: string;
  workDate: string;
  version: number;
  status: AttendanceComputation["status"];
  scheduleTemplateId: string | null;
  scheduleVersionId: string | null;
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
  lateJustified: boolean;
  earlyLeaveJustified: boolean;
  outsideGeofenceJustified: boolean;
  overtimeMinutes: number;
  inputHash: string;
  createdAt: Date;
};

function isoDateShift(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function jakartaTimestamp(workDate: string, time: string, dayOffset = 0) {
  const date = dayOffset ? isoDateShift(workDate, dayOffset) : workDate;
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
  attendanceDisposition: "leave" | "absent" | null;
  lateJustified: boolean;
  earlyLeaveJustified: boolean;
  outsideGeofenceJustified: boolean;
  overtimeMinutes: number;
  now?: Date;
}): AttendanceComputation {
  const now = input.now ?? new Date();
  const justified = input.lateJustified || input.earlyLeaveJustified || input.outsideGeofenceJustified;
  const empty = (status: AttendanceComputation["status"]) => emptyComputation(status, {
    lateJustified: input.lateJustified,
    earlyLeaveJustified: input.earlyLeaveJustified,
    outsideGeofenceJustified: input.outsideGeofenceJustified,
    overtimeMinutes: input.overtimeMinutes,
  });
  if (input.schedule.state === "configuration_error") {
    return empty("configuration_error");
  }
  if (input.schedule.state === "off") {
    return empty("off");
  }
  if (input.attendanceDisposition === "leave") {
    return empty("leave");
  }
  if (input.attendanceDisposition === "absent") {
    return empty("absent");
  }
  const scheduledStart = input.schedule.scheduledStartAt;
  const scheduledEnd = input.schedule.scheduledEndAt;
  if (!scheduledStart || !scheduledEnd) {
    return empty("configuration_error");
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
    if (now < scheduledStart) return empty("scheduled");
    if (now <= scheduledEnd) return empty("pending");
    return empty("absent");
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
    justified,
    lateJustified: input.lateJustified,
    earlyLeaveJustified: input.earlyLeaveJustified,
    outsideGeofenceJustified: input.outsideGeofenceJustified,
    overtimeMinutes: input.overtimeMinutes,
    sessions: input.sessions,
  };
}

function emptyComputation(
  status: AttendanceComputation["status"],
  input: {
    lateJustified: boolean;
    earlyLeaveJustified: boolean;
    outsideGeofenceJustified: boolean;
    overtimeMinutes: number;
  },
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
    justified: input.lateJustified || input.earlyLeaveJustified || input.outsideGeofenceJustified,
    lateJustified: input.lateJustified,
    earlyLeaveJustified: input.earlyLeaveJustified,
    outsideGeofenceJustified: input.outsideGeofenceJustified,
    overtimeMinutes: input.overtimeMinutes,
    sessions: [],
  };
}

export async function resolveSchedule(
  db: Pool | PoolClient,
  employeeId: string,
  workDate: string,
): Promise<ResolvedSchedule> {
  const roster = await db.query<ScheduleRow>(
    `WITH latest_roster AS (
       SELECT id
       FROM attendance_rosters
       WHERE status = 'PUBLISHED'
         AND week_start = date_trunc('week', $2::date)::date
       ORDER BY version DESC
       LIMIT 1
     )
     SELECT
       entry.schedule_template_id AS "scheduleTemplateId",
       entry.schedule_version_id AS "scheduleVersionId",
       latest.id AS "rosterId",
       coalesce(entry.is_off, false) AS "isOff",
       version.start_time::text AS "startTime",
       version.end_time::text AS "endTime",
       version.end_day_offset AS "endDayOffset",
       version.late_grace_minutes AS "lateGraceMinutes",
       version.early_leave_tolerance_minutes AS "earlyLeaveToleranceMinutes",
       location.id AS "workLocationId",
       location.name AS "locationName",
       location.latitude,
       location.longitude,
       location.radius_meters AS "radiusMeters"
     FROM latest_roster latest
     LEFT JOIN attendance_roster_entries entry
       ON entry.roster_id = latest.id
      AND entry.employee_id = $1
      AND entry.work_date = $2::date
     LEFT JOIN attendance_schedule_versions version ON version.id = entry.schedule_version_id
     LEFT JOIN attendance_work_locations location ON location.id = version.work_location_id`,
    [employeeId, workDate],
  );
  if (roster.rows[0]?.rosterId && (roster.rows[0].scheduleTemplateId || roster.rows[0].isOff)) {
    return mapScheduleRow(roster.rows[0], workDate);
  }

  const holiday = await db.query<{ isWorkingDay: boolean }>(
    `SELECT is_working_day AS "isWorkingDay"
     FROM leave_calendar_exceptions
     WHERE calendar_date = $1::date`,
    [workDate],
  );
  if (holiday.rows[0]?.isWorkingDay === false) {
    return { ...baseSchedule(), state: "off", reason: "calendar_holiday" };
  }

  const assigned = await db.query<ScheduleRow>(
    `SELECT
       assignment.schedule_template_id AS "scheduleTemplateId",
       version.id AS "scheduleVersionId",
       NULL::uuid AS "rosterId",
       false AS "isOff",
       version.start_time::text AS "startTime",
       version.end_time::text AS "endTime",
       version.end_day_offset AS "endDayOffset",
       version.late_grace_minutes AS "lateGraceMinutes",
       version.early_leave_tolerance_minutes AS "earlyLeaveToleranceMinutes",
       location.id AS "workLocationId",
       location.name AS "locationName",
       location.latitude,
       location.longitude,
       location.radius_meters AS "radiusMeters"
     FROM attendance_schedule_assignments assignment
     JOIN attendance_schedule_templates schedule ON schedule.id = assignment.schedule_template_id
     JOIN LATERAL (
       SELECT candidate.*
       FROM attendance_schedule_versions candidate
       WHERE candidate.schedule_template_id = assignment.schedule_template_id
         AND candidate.effective_from <= (($2::date + time '12:00') AT TIME ZONE 'Asia/Jakarta')
         AND (candidate.effective_to IS NULL OR candidate.effective_to > (($2::date + time '12:00') AT TIME ZONE 'Asia/Jakarta'))
       ORDER BY candidate.version DESC
       LIMIT 1
     ) version ON true
     LEFT JOIN attendance_work_locations location ON location.id = version.work_location_id
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
    scheduleVersionId: null,
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
  const endDayOffset = row.endDayOffset ?? (row.endTime <= row.startTime ? 1 : 0);
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
    scheduleVersionId: row.scheduleVersionId,
    rosterId: row.rosterId,
    scheduledStartAt: jakartaTimestamp(workDate, row.startTime),
    scheduledEndAt: jakartaTimestamp(workDate, row.endTime, endDayOffset),
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
      `SELECT id, kind, mode,
         proposed_check_in_at AS "proposedCheckInAt",
         proposed_check_out_at AS "proposedCheckOutAt"
       FROM attendance_clarifications
       WHERE employee_id = $1 AND work_date = $2::date AND status = 'approved'
       ORDER BY created_at, id`,
      [employeeId, workDate],
    );
    const lateJustified = clarifications.rows.some((item) => item.mode === "justification" && item.kind === "lateness");
    const earlyLeaveJustified = clarifications.rows.some((item) => item.mode === "justification" && item.kind === "early_leave");
    const outsideGeofenceJustified = clarifications.rows.some((item) => item.mode === "justification" && item.kind === "outside_geofence");

    const leaveDisposition = await client.query<LeaveDispositionRow>(
      `WITH candidates AS (
         SELECT request.id AS "leaveRequestId", NULL::uuid AS "resolutionCaseId",
                'leave'::text AS disposition, 1 AS priority
         FROM leave_requests request
         WHERE request.employee_id = $1
           AND request.status = 'approved'
           AND $2::date BETWEEN request.start_on AND request.end_on
           AND (
             request.administration_status IN ('not_applicable', 'validated')
             OR EXISTS (
               SELECT 1
               FROM leave_request_validation_days day
               WHERE day.leave_request_id = request.id
                 AND day.calendar_date = $2::date
                 AND day.status = 'validated'
             )
           )
           AND NOT EXISTS (
             SELECT 1
             FROM leave_request_validation_days day
             WHERE day.leave_request_id = request.id
               AND day.calendar_date = $2::date
               AND day.status = 'unresolved'
           )

         UNION ALL

         SELECT resolution.source_leave_request_id AS "leaveRequestId",
                resolution.id AS "resolutionCaseId",
                CASE WHEN resolution.final_resolution = 'unpaid_absence'
                     THEN 'absent' ELSE 'leave' END AS disposition,
                2 AS priority
         FROM attendance_resolution_cases resolution
         JOIN attendance_resolution_days day
           ON day.attendance_resolution_case_id = resolution.id
         WHERE resolution.employee_id = $1
           AND resolution.status = 'resolved'
           AND day.calendar_date = $2::date
           AND resolution.final_resolution IN ('dispensation', 'annual_conversion', 'unpaid_absence')
       )
       SELECT "leaveRequestId", "resolutionCaseId", disposition
       FROM candidates
       ORDER BY priority DESC
       LIMIT 1`,
      [employeeId, workDate],
    );
    const disposition = leaveDisposition.rows[0] ?? null;

    const overtime = await client.query<OvertimeRow>(
      `SELECT id, approved_minutes AS "approvedMinutes"
       FROM attendance_overtime_requests
       WHERE employee_id = $1
         AND work_date = $2::date
         AND status = 'approved'
       ORDER BY decided_at DESC NULLS LAST, created_at DESC
       LIMIT 1`,
      [employeeId, workDate],
    );
    const overtimeMinutes = Number(overtime.rows[0]?.approvedMinutes ?? 0);

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
      attendanceDisposition: disposition?.disposition ?? null,
      lateJustified,
      earlyLeaveJustified,
      outsideGeofenceJustified,
      overtimeMinutes,
      now,
    });
    const input = {
      schedule: {
        state: schedule.state,
        scheduleTemplateId: schedule.scheduleTemplateId,
        scheduleVersionId: schedule.scheduleVersionId,
        rosterId: schedule.rosterId,
        start: schedule.scheduledStartAt?.toISOString() ?? null,
        end: schedule.scheduledEndAt?.toISOString() ?? null,
        lateGraceMinutes: schedule.lateGraceMinutes,
        earlyLeaveToleranceMinutes: schedule.earlyLeaveToleranceMinutes,
      },
      events: events.map((event) => [event.id, event.eventKind, event.occurredAt.toISOString()]),
      clarifications: clarifications.rows.map((item) => item.id),
      leave: disposition?.leaveRequestId ?? null,
      resolutionCase: disposition?.resolutionCaseId ?? null,
      overtime: overtime.rows[0]?.id ?? null,
      computed: {
        status: computed.status,
        workedMinutes: computed.workedMinutes,
        breakMinutes: computed.breakMinutes,
        lateMinutes: computed.lateMinutes,
        earlyLeaveMinutes: computed.earlyLeaveMinutes,
        incompleteSession: computed.incompleteSession,
        justified: computed.justified,
        lateJustified: computed.lateJustified,
        earlyLeaveJustified: computed.earlyLeaveJustified,
        outsideGeofenceJustified: computed.outsideGeofenceJustified,
        overtimeMinutes: computed.overtimeMinutes,
      },
    };
    const inputHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");

    const existing = await client.query<ResultRow>(
      `SELECT
         id, employee_id AS "employeeId", work_date::text AS "workDate", version, status,
         schedule_template_id AS "scheduleTemplateId", schedule_version_id AS "scheduleVersionId", roster_id AS "rosterId",
         scheduled_start_at AS "scheduledStartAt", scheduled_end_at AS "scheduledEndAt",
         first_check_in_at AS "firstCheckInAt", last_check_out_at AS "lastCheckOutAt",
         worked_minutes AS "workedMinutes", break_minutes AS "breakMinutes",
         late_minutes AS "lateMinutes", early_leave_minutes AS "earlyLeaveMinutes",
         incomplete_session AS "incompleteSession", justified,
         late_justified AS "lateJustified", early_leave_justified AS "earlyLeaveJustified",
         outside_geofence_justified AS "outsideGeofenceJustified",
         overtime_minutes AS "overtimeMinutes", input_hash AS "inputHash",
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
         id, employee_id, work_date, version, status, schedule_template_id, schedule_version_id, roster_id,
         scheduled_start_at, scheduled_end_at, first_check_in_at, last_check_out_at,
         worked_minutes, break_minutes, late_minutes, early_leave_minutes,
         incomplete_session, justified, late_justified, early_leave_justified,
         outside_geofence_justified, overtime_minutes, input_hash, source_event_ids,
         source_clarification_ids, source_leave_request_id, source_attendance_resolution_case_id, safe_metadata
       ) VALUES (
         $1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12,
         $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24::jsonb, $25::jsonb, $26, $27, $28::jsonb
       )
       RETURNING
         id, employee_id AS "employeeId", work_date::text AS "workDate", version, status,
         schedule_template_id AS "scheduleTemplateId", schedule_version_id AS "scheduleVersionId", roster_id AS "rosterId",
         scheduled_start_at AS "scheduledStartAt", scheduled_end_at AS "scheduledEndAt",
         first_check_in_at AS "firstCheckInAt", last_check_out_at AS "lastCheckOutAt",
         worked_minutes AS "workedMinutes", break_minutes AS "breakMinutes",
         late_minutes AS "lateMinutes", early_leave_minutes AS "earlyLeaveMinutes",
         incomplete_session AS "incompleteSession", justified,
         late_justified AS "lateJustified", early_leave_justified AS "earlyLeaveJustified",
         outside_geofence_justified AS "outsideGeofenceJustified",
         overtime_minutes AS "overtimeMinutes", input_hash AS "inputHash",
         created_at AS "createdAt"`,
      [
        randomUUID(), employeeId, workDate, versionResult.rows[0]?.version ?? 1, computed.status,
        schedule.scheduleTemplateId, schedule.scheduleVersionId, schedule.rosterId,
        schedule.scheduledStartAt, schedule.scheduledEndAt,
        computed.firstCheckInAt, computed.lastCheckOutAt, computed.workedMinutes, computed.breakMinutes,
        computed.lateMinutes, computed.earlyLeaveMinutes, computed.incompleteSession, computed.justified,
        computed.lateJustified, computed.earlyLeaveJustified, computed.outsideGeofenceJustified,
        computed.overtimeMinutes, inputHash, JSON.stringify(events.map((event) => event.id)),
        JSON.stringify(clarifications.rows.map((item) => item.id)), disposition?.leaveRequestId ?? null,
        disposition?.resolutionCaseId ?? null,
        JSON.stringify({ overtimeRequestId: overtime.rows[0]?.id ?? null }),
      ],
    );
    const insertedResult = result.rows[0];
    if (!insertedResult) throw new Error("Attendance result insert did not return a row");
    for (const [index, session] of computed.sessions.entries()) {
      await client.query(
        `INSERT INTO attendance_result_sessions (
           id, attendance_result_version_id, employee_id, work_date, sequence,
           check_in_at, check_out_at, worked_minutes, complete, source_summary
         ) VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10)`,
        [
          randomUUID(), insertedResult.id, employeeId, workDate, index + 1,
          session.checkInAt, session.checkOutAt,
          session.checkOutAt ? minutesBetween(session.checkInAt, session.checkOutAt) : null,
          Boolean(session.checkOutAt), "normalized attendance events",
        ],
      );
    }
    await client.query("COMMIT");
    return insertedResult;
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
