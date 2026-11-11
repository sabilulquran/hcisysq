import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import { registerAttendanceWorkforceRoutes } from "../src/modules/attendance/workforce-routes.js";
import { AuthService } from "../src/modules/auth/service.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

// This test never connects to an arbitrary DATABASE_URL. All fixtures and API
// writes live inside one outer transaction, rolled back even after a failure.
describe.skipIf(!allowed)("ATT-006 real PostgreSQL mobile clock", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let cookie: string;
  let employeeId: string;
  let accountId: string;
  let scheduleLocationId: string;

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    vi.setSystemTime(new Date("2099-01-05T01:00:00Z"));
    client = await pool.connect();
    await client.query("BEGIN");
    const stack: string[] = [];
    let sequence = 0;
    const query = async (text: string, values?: unknown[]) => {
      const command = text.trim().toUpperCase();
      if (command === "BEGIN") {
        const savepoint = `mobile_test_${++sequence}`;
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
    const transactionPool = {
      query,
      connect: async () => ({ query, release: () => undefined }),
    } as unknown as Pool;
    accountId = randomUUID();
    employeeId = randomUUID();
    await client.query(
      "INSERT INTO employees(id,employee_number,full_name,status) VALUES($1,$2,'Synthetic Mobile Test','active')",
      [employeeId, `MOBILE-TEST-${employeeId}`],
    );
    await client.query(
      "INSERT INTO accounts(id,employee_id,email,principal_type,status) VALUES($1,$2,$3,'EMPLOYEE','active')",
      [accountId, employeeId, `mobile-${accountId}@example.invalid`],
    );
    const locationId = randomUUID();
    scheduleLocationId = locationId;
    const scheduleId = randomUUID();
    await client.query(
      `INSERT INTO attendance_work_locations(id,name,latitude,longitude,radius_meters,created_by_account_id)
       VALUES($1,'Synthetic Mobile Location',-6.7,108.55,150,$2)`,
      [locationId, accountId],
    );
    await client.query(
      `INSERT INTO attendance_schedule_templates(id,name,start_time,end_time,work_location_id,created_by_account_id)
       VALUES($1,'Synthetic Mobile Schedule','08:00','16:00',$2,$3)`,
      [scheduleId, locationId, accountId],
    );
    await client.query(
      `INSERT INTO attendance_schedule_versions(id,schedule_template_id,version,name,start_time,end_time,end_day_offset,work_location_id,effective_from,created_by_account_id)
       VALUES($1,$2,1,'Synthetic Mobile Schedule','08:00','16:00',0,$3,'2000-01-01T00:00:00Z',$4)`,
      [randomUUID(), scheduleId, locationId, accountId],
    );
    await client.query(
      `INSERT INTO attendance_schedule_assignments(id,employee_id,schedule_template_id,weekday_mask,effective_from,created_by_account_id)
       VALUES($1,$2,$3,127,'2000-01-01',$4)`,
      [randomUUID(), employeeId, scheduleId, accountId],
    );
    const config = {
      NODE_ENV: "test", HOST: "127.0.0.1", PORT: 3001, DATABASE_URL: databaseUrl!,
      AUTH_MODE: "local", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8,
      MOBILE_ATTENDANCE_ENABLED: "1", BIOMETRIC_COLLECTION_ENABLED: "0",
      BIOMETRIC_ACTIVE_KEY_ID: "synthetic", BIOMETRIC_ENCRYPTION_KEYS: JSON.stringify({ synthetic: "22".repeat(32) }),
    } as ApiConfig;
    const auth = new AuthService(transactionPool, config.AUTH_ENCRYPTION_KEY!, 8, false);
    const session = await auth.createSessionForAccountId(accountId, {
      ipAddress: "127.0.0.1", userAgent: "rollback-only-mobile-test",
    });
    cookie = session.setCookie.split(";")[0]!;
    app = Fastify({ logger: false });
    await registerAttendanceWorkforceRoutes(app, transactionPool, config);
  });

  afterEach(async () => {
    try { await app?.close(); } finally {
      if (client) { await client.query("ROLLBACK"); client.release(); }
      vi.useRealTimers();
    }
  });

  it("saves encrypted camera evidence, evaluates the shift and replays without another event", async () => {
    const key = randomUUID();
    const payload = {
      action: "check_in", latitude: -6.7, longitude: 108.55, accuracyMeters: 10,
      photoBase64: Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0xff, 0xd9]).toString("base64"),
    };
    const snapshot = await app.inject({ method: "GET", url: "/attendance/me/workforce", headers: { cookie } });
    expect(snapshot.statusCode, snapshot.body).toBe(200);
    expect(snapshot.json().mobileEnabled).toBe(true);
    expect(snapshot.json().mobileReadiness).toMatchObject({
      captureReady: true,
      captureReason: "ready",
      scheduleState: "scheduled",
      hasWorkLocation: true,
    });
    expect(snapshot.json().schedule.state).toBe("scheduled");
    const response = await app.inject({ method: "POST", url: "/attendance/mobile/clock", headers: { cookie, "idempotency-key": key }, payload });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().geofenceStatus).toBe("inside");
    expect(response.json().result.firstCheckInAt).toBe("2099-01-05T01:00:00.000Z");
    const replay = await app.inject({ method: "POST", url: "/attendance/mobile/clock", headers: { cookie, "idempotency-key": key }, payload });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().evidenceId).toBe(response.json().evidenceId);
    const count = await client.query("SELECT count(*)::int AS total FROM attendance_mobile_evidence WHERE employee_id=$1", [employeeId]);
    expect(count.rows[0].total).toBe(1);
    const photo = await app.inject({ method: "GET", url: `/attendance/mobile/evidence/${response.json().evidenceId}/photo`, headers: { cookie } });
    expect(photo.statusCode, photo.body).toBe(200);
    expect(photo.headers["cache-control"]).toBe("no-store");
  });

  const photoBase64 = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0xff, 0xd9]).toString("base64");

  /** A published structure: a school unit naming `locationId`, and a sub-unit (no location) the employee is in. */
  async function placeEmployeeUnder(locationId: string) {
    const changeSetId = randomUUID();
    const schoolKey = randomUUID();
    const classKey = randomUUID();
    await client.query(
      `INSERT INTO organization_change_sets (id, name, effective_on, status, created_by_account_id, validated_at, published_at)
       VALUES ($1,'Struktur sintetis ORG-005-3','2098-12-01'::date,'PUBLISHED',$2, now(), now())`,
      [changeSetId, accountId],
    );
    await client.query(
      `INSERT INTO organization_nodes (id, change_set_id, stable_key, name, node_type, effective_from, work_location_id)
       VALUES ($1,$2,$3,'Sekolah sintetis','UNIT','2098-12-01'::date,$4)`,
      [randomUUID(), changeSetId, schoolKey, locationId],
    );
    await client.query(
      `INSERT INTO organization_nodes (id, change_set_id, stable_key, name, node_type, parent_node_key, effective_from)
       VALUES ($1,$2,$3,'Kelas sintetis','UNIT',$4,'2098-12-01'::date)`,
      [randomUUID(), changeSetId, classKey, schoolKey],
    );
    await client.query(
      `INSERT INTO organization_memberships (id, change_set_id, employee_id, node_key, is_primary, effective_from)
       VALUES ($1,$2,$3,$4,true,'2098-12-01'::date)`,
      [randomUUID(), changeSetId, employeeId, classKey],
    );
  }

  async function addLocation(latitude: number, longitude: number) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO attendance_work_locations(id,name,latitude,longitude,radius_meters,created_by_account_id)
       VALUES($1,'Synthetic Unit Location',$2,$3,200,$4)`,
      [id, latitude, longitude, accountId],
    );
    return id;
  }

  async function clock(latitude: number, longitude: number) {
    return app.inject({
      method: "POST", url: "/attendance/mobile/clock",
      headers: { cookie, "idempotency-key": randomUUID() },
      payload: { action: "check_in", latitude, longitude, accuracyMeters: 10, photoBase64 },
    });
  }

  it("ORG-005-3: checks against the unit's inherited location when the shift names none", async () => {
    await client.query("UPDATE attendance_schedule_versions SET work_location_id = NULL WHERE work_location_id = $1", [scheduleLocationId]);
    const unitLocationId = await addLocation(-6.9, 108.6);
    await placeEmployeeUnder(unitLocationId);

    const snapshot = await app.inject({ method: "GET", url: "/attendance/me/workforce", headers: { cookie } });
    expect(snapshot.statusCode, snapshot.body).toBe(200);
    expect(snapshot.json().mobileReadiness).toMatchObject({
      hasWorkLocation: true, workLocationId: unitLocationId, workLocationSource: "unit",
    });

    const response = await clock(-6.9, 108.6);
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({
      geofenceStatus: "inside", reviewState: "accepted", workLocationId: unitLocationId, workLocationSource: "unit",
    });
    const stored = await client.query(
      `SELECT evidence.work_location_id AS "workLocationId", event.safe_metadata AS metadata
       FROM attendance_mobile_evidence evidence JOIN attendance_events event ON event.id = evidence.event_id
       WHERE evidence.id = $1`,
      [response.json().evidenceId],
    );
    expect(stored.rows[0].workLocationId).toBe(unitLocationId);
    expect(stored.rows[0].metadata).toMatchObject({ workLocationSource: "unit" });

    const far = await clock(-6.7, 108.55);
    expect(far.json()).toMatchObject({ geofenceStatus: "outside", reviewState: "needs_review", workLocationSource: "unit" });
  });

  it("ORG-005-3: the shift's own location always wins over the unit's", async () => {
    const unitLocationId = await addLocation(-6.9, 108.6);
    await placeEmployeeUnder(unitLocationId);
    const atUnit = await clock(-6.9, 108.6);
    expect(atUnit.statusCode, atUnit.body).toBe(201);
    expect(atUnit.json()).toMatchObject({
      geofenceStatus: "outside", workLocationId: scheduleLocationId, workLocationSource: "shift",
    });
  });

  it("ORG-005-3: a switched-off shift location falls back to the unit's", async () => {
    const unitLocationId = await addLocation(-6.9, 108.6);
    await placeEmployeeUnder(unitLocationId);
    await client.query("UPDATE attendance_work_locations SET active = false WHERE id = $1", [scheduleLocationId]);
    const response = await clock(-6.9, 108.6);
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({ geofenceStatus: "inside", workLocationId: unitLocationId, workLocationSource: "unit" });
  });

  it("ORG-005-3: a misconfigured schedule day never takes the unit location", async () => {
    await client.query("UPDATE attendance_schedule_versions SET work_location_id = NULL WHERE work_location_id = $1", [scheduleLocationId]);
    const second = randomUUID();
    await client.query(
      `INSERT INTO attendance_schedule_assignments(id,employee_id,schedule_template_id,weekday_mask,effective_from,created_by_account_id)
       SELECT $1, employee_id, schedule_template_id, 127, '2001-01-01', created_by_account_id
       FROM attendance_schedule_assignments WHERE employee_id = $2 LIMIT 1`,
      [second, employeeId],
    );
    await placeEmployeeUnder(await addLocation(-6.9, 108.6));
    const response = await clock(-6.9, 108.6);
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({ geofenceStatus: "unassigned_location", reviewState: "needs_review", workLocationSource: null });
  });

  it("ORG-005-3: a switched-off unit location, or no unit at all, leaves the clock-in unassigned", async () => {
    await client.query("UPDATE attendance_schedule_versions SET work_location_id = NULL WHERE work_location_id = $1", [scheduleLocationId]);
    const none = await clock(-6.9, 108.6);
    expect(none.statusCode, none.body).toBe(201);
    expect(none.json()).toMatchObject({
      geofenceStatus: "unassigned_location", reviewState: "needs_review", workLocationId: null, workLocationSource: null,
    });

    const unitLocationId = await addLocation(-6.9, 108.6);
    await placeEmployeeUnder(unitLocationId);
    await client.query("UPDATE attendance_work_locations SET active = false WHERE id = $1", [unitLocationId]);
    const inactive = await clock(-6.9, 108.6);
    expect(inactive.json()).toMatchObject({ geofenceStatus: "unassigned_location", workLocationSource: null });
  });
});
