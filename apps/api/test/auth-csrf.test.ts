import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { ApiConfig } from "../src/config/env.js";
import { isCrossSiteMutation, publicOrigin } from "../src/modules/auth/csrf.js";
import { oidcStateCookieName } from "../src/modules/auth/service.js";

// SEC-REV-2026-10-16 SEC-06 (cross-site mutations) and the SEC-05 cookie name.
const ORIGIN = "https://hcis.example.invalid";

describe("SEC-06 isCrossSiteMutation", () => {
  it.each([
    ["same-origin page", "POST", { "sec-fetch-site": "same-origin" }, false],
    ["user-typed navigation", "POST", { "sec-fetch-site": "none" }, false],
    ["sibling SQ Core app", "POST", { "sec-fetch-site": "same-site" }, true],
    ["foreign site", "DELETE", { "sec-fetch-site": "cross-site" }, true],
    ["foreign site, safe method", "GET", { "sec-fetch-site": "cross-site" }, false],
    ["older browser, own origin", "PATCH", { origin: ORIGIN }, false],
    ["older browser, other origin", "PUT", { origin: "https://hub.example.invalid" }, true],
    ["sandboxed page", "POST", { origin: "null" }, true],
    ["machine client or script", "POST", {}, false],
  ])("%s", (_label, method, headers, rejected) => {
    expect(isCrossSiteMutation(method, "/leave/me/annual/submit", headers, ORIGIN)).toBe(rejected);
  });

  it("never blocks device ingress", () => {
    expect(isCrossSiteMutation("POST", "/iclock/cdata?SN=X", { "sec-fetch-site": "cross-site" }, ORIGIN)).toBe(false);
  });

  it("falls back to Sec-Fetch-Site only when the public origin is unknown (local mode)", () => {
    expect(isCrossSiteMutation("POST", "/auth/login", { origin: "https://other.invalid" }, null)).toBe(false);
    expect(isCrossSiteMutation("POST", "/auth/login", { "sec-fetch-site": "cross-site" }, null)).toBe(true);
  });

  it("takes the public origin from the OIDC callback URL", () => {
    expect(publicOrigin({ AUTH_MODE: "oidc", OIDC_REDIRECT_URI: `${ORIGIN}/auth/callback` })).toBe(ORIGIN);
    expect(publicOrigin({ AUTH_MODE: "local", OIDC_REDIRECT_URI: undefined })).toBeNull();
  });
});

describe("SEC-06 onRequest hook", () => {
  it("answers 403 before any route runs and lets same-origin requests through", async () => {
    const app = await createApp({
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: 3001,
      DATABASE_URL: "postgres://synthetic@127.0.0.1:1/unused",
      AUTH_MODE: "local",
      AUTH_ENCRYPTION_KEY: "11".repeat(32),
      AUTH_SESSION_TTL_HOURS: 8,
    } as ApiConfig, {} as Pool);

    const rejected = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { "sec-fetch-site": "same-site", cookie: "hcis_session=synthetic" },
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json()).toEqual({
      code: "CROSS_SITE_REQUEST_REJECTED",
      message: "Permintaan ditolak karena tidak berasal dari aplikasi HCIS.",
    });

    const allowed = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "sec-fetch-site": "same-origin" },
      payload: {},
    });
    expect(allowed.statusCode).toBe(400);
    await app.close();
  });
});

describe("SEC-05 state cookie name", () => {
  it("uses the __Host- prefix whenever cookies are Secure", () => {
    const hash = "ab".repeat(32);
    expect(oidcStateCookieName(hash, true)).toBe(`__Host-hcis_oidc_state_${"ab".repeat(16)}`);
    expect(oidcStateCookieName(hash, false)).toBe(`hcis_oidc_state_${"ab".repeat(16)}`);
  });
});
