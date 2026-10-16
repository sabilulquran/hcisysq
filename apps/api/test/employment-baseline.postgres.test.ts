// EMP-005 S2 against real PostgreSQL: import source snapshot writer, baseline
// dry-run/apply/idempotency/exclusions, and the 0058 permission bundle.
// Loopback CI database only; everything runs inside one rolled-back transaction.

import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { normalizeEmployeeImportRow } from "../src/modules/employees/domain/employee-import.js";
import { PostgresEmployeeImportStore } from "../src/modules/employees/infrastructure/postgres-employee-import-store.js";
import { runEmploymentBaseline } from "../src/modules/employment/application/baseline-service.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

const ROWS = [
  { NIP: "EMPS2-0001", NAMA: "Guru Tetap Sintetis", "STATUS AKTIF": "Aktif", "STATUS KEPEGAWAIAN": "Pegawai Tetap", "JENIS KEPEGAWAIAN": "Tenaga Pendidik", UNIT: "SDIT Sintetis S2", JABATAN: "Guru Kelas", TMT: "2019-07-15" },
  { NIP: "EMPS2-0002", NAMA: "Kontrak Sintetis", "STATUS AKTIF": "Aktif PKWT", "STATUS KEPEGAWAIAN": "", "JENIS KEPEGAWAIAN": "Tenaga Kependidikan", UNIT: "SDIT Sintetis S2", JABATAN: "Staf TU", TMT: "2025-01-02" },
  { NIP: "EMPS2-0003", NAMA: "BUMY Sintetis", "STATUS AKTIF": "Aktif BUMY", "STATUS KEPEGAWAIAN": "Pegawai Kontrak", "JENIS KEPEGAWAIAN": "Tenaga Kependidikan", UNIT: "BUMY Sintetis", JABATAN: "Staf", TMT: "2024-01-01" },
  { NIP: "EMPS2-0004", NAMA: "Pengurus Sintetis", "STATUS AKTIF": "Aktif", "STATUS KEPEGAWAIAN": "Pengurus Yayasan", "JENIS KEPEGAWAIAN": "-", UNIT: "Yayasan Sintetis", JABATAN: "Pengurus", TMT: "2020-01-01" },
  { NIP: "EMPS2-0005", NAMA: "Keluar Sintetis", "STATUS AKTIF": "Tidak Aktif", "STATUS KEPEGAWAIAN": "Pegawai Kontrak", "JENIS KEPEGAWAIAN": "Tenaga Pendidik", UNIT: "SDIT Sintetis S2", JABATAN: "Guru", TMT: "2021-07-01", "TAHUN KELUAR (TTTT-BB)": "2024-06" },
];

