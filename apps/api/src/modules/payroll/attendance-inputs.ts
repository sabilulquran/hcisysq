/**
 * PAY-003 attendance-derived period inputs (specification section 4).
 *
 * Two of the period's inputs are facts attendance already holds, so payroll reads
 * them rather than asking anyone to type them again: approved overtime (ATT-010)
 * and, for contract workers, the days that earn transport.
 *
 * The resolver writes them as ordinary period inputs with origin ATTENDANCE, so
 * the calculation, the review screen and the stale-input fingerprint all treat
 * them exactly like any other input. Resolving replaces the whole set: a row it
 * wrote last time and no longer finds is removed, because an overtime request
 * that was cancelled must stop being paid. That is also why resolving is an
 * explicit action rather than something the calculation does — it overwrites a
 * correction human capital typed by hand.
 */

import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { ATTENDANCE_INPUT_KEYS, ownEmploymentIds, type InputKey } from "./inputs-store.js";
import { writeAudit } from "./store.js";

/** The two keys this resolver owns. Nothing else it writes, nothing else it clears. */
export { ATTENDANCE_INPUT_KEYS };

/**
 * Only these categories have an overtime component (specification section 5.2:
 * a contract worker is paid per attendance and per teaching hour, not overtime).
 */
const OVERTIME_CATEGORIES = ["TETAP", "PERCOBAAN"];

/** Transport belongs to contract workers, and to nobody else. */
const TRANSPORT_CATEGORIES = ["KONTRAK", "KONTRAK_HONORER", "LEPAS"];

export type AttendanceWindow = {
  periodId: string;
  /** Cutoff window of the period, inclusive, Asia/Jakarta calendar dates. */
  cutoffStart: string;
  cutoffEnd: string;
  legalEntityKey: string | null;
};

export type ResolvedAttendanceInputs = {
  overtime: Array<{ employmentId: string; hours: number }>;
  attendanceDays: Array<{ employmentId: string; days: number }>;
};

/**
 * The employment rows a work date may be credited to. An employment whose end
 * date is unknown is excluded: EMP-005 stores it with no end date, and the
 * no-overlap constraint does not cover it, so leaving it in would let a rehired
 * employee's old contract collect the same day as the new one.
 */
const EMPLOYMENT_COVERS_DAY = `
  e.voided_by_action_id IS NULL
  AND e.end_basis IS DISTINCT FROM 'UNKNOWN'
  AND coalesce(e.legal_entity_key, '00000000-0000-0000-0000-000000000000'::uuid)
      = coalesce($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
`;

const TERM_CATEGORY_ON_DAY = `
  EXISTS (
    SELECT 1 FROM employment_terms t
    WHERE t.employment_id = e.id
      AND t.voided_by_action_id IS NULL
      AND t.category = ANY($4::text[])
      AND (t.effective_from IS NULL OR t.effective_from <= work_day)
      AND (t.effective_to IS NULL OR t.effective_to >= work_day)
  )
`;

/**
 * Overtime hours per employment: approved minutes only, from requests whose work
 * date falls inside the cutoff window. A late checkout is not overtime; ATT-008
 * says so, and this reads the approved figure rather than any raw duration.
 */
async function resolveOvertime(pool: Pool, window: AttendanceWindow) {
  const { rows } = await pool.query<{ employmentId: string; minutes: string }>(
    `SELECT e.id AS "employmentId", sum(r.approved_minutes)::text AS minutes
     FROM attendance_overtime_requests r
     JOIN employments e ON e.employee_id = r.employee_id
     CROSS JOIN LATERAL (SELECT r.work_date AS work_day) day
     WHERE r.status = 'approved'
       AND r.approved_minutes > 0
       AND r.work_date BETWEEN $1::date AND $2::date
       AND ${EMPLOYMENT_COVERS_DAY}
       AND (e.started_on IS NULL OR e.started_on <= r.work_date)
       AND (e.ended_on IS NULL OR e.ended_on >= r.work_date)
       AND ${TERM_CATEGORY_ON_DAY}
     GROUP BY e.id`,
    [window.cutoffStart, window.cutoffEnd, window.legalEntityKey, OVERTIME_CATEGORIES],
  );
  return rows.map((row) => ({
    employmentId: row.employmentId,
    // Minutes to hours at four decimals, which is what the column stores. Two
    // decimals would be a tenth of a rupiah-per-hour's worth of rounding either
    // way, and rounding up would invent money the foundation never owed.
    hours: Math.round((Number(row.minutes) / 60) * 10_000) / 10_000,
  }));
}

/**
 * Days that earn PKWT transport: a working day with a recorded check-in inside
 * the cutoff window, counted once (specification section 10 item 4). Lateness
 * does not matter. A rest day or a public holiday earns no transport unless the
 * employee was scheduled to work it; days recorded before ATT-014 added the day
 * type carry NULL and are treated as working days, since that is what they were.
 */
