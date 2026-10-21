import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  ApplicationAccessError,
  SqHubApplicationAccessClient,
} from "../src/modules/auth/application-access.js";
import { OidcProvider } from "../src/modules/auth/oidc-provider.js";
import { OidcLoginService } from "../src/modules/auth/oidc-service.js";
import { AuthService } from "../src/modules/auth/service.js";

const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };
const mappedAccount = {
  id: "00000000-0000-4000-8000-000000000021",
  email: "staff@example.org",
  principalType: "EMPLOYEE" as const,
  status: "active" as const,
};

function buildHarness(options?: {
  identity?: { issuer: string; subject: string };
  accountRows?: Array<typeof mappedAccount>;
  allowed?: boolean;
  accessError?: boolean;
  transactionReturnTo?: string | null;
}) {
  const identity = options?.identity ?? {
    issuer: "https://login-staging.sabilulquran.or.id/realms/sq-staff-staging",
    subject: "opaque-subject-1",
  };
  const accountRows = options?.accountRows ?? [mappedAccount];
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("DELETE FROM auth_oidc_transactions")) {
      return {
        rows: [{ codeVerifier: "verifier", nonce: "nonce", returnTo: options?.transactionReturnTo ?? null }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM accounts") && sql.includes("identity_issuer")) {
      return { rows: accountRows, rowCount: accountRows.length };
    }
    return { rows: [], rowCount: 1 };
  });
  const provider = {
    completeAuthorization: vi.fn(async () => identity),
  } as unknown as OidcProvider;
  const applicationAccess = {
    isAllowed: vi.fn(async () => {
      if (options?.accessError) throw new ApplicationAccessError("unavailable");
      return options?.allowed ?? true;
    }),
  } as unknown as SqHubApplicationAccessClient;
  const auth = {
    createSessionForAccountId: vi.fn(async (accountId: string) => ({
      session: {
        principal: {
          id: accountId,
          email: mappedAccount.email,
          principalType: "EMPLOYEE" as const,
        },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      setCookie: "hcis_session=opaque; HttpOnly",
    })),
  } as unknown as AuthService;
  const service = new OidcLoginService(
    { query } as unknown as Pool,
    provider,
    applicationAccess,
    auth,
  );

  return { service, query, provider, applicationAccess, auth, identity };
}

const callback = () =>
  new URL(
    "https://hcis-staging.sabilulquran.or.id/auth/callback?code=opaque&state=state-1",
  );

describe("OidcLoginService", () => {
  it("maps exact issuer + sub and preserves the original accounts.id", async () => {
    const { service, query, auth, identity } = buildHarness();
    const result = await service.complete(callback(), context);

    const mappingCall = query.mock.calls.find(([sql]) => String(sql).includes("identity_issuer"));
    expect(mappingCall?.[1]).toEqual([identity.issuer, identity.subject]);
    expect(auth.createSessionForAccountId).toHaveBeenCalledWith(
      mappedAccount.id,
      context,
      "auth.oidc.login.succeeded",
    );
    expect(result.session.principal.id).toBe(mappedAccount.id);
    expect(result.idToken).toBeNull();
  });

  it("returns the ID token so logout can send it as id_token_hint", async () => {
    const { service } = buildHarness({
      identity: {
        issuer: "https://login-staging.sabilulquran.or.id/realms/sq-staff-staging",
        subject: "opaque-subject-1",
        idToken: "header.payload.signature",
      } as { issuer: string; subject: string },
    });
    const result = await service.complete(callback(), context);
    expect(result.idToken).toBe("header.payload.signature");
  });

  it("returns the returnTo stored with the consumed transaction", async () => {
    const { service } = buildHarness({ transactionReturnTo: "/app/leave" });
    expect((await service.complete(callback(), context)).returnTo).toBe("/app/leave");
  });

  it("re-validates the stored returnTo instead of trusting the row", async () => {
    const { service } = buildHarness({ transactionReturnTo: "//evil.example" });
    expect((await service.complete(callback(), context)).returnTo).toBeNull();
  });

  it.each([
    [
      "wrong issuer with the same subject",
      { issuer: "https://wrong.example/realm", subject: "opaque-subject-1" },
    ],
    [
      "same issuer with the wrong subject",
      {
        issuer: "https://login-staging.sabilulquran.or.id/realms/sq-staff-staging",
        subject: "wrong-subject",
      },
    ],
    [
      "unknown subject",
      {
        issuer: "https://login-staging.sabilulquran.or.id/realms/sq-staff-staging",
        subject: "unknown",
      },
    ],
  ])("denies %s instead of joining by email or NIP", async (_label, identity) => {
    const { service, auth } = buildHarness({ identity, accountRows: [] });
    await expect(service.complete(callback(), context)).rejects.toMatchObject({
      code: "OIDC_ACCOUNT_NOT_MAPPED",
      statusCode: 403,
    });
    expect(auth.createSessionForAccountId).not.toHaveBeenCalled();
  });

  it("denies a suspended HCIS-local account before Application Access", async () => {
    const { service, applicationAccess, auth } = buildHarness({
      accountRows: [{ ...mappedAccount, status: "suspended" as const }],
    });
    await expect(service.complete(callback(), context)).rejects.toMatchObject({
      code: "ACCOUNT_INACTIVE",
      statusCode: 403,
    });
    expect(applicationAccess.isAllowed).not.toHaveBeenCalled();
    expect(auth.createSessionForAccountId).not.toHaveBeenCalled();
  });

  it("denies a new session when HCIS Application Access is absent or revoked", async () => {
    const { service, auth } = buildHarness({ allowed: false });
    await expect(service.complete(callback(), context)).rejects.toMatchObject({
      code: "HCIS_ACCESS_DENIED",
      statusCode: 403,
    });
    expect(auth.createSessionForAccountId).not.toHaveBeenCalled();
  });

  it("fails closed when the Application Access machine call cannot be verified", async () => {
    const { service, auth } = buildHarness({ accessError: true });
    await expect(service.complete(callback(), context)).rejects.toMatchObject({
      code: "APPLICATION_ACCESS_UNAVAILABLE",
      statusCode: 503,
    });
    expect(auth.createSessionForAccountId).not.toHaveBeenCalled();
  });

  it("denies a callback without state before OIDC validation", async () => {
    const { service, provider } = buildHarness();
    await expect(
      service.complete(
        new URL("https://hcis-staging.sabilulquran.or.id/auth/callback?code=opaque"),
        context,
      ),
    ).rejects.toMatchObject({ code: "OIDC_CALLBACK_INVALID", statusCode: 401 });
    expect(provider.completeAuthorization).not.toHaveBeenCalled();
  });
});
