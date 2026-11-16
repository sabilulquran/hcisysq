// PAY-003 annual PPh21 / 1721-A1 / tax identity routes: who may read and write,
// what each answers, and that no figure or identity number reaches an audit
// payload. Fake pool; synthetic people; obviously synthetic TER brackets.

import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerPph21AnnualRoutes } from "../src/modules/payroll/pph21-annual-routes.js";
import { sealTaxIdentity } from "../src/modules/payroll/tax-identity.js";

const KEY = "11".repeat(32);
const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://payroll-pph21-annual-routes-test",
  AUTH_MODE: "local" as const,
  AUTH_ENCRYPTION_KEY: KEY,
  AUTH_SESSION_TTL_HOURS: 8,
};

const EMPLOYEE_ID = "7a000000-0000-4000-8000-000000000011";
const OTHER_EMPLOYEE_ID = "7a000000-0000-4000-8000-000000000099";
const NIK = "3209010101900001";
const RECAP = "/payroll/pph21/annual?year=2026";
const A1 = `/payroll/pph21/annual/2026/employees/${EMPLOYEE_ID}/a1/1`;
const IDENTITY = `/payroll/employees/${EMPLOYEE_ID}/tax-identity`;

type Persona =
  | "employee"
  | "hc"
  | "module_admin"
  | "director"
  | "report_only"
  | "approver_only"
  | "super_admin"
  | "board";

const PERMISSIONS: Record<Persona, string[]> = {
  employee: ["payslips.read.own"],
  hc: ["payroll.profiles.manage", "payroll.periods.manage", "payroll.inputs.manage", "payroll.calculate"],
  module_admin: ["payroll.periods.manage", "payroll.policies.manage"],
  director: ["payroll.approve", "payroll.reports.read.organization", "payroll.results.read.organization"],
  report_only: ["payroll.reports.read.organization"],
  approver_only: ["payroll.approve", "payroll.payments.confirm"],
  super_admin: [],
  board: [],
};

const ANNUAL_POLICY = {
  source: "Contoh uji",
  ptkp: { taxpayer: 54_000_000, married: 4_500_000, perDependent: 4_500_000, maxDependents: 3 },
  positionCost: { rate: 0.05, monthlyCap: 500_000, annualCap: 6_000_000 },
  brackets: [{ upTo: 60_000_000, rate: 0.05 }, { upTo: null, rate: 0.15 }],
  pkpRoundingUnit: 1000,
};

const TER_POLICY = {
  source: "Tabel uji sintetis",
  objectCode: "21-100-01",
  ptkpCategory: { "TK/0": "A" },
  categories: {
    A: [{ upTo: null, rate: 0.01 }],
    B: [{ upTo: null, rate: 0.02 }],
    C: [{ upTo: null, rate: 0.03 }],
  },
};

type Options = {
  /** State of the single December period. */
  state?: string;
  /** Month of the single period; November keeps the span open. */
  month?: string;
  annualPolicy?: boolean;
  /** A month of the year reopened back to COLLECTING. */
  reopenedMonth?: string;
  /** The employee the signed-in account is linked to. */
  linkedEmployeeId?: string;
  body?: unknown;
  method?: "GET" | "PUT";
};

