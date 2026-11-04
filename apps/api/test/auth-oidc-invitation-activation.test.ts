import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import type { SqHubApplicationAccessClient } from "../src/modules/auth/application-access.js";
import type { OidcProvider } from "../src/modules/auth/oidc-provider.js";
import { OidcLoginService } from "../src/modules/auth/oidc-service.js";
import type { AuthService } from "../src/modules/auth/service.js";

// AUTH-002-INVITE §5: first Akun SQ sign-in of an invited account with an open invitation.
const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };
const identity = { issuer: "https://login.example.test/realms/sq-staff", subject: "kc-subject-1" };
const invitedAccount = {
  id: "00000000-0000-4000-8000-000000000031",
  email: "staff@example.org",
  principalType: "EMPLOYEE" as const,
  status: "invited" as "invited" | "active" | "suspended",
};

function harness(options: { openInvitation?: boolean; activates?: boolean; allowed?: boolean; status?: typeof invitedAccount.status } = {}) {
  const account = { ...invitedAccount, status: options.status ?? "invited" };
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("DELETE FROM auth_oidc_transactions")) {
      return { rows: [{ codeVerifier: "verifier", nonce: "nonce", returnTo: null }], rowCount: 1 };
    }
    if (sql.includes("FROM accounts") && sql.includes("identity_issuer")) return { rows: [account], rowCount: 1 };
    if (sql.includes("FROM account_activation_invitations")) {
      return { rows: options.openInvitation ? [{}] : [], rowCount: options.openInvitation ? 1 : 0 };
    }
    return { rows: [], rowCount: 1 };
  });
  const clientQuery = vi.fn(async (sql: string) => {
    if (sql.includes("UPDATE accounts a")) {
      return options.activates === false
        ? { rows: [], rowCount: 0 }
        : { rows: [{ id: account.id, email: account.email }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  const pool = { query, connect: vi.fn(async () => ({ query: clientQuery, release: vi.fn() })) } as unknown as Pool;
  const applicationAccess = {
    isAllowed: vi.fn(async () => options.allowed ?? true),
  } as unknown as SqHubApplicationAccessClient;
  const auth = {
    createSessionForAccountId: vi.fn(async (accountId: string) => ({
      session: { principal: { id: accountId, email: account.email, principalType: "EMPLOYEE" as const }, expiresAt: new Date().toISOString() },
      setCookie: "hcis_session=opaque; HttpOnly",
    })),
  } as unknown as AuthService;
  const provider = { completeAuthorization: vi.fn(async () => identity) } as unknown as OidcProvider;
  return { service: new OidcLoginService(pool, provider, applicationAccess, auth), clientQuery, auth, applicationAccess };
}

const callback = () => new URL("https://hcis.example.test/auth/callback?code=opaque&state=state-1");
const bound = () => true;

describe("OIDC sign-in activates an invited account by invitation", () => {
  it("activates after SQ Hub allows access, then signs in", async () => {
    const { service, clientQuery, auth } = harness({ openInvitation: true });
    const result = await service.complete(callback(), context, bound);
    expect(result.session.principal.id).toBe(invitedAccount.id);
    const update = clientQuery.mock.calls.find(([sql]) => String(sql).includes("UPDATE accounts a"));
    expect(update?.[1]).toEqual([invitedAccount.id, identity.issuer, identity.subject]);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("auth.activation.invitation_completed"))).toBe(true);
    expect(auth.createSessionForAccountId).toHaveBeenCalledOnce();
  });

  it("keeps refusing an invited account without an open invitation", async () => {
    const { service, clientQuery, auth } = harness({ openInvitation: false });
    await expect(service.complete(callback(), context, bound)).rejects.toMatchObject({ code: "ACCOUNT_INACTIVE" });
    expect(clientQuery).not.toHaveBeenCalled();
    expect(auth.createSessionForAccountId).not.toHaveBeenCalled();
  });

  it("does not activate when SQ Hub denies HCIS access", async () => {
    const { service, clientQuery } = harness({ openInvitation: true, allowed: false });
    await expect(service.complete(callback(), context, bound)).rejects.toMatchObject({ code: "HCIS_ACCESS_DENIED" });
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it("refuses when the guarded update finds nothing to activate", async () => {
    const { service, auth } = harness({ openInvitation: true, activates: false });
    await expect(service.complete(callback(), context, bound)).rejects.toMatchObject({ code: "ACCOUNT_INACTIVE" });
    expect(auth.createSessionForAccountId).not.toHaveBeenCalled();
  });

  it("never activates a suspended account", async () => {
    const { service, clientQuery } = harness({ openInvitation: true, status: "suspended" });
    await expect(service.complete(callback(), context, bound)).rejects.toMatchObject({ code: "ACCOUNT_INACTIVE" });
    expect(clientQuery).not.toHaveBeenCalled();
  });
});
