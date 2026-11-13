// PAY-003 PPh21 TER report route: who may read it, from which state, what
// happens without a policy, the CSV, and the sensitive-access record. Fake pool;
// synthetic data and obviously synthetic brackets only.

import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerPayrollRoutes } from "../src/modules/payroll/routes.js";

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://payroll-pph21-routes-test",
  AUTH_MODE: "local" as const,
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

const PERIOD_ID = "50000000-0000-4000-8000-000000000001";
const URL = `/payroll/periods/${PERIOD_ID}/pph21`;

type Persona =
  | "employee"
  | "hc"
  | "calculator"
  | "inputs_only"
  | "module_admin"
  | "director"
  | "finance"
  | "approver_only"
  | "super_admin"
  | "board";

const PERMISSIONS: Record<Persona, string[]> = {
  employee: ["payslips.read.own"],
  hc: ["payroll.policies.manage", "payroll.profiles.manage", "payroll.periods.manage", "payroll.inputs.manage", "payroll.calculate", "payroll.submit"],
  calculator: ["payroll.calculate"],
  inputs_only: ["payroll.inputs.manage"],
  // hcis_module_admin runs the lifecycle with payroll.periods.manage; that alone
  // must not open per-person gross and tax (specification section 7.2).
  module_admin: ["payroll.periods.manage", "payroll.policies.manage", "payroll.profiles.manage"],
  director: ["payroll.approve", "payroll.reopen.approve", "payroll.reports.read.organization"],
  finance: ["payroll.payments.confirm", "payroll.reports.read.organization", "payroll.transfers.read.organization"],
  // Section 7: deciding on a period is not a licence to read its figures.
  approver_only: ["payroll.approve", "payroll.payments.confirm"],
  super_admin: [],
  board: [],
};

const POLICY = {
  source: "Tabel uji sintetis",
  objectCode: "21-100-01",
  ptkpCategory: { "TK/0": "A", "K/1": "B" },
  categories: {
    A: [{ upTo: 1_000_000, rate: 0 }, { upTo: null, rate: 0.01 }],
    B: [{ upTo: null, rate: 0.02 }],
    C: [{ upTo: null, rate: 0.03 }],
  },
};

const SOURCE_ROWS = [
  {
    employmentId: "60000000-0000-4000-8000-000000000001",
    employeeId: "70000000-0000-4000-8000-000000000011",
    employeeNumber: "0016001",
    fullName: "Pegawai Uji",
    ptkpStatus: "TK/0",
    excluded: false,
    exclusionReason: null,
    payFactor: "1.0000",
    blockerCount: 0,
    serviceEndDate: null,
    hasContinuingEmployment: false,
    termCategory: "TETAP",
    earnings: [{ code: "BASIC", amount: "3000000" }, { code: "BPJS_KES_ALLOW", amount: "150000" }],
  },
  {
    employmentId: "60000000-0000-4000-8000-000000000002",
    employeeId: "70000000-0000-4000-8000-000000000012",
    employeeNumber: "2016002",
    fullName: "Pegawai Dua",
    ptkpStatus: null,
    excluded: false,
    exclusionReason: null,
    payFactor: "0.8000",
    blockerCount: 0,
    serviceEndDate: null,
    hasContinuingEmployment: false,
    termCategory: "KONTRAK_HONORER",
    earnings: [{ code: "BASIC", amount: "2000000" }],
  },
];

type Options = {
  state?: string;
  policy?: "valid" | "missing" | "invalid";
  periodMonth?: string;
};

function periodRow(options: Options) {
  const month = options.periodMonth ?? "2026-09-01";
  return {
    id: PERIOD_ID,
    legalEntityKey: null,
    periodMonth: month,
    payDate: `${month.slice(0, 8)}25`,
    periodStart: month,
    periodEnd: `${month.slice(0, 8)}30`,
    cutoffStart: "2026-08-23",
    cutoffEnd: "2026-09-22",
    state: options.state ?? "APPROVED",
    stateBeforeReopenRequest: null,
    submittedByAccountId: null,
    submittedAt: null,
    approvedByAccountId: null,
    approvedAt: null,
    paymentConfirmedAt: null,
    publishedAt: null,
    reopenCount: 0,
    version: 3,
    resultCount: 2,
    blockerCount: 0,
    lastCalculatedAt: "2026-09-20T00:00:00.000Z",
    inputCount: 0,
    lastInputRecordedAt: null,
    calculatedInputCount: 0,
    calculatedLastInputRecordedAt: null,
  };
}