async function call(persona: Persona | "anonymous", url: string, options: Options = {}) {
  const audits: Array<{ action: string; payload: Record<string, unknown> }> = [];
  const writes: unknown[][] = [];
  const sql: string[] = [];
  const month = options.month ?? "2026-12";
  const state = options.state ?? "PUBLISHED";
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    sql.push(text);
    if (text.includes("FROM auth_sessions s")) {
      if (persona === "anonymous") return { rows: [], rowCount: 0 };
      return {
        rows: [{
          sessionId: "00000000-0000-4000-8000-000000000100",
          accountId: "00000000-0000-4000-8000-000000000001",
          email: `${persona}@example.invalid`,
          principalType:
            persona === "super_admin" ? "SUPER_ADMIN" : persona === "board" ? "FOUNDATION_BOARD" : "EMPLOYEE",
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        }],
        rowCount: 1,
      };
    }
    if (text.includes("UPDATE auth_sessions SET last_seen_at")) return { rows: [], rowCount: 1 };
    if (text.includes('SELECT DISTINCT role_permission.permission_key AS "permissionKey"')) {
      const keys = persona === "anonymous" ? [] : PERMISSIONS[persona];
      return { rows: keys.map((permissionKey) => ({ permissionKey })), rowCount: keys.length };
    }
    if (text.includes("account.principal_type = 'EMPLOYEE'")) {
      return { rows: persona === "employee" ? [{ employeeId: EMPLOYEE_ID }] : [], rowCount: 1 };
    }
    if (text.includes('SELECT employee_id AS "employeeId" FROM accounts')) {
      return { rows: [{ employeeId: options.linkedEmployeeId ?? OTHER_EMPLOYEE_ID }], rowCount: 1 };
    }
    if (text.includes("policy_key = 'PPH21_ANNUAL'")) {
      if (options.annualPolicy === false) return { rows: [], rowCount: 0 };
      return { rows: [{ id: "a1", effectiveFrom: "2026-01-01", payload: ANNUAL_POLICY }], rowCount: 1 };
    }
    if (text.includes("policy_key = 'PPH21_TER'")) {
      return { rows: [{ id: "t1", effectiveFrom: "2026-01-01", payload: TER_POLICY }], rowCount: 1 };
    }
    if (text.includes("FROM payroll_periods") && text.includes("ORDER BY period_month")) {
      return {
        rows: [{
          id: "50000000-0000-4000-8000-000000000012",
          periodMonth: `${month}-01`,
          periodStart: `${month}-01`,
          periodEnd: `${month}-28`,
          payDate: `${month}-25`,
          state,
        }, ...(options.reopenedMonth ? [{
          id: "50000000-0000-4000-8000-000000000005",
          periodMonth: `${options.reopenedMonth}-01`,
          periodStart: `${options.reopenedMonth}-01`,
          periodEnd: `${options.reopenedMonth}-28`,
          payDate: `${options.reopenedMonth}-25`,
          state: "COLLECTING",
        }] : [])],
        rowCount: 1,
      };
    }
    if (text.includes("pph21_report_excluded")) {
      return {
        rows: [{
          employmentId: "60000000-0000-4000-8000-000000000001",
          employeeId: EMPLOYEE_ID,
          employeeNumber: "0016001",
          fullName: "Pegawai Uji",
          ptkpStatus: "TK/0",
          excluded: false,
          exclusionReason: null,
          payFactor: "1.0000",
          blockerCount: 0,
          serviceEndDate: null,
          hasContinuingEmployment: true,
          termCategory: "TETAP",
          earnings: [{ code: "BASIC", amount: "70000000" }],
          deductions: [],
        }],
        rowCount: 1,
      };
    }
    if (text.includes("SELECT DISTINCT extract(year")) return { rows: [{ year: 2026 }], rowCount: 1 };
    if (text.includes("AS month FROM payroll_periods")) {
      return { rows: state === "PUBLISHED" ? [{ month }] : [], rowCount: 1 };
    }
    if (text.includes("FROM payroll_tax_identities")) {
      return {
        rows: [{
          employeeId: EMPLOYEE_ID,
          nikSealed: sealTaxIdentity(KEY, EMPLOYEE_ID, "nik", NIK),
          nikLast4: "0001",
          npwpSealed: null,
          npwpLast4: null,
          updatedAt: "2026-11-01T08:00:00",
        }],
        rowCount: 1,
      };
    }
    if (text.includes("SELECT 1 FROM employees")) return { rows: [{}], rowCount: 1 };
    if (text.includes("FROM employees WHERE id = $1")) {
      return { rows: [{ employeeId: EMPLOYEE_ID, employeeNumber: "0016001", fullName: "Pegawai Uji", position: "Guru" }], rowCount: 1 };
    }
    if (text.includes("INSERT INTO payroll_tax_identities")) {
      writes.push(values ?? []);
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("INSERT INTO payroll_audit_events")) {
      audits.push({ action: String(values?.[2] ?? ""), payload: JSON.parse(String(values?.[5] ?? "{}")) });
      return { rows: [], rowCount: 1 };
    }
    // Transaction control and the signer resolver's lookups: nothing to return.
    return { rows: [], rowCount: 0 };
  });
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  const app = Fastify({ logger: false });
  await registerPph21AnnualRoutes(app, pool, config);
  const response = await app.inject({
    method: options.method ?? "GET",
    url,
    headers: persona === "anonymous" ? {} : { cookie: "hcis_session=test-token" },
    ...(options.body === undefined ? {} : { payload: options.body as object }),
  });
  await app.close();
  return { response, audits, writes, sql };
}

