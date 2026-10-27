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

  async function newEmployment(
    category: string,
    options: {
      employeeId?: string;
      endBasis?: "RECORDED" | "UNKNOWN";
      endedOn?: string | null;
      startedOn?: string;
    } = {},
  ): Promise<{ employmentId: string; employeeId: string }> {
    const employeeId = options.employeeId ?? randomUUID();
    const employmentId = randomUUID();
    const actionId = randomUUID();
    const client = await pool.connect();
    await client.query("BEGIN");
    if (!options.employeeId) {
      await client.query(
        "INSERT INTO employees(id, employee_number, full_name, status) VALUES ($1, $2, 'Synthetic Attendance', 'active')",
        [employeeId, `EMP-ATT-${employeeId}`],
      );
    }
    await client.query(
      `INSERT INTO employments(
         id, employee_id, legal_entity_key, started_on, start_basis, ended_on, end_basis,
         end_precision, end_reason, source, opened_by_action_id)
       VALUES ($1, $2, $3, $9::date, 'RECORDED', $5::date, $6, $7, $8, 'ACTION', $4)`,
      [
        employmentId,
        employeeId,
        legalEntityKey,
        actionId,
        options.endedOn ?? null,
        options.endBasis ?? null,
        options.endBasis === "RECORDED" ? "DAY" : null,
        options.endBasis ? "RESIGN" : null,
        options.startedOn ?? "2016-07-01",
      ],
    );
    await client.query(
      `INSERT INTO employment_actions(id, employee_id, employment_id, action_type, effective_on)
       VALUES ($1, $2, $3, 'BASELINE', $4::date)`,
      [actionId, employeeId, employmentId, options.startedOn ?? "2016-07-01"],
    );
    await client.query(
      `INSERT INTO employment_terms(id, employment_id, sequence, category, effective_from, opened_by_action_id)
       VALUES ($1, $2, 1, $3, $5::date, $4)`,
      [randomUUID(), employmentId, category, actionId, options.startedOn ?? "2016-07-01"],
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

  async function attendanceDay(
    employeeId: string,
    workDate: string,
    checkedIn: boolean,
    options: { version?: number; dayType?: string | null; holidayScheduledWork?: boolean | null } = {},
  ) {
    await pool.query(
      `INSERT INTO attendance_result_versions(
         id, employee_id, work_date, version, status, first_check_in_at, input_hash,
         day_type, holiday_scheduled_work)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9)`,
      [
        randomUUID(),
        employeeId,
        workDate,
        options.version ?? 1,
        checkedIn ? "present" : "absent",
        checkedIn ? `${workDate}T01:00:00.000Z` : null,
        randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
        options.dayType === undefined ? "working_day" : options.dayType,
        options.holidayScheduledWork ?? null,
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

  it("keeps four decimals, as the column does, rather than inventing a rupiah", async () => {
    const { employmentId, employeeId } = await newEmployment("TETAP");
    await approvedOvertime(employeeId, "2026-09-10", 10);
    const resolved = await resolveAttendanceInputs(pool, window());
    expect(resolved.overtime).toEqual([{ employmentId, hours: 0.1667 }]);
  });

  it("gives a contract worker no overtime, who is paid per attendance instead", async () => {
    const { employeeId } = await newEmployment("KONTRAK_HONORER");
    await approvedOvertime(employeeId, "2026-09-10", 120);
    const resolved = await resolveAttendanceInputs(pool, window());
    expect(resolved.overtime).toEqual([]);
  });

  it("leaves out an employment whose end date nobody has resolved", async () => {
    const { employeeId } = await newEmployment("TETAP", { endBasis: "UNKNOWN", endedOn: null });
    await approvedOvertime(employeeId, "2026-09-10", 120);
    const resolved = await resolveAttendanceInputs(pool, window());
    expect(resolved.overtime).toEqual([]);
  });

  it("credits a rehired employee's day to one employment only", async () => {
    const first = await newEmployment("TETAP", { endBasis: "RECORDED", endedOn: "2026-08-31" });
    const second = await newEmployment("TETAP", { employeeId: first.employeeId, startedOn: "2026-09-01" });
    await approvedOvertime(first.employeeId, "2026-09-10", 120);
    const resolved = await resolveAttendanceInputs(pool, window());
    expect(resolved.overtime).toEqual([{ employmentId: second.employmentId, hours: 2 }]);
  });

  it("earns no transport on a rest day or a public holiday", async () => {
    const { employeeId } = await newEmployment("KONTRAK_HONORER");
    await attendanceDay(employeeId, "2026-09-01", true, { dayType: "rest_day" });
    await attendanceDay(employeeId, "2026-09-02", true, { dayType: "public_holiday" });
    const resolved = await resolveAttendanceInputs(pool, window());
    expect(resolved.attendanceDays).toEqual([]);
  });

  it("earns transport on a holiday the employee was scheduled to work", async () => {
    const { employmentId, employeeId } = await newEmployment("KONTRAK_HONORER");
    await attendanceDay(employeeId, "2026-09-01", true, {
      dayType: "public_holiday",
      holidayScheduledWork: true,
    });
    const resolved = await resolveAttendanceInputs(pool, window());
    expect(resolved.attendanceDays).toEqual([{ employmentId, days: 1 }]);
  });

  it("treats a day recorded before the day type existed as a working day", async () => {
    const { employmentId, employeeId } = await newEmployment("LEPAS");
    await attendanceDay(employeeId, "2026-09-01", true, { dayType: null });
    const resolved = await resolveAttendanceInputs(pool, window());
    expect(resolved.attendanceDays).toEqual([{ employmentId, days: 1 }]);
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
    await attendanceDay(employeeId, "2026-09-01", false, { version: 1 });
    await attendanceDay(employeeId, "2026-09-01", true, { version: 2 });
    const resolved = await resolveAttendanceInputs(pool, window());
    expect(resolved.attendanceDays).toEqual([{ employmentId, days: 1 }]);
  });

  it("reads the latest version of a day, not the first", async () => {
    const { employeeId } = await newEmployment("KONTRAK");
    await attendanceDay(employeeId, "2026-09-01", true, { version: 1 });
    await attendanceDay(employeeId, "2026-09-01", false, { version: 2 });
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
    expect(counts).toEqual({ overtimeCount: 1, attendanceCount: 1, clearedCount: 0, skippedOwnCount: 0 });

    const inputs = await listInputs(pool, periodId);
    expect(inputs).toEqual([
      expect.objectContaining({ employmentId, inputKey: "CONTRACT_ATTENDANCE_DAYS", origin: "ATTENDANCE" }),
      expect.objectContaining({ employmentId, inputKey: "OVERTIME_HOURS", origin: "ATTENDANCE" }),
    ]);
  });

  it("removes what it wrote before when attendance no longer supports it", async () => {
    const { employeeId } = await newEmployment("TETAP");
    await approvedOvertime(employeeId, "2026-09-10", 120);
    await applyAttendanceInputs(pool, window(), actorAccountId);
    expect(await listInputs(pool, periodId)).toHaveLength(1);

    await pool.query("UPDATE attendance_overtime_requests SET status = 'cancelled' WHERE employee_id = $1", [
      employeeId,
    ]);
    const outcome = await applyAttendanceInputs(pool, window(), actorAccountId);
    expect(outcome.clearedCount).toBe(1);
    expect(await listInputs(pool, periodId)).toEqual([]);
  });

  it("leaves a manual input of another key alone", async () => {
    const { employmentId, employeeId } = await newEmployment("TETAP");
    await approvedOvertime(employeeId, "2026-09-10", 60);
    await pool.query(
      `INSERT INTO payroll_period_inputs(id, period_id, employment_id, input_key, value, origin, reason)
       VALUES ($1, $2, $3, 'ARREARS', 250000, 'MANUAL', 'rapel kenaikan')`,
      [randomUUID(), periodId, employmentId],
    );
    await applyAttendanceInputs(pool, window(), actorAccountId);
    const inputs = await listInputs(pool, periodId);
    expect(inputs.map((input) => input.inputKey).sort()).toEqual(["ARREARS", "OVERTIME_HOURS"]);
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
