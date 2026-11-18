import { createServer, type Server } from "node:http";

import Fastify from "fastify";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig, type ApiConfig } from "../src/config/env.js";
import { ActorAssertionError } from "../src/modules/auth/actor-assertion.js";
import { createGovernanceTokenVerifier } from "../src/modules/governance/token-verifier.js";

// ORG-015. Synthetic data only: no production identity, token or request is used here.

const DECISION_AUDIENCE = "hcis-organ-decision";
const PORTAL_CLIENT = "sq-organ";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const STEP_ID = "00000000-0000-4000-8000-0000000000aa";
const REQUEST_ID = "00000000-0000-4000-8000-0000000000bb";
const ACTION_ID = "00000000-0000-4000-8000-0000000000cc";

describe("ORG-015-2 decision token", () => {
  let server: Server;
  let issuer: string;
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  const kid = "org015-test-key";

  beforeAll(async () => {
    keys = await generateKeyPair("RS256", { extractable: true });
    const jwk = { ...(await exportJWK(keys.publicKey)), kid, alg: "RS256", use: "sig" };
    server = createServer((request, response) => {
      if (request.url?.endsWith("/protocol/openid-connect/certs")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    issuer = `http://127.0.0.1:${address.port}/realms/staff`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function sign(claims: Record<string, unknown> = {}, issuedAt?: number) {
    const token = new SignJWT({
      typ: "Bearer",
      azp: PORTAL_CLIENT,
      aud: [DECISION_AUDIENCE, "account"],
      acr: "2",
      jti: "synthetic-jti",
      ...claims,
    })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(issuer)
      .setSubject("synthetic-subject")
      .setExpirationTime("5m");
    return (issuedAt === undefined ? token.setIssuedAt() : token.setIssuedAt(issuedAt)).sign(keys.privateKey);
  }

  const decisionVerifier = () => createGovernanceTokenVerifier({
    issuer,
    audience: DECISION_AUDIENCE,
    allowedClients: new Set([PORTAL_CLIENT]),
    stepUp: { acr: "2", maxAgeSeconds: 60 },
  });

  it("accepts a fresh step-up token and returns the jti it must be spent under", async () => {
    await expect(decisionVerifier()(await sign())).resolves.toMatchObject({
      issuer,
      subject: "synthetic-subject",
      client: PORTAL_CLIENT,
      jti: "synthetic-jti",
    });
  });

  it.each([
    ["no acr at all", { acr: undefined }, "STEP_UP_REQUIRED", 403],
    ["acr 1, which a password alone reaches", { acr: "1" }, "STEP_UP_REQUIRED", 403],
    ["acr 0", { acr: "0" }, "STEP_UP_REQUIRED", 403],
    ["no jti, so it could never be spent", { jti: undefined }, "INVALID_TOKEN", 401],
    ["the summary audience", { aud: "hcis" }, "FORBIDDEN_AUDIENCE", 403],
    ["SQ Hub as the authorized party", { azp: "sq-hub" }, "FORBIDDEN_CLIENT", 403],
  ])("refuses a token with %s", async (_label, claims, code, statusCode) => {
    await expect(decisionVerifier()(await sign(claims))).rejects.toMatchObject({ code, statusCode });
  });

  it("refuses a token 61 seconds old, even though it has not expired", async () => {
    // The clock tolerance is not added to this window: with it the real limit would be 90
    // seconds, which is half as long again as the one the specification states.
    const stale = await sign({}, Math.floor(Date.now() / 1000) - 61);
    await expect(decisionVerifier()(stale)).rejects.toMatchObject({ code: "TOKEN_TOO_OLD", statusCode: 401 });
    const older = await sign({}, Math.floor(Date.now() / 1000) - 200);
    await expect(decisionVerifier()(older)).rejects.toMatchObject({ code: "TOKEN_TOO_OLD", statusCode: 401 });
  });

  it("accepts a token 59 seconds old", async () => {
    const recent = await sign({}, Math.floor(Date.now() / 1000) - 59);
    await expect(decisionVerifier()(recent)).resolves.toMatchObject({ subject: "synthetic-subject" });
  });

  it("keeps the read token and the decision token apart in both directions", async () => {
    const summaryVerifier = createGovernanceTokenVerifier({
      issuer, audience: "hcis", allowedClients: new Set(["sq-hub", PORTAL_CLIENT]),
    });
    // A decision token may not read the summary, and a summary token may not decide.
    await expect(summaryVerifier(await sign())).rejects.toMatchObject({ code: "FORBIDDEN_AUDIENCE" });
    await expect(decisionVerifier()(await sign({ aud: ["hcis", "account"], acr: "2" })))
      .rejects.toMatchObject({ code: "FORBIDDEN_AUDIENCE" });
  });

  it("leaves the summary verifier exactly as ORG-010 had it", async () => {
    const summaryVerifier = createGovernanceTokenVerifier({
      issuer, audience: DECISION_AUDIENCE, allowedClients: new Set([PORTAL_CLIENT]),
    });
    // No step-up requirement: no acr, no jti, and the identity carries neither.
    await expect(summaryVerifier(await sign({ acr: undefined, jti: undefined })))
      .resolves.toEqual({ issuer, subject: "synthetic-subject", client: PORTAL_CLIENT });
  });
});

describe("ORG-015-1 configuration", () => {
  const base = { DATABASE_URL: "postgres://synthetic@127.0.0.1:1/unused" };
  const oidc = {
    AUTH_MODE: "oidc", OIDC_ISSUER: "https://identity.example.invalid/realms/staff", OIDC_CLIENT_ID: "hcis-web",
    OIDC_CLIENT_SECRET: "synthetic", OIDC_REDIRECT_URI: "https://hcis.example.invalid/api/auth/callback",
    OIDC_POST_LOGOUT_REDIRECT_URI: "https://hcis.example.invalid/", SQ_HUB_APPLICATION_ACCESS_URL: "https://hub.example.invalid/access",
    SQ_HUB_MACHINE_CLIENT_ID: "hcis-machine", SQ_HUB_MACHINE_CLIENT_SECRET: "synthetic",
  };
  const governance = {
    GOVERNANCE_SUMMARY_ENABLED: "true", GOVERNANCE_SUMMARY_AUDIENCE: "hcis",
    GOVERNANCE_SUMMARY_ALLOWED_CLIENTS: "sq-hub,sq-organ", GOVERNANCE_SUMMARY_APPLICATION_KEY: "hcis",
  };

  it("is off by default and defaults the allowlist to the portal client alone", () => {
    const config = loadConfig(base);
    expect(config.GOVERNANCE_DECISIONS_ENABLED).toBe("false");
    expect(config.GOVERNANCE_DECISION_ALLOWED_CLIENTS).toBe("sq-organ");
  });

  it("requires its own audience when enabled", () => {
    expect(() => loadConfig({ ...base, ...oidc, ...governance, GOVERNANCE_DECISIONS_ENABLED: "true" }))
      .toThrow(/GOVERNANCE_DECISION_AUDIENCE is required/);
  });

  it("requires the summary plumbing it reuses", () => {
    expect(() => loadConfig({
      ...base, ...oidc, GOVERNANCE_DECISIONS_ENABLED: "true", GOVERNANCE_DECISION_AUDIENCE: DECISION_AUDIENCE,
    })).toThrow(/requires GOVERNANCE_SUMMARY_ENABLED=true/);
  });

  it("refuses an audience that is also the summary or a machine audience", () => {
    expect(() => loadConfig({
      ...base, ...oidc, ...governance, GOVERNANCE_DECISIONS_ENABLED: "true", GOVERNANCE_DECISION_AUDIENCE: "hcis",
    })).toThrow(/must differ from GOVERNANCE_SUMMARY_AUDIENCE/);
    expect(() => loadConfig({
      ...base, ...oidc, ...governance, ORG_DIRECTORY_TOKEN_AUDIENCE: DECISION_AUDIENCE,
      GOVERNANCE_DECISIONS_ENABLED: "true", GOVERNANCE_DECISION_AUDIENCE: DECISION_AUDIENCE,
    })).toThrow(/must differ from ORG_DIRECTORY_TOKEN_AUDIENCE/);
  });

  // A decision token is issued to a person and carries no service-account marker, so sharing a
  // name with the AUTH-014 actor audience would let it vouch for someone on the role channel.
  it("refuses an audience shared with the AUTH-014 role-administration channel", () => {
    for (const key of ["HCIS_ROLE_ADMIN_TOKEN_AUDIENCE", "HCIS_ROLE_ADMIN_ACTOR_AUDIENCE"] as const) {
      expect(() => loadConfig({
        ...base, ...oidc, ...governance, [key]: DECISION_AUDIENCE,
        GOVERNANCE_DECISIONS_ENABLED: "true", GOVERNANCE_DECISION_AUDIENCE: DECISION_AUDIENCE,
      })).toThrow(new RegExp(`must differ from ${key}`));
    }
  });

  it("accepts a complete configuration", () => {
    const config = loadConfig({
      ...base, ...oidc, ...governance, GOVERNANCE_DECISIONS_ENABLED: "true",
      GOVERNANCE_DECISION_AUDIENCE: DECISION_AUDIENCE,
    });
    expect(config.GOVERNANCE_DECISION_AUDIENCE).toBe(DECISION_AUDIENCE);
  });
});

const leave = vi.hoisted(() => ({
  apply: vi.fn(),
  capability: vi.fn(async () => undefined),
}));
const assertions = vi.hoisted(() => ({ spend: vi.fn(async () => undefined) }));

vi.mock("../src/modules/leave/employee-routes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/leave/employee-routes.js")>();
  return {
    ...actual,
    applyLeaveApprovalDecision: leave.apply,
    assertGovernanceApprovalCapability: leave.capability,
  };
});
vi.mock("../src/modules/auth/actor-assertion.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/auth/actor-assertion.js")>();
  return { ...actual, spendActorAssertion: assertions.spend };
});

const { registerGovernanceDecisionRoutes } = await import("../src/modules/governance/decision-routes.js");
const { EmployeeLeaveError } = await import("../src/modules/leave/employee-routes.js");

interface FakePool {
  pool: Pool;
  audits: Array<{ eventType: string; accountId: string | null; reasonCode: string | null }>;
  clientQueries: string[];
}

function fakePool(rows: { steps?: unknown[]; history?: unknown[] } = {}): FakePool {
  const audits: FakePool["audits"] = [];
  const clientQueries: string[] = [];
  const query = async (sql: string, params?: unknown[]) => {
    if (sql.includes("auth_audit_events")) {
      audits.push({ eventType: String(params?.[2]), accountId: (params?.[1] ?? null) as string | null, reasonCode: (params?.[5] ?? null) as string | null });
      return { rows: [] };
    }
    if (sql.includes("FROM leave_request_approval_steps s")) return { rows: rows.steps ?? [] };
    if (sql.includes("FROM leave_request_approval_steps")) return { rows: rows.history ?? [] };
    return { rows: [] };
  };
  const client = {
    query: async (sql: string) => {
      clientQueries.push(sql);
      return { rows: [] };
    },
    release: () => undefined,
  } as unknown as PoolClient;
  const pool = { query, connect: async () => client } as unknown as Pool;
  return { pool, audits, clientQueries };
}

const baseConfig = {
  NODE_ENV: "test", HOST: "127.0.0.1", PORT: 3001, DATABASE_URL: "postgres://org015-test",
  AUTH_MODE: "local", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8,
} as ApiConfig;

function identity(overrides: Record<string, unknown> = {}) {
  return {
    issuer: "https://identity.example.invalid/realms/staff",
    subject: "synthetic-subject",
    client: PORTAL_CLIENT,
    jti: "synthetic-jti",
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

async function buildApp(input: {
  pool: Pool;
  enabled?: boolean;
  verify?: () => Promise<ReturnType<typeof identity>>;
  account?: { principalType?: string; employeeId?: string | null };
  accessAllowed?: boolean;
}) {
  const app = Fastify();
  const accountRow = {
    id: ACCOUNT_ID,
    principalType: input.account?.principalType ?? "FOUNDATION_BOARD",
    employeeId: input.account?.employeeId ?? null,
    status: "active",
  };
  // The account lookup and board access live in resolveGovernanceAccount, which reads the pool;
  // here the pool answers it directly so the test stays on the route's own rules.
  const pool = {
    ...input.pool,
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM accounts WHERE identity_issuer")) return { rows: [accountRow] };
      // An employee account reaches the board through board.read; grant it so the test exercises
      // the portal's own rule rather than stopping at board access.
      if (sql.includes("role_permission.permission_key = $2")) return { rows: [{ allowed: true }] };
      return await (input.pool.query as unknown as (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>)(sql, params);
    },
    connect: input.pool.connect.bind(input.pool),
  } as unknown as Pool;

  registerGovernanceDecisionRoutes(
    app,
    pool,
    { ...baseConfig, GOVERNANCE_DECISIONS_ENABLED: input.enabled === false ? "false" : "true" },
    {
      verifyToken: (input.verify ?? (async () => identity())) as never,
      applicationAccess: { isAllowed: async () => input.accessAllowed ?? true },
    },
  );
  await app.ready();
  return app;
}

describe("ORG-015-3 POST /governance/decisions/:stepId", () => {
  beforeEach(() => {
    leave.apply.mockReset();
    leave.capability.mockReset();
    leave.capability.mockResolvedValue(undefined);
    assertions.spend.mockReset();
    assertions.spend.mockResolvedValue(undefined);
  });

  async function decide(app: Awaited<ReturnType<typeof buildApp>>, body: Record<string, unknown> = {}) {
    return await app.inject({
      method: "POST",
      url: `/governance/decisions/${STEP_ID}`,
      headers: { authorization: "Bearer synthetic-token" },
      payload: { decision: "approve", requestId: ACTION_ID, ...body },
    });
  }

  it("forwards the decision and answers with what the leave engine returned", async () => {
    leave.apply.mockResolvedValue({
      replayed: false,
      payload: { requestId: REQUEST_ID, requestStatus: "approved", stepStatus: "approved", nextPendingStepId: null, hcHandling: "notify", hcTaskStatus: null, criticalReviewStatus: null },
    });
    const { pool, audits } = fakePool();
    const app = await buildApp({ pool });
    const response = await decide(app);
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json().requestStatus).toBe("approved");
    expect(leave.apply).toHaveBeenCalledOnce();
    expect(leave.apply.mock.calls[0]![1]).toMatchObject({
      principal: { id: ACCOUNT_ID, principalType: "FOUNDATION_BOARD" },
      stepId: STEP_ID,
      decision: "approve",
      decisionRequestId: ACTION_ID,
    });
    expect(audits.some((entry) => entry.eventType === "governance.decision.served")).toBe(true);
  });

  it("spends the token before the step is read, and refuses the second presentation", async () => {
    const order: string[] = [];
    assertions.spend.mockImplementation(async () => {
      order.push("spend");
      return undefined;
    });
    leave.apply.mockImplementation(async () => {
      order.push("decide");
      return { replayed: false, payload: { requestId: REQUEST_ID, requestStatus: "approved", stepStatus: "approved", nextPendingStepId: null, hcHandling: "none", hcTaskStatus: null, criticalReviewStatus: null } };
    });
    const first = await buildApp({ pool: fakePool().pool });
    expect((await decide(first)).statusCode).toBe(200);
    await first.close();
    expect(order).toEqual(["spend", "decide"]);

    assertions.spend.mockRejectedValueOnce(new ActorAssertionError("ACTOR_ASSERTION_SPENT", "already used"));
    const { pool, audits } = fakePool();
    const second = await buildApp({ pool });
    const response = await decide(second);
    await second.close();
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("DECISION_TOKEN_SPENT");
    expect(leave.apply).toHaveBeenCalledOnce();
    expect(audits.at(-1)).toMatchObject({ eventType: "governance.decision.denied", reasonCode: "DECISION_TOKEN_SPENT" });
  });

  it("burns the token even when the decision is then refused", async () => {
    leave.apply.mockRejectedValue(new EmployeeLeaveError(403, "APPROVAL_FORBIDDEN", "Tahap approval ini bukan milik akun Anda."));
    const { pool, clientQueries } = fakePool();
    const app = await buildApp({ pool });
    const response = await decide(app);
    await app.close();

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("APPROVAL_FORBIDDEN");
    expect(assertions.spend).toHaveBeenCalledOnce();
    // The decision rolled back; the spend did not, because it is not in that transaction.
    expect(clientQueries).toContain("ROLLBACK");
  });

  it("answers a replay as the decision that was already made", async () => {
    leave.apply.mockResolvedValue({
      replayed: true,
      payload: { requestId: REQUEST_ID, requestStatus: "approved", stepStatus: "approved", nextPendingStepId: null, hcHandling: "none", hcTaskStatus: null, criticalReviewStatus: null },
    });
    const { pool, audits } = fakePool();
    const app = await buildApp({ pool });
    const response = await decide(app);
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(audits.at(-1)).toMatchObject({ eventType: "governance.decision.served", reasonCode: "REPLAY" });
  });

  it("refuses a body without a requestId, and an unknown decision", async () => {
    const app = await buildApp({ pool: fakePool().pool });
    expect((await decide(app, { requestId: undefined })).statusCode).toBe(400);
    expect((await decide(app, { decision: "maybe" })).statusCode).toBe(400);
    await app.close();
    expect(leave.apply).not.toHaveBeenCalled();
    expect(assertions.spend).not.toHaveBeenCalled();
  });

  it("refuses an employee account: a salaried Pengurus decides with a session", async () => {
    const { pool, audits } = fakePool();
    const app = await buildApp({ pool, account: { principalType: "EMPLOYEE", employeeId: "00000000-0000-4000-8000-0000000000ee" } });
    const response = await decide(app);
    await app.close();

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("NOT_FOUNDATION_BOARD");
    expect(assertions.spend).not.toHaveBeenCalled();
    expect(audits.at(-1)).toMatchObject({ eventType: "governance.decision.denied" });
  });

  it("refuses a request with no bearer token, and one carrying two Authorization headers", async () => {
    const app = await buildApp({ pool: fakePool().pool });
    const missing = await app.inject({
      method: "POST", url: `/governance/decisions/${STEP_ID}`,
      payload: { decision: "approve", requestId: ACTION_ID },
    });
    // Two headers: one of them could be a token the caller is not supposed to hold, and
    // which header a proxy keeps is not ours to decide. Neither is read.
    const doubled = await app.inject({
      method: "POST", url: `/governance/decisions/${STEP_ID}`,
      headers: { authorization: ["Bearer first", "Bearer second"] as unknown as string },
      payload: { decision: "approve", requestId: ACTION_ID },
    });
    await app.close();
    expect(missing.statusCode).toBe(401);
    expect(missing.json().code).toBe("UNAUTHENTICATED");
    expect(doubled.statusCode).toBe(401);
    expect(doubled.json().code).toBe("UNAUTHENTICATED");
    expect(assertions.spend).not.toHaveBeenCalled();
  });

  it("does not register either route while the flag is off", async () => {
    const app = await buildApp({ pool: fakePool().pool, enabled: false });
    const post = await decide(app);
    const get = await app.inject({ method: "GET", url: "/governance/decisions", headers: { authorization: "Bearer x" } });
    await app.close();
    expect(post.statusCode).toBe(404);
    expect(get.statusCode).toBe(404);
  });
});

describe("ORG-015-3 GET /governance/decisions", () => {
  beforeEach(() => {
    leave.capability.mockReset();
    leave.capability.mockResolvedValue(undefined);
    assertions.spend.mockReset();
    assertions.spend.mockResolvedValue(undefined);
  });

  const step = {
    stepId: STEP_ID,
    requestId: REQUEST_ID,
    policyKey: "annual",
    requesterName: "Pegawai Sintetis",
    requesterPosition: "Direktur",
    requesterUnit: "Unit Alfa",
    startOn: "2026-12-01",
    endOn: "2026-12-03",
    workingDays: 3,
    reason: "Keperluan keluarga",
    submittedAt: new Date("2026-11-17T02:00:00Z"),
  };

  async function list(input: Parameters<typeof buildApp>[0]) {
    const app = await buildApp(input);
    const response = await app.inject({
      method: "GET", url: "/governance/decisions", headers: { authorization: "Bearer synthetic-token" },
    });
    await app.close();
    return response;
  }

  it("returns the caller's pending steps with the requester and the step history by role", async () => {
    const { pool } = fakePool({
      steps: [step],
      history: [
        { requestId: REQUEST_ID, order: 1, status: "approved", decidedAt: new Date("2026-11-17T03:00:00Z"), sources: ["DIRECT_MANAGER"] },
        { requestId: REQUEST_ID, order: 2, status: "pending", decidedAt: null, sources: ["GOVERNANCE_APPROVER"] },
      ],
    });
    const response = await list({ pool });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    const item = response.json().items[0];
    expect(item).toMatchObject({
      stepId: STEP_ID,
      kind: "annual",
      requester: { name: "Pegawai Sintetis", positionLabel: "Direktur", unitName: "Unit Alfa" },
      period: { startOn: "2026-12-01", endOn: "2026-12-03", workingDays: 3 },
      reason: "Keperluan keluarga",
    });
    expect(item.history).toEqual([
      { order: 1, status: "approved", decidedAt: "2026-11-17T03:00:00.000Z", approverRole: "Atasan langsung" },
      { order: 2, status: "pending", decidedAt: null, approverRole: "Organ Yayasan" },
    ]);
    // ORG-013-3: no other approver's note, and no approver named anywhere.
    expect(JSON.stringify(item)).not.toContain("decisionNote");
    expect(JSON.stringify(item.history)).not.toContain("Pegawai");
  });

  it("spends the token the list was read with, so it can never decide afterwards", async () => {
    assertions.spend.mockReset();
    assertions.spend.mockResolvedValue(undefined);
    const response = await list({ pool: fakePool({ steps: [step] }).pool });
    expect(response.statusCode).toBe(200);
    expect(assertions.spend).toHaveBeenCalledOnce();
    expect(assertions.spend.mock.calls[0]![2]).toMatchObject({ method: "GET", path: "/governance/decisions" });
  });

  it("refuses a list token that was already spent", async () => {
    assertions.spend.mockReset();
    assertions.spend.mockRejectedValue(new ActorAssertionError("ACTOR_ASSERTION_SPENT", "already used"));
    const { pool, audits } = fakePool({ steps: [step] });
    const response = await list({ pool });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("DECISION_TOKEN_SPENT");
    expect(leave.capability).not.toHaveBeenCalled();
    expect(audits.at(-1)).toMatchObject({ eventType: "governance.decision.denied", reasonCode: "DECISION_TOKEN_SPENT" });
  });

  it("answers an empty list rather than a refusal when nothing is waiting", async () => {
    const response = await list({ pool: fakePool().pool });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([]);
  });

  it("refuses a caller whose governance capability has lapsed", async () => {
    leave.capability.mockRejectedValue(new EmployeeLeaveError(403, "APPROVAL_FORBIDDEN", "Capability governance approval tidak tersedia."));
    const { pool, audits } = fakePool({ steps: [step] });
    const response = await list({ pool });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("APPROVAL_FORBIDDEN");
    expect(audits.at(-1)).toMatchObject({ eventType: "governance.decision.denied", reasonCode: "APPROVAL_FORBIDDEN" });
  });

  it("refuses when SQ Hub no longer grants Application Access", async () => {
    const response = await list({ pool: fakePool().pool, accessAllowed: false });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("HCIS_ACCESS_DENIED");
  });
});
