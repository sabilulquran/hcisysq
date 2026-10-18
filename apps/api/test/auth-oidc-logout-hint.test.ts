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
import { OidcProvider } from "../src/modules/auth/oidc-provider.js";
import { registerAuthRoutes } from "../src/modules/auth/routes.js";
import { readOidcIdTokenCookie } from "../src/modules/auth/service.js";

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

const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;
const syntheticIdToken = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c2lnbmF0dXJl";

async function logout(cookie?: string) {
  const app = Fastify({ logger: false });
  await registerAuthRoutes(app, pool, config);
  const response = await app.inject({
    method: "POST",
    url: "/auth/logout",
    headers: cookie ? { cookie } : {},
  });
  await app.close();
  return response;
}

afterEach(() => vi.clearAllMocks());

describe("OIDC logout id_token_hint", () => {
  it("sends the session ID token as id_token_hint so Akun SQ skips its confirmation page", async () => {
    const response = await logout(
      `hcis_session=opaque; hcis_oidc_id_token=${syntheticIdToken}`,
    );

    expect(response.statusCode).toBe(200);
    const logoutUrl = new URL(response.json().logoutUrl);
    expect(logoutUrl.origin + logoutUrl.pathname).toBe(`${ISSUER}/protocol/openid-connect/logout`);
    expect(logoutUrl.searchParams.get("id_token_hint")).toBe(syntheticIdToken);
    expect(logoutUrl.searchParams.get("client_id")).toBe("hcis-staging");
    expect(logoutUrl.searchParams.get("post_logout_redirect_uri")).toBe(
      "https://hcis-staging.sabilulquran.or.id/",
    );
  });

  it("clears both the session and the ID token cookies on logout", async () => {
    const response = await logout(`hcis_oidc_id_token=${syntheticIdToken}`);
    const setCookie = response.headers["set-cookie"];
    const cookies = Array.isArray(setCookie) ? setCookie : [String(setCookie)];

    expect(cookies.some((value) => value.startsWith("hcis_session=;") && value.includes("Max-Age=0"))).toBe(true);
    expect(
      cookies.some(
        (value) =>
          value.startsWith("hcis_oidc_id_token=;") &&
          value.includes("HttpOnly") &&
          value.includes("Max-Age=0"),
      ),
    ).toBe(true);
  });

  it("falls back to the confirmation flow when no ID token is held", async () => {
    const response = await logout();
    const logoutUrl = new URL(response.json().logoutUrl);

    expect(logoutUrl.searchParams.has("id_token_hint")).toBe(false);
    expect(logoutUrl.searchParams.get("client_id")).toBe("hcis-staging");
  });

  it("ignores a cookie value that is not a compact JWS", async () => {
    expect(readOidcIdTokenCookie("hcis_oidc_id_token=not-a-token")).toBeNull();
    expect(readOidcIdTokenCookie("hcis_oidc_id_token=a.b.c%0d%0aX")).toBeNull();
    expect(readOidcIdTokenCookie(`hcis_oidc_id_token=${syntheticIdToken}`)).toBe(syntheticIdToken);

    const response = await logout("hcis_oidc_id_token=not-a-token");
    expect(new URL(response.json().logoutUrl).searchParams.has("id_token_hint")).toBe(false);
  });

  it("builds the provider logout URL with and without a hint", async () => {
    const provider = new OidcProvider({
      issuer: ISSUER,
      clientId: "hcis-staging",
      clientSecret: "synthetic-secret",
      redirectUri: "https://hcis-staging.sabilulquran.or.id/auth/callback",
      postLogoutRedirectUri: "https://hcis-staging.sabilulquran.or.id/",
    });

    expect((await provider.buildLogoutUrl(syntheticIdToken)).searchParams.get("id_token_hint")).toBe(
      syntheticIdToken,
    );
    expect((await provider.buildLogoutUrl()).searchParams.has("id_token_hint")).toBe(false);
  });
});
