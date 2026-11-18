import type { Pool } from "pg";

import { ApplicationAccessError, SqHubApplicationAccessClient } from "../auth/application-access.js";
import { hasBoardAccess } from "../auth/permissions.js";
import type { GovernanceIdentity } from "./token-verifier.js";

/**
 * ORG-010 §3.3 and ORG-015-4: turning a verified governance token into an HCIS account.
 *
 * Shared by the summary, the employee list and the decision routes so the four gates stay the same
 * everywhere: the identity is mapped by issuer and subject only, the account is active, it has
 * board access, and SQ Hub still grants it Application Access to HCIS.
 */
export interface ResolvedGovernanceAccount {
  id: string;
  principalType: string;
  employeeId: string | null;
}

export class GovernanceAccountDenied extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    public readonly accountId: string | null,
  ) {
    super(code);
    this.name = "GovernanceAccountDenied";
  }
}

export async function resolveGovernanceAccount(
  pool: Pool,
  applicationAccess: Pick<SqHubApplicationAccessClient, "isAllowed">,
  identity: GovernanceIdentity,
): Promise<ResolvedGovernanceAccount> {
  const mapped = await pool.query<ResolvedGovernanceAccount & { status: string }>(
    `SELECT id, principal_type AS "principalType", employee_id AS "employeeId", status
     FROM accounts WHERE identity_issuer = $1 AND identity_subject = $2 LIMIT 2`,
    [identity.issuer, identity.subject],
  );
  const account = mapped.rows.length === 1 ? mapped.rows[0] : undefined;
  if (!account) throw new GovernanceAccountDenied(403, "OIDC_ACCOUNT_NOT_MAPPED", null);
  if (account.status !== "active") throw new GovernanceAccountDenied(403, "ACCOUNT_INACTIVE", account.id);
  if (!(await hasBoardAccess(pool, account))) throw new GovernanceAccountDenied(403, "BOARD_ACCESS_REQUIRED", account.id);
  // D3: re-check SQ Hub Application Access with the same client and rules as OIDC login.
  let allowed: boolean;
  try {
    allowed = await applicationAccess.isAllowed({ issuer: identity.issuer, subject: identity.subject });
  } catch (error) {
    if (!(error instanceof ApplicationAccessError)) throw error;
    throw new GovernanceAccountDenied(503, "APPLICATION_ACCESS_UNAVAILABLE", account.id);
  }
  if (!allowed) throw new GovernanceAccountDenied(403, "HCIS_ACCESS_DENIED", account.id);
  return { id: account.id, principalType: account.principalType, employeeId: account.employeeId };
}
