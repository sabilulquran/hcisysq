import type { Pool } from "pg";

import { calculationPairs, type CalculationScope } from "./calculation-runner.js";
import { jakartaWorkDate } from "./engine.js";

// ATT-014-2 detail rows (docs/domain/attendance-report-calculation.md §6.2, §6.5). This read model
// never calculates a verdict: it reads stored result versions, says which pairs are outside the
// coverage rule or not calculated yet, and flags results whose inputs changed afterwards.

export type CalculationRowStatus =
  | "scheduled" | "pending" | "present" | "late" | "incomplete" | "leave" | "absent" | "off" | "configuration_error"
  | "unscheduled" | "not_captured" | "not_calculated";

type EmployeeRow = { employeeId: string; employeeNumber: string; employeeName: string; unitId: string | null; unitName: string | null };

type StoredResult = {
  employeeId: string;
  workDate: string;
  version: number;
  status: Exclude<CalculationRowStatus, "unscheduled" | "not_captured" | "not_calculated">;
  scheduledStartAt: Date | null;
  scheduledEndAt: Date | null;
  firstCheckInAt: Date | null;
  lastCheckOutAt: Date | null;
  workedMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
  incompleteSession: boolean;
  hasDisposition: boolean;
  /** A schedule pattern or published roster entry covers the date (R2a: tells a rest day from no schedule). */
  hasScheduleCoverage: boolean;
  createdAt: Date;
  calculatedAt: Date;
  changed: boolean;
};

const CLOCK_STATUSES = new Set(["scheduled", "pending", "absent"]);

/**
 * D-14-4: today's result is provisional. A scheduled day without any check-in is re-evaluated by the
 * clock on read, so a result calculated in the morning does not stay "scheduled" after the shift.
 * The same rule as evaluateSessions; a final leave/resolution disposition is never re-evaluated.
 */
export function provisionalStatus(result: Pick<StoredResult, "status" | "scheduledStartAt" | "scheduledEndAt" | "firstCheckInAt" | "hasDisposition">, now: Date) {
  if (!CLOCK_STATUSES.has(result.status) || result.firstCheckInAt || result.hasDisposition) return result.status;
  if (!result.scheduledStartAt || !result.scheduledEndAt) return result.status;
  if (now < new Date(result.scheduledStartAt)) return "scheduled";
  if (now <= new Date(result.scheduledEndAt)) return "pending";
  return "absent";
}

/** §6.3 before ATT-013: Normal 1 for a scheduled day; Riil 1 present/late, 0 absent, empty otherwise. */
export function normalActual(status: CalculationRowStatus) {
  if (status === "present" || status === "late") return { normal: 1, actual: 1 };
  if (status === "absent") return { normal: 1, actual: 0 };
  if (["incomplete", "leave", "scheduled", "pending"].includes(status)) return { normal: 1, actual: null };
  return { normal: null, actual: null };
}

