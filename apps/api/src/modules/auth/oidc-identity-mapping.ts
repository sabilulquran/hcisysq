import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { z } from "zod";

const accountIdSchema = z.string().uuid();
const issuerSchema = z.string().url().max(2048);
const subjectSchema = z.string().min(1).max(512);

export interface OidcIdentityRef {
  issuer: string;
  subject: string;
}

interface AccountMappingRow {
  id: string;
  email: string;
  principalType: "EMPLOYEE" | "FOUNDATION_BOARD" | "SUPER_ADMIN";
  status: "invited" | "active" | "suspended" | "inactive";
  identityIssuer: string | null;
  identitySubject: string | null;
}

export type OidcIdentityMappingStatus =
  | "would_map"
  | "mapped"
  | "already_mapped"
  | "would_replace"
  | "replaced"
  | "would_clear"
  | "cleared"
  | "already_clear";

export interface OidcIdentityMappingResult {
  status: OidcIdentityMappingStatus;
  account: {
    id: string;
    email: string;
    principalType: AccountMappingRow["principalType"];
    accountStatus: AccountMappingRow["status"];
  };
  previousIdentity: OidcIdentityRef | null;
  nextIdentity: OidcIdentityRef | null;
}

export class OidcIdentityMappingError extends Error {
  constructor(
    public readonly code:
      | "ACCOUNT_NOT_FOUND"
      | "IDENTITY_ALREADY_ASSIGNED"
      | "REPLACE_REQUIRED"
      | "SOURCE_HAS_NO_IDENTITY"
      | "TARGET_NOT_ELIGIBLE"
      | "TARGET_ALREADY_MAPPED"
      | "SAME_ACCOUNT",
    message: string,
  ) {
    super(message);
    this.name = "OidcIdentityMappingError";
  }
}

export interface OidcIdentityHandOverResult {
  status: "would_hand_over" | "handed_over";
  identity: OidcIdentityRef;
  from: OidcIdentityMappingResult["account"];
  to: OidcIdentityMappingResult["account"];
}

// ORG-010 §5: a hand-over always goes to the other principal kind.
const HAND_OVER_TARGET: Partial<Record<AccountMappingRow["principalType"], AccountMappingRow["principalType"]>> = {
  FOUNDATION_BOARD: "EMPLOYEE",
  EMPLOYEE: "FOUNDATION_BOARD",
};

export class OidcIdentityMappingService {
  constructor(private readonly client: Pick<PoolClient, "query">) {}

  async map(input: {
    accountId: string;
    issuer: string;
    subject: string;
    apply: boolean;
    replace?: boolean;
  }): Promise<OidcIdentityMappingResult> {
    const accountId = accountIdSchema.parse(input.accountId);
    const identity = {
      issuer: issuerSchema.parse(input.issuer),
      subject: subjectSchema.parse(input.subject),
    };

    if (input.apply) {
      await this.client.query("SELECT pg_advisory_xact_lock(hashtext('hcis-oidc-identity-mapping'))");
    }

    const account = await this.findAccount(accountId, input.apply);
    if (!account) {
      throw new OidcIdentityMappingError("ACCOUNT_NOT_FOUND", `HCIS account ${accountId} was not found.`);
    }

    const previousIdentity = this.identityFromAccount(account);
    if (
      previousIdentity?.issuer === identity.issuer &&
      previousIdentity.subject === identity.subject
    ) {
      return this.result("already_mapped", account, previousIdentity, identity);
    }

    const owner = await this.findIdentityOwner(identity);
    if (owner && owner.id !== account.id) {
      throw new OidcIdentityMappingError(
        "IDENTITY_ALREADY_ASSIGNED",
        `OIDC identity is already assigned to HCIS account ${owner.id}.`,
      );
    }

    if (!input.apply) {
      return this.result(previousIdentity ? "would_replace" : "would_map", account, previousIdentity, identity);
    }

    if (previousIdentity && !input.replace) {
      throw new OidcIdentityMappingError(
        "REPLACE_REQUIRED",
        "Account already has a different OIDC identity mapping. Preview first, then re-run with --replace --apply only after verifying the existing binding.",
      );
    }

    await this.client.query(
      `
        UPDATE accounts
        SET identity_issuer = $2,
            identity_subject = $3,
            updated_at = now()
        WHERE id = $1
      `,
      [account.id, identity.issuer, identity.subject],
    );
    await this.audit(previousIdentity ? "auth.oidc.identity_mapping_replaced" : "auth.oidc.identity_mapped", account);

    return this.result(previousIdentity ? "replaced" : "mapped", account, previousIdentity, identity);
  }

