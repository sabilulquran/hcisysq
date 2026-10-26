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

const PERIOD_ID = "50000000-0000-4000-8000-000000000001";
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

function createPool(persona: Persona, overrides: PeriodOverrides, options: { versionRace?: boolean } = {}) {
  const audits: string[] = [];
  const updates: string[] = [];
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
    if (sql.includes("FROM payroll_period_transitions")) {
      return { rows: transitions, rowCount: transitions.length };
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
  return { pool, audits, updates, transitions };
}

async function call(
  persona: Persona,
  method: "GET" | "POST",
  url: string,
  options: { payload?: object; period?: PeriodOverrides; versionRace?: boolean } = {},
) {
  const { pool, audits, updates, transitions } = createPool(persona, options.period ?? {}, {
    ...(options.versionRace === undefined ? {} : { versionRace: options.versionRace }),
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
  return { response, audits, updates, transitions };
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

  it("lets human capital read periods", async () => {
    const { response } = await call("hc", "GET", "/payroll/periods");
    expect(response.statusCode).toBe(200);
    expect(response.json().periods).toHaveLength(1);
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
