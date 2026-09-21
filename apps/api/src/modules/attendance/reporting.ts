import type { Pool } from "pg";

import { resolveSchedule } from "./engine.js";

export type AttendanceReportType =
  | "detail"
  | "period"
  | "unit"
  | "sessions"
  | "scans"
  | "schedule"
  | "overtime";

export type AttendanceReportFilter = {
  type: AttendanceReportType;
  from: string;
  to: string;
  employeeId?: string;
  unitId?: string;
  status?: string;
  scheduleId?: string;
  locationId?: string;
  source?: "adms" | "mobile" | "manual";
  deviceId?: string;
};

type EmployeeRow = {
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  unitId: string | null;
  unitName: string | null;
};

type ResultRow = {
  id: string;
  employeeId: string;
  workDate: string;
  version: number;
  status: string;
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
  overtimeMinutes: number;
  incompleteSession: boolean;
  justified: boolean;
  lateJustified: boolean;
  earlyLeaveJustified: boolean;
  outsideGeofenceJustified: boolean;
  sources: string[] | null;
  deviceIds: string[] | null;
};

function shiftDate(value: string, days: number) {
  const date = new Date(value + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function reportDates(from: string, to: string, maximum = 93) {
  if (from > to) throw new Error("INVALID_REPORT_RANGE");
  const output: string[] = [];
  let cursor = from;
  while (cursor <= to) {
    output.push(cursor);
    if (output.length > maximum) throw new Error("REPORT_RANGE_TOO_LARGE");
    cursor = shiftDate(cursor, 1);
  }
  return output;
}

async function activeEmployees(pool: Pool, filter: Pick<AttendanceReportFilter, "employeeId" | "unitId">) {
  const values: unknown[] = [];
  const clauses = ["employee.status = 'active'"];
  if (filter.employeeId) {
    values.push(filter.employeeId);
    clauses.push(`employee.id = $${values.length}`);
  }
  if (filter.unitId) {
    values.push(filter.unitId);
    clauses.push(`employee.organizational_unit_id = $${values.length}`);
  }
  const result = await pool.query<EmployeeRow>(
    `SELECT employee.id AS "employeeId", employee.employee_number AS "employeeNumber",
       employee.full_name AS "employeeName", unit.id AS "unitId", unit.name AS "unitName"
     FROM employees employee
     LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY unit.name NULLS LAST, employee.full_name`,
    values,
  );
  return result.rows;
}

async function latestResults(pool: Pool, date: string, employeeIds: string[]) {
  if (employeeIds.length === 0) return new Map<string, ResultRow>();
  const result = await pool.query<ResultRow>(
    `SELECT latest.id, latest.employee_id AS "employeeId", latest.work_date::text AS "workDate",
       latest.version, latest.status, latest.schedule_template_id AS "scheduleTemplateId",
       latest.schedule_version_id AS "scheduleVersionId", latest.roster_id AS "rosterId",
       latest.scheduled_start_at AS "scheduledStartAt", latest.scheduled_end_at AS "scheduledEndAt",
       latest.first_check_in_at AS "firstCheckInAt", latest.last_check_out_at AS "lastCheckOutAt",
       latest.worked_minutes AS "workedMinutes", latest.break_minutes AS "breakMinutes",
       latest.late_minutes AS "lateMinutes", latest.early_leave_minutes AS "earlyLeaveMinutes",
       latest.overtime_minutes AS "overtimeMinutes", latest.incomplete_session AS "incompleteSession",
       latest.justified, latest.late_justified AS "lateJustified",
       latest.early_leave_justified AS "earlyLeaveJustified",
       latest.outside_geofence_justified AS "outsideGeofenceJustified",
       evidence.sources, evidence."deviceIds"
     FROM unnest($1::uuid[]) employee_id
     JOIN LATERAL (
       SELECT result.*
       FROM attendance_result_versions result
       WHERE result.employee_id = employee_id
         AND result.work_date = $2::date
       ORDER BY result.version DESC
       LIMIT 1
     ) latest ON true
     LEFT JOIN LATERAL (
       SELECT array_agg(DISTINCT event.source::text ORDER BY event.source::text) AS sources,
              array_agg(DISTINCT event.safe_metadata->>'deviceId')
                FILTER (WHERE event.safe_metadata ? 'deviceId') AS "deviceIds"
       FROM attendance_events event
       WHERE event.id::text IN (
         SELECT jsonb_array_elements_text(latest.source_event_ids)
       )
     ) evidence ON true`,
    [employeeIds, date],
  );
  return new Map(result.rows.map((item) => [item.employeeId, item]));
}

async function leaveDisposition(pool: Pool, employeeId: string, workDate: string) {
  const result = await pool.query<{ disposition: "leave" | "absent" }>(
    `WITH candidates AS (
       SELECT 'leave'::text AS disposition, 1 AS priority
       FROM leave_requests request
       WHERE request.employee_id = $1
         AND request.status = 'approved'
         AND $2::date BETWEEN request.start_on AND request.end_on
         AND (
           request.administration_status IN ('not_applicable', 'validated')
           OR EXISTS (
             SELECT 1 FROM leave_request_validation_days day
             WHERE day.leave_request_id = request.id
               AND day.calendar_date = $2::date
               AND day.status = 'validated'
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM leave_request_validation_days day
           WHERE day.leave_request_id = request.id
             AND day.calendar_date = $2::date
             AND day.status = 'unresolved'
         )
       UNION ALL
       SELECT CASE WHEN resolution.final_resolution = 'unpaid_absence'
                   THEN 'absent' ELSE 'leave' END,
              2
       FROM attendance_resolution_cases resolution
       JOIN attendance_resolution_days day
         ON day.attendance_resolution_case_id = resolution.id
       WHERE resolution.employee_id = $1
         AND resolution.status = 'resolved'
         AND day.calendar_date = $2::date
         AND resolution.final_resolution IN ('dispensation', 'annual_conversion', 'unpaid_absence')
     )
     SELECT disposition FROM candidates ORDER BY priority DESC LIMIT 1`,
    [employeeId, workDate],
  );
  return result.rows[0]?.disposition ?? null;
}

function iso(value: Date | null | undefined) {
  return value?.toISOString() ?? null;
}

export async function attendanceDailyReadModel(
  pool: Pool,
  date: string,
  filter: Pick<AttendanceReportFilter, "employeeId" | "unitId"> = {},
  now = new Date(),
) {
  const employees = await activeEmployees(pool, filter);
  const latest = await latestResults(pool, date, employees.map((item) => item.employeeId));
  const rows = [];
  for (const employee of employees) {
    const result = latest.get(employee.employeeId) ?? null;
    const schedule = await resolveSchedule(pool, employee.employeeId, date);
    if (result) {
      rows.push({
        ...employee,
        workDate: date,
        status: result.status,
        resultVersion: result.version,
        scheduleTemplateId: result.scheduleTemplateId,
        scheduleVersionId: result.scheduleVersionId,
        rosterId: result.rosterId,
        workLocationId: schedule.workLocation?.id ?? null,
        workLocationName: schedule.workLocation?.name ?? null,
        scheduledStartAt: iso(result.scheduledStartAt),
        scheduledEndAt: iso(result.scheduledEndAt),
        firstCheckInAt: iso(result.firstCheckInAt),
        lastCheckOutAt: iso(result.lastCheckOutAt),
        workedMinutes: Number(result.workedMinutes ?? 0),
        breakMinutes: Number(result.breakMinutes ?? 0),
        lateMinutes: Number(result.lateMinutes ?? 0),
        earlyLeaveMinutes: Number(result.earlyLeaveMinutes ?? 0),
        overtimeMinutes: Number(result.overtimeMinutes ?? 0),
        incompleteSession: Boolean(result.incompleteSession),
        justified: Boolean(result.justified),
        lateJustified: Boolean(result.lateJustified),
        earlyLeaveJustified: Boolean(result.earlyLeaveJustified),
        outsideGeofenceJustified: Boolean(result.outsideGeofenceJustified),
        sources: result.sources ?? [],
        deviceIds: result.deviceIds ?? [],
        materialized: true,
      });
      continue;
    }

    const disposition = await leaveDisposition(pool, employee.employeeId, date);
    let status = "configuration_error";
    if (disposition === "leave") status = "leave";
    else if (disposition === "absent") status = "absent";
    else if (schedule.state === "off") status = "off";
    else if (schedule.state === "configuration_error") status = "configuration_error";
    else if (schedule.scheduledStartAt && schedule.scheduledEndAt) {
      if (now < schedule.scheduledStartAt) status = "scheduled";
      else if (now <= schedule.scheduledEndAt) status = "pending";
      else status = "absent";
    }

    rows.push({
      ...employee,
      workDate: date,
      status,
      resultVersion: null,
      scheduleTemplateId: schedule.scheduleTemplateId,
      scheduleVersionId: schedule.scheduleVersionId,
      rosterId: schedule.rosterId,
      workLocationId: schedule.workLocation?.id ?? null,
      workLocationName: schedule.workLocation?.name ?? null,
      scheduledStartAt: iso(schedule.scheduledStartAt),
      scheduledEndAt: iso(schedule.scheduledEndAt),
      firstCheckInAt: null,
      lastCheckOutAt: null,
      workedMinutes: 0,
      breakMinutes: 0,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      overtimeMinutes: 0,
      incompleteSession: false,
      justified: false,
      lateJustified: false,
      earlyLeaveJustified: false,
      outsideGeofenceJustified: false,
      sources: [] as string[],
      deviceIds: [] as string[],
      materialized: false,
    });
  }
  return rows;
}

function rowMatches(row: Awaited<ReturnType<typeof attendanceDailyReadModel>>[number], filter: AttendanceReportFilter) {
  if (filter.status && row.status !== filter.status) return false;
  if (filter.scheduleId && row.scheduleTemplateId !== filter.scheduleId) return false;
  if (filter.locationId && row.workLocationId !== filter.locationId) return false;
  if (filter.source && !row.sources.includes(filter.source)) return false;
  if (filter.deviceId && !row.deviceIds.includes(filter.deviceId)) return false;
  return true;
}

function summarize(rows: Awaited<ReturnType<typeof attendanceDailyReadModel>>) {
  return rows.reduce<Record<string, number>>((accumulator, row) => {
    accumulator[row.status] = (accumulator[row.status] ?? 0) + 1;
    return accumulator;
  }, {});
}

export async function buildAttendanceReport(pool: Pool, filter: AttendanceReportFilter) {
  const dates = reportDates(filter.from, filter.to);
  if (filter.type === "sessions") {
    const values: unknown[] = [filter.from, filter.to];
    const clauses = [
      "session.work_date BETWEEN $1::date AND $2::date",
      `result.id = (
         SELECT current.id FROM attendance_result_versions current
         WHERE current.employee_id = session.employee_id
           AND current.work_date = session.work_date
         ORDER BY current.version DESC LIMIT 1
       )`,
    ];
    if (filter.employeeId) { values.push(filter.employeeId); clauses.push(`session.employee_id = $${values.length}`); }
    if (filter.unitId) { values.push(filter.unitId); clauses.push(`employee.organizational_unit_id = $${values.length}`); }
    if (filter.scheduleId) { values.push(filter.scheduleId); clauses.push(`result.schedule_template_id = $${values.length}`); }
    if (filter.locationId) { values.push(filter.locationId); clauses.push(`schedule_version.work_location_id = $${values.length}`); }
    if (filter.source) {
      values.push(filter.source);
      clauses.push(`EXISTS (
        SELECT 1 FROM attendance_events event
        WHERE event.id::text IN (SELECT jsonb_array_elements_text(result.source_event_ids))
          AND event.source = $${values.length}
      )`);
    }
    if (filter.deviceId) {
      values.push(filter.deviceId);
      clauses.push(`EXISTS (
        SELECT 1 FROM attendance_events event
        WHERE event.id::text IN (SELECT jsonb_array_elements_text(result.source_event_ids))
          AND event.safe_metadata->>'deviceId' = $${values.length}
      )`);
    }
    const result = await pool.query(
      `SELECT session.id, session.employee_id AS "employeeId", employee.employee_number AS "employeeNumber",
         employee.full_name AS "employeeName", unit.name AS "unitName",
         session.work_date::text AS "workDate", session.sequence,
         session.check_in_at AS "checkInAt", session.check_out_at AS "checkOutAt",
         session.worked_minutes AS "workedMinutes", session.complete, session.source_summary AS "sourceSummary",
         result.version AS "resultVersion", result.schedule_template_id AS "scheduleTemplateId",
         schedule_version.work_location_id AS "workLocationId"
       FROM attendance_result_sessions session
       JOIN attendance_result_versions result ON result.id = session.attendance_result_version_id
       JOIN employees employee ON employee.id = session.employee_id
       LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
       LEFT JOIN attendance_schedule_versions schedule_version ON schedule_version.id = result.schedule_version_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY session.work_date, employee.full_name, session.sequence`,
      values,
    );
    return { type: filter.type, from: filter.from, to: filter.to, items: result.rows };
  }

  if (filter.type === "scans") {
    const values: unknown[] = [filter.from, filter.to];
    const clauses = [
      "(event.occurred_at AT TIME ZONE 'Asia/Jakarta')::date BETWEEN $1::date AND $2::date",
    ];
    if (filter.employeeId) { values.push(filter.employeeId); clauses.push(`event.employee_id = $${values.length}`); }
    if (filter.unitId) { values.push(filter.unitId); clauses.push(`employee.organizational_unit_id = $${values.length}`); }
    if (filter.source) { values.push(filter.source); clauses.push(`event.source = $${values.length}`); }
    if (filter.deviceId) { values.push(filter.deviceId); clauses.push(`event.safe_metadata->>'deviceId' = $${values.length}`); }
    const result = await pool.query(
      `SELECT event.id, event.employee_id AS "employeeId", employee.employee_number AS "employeeNumber",
         employee.full_name AS "employeeName", unit.name AS "unitName",
         event.source, event.event_kind AS "eventKind", event.occurred_at AS "occurredAt",
         event.received_at AS "receivedAt", event.source_reference AS "sourceReference",
         event.safe_metadata->>'deviceId' AS "deviceId"
       FROM attendance_events event
       JOIN employees employee ON employee.id = event.employee_id
       LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY event.occurred_at DESC, event.id DESC
       LIMIT 5000`,
      values,
    );
    return { type: filter.type, from: filter.from, to: filter.to, items: result.rows };
  }

  if (filter.type === "overtime") {
    const values: unknown[] = [filter.from, filter.to];
    const clauses = ["request.work_date BETWEEN $1::date AND $2::date"];
    if (filter.employeeId) { values.push(filter.employeeId); clauses.push(`request.employee_id = $${values.length}`); }
    if (filter.unitId) { values.push(filter.unitId); clauses.push(`employee.organizational_unit_id = $${values.length}`); }
    const result = await pool.query(
      `SELECT request.id, request.employee_id AS "employeeId", employee.employee_number AS "employeeNumber",
         employee.full_name AS "employeeName", unit.name AS "unitName",
         request.work_date::text AS "workDate", request.requested_minutes AS "requestedMinutes",
         request.approved_minutes AS "approvedMinutes", request.status, request.note,
         request.decision_note AS "decisionNote", request.created_at AS "createdAt",
         request.decided_at AS "decidedAt"
       FROM attendance_overtime_requests request
       JOIN employees employee ON employee.id = request.employee_id
       LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY request.work_date DESC, request.created_at DESC`,
      values,
    );
    return { type: filter.type, from: filter.from, to: filter.to, items: result.rows };
  }

  const detail = [];
  for (const date of dates) {
    const daily = await attendanceDailyReadModel(pool, date, filter);
    detail.push(...daily.filter((row) => rowMatches(row, filter)));
  }

  if (filter.type === "detail") {
    return { type: filter.type, from: filter.from, to: filter.to, summary: summarize(detail), items: detail };
  }

  if (filter.type === "schedule") {
    return {
      type: filter.type,
      from: filter.from,
      to: filter.to,
      items: detail.map((row) => ({
        employeeId: row.employeeId,
        employeeNumber: row.employeeNumber,
        employeeName: row.employeeName,
        unitName: row.unitName,
        workDate: row.workDate,
        scheduleTemplateId: row.scheduleTemplateId,
        scheduleVersionId: row.scheduleVersionId,
        rosterId: row.rosterId,
        workLocationId: row.workLocationId,
        workLocationName: row.workLocationName,
        scheduledStartAt: row.scheduledStartAt,
        scheduledEndAt: row.scheduledEndAt,
        status: row.status,
      })),
    };
  }

  if (filter.type === "period") {
    const grouped = new Map<string, {
      employeeId: string; employeeNumber: string; employeeName: string; unitName: string | null;
      expectedDays: number; attendanceDays: number; lateDays: number; absenceDays: number;
      leaveDays: number; workedMinutes: number; breakMinutes: number; overtimeMinutes: number;
      lateMinutes: number; earlyLeaveMinutes: number;
    }>();
    for (const row of detail) {
      const item = grouped.get(row.employeeId) ?? {
        employeeId: row.employeeId, employeeNumber: row.employeeNumber, employeeName: row.employeeName,
        unitName: row.unitName, expectedDays: 0, attendanceDays: 0, lateDays: 0, absenceDays: 0,
        leaveDays: 0, workedMinutes: 0, breakMinutes: 0, overtimeMinutes: 0,
        lateMinutes: 0, earlyLeaveMinutes: 0,
      };
      if (!["off", "configuration_error"].includes(row.status)) item.expectedDays += 1;
      if (["present", "late", "incomplete"].includes(row.status)) item.attendanceDays += 1;
      if (row.status === "late") item.lateDays += 1;
      if (row.status === "absent") item.absenceDays += 1;
      if (row.status === "leave") item.leaveDays += 1;
      item.workedMinutes += row.workedMinutes;
      item.breakMinutes += row.breakMinutes;
      item.overtimeMinutes += row.overtimeMinutes;
      item.lateMinutes += row.lateMinutes;
      item.earlyLeaveMinutes += row.earlyLeaveMinutes;
      grouped.set(row.employeeId, item);
    }
    return { type: filter.type, from: filter.from, to: filter.to, items: [...grouped.values()] };
  }

  const grouped = new Map<string, {
    unitId: string | null; unitName: string; employeeIds: Set<string>; expectedDays: number;
    attendanceDays: number; lateDays: number; absenceDays: number; leaveDays: number;
    workedMinutes: number; overtimeMinutes: number;
  }>();
  for (const row of detail) {
    const key = row.unitId ?? "__none__";
    const item = grouped.get(key) ?? {
      unitId: row.unitId, unitName: row.unitName ?? "Tanpa unit", employeeIds: new Set<string>(),
      expectedDays: 0, attendanceDays: 0, lateDays: 0, absenceDays: 0, leaveDays: 0,
      workedMinutes: 0, overtimeMinutes: 0,
    };
    item.employeeIds.add(row.employeeId);
    if (!["off", "configuration_error"].includes(row.status)) item.expectedDays += 1;
    if (["present", "late", "incomplete"].includes(row.status)) item.attendanceDays += 1;
    if (row.status === "late") item.lateDays += 1;
    if (row.status === "absent") item.absenceDays += 1;
    if (row.status === "leave") item.leaveDays += 1;
    item.workedMinutes += row.workedMinutes;
    item.overtimeMinutes += row.overtimeMinutes;
    grouped.set(key, item);
  }
  return {
    type: filter.type,
    from: filter.from,
    to: filter.to,
    items: [...grouped.values()].map(({ employeeIds, ...item }) => ({ ...item, employees: employeeIds.size })),
  };
}
