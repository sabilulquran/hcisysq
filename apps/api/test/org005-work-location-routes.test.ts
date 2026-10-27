import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerAdmsPhysicalParityRegistryUserRoutes } from "../src/modules/attendance/adms/physical-parity-registry-user-routes.js";
import { registerAttendanceWorkforceRoutes } from "../src/modules/attendance/workforce-routes.js";

/**
 * ORG-005-2 (DRAFT, docs/domain/organization-sites-work-locations.md): a machine names the work
 * location it stands at (D-5-4), and a location still in use is not switched off (D-5-7).
 */

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://org005-test",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

const LOCATION = "00000000-0000-4000-8000-000000000070";
const DEVICE = "00000000-0000-4000-8000-000000000080";

interface Options {
  /** Units of today's structure naming the location. */
  unitsUsing?: string[];
  /** Active machines standing at the location. */
  devicesUsing?: string[];
  /** null when the location does not exist. */
  locationActive?: boolean | null;
}

function createPool(options: Options = {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
    if (sql.includes('SELECT DISTINCT role_permission.permission_key AS "permissionKey"')) {
      const keys = ["attendance.schedule.manage", "attendance.devices.read", "attendance.devices.configure"];
      return { rows: keys.map((permissionKey) => ({ permissionKey })), rowCount: keys.length };
    }
    if (sql.includes("FROM auth_sessions s")) {
      return {
        rows: [{
          sessionId: "00000000-0000-4000-8000-000000000001",
          accountId: "00000000-0000-4000-8000-000000000002",
          email: "synthetic@example.invalid",
          principalType: "EMPLOYEE",
          expiresAt: new Date("2027-01-01T00:00:00.000Z"),
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("UPDATE auth_sessions SET last_seen_at")) return { rows: [], rowCount: 1 };
    // The location being edited.
    if (sql.includes("FROM attendance_work_locations WHERE id = $1") && sql.includes("radius_meters")) {
      return { rows: [{ name: "Kampus SDIT", latitude: -6.2, longitude: 106.8, radiusMeters: 100, active: true }], rowCount: 1 };
    }
    if (sql.includes("SELECT active FROM attendance_work_locations")) {
      return options.locationActive === null || options.locationActive === undefined
        ? { rows: [], rowCount: 0 } : { rows: [{ active: options.locationActive }], rowCount: 1 };
    }
    if (sql.includes("FROM attendance_adms_devices") && sql.includes("work_location_id = $1")) {
      const rows = (options.devicesUsing ?? []).map((name) => ({ name }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM attendance_adms_devices WHERE id = $1")) {
      return {
        rows: [{
          id: DEVICE, serialNumber: "SYN0001", lifecycle: "active", timezone: "Asia/Jakarta",
          organizationalUnitId: null, areaContext: null, worksiteLabel: null, workLocationId: LOCATION,
          workLocationName: "Kampus SDIT", deviceRole: "attendance_only", transferMode: "push",
          heartbeatIntervalSeconds: 60, desiredPushProtocolVersion: null,
        }],
        rowCount: 1,
      };
    }
    // Today's structure: one published change set with the units that use the location.
    if (sql.includes("FROM organization_change_sets") && sql.includes("effective_on <= $1::date")) {
      return {
        rows: [{
          id: "published", name: "Struktur", effectiveOn: "2026-01-01", status: "PUBLISHED", baseChangeSetId: null,
          validationReport: {}, createdByAccountId: "actor", createdAt: new Date("2026-01-01T00:00:00Z"),
          validatedAt: new Date("2026-01-01T00:00:00Z"), publishedAt: new Date("2026-01-01T00:00:00Z"), revision: 0,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM organization_nodes")) {
      const rows = (options.unitsUsing ?? []).map((name, index) => ({
        id: `node-${index}`, stableKey: `00000000-0000-4000-8000-00000000009${index}`, name, nodeType: "UNIT",
        parentNodeKey: null, active: true, effectiveFrom: "2026-01-01", effectiveTo: null, visualRankOffset: 0,
        integrationCode: null, legacyUnitId: null, workLocationId: LOCATION,
      }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM organization_")) return { rows: [], rowCount: 0 };
    if (sql.includes("UPDATE attendance_work_locations") || sql.includes("UPDATE attendance_adms_devices")
      || sql.includes("INSERT INTO")) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected ORG-005 SQL: ${sql}`);
  });
  const client = { query, release: vi.fn() };
  const pool = { query, connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, query };
}

async function call(register: "workforce" | "devices", method: "PATCH", url: string, payload: object, options: Options = {}) {
  const { pool, query } = createPool(options);
  const app = Fastify({ logger: false });
  if (register === "workforce") await registerAttendanceWorkforceRoutes(app, pool, config);
  else await registerAdmsPhysicalParityRegistryUserRoutes(app, pool, config);
  const response = await app.inject({ method, url, headers: { cookie: "hcis_session=synthetic" }, payload });
  await app.close();
  return { response, query };
}

const locationUrl = `/admin/attendance/work-locations/${LOCATION}`;
const deviceUrl = `/admin/attendance/adms/devices/${DEVICE}/wdms-profile`;
const updated = (query: ReturnType<typeof vi.fn>, table: string) =>
  query.mock.calls.some(([sql]) => String(sql).includes(`UPDATE ${table}`));

describe("ORG-005-2 a location still in use is not switched off (D-5-7)", () => {
  it("refuses and names the units and machines that still use it", async () => {
    const { response, query } = await call("workforce", "PATCH", locationUrl, { active: false },
      { unitsUsing: ["SDIT"], devicesUsing: ["Mesin Lobi"] });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "WORK_LOCATION_IN_USE",
      details: { uses: [{ kind: "UNIT", name: "SDIT" }, { kind: "DEVICE", name: "Mesin Lobi" }] },
    });
    expect(updated(query, "attendance_work_locations")).toBe(false);
  });

  it("switches off a location nothing uses", async () => {
    const { response, query } = await call("workforce", "PATCH", locationUrl, { active: false });
    expect(response.statusCode).toBe(200);
    expect(updated(query, "attendance_work_locations")).toBe(true);
  });

  it("does not look for uses when only the name changes", async () => {
    const { response, query } = await call("workforce", "PATCH", locationUrl, { name: "Kampus SDIT Baru" },
      { unitsUsing: ["SDIT"] });
    expect(response.statusCode).toBe(200);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("FROM organization_nodes"))).toBe(false);
  });
});

describe("ORG-005-2 a machine names the work location it stands at (D-5-4)", () => {
  it("links an active location, audits it, and returns its name", async () => {
    const { response, query } = await call("devices", "PATCH", deviceUrl, { workLocationId: LOCATION }, { locationActive: true });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ item: { workLocationId: LOCATION, workLocationName: "Kampus SDIT" } });
    const update = query.mock.calls.find(([sql]) => String(sql).includes("UPDATE attendance_adms_devices"));
    expect((update?.[1] as unknown[]).slice(10)).toEqual([true, LOCATION]);
    const auditCall = query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO attendance_adms_admin_audit_events"));
    expect(JSON.parse((auditCall?.[1] as unknown[])[4] as string)).toMatchObject({ workLocationId: LOCATION });
  });

  it("refuses an inactive or unknown location and changes nothing", async () => {
    for (const locationActive of [false, null]) {
      const { response, query } = await call("devices", "PATCH", deviceUrl, { workLocationId: LOCATION }, { locationActive });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "INVALID_WORK_LOCATION" });
      expect(query.mock.calls.map(([sql]) => String(sql))).toContain("ROLLBACK");
    }
  });
});
