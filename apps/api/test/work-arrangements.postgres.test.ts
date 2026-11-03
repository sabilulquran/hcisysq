// ATT-015 Package 1 acceptance against a real schema.
// Synthetic employees only; every test runs inside one rolled-back transaction.

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import { materializeAttendanceResult } from "../src/modules/attendance/engine.js";
import { attendanceExceptions } from "../src/modules/attendance/exceptions.js";
import { registerWorkArrangementRoutes } from "../src/modules/attendance/work-arrangement-routes.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import { registerTripRoutes } from "../src/modules/trips/routes.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

/** The routes own their transactions; BEGIN/COMMIT/ROLLBACK become savepoints of the test's. */
function savepointPool(client: PoolClient): Pool {
  let depth = 0;
  const run = async (text: string, values?: unknown[]) => {
    const statement = String(text).trim().toUpperCase();
    if (statement.startsWith("BEGIN")) return client.query(`SAVEPOINT test_sp_${++depth}`);
    if (statement.startsWith("COMMIT")) {
      const name = `test_sp_${depth}`;
      depth -= 1;
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    if (statement.startsWith("ROLLBACK")) {
      const name = `test_sp_${depth}`;
      depth -= 1;
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    return client.query(text, values);
  };
  const handle = { query: run, release: () => {} };
  return { query: run, connect: async () => handle } as unknown as Pool;
}

function jakartaToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function addDays(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

describe.skipIf(!allowed)("ATT-015 work arrangements", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let principal: AuthPrincipal;
  let permissions: string[];
  let morningShift: string;
  let afternoonShift: string;
  const people = {} as Record<"requester" | "manager" | "unitApprover" | "other", { employeeId: string; accountId: string }>;
  const today = jakartaToday();
  const yesterday = addDays(today, -1);

  async function insertEmployee(name: string, unitId: string | null) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO employees(id, employee_number, full_name, status, started_on, organizational_unit_id)
       VALUES ($1,$2,$3,'active','2020-01-06',$4)`,
      [id, `ARR-${id.slice(0, 8)}`, name, unitId],
    );
    return id;
  }

  async function insertAccount(employeeId: string, status = "active") {
    const id = randomUUID();
    await client.query(
      `INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1,$2,$3,'EMPLOYEE',$4)`,
      [id, employeeId, `arrangement-${id}@example.invalid`, status],
    );
    return id;
  }

  async function insertShift(name: string, start: string, end: string) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO attendance_schedule_templates (id, name, start_time, end_time, created_by_account_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, name, start, end, people.other.accountId],
    );
    await client.query(
      `INSERT INTO attendance_schedule_versions (id, schedule_template_id, version, name, start_time, end_time, end_day_offset, effective_from, created_by_account_id)
       VALUES ($1, $2, 1, $3, $4, $5, 0, '2000-01-01T00:00:00Z', $6)`,
      [randomUUID(), id, name, start, end, people.other.accountId],
    );
    return id;
  }

  function actAs(who: keyof typeof people, granted: string[] = []) {
    principal = { id: people[who].accountId, email: `${who}@example.invalid`, principalType: "EMPLOYEE" };
    permissions = granted;
  }

  async function submit(overrides: Record<string, unknown> = {}) {
    actAs("requester");
    return app.inject({
      method: "POST",
      url: "/attendance/arrangements/me",
      payload: {
        type: "FIELD_ASSIGNMENT",
        location: "SDIT Mitra Cibinong",
        purpose: "Mendampingi santri lomba tahfizh tingkat kecamatan",
        startOn: yesterday,
        endOn: yesterday,
        idempotencyKey: randomUUID(),
        ...overrides,
      },
    });
  }

  async function submitted(overrides: Record<string, unknown> = {}) {
    const response = await submit(overrides);
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string; approvalChain: Array<{ id: string; employeeId: string }> };
  }

  async function decide(stepId: string, who: keyof typeof people, decision: "approve" | "reject", note?: string) {
    actAs(who);
    return app.inject({ method: "POST", url: `/attendance/arrangements/approvals/${stepId}/decision`, payload: { decision, note } });
  }

  async function approved(overrides: Record<string, unknown> = {}) {
    const request = await submitted(overrides);
    expect((await decide(request.approvalChain[0]!.id, "manager", "approve")).statusCode).toBe(200);
    const last = await decide(request.approvalChain[1]!.id, "unitApprover", "approve");
    expect(last.statusCode, last.body).toBe(200);
    return { ...request, final: last.json() as { requestStatus: string; recalculatedDates?: number } };
  }

  async function latestResult(workDate: string) {
    const result = await client.query<{
      status: string; lateMinutes: number; lateJustified: boolean; justified: boolean;
      firstCheckInAt: Date | null; sourceWorkArrangementId: string | null;
    }>(
      `SELECT status, late_minutes AS "lateMinutes", late_justified AS "lateJustified", justified,
              first_check_in_at AS "firstCheckInAt", source_work_arrangement_id AS "sourceWorkArrangementId"
         FROM attendance_result_versions
        WHERE employee_id = $1 AND work_date = $2::date
        ORDER BY version DESC LIMIT 1`,
      [people.requester.employeeId, workDate],
    );
    return result.rows[0];
  }

  async function eventCount() {
    const result = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM attendance_events WHERE employee_id = $1", [people.requester.employeeId],
    );
    return result.rows[0]!.count;
  }

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    const unitId = randomUUID();
    await client.query(
      "INSERT INTO organizational_units(id, normalized_name, name) VALUES ($1,$2,'Unit Tugas Luar Sintetis')",
      [unitId, `unit-arrangement-${unitId}`],
    );
    for (const key of ["manager", "unitApprover", "requester", "other"] as const) {
      const employeeId = await insertEmployee(`Pegawai ${key}`, unitId);
      people[key] = { employeeId, accountId: await insertAccount(employeeId) };
    }
    await client.query("UPDATE organizational_units SET leave_approver_employee_id = $2 WHERE id = $1", [unitId, people.unitApprover.employeeId]);
    await client.query("UPDATE employees SET direct_manager_employee_id = $2 WHERE id = $1", [people.requester.employeeId, people.manager.employeeId]);
    // Every day 07:00-16:00 for the requester; a second shift to change to.
    morningShift = await insertShift("Shift Pagi Sintetis", "07:00", "16:00");
    afternoonShift = await insertShift("Shift Siang Sintetis", "12:00", "20:00");
    await client.query(
      `INSERT INTO attendance_schedule_assignments (id, employee_id, schedule_template_id, weekday_mask, effective_from, created_by_account_id)
       VALUES ($1, $2, $3, 127, '2020-01-01', $4)`,
      [randomUUID(), people.requester.employeeId, morningShift, people.other.accountId],
    );
    actAs("requester");

    const config = { NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8 } as ApiConfig;
    const auth = {
      getSession: async () => ({ principal, expiresAt: "2099-01-01T00:00:00Z" }),
      getAuthorizationContext: async () => ({ organizationPermissions: permissions }),
    } as never;
    app = Fastify({ logger: false });
    await registerWorkArrangementRoutes(app, savepointPool(client), config, auth);
    await registerTripRoutes(app, savepointPool(client), config, auth);
  });

  afterEach(async () => {
    try { await app?.close(); } finally {
      if (client) { await client.query("ROLLBACK"); client.release(); }
    }
  });

  it("ATT-015-A/B/L: snapshots the chain at submission and keeps each request private to its owner", async () => {
    const preview = await app.inject({
      method: "POST", url: "/attendance/arrangements/me/preview",
      payload: { type: "REMOTE_WORK", startOn: addDays(today, 3), endOn: addDays(today, 3) },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ days: 1, meetings: [] });
    expect(preview.json().approvalChain.map((step: { employeeId: string }) => step.employeeId))
      .toEqual([people.manager.employeeId, people.unitApprover.employeeId]);

    const request = await submitted({ type: "REMOTE_WORK", location: "Rumah, Cibinong", startOn: addDays(today, 3), endOn: addDays(today, 3) });
    await client.query("UPDATE employees SET direct_manager_employee_id = $2 WHERE id = $1", [people.requester.employeeId, people.other.employeeId]);
    const detail = await app.inject({ method: "GET", url: `/attendance/arrangements/me/${request.id}` });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({ type: "REMOTE_WORK", status: "IN_REVIEW", location: "Rumah, Cibinong" });
    expect(detail.json().steps.map((step: { status: string }) => step.status)).toEqual(["pending", "waiting"]);
    expect(detail.json().events.map((event: { eventType: string }) => event.eventType)).toEqual(["arrangement.request.submitted"]);

    const list = await app.inject({ method: "GET", url: "/attendance/arrangements/me?type=REMOTE_WORK" });
    expect(list.json().pagination).toMatchObject({ page: 1, pageSize: 25, total: 1 });

    actAs("other");
    expect((await app.inject({ method: "GET", url: `/attendance/arrangements/me/${request.id}` })).statusCode).toBe(404);
    expect((await app.inject({
      method: "POST", url: `/attendance/arrangements/me/${request.id}/cancel`, payload: { reason: "Bukan milik saya" },
    })).statusCode).toBe(404);
  });

  it("replays an idempotent submission instead of storing a duplicate", async () => {
    const key = randomUUID();
    const first = await submit({ idempotencyKey: key });
    expect(first.statusCode, first.body).toBe(201);
    const again = await submit({ idempotencyKey: key });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ id: first.json().id, idempotentReplay: true });
  });

  it("ATT-015-C: only the snapshotted approver decides, once", async () => {
    const request = await submitted();
    const [first, second] = request.approvalChain;
    expect((await decide(first!.id, "requester", "approve")).statusCode).toBe(403);
    expect((await decide(first!.id, "unitApprover", "approve")).statusCode).toBe(403);
    expect((await decide(first!.id, "manager", "approve")).json().requestStatus).toBe("IN_REVIEW");
    const repeat = await decide(first!.id, "manager", "approve");
    expect(repeat.statusCode).toBe(409);
    expect(repeat.json().code).toBe("STEP_NOT_PENDING");
    expect((await decide(second!.id, "unitApprover", "reject")).statusCode).toBe(400);
    const rejected = await decide(second!.id, "unitApprover", "reject", "Tidak ada surat undangan");
    expect(rejected.json().requestStatus).toBe("REJECTED");
  });

  it("ATT-015-D: an approver whose account is not active blocks submission and stores nothing", async () => {
    await client.query("UPDATE accounts SET status = 'invited' WHERE id = $1", [people.manager.accountId]);
    const response = await submit();
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().code).toBe("APPROVER_ACCOUNT_NOT_READY");
    const stored = await client.query("SELECT 1 FROM attendance_work_arrangement_requests WHERE employee_id = $1", [people.requester.employeeId]);
    expect(stored.rowCount).toBe(0);
  });

  it("ATT-015-E: refuses windows, lengths and overlaps; a trip over an arrangement is refused too", async () => {
    expect((await submit({ type: "REMOTE_WORK", location: "Rumah", startOn: today, endOn: addDays(today, 1) })).json().code)
      .toBe("ARRANGEMENT_SINGLE_DAY");
    expect((await submit({ type: "REMOTE_WORK", location: "Rumah", startOn: yesterday, endOn: yesterday })).json().code)
      .toBe("ARRANGEMENT_DATE_TOO_EARLY");
    expect((await submit({ startOn: addDays(today, -8), endOn: addDays(today, -8) })).json().code).toBe("ARRANGEMENT_DATE_TOO_EARLY");
    expect((await submit({ startOn: addDays(today, 1), endOn: addDays(today, 8) })).json().code).toBe("ARRANGEMENT_TOO_LONG");
    expect((await submit({ startOn: addDays(today, 61), endOn: addDays(today, 61) })).json().code).toBe("ARRANGEMENT_DATE_TOO_LATE");

    await submitted({ startOn: addDays(today, 10), endOn: addDays(today, 12) });
    expect((await submit({ type: "REMOTE_WORK", location: "Rumah", startOn: addDays(today, 12), endOn: addDays(today, 12) })).json().code)
      .toBe("ARRANGEMENT_OVERLAP");

    await client.query(
      `INSERT INTO leave_requests(id, employee_id, policy_key, status, start_on, end_on, working_days, hc_handling, idempotency_key)
       VALUES ($1,$2,'annual','approved',$3,$3,1,'none',$4)`,
      [randomUUID(), people.requester.employeeId, addDays(today, 20), randomUUID()],
    );
    expect((await submit({ startOn: addDays(today, 19), endOn: addDays(today, 21) })).json().code).toBe("ARRANGEMENT_LEAVE_OVERLAP");

    actAs("requester");
    const trip = await app.inject({
      method: "POST", url: "/trips/me",
      payload: {
        destination: "Yayasan Mitra Bandung", purpose: "Rapat koordinasi kurikulum tahfidz",
        startOn: addDays(today, 11), endOn: addDays(today, 13), idempotencyKey: randomUUID(),
      },
    });
    expect(trip.statusCode).toBe(409);
    expect(trip.json().code).toBe("TRIP_ARRANGEMENT_OVERLAP");
  });

  it("ATT-015-F/G/I: an approved tugas luar explains a day without punches, never invents one, and cancelling restores it", async () => {
    const eventsBefore = await eventCount();
    await materializeAttendanceResult(savepointPool(client), people.requester.employeeId, yesterday);
    expect((await latestResult(yesterday))?.status).toBe("absent");

    const request = await approved();
    expect(request.final).toMatchObject({ requestStatus: "APPROVED", recalculatedDates: 1 });
    expect(await latestResult(yesterday)).toMatchObject({
      status: "field_assignment", firstCheckInAt: null, justified: true, sourceWorkArrangementId: request.id,
    });
    expect(await eventCount()).toBe(eventsBefore);

    // A late punch on a covered day stands; the lateness is recorded but explained.
    await client.query(
      `INSERT INTO attendance_events (id, employee_id, source, event_kind, occurred_at, source_reference)
       VALUES ($1, $2, 'manual', 'check_in', $3, $4), ($5, $2, 'manual', 'check_out', $6, $7)`,
      [randomUUID(), people.requester.employeeId, `${yesterday}T10:00:00+07:00`, `test:${randomUUID()}`,
        randomUUID(), `${yesterday}T16:05:00+07:00`, `test:${randomUUID()}`],
    );
    await materializeAttendanceResult(savepointPool(client), people.requester.employeeId, yesterday);
    const punched = await latestResult(yesterday);
    expect(punched?.status).toBe("late");
    expect(punched?.lateMinutes).toBeGreaterThan(0);
    expect(punched?.lateJustified).toBe(true);

    // The employee may no longer cancel a started arrangement; HC can, and the day is recalculated.
    actAs("requester");
    const own = await app.inject({ method: "POST", url: `/attendance/arrangements/me/${request.id}/cancel`, payload: { reason: "Salah tanggal" } });
    expect(own.json().code).toBe("ARRANGEMENT_NOT_CANCELLABLE");
    actAs("other", ["attendance.arrangements.read", "attendance.arrangements.manage"]);
    const cancelled = await app.inject({
      method: "POST", url: `/admin/attendance/arrangements/${request.id}/cancel`, payload: { reason: "Tidak ada bukti undangan lomba" },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json()).toMatchObject({ status: "CANCELLED", recalculatedDates: 1 });
    // The punches remain, so the day is judged on them alone again: late and no longer explained.
    expect(await latestResult(yesterday)).toMatchObject({ status: "late", lateJustified: false, sourceWorkArrangementId: null });
  });

  it("ATT-015-H: approved leave on the same day wins over the arrangement", async () => {
    const request = await approved();
    await client.query(
      `INSERT INTO leave_requests(id, employee_id, policy_key, status, start_on, end_on, working_days, hc_handling, idempotency_key)
       VALUES ($1,$2,'annual','approved',$3,$3,1,'none',$4)`,
      [randomUUID(), people.requester.employeeId, yesterday, randomUUID()],
    );
    await materializeAttendanceResult(savepointPool(client), people.requester.employeeId, yesterday);
    expect(await latestResult(yesterday)).toMatchObject({ status: "leave", sourceWorkArrangementId: null });
    void request;
  });

  it("ATT-015-J: a schedule change is applied by HC as a new roster version, and refused when stale", async () => {
    const workDate = addDays(today, 5);
    const options = await app.inject({ method: "GET", url: `/attendance/arrangements/schedule-options?workDate=${workDate}` });
    expect(options.statusCode, options.body).toBe(200);
    expect(options.json().current.scheduleTemplateId).toBe(morningShift);
    expect(options.json().options.map((option: { id: string }) => option.id)).toContain(afternoonShift);
    expect(options.json().options.map((option: { id: string }) => option.id)).not.toContain(morningShift);

    expect((await submit({ type: "SCHEDULE_CHANGE", scheduleTemplateId: morningShift, startOn: workDate, endOn: workDate, location: undefined }))
      .json().code).toBe("SCHEDULE_CHANGE_SAME_SHIFT");
    expect((await submit({ type: "SCHEDULE_CHANGE", scheduleTemplateId: afternoonShift, startOn: today, endOn: today, location: undefined }))
      .json().code).toBe("ARRANGEMENT_DATE_TOO_EARLY");

    const request = await approved({ type: "SCHEDULE_CHANGE", scheduleTemplateId: afternoonShift, startOn: workDate, endOn: workDate, location: undefined });
    actAs("other", ["attendance.arrangements.read"]);
    expect((await app.inject({ method: "POST", url: `/admin/attendance/arrangements/${request.id}/apply`, payload: {} })).statusCode).toBe(403);
    actAs("other", ["attendance.arrangements.read", "attendance.arrangements.manage"]);
    const applied = await app.inject({ method: "POST", url: `/admin/attendance/arrangements/${request.id}/apply`, payload: {} });
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json().status).toBe("APPLIED");
    const entry = await client.query<{ templateId: string }>(
      `SELECT entry.schedule_template_id AS "templateId"
         FROM attendance_roster_entries entry
        WHERE entry.roster_id = $1 AND entry.employee_id = $2 AND entry.work_date = $3::date`,
      [applied.json().roster.rosterId, people.requester.employeeId, workDate],
    );
    expect(entry.rows[0]?.templateId).toBe(afternoonShift);
    expect((await app.inject({ method: "POST", url: `/admin/attendance/arrangements/${request.id}/apply`, payload: {} })).json().code)
      .toBe("ARRANGEMENT_NOT_APPLICABLE");

    // A second request for another day goes stale when HC changes that day first.
    const otherDate = addDays(today, 6);
    const stale = await approved({ type: "SCHEDULE_CHANGE", scheduleTemplateId: afternoonShift, startOn: otherDate, endOn: otherDate, location: undefined });
    await client.query("UPDATE attendance_schedule_assignments SET effective_to = $2::date - 1 WHERE employee_id = $1", [people.requester.employeeId, otherDate]);
    actAs("other", ["attendance.arrangements.read", "attendance.arrangements.manage"]);
    const refused = await app.inject({ method: "POST", url: `/admin/attendance/arrangements/${stale.id}/apply`, payload: {} });
    expect(refused.json().code).toBe("SCHEDULE_CHANGE_STALE");
  });

  it("ATT-015-K/M: the HC register needs the permission and approved requests reach the exceptions tab", async () => {
    const request = await approved();
    actAs("other", []);
    expect((await app.inject({ method: "GET", url: "/admin/attendance/arrangements" })).statusCode).toBe(403);
    actAs("other", ["attendance.arrangements.read"]);
    const page = await app.inject({ method: "GET", url: `/admin/attendance/arrangements?employeeId=${people.requester.employeeId}&pageSize=1` });
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json().pagination).toMatchObject({ pageSize: 1, total: 1 });
    expect((await app.inject({ method: "GET", url: "/admin/attendance/arrangements?pageSize=101" })).statusCode).toBe(400);
    const detail = (await app.inject({ method: "GET", url: `/admin/attendance/arrangements/${request.id}` })).json();
    expect(detail.events.map((event: { eventType: string }) => event.eventType)).toEqual([
      "arrangement.request.submitted", "arrangement.approval.approved_step", "arrangement.approval.approved_step", "arrangement.request.approved",
    ]);

    const exceptions = await attendanceExceptions(savepointPool(client), {
      from: yesterday, to: yesterday, employeeId: people.requester.employeeId, page: 1, pageSize: 25,
    });
    expect(exceptions.items).toEqual([expect.objectContaining({
      kind: "arrangement", id: request.id, type: "FIELD_ASSIGNMENT", typeName: "Tugas luar", status: "APPROVED",
    })]);
  });
});
