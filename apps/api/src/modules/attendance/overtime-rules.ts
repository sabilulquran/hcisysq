import type { Pool, PoolClient } from "pg";

// ATT-011-6b-3 overtime rules: "overtime does not apply" by position or role (D-10, §7.8) and the
// PP 35/2021 warning thresholds (D-5b, §7.7). The rule match itself is one SQL function
// (attendance_overtime_excluding_rule, migration 0146) so the routes, the engine and the report agree.

type Db = Pick<Pool | PoolClient, "query">;

export type OvertimeExclusion = { ruleId: string; reasonLabel: string; targetKind: "position" | "role"; targetLabel: string };

/** The rule that excludes this employee's overtime on this date, or null. */
export async function overtimeExclusionFor(db: Db, employeeId: string, workDate: string): Promise<OvertimeExclusion | null> {
  const result = await db.query<OvertimeExclusion>(
    `SELECT rule.id AS "ruleId", rule.reason_label AS "reasonLabel", rule.target_kind AS "targetKind", rule.target_label AS "targetLabel"
     FROM attendance_overtime_eligibility_rules rule
     WHERE rule.id = attendance_overtime_excluding_rule($1::uuid, $2::date)`,
    [employeeId, workDate],
  );
  return result.rows[0] ?? null;
}

/** SQL fragment: true when the employee/date pair is excluded by a rule (both are SQL expressions). */
export const overtimeExcludedSql = (employeeExpr: string, dateExpr: string) =>
  `(attendance_overtime_excluding_rule(${employeeExpr}, ${dateExpr}) IS NOT NULL)`;

// D-5b DRAFT defaults until HC records a version: 4 hours a day and 18 hours an ISO week.
export const DEFAULT_OVERTIME_POLICY = { dailyWarningMinutes: 240, weeklyWarningMinutes: 1080 } as const;

export type OvertimePolicy = {
  id: string | null;
  effectiveFrom: string | null;
  dailyWarningMinutes: number;
  weeklyWarningMinutes: number;
  source: "configured" | "default";
};

/** SQL: the thresholds in force on a date expression, with the DRAFT defaults when none is recorded. */
export const overtimePolicySql = (dateExpr: string) => `
  SELECT coalesce(version.daily_warning_minutes, ${DEFAULT_OVERTIME_POLICY.dailyWarningMinutes}) AS daily,
         coalesce(version.weekly_warning_minutes, ${DEFAULT_OVERTIME_POLICY.weeklyWarningMinutes}) AS weekly
  FROM (SELECT 1) one
  LEFT JOIN LATERAL (
    SELECT daily_warning_minutes, weekly_warning_minutes FROM attendance_overtime_policy_versions
    WHERE effective_from <= ${dateExpr}
    ORDER BY effective_from DESC, created_at DESC, id DESC LIMIT 1
  ) version ON true`;

export async function overtimePolicyOn(db: Db, date: string): Promise<OvertimePolicy> {
  const result = await db.query<{ id: string; effectiveFrom: string; dailyWarningMinutes: number; weeklyWarningMinutes: number }>(
    `SELECT id, effective_from::text AS "effectiveFrom", daily_warning_minutes AS "dailyWarningMinutes",
       weekly_warning_minutes AS "weeklyWarningMinutes"
     FROM attendance_overtime_policy_versions
     WHERE effective_from <= $1::date
     ORDER BY effective_from DESC, created_at DESC, id DESC
     LIMIT 1`,
    [date],
  );
  const row = result.rows[0];
  return row
    ? { ...row, source: "configured" }
    : { id: null, effectiveFrom: null, ...DEFAULT_OVERTIME_POLICY, source: "default" };
}

export type OvertimeWarning = {
  code: "OVERTIME_DAILY_GUIDE_EXCEEDED" | "OVERTIME_WEEKLY_GUIDE_EXCEEDED";
  scope: "day" | "week";
  totalMinutes: number;
  limitMinutes: number;
  message: string;
};

const hours = (minutes: number) => {
  const value = Math.round((minutes / 60) * 10) / 10;
  return `${String(value).replace(".", ",")} j`;
};

/** Neutral wording (§7.7): information about a guide figure, never an accusation. */
export function overtimeWarnings(totals: { dayMinutes: number; weekMinutes: number }, policy: Pick<OvertimePolicy, "dailyWarningMinutes" | "weeklyWarningMinutes">): OvertimeWarning[] {
  const warnings: OvertimeWarning[] = [];
  if (totals.dayMinutes > policy.dailyWarningMinutes) {
    warnings.push({
      code: "OVERTIME_DAILY_GUIDE_EXCEEDED", scope: "day", totalMinutes: totals.dayMinutes, limitMinutes: policy.dailyWarningMinutes,
      message: `Melebihi batas PP 35/2021: ${hours(totals.dayMinutes)} hari ini (acuan ${hours(policy.dailyWarningMinutes)}).`,
    });
  }
  if (totals.weekMinutes > policy.weeklyWarningMinutes) {
    warnings.push({
      code: "OVERTIME_WEEKLY_GUIDE_EXCEEDED", scope: "week", totalMinutes: totals.weekMinutes, limitMinutes: policy.weeklyWarningMinutes,
      message: `Melebihi batas PP 35/2021: ${hours(totals.weekMinutes)} minggu ini (acuan ${hours(policy.weeklyWarningMinutes)}).`,
    });
  }
  return warnings;
}

