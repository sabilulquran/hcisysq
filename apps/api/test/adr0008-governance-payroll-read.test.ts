import Fastify from "fastify";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import { loadConfig, type ApiConfig } from "../src/config/env.js";
import {
  BOARD_READ_PERMISSION,
  GOVERNANCE_PAYROLL_READ_PERMISSION,
  GOVERNANCE_PAYROLL_READER_ROLE_KEY,
  PAYROLL_PERMISSIONS,
} from "../src/modules/auth/permissions.js";
import { canDelegateRole, isGovernanceAccountRole, isSeatLinkableRole } from "../src/modules/auth/role-assignment.js";
import { registerGovernancePayrollRoutes } from "../src/modules/governance/payroll-routes.js";
import { PER_PERSON_READER_PERMISSIONS } from "../src/modules/payroll/routes.js";

/**
 * ADR-0008 — Pengurus Yayasan membaca gaji per orang. Synthetic data only: no production account,
 * token or payroll figure appears here.
 *
 * The negative cases are the point of the file. The owner opened one door; these pin that the
 * others stayed shut.
 */

const PORTAL_CLIENT = "sq-organ";
const ORGAN_ACCOUNT = "00000000-0000-4000-8000-000000000001";
const PERIOD = "00000000-0000-4000-8000-0000000000aa";
const DRAFT_PERIOD = "00000000-0000-4000-8000-0000000000bb";

interface Audits {
  auth: Array<{ eventType: string; accountId: string | null; reasonCode: string | null }>;
  payroll: Array<{ actorAccountId: string; action: string; periodId: string; payload: unknown }>;
}

function buildPool(options: {
  capability?: boolean;
  boardAccess?: boolean;
  account?: { principalType?: string; employeeId?: string | null; status?: string };
}) {
  const audits: Audits = { auth: [], payroll: [] };
  const accountRow = {
    id: ORGAN_ACCOUNT,
    principalType: options.account?.principalType ?? "FOUNDATION_BOARD",
    employeeId: options.account?.employeeId ?? null,
    status: options.account?.status ?? "active",
  };
  const query = async (sql: string, params?: unknown[]) => {
    if (sql.includes("auth_audit_events")) {
      audits.auth.push({
        eventType: String(params?.[2]),
        accountId: (params?.[1] ?? null) as string | null,
        reasonCode: (params?.[5] ?? null) as string | null,
      });
      return { rows: [] };
    }
    if (sql.includes("FROM accounts WHERE identity_issuer")) return { rows: [accountRow] };
    // The ADR-0008 capability: an organization-scoped, in-date assignment of the new role.
    if (sql.includes("rp.permission_key = $2")) {
      expect(params?.[1]).toBe(GOVERNANCE_PAYROLL_READ_PERMISSION);
      return { rows: [{ allowed: options.capability ?? false }] };
    }
    // board.read for an EMPLOYEE account (ORG-010 path A).
    if (sql.includes("role_permission.permission_key = $2")) {
      return { rows: [{ allowed: options.boardAccess ?? true }] };
    }
    if (sql.includes("FROM payroll_periods p")) {
      return {
        rows: [{ id: PERIOD, kind: "MONTHLY", periodMonth: "2026-10-01", state: "APPROVED", payDate: "2026-10-25" }],
      };
    }
    if (sql.includes("payroll_result_lines")) {
      return {
        rows: [
          { employmentId: "employment-1", componentCode: "BASIC", category: "INCOME", amount: "1000", basis: null, displayOrder: 1 },
        ],
      };
    }
    if (sql.includes("latest.revision")) {
      return {
        rows: [{
          employmentId: "employment-1", revision: 1, gross: "1000", deductions: "100", net: "900",
          payable: "900", employerCost: "1100", payFactor: "1", payFactorReason: "FULL",
          bpjsBase: "1000", blockers: [], calculatedAt: "2026-10-20T00:00:00.000Z", thrAverageWage: null,
        }],
      };
    }
    if (sql.includes('AS "employeeNumber"')) {
      return { rows: [{ employmentId: "employment-1", employeeNumber: "SQ-001", fullName: "Pegawai Sintetis" }] };
    }
    return { rows: [] };
  };
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("payroll_audit_events")) {
        audits.payroll.push({
          actorAccountId: String(params?.[1]),
          action: String(params?.[2]),
          periodId: String(params?.[3]),
          payload: JSON.parse(String(params?.[5])),
        });
      }
      return { rows: [] };
    },
    release: () => undefined,
  } as unknown as PoolClient;
  return { pool: { query, connect: async () => client } as unknown as Pool, audits };
}

