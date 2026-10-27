// PAY-003 reference data routes: who may write policy, profiles and loans, that
// every write opens a new effective-dated row, and that loans lock once a period
// has been calculated. Fake pool; synthetic data only.

import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerPayrollAdminRoutes } from "../src/modules/payroll/admin-routes.js";

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://payroll-admin-routes-test",
  AUTH_MODE: "local" as const,
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

const PERIOD_ID = "50000000-0000-4000-8000-000000000001";
const EMPLOYMENT_ID = "60000000-0000-4000-8000-000000000001";
const OWN_EMPLOYMENT_ID = "60000000-0000-4000-8000-000000000002";
const EMPLOYEE_ID = "70000000-0000-4000-8000-000000000001";
const LOAN_ID = "80000000-0000-4000-8000-000000000001";

type Persona = "anonymous" | "employee" | "hc" | "finance" | "director" | "super_admin";

const PERMISSIONS: Record<Persona, string[]> = {
  anonymous: [],
  employee: ["payslips.read.own"],
  hc: [
    "payroll.policies.manage",
    "payroll.profiles.manage",
    "payroll.periods.manage",
    "payroll.inputs.manage",
    "payroll.calculate",
    "payroll.submit",
  ],
  finance: ["payroll.loans.manage"],
  director: ["payroll.approve", "payroll.reopen.approve", "payroll.reports.read.organization"],
  super_admin: [],
};

type Options = {
  periodState?: string;
  loanBalance?: number;
  insertError?: string;
  /** A period already calculated whose pay date the write would reach back past. */
  settledPeriodMonth?: string;
  loanClosed?: boolean;
};

