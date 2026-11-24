import { describe, expect, it } from "vitest";

import {
  isSafeReturnTo,
  loginSearch,
  oidcLoginFailureMessage,
  oidcStartHref,
  shouldStartOidcAutomatically,
  claimOidcRetry,
  oidcRetryStep,
  isOidcRetryCandidate,
  OIDC_RETRY_STORAGE_KEY,
  OIDC_RETRY_WINDOW_MS,
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

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("AUTH-012 Rev 2 one automatic retry after a callback failure", () => {
  const now = 1_795_485_383_000;

  it("retries only the generic callback failure", () => {
    expect(isOidcRetryCandidate({ authError: "oidc_failed" })).toBe(true);
    expect(isOidcRetryCandidate({ authError: "access_denied" })).toBe(false);
    expect(isOidcRetryCandidate({ authError: "access_unavailable" })).toBe(false);
    expect(isOidcRetryCandidate({ authError: "account_inactive" })).toBe(false);
    expect(isOidcRetryCandidate({ authError: "token=secret" })).toBe(false);
    expect(isOidcRetryCandidate({})).toBe(false);
  });

  it("claims the first retry and records a timestamp only", () => {
    const storage = memoryStorage();
    expect(claimOidcRetry(storage, now)).toBe(true);
    expect([...storage.values.entries()]).toEqual([[OIDC_RETRY_STORAGE_KEY, String(now)]]);
  });

  it("refuses a second retry inside the window so a failing sign-in cannot loop", () => {
    const storage = memoryStorage();
    expect(claimOidcRetry(storage, now)).toBe(true);
    expect(claimOidcRetry(storage, now + 5_000)).toBe(false);
    expect(claimOidcRetry(storage, now + OIDC_RETRY_WINDOW_MS - 1)).toBe(false);
  });

  it("allows a retry again for a later, separate failure", () => {
    const storage = memoryStorage({ [OIDC_RETRY_STORAGE_KEY]: String(now) });
    expect(claimOidcRetry(storage, now + OIDC_RETRY_WINDOW_MS)).toBe(true);
  });

  it("treats a marker from the future as recent", () => {
    const storage = memoryStorage({ [OIDC_RETRY_STORAGE_KEY]: String(now + 60_000) });
    expect(claimOidcRetry(storage, now)).toBe(false);
  });

  it("replaces an unreadable marker", () => {
    const storage = memoryStorage({ [OIDC_RETRY_STORAGE_KEY]: "garbage" });
    expect(claimOidcRetry(storage, now)).toBe(true);
    expect(storage.values.get(OIDC_RETRY_STORAGE_KEY)).toBe(String(now));
  });

  it("never retries without a working storage", () => {
    expect(claimOidcRetry(undefined, now)).toBe(false);
    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => undefined,
    };
    expect(claimOidcRetry(throwing, now)).toBe(false);
    const discarding = { getItem: () => null, setItem: () => undefined };
    expect(claimOidcRetry(discarding, now)).toBe(false);
  });
});

describe("AUTH-012 Rev 2 login entry retry step", () => {
  const failed = { authError: "oidc_failed" };
  const counting = (result: boolean) => {
    const calls = { count: 0 };
    return { calls, claim: () => { calls.count += 1; return result; } };
  };

  it("waits for the mode without claiming the retry", () => {
    const { calls, claim } = counting(true);
    expect(oidcRetryStep(null, false, failed, claim)).toBe("wait");
    expect(calls.count).toBe(0);
  });

  it("retries in OIDC mode only when the one retry is claimed", () => {
    const granted = counting(true);
    expect(oidcRetryStep("oidc", false, failed, granted.claim)).toBe("retry");
    expect(granted.calls.count).toBe(1);
    const refused = counting(false);
    expect(oidcRetryStep("oidc", false, failed, refused.claim)).toBe("decline");
    expect(refused.calls.count).toBe(1);
  });

  it("declines without claiming in local mode, on a mode error, or for other categories", () => {
    const { calls, claim } = counting(true);
    expect(oidcRetryStep("local", false, failed, claim)).toBe("decline");
    expect(oidcRetryStep(null, true, failed, claim)).toBe("decline");
    expect(oidcRetryStep("oidc", false, { authError: "access_denied" }, claim)).toBe("decline");
    expect(oidcRetryStep("oidc", false, {}, claim)).toBe("decline");
    expect(calls.count).toBe(0);
  });
});
