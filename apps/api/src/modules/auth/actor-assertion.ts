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
    readonly code: "ACTOR_ASSERTION_INVALID" | "ACTOR_UNRESOLVED" | "ACTOR_ASSERTION_SPENT",
    message: string,
  ) {
    super(message);
    this.name = "ActorAssertionError";
  }
}

export interface ActorAssertionClaims {
  issuer: string;
  subject: string;
  /** The client the assertion was issued to. Used to refuse a machine vouching for itself. */
  authorizedParty: string | null;
  /** §2.11: the token id this assertion is spent under. Required; an assertion without one
   * could not be made single use, and would stay replayable for its whole lifetime. */
  jti: string;
  expiresAt: Date;
}

export type VerifyActorAssertion = (assertion: string) => Promise<ActorAssertionClaims>;

export function createActorAssertionVerifier(input: {
  issuer: string;
  audience: string;
  /** §2.2: an assertion older than this is refused even if it has not expired. */
  maxAgeSeconds: number;
  /**
   * The machine clients of this realm. A token whose `azp` is one of them was issued *to a
   * service*, not to a person, and is refused however well-formed it is.
   */
  machineClients: ReadonlySet<string>;
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
    const jti = typeof payload.jti === "string" ? payload.jti.trim() : "";
    if (!jti) {
      throw new ActorAssertionError("ACTOR_ASSERTION_INVALID", "actor assertion carries no jti");
    }
    if (typeof payload.exp !== "number") {
      throw new ActorAssertionError("ACTOR_ASSERTION_INVALID", "actor assertion carries no expiry");
    }
    // A client-credentials token has no human behind it. Accepting one would let the machine
    // account grant roles in nobody's name, which is what the assertion exists to prevent.
    //
    // Comparing `azp` with `sub` does NOT detect this: Keycloak gives a service-account token
    // `azp = <clientId>` and `sub = <service-account user uuid>`, so they are never equal. The two
    // checks that do work are the issuing client and the service-account username convention.
    const azp = typeof payload.azp === "string" ? payload.azp : null;
    const username = typeof payload.preferred_username === "string" ? payload.preferred_username : "";
    if ((azp && input.machineClients.has(azp)) || username.startsWith("service-account-")) {
      throw new ActorAssertionError("ACTOR_ASSERTION_INVALID", "actor assertion is a machine token");
    }
    return { issuer, subject, jti, authorizedParty: azp, expiresAt: new Date(payload.exp * 1000) };
  };
}

export interface AssertionBinding {
  method: string;
  path: string;
  hubRequestId?: string | null | undefined;
  actorAccountId?: string | null | undefined;
}

/**
 * §2.11 gap 1: spend the assertion, once.
 *
 * The insert is the check. A second presentation of the same jti collides on the primary key and is
 * refused, so a captured assertion is worthless the moment the legitimate request lands. What it
 * does not stop is a race — an attacker who captures the assertion and gets in first — and that is
 * why the row records what the assertion was spent on: an unrecognised grant can then be traced to
 * a specific presentation instead of being invisible.
 *
 * Spending happens before the grant is attempted, so a refused grant still burns the assertion.
 * That is deliberate: one assertion is one attempt, and retrying needs a fresh one from SQ Hub.
 *
 * Expired rows are swept here rather than by a scheduled job. They are only useful until their own
 * expiry, assertions over 60 seconds old are refused anyway, and the table therefore stays at about
 * the number of grants made in a minute.
 */
export async function spendActorAssertion(
  db: Pick<Pool, "query"> | PoolClient,
  claims: ActorAssertionClaims,
  binding: AssertionBinding,
): Promise<void> {
  // The margin is for clock skew, not for tidiness: jose judges `exp` by the app server's clock
  // and this DELETE by the database's. Sweeping exactly at expiry would, on a database running
  // ahead, drop a row while jose would still accept the token — restoring replay for that window.
  await db.query("DELETE FROM auth_actor_assertions WHERE expires_at < now() - interval '15 minutes'");
  try {
    await db.query(
      `INSERT INTO auth_actor_assertions
         (issuer, jti, expires_at, request_method, request_path, hub_request_id, actor_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [claims.issuer, claims.jti, claims.expiresAt, binding.method, binding.path,
        binding.hubRequestId ?? null, binding.actorAccountId ?? null],
    );
  } catch (error) {
    // Named, not just the SQLSTATE: today this table has one unique constraint, but a second one
    // added later would otherwise be reported as a replay that never happened.
    if (typeof error === "object" && error !== null
      && (error as { code?: string }).code === "23505"
      && String((error as { constraint?: string }).constraint ?? "").includes("auth_actor_assertions_pkey")) {
      throw new ActorAssertionError("ACTOR_ASSERTION_SPENT", "actor assertion has already been used");
    }
    throw error;
  }
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
