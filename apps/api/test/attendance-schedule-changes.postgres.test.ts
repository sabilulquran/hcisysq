import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

const actor = { id: "" };

vi.mock("../src/modules/auth/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/auth/service.js")>();
  class FakeAuthService {
    async getSession(token: string | null) {
      if (!token) return null;
      return { principal: { id: actor.id, email: "hc-planner@example.invalid", principalType: "SUPER_ADMIN" }, expiresAt: new Date("2099-01-01T00:00:00.000Z") };
    }
    async getAuthorizationContext() {
      return { organizationPermissions: ["attendance.schedule.manage"] };
    }
  }
  return { ...actual, AuthService: FakeAuthService };
});

const { registerAttendanceWorkforceRoutes } = await import("../src/modules/attendance/workforce-routes.js");

const config = {
  NODE_ENV: "test", HOST: "127.0.0.1", PORT: 3001, DATABASE_URL: "postgres://unused",
  AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8,
} as ApiConfig;

function addDays(date: string, days: number) {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

// ATT-011-4b Perubahan Jadwal against the real schema: preview, apply, the assignments and roster
// versions it writes, the calendar that reads them back, and the refusals. Synthetic rows inside one
// outer transaction that is always rolled back.
describe.skipIf(!allowed)("ATT-011-4b schedule change sets (PostgreSQL)", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let morning: string;
  let afternoon: string;
  let first: string;
  let second: string;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay() || 7;
  const week = addDays(today, 15 - weekday);

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    const stack: string[] = [];
    let sequence = 0;
    const query = async (text: string, values?: unknown[]) => {
      const command = text.trim().toUpperCase();
      if (command === "BEGIN") {
        const savepoint = `planner_${++sequence}`;
        stack.push(savepoint);
        return client.query(`SAVEPOINT ${savepoint}`);
      }
      if (command === "COMMIT" || command === "ROLLBACK") {
        const savepoint = stack.pop();
        if (!savepoint) throw new Error("Unbalanced test transaction");
        if (command === "ROLLBACK") await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        return client.query(`RELEASE SAVEPOINT ${savepoint}`);
      }
      return client.query(text, values);
    };
    const transactionPool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;

    actor.id = randomUUID();
    first = randomUUID();
    second = randomUUID();
    await client.query(
      `INSERT INTO employees (id, employee_number, full_name, status, started_on)
       VALUES ($1, $3, 'Synthetic Planner One', 'active', '2026-01-01'), ($2, $4, 'Synthetic Planner Two', 'active', '2026-01-01')`,
      [first, second, `PL-${first}`, `PL-${second}`],
    );
    await client.query(
      "INSERT INTO accounts (id, employee_id, email, principal_type, status) VALUES ($1, $2, $3, 'EMPLOYEE', 'active')",
      [actor.id, first, `pl-${actor.id}@example.invalid`],
    );
    morning = randomUUID();
    afternoon = randomUUID();
    for (const [id, name, start, end] of [[morning, "Synthetic Pagi", "07:00", "15:00"], [afternoon, "Synthetic Siang", "13:00", "21:00"]] as const) {
      await client.query(
        "INSERT INTO attendance_schedule_templates (id, name, start_time, end_time, created_by_account_id) VALUES ($1, $2, $3, $4, $5)",
        [id, name, start, end, actor.id],
      );
      await client.query(
        `INSERT INTO attendance_schedule_versions (id, schedule_template_id, version, name, start_time, end_time, end_day_offset, effective_from, created_by_account_id)
         VALUES ($1, $2, 1, $3, $4, $5, 0, '2000-01-01T00:00:00Z', $6)`,
        [randomUUID(), id, name, start, end, actor.id],
      );
    }
    // The first employee works Pagi Monday to Friday, open-ended.
    await client.query(
      `INSERT INTO attendance_schedule_assignments (id, employee_id, schedule_template_id, weekday_mask, effective_from, created_by_account_id)
       VALUES ($1, $2, $3, 31, '2026-01-01', $4)`,
      [randomUUID(), first, morning, actor.id],
    );

    app = Fastify({ logger: false });
    await registerAttendanceWorkforceRoutes(app, transactionPool, config, {
      calculationRunner: { kick: vi.fn(), recoverInterrupted: vi.fn(async () => 0), idle: vi.fn(async () => undefined) },
    });
  });

  afterEach(async () => {
    await app?.close();
    await client.query("ROLLBACK");
    client.release();
  });

  const call = (method: "GET" | "POST", url: string, payload?: unknown, key?: string) => app.inject({
    method, url, headers: { cookie: "hcis_session=test-token", ...(key ? { "idempotency-key": key } : {}) },
    ...(payload ? { payload: payload as Record<string, unknown> } : {}),
  });
  const preview = (change: Record<string, unknown>) => call("POST", "/admin/attendance/schedule-changes/preview", change);
  const apply = async (change: Record<string, unknown>, key = randomUUID()) => {
    const previewed = await preview(change);
    expect(previewed.statusCode, previewed.body).toBe(200);
    return { previewed: previewed.json(), applied: await call("POST", "/admin/attendance/schedule-changes", { change, previewFingerprint: previewed.json().fingerprint }, key) };
  };
  const assignments = async (employeeId: string) => (await client.query<{ template: string; mask: number; from: string; to: string | null }>(
    `SELECT schedule_template_id AS template, weekday_mask AS mask, effective_from::text AS from, effective_to::text AS to
     FROM attendance_schedule_assignments WHERE employee_id = $1 ORDER BY effective_from, weekday_mask`,
    [employeeId],
  )).rows;
  const calendar = async (from: string, to: string) => {
    const response = await call("GET", `/admin/attendance/schedule-calendar?from=${from}&to=${to}&q=Synthetic%20Planner`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as { total: number; employees: Array<{ id: string; days: Array<{ date: string; source: string; scheduleTemplateId: string | null }> }> };
  };

  it("sets a pattern: ends the old one, keeps unticked days, continues it after the period, and is idempotent", async () => {
    const change = {
      kind: "pattern", employeeIds: [first, second], scheduleTemplateId: afternoon,
      from: week, to: addDays(week, 27), weekdays: [1, 2, 3], untickedDays: "keep", note: "Semester ganjil",
    };
    const key = randomUUID();
    const { previewed, applied } = await apply(change, key);
    expect(previewed.summary).toMatchObject({ employees: 2, newEmployees: 1, replacedEmployees: 1, blockingIssues: 0 });
    expect(applied.statusCode, applied.body).toBe(201);

    expect(await assignments(first)).toEqual([
      { template: morning, mask: 31, from: "2026-01-01", to: addDays(week, -1) },
      { template: afternoon, mask: 7, from: week, to: addDays(week, 27) },
      { template: morning, mask: 24, from: week, to: addDays(week, 27) },
      { template: morning, mask: 31, from: addDays(week, 28), to: null },
    ]);
    expect(await assignments(second)).toEqual([{ template: afternoon, mask: 7, from: week, to: addDays(week, 27) }]);

    const days = (await calendar(week, addDays(week, 6))).employees.find((employee) => employee.id === first)!.days;
    expect(days.map((day) => [day.source, day.scheduleTemplateId])).toEqual([
      ["pattern", afternoon], ["pattern", afternoon], ["pattern", afternoon], ["pattern", morning], ["pattern", morning], ["off", null], ["off", null],
    ]);

    const replay = await call("POST", "/admin/attendance/schedule-changes", { change, previewFingerprint: previewed.fingerprint }, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ id: applied.json().id, replayed: true });
    const stale = await call("POST", "/admin/attendance/schedule-changes", { change, previewFingerprint: previewed.fingerprint }, randomUUID());
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("SCHEDULE_CHANGED_SINCE_PREVIEW");

    const history = (await call("GET", "/admin/attendance/schedule-changes")).json();
    expect(history.items[0]).toMatchObject({ id: applied.json().id, kind: "pattern", note: "Semester ganjil" });
    const detail = (await call("GET", `/admin/attendance/schedule-changes/${applied.json().id}`)).json();
    expect(detail.total).toBe(5);
    const audit = await client.query("SELECT payload FROM access_audit_events WHERE action = 'attendance.schedule_change.applied' AND entity_id = $1", [applied.json().id]);
    expect(audit.rows[0].payload).toMatchObject({ kind: "pattern", employees: 2, items: 5 });
  });

  it("replaces days as a new published roster version that keeps the other entries", async () => {
    const rosterId = randomUUID();
    await client.query(
      `INSERT INTO attendance_rosters (id, week_start, version, status, created_by_account_id, published_by_account_id, published_at)
       VALUES ($1, $2::date, 1, 'PUBLISHED', $3, $3, now())`,
      [rosterId, week, actor.id],
    );
    await client.query(
      `INSERT INTO attendance_roster_entries (roster_id, employee_id, work_date, schedule_template_id, schedule_version_id, is_off)
       SELECT $1, $2, $3::date, $4, id, false FROM attendance_schedule_versions WHERE schedule_template_id = $4`,
      [rosterId, second, addDays(week, 3), afternoon],
    );
    const missingNote = await preview({ kind: "replacement", employeeIds: [first], scheduleTemplateId: null, from: addDays(week, 1), to: addDays(week, 2) });
    expect(missingNote.statusCode).toBe(400);

    const { applied } = await apply({ kind: "replacement", employeeIds: [first], scheduleTemplateId: null, from: addDays(week, 1), to: addDays(week, 2), note: "Rapat luar" });
    expect(applied.statusCode, applied.body).toBe(201);
    const rosters = await client.query<{ version: number; changeSetId: string | null; entries: number }>(
      `SELECT roster.version, roster.change_set_id AS "changeSetId", (SELECT count(*)::int FROM attendance_roster_entries entry WHERE entry.roster_id = roster.id) AS entries
       FROM attendance_rosters roster WHERE week_start = $1::date AND status = 'PUBLISHED' ORDER BY version`,
      [week],
    );
    expect(rosters.rows).toEqual([{ version: 1, changeSetId: null, entries: 1 }, { version: 2, changeSetId: applied.json().id, entries: 3 }]);

    const result = await calendar(week, addDays(week, 6));
    const sources = (id: string) => result.employees.find((employee) => employee.id === id)!.days.slice(0, 4).map((day) => day.source);
    expect(sources(first)).toEqual(["pattern", "roster_off", "roster_off", "pattern"]);
    expect(sources(second)).toEqual(["off", "off", "off", "roster"]);
  });

  it("refuses a draft roster week, a past date, and a start that is not a Monday for a copy", async () => {
    await client.query(
      "INSERT INTO attendance_rosters (id, week_start, version, status, created_by_account_id) VALUES ($1, $2::date, 1, 'DRAFT', $3)",
      [randomUUID(), week, actor.id],
    );
    const change = { kind: "replacement", employeeIds: [first], scheduleTemplateId: afternoon, from: week, to: week, note: "Ganti" };
    const previewed = await preview(change);
    expect(previewed.json().issues).toEqual([expect.objectContaining({ code: "draft_roster", blocking: true })]);
    const refused = await call("POST", "/admin/attendance/schedule-changes", { change, previewFingerprint: previewed.json().fingerprint });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("ROSTER_DRAFT_EXISTS");

    const past = await preview({ ...change, from: addDays(today, -1), to: addDays(today, -1) });
    expect(past.statusCode).toBe(422);
    expect(past.json().code).toBe("SCHEDULE_CHANGE_IN_PAST");
    expect((await preview({ kind: "copy", employeeIds: [first], sourceWeekStart: addDays(week, 1), targetWeekStarts: [addDays(week, 7)] })).statusCode).toBe(400);
  });

  it("clears a holiday shift an earlier change wrote, and copies around a holiday in the source week", async () => {
    const holiday = addDays(week, 2);
    await client.query(
      `INSERT INTO leave_calendar_exceptions (calendar_date, is_working_day, label) VALUES ($1::date, false, 'Synthetic holiday')
       ON CONFLICT (calendar_date) DO UPDATE SET is_working_day = false`,
      [holiday],
    );
    const onHoliday = await apply({ kind: "replacement", employeeIds: [first], scheduleTemplateId: afternoon, from: holiday, to: holiday, workOnHolidays: true, note: "Tugas libur" });
    expect(onHoliday.applied.statusCode, onHoliday.applied.body).toBe(201);
    expect((await calendar(holiday, holiday)).employees.find((employee) => employee.id === first)!.days[0]).toMatchObject({ source: "roster", scheduleTemplateId: afternoon });

    const off = await apply({ kind: "replacement", employeeIds: [first], scheduleTemplateId: null, from: addDays(week, 1), to: addDays(week, 3), note: "Batal" });
    expect(off.applied.statusCode, off.applied.body).toBe(201);
    const days = (await calendar(week, addDays(week, 4))).employees.find((employee) => employee.id === first)!.days;
    expect(days.map((day) => day.source)).toEqual(["pattern", "roster_off", "holiday", "roster_off", "pattern"]);
    const items = (await call("GET", `/admin/attendance/schedule-changes/${off.applied.json().id}`)).json().items;
    expect(items.map((entry: { action: string }) => entry.action).sort()).toEqual(["roster_entry_cleared", "roster_entry_off", "roster_entry_off"]);

    const copied = await apply({ kind: "copy", employeeIds: [second], sourceWeekStart: week, targetWeekStarts: [addDays(week, 7)] });
    expect(copied.applied.statusCode, copied.applied.body).toBe(201);
    const target = await client.query<{ workDate: string }>(
      `SELECT entry.work_date::text AS "workDate" FROM attendance_roster_entries entry JOIN attendance_rosters roster ON roster.id = entry.roster_id
       WHERE roster.change_set_id = $1 AND entry.employee_id = $2 ORDER BY entry.work_date`,
      [copied.applied.json().id, second],
    );
    expect(target.rows.map((row) => row.workDate)).not.toContain(addDays(week, 9));
    expect(target.rows).toHaveLength(6);
  });

  it("blocks an unknown shift and refuses an idempotency key reused for another change", async () => {
    const missingShift = { kind: "pattern", employeeIds: [first], scheduleTemplateId: randomUUID(), from: week, to: null, weekdays: [1], untickedDays: "off" };
    const unknown = await preview(missingShift);
    expect(unknown.json().issues).toEqual([expect.objectContaining({ code: "shift_not_valid", blocking: true })]);
    const refused = await call("POST", "/admin/attendance/schedule-changes", { change: missingShift, previewFingerprint: unknown.json().fingerprint });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().code).toBe("SCHEDULE_CHANGE_BLOCKED");
    expect(await assignments(first)).toHaveLength(1);

    const key = randomUUID();
    const change = { kind: "replacement", employeeIds: [first], scheduleTemplateId: afternoon, from: week, to: week, note: "Satu" };
    expect((await apply(change, key)).applied.statusCode).toBe(201);
    const other = { ...change, note: "Dua" };
    const otherPreview = (await preview(other)).json();
    const reused = await call("POST", "/admin/attendance/schedule-changes", { change: other, previewFingerprint: otherPreview.fingerprint }, key);
    expect(reused.statusCode).toBe(422);
    expect(reused.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("copies the schedule in force on the source week, pattern included", async () => {
    const { applied } = await apply({ kind: "copy", employeeIds: [first], sourceWeekStart: week, targetWeekStarts: [addDays(week, 7)] });
    expect(applied.statusCode, applied.body).toBe(201);
    const entries = await client.query<{ workDate: string; template: string | null; isOff: boolean }>(
      `SELECT entry.work_date::text AS "workDate", entry.schedule_template_id AS template, entry.is_off AS "isOff"
       FROM attendance_roster_entries entry JOIN attendance_rosters roster ON roster.id = entry.roster_id
       WHERE roster.change_set_id = $1 ORDER BY entry.work_date`,
      [applied.json().id],
    );
    expect(entries.rows.map((row) => row.template)).toEqual([morning, morning, morning, morning, morning, null, null]);
    expect(entries.rows.at(-1)!.isOff).toBe(true);
  });
});
