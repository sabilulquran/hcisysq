import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import {
  buildTotpUri,
  encryptSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashPassword,
  hashRecoveryCode,
} from "./crypto.js";

/**
 * AUTH-014 §3.2 — the break-glass account's own tooling.
 *
 * The SUPER_ADMIN account is the fallback for when SQ Hub cannot grant roles. Until AUTH-014 it had
 * no operational tooling at all: `bootstrap-super-admin` refuses once an account exists,
 * `assertAccountManagementTarget` forbids SUPER_ADMIN as a management target, so the only way to
 * change its status or credential was hand-written SQL on the production host. That is exactly how
 * the account became unusable in the first place. These two operations replace that SQL.
 *
 * Both are preview-first and never touch an account that is not SUPER_ADMIN.
 */

export class BreakGlassError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BreakGlassError";
  }
}

export type AccountStatus = "active" | "inactive";

interface BreakGlassAccount {
  id: string;
  email: string;
  status: AccountStatus;
}

/**
 * Resolve the single break-glass account.
 *
 * Refuses when there is none and when there is more than one: with several SUPER_ADMIN rows the
 * operator must say which one, and silently picking the first would be the worst possible guess for
 * a privileged account.
 */
async function resolveBreakGlassAccount(
  db: PoolClient,
  requestedAccountId: string | undefined,
  forUpdate: boolean,
): Promise<BreakGlassAccount> {
  const lock = forUpdate ? " FOR UPDATE" : "";
  const result = requestedAccountId
    ? await db.query<BreakGlassAccount>(
        `SELECT id, email, status FROM accounts
          WHERE id = $1 AND principal_type = 'SUPER_ADMIN'${lock}`,
        [requestedAccountId],
      )
    : await db.query<BreakGlassAccount>(
        `SELECT id, email, status FROM accounts
          WHERE principal_type = 'SUPER_ADMIN' ORDER BY created_at LIMIT 2${lock}`,
      );

  if (!result.rowCount) {
    throw new BreakGlassError(
      "BREAK_GLASS_ACCOUNT_NOT_FOUND",
      requestedAccountId
        ? "No SUPER_ADMIN account with that id. This command never touches any other principal type."
        : "No SUPER_ADMIN account exists. Use bootstrap-super-admin to create the first one.",
    );
  }
  if (result.rowCount > 1) {
    throw new BreakGlassError(
      "BREAK_GLASS_ACCOUNT_AMBIGUOUS",
      "More than one SUPER_ADMIN account exists. Pass --account-id to name the one you mean.",
    );
  }
  return result.rows[0]!;
}

export interface SetStatusInput {
  accountId?: string | undefined;
  status: AccountStatus;
  reason: string;
  apply: boolean;
}

export interface SetStatusResult {
  status: "would_change" | "changed" | "unchanged";
  accountId: string;
  email: string;
  previousStatus: AccountStatus;
  requestedStatus: AccountStatus;
  sessionsRevoked: number;
}

/**
 * Activate or deactivate the break-glass account.
 *
 * Deactivating also revokes its live sessions. `getSession` already filters `status = 'active'`, so
 * an open session stops working either way; revoking makes that visible in the session table rather
 * than leaving rows that look live.
 */
export async function setBreakGlassStatus(
  db: PoolClient,
  input: SetStatusInput,
): Promise<SetStatusResult> {
  const account = await resolveBreakGlassAccount(db, input.accountId, input.apply);
  const base = {
    accountId: account.id,
    email: account.email,
    previousStatus: account.status,
    requestedStatus: input.status,
  };

  if (account.status === input.status) {
    return { ...base, status: "unchanged", sessionsRevoked: 0 };
  }
  if (!input.apply) {
    return { ...base, status: "would_change", sessionsRevoked: 0 };
  }

  await db.query("UPDATE accounts SET status = $2, updated_at = now() WHERE id = $1", [account.id, input.status]);

  let sessionsRevoked = 0;
  if (input.status === "inactive") {
    const revoked = await db.query(
      "UPDATE auth_sessions SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL RETURNING id",
      [account.id],
    );
    sessionsRevoked = revoked.rowCount ?? 0;
  }

  await writeAudit(db, account, "auth.break_glass.status_changed", input.reason);
  return { ...base, status: "changed", sessionsRevoked };
}

