import { assertAccountManagementTarget } from "./role-assignment.js";
import type { AuthPrincipal } from "./service.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { hashPassword } from "./crypto.js";
import type { RequestContext } from "./service.js";

export const ACCOUNT_ACTIVATION_TTL_HOURS = 24;
export const ACCOUNT_ACTIVATION_PASSWORD_MIN_LENGTH = 12;
export const ACCOUNT_ACTIVATION_PASSWORD_MAX_LENGTH = 128;

type ActivatablePrincipalType = "EMPLOYEE" | "FOUNDATION_BOARD";

interface AccountForIssueRow {
  id: string;
  principalType: "EMPLOYEE" | "FOUNDATION_BOARD" | "SUPER_ADMIN";
  status: "invited" | "active" | "suspended" | "inactive";
  employeeStatus: "active" | "inactive" | "resigned" | null;
  passwordHash: string | null;
}

interface ActivationRow {
  tokenId: string;
  accountId: string;
  email: string;
  principalType: "EMPLOYEE" | "FOUNDATION_BOARD" | "SUPER_ADMIN";
  accountStatus: "invited" | "active" | "suspended" | "inactive";
  employeeStatus: "active" | "inactive" | "resigned" | null;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
}

export interface ActivationPreview {
  maskedEmail: string;
  principalType: ActivatablePrincipalType;
  expiresAt: string;
}

export class AccountActivationError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AccountActivationError";
  }
}

function hashActivationToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function generateActivationToken() {
  return randomBytes(32).toString("base64url");
}

