import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import type { Pool, PoolClient } from "pg";

import type { AuthPrincipal } from "./service.js";

const VERIFICATION_DEADLINE_MS = 3_000;
const JWKS_TRANSPORT_TIMEOUT_MS = 2_500;

/**
 * AUTH-014 §2.2 — proving *which human* is acting, not merely that SQ Hub called.
 *
 * The machine token proves one thing only: the request came from SQ Hub. The first draft of this
 * design carried the acting person's identity as two plain JSON fields in the request body, and the
 * independent security review was right that this collapses immediately: a compromised Hub, or one
 * rogue Platform Administrator, names someone else as actor, walks past the self-grant prohibition,
 * and leaves an audit trail accusing an innocent employee.
 *
 * So the actor arrives as a second, separately signed token — issued by Keycloak for that person's
 * session through token exchange, with HCIS as its audience — and the identity is taken from there.
 * The body never carries it.
 */

export class ActorAssertionError extends Error {
  constructor(
    readonly code: "ACTOR_ASSERTION_INVALID" | "ACTOR_UNRESOLVED",
    message: string,
  ) {
    super(message);
    this.name = "ActorAssertionError";
  }
}

export interface ActorAssertionClaims {
  issuer: string;
  subject: string;
}

export type VerifyActorAssertion = (assertion: string) => Promise<ActorAssertionClaims>;

export function createActorAssertionVerifier(input: {
  issuer: string;
  audience: string;
  /** §2.2: an assertion older than this is refused even if it has not expired. */
  maxAgeSeconds: number;
}): VerifyActorAssertion {
  const issuer = input.issuer.replace(/\/$/, "");
  const jwksUrl = new URL(`${issuer}/protocol/openid-connect/certs`);
  const jwks = createRemoteJWKSet(jwksUrl, {
    timeoutDuration: JWKS_TRANSPORT_TIMEOUT_MS,
    [customFetch]: (url, options) =>
      fetch(url, { ...options, signal: AbortSignal.timeout(VERIFICATION_DEADLINE_MS) }),
  });

  return async (assertion: string) => {
    let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
    try {
      ({ payload } = await jwtVerify(assertion, jwks, {
        issuer,
        audience: input.audience,
        maxTokenAge: input.maxAgeSeconds,
      }));
    } catch {
      throw new ActorAssertionError("ACTOR_ASSERTION_INVALID", "actor assertion is invalid");
    }

    const subject = typeof payload.sub === "string" ? payload.sub.trim() : "";
    if (!subject) {
      throw new ActorAssertionError("ACTOR_ASSERTION_INVALID", "actor assertion carries no subject");
    }
    // A client-credentials token has no human behind it. Accepting one here would let the machine
    // account grant roles in nobody's name, which is exactly what the assertion exists to prevent.
    if (typeof payload.azp === "string" && payload.azp === subject) {
      throw new ActorAssertionError("ACTOR_ASSERTION_INVALID", "actor assertion is a machine token");
    }
    return { issuer, subject };
  };
}

/**
 * §2.4 step 4: map the asserted identity to a local account, failing closed.
 *
 * Only `identity_issuer` + `identity_subject`, never email and never name: those are mutable and
 * reassignable, and a wrong match here means the audit accuses the wrong person and the self-grant
 * check compares against the wrong account. The pair is unique by index
 * (`accounts_identity_issuer_subject_unique`, migration 0020), so "exactly one row" is enforced by
 * the schema rather than by convention.
 */
export async function resolveAssertedActor(
  db: Pick<Pool, "query"> | PoolClient,
  claims: ActorAssertionClaims,
): Promise<AuthPrincipal> {
  const result = await db.query<{
    id: string; email: string; principalType: AuthPrincipal["principalType"];
    accountStatus: string; employeeStatus: string | null;
  }>(
    `SELECT account.id, account.email, account.principal_type AS "principalType",
            account.status AS "accountStatus", employee.status AS "employeeStatus"
       FROM accounts account
       LEFT JOIN employees employee ON employee.id = account.employee_id
      WHERE account.identity_issuer = $1 AND account.identity_subject = $2`,
    [claims.issuer, claims.subject],
  );

  const row = result.rows[0];
  if (!row || result.rowCount !== 1) {
    throw new ActorAssertionError("ACTOR_UNRESOLVED", "actor is not a known HCIS account");
  }
  if (row.accountStatus !== "active") {
    throw new ActorAssertionError("ACTOR_UNRESOLVED", "actor account is not active");
  }
  if (row.principalType === "EMPLOYEE" && row.employeeStatus !== "active") {
    throw new ActorAssertionError("ACTOR_UNRESOLVED", "actor employee record is not active");
  }
  return { id: row.id, email: row.email, principalType: row.principalType };
}
