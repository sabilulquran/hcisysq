import Fastify from "fastify";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AdminPermission } from "../src/modules/auth/permissions.js";
import { normalActual, provisionalStatus } from "../src/modules/attendance/calculation-rows.js";
import {
  createCalculationRunner,
  daysInclusive,
  validateCalculationRange,
  type CalculationRunner,
} from "../src/modules/attendance/calculation-runner.js";

// ATT-014-2 Kalkulasi. Synthetic identifiers only; the PostgreSQL behaviour (coverage, idempotency,
// invariants, freshness) is covered by attendance-calculation.postgres.test.ts.

const NOW = new Date("2026-10-26T10:00:00+07:00");

describe("ATT-014-2 calculation range (D-14-2)", () => {
  it("accepts up to 93 days ending today", () => {
    expect(daysInclusive("2026-07-26", "2026-10-26")).toBe(93);
    expect(validateCalculationRange("2026-07-26", "2026-10-26", NOW)).toBeNull();
    expect(validateCalculationRange("2026-10-26", "2026-10-26", NOW)).toBeNull();
  });

  it("rejects 94 days, a reversed range, an impossible date and a future date", () => {
    expect(validateCalculationRange("2026-07-25", "2026-10-26", NOW)).toBe("CALCULATION_RANGE_TOO_LARGE");
    expect(validateCalculationRange("2026-10-20", "2026-10-19", NOW)).toBe("INVALID_CALCULATION_RANGE");
    expect(validateCalculationRange("2026-13-01", "2026-13-02", NOW)).toBe("INVALID_CALCULATION_RANGE");
    expect(validateCalculationRange("2026-10-26", "2026-10-27", NOW)).toBe("CALCULATION_DATE_IN_FUTURE");
  });

  it("uses the Jakarta date for today", () => {
    // 2026-10-26 23:30 UTC is already 2026-10-27 in Jakarta.
    expect(validateCalculationRange("2026-10-27", "2026-10-27", new Date("2026-10-26T23:30:00Z"))).toBeNull();
  });
});

describe("ATT-014-2 provisional today (D-14-4)", () => {
  const base = {
    scheduledStartAt: new Date("2026-10-26T07:00:00+07:00"),
    scheduledEndAt: new Date("2026-10-26T16:00:00+07:00"),
    firstCheckInAt: null,
    hasDisposition: false,
  };

  it("re-evaluates a morning result by the clock so it does not freeze as scheduled", () => {
    expect(provisionalStatus({ ...base, status: "scheduled" }, new Date("2026-10-26T06:00:00+07:00"))).toBe("scheduled");
    expect(provisionalStatus({ ...base, status: "scheduled" }, new Date("2026-10-26T09:00:00+07:00"))).toBe("pending");
    expect(provisionalStatus({ ...base, status: "scheduled" }, new Date("2026-10-26T17:00:00+07:00"))).toBe("absent");
  });

  it("never re-evaluates a day with a check-in or a final leave disposition", () => {
    const later = new Date("2026-10-26T17:00:00+07:00");
    expect(provisionalStatus({ ...base, status: "incomplete", firstCheckInAt: new Date("2026-10-26T07:02:00+07:00") }, later)).toBe("incomplete");
    expect(provisionalStatus({ ...base, status: "pending", firstCheckInAt: new Date("2026-10-26T07:02:00+07:00") }, later)).toBe("pending");
    expect(provisionalStatus({ ...base, status: "absent", hasDisposition: true }, new Date("2026-10-26T09:00:00+07:00"))).toBe("absent");
    expect(provisionalStatus({ ...base, status: "leave" }, later)).toBe("leave");
  });

  it("derives Normal/Riil from the status", () => {
    expect(normalActual("present")).toEqual({ normal: 1, actual: 1 });
    expect(normalActual("late")).toEqual({ normal: 1, actual: 1 });
    expect(normalActual("absent")).toEqual({ normal: 1, actual: 0 });
    expect(normalActual("incomplete")).toEqual({ normal: 1, actual: null });
    expect(normalActual("not_captured")).toEqual({ normal: null, actual: null });
    expect(normalActual("off")).toEqual({ normal: null, actual: null });
  });
});

