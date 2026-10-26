import type { Pool } from "pg";

import { pageOffset, pagination, type PageQuery } from "../../lib/pagination.js";

// ATT-014 §20.2 tab "Pengecualian" (package R2b): approved leave and attendance clarifications or HC
// corrections that touch the range, read-only. Leave is listed per request overlapping the range;
// clarifications per work date, every status, so HC also sees what is still waiting.

export type AttendanceExceptionFilter = PageQuery & {
  from: string;
  to: string;
  unitId?: string | null;
  employeeId?: string | null;
};

export type AttendanceException = {
  kind: "leave" | "clarification";
  id: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  unitName: string | null;
  startOn: string;
  endOn: string;
  /** Leave: policy key. Clarification: lateness, early_leave, missing_check_in, ... */
  type: string;
  /** Clarification only: justification or correction. */
  mode: string | null;
  /** Clarification only: employee or hc (an HC correction). */
  origin: "employee" | "hc" | null;
  status: string;
  reason: string | null;
};

export async function attendanceExceptions(pool: Pick<Pool, "query">, filter: AttendanceExceptionFilter) {
  const result = await pool.query<AttendanceException & { total: number }>(
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
      return row;
    }),
  };
}