describe.skipIf(!allowed)("EMP-005 S2 baseline on PostgreSQL", () => {
  let pool: Pool;
  let client: PoolClient;
  let transactionPool: Pool;
  let employeeIds: string[];

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    const stack: string[] = [];
    let sequence = 0;
    const query = async (text: string, values?: unknown[]) => {
      const command = text.trim().toUpperCase();
      if (command === "BEGIN") {
        const savepoint = `emp_s2_${++sequence}`;
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
    transactionPool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;

    const store = new PostgresEmployeeImportStore(transactionPool);
    const rows = ROWS.map((source, index) => ({ ...normalizeEmployeeImportRow(index + 3, source), action: "insert" as const }));
    const preview = await store.savePreview({
      sourceFilename: "synthetic-emp-s2.xlsx",
      sourceSheet: "Master Data SDM YSQ",
      checksumSha256: createHash("sha256").update("synthetic-emp-s2").digest("hex"),
      rows,
    });
    await store.commit(preview.importId);
    const ids = await client.query<{ id: string }>(
      "SELECT id FROM employees WHERE employee_number LIKE 'EMPS2-%' ORDER BY employee_number",
    );
    employeeIds = ids.rows.map((row) => row.id);
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  it("import commit keeps the raw classification values in source snapshots", async () => {
    const snapshots = await client.query<{ employeeNumber: string; statusActive: string }>(
      `SELECT e.employee_number AS "employeeNumber", s.source_data->>'STATUS AKTIF' AS "statusActive"
       FROM employee_import_source_snapshots s JOIN employees e ON e.id = s.employee_id
       WHERE e.employee_number LIKE 'EMPS2-%' ORDER BY e.employee_number`,
    );
    expect(snapshots.rows.map((row) => row.statusActive)).toEqual(["Aktif", "Aktif PKWT", "Aktif BUMY", "Aktif", "Tidak Aktif"]);
    const statuses = await client.query<{ status: string }>("SELECT status FROM employees WHERE employee_number = 'EMPS2-0003'");
    expect(statuses.rows[0]?.status).toBe("active");
  });

  it("dry-run writes nothing and reports counts only", async () => {
    const summary = await runEmploymentBaseline(transactionPool, { apply: false, cutoff: "2026-11-01", employeeIds });
    expect(summary).toMatchObject({ dryRun: true, considered: 5, created: 3, excluded: { BUMY: 1, PENGURUS_YAYASAN: 1 } });
    expect(JSON.stringify(summary)).not.toMatch(/Sintetis|EMPS2/);
    const rows = await client.query("SELECT 1 FROM employments WHERE employee_id = ANY($1::uuid[])", [employeeIds]);
    expect(rows.rowCount).toBe(0);
  });

  it("applies the baseline once, excludes BUMY and Pengurus Yayasan, and never changes accounts", async () => {
    const accountsBefore = await client.query("SELECT id, status FROM accounts ORDER BY id");
    const summary = await runEmploymentBaseline(transactionPool, { apply: true, cutoff: "2026-11-01", employeeIds });
    expect(summary).toMatchObject({ dryRun: false, created: 3, skippedExisting: 0, excluded: { BUMY: 1, PENGURUS_YAYASAN: 1 } });
    expect(summary.issueCounts).toMatchObject({ BASELINE_CONTRACT_END_UNKNOWN: 1, BASELINE_EXCLUDED_BUMY: 1, BASELINE_EXCLUDED_FOUNDATION_BOARD: 1 });

    const employments = await client.query<{ employeeNumber: string; startedOn: string; endedOn: string | null; endPrecision: string | null; category: string }>(
      `SELECT e2.employee_number AS "employeeNumber", e.started_on::text AS "startedOn", e.ended_on::text AS "endedOn",
              e.end_precision AS "endPrecision", t.category
       FROM employments e JOIN employees e2 ON e2.id = e.employee_id JOIN employment_terms t ON t.employment_id = e.id
       WHERE e.employee_id = ANY($1::uuid[]) ORDER BY e2.employee_number`,
      [employeeIds],
    );
    expect(employments.rows).toEqual([
      { employeeNumber: "EMPS2-0001", startedOn: "2019-07-15", endedOn: null, endPrecision: null, category: "TETAP" },
      { employeeNumber: "EMPS2-0002", startedOn: "2025-01-02", endedOn: null, endPrecision: null, category: "KONTRAK" },
      { employeeNumber: "EMPS2-0005", startedOn: "2021-07-01", endedOn: "2024-06-30", endPrecision: "MONTH", category: "KONTRAK" },
    ]);
    const placements = await client.query<{ effectiveFrom: string; basis: string }>(
      `SELECT p.effective_from::text AS "effectiveFrom", p.effective_from_basis AS basis
       FROM employment_placements p JOIN employments e ON e.id = p.employment_id WHERE e.employee_id = ANY($1::uuid[])`,
      [employeeIds],
    );
    expect(placements.rows).toEqual([
      { effectiveFrom: "2026-11-01", basis: "BASELINE_ASSUMED" },
      { effectiveFrom: "2026-11-01", basis: "BASELINE_ASSUMED" },
    ]);

    const audit = await client.query<{ action: string; payload: Record<string, unknown> }>(
      `SELECT action, payload FROM employment_audit_events
       WHERE employee_id = ANY($1::uuid[]) OR (action = 'employment.baseline.run' AND employee_id IS NULL)`,
      [employeeIds],
    );
    expect(audit.rows.filter((row) => row.action === "employment.baseline.created")).toHaveLength(3);
    for (const row of audit.rows.filter((entry) => entry.action === "employment.baseline.created")) {
      expect(Object.keys(row.payload).sort()).toEqual(["employmentId", "issueCodes", "sourceImportJobId"]);
    }
    expect(JSON.stringify(audit.rows)).not.toMatch(/Sintetis|EMPS2/);
    expect((await client.query("SELECT id, status FROM accounts ORDER BY id")).rows).toEqual(accountsBefore.rows);

    const again = await runEmploymentBaseline(transactionPool, { apply: true, cutoff: "2026-11-02", employeeIds });
    expect(again).toMatchObject({ created: 0, skippedExisting: 3 });
  });

  it("re-runs the baseline for one employee by purging only baseline-only rows", async () => {
    await runEmploymentBaseline(transactionPool, { apply: true, cutoff: "2026-11-01", employeeIds });
    const first = employeeIds[0]!;
    const before = await client.query<{ id: string }>("SELECT id FROM employments WHERE employee_id = $1", [first]);
    const summary = await runEmploymentBaseline(transactionPool, { apply: true, cutoff: "2026-11-05", employeeIds: [first], rerun: true });
    expect(summary).toMatchObject({ purged: 1, created: 1 });
    const after = await client.query<{ id: string }>("SELECT id FROM employments WHERE employee_id = $1", [first]);
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]?.id).not.toBe(before.rows[0]?.id);
  });

  it("refuses to run while the rollout mode is AUTHORITATIVE", async () => {
    await client.query(
      "INSERT INTO employment_rollout_settings (id, mode, reason) VALUES (1, 'AUTHORITATIVE', 'Synthetic refusal test') ON CONFLICT (id) DO UPDATE SET mode = EXCLUDED.mode",
    );
    await expect(runEmploymentBaseline(transactionPool, { apply: true, cutoff: "2026-11-01", employeeIds })).rejects.toMatchObject({
      code: "EMPLOYMENT_BASELINE_MODE_AUTHORITATIVE",
    });
  });

  it("bundles employment.read and employment.manage for human_capital_admin but not employment.correct (D-16)", async () => {
    const result = await client.query<{ permissionKey: string }>(
      `SELECT rp.permission_key AS "permissionKey" FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
       WHERE r.role_key = 'human_capital_admin' AND rp.permission_key LIKE 'employment.%' ORDER BY 1`,
    );
    expect(result.rows.map((row) => row.permissionKey)).toEqual(["employment.manage", "employment.read"]);
    const all = await client.query("SELECT 1 FROM permissions WHERE permission_key = 'employment.correct'");
    expect(all.rowCount).toBe(1);
  });
});
