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

// The cookie carries the account id; HC is the one account with attendance.overtime.manage.
const people = { hc: "" };

vi.mock("../src/modules/auth/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/auth/service.js")>();
  class FakeAuthService {
    async getSession(token: string | null) {
      if (!token) return null;
      return {
        principal: { id: token, email: `${token}@example.invalid`, principalType: token === people.hc ? "SUPER_ADMIN" : "EMPLOYEE" },
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      };
    }
    async getAuthorizationContext(principal: { id: string }) {
      return { organizationPermissions: principal.id === people.hc ? ["attendance.overtime.manage"] : [] };
    }
  }
  return { ...actual, AuthService: FakeAuthService };
});

const { registerAttendanceWorkforceRoutes } = await import("../src/modules/attendance/workforce-routes.js");

const config = {
  NODE_ENV: "test", HOST: "127.0.0.1", PORT: 3001, DATABASE_URL: "postgres://unused",
  AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8,
} as ApiConfig;

// ATT-011-6b-1 supervisor overtime (§7.2-§7.6) against the real schema and the APR-001 resolver on
// ORG-002 data (OVERTIME not rolled out to the structure). Synthetic rows, always rolled back.
describe.skipIf(!allowed)("ATT-011-6b-1 supervisor overtime (PostgreSQL)", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  const ids = { staff: "", boss: "", other: "", loner: "" };
  const accounts = { staff: "", boss: "", other: "", loner: "" };
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());

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
        const savepoint = `overtime_${++sequence}`;
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

    for (const key of ["boss", "staff", "other", "loner"] as const) {
      ids[key] = randomUUID();
      accounts[key] = randomUUID();
      await client.query(
        `INSERT INTO employees (id, employee_number, full_name, status, started_on, direct_manager_employee_id)
         VALUES ($1, $2, $3, 'active', '2026-01-01', $4)`,
        [ids[key], `OT-${ids[key]}`, `Synthetic ${key}`, key === "staff" || key === "other" ? ids.boss : null],
      );
      await client.query(
        "INSERT INTO accounts (id, employee_id, email, principal_type, status) VALUES ($1, $2, $3, 'EMPLOYEE', 'active')",
        [accounts[key], ids[key], `ot-${accounts[key]}@example.invalid`],
      );
    }
    people.hc = randomUUID();
    await client.query("INSERT INTO accounts (id, email, principal_type, status) VALUES ($1, $2, 'SUPER_ADMIN', 'active')", [people.hc, `hc-${people.hc}@example.invalid`]);

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

  const as = (account: string) => (method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers: { cookie: `hcis_session=${account}` }, ...(payload ? { payload } : {}) });
  const request = async (id: string) => (await client.query(
    `SELECT status, approved_minutes AS "approvedMinutes", initiated_by AS "initiatedBy", supervisor_employee_id AS "supervisorEmployeeId"
     FROM attendance_overtime_requests WHERE id = $1`, [id],
  )).rows[0];

  it("sends an employee's request to the snapshotted supervisor, who alone decides it once", async () => {
    const submitted = await as(accounts.staff)("POST", "/attendance/overtime", { workDate: today, requestedMinutes: 120, note: "Rapat wali murid" });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const id = submitted.json().id as string;
    expect(await request(id)).toMatchObject({ status: "submitted", initiatedBy: "employee", supervisorEmployeeId: ids.boss });

    const pending = (await as(accounts.boss)("GET", "/attendance/team-overtime")).json();
    expect(pending).toMatchObject({ isSupervisor: true, total: 1, items: [{ id, employeeId: ids.staff }] });

    const stranger = await as(accounts.other)("POST", `/attendance/team-overtime/${id}/decision`, { decision: "approve" });
    expect(stranger.statusCode).toBe(403);
    const hc = await as(people.hc)("POST", `/admin/attendance/overtime/${id}/decision`, { decision: "approve" });
    expect(hc.json().code).toBe("OVERTIME_NOT_HC_DECIDED");
    expect((await as(accounts.boss)("POST", `/attendance/team-overtime/${id}/decision`, { decision: "reject" })).json().code).toBe("OVERTIME_REJECT_NOTE_REQUIRED");

    const approved = await as(accounts.boss)("POST", `/attendance/team-overtime/${id}/decision`, { decision: "approve", approvedMinutes: 60 });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(await request(id)).toMatchObject({ status: "approved", approvedMinutes: 60 });
    expect((await as(accounts.boss)("POST", `/attendance/team-overtime/${id}/decision`, { decision: "approve" })).json().code).toBe("OVERTIME_STEP_ALREADY_DECIDED");

    const audit = await client.query("SELECT action FROM access_audit_events WHERE entity_id = $1 ORDER BY created_at", [id]);
    expect(audit.rows.map((row) => row.action).sort()).toEqual(["attendance.overtime.submitted", "attendance.overtime.supervisor_approved"]);
  });

  it("refuses an employee without a recorded supervisor, and a date more than 7 days back", async () => {
    const loner = await as(accounts.loner)("POST", "/attendance/overtime", { workDate: today, requestedMinutes: 60 });
    expect(loner.statusCode).toBe(422);
    expect(loner.json().code).toBe("OVERTIME_APPROVER_UNRESOLVED");
    const old = new Date(Date.parse(`${today}T00:00:00Z`) - 8 * 86_400_000).toISOString().slice(0, 10);
    expect((await as(accounts.staff)("POST", "/attendance/overtime", { workDate: old, requestedMinutes: 60 })).json().code).toBe("OVERTIME_DATE_OUT_OF_RANGE");
    const count = await client.query("SELECT count(*)::int AS n FROM attendance_overtime_requests WHERE employee_id = ANY($1::uuid[])", [[ids.loner, ids.staff]]);
    expect(count.rows[0].n).toBe(0);
  });

  it("lets a supervisor order overtime only for direct reports, which each employee agrees to", async () => {
    const mixed = await as(accounts.boss)("POST", "/attendance/team-overtime/orders", { employeeIds: [ids.staff, ids.loner], workDate: today, requestedMinutes: 90, note: "Persiapan wisuda" });
    expect(mixed.statusCode).toBe(403);
    expect(mixed.json().employees).toEqual([{ employeeId: ids.loner, employeeName: "Synthetic loner" }]);
    expect((await client.query("SELECT count(*)::int AS n FROM attendance_overtime_requests WHERE initiated_by = 'supervisor' AND supervisor_employee_id = $1", [ids.boss])).rows[0].n).toBe(0);

    const ordered = await as(accounts.boss)("POST", "/attendance/team-overtime/orders", { employeeIds: [ids.staff, ids.other], workDate: today, requestedMinutes: 90, note: "Persiapan wisuda" });
    expect(ordered.statusCode, ordered.body).toBe(201);
    const [forStaff, forOther] = ordered.json().ids as string[];

    expect((await as(accounts.staff)("POST", `/attendance/overtime/${forStaff}/cancel`)).statusCode).toBe(409);
    expect((await as(accounts.other)("POST", `/attendance/overtime/${forStaff}/respond`, { decision: "agree" })).statusCode).toBe(403);
    expect((await as(accounts.staff)("POST", `/attendance/overtime/${forStaff}/respond`, { decision: "agree" })).statusCode).toBe(200);
    expect(await request(forStaff)).toMatchObject({ status: "approved", approvedMinutes: 90, initiatedBy: "supervisor" });
    expect((await as(accounts.other)("POST", `/attendance/overtime/${forOther}/respond`, { decision: "decline" })).statusCode).toBe(200);
    expect(await request(forOther)).toMatchObject({ status: "rejected" });
    expect((await as(accounts.boss)("POST", `/attendance/team-overtime/${forStaff}/cancel`)).statusCode).toBe(409);
  });

  it("lets HC reassign a waiting request and void an approved one with a reason", async () => {
    const id = (await as(accounts.staff)("POST", "/attendance/overtime", { workDate: today, requestedMinutes: 60 })).json().id as string;
    expect((await as(accounts.boss)("POST", `/admin/attendance/overtime/${id}/reassign`, { supervisorEmployeeId: ids.other, reason: "Cuti" })).statusCode).toBe(403);
    expect((await as(people.hc)("POST", `/admin/attendance/overtime/${id}/reassign`, { supervisorEmployeeId: ids.staff, reason: "Cuti" })).json().code).toBe("OVERTIME_APPROVER_SELF");
    expect((await as(people.hc)("POST", `/admin/attendance/overtime/${id}/reassign`, { supervisorEmployeeId: ids.other, reason: "Atasan cuti" })).statusCode).toBe(200);
    expect((await as(accounts.boss)("POST", `/attendance/team-overtime/${id}/decision`, { decision: "approve" })).statusCode).toBe(403);
    expect((await as(accounts.other)("POST", `/attendance/team-overtime/${id}/decision`, { decision: "approve" })).statusCode).toBe(200);

    expect((await as(people.hc)("POST", `/admin/attendance/overtime/${id}/void`, { reason: "x" })).statusCode).toBe(400);
    const voided = await as(people.hc)("POST", `/admin/attendance/overtime/${id}/void`, { reason: "Salah tanggal" });
    expect(voided.statusCode, voided.body).toBe(200);
    expect(await request(id)).toMatchObject({ status: "cancelled" });
    const events = await client.query("SELECT event_type FROM attendance_overtime_events WHERE overtime_request_id = $1 ORDER BY created_at", [id]);
    expect(events.rows.map((row) => row.event_type).sort()).toEqual(["admin_voided", "approved", "reassigned", "submitted"]);
  });
});
