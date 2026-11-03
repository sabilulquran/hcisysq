// LEAVE-009 storage helpers shared by leave submission, line approval and the calendar.
// Spec: docs/domain/leave-critical-periods.md §5.2–§5.4.

import { randomUUID } from "node:crypto";

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

/** D-06: copy the matched periods onto the request as a waiting review. */
export async function attachCriticalReview(
  db: PoolClient,
  input: {
    requestId: string;
    actorAccountId: string;
    periods: readonly CriticalPeriodSnapshotItem[];
  },
): Promise<string> {
  const reviewId = randomUUID();
  await db.query(
    `INSERT INTO leave_request_critical_reviews (
      id, leave_request_id, status, period_snapshot
    ) VALUES ($1, $2, 'waiting', $3::jsonb)`,
    [reviewId, input.requestId, JSON.stringify(input.periods)],
  );
  await db.query(
    `INSERT INTO leave_request_events (
      id, leave_request_id, actor_account_id, event_type, payload
    ) VALUES ($1, $2, $3, 'leave.critical_review.attached', $4::jsonb)`,
    [
      randomUUID(),
      input.requestId,
      input.actorAccountId,
      JSON.stringify({ reviewId, periodIds: input.periods.map((period) => period.id) }),
    ],
  );
  return reviewId;
}

/**
 * §5.4: called when the last line step is approved. Returns the review id when the request
 * carries a waiting critical review, which then holds the request in review for HC.
 */
export async function activateCriticalReviewAfterLineApproval(
  db: PoolClient,
  requestId: string,
): Promise<string | null> {
  const result = await db.query<{ id: string }>(
    `UPDATE leave_request_critical_reviews
     SET status = 'pending', updated_at = now()
     WHERE leave_request_id = $1 AND status = 'waiting'
     RETURNING id`,
    [requestId],
  );
  return result.rows[0]?.id ?? null;
}
