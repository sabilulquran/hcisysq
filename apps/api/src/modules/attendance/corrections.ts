import type { Pool } from "pg";

// ATT-011-3R Perbaikan Absen (ATT-014 §19.6): employee requests and HC corrections in one list.
// Both already live in attendance_clarifications; an HC correction is a row approved at once whose
// "submitted" event carries administrativeCorrection = true. Raw scans are never changed here.

export type CorrectionOrigin = "employee" | "hc";

export type AttendanceCorrectionFilter = {
  status: "all" | "submitted" | "approved" | "rejected" | "cancelled";
  origin: "all" | CorrectionOrigin;
  mode: "all" | "correction" | "justification";
  from?: string | null | undefined;
  to?: string | null | undefined;
  q?: string | null | undefined;
  page: number;
  pageSize: number;
};

export async function listAttendanceCorrections(pool: Pick<Pool, "query">, filter: AttendanceCorrectionFilter) {
  const result = await pool.query<Record<string, unknown> & { total: number; submittedCount: number }>(
    `WITH rows AS (
       SELECT clarification.*,
         CASE WHEN EXISTS (
           SELECT 1 FROM attendance_clarification_events submitted
           WHERE submitted.clarification_id = clarification.id
             AND submitted.event_type = 'submitted'
             AND submitted.payload->>'administrativeCorrection' = 'true'
         ) THEN 'hc' ELSE 'employee' END AS origin
       FROM attendance_clarifications clarification
     ), filtered AS (
       SELECT rows.*
       FROM rows
       JOIN employees employee ON employee.id = rows.employee_id
       WHERE ($1::text = 'all' OR rows.status = $1)
         AND ($2::text = 'all' OR rows.origin = $2)
         AND ($3::text = 'all' OR rows.mode = $3)
         AND ($4::date IS NULL OR rows.work_date >= $4::date)
         AND ($5::date IS NULL OR rows.work_date <= $5::date)
         AND ($6::text IS NULL OR employee.full_name ILIKE '%' || $6 || '%' OR employee.employee_number ILIKE '%' || $6 || '%')
     )
     SELECT filtered.id, filtered.work_date::text AS "workDate", filtered.kind, filtered.mode, filtered.reason,
       filtered.status, filtered.origin,
       filtered.proposed_check_in_at AS "proposedCheckInAt", filtered.proposed_check_out_at AS "proposedCheckOutAt",
       filtered.decision_note AS "decisionNote", filtered.decided_at AS "decidedAt",
       decider.email AS "decidedByEmail",
       employee.id AS "employeeId", employee.employee_number AS "employeeNumber",
       employee.full_name AS "employeeName", unit.name AS "unitName",
       filtered.created_at AS "createdAt",
       count(*) OVER ()::int AS total,
       (SELECT count(*)::int FROM rows WHERE rows.status = 'submitted') AS "submittedCount"
     FROM filtered
     JOIN employees employee ON employee.id = filtered.employee_id
     LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
     LEFT JOIN accounts decider ON decider.id = filtered.decided_by_account_id
     ORDER BY filtered.work_date DESC, filtered.created_at DESC, filtered.id
     LIMIT $7 OFFSET $8`,
    [
      filter.status, filter.origin, filter.mode, filter.from ?? null, filter.to ?? null,
      filter.q?.trim() ? filter.q.trim() : null, filter.pageSize, (filter.page - 1) * filter.pageSize,
    ],
  );
  const total = result.rows[0]?.total ?? 0;
  return {
    page: filter.page,
    pageSize: filter.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / filter.pageSize)),
    submittedCount: result.rows[0]?.submittedCount ?? null,
    items: result.rows.map(({ total: rowTotal, submittedCount, ...row }) => {
      void rowTotal;
      void submittedCount;
      return row;
    }),
  };
}
