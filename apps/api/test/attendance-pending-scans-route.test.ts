import Fastify from "fastify";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";

// ATT-014 §6.5b (DRAFT). Kehadiran tidak dihitung otomatis (keputusan owner 2026-10-24), jadi
// riwayat pegawai harus jujur: scan yang sudah diterima untuk tanggal yang belum dikalkulasi
// ditampilkan apa adanya, bukan "—". Identitas sintetis; SQL-nya diuji di test PostgreSQL.

const EMPLOYEE_ID = "00000000-0000-4000-8000-000000030001";

vi.mock("../src/modules/auth/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/auth/service.js")>();
  class FakeAuthService {
    async getSession(token: string | null) {
      if (!token) return null;
      return {
        principal: { id: "00000000-0000-4000-8000-000000030002", email: "pegawai@example.invalid", principalType: "EMPLOYEE" },
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      };
    }
    async getAuthorizationContext() {
      return { organizationPermissions: [] };
    }
  }
  return { ...actual, AuthService: FakeAuthService };
});

const { registerAttendanceWorkforceRoutes } = await import("../src/modules/attendance/workforce-routes.js");

const config = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://attendance-pending-scans-test",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
} as ApiConfig;

describe("GET /attendance/me/schedule — scan yang belum dikalkulasi", () => {
  let app: ReturnType<typeof Fastify>;
  const results = { rows: [] as unknown[] };

  const query = vi.fn<(sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>>(async (sql) => {
    if (sql.includes("JOIN employees employee ON employee.id = account.employee_id")) {
      return { rows: [{ id: EMPLOYEE_ID, fullName: "Pegawai Sintetis", employeeNumber: "SYN-1" }] };
    }
    if (sql.includes("FROM attendance_adms_events event")) {
      return { rows: [{
        workDate: "2026-11-12",
        firstScanAt: new Date("2026-11-12T05:40:04.000Z"),
        lastScanAt: new Date("2026-11-12T05:40:04.000Z"),
        scanCount: "1",
      }] };
    }
    if (sql.includes("FROM attendance_result_versions")) return results;
    return { rows: [] };
  });

  beforeEach(async () => {
    results.rows = [];
    query.mockClear();
    app = Fastify({ logger: false });
    await registerAttendanceWorkforceRoutes(app, { query, connect: vi.fn() } as unknown as Pool, config, {
      calculationRunner: { kick: vi.fn(), recoverInterrupted: vi.fn(async () => 0), idle: vi.fn(async () => undefined) },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const get = () => app.inject({
    method: "GET",
    url: "/attendance/me/schedule?from=2026-11-11&to=2026-11-13",
    headers: { cookie: "hcis_session=test-token" },
  });

  it("menyertakan jam scan untuk tanggal yang belum punya hasil", async () => {
    const response = await get();
    expect(response.statusCode, response.body).toBe(200);
    const items = response.json().items as Array<{ workDate: string; pendingScans: { firstScanAt: string; lastScanAt: string | null; scanCount: number } | null }>;
    const twelfth = items.find((item) => item.workDate === "2026-11-12");
    expect(twelfth?.pendingScans).toEqual({
      firstScanAt: "2026-11-12T05:40:04.000Z",
      lastScanAt: null,
      scanCount: 1,
    });
    expect(items.find((item) => item.workDate === "2026-11-11")?.pendingScans).toBeNull();
  });

  it("menyembunyikan penanda itu begitu tanggalnya punya hasil kalkulasi", async () => {
    results.rows = [{ id: "00000000-0000-4000-8000-000000030003", workDate: "2026-11-12", version: 1, status: "incomplete" }];
    const items = (await get()).json().items as Array<{ workDate: string; pendingScans: unknown }>;
    expect(items.every((item) => item.pendingScans === null)).toBe(true);
  });

  it("membaca scan satu kali untuk seluruh rentang, bukan per tanggal", async () => {
    await get();
    expect(query.mock.calls.filter(([sql]) => sql.includes("FROM attendance_adms_events event"))).toHaveLength(1);
    expect(query.mock.calls.filter(([sql]) => /^\s*(INSERT|UPDATE|DELETE)\s/i.test(sql))).toEqual([]);
  });
});
