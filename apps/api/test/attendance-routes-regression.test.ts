import Fastify from "fastify";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

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

function createIntegrationMutationPool() {
  const poolQuery = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('SELECT DISTINCT role_permission.permission_key AS "permissionKey"')) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM auth_sessions s")) {
      return { rows: [sessionRow("SUPER_ADMIN")], rowCount: 1 };
    }
    if (sql.includes("UPDATE auth_sessions SET last_seen_at")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM employees e") && sql.includes("WHERE e.id = $1")) {
      return { rows: [employeeRow(String(values?.[0]))], rowCount: 1 };
    }
    throw new Error(`Unexpected pool SQL: ${sql}`);
  });

  const clientQuery = vi.fn(async (sql: string) => {
    if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: null };
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}], rowCount: 1 };
    if (sql.includes("FROM attendance_daily_records") && sql.includes("FOR UPDATE")) {
      return {
        rows: [
          {
            employeeId: employeeA,
            attendanceDate: "2026-08-21",
            checkInAt: new Date("2026-08-21T00:00:00.000Z"),
            checkOutAt: new Date("2026-08-21T09:00:00.000Z"),
            source: "integration" as const,
            sourceReference: "fingerprint:123",
            note: null,
            createdAt: new Date("2026-08-21T00:00:00.000Z"),
            updatedAt: new Date("2026-08-21T09:00:00.000Z"),
          },
        ],
        rowCount: 1,
      };
    }
    throw new Error(`Unexpected client SQL: ${sql}`);
  });

  const client = {
    query: clientQuery,
    release: vi.fn(),
  } as unknown as PoolClient;
  const pool = {
    query: poolQuery,
    connect: vi.fn(async () => client),
  } as unknown as Pool;
  return { pool, clientQuery };
}

function createConcurrentMutationPool() {
  let record:
    | {
        employeeId: string;
        attendanceDate: string;
        checkInAt: Date | null;
        checkOutAt: Date | null;
        source: "manual";
        sourceReference: null;
        note: string | null;
        createdAt: Date;
        updatedAt: Date;
      }
    | undefined;
  let lockTail = Promise.resolve();
  const auditActions: string[] = [];

  const poolQuery = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('SELECT DISTINCT role_permission.permission_key AS "permissionKey"')) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM auth_sessions s")) {
      return { rows: [sessionRow("SUPER_ADMIN")], rowCount: 1 };
    }
    if (sql.includes("UPDATE auth_sessions SET last_seen_at")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM employees e") && sql.includes("WHERE e.id = $1")) {
      return { rows: [employeeRow(String(values?.[0]))], rowCount: 1 };
    }
    throw new Error(`Unexpected pool SQL: ${sql}`);
  });

  const connect = vi.fn(async () => {
    let unlock: (() => void) | undefined;
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql === "BEGIN") return { rows: [], rowCount: null };
      if (sql.includes("pg_advisory_xact_lock")) {
        const previous = lockTail;
        lockTail = new Promise<void>((resolve) => {
          unlock = resolve;
        });
        await previous;
        return { rows: [{}], rowCount: 1 };
      }
      if (sql.includes("FROM attendance_daily_records") && sql.includes("FOR UPDATE")) {
        return { rows: record ? [{ ...record }] : [], rowCount: record ? 1 : 0 };
      }
      if (sql.includes("INSERT INTO attendance_daily_records")) {
        const now = new Date("2026-08-21T10:00:00.000Z");
        record = {
          employeeId: String(values?.[0]),
          attendanceDate: String(values?.[1]),
          checkInAt: values?.[2] ? new Date(String(values[2])) : null,
          checkOutAt: values?.[3] ? new Date(String(values[3])) : null,
          source: "manual",
          sourceReference: null,
          note: (values?.[4] as string | null) ?? null,
          createdAt: record?.createdAt ?? now,
          updatedAt: now,
        };
        return { rows: [{ ...record }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO attendance_daily_audit_events")) {
        auditActions.push(String(values?.[4]));
        return { rows: [], rowCount: 1 };
      }
      if (sql === "COMMIT" || sql === "ROLLBACK") {
        unlock?.();
        unlock = undefined;
        return { rows: [], rowCount: null };
      }
      throw new Error(`Unexpected client SQL: ${sql}`);
    });
    return { query, release: vi.fn() } as unknown as PoolClient;
  });

  return {
    pool: { query: poolQuery, connect } as unknown as Pool,
    auditActions,
  };
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

describe("ATT-001 route-level mutation provenance and concurrency", () => {
  it("rejects manual mutation of an integration-sourced record before write/audit", async () => {
    const { pool, clientQuery } = createIntegrationMutationPool();
    const app = Fastify({ logger: false });
    await registerAttendanceRoutes(app, pool, config);

    const response = await app.inject({
      method: "PUT",
      url: `/admin/attendance/employees/${employeeA}/2026-08-21`,
      headers: { cookie: "hcis_session=test-token", "content-type": "application/json" },
      payload: {
        checkInAt: "2026-08-21T07:00:00+07:00",
        checkOutAt: "2026-08-21T16:00:00+07:00",
        note: "manual correction",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "INTEGRATED_ATTENDANCE_IMMUTABLE" });
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO attendance_daily_records"))).toBe(false);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("attendance_daily_audit_events"))).toBe(false);
    await app.close();
  });

  it("serializes concurrent corrections so audit actions are created then updated", async () => {
    const { pool, auditActions } = createConcurrentMutationPool();
    const app = Fastify({ logger: false });
    await registerAttendanceRoutes(app, pool, config);

    const request = (note: string) =>
      app.inject({
        method: "PUT",
        url: `/admin/attendance/employees/${employeeA}/2026-08-21`,
        headers: { cookie: "hcis_session=test-token", "content-type": "application/json" },
        payload: {
          checkInAt: "2026-08-21T07:00:00+07:00",
          checkOutAt: "2026-08-21T16:00:00+07:00",
          note,
        },
      });

    const [first, second] = await Promise.all([request("first"), request("second")]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(auditActions).toEqual(["created", "updated"]);
    await app.close();
  });
});
