import { createHash } from "node:crypto";

import Fastify from "fastify";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

const ISSUER = "https://login.sabilulquran.or.id/realms/sq-staff-staging";

vi.mock("openid-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openid-client")>();
  return {
    ...actual,
    discovery: vi.fn(
      async () =>
        new actual.Configuration(
          {
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
            token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
            end_session_endpoint: `${ISSUER}/protocol/openid-connect/logout`,
          },
          "hcis-staging",
          "synthetic-secret",
        ),
    ),
  };
});

import type { ApiConfig } from "../src/config/env.js";
import { OidcLoginService } from "../src/modules/auth/oidc-service.js";
import { safeReturnTo } from "../src/modules/auth/return-to.js";
import { registerAuthRoutes } from "../src/modules/auth/routes.js";

const config: ApiConfig = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://unused",
  AUTH_MODE: "oidc",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
  OIDC_ISSUER: ISSUER,
  OIDC_CLIENT_ID: "hcis-staging",
  OIDC_CLIENT_SECRET: "synthetic-secret",
  OIDC_REDIRECT_URI: "https://hcis-staging.sabilulquran.or.id/auth/callback",
  OIDC_POST_LOGOUT_REDIRECT_URI: "https://hcis-staging.sabilulquran.or.id/",
  SQ_HUB_APPLICATION_ACCESS_URL:
    "https://hub-staging.sabilulquran.or.id/internal/v1/application-access/check",
  SQ_HUB_MACHINE_CLIENT_ID: "hcis-api-staging",
  SQ_HUB_MACHINE_CLIENT_SECRET: "synthetic-machine-secret",
};

async function inject(
  url: string,
  query = vi.fn(async () => ({ rows: [], rowCount: 0 })),
  headers: Record<string, string> = {},
) {
  const app = Fastify({ logger: false });
  await registerAuthRoutes(app, { query } as unknown as Pool, config);
  const response = await app.inject({ method: "GET", url, headers });
  await app.close();
  return { response, query };
}

function storedReturnTo(query: ReturnType<typeof vi.fn>) {
  const insert = query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO auth_oidc_transactions"));
  expect(insert).toBeDefined();
  return (insert?.[1] as unknown[])[3];
}

afterEach(() => vi.restoreAllMocks());

describe("AUTH-012 safe returnTo", () => {
  it.each([
    ["/app", "/app"],
    ["/app/leave?tab=history", "/app/leave?tab=history"],
    ["/admin/attendance/devices#top", "/admin/attendance/devices#top"],
    ["/app/../admin", "/admin"],
  ])("accepts the same-origin path %s", (value, expected) => {
    expect(safeReturnTo(value)).toBe(expected);
  });

  it.each([
    ["protocol-relative", "//evil.example/app"],
    ["backslash host", "/\\evil.example"],
    ["backslash anywhere", "/app\\..\\..\\evil"],
    ["absolute URL", "https://evil.example/app"],
    ["javascript scheme", "javascript:alert(1)"],
    ["relative without slash", "app"],
    ["dot segment that becomes protocol-relative", "/.//evil.example"],
    ["tab inside", "/\t/evil.example"],
    ["newline inside", "/app\r\nSet-Cookie: x=1"],
    ["API path", "/api/auth/oidc/start"],
    ["callback path", "/auth/callback?code=x"],
    ["empty", ""],
    ["too long", `/${"a".repeat(600)}`],
  ])("rejects %s", (_label, value) => {
    expect(safeReturnTo(value)).toBeNull();
  });

  it("rejects non-string values such as a repeated query parameter", () => {
    expect(safeReturnTo(["/app", "/admin"])).toBeNull();
    expect(safeReturnTo(undefined)).toBeNull();
    expect(safeReturnTo(null)).toBeNull();
  });
});

describe("AUTH-012 /auth/oidc/start returnTo", () => {
  it("stores a safe returnTo in the server-side transaction and starts plain Authorization Code + PKCE", async () => {
    const { response, query } = await inject(`/auth/oidc/start?returnTo=${encodeURIComponent("/app/leave?tab=history")}`);

    expect(response.statusCode).toBe(302);
    const location = new URL(String(response.headers.location));
    expect(location.origin + location.pathname).toBe(`${ISSUER}/protocol/openid-connect/auth`);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    // Keycloak already passes through silently when an SSO session exists.
    expect(location.searchParams.has("prompt")).toBe(false);
    // The path never travels to Akun SQ.
    expect(location.search).not.toContain("leave");
    expect(storedReturnTo(query)).toBe("/app/leave?tab=history");
  });

  it.each(["//evil.example", "https://evil.example/", "/\\evil.example"])(
    "drops the unsafe returnTo %s and still starts sign-in",
    async (value) => {
      const { response, query } = await inject(`/auth/oidc/start?returnTo=${encodeURIComponent(value)}`);
      expect(response.statusCode).toBe(302);
      expect(storedReturnTo(query)).toBeNull();
    },
  );

  it("starts without returnTo exactly as before", async () => {
    const { response, query } = await inject("/auth/oidc/start");
    expect(response.statusCode).toBe(302);
    expect(storedReturnTo(query)).toBeNull();
  });
});

