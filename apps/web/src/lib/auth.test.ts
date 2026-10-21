import { describe, expect, it } from "vitest";

import {
  isSafeReturnTo,
  loginSearch,
  oidcLoginFailureMessage,
  oidcStartHref,
  shouldStartOidcAutomatically,
} from "@/lib/auth";

describe("OIDC login failure copy", () => {
  it("distinguishes application access outcomes from technical identity failure", () => {
    expect(oidcLoginFailureMessage("access_denied")).toContain("belum memiliki akses ke HCIS");
    expect(oidcLoginFailureMessage("access_unavailable")).toContain("belum dapat memverifikasi hak akses");
    expect(oidcLoginFailureMessage("account_inactive")).toContain("sedang tidak aktif");
    expect(oidcLoginFailureMessage("oidc_failed")).toBe(
      "Masuk dengan Akun SQ belum berhasil. Silakan coba lagi.",
    );
  });

  it("does not render arbitrary query-string values as login errors", () => {
    expect(oidcLoginFailureMessage("OIDC_ACCOUNT_NOT_MAPPED")).toBeNull();
    expect(oidcLoginFailureMessage("token=secret")).toBeNull();
    expect(oidcLoginFailureMessage(null)).toBeNull();
  });
});

describe("AUTH-012 automatic Akun SQ start", () => {
  it("starts automatically only in OIDC mode without a callback failure", () => {
    expect(shouldStartOidcAutomatically("oidc", {})).toBe(true);
    expect(shouldStartOidcAutomatically("oidc", { returnTo: "/app" })).toBe(true);
    expect(shouldStartOidcAutomatically("oidc", { authError: "oidc_failed" })).toBe(false);
    // Any authError value stops the loop, even one the page does not display.
    expect(shouldStartOidcAutomatically("oidc", { authError: "" })).toBe(false);
    expect(shouldStartOidcAutomatically("local", {})).toBe(false);
    expect(shouldStartOidcAutomatically(null, {})).toBe(false);
  });

  it("carries a same-origin returnTo to the start route", () => {
    expect(oidcStartHref("/app/leave?tab=history")).toBe(
      "/api/auth/oidc/start?returnTo=%2Fapp%2Fleave%3Ftab%3Dhistory",
    );
    expect(oidcStartHref("/")).toBe("/api/auth/oidc/start");
    expect(oidcStartHref(undefined)).toBe("/api/auth/oidc/start");
  });

  it.each([
    "//evil.example",
    "/\\evil.example",
    "https://evil.example/",
    "javascript:alert(1)",
    "app",
    "/api/auth/oidc/start",
    "/auth/callback?code=x",
    "/app\r\nx",
  ])("does not forward the unsafe returnTo %s", (value) => {
    expect(isSafeReturnTo(value)).toBe(false);
    expect(oidcStartHref(value)).toBe("/api/auth/oidc/start");
  });

  it("keeps only string search values for the login entry", () => {
    expect(loginSearch({ returnTo: "/app", authError: "oidc_failed", other: "x" })).toEqual({
      returnTo: "/app",
      authError: "oidc_failed",
    });
    expect(loginSearch({ returnTo: 1, authError: ["a"] })).toEqual({});
  });
});
