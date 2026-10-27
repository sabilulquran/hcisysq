// PAY-003 period lifecycle routes: authorization per action, state guards, the
// no-self-approval rule, idempotency, and the no-store header. Fake pool;
// synthetic data only.

import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerPayrollRoutes } from "../src/modules/payroll/routes.js";

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://payroll-routes-test",
  AUTH_MODE: "local" as const,
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

// A complete, synthetic policy set, so a calculation run has something to read.
const POLICY_PAYLOADS: Record<string, unknown> = {
  SALARY_SCALE: { scale: { S1: Array.from({ length: 28 }, (_, mkg) => 2_000_000 + mkg * 100_000) } },
  BASIC_MULTIPLIER: { units: {}, knownUnitRefs: [], workPatterns: { FULL: 1 } },
  TEACHING_HOURS: { monthlyHourLimit: 96, overRatePerHour: 10_000, shortRatePerHour: 10_000, weeksPerMonth: 4 },
  PERFORMANCE: {
    defaultBase: 100_000, baseByPosition: {}, annualShare: 0.6, monthlyShare: 0.4,
    unratedBelowOneYear: { annualRate: 0, monthlyRate: 1 },
  },
  FAMILY: { spouseRate: 0.05, childRate: 0.02 },
  FUNCTIONAL_ALLOWANCE: { byPosition: {}, concurrentStructuralFactor: 0.7, excludedUnits: [], positionsWithoutAllowance: [] },
  POSITIONAL_ALLOWANCE: { byPosition: {}, unitMultipliers: {}, positionsWithoutAllowance: [] },
  OVERTIME: { monthlyHourDivisor: 173 },
  BPJS_KESEHATAN: {
    contributionRate: 0.05, extraFamilyRate: 0.01, floor: 2_878_646, ceiling: 12_000_000,
    coveredChildren: 3, fixedAllowanceComponents: ["BASIC"],
  },
  CONTRACT_RATES: { transportPerAttendance: 15_000, teachingFeePerHour: 15_400 },
  EARLY_SERVICE: { months: 2, netRate: 0.8 },
  VARIANCE_THRESHOLD: { relative: 0.1, absolute: 50_000, manualInput: 1_000_000 },
};

const POLICY_ROWS = Object.entries(POLICY_PAYLOADS).map(([policyKey, payload], index) => ({
  id: `policy-${index}`,
  policyKey,
  payload,
}));

const PERIOD_ID = "50000000-0000-4000-8000-000000000001";
const EMPLOYMENT_ID = "60000000-0000-4000-8000-000000000001";
const OWN_EMPLOYMENT_ID = "60000000-0000-4000-8000-000000000002";
const HC_ACCOUNT = "00000000-0000-4000-8000-000000000001";
const DIRECTOR_ACCOUNT = "00000000-0000-4000-8000-000000000002";

type Persona = "anonymous" | "employee" | "hc" | "director" | "finance" | "super_admin" | "board";

const PERMISSIONS: Record<Persona, string[]> = {
  anonymous: [],
  employee: ["payslips.read.own"],
  // Exactly what migration 0069 grants each role: the director and the finance
  // lead never hold payroll.periods.manage.
  hc: ["payroll.policies.manage", "payroll.profiles.manage", "payroll.periods.manage", "payroll.inputs.manage", "payroll.calculate", "payroll.submit"],
  director: ["payroll.approve", "payroll.reopen.approve", "payroll.reports.read.organization"],
  finance: ["payroll.payments.confirm", "payroll.reports.read.organization", "payroll.transfers.read.organization"],
  // Legacy Super Admin compatibility grants no payroll permission (ADR-0003).
  super_admin: [],
  // ORG-003-F and ORG-010-F forbid the Foundation Board payroll figures entirely.
  board: [],
};

const ACCOUNTS: Record<Persona, string> = {
  anonymous: HC_ACCOUNT,
  employee: HC_ACCOUNT,
  hc: HC_ACCOUNT,
  director: DIRECTOR_ACCOUNT,
  finance: "00000000-0000-4000-8000-000000000003",
  super_admin: "00000000-0000-4000-8000-000000000004",
  board: "00000000-0000-4000-8000-000000000005",
};

type PeriodOverrides = {
  state?: string;
  submittedByAccountId?: string | null;
  blockerCount?: number;
  resultCount?: number;
  lastCalculatedAt?: string | null;
  inputCount?: number;
  lastInputRecordedAt?: string | null;
  calculatedInputCount?: number | null;
  calculatedLastInputRecordedAt?: string | null;
  stateBeforeReopenRequest?: string | null;
  version?: number;
};

function periodRow(overrides: PeriodOverrides = {}) {
  return {
    id: PERIOD_ID,
    legalEntityKey: null,
    periodMonth: "2026-09-01",
    payDate: "2026-09-25",
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    cutoffStart: "2026-08-23",
    cutoffEnd: "2026-09-22",
    state: overrides.state ?? "DRAFT",
    stateBeforeReopenRequest: overrides.stateBeforeReopenRequest ?? null,
    submittedByAccountId: overrides.submittedByAccountId ?? null,
    submittedAt: null,
    approvedByAccountId: null,
    approvedAt: null,
    paymentConfirmedAt: null,
    publishedAt: null,
    reopenCount: 0,
    version: overrides.version ?? 0,
    resultCount: overrides.resultCount ?? 0,
    blockerCount: overrides.blockerCount ?? 0,
    lastCalculatedAt: overrides.lastCalculatedAt ?? null,
    inputCount: overrides.inputCount ?? 0,
    lastInputRecordedAt: overrides.lastInputRecordedAt ?? null,
    calculatedInputCount: overrides.calculatedInputCount ?? null,
    calculatedLastInputRecordedAt: overrides.calculatedLastInputRecordedAt ?? null,
  };
}