const baseConfig = {
  NODE_ENV: "test", HOST: "127.0.0.1", PORT: 3001, DATABASE_URL: "postgres://adr0008-test",
  AUTH_MODE: "local", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8,
  GOVERNANCE_SUMMARY_ENABLED: "true", GOVERNANCE_PAYROLL_READ_ENABLED: "true",
} as ApiConfig;

function identity(overrides: Record<string, unknown> = {}) {
  return {
    issuer: "https://identity.example.invalid/realms/staff",
    subject: "synthetic-subject",
    client: PORTAL_CLIENT,
    ...overrides,
  };
}

async function buildApp(input: {
  pool: Pool;
  enabled?: boolean;
  client?: string;
  accessAllowed?: boolean;
}) {
  const app = Fastify();
  registerGovernancePayrollRoutes(
    app,
    input.pool,
    { ...baseConfig, GOVERNANCE_PAYROLL_READ_ENABLED: input.enabled === false ? "false" : "true" },
    {
      verifyToken: (async () => identity({ client: input.client ?? PORTAL_CLIENT })) as never,
      applicationAccess: { isAllowed: async () => input.accessAllowed ?? true },
      allowedClients: new Set([PORTAL_CLIENT]),
    },
  );
  await app.ready();
  return app;
}

async function get(app: Awaited<ReturnType<typeof buildApp>>, url: string) {
  return await app.inject({ method: "GET", url, headers: { authorization: "Bearer synthetic-token" } });
}