function createPool(persona: Persona, options: Options = {}) {
  const audits: string[] = [];
  const writes: string[] = [];
  const closed: string[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM auth_sessions s")) {
      if (persona === "anonymous") return { rows: [], rowCount: 0 };
      return {
        rows: [{
          sessionId: "00000000-0000-4000-8000-000000000100",
          accountId: "00000000-0000-4000-8000-000000000001",
          email: `${persona}@example.invalid`,
          principalType: persona === "super_admin" ? "SUPER_ADMIN" : "EMPLOYEE",
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("UPDATE auth_sessions SET last_seen_at")) return { rows: [], rowCount: 1 };
    if (sql.includes('SELECT DISTINCT role_permission.permission_key AS "permissionKey"')) {
      const keys = PERMISSIONS[persona];
      return { rows: keys.map((permissionKey) => ({ permissionKey })), rowCount: keys.length };
    }
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes('to_char(period_month')) {
      return options.settledPeriodMonth
        ? { rows: [{ periodMonth: options.settledPeriodMonth }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes('closed_at AS "closedAt" FROM payroll_loans')) {
      return { rows: [{ closedAt: options.loanClosed ? "2026-06-01T00:00:00.000Z" : null }], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM payroll_loan_deductions")) {
      writes.push("loan_deduction_removed");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("JOIN accounts a ON a.employee_id = e.employee_id")) {
      return { rows: [{ id: OWN_EMPLOYMENT_ID }], rowCount: 1 };
    }
    if (sql.includes("UPDATE payroll_policy_versions") || sql.includes("UPDATE payroll_compensation_profiles")) {
      closed.push(sql.replace(/\s+/g, " ").trim().slice(0, 40));
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO payroll_policy_versions")) {
      if (options.insertError) {
        const error = new Error("insert refused") as Error & { code?: string };
        error.code = options.insertError;
        throw error;
      }
      writes.push("policy");
      return { rows: [{ id: "policy-1", policyKey: String(values?.[1] ?? ""), effectiveFrom: "2026-01-01" }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO payroll_compensation_profiles")) {
      if (options.insertError) {
        const error = new Error("insert refused") as Error & { code?: string };
        error.code = options.insertError;
        throw error;
      }
      writes.push("profile");
      return { rows: [{ id: "profile-1", employmentId: String(values?.[1] ?? "") }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO payroll_loans")) {
      writes.push("loan");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("count(*)::int AS total")) {
      return { rows: [{ total: 1 }], rowCount: 1 };
    }
    if (sql.includes("FROM employments e")) {
      return {
        rows: [{
          employmentId: EMPLOYMENT_ID,
          employeeId: EMPLOYEE_ID,
          employeeNumber: "YSQ-0001",
          fullName: "Pegawai Uji",
          startedOn: "2020-01-01",
          endedOn: null,
          profileCount: 1,
        }],
        rowCount: 1,
      };
    }
    // The balance query also reads payroll_loans, so it has to be matched first.
    if (sql.includes("balance")) {
      return { rows: [{ balance: String(options.loanBalance ?? 900_000) }], rowCount: 1 };
    }
    if (sql.includes("FROM payroll_loans l")) {
      return { rows: [{ id: LOAN_ID, employeeId: EMPLOYEE_ID, principal: "1200000", outstanding: "900000" }], rowCount: 1 };
    }
    if (sql.includes("FROM payroll_policy_versions")) {
      return { rows: [{ id: "policy-1", policyKey: "OVERTIME", effectiveFrom: "2026-01-01" }], rowCount: 1 };
    }
    if (sql.includes("FROM payroll_compensation_profiles")) {
      return { rows: [{ id: "profile-1", employmentId: EMPLOYMENT_ID, effectiveFrom: "2026-01-01" }], rowCount: 1 };
    }
    if (sql.includes("FROM payroll_periods WHERE id = $1 FOR UPDATE")) {
      return { rows: [{ state: options.periodState ?? "COLLECTING" }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO payroll_loan_deductions")) {
      writes.push("loan_deduction");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO payroll_audit_events")) {
      audits.push(String(values?.[2] ?? ""));
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL in payroll admin routes test: ${sql}`);
  });
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  return { pool, audits, writes, closed };
}

async function call(
  persona: Persona,
  method: "GET" | "POST" | "PUT",
  url: string,
  options: Options & { payload?: object } = {},
) {
  const { pool, audits, writes, closed } = createPool(persona, options);
  const app = Fastify({ logger: false });
  await registerPayrollAdminRoutes(app, pool, config);
  const response = await app.inject({
    method,
    url,
    headers: persona === "anonymous" ? {} : { cookie: "hcis_session=test-token" },
    ...(options.payload ? { payload: options.payload } : {}),
  });
  await app.close();
  return { response, audits, writes, closed };
}

const VALID_POLICY = {
  policyKey: "OVERTIME",
  effectiveFrom: "2027-01-01",
  payload: { monthlyHourDivisor: 173 },
  source: "Keputusan yayasan uji",
};

describe("PAY-003 policy versions", () => {
  it("opens a version and closes the one it supersedes", async () => {
    const { response, writes, closed, audits } = await call("hc", "POST", "/payroll/policies", {
      payload: VALID_POLICY,
    });
    expect(response.statusCode).toBe(201);
    expect(writes).toEqual(["policy"]);
    expect(closed).toHaveLength(1);
    expect(audits).toEqual(["payroll.policy.version_opened"]);
  });

  it("refuses a payload the engine could not read later", async () => {
    const { response, writes } = await call("hc", "POST", "/payroll/policies", {
      payload: { ...VALID_POLICY, payload: { monthlyHoursDivisor: 173 } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("PAYROLL_INVALID_POLICY");
    expect(writes).toEqual([]);
  });

  it("refuses to reach back into a period already calculated without a reason", async () => {
    const { response, writes } = await call("hc", "POST", "/payroll/policies", {
      payload: { ...VALID_POLICY, effectiveFrom: "2026-01-01" },
      settledPeriodMonth: "2026-09",
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("PAYROLL_BACKDATES_SETTLED_PERIOD");
    expect(writes).toEqual([]);
  });

  it("allows it once the reason is given", async () => {
    const { response, writes } = await call("hc", "POST", "/payroll/policies", {
      payload: {
        ...VALID_POLICY,
        effectiveFrom: "2026-01-01",
        backdateReason: "Koreksi tarif lembur sesuai keputusan yayasan",
      },
      settledPeriodMonth: "2026-09",
    });
    expect(response.statusCode).toBe(201);
    expect(writes).toEqual(["policy"]);
  });

  it("requires a source, because a statutory value has to say where it comes from", async () => {
    const { response } = await call("hc", "POST", "/payroll/policies", {
      payload: { ...VALID_POLICY, source: "" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("refuses a second version covering the same day", async () => {
    const { response } = await call("hc", "POST", "/payroll/policies", {
      payload: VALID_POLICY,
      insertError: "23P01",
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("PAYROLL_POLICY_OVERLAP");
  });

  it("is closed to everyone without payroll.policies.manage", async () => {
    for (const persona of ["employee", "finance", "director", "super_admin"] as const) {
      const { response } = await call(persona, "POST", "/payroll/policies", { payload: VALID_POLICY });
      expect(response.statusCode).toBe(403);
    }
    expect((await call("anonymous", "GET", "/payroll/policies")).response.statusCode).toBe(401);
  }, 20_000);
});

describe("PAY-003 compensation profiles", () => {
  const url = `/payroll/employments/${EMPLOYMENT_ID}/compensation-profiles`;
  const profile = { effectiveFrom: "2026-09-01", education: "S1", spouseCount: 1, childCount: 2 };

  it("opens a profile and closes the previous one", async () => {
    const { response, writes, closed, audits } = await call("hc", "POST", url, { payload: profile });
    expect(response.statusCode).toBe(201);
    expect(writes).toEqual(["profile"]);
    expect(closed).toHaveLength(1);
    expect(audits).toEqual(["payroll.profile.opened"]);
  });

  it("refuses a profile for the actor's own employment", async () => {
    const { response } = await call(
      "hc",
      "POST",
      `/payroll/employments/${OWN_EMPLOYMENT_ID}/compensation-profiles`,
      { payload: profile },
    );
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("PAYROLL_OWN_RECORD");
  });

  it("refuses a profile that reaches back into a period already calculated", async () => {
    const { response, writes } = await call("hc", "POST", url, {
      payload: { ...profile, effectiveFrom: "2026-01-01" },
      settledPeriodMonth: "2026-09",
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("PAYROLL_BACKDATES_SETTLED_PERIOD");
    expect(writes).toEqual([]);
  });

  it("refuses an overlapping effective date", async () => {
    const { response } = await call("hc", "POST", url, { payload: profile, insertError: "23P01" });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("PAYROLL_PROFILE_OVERLAP");
  });

  it("turns a database rule into a 400, not a 500", async () => {
    const { response } = await call("hc", "POST", url, { payload: profile, insertError: "23514" });
    expect(response.statusCode).toBe(400);
  });

  it("refuses an unknown employment with a 404", async () => {
    const { response } = await call("hc", "POST", url, { payload: profile, insertError: "23503" });
    expect(response.statusCode).toBe(404);
  });

  it("refuses an education level outside the salary scale vocabulary", async () => {
    const { response } = await call("hc", "POST", url, {
      payload: { ...profile, education: "DOKTOR_HONORIS" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("is closed to finance and to the director", async () => {
    for (const persona of ["finance", "director", "employee"] as const) {
      expect((await call(persona, "POST", url, { payload: profile })).response.statusCode).toBe(403);
    }
  }, 20_000);
});

describe("PAY-003 loans", () => {
  const loan = { employeeId: EMPLOYEE_ID, grantedOn: "2026-05-01", principal: 1_200_000 };

  it("lets finance record a loan", async () => {
    const { response, writes, audits } = await call("finance", "POST", "/payroll/loans", { payload: loan });
    expect(response.statusCode).toBe(201);
    expect(writes).toEqual(["loan"]);
    expect(audits).toEqual(["payroll.loan.created"]);
  });

  it("refuses a loan with no principal to repay", async () => {
    const { response } = await call("finance", "POST", "/payroll/loans", {
      payload: { ...loan, principal: 0 },
    });
    expect(response.statusCode).toBe(400);
  });

  it("is closed to human capital, who must not move the figures finance owns", async () => {
    expect((await call("hc", "POST", "/payroll/loans", { payload: loan })).response.statusCode).toBe(403);
  });

  it("reads the register a page at a time, with the total", async () => {
    const { response } = await call("finance", "GET", "/payroll/loans?page=1&pageSize=25");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ total: 1, page: 1, pageSize: 25 });
  });

  it("refuses a page larger than the standard allows", async () => {
    expect((await call("finance", "GET", "/payroll/loans?pageSize=101")).response.statusCode).toBe(400);
  });

  it("keeps the loan register itself closed to human capital", async () => {
    // Section 3.4: only payroll.loans.manage. The calculation reads the balances
    // inside its own transaction, so payroll.calculate needs no way in.
    expect((await call("hc", "GET", "/payroll/loans")).response.statusCode).toBe(403);
  });

  it("removes this period's instalment when the amount is zero", async () => {
    const { response, writes } = await call("finance", "PUT", `/payroll/periods/${PERIOD_ID}/loan-deductions`, {
      payload: { deductions: [{ loanId: LOAN_ID, amount: 0 }] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ written: 0, removed: 1 });
    expect(writes).toEqual(["loan_deduction_removed"]);
  });

  it("refuses the same loan twice in one request", async () => {
    const { response } = await call("finance", "PUT", `/payroll/periods/${PERIOD_ID}/loan-deductions`, {
      payload: {
        deductions: [
          { loanId: LOAN_ID, amount: 100_000 },
          { loanId: LOAN_ID, amount: 200_000 },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("refuses an instalment against a loan that is already closed", async () => {
    const { response, writes } = await call("finance", "PUT", `/payroll/periods/${PERIOD_ID}/loan-deductions`, {
      payload: { deductions: [{ loanId: LOAN_ID, amount: 100_000 }] },
      loanClosed: true,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("PAYROLL_LOAN_CLOSED");
    expect(writes).toEqual([]);
  });

  it("records this period's instalments while the period is still collecting", async () => {
    const { response, writes, audits } = await call("finance", "PUT", `/payroll/periods/${PERIOD_ID}/loan-deductions`, {
      payload: { deductions: [{ loanId: LOAN_ID, amount: 300_000 }] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ written: 1, removed: 0 });
    expect(writes).toEqual(["loan_deduction"]);
    expect(audits).toEqual(["payroll.loan.deductions_recorded"]);
  });

  it("locks the instalments once the period has been calculated", async () => {
    for (const periodState of ["CALCULATED", "SUBMITTED", "APPROVED", "PAYMENT_CONFIRMED", "PUBLISHED"]) {
      const { response, writes } = await call("finance", "PUT", `/payroll/periods/${PERIOD_ID}/loan-deductions`, {
        payload: { deductions: [{ loanId: LOAN_ID, amount: 300_000 }] },
        periodState,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("PAYROLL_LOAN_LOCKED");
      expect(writes).toEqual([]);
    }
  }, 20_000);

  it("refuses an instalment larger than what is left to repay", async () => {
    const { response, writes } = await call("finance", "PUT", `/payroll/periods/${PERIOD_ID}/loan-deductions`, {
      payload: { deductions: [{ loanId: LOAN_ID, amount: 1_000_000 }] },
      loanBalance: 400_000,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("PAYROLL_LOAN_EXCEEDS_BALANCE");
    expect(writes).toEqual([]);
  });

  it("answers every response with no-store", async () => {
    const { response } = await call("finance", "GET", "/payroll/loans");
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});

describe("PAY-003 the employment picker", () => {
  it("answers a search with one page and the total beside it", async () => {
    const { response } = await call("hc", "GET", "/payroll/employments?q=Pegawai&page=1&pageSize=25");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ total: 1, page: 1, pageSize: 25 });
    expect(response.json().employments[0]).toMatchObject({ fullName: "Pegawai Uji" });
  });

  it("refuses a page larger than the standard allows", async () => {
    // ENG-LIST-001: 100 is the ceiling, and asking for more is a mistake the
    // caller is told about rather than quietly trimmed.
    expect((await call("hc", "GET", "/payroll/employments?pageSize=101")).response.statusCode).toBe(400);
  });

  it("opens for finance too, who record a kasbon against an employee", async () => {
    expect((await call("finance", "GET", "/payroll/employments")).response.statusCode).toBe(200);
  });

  it("stays closed to an employee holding no payroll permission", async () => {
    expect((await call("employee", "GET", "/payroll/employments")).response.statusCode).toBe(403);
  });
});
