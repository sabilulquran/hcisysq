import { createHash, randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { jakartaWorkDate, resolveSchedule } from "./engine.js";

// ATT-011-4 §5.3 Perubahan Jadwal. "Atur jadwal" (pattern), "Ganti jadwal" (replacement) and "Salin
// jadwal" (copy) become one change set: the server plans it from the current data (the preview), and
// applying it re-plans under locks and refuses when anything changed since the preview. The resolver
// order (published roster > calendar holiday > pattern) is untouched: a pattern writes assignments, a
// replacement or copy writes a new published roster version per week. Past dates are never changed (D-3).

type Db = Pick<PoolClient, "query">;

export type ScheduleChangeScope = {
  employeeIds?: string[] | undefined;
  unitId?: string | null | undefined;
  excludeEmployeeIds?: string[] | undefined;
  workOnHolidays?: boolean | undefined;
  note?: string | null | undefined;
};

export type ScheduleChangeInput = ScheduleChangeScope & (
  | { kind: "pattern"; scheduleTemplateId: string | null; from: string; to: string | null; weekdays: number[]; untickedDays: "off" | "keep" }
  | { kind: "replacement"; scheduleTemplateId: string | null; from: string; to: string }
  | { kind: "copy"; sourceWeekStart: string; targetWeekStarts: string[] }
);

export type ScheduleChangeOp =
  | { action: "assignment_created"; employeeId: string; scheduleTemplateId: string; weekdayMask: number; from: string; to: string | null; reason: "new" | "continuation" | "kept_days" }
  | { action: "assignment_ended"; employeeId: string; assignmentId: string; scheduleTemplateId: string; weekdayMask: number; from: string; to: string; previousTo: string | null }
  | { action: "assignment_removed"; employeeId: string; assignmentId: string; scheduleTemplateId: string; weekdayMask: number; from: string; to: string | null }
  | { action: "roster_entry_set"; employeeId: string; workDate: string; scheduleTemplateId: string; scheduleVersionId: string }
  | { action: "roster_entry_off"; employeeId: string; workDate: string }
  /** A skipped holiday whose latest published roster still has an entry: removed so the day is Libur. */
  | { action: "roster_entry_cleared"; employeeId: string; workDate: string };

type RosterOp = Extract<ScheduleChangeOp, { workDate: string }>;
function isRosterOp(op: ScheduleChangeOp): op is RosterOp {
  return op.action === "roster_entry_set" || op.action === "roster_entry_off" || op.action === "roster_entry_cleared";
}

export type ScheduleChangeIssue = {
  employeeId: string | null;
  employeeName: string | null;
  code: "inactive" | "ended" | "shift_swap" | "draft_roster" | "started" | "source_conflict" | "shift_not_valid";
  date: string | null;
  message: string;
  /** Blocking issues stop "Terapkan" until the employee is excluded or the cause is resolved. */
  blocking: boolean;
};

export class ScheduleChangeError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

export const MAX_EMPLOYEES = 500;
export const MAX_DAYS = 400;

const DAY_MS = 86_400_000;
export function addDays(date: string, days: number) {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}
function isoWeekday(date: string) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}
export function mondayOf(date: string) {
  return addDays(date, 1 - isoWeekday(date));
}
function daysBetween(from: string, to: string) {
  return Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / DAY_MS);
}
function eachDate(from: string, to: string) {
  const dates: string[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) dates.push(date);
  return dates;
}
export function maskOf(weekdays: readonly number[]) {
  return weekdays.reduce((mask, day) => mask | (1 << (day - 1)), 0);
}
function inMask(mask: number, date: string) {
  return (mask & (1 << (isoWeekday(date) - 1))) !== 0;
}

/** The dates a change touches, and the last date considered for an open-ended pattern. */
export function changeRange(input: ScheduleChangeInput): { from: string; to: string; openEnded: boolean } {
  if (input.kind === "copy") {
    const weeks = [...input.targetWeekStarts].sort();
    return { from: weeks[0]!, to: addDays(weeks.at(-1)!, 6), openEnded: false };
  }
  if (input.kind === "pattern" && input.to === null) return { from: input.from, to: addDays(input.from, MAX_DAYS - 1), openEnded: true };
  return { from: input.from, to: input.to!, openEnded: false };
}

type EmployeeRow = { id: string; employeeNumber: string; fullName: string; status: string; endedOn: string | null };
type AssignmentRow = { id: string; employeeId: string; scheduleTemplateId: string; weekdayMask: number; from: string; to: string | null };

