import type { Pool } from "pg";

import { pageOffset, pagination, type PageQuery } from "../../lib/pagination.js";

// ATT-011-6a §7.4 HC overtime monitoring. The page of requests is chosen first; the kind of day and the
// scan facts are looked up for those rows only, with time-range filters the punch indexes can use.

export type OvertimeListFilter = PageQuery & {
  statuses: string[] | null;
  unitId?: string | null;
};

export async function listOvertimeForHc(pool: Pick<Pool, "query">, filter: OvertimeListFilter) {
  const values = [filter.statuses, filter.unitId ?? null];
  const where = `WHERE ($1::text[] IS NULL OR request.status = ANY($1::text[]))
         AND ($2::uuid IS NULL OR employee.organizational_unit_id = $2)`;
  const [count, page] = await Promise.all([
    pool.query<{ total: number }>(
      `SELECT count(*)::int AS total
       FROM attendance_overtime_requests request
       JOIN employees employee ON employee.id = request.employee_id
       ${where}`,
      values,
    ),
    pool.query(
      `WITH page AS (
         SELECT request.*
         FROM attendance_overtime_requests request
         JOIN employees employee ON employee.id = request.employee_id
         ${where}
         ORDER BY request.work_date DESC, request.created_at DESC, request.id
         LIMIT $3 OFFSET $4
       )
       SELECT request.id, request.employee_id AS "employeeId",
         employee.employee_number AS "employeeNumber", employee.full_name AS "employeeName",
         unit.name AS "unitName", request.work_date::text AS "workDate",
         request.requested_minutes AS "requestedMinutes", request.approved_minutes AS "approvedMinutes",
         request.note, request.status, request.decision_note AS "decisionNote",
         request.created_at AS "createdAt", request.decided_at AS "decidedAt",
         CASE WHEN EXISTS (
           SELECT 1 FROM attendance_overtime_events submitted
           WHERE submitted.overtime_request_id = request.id AND submitted.event_type = 'submitted'
             AND submitted.payload->>'createdByHc' = 'true'
         ) THEN 'hc' ELSE 'employee' END AS "initiatedBy",
         result.day_type AS "dayType",
         CASE
           WHEN result.id IS NULL THEN NULL
           WHEN result.scheduled_start_at IS NOT NULL THEN
             CASE WHEN result.first_check_in_at IS NULL AND result.last_check_out_at IS NULL THEN NULL ELSE
               (greatest(0, coalesce(extract(epoch FROM result.scheduled_start_at - result.first_check_in_at), 0))
                + greatest(0, coalesce(extract(epoch FROM result.last_check_out_at - result.scheduled_end_at), 0)))::int / 60
             END
           ELSE span.minutes
         END AS "scanOutsideScheduleMinutes"
       FROM page request
       JOIN employees employee ON employee.id = request.employee_id
       LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
       LEFT JOIN LATERAL (
         SELECT version.id, version.day_type, version.scheduled_start_at, version.scheduled_end_at,
           version.first_check_in_at, version.last_check_out_at
         FROM attendance_result_versions version
         WHERE version.employee_id = request.employee_id AND version.work_date = request.work_date
         ORDER BY version.version DESC LIMIT 1
       ) result ON true
       -- A day without a schedule: every scan of the day is outside it (first to last scan).
       LEFT JOIN LATERAL (
         SELECT (extract(epoch FROM max(punch.at) - min(punch.at)) / 60)::int AS minutes
         FROM (
           SELECT event.occurred_at AS at FROM attendance_events event
           WHERE event.employee_id = request.employee_id
             AND event.occurred_at >= (request.work_date::timestamp AT TIME ZONE 'Asia/Jakarta')
             AND event.occurred_at < ((request.work_date + 1)::timestamp AT TIME ZONE 'Asia/Jakarta')
           UNION ALL
           SELECT adms.occurred_at FROM attendance_adms_employee_mappings mapping
           JOIN attendance_adms_events adms
             ON adms.device_id = mapping.device_id AND adms.pin = mapping.pin
            AND adms.occurred_at >= greatest(mapping.effective_from, (request.work_date::timestamp AT TIME ZONE 'Asia/Jakarta'))
            AND adms.occurred_at < least(coalesce(mapping.effective_to, 'infinity'::timestamptz), ((request.work_date + 1)::timestamp AT TIME ZONE 'Asia/Jakarta'))
           WHERE mapping.employee_id = request.employee_id
         ) punch
         WHERE result.id IS NOT NULL AND result.scheduled_start_at IS NULL
         HAVING count(*) > 0
       ) span ON true
       ORDER BY request.work_date DESC, request.created_at DESC, request.id`,
      [...values, filter.pageSize, pageOffset(filter)],
    ),
  ]);
  return { ...pagination(filter, count.rows[0]?.total ?? 0), items: page.rows };
}