async function storedResults(pool: Pick<Pool, "query">, employeeIds: string[], from: string, to: string) {
  if (employeeIds.length === 0) return [];
  const result = await pool.query<StoredResult>(
    `WITH latest AS (
       SELECT DISTINCT ON (version.employee_id, version.work_date) version.*
       FROM attendance_result_versions version
       WHERE version.employee_id = ANY($1::uuid[])
         AND version.work_date BETWEEN $2::date AND $3::date
       ORDER BY version.employee_id, version.work_date, version.version DESC
     ), checked AS (
       SELECT latest.*,
         greatest(latest.created_at, coalesce(run.started_at, latest.created_at)) AS calculated_at,
         coalesce(latest.scheduled_start_at - interval '6 hours', latest.work_date::timestamp AT TIME ZONE 'Asia/Jakarta') AS window_start,
         coalesce(latest.scheduled_end_at + interval '6 hours', (latest.work_date + 1)::timestamp AT TIME ZONE 'Asia/Jakarta') AS window_end
       FROM latest
       JOIN employees employee ON employee.id = latest.employee_id
       LEFT JOIN LATERAL (
         -- A completed run that covered the pair counts as a calculation even when the engine reused
         -- the existing version (same input_hash), so the freshness check does not stay stuck.
         SELECT max(candidate.started_at) AS started_at
         FROM attendance_calculation_runs candidate
         WHERE candidate.status = 'completed'
           AND latest.work_date BETWEEN candidate.date_from AND candidate.date_to
           AND (candidate.employee_id IS NULL OR candidate.employee_id = latest.employee_id)
           AND (candidate.unit_id IS NULL OR candidate.unit_id = employee.organizational_unit_id)
       ) run ON true
     )
     SELECT checked.employee_id AS "employeeId", checked.work_date::text AS "workDate", checked.version, checked.status,
       checked.scheduled_start_at AS "scheduledStartAt", checked.scheduled_end_at AS "scheduledEndAt",
       checked.first_check_in_at AS "firstCheckInAt", checked.last_check_out_at AS "lastCheckOutAt",
       checked.worked_minutes AS "workedMinutes", checked.late_minutes AS "lateMinutes",
       checked.early_leave_minutes AS "earlyLeaveMinutes", checked.overtime_minutes AS "overtimeMinutes",
       checked.incomplete_session AS "incompleteSession",
       (checked.source_leave_request_id IS NOT NULL OR checked.source_attendance_resolution_case_id IS NOT NULL) AS "hasDisposition",
       (
         EXISTS (
           SELECT 1 FROM attendance_schedule_assignments assignment
           WHERE assignment.employee_id = checked.employee_id
             AND checked.work_date >= assignment.effective_from
             AND (assignment.effective_to IS NULL OR checked.work_date <= assignment.effective_to)
         )
         OR EXISTS (
           SELECT 1
           FROM attendance_roster_entries entry
           JOIN attendance_rosters roster ON roster.id = entry.roster_id AND roster.status = 'PUBLISHED'
           WHERE entry.employee_id = checked.employee_id AND entry.work_date = checked.work_date
         )
       ) AS "hasScheduleCoverage",
       checked.created_at AS "createdAt", checked.calculated_at AS "calculatedAt",
       (
         EXISTS (
           SELECT 1
           FROM attendance_adms_events event
           JOIN attendance_adms_employee_mappings mapping
             ON mapping.device_id = event.device_id
            AND mapping.pin = event.pin
            AND event.occurred_at >= mapping.effective_from
            AND (mapping.effective_to IS NULL OR event.occurred_at < mapping.effective_to)
           WHERE mapping.employee_id = checked.employee_id
             AND event.created_at > checked.calculated_at
             AND event.occurred_at BETWEEN checked.window_start AND checked.window_end
         )
         OR EXISTS (
           SELECT 1 FROM attendance_events event
           WHERE event.employee_id = checked.employee_id
             AND event.created_at > checked.calculated_at
             AND event.occurred_at BETWEEN checked.window_start AND checked.window_end
         )
         OR EXISTS (
           SELECT 1 FROM attendance_schedule_assignments assignment
           WHERE assignment.employee_id = checked.employee_id
             AND assignment.created_at > checked.calculated_at
             AND checked.work_date >= assignment.effective_from
             AND (assignment.effective_to IS NULL OR checked.work_date <= assignment.effective_to)
         )
         OR EXISTS (
           SELECT 1
           FROM attendance_roster_entries entry
           JOIN attendance_rosters roster ON roster.id = entry.roster_id
           WHERE entry.employee_id = checked.employee_id
             AND entry.work_date = checked.work_date
             AND roster.status = 'PUBLISHED'
             AND roster.published_at > checked.calculated_at
         )
         OR EXISTS (
           -- §20.10: a shift whose start was moved earlier now gives a schedule to dates it did not cover.
           SELECT 1
           FROM access_audit_events audit
           JOIN attendance_schedule_assignments assignment ON assignment.schedule_template_id = audit.entity_id
           WHERE audit.action = 'attendance.schedule.backdated'
             AND audit.occurred_at > checked.calculated_at
             AND assignment.employee_id = checked.employee_id
             AND checked.work_date >= assignment.effective_from
             AND (assignment.effective_to IS NULL OR checked.work_date <= assignment.effective_to)
         )
       ) AS changed
     FROM checked`,
    [employeeIds, from, to],
  );
  return result.rows;
}

