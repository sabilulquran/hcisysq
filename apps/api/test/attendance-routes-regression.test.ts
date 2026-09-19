import Fastify from "fastify";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/modules/attendance/engine.js", () => ({
  materializeAttendanceResult: vi.fn(async (_pool: unknown, employeeId: string, workDate: string) => ({
    id: "00000000-0000-4000-8000-000000000777",
    employeeId,
    workDate,
    version: 2,
    status: "present",
    scheduleTemplateId: null,
    scheduleVersionId: null,
    rosterId: null,
    scheduledStartAt: null,
    scheduledEndAt: null,
    firstCheckInAt: new Date("2026-08-21T00:00:00.000Z"),
    lastCheckOutAt: new Date("2026-08-21T09:00:00.000Z"),
    workedMinutes: 540,
    breakMinutes: 0,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    incompleteSession: false,
    justified: false,
    lateJustified: false,
    earlyLeaveJustified: false,
    outsideGeofenceJustified: false,
    overtimeMinutes: 0,
    inputHash: "a".repeat(64),
    createdAt: new Date("2026-08-21T10:00:00.000Z"),
  })),
}));

import { registerAttendanceRoutes } from "../src/modules/attendance/routes.js";

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://attendance-route-test",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

const employeeA = "00000000-0000-4000-8000-000000000010";
const employeeB = "00000000-0000-4000-8000-000000000020";
const accountId = "00000000-0000-4000-8000-000000000001";

function sessionRow(principalType: "EMPLOYEE" | "SUPER_ADMIN") {
  return {
    sessionId: "00000000-0000-4000-8000-000000000100",
    accountId,
    email: principalType === "EMPLOYEE" ? "employee@example.org" : "admin@example.org",
    principalType,
    expiresAt: new Date("2026-08-22T12:00:00.000Z"),
  };
}

function employeeRow(id: string) {
  return {
    id,
    employeeNumber: id === employeeA ? "EMP-A" : "EMP-B",
    fullName: id === employeeA ? "Employee A" : "Employee B",
    status: "active" as const,
    unitName: "Unit Test",
    positionName: "Position Test",
  };
}

function createReadPool(principalType: "EMPLOYEE" | "SUPER_ADMIN") {
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('SELECT DISTINCT role_permission.permission_key AS "permissionKey"')) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM auth_sessions s")) {
      return { rows: [sessionRow(principalType)], rowCount: 1 };
    }
    if (sql.includes("UPDATE auth_sessions SET last_seen_at")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM accounts a") && sql.includes("JOIN employees e")) {
      return { rows: [employeeRow(employeeA)], rowCount: 1 };
    }
    if (sql.includes("FROM employees e") && sql.includes("WHERE e.id = $1")) {
      return { rows: [employeeRow(String(values?.[0]))], rowCount: 1 };
    }
    if (sql.includes("FROM attendance_daily_records")) {
      const target = String(values?.[0]);
      return {
        rows: [
          {
            employeeId: target,
            attendanceDate: "2026-08-21",
            checkInAt: new Date("2026-08-21T00:00:00.000Z"),
            checkOutAt: new Date("2026-08-21T09:00:00.000Z"),
            source: "manual" as const,
            sourceReference: "admin-only-reference",
            note: "admin-only-note",
            createdAt: new Date("2026-08-21T00:00:00.000Z"),
            updatedAt: new Date("2026-08-21T09:00:00.000Z"),
          },
        ],
        rowCount: 1,
      };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });

  return { pool: { query } as unknown as Pool, query };
}