async function call(persona: Persona | "anonymous", url: string, options: Options = {}) {
  const audits: Array<{ action: string; payload: unknown }> = [];
  const sql: string[] = [];
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
    if (text.includes("policy_key = 'PPH21_TER'")) {
      if (options.policy === "missing") return { rows: [], rowCount: 0 };
      const payload = options.policy === "invalid" ? { source: "lama", ptkpCategory: {} } : POLICY;
      return {
        rows: [{ id: "70000000-0000-4000-8000-000000000001", effectiveFrom: "2026-01-01", payload }],
        rowCount: 1,
      };
    }
    if (text.includes("pph21_report_excluded")) {
      return { rows: SOURCE_ROWS, rowCount: SOURCE_ROWS.length };
    }
    if (text.includes("FROM payroll_periods p")) {
      return { rows: [periodRow(options)], rowCount: 1 };
    }
    if (text.includes("INSERT INTO payroll_audit_events")) {
      audits.push({ action: String(values?.[2] ?? ""), payload: JSON.parse(String(values?.[5] ?? "{}")) });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL in PPh21 route test: ${text}`);
  });
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  const app = Fastify({ logger: false });
  await registerPayrollRoutes(app, pool, config);
  const response = await app.inject({
    method: "GET",
    url,
    headers: persona === "anonymous" ? {} : { cookie: "hcis_session=test-token" },
  });
  await app.close();
  return { response, audits, sql };
}

describe("PAY-003 PPh21 report authorization", () => {
  it("is read by payroll.reports.read.organization holders", async () => {
    for (const persona of ["director", "finance"] as const) {
      const { response } = await call(persona, URL);
      expect(response.statusCode, persona).toBe(200);
    }
  }, 20_000);

  it("is read by payroll.calculate or payroll.inputs.manage holders", async () => {
    for (const persona of ["hc", "calculator", "inputs_only"] as const) {
      const { response } = await call(persona, URL);
      expect(response.statusCode, persona).toBe(200);
    }
  });

  it("is closed to payroll.periods.manage without a reading permission, approvers, the board, Super Admin and employees", async () => {
    for (const persona of ["module_admin", "approver_only", "board", "super_admin", "employee"] as const) {
      const { response, sql } = await call(persona, URL);
      expect(response.statusCode, persona).toBe(403);
      expect(response.json().code).toBe("PAYROLL_FORBIDDEN");
      // Refused before the period is looked up, so a 404 never leaks which exist.
      expect(sql.some((text) => text.includes("FROM payroll_periods p")), persona).toBe(false);
    }
  }, 20_000);

  it("asks for a session first", async () => {
    const { response } = await call("anonymous", URL);
    expect(response.statusCode).toBe(401);
  });
});

describe("PAY-003 PPh21 report state and policy", () => {
  it("stays closed until the period is approved, to its runners too", async () => {
    for (const state of ["DRAFT", "COLLECTING", "CALCULATED", "SUBMITTED"]) {
      for (const persona of ["director", "hc"] as const) {
        const { response, audits } = await call(persona, URL, { state });
        expect(response.statusCode, `${persona} ${state}`).toBe(409);
        expect(response.json().code).toBe("PAYROLL_NOT_APPROVED_YET");
        expect(audits).toEqual([]);
      }
    }
  }, 30_000);

  it("opens from approval onwards", async () => {
    for (const state of ["APPROVED", "PAYMENT_CONFIRMED", "PUBLISHED", "REOPEN_REQUESTED"]) {
      const { response } = await call("director", URL, { state });
      expect(response.statusCode, state).toBe(200);
    }
  }, 20_000);

  it("refuses with PPH21_TER_POLICY_MISSING when no version covers the pay date, and records nothing", async () => {
    const { response, audits } = await call("director", URL, { policy: "missing" });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("PPH21_TER_POLICY_MISSING");
    expect(audits).toEqual([]);
  });

  it("refuses a stored version that does not have the shape the report needs", async () => {
    const { response } = await call("director", URL, { policy: "invalid" });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("PPH21_TER_POLICY_INVALID");
  });

  it("refuses an unknown format", async () => {
    const { response } = await call("director", `${URL}?format=xlsx`);
    expect(response.statusCode).toBe(400);
  });
});

describe("PAY-003 PPh21 report content", () => {
  it("reports rows, totals and the policy source, figures as text, no-store", async () => {
    const { response } = await call("director", URL);
    expect(response.headers["cache-control"]).toBe("no-store");
    const { report } = response.json();
    expect(report.taxPeriod).toBe("2026-09");
    expect(report.objectCode).toBe("21-100-01");
    expect(report.policy).toEqual({
      versionId: "70000000-0000-4000-8000-000000000001",
      effectiveFrom: "2026-01-01",
      source: "Tabel uji sintetis",
    });
    // BPJS_KES_ALLOW is left out of the base; the 0.8 factor scales the second.
    expect(report.rows.map((row: { gross: string; tax: string | null; flags: string[] }) => [row.gross, row.tax, row.flags]))
      .toEqual([
        ["3000000", "30000", []],
        ["1600000", null, ["PTKP_MISSING", "NON_PERMANENT_TERMS"]],
      ]);
    expect(report.rows[1].note).toContain("Status PTKP");
    expect(report.totals).toMatchObject({
      employeeCount: 2,
      gross: "4600000",
      tax: "30000",
      ptkpMissingCount: 1,
      nonPermanentCount: 1,
    });
    expect(report.rows[0].employeeId).toBe("70000000-0000-4000-8000-000000000011");
    expect(JSON.stringify(report)).not.toMatch(/bankAccount|nik|npwp/i);
  });

  it("marks every row of a December period as needing the annual calculation", async () => {
    const { response } = await call("director", URL, { periodMonth: "2026-12-01" });
    const { report } = response.json();
    expect(report.rows.every((row: { flags: string[] }) => row.flags.includes("ANNUAL_CALCULATION_REQUIRED"))).toBe(true);
    expect(report.totals.annualCalculationCount).toBe(2);
  });

  it("records the read as sensitive access, with a count and no figure", async () => {
    const { audits } = await call("finance", URL);
    expect(audits).toEqual([{ action: "payroll.report.read", payload: { scope: "pph21_report", row_count: 2 } }]);
  });

  it("exports CSV as an attachment named for the masa pajak, recorded separately", async () => {
    const { response, audits } = await call("finance", `${URL}?format=csv`);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.headers["content-disposition"]).toBe('attachment; filename="pph21-ter-2026-09.csv"');
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.startsWith("﻿")).toBe(true);
    expect(response.body).toContain("\r\n");
    expect(response.body).toContain(`"'0016001","Pegawai Uji","TK/0","A","3000000","1%","30000","21-100-01","Y",""`);
    expect(audits).toEqual([{ action: "payroll.report.read", payload: { scope: "pph21_report_csv", row_count: 2 } }]);
  });
});
