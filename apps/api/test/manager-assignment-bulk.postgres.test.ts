// ORG-001 terhadap PostgreSQL sungguhan: penerapan penetapan atasan langsung
// massal menjalankan ketiga statement-nya — UPDATE ... FROM unnest, INSERT audit
// per pegawai lewat unnest, dan INSERT audit batch — lalu hasilnya dibaca
// kembali dari `employees` dan `access_audit_events`.
//
// Suite fake pool mencocokkan potongan SQL; ia tidak pernah mengeksekusinya.
// Jalur inilah yang akan menulis atasan seluruh tenaga kerja sekaligus, jadi
// SQL-nya harus pernah benar-benar dijalankan sebelum HC menjalankannya.
//
// Hanya database loopback CI; orang-orangnya sintetis; semua tulisan di-rollback.

import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  applyManagerAssignments,
  buildManagerAssignmentPreview,
  ManagerAssignmentBatchError,
} from "../src/modules/employees/application/manager-assignment-batch.js";
import { parseManagerAssignmentCsv } from "../src/modules/employees/infrastructure/parse-manager-assignment-csv.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

/** applyManagerAssignments memiliki transaksinya sendiri; BEGIN/COMMIT/ROLLBACK menjadi savepoint milik test. */
function savepointPool(client: PoolClient): Pool {
  let depth = 0;
  const run = async (text: string, values?: unknown[]) => {
    const statement = String(text).trim().toUpperCase();
    if (statement.startsWith("BEGIN")) return client.query(`SAVEPOINT org001_sp_${++depth}`);
    if (statement.startsWith("COMMIT")) {
      const name = `org001_sp_${depth}`;
      depth -= 1;
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    if (statement.startsWith("ROLLBACK")) {
      const name = `org001_sp_${depth}`;
      depth -= 1;
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    return client.query(text, values);
  };
  const handle = { query: run, release: () => undefined };
  return { query: run, connect: async () => handle } as unknown as Pool;
}

function csv(rows: Array<[string, string]>): Buffer {
  return Buffer.from(["NIP,NIP ATASAN", ...rows.map(([nip, manager]) => `${nip},${manager}`)].join("\r\n"), "utf8");
}

describe.skipIf(!allowed)("ORG-001 penerapan massal atasan langsung pada PostgreSQL", () => {
  let pool: Pool;
  let client: PoolClient;
  let db: Pool;
  let actorAccountId: string;
  const people = new Map<string, { id: string; employeeNumber: string }>();

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    db = savepointPool(client);
    people.clear();

    const suffix = randomUUID().slice(0, 8);
    for (const who of ["atasan", "atasanLama", "satu", "dua", "nonaktif"]) {
      const id = randomUUID();
      const employeeNumber = `ORG001-${suffix}-${who}`;
      await client.query(
        `INSERT INTO employees(id, employee_number, full_name, status, started_on)
         VALUES ($1, $2, $3, $4, '2020-01-06')`,
        [id, employeeNumber, `Pegawai Sintetis ${who}`, who === "nonaktif" ? "resigned" : "active"],
      );
      people.set(who, { id, employeeNumber });
    }
    // "dua" sudah punya atasan, supaya audit dapat membuktikan dari siapa ke siapa.
    await client.query(
      "UPDATE employees SET direct_manager_employee_id = $2 WHERE id = $1",
      [people.get("dua")!.id, people.get("atasanLama")!.id],
    );

    actorAccountId = randomUUID();
    await client.query(
      "INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1, $2, $3, 'EMPLOYEE', 'active')",
      [actorAccountId, people.get("atasan")!.id, `org001-${actorAccountId}@example.invalid`],
    );
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  const nip = (who: string) => people.get(who)!.employeeNumber;
  const id = (who: string) => people.get(who)!.id;

  async function managerOf(who: string) {
    const result = await client.query<{ managerId: string | null }>(
      `SELECT direct_manager_employee_id AS "managerId" FROM employees WHERE id = $1`,
      [id(who)],
    );
    return result.rows[0]!.managerId;
  }

  async function auditEvents() {
    const result = await client.query<{
      action: string; entityType: string; entityId: string | null;
      actorAccountId: string | null; payload: Record<string, unknown>;
    }>(
      // Disaring pada actor sintetis test ini: database CI dipakai bersama dan
      // peristiwa milik suite lain tidak boleh ikut terhitung.
      `SELECT action, entity_type AS "entityType", entity_id AS "entityId",
              actor_account_id AS "actorAccountId", payload
         FROM access_audit_events
        WHERE actor_account_id = $1
          AND action IN ('employee.manager.updated', 'employee.manager.batch_applied')
        ORDER BY action, entity_id`,
      [actorAccountId],
    );
    return result.rows;
  }

  async function apply(file: Buffer, previewToken?: string) {
    const sourceRows = parseManagerAssignmentCsv(file);
    const token = previewToken ?? (await buildManagerAssignmentPreview(db, sourceRows)).previewToken;
    return applyManagerAssignments(db, {
      actorAccountId,
      sourceRows,
      previewToken: token,
      sourceFilename: "atasan-sintetis.csv",
      checksumSha256: "0".repeat(64),
    });
  }

  it("menulis atasan kedua pegawai dan mencatat audit yang dapat dibaca kembali", async () => {
    const result = await apply(csv([[nip("satu"), nip("atasan")], [nip("dua"), nip("atasan")]]));

    expect(result.appliedCount).toBe(2);
    expect(await managerOf("satu")).toBe(id("atasan"));
    expect(await managerOf("dua")).toBe(id("atasan"));

    const events = await auditEvents();
    const perEmployee = events.filter((event) => event.action === "employee.manager.updated");
    expect(perEmployee).toHaveLength(2);
    for (const event of perEmployee) {
      expect(event.entityType).toBe("employee");
      expect(event.actorAccountId).toBe(actorAccountId);
      expect(event.payload).toMatchObject({ managerEmployeeId: id("atasan"), source: "BULK_CSV", batchId: result.batchId });
    }
    // Dari siapa ke siapa: "dua" pindah dari atasan lama, "satu" sebelumnya tanpa atasan.
    expect(perEmployee.find((event) => event.entityId === id("dua"))!.payload)
      .toMatchObject({ previousManagerEmployeeId: id("atasanLama") });
    expect(perEmployee.find((event) => event.entityId === id("satu"))!.payload)
      .toMatchObject({ previousManagerEmployeeId: null });

    const batch = events.filter((event) => event.action === "employee.manager.batch_applied");
    expect(batch).toHaveLength(1);
    expect(batch[0]!.entityType).toBe("employee_manager_batch");
    expect(batch[0]!.entityId).toBe(result.batchId);
    expect(batch[0]!.payload).toMatchObject({ rowCount: 2, appliedCount: 2, unchangedCount: 0 });
    expect((batch[0]!.payload as { appliedEmployeeNumbers: string[] }).appliedEmployeeNumbers.sort())
      .toEqual([nip("dua"), nip("satu")].sort());
  });

  it("satu baris tidak sah meninggalkan nol tulisan dan nol baris audit", async () => {
    // Baris kedua menunjuk pegawai yang sudah tidak aktif; baris pertama sah.
    const file = csv([[nip("satu"), nip("atasan")], [nip("dua"), nip("nonaktif")]]);

    await expect(apply(file)).rejects.toMatchObject({ code: "MANAGER_ASSIGNMENT_BATCH_INVALID" });

    expect(await managerOf("satu")).toBeNull();
    expect(await managerOf("dua")).toBe(id("atasanLama"));
    expect(await auditEvents()).toEqual([]);
  });

  it("mengosongkan atasan lewat sel - dan mencatat atasan lamanya", async () => {
    const result = await apply(csv([[nip("dua"), "-"]]));

    expect(result.appliedCount).toBe(1);
    expect(await managerOf("dua")).toBeNull();
    const updated = (await auditEvents()).find((event) => event.action === "employee.manager.updated")!;
    expect(updated.payload).toMatchObject({
      managerEmployeeId: null,
      previousManagerEmployeeId: id("atasanLama"),
    });
  });

  it("menolak penerapan yang tokennya tidak lagi cocok, tanpa menulis apa pun", async () => {
    const file = csv([[nip("satu"), nip("atasan")]]);
    const stale = (await buildManagerAssignmentPreview(db, parseManagerAssignmentCsv(file))).previewToken;
    // Jalur lain memindahkan orang yang sama sesudah dry-run.
    await client.query("UPDATE employees SET direct_manager_employee_id = $2 WHERE id = $1",
      [id("satu"), id("atasanLama")]);

    await expect(apply(file, stale)).rejects.toBeInstanceOf(ManagerAssignmentBatchError);
    expect(await managerOf("satu")).toBe(id("atasanLama"));
    expect(await auditEvents()).toEqual([]);
  });

  it("berkas yang sama dijalankan dua kali tidak menulis apa pun pada kali kedua", async () => {
    const file = csv([[nip("satu"), nip("atasan")]]);
    expect((await apply(file)).appliedCount).toBe(1);

    const second = await apply(file);
    expect(second.appliedCount).toBe(0);
    expect(second.unchangedCount).toBe(1);
    expect(await managerOf("satu")).toBe(id("atasan"));
    // Satu peristiwa per pegawai dari penerapan pertama, dan dua peristiwa batch.
    const events = await auditEvents();
    expect(events.filter((event) => event.action === "employee.manager.updated")).toHaveLength(1);
    expect(events.filter((event) => event.action === "employee.manager.batch_applied")).toHaveLength(2);
  });

  /**
   * ORG-004: bagan terbit paling sederhana yang dapat menentukan atasan —
   * satu unit, satu jabatan pemimpin yang diisi "atasan", "satu" dan "dua"
   * menjadi anggota unit, dan satu authority binding NODE -> LEADER.
   * Kelayakan menuntut atasan punya account EMPLOYEE aktif; account sintetis
   * yang dibuat beforeEach memang milik "atasan".
   */
  async function seedChart() {
    const changeSet = randomUUID();
    const nodeKey = randomUUID();
    const positionKey = randomUUID();
    await client.query(
      `INSERT INTO organization_change_sets (id, name, effective_on, status, created_by_account_id, validated_at, published_at)
       VALUES ($1, 'Bagan uji ORG-001', '2020-01-01'::date, 'PUBLISHED', $2, now(), now())`,
      [changeSet, actorAccountId],
    );
    await client.query(
      `INSERT INTO organization_nodes (id, change_set_id, stable_key, name, node_type, parent_node_key, effective_from)
       VALUES ($1, $2, $3, 'Unit Uji ORG-001', 'UNIT', NULL, '2020-01-01')`,
      [randomUUID(), changeSet, nodeKey],
    );
    await client.query(
      `INSERT INTO organization_positions (id, change_set_id, stable_key, node_key, title, effective_from, holder_source, vacancy_policy)
       VALUES ($1, $2, $3, $4, 'Pemimpin Unit Uji', '2020-01-01', 'EMPLOYEE', 'BLOCK')`,
      [randomUUID(), changeSet, positionKey, nodeKey],
    );
    await client.query(
      `INSERT INTO organization_incumbencies (id, change_set_id, position_key, employee_id, kind, effective_from)
       VALUES ($1, $2, $3, $4, 'PRIMARY', '2020-01-01')`,
      [randomUUID(), changeSet, positionKey, id("atasan")],
    );
    for (const who of ["satu", "dua"]) {
      await client.query(
        `INSERT INTO organization_memberships (id, change_set_id, employee_id, node_key, is_primary, effective_from)
         VALUES ($1, $2, $3, $4, true, '2020-01-01')`,
        [randomUUID(), changeSet, id(who), nodeKey],
      );
    }
    await client.query(
      `INSERT INTO organization_authority_bindings (id, change_set_id, subject_kind, subject_key, binding_type, target_position_key, vacancy_policy, effective_from)
       VALUES ($1, $2, 'NODE', $3, 'LEADER', $4, 'BLOCK', '2020-01-01')`,
      [randomUUID(), changeSet, nodeKey, positionKey],
    );
  }

  async function preview(file: Buffer) {
    return buildManagerAssignmentPreview(db, parseManagerAssignmentCsv(file), { withChartSuggestions: true });
  }

  describe("usulan atasan dari bagan organisasi terbit", () => {
    it("menyebut atasan menurut bagan pada baris yang berkasnya belum menyebut atasan", async () => {
      await seedChart();
      // Sel kosong tetap ditolak — usulan bagan tidak diterapkan diam-diam —
      // tetapi HC dapat membacanya untuk dituliskan ke berkasnya.
      const result = await preview(csv([[nip("satu"), ""]]));

      const row = result.rows[0]!;
      expect(row.outcome).toBe("refused");
      expect(row.code).toBe("MANAGER_NUMBER_REQUIRED");
      expect(row.chartManager).toMatchObject({ employeeNumber: nip("atasan") });
      expect(row.chartIssue).toBeNull();
      expect(row.chartAgrees).toBeNull();
      expect(result.chartSuggestionCount).toBe(1);
      expect(result.applicable).toBe(false);
    });

    it("menandai baris yang berbeda dari bagan dan baris yang sama dengan bagan", async () => {
      await seedChart();
      const result = await preview(csv([
        [nip("satu"), nip("atasan")],
        [nip("dua"), nip("atasanLama")],
      ]));

      const sama = result.rows.find((row) => row.employeeNumber === nip("satu"))!;
      const beda = result.rows.find((row) => row.employeeNumber === nip("dua"))!;
      expect(sama.chartAgrees).toBe(true);
      expect(beda.chartAgrees).toBe(false);
      expect(beda.chartManager).toMatchObject({ employeeNumber: nip("atasan") });
      expect(result.differsFromChartCount).toBe(1);
      // Selisih dengan bagan tidak menolak apa pun; ia hanya diberitahukan.
      expect(result.applicable).toBe(true);
    });

    it("melaporkan alasan saat bagan tidak dapat menentukan atasan", async () => {
      await seedChart();
      // "nonaktif" tidak menjadi anggota unit mana pun di bagan.
      const result = await preview(csv([[nip("nonaktif"), nip("atasan")]]));

      const row = result.rows[0]!;
      expect(row.chartManager).toBeNull();
      expect(row.chartIssue).toBeTruthy();
      expect(row.chartAgrees).toBeNull();
      expect(result.differsFromChartCount).toBe(0);
    });

    it("tidak memakai bagan saat penerapan, dan usulan tidak mengubah token", async () => {
      const file = csv([[nip("satu"), nip("atasanLama")]]);
      const tanpaBagan = (await buildManagerAssignmentPreview(db, parseManagerAssignmentCsv(file))).previewToken;
      await seedChart();
      const denganBagan = await preview(file);

      // Bagan terbit sesudah dry-run pertama; tokennya tetap sama, jadi usulan
      // tidak pernah dapat membatalkan konfirmasi HC.
      expect(denganBagan.previewToken).toBe(tanpaBagan);
      expect(denganBagan.rows[0]!.chartAgrees).toBe(false);

      const applied = await apply(file, tanpaBagan);
      expect(applied.appliedCount).toBe(1);
      expect(await managerOf("satu")).toBe(id("atasanLama"));
    });
  });

  it("menolak siklus yang hanya dibentuk oleh berkasnya, terhadap data sungguhan", async () => {
    const file = csv([[nip("satu"), nip("dua")], [nip("dua"), nip("satu")]]);

    await expect(apply(file)).rejects.toMatchObject({ code: "MANAGER_ASSIGNMENT_BATCH_INVALID" });
    expect(await managerOf("satu")).toBeNull();
    expect(await managerOf("dua")).toBe(id("atasanLama"));
    expect(await auditEvents()).toEqual([]);
  });
});
