import type { Pool } from "pg";

import { jakartaWorkDate, resolveSchedule, type ResolvedSchedule } from "./engine.js";
import { activeEmployees, leaveDisposition } from "./reporting.js";

// ATT-014-1 Pantauan Hari Ini: today's scan facts per employee. This read model never writes a
// result version and never issues an attendance verdict (absent/late/incomplete); verdicts come
// only from Kalkulasi (ATT-014 §5).

const SCAN_WINDOW_MS = 6 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export type TodayScan = {
  employeeId: string;
  occurredAt: Date;
  source: "adms" | "mobile" | "manual";
  deviceId: string | null;
};

export type TodayDayKind =
  | "scheduled"
  | "off"
  | "holiday"
  | "unscheduled"
  | "leave"
  | "resolved_absent"
  | "configuration_error";

export type TodayFact =
  | "before_shift"
  | "no_scan"
  | "not_connected"
  | "checked_in"
  | "has_scans"
  | "scan_on_rest_day"
  | "scan_without_schedule"
  | "none";

export type TodayCard =
  | "scanned"
  | "not_scanned"
  | "not_connected"
  | "off"
  | "leave"
  | "unscheduled"
  | "unscheduled_with_scans"
  | "configuration_error";

export const TODAY_CARDS: readonly TodayCard[] = [
  "scanned", "not_scanned", "not_connected", "off", "leave", "unscheduled", "unscheduled_with_scans", "configuration_error",
];

export type TodayClassificationInput = {
  schedule: ResolvedSchedule;
  /** True when the employee has a pattern covering today, so an "off" schedule is a rest day rather than no schedule. */
  hasScheduleCoverage: boolean;
  disposition: "leave" | "absent" | null;
  /** True when the employee has a machine PIN mapping valid today. */
  connected: boolean;
  scans: readonly TodayScan[];
  dayStart: Date;
  now: Date;
};

export type TodayClassification = {
  dayKind: TodayDayKind;
  fact: TodayFact;
  card: TodayCard;
  scans: TodayScan[];
  firstScanAt: Date | null;
  lastScanAt: Date | null;
  startDeltaMinutes: number | null;
  connected: boolean;
};

/** The scans that belong to today's work date: the shift window for a scheduled day, else the calendar day. */
export function todayScanWindow(schedule: ResolvedSchedule, dayStart: Date, now: Date) {
  const start = schedule.state === "scheduled" && schedule.scheduledStartAt
    ? new Date(schedule.scheduledStartAt.getTime() - SCAN_WINDOW_MS)
    : dayStart;
  const end = schedule.state === "scheduled" && schedule.scheduledEndAt
    ? new Date(schedule.scheduledEndAt.getTime() + SCAN_WINDOW_MS)
    : new Date(dayStart.getTime() + DAY_MS);
  return { start, end: end < now ? end : now };
}

function dayKindOf(input: TodayClassificationInput): TodayDayKind {
  // Same precedence as the engine's evaluateSessions: schedule state first, then the final leave disposition.
  const { schedule } = input;
  if (schedule.state === "configuration_error") return "configuration_error";
  if (schedule.state === "off") {
    if (schedule.reason === "calendar_holiday") return "holiday";
    if (schedule.rosterId || input.hasScheduleCoverage) return "off";
    return "unscheduled";
  }
  if (input.disposition === "leave") return "leave";
  if (input.disposition === "absent") return "resolved_absent";
  return "scheduled";
}

export function classifyToday(input: TodayClassificationInput): TodayClassification {
  const window = todayScanWindow(input.schedule, input.dayStart, input.now);
  const scans = input.scans
    .filter((scan) => scan.occurredAt >= window.start && scan.occurredAt <= window.end)
    .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());
  const connected = input.connected || scans.some((scan) => scan.source !== "adms");
  const dayKind = dayKindOf(input);
  const first = scans[0]?.occurredAt ?? null;
  const last = scans.at(-1)?.occurredAt ?? null;

  let fact: TodayFact = "none";
  let card: TodayCard;
  switch (dayKind) {
    case "scheduled": {
      if (scans.length > 0) {
        fact = scans.length === 1 ? "checked_in" : "has_scans";
        card = "scanned";
      } else if (!connected) {
        fact = "not_connected";
        card = "not_connected";
      } else {
        const start = input.schedule.scheduledStartAt;
        fact = start && input.now < start ? "before_shift" : "no_scan";
        card = "not_scanned";
      }
      break;
    }
    case "off":
    case "holiday":
      if (scans.length > 0) fact = "scan_on_rest_day";
      card = "off";
      break;
    case "unscheduled":
      if (scans.length > 0) fact = "scan_without_schedule";
      card = scans.length > 0 ? "unscheduled_with_scans" : "unscheduled";
      break;
    case "leave":
    case "resolved_absent":
      card = "leave";
      break;
    default:
      card = "configuration_error";
  }

  const start = input.schedule.scheduledStartAt;
  const startDeltaMinutes = dayKind === "scheduled" && first && start
    ? Math.round((first.getTime() - start.getTime()) / 60_000)
    : null;

  return { dayKind, fact, card, scans, firstScanAt: first, lastScanAt: last, startDeltaMinutes, connected };
}

