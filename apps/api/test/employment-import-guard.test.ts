// EMP-005 S5 import guard (spec §8.1): once the history is AUTHORITATIVE, an
// EMP-004 import no longer writes the nine employment columns of an employee
// that has one, and says so in the audit trail. Fake pool; synthetic rows only.

import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { PROJECTED_IMPORT_FIELDS } from "../src/modules/employment/domain/index.js";
import { PostgresEmployeeImportStore } from "../src/modules/employees/infrastructure/postgres-employee-import-store.js";

const IMPORT_ID = "60000000-0000-4000-8000-000000000001";
const EMPLOYEE_ID = "10000000-0000-4000-8000-000000000001";

const CANDIDATE = {
  employeeNumber: "YSQ-0001",
  fullName: "Pegawai Sintetis",
  status: "active",
  employmentStatus: "Pegawai Kontrak",
  unitName: "SDIT Sintetis",
  positionName: "Guru Kelas",
  employmentType: "Tenaga Pendidik",
  functionalPosition: null,
  structuralPosition: null,
  email: "pegawai@example.test",
  phone: null,
  education: null,
  startedOn: "2026-07-01",
  endedOn: null,
  sourceClassification: null,
};

function createStore(options: {
  mode: "OFF" | "SHADOW" | "AUTHORITATIVE";
  hasEmployment: boolean;
  /** The candidate is marked outside HCIS management (S2B §8.7). */
  outsideHcis?: boolean;
}) {
  const statements: string[] = [];
  const query = vi.fn(async (sql: string) => {
    statements.push(sql);
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM employee_import_jobs WHERE id = $1")) {
      return {
        rows: [{
          id: IMPORT_ID, status: "previewed", error_count: 0, insert_count: 0, update_count: 0,
          source_filename: "sintetis.xlsx", source_sheet: "Sheet1", checksum_sha256: "0".repeat(64),
          row_count: 1, warning_count: 0, created_at: new Date("2027-01-01T00:00:00Z"), committed_at: null,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("count(*) FILTER")) return { rows: [{ total: 1, skip: 0 }], rowCount: 1 };
    if (sql.includes("jsonb_array_elements(messages)")) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM employee_import_rows")) {
      return { rows: [{ row_number: 1, action: "update", payload: CANDIDATE, messages: [] }], rowCount: 1 };
    }
    // S2B §8.7 asks the same shape of question; answer it separately, or the
    // employment-managed set and the outside-HCIS set become the same thing.
    if (sql.includes("management_scope = 'OUTSIDE_HCIS'") && sql.includes("employee_number = ANY")) {
      return options.outsideHcis
        ? { rows: [{ employeeNumber: CANDIDATE.employeeNumber }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes("WHERE employee_number = ANY")) {
      return { rows: [{ employeeNumber: CANDIDATE.employeeNumber }], rowCount: 1 };
    }
    if (sql.includes("FROM employment_rollout_settings WHERE id = 1")) {
      return { rows: [{ mode: options.mode }], rowCount: 1 };
    }
    if (sql.includes("FROM employments WHERE voided_by_action_id IS NULL")) {
      return options.hasEmployment ? { rows: [{ employeeId: EMPLOYEE_ID }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM employees WHERE employee_number = $1")) return { rows: [{ id: EMPLOYEE_ID }], rowCount: 1 };
    if (sql.includes("INSERT INTO organizational_units") || sql.includes("INSERT INTO positions")) {
      return { rows: [{ id: "20000000-0000-4000-8000-000000000001" }], rowCount: 1 };
    }
    if (sql.includes("UPDATE employees SET")) return { rows: [], rowCount: 1 };
    if (sql.includes("UPDATE employee_import_rows")) return { rows: [], rowCount: 1 };
    if (sql.includes("INSERT INTO employment_audit_events")) return { rows: [], rowCount: 1 };
    if (sql.includes("UPDATE employee_import_jobs")) {
      return {
        rows: [{
          id: IMPORT_ID, status: "committed", error_count: 0, insert_count: 0, update_count: 1,
          source_filename: "sintetis.xlsx", source_sheet: "Sheet1", checksum_sha256: "0".repeat(64),
          row_count: 1, warning_count: 0, created_at: new Date("2027-01-01T00:00:00Z"), committed_at: new Date("2027-01-01T00:05:00Z"),
        }],
        rowCount: 1,
      };
    }
    throw new Error(`Unexpected SQL in import guard test: ${sql}`);
  });
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  return { store: new PostgresEmployeeImportStore(pool), statements };
}

function employeeUpdate(statements: string[]): string {
  return statements.find((sql) => sql.includes("UPDATE employees SET")) ?? "";
}

describe("EMP-005 §8.1 import preview", () => {
  it("tells the operator which rows will keep their employment columns", async () => {
    const { store } = createStore({ mode: "AUTHORITATIVE", hasEmployment: true });
    const page = await store.getPreviewPage(IMPORT_ID, { page: 1, pageSize: 25 }, "all");
    expect(page?.rows[0]?.issues.map((issue) => issue.code)).toContain("EMPLOYMENT_FIELDS_IGNORED");
  });

  it("says nothing of the sort while the mode is SHADOW", async () => {
    const { store } = createStore({ mode: "SHADOW", hasEmployment: true });
    const page = await store.getPreviewPage(IMPORT_ID, { page: 1, pageSize: 25 }, "all");
    expect(page?.rows[0]?.issues).toEqual([]);
  });
});

describe("EMP-005 §8.1 import guard", () => {
  it("keeps writing every column while the mode is not AUTHORITATIVE", async () => {
    for (const mode of ["OFF", "SHADOW"] as const) {
      const { store, statements } = createStore({ mode, hasEmployment: true });
      await store.commit(IMPORT_ID);
      const update = employeeUpdate(statements);
      expect(update, mode).toContain("status = $3");
      expect(update, mode).toContain("organizational_unit_id = $5");
      expect(statements.some((sql) => sql.includes("employment_audit_events"))).toBe(false);
    }
  });

  it("leaves the nine employment columns to the history in AUTHORITATIVE", async () => {
    const { store, statements } = createStore({ mode: "AUTHORITATIVE", hasEmployment: true });
    await store.commit(IMPORT_ID);
    const update = employeeUpdate(statements);
    for (const column of ["status =", "employment_status =", "employment_type =", "organizational_unit_id =",
      "position_id =", "functional_position =", "structural_position =", "started_on =", "ended_on ="]) {
      expect(update, column).not.toContain(column);
    }
    // The rest of the master is still import's to write.
    expect(update).toContain("full_name = $2");
    expect(update).toContain("email = $3");
    expect(statements.some((sql) => sql.includes("employment_audit_events"))).toBe(true);
  });

  it("still writes every column for an employee without history", async () => {
    const { store, statements } = createStore({ mode: "AUTHORITATIVE", hasEmployment: false });
    await store.commit(IMPORT_ID);
    expect(employeeUpdate(statements)).toContain("organizational_unit_id = $5");
    expect(statements.some((sql) => sql.includes("employment_audit_events"))).toBe(false);
  });

  it("names exactly the nine projected fields", () => {
    expect([...PROJECTED_IMPORT_FIELDS]).toEqual([
      "status", "employmentStatus", "employmentType", "organizationalUnitId", "positionId",
      "functionalPosition", "structuralPosition", "startedOn", "endedOn",
    ]);
  });
});