async function resolveAttendanceDays(pool: Pool, window: AttendanceWindow) {
  const { rows } = await pool.query<{ employmentId: string; days: string }>(
    `WITH latest AS (
       SELECT DISTINCT ON (v.employee_id, v.work_date)
              v.employee_id, v.work_date, v.first_check_in_at, v.day_type, v.holiday_scheduled_work
       FROM attendance_result_versions v
       WHERE v.work_date BETWEEN $1::date AND $2::date
       ORDER BY v.employee_id, v.work_date, v.version DESC
     )
     SELECT e.id AS "employmentId", count(*)::text AS days
     FROM latest
     JOIN employments e ON e.employee_id = latest.employee_id
     CROSS JOIN LATERAL (SELECT latest.work_date AS work_day) day
     WHERE latest.first_check_in_at IS NOT NULL
       AND (
         latest.day_type IS NULL
         OR latest.day_type = 'working_day'
         OR latest.holiday_scheduled_work IS TRUE
       )
       AND ${EMPLOYMENT_COVERS_DAY}
       AND (e.started_on IS NULL OR e.started_on <= latest.work_date)
       AND (e.ended_on IS NULL OR e.ended_on >= latest.work_date)
       AND ${TERM_CATEGORY_ON_DAY}
     GROUP BY e.id`,
    [window.cutoffStart, window.cutoffEnd, window.legalEntityKey, TRANSPORT_CATEGORIES],
  );
  return rows.map((row) => ({ employmentId: row.employmentId, days: Number(row.days) }));
}

export async function resolveAttendanceInputs(
  pool: Pool,
  window: AttendanceWindow,
): Promise<ResolvedAttendanceInputs> {
  const [overtime, attendanceDays] = await Promise.all([
    resolveOvertime(pool, window),
    resolveAttendanceDays(pool, window),
  ]);
  return { overtime, attendanceDays };
}

export type AttendanceResolveOutcome = {
  overtimeCount: number;
  attendanceCount: number;
  /** Rows an earlier resolve had written that attendance no longer supports. */
  clearedCount: number;
  /** Rows left alone because they belong to the actor's own employment. */
  skippedOwnCount: number;
};

/**
 * Resolves and stores the attendance inputs for a period. The whole set is
 * replaced: anything the resolver wrote before and does not find again is
 * removed, so a cancelled overtime request stops being paid.
 */
export async function applyAttendanceInputs(
  pool: Pool,
  window: AttendanceWindow,
  actorAccountId: string,
): Promise<AttendanceResolveOutcome> {
  const resolved = await resolveAttendanceInputs(pool, window);
  // Nobody records their own period inputs, this route included
  // (specification section 2).
  const own = await ownEmploymentIds(pool, actorAccountId);

  const overtime = resolved.overtime.filter((row) => !own.has(row.employmentId));
  const attendanceDays = resolved.attendanceDays.filter((row) => !own.has(row.employmentId));
  const skippedOwnCount =
    resolved.overtime.length - overtime.length + (resolved.attendanceDays.length - attendanceDays.length);

  const rows = [
    ...overtime.map((row) => ({ employmentId: row.employmentId, inputKey: "OVERTIME_HOURS", value: row.hours })),
    ...attendanceDays.map((row) => ({
      employmentId: row.employmentId,
      inputKey: "CONTRACT_ATTENDANCE_DAYS",
      value: row.days,
    })),
  ];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Clear what this resolver wrote last time, keeping any MANUAL row for an
    // employment it is about to write again (the upsert replaces that one) and
    // any MANUAL row it no longer touches at all.
    const cleared = await client.query(
      `DELETE FROM payroll_period_inputs
       WHERE period_id = $1
         AND origin = 'ATTENDANCE'
         AND input_key = ANY($2::text[])
         AND NOT (employment_id = ANY($3::uuid[]))`,
      [
        window.periodId,
        ATTENDANCE_INPUT_KEYS,
        own.size === 0 ? [] : [...own],
      ],
    );

    for (const row of rows) {
      await client.query(
        `INSERT INTO payroll_period_inputs(
           id, period_id, employment_id, input_key, value, origin, recorded_by_account_id)
         VALUES ($1, $2, $3, $4, $5, 'ATTENDANCE', $6)
         ON CONFLICT (period_id, employment_id, input_key) DO UPDATE SET
           value = EXCLUDED.value,
           origin = EXCLUDED.origin,
           reason = NULL,
           decision_reference = NULL,
           recorded_by_account_id = EXCLUDED.recorded_by_account_id,
           recorded_at = now()`,
        [randomUUID(), window.periodId, row.employmentId, row.inputKey, row.value, actorAccountId],
      );
    }

    // Identifiers, the window and counts only: no per-person figure (section 8).
    await writeAudit(client, {
      actorAccountId,
      action: "payroll.period.attendance_resolved",
      periodId: window.periodId,
      payload: {
        cutoff_start: window.cutoffStart,
        cutoff_end: window.cutoffEnd,
        overtime_count: overtime.length,
        attendance_count: attendanceDays.length,
        cleared_count: cleared.rowCount ?? 0,
        skipped_own_count: skippedOwnCount,
      },
    });

    await client.query("COMMIT");
    return {
      overtimeCount: overtime.length,
      attendanceCount: attendanceDays.length,
      clearedCount: cleared.rowCount ?? 0,
      skippedOwnCount,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