describe("ADR-0008 GET /governance/payroll/*", () => {
  it("serves the approved periods and their per-person figures to an organ account that holds the role", async () => {
    const { pool } = buildPool({ capability: true });
    const app = await buildApp({ pool });

    const periods = await get(app, "/governance/payroll/periods");
    const results = await get(app, `/governance/payroll/periods/${PERIOD}/results`);
    await app.close();

    expect(periods.statusCode).toBe(200);
    expect(periods.json().periods).toEqual([
      { id: PERIOD, kind: "MONTHLY", periodMonth: "2026-10-01", state: "APPROVED", payDate: "2026-10-25" },
    ]);

    expect(results.statusCode).toBe(200);
    expect(results.headers["cache-control"]).toBe("private, no-store");
    const people = results.json().people as Array<Record<string, unknown>>;
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ employeeNumber: "SQ-001", fullName: "Pegawai Sintetis", net: "900" });
    expect(people[0]!.lines).toEqual([{ componentCode: "BASIC", category: "INCOME", amount: "1000", displayOrder: 1 }]);
    // What the ADR did not open: no bank account, and no internal employment key.
    expect(JSON.stringify(people[0])).not.toContain("employmentId");
    expect(JSON.stringify(results.json())).not.toMatch(/bank|rekening|account_number/i);
  });

  it("writes every read to the payroll audit, the same action an HC read writes", async () => {
    const { pool, audits } = buildPool({ capability: true });
    const app = await buildApp({ pool });
    await get(app, `/governance/payroll/periods/${PERIOD}/results`);
    await app.close();

    expect(audits.payroll).toEqual([{
      actorAccountId: ORGAN_ACCOUNT,
      action: "payroll.report.read",
      periodId: PERIOD,
      payload: { scope: "governance_period_results", row_count: 1, actor: "organ" },
    }]);
    expect(audits.auth.map((entry) => entry.eventType)).toContain("governance.payroll.results.read");
  });

  it("refuses an organ account that does not hold the role, and reads nothing", async () => {
    const { pool, audits } = buildPool({ capability: false });
    const app = await buildApp({ pool });
    const response = await get(app, `/governance/payroll/periods/${PERIOD}/results`);
    await app.close();

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("PAYROLL_READ_FORBIDDEN");
    expect(audits.payroll).toEqual([]);
    expect(audits.auth).toContainEqual({
      eventType: "governance.payroll.denied", accountId: ORGAN_ACCOUNT, reasonCode: "PAYROLL_READ_FORBIDDEN",
    });
  });

  it("refuses a plain foundation_board_viewer: board.read is not payroll", async () => {
    // ORG-010 path A — an EMPLOYEE account whose board access comes from the viewer role. It
    // passes every board gate and still reads no pay here.
    const { pool, audits } = buildPool({
      capability: true, boardAccess: true,
      account: { principalType: "EMPLOYEE", employeeId: "employee-1" },
    });
    const app = await buildApp({ pool });
    const response = await get(app, `/governance/payroll/periods/${PERIOD}/results`);
    await app.close();

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("NOT_FOUNDATION_BOARD");
    expect(audits.payroll).toEqual([]);
  });

  it("leaves an employee principal exactly where it was: no board access, no payroll read", async () => {
    const { pool, audits } = buildPool({
      capability: true, boardAccess: false,
      account: { principalType: "EMPLOYEE", employeeId: "employee-1" },
    });
    const app = await buildApp({ pool });
    const response = await get(app, "/governance/payroll/periods");
    await app.close();

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("BOARD_ACCESS_REQUIRED");
    expect(audits.payroll).toEqual([]);
  });

  it("answers 404 for a period that is not approved yet, without saying it exists", async () => {
    const { pool, audits } = buildPool({ capability: true });
    const app = await buildApp({ pool });
    const response = await get(app, `/governance/payroll/periods/${DRAFT_PERIOD}/results`);
    await app.close();

    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("PAYROLL_PERIOD_NOT_FOUND");
    expect(audits.payroll).toEqual([]);
  });

  it("refuses a token from a client that is not the portal", async () => {
    const { pool } = buildPool({ capability: true });
    const app = await buildApp({ pool, client: "sq-hub" });
    const response = await get(app, "/governance/payroll/periods");
    await app.close();

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("FORBIDDEN_CLIENT");
  });

  it("refuses a cookie: these routes read exactly one bearer token", async () => {
    const { pool } = buildPool({ capability: true });
    const app = await buildApp({ pool });
    const response = await app.inject({
      method: "GET", url: "/governance/payroll/periods", headers: { cookie: "hcis_session=synthetic" },
    });
    await app.close();

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("UNAUTHENTICATED");
  });

  it("answers 404 on every route while the flag is off", async () => {
    const { pool } = buildPool({ capability: true });
    const app = await buildApp({ pool, enabled: false });
    for (const url of ["/governance/payroll/periods", `/governance/payroll/periods/${PERIOD}/results`]) {
      const response = await get(app, url);
      expect(response.statusCode, url).toBe(404);
    }
    await app.close();
  });

  it("opens no route for the transfer list, in any shape", async () => {
    const registered: string[] = [];
    const app = Fastify();
    app.addHook("onRoute", (route) => registered.push(route.url));
    registerGovernancePayrollRoutes(app, buildPool({ capability: true }).pool, baseConfig, {
      verifyToken: (async () => identity()) as never,
      applicationAccess: { isAllowed: async () => true },
    });
    await app.ready();
    await app.close();

    expect([...new Set(registered)].sort()).toEqual([
      "/governance/payroll/periods",
      "/governance/payroll/periods/:periodId/results",
    ]);
  });
});

describe("ADR-0008 the new key stays out of every payroll bundle", () => {
  it("is neither a payroll permission nor a per-person reader key on the HCIS surface", () => {
    expect(PAYROLL_PERMISSIONS as readonly string[]).not.toContain(GOVERNANCE_PAYROLL_READ_PERMISSION);
    // The /payroll routes keep their own readers: an organ key never opens /admin or /app.
    expect(PER_PERSON_READER_PERMISSIONS).not.toContain(GOVERNANCE_PAYROLL_READ_PERMISSION);
    expect(GOVERNANCE_PAYROLL_READ_PERMISSION).not.toBe(BOARD_READ_PERMISSION);
    // And it does not open the transfer list, which keeps its own permission (ADR-0008 D-4).
    expect(GOVERNANCE_PAYROLL_READ_PERMISSION).not.toBe("payroll.transfers.read.organization");
  });
});

