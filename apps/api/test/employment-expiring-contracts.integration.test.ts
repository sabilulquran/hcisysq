// EMP-005 S7 "Kontrak akan berakhir" terhadap PostgreSQL sungguhan. Pool
// palsu tidak dapat membuktikan apa pun tentang DISTINCT ON, NULL, dan paging
// — dan dua cacat nyata (pegawai tetap yang terus muncul sebagai lewat tempo,
// dan kontrak tanpa tanggal mulai yang hilang) hanya terlihat di sini.
// Hanya berjalan pada basis data CI loopback; semua tulisan di-rollback.

import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { listExpiringContracts } from "../src/modules/employment/infrastructure/postgres-employment-store.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

describe.skipIf(!allowed)("EMP-005 §13.4 kontrak akan berakhir, terhadap PostgreSQL", () => {
  let pool: Pool;
  let client: PoolClient;
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
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  function daysFromToday(days: number): string {
    return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  }

  const today = () => daysFromToday(0);

  async function addEmployee(name: string, unit: string | null = unitId): Promise<string> {
    const employeeId = randomUUID();
    await client.query(
      `INSERT INTO employees(id, employee_number, full_name, status, organizational_unit_id)
       VALUES ($1, $2, $3, 'active', $4)`,
      [employeeId, `EMP-S7-${employeeId}`, name, unit],
    );
    return employeeId;
  }

  /** Satu hubungan kerja berjalan dengan daftar term-nya, terbaru terakhir. */
  async function addEmployment(
    employeeId: string,
    terms: Array<{ category: string; from: string | null; to: string | null }>,
  ): Promise<string> {
    const employmentId = randomUUID();
    const actionId = randomUUID();
    const firstFrom = terms[0]?.from ?? null;
    await client.query(
      `INSERT INTO employments(id, employee_id, staff_type, started_on, start_basis, service_start_on,
         source, opened_by_action_id)
       VALUES ($1, $2, 'PENDIDIK', $3, $4, $3, 'BASELINE_FROM_MASTER', $5)`,
      [employmentId, employeeId, firstFrom, firstFrom ? "RECORDED" : "UNKNOWN", actionId],
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

  function worklist(overrides: Partial<Parameters<typeof listExpiringContracts>[1]> = {}) {
    return listExpiringContracts(client, {
      today: today(),
      withinDays: 60,
      unitId: null,
      page: 1,
      pageSize: 100,
      ...overrides,
    });
  }

  it("menampilkan kontrak yang akan berakhir beserta sisa harinya", async () => {
    const employeeId = await addEmployee("Pegawai Kontrak");
    await addEmployment(employeeId, [{ category: "KONTRAK", from: daysFromToday(-300), to: daysFromToday(20) }]);
    const row = (await worklist()).rows.find((item) => item.employeeId === employeeId);
    expect(row).toMatchObject({ category: "KONTRAK", daysLeft: 20, unitName: "Unit Sintetis S7" });
  });

  it("menandai kontrak yang sudah lewat tanpa tindak lanjut", async () => {
    const employeeId = await addEmployee("Pegawai Lewat Tempo");
    await addEmployment(employeeId, [{ category: "KONTRAK", from: daysFromToday(-400), to: daysFromToday(-10) }]);
    const row = (await worklist()).rows.find((item) => item.employeeId === employeeId);
    expect(row?.daysLeft).toBe(-10);
  });

  it("tidak menampilkan pegawai yang sudah diangkat tetap sesudah kontraknya", async () => {
    const employeeId = await addEmployee("Pegawai Diangkat Tetap");
    await addEmployment(employeeId, [
      { category: "KONTRAK", from: daysFromToday(-400), to: daysFromToday(-40) },
      { category: "TETAP", from: daysFromToday(-39), to: null },
    ]);
    const rows = (await worklist()).rows;
    expect(rows.find((item) => item.employeeId === employeeId)).toBeUndefined();
  });

  it("menampilkan kontrak yang tanggal mulainya belum diketahui", async () => {
    const employeeId = await addEmployee("Pegawai Data Awal");
    await addEmployment(employeeId, [{ category: "KONTRAK", from: null, to: daysFromToday(15) }]);
    const row = (await worklist()).rows.find((item) => item.employeeId === employeeId);
    expect(row?.daysLeft).toBe(15);
  });

  it("melewatkan kontrak di luar rentang, hubungan kerja yang berakhir, dan pegawai yang dihapus dari master", async () => {
    const farFuture = await addEmployee("Pegawai Kontrak Panjang");
    await addEmployment(farFuture, [{ category: "KONTRAK", from: daysFromToday(-100), to: daysFromToday(200) }]);

    const ended = await addEmployee("Pegawai Sudah Keluar");
    const employmentId = await addEmployment(ended, [{ category: "KONTRAK", from: daysFromToday(-400), to: daysFromToday(-5) }]);
    await client.query(
      `UPDATE employments SET ended_on = $2, end_basis = 'RECORDED', end_precision = 'DAY', end_reason = 'KONTRAK_BERAKHIR'
       WHERE id = $1`,
      [employmentId, daysFromToday(-5)],
    );

    const removed = await addEmployee("Pegawai Dihapus Master");
    await addEmployment(removed, [{ category: "KONTRAK", from: daysFromToday(-200), to: daysFromToday(10) }]);
    await client.query(
      "UPDATE employees SET removed_at = now(), removal_reason = 'Uji sintetis' WHERE id = $1",
      [removed],
    );

    const ids = (await worklist()).rows.map((row) => row.employeeId);
    expect(ids).not.toContain(farFuture);
    expect(ids).not.toContain(ended);
    expect(ids).not.toContain(removed);
  });

  it("menyaring per unit", async () => {
    const otherUnitId = randomUUID();
    await client.query(
      "INSERT INTO organizational_units(id, normalized_name, name) VALUES ($1, $2, 'Unit Lain S7')",
      [otherUnitId, `unit-s7b-${otherUnitId}`],
    );
    const mine = await addEmployee("Pegawai Unit Ini");
    await addEmployment(mine, [{ category: "KONTRAK", from: daysFromToday(-100), to: daysFromToday(10) }]);
    const other = await addEmployee("Pegawai Unit Lain", otherUnitId);
    await addEmployment(other, [{ category: "KONTRAK", from: daysFromToday(-100), to: daysFromToday(10) }]);

    const ids = (await worklist({ unitId })).rows.map((row) => row.employeeId);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(other);
  });

  it("menghitung total yang sebenarnya walau halaman yang diminta sudah lewat", async () => {
    const employeeId = await addEmployee("Pegawai Halaman");
    await addEmployment(employeeId, [{ category: "KONTRAK", from: daysFromToday(-100), to: daysFromToday(5) }]);
    const firstPage = await worklist({ pageSize: 1, page: 1 });
    expect(firstPage.rows).toHaveLength(1);
    const farPage = await worklist({ pageSize: 1, page: 99 });
    expect(farPage.rows).toHaveLength(0);
    expect(farPage.total).toBe(firstPage.total);
    expect(farPage.total).toBeGreaterThan(0);
  });
});