export interface RotateCredentialInput {
  accountId?: string | undefined;
  password: string;
  encryptionKey: string;
  reason: string;
  apply: boolean;
}

export interface RotateCredentialResult {
  status: "would_rotate" | "rotated";
  accountId: string;
  email: string;
  /**
   * The account's status, unchanged by this operation. The runbook rotates after every use, by
   * which time the account is usually back to `inactive`; the caller is told so it can say that the
   * new credential will not log anyone in until `--set-status active` runs.
   */
  accountStatus: AccountStatus;
  sessionsRevoked: number;
  /** Present only when applied. Shown once by the CLI and never stored anywhere else. */
  secrets?: { totpSecret: string; totpUri: string; recoveryCodes: string[] };
}

/**
 * Rotate the break-glass password, TOTP secret and recovery codes together.
 *
 * They rotate together on purpose: AUTH-014 §3.2 step 5 rotates the credential after every use, and
 * leaving the second factor in place would mean a used credential is only half replaced. Live
 * sessions are revoked, because a session that survives its own credential rotation defeats it.
 */
export async function rotateBreakGlassCredential(
  db: PoolClient,
  input: RotateCredentialInput,
): Promise<RotateCredentialResult> {
  const account = await resolveBreakGlassAccount(db, input.accountId, input.apply);
  const base = { accountId: account.id, email: account.email, accountStatus: account.status };

  if (!input.apply) {
    return { ...base, status: "would_rotate", sessionsRevoked: 0 };
  }

  const passwordHash = await hashPassword(input.password);
  const totpSecret = generateTotpSecret();
  const encrypted = encryptSecret(totpSecret, input.encryptionKey);
  const recoveryCodes = generateRecoveryCodes();

  await db.query(
    `UPDATE accounts SET
       password_hash = $2, password_changed_at = now(),
       mfa_secret_ciphertext = $3, mfa_secret_iv = $4, mfa_secret_tag = $5, mfa_enabled_at = now(),
       updated_at = now()
     WHERE id = $1`,
    [account.id, passwordHash, encrypted.ciphertext, encrypted.iv, encrypted.tag],
  );

  await db.query("DELETE FROM auth_recovery_codes WHERE account_id = $1", [account.id]);
  for (const code of recoveryCodes) {
    await db.query(
      "INSERT INTO auth_recovery_codes (id, account_id, code_hash) VALUES ($1, $2, $3)",
      [randomUUID(), account.id, hashRecoveryCode(code)],
    );
  }

  const revoked = await db.query(
    "UPDATE auth_sessions SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL RETURNING id",
    [account.id],
  );

  await writeAudit(db, account, "auth.break_glass.credential_rotated", input.reason);

  return {
    ...base,
    status: "rotated",
    sessionsRevoked: revoked.rowCount ?? 0,
    secrets: { totpSecret, totpUri: buildTotpUri(account.email, totpSecret), recoveryCodes },
  };
}

/**
 * The reason is recorded in `user_agent`, the only free-text column this table has. It is a stretch
 * of the column's name and deliberately so: AUTH-014 §3.2 step 1 requires the reason to be written
 * down, and a reason kept only in a runbook is a reason nobody can find later.
 */
async function writeAudit(
  db: PoolClient,
  account: BreakGlassAccount,
  eventType: string,
  reason: string,
): Promise<void> {
  await db.query(
    `INSERT INTO auth_audit_events (id, account_id, event_type, email, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), account.id, eventType, account.email, `break-glass: ${reason}`],
  );
}
