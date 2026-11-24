// TRIP-002 D-22: uang saku perjalanan dinas terkunci sampai dinyalakan, dan setiap penyalaan
// menjalankan pemeriksaan kesiapannya lebih dulu — yang pertama maupun penyalaan ulang sesudah
// dimatikan. Keputusan owner 24 November 2026.
//
// Yang dijaga berkas ini, lewat route yang sama dengan yang dipakai layar:
//
//   * katalog klasifikasi kosong, pemetaan golongan kurang, pegawai tanpa golongan, atau tarif
//     yang belum ditetapkan MENAHAN penyalaan, dan saklarnya tetap mati;
//   * sementara terkunci, dua pintu masuk uang saku menolak 409 TRIP_PER_DIEM_NOT_ACTIVE, tetapi
//     jalur lain — cuti — berjalan seperti biasa;
//   * mematikan lalu menyalakan lagi menjalankan pemeriksaan yang sama sekali lagi, jadi data
//     yang rusak di antaranya tetap tertahan.
//
// Pasangannya di sisi rilis adalah scripts/mi8/test-trip-002-gate.sh, yang membuktikan hal yang
// sama untuk gerbang rilis: pemetaan golongan yang kosong menahan rilis selagi uang saku menyala
// dan meloloskannya selagi mati.
//
// Loopback CI database only; semua orang sintetis; setiap tulisan di-ROLLBACK.

import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import { AuthService, type AuthPrincipal } from "../src/modules/auth/service.js";
import { encodeWorkingWeekdays } from "../src/modules/leave/domain/working-calendar.js";
import { registerEmployeeLeaveRoutes } from "../src/modules/leave/employee-routes.js";
import { registerTripAdvanceRoutes } from "../src/modules/trip-advances/routes.js";

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
    const statement = String(text).trim().toUpperCase().replace(/;$/, "").trim();
    if (statement === "BEGIN") return client.query(`SAVEPOINT pd_sp_${++depth}`);
    if (statement === "COMMIT") {
      const name = `pd_sp_${depth}`;
      depth -= 1;
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    if (statement === "ROLLBACK") {
      const name = `pd_sp_${depth}`;
      depth -= 1;
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    return client.query(text, values);
  };
  const handle = { query: run, release: () => {} };
  return { query: run, connect: async () => handle } as unknown as Pool;
}

function jakartaToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function inDays(days: number): string {
  const base = new Date(`${jakartaToday()}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

interface Finding { severity: string; kind: string; detail: string }

describe.skipIf(!allowed)("TRIP-002 D-22: saklar uang saku perjalanan dinas (PostgreSQL)", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;

  /** Who the session is, and what the session may do. Both are swapped per case. */
  let principal: AuthPrincipal;
  let permissions: string[] = [];

  let employeeId = "";
  let employeeAccountId = "";
  let employeeNumber = "";
  let adminAccountId = "";
  let tripId = "";
  let approverEmployeeId = "";
  let employeeCookie = "";
  const CODE = "GURU_SINTETIS";

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    // The readiness check is a question about EVERY active employee, so this file needs a world
    // it can account for. The shared CI database is not one: suites that commit leave people
    // behind, and a run of the whole suite found 261 of them. Two things make the world knowable
    // without a database of its own:
    //
    //   * REPEATABLE READ, so the snapshot is taken here and a suite committing a new employee
    //     halfway through this test cannot appear between the retirement below and the check; and
    //   * retiring everyone who was already here, inside this transaction, which is rolled back.
    //
    // Nothing outside this transaction changes, and a parallel suite's own people are invisible
    // to it anyway.
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await client.query(
      "UPDATE employees SET status = 'resigned' WHERE status = 'active' AND removed_at IS NULL",
    );
    const transactionPool = savepointPool(client);

    // Production runs LEGACY everywhere; the leave half of this file depends on that.
    await client.query("DELETE FROM organization_rollout_settings");
    await client.query(
      `INSERT INTO leave_calendar_settings(singleton, timezone, working_weekday_mask)
       VALUES (true, 'Asia/Jakarta', $1)
       ON CONFLICT (singleton) DO UPDATE SET working_weekday_mask = EXCLUDED.working_weekday_mask`,
      [encodeWorkingWeekdays([1, 2, 3, 4, 5])],
    );

    const unitId = randomUUID();
    await client.query(
      "INSERT INTO organizational_units(id, normalized_name, name) VALUES ($1, $2, 'Unit Uang Saku Sintetis')",
      [unitId, `trip002-act-${unitId}`],
    );

    // The approver: the unit's leave approver and the requester's manager, so both the leave
    // chain and the trip chain resolve without touching the published chart.
    approverEmployeeId = randomUUID();
    await client.query(
      `INSERT INTO employees(id, employee_number, full_name, status, started_on,
                             organizational_unit_id, leave_entitlement_group, management_scope)
       VALUES ($1, $2, 'Penyetuju Sintetis', 'active', '2020-01-06', $3, 'non_education', 'MANAGED')`,
      [approverEmployeeId, `TRIP002A-${approverEmployeeId.slice(0, 8)}`, unitId],
    );
    const approverAccountId = randomUUID();
    await client.query(
      "INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1, $2, $3, 'EMPLOYEE', 'active')",
      [approverAccountId, approverEmployeeId, `trip002-approver-${approverAccountId}@example.invalid`],
    );

    employeeId = randomUUID();
    employeeNumber = `TRIP002E-${employeeId.slice(0, 8)}`;
    await client.query(
      `INSERT INTO employees(id, employee_number, full_name, status, started_on,
                             organizational_unit_id, leave_entitlement_group, management_scope,
                             direct_manager_employee_id)
       VALUES ($1, $2, 'Pegawai Sintetis', 'active', '2020-01-06', $3, 'non_education', 'MANAGED', $4)`,
      [employeeId, employeeNumber, unitId, approverEmployeeId],
    );
    employeeAccountId = randomUUID();
    await client.query(
      "INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1, $2, $3, 'EMPLOYEE', 'active')",
      [employeeAccountId, employeeId, `trip002-employee-${employeeAccountId}@example.invalid`],
    );
    await client.query(
      "UPDATE organizational_units SET leave_approver_employee_id = $2 WHERE id = $1",
      [unitId, approverEmployeeId],
    );

    // Human Capital's own account: a SUPER_ADMIN row is enough, because the permissions the
    // routes read come from the injected authorization context, not from role rows.
    adminAccountId = randomUUID();
    await client.query(
      `INSERT INTO accounts(id, email, principal_type, status,
                            mfa_enabled_at, mfa_secret_ciphertext, mfa_secret_iv, mfa_secret_tag)
       VALUES ($1, $2, 'SUPER_ADMIN', 'active', now(), 'synthetic', 'synthetic', 'synthetic')`,
      [adminAccountId, `trip002-hc-${adminAccountId}@example.invalid`],
    );

    // A complete, healthy world: one classification in force, mapped, bound to EVERY active
    // employee this transaction can see, with the two paying rates in place. Each case breaks
    // exactly one thing. The approver needs a binding too — the readiness check asks about
    // people, not about the requester, so an approver with no classification would hold
    // activation on their own and every case would fail for the wrong reason.
    await client.query(
      `INSERT INTO job_classifications(id, code, name, family, effective_from)
       VALUES ($1, $2, 'Guru Sintetis', 'FUNCTIONAL', '2020-01-06')`,
      [randomUUID(), CODE],
    );
    for (const who of [employeeId, approverEmployeeId]) {
      const actionId = randomUUID();
      const employment = randomUUID();
      await client.query(
        `INSERT INTO employments(id, employee_id, started_on, start_basis, source, opened_by_action_id)
         VALUES ($1, $2, '2020-01-06', 'RECORDED', 'BASELINE_FROM_MASTER', $3)`,
        [employment, who, actionId],
      );
      await client.query(
        `INSERT INTO employment_actions(id, employee_id, employment_id, action_type)
         VALUES ($1, $2, $3, 'BASELINE')`,
        [actionId, who, employment],
      );
      await client.query(
        `INSERT INTO employment_placements
           (id, employment_id, kind, org_node_key, job_title_label, job_classification_code,
            effective_from, effective_from_basis, opened_by_action_id)
         VALUES ($1, $2, 'PRIMARY', $3, 'Guru Sintetis', $4, '2020-01-06', 'RECORDED', $5)`,
        [randomUUID(), employment, randomUUID(), CODE, actionId],
      );
    }
    await client.query(
      `INSERT INTO trip_per_diem_golongan_map(job_classification_code, golongan, updated_by_account_id)
       VALUES ($1, 'STAF', $2)`,
      [CODE, adminAccountId],
    );
    for (const wilayah of ["DALAM_DAERAH", "LUAR_DAERAH"]) {
      await client.query(
        `INSERT INTO trip_per_diem_rates(id, golongan, wilayah, effective_from, daily_amount,
                                         decree_reference, created_by_account_id)
         VALUES ($1, 'STAF', $2, '2026-07-10', 60000, 'SK 01.111/YSQ/VII/2026 (sintetis)', $3)`,
        [randomUUID(), wilayah, adminAccountId],
      );
    }

    // A trip of the employee's own, approved, with a chain the advance can copy.
    tripId = randomUUID();
    await client.query(
      `INSERT INTO business_trip_requests
         (id, employee_id, destination, purpose, start_on, end_on, status, idempotency_key)
       VALUES ($1, $2, 'Jakarta', 'Rapat koordinasi yayasan sintetis', $3, $4, 'APPROVED', $5)`,
      [tripId, employeeId, inDays(10), inDays(11), randomUUID()],
    );
    await client.query(
      `INSERT INTO business_trip_approval_steps(id, request_id, step_order, approver_employee_id, sources, status)
       VALUES ($1, $2, 1, $3, ARRAY['LINE_MANAGER'], 'approved')`,
      [randomUUID(), tripId, approverEmployeeId],
    );

    // The world this file reasons about must be exactly the two people it made; if the
    // retirement above ever stops working, every case would fail for the wrong reason.
    const population = await client.query<{ total: number }>(
      "SELECT count(*)::int AS total FROM employees WHERE status = 'active' AND removed_at IS NULL",
    );
    expect(population.rows[0]!.total, "the fixture must be the only active population").toBe(2);

    principal = { id: employeeAccountId, email: "employee@example.invalid", principalType: "EMPLOYEE" };
    permissions = [];

    const config = {
      NODE_ENV: "test", HOST: "127.0.0.1", PORT: 3001, DATABASE_URL: databaseUrl!,
      AUTH_MODE: "local", AUTH_ENCRYPTION_KEY: "17".repeat(32), AUTH_SESSION_TTL_HOURS: 8,
    } as ApiConfig;
    const auth = {
      getSession: async () => ({ principal, expiresAt: "2099-01-01T00:00:00Z" }),
      getAuthorizationContext: async () => ({ organizationPermissions: permissions }),
    } as unknown as Pick<AuthService, "getSession" | "getAuthorizationContext">;

    // The leave routes build their own AuthService and read a cookie, so the leave half of this
    // file signs in for real rather than injecting a principal.
    const realAuth = new AuthService(transactionPool, config.AUTH_ENCRYPTION_KEY!, 8, false);
    const session = await realAuth.createSessionForAccountId(employeeAccountId, {
      ipAddress: "127.0.0.1", userAgent: "rollback-only-trip002-activation-test",
    });
    employeeCookie = session.setCookie.split(";")[0]!;

    app = Fastify({ logger: false });
    await registerTripAdvanceRoutes(app, transactionPool, config, auth);
    await registerEmployeeLeaveRoutes(app, transactionPool, config);
  });

  afterEach(async () => {
    try { await app?.close(); } finally {
      if (client) { await client.query("ROLLBACK"); client.release(); }
    }
  });

  // ------------------------------------------------------------------ helpers

  function asAdmin(...granted: string[]) {
    principal = { id: adminAccountId, email: "hc@example.invalid", principalType: "SUPER_ADMIN" };
    permissions = granted.length > 0 ? granted : ["trip_advances.read", "trip_per_diem.manage"];
  }

  function asEmployee() {
    principal = { id: employeeAccountId, email: "employee@example.invalid", principalType: "EMPLOYEE" };
    permissions = [];
  }

  const readActivation = () => app.inject({ method: "GET", url: "/admin/trip-per-diem-activation" });

  const writeActivation = (state: "ACTIVE" | "INACTIVE", reason = "Keputusan HC sintetis untuk uji") =>
    app.inject({ method: "POST", url: "/admin/trip-per-diem-activation", payload: { state, reason } });

  async function storedState(): Promise<string> {
    const row = await client.query<{ state: string }>(
      "SELECT state FROM trip_per_diem_activation ORDER BY recorded_seq DESC LIMIT 1",
    );
    return row.rows[0]?.state ?? "INACTIVE";
  }

  /** Turn it on from a healthy world, and fail loudly if the world was not healthy. */
  async function activate() {
    asAdmin();
    const response = await writeActivation("ACTIVE");
    expect(response.statusCode, response.body).toBe(200);
  }

  function kinds(body: string): string[] {
    return ((JSON.parse(body) as { blockers?: Finding[] }).blockers ?? []).map((finding) => finding.kind);
  }

  // ------------------------------------------------- it starts locked, and says why

  it("ships locked: nothing has been written, and the state in force is INACTIVE", async () => {
    asAdmin();
    const response = await readActivation();
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as { state: string; ready: boolean; changedAt: string | null };
    expect(body.state).toBe("INACTIVE");
    expect(body.changedAt).toBeNull();
    expect(body.ready).toBe(true);
    const rows = await client.query("SELECT 1 FROM trip_per_diem_activation");
    expect(rows.rowCount).toBe(0);
  });

  // --------------------------------------------- the check that holds activation

  it("an empty classification catalogue holds activation, and the switch stays off", async () => {
    await client.query("DELETE FROM trip_per_diem_golongan_map");
    await client.query("DELETE FROM job_classifications");
    asAdmin();
    const response = await writeActivation("ACTIVE");
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().code).toBe("TRIP_PER_DIEM_NOT_READY");
    expect(kinds(response.body)).toContain("CATALOGUE_EMPTY");
    expect(await storedState()).toBe("INACTIVE");
  });

  it("a classification in force that nobody mapped holds activation, and is named", async () => {
    await client.query("DELETE FROM trip_per_diem_golongan_map");
    asAdmin();
    const response = await writeActivation("ACTIVE");
    expect(response.statusCode, response.body).toBe(409);
    const blockers = (response.json() as { blockers: Finding[] }).blockers;
    expect(blockers.some((finding) => finding.kind === "CLASSIFICATION_UNMAPPED" && finding.detail === CODE)).toBe(true);
    expect(await storedState()).toBe("INACTIVE");
  });

  it("an eligible employee who resolves to no golongan holds activation, and is named", async () => {
    // Nobody is placed on this classification, so only the person-side check can see them.
    const strandedId = randomUUID();
    const strandedNumber = `TRIP002X-${strandedId.slice(0, 8)}`;
    await client.query(
      `INSERT INTO employees(id, employee_number, full_name, status, started_on, management_scope)
       VALUES ($1, $2, 'Pegawai Tanpa Klasifikasi', 'active', '2020-01-06', 'MANAGED')`,
      [strandedId, strandedNumber],
    );
    asAdmin();
    const response = await writeActivation("ACTIVE");
    expect(response.statusCode, response.body).toBe(409);
    const blockers = (response.json() as { blockers: Finding[] }).blockers;
    expect(blockers.some((finding) => finding.kind === "EMPLOYEE_UNRESOLVED" && finding.detail === strandedNumber)).toBe(true);
    expect(await storedState()).toBe("INACTIVE");
  });

  it("a golongan somebody resolves to without a rate holds activation", async () => {
    // trip_per_diem_rates is append-only in production; a fixture resets it as a replica session.
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query("DELETE FROM trip_per_diem_rates WHERE wilayah = 'LUAR_DAERAH'");
    await client.query("SET LOCAL session_replication_role = 'origin'");
    asAdmin();
    const response = await writeActivation("ACTIVE");
    expect(response.statusCode, response.body).toBe(409);
    const blockers = (response.json() as { blockers: Finding[] }).blockers;
    expect(blockers.some((finding) => finding.kind === "RATE_MISSING" && finding.detail === "STAF LUAR_DAERAH")).toBe(true);
    expect(await storedState()).toBe("INACTIVE");
  });

  it("a classification published for a future date only warns, and lets activation through", async () => {
    await client.query(
      `INSERT INTO job_classifications(id, code, name, family, effective_from)
       VALUES ($1, 'GURU_BESAR_SINTETIS', 'Guru Besar Sintetis', 'FUNCTIONAL', $2)`,
      [randomUUID(), inDays(30)],
    );
    asAdmin();
    const read = await readActivation();
    const warnings = (read.json() as { warnings: Finding[]; ready: boolean });
    expect(warnings.ready).toBe(true);
    expect(warnings.warnings.some((finding) => finding.kind === "CLASSIFICATION_UNMAPPED_FUTURE")).toBe(true);
    const response = await writeActivation("ACTIVE");
    expect(response.statusCode, response.body).toBe(200);
    expect(await storedState()).toBe("ACTIVE");
  });

  it("a complete world activates, and the decision is recorded with its reason", async () => {
    asAdmin();
    const response = await writeActivation("ACTIVE", "Katalog dan pemetaan golongan sudah lengkap");
    expect(response.statusCode, response.body).toBe(200);
    expect(await storedState()).toBe("ACTIVE");
    const row = await client.query<{ reason: string; readiness: Record<string, number>; account: string }>(
      `SELECT reason, readiness, changed_by_account_id AS account
         FROM trip_per_diem_activation ORDER BY recorded_seq DESC LIMIT 1`,
    );
    expect(row.rows[0]!.reason).toBe("Katalog dan pemetaan golongan sudah lengkap");
    expect(row.rows[0]!.account).toBe(adminAccountId);
    const event = await client.query<{ type: string; note: string }>(
      `SELECT event_type AS type, note FROM trip_advance_events
        WHERE event_type = 'trip_advance.per_diem.activated' AND advance_id IS NULL`,
    );
    expect(event.rowCount).toBe(1);
    expect(event.rows[0]!.note).toBe("Katalog dan pemetaan golongan sudah lengkap");
  });

  // ------------------------------------- switching off, and switching on again

  it("switching off is always allowed, is audited, and shuts the doors again", async () => {
    await activate();
    const off = await writeActivation("INACTIVE", "Dimatikan sementara untuk perbaikan data");
    expect(off.statusCode, off.body).toBe(200);
    expect(await storedState()).toBe("INACTIVE");
    const event = await client.query(
      `SELECT 1 FROM trip_advance_events WHERE event_type = 'trip_advance.per_diem.deactivated'`,
    );
    expect(event.rowCount).toBe(1);

    asEmployee();
    const estimate = await app.inject({
      method: "GET", url: `/trip-advances/me/estimate?tripId=${tripId}&wilayah=LUAR_DAERAH`,
    });
    expect(estimate.statusCode, estimate.body).toBe(409);
    expect(estimate.json().code).toBe("TRIP_PER_DIEM_NOT_ACTIVE");
  });

  it("switching on again runs the same check again: data broken in between still holds it", async () => {
    await activate();
    expect((await writeActivation("INACTIVE", "Dimatikan dulu, data akan dirapikan")).statusCode).toBe(200);
    // Somebody removes the mapping while the feature is off. The second activation must not
    // ride on the first one's clean bill of health.
    await client.query("DELETE FROM trip_per_diem_golongan_map");
    const again = await writeActivation("ACTIVE", "Dicoba dinyalakan lagi tanpa memperbaiki");
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().code).toBe("TRIP_PER_DIEM_NOT_READY");
    expect(await storedState()).toBe("INACTIVE");

    await client.query(
      `INSERT INTO trip_per_diem_golongan_map(job_classification_code, golongan, updated_by_account_id)
       VALUES ($1, 'STAF', $2)`,
      [CODE, adminAccountId],
    );
    const fixed = await writeActivation("ACTIVE", "Pemetaan golongan sudah diisi lagi");
    expect(fixed.statusCode, fixed.body).toBe(200);
    expect(await storedState()).toBe("ACTIVE");
  });

  it("asking for the state it already holds is refused, so the history stays meaningful", async () => {
    asAdmin();
    const first = await writeActivation("INACTIVE", "Mematikan yang sudah mati");
    expect(first.statusCode, first.body).toBe(409);
    expect(first.json().code).toBe("TRIP_PER_DIEM_ACTIVATION_UNCHANGED");
    await activate();
    const second = await writeActivation("ACTIVE", "Menyalakan yang sudah menyala");
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json().code).toBe("TRIP_PER_DIEM_ACTIVATION_UNCHANGED");
  });

  it("a decision without a written reason is refused", async () => {
    asAdmin();
    const response = await app.inject({
      method: "POST", url: "/admin/trip-per-diem-activation", payload: { state: "ACTIVE", reason: "singkat" },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(await storedState()).toBe("INACTIVE");
  });

  it("reading the lock needs only read access; opening it needs trip_per_diem.manage", async () => {
    asAdmin("trip_advances.read");
    const read = await readActivation();
    expect(read.statusCode, read.body).toBe(200);
    const refused = await writeActivation("ACTIVE");
    expect(refused.statusCode, refused.body).toBe(403);

    asEmployee();
    const outsider = await readActivation();
    expect(outsider.statusCode, outsider.body).toBe(403);
  });

  // --------------------------------------------- what the lock does, and does not

  it("while locked, the estimate and a new advance are refused and nothing is written", async () => {
    asEmployee();
    const estimate = await app.inject({
      method: "GET", url: `/trip-advances/me/estimate?tripId=${tripId}&wilayah=LUAR_DAERAH`,
    });
    expect(estimate.statusCode, estimate.body).toBe(409);
    expect(estimate.json().code).toBe("TRIP_PER_DIEM_NOT_ACTIVE");

    const created = await app.inject({
      method: "POST", url: "/trip-advances/me",
      payload: {
        businessTripId: tripId, wilayah: "LUAR_DAERAH", amount: 0,
        purpose: "Uang muka rapat koordinasi sintetis", idempotencyKey: randomUUID(),
      },
    });
    expect(created.statusCode, created.body).toBe(409);
    expect(created.json().code).toBe("TRIP_PER_DIEM_NOT_ACTIVE");
    const rows = await client.query("SELECT 1 FROM trip_advances WHERE employee_id = $1", [employeeId]);
    expect(rows.rowCount).toBe(0);
  });

  it("once unlocked the same two doors open, so the refusal was the lock and not a broken feature", async () => {
    await activate();
    asEmployee();
    const estimate = await app.inject({
      method: "GET", url: `/trip-advances/me/estimate?tripId=${tripId}&wilayah=LUAR_DAERAH`,
    });
    expect(estimate.statusCode, estimate.body).toBe(200);
    expect((estimate.json() as { golongan: string }).golongan).toBe("STAF");

    const created = await app.inject({
      method: "POST", url: "/trip-advances/me",
      payload: {
        businessTripId: tripId, wilayah: "LUAR_DAERAH", amount: 0,
        purpose: "Uang muka rapat koordinasi sintetis", idempotencyKey: randomUUID(),
      },
    });
    expect(created.statusCode, created.body).toBe(201);
  });

  it("while locked, reading one's own register still works: only the two doors are shut", async () => {
    asEmployee();
    const list = await app.inject({ method: "GET", url: "/trip-advances/me" });
    expect(list.statusCode, list.body).toBe(200);
    expect((list.json() as { items: unknown[] }).items).toEqual([]);
  });

  it("while locked, a leave request still goes through: the lock is the per diem feature's alone", async () => {
    asEmployee();
    const leave = await app.inject({
      method: "POST", url: "/leave/me/annual/submit",
      headers: { cookie: employeeCookie },
      payload: {
        startOn: inDays(30), endOn: inDays(31),
        reason: "Acara keluarga sintetis", idempotencyKey: randomUUID(),
      },
    });
    expect(leave.statusCode, leave.body).toBe(201);
    const stored = await client.query("SELECT 1 FROM leave_requests WHERE employee_id = $1", [employeeId]);
    expect(stored.rowCount).toBe(1);
    expect(await storedState()).toBe("INACTIVE");
  });
});