export function maskActivationEmail(email: string) {
  const separator = email.lastIndexOf("@");
  if (separator <= 0) return "***";
  const local = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"*".repeat(Math.max(3, local.length - visible.length))}@${domain}`;
}

export function assertActivationPassword(password: string) {
  if (password.length < ACCOUNT_ACTIVATION_PASSWORD_MIN_LENGTH) {
    throw new AccountActivationError(
      400,
      "ACTIVATION_PASSWORD_TOO_SHORT",
      `Kata sandi minimal ${ACCOUNT_ACTIVATION_PASSWORD_MIN_LENGTH} karakter.`,
    );
  }
  if (password.length > ACCOUNT_ACTIVATION_PASSWORD_MAX_LENGTH) {
    throw new AccountActivationError(
      400,
      "ACTIVATION_PASSWORD_TOO_LONG",
      `Kata sandi maksimal ${ACCOUNT_ACTIVATION_PASSWORD_MAX_LENGTH} karakter.`,
    );
  }
}

function invalidActivationLink(): AccountActivationError {
  return new AccountActivationError(
    410,
    "ACTIVATION_LINK_INVALID",
    "Link aktivasi tidak berlaku atau sudah kedaluwarsa. Minta link aktivasi baru kepada administrator.",
  );
}

function assertUsableActivation(row: ActivationRow | undefined): asserts row is ActivationRow & {
  principalType: ActivatablePrincipalType;
} {
  if (
    !row ||
    row.principalType === "SUPER_ADMIN" ||
    row.accountStatus !== "invited" ||
    row.consumedAt ||
    row.revokedAt ||
    row.expiresAt.getTime() <= Date.now() ||
    (row.principalType === "EMPLOYEE" && row.employeeStatus !== "active")
  ) {
    throw invalidActivationLink();
  }
}

async function loadActivation(
  db: Pool | PoolClient,
  token: string,
  lock = false,
): Promise<ActivationRow | undefined> {
  const result = await db.query<ActivationRow>(
    `SELECT
      activation.id AS "tokenId",
      account.id AS "accountId",
      account.email,
      account.principal_type AS "principalType",
      account.status AS "accountStatus",
      employee.status AS "employeeStatus",
      activation.expires_at AS "expiresAt",
      activation.consumed_at AS "consumedAt",
      activation.revoked_at AS "revokedAt"
     FROM account_activation_tokens activation
     JOIN accounts account ON account.id = activation.account_id
     LEFT JOIN employees employee ON employee.id = account.employee_id
     WHERE activation.token_hash = $1
     LIMIT 1
     ${lock ? "FOR UPDATE OF activation, account" : ""}`,
    [hashActivationToken(token)],
  );
  return result.rows[0];
}

export class AccountActivationService {
  constructor(private readonly pool: Pool) {}

  async issue(
    accountId: string,
    actor: AuthPrincipal,
  ): Promise<{ token: string; expiresAt: string }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const accountResult = await client.query<AccountForIssueRow>(
        `SELECT
          account.id,
          account.principal_type AS "principalType",
          account.status,
          employee.status AS "employeeStatus",
          account.password_hash AS "passwordHash"
         FROM accounts account
         LEFT JOIN employees employee ON employee.id = account.employee_id
         WHERE account.id = $1
         FOR UPDATE OF account`,
        [accountId],
      );
      const account = accountResult.rows[0];
      if (!account) {
        throw new AccountActivationError(404, "ACCOUNT_NOT_FOUND", "Account tidak ditemukan.");
      }
      await assertAccountManagementTarget(client, actor, accountId);
      if (account.principalType === "SUPER_ADMIN") {
        throw new AccountActivationError(
          403,
          "SUPER_ADMIN_ACTIVATION_PROTECTED",
          "Aktivasi Super Admin tidak menggunakan alur undangan account biasa.",
        );
      }
      if (account.status !== "invited") {
        throw new AccountActivationError(
          409,
          "ACCOUNT_NOT_INVITED",
          "Link aktivasi hanya dapat diterbitkan untuk account yang masih berstatus invited.",
        );
      }
      if (account.passwordHash) {
        throw new AccountActivationError(
          409,
          "ACCOUNT_ALREADY_ACTIVATED",
          "Account sudah pernah diaktifkan. Gunakan alur pemulihan kata sandi untuk mengganti kredensial.",
        );
      }
      if (account.principalType === "EMPLOYEE" && account.employeeStatus !== "active") {
        throw new AccountActivationError(
          409,
          "EMPLOYEE_NOT_ACTIVE",
          "Account pegawai hanya dapat diaktivasi ketika employee masih aktif.",
        );
      }

      await client.query(
        `UPDATE account_activation_tokens
         SET revoked_at = now()
         WHERE account_id = $1
           AND consumed_at IS NULL
           AND revoked_at IS NULL`,
        [account.id],
      );

      const token = generateActivationToken();
      const expiresAt = new Date(Date.now() + ACCOUNT_ACTIVATION_TTL_HOURS * 60 * 60 * 1000);
      await client.query(
        `INSERT INTO account_activation_tokens (
          id, account_id, token_hash, expires_at, issued_by_account_id
        ) VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), account.id, hashActivationToken(token), expiresAt, actor.id],
      );
      await client.query("COMMIT");
      return { token, expiresAt: expiresAt.toISOString() };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async preview(token: string): Promise<ActivationPreview> {
    const row = await loadActivation(this.pool, token);
    assertUsableActivation(row);
    return {
      maskedEmail: maskActivationEmail(row.email),
      principalType: row.principalType,
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  async activate(token: string, password: string, context: RequestContext): Promise<{
    principalType: ActivatablePrincipalType;
  }> {
    assertActivationPassword(password);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = await loadActivation(client, token, true);
      assertUsableActivation(row);

      const passwordHash = await hashPassword(password);
      await client.query(
        `UPDATE accounts
         SET password_hash = $2,
             password_changed_at = now(),
             status = 'active',
             updated_at = now()
         WHERE id = $1`,
        [row.accountId, passwordHash],
      );
      await client.query(
        `UPDATE account_activation_tokens
         SET consumed_at = now()
         WHERE id = $1`,
        [row.tokenId],
      );
      await client.query(
        `UPDATE auth_sessions
         SET revoked_at = now()
         WHERE account_id = $1 AND revoked_at IS NULL`,
        [row.accountId],
      );
      await client.query(
        `INSERT INTO auth_audit_events (
          id, account_id, event_type, email, ip_address, user_agent
        ) VALUES ($1, $2, 'auth.activation.completed', $3, $4, $5)`,
        [randomUUID(), row.accountId, row.email, context.ipAddress, context.userAgent],
      );
      await client.query("COMMIT");
      return { principalType: row.principalType };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
