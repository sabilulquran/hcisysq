// EMP-005 S2B §8.7, sisi pengaju: sebuah data pegawai yang ditandai "di luar pengelolaan HCIS"
// tidak dapat membuat pengajuan baru untuk dirinya sendiri di modul mana pun, dan pegawai
// MANAGED tidak terpengaruh.
//
// Pelengkap `employee-management-scope-consumers.postgres.test.ts`, yang menjaga sisi approver.
// Sebelum perbaikan ini, perjalanan dinas, uang muka, pinjaman, reimbursement, lembur, klarifikasi
// kehadiran, tukar shift, pengaturan kerja, penilaian diri, dan catatan pelatihan hanya memeriksa
// akun aktif + pegawai aktif, sehingga data yang ditandai tetap bisa mengajukan.
//
// Loopback CI database only; synthetic people; every write is rolled back.

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import { registerAttendanceShiftSwapRoutes } from "../src/modules/attendance/shift-swap-routes.js";
import { registerWorkArrangementRoutes } from "../src/modules/attendance/work-arrangement-routes.js";
import { registerAttendanceWorkforceRoutes } from "../src/modules/attendance/workforce-routes.js";
import { AuthService, type AuthPrincipal } from "../src/modules/auth/service.js";
import { OUTSIDE_HCIS_CODE } from "../src/modules/employees/management-scope.js";
import { registerLoanRoutes } from "../src/modules/loans/routes.js";
import { registerPerformanceRoutes } from "../src/modules/performance/routes.js";
import { registerReimbursementRoutes } from "../src/modules/reimbursements/routes.js";
import { registerTrainingRoutes } from "../src/modules/training/routes.js";
import { registerTripAdvanceRoutes } from "../src/modules/trip-advances/routes.js";
import { registerTripRoutes } from "../src/modules/trips/routes.js";

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
    if (statement.startsWith("BEGIN")) return client.query(`SAVEPOINT scope_req_${++depth}`);
    if (statement.startsWith("COMMIT")) {
      const name = `scope_req_${depth}`;
      depth -= 1;
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    if (statement.startsWith("ROLLBACK")) {
      const name = `scope_req_${depth}`;
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

interface Submission {
  /** Module label for the test name. */
  module: string;
  url: string;
  payload: () => object;
  /**
   * True when a MANAGED requester must get a successful answer. False when the endpoint needs
   * fixtures this suite deliberately does not build (a trip, an open review): the guard runs
   * before them, so the MANAGED case is asserted only to be refused for some *other* reason.
   */
  managedSucceeds: boolean;
}

describe.skipIf(!allowed)("EMP-005 S2B §8.7: a requester outside HCIS management files nothing new", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let principal: AuthPrincipal;
  let requesterEmployeeId = "";

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    // LEGACY authority resolution is what production runs today.
    await client.query("DELETE FROM organization_rollout_settings");
    const unitId = randomUUID();
    await client.query(
      "INSERT INTO organizational_units(id, normalized_name, name) VALUES ($1, $2, 'Unit EMP-005 pengaju')",
      [unitId, `emp005-req-${unitId}`],
    );
    const people = {} as Record<"requester" | "manager" | "unitApprover", { employeeId: string; accountId: string }>;
    for (const who of ["manager", "unitApprover", "requester"] as const) {
      const employeeId = randomUUID();
      await client.query(
        `INSERT INTO employees(id, employee_number, full_name, status, started_on, organizational_unit_id)
         VALUES ($1, $2, $3, 'active', '2020-01-06', $4)`,
        [employeeId, `EMP005R-${employeeId.slice(0, 8)}`, `Pegawai ${who}`, unitId],
      );
      const accountId = randomUUID();
      await client.query(
        "INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1, $2, $3, 'EMPLOYEE', 'active')",
        [accountId, employeeId, `emp005-req-${accountId}@example.invalid`],
      );
      people[who] = { employeeId, accountId };
    }
    await client.query(
      "UPDATE organizational_units SET leave_approver_employee_id = $2 WHERE id = $1",
      [unitId, people.unitApprover.employeeId],
    );
    await client.query(
      "UPDATE employees SET direct_manager_employee_id = $2 WHERE id = $1",
      [people.requester.employeeId, people.manager.employeeId],
    );
    requesterEmployeeId = people.requester.employeeId;
    principal = { id: people.requester.accountId, email: "requester@example.invalid", principalType: "EMPLOYEE" };

    const config = {
      NODE_ENV: "test", HOST: "127.0.0.1", PORT: 3001, DATABASE_URL: databaseUrl!,
      AUTH_MODE: "local", AUTH_ENCRYPTION_KEY: "14".repeat(32), AUTH_SESSION_TTL_HOURS: 8,
    } as ApiConfig;
    const auth = {
      getSession: async () => ({ principal, expiresAt: "2099-01-01T00:00:00Z" }),
      getAuthorizationContext: async () => ({ organizationPermissions: [] }),
    } as never;
    const transactionPool = savepointPool(client);
    app = Fastify({ logger: false });
    await registerTripRoutes(app, transactionPool, config, auth);
    await registerTripAdvanceRoutes(app, transactionPool, config, auth);
    await registerLoanRoutes(app, transactionPool, config, auth);
    await registerReimbursementRoutes(app, transactionPool, config, auth);
    await registerWorkArrangementRoutes(app, transactionPool, config, auth);
    await registerPerformanceRoutes(app, transactionPool, config, auth);
    await registerTrainingRoutes(app, transactionPool, config, auth);
  });

  afterEach(async () => {
    try { await app?.close(); } finally {
      if (client) { await client.query("ROLLBACK"); client.release(); }
    }
  });

  async function mark() {
    await client.query(
      `UPDATE employees
          SET management_scope = 'OUTSIDE_HCIS', management_scope_reason = 'PENGURUS_YAYASAN',
              management_scope_note = 'Dikonfirmasi HC (sintetis)', management_scope_marked_at = now()
        WHERE id = $1`,
      [requesterEmployeeId],
    );
  }

  const submissions: Submission[] = [
    {
      module: "perjalanan dinas (pratinjau)",
      url: "/trips/me/preview",
      payload: () => ({ startOn: inDays(7), endOn: inDays(8) }),
      managedSucceeds: true,
    },
    {
      module: "perjalanan dinas (kirim)",
      url: "/trips/me",
      payload: () => ({
        startOn: inDays(7), endOn: inDays(8), destination: "Surabaya",
        purpose: "Pelatihan guru di sekolah mitra", idempotencyKey: randomUUID(),
      }),
      managedSucceeds: true,
    },
    {
      module: "uang muka perjalanan",
      url: "/trip-advances/me",
      // The trip does not exist: a MANAGED requester must fall through to the trip check.
      payload: () => ({
        businessTripId: randomUUID(), wilayah: "LUAR_DAERAH", amount: 500_000,
        purpose: "Uang muka perjalanan dinas sintetis", idempotencyKey: randomUUID(),
      }),
      managedSucceeds: false,
    },
    {
      module: "pinjaman (pratinjau)",
      url: "/loans/me/preview",
      payload: () => ({ principal: 1_000_000, tenorMonths: 3 }),
      managedSucceeds: true,
    },
    {
      module: "pinjaman (kirim)",
      url: "/loans/me",
      payload: () => ({
        principal: 1_000_000, tenorMonths: 3, purpose: "Biaya perbaikan rumah",
        idempotencyKey: randomUUID(),
      }),
      managedSucceeds: true,
    },
    {
      module: "reimbursement (draf baru)",
      url: "/reimbursements/me",
      payload: () => ({
        title: "Transport kunjungan unit",
        items: [{ category: "TRANSPORT", expenseDate: inDays(-2), description: "Ongkos perjalanan", amount: 150_000 }],
        idempotencyKey: randomUUID(),
      }),
      managedSucceeds: true,
    },
    {
      module: "pengaturan kerja (pratinjau)",
      url: "/attendance/arrangements/me/preview",
      payload: () => ({ type: "REMOTE_WORK", startOn: inDays(3), endOn: inDays(3) }),
      managedSucceeds: true,
    },
    {
      module: "pengaturan kerja (kirim)",
      url: "/attendance/arrangements/me",
      payload: () => ({
        type: "REMOTE_WORK", startOn: inDays(3), endOn: inDays(3), location: "Rumah",
        purpose: "Menyelesaikan laporan bulanan", idempotencyKey: randomUUID(),
      }),
      managedSucceeds: true,
    },
    {
      module: "penilaian diri",
      // The review does not exist: a MANAGED requester must fall through to the review check.
      url: `/performance/me/${randomUUID()}/self-assessment`,
      payload: () => ({ scores: { "kriteria-1": 3 }, note: "Capaian bulan ini" }),
      managedSucceeds: false,
    },
    {
      module: "catatan pelatihan eksternal",
      url: "/training/me/records",
      payload: () => ({
        title: "Pelatihan tahsin lanjutan", category: "QURANIC", organizer: "Lembaga mitra",
        description: "Pelatihan dua hari", startOn: inDays(-5), endOn: inDays(-4), hours: 8,
        idempotencyKey: randomUUID(),
      }),
      managedSucceeds: true,
    },
  ];

  for (const submission of submissions) {
    it(`${submission.module}: ditolak setelah ditandai, berjalan untuk pegawai MANAGED`, async () => {
      const managed = await app.inject({ method: "POST", url: submission.url, payload: submission.payload() });
      if (submission.managedSucceeds) {
        expect(managed.statusCode, managed.body).toBeLessThan(300);
      } else {
        // Whatever stops a MANAGED requester here, it is never the EMP-005 refusal.
        expect(managed.json().code, managed.body).not.toBe(OUTSIDE_HCIS_CODE);
      }

      await mark();
      const refused = await app.inject({ method: "POST", url: submission.url, payload: submission.payload() });
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json()).toMatchObject({
        code: OUTSIDE_HCIS_CODE,
        message: "Data ini di luar pengelolaan HCIS dan hanya dapat dibaca.",
      });
    });
  }

  it("reimbursement: draf yang dibuat sebelum penandaan tetap terbaca, tetapi tidak dapat dikirim", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/reimbursements/me",
      payload: {
        title: "Transport kunjungan unit",
        items: [{ category: "TRANSPORT", expenseDate: inDays(-2), description: "Ongkos perjalanan", amount: 150_000 }],
        idempotencyKey: randomUUID(),
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const claimId = created.json().id as string;

    await mark();
    const readable = await app.inject({ method: "GET", url: `/reimbursements/me/${claimId}` });
    expect(readable.statusCode, readable.body).toBe(200);

    const refused = await app.inject({ method: "POST", url: `/reimbursements/me/${claimId}/submit` });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().code).toBe(OUTSIDE_HCIS_CODE);
  });

  it("perjalanan dinas: ulangan kunci idempotensi dari sebelum penandaan tetap menjawab", async () => {
    const payload = {
      startOn: inDays(7), endOn: inDays(8), destination: "Surabaya",
      purpose: "Pelatihan guru di sekolah mitra", idempotencyKey: randomUUID(),
    };
    const first = await app.inject({ method: "POST", url: "/trips/me", payload });
    expect(first.statusCode, first.body).toBe(201);

    await mark();
    const replay = await app.inject({ method: "POST", url: "/trips/me", payload });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({ id: first.json().id, idempotentReplay: true });

    // A fresh key is a new request and is refused.
    const fresh = await app.inject({
      method: "POST",
      url: "/trips/me",
      payload: { ...payload, startOn: inDays(14), endOn: inDays(15), idempotencyKey: randomUUID() },
    });
    expect(fresh.statusCode, fresh.body).toBe(409);
    expect(fresh.json().code).toBe(OUTSIDE_HCIS_CODE);
  });

  it("perjalanan dinas: riwayat sebelum penandaan tetap terbaca", async () => {
    const submitted = await app.inject({
      method: "POST",
      url: "/trips/me",
      payload: {
        startOn: inDays(7), endOn: inDays(8), destination: "Surabaya",
        purpose: "Pelatihan guru di sekolah mitra", idempotencyKey: randomUUID(),
      },
    });
    expect(submitted.statusCode, submitted.body).toBe(201);

    await mark();
    const list = await app.inject({ method: "GET", url: "/trips/me" });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items).toHaveLength(1);
  });
});

