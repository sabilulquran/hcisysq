import { createHash, randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { activateInvitedAccountOnSignIn, INVITATION_VALID_DAYS } from "./activation-invitation.js";
import { ApplicationAccessError, SqHubApplicationAccessClient } from "./application-access.js";
import { OidcProvider, type OidcIdentity } from "./oidc-provider.js";
import { safeReturnTo } from "./return-to.js";
import {
  AuthError,
  AuthService,
  type AccountStatus,
  type AuthSessionResult,
  type PrincipalType,
  type RequestContext,
} from "./service.js";

export const TRANSACTION_TTL_MINUTES = 10;

interface OidcTransactionRow {
  codeVerifier: string;
  nonce: string;
  returnTo: string | null;
}

interface MappedAccountRow {
  id: string;
  email: string;
  principalType: PrincipalType;
  status: AccountStatus;
}

export class OidcLoginService {
  constructor(
    private readonly pool: Pool,
    private readonly provider: OidcProvider,
    private readonly applicationAccess: SqHubApplicationAccessClient,
    private readonly auth: AuthService,
  ) {}

  /** `returnTo` is validated again here; an unsafe value is dropped, not stored. */
  async begin(returnTo?: string | null): Promise<{ url: URL; stateHash: string }> {
    const { url, transaction } = await this.provider.createAuthorizationRequest();
    const stateHash = this.hashState(transaction.state);

    await this.pool.query("DELETE FROM auth_oidc_transactions WHERE expires_at <= now()");
    await this.pool.query(
      `
        INSERT INTO auth_oidc_transactions (
          state_hash, code_verifier, nonce, return_to, expires_at
        ) VALUES ($1, $2, $3, $4, now() + ($5 * interval '1 minute'))
      `,
      [
        stateHash,
        transaction.codeVerifier,
        transaction.nonce,
        safeReturnTo(returnTo),
        TRANSACTION_TTL_MINUTES,
      ],
    );

    return { url, stateHash };
  }

  /**
   * SEC-05: `isBoundToBrowser` must confirm that this browser started the login for this state
   * (a per-state cookie set by /auth/oidc/start); otherwise a victim could be signed in to an
   * attacker's account through a crafted callback link.
   */
  async complete(
    callbackUrl: URL,
    context: RequestContext,
    isBoundToBrowser: (stateHash: string) => boolean,
  ): Promise<{
    session: AuthSessionResult;
    setCookie: string;
    idToken: string | null;
    returnTo: string | null;
  }> {
    const state = callbackUrl.searchParams.get("state");
    if (!state) {
      await this.audit("auth.oidc.callback.invalid", context, null, null);
      throw new AuthError(401, "OIDC_CALLBACK_INVALID", "Respons Akun SQ tidak valid.");
    }

    if (!isBoundToBrowser(this.hashState(state))) {
      // The transaction is left to expire so the browser that started it can still finish.
      await this.audit("auth.oidc.callback.invalid", context, null, null);
      throw new AuthError(401, "OIDC_CALLBACK_UNBOUND", "Login Akun SQ harus diselesaikan di browser yang memulainya.");
    }

    const transaction = await this.consumeTransaction(state);
    if (!transaction) {
      await this.audit("auth.oidc.callback.invalid", context, null, null);
      throw new AuthError(
        401,
        "OIDC_CALLBACK_INVALID",
        "Respons Akun SQ tidak valid atau sudah digunakan.",
      );
    }

    let identity: OidcIdentity;
    try {
      identity = await this.provider.completeAuthorization(callbackUrl, {
        state,
        codeVerifier: transaction.codeVerifier,
        nonce: transaction.nonce,
      });
    } catch {
      await this.audit("auth.oidc.callback.invalid", context, null, null);
      throw new AuthError(
        401,
        "OIDC_CALLBACK_INVALID",
        "Respons Akun SQ tidak dapat diverifikasi.",
      );
    }

    const account = await this.findMappedAccount(identity);
    if (!account) {
      await this.audit("auth.oidc.mapping.missing", context, null, null);
      throw new AuthError(
        403,
        "OIDC_ACCOUNT_NOT_MAPPED",
        "Identitas SQ belum dipetakan ke akun HCIS.",
      );
    }
    // AUTH-002-INVITE §5: an `invited` account with an open activation invitation for this exact
    // identity is activated below, after SQ Hub allows HCIS access; any other non-active state stops here.
    const activatesByInvitation = account.status === "invited"
      && await this.hasOpenInvitation(account.id, identity);
    if (account.status !== "active" && !activatesByInvitation) {
      await this.audit("auth.oidc.account.inactive", context, account.id, account.email);
      throw new AuthError(403, "ACCOUNT_INACTIVE", "Akun HCIS tidak aktif.");
    }

    let allowed: boolean;
    try {
      allowed = await this.applicationAccess.isAllowed(identity);
    } catch (error) {
      if (!(error instanceof ApplicationAccessError)) throw error;
      await this.audit(
        "auth.oidc.application_access.unavailable",
        context,
        account.id,
        account.email,
      );
      throw new AuthError(
        503,
        "APPLICATION_ACCESS_UNAVAILABLE",
        "Akses HCIS belum dapat diverifikasi. Coba lagi.",
      );
    }

    if (!allowed) {
      await this.audit(
        "auth.oidc.application_access.denied",
        context,
        account.id,
        account.email,
      );
      throw new AuthError(403, "HCIS_ACCESS_DENIED", "Akses ke HCIS tidak diberikan.");
    }

    if (activatesByInvitation) {
      const activated = await activateInvitedAccountOnSignIn(this.pool, {
        accountId: account.id,
        issuer: identity.issuer,
        subject: identity.subject,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      });
      if (!activated) {
        await this.audit("auth.oidc.account.inactive", context, account.id, account.email);
        throw new AuthError(403, "ACCOUNT_INACTIVE", "Akun HCIS tidak aktif.");
      }
    }

    const result = await this.auth.createSessionForAccountId(
      account.id,
      context,
      "auth.oidc.login.succeeded",
    );
    return {
      ...result,
      idToken: identity.idToken ?? null,
      // Taken from the server-side transaction only, never from the callback query.
      returnTo: safeReturnTo(transaction.returnTo),
    };
  }

  buildLogoutUrl(idTokenHint?: string | null): Promise<URL> {
    return this.provider.buildLogoutUrl(idTokenHint);
  }

  private async consumeTransaction(state: string): Promise<OidcTransactionRow | null> {
    const result = await this.pool.query<OidcTransactionRow>(
      `
        DELETE FROM auth_oidc_transactions
        WHERE state_hash = $1
          AND expires_at > now()
        RETURNING code_verifier AS "codeVerifier", nonce, return_to AS "returnTo"
      `,
      [this.hashState(state)],
    );
    return result.rows[0] ?? null;
  }

  private async findMappedAccount(identity: OidcIdentity): Promise<MappedAccountRow | null> {
    const result = await this.pool.query<MappedAccountRow>(
      `
        SELECT id, email, principal_type AS "principalType", status
        FROM accounts
        WHERE identity_issuer = $1
          AND identity_subject = $2
        LIMIT 2
      `,
      [identity.issuer, identity.subject],
    );

    if (result.rows.length !== 1) return null;
    return result.rows[0] ?? null;
  }

  private async hasOpenInvitation(accountId: string, identity: OidcIdentity): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM account_activation_invitations
        WHERE account_id = $1 AND identity_issuer = $2 AND identity_subject = $3
          AND state = 'issued' AND completed_at IS NULL AND revoked_at IS NULL
          AND created_at > now() - make_interval(days => $4)
        LIMIT 1`,
      [accountId, identity.issuer, identity.subject, INVITATION_VALID_DAYS],
    );
    return (result.rowCount ?? 0) > 0;
  }

  hashState(state: string): string {
    return createHash("sha256").update(state, "utf8").digest("hex");
  }

  private async audit(
    eventType: string,
    context: RequestContext,
    accountId: string | null,
    email: string | null,
  ): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO auth_audit_events (
          id, account_id, event_type, email, ip_address, user_agent
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [randomUUID(), accountId, eventType, email, context.ipAddress, context.userAgent],
    );
  }
}