// Runner with a pool that answers by SQL shape.
const ACCOUNT = "00000000-0000-4000-8000-000000014301";
const RUN_ID = "00000000-0000-4000-8000-000000014302";
const EMPLOYEE_A = "00000000-0000-4000-8000-000000014303";
const EMPLOYEE_B = "00000000-0000-4000-8000-000000014304";

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID, requestedByAccountId: ACCOUNT, unitId: null, employeeId: null,
    dateFrom: "2026-10-01", dateTo: "2026-10-02", status: "running",
    totalPairs: 0, processedPairs: 0, failedPairs: 0, uncoveredPairs: 0,
    cancelRequestedAt: null, errorCode: null,
    createdAt: new Date("2026-10-26T02:00:00Z"), startedAt: new Date("2026-10-26T02:00:01Z"), finishedAt: null,
    ...overrides,
  };
}

function runnerPool(options: { pairs: Array<{ employeeId: string; workDate: string; covered: boolean }>; cancelAt?: number; claims?: number }) {
  let claims = options.claims ?? 1;
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    if (sql.includes("SET status = 'running'")) {
      if (claims <= 0) return { rows: [] };
      claims -= 1;
      return { rows: [runRow()] };
    }
    if (sql.includes("WITH scoped AS")) return { rows: options.pairs };
    if (sql.includes("SET total_pairs")) return { rows: [] };
    if (sql.includes("SET processed_pairs = $2, failed_pairs = $3")) {
      return { rows: [{ cancelRequested: options.cancelAt !== undefined && Number(values[1]) >= options.cancelAt }] };
    }
    if (sql.includes("SELECT cancel_requested_at IS NOT NULL")) return { rows: [{ cancelRequested: false }] };
    if (sql.includes("SET status = $2")) return { rows: [] };
    if (sql.includes("INSERT INTO access_audit_events")) return { rows: [] };
    if (sql.includes("error_code = 'INTERRUPTED'")) return { rows: [{ id: RUN_ID, requestedByAccountId: ACCOUNT }] };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return { pool: { query } as unknown as Pool, statements };
}

function finishStatement(statements: Array<{ sql: string; values: unknown[] }>) {
  return statements.find((statement) => statement.sql.includes("SET status = $2"));
}