function createPool(
  persona: Persona,
  overrides: PeriodOverrides,
  options: { versionRace?: boolean; policyComplete?: boolean; hasPreviousPeriod?: boolean } = {},
) {
  const audits: string[] = [];
  const updates: string[] = [];
  const inputWrites: Array<{ employmentId: string; inputKey: string; value: unknown }> = [];
  const deletes: string[] = [];
  const transitions: Array<{ action: string; fromState: string; toState: string; reason: string | null }> = [];
  // The route reads the period again after a transition, so the fake has to move
  // with it rather than keep answering with the state before the write.
  let current = { ...overrides };
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM auth_sessions s")) {
      if (persona === "anonymous") return { rows: [], rowCount: 0 };
      return {
        rows: [{
          sessionId: "00000000-0000-4000-8000-000000000100",
          accountId: ACCOUNTS[persona],
          email: `${persona}@example.invalid`,
          principalType:
            persona === "super_admin" ? "SUPER_ADMIN" : persona === "board" ? "FOUNDATION_BOARD" : "EMPLOYEE",
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
    if (sql.includes("FOR UPDATE")) {
      return { rows: [{ state: current.state ?? "DRAFT", version: current.version ?? 0 }], rowCount: 1 };
    }
    // The report queries read payroll_results through a subquery, so they have to
    // be answered before the plain results branch further down.
    if (sql.includes("JOIN payroll_periods prev")) {
      return options.hasPreviousPeriod === false
        ? { rows: [], rowCount: 0 }
        : { rows: [{ id: "40000000-0000-4000-8000-000000000009" }], rowCount: 1 };
    }
    if (sql.includes("origin = 'MANUAL'")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("WITH current_latest AS")) {
      return {
        rows: [{
          employmentId: EMPLOYMENT_ID,
          componentCode: "PERF",
          previousAmount: "100000",
          currentAmount: "400000",
          delta: "300000",
          kind: "COMPONENT",
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("coalesce(sum(latest.gross)")) {
      return {
        rows: [{
          employeeCount: 2,
          gross: "6000000",
          deductions: "400000",
          net: "5600000",
          payable: "5600000",
          employerCost: "0",
          blockerCount: 0,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes('profile.unit_ref AS "unitRef"') && !sql.includes("employee_number")) {
      return { rows: [{ unitRef: "unit-pusat", employeeCount: 2, payable: "5600000" }], rowCount: 1 };
    }
    if (sql.includes('l.component_code AS "componentCode"') && sql.includes("payroll_components")) {
      return {
        rows: [{ componentCode: "BASIC", category: "EARNING", employeeCount: 2, amount: "6000000" }],
        rowCount: 1,
      };
    }
    // The identity lookup reads the same two employee columns as the transfer
    // list, so it has to be answered before it.
    if (sql.includes('latest.employment_id AS "employmentId"') && sql.includes('emp.full_name AS "fullName"')) {
      return {
        rows: [{ employmentId: EMPLOYMENT_ID, employeeNumber: "YSQ-0001", fullName: "Pegawai Uji" }],
        rowCount: 1,
      };
    }
    if (sql.includes('emp.employee_number AS "employeeNumber"')) {
      return {
        rows: [{
          employeeNumber: "2016001",
          fullName: "Pegawai Uji",
          unitRef: "unit-pusat",
          payable: "3000000",
          bankName: "BSI",
          bankAccountNumber: "0000000001",
          bankAccountName: "Pegawai Uji",
          paymentConfirmedAt: null,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("policy_key = 'VARIANCE_THRESHOLD'")) {
      return { rows: [{ payload: { relative: 0.1, absolute: 50_000, manualInput: 1_000_000 } }], rowCount: 1 };
    }
    if (sql.includes("FROM payroll_loans")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM attendance_overtime_requests")) {
      return { rows: [{ employmentId: EMPLOYMENT_ID, minutes: "120" }], rowCount: 1 };
    }
    if (sql.includes("attendance_result_versions")) {
      return { rows: [{ employmentId: EMPLOYMENT_ID, days: "18" }], rowCount: 1 };
    }
    if (sql.includes("FROM payroll_period_transitions")) {
      return { rows: transitions, rowCount: transitions.length };
    }
    // The period query reads inputs and results in subqueries, so it has to be
    // answered first or these branches would swallow it.
    if (sql.includes("DELETE FROM payroll_period_inputs")) {
      if (sql.includes("origin = 'ATTENDANCE'")) {
        deletes.push("attendance_sweep");
        return { rows: [], rowCount: 2 };
      }
      deletes.push(`${String(values?.[1] ?? "")}:${String(values?.[2] ?? "")}`);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM payroll_period_inputs") && !sql.includes("FROM payroll_periods p")) {
      if (sql.includes('count(*)::int AS "inputCount"')) {
        return { rows: [{ inputCount: inputWrites.length, lastInputRecordedAt: null }], rowCount: 1 };
      }
      return {
        rows: inputWrites.map((write) => ({
          employmentId: write.employmentId,
          inputKey: write.inputKey,
          value: String(write.value),
          origin: "MANUAL",
          reason: null,
          decisionReference: null,
          recordedAt: "2026-09-19T00:00:00.000Z",
        })),
        rowCount: inputWrites.length,
      };
    }
    if (sql.includes("INSERT INTO payroll_period_inputs")) {
      inputWrites.push({
        employmentId: String(values?.[2] ?? ""),
        inputKey: String(values?.[3] ?? ""),
        value: values?.[4],
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("JOIN accounts a ON a.employee_id = e.employee_id")) {
      return { rows: [{ id: OWN_EMPLOYMENT_ID }], rowCount: 1 };
    }
    if (sql.includes("FROM attendance_overtime_requests")) {
      return { rows: [{ employmentId: EMPLOYMENT_ID, minutes: "120" }], rowCount: 1 };
    }
    if (sql.includes("attendance_result_versions")) {
      return { rows: [{ employmentId: EMPLOYMENT_ID, days: "18" }], rowCount: 1 };
    }
    if (sql.includes("FROM payroll_period_transitions")) {
      return { rows: transitions, rowCount: transitions.length };
    }
    // The period query reads inputs and results in subqueries, so it has to be
    // answered first or these branches would swallow it.
    if (sql.includes("FROM payroll_period_inputs") && !sql.includes("FROM payroll_periods p")) {
      if (sql.includes('count(*)::int AS "inputCount"')) {
        return { rows: [{ inputCount: inputWrites.length, lastInputRecordedAt: null }], rowCount: 1 };
      }
      return {
        rows: inputWrites.map((write) => ({
          employmentId: write.employmentId,
          inputKey: write.inputKey,
          value: String(write.value),
          origin: "MANUAL",
          reason: null,
          decisionReference: null,
          recordedAt: "2026-09-19T00:00:00.000Z",
        })),
        rowCount: inputWrites.length,
      };
    }
    if (sql.includes("INSERT INTO payroll_period_inputs")) {
      inputWrites.push({
        employmentId: String(values?.[2] ?? ""),
        inputKey: String(values?.[3] ?? ""),
        value: values?.[4],
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM payroll_policy_versions")) {
      return options.policyComplete === false ? { rows: [], rowCount: 0 } : { rows: POLICY_ROWS, rowCount: POLICY_ROWS.length };
    }
    if (sql.includes("FROM employments e") && sql.includes("employment_terms")) {
      return {
        rows: [{
          employmentId: EMPLOYMENT_ID,
          employeeId: "70000000-0000-4000-8000-000000000001",
          serviceStartDate: "2016-07-01",
          serviceEndDate: null,
          termCategory: "TETAP",
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM payroll_compensation_profiles")) {
      return {
        rows: [{
          employmentId: EMPLOYMENT_ID,
          education: "S1",
          workPattern: null,
          unitRef: null,
          functionalPositionRef: null,
          structuralPositionRef: null,
          teachingHoursPerWeek: null,
          spouseCount: 0,
          childCount: 0,
          registeredDependants: 0,
          specialQualificationTarget: null,
          annualPerformanceRate: null,
          monthlyPerformanceRate: null,
          bpjsSegment: "BELUM_TERDAFTAR",
          bpjsActiveFrom: null,
          bpjsExtraFamilyOverride: null,
          bankAccountNumber: "0000000001",
          bankAccountName: "Pegawai Uji",
        }],
        rowCount: 1,
      };
    }
    if ((sql.includes("FROM payroll_results r") || sql.includes("FROM payroll_results WHERE"))
        && !sql.includes("FROM payroll_periods p")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO payroll_results") || sql.includes("INSERT INTO payroll_result_lines")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("JOIN payroll_result_lines")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("count(*)::int AS total FROM payroll_periods")) {
      return { rows: [{ total: 7 }], rowCount: 1 };
    }
    if (sql.includes("FROM payroll_periods p")) {
      return { rows: [periodRow(current)], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO payroll_periods")) {
      return { rows: [periodRow(current)], rowCount: 1 };
    }
    if (sql.includes("UPDATE payroll_periods SET")) {
      updates.push(sql.replace(/\s+/g, " ").trim());
      if (options.versionRace) return { rows: [], rowCount: 0 };
      const nextState = String(values?.[1] ?? "");
      current = { ...current, state: nextState, version: (current.version ?? 0) + 1 };
      return { rows: [{ ...periodRow(current), state: nextState }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO payroll_period_transitions")) {
      transitions.push({
        action: String(values?.[2] ?? ""),
        fromState: String(values?.[3] ?? ""),
        toState: String(values?.[4] ?? ""),
        reason: (values?.[5] ?? null) as string | null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO payroll_audit_events")) {
      audits.push(String(values?.[2] ?? ""));
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL in payroll routes test: ${sql}`);
  });
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  return { pool, audits, updates, transitions, inputWrites, deletes };
}

async function call(
  persona: Persona,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  options: {
    payload?: object;
    period?: PeriodOverrides;
    versionRace?: boolean;
    policyComplete?: boolean;
    hasPreviousPeriod?: boolean;
  } = {},
) {
  const { pool, audits, updates, transitions, inputWrites, deletes } = createPool(persona, options.period ?? {}, {
    ...(options.versionRace === undefined ? {} : { versionRace: options.versionRace }),
    ...(options.policyComplete === undefined ? {} : { policyComplete: options.policyComplete }),
    ...(options.hasPreviousPeriod === undefined ? {} : { hasPreviousPeriod: options.hasPreviousPeriod }),
  });
  const app = Fastify({ logger: false });
  await registerPayrollRoutes(app, pool, config);
  const response = await app.inject({
    method,
    url,
    headers: persona === "anonymous" ? {} : { cookie: "hcis_session=test-token" },
    ...(options.payload ? { payload: options.payload } : {}),
  });
  await app.close();
  return { response, audits, updates, transitions, inputWrites, deletes };
}

const READ_ROUTES = ["/payroll/periods", `/payroll/periods/${PERIOD_ID}`];

describe("PAY-003 route authorization", () => {
  it.each(READ_ROUTES)("denies anonymous, ordinary employees and Super Admin on %s", async (url) => {
    expect((await call("anonymous", "GET", url)).response.statusCode).toBe(401);
    expect((await call("employee", "GET", url)).response.json()).toMatchObject({ code: "PAYROLL_FORBIDDEN" });
    expect((await call("super_admin", "GET", url)).response.statusCode).toBe(403);
  }, 20_000);

  it("gives the Foundation Board nothing at all", async () => {
    for (const url of READ_ROUTES) {
      expect((await call("board", "GET", url)).response.statusCode).toBe(403);
    }
    const write = await call("board", "POST", "/payroll/periods", {
      payload: { periodMonth: "2026-09-01" },
    });
    expect(write.response.statusCode).toBe(403);
    const transition = await call("board", "POST", `/payroll/periods/${PERIOD_ID}/transitions`, {
      payload: { action: "approve" },
    });
    expect(transition.response.statusCode).toBe(403);
  }, 20_000);

  it("lets human capital read periods, and says how many there are", async () => {
    const { response } = await call("hc", "GET", "/payroll/periods");
    expect(response.statusCode).toBe(200);
    expect(response.json().periods).toHaveLength(1);
    // Without a total the screen would quietly cut the list at one page.
    expect(response.json().total).toBe(7);
  });

  it("tells the caller which work is available beyond the lifecycle", async () => {
    const collecting = await call("hc", "GET", `/payroll/periods/${PERIOD_ID}`, {
      period: { state: "COLLECTING" },
    });
    expect(collecting.response.json().period.availableOperations).toEqual(["resolve_attendance"]);

    const paid = await call("hc", "GET", `/payroll/periods/${PERIOD_ID}`, {
      period: { state: "PAYMENT_CONFIRMED" },
    });
    expect(paid.response.json().period.availableOperations).toEqual(["draft_payslips"]);
  }, 20_000);

  it("offers publishing slips only to whoever holds payslips.publish", async () => {
    const { response } = await call("hc", "GET", `/payroll/periods/${PERIOD_ID}`, {
      period: { state: "PAYMENT_CONFIRMED" },
    });
    expect(response.json().period.availableOperations).not.toContain("publish_payslips");
  });

  it("says which actions carry a reason, so no caller restates the table", async () => {
    const { response } = await call("hc", "GET", `/payroll/periods/${PERIOD_ID}`);
    expect(response.json().period.reasonRequiredActions).toEqual([
      "return",
      "request_reopen",
      "reject_reopen",
    ]);
  });

  it("lets the director and the finance lead read a period they must decide on", async () => {
    for (const persona of ["director", "finance"] as const) {
      const { response } = await call(persona, "GET", `/payroll/periods/${PERIOD_ID}`);
      expect(response.statusCode).toBe(200);
    }
  }, 20_000);

  it("offers each reader only the actions they hold", async () => {
    const period = { state: "SUBMITTED", submittedByAccountId: HC_ACCOUNT, resultCount: 1, lastCalculatedAt: "2026-09-20T00:00:00.000Z" };
    const director = await call("director", "GET", `/payroll/periods/${PERIOD_ID}`, { period });
    expect(director.response.json().period.availableActions).toEqual(["return", "approve"]);
    const hc = await call("hc", "GET", `/payroll/periods/${PERIOD_ID}`, { period });
    expect(hc.response.json().period.availableActions).toEqual([]);
  }, 20_000);

  it("checks the permission before looking the period up, so a 404 tells an outsider nothing", async () => {
    const { response } = await call("employee", "POST", `/payroll/periods/${PERIOD_ID}/transitions`, {
      payload: { action: "approve" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("answers every payroll response with no-store", async () => {
    for (const persona of ["anonymous", "employee", "hc"] as const) {
      const { response } = await call(persona, "GET", "/payroll/periods");
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  }, 20_000);
});

describe("PAY-003 period creation", () => {
  it("creates a period and records it in the audit", async () => {
    const { response, audits } = await call("hc", "POST", "/payroll/periods", {
      payload: { periodMonth: "2026-09-01" },
    });
    expect(response.statusCode).toBe(201);
    expect(audits).toEqual(["payroll.period.created"]);
  });

  it("refuses a month given as anything but its first day", async () => {
    const { response } = await call("hc", "POST", "/payroll/periods", {
      payload: { periodMonth: "2026-09-15" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("PAYROLL_INVALID_PERIOD");
  });

  it("refuses a cutoff that ends before it starts", async () => {
    const { response } = await call("hc", "POST", "/payroll/periods", {
      payload: { periodMonth: "2026-09-01", cutoffStart: "2026-09-22", cutoffEnd: "2026-08-23" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("refuses creation to the director, who may approve but not run periods", async () => {
    const { response } = await call("director", "POST", "/payroll/periods", {
      payload: { periodMonth: "2026-09-01" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("refuses a cutoff end that would precede the default start", async () => {
    const { response } = await call("hc", "POST", "/payroll/periods", {
      payload: { periodMonth: "2026-09-01", cutoffEnd: "2026-08-01" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("refuses a pay date outside the period month", async () => {
    const { response } = await call("hc", "POST", "/payroll/periods", {
      payload: { periodMonth: "2026-09-01", payDate: "2026-10-05" },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("PAY-003 transitions", () => {
  const transition = (action: string, reason?: string) => ({
    payload: reason === undefined ? { action } : { action, reason },
  });

  it("moves a draft period into collecting and audits it", async () => {
    const { response, audits } = await call("hc", "POST", `/payroll/periods/${PERIOD_ID}/transitions`, {
      ...transition("start_collecting"),
      period: { state: "DRAFT" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().period.state).toBe("COLLECTING");
    expect(audits).toEqual(["payroll.period.collecting"]);
  });

  it("refuses a transition the actor has no permission for", async () => {
    const { response } = await call("hc", "POST", `/payroll/periods/${PERIOD_ID}/transitions`, {
      ...transition("approve"),
      period: { state: "SUBMITTED", resultCount: 1, lastCalculatedAt: "2026-09-20T00:00:00.000Z" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("PAYROLL_FORBIDDEN");
  });

  it("refuses a transition taken out of order", async () => {
    const { response } = await call("hc", "POST", `/payroll/periods/${PERIOD_ID}/transitions`, {
      ...transition("submit"),
      period: { state: "DRAFT" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("PAYROLL_STATE_CONFLICT");
  });

  it("refuses submission while a blocker stands", async () => {
    const { response } = await call("hc", "POST", `/payroll/periods/${PERIOD_ID}/transitions`, {
      ...transition("submit"),
      period: {
        state: "CALCULATED",
        resultCount: 5,
        blockerCount: 2,
        lastCalculatedAt: "2026-09-20T00:00:00.000Z",
        inputCount: 3,
        calculatedInputCount: 3,
        lastInputRecordedAt: "2026-09-19T00:00:00.000Z",
        calculatedLastInputRecordedAt: "2026-09-19T00:00:00.000Z",
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("PAYROLL_BLOCKERS_PRESENT");
  });

  it("refuses submission when an input was recorded after the last calculation", async () => {
    const { response } = await call("hc", "POST", `/payroll/periods/${PERIOD_ID}/transitions`, {
      ...transition("submit"),
      period: {
        state: "CALCULATED",
        resultCount: 5,
        lastCalculatedAt: "2026-09-20T00:00:00.000Z",
        inputCount: 4,
        calculatedInputCount: 3,
        lastInputRecordedAt: "2026-09-21T00:00:00.000Z",
        calculatedLastInputRecordedAt: "2026-09-19T00:00:00.000Z",
      },
    });
    expect(response.json().code).toBe("PAYROLL_CALCULATION_STALE");
  });

  it("refuses submission when an input was deleted after the last calculation", async () => {
    const { response } = await call("hc", "POST", `/payroll/periods/${PERIOD_ID}/transitions`, {
      ...transition("submit"),
      period: {
        state: "CALCULATED",
        resultCount: 5,
        lastCalculatedAt: "2026-09-20T00:00:00.000Z",
        inputCount: 2,
        calculatedInputCount: 3,
        lastInputRecordedAt: "2026-09-19T00:00:00.000Z",
        calculatedLastInputRecordedAt: "2026-09-19T00:00:00.000Z",
      },
    });
    expect(response.json().code).toBe("PAYROLL_CALCULATION_STALE");
  });

  it("refuses the submitter as approver of the same period", async () => {
    const period = {
      state: "SUBMITTED",
      submittedByAccountId: DIRECTOR_ACCOUNT,
      resultCount: 5,
      lastCalculatedAt: "2026-09-20T00:00:00.000Z",
    };
    const { response } = await call("director", "POST", `/payroll/periods/${PERIOD_ID}/transitions`, {
      ...transition("approve"),
      period,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("PAYROLL_SELF_APPROVAL");
  });

  it("lets a different director approve, and records who", async () => {
    const { response, audits, updates } = await call("director", "POST", `/payroll/periods/${PERIOD_ID}/transitions`, {
      ...transition("approve"),
      period: {
        state: "SUBMITTED",
        submittedByAccountId: HC_ACCOUNT,
        resultCount: 5,
        lastCalculatedAt: "2026-09-20T00:00:00.000Z",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(audits).toEqual(["payroll.period.approved"]);
    expect(updates[0]).toContain("approved_by_account_id");
  });

  it("lets the director approve although an input arrived while the period was submitted", async () => {
    const { response } = await call("director", "POST", `/payroll/periods/${PERIOD_ID}/transitions`, {
      ...transition("approve"),
      period: {
        state: "SUBMITTED",
        submittedByAccountId: HC_ACCOUNT,
        resultCount: 5,
        lastCalculatedAt: "2026-09-20T00:00:00.000Z",
        inputCount: 9,
        calculatedInputCount: 3,
      },
    });
    expect(response.statusCode).toBe(200);
  });

  it("still refuses approval while a blocker stands", async () => {
    const { response } = await call("director", "POST", `/payroll/periods/${PERIOD_ID}/transitions`, {
      ...transition("approve"),
      period: { state: "SUBMITTED", submittedByAccountId: HC_ACCOUNT, resultCount: 5, blockerCount: 1 },
    });
    expect(response.json().code).toBe("PAYROLL_BLOCKERS_PRESENT");
  });

  it("requires a reason to return a submitted period", async () => {
    const period = { state: "SUBMITTED", submittedByAccountId: HC_ACCOUNT };
    const without = await call("director", "POST", `/payroll/periods/${PERIOD_ID}/transitions`, {
      ...transition("return"),
      period,
    });
    expect(without.response.json().code).toBe("PAYROLL_REASON_REQUIRED");

    const withReason = await call("director", "POST", `/payroll/periods/${PERIOD_ID}/transitions`, {
      ...transition("return", "Jam mengajar belum diperbarui"),
      period,
    });
    expect(withReason.response.json().period.state).toBe("COLLECTING");
    expect(withReason.updates[0]).toContain("submitted_by_account_id = NULL");
    // The reason is kept where human capital can read it, not only counted.
    expect(withReason.transitions[0]).toMatchObject({
      action: "return",
      fromState: "SUBMITTED",
      toState: "COLLECTING",
      reason: "Jam mengajar belum diperbarui",
    });
  });

  it("clears the submission when a period is returned, so the next submitter is recorded afresh", async () => {
    const { updates } = await call("director", "POST", `/payroll/periods/${PERIOD_ID}/transitions`, {
      ...transition("return", "Ada input yang salah"),
      period: { state: "SUBMITTED", submittedByAccountId: HC_ACCOUNT },
    });
    expect(updates[0]).toContain("submitted_at = NULL");
  });

  it("confirms payment only with the finance permission", async () => {
    const period = { state: "APPROVED" };
    expect((await call("hc", "POST", `/payroll/periods/${PERIOD_ID}/transitions`, {
      ...transition("confirm_payment"),
      period,
    })).response.statusCode).toBe(403);

    const { response, audits } = await call("finance", "POST", `/payroll/periods/${PERIOD_ID}/transitions`, {
      ...transition("confirm_payment"),
      period,
    });
    expect(response.json().period.state).toBe("PAYMENT_CONFIRMED");
    expect(audits).toEqual(["payroll.payment.confirmed"]);
  });

  it("returns an approved reopen to collecting and counts it", async () => {
    const { response, updates } = await call("director", "POST", `/payroll/periods/${PERIOD_ID}/transitions`, {
      ...transition("approve_reopen"),
      period: { state: "REOPEN_REQUESTED", stateBeforeReopenRequest: "PUBLISHED" },
    });
    expect(response.json().period.state).toBe("COLLECTING");
    expect(updates[0]).toContain("reopen_count = reopen_count + 1");
    // A period back in COLLECTING must not still read as approved and paid.
    for (const column of ["approved_by_account_id = NULL", "payment_confirmed_at = NULL", "published_at = NULL"]) {
      expect(updates[0]).toContain(column);
    }
  });

  it("puts a rejected reopen back where the period was", async () => {
    const { response } = await call("director", "POST", `/payroll/periods/${PERIOD_ID}/transitions`, {
      ...transition("reject_reopen", "Selisihnya ditangani periode berikutnya"),
      period: { state: "REOPEN_REQUESTED", stateBeforeReopenRequest: "PAYMENT_CONFIRMED" },
    });
    expect(response.json().period.state).toBe("PAYMENT_CONFIRMED");
  });

  it("refuses a repeated action rather than moving the period twice", async () => {
    const { response, updates, audits } = await call("hc", "POST", `/payroll/periods/${PERIOD_ID}/transitions`, {
      ...transition("publish"),
      period: { state: "PUBLISHED" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("PAYROLL_STATE_CONFLICT");
    expect(updates).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("refuses to write when another actor moved the period first", async () => {
    const { response } = await call("hc", "POST", `/payroll/periods/${PERIOD_ID}/transitions`, {
      ...transition("start_collecting"),
      period: { state: "DRAFT" },
      versionRace: true,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("PAYROLL_STATE_CONFLICT");
  });

  it("refuses an action it does not know", async () => {
    const { response } = await call("hc", "POST", `/payroll/periods/${PERIOD_ID}/transitions`, {
      payload: { action: "delete_everything" },
      period: { state: "DRAFT" },
    });
    expect(response.statusCode).toBe(400);
  });
});


describe("PAY-003 period inputs", () => {
  const collecting = { state: "COLLECTING" };

  it("records an input and audits the batch without naming an amount", async () => {
    const { response, inputWrites, audits } = await call("hc", "PUT", `/payroll/periods/${PERIOD_ID}/inputs`, {
      period: collecting,
      payload: { inputs: [{ employmentId: EMPLOYMENT_ID, inputKey: "OVERTIME_HOURS", value: 5 }] },
    });
    expect(response.statusCode).toBe(200);
    expect(inputWrites).toEqual([{ employmentId: EMPLOYMENT_ID, inputKey: "OVERTIME_HOURS", value: 5 }]);
    expect(audits).toEqual(["payroll.period.inputs_recorded"]);
  });

  it("refuses an actor without payroll.inputs.manage", async () => {
    for (const persona of ["director", "finance", "employee", "board"] as const) {
      const { response } = await call(persona, "PUT", `/payroll/periods/${PERIOD_ID}/inputs`, {
        period: collecting,
        payload: { inputs: [{ employmentId: EMPLOYMENT_ID, inputKey: "OVERTIME_HOURS", value: 5 }] },
      });
      expect(response.statusCode).toBe(403);
    }
  }, 20_000);

  it("refuses an input recorded for the actor's own employment", async () => {
    const { response } = await call("hc", "PUT", `/payroll/periods/${PERIOD_ID}/inputs`, {
      period: collecting,
      payload: { inputs: [{ employmentId: OWN_EMPLOYMENT_ID, inputKey: "OVERTIME_HOURS", value: 5 }] },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("PAYROLL_OWN_RECORD");
  });

  it("requires a reason for the inputs that change pay by hand", async () => {
    for (const inputKey of ["ADJUSTMENT", "ARREARS", "PRORATION_FACTOR", "FULL_PAY_DESPITE_LEAVING"]) {
      const { response } = await call("hc", "PUT", `/payroll/periods/${PERIOD_ID}/inputs`, {
        period: collecting,
        payload: { inputs: [{ employmentId: EMPLOYMENT_ID, inputKey, value: 1 }] },
      });
      expect(response.json().code).toBe("PAYROLL_REASON_REQUIRED");
    }
  }, 20_000);

  it("requires the decision an adjustment rests on", async () => {
    const { response } = await call("hc", "PUT", `/payroll/periods/${PERIOD_ID}/inputs`, {
      period: collecting,
      payload: { inputs: [{ employmentId: EMPLOYMENT_ID, inputKey: "ADJUSTMENT", value: -500_000, reason: "koreksi" }] },
    });
    expect(response.json().code).toBe("PAYROLL_DECISION_REQUIRED");
  });

  it("refuses to change inputs once a period has left the working phase", async () => {
    for (const state of ["SUBMITTED", "APPROVED", "PAYMENT_CONFIRMED", "PUBLISHED"]) {
      const { response } = await call("hc", "PUT", `/payroll/periods/${PERIOD_ID}/inputs`, {
        period: { state },
        payload: { inputs: [{ employmentId: EMPLOYMENT_ID, inputKey: "OVERTIME_HOURS", value: 5 }] },
      });
      expect(response.statusCode).toBe(409);
    }
  }, 20_000);

  it("removes one input and records that it went", async () => {
    const { response, deletes, audits } = await call(
      "hc",
      "DELETE",
      `/payroll/periods/${PERIOD_ID}/inputs/${EMPLOYMENT_ID}/OVERTIME_HOURS`,
      { period: collecting },
    );
    expect(response.statusCode).toBe(204);
    expect(deletes).toEqual([`${EMPLOYMENT_ID}:OVERTIME_HOURS`]);
    expect(audits).toEqual(["payroll.period.input_removed"]);
  });

  it("refuses an input key it does not know", async () => {
    const { response } = await call("hc", "PUT", `/payroll/periods/${PERIOD_ID}/inputs`, {
      period: collecting,
      payload: { inputs: [{ employmentId: EMPLOYMENT_ID, inputKey: "BONUS_SIAPA_SAJA", value: 1 }] },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("PAY-003 calculation", () => {
  it("calculates a collecting period and writes one audit event, with aggregates only", async () => {
    const { response, audits } = await call("hc", "POST", `/payroll/periods/${PERIOD_ID}/transitions`, {
      period: { state: "COLLECTING" },
      payload: { action: "calculate" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().period.state).toBe("CALCULATED");
    expect(audits).toEqual(["payroll.period.calculated"]);
  });

  it("refuses to calculate a period that has already left its working phase", async () => {
    for (const state of ["SUBMITTED", "APPROVED", "PUBLISHED"]) {
      const { response } = await call("hc", "POST", `/payroll/periods/${PERIOD_ID}/transitions`, {
        period: { state },
        payload: { action: "calculate" },
      });
      expect(response.statusCode).toBe(409);
    }
  }, 20_000);

  it("refuses to calculate when no policy covers the pay date", async () => {
    const { response, audits } = await call("hc", "POST", `/payroll/periods/${PERIOD_ID}/transitions`, {
      period: { state: "COLLECTING" },
      payload: { action: "calculate" },
      policyComplete: false,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("PAYROLL_POLICY_MISSING");
    expect(audits).toEqual([]);
  });

  it("lets only payroll.calculate run it", async () => {
    for (const persona of ["director", "finance", "employee"] as const) {
      const { response } = await call(persona, "POST", `/payroll/periods/${PERIOD_ID}/transitions`, {
        period: { state: "COLLECTING" },
        payload: { action: "calculate" },
      });
      expect(response.statusCode).toBe(403);
    }
  }, 20_000);
});

describe("PAY-003 results", () => {
  it("records every read of per-person pay", async () => {
    const { response, audits } = await call("director", "GET", `/payroll/periods/${PERIOD_ID}/results`, {
      period: { state: "APPROVED" },
    });
    expect(response.statusCode).toBe(200);
    expect(audits).toEqual(["payroll.report.read"]);
  });

  it("refuses a reader with no payroll permission", async () => {
    for (const persona of ["employee", "board", "super_admin"] as const) {
      const { response } = await call(persona, "GET", `/payroll/periods/${PERIOD_ID}/results`, {
        period: { state: "APPROVED" },
      });
      expect(response.statusCode).toBe(403);
    }
  }, 20_000);

  it("keeps the figures from report readers until the period is approved", async () => {
    for (const state of ["DRAFT", "COLLECTING", "CALCULATED", "SUBMITTED"]) {
      const { response } = await call("director", "GET", `/payroll/periods/${PERIOD_ID}/results`, {
        period: { state },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("PAYROLL_NOT_APPROVED_YET");
    }
  }, 20_000);

  it("still shows them to the people running the period", async () => {
    const { response } = await call("hc", "GET", `/payroll/periods/${PERIOD_ID}/results`, {
      period: { state: "CALCULATED" },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe("PAY-003 input ranges", () => {
  it("refuses a proration factor the database would reject anyway", async () => {
    for (const value of [0, 1.5, -0.5]) {
      const { response } = await call("hc", "PUT", `/payroll/periods/${PERIOD_ID}/inputs`, {
        period: { state: "COLLECTING" },
        payload: {
          inputs: [{ employmentId: EMPLOYMENT_ID, inputKey: "PRORATION_FACTOR", value, reason: "masuk pertengahan bulan" }],
        },
      });
      expect(response.statusCode).toBe(400);
    }
  }, 20_000);

  it("refuses a negative count, hour or amount", async () => {
    const { response } = await call("hc", "PUT", `/payroll/periods/${PERIOD_ID}/inputs`, {
      period: { state: "COLLECTING" },
      payload: { inputs: [{ employmentId: EMPLOYMENT_ID, inputKey: "OVERTIME_HOURS", value: -4 }] },
    });
    expect(response.statusCode).toBe(400);
  });

  it("accepts a negative adjustment, which is the one input that may be", async () => {
    const { response } = await call("hc", "PUT", `/payroll/periods/${PERIOD_ID}/inputs`, {
      period: { state: "COLLECTING" },
      payload: {
        inputs: [{
          employmentId: EMPLOYMENT_ID,
          inputKey: "ADJUSTMENT",
          value: -500_000,
          reason: "koreksi kualifikasi khusus",
          decisionReference: "SK-UJI-001",
        }],
      },
    });
    expect(response.statusCode).toBe(200);
  });
});


describe("PAY-003 attendance-derived inputs", () => {
  const url = `/payroll/periods/${PERIOD_ID}/inputs/from-attendance`;

  it("stores approved overtime and contract attendance as ATTENDANCE inputs", async () => {
    const { response, inputWrites, audits } = await call("hc", "POST", url, {
      period: { state: "COLLECTING" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      overtimeCount: 1,
      attendanceCount: 1,
      clearedCount: 2,
      skippedOwnCount: 0,
    });
    expect(inputWrites).toEqual([
      { employmentId: EMPLOYMENT_ID, inputKey: "OVERTIME_HOURS", value: 2 },
      { employmentId: EMPLOYMENT_ID, inputKey: "CONTRACT_ATTENDANCE_DAYS", value: 18 },
    ]);
    expect(audits).toEqual(["payroll.period.attendance_resolved"]);
  });

  it("clears what an earlier resolve wrote before writing again", async () => {
    const { deletes } = await call("hc", "POST", url, { period: { state: "COLLECTING" } });
    expect(deletes).toEqual(["attendance_sweep"]);
  });

  it("needs payroll.inputs.manage", async () => {
    for (const persona of ["director", "finance", "employee", "board", "super_admin"] as const) {
      const { response } = await call(persona, "POST", url, { period: { state: "COLLECTING" } });
      expect(response.statusCode).toBe(403);
    }
  }, 20_000);

  it("refuses once the period has left its working phase", async () => {
    for (const state of ["SUBMITTED", "APPROVED", "PUBLISHED"]) {
      const { response, inputWrites } = await call("hc", "POST", url, { period: { state } });
      expect(response.statusCode).toBe(409);
      expect(inputWrites).toEqual([]);
    }
  }, 20_000);
});


describe("PAY-003 period report", () => {
  const url = `/payroll/periods/${PERIOD_ID}/report`;

  it("gives the director totals per unit and per component, with no account anywhere", async () => {
    const { response, audits } = await call("director", "GET", url, { period: { state: "APPROVED" } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.report.totals.payable).toBe("5600000");
    expect(body.report.byUnit).toHaveLength(1);
    expect(body.report.byComponent).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("bankAccount");
    expect(audits).toEqual(["payroll.report.read"]);
  });

  it("keeps it from report readers until the period is approved", async () => {
    const { response } = await call("director", "GET", url, { period: { state: "CALCULATED" } });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("PAYROLL_NOT_APPROVED_YET");
  });

  it("still shows it to the people running the period", async () => {
    const { response } = await call("hc", "GET", url, { period: { state: "CALCULATED" } });
    expect(response.statusCode).toBe(200);
  });

  it("is closed to the board and to anyone without a payroll permission", async () => {
    for (const persona of ["board", "employee", "super_admin"] as const) {
      const { response } = await call(persona, "GET", url, { period: { state: "APPROVED" } });
      expect(response.statusCode).toBe(403);
    }
  }, 20_000);
});

describe("PAY-003 transfer list", () => {
  const url = `/payroll/periods/${PERIOD_ID}/transfers`;

  it("gives finance the accounts to pay into, and records the read", async () => {
    const { response, audits } = await call("finance", "GET", url, { period: { state: "APPROVED" } });
    expect(response.statusCode).toBe(200);
    expect(response.json().transfers[0].bankAccountNumber).toBe("0000000001");
    expect(audits).toEqual(["payroll.report.read"]);
  });

  it("is closed to the director, who may approve but not see accounts", async () => {
    const { response } = await call("director", "GET", url, { period: { state: "APPROVED" } });
    expect(response.statusCode).toBe(403);
  });

  it("is closed to human capital", async () => {
    const { response } = await call("hc", "GET", url, { period: { state: "APPROVED" } });
    expect(response.statusCode).toBe(403);
  });

  it("refuses before the period is approved", async () => {
    const { response } = await call("finance", "GET", url, { period: { state: "CALCULATED" } });
    expect(response.statusCode).toBe(409);
  });

  it("exports CSV as an attachment, still no-store", async () => {
    const { response, audits } = await call("finance", "GET", `${url}?format=csv`, {
      period: { state: "PAYMENT_CONFIRMED" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.headers["content-disposition"]).toContain("daftar-transfer-2026-09.csv");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toContain(`"'0000000001"`);
    expect(audits).toEqual(["payroll.report.read"]);
  });
});

describe("PAY-003 input rules on the period", () => {
  it("tells the screen which inputs are typed by hand and which carry a reason", async () => {
    const { response } = await call("hc", "GET", `/payroll/periods/${PERIOD_ID}`, {
      period: { state: "COLLECTING" },
    });
    expect(response.statusCode).toBe(200);
    const rules = response.json().period.inputRules;
    // Overtime and PKWT attendance come from the resolver, so they are not
    // offered by hand: typing one would be thrown away by the next resolve.
    expect(rules.manual).not.toContain("OVERTIME_HOURS");
    expect(rules.manual).not.toContain("CONTRACT_ATTENDANCE_DAYS");
    expect(rules.manual).toContain("ADJUSTMENT");
    expect(rules.reasonRequired).toEqual(["ADJUSTMENT", "ARREARS", "PRORATION_FACTOR", "FULL_PAY_DESPITE_LEAVING"]);
    expect(rules.decisionRequired).toEqual(["ADJUSTMENT"]);
  });

  it("refuses by the same lists it published", async () => {
    const withoutReason = await call("hc", "PUT", `/payroll/periods/${PERIOD_ID}/inputs`, {
      period: { state: "COLLECTING" },
      payload: { inputs: [{ employmentId: EMPLOYMENT_ID, inputKey: "ARREARS", value: 100000 }] },
    });
    expect(withoutReason.response.statusCode).toBe(400);
    expect(withoutReason.response.json().code).toBe("PAYROLL_REASON_REQUIRED");

    const withoutDecision = await call("hc", "PUT", `/payroll/periods/${PERIOD_ID}/inputs`, {
      period: { state: "COLLECTING" },
      payload: {
        inputs: [{ employmentId: EMPLOYMENT_ID, inputKey: "ADJUSTMENT", value: 250000, reason: "SK kenaikan" }],
      },
    });
    expect(withoutDecision.response.statusCode).toBe(400);
    expect(withoutDecision.response.json().code).toBe("PAYROLL_DECISION_REQUIRED");
  });
});

describe("PAY-003 variance", () => {
  const url = `/payroll/periods/${PERIOD_ID}/variance`;

  it("reports what moved since the previous period", async () => {
    const { response, audits } = await call("hc", "GET", url, { period: { state: "CALCULATED" } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.variances).toHaveLength(1);
    expect(body.variances[0]).toMatchObject({ componentCode: "PERF", delta: "300000" });
    expect(body.threshold).toEqual({ relative: 0.1, absolute: 50_000, manualInput: 1_000_000 });
    expect(audits).toEqual(["payroll.report.read"]);
    // Only the people a variance row is about: payroll.calculate opens this
    // comparison but not the result list, so the whole roster must not leak.
    expect(body.employees).toEqual([
      { employmentId: body.variances[0].employmentId, employeeNumber: "YSQ-0001", fullName: "Pegawai Uji" },
    ]);
  });

  it("answers plainly when there is no earlier period to compare against", async () => {
    const { response } = await call("hc", "GET", url, {
      period: { state: "CALCULATED" },
      hasPreviousPeriod: false,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ previousPeriodId: null, threshold: null, variances: [], employees: [] });
  });

  it("keeps it from report readers until the period is approved", async () => {
    const { response } = await call("director", "GET", url, { period: { state: "CALCULATED" } });
    expect(response.statusCode).toBe(409);
  });
});
