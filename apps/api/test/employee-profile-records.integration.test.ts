// EMP-007 P2-2 store against real PostgreSQL. The route tests use a fake pool,
// which can say nothing about the certificate worklist's joins and paging, or
// about the one rule that only the table can keep: taking a verification back
// must not erase who verified the record and when.
// Loopback CI database only; every write is rolled back.

import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  getSkill,
  insertEducation,
  insertSkill,
  listEducation,
  listExpiringCertificates,
  listSkills,
  lockProfileRecord,
  setVerification,
  voidRecord,
} from "../src/modules/employees/infrastructure/postgres-employee-profile-store.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

const EDUCATION = {
  level: "D4_S1" as const,
  institutionName: "Universitas Sintetis",
  major: "Pendidikan Agama Islam",
  startedYear: 2014,
  completedYear: 2018,
  completionStatus: "SELESAI" as const,
  degreeTitle: "S.Pd.",
  certificateNumber: null,
  archiveReference: null,
  notes: null,
};

describe.skipIf(!allowed)("EMP-007 §4.1, §4.2, §7.5 against PostgreSQL", () => {
  let pool: Pool;
  let client: PoolClient;
  let unitId: string;
  let actorId: string;

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    unitId = randomUUID();
    await client.query(
      "INSERT INTO organizational_units(id, normalized_name, name) VALUES ($1, $2, 'Unit Sintetis P2')",
      [unitId, `unit-p2-${unitId}`],
    );
    actorId = randomUUID();
    await client.query(
      `INSERT INTO accounts(id, email, principal_type, status)
       VALUES ($1, $2, 'EMPLOYEE', 'active')`,
      [actorId, `p2-${actorId}@example.org`],
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
      [employeeId, `EMP-P2-${employeeId}`, name, unit],
    );
    return employeeId;
  }

  function certificate(overrides: Partial<Parameters<typeof insertSkill>[2]> = {}) {
    return {
      kind: "SERTIFIKAT" as const,
      name: "Sertifikat Pendidik",
      category: "PENGAJARAN" as const,
      proficiency: null,
      issuer: "Kementerian Agama",
      certificateNumber: null,
      issuedOn: daysFromToday(-700),
      expiresOn: daysFromToday(20),
      archiveReference: null,
      notes: null,
      ...overrides,
    };
  }

  function worklist(overrides: Partial<Parameters<typeof listExpiringCertificates>[1]> = {}) {
    return listExpiringCertificates(client, {
      today: today(), withinDays: 60, unitId: null, page: 1, pageSize: 100, ...overrides,
    });
  }

  it("keeps who verified a record when the verification is taken back", async () => {
    const employeeId = await addEmployee("Pegawai Verifikasi");
    const recordId = await insertEducation(client, employeeId, EDUCATION, actorId);
    await setVerification(client, "employee_education", recordId, true, null, actorId);
    await setVerification(client, "employee_education", recordId, false, "Ijazah asli belum ditunjukkan", actorId);

    const row = (await client.query(
      `SELECT verification_status AS status, verified_by_account_id AS "verifiedBy", verified_at AS "verifiedAt",
              unverified_reason AS reason
       FROM employee_education WHERE id = $1`,
      [recordId],
    )).rows[0];
    expect(row.status).toBe("DILAPORKAN");
    expect(row.verifiedBy).toBe(actorId);
    expect(row.verifiedAt).not.toBeNull();
    expect(row.reason).toBe("Ijazah asli belum ditunjukkan");
  });

  it("hides a voided record from the list but keeps it readable by id", async () => {
    const employeeId = await addEmployee("Pegawai Pembatalan");
    const recordId = await insertSkill(client, employeeId, certificate(), actorId);
    expect(await listSkills(client, employeeId)).toHaveLength(1);
    await voidRecord(client, "employee_skills", recordId, "Catatan ganda");
    expect(await listSkills(client, employeeId)).toHaveLength(0);
    expect(await listSkills(client, employeeId, true)).toHaveLength(1);
    expect(await getSkill(client, recordId)).toMatchObject({ voidedReason: "Catatan ganda" });
  });

  it("reports a voided record to the lock, so a second editor is refused rather than racing", async () => {
    const employeeId = await addEmployee("Pegawai Kunci");
    const recordId = await insertEducation(client, employeeId, EDUCATION, actorId);
    expect(await lockProfileRecord(client, "employee_education", recordId)).toMatchObject({ employeeId, voidedAt: null });
    await voidRecord(client, "employee_education", recordId, "Salah entri");
    expect((await lockProfileRecord(client, "employee_education", recordId))!.voidedAt).not.toBeNull();
    expect(await lockProfileRecord(client, "employee_education", randomUUID())).toBeNull();
  });

  it("reads dates back as the day they were written, whatever the server's zone", async () => {
    const employeeId = await addEmployee("Pegawai Tanggal");
    const recordId = await insertSkill(client, employeeId, certificate({ issuedOn: "2024-01-10", expiresOn: "2029-01-10" }), actorId);
    expect(await getSkill(client, recordId)).toMatchObject({ issuedOn: "2024-01-10", expiresOn: "2029-01-10" });
  });

  it("orders education newest first and skills by kind", async () => {
    const employeeId = await addEmployee("Pegawai Urutan");
    await insertEducation(client, employeeId, { ...EDUCATION, level: "SMA_SEDERAJAT", startedYear: 2011, completedYear: 2014 }, actorId);
    await insertEducation(client, employeeId, EDUCATION, actorId);
    expect((await listEducation(client, employeeId)).map((row) => row.level)).toEqual(["D4_S1", "SMA_SEDERAJAT"]);

    await insertSkill(client, employeeId, certificate({ kind: "KEAHLIAN", name: "Microsoft Excel", expiresOn: null, issuedOn: null, issuer: null, proficiency: "MAHIR" }), actorId);
    expect((await listSkills(client, employeeId)).map((row) => row.kind)).toEqual(["KEAHLIAN", "SERTIFIKAT"]);
  });

  it("lists certificates about to expire, and the ones already past", async () => {
    const soon = await addEmployee("Pegawai Segera");
    await insertSkill(client, soon, certificate({ expiresOn: daysFromToday(20) }), actorId);
    const past = await addEmployee("Pegawai Lewat");
    await insertSkill(client, past, certificate({ expiresOn: daysFromToday(-10) }), actorId);

    const rows = (await worklist()).rows;
    expect(rows.find((row) => row.employeeId === soon)).toMatchObject({ daysLeft: 20, unitName: "Unit Sintetis P2" });
    expect(rows.find((row) => row.employeeId === past)?.daysLeft).toBe(-10);
  });

  it("leaves out plain skills, certificates with no expiry, voided ones, the far future, and removed employees", async () => {
    const plain = await addEmployee("Pegawai Keahlian");
    await insertSkill(client, plain, certificate({ kind: "KEAHLIAN", expiresOn: daysFromToday(10) }), actorId);

    const openEnded = await addEmployee("Pegawai Tanpa Akhir");
    await insertSkill(client, openEnded, certificate({ expiresOn: null }), actorId);

    const voided = await addEmployee("Pegawai Dibatalkan");
    const voidedId = await insertSkill(client, voided, certificate({ expiresOn: daysFromToday(10) }), actorId);
    await voidRecord(client, "employee_skills", voidedId, "Catatan ganda");

    const far = await addEmployee("Pegawai Jauh");
    await insertSkill(client, far, certificate({ expiresOn: daysFromToday(200) }), actorId);

    const removed = await addEmployee("Pegawai Dihapus");
    await insertSkill(client, removed, certificate({ expiresOn: daysFromToday(10) }), actorId);
    await client.query(
      "UPDATE employees SET removed_at = now(), removal_reason = 'Uji sintetis' WHERE id = $1",
      [removed],
    );

    const ids = (await worklist()).rows.map((row) => row.employeeId);
    for (const absent of [plain, openEnded, voided, far, removed]) expect(ids).not.toContain(absent);
  });

  it("filters by unit", async () => {
    const otherUnitId = randomUUID();
    await client.query(
      "INSERT INTO organizational_units(id, normalized_name, name) VALUES ($1, $2, 'Unit Lain P2')",
      [otherUnitId, `unit-p2b-${otherUnitId}`],
    );
    const mine = await addEmployee("Pegawai Unit Ini");
    await insertSkill(client, mine, certificate({ expiresOn: daysFromToday(10) }), actorId);
    const other = await addEmployee("Pegawai Unit Lain", otherUnitId);
    await insertSkill(client, other, certificate({ expiresOn: daysFromToday(10) }), actorId);

    const ids = (await worklist({ unitId })).rows.map((row) => row.employeeId);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(other);
  });

  it("reports the real total even on a page past the end", async () => {
    const employeeId = await addEmployee("Pegawai Halaman");
    await insertSkill(client, employeeId, certificate({ expiresOn: daysFromToday(5) }), actorId);
    const first = await worklist({ pageSize: 1, page: 1 });
    const far = await worklist({ pageSize: 1, page: 99 });
    expect(first.rows).toHaveLength(1);
    expect(far.rows).toHaveLength(0);
    expect(far.total).toBe(first.total);
    expect(far.total).toBeGreaterThan(0);
  });
});
