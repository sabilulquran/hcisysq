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
  | "JWKS_UNAVAILABLE";

const STATUS: Record<GovernanceTokenErrorCode, number> = {
  INVALID_TOKEN: 401,
  FORBIDDEN_AUDIENCE: 403,
  FORBIDDEN_CLIENT: 403,
  JWKS_UNAVAILABLE: 503,
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

      return { issuer, subject: payload.sub };
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
