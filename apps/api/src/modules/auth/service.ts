import { randomUUID } from "node:crypto";

import type { Pool } from "pg";
import { resolveAuthorizationContext } from "./permissions.js";

import {
  decryptSecret,
  generateSessionToken,
  hashPassword,
  hashRecoveryCode,
  hashSessionToken,
  verifyPassword,
  verifyTotp,
} from "./crypto.js";

export const AUTH_COOKIE_NAME = "hcis_session";

export type PrincipalType = "EMPLOYEE" | "FOUNDATION_BOARD" | "SUPER_ADMIN";
export type AccountStatus = "invited" | "active" | "suspended" | "inactive";

interface AccountRow {
  id: string;
  email: string;
  principalType: PrincipalType;
  status: AccountStatus;
  passwordHash: string | null;
  mfaSecretCiphertext: string | null;
  mfaSecretIv: string | null;
  mfaSecretTag: string | null;
  mfaEnabledAt: Date | null;
}

interface SessionRow {
  sessionId: string;
  accountId: string;
  email: string;
  principalType: PrincipalType;
  expiresAt: Date;
}

interface RateState {
  count: number;
  resetAt: number;
}

export interface RequestContext {
  ipAddress: string | null;
  userAgent: string | null;
}

export interface AuthPrincipal {
  id: string;
  email: string;
  principalType: PrincipalType;
}

export interface AuthSessionResult {
  principal: AuthPrincipal;
  expiresAt: string;
}

export interface LoginInput {
  email: string;
  password: string;
  mfaCode?: string | undefined;
}

export class AuthError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export class AuthService {
  private readonly attempts = new Map<string, RateState>();
  private readonly sessionTtlSeconds: number;

  getAuthorizationContext(principal: AuthPrincipal) {
    return resolveAuthorizationContext(this.pool, principal);
  }

  constructor(
    private readonly pool: Pool,
    private readonly encryptionKey: string,
    sessionTtlHours: number,
    private readonly secureCookies: boolean,
  ) {
    this.sessionTtlSeconds = sessionTtlHours * 60 * 60;
  }

  async login(input: LoginInput, context: RequestContext): Promise<{
    session: AuthSessionResult;
    setCookie: string;
  }> {
    const email = input.email.trim().toLowerCase();
    const rateKey = `${context.ipAddress ?? "unknown"}|${email}`;
    this.assertRateLimit(rateKey);

    const account = await this.findAccountByEmail(email);
    const passwordOk = account?.passwordHash
      ? await verifyPassword(input.password, account.passwordHash)
      : await this.consumeDummyPasswordWork(input.password);

    if (!account || account.status !== "active" || !account.passwordHash || !passwordOk) {
      this.recordFailure(rateKey);
      await this.audit("auth.login.failed", context, account?.id ?? null, email);
      throw new AuthError(401, "INVALID_CREDENTIALS", "Email atau kata sandi tidak valid.");
    }

    if (account.mfaEnabledAt) {
      if (!input.mfaCode?.trim()) {
        throw new AuthError(401, "MFA_REQUIRED", "Kode autentikator diperlukan.");
      }

      const mfaOk = await this.verifyMfa(account, input.mfaCode, context);
      if (!mfaOk) {
        this.recordFailure(rateKey);
        await this.audit("auth.login.mfa_failed", context, account.id, email);
        throw new AuthError(401, "INVALID_CREDENTIALS", "Kode autentikator tidak valid.");
      }
    } else if (account.principalType === "SUPER_ADMIN") {
      await this.audit("auth.login.mfa_missing", context, account.id, email);
      throw new AuthError(403, "MFA_NOT_CONFIGURED", "MFA Super Admin belum dikonfigurasi.");
    }

    this.attempts.delete(rateKey);
    return this.createSession(account, context, "auth.login.succeeded");
  }

  async createSessionForAccountId(
    accountId: string,
    context: RequestContext,
    auditEvent = "auth.session.created",
  ): Promise<{ session: AuthSessionResult; setCookie: string }> {
    const account = await this.findAccountById(accountId);
    if (!account || account.status !== "active") {
      throw new AuthError(403, "ACCOUNT_INACTIVE", "Akun HCIS tidak aktif.");
    }
    return this.createSession(account, context, auditEvent);
  }

