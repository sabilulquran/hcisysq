// PAY-003 attendance-derived period inputs against real PostgreSQL: approved
// overtime and the days that earn PKWT transport, both read from the cutoff
// window. Runs only against the loopback CI database.

import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAttendanceInputs, resolveAttendanceInputs } from "../src/modules/payroll/attendance-inputs.js";
import { listInputs } from "../src/modules/payroll/inputs-store.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

const CUTOFF_START = "2026-08-23";
const CUTOFF_END = "2026-09-22";

describe.skipIf(!allowed)("PAY-003 attendance inputs against PostgreSQL", () => {
  let pool: Pool;
  let periodId: string;
  let legalEntityKey: string;
  let actorAccountId: string;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl!, max: 2 });
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function newEmployment(category: string): Promise<{ employmentId: string; employeeId: string }> {
    const employeeId = randomUUID();
    const employmentId = randomUUID();
    const actionId = randomUUID();
    const client = await pool.connect();
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO employees(id, employee_number, full_name, status) VALUES ($1, $2, 'Synthetic Attendance', 'active')",
      [employeeId, `EMP-ATT-${employeeId}`],
    );
    await client.query(
      `INSERT INTO employments(id, employee_id, legal_entity_key, started_on, start_basis, source, opened_by_action_id)
       VALUES ($1, $2, $3, DATE '2016-07-01', 'RECORDED', 'ACTION', $4)`,
      [employmentId, employeeId, legalEntityKey, actionId],
    );
    await client.query(
      `INSERT INTO employment_actions(id, employee_id, employment_id, action_type, effective_on)
       VALUES ($1, $2, $3, 'BASELINE', DATE '2016-07-01')`,
      [actionId, employeeId, employmentId],
    );
    await client.query(
      `INSERT INTO employment_terms(id, employment_id, sequence, category, effective_from, opened_by_action_id)
       VALUES ($1, $2, 1, $3, DATE '2016-07-01', $4)`,
      [randomUUID(), employmentId, category, actionId],
    );
    await client.query("COMMIT");
    client.release();
    return { employmentId, employeeId };
  }

  async function approvedOvertime(employeeId: string, workDate: string, minutes: number) {
    await pool.query(
      `INSERT INTO attendance_overtime_requests(
         id, employee_id, work_date, requested_minutes, approved_minutes, status,
         requested_by_account_id, decided_by_account_id, decided_at)
       VALUES ($1, $2, $3::date, $4, $4, 'approved', $5, $5, now())`,
      [randomUUID(), employeeId, workDate, minutes, actorAccountId],
    );
  }

  async function pendingOvertime(employeeId: string, workDate: string, minutes: number) {
    await pool.query(
      `INSERT INTO attendance_overtime_requests(
         id, employee_id, work_date, requested_minutes, status, requested_by_account_id)
       VALUES ($1, $2, $3::date, $4, 'submitted', $5)`,
      [randomUUID(), employeeId, workDate, minutes, actorAccountId],
    );
  }

  async function attendanceDay(employeeId: string, workDate: string, checkedIn: boolean, version = 1) {
    await pool.query(
      `INSERT INTO attendance_result_versions(
         id, employee_id, work_date, version, status, first_check_in_at, input_hash)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7)`,
      [
        randomUUID(),
        employeeId,
        workDate,
        version,
        checkedIn ? "present" : "absent",
        checkedIn ? `${workDate}T01:00:00.000Z` : null,
        randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
      ],
    );
  }

  beforeEach(async () => {
    legalEntityKey = randomUUID();
    periodId = randomUUID();
    await pool.query(
      `INSERT INTO payroll_periods(
         id, legal_entity_key, period_month, pay_date, period_start, period_end, cutoff_start, cutoff_end, state)
       VALUES ($1, $2, DATE '2026-09-01', DATE '2026-09-25', DATE '2026-09-01', DATE '2026-09-30',
               $3::date, $4::date, 'COLLECTING')`,
      [periodId, legalEntityKey, CUTOFF_START, CUTOFF_END],
    );

    const { rows } = await pool.query<{ id: string }>("SELECT id FROM accounts LIMIT 1");
    if (rows[0]) {
      actorAccountId = rows[0].id;
    } else {
      const employeeId = randomUUID();
      actorAccountId = randomUUID();
      await pool.query(
        "INSERT INTO employees(id, employee_number, full_name, status) VALUES ($1, $2, 'Synthetic Actor', 'active')",
        [employeeId, `EMP-ATT-ACTOR-${employeeId}`],
      );
      await pool.query(
        `INSERT INTO accounts(id, employee_id, email, principal_type, status)
         VALUES ($1, $2, $3, 'EMPLOYEE', 'active')`,
        [actorAccountId, employeeId, `att-${actorAccountId}@example.invalid`],
      );
    }
  });

  const window = () => ({ periodId, cutoffStart: CUTOFF_START, cutoffEnd: CUTOFF_END, legalEntityKey });

  it("sums approved overtime inside the cutoff window and converts it to hours", async () => {
    const { employmentId, employeeId } = await newEmployment("TETAP");
    await approvedOvertime(employeeId, "2026-08-25", 90);
    await approvedOvertime(employeeId, "2026-09-10", 150);

    const resolved = await resolveAttendanceInputs(pool, window());
    expect(resolved.overtime).toEqual([{ employmentId, hours: 4 }]);
  });

  it("ignores overtime that was never approved", async () => {
    const { employeeId } = await newEmployment("TETAP");
    await pendingOvertime(employeeId, "2026-09-10", 120);
    const resolved = await resolveAttendanceInputs(pool, window());
    expect(resolved.overtime).toEqual([]);
  });

  it("ignores overtime worked outside the cutoff window", async () => {
    const { employeeId } = await newEmployment("TETAP");
    await approvedOvertime(employeeId, "2026-08-22", 60);
    await approvedOvertime(employeeId, "2026-09-23", 60);
    const resolved = await resolveAttendanceInputs(pool, window());
    expect(resolved.overtime).toEqual([]);
  });

  it("keeps a part hour rather than rounding it away", async () => {
    const { employmentId, employeeId } = await newEmployment("TETAP");
    await approvedOvertime(employeeId, "2026-09-10", 45);
    const resolved = await resolveAttendanceInputs(pool, window());
    expect(resolved.overtime).toEqual([{ employmentId, hours: 0.75 }]);
  });

  it("counts a contract worker's days with a recorded check-in", async () => {
    const { employmentId, employeeId } = await newEmployment("KONTRAK_HONORER");
    await attendanceDay(employeeId, "2026-08-25", true);
    await attendanceDay(employeeId, "2026-09-01", true);
    await attendanceDay(employeeId, "2026-09-02", false);

    const resolved = await resolveAttendanceInputs(pool, window());
    expect(resolved.attendanceDays).toEqual([{ employmentId, days: 2 }]);
  });

  it("counts one day once, however many versions it has", async () => {
    const { employmentId, employeeId } = await newEmployment("LEPAS");
    await attendanceDay(employeeId, "2026-09-01", false, 1);
    await attendanceDay(employeeId, "2026-09-01", true, 2);
    const resolved = await resolveAttendanceInputs(pool, window());
    expect(resolved.attendanceDays).toEqual([{ employmentId, days: 1 }]);
  });

  it("reads the latest version of a day, not the first", async () => {
    const { employeeId } = await newEmployment("KONTRAK");
    await attendanceDay(employeeId, "2026-09-01", true, 1);
    await attendanceDay(employeeId, "2026-09-01", false, 2);
    const resolved = await resolveAttendanceInputs(pool, window());
    expect(resolved.attendanceDays).toEqual([]);
  });

  it("gives a permanent employee no transport days", async () => {
    const { employeeId } = await newEmployment("TETAP");
    await attendanceDay(employeeId, "2026-09-01", true);
    const resolved = await resolveAttendanceInputs(pool, window());
    expect(resolved.attendanceDays).toEqual([]);
  });

  it("stores what it resolved as ordinary period inputs marked ATTENDANCE", async () => {
    const { employmentId, employeeId } = await newEmployment("KONTRAK_HONORER");
    await approvedOvertime(employeeId, "2026-09-10", 120);
    await attendanceDay(employeeId, "2026-09-01", true);

    const counts = await applyAttendanceInputs(pool, window(), actorAccountId);
    expect(counts).toEqual({ overtimeCount: 1, attendanceCount: 1 });

    const inputs = await listInputs(pool, periodId);
    expect(inputs).toEqual([
      expect.objectContaining({ employmentId, inputKey: "CONTRACT_ATTENDANCE_DAYS", origin: "ATTENDANCE" }),
      expect.objectContaining({ employmentId, inputKey: "OVERTIME_HOURS", origin: "ATTENDANCE" }),
    ]);
  });

  it("replaces what an earlier resolve stored rather than adding to it", async () => {
    const { employeeId } = await newEmployment("TETAP");
    await approvedOvertime(employeeId, "2026-09-10", 60);
    await applyAttendanceInputs(pool, window(), actorAccountId);
    await approvedOvertime(employeeId, "2026-09-11", 60);
    await applyAttendanceInputs(pool, window(), actorAccountId);

    const inputs = await listInputs(pool, periodId);
    expect(inputs).toHaveLength(1);
    expect(Number(inputs[0]!.value)).toBe(2);
  });

  it("leaves another legal entity's attendance alone", async () => {
    const { employeeId } = await newEmployment("TETAP");
    await approvedOvertime(employeeId, "2026-09-10", 60);
    const resolved = await resolveAttendanceInputs(pool, { ...window(), legalEntityKey: randomUUID() });
    expect(resolved.overtime).toEqual([]);
  });
});
