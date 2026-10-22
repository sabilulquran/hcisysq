import Fastify from "fastify";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

const ISSUER = "https://login.example.test/realms/sq-staff";

vi.mock("openid-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openid-client")>();
  return {
    ...actual,
    discovery: vi.fn(
      async () =>
        new actual.Configuration(
          { issuer: ISSUER, token_endpoint: `${ISSUER}/protocol/openid-connect/token` },
          "hcis-api",
          "synthetic-machine-secret",
        ),
    ),
    clientCredentialsGrant: vi.fn(async () => ({ access_token: "synthetic-machine-token" })),
  };
});

import type { ApiConfig } from "../src/config/env.js";
import { getOidcRuntimeConfig } from "../src/config/env.js";
import { ApplicationAccessError, SqHubApplicationAccessClient } from "../src/modules/auth/application-access.js";
import {
  deriveLauncherUrl,
  LAUNCHER_CACHE_TTL_MS,
  LAUNCHER_FAILURE_TTL_MS,
  LauncherService,
  type LauncherSource,
} from "../src/modules/auth/launcher.js";
import { registerAuthRoutes } from "../src/modules/auth/routes.js";

const ACCESS_CHECK_URL = "https://hub.example.test/internal/v1/application-access/check";
const LAUNCHER_URL = "https://hub.example.test/internal/v1/application-access/launcher";
const IDENTITY = { issuer: ISSUER, subject: "synthetic-subject" };
const APPS = [
  { key: "aset-sq", name: "Aset SQ", canonicalUrl: "https://aset.example.test" },
  { key: "hcis", name: "HCIS", canonicalUrl: "https://hcis.example.test" },
];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("AUTH-013 launcher URL", () => {
  it("derives the launcher endpoint next to the configured access check", () => {
    expect(deriveLauncherUrl(ACCESS_CHECK_URL)).toBe(LAUNCHER_URL);
    expect(deriveLauncherUrl("http://127.0.0.1:3100/internal/v1/application-access/check")).toBe(
      "http://127.0.0.1:3100/internal/v1/application-access/launcher",
    );
  });

  it("prefers an explicit override and refuses to guess for an unexpected path", () => {
    expect(deriveLauncherUrl(ACCESS_CHECK_URL, "https://hub.example.test/custom")).toBe("https://hub.example.test/custom");
    expect(deriveLauncherUrl("https://hub.example.test/access")).toBeNull();
  });
});

