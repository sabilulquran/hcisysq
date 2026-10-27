// EMP-009 / EMP-003 P2-3 against real PostgreSQL. The rules that matter here
// live in the table, not in the code: one spouse and one emergency-contact
// order at a time, one address per kind at a time. A fake pool cannot say
// anything about an exclusion constraint, so this is where they are proved.
// Loopback CI database only; every write is rolled back.

import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closingDateFor } from "../src/modules/employees/domain/employee-profile.js";
import {
  closeAddress,
  getAddress,
  insertAddress,
  insertFamilyMember,
  listAddresses,
  listFamilyMembers,
  lockOpenAddress,
  lockProfileRecord,
  voidRecord,
} from "../src/modules/employees/infrastructure/postgres-employee-profile-store.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

const SPOUSE = {
  relation: "PASANGAN" as const,
  fullName: "Nama Sintetis",
  birthDate: "1990-05-04",
  gender: "P" as const,
  isDependent: false,
  dependentOrder: null,
  isEmergencyContact: false,
  emergencyPhone: null,
  emergencyPriority: null,
  validFrom: "2015-06-01",
  validTo: null,
  notes: null,
};

const ADDRESS = {
  kind: "DOMISILI" as const,
  addressLine: "Jalan Sintetis 1",
  village: null,
  district: null,
  city: "Bandung",
  province: "Jawa Barat",
  postalCode: "40111",
  validFrom: "2020-01-01",
  validTo: null,
  source: "HC" as const,
  notes: null,
};

