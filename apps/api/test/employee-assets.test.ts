// ASSET-001: the Aset SQ adapter, Asset Saya, and the Termination asset warning.
// Fake pool and fake auth; synthetic employees and assets only.

import Fastify from "fastify";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

const ISSUER = "https://login.example.test/realms/sq-staff";
const grant = vi.fn(async () => ({ access_token: "synthetic-aset-token", expires_in: 300 }));

vi.mock("openid-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openid-client")>();
  return {
    ...actual,
    discovery: vi.fn(
      async () =>
        new actual.Configuration(
          { issuer: ISSUER, token_endpoint: `${ISSUER}/protocol/openid-connect/token` },
          "hcis-aset-custody",
          "synthetic-secret",
        ),
    ),
    clientCredentialsGrant: (...args: unknown[]) => grant(...(args as [])),
  };
});

const { loadConfig } = await import("../src/config/env.js");
const {
  AsetSqPersonCustodyClient,
  PersonCustodyUnavailableError,
} = await import("../src/modules/employee-assets/aset-sq-client.js");
const { registerEmployeeAssetRoutes } = await import("../src/modules/employee-assets/routes.js");
type PersonCustodyReader = import("../src/modules/employee-assets/aset-sq-client.js").PersonCustodyReader;

const EMPLOYEE_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_ID = "10000000-0000-4000-8000-000000000002";
const BASE_URL = "http://127.0.0.1:3093";

function custody(personRef = `hcis:employee:${EMPLOYEE_ID}`) {
  return {
    personRef,
    generatedAt: "2026-11-02T03:00:00.000Z",
    clearance: "OUTSTANDING",
    counts: { outstanding: 1, pendingAcceptance: 0, overdue: 1 },
    assignments: [
      {
        assignmentId: "20000000-0000-4000-8000-000000000001",
        assetTag: "SQ-LTP-0012",
        assetLabel: "Lenovo ThinkPad E14",
        custodyState: "ACTIVE",
        checkoutAt: "2026-09-01T02:00:00.000Z",
        expectedReturnOn: "2026-10-31",
        overdue: true,
      },
    ],
    truncated: false,
    selfServiceUrl: "https://aset.example.test/my-assets",
  };
}

