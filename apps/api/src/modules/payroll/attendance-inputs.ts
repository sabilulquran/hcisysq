/**
 * PAY-003 attendance-derived period inputs (specification section 4).
 *
 * Two of the period's inputs are facts attendance already holds, so payroll reads
 * them rather than asking anyone to type them again: approved overtime (ATT-010)
 * and, for contract workers, the days that earn transport.
 *
 * The resolver writes them as ordinary period inputs with origin ATTENDANCE, so
 * the calculation, the review screen and the stale-input fingerprint all treat
 * them exactly like any other input. Human capital can still override one by
 * writing it again as MANUAL; the next resolve would overwrite that, which is why
 * resolving is an explicit action rather than something the calculation does.
 */

import type { Pool } from "pg";

import { saveInputs, type PeriodInputWrite } from "./inputs-store.js";

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
 * Overtime hours per employment: approved minutes only, from requests whose work
 * date falls inside the cutoff window. A late checkout is not overtime; ATT-008
 * says so, and this reads the approved figure rather than any raw duration.
 */
async function resolveOvertime(pool: Pool, window: AttendanceWindow) {
  const { rows } = await pool.query<{ employmentId: string; minutes: string }>(
    `SELECT e.id AS "employmentId", sum(r.approved_minutes)::text AS minutes
     FROM attendance_overtime_requests r
     JOIN employments e ON e.employee_id = r.employee_id
     WHERE r.status = 'approved'
       AND r.approved_minutes > 0
       AND r.work_date BETWEEN $1::date AND $2::date
       AND e.voided_by_action_id IS NULL
       AND coalesce(e.legal_entity_key, '00000000-0000-0000-0000-000000000000'::uuid)
           = coalesce($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
       -- The employment has to cover the day the overtime was worked, so a
       -- rehired employee's old contract does not collect their new hours.
       AND (e.started_on IS NULL OR e.started_on <= r.work_date)
       AND (e.ended_on IS NULL OR e.ended_on >= r.work_date)
     GROUP BY e.id`,
    [window.cutoffStart, window.cutoffEnd, window.legalEntityKey],
  );
  return rows.map((row) => ({
    employmentId: row.employmentId,
    // Minutes to hours, keeping two decimals: the engine multiplies by a rate
    // per hour, and rounding to whole hours would quietly change the pay.
    hours: Math.round((Number(row.minutes) / 60) * 100) / 100,
  }));
}

/**
 * Days that earn PKWT transport: a work day with a recorded check-in inside the
 * cutoff window, counted once (specification section 10 item 4). Lateness does
 * not matter, and leave or a day off earns nothing because neither produces a
 * check-in.
 */
async function resolveAttendanceDays(pool: Pool, window: AttendanceWindow) {
  const { rows } = await pool.query<{ employmentId: string; days: string }>(
    `WITH latest AS (
       SELECT DISTINCT ON (v.employee_id, v.work_date)
              v.employee_id, v.work_date, v.first_check_in_at
       FROM attendance_result_versions v
       WHERE v.work_date BETWEEN $1::date AND $2::date
       ORDER BY v.employee_id, v.work_date, v.version DESC
     )
     SELECT e.id AS "employmentId", count(*)::text AS days
     FROM latest
     JOIN employments e ON e.employee_id = latest.employee_id
     WHERE latest.first_check_in_at IS NOT NULL
       AND e.voided_by_action_id IS NULL
       AND coalesce(e.legal_entity_key, '00000000-0000-0000-0000-000000000000'::uuid)
           = coalesce($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
       AND (e.started_on IS NULL OR e.started_on <= latest.work_date)
       AND (e.ended_on IS NULL OR e.ended_on >= latest.work_date)
       -- Transport belongs to contract workers; a permanent employee's
       -- attendance does not become a transport input (section 5.2).
       AND EXISTS (
         SELECT 1 FROM employment_terms t
         WHERE t.employment_id = e.id
           AND t.voided_by_action_id IS NULL
           AND t.category IN ('KONTRAK', 'KONTRAK_HONORER', 'LEPAS')
           AND (t.effective_from IS NULL OR t.effective_from <= latest.work_date)
           AND (t.effective_to IS NULL OR t.effective_to >= latest.work_date)
       )
     GROUP BY e.id`,
    [window.cutoffStart, window.cutoffEnd, window.legalEntityKey],
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

/**
 * Resolves and stores the attendance inputs for a period, replacing whatever was
 * there for those two keys. Returns how many rows each key produced.
 */
export async function applyAttendanceInputs(
  pool: Pool,
  window: AttendanceWindow,
  actorAccountId: string,
): Promise<{ overtimeCount: number; attendanceCount: number }> {
  const resolved = await resolveAttendanceInputs(pool, window);

  const writes: PeriodInputWrite[] = [
    ...resolved.overtime.map((row) => ({
      employmentId: row.employmentId,
      inputKey: "OVERTIME_HOURS" as const,
      value: row.hours,
      origin: "ATTENDANCE" as const,
    })),
    ...resolved.attendanceDays.map((row) => ({
      employmentId: row.employmentId,
      inputKey: "CONTRACT_ATTENDANCE_DAYS" as const,
      value: row.days,
      origin: "ATTENDANCE" as const,
    })),
  ];

  if (writes.length > 0) {
    await saveInputs(pool, window.periodId, writes, actorAccountId);
  }

  return { overtimeCount: resolved.overtime.length, attendanceCount: resolved.attendanceDays.length };
}
