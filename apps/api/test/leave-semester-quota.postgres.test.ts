// LEAVE-003 R2 against a real schema: the Cuti Tahunan usage limit moves from 3 working days per
// three-month period to 6 per calendar semester, by leave date, and the requests the old rule wrote
// keep counting — once each — without being rewritten.
//
// Two apps run on the same transaction: `legacyApp` is the release in production today (no
// effective date, so the three-month rule governs every date) and `app` is the same code with the
// date set. That is what makes "an old record is still read correctly" a demonstration rather than
// a claim: the old row is written by the old configuration, through the ordinary submit route.
//
// Synthetic employees only; every test runs inside one rolled-back transaction.

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import { AuthService } from "../src/modules/auth/service.js";
import { encodeWorkingWeekdays } from "../src/modules/leave/domain/working-calendar.js";
import { registerEmployeeLeaveRoutes } from "../src/modules/leave/employee-routes.js";

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

type Person = "requester" | "manager" | "unitApprover";

// Monday 5 January 2099, 08:00 Jakarta. Every date below is a Monday-to-Friday working day and at
// least H-7 away. 2099 is not a leap year.
const NOW = new Date("2099-01-05T01:00:00Z");
const SEMESTER_FROM = "2099-01-01";

describe.skipIf(!allowed)("LEAVE-003 R2 semester quota on a real schema", () => {
  let pool: Pool;
  let client: PoolClient;
  /** The semester rule is in force for every date. */
  let app: ReturnType<typeof Fastify>;
  /** The rule production runs today: three-month periods, no effective date at all. */
  let legacyApp: ReturnType<typeof Fastify>;
  /** An effective date inside a semester, where the two rules meet in one half year. */
  let midSemesterApp: ReturnType<typeof Fastify>;
  let unitId: string;
  const people = {} as Record<Person, { employeeId: string; accountId: string; cookie: string }>;

  function call(
    instance: ReturnType<typeof Fastify>,
    method: "GET" | "POST",
    url: string,
    payload?: object,
  ) {
    return instance.inject({
      method,
      url,
      headers: { cookie: people.requester.cookie },
      ...(payload ? { payload } : {}),
    });
  }

  async function submit(
    instance: ReturnType<typeof Fastify>,
    startOn: string,
    endOn: string,
  ) {
    return call(instance, "POST", "/leave/me/annual/submit", {
      startOn,
      endOn,
      reason: "Keperluan keluarga",
      idempotencyKey: randomUUID(),
    });
  }

  async function storedRequest(id: string) {
    const rows = await client.query<{
      periodKey: string | null;
      limitDays: number | null;
      workingDays: number;
      status: string;
    }>(
      `SELECT annual_period_key AS "periodKey", annual_period_limit_days AS "limitDays",
              working_days AS "workingDays", status
         FROM leave_requests WHERE id = $1`,
      [id],
    );
    return rows.rows[0]!;
  }

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl!, max: 1 });
  });
  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    vi.setSystemTime(NOW);
    client = await pool.connect();
    await client.query("BEGIN");
    const transactionPool = savepointPool(client);
    unitId = randomUUID();
    await client.query(
      "INSERT INTO organizational_units(id, normalized_name, name) VALUES ($1, $2, 'Unit Kuota Sintetis')",
      [unitId, `leave003r2-${unitId}`],
    );
    await client.query(
      `INSERT INTO leave_calendar_settings(singleton, timezone, working_weekday_mask)
       VALUES (true, 'Asia/Jakarta', $1)
       ON CONFLICT (singleton) DO UPDATE SET working_weekday_mask = EXCLUDED.working_weekday_mask`,
      [encodeWorkingWeekdays([1, 2, 3, 4, 5])],
    );
    await client.query(
      "DELETE FROM leave_calendar_exceptions WHERE calendar_date BETWEEN '2099-01-01' AND '2099-12-31'",
    );
    // LEGACY authority resolution is what production runs today.
    await client.query("DELETE FROM organization_rollout_settings");
    await client.query(
      "UPDATE leave_critical_periods SET is_active = false WHERE starts_on <= '2099-12-31' AND ends_on >= '2099-01-01'",
    );

    const baseConfig = {
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: 3001,
      DATABASE_URL: databaseUrl!,
      AUTH_MODE: "local",
      AUTH_ENCRYPTION_KEY: "11".repeat(32),
      AUTH_SESSION_TTL_HOURS: 8,
    } as ApiConfig;
    const auth = new AuthService(transactionPool, baseConfig.AUTH_ENCRYPTION_KEY!, 8, false);
    for (const who of ["manager", "unitApprover", "requester"] as const) {
      const employeeId = randomUUID();
      await client.query(
        `INSERT INTO employees(id, employee_number, full_name, status, started_on, organizational_unit_id,
                               leave_entitlement_group)
         VALUES ($1, $2, $3, 'active', '2020-01-06', $4, 'non_education')`,
        [employeeId, `L003R2-${employeeId.slice(0, 8)}`, `Pegawai ${who}`, unitId],
      );
      const accountId = randomUUID();
      await client.query(
        "INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1, $2, $3, 'EMPLOYEE', 'active')",
        [accountId, employeeId, `leave003r2-${accountId}@example.invalid`],
      );
      const session = await auth.createSessionForAccountId(accountId, {
        ipAddress: "127.0.0.1",
        userAgent: "rollback-only-leave003r2-test",
      });
      people[who] = { employeeId, accountId, cookie: session.setCookie.split(";")[0]! };
    }
    await client.query(
      "UPDATE organizational_units SET leave_approver_employee_id = $2 WHERE id = $1",
      [unitId, people.unitApprover.employeeId],
    );
    await client.query(
      "UPDATE employees SET direct_manager_employee_id = $2 WHERE id = $1",
      [people.requester.employeeId, people.manager.employeeId],
    );

    app = Fastify({ logger: false });
    await registerEmployeeLeaveRoutes(app, transactionPool, {
      ...baseConfig,
      ANNUAL_LEAVE_SEMESTER_QUOTA_EFFECTIVE_FROM: SEMESTER_FROM,
    });
    legacyApp = Fastify({ logger: false });
    await registerEmployeeLeaveRoutes(legacyApp, transactionPool, baseConfig);
    midSemesterApp = Fastify({ logger: false });
    await registerEmployeeLeaveRoutes(midSemesterApp, transactionPool, {
      ...baseConfig,
      ANNUAL_LEAVE_SEMESTER_QUOTA_EFFECTIVE_FROM: "2099-04-01",
    });
  });

  afterEach(async () => {
    try {
      await app?.close();
      await legacyApp?.close();
      await midSemesterApp?.close();
    } finally {
      if (client) {
        await client.query("ROLLBACK");
        client.release();
      }
      vi.useRealTimers();
    }
  });

  it("stores six working days against the semester and refuses the seventh", async () => {
    // Monday 2 February to Monday 9 February 2099: six working days inside one semester.
    const accepted = await submit(app, "2099-02-02", "2099-02-09");
    expect(accepted.statusCode, accepted.body).toBe(201);
    const body = accepted.json() as { id: string; quotaScheme: string; periodKey: string };
    expect(body.quotaScheme).toBe("SEMESTER");
    expect(body.periodKey).toBe("JAN_JUN");

    const stored = await storedRequest(body.id);
    expect(stored).toMatchObject({ periodKey: "JAN_JUN", limitDays: 6, workingDays: 6 });

    // One more working day in the same semester no longer fits.
    const refused = await submit(app, "2099-05-04", "2099-05-04");
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("PERIOD_LIMIT_EXCEEDED");
  });

  it("refuses seven working days outright", async () => {
    // Monday 2 February to Tuesday 10 February 2099: seven working days.
    const response = await submit(app, "2099-02-02", "2099-02-10");
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("PERIOD_LIMIT_EXCEEDED");
    expect(response.json().message).toContain("Januari-Juni");
  });

  it("counts a request the old rule recorded, once, against the new semester", async () => {
    // Written by the configuration production runs today: a JAN_MAR row with a 3-day limit.
    const legacy = await submit(legacyApp, "2099-02-02", "2099-02-04");
    expect(legacy.statusCode, legacy.body).toBe(201);
    const legacyBody = legacy.json() as { id: string; quotaScheme: string; periodKey: string };
    expect(legacyBody.quotaScheme).toBe("QUARTER");
    expect(await storedRequest(legacyBody.id)).toMatchObject({
      periodKey: "JAN_MAR",
      limitDays: 3,
      workingDays: 3,
    });

    // Read under the semester rule, those 3 days belong to Januari-Juni and leave 3 of the 6.
    const preview = await call(app, "POST", "/leave/me/annual/preview", {
      startOn: "2099-05-04",
      endOn: "2099-05-06",
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({
      quotaScheme: "SEMESTER",
      periodKey: "JAN_JUN",
      periodLimitDays: 6,
      availableDaysBeforeRequest: 3,
      availableDaysAfterRequest: 0,
    });

    // A fourth day in that semester is refused: the old row is not counted twice, and not ignored.
    const tooMany = await submit(app, "2099-05-04", "2099-05-07");
    expect(tooMany.statusCode).toBe(409);
    expect(tooMany.json().code).toBe("PERIOD_LIMIT_EXCEEDED");

    const fits = await submit(app, "2099-05-04", "2099-05-06");
    expect(fits.statusCode, fits.body).toBe(201);

    // The old row kept its own key and its own limit; nothing rewrote it.
    expect(await storedRequest(legacyBody.id)).toMatchObject({
      periodKey: "JAN_MAR",
      limitDays: 3,
    });
  });

  it("reserves quota while a request waits for a decision and releases it on cancellation", async () => {
    const pending = await submit(app, "2099-02-02", "2099-02-09");
    expect(pending.statusCode, pending.body).toBe(201);
    const pendingId = (pending.json() as { id: string }).id;
    expect((await storedRequest(pendingId)).status).toBe("in_review");

    const blocked = await submit(app, "2099-05-04", "2099-05-04");
    expect(blocked.statusCode).toBe(409);

    const cancelled = await call(app, "POST", `/leave/me/requests/${pendingId}/cancel`, {
      reason: "Rencana berubah",
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect((await storedRequest(pendingId)).status).toBe("cancelled");

    const afterCancel = await submit(app, "2099-05-04", "2099-05-11");
    expect(afterCancel.statusCode, afterCancel.body).toBe(201);
    expect((await storedRequest((afterCancel.json() as { id: string }).id)).workingDays).toBe(6);
  });

  it("accepts one request across the old three-month boundary inside one semester", async () => {
    // Monday 30 March to Thursday 2 April 2099: four working days across Jan-Mar and Apr-Jun.
    const response = await submit(app, "2099-03-30", "2099-04-02");
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({ periodKey: "JAN_JUN", workingDays: 4 });
  });

  it("refuses one request across 30 June and 1 July", async () => {
    const response = await submit(app, "2099-06-29", "2099-07-02");
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("CROSS_PERIOD_REQUEST_UNSUPPORTED");
    expect(response.json().message).toContain("30 Juni-1 Juli");
  });

  it("holds the semester to six days when the effective date falls inside it", async () => {
    // Effective 1 April 2099. Booked first, for May, under the semester rule: all six days.
    const may = await submit(midSemesterApp, "2099-05-04", "2099-05-11");
    expect(may.statusCode, may.body).toBe(201);
    expect(may.json()).toMatchObject({ quotaScheme: "SEMESTER", periodKey: "JAN_JUN", workingDays: 6 });

    // Booked second, for March, under the three-month rule. Its own quarter is empty, but the
    // half year is spent — without the semester cap this would add 3 more days, 9 in one semester.
    const march = await submit(midSemesterApp, "2099-03-23", "2099-03-25");
    expect(march.statusCode).toBe(409);
    expect(march.json().code).toBe("PERIOD_LIMIT_EXCEEDED");

    const summary = await call(midSemesterApp, "GET", "/leave/me/summary");
    expect(summary.json().annualLeave).toMatchObject({
      quotaScheme: "QUARTER",
      currentPeriodKey: "JAN_MAR",
      availableNowDays: 0,
    });
  });

  it("counts a December request against Juli-Desember", async () => {
    const october = await submit(app, "2099-10-05", "2099-10-07");
    expect(october.statusCode, october.body).toBe(201);
    expect(october.json()).toMatchObject({ periodKey: "JUL_DEC", workingDays: 3 });

    // December is the last month of the period: its usage must land in the same bucket.
    const december = await call(app, "POST", "/leave/me/annual/preview", {
      startOn: "2099-12-07",
      endOn: "2099-12-09",
    });
    expect(december.statusCode, december.body).toBe(200);
    expect(december.json()).toMatchObject({
      periodKey: "JUL_DEC",
      periodLimitDays: 6,
      availableDaysBeforeRequest: 3,
      availableDaysAfterRequest: 0,
    });

    const tooMany = await submit(app, "2099-12-07", "2099-12-10");
    expect(tooMany.statusCode).toBe(409);
    expect(tooMany.json().code).toBe("PERIOD_LIMIT_EXCEEDED");
  });

  it("shows the employee two six-day semesters instead of four three-day periods", async () => {
    const legacySummary = await call(legacyApp, "GET", "/leave/me/summary");
    expect(legacySummary.statusCode, legacySummary.body).toBe(200);
    expect(legacySummary.json().annualLeave).toMatchObject({
      quotaScheme: "QUARTER",
      semesterEffectiveFrom: null,
      currentPeriodKey: "JAN_MAR",
      currentPeriodLimitDays: 3,
    });
    expect(
      (legacySummary.json().annualLeave.periods as Array<{ key: string }>).map((p) => p.key),
    ).toEqual(["JAN_MAR", "APR_JUN", "JUL_SEP", "OCT_DEC"]);

    const summary = await call(app, "GET", "/leave/me/summary");
    expect(summary.statusCode, summary.body).toBe(200);
    expect(summary.json().annualLeave).toMatchObject({
      quotaScheme: "SEMESTER",
      semesterEffectiveFrom: SEMESTER_FROM,
      currentPeriodKey: "JAN_JUN",
      currentPeriodLimitDays: 6,
      availableNowDays: 6,
      annualEntitlementDays: 12,
    });
    expect(
      (summary.json().annualLeave.periods as Array<{ key: string; allocationDays: number }>).map(
        (period) => [period.key, period.allocationDays],
      ),
    ).toEqual([
      ["JAN_JUN", 6],
      ["JUL_DEC", 6],
    ]);
  });
});
