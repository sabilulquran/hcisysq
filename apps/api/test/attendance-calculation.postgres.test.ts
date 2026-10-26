import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { attendanceCalculationRows } from "../src/modules/attendance/calculation-rows.js";
import { createCalculationRunner, type CalculationRunner } from "../src/modules/attendance/calculation-runner.js";
import { listAttendanceCorrections } from "../src/modules/attendance/corrections.js";
import { attendanceTransactions } from "../src/modules/attendance/transactions.js";
import { unattributedPins, unscheduledEmployees } from "../src/modules/attendance/unscheduled.js";
import { materializeAttendanceResult } from "../src/modules/attendance/engine.js";
import { listOvertimeForHc } from "../src/modules/attendance/overtime-list.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

// ATT-014-2 Kalkulasi against the real schema and engine. Synthetic rows only, all inside one outer
// transaction that is rolled back even after a failure. now() is constant inside that transaction,
// so "later" facts carry an explicit created_at.
describe.skipIf(!allowed)("ATT-014-2 real PostgreSQL calculation", () => {
  let pool: Pool;
  let client: PoolClient;
  let transactionPool: Pool;
  let runner: CalculationRunner;
  let accountId: string;
  let mapped: string;
  let unmapped: string;
  let deviceId: string;
  let requestId: string;

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  async function admsScan(at: string, createdAt?: string, pin = "CALC-1") {
    const id = randomUUID();
    await client.query(
      `INSERT INTO attendance_adms_events (
         id, device_id, source_request_id, event_identity_hash, pin,
         occurred_at_raw, occurred_at, raw_line, raw_fields, raw_line_sha256, received_at, created_at
       ) VALUES ($1::uuid, $2, $3, $1::uuid::text, $6, $4::text, $4::text::timestamptz, 'synthetic', '[]'::jsonb,
                 $1::uuid::text, $4::text::timestamptz, coalesce($5::timestamptz, now()))`,
      [id, deviceId, requestId, at, createdAt ?? null, pin],
    );
  }

  async function queueRun(scope: { employeeId?: string; from: string; to: string }, createdAt?: string) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO attendance_calculation_runs (id, requested_by_account_id, employee_id, date_from, date_to, status, created_at)
       VALUES ($1, $2, $3, $4::date, $5::date, 'queued', coalesce($6::timestamptz, now()))`,
      [id, accountId, scope.employeeId ?? null, scope.from, scope.to, createdAt ?? null],
    );
    return id;
  }

  async function calculate(scope: { employeeId?: string; from: string; to: string }) {
    const id = await queueRun(scope);
    runner.kick();
    await runner.idle();
    const run = await client.query("SELECT * FROM attendance_calculation_runs WHERE id = $1", [id]);
    return run.rows[0];
  }

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    const stack: string[] = [];
    let sequence = 0;
    const query = async (text: string, values?: unknown[]) => {
      const command = text.trim().toUpperCase();
      if (command === "BEGIN") {
        const savepoint = `calc_test_${++sequence}`;
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
    transactionPool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
    runner = createCalculationRunner(transactionPool, { pause: async () => undefined });

    // No other run may hold the single running slot inside this transaction.
    await client.query("UPDATE attendance_calculation_runs SET status = 'failed', error_code = 'TEST_ISOLATION' WHERE status IN ('queued', 'running')");

    accountId = randomUUID();
    mapped = randomUUID();
    unmapped = randomUUID();
    await client.query(
      `INSERT INTO employees (id, employee_number, full_name, status, started_on)
       VALUES ($1, $3, 'Synthetic Calculation Mapped', 'active', '2026-01-01'),
              ($2, $4, 'Synthetic Calculation Unmapped', 'active', '2026-01-01')`,
      [mapped, unmapped, `CALC-${mapped}`, `CALC-${unmapped}`],
    );
    await client.query(
      "INSERT INTO accounts (id, employee_id, email, principal_type, status) VALUES ($1, $2, $3, 'EMPLOYEE', 'active')",
      [accountId, unmapped, `calc-${accountId}@example.invalid`],
    );
    const scheduleId = randomUUID();
    await client.query(
      `INSERT INTO attendance_schedule_templates (id, name, start_time, end_time, created_by_account_id)
       VALUES ($1, 'Synthetic Calculation Shift', '07:00', '16:00', $2)`,
      [scheduleId, accountId],
    );
    await client.query(
      `INSERT INTO attendance_schedule_versions (id, schedule_template_id, version, name, start_time, end_time, end_day_offset, effective_from, created_by_account_id)
       VALUES ($1, $2, 1, 'Synthetic Calculation Shift', '07:00', '16:00', 0, '2000-01-01T00:00:00Z', $3)`,
      [randomUUID(), scheduleId, accountId],
    );
    for (const employeeId of [mapped, unmapped]) {
      await client.query(
        `INSERT INTO attendance_schedule_assignments (id, employee_id, schedule_template_id, weekday_mask, effective_from, created_by_account_id, created_at)
         VALUES ($1, $2, $3, 127, '2026-01-01', $4, now() - interval '1 day')`,
        [randomUUID(), employeeId, scheduleId, accountId],
      );
    }
    deviceId = randomUUID();
    requestId = randomUUID();
    await client.query(
      `INSERT INTO attendance_adms_devices (id, serial_number, lifecycle, timezone, display_name)
       VALUES ($1, $2, 'active', 'Asia/Jakarta', 'Synthetic Calculation Device')`,
      [deviceId, `CALC-${deviceId}`],
    );
    await client.query(
      `INSERT INTO attendance_adms_request_journal (
         id, device_id, method, path, raw_query, safe_metadata, body, body_sha256, body_byte_length,
         body_captured, classification, response_status, response_body, received_at
       ) VALUES ($1, $2, 'POST', '/iclock/cdata', '?table=ATTLOG', '{}'::jsonb, NULL, NULL, 0, true, 'attlog', 200, 'OK', now())`,
      [requestId, deviceId],
    );
    // The PIN is connected from 2026-08-26 (Jakarta). Earlier scans exist but are outside coverage.
    await client.query(
      `INSERT INTO attendance_adms_employee_mappings (id, device_id, pin, employee_id, effective_from)
       VALUES ($1, $2, 'CALC-1', $3, '2026-08-26T00:00:00+07:00')`,
      [randomUUID(), deviceId, mapped],
    );
    await admsScan("2026-08-27T07:05:00+07:00");
    await admsScan("2026-08-28T06:55:00+07:00");
    await admsScan("2026-08-28T16:05:00+07:00");
  });

  afterEach(async () => {
    if (client) {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("calculates covered dates only and shows the rest as not captured (D-14-3)", async () => {
    const run = await calculate({ employeeId: mapped, from: "2026-08-25", to: "2026-08-28" });
    expect(run).toMatchObject({ status: "completed", total_pairs: 3, processed_pairs: 3, uncovered_pairs: 1, failed_pairs: 0 });
    const versions = await client.query(
      "SELECT work_date::text AS date, status FROM attendance_result_versions WHERE employee_id = $1 ORDER BY work_date",
      [mapped],
    );
    expect(versions.rows).toEqual([
      { date: "2026-08-26", status: "absent" },
      { date: "2026-08-27", status: "incomplete" },
      { date: "2026-08-28", status: "present" },
    ]);
    const rows = await attendanceCalculationRows(transactionPool, { employeeId: mapped, from: "2026-08-25", to: "2026-08-28" });
    expect(rows.items.map((item) => [item.workDate, item.status])).toEqual([
      ["2026-08-25", "not_captured"],
      ["2026-08-26", "absent"],
      ["2026-08-27", "incomplete"],
      ["2026-08-28", "present"],
    ]);
    expect(rows.items[0]).toMatchObject({ normal: null, actual: null, resultVersion: null });
  });

  it("never writes a result for an employee without any capture", async () => {
    const run = await calculate({ employeeId: unmapped, from: "2026-08-25", to: "2026-08-28" });
    expect(run).toMatchObject({ status: "completed", total_pairs: 0, uncovered_pairs: 4 });
    const versions = await client.query("SELECT count(*)::int AS total FROM attendance_result_versions WHERE employee_id = $1", [unmapped]);
    expect(versions.rows[0].total).toBe(0);
  });

  it("keeps a missing punch incomplete without using schedule times as scans (I-3, I-4) and leaves evidence untouched (I-2)", async () => {
    const before = await client.query(
      "SELECT id, occurred_at, raw_line, raw_line_sha256 FROM attendance_adms_events WHERE device_id = $1 ORDER BY id",
      [deviceId],
    );
    await calculate({ employeeId: mapped, from: "2026-08-27", to: "2026-08-27" });
    const result = await client.query(
      `SELECT status, first_check_in_at, last_check_out_at, early_leave_minutes, incomplete_session, overtime_minutes
       FROM attendance_result_versions WHERE employee_id = $1 AND work_date = '2026-08-27'`,
      [mapped],
    );
    expect(result.rows[0]).toMatchObject({ status: "incomplete", last_check_out_at: null, incomplete_session: true, overtime_minutes: 0 });
    expect(new Date(result.rows[0].first_check_in_at).toISOString()).toBe("2026-08-27T00:05:00.000Z");
    const after = await client.query(
      "SELECT id, occurred_at, raw_line, raw_line_sha256 FROM attendance_adms_events WHERE device_id = $1 ORDER BY id",
      [deviceId],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("sums every approved overtime request and stores the kind of day (ATT-011-6a)", async () => {
    for (const [minutes, status] of [[60, "approved"], [45, "approved"], [30, "rejected"]] as const) {
      await client.query(
        `INSERT INTO attendance_overtime_requests (id, employee_id, work_date, requested_minutes, approved_minutes, status, requested_by_account_id)
         VALUES ($1, $2, '2026-08-28', $3, $4, $5, $6)`,
        [randomUUID(), mapped, minutes, status === "approved" ? minutes : null, status, accountId],
      );
    }
    await calculate({ employeeId: mapped, from: "2026-08-28", to: "2026-08-28" });
    const day = await client.query(
      `SELECT overtime_minutes, day_type, holiday_scheduled_work FROM attendance_result_versions
       WHERE employee_id = $1 AND work_date = '2026-08-28' ORDER BY version DESC LIMIT 1`,
      [mapped],
    );
    expect(day.rows[0]).toMatchObject({ overtime_minutes: 105, day_type: "working_day", holiday_scheduled_work: false });

    // A calendar holiday with no roster override: the day is a holiday, not scheduled work (§5.6).
    await client.query(
      `INSERT INTO leave_calendar_exceptions (calendar_date, is_working_day, label) VALUES ('2026-08-27', false, 'Synthetic holiday')
       ON CONFLICT (calendar_date) DO UPDATE SET is_working_day = false`,
    );
    await calculate({ employeeId: mapped, from: "2026-08-27", to: "2026-08-27" });
    const holiday = await client.query(
      `SELECT status, day_type, holiday_scheduled_work FROM attendance_result_versions
       WHERE employee_id = $1 AND work_date = '2026-08-27' ORDER BY version DESC LIMIT 1`,
      [mapped],
    );
    expect(holiday.rows[0]).toMatchObject({ status: "off", day_type: "public_holiday", holiday_scheduled_work: false });
  });

  it("returns to the earlier result when a holiday is added and removed again (latest version only)", async () => {
    const latest = async () => (await client.query(
      `SELECT version, status, day_type FROM attendance_result_versions
       WHERE employee_id = $1 AND work_date = '2026-08-27' ORDER BY version DESC LIMIT 1`, [mapped])).rows[0];
    await calculate({ employeeId: mapped, from: "2026-08-27", to: "2026-08-27" });
    const working = await latest();
    await client.query(
      `INSERT INTO leave_calendar_exceptions (calendar_date, is_working_day, label) VALUES ('2026-08-27', false, 'Synthetic holiday')
       ON CONFLICT (calendar_date) DO UPDATE SET is_working_day = false`,
    );
    await calculate({ employeeId: mapped, from: "2026-08-27", to: "2026-08-27" });
    expect(await latest()).toMatchObject({ status: "off", day_type: "public_holiday" });
    await client.query("DELETE FROM leave_calendar_exceptions WHERE calendar_date = '2026-08-27'");
    await calculate({ employeeId: mapped, from: "2026-08-27", to: "2026-08-27" });
    const back = await latest();
    expect(back).toMatchObject({ status: working.status, day_type: "working_day" });
    expect(back.version).toBeGreaterThan(working.version + 1);
    // And it is stable again afterwards.
    await calculate({ employeeId: mapped, from: "2026-08-27", to: "2026-08-27" });
    expect((await latest()).version).toBe(back.version);
  });

  it("marks a holiday that a published roster schedules as holiday work (§5.6)", async () => {
    const template = (await client.query(
      "SELECT schedule_template_id AS id FROM attendance_schedule_assignments WHERE employee_id = $1 LIMIT 1", [mapped])).rows[0].id;
    const version = (await client.query(
      "SELECT id FROM attendance_schedule_versions WHERE schedule_template_id = $1 ORDER BY version DESC LIMIT 1", [template])).rows[0].id;
    await client.query(
      `INSERT INTO leave_calendar_exceptions (calendar_date, is_working_day, label) VALUES ('2026-08-27', false, 'Synthetic holiday')
       ON CONFLICT (calendar_date) DO UPDATE SET is_working_day = false`,
    );
    const roster = randomUUID();
    await client.query(
      `INSERT INTO attendance_rosters (id, week_start, version, status, created_by_account_id, published_by_account_id, published_at)
       VALUES ($1, date_trunc('week', '2026-08-27'::date)::date, 1000, 'PUBLISHED', $2, $2, now())`,
      [roster, accountId],
    );
    await client.query(
      `INSERT INTO attendance_roster_entries (roster_id, employee_id, work_date, schedule_template_id, schedule_version_id)
       VALUES ($1, $2, '2026-08-27', $3, $4)`,
      [roster, mapped, template, version],
    );
    await calculate({ employeeId: mapped, from: "2026-08-27", to: "2026-08-27" });
    const day = await client.query(
      `SELECT day_type, holiday_scheduled_work FROM attendance_result_versions
       WHERE employee_id = $1 AND work_date = '2026-08-27' ORDER BY version DESC LIMIT 1`, [mapped]);
    expect(day.rows[0]).toMatchObject({ day_type: "public_holiday", holiday_scheduled_work: true });
  });

  it("lists overtime for HC with the kind of day and the scan time outside the schedule (ATT-011-6a §7.4)", async () => {
    await admsScan("2026-08-28T06:30:00+07:00");
    await admsScan("2026-08-28T17:15:00+07:00");
    await calculate({ employeeId: mapped, from: "2026-08-28", to: "2026-08-28" });
    const id = randomUUID();
    await client.query(
      `INSERT INTO attendance_overtime_requests (id, employee_id, work_date, requested_minutes, status, requested_by_account_id)
       VALUES ($1, $2, '2026-08-28', 60, 'rejected', $3)`,
      [id, mapped, accountId],
    );
    const page = await listOvertimeForHc(client, { page: 1, pageSize: 100, statuses: ["rejected", "cancelled"], unitId: null });
    const row = page.items.find((item: Record<string, unknown>) => item.id === id) as Record<string, unknown>;
    // Schedule 07:00–16:00: 30 minutes before plus 75 after.
    expect(row).toMatchObject({ dayType: "working_day", scanOutsideScheduleMinutes: 105, initiatedBy: "employee" });
    expect(page.total).toBeGreaterThanOrEqual(1);
  });

  it("is idempotent: calculating unchanged data again writes no new version (ATT-014-C)", async () => {
    await calculate({ employeeId: mapped, from: "2026-08-25", to: "2026-08-28" });
    const first = await client.query("SELECT count(*)::int AS total FROM attendance_result_versions WHERE employee_id = $1", [mapped]);
    await calculate({ employeeId: mapped, from: "2026-08-25", to: "2026-08-28" });
    const second = await client.query("SELECT count(*)::int AS total FROM attendance_result_versions WHERE employee_id = $1", [mapped]);
    expect(second.rows[0].total).toBe(first.rows[0].total);
  });

  it("flags a row changed after a new scan or schedule change, until it is calculated again (ATT-014-H)", async () => {
    await calculate({ employeeId: mapped, from: "2026-08-26", to: "2026-08-28" });
    let rows = await attendanceCalculationRows(transactionPool, { employeeId: mapped, from: "2026-08-26", to: "2026-08-28" });
    expect(rows.changedCount).toBe(0);

    await admsScan("2026-08-27T16:10:00+07:00", new Date(Date.now() + 3_600_000).toISOString());
    rows = await attendanceCalculationRows(transactionPool, { employeeId: mapped, from: "2026-08-26", to: "2026-08-28" });
    expect(rows.changedCount).toBe(1);
    expect(rows.items.find((item) => item.workDate === "2026-08-27")).toMatchObject({ status: "incomplete", changedSinceCalculated: true });

    const changedOnly = await attendanceCalculationRows(
      transactionPool, { employeeId: mapped, from: "2026-08-26", to: "2026-08-28" }, { changedOnly: true },
    );
    expect(changedOnly.items.map((item) => item.workDate)).toEqual(["2026-08-27"]);

    await client.query(
      `INSERT INTO attendance_schedule_assignments (id, employee_id, schedule_template_id, weekday_mask, effective_from, effective_to, created_by_account_id, created_at)
       SELECT $1::uuid, $2::uuid, schedule_template_id, 127, '2026-08-28'::date, '2026-08-28'::date, $3::uuid, now() + interval '1 hour'
       FROM attendance_schedule_assignments WHERE employee_id = $2::uuid LIMIT 1`,
      [randomUUID(), mapped, accountId],
    );
    rows = await attendanceCalculationRows(transactionPool, { employeeId: mapped, from: "2026-08-26", to: "2026-08-28" });
    expect(rows.items.filter((item) => item.changedSinceCalculated).map((item) => item.workDate)).toEqual(["2026-08-27", "2026-08-28"]);
  });

  it("lists raw machine scans in Data Transaksi before and after calculation (ATT-014 §19.1)", async () => {
    // A scan before the PIN was connected belongs to nobody and is not listed.
    await admsScan("2026-08-25T07:00:00+07:00");
    const scope = { employeeId: mapped, from: "2026-08-25", to: "2026-08-28", page: 1, pageSize: 50 };
    let rows = await attendanceTransactions(transactionPool, scope);
    expect(rows.total).toBe(3);
    expect(rows.items.map((item) => [item.workDate, item.source, item.usedInResult])).toEqual([
      ["2026-08-28", "adms", false],
      ["2026-08-28", "adms", false],
      ["2026-08-27", "adms", false],
    ]);
    expect(rows.items[0]?.deviceName).toBe("Synthetic Calculation Device");

    await calculate({ employeeId: mapped, from: "2026-08-25", to: "2026-08-28" });
    rows = await attendanceTransactions(transactionPool, scope);
    expect(rows.items.every((item) => item.usedInResult)).toBe(true);

    const paged = await attendanceTransactions(transactionPool, { ...scope, page: 2, pageSize: 2 });
    expect(paged).toMatchObject({ total: 3, totalPages: 2 });
    expect(paged.items).toHaveLength(1);
    const none = await attendanceTransactions(transactionPool, { ...scope, source: "mobile" });
    expect(none.total).toBe(0);
  });

  it("lists employee requests and HC corrections together with their origin (ATT-011-3R)", async () => {
    const employeeRequest = randomUUID();
    const hcCorrection = randomUUID();
    await client.query(
      `INSERT INTO attendance_clarifications (id, employee_id, work_date, kind, mode, reason, proposed_check_out_at, status)
       VALUES ($1, $2, '2026-08-27', 'missing_check_out', 'correction', 'Lupa scan pulang', '2026-08-27T16:00:00+07:00', 'submitted')`,
      [employeeRequest, mapped],
    );
    await client.query(
      `INSERT INTO attendance_clarification_events (id, clarification_id, actor_account_id, event_type, payload)
       VALUES ($1, $2, $3, 'submitted', '{}'::jsonb)`,
      [randomUUID(), employeeRequest, accountId],
    );
    await client.query(
      `INSERT INTO attendance_clarifications (
         id, employee_id, work_date, kind, mode, reason, proposed_check_in_at, status, decided_by_account_id, decided_at
       ) VALUES ($1, $2, '2026-08-28', 'other', 'correction', 'Mesin mati', '2026-08-28T07:00:00+07:00', 'approved', $3, now())`,
      [hcCorrection, mapped, accountId],
    );
    await client.query(
      `INSERT INTO attendance_clarification_events (id, clarification_id, actor_account_id, event_type, payload)
       VALUES ($1, $3, $4, 'submitted', '{"administrativeCorrection": true}'::jsonb),
              ($2, $3, $4, 'approved', '{"administrativeCorrection": true}'::jsonb)`,
      [randomUUID(), randomUUID(), hcCorrection, accountId],
    );
    const base = { status: "all" as const, origin: "all" as const, mode: "all" as const, q: "Calculation Mapped", page: 1, pageSize: 50 };
    const all = await listAttendanceCorrections(transactionPool, base);
    expect(all.items.map((item) => [item.id, item.origin])).toEqual([[hcCorrection, "hc"], [employeeRequest, "employee"]]);
    expect(all.submittedCount).toBeGreaterThanOrEqual(1);
    const hcOnly = await listAttendanceCorrections(transactionPool, { ...base, origin: "hc" });
    expect(hcOnly.items.map((item) => item.id)).toEqual([hcCorrection]);
    const waiting = await listAttendanceCorrections(transactionPool, { ...base, status: "submitted", from: "2026-08-27", to: "2026-08-27" });
    expect(waiting).toMatchObject({ total: 1 });
    // The approved HC correction shows up in Data Transaksi as a "Koreksi HC" punch.
    const punches = await attendanceTransactions(transactionPool, { employeeId: mapped, from: "2026-08-28", to: "2026-08-28", source: "correction", page: 1, pageSize: 50 });
    expect(punches.items.map((item) => [item.correctionBy, item.boundary])).toEqual([["hc", "check_in"]]);
  });

  it("explains empty days: Tanpa jadwal instead of Libur, and scans that cannot be attributed (ATT-014 R2a)", async () => {
    // A third employee scans through PIN CALC-2 but has no schedule pattern at all.
    const noSchedule = randomUUID();
    await client.query(
      `INSERT INTO employees (id, employee_number, full_name, status, started_on, functional_position)
       VALUES ($1, $2, 'Synthetic Calculation Unscheduled', 'active', '2026-01-01', 'Guru Sintetis (Half Day)')`,
      [noSchedule, `CALC-${noSchedule}`],
    );
    await client.query(
      `INSERT INTO attendance_adms_employee_mappings (id, device_id, pin, employee_id, effective_from)
       VALUES ($1, $2, 'CALC-2', $3, '2026-08-01T00:00:00+07:00')`,
      [randomUUID(), deviceId, noSchedule],
    );
    await admsScan("2026-08-27T07:01:00+07:00", undefined, "CALC-2");
    await admsScan("2026-08-27T12:02:00+07:00", undefined, "CALC-2");
    await admsScan("2026-08-28T12:31:00+07:00", undefined, "CALC-2");
    // A PIN nobody holds, and a CALC-1 scan before its mapping became effective (26 Aug).
    await admsScan("2026-08-27T07:10:00+07:00", undefined, "CALC-9");
    await admsScan("2026-08-24T07:05:00+07:00");

    const scope = { from: "2026-08-20", to: "2026-08-28", page: 1, pageSize: 50 };
    const employees = await unscheduledEmployees(transactionPool, { ...scope, employeeId: noSchedule });
    expect(employees.items).toEqual([expect.objectContaining({
      employeeId: noSchedule, position: "Guru Sintetis (Half Day)", days: 2,
      firstDate: "2026-08-27", lastDate: "2026-08-28", earliestLastScan: "12:02", latestLastScan: "12:31", scheduleStartsOn: null,
    })]);
    // Employees with a pattern covering the dates are not listed.
    expect((await unscheduledEmployees(transactionPool, { ...scope, employeeId: mapped })).total).toBe(0);

    const pins = await unattributedPins(transactionPool, scope);
    const byPin = new Map(pins.items.map((item) => [item.pin, item]));
    expect(byPin.get("CALC-9")).toMatchObject({ status: "unmapped", scans: 1, mappedEmployeeId: null });
    expect(byPin.get("CALC-1")).toMatchObject({ status: "before_mapping", scans: 1, mappedEmployeeId: mapped, mappedEmployeeStartedOn: "2026-01-01" });
    expect(byPin.has("CALC-2")).toBe(false);

    await calculate({ employeeId: noSchedule, from: "2026-08-27", to: "2026-08-28" });
    const rows = await attendanceCalculationRows(transactionPool, { employeeId: noSchedule, from: "2026-08-27", to: "2026-08-28" });
    expect(rows.items.map((item) => item.status)).toEqual(["unscheduled", "unscheduled"]);
  });

  it("resolves a schedule before the shift was created once its start is moved earlier (ATT-014 §20.10)", async () => {
    // A shift created "today" (version from now()) with a pattern from 1 Aug: August days have no schedule.
    const lateShift = randomUUID();
    await client.query(
      `INSERT INTO attendance_schedule_templates (id, name, start_time, end_time, created_by_account_id)
       VALUES ($1, 'Synthetic Late Shift', '07:00', '12:00', $2)`,
      [lateShift, accountId],
    );
    const versionId = randomUUID();
    await client.query(
      `INSERT INTO attendance_schedule_versions (id, schedule_template_id, version, name, start_time, end_time, end_day_offset, created_by_account_id)
       VALUES ($1, $2, 1, 'Synthetic Late Shift', '07:00', '12:00', 0, $3)`,
      [versionId, lateShift, accountId],
    );
    await client.query("UPDATE attendance_schedule_assignments SET effective_to = '2026-07-31' WHERE employee_id = $1", [mapped]);
    await client.query(
      `INSERT INTO attendance_schedule_assignments (id, employee_id, schedule_template_id, weekday_mask, effective_from, created_by_account_id)
       VALUES ($1, $2, $3, 127, '2026-08-01', $4)`,
      [randomUUID(), mapped, lateShift, accountId],
    );
    await calculate({ employeeId: mapped, from: "2026-08-28", to: "2026-08-28" });
    let rows = await attendanceCalculationRows(transactionPool, { employeeId: mapped, from: "2026-08-28", to: "2026-08-28" });
    expect(rows.items[0]?.status).toBe("unscheduled");

    // Same SQL as POST /admin/attendance/schedules/{id}/backdate, then Kalkulasi again.
    await client.query(
      "UPDATE attendance_schedule_versions SET effective_from = ('2021-07-01'::date::timestamp AT TIME ZONE 'Asia/Jakarta') WHERE id = $1",
      [versionId],
    );
    await client.query(
      `INSERT INTO access_audit_events (id, actor_account_id, action, entity_type, entity_id, payload, occurred_at)
       VALUES ($1, $2, 'attendance.schedule.backdated', 'attendance_schedule_template', $3, '{}'::jsonb, now() + interval '1 hour')`,
      [randomUUID(), accountId, lateShift],
    );
    rows = await attendanceCalculationRows(transactionPool, { employeeId: mapped, from: "2026-08-28", to: "2026-08-28" });
    // Until Kalkulasi runs again the row keeps the stored result, flagged as changed.
    expect(rows.items[0]?.changedSinceCalculated).toBe(true);

    await queueRun({ employeeId: mapped, from: "2026-08-28", to: "2026-08-28" }, new Date(Date.now() + 2 * 3_600_000).toISOString());
    const ordered = createCalculationRunner(transactionPool, { pause: async () => undefined });
    ordered.kick();
    await ordered.idle();
    const result = await client.query(
      "SELECT status FROM attendance_result_versions WHERE employee_id = $1 AND work_date = '2026-08-28' ORDER BY version DESC LIMIT 1",
      [mapped],
    );
    expect(result.rows[0].status).not.toBe("off");
  });

  it("paginates rows while the summary counts every row", async () => {
    await calculate({ employeeId: mapped, from: "2026-08-15", to: "2026-08-28" });
    const rows = await attendanceCalculationRows(
      transactionPool, { employeeId: mapped, from: "2026-08-15", to: "2026-08-28" }, { page: 2, pageSize: 10 },
    );
    expect(rows).toMatchObject({ page: 2, pageSize: 10, total: 14, totalPages: 2 });
    expect(rows.items).toHaveLength(4);
    expect(rows.summary.not_captured).toBe(11);
  });

  it("marks a run left running as INTERRUPTED and runs queued requests one at a time", async () => {
    const stuck = randomUUID();
    await client.query(
      `INSERT INTO attendance_calculation_runs (id, requested_by_account_id, date_from, date_to, status, started_at)
       VALUES ($1, $2, '2026-08-26', '2026-08-26', 'running', now())`,
      [stuck, accountId],
    );
    await expect(runner.recoverInterrupted()).resolves.toBe(1);
    const recovered = await client.query("SELECT status, error_code FROM attendance_calculation_runs WHERE id = $1", [stuck]);
    expect(recovered.rows[0]).toEqual({ status: "failed", error_code: "INTERRUPTED" });

    // now() is constant inside the test transaction, so the queue order comes from explicit created_at
    // values; the later request is inserted first to show that insertion order does not matter.
    const second = await queueRun({ employeeId: mapped, from: "2026-08-28", to: "2026-08-28" }, new Date(Date.now() - 60_000).toISOString());
    const first = await queueRun({ employeeId: mapped, from: "2026-08-26", to: "2026-08-27" }, new Date(Date.now() - 120_000).toISOString());
    const order: string[] = [];
    const ordered = createCalculationRunner(transactionPool, {
      pause: async () => undefined,
      materialize: (db, employeeId, workDate, now) => {
        order.push(workDate);
        return materializeAttendanceResult(db, employeeId, workDate, now);
      },
    });
    ordered.kick();
    await ordered.idle();
    expect(order).toEqual(["2026-08-26", "2026-08-27", "2026-08-28"]);
    const runs = await client.query(
      "SELECT id, status FROM attendance_calculation_runs WHERE id = ANY($1::uuid[]) ORDER BY created_at",
      [[first, second]],
    );
    expect(runs.rows).toEqual([{ id: first, status: "completed" }, { id: second, status: "completed" }]);
    const audit = await client.query(
      "SELECT action FROM access_audit_events WHERE entity_id = ANY($1::uuid[]) ORDER BY action",
      [[stuck, first, second]],
    );
    expect(audit.rows.map((row) => row.action)).toEqual([
      "attendance.calculation.completed", "attendance.calculation.completed", "attendance.calculation.failed",
    ]);
  });
});