// Overtime, attendance clarification and shift swap build their own AuthService, so they need a
// real session cookie rather than an injected principal.
describe.skipIf(!allowed)("EMP-005 S2B §8.7: attendance self-service refuses a marked requester", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let employeeId = "";
  let counterpartEmployeeId = "";
  let cookie = "";

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("DELETE FROM organization_rollout_settings");
    const unitId = randomUUID();
    await client.query(
      "INSERT INTO organizational_units(id, normalized_name, name) VALUES ($1, $2, 'Unit EMP-005 kehadiran')",
      [unitId, `emp005-att-${unitId}`],
    );
    const config = {
      NODE_ENV: "test", HOST: "127.0.0.1", PORT: 3001, DATABASE_URL: databaseUrl!,
      AUTH_MODE: "local", AUTH_ENCRYPTION_KEY: "15".repeat(32), AUTH_SESSION_TTL_HOURS: 8,
    } as ApiConfig;
    const transactionPool = savepointPool(client);
    const auth = new AuthService(transactionPool, config.AUTH_ENCRYPTION_KEY!, 8, false);
    const ids: string[] = [];
    for (const who of ["requester", "counterpart"] as const) {
      const id = randomUUID();
      await client.query(
        `INSERT INTO employees(id, employee_number, full_name, status, started_on, organizational_unit_id)
         VALUES ($1, $2, $3, 'active', '2020-01-06', $4)`,
        [id, `EMP005A-${id.slice(0, 8)}`, `Pegawai ${who}`, unitId],
      );
      const accountId = randomUUID();
      await client.query(
        "INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1, $2, $3, 'EMPLOYEE', 'active')",
        [accountId, id, `emp005-att-${accountId}@example.invalid`],
      );
      if (who === "requester") {
        const session = await auth.createSessionForAccountId(accountId, {
          ipAddress: "127.0.0.1", userAgent: "rollback-only-emp005-requester-test",
        });
        cookie = session.setCookie.split(";")[0]!;
      }
      ids.push(id);
    }
    [employeeId, counterpartEmployeeId] = ids as [string, string];

    app = Fastify({ logger: false });
    await registerAttendanceWorkforceRoutes(app, transactionPool, config);
    await registerAttendanceShiftSwapRoutes(app, transactionPool, config);
  });

  afterEach(async () => {
    try { await app?.close(); } finally {
      if (client) { await client.query("ROLLBACK"); client.release(); }
    }
  });

  async function mark() {
    await client.query(
      `UPDATE employees
          SET management_scope = 'OUTSIDE_HCIS', management_scope_reason = 'BUMY',
              management_scope_note = 'Dikonfirmasi HC (sintetis)', management_scope_marked_at = now()
        WHERE id = $1`,
      [employeeId],
    );
  }

  function post(url: string, payload: object) {
    return app.inject({ method: "POST", url, headers: { cookie }, payload });
  }

  it("klarifikasi kehadiran: dicatat untuk pegawai MANAGED, ditolak setelah ditandai", async () => {
    const body = {
      workDate: jakartaToday(), kind: "machine_issue", mode: "justification",
      reason: "Mesin absen tidak membaca sidik jari.",
    };
    const managed = await post("/attendance/clarifications", body);
    expect(managed.statusCode, managed.body).toBe(201);

    await mark();
    const refused = await post("/attendance/clarifications", body);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().code).toBe(OUTSIDE_HCIS_CODE);
  });

  it("lembur: pengajuan sendiri ditolak setelah ditandai", async () => {
    const body = { workDate: jakartaToday(), requestedMinutes: 60, note: "Menyelesaikan laporan." };
    const managed = await post("/attendance/overtime", body);
    // No schedule is seeded here, so a MANAGED requester is stopped by an overtime rule —
    // never by the EMP-005 refusal.
    expect(managed.json().code, managed.body).not.toBe(OUTSIDE_HCIS_CODE);

    await mark();
    const refused = await post("/attendance/overtime", body);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().code).toBe(OUTSIDE_HCIS_CODE);
  });

  it("tukar shift: pengajuan ditolak setelah ditandai", async () => {
    const body = { workDate: inDays(1), counterpartEmployeeId };
    const managed = await post("/attendance/shift-swaps", body);
    expect(managed.json().code, managed.body).not.toBe(OUTSIDE_HCIS_CODE);

    await mark();
    const refused = await post("/attendance/shift-swaps", body);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().code).toBe(OUTSIDE_HCIS_CODE);
  });
});
