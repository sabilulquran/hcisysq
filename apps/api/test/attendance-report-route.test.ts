import Fastify from "fastify";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AdminPermission } from "../src/modules/auth/permissions.js";

// ATT-014 §19.2 report route: preview, print document, CSV, XLSX and their audit. Synthetic data only.

const granted = { permissions: [] as AdminPermission[] };

vi.mock("../src/modules/auth/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/auth/service.js")>();
  class FakeAuthService {
    async getSession(token: string | null) {
      if (!token) return null;
      return {
        principal: { id: "00000000-0000-4000-8000-000000017001", email: "hc-report@example.invalid", principalType: "SUPER_ADMIN" },
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
  DATABASE_URL: "postgres://attendance-report-test",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
} as ApiConfig;

const EMPLOYEE = "00000000-0000-4000-8000-000000017002";

describe("GET /admin/attendance/reports/:model", () => {
  let app: ReturnType<typeof Fastify>;
  const query = vi.fn<(sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>>(async (sql) => {
    if (sql.includes("WITH scoped AS")) {
      return { rows: [{ employeeId: EMPLOYEE, workDate: "2026-10-01", covered: false }, { employeeId: EMPLOYEE, workDate: "2026-10-02", covered: true }] };
    }
    if (sql.includes("FROM employees employee")) {
      return { rows: [{ employeeId: EMPLOYEE, employeeNumber: "SYN-1", employeeName: "Pegawai Sintetis", unitId: null, unitName: "Unit Sintetis" }] };
    }
    return { rows: [] };
  });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T10:00:00+07:00"));
    query.mockClear();
    granted.permissions = ["attendance.reports.read"];
    app = Fastify({ logger: false });
    await registerAttendanceWorkforceRoutes(app, { query, connect: vi.fn() } as unknown as Pool, config, {
      calculationRunner: { kick: vi.fn(), recoverInterrupted: vi.fn(async () => 0), idle: vi.fn(async () => undefined) },
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
  });

  const get = (path: string) => app.inject({ method: "GET", url: path, headers: { cookie: "hcis_session=test-token" } });
  const audits = () => query.mock.calls.filter(([sql]) => sql.includes("INSERT INTO access_audit_events"));

  it("returns a preview with header and warnings, without an audit entry", async () => {
    const response = await get("/admin/attendance/reports/daily_grid?from=2026-10-01&to=2026-10-02");
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ model: "daily_grid", orientation: "landscape", warnings: { notCalculated: 1, changed: 0 } });
    expect(body.header).toMatchObject({
      scope: "Unit: Semua unit", unit: "Semua unit", employeeCount: 1, workDays: 0, calculatedAt: "Belum ditarik",
      period: "Periode 1 Oktober 2026 – 2 Oktober 2026", printedBy: "hc-report@example.invalid",
    });
    expect(body.groups[0].rows[0]).toMatchObject({ "d:2026-10-01": "·", "d:2026-10-02": "·" });
    expect(audits()).toHaveLength(0);
  });

  it("audits a print document with model, scope and row count only", async () => {
    await get("/admin/attendance/reports/employee_summary?from=2026-10-01&to=2026-10-02&purpose=print");
    expect(audits()).toHaveLength(1);
    const values = audits()[0]![1]!;
    expect(values[2]).toBe("attendance.report.exported");
    expect(JSON.parse(String(values[5]))).toEqual({
      model: "employee_summary", format: "json", purpose: "print", unitId: null, employeeId: null,
      from: "2026-10-01", to: "2026-10-02", rows: 2,
    });
  });

  it("downloads CSV and XLSX, each audited", async () => {
    const csv = await get("/admin/attendance/reports/daily_detail?from=2026-10-01&to=2026-10-02&format=csv");
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toContain("hcis-kehadiran-daily_detail-2026-10-01-2026-10-02.csv");
    const xlsx = await get("/admin/attendance/reports/daily_detail?from=2026-10-01&to=2026-10-02&format=xlsx");
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe("PK");
    expect(audits()).toHaveLength(2);
  });

  it("rejects an unknown model, a bad range and a missing permission before reading", async () => {
    expect((await get("/admin/attendance/reports/payroll?from=2026-10-01&to=2026-10-02")).statusCode).toBe(404);
    expect((await get("/admin/attendance/reports/daily_grid?from=2026-07-01&to=2026-10-26")).statusCode).toBe(422);
    expect((await get("/admin/attendance/reports/daily_grid?from=2026-10-01&to=2026-10-02&format=pdf")).statusCode).toBe(400);
    granted.permissions = ["attendance.calculation.run"];
    expect((await get("/admin/attendance/reports/daily_grid?from=2026-10-01&to=2026-10-02")).statusCode).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });
});