export async function attendanceCalculationRows(
  pool: Pick<Pool, "query">,
  scope: CalculationScope,
  filter: { status?: CalculationRowStatus; changedOnly?: boolean; page?: number; pageSize?: number } = {},
  now = new Date(),
) {
  const today = jakartaWorkDate(now);
  const { covered, uncovered } = await calculationPairs(pool, scope);
  const employeeIds = [...new Set([...covered, ...uncovered].map((pair) => pair.employeeId))];
  const [employees, results] = await Promise.all([
    employeeIds.length === 0
      ? Promise.resolve([] as EmployeeRow[])
      : pool.query<EmployeeRow>(
          `SELECT employee.id AS "employeeId", employee.employee_number AS "employeeNumber",
             employee.full_name AS "employeeName", unit.id AS "unitId", unit.name AS "unitName"
           FROM employees employee
           LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
           WHERE employee.id = ANY($1::uuid[])`,
          [employeeIds],
        ).then((result) => result.rows),
    storedResults(pool, employeeIds, scope.from, scope.to),
  ]);
  const employeeById = new Map(employees.map((employee) => [employee.employeeId, employee]));
  const resultByPair = new Map(results.map((result) => [`${result.employeeId}:${result.workDate}`, result]));
  const uncoveredKeys = new Set(uncovered.map((pair) => `${pair.employeeId}:${pair.workDate}`));

  const summary: Record<string, number> = {};
  let changedCount = 0;
  let lastCalculatedAt: Date | null = null;
  const items = [...covered, ...uncovered].map((pair) => {
    const key = `${pair.employeeId}:${pair.workDate}`;
    const employee = employeeById.get(pair.employeeId);
    const stored = uncoveredKeys.has(key) ? undefined : resultByPair.get(key);
    const provisional = pair.workDate === today;
    const status: CalculationRowStatus = uncoveredKeys.has(key)
      ? "not_captured"
      : !stored ? "not_calculated"
        // ATT-014 §20.1: the engine writes "off" both for a rest day and for a day without any
        // schedule; only the first is a real day off (Libur).
        : stored.status === "off" && !stored.hasScheduleCoverage ? "unscheduled"
          : provisional ? provisionalStatus(stored, now) : stored.status;
    const changed = Boolean(stored?.changed);
    if (changed) changedCount += 1;
    if (stored && (!lastCalculatedAt || stored.calculatedAt > lastCalculatedAt)) lastCalculatedAt = stored.calculatedAt;
    return {
      employeeId: pair.employeeId,
      employeeNumber: employee?.employeeNumber ?? null,
      employeeName: employee?.employeeName ?? null,
      unitId: employee?.unitId ?? null,
      unitName: employee?.unitName ?? null,
      workDate: pair.workDate,
      status,
      provisional,
      changedSinceCalculated: changed,
      resultVersion: stored?.version ?? null,
      calculatedAt: stored ? new Date(stored.calculatedAt).toISOString() : null,
      scheduledStartAt: stored?.scheduledStartAt ? new Date(stored.scheduledStartAt).toISOString() : null,
      scheduledEndAt: stored?.scheduledEndAt ? new Date(stored.scheduledEndAt).toISOString() : null,
      firstCheckInAt: stored?.firstCheckInAt ? new Date(stored.firstCheckInAt).toISOString() : null,
      lastCheckOutAt: stored?.lastCheckOutAt ? new Date(stored.lastCheckOutAt).toISOString() : null,
      workedMinutes: stored?.workedMinutes ?? null,
      lateMinutes: stored?.lateMinutes ?? null,
      earlyLeaveMinutes: stored?.earlyLeaveMinutes ?? null,
      overtimeMinutes: stored?.overtimeMinutes ?? null,
      incompleteSession: stored?.incompleteSession ?? null,
      ...normalActual(status),
    };
  })
    .filter((item) => !filter.status || item.status === filter.status)
    .filter((item) => !filter.changedOnly || item.changedSinceCalculated)
    .sort((left, right) =>
      (left.unitName ?? "￿").localeCompare(right.unitName ?? "￿")
      || (left.employeeName ?? "").localeCompare(right.employeeName ?? "")
      || left.workDate.localeCompare(right.workDate));

  for (const item of items) summary[item.status] = (summary[item.status] ?? 0) + 1;
  // Paginated: 93 days x every employee is thousands of rows. Summary and counts cover all pages.
  const pageSize = filter.pageSize ?? 50;
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, filter.page ?? 1), totalPages);
  return {
    from: scope.from,
    to: scope.to,
    today,
    generatedAt: now.toISOString(),
    lastCalculatedAt: lastCalculatedAt ? new Date(lastCalculatedAt).toISOString() : null,
    changedCount,
    summary,
    page,
    pageSize,
    total,
    totalPages,
    items: items.slice((page - 1) * pageSize, page * pageSize),
  };
}