/** A per-person amount or an identity number must never reach the audit payload (section 8). */
function expectCleanAudit(audits: Array<{ payload: Record<string, unknown> }>) {
  for (const audit of audits) {
    const text = JSON.stringify(audit.payload);
    expect(text).not.toContain(NIK);
    expect(text).not.toContain("70000000");
    for (const key of ["amount", "gross", "net", "nik", "npwp", "tax"]) expect(audit.payload).not.toHaveProperty(key);
  }
}

describe("annual recap authorization", () => {
  it("is read by per-person readers only", async () => {
    for (const persona of ["hc", "director"] as const) {
      expect((await call(persona, RECAP)).response.statusCode, persona).toBe(200);
    }
    for (const persona of ["module_admin", "report_only", "approver_only", "super_admin", "board", "employee"] as const) {
      const { response, sql } = await call(persona, RECAP);
      expect(response.statusCode, persona).toBe(403);
      expect(sql.some((text) => text.includes("FROM payroll_periods")), persona).toBe(false);
    }
    expect((await call("anonymous", RECAP)).response.statusCode).toBe(401);
  }, 30_000);
});

describe("annual recap", () => {
  it("settles December and says whether NIK/NPWP are on file without printing them", async () => {
    const { response, audits } = await call("director", RECAP);
    expect(response.headers["cache-control"]).toBe("no-store");
    const row = response.json().annual.rows[0];
    // 70 jt; biaya jabatan 500 rb (one month); neto 69,5 jt; PKP 15,5 jt; 5% = 775 rb.
    expect(row).toMatchObject({ closed: true, gross: "70000000", net: "69500000", pkp: "15500000", annualTax: "775000", finalMasaTax: "775000" });
    expect(row.taxIdentity).toEqual({ nik: true, npwp: false });
    expect(response.body).not.toContain(NIK);
    expect(audits).toEqual([{ action: "payroll.report.read", payload: { scope: "pph21_annual", tax_year: 2026, row_count: 1 } }]);
  });

  it("exports the e-Bupot recap with the NIK and records the export without it", async () => {
    const { response, audits } = await call("hc", `${RECAP}&format=csv`);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.body).toContain(`'${NIK}`);
    expect(audits[0]!.payload).toMatchObject({ scope: "pph21_annual_csv", includes_tax_identity: true });
    expectCleanAudit(audits);
  });

  it("answers 409 without a PPH21_ANNUAL policy and 400 for a bad year", async () => {
    const { response } = await call("hc", RECAP, { annualPolicy: false });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("PPH21_ANNUAL_POLICY_MISSING");
    expect((await call("hc", "/payroll/pph21/annual?year=1999")).response.statusCode).toBe(400);
  });
});

describe("1721-A1 for HC", () => {
  it("prints the NIK on the document and audits the read without it", async () => {
    const { response, audits } = await call("director", A1);
    expect(response.statusCode).toBe(200);
    const a1 = response.json().a1;
    expect(a1.employee).toMatchObject({ nik: NIK, npwp: null, position: "Guru" });
    expect(a1.segment).toMatchObject({ annualTax: "775000", endPeriod: "2026-12" });
    expect(a1.objectCode).toBe("21-100-01");
    expect(audits.map((audit) => audit.action)).toEqual(["payroll.a1.read"]);
    expectCleanAudit(audits);
  });

  it("refuses a span whose final masa pajak has not come, a missing one, and non-readers", async () => {
    const open = await call("hc", A1, { month: "2026-11" });
    expect(open.response.statusCode).toBe(409);
    expect(open.response.json().code).toBe("PPH21_A1_NOT_FINAL");
    expect((await call("hc", A1.replace(/\/1$/, "/2"))).response.statusCode).toBe(404);
    expect((await call("module_admin", A1)).response.statusCode).toBe(403);
    expect((await call("employee", A1)).response.statusCode).toBe(403);
  });
});