function jakartaDayStart(date: string) {
  return new Date(`${date}T00:00:00+07:00`);
}

export async function attendanceTodayReadModel(
  pool: Pool,
  filter: { unitId?: string; employeeId?: string } = {},
  now = new Date(),
) {
  const date = jakartaWorkDate(now);
  const dayStart = jakartaDayStart(date);
  const employees = await activeEmployees(pool, filter);
  const ids = employees.map((employee) => employee.employeeId);
  const fetchFrom = new Date(dayStart.getTime() - SCAN_WINDOW_MS);
  const summary = Object.fromEntries(TODAY_CARDS.map((card) => [card, 0])) as Record<TodayCard, number>;
  if (ids.length === 0) return { date, generatedAt: now.toISOString(), summary, items: [] };

  const [scanRows, mappingRows, coverageRows, templateRows] = await Promise.all([
        pool.query<{ employeeId: string; occurredAt: Date; source: TodayScan["source"]; deviceId: string | null }>(
          `SELECT mapping.employee_id AS "employeeId", event.occurred_at AS "occurredAt",
             'adms'::text AS source, event.device_id::text AS "deviceId"
           FROM attendance_adms_events event
           JOIN attendance_adms_employee_mappings mapping
             ON mapping.device_id = event.device_id
            AND mapping.pin = event.pin
            AND event.occurred_at >= mapping.effective_from
            AND (mapping.effective_to IS NULL OR event.occurred_at < mapping.effective_to)
           WHERE mapping.employee_id = ANY($1::uuid[])
             AND event.occurred_at >= $2
             AND event.occurred_at <= $3
           UNION ALL
           SELECT event.employee_id, event.occurred_at, event.source::text, event.safe_metadata->>'deviceId'
           FROM attendance_events event
           WHERE event.employee_id = ANY($1::uuid[])
             AND event.source <> 'adms'
             AND event.occurred_at >= $2
             AND event.occurred_at <= $3`,
          [ids, fetchFrom, now],
        ).then((result) => result.rows),
        pool.query<{ employeeId: string }>(
          `SELECT DISTINCT employee_id AS "employeeId"
           FROM attendance_adms_employee_mappings
           WHERE employee_id = ANY($1::uuid[])
             AND effective_from <= $3
             AND (effective_to IS NULL OR effective_to > $2)`,
          [ids, dayStart, now],
        ).then((result) => result.rows),
        pool.query<{ employeeId: string }>(
          `SELECT DISTINCT employee_id AS "employeeId"
           FROM attendance_schedule_assignments
           WHERE employee_id = ANY($1::uuid[])
             AND $2::date >= effective_from
             AND (effective_to IS NULL OR $2::date <= effective_to)`,
          [ids, date],
        ).then((result) => result.rows),
        pool.query<{ id: string; name: string }>(
          `SELECT id, name FROM attendance_schedule_templates`,
        ).then((result) => result.rows),
      ]);

  const scansByEmployee = new Map<string, TodayScan[]>();
  for (const row of scanRows) {
    const list = scansByEmployee.get(row.employeeId) ?? [];
    list.push({ employeeId: row.employeeId, occurredAt: new Date(row.occurredAt), source: row.source, deviceId: row.deviceId });
    scansByEmployee.set(row.employeeId, list);
  }
  const connected = new Set(mappingRows.map((row) => row.employeeId));
  const covered = new Set(coverageRows.map((row) => row.employeeId));
  const templateNames = new Map(templateRows.map((row) => [row.id, row.name]));

  const items = [];
  for (const employee of employees) {
    const schedule = await resolveSchedule(pool, employee.employeeId, date);
    const disposition = schedule.state === "scheduled"
      ? await leaveDisposition(pool, employee.employeeId, date)
      : null;
    const classified = classifyToday({
      schedule,
      hasScheduleCoverage: covered.has(employee.employeeId),
      disposition,
      connected: connected.has(employee.employeeId),
      scans: scansByEmployee.get(employee.employeeId) ?? [],
      dayStart,
      now,
    });
    items.push({
      ...employee,
      workDate: date,
      dayKind: classified.dayKind,
      scheduleName: schedule.scheduleTemplateId ? templateNames.get(schedule.scheduleTemplateId) ?? null : null,
      scheduledStartAt: schedule.scheduledStartAt?.toISOString() ?? null,
      scheduledEndAt: schedule.scheduledEndAt?.toISOString() ?? null,
      firstScanAt: classified.firstScanAt?.toISOString() ?? null,
      lastScanAt: classified.lastScanAt?.toISOString() ?? null,
      scanCount: classified.scans.length,
      sources: [...new Set(classified.scans.map((scan) => scan.source))].sort(),
      deviceIds: [...new Set(classified.scans.map((scan) => scan.deviceId).filter((value): value is string => Boolean(value)))],
      startDeltaMinutes: classified.startDeltaMinutes,
      connected: classified.connected,
      fact: classified.fact,
      card: classified.card,
    });
  }

  for (const item of items) summary[item.card] += 1;
  return { date, generatedAt: now.toISOString(), summary, items };
}