function createCanonicalMutationPool() {
  const writes: string[] = [];
  const poolQuery = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('SELECT DISTINCT role_permission.permission_key AS "permissionKey"')) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM auth_sessions s")) return { rows: [sessionRow("SUPER_ADMIN")], rowCount: 1 };
    if (sql.includes("UPDATE auth_sessions SET last_seen_at")) return { rows: [], rowCount: 1 };
    if (sql.includes("FROM employees e") && sql.includes("WHERE e.id = $1")) {
      return { rows: [employeeRow(String(values?.[0]))], rowCount: 1 };
    }
    throw new Error(`Unexpected pool SQL: ${sql}`);
  });

  const clientQuery = vi.fn(async (sql: string) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: null };
    if (sql.includes("INSERT INTO attendance_clarifications")) {
      writes.push("clarification");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO attendance_clarification_events")) {
      writes.push("events");
      return { rows: [], rowCount: 2 };
    }
    throw new Error(`Unexpected client SQL: ${sql}`);
  });

  const client = { query: clientQuery, release: vi.fn() } as unknown as PoolClient;
  const pool = { query: poolQuery, connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, clientQuery, writes };
}

describe("ATT-001 route-level account isolation", () => {
  it("does not let an employee query parameter select another employee", async () => {
    const { pool, query } = createReadPool("EMPLOYEE");
    const app = Fastify({ logger: false });
    await registerAttendanceRoutes(app, pool, config);

    const response = await app.inject({
      method: "GET",
      url: `/attendance/me?from=2026-08-21&to=2026-08-21&employeeId=${employeeB}`,
      headers: { cookie: "hcis_session=test-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().employee.id).toBe(employeeA);
    const attendanceCall = query.mock.calls.find(([sql]) =>
      String(sql).includes("FROM attendance_daily_records"),
    );
    expect(attendanceCall?.[1]?.[0]).toBe(employeeA);
    expect(attendanceCall?.[1]?.[0]).not.toBe(employeeB);
    await app.close();
  });

  it("fails closed when an employee principal calls the admin read route", async () => {
    const { pool, query } = createReadPool("EMPLOYEE");
    const app = Fastify({ logger: false });
    await registerAttendanceRoutes(app, pool, config);

    const response = await app.inject({
      method: "GET",
      url: `/admin/attendance/employees/${employeeB}`,
      headers: { cookie: "hcis_session=test-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("FROM employees e"))).toBe(false);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("FROM attendance_daily_records"))).toBe(false);
    await app.close();
  });

  it("keeps admin-only fields out of the employee response at route level", async () => {
    const { pool } = createReadPool("EMPLOYEE");
    const app = Fastify({ logger: false });
    await registerAttendanceRoutes(app, pool, config);

    const response = await app.inject({
      method: "GET",
      url: "/attendance/me?from=2026-08-21&to=2026-08-21",
      headers: { cookie: "hcis_session=test-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json().items[0]).not.toHaveProperty("note");
    expect(response.json().items[0]).not.toHaveProperty("sourceReference");
    await app.close();
  });
});

describe("ATT-008 ATT-001 compatibility mutation convergence", () => {
  it("turns the legacy PUT surface into an append-only canonical correction", async () => {
    const { pool, clientQuery, writes } = createCanonicalMutationPool();
    const app = Fastify({ logger: false });
    await registerAttendanceRoutes(app, pool, config);

    const response = await app.inject({
      method: "PUT",
      url: `/admin/attendance/employees/${employeeA}/2026-08-21`,
      headers: { cookie: "hcis_session=test-token", "content-type": "application/json" },
      payload: {
        checkInAt: "2026-08-21T07:00:00+07:00",
        checkOutAt: "2026-08-21T16:00:00+07:00",
        note: "canonical correction",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      canonical: true,
      item: {
        employeeId: employeeA,
        attendanceDate: "2026-08-21",
        source: "integration",
      },
    });
    expect(writes).toEqual(["clarification", "events"]);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("attendance_daily_records"))).toBe(false);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("attendance_daily_audit_events"))).toBe(false);
    await app.close();
  });

  it("rejects deletion because canonical attendance is append-only", async () => {
    const { pool } = createCanonicalMutationPool();
    const app = Fastify({ logger: false });
    await registerAttendanceRoutes(app, pool, config);

    const response = await app.inject({
      method: "DELETE",
      url: `/admin/attendance/employees/${employeeA}/2026-08-21`,
      headers: { cookie: "hcis_session=test-token" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "CANONICAL_ATTENDANCE_IS_APPEND_ONLY" });
    await app.close();
  });
});