describe("AUTH-013 SQ Hub launcher client", () => {
  it("posts only issuer and subject with the machine token and returns the validated list", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ applications: [...APPS, { key: "x", name: "X", canonicalUrl: "https://x.example.test", extra: 1 }] }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new SqHubApplicationAccessClient(ISSUER, "hcis-api", "synthetic-machine-secret", ACCESS_CHECK_URL);
    const applications = await client.listLauncherApplications({ ...IDENTITY, idToken: "synthetic.id.token" } as never);

    expect(applications).toEqual([...APPS, { key: "x", name: "X", canonicalUrl: "https://x.example.test" }]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(LAUNCHER_URL);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer synthetic-machine-token");
    expect(JSON.parse(init.body as string)).toEqual({ identity: IDENTITY });
    expect(init.body as string).not.toContain("synthetic.id.token");
  });

  it.each([
    ["an HTTP error", () => jsonResponse({ code: "FORBIDDEN_CLIENT" }, 403)],
    ["a malformed body", () => jsonResponse({ apps: [] })],
    ["a script link", () => jsonResponse({ applications: [{ key: "bad", name: "Bad", canonicalUrl: "javascript:alert(1)" }] })],
  ])("rejects %s as ApplicationAccessError", async (_label, respond) => {
    vi.stubGlobal("fetch", vi.fn(async () => respond()));
    const client = new SqHubApplicationAccessClient(ISSUER, "hcis-api", "synthetic-machine-secret", ACCESS_CHECK_URL);
    await expect(client.listLauncherApplications(IDENTITY)).rejects.toBeInstanceOf(ApplicationAccessError);
  });

  it("does not call SQ Hub when no launcher URL can be derived", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new SqHubApplicationAccessClient(ISSUER, "hcis-api", "secret", "https://hub.example.test/access", null);
    await expect(client.listLauncherApplications(IDENTITY)).rejects.toBeInstanceOf(ApplicationAccessError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("AUTH-013 launcher cache", () => {
  function setup(list: LauncherSource["listLauncherApplications"]) {
    let now = 1_000_000;
    const source = { listLauncherApplications: vi.fn(list) };
    const service = new LauncherService(source, () => now);
    return { service, source, advance: (ms: number) => { now += ms; } };
  }

  it("keeps a session's list for 5 minutes and loads the identity only on a miss", async () => {
    const { service, source, advance } = setup(async () => APPS);
    const loadIdentity = vi.fn(async () => IDENTITY);

    expect(await service.get("session-a", loadIdentity)).toEqual({ applications: APPS });
    advance(LAUNCHER_CACHE_TTL_MS - 1);
    expect(await service.get("session-a", loadIdentity)).toEqual({ applications: APPS });
    expect(source.listLauncherApplications).toHaveBeenCalledTimes(1);
    expect(loadIdentity).toHaveBeenCalledTimes(1);

    advance(1);
    await service.get("session-a", loadIdentity);
    expect(source.listLauncherApplications).toHaveBeenCalledTimes(2);
  });

  it("never shares a list between sessions", async () => {
    const { service, source } = setup(async () => APPS);
    await service.get("session-a", async () => IDENTITY);
    await service.get("session-b", async () => ({ issuer: ISSUER, subject: "other" }));
    expect(source.listLauncherApplications).toHaveBeenCalledTimes(2);
    expect(source.listLauncherApplications).toHaveBeenLastCalledWith({ issuer: ISSUER, subject: "other" });
  });

  it("reports unavailable on a SQ Hub failure and retries after the short failure window", async () => {
    const { service, source, advance } = setup(async () => {
      throw new ApplicationAccessError("synthetic outage");
    });
    expect(await service.get("session-a", async () => IDENTITY)).toEqual({ applications: null, unavailable: true });
    advance(LAUNCHER_FAILURE_TTL_MS - 1);
    await service.get("session-a", async () => IDENTITY);
    expect(source.listLauncherApplications).toHaveBeenCalledTimes(1);
    advance(1);
    await service.get("session-a", async () => IDENTITY);
    expect(source.listLauncherApplications).toHaveBeenCalledTimes(2);
  });

  it("reports unavailable without calling SQ Hub when the account has no stored identity", async () => {
    const { service, source } = setup(async () => APPS);
    expect(await service.get("session-a", async () => null)).toEqual({ applications: null, unavailable: true });
    expect(source.listLauncherApplications).not.toHaveBeenCalled();
  });

  it("is always unavailable without a source (local mode)", async () => {
    const service = new LauncherService(null);
    const loadIdentity = vi.fn(async () => IDENTITY);
    expect(await service.get("session-a", loadIdentity)).toEqual({ applications: null, unavailable: true });
    expect(loadIdentity).not.toHaveBeenCalled();
  });
});

const oidcConfig: ApiConfig = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://unused",
  AUTH_MODE: "oidc",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
  OIDC_ISSUER: ISSUER,
  OIDC_CLIENT_ID: "hcis",
  OIDC_CLIENT_SECRET: "synthetic-secret",
  OIDC_REDIRECT_URI: "https://hcis.example.test/auth/callback",
  OIDC_POST_LOGOUT_REDIRECT_URI: "https://hcis.example.test/",
  SQ_HUB_APPLICATION_ACCESS_URL: ACCESS_CHECK_URL,
  SQ_HUB_MACHINE_CLIENT_ID: "hcis-api",
  SQ_HUB_MACHINE_CLIENT_SECRET: "synthetic-machine-secret",
};

function sessionPool(options: { session: boolean; identity?: { issuer: string | null; subject: string | null } }) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes("FROM auth_sessions s")) {
        return options.session
          ? { rows: [{ sessionId: "s-1", accountId: "a-1", email: "staf@example.test", principalType: "employee", expiresAt: new Date(Date.now() + 3_600_000) }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (sql.includes("identity_issuer AS issuer")) {
        return { rows: options.identity ? [options.identity] : [], rowCount: options.identity ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  return { pool, queries };
}

async function getLauncher(config: ApiConfig, pool: Pool, cookie?: string) {
  const app = Fastify({ logger: false });
  await registerAuthRoutes(app, pool, config);
  const response = await app.inject({ method: "GET", url: "/auth/launcher", headers: cookie ? { cookie } : {} });
  await app.close();
  return response;
}

describe("AUTH-013 GET /auth/launcher", () => {
  it("requires an HCIS session", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { pool } = sessionPool({ session: false });
    const response = await getLauncher(oidcConfig, pool, "hcis_session=expired");
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "UNAUTHENTICATED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the SQ Hub list for the session's stored identity, never a token", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ applications: APPS }));
    vi.stubGlobal("fetch", fetchMock);
    const { pool, queries } = sessionPool({ session: true, identity: IDENTITY });

    const response = await getLauncher(oidcConfig, pool, "hcis_session=opaque-session-token");

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ applications: APPS });
    expect(response.body).not.toContain("synthetic-machine-token");
    expect(queries.find((query) => query.sql.includes("identity_issuer AS issuer"))?.params).toEqual(["a-1"]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(getOidcRuntimeConfig(oidcConfig).applicationLauncherUrl);
    expect(JSON.parse(init.body as string)).toEqual({ identity: IDENTITY });
  });

  it("falls back to unavailable when SQ Hub fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: "INTERNAL" }, 500)));
    const { pool } = sessionPool({ session: true, identity: IDENTITY });
    const response = await getLauncher(oidcConfig, pool, "hcis_session=opaque-session-token");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ applications: null, unavailable: true });
  });

  it("stays unavailable in local mode without calling SQ Hub", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { pool } = sessionPool({ session: true, identity: IDENTITY });
    const localConfig = { ...oidcConfig, AUTH_MODE: "local" } as ApiConfig;
    const response = await getLauncher(localConfig, pool, "hcis_session=opaque-session-token");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ applications: null, unavailable: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
