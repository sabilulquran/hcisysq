import type { Pool } from "pg";

import { pageOffset, pagination, type PageQuery } from "../../lib/pagination.js";
import { LEAVE_POLICY_CATALOG } from "../leave/domain/policy-catalog.js";
import { ARRANGEMENT_TYPE_LABELS, type ArrangementType } from "./work-arrangements.js";

// ATT-014 §20.2 tab "Pengecualian" (package R2b): approved leave and attendance clarifications or HC
// corrections that touch the range, read-only. Leave is listed per request overlapping the range;
// clarifications per work date, every status, so HC also sees what is still waiting.
// TRIP-001 D-11: approved business trips are listed too, per trip overlapping the range. Read-only:
// nothing here writes attendance, and a trip never stands in for a punch.
// ATT-015 §7.4: approved tugas luar, WFH/WFA and applied schedule changes are listed per request.

export type AttendanceExceptionFilter = PageQuery & {
  from: string;
  to: string;
  unitId?: string | null;
  employeeId?: string | null;
};

export type AttendanceException = {
  kind: "leave" | "clarification" | "trip" | "arrangement";
  id: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  unitName: string | null;
  startOn: string;
  endOn: string;
  /** Leave: policy key. Clarification: lateness, early_leave, missing_check_in, ... Trip: destination.
   * Arrangement: FIELD_ASSIGNMENT, REMOTE_WORK or SCHEDULE_CHANGE. */
  type: string;
  /** Leave: the policy name from the catalog; null for clarifications (labelled on screen). */
  typeName: string | null;
  /** Clarification only: justification or correction. */
  mode: string | null;
  /** Clarification only: employee or hc (an HC correction). */
  origin: "employee" | "hc" | null;
  status: string;
  reason: string | null;
};

export async function attendanceExceptions(pool: Pick<Pool, "query">, filter: AttendanceExceptionFilter) {
  const result = await pool.query<Omit<AttendanceException, "typeName"> & { total: number }>(
    `WITH scoped AS (
       SELECT employee.id, employee.employee_number, employee.full_name, unit.name AS unit_name
       FROM employees employee
       LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
       WHERE ($3::uuid IS NULL OR employee.id = $3)
         AND ($4::uuid IS NULL OR employee.organizational_unit_id = $4)
     ), items AS (
       SELECT 'leave'::text AS kind, request.id, request.employee_id, request.start_on, request.end_on,
         request.policy_key AS type, NULL::text AS mode, NULL::text AS origin, request.status, request.reason
       FROM leave_requests request
       WHERE request.status = 'approved' AND request.start_on <= $2::date AND request.end_on >= $1::date
       UNION ALL
       SELECT 'clarification', clarification.id, clarification.employee_id, clarification.work_date, clarification.work_date,
         clarification.kind, clarification.mode,
         CASE WHEN EXISTS (
           SELECT 1 FROM attendance_clarification_events submitted
           WHERE submitted.clarification_id = clarification.id
             AND submitted.event_type = 'submitted'
             AND submitted.payload->>'administrativeCorrection' = 'true'
         ) THEN 'hc' ELSE 'employee' END,
         clarification.status, clarification.reason
       FROM attendance_clarifications clarification
       WHERE clarification.work_date BETWEEN $1::date AND $2::date
       UNION ALL
       SELECT 'trip', trip.id, trip.employee_id, trip.start_on, trip.end_on,
         trip.destination, NULL, NULL, trip.status, trip.purpose
       FROM business_trip_requests trip
       WHERE trip.status IN ('APPROVED', 'ISSUED', 'COMPLETED')
         AND trip.start_on <= $2::date AND trip.end_on >= $1::date
       UNION ALL
       SELECT 'arrangement', arrangement.id, arrangement.employee_id, arrangement.start_on, arrangement.end_on,
         arrangement.arrangement_type, NULL, NULL, arrangement.status, arrangement.purpose
       FROM attendance_work_arrangement_requests arrangement
       WHERE arrangement.status IN ('APPROVED', 'APPLIED')
         AND arrangement.start_on <= $2::date AND arrangement.end_on >= $1::date
     )
     SELECT items.kind, items.id, scoped.id AS "employeeId", scoped.employee_number AS "employeeNumber",
       scoped.full_name AS "employeeName", scoped.unit_name AS "unitName",
       items.start_on::text AS "startOn", items.end_on::text AS "endOn", items.type, items.mode, items.origin,
       items.status, items.reason, count(*) OVER ()::int AS total
     FROM items
     JOIN scoped ON scoped.id = items.employee_id
     ORDER BY items.start_on, scoped.full_name, items.kind, items.id
     LIMIT $5 OFFSET $6`,
    [filter.from, filter.to, filter.employeeId ?? null, filter.unitId ?? null, filter.pageSize, pageOffset(filter)],
  );
  const total = result.rows[0]?.total ?? 0;
  return {
    ...pagination(filter, total),
    items: result.rows.map(({ total: rowTotal, ...row }) => {
      void rowTotal;
      const policy = row.kind === "leave" ? LEAVE_POLICY_CATALOG.find((item) => item.key === row.type) : undefined;
      const typeName = row.kind === "trip" ? "Perjalanan Dinas"
        : row.kind === "arrangement" ? ARRANGEMENT_TYPE_LABELS[row.type as ArrangementType] ?? row.type
        : policy?.name ?? (row.kind === "leave" ? row.type : null);
      return { ...row, typeName };
    }),
  };
}
