// LEAVE-009 storage helper shared by leave preview, submission and the calendar. Since D-12
// (2026-11-18) a critical period is only matched, warned about and recorded on the request, so
// there is nothing here that writes a review row. Spec: docs/domain/leave-critical-periods.md §5.2.

import type { Pool, PoolClient } from "pg";

import {
  matchCriticalPeriods,
  type CriticalPeriodRecord,
  type CriticalPeriodSnapshotItem,
} from "./domain/critical-period.js";

interface CriticalPeriodRow {
  id: string;
  label: string;
  startOn: string;
  endOn: string;
  unitId: string | null;
  unitName: string | null;
  isActive: boolean;
}

/**
 * Active periods for the foundation or one unit that overlap a date range. Bounded by the
 * range itself: the result is the handful of periods that touch these dates.
 */
export async function loadApplicableCriticalPeriods(
  db: Pool | PoolClient,
  input: { unitId: string | null; startOn: string; endOn: string },
): Promise<CriticalPeriodSnapshotItem[]> {
  const result = await db.query<CriticalPeriodRow>(
    `SELECT
      period.id,
      period.label,
      period.starts_on::text AS "startOn",
      period.ends_on::text AS "endOn",
      period.organizational_unit_id AS "unitId",
      unit.name AS "unitName",
      period.is_active AS "isActive"
    FROM leave_critical_periods period
    LEFT JOIN organizational_units unit ON unit.id = period.organizational_unit_id
    WHERE period.is_active
      AND period.starts_on <= $3::date
      AND period.ends_on >= $2::date
      AND (period.organizational_unit_id IS NULL OR period.organizational_unit_id = $1::uuid)
    ORDER BY period.starts_on ASC, period.id ASC`,
    [input.unitId, input.startOn, input.endOn],
  );
  const records: CriticalPeriodRecord[] = result.rows;
  return matchCriticalPeriods(records, input);
}
