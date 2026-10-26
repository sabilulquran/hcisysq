import type { Pool } from "pg";

import { pageOffset, pagination, type PageQuery } from "../../lib/pagination.js";
import type { AdminPermission } from "../auth/permissions.js";

// ATT-011-3 §6.1 "Perlu tindakan": one queue, oldest date first, of everything that waits for HC.
// Each kind appears only for accounts holding the permission that acts on it, so the queue never shows
// a task the reader cannot finish. Read-only; the actions use their existing endpoints. Leave
// resolutions (LEAVE-007) keep their own HC page: their permission is not an admin permission (TBD).

export type ActionKind = "clarification" | "mobile_review" | "incomplete" | "configuration_error";

export const ACTION_KIND_PERMISSIONS: Record<ActionKind, readonly AdminPermission[]> = {
  clarification: ["attendance.clarification.manage"],
  mobile_review: ["attendance.clarification.manage"],
  incomplete: ["attendance.records.manage", "attendance.reports.read"],
  configuration_error: ["attendance.reports.read", "attendance.schedule.manage"],
};

export const ACTION_QUEUE_PERMISSIONS = [
  ...new Set(Object.values(ACTION_KIND_PERMISSIONS).flat()),
] as AdminPermission[];

export function allowedActionKinds(held: readonly AdminPermission[]): ActionKind[] {
  return (Object.keys(ACTION_KIND_PERMISSIONS) as ActionKind[])
    .filter((kind) => ACTION_KIND_PERMISSIONS[kind].some((permission) => held.includes(permission)));
}

export type ActionQueueFilter = PageQuery & {
  from: string;
  to: string;
  /** "Tidak lengkap > 1 hari" (§6.1): incomplete days on or before this date; yesterday may still be fixed by a scan. */
  incompleteBefore: string;
  unitId?: string | null;
  kind?: ActionKind | null;
  kinds: readonly ActionKind[];
};

export type ActionQueueItem = {
  kind: ActionKind;
  id: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  unitName: string | null;
  workDate: string;
  /** Clarification: kind (lateness, ...). Mobile: geofence status. Result: status. */
  detail: string | null;
  mode: string | null;
  reason: string | null;
  occurredAt: string | null;
};

// $1 from, $2 to, $3 unitId, $4 kinds, $5 incompleteBefore.
const QUEUE = `WITH scoped AS (
       SELECT employee.id, employee.employee_number, employee.full_name, unit.name AS unit_name
       FROM employees employee
       LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
       WHERE ($3::uuid IS NULL OR employee.organizational_unit_id = $3)
     ), latest AS (
       SELECT DISTINCT ON (version.employee_id, version.work_date)
         version.id, version.employee_id, version.work_date, version.status
       FROM attendance_result_versions version
       JOIN scoped ON scoped.id = version.employee_id
       WHERE version.work_date BETWEEN $1::date AND $2::date
       ORDER BY version.employee_id, version.work_date, version.version DESC
     ), items AS (
       SELECT 'clarification'::text AS kind, clarification.id, clarification.employee_id, clarification.work_date,
         clarification.kind AS detail, clarification.mode, clarification.reason, NULL::timestamptz AS occurred_at
       FROM attendance_clarifications clarification
       WHERE 'clarification' = ANY($4::text[]) AND clarification.status = 'submitted'
         AND clarification.work_date BETWEEN $1::date AND $2::date
       UNION ALL
       -- A flagged phone punch leaves the queue once a clarification for that day was decided.
       SELECT 'mobile_review', evidence.id, evidence.employee_id, (event.occurred_at AT TIME ZONE 'Asia/Jakarta')::date,
         evidence.geofence_status, evidence.action, NULL, event.occurred_at
       FROM attendance_mobile_evidence evidence
       JOIN attendance_events event ON event.id = evidence.event_id
       WHERE 'mobile_review' = ANY($4::text[]) AND evidence.review_state = 'needs_review'
         AND (event.occurred_at AT TIME ZONE 'Asia/Jakarta')::date BETWEEN $1::date AND $2::date
         AND NOT EXISTS (
           SELECT 1 FROM attendance_clarifications decided
           WHERE decided.employee_id = evidence.employee_id
             AND decided.work_date = (event.occurred_at AT TIME ZONE 'Asia/Jakarta')::date
             AND decided.status IN ('approved', 'rejected')
         )
       UNION ALL
       SELECT latest.status, latest.id, latest.employee_id, latest.work_date, latest.status, NULL, NULL, NULL
       FROM latest
       WHERE (latest.status = 'incomplete' AND 'incomplete' = ANY($4::text[]) AND latest.work_date <= $5::date
              AND NOT EXISTS (
                SELECT 1 FROM attendance_clarifications pending
                WHERE pending.employee_id = latest.employee_id AND pending.work_date = latest.work_date
                  AND pending.status = 'submitted'
              ))
          OR (latest.status = 'configuration_error' AND 'configuration_error' = ANY($4::text[]))
     ), joined AS (
       SELECT items.*, scoped.employee_number, scoped.full_name, scoped.unit_name
       FROM items JOIN scoped ON scoped.id = items.employee_id
     )`;

export async function attendanceActionQueue(pool: Pick<Pool, "query">, filter: ActionQueueFilter) {
  const shared = [filter.from, filter.to, filter.unitId ?? null, filter.kinds, filter.incompleteBefore];
  const [page, counts] = await Promise.all([
    pool.query<Omit<ActionQueueItem, "occurredAt"> & { occurredAt: Date | null; total: number }>(
      `${QUEUE}
       SELECT joined.kind, joined.id, joined.employee_id AS "employeeId", joined.employee_number AS "employeeNumber",
         joined.full_name AS "employeeName", joined.unit_name AS "unitName", joined.work_date::text AS "workDate",
         joined.detail, joined.mode, joined.reason, joined.occurred_at AS "occurredAt",
         count(*) OVER ()::int AS total
       FROM joined
       WHERE ($6::text IS NULL OR joined.kind = $6)
       ORDER BY joined.work_date, joined.full_name, joined.kind, joined.id
       LIMIT $7 OFFSET $8`,
      [...shared, filter.kind ?? null, filter.pageSize, pageOffset(filter)],
    ),
    pool.query<{ kind: ActionKind; n: number }>(`${QUEUE} SELECT kind, count(*)::int AS n FROM joined GROUP BY kind`, shared),
  ]);
  const total = page.rows[0]?.total ?? 0;
  return {
    ...pagination(filter, total),
    kinds: filter.kinds,
    counts: Object.fromEntries(counts.rows.map((row) => [row.kind, row.n])) as Partial<Record<ActionKind, number>>,
    items: page.rows.map(({ total: rowTotal, occurredAt, ...row }) => {
      void rowTotal;
      return { ...row, occurredAt: occurredAt ? new Date(occurredAt).toISOString() : null };
    }),
  };
}