/**
 * D-5b: approved + waiting overtime of the employee on the day and in the ISO week (Monday-Sunday) of
 * the date, plus `addMinutes` for the request being made or decided. `excludeId` leaves out the request
 * being decided, whose own minutes are passed in `addMinutes` instead.
 */
export async function overtimeWarningsFor(
  db: Db,
  input: { employeeId: string; workDate: string; addMinutes: number; excludeId?: string | null },
): Promise<OvertimeWarning[]> {
  // One after the other: `db` may be a transaction client, which runs one query at a time.
  const totals = await db.query<{ dayMinutes: number; weekMinutes: number }>(
      `SELECT
         coalesce(sum(minutes) FILTER (WHERE work_date = $2::date), 0)::int AS "dayMinutes",
         coalesce(sum(minutes), 0)::int AS "weekMinutes"
       FROM (
         SELECT work_date, CASE WHEN status = 'approved' THEN coalesce(approved_minutes, 0) ELSE requested_minutes END AS minutes
         FROM attendance_overtime_requests
         WHERE employee_id = $1 AND status IN ('submitted', 'approved')
           AND work_date >= date_trunc('week', $2::date)::date AND work_date < date_trunc('week', $2::date)::date + 7
           AND ($3::uuid IS NULL OR id <> $3)
       ) counted`,
      [input.employeeId, input.workDate, input.excludeId ?? null],
  );
  const policy = await overtimePolicyOn(db, input.workDate);
  const row = totals.rows[0];
  return overtimeWarnings({
    dayMinutes: Number(row?.dayMinutes ?? 0) + input.addMinutes,
    weekMinutes: Number(row?.weekMinutes ?? 0) + input.addMinutes,
  }, policy);
}

/**
 * SQL joins adding the D-5b totals and thresholds for a request row `alias` (approved + waiting of that
 * employee on its day and ISO week, the row itself included). Select the columns with
 * `overtimeWarningColumnsSql` and turn them into `warnings` with `withOvertimeWarnings`.
 */
export const overtimeWarningJoinsSql = (alias: string) => `
  LEFT JOIN LATERAL (
    SELECT coalesce(sum(counted.minutes) FILTER (WHERE counted.work_date = ${alias}.work_date), 0)::int AS day_minutes,
           coalesce(sum(counted.minutes), 0)::int AS week_minutes
    FROM (
      SELECT same_week.work_date,
        CASE WHEN same_week.status = 'approved' THEN coalesce(same_week.approved_minutes, 0) ELSE same_week.requested_minutes END AS minutes
      FROM attendance_overtime_requests same_week
      WHERE same_week.employee_id = ${alias}.employee_id AND same_week.status IN ('submitted', 'approved')
        AND same_week.work_date >= date_trunc('week', ${alias}.work_date)::date
        AND same_week.work_date < date_trunc('week', ${alias}.work_date)::date + 7
    ) counted
  ) overtime_totals ON true
  LEFT JOIN LATERAL (${overtimePolicySql(`${alias}.work_date`)}) overtime_policy ON true`;

export const overtimeWarningColumnsSql = `overtime_totals.day_minutes AS "warningDayMinutes", overtime_totals.week_minutes AS "warningWeekMinutes",
  overtime_policy.daily AS "warningDailyLimit", overtime_policy.weekly AS "warningWeeklyLimit"`;

/** Replaces the four warning columns of a row by `warnings[]`; closed requests (rejected/cancelled) get none. */
export function withOvertimeWarnings<T extends Record<string, unknown>>(row: T) {
  const { warningDayMinutes, warningWeekMinutes, warningDailyLimit, warningWeeklyLimit, ...rest } = row;
  const open = rest.status === undefined || rest.status === "submitted" || rest.status === "approved";
  const warnings = open && warningDailyLimit !== undefined && warningDailyLimit !== null
    ? overtimeWarnings(
      { dayMinutes: Number(warningDayMinutes ?? 0), weekMinutes: Number(warningWeekMinutes ?? 0) },
      { dailyWarningMinutes: Number(warningDailyLimit), weeklyWarningMinutes: Number(warningWeeklyLimit) },
    )
    : [];
  return { ...rest, warnings };
}
