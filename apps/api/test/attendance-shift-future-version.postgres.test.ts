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
      return { principal: { id: actor.id, email: "hc-timeline@example.invalid", principalType: "SUPER_ADMIN" }, expiresAt: new Date("2099-01-01T00:00:00.000Z") };
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

// ATT-011-4a timeline against the real schema: a change from a later date, the readers that must keep
// showing the version in force, and roster publish pinning the version valid on each date. Synthetic
// rows inside one outer transaction that is always rolled back.
describe.skipIf(!allowed)("ATT-011-4a shift timeline (PostgreSQL)", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let scheduleId: string;
  let employeeId: string;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay() || 7;
  const weekStart = addDays(today, 15 - weekday);
  const effectiveFrom = addDays(weekStart, 3);

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
        const savepoint = `timeline_${++sequence}`;
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
    employeeId = randomUUID();
    scheduleId = randomUUID();
    await client.query(
      "INSERT INTO employees (id, employee_number, full_name, status, started_on) VALUES ($1, $2, 'Synthetic Timeline', 'active', '2026-01-01')",
      [employeeId, `TL-${employeeId}`],
    );
    await client.query(
      "INSERT INTO accounts (id, employee_id, email, principal_type, status) VALUES ($1, $2, $3, 'EMPLOYEE', 'active')",
      [actor.id, employeeId, `tl-${actor.id}@example.invalid`],
    );
    await client.query(
      `INSERT INTO attendance_schedule_templates (id, name, start_time, end_time, created_by_account_id)
       VALUES ($1, 'Synthetic Timeline Shift', '08:00', '16:00', $2)`,
      [scheduleId, actor.id],
    );
    await client.query(
      `INSERT INTO attendance_schedule_versions (id, schedule_template_id, version, name, start_time, end_time, end_day_offset, effective_from, created_by_account_id)
       VALUES ($1, $2, 1, 'Synthetic Timeline Shift', '08:00', '16:00', 0, '2000-01-01T00:00:00Z', $3)`,
      [randomUUID(), scheduleId, actor.id],
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

  const call = (method: "GET" | "PATCH" | "POST", url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers: { cookie: "hcis_session=test-token" }, ...(payload ? { payload } : {}) });
  const versions = async () => (await client.query<{ version: number; start: string; from: string; to: string | null }>(
    `SELECT version, start_time::text AS start, (effective_from AT TIME ZONE 'Asia/Jakarta')::date::text AS from,
       (effective_to AT TIME ZONE 'Asia/Jakarta')::text AS to
     FROM attendance_schedule_versions WHERE schedule_template_id = $1 ORDER BY version`,
    [scheduleId],
  )).rows;

  it("keeps today's hours, replaces a scheduled change, and refuses a change from now while one is scheduled", async () => {
    expect((await call("PATCH", `/admin/attendance/schedules/${scheduleId}`, { startTime: "07:30", endTime: "15:30", effectiveFrom })).statusCode).toBe(200);
    const listed = (await call("GET", "/admin/attendance/schedules")).json().items.find((item: { id: string }) => item.id === scheduleId);
    expect(listed).toMatchObject({ startTime: "08:00:00", pendingVersion: { effectiveFrom, startTime: "07:30:00" } });

    expect((await call("PATCH", `/admin/attendance/schedules/${scheduleId}`, { lateGraceMinutes: 5 })).json().code).toBe("SCHEDULE_CHANGE_PENDING");

    // A partial change from the same date replaces the scheduled one and keeps its hours.
    expect((await call("PATCH", `/admin/attendance/schedules/${scheduleId}`, { lateGraceMinutes: 5, effectiveFrom })).statusCode).toBe(200);
    const rows = await versions();
    expect(rows.map((row) => [row.start, row.from])).toEqual([["08:00:00", "2000-01-01"], ["07:30:00", effectiveFrom]]);
    expect(rows[0]!.to).toBe(`${effectiveFrom} 00:00:00`);
    expect(rows[1]!.to).toBeNull();
  });

  it("pins each roster date to the version valid on it, which then cannot be replaced", async () => {
    expect((await call("PATCH", `/admin/attendance/schedules/${scheduleId}`, { startTime: "07:30", endTime: "15:30", effectiveFrom })).statusCode).toBe(200);
    const rosterId = randomUUID();
    await client.query(
      "INSERT INTO attendance_rosters (id, week_start, version, status, created_by_account_id) VALUES ($1, $2::date, 1000, 'DRAFT', $3)",
      [rosterId, weekStart, actor.id],
    );
    await client.query(
      `INSERT INTO attendance_roster_entries (roster_id, employee_id, work_date, schedule_template_id, is_off)
       VALUES ($1, $2, $3::date, $4, false), ($1, $2, $5::date, $4, false)`,
      [rosterId, employeeId, addDays(weekStart, 1), scheduleId, addDays(weekStart, 4)],
    );
    const published = await call("POST", `/admin/attendance/rosters/${rosterId}/publish`);
    expect(published.statusCode, published.body).toBe(200);
    const pinned = await client.query<{ workDate: string; start: string }>(
      `SELECT entry.work_date::text AS "workDate", version.start_time::text AS start
       FROM attendance_roster_entries entry JOIN attendance_schedule_versions version ON version.id = entry.schedule_version_id
       WHERE entry.roster_id = $1 ORDER BY entry.work_date`,
      [rosterId],
    );
    expect(pinned.rows.map((row) => row.start)).toEqual(["08:00:00", "07:30:00"]);

    const refused = await call("PATCH", `/admin/attendance/schedules/${scheduleId}`, { startTime: "07:00", effectiveFrom });
    expect(refused.json().code).toBe("SCHEDULE_FUTURE_VERSION_IN_USE");
  });
});
