// EMP-005 S7 "Kontrak akan berakhir" terhadap PostgreSQL sungguhan. Pool
// palsu tidak bisa membuktikan apa pun tentang DISTINCT ON, NULL, dan paging —
// dan dua cacat nyata (pegawai tetap yang terus muncul sebagai lewat tempo,
// dan kontrak tanpa tanggal mulai yang hilang) hanya terlihat di sini.
// Hanya berjalan pada basis data CI loopback; semua tulisan di-rollback.

import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: databaseUrl ?? "",
  AUTH_MODE: "local" as const,
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

interface Row {
  employeeId: string;
  fullName: string;
  endsOn: string;
  daysLeft: number;
  overdue: boolean;
  category: string;
}

describe.skipIf(!allowed)("EMP-005 §13.4 kontrak akan berakhir, terhadap PostgreSQL", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: FastifyInstance;
  let unitId: string;

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    unitId = randomUUID();
    await client.query(
      "INSERT INTO organizational_units(id, normalized_name, name) VALUES ($1, $2, 'Unit Sintetis S7')",
      [unitId, `unit-s7-${unitId}`],
    );
    await client.query(
      `INSERT INTO employment_rollout_settings (id, mode, reason) VALUES (1, 'AUTHORITATIVE', 'Uji integrasi S7')
       ON CONFLICT (id) DO UPDATE SET mode = 'AUTHORITATIVE'`,
    );

    // Satu koneksi, satu transaksi: route memakai client yang sama agar
    // seluruh data uji terlihat dan ikut di-rollback.
    const { registerEmploymentSelfServiceRoutes } = await import("../src/modules/employment/self-service-routes.js");
    const facade = {
      query: (...args: Parameters<PoolClient["query"]>) => (client.query as never)(...args),
      connect: async () => ({ query: client.query.bind(client), release: () => undefined }),
    } as unknown as Pool;
    app = Fastify({ logger: false });
    // Sesi dan izin dijawab langsung: yang diuji di sini SQL-nya, bukan auth
    // (itu sudah ditutup tes rute).
    vi.spyOn(
      await import("../src/modules/auth/service.js").then((module) => module.AuthService.prototype),
      "getSession",
    ).mockResolvedValue({
      principal: { id: randomUUID(), email: "hc@example.invalid", principalType: "EMPLOYEE" },
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    vi.spyOn(
      await import("../src/modules/auth/service.js").then((module) => module.AuthService.prototype),
      "getAuthorizationContext",
    ).mockResolvedValue({ organizationPermissions: ["employment.read"] } as never);
    await registerEmploymentSelfServiceRoutes(app, facade, config);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
    await client.query("ROLLBACK");
    client.release();
  });

  function daysFromToday(days: number): string {
    return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  }

  async function addEmployee(name: string): Promise<string> {
    const employeeId = randomUUID();
    await client.query(
      `INSERT INTO employees(id, employee_number, full_name, status, organizational_unit_id)
       VALUES ($1, $2, $3, 'active', $4)`,
      [employeeId, `EMP-S7-${employeeId}`, name, unitId],
    );
    return employeeId;
  }

  /** Satu hubungan kerja berjalan dengan daftar term-nya, terbaru terakhir. */
  async function addEmployment(
    employeeId: string,
    terms: Array<{ category: string; from: string | null; to: string | null }>,
  ) {
    const employmentId = randomUUID();
    const actionId = randomUUID();
    await client.query(
      `INSERT INTO employments(id, employee_id, staff_type, started_on, start_basis, service_start_on,
         source, opened_by_action_id)
       VALUES ($1, $2, 'PENDIDIK', $3, $4, $3, 'BASELINE_FROM_MASTER', $5)`,
      [employmentId, employeeId, terms[0]?.from ?? null, terms[0]?.from ? "RECORDED" : "UNKNOWN", actionId],
    );
    await client.query(
      `INSERT INTO employment_actions(id, employee_id, employment_id, action_type, recorded_at)
       VALUES ($1, $2, $3, 'BASELINE', now())`,
      [actionId, employeeId, employmentId],
    );
    let sequence = 0;
    for (const term of terms) {
      sequence += 1;
      await client.query(
        `INSERT INTO employment_terms(id, employment_id, sequence, category, effective_from, effective_to, opened_by_action_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [randomUUID(), employmentId, sequence, term.category, term.from, term.to, actionId],
      );
    }
    return employmentId;
  }

  async function worklist(query = "withinDays=60"): Promise<{ total: number; rows: Row[] }> {
    const response = await app.inject({
      method: "GET",
      url: `/admin/employment/contracts/expiring?${query}`,
      headers: { cookie: "hcis_session=test-token" },
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  it("menampilkan kontrak yang akan berakhir beserta sisa harinya", async () => {
    const employeeId = await addEmployee("Pegawai Kontrak");
    await addEmployment(employeeId, [{ category: "KONTRAK", from: daysFromToday(-300), to: daysFromToday(20) }]);
    const body = await worklist();
    const row = body.rows.find((item) => item.employeeId === employeeId);
    expect(row).toMatchObject({ category: "KONTRAK", daysLeft: 20, overdue: false });
  });

  it("menandai kontrak yang sudah lewat tanpa tindak lanjut", async () => {
    const employeeId = await addEmployee("Pegawai Lewat Tempo");
    await addEmployment(employeeId, [{ category: "KONTRAK", from: daysFromToday(-400), to: daysFromToday(-10) }]);
    const row = (await worklist()).rows.find((item) => item.employeeId === employeeId);
    expect(row).toMatchObject({ daysLeft: -10, overdue: true });
  });

  it("tidak menampilkan pegawai yang sudah diangkat tetap sesudah kontraknya", async () => {
    const employeeId = await addEmployee("Pegawai Diangkat Tetap");
    await addEmployment(employeeId, [
      { category: "KONTRAK", from: daysFromToday(-400), to: daysFromToday(-40) },
      { category: "TETAP", from: daysFromToday(-39), to: null },
    ]);
    const body = await worklist();
    expect(body.rows.find((item) => item.employeeId === employeeId)).toBeUndefined();
  });

  it("menampilkan kontrak yang tanggal mulainya belum diketahui", async () => {
    const employeeId = await addEmployee("Pegawai Data Awal");
    await addEmployment(employeeId, [{ category: "KONTRAK", from: null, to: daysFromToday(15) }]);
    const row = (await worklist()).rows.find((item) => item.employeeId === employeeId);
    expect(row).toMatchObject({ daysLeft: 15 });
  });

  it("tidak menampilkan kontrak yang berakhir di luar rentang, dan hubungan kerja yang sudah berakhir", async () => {
    const farFuture = await addEmployee("Pegawai Kontrak Panjang");
    await addEmployment(farFuture, [{ category: "KONTRAK", from: daysFromToday(-100), to: daysFromToday(200) }]);

    const ended = await addEmployee("Pegawai Sudah Keluar");
    const employmentId = await addEmployment(ended, [{ category: "KONTRAK", from: daysFromToday(-400), to: daysFromToday(-5) }]);
    await client.query(
      "UPDATE employments SET ended_on = $2, end_basis = 'RECORDED', end_precision = 'DAY', end_reason = 'KONTRAK_BERAKHIR' WHERE id = $1",
      [employmentId, daysFromToday(-5)],
    );

    const removed = await addEmployee("Pegawai Dihapus Master");
    await addEmployment(removed, [{ category: "KONTRAK", from: daysFromToday(-200), to: daysFromToday(10) }]);
    await client.query("UPDATE employees SET removed_at = now() WHERE id = $1", [removed]);

    const ids = (await worklist()).rows.map((row) => row.employeeId);
    expect(ids).not.toContain(farFuture);
    expect(ids).not.toContain(ended);
    expect(ids).not.toContain(removed);
  });

  it("menghitung total yang sebenarnya walau halaman yang diminta sudah lewat", async () => {
    const employeeId = await addEmployee("Pegawai Halaman");
    await addEmployment(employeeId, [{ category: "KONTRAK", from: daysFromToday(-100), to: daysFromToday(5) }]);
    const firstPage = await worklist("withinDays=60&pageSize=1&page=1");
    expect(firstPage.rows).toHaveLength(1);
    const farPage = await worklist("withinDays=60&pageSize=1&page=99");
    expect(farPage.rows).toHaveLength(0);
    expect(farPage.total).toBe(firstPage.total);
  });
});
