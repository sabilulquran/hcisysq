// Paket 2 P2-1 terhadap PostgreSQL sungguhan: constraint migrasi 0102 yang
// menjaga "satu yang berlaku pada satu waktu" dan pasangan field yang harus
// konsisten. Hanya berjalan pada basis data CI loopback; semua tulisan
// di-rollback.

import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

describe.skipIf(!allowed)("0102 employee profile records migration", () => {
  let pool: Pool;
  let client: PoolClient;
  let employeeId: string;
  let savepoint = 0;

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    employeeId = randomUUID();
    await client.query(
      "INSERT INTO employees(id, employee_number, full_name, status) VALUES ($1, $2, 'Synthetic Profile Test', 'active')",
      [employeeId, `EMP-P2-${employeeId}`],
    );
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  async function expectSqlError(sql: string, values: unknown[], code: string) {
    const name = `profile_test_${++savepoint}`;
    await client.query(`SAVEPOINT ${name}`);
    let caught: unknown;
    try {
      await client.query(sql, values);
    } catch (error) {
      caught = error;
    }
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    expect((caught as { code?: string } | undefined)?.code).toBe(code);
  }

  const insertEducation = `INSERT INTO employee_education
    (id, employee_id, level, institution_name, completion_status, started_year, completed_year)
    VALUES ($1, $2, $3, 'Lembaga Sintetis', $4, $5, $6)`;

  const insertSkill = `INSERT INTO employee_skills
    (id, employee_id, kind, name, category, issuer, issued_on, expires_on)
    VALUES ($1, $2, $3, 'Keahlian Sintetis', 'PENGAJARAN', $4, $5, $6)`;

  const insertFamily = `INSERT INTO employee_family_members
    (id, employee_id, relation, full_name, birth_date, is_dependent, is_emergency_contact,
     emergency_phone, emergency_priority, valid_from, valid_to)
    VALUES ($1, $2, $3, 'Anggota Sintetis', $4, $5, $6, $7, $8, $9, $10)`;

  const insertAddress = `INSERT INTO employee_addresses
    (id, employee_id, kind, address_line, city, valid_from, valid_to)
    VALUES ($1, $2, $3, 'Jalan Sintetis 1', 'Bandung', $4, $5)`;

  describe("pendidikan", () => {
    it("menolak tahun selesai sebelum tahun mulai dan status selesai tanpa tahun", async () => {
      await expectSqlError(insertEducation, [randomUUID(), employeeId, "D4_S1", "SELESAI", 2022, 2018], "23514");
      await expectSqlError(insertEducation, [randomUUID(), employeeId, "D4_S1", "SELESAI", 2018, null], "23514");
    });

    it("menerima beberapa catatan pada jenjang yang sama", async () => {
      await client.query(insertEducation, [randomUUID(), employeeId, "D4_S1", "SELESAI", 2014, 2018]);
      await client.query(insertEducation, [randomUUID(), employeeId, "D4_S1", "SELESAI", 2019, 2023]);
      const rows = await client.query("SELECT count(*)::int AS n FROM employee_education WHERE employee_id = $1", [employeeId]);
      expect(rows.rows[0]?.n).toBe(2);
    });

    it("menuntut tanggal verifikasi bila statusnya terverifikasi", async () => {
      const id = randomUUID();
      await client.query(insertEducation, [id, employeeId, "S2", "SELESAI", 2019, 2021]);
      await expectSqlError(
        "UPDATE employee_education SET verification_status = 'DIVERIFIKASI' WHERE id = $1",
        [id],
        "23514",
      );
      await client.query(
        "UPDATE employee_education SET verification_status = 'DIVERIFIKASI', verified_at = now() WHERE id = $1",
        [id],
      );
    });
  });

  describe("keahlian", () => {
    it("menuntut penerbit dan tanggal terbit pada sertifikat", async () => {
      await expectSqlError(insertSkill, [randomUUID(), employeeId, "SERTIFIKAT", null, "2026-01-01", null], "23514");
      await expectSqlError(insertSkill, [randomUUID(), employeeId, "SERTIFIKAT", "Kemenag", null, null], "23514");
      await client.query(insertSkill, [randomUUID(), employeeId, "KEAHLIAN", null, null, null]);
    });

    it("menolak masa berlaku yang berakhir sebelum terbit", async () => {
      await expectSqlError(
        insertSkill,
        [randomUUID(), employeeId, "SERTIFIKAT", "Kemenag", "2026-03-01", "2026-02-01"],
        "23514",
      );
    });
  });

  describe("keluarga", () => {
    it("hanya mengizinkan satu pasangan yang berlaku pada satu waktu", async () => {
      await client.query(insertFamily, [randomUUID(), employeeId, "PASANGAN", null, false, false, null, null, "2019-01-01", null]);
      await expectSqlError(
        insertFamily,
        [randomUUID(), employeeId, "PASANGAN", null, false, false, null, null, "2022-01-01", null],
        "23P01",
      );
    });

    it("mengizinkan pasangan berikutnya setelah yang lama ditutup", async () => {
      await client.query(insertFamily, [randomUUID(), employeeId, "PASANGAN", null, false, false, null, null, "2019-01-01", "2023-12-31"]);
      await client.query(insertFamily, [randomUUID(), employeeId, "PASANGAN", null, false, false, null, null, "2024-01-01", null]);
    });

    it("menolak urutan kontak darurat yang bertabrakan", async () => {
      await client.query(insertFamily, [randomUUID(), employeeId, "ORANG_TUA", null, false, true, "0812", 1, "2020-01-01", null]);
      await expectSqlError(
        insertFamily,
        [randomUUID(), employeeId, "SAUDARA", null, false, true, "0813", 1, "2021-01-01", null],
        "23P01",
      );
      await client.query(insertFamily, [randomUUID(), employeeId, "SAUDARA", null, false, true, "0813", 2, "2021-01-01", null]);
    });

    it("menuntut tanggal lahir untuk tanggungan dan nomor untuk kontak darurat", async () => {
      await expectSqlError(
        insertFamily,
        [randomUUID(), employeeId, "ANAK", null, true, false, null, null, "2020-01-01", null],
        "23514",
      );
      await expectSqlError(
        insertFamily,
        [randomUUID(), employeeId, "ANAK", "2020-01-01", false, true, null, 1, "2020-01-01", null],
        "23514",
      );
    });
  });

  describe("alamat", () => {
    it("hanya mengizinkan satu alamat per jenis yang berlaku bersamaan", async () => {
      await client.query(insertAddress, [randomUUID(), employeeId, "DOMISILI", "2024-01-01", null]);
      await expectSqlError(insertAddress, [randomUUID(), employeeId, "DOMISILI", "2026-01-01", null], "23P01");
      // Jenis lain tidak bertabrakan.
      await client.query(insertAddress, [randomUUID(), employeeId, "KTP", "2024-01-01", null]);
    });

    it("mengizinkan alamat baru setelah yang lama ditutup", async () => {
      await client.query(insertAddress, [randomUUID(), employeeId, "DOMISILI", "2024-01-01", "2026-12-31"]);
      await client.query(insertAddress, [randomUUID(), employeeId, "DOMISILI", "2027-01-01", null]);
    });

    it("menolak kode pos yang bukan lima angka", async () => {
      await expectSqlError(
        `INSERT INTO employee_addresses (id, employee_id, kind, address_line, city, postal_code, valid_from)
         VALUES ($1, $2, 'DOMISILI', 'Jalan Sintetis 1', 'Bandung', '4012', '2026-01-01')`,
        [randomUUID(), employeeId],
        "23514",
      );
    });
  });

  describe("usulan perubahan data", () => {
    const insertRequest = `INSERT INTO employee_data_change_requests
      (id, employee_id, submitted_by_account_id, target, payload, state, decided_at, decision_note)
      VALUES ($1, $2, $3, 'ALAMAT', '{"city":"Bandung"}'::jsonb, $4, $5, $6)`;

    it("menuntut alasan saat menolak, dan tanggal keputusan saat sudah diputuskan", async () => {
      const accountId = randomUUID();
      await client.query(
        `INSERT INTO accounts(id, email, principal_type, status, employee_id)
         VALUES ($1, $2, 'EMPLOYEE', 'active', $3)`,
        [accountId, `p2-${accountId}@example.invalid`, employeeId],
      );
      await expectSqlError(insertRequest, [randomUUID(), employeeId, accountId, "DITOLAK", new Date(), null], "23514");
      await expectSqlError(insertRequest, [randomUUID(), employeeId, accountId, "DITERIMA", null, null], "23514");
      await client.query(insertRequest, [randomUUID(), employeeId, accountId, "DIAJUKAN", null, null]);
      await client.query(insertRequest, [randomUUID(), employeeId, accountId, "DITOLAK", new Date(), "Alamat tidak jelas"]);
    });
  });
});
