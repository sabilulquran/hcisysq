// ENG-LIST-001 PAG-4 against real PostgreSQL: an employee import preview is read page by page,
// with the issue filter and whole-import aggregates computed in SQL.
// Loopback CI database only; everything runs inside one rolled-back transaction.

import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { normalizeEmployeeImportRow } from "../src/modules/employees/domain/employee-import.js";
import { PostgresEmployeeImportStore } from "../src/modules/employees/infrastructure/postgres-employee-import-store.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

// 30 synthetic rows: every tenth has no NIP (an error), the rest are clean inserts except two skips.
// Every row carries UNIT and JABATAN so the only issues are the three missing NIPs.
function plannedRows() {
  return Array.from({ length: 30 }, (_, index) => {
    const n = index + 1;
    const placement = { UNIT: "Unit Sintetis PAG4", JABATAN: "Staf Sintetis" };
    const source = n % 10 === 0
      ? { NAMA: `Tanpa NIP ${n}`, "STATUS AKTIF": "Aktif", ...placement }
      : { NIP: `PAG4-${String(n).padStart(4, "0")}`, NAMA: `Pegawai Sintetis ${n}`, "STATUS AKTIF": "Aktif", ...placement };
    const normalized = normalizeEmployeeImportRow(n + 2, source);
    const action = n % 10 === 0 ? ("error" as const) : n === 3 || n === 4 ? ("skip" as const) : ("insert" as const);
    return { ...normalized, action };
  });
}

describe.skipIf(!allowed)("PAG-4 employee import preview paging on PostgreSQL", () => {
  let pool: Pool;
  let client: PoolClient;
  let store: PostgresEmployeeImportStore;
  let importId: string;

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
        const savepoint = `pag4_${++sequence}`;
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
    store = new PostgresEmployeeImportStore({ query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool);
    const preview = await store.savePreview({
      sourceFilename: "synthetic-pag4.csv",
      sourceSheet: "CSV",
      checksumSha256: createHash("sha256").update("synthetic-pag4").digest("hex"),
      rows: plannedRows(),
    });
    importId = preview.importId;
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  it("reads every row exactly once across pages, in row order", async () => {
    const first = await store.getPreviewPage(importId, { page: 1, pageSize: 25 }, "all");
    const second = await store.getPreviewPage(importId, { page: 2, pageSize: 25 }, "all");
    expect(first?.pagination).toEqual({ page: 1, pageSize: 25, total: 30, pageCount: 2 });
    expect(second?.rows).toHaveLength(5);
    const numbers = [...(first?.rows ?? []), ...(second?.rows ?? [])].map((row) => row.rowNumber);
    expect(numbers).toEqual(Array.from({ length: 30 }, (_, index) => index + 3));
    const past = await store.getPreviewPage(importId, { page: 3, pageSize: 25 }, "all");
    expect(past?.rows).toEqual([]);
    expect(past?.pagination.total).toBe(30);
  });

  it("filters to rows with issues and keeps the aggregates for the whole import", async () => {
    const all = await store.getPreviewPage(importId, { page: 1, pageSize: 25 }, "all");
    expect(all?.rows.some((row) => row.issues.length === 0)).toBe(true);

    const issues = await store.getPreviewPage(importId, { page: 1, pageSize: 25 }, "issues");
    expect(issues?.rows.map((row) => row.rowNumber)).toEqual([12, 22, 32]);
    expect(issues?.pagination).toEqual({ page: 1, pageSize: 25, total: 3, pageCount: 1 });
    expect(issues?.skipCount).toBe(2);
    expect(issues?.issueSummary).toEqual([{ code: "missing_employee_number", severity: "error", count: 3 }]);
  });

  it("returns null for an unknown import", async () => {
    expect(await store.getPreviewPage("00000000-0000-4000-8000-000000000000", { page: 1, pageSize: 25 }, "all")).toBeNull();
  });
});