describe("AUTH-012 /auth/callback redirect target", () => {
  const success = (returnTo: string | null) => ({
    session: {
      principal: { id: "synthetic-account", email: "staff@example.org", principalType: "EMPLOYEE" as const },
      expiresAt: "2099-01-01T00:00:00Z",
    },
    setCookie: "hcis_session=opaque; HttpOnly",
    idToken: null,
    returnTo,
  });

  it("redirects to the returnTo stored with the transaction", async () => {
    vi.spyOn(OidcLoginService.prototype, "complete").mockResolvedValue(success("/app/leave"));
    const { response } = await inject("/auth/callback?code=opaque&state=state-1");
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/app/leave");
  });

  it("ignores a returnTo in the callback query and falls back to /", async () => {
    vi.spyOn(OidcLoginService.prototype, "complete").mockResolvedValue(success(null));
    const { response } = await inject(
      `/auth/callback?code=opaque&state=state-1&returnTo=${encodeURIComponent("https://evil.example/")}`,
    );
    expect(response.headers.location).toBe("/");
  });

  it("keeps failures on /?authError so the login page does not restart sign-in in a loop", async () => {
    vi.spyOn(OidcLoginService.prototype, "complete").mockRejectedValue(new Error("synthetic"));
    const { response } = await inject("/auth/callback?code=opaque&state=state-1");
    expect(response.headers.location).toBe("/?authError=oidc_failed");
  });
});

describe("SEC-05 login bound to the starting browser", () => {
  const stateHash = (state: string) => createHash("sha256").update(state, "utf8").digest("hex");
  const cookieName = (state: string) => `hcis_oidc_state_${stateHash(state).slice(0, 32)}`;
  const setCookies = (value: string | string[] | undefined) => [value ?? []].flat();

  it("sets a short-lived HttpOnly cookie named by the state hash when sign-in starts", async () => {
    const { response } = await inject("/auth/oidc/start");
    const state = new URL(String(response.headers.location)).searchParams.get("state")!;
    expect(setCookies(response.headers["set-cookie"])).toEqual([
      `${cookieName(state)}=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`,
    ]);
  });

  it("only accepts the state whose cookie this browser holds, and clears that cookie", async () => {
    const complete = vi.spyOn(OidcLoginService.prototype, "complete").mockImplementation(
      async (_url, _context, isBoundToBrowser) => {
        if (!isBoundToBrowser(stateHash("state-1"))) throw new Error("unbound");
        return {
          session: {
            principal: { id: "synthetic-account", email: "staff@example.org", principalType: "EMPLOYEE" as const },
            expiresAt: "2099-01-01T00:00:00Z",
          },
          setCookie: "hcis_session=opaque; HttpOnly",
          idToken: null,
          returnTo: null,
        };
      },
    );
    const clear = `${cookieName("state-1")}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

    const bound = await inject("/auth/callback?code=opaque&state=state-1", undefined, {
      cookie: `${cookieName("state-1")}=1`,
    });
    expect(bound.response.headers.location).toBe("/");
    expect(setCookies(bound.response.headers["set-cookie"])).toContain(clear);

    for (const cookie of [undefined, `${cookieName("state-2")}=1`, `${cookieName("state-1")}=0`]) {
      const unbound = await inject("/auth/callback?code=opaque&state=state-1", undefined, cookie ? { cookie } : {});
      expect(unbound.response.headers.location).toBe("/?authError=oidc_failed");
      expect(setCookies(unbound.response.headers["set-cookie"])).toEqual([clear]);
    }
    expect(complete).toHaveBeenCalledTimes(4);
  });
});

describe("AUTH-012 migration", () => {
  it("adds return_to as a nullable, constrained column so the running release keeps working", async () => {
    const { readFile } = await import("node:fs/promises");
    const sql = await readFile(new URL("../migrations/0060_oidc_transaction_return_to.sql", import.meta.url), "utf8");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS return_to text NULL");
    expect(sql).toContain("left(return_to, 2) <> '//'");
    const statements = sql.replace(/--.*$/gm, "");
    expect(statements).not.toMatch(/\b(DROP|DELETE|UPDATE)\b/i);
  });
});