describe("ATT-014-2 calculation runner", () => {
  it("calculates covered pairs only, counts uncovered pairs and audits completion", async () => {
    const { pool, statements } = runnerPool({
      pairs: [
        { employeeId: EMPLOYEE_A, workDate: "2026-10-01", covered: true },
        { employeeId: EMPLOYEE_B, workDate: "2026-10-01", covered: false },
        { employeeId: EMPLOYEE_A, workDate: "2026-10-02", covered: true },
      ],
    });
    const materialize = vi.fn(async () => ({}));
    const runner = createCalculationRunner(pool, { materialize, pause: async () => undefined });
    runner.kick();
    await runner.idle();
    expect(materialize.mock.calls.map((call) => [call[1], call[2]])).toEqual([[EMPLOYEE_A, "2026-10-01"], [EMPLOYEE_A, "2026-10-02"]]);
    expect(statements.find((statement) => statement.sql.includes("SET total_pairs"))?.values).toEqual([RUN_ID, 2, 1]);
    expect(finishStatement(statements)?.values).toEqual([RUN_ID, "completed", 2, 0, null]);
    const audit = statements.find((statement) => statement.sql.includes("INSERT INTO access_audit_events"));
    expect(audit?.values[2]).toBe("attendance.calculation.completed");
    expect(JSON.parse(String(audit?.values[4]))).toMatchObject({ processedPairs: 2, failedPairs: 0, uncoveredPairs: 1 });
  });

  it("keeps going when one pair fails and records it in failed_pairs", async () => {
    const { pool, statements } = runnerPool({
      pairs: [
        { employeeId: EMPLOYEE_A, workDate: "2026-10-01", covered: true },
        { employeeId: EMPLOYEE_B, workDate: "2026-10-01", covered: true },
      ],
    });
    const materialize = vi.fn(async (_pool: Pool, employeeId: string) => {
      if (employeeId === EMPLOYEE_A) throw new Error("synthetic failure");
      return {};
    });
    const runner = createCalculationRunner(pool, { materialize, pause: async () => undefined });
    runner.kick();
    await runner.idle();
    expect(materialize).toHaveBeenCalledTimes(2);
    expect(finishStatement(statements)?.values).toEqual([RUN_ID, "completed", 2, 1, null]);
  });

  it("stops at the next progress checkpoint after cancel and keeps calculated pairs", async () => {
    const pairs = Array.from({ length: 60 }, (_, index) => ({
      employeeId: EMPLOYEE_A, workDate: `2026-10-${String((index % 28) + 1).padStart(2, "0")}`, covered: true,
    }));
    const { pool, statements } = runnerPool({ pairs, cancelAt: 25 });
    const materialize = vi.fn(async () => ({}));
    const runner = createCalculationRunner(pool, { materialize, pause: async () => undefined });
    runner.kick();
    await runner.idle();
    expect(materialize).toHaveBeenCalledTimes(25);
    expect(finishStatement(statements)?.values).toEqual([RUN_ID, "cancelled", 25, 0, null]);
  });

  it("processes queued runs one after another", async () => {
    const { pool } = runnerPool({ pairs: [{ employeeId: EMPLOYEE_A, workDate: "2026-10-01", covered: true }], claims: 2 });
    const materialize = vi.fn(async () => ({}));
    const runner = createCalculationRunner(pool, { materialize, pause: async () => undefined });
    runner.kick();
    runner.kick();
    await runner.idle();
    expect(materialize).toHaveBeenCalledTimes(2);
  });

  it("fails the run with CALCULATION_FAILED when the pairs cannot be built", async () => {
    const { pool, statements } = runnerPool({ pairs: [] });
    const original = (pool.query as unknown as ReturnType<typeof vi.fn>).getMockImplementation()!;
    (pool.query as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes("WITH scoped AS")) throw new Error("synthetic database error");
      return original(sql, values);
    });
    const runner = createCalculationRunner(pool, { materialize: vi.fn(), pause: async () => undefined });
    runner.kick();
    await runner.idle();
    expect(finishStatement(statements)?.values).toEqual([RUN_ID, "failed", 0, 0, "CALCULATION_FAILED"]);
  });

  it("marks runs left running by a previous process as INTERRUPTED", async () => {
    const { pool, statements } = runnerPool({ pairs: [] });
    const runner = createCalculationRunner(pool);
    await expect(runner.recoverInterrupted()).resolves.toBe(1);
    const audit = statements.find((statement) => statement.sql.includes("INSERT INTO access_audit_events"));
    expect(audit?.values[2]).toBe("attendance.calculation.failed");
    expect(JSON.parse(String(audit?.values[4]))).toEqual({ errorCode: "INTERRUPTED" });
  });
});

// Routes: one synthetic account whose permissions are set per test.
const granted = { permissions: [] as AdminPermission[] };

vi.mock("../src/modules/auth/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/auth/service.js")>();
  class FakeAuthService {
    async getSession(token: string | null) {
      if (!token) return null;
      return {
        principal: { id: ACCOUNT, email: "hc-calculation@example.invalid", principalType: "SUPER_ADMIN" },
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      };
    }
    async getAuthorizationContext() {
      return { organizationPermissions: [...granted.permissions] };
    }
  }
  return { ...actual, AuthService: FakeAuthService };
});

const { registerAttendanceWorkforceRoutes } = await import("../src/modules/attendance/workforce-routes.js");