  async getSession(token: string | null): Promise<AuthSessionResult | null> {
    if (!token) return null;

    const result = await this.pool.query<SessionRow>(
      `
        SELECT
          s.id AS "sessionId",
          a.id AS "accountId",
          a.email,
          a.principal_type AS "principalType",
          s.expires_at AS "expiresAt"
        FROM auth_sessions s
        JOIN accounts a ON a.id = s.account_id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
          AND a.status = 'active'
          AND (a.password_changed_at IS NULL OR s.created_at >= a.password_changed_at)
        LIMIT 1
      `,
      [hashSessionToken(token)],
    );

    const row = result.rows[0];
    if (!row) return null;

    await this.pool.query(
      `UPDATE auth_sessions SET last_seen_at = now() WHERE id = $1`,
      [row.sessionId],
    );

    return {
      principal: {
        id: row.accountId,
        email: row.email,
        principalType: row.principalType,
      },
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  async logout(token: string | null, context: RequestContext): Promise<void> {
    if (!token) return;

    const result = await this.pool.query<{ accountId: string; email: string }>(
      `
        UPDATE auth_sessions s
        SET revoked_at = now()
        FROM accounts a
        WHERE s.token_hash = $1
          AND s.account_id = a.id
          AND s.revoked_at IS NULL
        RETURNING a.id AS "accountId", a.email
      `,
      [hashSessionToken(token)],
    );

    const row = result.rows[0];
    if (row) await this.audit("auth.logout", context, row.accountId, row.email);
  }

  clearSessionCookie(): string {
    const secure = this.secureCookies ? "; Secure" : "";
    return `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  }

  private async createSession(
    account: AccountRow,
    context: RequestContext,
    auditEvent: string,
  ): Promise<{ session: AuthSessionResult; setCookie: string }> {
    const { token, hash } = generateSessionToken();
    const sessionId = randomUUID();
    const expiresAt = new Date(Date.now() + this.sessionTtlSeconds * 1000);

    await this.pool.query(
      `
        INSERT INTO auth_sessions (
          id, account_id, token_hash, expires_at, ip_address, user_agent
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [sessionId, account.id, hash, expiresAt, context.ipAddress, context.userAgent],
    );

    await this.audit(auditEvent, context, account.id, account.email);

    return {
      session: {
        principal: this.toPrincipal(account),
        expiresAt: expiresAt.toISOString(),
      },
      setCookie: this.buildSessionCookie(token),
    };
  }

  private async findAccountByEmail(email: string): Promise<AccountRow | null> {
    const result = await this.pool.query<AccountRow>(
      `
        SELECT
          id,
          email,
          principal_type AS "principalType",
          status,
          password_hash AS "passwordHash",
          mfa_secret_ciphertext AS "mfaSecretCiphertext",
          mfa_secret_iv AS "mfaSecretIv",
          mfa_secret_tag AS "mfaSecretTag",
          mfa_enabled_at AS "mfaEnabledAt"
        FROM accounts
        WHERE lower(email) = lower($1)
        LIMIT 1
      `,
      [email],
    );

    return result.rows[0] ?? null;
  }

  private async findAccountById(accountId: string): Promise<AccountRow | null> {
    const result = await this.pool.query<AccountRow>(
      `
        SELECT
          id,
          email,
          principal_type AS "principalType",
          status,
          password_hash AS "passwordHash",
          mfa_secret_ciphertext AS "mfaSecretCiphertext",
          mfa_secret_iv AS "mfaSecretIv",
          mfa_secret_tag AS "mfaSecretTag",
          mfa_enabled_at AS "mfaEnabledAt"
        FROM accounts
        WHERE id = $1
        LIMIT 1
      `,
      [accountId],
    );

    return result.rows[0] ?? null;
  }

  private async verifyMfa(
    account: AccountRow,
    code: string,
    context: RequestContext,
  ): Promise<boolean> {
    if (!account.mfaSecretCiphertext || !account.mfaSecretIv || !account.mfaSecretTag) {
      return false;
    }

    const normalized = code.trim().replace(/\s+/g, "");
    const secret = decryptSecret(
      {
        ciphertext: account.mfaSecretCiphertext,
        iv: account.mfaSecretIv,
        tag: account.mfaSecretTag,
      },
      this.encryptionKey,
    );

    if (/^\d{6}$/.test(normalized) && verifyTotp(secret, normalized)) return true;

    const recoveryHash = hashRecoveryCode(normalized);
    const recovery = await this.pool.query<{ id: string }>(
      `
        UPDATE auth_recovery_codes
        SET used_at = now()
        WHERE account_id = $1
          AND code_hash = $2
          AND used_at IS NULL
        RETURNING id
      `,
      [account.id, recoveryHash],
    );

    if (recovery.rowCount && recovery.rowCount > 0) {
      await this.audit("auth.recovery_code.used", context, account.id, account.email);
      return true;
    }

    return false;
  }

  private toPrincipal(account: AccountRow): AuthPrincipal {
    return {
      id: account.id,
      email: account.email,
      principalType: account.principalType,
    };
  }

  private buildSessionCookie(token: string): string {
    const secure = this.secureCookies ? "; Secure" : "";
    return `${AUTH_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${this.sessionTtlSeconds}${secure}`;
  }

  private assertRateLimit(key: string): void {
    const now = Date.now();
    const state = this.attempts.get(key);
    if (!state) return;

    if (state.resetAt <= now) {
      this.attempts.delete(key);
      return;
    }

    if (state.count >= 5) {
      const retryAfterSeconds = Math.max(1, Math.ceil((state.resetAt - now) / 1000));
      throw new AuthError(
        429,
        "TOO_MANY_ATTEMPTS",
        `Terlalu banyak percobaan masuk. Coba lagi dalam ${retryAfterSeconds} detik.`,
      );
    }
  }

  private recordFailure(key: string): void {
    const now = Date.now();
    this.pruneRateLimitState(now);
    const current = this.attempts.get(key);
    if (!current || current.resetAt <= now) {
      this.attempts.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
      return;
    }

    current.count += 1;
    this.attempts.set(key, current);
  }

  private pruneRateLimitState(now: number): void {
    if (this.attempts.size < 5_000) return;

    for (const [key, state] of this.attempts) {
      if (state.resetAt <= now) this.attempts.delete(key);
    }

    while (this.attempts.size >= 5_000) {
      const oldestKey = this.attempts.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.attempts.delete(oldestKey);
    }
  }

  private async consumeDummyPasswordWork(password: string): Promise<false> {
    await hashPassword(password);
    return false;
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

export function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;

  for (const chunk of cookieHeader.split(";")) {
    const separator = chunk.indexOf("=");
    if (separator < 0) continue;
    const key = chunk.slice(0, separator).trim();
    if (key !== name) continue;
    return chunk.slice(separator + 1).trim() || null;
  }

  return null;
}