describe("ADR-0008 D-3 granting the role", () => {
  const role = {
    roleKey: GOVERNANCE_PAYROLL_READER_ROLE_KEY,
    permissions: [GOVERNANCE_PAYROLL_READ_PERMISSION],
  };

  it("is a governance account role, like the ORG-013 leave approver", () => {
    expect(isGovernanceAccountRole(GOVERNANCE_PAYROLL_READER_ROLE_KEY)).toBe(true);
    expect(isGovernanceAccountRole("foundation_board_viewer")).toBe(false);
  });

  it("may be granted while it carries exactly its one permission", () => {
    expect(canDelegateRole(role, false, "sq_hub")).toBe(true);
  });

  it("is refused once the bundle grows, whatever was added", () => {
    for (const extra of ["payroll.transfers.read.organization", "board.read", "payroll.approve"]) {
      expect(canDelegateRole({ ...role, permissions: [...role.permissions, extra] }, false, "sq_hub")).toBe(false);
    }
  });

  it("is refused for any other role that tries to carry the key", () => {
    expect(canDelegateRole({ roleKey: "director", permissions: [GOVERNANCE_PAYROLL_READ_PERMISSION] }, false, "sq_hub"))
      .toBe(false);
    expect(canDelegateRole({ roleKey: "foundation_board_viewer", permissions: [GOVERNANCE_PAYROLL_READ_PERMISSION] }, false, "sq_hub"))
      .toBe(false);
  });

  it("never follows a seat: holding Ketua, Sekretaris or Bendahara confers nothing (ORG-013-1 point 3)", () => {
    expect(isSeatLinkableRole(role)).toBe(false);
  });
});

describe("ADR-0008 configuration", () => {
  const base = {
    DATABASE_URL: "postgres://synthetic@127.0.0.1:1/unused",
    AUTH_MODE: "oidc",
    OIDC_ISSUER: "https://identity.example.invalid/realms/staff",
    OIDC_CLIENT_ID: "hcis-web",
    OIDC_CLIENT_SECRET: "synthetic",
    OIDC_REDIRECT_URI: "https://hcis.example.invalid/api/auth/callback",
    OIDC_POST_LOGOUT_REDIRECT_URI: "https://hcis.example.invalid/",
    SQ_HUB_APPLICATION_ACCESS_URL: "https://hub.example.invalid/access",
    SQ_HUB_MACHINE_CLIENT_ID: "hcis-machine",
    SQ_HUB_MACHINE_CLIENT_SECRET: "synthetic",
    AUTH_ENCRYPTION_KEY: "11".repeat(32),
  };
  const governance = {
    GOVERNANCE_SUMMARY_ENABLED: "true",
    GOVERNANCE_SUMMARY_AUDIENCE: "hcis",
    GOVERNANCE_SUMMARY_ALLOWED_CLIENTS: "sq-hub,sq-organ",
    GOVERNANCE_SUMMARY_APPLICATION_KEY: "hcis",
  };

  it("refuses the payroll read without the summary plumbing it depends on", () => {
    expect(() => loadConfig({ ...base, GOVERNANCE_PAYROLL_READ_ENABLED: "true" }))
      .toThrow(/GOVERNANCE_PAYROLL_READ_ENABLED=true requires GOVERNANCE_SUMMARY_ENABLED=true/);
  });

  it("is off unless it is switched on", () => {
    expect(loadConfig({ ...base, ...governance }).GOVERNANCE_PAYROLL_READ_ENABLED).toBe("false");
    expect(loadConfig({ ...base, ...governance, GOVERNANCE_PAYROLL_READ_ENABLED: "true" })
      .GOVERNANCE_PAYROLL_READ_ENABLED).toBe("true");
  });
});