const config = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://attendance-calculation-test",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
} as ApiConfig;

function routePool(existing: Record<string, unknown> | null = null) {
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.includes("INSERT INTO attendance_calculation_runs")) {
      return { rows: [runRow({ id: values[0], status: "queued", dateFrom: values[4], dateTo: values[5], unitId: values[2], employeeId: values[3], startedAt: null })] };
    }
    if (sql.includes("INSERT INTO access_audit_events")) return { rows: [] };
    if (sql.includes("count(*)::int AS position")) return { rows: [{ position: 2 }] };
    if (sql.includes("FROM attendance_calculation_runs WHERE id = $1")) return { rows: existing ? [existing] : [] };
    if (sql.includes("cancel_requested_at = coalesce")) {
      if (!existing || !["queued", "running"].includes(String(existing.status))) return { rows: [] };
      return {
        rows: [{ ...existing, status: existing.status === "queued" ? "cancelled" : existing.status, cancelRequestedAt: new Date() }],
      };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return { pool: { query, connect: vi.fn() } as unknown as Pool, query };
}

describe("ATT-014-2 calculation routes", () => {
  let app: ReturnType<typeof Fastify>;
  let pool: ReturnType<typeof routePool>;
  let runner: CalculationRunner & { kick: ReturnType<typeof vi.fn> };

  async function start(existing: Record<string, unknown> | null = null) {
    pool = routePool(existing);
    runner = { kick: vi.fn(), recoverInterrupted: vi.fn(async () => 0), idle: vi.fn(async () => undefined) };
    app = Fastify({ logger: false });
    await registerAttendanceWorkforceRoutes(app, pool.pool, config, { calculationRunner: runner });
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    granted.permissions = ["attendance.calculation.run", "attendance.reports.read"];
    await start();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
  });

  const cookie = { cookie: "hcis_session=test-token" };
  const post = (payload: unknown, url = "/admin/attendance/calculations") =>
    app.inject({ method: "POST", url, headers: cookie, payload: payload as Record<string, unknown> });

  it("queues a calculation, audits the request and starts the runner", async () => {
    const response = await post({ from: "2026-10-01", to: "2026-10-26", unitId: "00000000-0000-4000-8000-000000014305" });
    expect(response.statusCode, response.body).toBe(202);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({ status: "queued", position: 2, from: "2026-10-01", to: "2026-10-26" });
    expect(runner.kick).toHaveBeenCalledTimes(1);
    const audit = pool.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO access_audit_events"));
    expect(audit?.[1]?.[2]).toBe("attendance.calculation.requested");
    expect(JSON.parse(String(audit?.[1]?.[5]))).toEqual({
      unitId: "00000000-0000-4000-8000-000000014305", employeeId: null, from: "2026-10-01", to: "2026-10-26",
    });
  });

  it("rejects more than 93 days and future dates with 422, a bad body with 400, and writes nothing", async () => {
    const tooLarge = await post({ from: "2026-07-25", to: "2026-10-26" });
    expect(tooLarge.statusCode).toBe(422);
    expect(tooLarge.json().code).toBe("CALCULATION_RANGE_TOO_LARGE");
    const future = await post({ from: "2026-10-26", to: "2026-10-27" });
    expect(future.statusCode).toBe(422);
    expect(future.json().code).toBe("CALCULATION_DATE_IN_FUTURE");
    const reversed = await post({ from: "2026-10-10", to: "2026-10-01" });
    expect(reversed.statusCode).toBe(400);
    const unknownField = await post({ from: "2026-10-01", to: "2026-10-02", everyone: true });
    expect(unknownField.statusCode).toBe(400);
    expect(unknownField.json().code).toBe("INVALID_CALCULATION_RANGE");
    expect(pool.query).not.toHaveBeenCalled();
    expect(runner.kick).not.toHaveBeenCalled();
  });

  it("requires attendance.calculation.run; reading reports is not enough", async () => {
    granted.permissions = ["attendance.reports.read", "attendance.policy.manage"];
    const response = await post({ from: "2026-10-01", to: "2026-10-02" });
    expect(response.statusCode).toBe(403);
    const alias = await app.inject({ method: "POST", url: "/admin/attendance/finalize/2026-10-01", headers: cookie });
    expect(alias.statusCode).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("keeps finalize/{date} as an alias that queues one date for everyone", async () => {
    const response = await app.inject({ method: "POST", url: "/admin/attendance/finalize/2026-10-25", headers: cookie });
    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toMatchObject({ status: "queued", from: "2026-10-25", to: "2026-10-25", unitId: null, employeeId: null });
    expect(runner.kick).toHaveBeenCalledTimes(1);
  });

  it("returns run progress to report readers and 404 for an unknown run", async () => {
    await app.close();
    await start(runRow({ totalPairs: 100, processedPairs: 50 }));
    granted.permissions = ["attendance.reports.read"];
    const response = await app.inject({ method: "GET", url: `/admin/attendance/calculations/${RUN_ID}`, headers: cookie });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "running", position: null, totalPairs: 100, processedPairs: 50 });
    await app.close();
    await start(null);
    const missing = await app.inject({ method: "GET", url: `/admin/attendance/calculations/${RUN_ID}`, headers: cookie });
    expect(missing.statusCode).toBe(404);
  });

  it("cancels a queued run at once and audits it", async () => {
    await app.close();
    await start(runRow({ status: "queued", startedAt: null }));
    const response = await app.inject({ method: "POST", url: `/admin/attendance/calculations/${RUN_ID}/cancel`, headers: cookie });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ status: "cancelled", cancelRequested: true });
    const audit = pool.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO access_audit_events"));
    expect(audit?.[1]?.[2]).toBe("attendance.calculation.cancelled");
  });

  it("asks a running run to stop and answers 409 for a finished run", async () => {
    await app.close();
    await start(runRow({ status: "running" }));
    const running = await app.inject({ method: "POST", url: `/admin/attendance/calculations/${RUN_ID}/cancel`, headers: cookie });
    expect(running.statusCode).toBe(200);
    expect(running.json()).toMatchObject({ status: "running", cancelRequested: true });
    await app.close();
    await start(runRow({ status: "completed" }));
    const finished = await app.inject({ method: "POST", url: `/admin/attendance/calculations/${RUN_ID}/cancel`, headers: cookie });
    expect(finished.statusCode).toBe(409);
    expect(finished.json().code).toBe("CALCULATION_ALREADY_FINISHED");
  });

  it("lets only the requester or a policy manager cancel", async () => {
    await app.close();
    await start(runRow({ status: "queued", requestedByAccountId: "00000000-0000-4000-8000-000000014399" }));
    const forbidden = await app.inject({ method: "POST", url: `/admin/attendance/calculations/${RUN_ID}/cancel`, headers: cookie });
    expect(forbidden.statusCode).toBe(403);
    granted.permissions = ["attendance.calculation.run", "attendance.policy.manage"];
    const allowed = await app.inject({ method: "POST", url: `/admin/attendance/calculations/${RUN_ID}/cancel`, headers: cookie });
    expect(allowed.statusCode).toBe(200);
  });

  it("validates the calculation-rows query before reading", async () => {
    const badPage = await app.inject({ method: "GET", url: "/admin/attendance/calculation-rows?from=2026-10-01&to=2026-10-02&pageSize=1000", headers: cookie });
    expect(badPage.statusCode).toBe(400);
    const tooLarge = await app.inject({ method: "GET", url: "/admin/attendance/calculation-rows?from=2026-07-01&to=2026-10-26", headers: cookie });
    expect(tooLarge.statusCode).toBe(422);
    granted.permissions = ["attendance.calculation.run"];
    const forbidden = await app.inject({ method: "GET", url: "/admin/attendance/calculation-rows?from=2026-10-01&to=2026-10-02", headers: cookie });
    expect(forbidden.statusCode).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