describe("1721-A1 with a period of the year not final", () => {
  it("refuses HC and hides it from the employee while an earlier month is reopened", async () => {
    const hc = await call("hc", A1, { reopenedMonth: "2026-05" });
    expect(hc.response.statusCode).toBe(409);
    expect(hc.response.json().code).toBe("PPH21_A1_PERIOD_PENDING");
    expect(hc.audits).toEqual([]);
    expect((await call("employee", "/payroll/me/a1", { reopenedMonth: "2026-05" })).response.json().items).toEqual([]);
    expect((await call("employee", "/payroll/me/a1/2026/1", { reopenedMonth: "2026-05" })).response.statusCode).toBe(404);
    const recap = await call("director", RECAP, { reopenedMonth: "2026-05" });
    expect(recap.response.json().annual.rows[0].flags).toContain("PERIOD_PENDING");
  });
});

describe("1721-A1 for the employee", () => {
  it("lists and opens the own bukti potong once the final masa pajak is published", async () => {
    const list = await call("employee", "/payroll/me/a1");
    expect(list.response.json().items).toEqual([{ year: 2026, index: 1, startPeriod: "2026-12", endPeriod: "2026-12" }]);
    expect(list.response.body).not.toContain("70000000");
    const doc = await call("employee", "/payroll/me/a1/2026/1");
    expect(doc.response.statusCode).toBe(200);
    expect(doc.response.json().a1.employee.nik).toBe(NIK);
    expect(doc.audits[0]!.payload).toMatchObject({ scope: "pph21_a1_self" });
    expectCleanAudit(doc.audits);
  });

  it("hides it while the period is approved but not published, and from accounts without an active employee", async () => {
    expect((await call("employee", "/payroll/me/a1", { state: "APPROVED" })).response.json().items).toEqual([]);
    expect((await call("employee", "/payroll/me/a1/2026/1", { state: "APPROVED" })).response.statusCode).toBe(404);
    expect((await call("director", "/payroll/me/a1")).response.statusCode).toBe(403);
    expect((await call("anonymous", "/payroll/me/a1")).response.statusCode).toBe(401);
  });
});

describe("tax identity", () => {
  it("is read masked and written by payroll.profiles.manage only", async () => {
    const read = await call("hc", IDENTITY);
    expect(read.response.json().taxIdentity).toMatchObject({ nikMasked: "************0001", npwpMasked: null });
    expect(read.response.body).not.toContain(NIK);
    for (const persona of ["director", "module_admin", "employee"] as const) {
      expect((await call(persona, IDENTITY, { method: "PUT", body: { nik: NIK } })).response.statusCode, persona).toBe(
        403,
      );
    }
  });

  it("seals the NIK, audits which field changed and never the value", async () => {
    const { response, audits, writes } = await call("hc", IDENTITY, { method: "PUT", body: { nik: "3209.0101.0190.0001" } });
    expect(response.statusCode).toBe(200);
    expect(JSON.stringify(writes)).not.toContain(NIK);
    expect(writes[0]![2]).toBe("0001");
    expect(audits).toEqual([
      { action: "payroll.tax_identity.updated", payload: { employee_id: EMPLOYEE_ID, fields: ["nik"], cleared: [] } },
    ]);
  });

  it("refuses a malformed number, an empty body, and the holder's own record", async () => {
    expect((await call("hc", IDENTITY, { method: "PUT", body: { nik: "123" } })).response.statusCode).toBe(400);
    expect((await call("hc", IDENTITY, { method: "PUT", body: {} })).response.statusCode).toBe(400);
    const own = await call("hc", IDENTITY, { method: "PUT", body: { nik: NIK }, linkedEmployeeId: EMPLOYEE_ID });
    expect(own.response.statusCode).toBe(403);
    expect(own.response.json().code).toBe("PAYROLL_SELF_EDIT_FORBIDDEN");
  });
});
