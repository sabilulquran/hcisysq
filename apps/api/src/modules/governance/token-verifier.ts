import { createRemoteJWKSet, customFetch, errors, jwtVerify } from "jose";

// ORG-010 §3.2: verifies the Keycloak token SQ Hub obtains by token exchange for the HCIS audience.
// Same jose pattern and deadline as organization-directory/machine-auth.ts. Errors never carry the
// token or its claims.

const VERIFICATION_DEADLINE_MS = 3_000;
const JWKS_TRANSPORT_TIMEOUT_MS = 2_500;
const CLOCK_SKEW_SECONDS = 30;

export type GovernanceTokenErrorCode =
  | "INVALID_TOKEN"
  | "FORBIDDEN_AUDIENCE"
  | "FORBIDDEN_CLIENT"
  | "JWKS_UNAVAILABLE"
  // ORG-015-2: only the decision token carries these two.
  | "STEP_UP_REQUIRED"
  | "TOKEN_TOO_OLD";

const STATUS: Record<GovernanceTokenErrorCode, number> = {
  INVALID_TOKEN: 401,
  FORBIDDEN_AUDIENCE: 403,
  FORBIDDEN_CLIENT: 403,
  JWKS_UNAVAILABLE: 503,
  STEP_UP_REQUIRED: 403,
  TOKEN_TOO_OLD: 401,
};

export class GovernanceTokenError extends Error {
  readonly statusCode: number;

  constructor(public readonly code: GovernanceTokenErrorCode) {
    super(code);
    this.name = "GovernanceTokenError";
    this.statusCode = STATUS[code];
  }
}

export interface GovernanceIdentity {
  issuer: string;
  subject: string;
  /** The allowlisted `azp`; ORG-014 narrows the employee list to the portal client. */
  client: string;
  /** ORG-015-2: present on a decision token, which is spent once under this id. */
  jti?: string;
  /** ORG-015-2: the decision token's own expiry, used to sweep the spent-token row. */
  expiresAt?: Date;
}

/**
 * ORG-015-2. A decision is a mutation, so its token must prove more than a read token: the
 * Level of Authentication reached with TOTP, an age measured from `iat` rather than `exp`, and a
 * `jti` the domain can spend. Reading tokens pass `undefined` and keep ORG-010 behaviour exactly.
 */
export interface GovernanceStepUpRequirement {
  /** The `acr` value the token must carry, ADR-0012 D4 (`"2"`). */
  acr: string;
  /** Maximum age from `iat`, in seconds (60). An older token is refused even if unexpired. */
  maxAgeSeconds: number;
}

export type VerifyGovernanceToken = (token: string) => Promise<GovernanceIdentity>;

interface ResolverGeneration {
  jwks: ReturnType<typeof createRemoteJWKSet>;
  abort: AbortController;
}

function isKeySetUnavailable(error: unknown): boolean {
  return error instanceof errors.JWKSTimeout
    || error instanceof errors.JWKSInvalid
    || (error instanceof errors.JOSEError && error.code === "ERR_JOSE_GENERIC")
    || error instanceof TypeError
    || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name));
}