export type ScheduleChangePlan = {
  fingerprint: string;
  employees: EmployeeRow[];
  ops: ScheduleChangeOp[];
  issues: ScheduleChangeIssue[];
  holidays: Array<{ date: string; label: string | null }>;
  weeks: string[];
  summary: {
    employees: number;
    from: string;
    to: string | null;
    newEmployees: number;
    replacedEmployees: number;
    rosterDays: number;
    blockingIssues: number;
  };
};

async function versionValidOn(db: Db, scheduleTemplateId: string, workDate: string) {
  const result = await db.query<{ id: string }>(
    `SELECT version.id FROM attendance_schedule_versions version
     JOIN attendance_schedule_templates template ON template.id = version.schedule_template_id AND template.active
     WHERE version.schedule_template_id = $1
       AND version.effective_from <= (($2::date + time '12:00') AT TIME ZONE 'Asia/Jakarta')
       AND (version.effective_to IS NULL OR version.effective_to > (($2::date + time '12:00') AT TIME ZONE 'Asia/Jakarta'))
     ORDER BY version.version DESC LIMIT 1`,
    [scheduleTemplateId, workDate],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * Plans the change from the data as it is now: no write. The fingerprint covers the normalized input
 * and every fact the plan was built on, so applying can tell whether anything changed since.
 */
export async function planScheduleChange(db: Db, input: ScheduleChangeInput, now = new Date()): Promise<ScheduleChangePlan> {
  const today = jakartaWorkDate(now);
  const range = changeRange(input);
  if (range.from < today) {
    throw new ScheduleChangeError(422, "SCHEDULE_CHANGE_IN_PAST", "Jadwal tanggal yang sudah lewat tidak dapat diubah. Gunakan Perbaiki jam pada Kehadiran.");
  }
  if (input.kind === "replacement" && daysBetween(input.from, input.to) > 61) {
    throw new ScheduleChangeError(422, "SCHEDULE_CHANGE_TOO_LONG", "Ganti jadwal paling panjang 62 hari; gunakan Atur jadwal untuk periode panjang.");
  }
  if (!range.openEnded && daysBetween(range.from, range.to) >= MAX_DAYS) {
    throw new ScheduleChangeError(422, "SCHEDULE_CHANGE_TOO_LONG", `Satu perubahan paling panjang ${MAX_DAYS} hari.`);
  }

  // Who: the unit's active employees and/or the chosen ones, minus the excluded.
  const employeeRows = await db.query<EmployeeRow>(
    `SELECT employee.id, employee.employee_number AS "employeeNumber", employee.full_name AS "fullName",
       employee.status, employee.ended_on::text AS "endedOn"
     FROM employees employee
     WHERE (employee.id = ANY($1::uuid[]) OR ($2::uuid IS NOT NULL AND employee.organizational_unit_id = $2 AND employee.status = 'active'))
       AND NOT (employee.id = ANY($3::uuid[]))
     ORDER BY employee.full_name, employee.id`,
    [input.employeeIds ?? [], input.unitId ?? null, input.excludeEmployeeIds ?? []],
  );
  const employees = employeeRows.rows;
  if (employees.length === 0) throw new ScheduleChangeError(422, "SCHEDULE_CHANGE_NO_EMPLOYEES", "Tidak ada pegawai aktif yang dipilih.");
  if (employees.length > MAX_EMPLOYEES) {
    throw new ScheduleChangeError(422, "SCHEDULE_CHANGE_TOO_LARGE", `Satu perubahan paling banyak ${MAX_EMPLOYEES} pegawai.`);
  }

  const issues: ScheduleChangeIssue[] = [];
  const ops: ScheduleChangeOp[] = [];
  // Last date per employee: an employee leaving within the range is changed only up to the last day.
  const lastDate = new Map<string, string>();
  const active: EmployeeRow[] = [];
  for (const employee of employees) {
    if (employee.status !== "active") {
      issues.push({ employeeId: employee.id, employeeName: employee.fullName, code: "inactive", date: null, message: "Tidak aktif; dikecualikan otomatis.", blocking: false });
      continue;
    }
    if (employee.endedOn && employee.endedOn < range.to) {
      if (employee.endedOn < range.from) {
        issues.push({ employeeId: employee.id, employeeName: employee.fullName, code: "ended", date: employee.endedOn, message: `Berhenti ${employee.endedOn}; dikecualikan otomatis.`, blocking: false });
        continue;
      }
      issues.push({ employeeId: employee.id, employeeName: employee.fullName, code: "ended", date: employee.endedOn, message: `Berhenti ${employee.endedOn}; dikecualikan otomatis setelah tanggal itu.`, blocking: false });
      lastDate.set(employee.id, employee.endedOn);
    }
    active.push(employee);
  }
  const ids = active.map((employee) => employee.id);
  const endFor = (employeeId: string) => lastDate.get(employeeId) ?? range.to;

  // D-3: today only before the shift that applies today has started.
  if (range.from === today) {
    for (const employee of active) {
      const schedule = await resolveSchedule(db as PoolClient, employee.id, today);
      if (schedule.state === "scheduled" && schedule.scheduledStartAt && schedule.scheduledStartAt <= now) {
        issues.push({ employeeId: employee.id, employeeName: employee.fullName, code: "started", date: today, message: "Shift hari ini sudah mulai; mulai perubahan besok atau kecualikan pegawai ini.", blocking: true });
      }
    }
  }

  // A pending shift swap on a changed date must be settled first (§5.2).
  const swaps = await db.query<{ employeeId: string; workDate: string }>(
    `SELECT DISTINCT person AS "employeeId", swap.work_date::text AS "workDate"
     FROM attendance_shift_swap_requests swap
     CROSS JOIN LATERAL (VALUES (swap.requester_employee_id), (swap.counterpart_employee_id)) people(person)
     WHERE swap.status IN ('awaiting_counterpart', 'awaiting_hc')
       AND swap.work_date BETWEEN $1::date AND $2::date
       AND person = ANY($3::uuid[])`,
    [range.from, range.to, ids],
  );
  const nameOf = (employeeId: string) => active.find((employee) => employee.id === employeeId)?.fullName ?? null;
  for (const swap of swaps.rows) {
    issues.push({ employeeId: swap.employeeId, employeeName: nameOf(swap.employeeId), code: "shift_swap", date: swap.workDate, message: `Sedang mengajukan Tukar Shift ${swap.workDate}; selesaikan dulu atau kecualikan.`, blocking: true });
  }

  const holidayRows = await db.query<{ date: string; label: string | null }>(
    `SELECT calendar_date::text AS date, label FROM leave_calendar_exceptions
     WHERE is_working_day = false AND calendar_date BETWEEN $1::date AND $2::date ORDER BY calendar_date`,
    [range.from, range.to],
  );
  const holidays = holidayRows.rows;
  const isHoliday = new Set(holidays.map((holiday) => holiday.date));

  const blocked = () => new Set(issues.filter((issue) => issue.blocking && issue.employeeId).map((issue) => issue.employeeId!));
  let newEmployees = 0;
  let replacedEmployees = 0;
  const assignmentRows = await db.query<AssignmentRow>(
    `SELECT id, employee_id AS "employeeId", schedule_template_id AS "scheduleTemplateId", weekday_mask AS "weekdayMask",
       effective_from::text AS "from", effective_to::text AS "to"
     FROM attendance_schedule_assignments
     WHERE employee_id = ANY($1::uuid[])
       AND (effective_to IS NULL OR effective_to >= $2::date)
       AND ($3::date IS NULL OR effective_from <= $3::date)
     ORDER BY employee_id, effective_from, id`,
    [ids, range.from, range.openEnded ? null : range.to],
  );
  const versionCache = new Map<string, string | null>();
  const pinned = async (employeeId: string, scheduleTemplateId: string, workDate: string) => {
    const key = `${scheduleTemplateId}:${workDate}`;
    if (!versionCache.has(key)) versionCache.set(key, await versionValidOn(db, scheduleTemplateId, workDate));
    const versionId = versionCache.get(key)!;
    if (!versionId) {
      issues.push({ employeeId, employeeName: nameOf(employeeId), code: "shift_not_valid", date: workDate, message: `Shift belum berlaku atau nonaktif pada ${workDate}.`, blocking: true });
    }
    return versionId;
  };

  // Holiday dates a replacement or copy leaves alone; an entry an earlier change put there is cleared.
  const skippedHolidays: Array<[string, string]> = [];

  if (input.kind === "pattern") {
    const mask = maskOf(input.weekdays);
    if (input.scheduleTemplateId && !(await versionValidOn(db, input.scheduleTemplateId, input.from))) {
      issues.push({ employeeId: null, employeeName: null, code: "shift_not_valid", date: input.from, message: `Shift tidak ada, nonaktif, atau belum berlaku pada ${input.from}.`, blocking: true });
    }
    for (const employee of active) {
      const to = lastDate.get(employee.id) ?? input.to;
      const existing = assignmentRows.rows.filter((row) => row.employeeId === employee.id);
      if (existing.length) replacedEmployees += 1; else newEmployees += 1;
      for (const row of existing) {
        if (row.from < input.from) {
          ops.push({ action: "assignment_ended", employeeId: employee.id, assignmentId: row.id, scheduleTemplateId: row.scheduleTemplateId, weekdayMask: row.weekdayMask, from: row.from, to: addDays(input.from, -1), previousTo: row.to });
        } else {
          ops.push({ action: "assignment_removed", employeeId: employee.id, assignmentId: row.id, scheduleTemplateId: row.scheduleTemplateId, weekdayMask: row.weekdayMask, from: row.from, to: row.to });
        }
        // The part of the old pattern after the new period continues unchanged.
        if (to !== null && (row.to === null || row.to > to)) {
          ops.push({ action: "assignment_created", employeeId: employee.id, scheduleTemplateId: row.scheduleTemplateId, weekdayMask: row.weekdayMask, from: addDays(to, 1) > row.from ? addDays(to, 1) : row.from, to: row.to, reason: "continuation" });
        }
        // "Biarkan seperti sekarang" keeps the old pattern on the days the new one does not use.
        const kept = row.weekdayMask & ~mask;
        if (input.untickedDays === "keep" && kept !== 0) {
          const keptFrom = row.from > input.from ? row.from : input.from;
          const keptTo = [row.to, to].filter((value): value is string => value !== null).sort()[0] ?? null;
          if (keptTo === null || keptTo >= keptFrom) {
            ops.push({ action: "assignment_created", employeeId: employee.id, scheduleTemplateId: row.scheduleTemplateId, weekdayMask: kept, from: keptFrom, to: keptTo, reason: "kept_days" });
          }
        }
      }
      if (input.scheduleTemplateId) {
        ops.push({ action: "assignment_created", employeeId: employee.id, scheduleTemplateId: input.scheduleTemplateId, weekdayMask: mask, from: input.from, to, reason: "new" });
        // D-2: on a holiday the pattern gives Libur, unless the change says to work on holidays.
        if (input.workOnHolidays) {
          for (const holiday of holidays) {
            if (holiday.date > endFor(employee.id) || !inMask(mask, holiday.date)) continue;
            const versionId = await pinned(employee.id, input.scheduleTemplateId, holiday.date);
            if (versionId) ops.push({ action: "roster_entry_set", employeeId: employee.id, workDate: holiday.date, scheduleTemplateId: input.scheduleTemplateId, scheduleVersionId: versionId });
          }
        }
      }
    }
  } else if (input.kind === "replacement") {
    for (const employee of active) {
      for (const date of eachDate(input.from, endFor(employee.id) < input.to ? endFor(employee.id) : input.to)) {
        if (isHoliday.has(date) && !(input.workOnHolidays && input.scheduleTemplateId)) {
          skippedHolidays.push([employee.id, date]);
          continue;
        }
        if (input.scheduleTemplateId) {
          const versionId = await pinned(employee.id, input.scheduleTemplateId, date);
          if (versionId) ops.push({ action: "roster_entry_set", employeeId: employee.id, workDate: date, scheduleTemplateId: input.scheduleTemplateId, scheduleVersionId: versionId });
        } else {
          ops.push({ action: "roster_entry_off", employeeId: employee.id, workDate: date });
        }
      }
    }
  } else {
    // Salin jadwal: the schedule in force on each source day (pattern and replacements), not only the roster (J-5).
    for (const employee of active) {
      for (let offset = 0; offset < 7; offset += 1) {
        const source = await resolveSchedule(db as PoolClient, employee.id, addDays(input.sourceWeekStart, offset));
        // A holiday in the source week is not the employee's schedule: leave that weekday as it is.
        if (source.state === "off" && source.reason === "calendar_holiday") continue;
        for (const week of input.targetWeekStarts) {
          const date = addDays(week, offset);
          if (date > endFor(employee.id)) continue;
          if (isHoliday.has(date) && !(input.workOnHolidays && source.state === "scheduled")) {
            skippedHolidays.push([employee.id, date]);
            continue;
          }
          if (source.state === "configuration_error") {
            issues.push({ employeeId: employee.id, employeeName: employee.fullName, code: "source_conflict", date, message: `Jadwal sumber ${addDays(input.sourceWeekStart, offset)} bermasalah; tanggal ${date} tidak disalin.`, blocking: false });
          } else if (source.state === "scheduled" && source.scheduleTemplateId) {
            const versionId = await pinned(employee.id, source.scheduleTemplateId, date);
            if (versionId) ops.push({ action: "roster_entry_set", employeeId: employee.id, workDate: date, scheduleTemplateId: source.scheduleTemplateId, scheduleVersionId: versionId });
          } else {
            ops.push({ action: "roster_entry_off", employeeId: employee.id, workDate: date });
          }
        }
      }
    }
  }

  if (skippedHolidays.length) {
    const existing = await db.query<{ employeeId: string; workDate: string }>(
      `WITH pairs AS (
         SELECT * FROM unnest($1::uuid[], $2::date[]) AS pair(employee_id, work_date)
       ), latest AS (
         SELECT DISTINCT ON (week_start) id, week_start FROM attendance_rosters
         WHERE status = 'PUBLISHED' AND week_start IN (SELECT date_trunc('week', work_date)::date FROM pairs)
         ORDER BY week_start, version DESC
       )
       SELECT entry.employee_id AS "employeeId", entry.work_date::text AS "workDate"
       FROM pairs
       JOIN latest ON latest.week_start = date_trunc('week', pairs.work_date)::date
       JOIN attendance_roster_entries entry
         ON entry.roster_id = latest.id AND entry.employee_id = pairs.employee_id AND entry.work_date = pairs.work_date
       ORDER BY entry.employee_id, entry.work_date`,
      [skippedHolidays.map(([employeeId]) => employeeId), skippedHolidays.map(([, date]) => date)],
    );
    for (const row of existing.rows) ops.push({ action: "roster_entry_cleared", employeeId: row.employeeId, workDate: row.workDate });
  }

  // Roster weeks: a draft roster typed by hand would be overtaken silently, so it blocks (§5.3 step 3).
  const weeks = [...new Set(ops.filter(isRosterOp).map((op) => mondayOf(op.workDate)))].sort();
  const rosterState = await db.query<{ weekStart: string; latestPublished: string | null; draftBy: string | null }>(
    `SELECT week.week_start::text AS "weekStart",
       (SELECT roster.id::text FROM attendance_rosters roster WHERE roster.week_start = week.week_start AND roster.status = 'PUBLISHED'
        ORDER BY roster.version DESC LIMIT 1) AS "latestPublished",
       (SELECT coalesce(account.email, 'HC') FROM attendance_rosters roster LEFT JOIN accounts account ON account.id = roster.created_by_account_id
        WHERE roster.week_start = week.week_start AND roster.status = 'DRAFT' ORDER BY roster.version DESC LIMIT 1) AS "draftBy"
     FROM unnest($1::date[]) AS week(week_start)`,
    [weeks],
  );
  for (const week of rosterState.rows) {
    if (week.draftBy) {
      issues.push({ employeeId: null, employeeName: null, code: "draft_roster", date: week.weekStart, message: `Ada draf jadwal per tanggal minggu ${week.weekStart} oleh ${week.draftBy}; terbitkan atau hapus dulu.`, blocking: true });
    }
  }

  const blockedIds = blocked();
  const fingerprint = createHash("sha256").update(JSON.stringify({
    input: normalizeInput(input),
    employees: active.map((employee) => [employee.id, employee.status, employee.endedOn]),
    assignments: assignmentRows.rows.map((row) => [row.id, row.scheduleTemplateId, row.weekdayMask, row.from, row.to]),
    rosters: rosterState.rows.map((row) => [row.weekStart, row.latestPublished, row.draftBy]),
    holidays: holidays.map((holiday) => holiday.date),
    swaps: swaps.rows.map((swap) => [swap.employeeId, swap.workDate]),
    blocked: [...blockedIds].sort(),
    // The plan itself, so a shift version that changed in between is noticed too.
    ops,
  })).digest("hex");

  return {
    fingerprint,
    employees: active,
    ops,
    issues,
    holidays,
    weeks,
    summary: {
      employees: active.length,
      from: range.from,
      to: range.openEnded ? null : range.to,
      newEmployees,
      replacedEmployees,
      rosterDays: ops.filter(isRosterOp).length,
      blockingIssues: issues.filter((issue) => issue.blocking).length,
    },
  };
}

function normalizeInput(input: ScheduleChangeInput) {
  return {
    ...input,
    employeeIds: [...(input.employeeIds ?? [])].sort(),
    excludeEmployeeIds: [...(input.excludeEmployeeIds ?? [])].sort(),
    ...(input.kind === "pattern" ? { weekdays: [...input.weekdays].sort() } : {}),
    ...(input.kind === "copy" ? { targetWeekStarts: [...input.targetWeekStarts].sort() } : {}),
    note: input.note ?? null,
    workOnHolidays: Boolean(input.workOnHolidays),
    unitId: input.unitId ?? null,
  };
}

/**
 * Applies a previewed change inside the caller's transaction: locks the employees and roster weeks,
 * re-plans, refuses on any difference from the preview or a blocking issue, then writes assignments,
 * one new published roster version per week, the change set with its items, and the audit event.
 */
export async function applyScheduleChange(
  client: PoolClient,
  input: ScheduleChangeInput,
  previewFingerprint: string,
  actorAccountId: string,
  idempotencyKey: string | null,
  now = new Date(),
) {
  if (idempotencyKey) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`attendance-schedule-change-key:${idempotencyKey}`]);
    const replay = await client.query<{ id: string; same: boolean }>(
      "SELECT id, input = $2::jsonb AS same FROM attendance_schedule_change_sets WHERE idempotency_key = $1",
      [idempotencyKey, JSON.stringify(normalizeInput(input))],
    );
    if (replay.rows[0] && !replay.rows[0].same) {
      throw new ScheduleChangeError(422, "IDEMPOTENCY_KEY_REUSED", "Idempotency-Key sudah dipakai untuk perubahan lain.");
    }
    if (replay.rows[0]) return { id: replay.rows[0].id, replayed: true, summary: null, employeeIds: [] as string[] };
  }
  const first = await planScheduleChange(client, input, now);
  const locks = [...first.employees.map((employee) => `attendance-schedule-employee:${employee.id}`), ...first.weeks.map((week) => `attendance-roster-week:${week}`)].sort();
  for (const key of locks) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
  const plan = await planScheduleChange(client, input, now);
  if (plan.fingerprint !== previewFingerprint) {
    throw new ScheduleChangeError(409, "SCHEDULE_CHANGED_SINCE_PREVIEW", "Jadwal sudah diubah orang lain. Lihat dampak lagi.");
  }
  const draft = plan.issues.find((issue) => issue.code === "draft_roster");
  if (draft) throw new ScheduleChangeError(409, "ROSTER_DRAFT_EXISTS", draft.message);
  const started = plan.issues.find((issue) => issue.code === "started");
  if (started) throw new ScheduleChangeError(422, "SCHEDULE_CHANGE_STARTED", started.message);
  const blocking = plan.issues.filter((issue) => issue.blocking);
  if (blocking.length) {
    throw new ScheduleChangeError(422, "SCHEDULE_CHANGE_BLOCKED", "Masih ada pegawai bermasalah. Kecualikan atau selesaikan dulu.", blocking);
  }

  const changeSetId = randomUUID();
  await client.query(
    `INSERT INTO attendance_schedule_change_sets (
       id, kind, requested_by_account_id, note, input, scope_summary, preview_fingerprint, idempotency_key
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)`,
    [changeSetId, input.kind, actorAccountId, input.note ?? null, JSON.stringify(normalizeInput(input)),
      JSON.stringify(plan.summary), plan.fingerprint, idempotencyKey],
  );
  // Items are written in one statement at the end (a replacement can touch 500 employees x 62 days).
  const items: Array<{ op: ScheduleChangeOp; from: string; to: string | null; mask: number | null; template: string | null; before: unknown; after: unknown }> = [];
  const item = (op: ScheduleChangeOp, fields: { from: string; to: string | null; mask: number | null; template: string | null; before: unknown; after: unknown }) => {
    items.push({ op, ...fields });
  };

  // Ends and removals first, so the new patterns never overlap an old one inside the transaction.
  const order = (op: ScheduleChangeOp) => (op.action === "assignment_ended" || op.action === "assignment_removed" ? 0 : op.action === "assignment_created" ? 1 : 2);
  for (const op of [...plan.ops].sort((left, right) => order(left) - order(right))) {
    if (op.action === "assignment_ended") {
      await client.query("UPDATE attendance_schedule_assignments SET effective_to = $2::date WHERE id = $1", [op.assignmentId, op.to]);
      item(op, { from: op.from, to: op.to, mask: op.weekdayMask, template: op.scheduleTemplateId, before: { assignmentId: op.assignmentId, effectiveTo: op.previousTo }, after: { assignmentId: op.assignmentId, effectiveTo: op.to } });
    } else if (op.action === "assignment_removed") {
      await client.query("DELETE FROM attendance_schedule_assignments WHERE id = $1", [op.assignmentId]);
      item(op, { from: op.from, to: op.to, mask: op.weekdayMask, template: op.scheduleTemplateId, before: { assignmentId: op.assignmentId, effectiveFrom: op.from, effectiveTo: op.to, weekdayMask: op.weekdayMask, scheduleTemplateId: op.scheduleTemplateId }, after: null });
    } else if (op.action === "assignment_created") {
      const id = randomUUID();
      await client.query(
        `INSERT INTO attendance_schedule_assignments (id, employee_id, schedule_template_id, weekday_mask, effective_from, effective_to, created_by_account_id, change_set_id)
         VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8)`,
        [id, op.employeeId, op.scheduleTemplateId, op.weekdayMask, op.from, op.to, actorAccountId, changeSetId],
      );
      item(op, { from: op.from, to: op.to, mask: op.weekdayMask, template: op.scheduleTemplateId, before: null, after: { assignmentId: id, reason: op.reason } });
    }
  }

  // One new published roster version per week: the latest published entries plus this change.
  for (const week of plan.weeks) {
    const latest = await client.query<{ id: string }>(
      "SELECT id FROM attendance_rosters WHERE week_start = $1::date AND status = 'PUBLISHED' ORDER BY version DESC LIMIT 1",
      [week],
    );
    const version = await client.query<{ version: number }>(
      "SELECT coalesce(max(version), 0)::int + 1 AS version FROM attendance_rosters WHERE week_start = $1::date",
      [week],
    );
    const rosterId = randomUUID();
    await client.query(
      `INSERT INTO attendance_rosters (id, week_start, version, status, created_by_account_id, published_by_account_id, published_at, change_set_id)
       VALUES ($1, $2::date, $3, 'PUBLISHED', $4, $4, clock_timestamp(), $5)`,
      [rosterId, week, version.rows[0]?.version ?? 1, actorAccountId, changeSetId],
    );
    if (latest.rows[0]) {
      await client.query(
        `INSERT INTO attendance_roster_entries (roster_id, employee_id, work_date, schedule_template_id, schedule_version_id, is_off, note)
         SELECT $1, employee_id, work_date, schedule_template_id, schedule_version_id, is_off, note
         FROM attendance_roster_entries WHERE roster_id = $2`,
        [rosterId, latest.rows[0].id],
      );
    }
    const weekOps = plan.ops.filter((op): op is RosterOp => isRosterOp(op) && mondayOf(op.workDate) === week);
    const before = await client.query<{ employeeId: string; workDate: string; scheduleTemplateId: string | null; scheduleVersionId: string | null; isOff: boolean }>(
      `SELECT entry.employee_id AS "employeeId", entry.work_date::text AS "workDate", entry.schedule_template_id AS "scheduleTemplateId",
         entry.schedule_version_id AS "scheduleVersionId", entry.is_off AS "isOff"
       FROM attendance_roster_entries entry
       JOIN unnest($2::uuid[], $3::date[]) AS pair(employee_id, work_date)
         ON pair.employee_id = entry.employee_id AND pair.work_date = entry.work_date
       WHERE entry.roster_id = $1`,
      [rosterId, weekOps.map((op) => op.employeeId), weekOps.map((op) => op.workDate)],
    );
    const beforeOf = new Map(before.rows.map(({ employeeId, workDate, ...state }) => [`${employeeId}:${workDate}`, state]));
    const sets = weekOps.filter((op) => op.action !== "roster_entry_cleared");
    if (sets.length) {
      await client.query(
        `INSERT INTO attendance_roster_entries (roster_id, employee_id, work_date, schedule_template_id, schedule_version_id, is_off, note)
         SELECT $1, change.employee_id, change.work_date, change.template_id, change.version_id, change.is_off, $7
         FROM unnest($2::uuid[], $3::date[], $4::uuid[], $5::uuid[], $6::boolean[]) AS change(employee_id, work_date, template_id, version_id, is_off)
         ON CONFLICT (roster_id, employee_id, work_date) DO UPDATE SET
           schedule_template_id = EXCLUDED.schedule_template_id, schedule_version_id = EXCLUDED.schedule_version_id,
           is_off = EXCLUDED.is_off, note = EXCLUDED.note`,
        [
          rosterId, sets.map((op) => op.employeeId), sets.map((op) => op.workDate),
          sets.map((op) => (op.action === "roster_entry_set" ? op.scheduleTemplateId : null)),
          sets.map((op) => (op.action === "roster_entry_set" ? op.scheduleVersionId : null)),
          sets.map((op) => op.action === "roster_entry_off"), input.note ?? null,
        ],
      );
    }
    const cleared = weekOps.filter((op) => op.action === "roster_entry_cleared");
    if (cleared.length) {
      await client.query(
        `DELETE FROM attendance_roster_entries entry
         USING unnest($2::uuid[], $3::date[]) AS pair(employee_id, work_date)
         WHERE entry.roster_id = $1 AND entry.employee_id = pair.employee_id AND entry.work_date = pair.work_date`,
        [rosterId, cleared.map((op) => op.employeeId), cleared.map((op) => op.workDate)],
      );
    }
    for (const op of weekOps) {
      const template = op.action === "roster_entry_set" ? op.scheduleTemplateId : null;
      item(op, {
        from: op.workDate, to: op.workDate, mask: null, template,
        before: beforeOf.get(`${op.employeeId}:${op.workDate}`) ?? null,
        after: op.action === "roster_entry_cleared" ? null : {
          rosterId, scheduleTemplateId: template, scheduleVersionId: op.action === "roster_entry_set" ? op.scheduleVersionId : null,
          isOff: op.action === "roster_entry_off",
        },
      });
    }
  }

  // §5.3: no overlapping patterns may remain; a hand-made assignment written meanwhile is caught here.
  const overlap = await client.query(
    `SELECT 1 FROM attendance_schedule_assignments one
     JOIN attendance_schedule_assignments other
       ON other.employee_id = one.employee_id AND other.id <> one.id
      AND (other.weekday_mask & one.weekday_mask) <> 0
      AND other.effective_from <= coalesce(one.effective_to, 'infinity'::date)
      AND one.effective_from <= coalesce(other.effective_to, 'infinity'::date)
     WHERE one.change_set_id = $1
     LIMIT 1`,
    [changeSetId],
  );
  if (overlap.rows[0]) {
    throw new ScheduleChangeError(409, "SCHEDULE_CHANGED_SINCE_PREVIEW", "Jadwal sudah diubah orang lain. Lihat dampak lagi.");
  }

  await client.query(
    `INSERT INTO attendance_schedule_change_items (
       id, change_set_id, sequence, employee_id, action, work_date_from, work_date_to, weekday_mask, schedule_template_id, before_state, after_state
     )
     SELECT gen_random_uuid(), $1, row.sequence, row.employee_id, row.action, row.work_date_from, row.work_date_to,
       row.weekday_mask, row.schedule_template_id, row.before_state::jsonb, row.after_state::jsonb
     FROM unnest($2::int[], $3::uuid[], $4::text[], $5::date[], $6::date[], $7::int[], $8::uuid[], $9::text[], $10::text[])
       AS row(sequence, employee_id, action, work_date_from, work_date_to, weekday_mask, schedule_template_id, before_state, after_state)`,
    [
      changeSetId, items.map((_, index) => index + 1), items.map((entry) => entry.op.employeeId), items.map((entry) => entry.op.action),
      items.map((entry) => entry.from), items.map((entry) => entry.to), items.map((entry) => entry.mask), items.map((entry) => entry.template),
      items.map((entry) => (entry.before === null ? null : JSON.stringify(entry.before))),
      items.map((entry) => (entry.after === null ? null : JSON.stringify(entry.after))),
    ],
  );

  await client.query(
    `INSERT INTO access_audit_events (id, actor_account_id, action, entity_type, entity_id, payload)
     VALUES ($1, $2, 'attendance.schedule_change.applied', 'attendance_schedule_change_set', $3, $4::jsonb)`,
    [randomUUID(), actorAccountId, changeSetId, JSON.stringify({ kind: input.kind, ...plan.summary, items: items.length })],
  );
  return { id: changeSetId, replayed: false, summary: plan.summary, employeeIds: plan.employees.map((employee) => employee.id) };
}