  async clear(input: {
    accountId: string;
    apply: boolean;
  }): Promise<OidcIdentityMappingResult> {
    const accountId = accountIdSchema.parse(input.accountId);

    if (input.apply) {
      await this.client.query("SELECT pg_advisory_xact_lock(hashtext('hcis-oidc-identity-mapping'))");
    }

    const account = await this.findAccount(accountId, input.apply);
    if (!account) {
      throw new OidcIdentityMappingError("ACCOUNT_NOT_FOUND", `HCIS account ${accountId} was not found.`);
    }

    const previousIdentity = this.identityFromAccount(account);
    if (!previousIdentity) {
      return this.result("already_clear", account, null, null);
    }

    if (!input.apply) {
      return this.result("would_clear", account, previousIdentity, null);
    }

    await this.client.query(
      `
        UPDATE accounts
        SET identity_issuer = NULL,
            identity_subject = NULL,
            updated_at = now()
        WHERE id = $1
      `,
      [account.id],
    );
    await this.audit("auth.oidc.identity_mapping_cleared", account);

    return this.result("cleared", account, previousIdentity, null);
  }

  /**
   * ORG-010 §5: move the Akun SQ identity held by one account (usually FOUNDATION_BOARD) to an active
   * account of the other kind (usually EMPLOYEE) under the mapping lock. The old account is set
   * inactive, never deleted, and its sessions end. Identity only: no role is granted (D8).
   * With apply, the caller owns the surrounding transaction.
   */
  async handOver(input: {
    fromAccountId: string;
    toAccountId: string;
    apply: boolean;
  }): Promise<OidcIdentityHandOverResult> {
    const fromAccountId = accountIdSchema.parse(input.fromAccountId);
    const toAccountId = accountIdSchema.parse(input.toAccountId);
    if (fromAccountId === toAccountId) {
      throw new OidcIdentityMappingError("SAME_ACCOUNT", "Source and target must be different HCIS accounts.");
    }

    if (input.apply) {
      await this.client.query("SELECT pg_advisory_xact_lock(hashtext('hcis-oidc-identity-mapping'))");
    }

    const from = await this.findAccount(fromAccountId, input.apply);
    if (!from) throw new OidcIdentityMappingError("ACCOUNT_NOT_FOUND", `HCIS account ${fromAccountId} was not found.`);
    const to = await this.findAccount(toAccountId, input.apply);
    if (!to) throw new OidcIdentityMappingError("ACCOUNT_NOT_FOUND", `HCIS account ${toAccountId} was not found.`);

    const identity = this.identityFromAccount(from);
    if (!identity) {
      throw new OidcIdentityMappingError("SOURCE_HAS_NO_IDENTITY", `HCIS account ${from.id} does not hold an OIDC identity.`);
    }
    if (this.identityFromAccount(to)) {
      throw new OidcIdentityMappingError("TARGET_ALREADY_MAPPED", `HCIS account ${to.id} already has an OIDC identity.`);
    }
    const expectedType = HAND_OVER_TARGET[from.principalType];
    if (!expectedType || to.principalType !== expectedType || to.status !== "active" || !(await this.employeeActive(to))) {
      throw new OidcIdentityMappingError(
        "TARGET_NOT_ELIGIBLE",
        `HCIS account ${to.id} must be an active ${expectedType ?? "EMPLOYEE or FOUNDATION_BOARD"} account.`,
      );
    }

    if (!input.apply) {
      return { status: "would_hand_over", identity, from: this.summary(from), to: this.summary(to) };
    }

    await this.client.query(
      `
        UPDATE accounts
        SET identity_issuer = NULL,
            identity_subject = NULL,
            status = 'inactive',
            updated_at = now()
        WHERE id = $1
      `,
      [from.id],
    );
    await this.client.query(
      "UPDATE auth_sessions SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL",
      [from.id],
    );
    await this.client.query(
      `
        UPDATE accounts
        SET identity_issuer = $2,
            identity_subject = $3,
            updated_at = now()
        WHERE id = $1
      `,
      [to.id, identity.issuer, identity.subject],
    );
    // One event naming the new account, the previous account, and the operator CLI as actor.
    await this.client.query(
      `
        INSERT INTO auth_audit_events (id, account_id, event_type, email, user_agent, related_account_id)
        VALUES ($1, $2, 'auth.oidc.identity_handed_over', $3, 'operator-cli:map-oidc-identity', $4)
      `,
      [randomUUID(), to.id, to.email, from.id],
    );

    return {
      status: "handed_over",
      identity,
      from: { ...this.summary(from), accountStatus: "inactive" },
      to: this.summary(to),
    };
  }