describe.skipIf(!allowed)("EMP-009 §4.3 and EMP-003 §4.4 against PostgreSQL", () => {
  let pool: Pool;
  let client: PoolClient;
  let employeeId: string;
  let actorId: string;
  let savepoint = 0;

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    actorId = randomUUID();
    await client.query(
      "INSERT INTO accounts(id, email, principal_type, status) VALUES ($1, $2, 'EMPLOYEE', 'active')",
      [actorId, `p23-${actorId}@example.org`],
    );
    employeeId = randomUUID();
    await client.query(
      "INSERT INTO employees(id, employee_number, full_name, status) VALUES ($1, $2, 'Pegawai Sintetis', 'active')",
      [employeeId, `EMP-P23-${employeeId}`],
    );
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  /** Runs work that must fail, without losing the surrounding transaction. */
  async function expectViolation(work: () => Promise<unknown>, code: string) {
    savepoint += 1;
    const name = `sp_${savepoint}`;
    await client.query(`SAVEPOINT ${name}`);
    let thrown: { code?: string } | null = null;
    try {
      await work();
    } catch (error) {
      thrown = error as { code?: string };
    }
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    expect(thrown?.code).toBe(code);
  }

  it("allows one spouse at a time and refuses a second overlapping one", async () => {
    await insertFamilyMember(client, employeeId, SPOUSE, actorId);
    await expectViolation(
      () => insertFamilyMember(client, employeeId, { ...SPOUSE, fullName: "Nama Kedua" }, actorId),
      "23P01",
    );
    // A remarriage after the first ended is a different period, so it fits.
    await client.query(
      "UPDATE employee_family_members SET valid_to = '2020-12-31'::date WHERE employee_id = $1",
      [employeeId],
    );
    await insertFamilyMember(client, employeeId, { ...SPOUSE, fullName: "Nama Kedua", validFrom: "2021-01-01" }, actorId);
    expect(await listFamilyMembers(client, employeeId)).toHaveLength(2);
  });

  it("lets a voided spouse record make room for the correct one", async () => {
    const wrongId = await insertFamilyMember(client, employeeId, SPOUSE, actorId);
    await voidRecord(client, "employee_family_members", wrongId, "Salah entri");
    await insertFamilyMember(client, employeeId, { ...SPOUSE, fullName: "Nama Benar" }, actorId);
    expect(await listFamilyMembers(client, employeeId)).toHaveLength(1);
  });

  it("keeps emergency-contact order unique per period, but lets two orders stand", async () => {
    const contact = {
      ...SPOUSE,
      relation: "ORANG_TUA" as const,
      isEmergencyContact: true,
      emergencyPhone: "0800000001",
      emergencyPriority: 1,
    };
    await insertFamilyMember(client, employeeId, contact, actorId);
    await expectViolation(
      () => insertFamilyMember(client, employeeId, { ...contact, fullName: "Nama Lain", emergencyPhone: "0800000002" }, actorId),
      "23P01",
    );
    await insertFamilyMember(
      client,
      employeeId,
      { ...contact, fullName: "Nama Lain", emergencyPhone: "0800000002", emergencyPriority: 2 },
      actorId,
    );
    const rows = await listFamilyMembers(client, employeeId);
    expect(rows.map((row) => row.emergencyPriority)).toEqual([1, 2]);
  });

  it("refuses a dependent with no birth date and an emergency contact with no phone", async () => {
    await expectViolation(
      () => insertFamilyMember(client, employeeId, { ...SPOUSE, isDependent: true, birthDate: null }, actorId),
      "23514",
    );
    await expectViolation(
      () => insertFamilyMember(
        client,
        employeeId,
        { ...SPOUSE, isEmergencyContact: true, emergencyPhone: null, emergencyPriority: 1 },
        actorId,
      ),
      "23514",
    );
  });

  it("never stores a family identity number, whatever a future route tries", async () => {
    const id = await insertFamilyMember(client, employeeId, SPOUSE, actorId);
    await expectViolation(
      () => client.query("UPDATE employee_family_members SET identity_number = '123' WHERE id = $1", [id]),
      "23514",
    );
  });

  it("allows one address per kind at a time, and the other kind alongside it", async () => {
    await insertAddress(client, employeeId, ADDRESS, actorId);
    await expectViolation(
      () => insertAddress(client, employeeId, { ...ADDRESS, addressLine: "Jalan Lain" }, actorId),
      "23P01",
    );
    // The KTP address is a different kind, so it has its own current record.
    await insertAddress(client, employeeId, { ...ADDRESS, kind: "KTP", addressLine: "Jalan KTP" }, actorId);
    expect((await listAddresses(client, employeeId)).map((row) => row.kind).sort()).toEqual(["DOMISILI", "KTP"]);
  });

  it("moves house by closing the old address the day before the new one", async () => {
    const oldId = await insertAddress(client, employeeId, ADDRESS, actorId);
    const open = await lockOpenAddress(client, employeeId, "DOMISILI");
    expect(open).toMatchObject({ id: oldId, validFrom: "2020-01-01", validTo: null });

    const closing = closingDateFor(open!, "2026-11-01");
    expect(closing).toEqual({ kind: "close", on: "2026-10-31" });
    if (closing.kind !== "close") throw new Error("unreachable");
    await closeAddress(client, oldId, closing.on);
    const newId = await insertAddress(
      client,
      employeeId,
      { ...ADDRESS, addressLine: "Jalan Sintetis 2", validFrom: "2026-11-01" },
      actorId,
    );

    expect(await getAddress(client, oldId)).toMatchObject({ validTo: "2026-10-31" });
    expect(await getAddress(client, newId)).toMatchObject({ validFrom: "2026-11-01", validTo: null });
    expect(await lockOpenAddress(client, employeeId, "DOMISILI")).toMatchObject({ id: newId });
  });

  it("refuses a postal code that is not five digits, and a period that ends before it starts", async () => {
    await expectViolation(() => insertAddress(client, employeeId, { ...ADDRESS, postalCode: "401" }, actorId), "23514");
    await expectViolation(
      () => insertAddress(client, employeeId, { ...ADDRESS, validFrom: "2026-01-01", validTo: "2025-01-01" }, actorId),
      "23514",
    );
  });

  it("tells the lock when the record's employee has left the master", async () => {
    const id = await insertFamilyMember(client, employeeId, SPOUSE, actorId);
    expect(await lockProfileRecord(client, "employee_family_members", id))
      .toMatchObject({ employeeId, employeeRemoved: false });
    await client.query(
      "UPDATE employees SET removed_at = now(), removal_reason = 'Uji sintetis' WHERE id = $1",
      [employeeId],
    );
    expect(await lockProfileRecord(client, "employee_addresses", randomUUID())).toBeNull();
    expect(await lockProfileRecord(client, "employee_family_members", id))
      .toMatchObject({ employeeId, employeeRemoved: true });
  });
});