function withoutPersonRef(body: ReturnType<typeof custody>) {
  const copy: Partial<ReturnType<typeof custody>> = { ...body };
  delete copy.personRef;
  return copy;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("Aset SQ person custody adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    grant.mockClear();
  });

  it("asks for the namespaced person, with the machine token, and drops nothing but personRef", async () => {
    const fetchMock = vi.fn(async () => json(custody()));
    vi.stubGlobal("fetch", fetchMock);
    const client = new AsetSqPersonCustodyClient(ISSUER, "hcis-aset-custody", "synthetic-secret", `${BASE_URL}/`);

    const result = await client.read(EMPLOYEE_ID);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/internal/v1/person-custody/hcis%3Aemployee%3A${EMPLOYEE_ID}`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer synthetic-aset-token");
    expect(result.counts).toEqual({ outstanding: 1, pendingAcceptance: 0, overdue: 1 });
    expect(result).not.toHaveProperty("personRef");
  });

  it("reuses the machine token until shortly before it expires", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(custody())));
    let now = 1_000_000;
    const client = new AsetSqPersonCustodyClient(ISSUER, "hcis-aset-custody", "synthetic-secret", BASE_URL, () => now);
    await client.read(EMPLOYEE_ID);
    now += 200_000;
    await client.read(EMPLOYEE_ID);
    expect(grant).toHaveBeenCalledTimes(1);
    now += 80_000; // 280 s into a 300 s token: inside the 30 s early-refresh window.
    await client.read(EMPLOYEE_ID);
    expect(grant).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["an HTTP error", () => json({ error: { code: "TOKEN_AZP" } }, 401), "HTTP_ERROR"],
    ["a network failure", () => { throw new TypeError("fetch failed"); }, "UNREACHABLE"],
    ["an answer with extra fields", () => json({ ...custody(), purchaseCost: "1" }), "INVALID_RESPONSE"],
    ["an answer about someone else", () => json(custody(`hcis:employee:${OTHER_ID}`)), "INVALID_RESPONSE"],
    ["a script link", () => json({ ...custody(), selfServiceUrl: "javascript:alert(1)" }), "INVALID_RESPONSE"],
  ])("treats %s as unavailable", async (_label, respond, failure) => {
    vi.stubGlobal("fetch", vi.fn(async () => respond()));
    const client = new AsetSqPersonCustodyClient(ISSUER, "hcis-aset-custody", "synthetic-secret", BASE_URL);
    await expect(client.read(EMPLOYEE_ID)).rejects.toMatchObject({ name: "PersonCustodyUnavailableError", failure });
  });

  it("reports a token failure without calling Aset SQ", async () => {
    grant.mockRejectedValueOnce(new Error("invalid_client"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new AsetSqPersonCustodyClient(ISSUER, "hcis-aset-custody", "synthetic-secret", BASE_URL);
    await expect(client.read(EMPLOYEE_ID)).rejects.toMatchObject({ failure: "TOKEN_FAILED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://employee-assets-test",
  AUTH_MODE: "local" as const,
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
} as Parameters<typeof registerEmployeeAssetRoutes>[2];

type Persona = "anonymous" | "employee" | "unlinked" | "super_admin" | "hc" | "reader";

const PERMISSIONS: Record<Persona, string[]> = {
  anonymous: [],
  employee: [],
  unlinked: [],
  super_admin: [],
  hc: ["employment.read", "employment.manage"],
  reader: ["employees.read.all", "employment.read"],
};

function fakeAuth(persona: Persona) {
  return {
    getSession: vi.fn(async () =>
      persona === "anonymous"
        ? null
        : {
          sessionId: "00000000-0000-4000-8000-000000000100",
          principal: {
            id: "00000000-0000-4000-8000-000000000001",
            email: "persona@example.org",
            principalType: persona === "super_admin" ? "SUPER_ADMIN" : "EMPLOYEE",
          },
        }),
    getAuthorizationContext: vi.fn(async () => ({ organizationPermissions: PERMISSIONS[persona] })),
  } as never;
}

function fakePool(persona: Persona, options: { employeeMissing?: boolean } = {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM accounts account")) {
      return persona === "unlinked" ? { rows: [], rowCount: 0 } : { rows: [{ employeeId: EMPLOYEE_ID }], rowCount: 1 };
    }
    if (sql.includes("SELECT id FROM employees")) {
      return options.employeeMissing ? { rows: [], rowCount: 0 } : { rows: [{ id: OTHER_ID }], rowCount: 1 };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  return { query } as unknown as Pool;
}

async function buildApp(persona: Persona, reader: PersonCustodyReader | null, options: { employeeMissing?: boolean } = {}) {
  const app = Fastify();
  await registerEmployeeAssetRoutes(app, fakePool(persona, options), config, { reader, auth: fakeAuth(persona) });
  return app;
}

function readerReturning(result: () => Promise<unknown>) {
  const read = vi.fn((employeeId: string) => { void employeeId; return result(); });
  return { reader: { read } as unknown as PersonCustodyReader, read };
}

const cookie = { cookie: "hcis_session=test-token" };

describe("GET /assets/me", () => {
  it("needs a session", async () => {
    const app = await buildApp("anonymous", null);
    const response = await app.inject({ method: "GET", url: "/assets/me" });
    expect(response.statusCode).toBe(401);
  });

  it("refuses an account that is not linked to an employee", async () => {
    for (const persona of ["unlinked", "super_admin"] as const) {
      const app = await buildApp(persona, readerReturning(async () => ({})).reader);
      const response = await app.inject({ method: "GET", url: "/assets/me", headers: cookie });
      expect(response.statusCode, persona).toBe(404);
      expect(response.json().code).toBe("EMPLOYEE_NOT_LINKED");
    }
  });

  it("reads the session's own employee and returns the holdings", async () => {
    const { reader, read } = readerReturning(async () => {
      return withoutPersonRef(custody());
    });
    const app = await buildApp("employee", reader);
    const response = await app.inject({ method: "GET", url: `/assets/me?employeeId=${OTHER_ID}`, headers: cookie });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(read).toHaveBeenCalledWith(EMPLOYEE_ID);
    expect(response.json()).toMatchObject({ status: "AVAILABLE", clearance: "OUTSTANDING", counts: { outstanding: 1 } });
  });

  it("says NOT_CONFIGURED, with the Aset SQ link, before the machine client exists", async () => {
    const app = await buildApp("employee", null);
    const response = await app.inject({ method: "GET", url: "/assets/me", headers: cookie });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "NOT_CONFIGURED", selfServiceUrl: "https://aset.sabilulquran.or.id/my-assets" });
  });

  it("answers UNAVAILABLE instead of an error when Aset SQ fails", async () => {
    const app = await buildApp("employee", readerReturning(async () => {
      throw new PersonCustodyUnavailableError("HTTP_ERROR", 503);
    }).reader);
    const response = await app.inject({ method: "GET", url: "/assets/me", headers: cookie });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("UNAVAILABLE");
  });
});

describe("GET /admin/employees/:employeeId/assets", () => {
  it("requires employment.manage", async () => {
    for (const persona of ["employee", "reader", "super_admin"] as const) {
      const { reader, read } = readerReturning(async () => ({}));
      const app = await buildApp(persona, reader);
      const response = await app.inject({ method: "GET", url: `/admin/employees/${OTHER_ID}/assets`, headers: cookie });
      expect(response.statusCode, persona).toBe(403);
      expect(read).not.toHaveBeenCalled();
    }
  });

  it("refuses an unknown or removed employee and a malformed id", async () => {
    const app = await buildApp("hc", readerReturning(async () => ({})).reader, { employeeMissing: true });
    expect((await app.inject({ method: "GET", url: `/admin/employees/${OTHER_ID}/assets`, headers: cookie })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/admin/employees/not-a-uuid/assets", headers: cookie })).statusCode).toBe(400);
  });

  it("returns the named employee's holdings to HC", async () => {
    const { reader, read } = readerReturning(async () => {
      return withoutPersonRef(custody(`hcis:employee:${OTHER_ID}`));
    });
    const app = await buildApp("hc", reader);
    const response = await app.inject({ method: "GET", url: `/admin/employees/${OTHER_ID}/assets`, headers: cookie });
    expect(response.statusCode).toBe(200);
    expect(read).toHaveBeenCalledWith(OTHER_ID);
    expect(response.json().status).toBe("AVAILABLE");
  });
});

describe("ASSET-001 configuration", () => {
  const oidcEnv = {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://x",
    AUTH_MODE: "oidc",
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: "hcis",
    OIDC_CLIENT_SECRET: "s",
    OIDC_REDIRECT_URI: "https://hcis.example.test/auth/callback",
    OIDC_POST_LOGOUT_REDIRECT_URI: "https://hcis.example.test/",
    SQ_HUB_APPLICATION_ACCESS_URL: "https://hub.example.test/internal/v1/application-access/check",
    SQ_HUB_MACHINE_CLIENT_ID: "hcis-hub-machine",
    SQ_HUB_MACHINE_CLIENT_SECRET: "s",
  };
  const aset = {
    ASET_SQ_PERSON_CUSTODY_URL: BASE_URL,
    ASET_SQ_MACHINE_CLIENT_ID: "hcis-aset-custody",
    ASET_SQ_MACHINE_CLIENT_SECRET: "s",
  };

  it("accepts the full set and an absent set", () => {
    expect(loadConfig({ ...oidcEnv, ...aset }).ASET_SQ_MACHINE_CLIENT_ID).toBe("hcis-aset-custody");
    expect(loadConfig(oidcEnv).ASET_SQ_MACHINE_CLIENT_ID).toBeUndefined();
  });

  it("refuses a partial set, local login, and a reused client", () => {
    expect(() => loadConfig({ ...oidcEnv, ASET_SQ_PERSON_CUSTODY_URL: BASE_URL })).toThrow(/ASET_SQ_MACHINE_CLIENT_ID/);
    expect(() => loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgres://x", AUTH_MODE: "local", ...aset })).toThrow(/AUTH_MODE=oidc/);
    for (const reused of ["hcis-hub-machine", "hcis", "sq-hub-identity-management"]) {
      expect(() => loadConfig({ ...oidcEnv, ...aset, ASET_SQ_MACHINE_CLIENT_ID: reused }), reused).toThrow(/dedicated client/);
    }
  });
});