export function createGovernanceTokenVerifier(input: {
  issuer: string;
  audience: string;
  allowedClients: ReadonlySet<string>;
  /** ORG-015-2: set for the decision audience only. */
  stepUp?: GovernanceStepUpRequirement;
}): VerifyGovernanceToken {
  const issuer = input.issuer.replace(/\/$/, "");
  const jwksUrl = new URL(`${issuer}/protocol/openid-connect/certs`);
  let current: ResolverGeneration | undefined;

  function generation(): ResolverGeneration {
    if (current) return current;
    const abort = new AbortController();
    current = {
      abort,
      jwks: createRemoteJWKSet(jwksUrl, {
        timeoutDuration: JWKS_TRANSPORT_TIMEOUT_MS,
        [customFetch]: (url, options) =>
          fetch(url, {
            ...options,
            signal: AbortSignal.any([abort.signal, ...(options.signal ? [options.signal] : [])]),
          }),
      }),
    };
    return current;
  }

  function discard(active: ResolverGeneration) {
    if (current === active) current = undefined;
    active.abort.abort();
  }

  return async (token: string) => {
    const active = generation();
    const started = performance.now();
    const deadlineError = new GovernanceTokenError("JWKS_UNAVAILABLE");
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      // 1-3: signature (RS256 only), issuer, exp/nbf with bounded skew.
      const { payload } = await Promise.race([
        jwtVerify(token, active.jwks, {
          issuer,
          algorithms: ["RS256"],
          clockTolerance: CLOCK_SKEW_SECONDS,
          requiredClaims: ["exp", "iat", "sub"],
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            discard(active);
            reject(deadlineError);
          }, VERIFICATION_DEADLINE_MS);
        }),
      ]);

      if (performance.now() - started >= VERIFICATION_DEADLINE_MS) {
        discard(active);
        throw deadlineError;
      }

      const nowSeconds = Math.floor(Date.now() / 1000);
      if (typeof payload.iat !== "number" || payload.iat > nowSeconds + CLOCK_SKEW_SECONDS) {
        throw new GovernanceTokenError("INVALID_TOKEN");
      }
      // 5: an access token only; ID and refresh tokens carry another typ.
      if (payload.typ !== "Bearer") throw new GovernanceTokenError("INVALID_TOKEN");
      // 7: subject present and bounded like the identity mapping.
      if (typeof payload.sub !== "string" || payload.sub.length < 1 || payload.sub.length > 512) {
        throw new GovernanceTokenError("INVALID_TOKEN");
      }
      // 4: audience contains the HCIS client.
      const audiences = typeof payload.aud === "string" ? [payload.aud] : Array.isArray(payload.aud) ? payload.aud : [];
      if (!audiences.includes(input.audience)) throw new GovernanceTokenError("FORBIDDEN_AUDIENCE");
      // 6: only tokens exchanged by the allowlisted SQ Hub client.
      if (typeof payload.azp !== "string" || !input.allowedClients.has(payload.azp)) {
        throw new GovernanceTokenError("FORBIDDEN_CLIENT");
      }

      if (!input.stepUp) return { issuer, subject: payload.sub, client: payload.azp };

      // ORG-015-2 step 3: proof of TOTP, as a Level of Authentication the realm issues. A trusted
      // device and a recovery code do not reach it, so neither can approve anything.
      if (payload.acr !== input.stepUp.acr) throw new GovernanceTokenError("STEP_UP_REQUIRED");
      // Step 4: age from `iat`, not from `exp`. Keycloak's own lifetime is minutes long; this is
      // the window in which a token captured in flight is still worth something.
      if (payload.iat + input.stepUp.maxAgeSeconds < nowSeconds - CLOCK_SKEW_SECONDS) {
        throw new GovernanceTokenError("TOKEN_TOO_OLD");
      }
      // Step 5: without a `jti` the token could not be spent, so it would stay replayable for its
      // whole life. Refusing it is the only way the single-use rule can hold.
      const jti = typeof payload.jti === "string" ? payload.jti.trim() : "";
      if (!jti || jti.length > 255) throw new GovernanceTokenError("INVALID_TOKEN");
      if (typeof payload.exp !== "number") throw new GovernanceTokenError("INVALID_TOKEN");

      return {
        issuer,
        subject: payload.sub,
        client: payload.azp,
        jti,
        expiresAt: new Date(payload.exp * 1000),
      };
    } catch (error) {
      if (error instanceof GovernanceTokenError) throw error;
      if (isKeySetUnavailable(error)) {
        discard(active);
        throw new GovernanceTokenError("JWKS_UNAVAILABLE");
      }
      throw new GovernanceTokenError("INVALID_TOKEN");
    } finally {
      clearTimeout(timer);
    }
  };
}
