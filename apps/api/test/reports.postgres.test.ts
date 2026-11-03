// RPT-001 Package 1 acceptance against a real schema (docs/domain/hr-reports.md §10).
// Synthetic employees only; every test runs inside one rolled-back transaction. Scope is resolved
// from real role assignments, so these tests exercise the unit-scope rule itself.

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import { resolveUnitScopedPermissions } from "../src/modules/auth/permissions.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import { SENSITIVE_COLUMN_KEYS } from "../src/modules/reports/domain.js";
import { registerReportRoutes } from "../src/modules/reports/routes.js";

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

const FINANCE_ROLE = "10000000-0000-4000-8000-000000000003";
const MANAGEMENT_ROLE = "10000000-0000-4000-8000-000000000004";
const PERIOD = "from=2026-10-01&to=2026-10-31";

type Person = "alpha1" | "alpha2" | "beta1" | "nounit" | "outside" | "reader" | "unitReader" | "leader" | "unitLeader" | "plain";

describe.skipIf(!allowed)("RPT-001 HR reports", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let principal: AuthPrincipal;
  const units = {} as Record<"alpha" | "beta", string>;
  const people = {} as Record<Person, { employeeId: string; accountId: string; number: string }>;
  const tag = randomUUID().slice(0, 8);

  async function insertUnit(name: string) {
    const id = randomUUID();
    await client.query("INSERT INTO organizational_units(id, normalized_name, name) VALUES ($1,$2,$3)", [id, `${name}-${tag}`.toLowerCase(), `${name} ${tag}`]);
    return id;
  }

  async function insertPerson(key: Person, unitId: string | null, extra: { status?: string; type?: string } = {}) {
    const employeeId = randomUUID();
    const number = `RPT-${tag}-${key}`;
    await client.query(
      `INSERT INTO employees(id, employee_number, full_name, status, organizational_unit_id, employment_type, email, phone, started_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'+620000000000','2020-01-06')`,
      [employeeId, number, `Pegawai ${key} ${tag}`, extra.status ?? "active", unitId, extra.type ?? "Tetap", `${key}-${tag}@example.invalid`],
    );
    const accountId = randomUUID();
    await client.query(
      `INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1,$2,$3,'EMPLOYEE','active')`,
      [accountId, employeeId, `rpt-${accountId}@example.invalid`],
    );
    people[key] = { employeeId, accountId, number };
  }

  async function grant(who: Person, roleId: string, unitId: string | null) {
    await client.query(
      `INSERT INTO account_role_assignments(id, account_id, role_id, scope_type, organizational_unit_id, reason)
       VALUES ($1,$2,$3,$4,$5,'Synthetic RPT-001')`,
      [randomUUID(), people[who].accountId, roleId, unitId ? "unit" : "organization", unitId],
    );
  }

  function actAs(who: Person) {
    principal = { id: people[who].accountId, email: `${who}@example.invalid`, principalType: "EMPLOYEE" };
  }

  async function get(url: string) {
    return app.inject({ method: "GET", url });
  }

  /** Only this test's synthetic employees, whatever else the database holds. */
  function ours(items: Array<{ employeeNumber: string }>) {
    return items.filter((item) => item.employeeNumber.startsWith(`RPT-${tag}-`)).map((item) => item.employeeNumber.split("-").pop());
  }

  async function exportEvents() {
    return (await client.query<{ actor: string; payload: Record<string, unknown> }>(
      `SELECT actor_account_id AS actor, payload FROM access_audit_events WHERE action = 'reports.hr.exported' ORDER BY occurred_at`,
    )).rows;
  }

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    units.alpha = await insertUnit("Unit Alpha");
    units.beta = await insertUnit("Unit Beta");
    await insertPerson("alpha1", units.alpha);
    await insertPerson("alpha2", units.alpha, { status: "resigned", type: "Kontrak" });
    await insertPerson("beta1", units.beta, { type: "Kontrak" });
    await insertPerson("nounit", null);
    await insertPerson("outside", units.alpha);
    await client.query(
      `UPDATE employees SET management_scope = 'OUTSIDE_HCIS', management_scope_reason = 'BUMY',
              management_scope_marked_at = now(), management_scope_note = 'Synthetic' WHERE id = $1`,
      [people.outside.employeeId],
    );
    for (const key of ["reader", "unitReader", "leader", "unitLeader", "plain"] as const) await insertPerson(key, units.beta);
    await grant("reader", FINANCE_ROLE, null);
    await grant("unitReader", FINANCE_ROLE, units.alpha);
    await grant("leader", MANAGEMENT_ROLE, null);
    await grant("unitLeader", MANAGEMENT_ROLE, units.alpha);

    // Activity in October 2026 for alpha1 (unit Alpha) and beta1 (unit Beta).
    const leave = async (employeeId: string, policy: string, status: string, start: string, days: number) => client.query(
      `INSERT INTO leave_requests(id, employee_id, policy_key, status, start_on, end_on, working_days, hc_handling, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$5::date + ($6::int - 1),$6,'none',$7)`,
      [randomUUID(), employeeId, policy, status, start, days, randomUUID()],
    );
    await leave(people.alpha1.employeeId, "annual", "approved", "2026-10-05", 2);
    await leave(people.alpha1.employeeId, "sick", "approved", "2026-10-12", 1);
    await leave(people.alpha1.employeeId, "annual", "in_review", "2026-10-26", 1);
    await leave(people.alpha1.employeeId, "annual", "approved", "2026-11-02", 3);
    await leave(people.beta1.employeeId, "unpaid", "approved", "2026-10-07", 4);
    const overtime = async (employeeId: string, date: string, minutes: number, status: string) => client.query(
      `INSERT INTO attendance_overtime_requests(id, employee_id, work_date, requested_minutes, approved_minutes, status,
         requested_by_account_id, decided_by_account_id, decided_at, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Catatan pribadi')`,
      [randomUUID(), employeeId, date, minutes, status === "approved" ? minutes : null, status, people.leader.accountId,
        status === "approved" ? people.leader.accountId : null, status === "approved" ? new Date() : null],
    );
    await overtime(people.alpha1.employeeId, "2026-10-03", 90, "approved");
    await overtime(people.alpha1.employeeId, "2026-10-04", 30, "submitted");
    await overtime(people.beta1.employeeId, "2026-10-03", 60, "approved");
    const trip = async (employeeId: string, status: string, start: string, end: string) => client.query(
      `INSERT INTO business_trip_requests(id, employee_id, destination, purpose, start_on, end_on, status, idempotency_key)
       VALUES ($1,$2,'Bandung','Maksud perjalanan rahasia',$3,$4,$5,$6)`,
      [randomUUID(), employeeId, start, end, status, randomUUID()],
    );
    await trip(people.alpha1.employeeId, "APPROVED", "2026-10-10", "2026-10-12");
    await trip(people.alpha1.employeeId, "REJECTED", "2026-10-15", "2026-10-15");
    await trip(people.beta1.employeeId, "APPROVED", "2026-10-20", "2026-10-21");
    const training = async (employeeId: string, hours: number, status: string, end: string) => client.query(
      `INSERT INTO training_records(id, employee_id, source, role, title, category, organizer, start_on, end_on, hours, status,
         idempotency_key, reject_reason)
       VALUES ($1,$2,'EXTERNAL','PARTICIPANT','Seminar Pedagogi','PEDAGOGY','Lembaga Luar',$3,$3,$4,$5,$6,$7)`,
      [randomUUID(), employeeId, end, hours, status, randomUUID(), status === "REJECTED" ? "Bukti kurang" : null],
    );
    await training(people.alpha1.employeeId, 6, "VERIFIED", "2026-10-08");
    await training(people.alpha1.employeeId, 4, "REJECTED", "2026-10-09");
    await training(people.beta1.employeeId, 2.5, "VERIFIED", "2026-10-15");
    await training(people.alpha2.employeeId, 3, "VERIFIED", "2026-10-16");

    const config = { NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8 } as ApiConfig;
    const auth = { getSession: async () => ({ principal, expiresAt: "2099-01-01T00:00:00Z" }) } as never;
    app = Fastify({ logger: false });
    await registerReportRoutes(app, savepointPool(client), config, auth);
  });

  afterEach(async () => {
    try { await app?.close(); } finally {
      if (client) { await client.query("ROLLBACK"); client.release(); }
    }
  });

  it("RPT-001-A: without a report role every route is 403; Super Admin is 403 too", async () => {
    actAs("plain");
    for (const url of ["/admin/reports/hr/access", "/admin/reports/hr/employees", `/admin/reports/hr/leave/export?format=csv&${PERIOD}`]) {
      const response = await get(url);
      expect(response.statusCode, url).toBe(403);
      expect(response.json().code).toBe("FORBIDDEN");
    }
    principal = { id: people.plain.accountId, email: "legacy@example.invalid", principalType: "SUPER_ADMIN" };
    expect((await get("/admin/reports/hr/employees")).statusCode).toBe(403);
    // An expired assignment grants nothing.
    await client.query("UPDATE account_role_assignments SET ends_on = current_date - 1 WHERE account_id = $1", [people.reader.accountId]);
    actAs("reader");
    expect((await get("/admin/reports/hr/employees")).statusCode).toBe(403);
  });

  it("RPT-001-B: a unit-scoped reader sees only its unit in all five reports, and is refused another unit", async () => {
    actAs("unitReader");
    const access = await get("/admin/reports/hr/access");
    expect(access.statusCode, access.body).toBe(200);
    expect(access.json().scope).toEqual({ type: "unit", units: [{ id: units.alpha, name: `Unit Alpha ${tag}` }] });
    expect(access.json().canExport).toBe(false);
    expect(access.json().filters.units).toEqual([{ id: units.alpha, name: `Unit Alpha ${tag}` }]);

    const employees = await get("/admin/reports/hr/employees?status=all&pageSize=100");
    expect(employees.statusCode, employees.body).toBe(200);
    // OUTSIDE_HCIS and other units never appear; the total counts the unit only.
    expect(ours(employees.json().items).sort()).toEqual(["alpha1", "alpha2"]);
    expect(employees.json().pagination.total).toBe(2);
    expect(ours((await get("/admin/reports/hr/employees")).json().items)).toEqual(["alpha1"]);

    const leave = (await get(`/admin/reports/hr/leave?${PERIOD}&pageSize=100`)).json();
    expect(ours(leave.items)).toEqual(["alpha1"]);
    expect(leave.items[0]).toMatchObject({ annualDays: 2, unpaidDays: 0, otherDays: 1, totalDays: 3, approvedCount: 2, pendingCount: 1 });
    const overtime = (await get(`/admin/reports/hr/overtime?${PERIOD}`)).json();
    expect(ours(overtime.items)).toEqual(["alpha1"]);
    expect(overtime.items[0]).toMatchObject({ approvedCount: 1, approvedHours: 1.5, pendingCount: 1 });
    const trips = (await get(`/admin/reports/hr/trips?${PERIOD}`)).json();
    expect(trips.items).toHaveLength(1);
    expect(trips.items[0]).toMatchObject({ destination: "Bandung", startOn: "2026-10-10", endOn: "2026-10-12", days: 3, statusLabel: "Disetujui" });
    const training = (await get(`/admin/reports/hr/training?${PERIOD}&pageSize=100`)).json();
    // The resigned alpha2 appears because of verified hours; rejected hours do not count.
    expect(ours(training.items).sort()).toEqual(["alpha1", "alpha2"]);
    expect(training.items.find((item: { employeeNumber: string }) => item.employeeNumber === people.alpha1.number))
      .toMatchObject({ externalHours: 6, totalHours: 6, recordCount: 1 });

    const other = await get(`/admin/reports/hr/employees?unitId=${units.beta}`);
    expect(other.statusCode).toBe(403);
    expect(other.json().code).toBe("REPORT_SCOPE_FORBIDDEN");
  });

  it("RPT-001-B: an organization reader sees every managed employee, never OUTSIDE_HCIS", async () => {
    actAs("reader");
    const all = (await get("/admin/reports/hr/employees?status=all&pageSize=100")).json();
    expect(ours(all.items).sort()).toEqual(["alpha1", "alpha2", "beta1", "leader", "nounit", "plain", "reader", "unitLeader", "unitReader"]);
    expect(ours((await get("/admin/reports/hr/employees?employmentType=Kontrak&status=all&pageSize=100")).json().items).sort())
      .toEqual(["alpha2", "beta1"]);
    const leave = (await get(`/admin/reports/hr/leave?${PERIOD}&unitId=${units.beta}&q=beta1`)).json();
    expect(leave.items).toHaveLength(1);
    expect(leave.items[0]).toMatchObject({ unpaidDays: 4, totalDays: 4 });
    expect((await get("/admin/reports/hr/access")).json().filters.employmentTypes).toEqual(expect.arrayContaining(["Kontrak", "Tetap"]));
  });

  it("RPT-001-C/D: Pembaca Laporan cannot export; Pimpinan exports CSV and XLSX, each audited without names", async () => {
    actAs("reader");
    const refused = await get(`/admin/reports/hr/leave/export?format=csv&${PERIOD}`);
    expect(refused.statusCode).toBe(403);
    expect(await exportEvents()).toHaveLength(0);

    actAs("unitLeader");
    expect((await get("/admin/reports/hr/access")).json()).toMatchObject({ canExport: true, exportScope: { type: "unit", unitIds: [units.alpha] } });
    const csv = await get("/admin/reports/hr/employees/export?format=csv&status=all");
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["cache-control"]).toBe("no-store");
    expect(csv.headers["content-disposition"]).toMatch(/^attachment; filename="hcis-laporan-employees-\d{4}-\d{2}-\d{2}\.csv"$/);
    const lines = csv.body.replace(/^\uFEFF/, "").trim().split("\r\n");
    expect(lines[0]).toBe('"NIP","Nama","Unit","Jabatan","Jenis kepegawaian","Status kepegawaian","Status","Mulai bekerja","Berakhir"');
    expect(lines.slice(1).filter((line) => line.includes(`RPT-${tag}-`))).toHaveLength(2);
    expect(csv.body).not.toContain("example.invalid");
    expect(csv.body).not.toContain("+620000000000");

    const xlsx = await get(`/admin/reports/hr/trips/export?format=xlsx&${PERIOD}`);
    expect(xlsx.statusCode, xlsx.body).toBe(200);
    expect(xlsx.headers["content-type"]).toContain("spreadsheetml");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(xlsx.rawPayload as unknown as ArrayBuffer);
    const text = JSON.stringify(workbook.worksheets[0]!.getSheetValues());
    expect(text).toContain("Rekap Perjalanan Dinas");
    expect(text).toContain("Bandung");
    expect(text).not.toContain("Maksud perjalanan rahasia");

    const events = await exportEvents();
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.actor === people.unitLeader.accountId)).toBe(true);
    expect(events[0]!.payload).toEqual({
      report: "employees", format: "csv", filters: { unitId: null, status: "all", employmentType: null },
      scope: "unit", unitCount: 1, rows: 2,
    });
    expect(events[1]!.payload).toMatchObject({ report: "trips", format: "xlsx", filters: { unitId: null, from: "2026-10-01", to: "2026-10-31" }, rows: 1 });
    expect(JSON.stringify(events)).not.toContain(tag);

    // An export never widens past the read scope, and free-text search is refused.
    expect((await get(`/admin/reports/hr/employees/export?format=csv&unitId=${units.beta}`)).statusCode).toBe(403);
    expect((await get("/admin/reports/hr/employees/export?format=csv&q=alpha")).statusCode).toBe(400);
  });

  it("RPT-001-E: no sensitive column in any report or file", async () => {
    actAs("leader");
    for (const report of ["employees", "leave", "overtime", "trips", "training"]) {
      const body = (await get(`/admin/reports/hr/${report}?${PERIOD}&status=all&pageSize=100`)).json();
      const keys = new Set([...body.columns.map((column: { key: string }) => column.key), ...body.items.flatMap(Object.keys)]);
      for (const key of SENSITIVE_COLUMN_KEYS) expect(keys.has(key), `${report} ${key}`).toBe(false);
      const file = await get(`/admin/reports/hr/${report}/export?format=csv&${report === "employees" ? "status=all" : PERIOD}`);
      expect(file.statusCode, file.body).toBe(200);
      for (const secret of ["example.invalid", "+620000000000", "Catatan pribadi", "Maksud perjalanan rahasia"]) {
        expect(file.body, `${report} ${secret}`).not.toContain(secret);
      }
    }
  });

  it("RPT-001-G: page size, period and report key are validated", async () => {
    actAs("reader");
    expect((await get("/admin/reports/hr/employees?pageSize=101")).statusCode).toBe(400);
    expect((await get("/admin/reports/hr/leave")).statusCode).toBe(400);
    expect((await get("/admin/reports/hr/leave?from=2026-10-31&to=2026-10-01")).statusCode).toBe(400);
    expect((await get("/admin/reports/hr/leave?from=2025-01-01&to=2026-01-02")).statusCode).toBe(400);
    expect((await get("/admin/reports/hr/payroll")).statusCode).toBe(404);
  });

  it("RPT-001-H: the session hint lists unit-scoped report permissions only", async () => {
    const hint = async (who: Person) => resolveUnitScopedPermissions(savepointPool(client),
      { id: people[who].accountId, email: "x@example.invalid", principalType: "EMPLOYEE" });
    expect(await hint("unitLeader")).toEqual(["reports.export.organization", "reports.read.organization"]);
    expect(await hint("unitReader")).toEqual(["reports.read.organization"]);
    expect(await hint("leader")).toEqual([]);
    expect(await hint("plain")).toEqual([]);
  });
});