  private async employeeActive(account: AccountMappingRow): Promise<boolean> {
    if (account.principalType !== "EMPLOYEE") return true;
    const result = await this.client.query<{ active: boolean }>(
      `
        SELECT employee.status = 'active' AS active
        FROM accounts account
        JOIN employees employee ON employee.id = account.employee_id
        WHERE account.id = $1
      `,
      [account.id],
    );
    return result.rows[0]?.active === true;
  }

  private summary(account: AccountMappingRow): OidcIdentityMappingResult["account"] {
    return {
      id: account.id,
      email: account.email,
      principalType: account.principalType,
      accountStatus: account.status,
    };
  }

  private async findAccount(accountId: string, lock: boolean): Promise<AccountMappingRow | null> {
    const result = await this.client.query<AccountMappingRow>(
      `
        SELECT
          id,
          email,
          principal_type AS "principalType",
          status,
          identity_issuer AS "identityIssuer",
          identity_subject AS "identitySubject"
        FROM accounts
        WHERE id = $1
        ${lock ? "FOR UPDATE" : ""}
        LIMIT 1
      `,
      [accountId],
    );
    return result.rows[0] ?? null;
  }

  private async findIdentityOwner(identity: OidcIdentityRef): Promise<{ id: string } | null> {
    const result = await this.client.query<{ id: string }>(
      `
        SELECT id
        FROM accounts
        WHERE identity_issuer = $1
          AND identity_subject = $2
        LIMIT 1
      `,
      [identity.issuer, identity.subject],
    );
    return result.rows[0] ?? null;
  }

  private identityFromAccount(account: AccountMappingRow): OidcIdentityRef | null {
    if (!account.identityIssuer || !account.identitySubject) return null;
    return { issuer: account.identityIssuer, subject: account.identitySubject };
  }

  private result(
    status: OidcIdentityMappingStatus,
    account: AccountMappingRow,
    previousIdentity: OidcIdentityRef | null,
    nextIdentity: OidcIdentityRef | null,
  ): OidcIdentityMappingResult {
    return {
      status,
      account: {
        id: account.id,
        email: account.email,
        principalType: account.principalType,
        accountStatus: account.status,
      },
      previousIdentity,
      nextIdentity,
    };
  }

  private async audit(eventType: string, account: AccountMappingRow): Promise<void> {
    await this.client.query(
      `
        INSERT INTO auth_audit_events (id, account_id, event_type, email)
        VALUES ($1, $2, $3, $4)
      `,
      [randomUUID(), account.id, eventType, account.email],
    );
  }
}
