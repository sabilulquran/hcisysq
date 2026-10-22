import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import { getOidcRuntimeConfig, type ApiConfig } from "../../config/env.js";
import { SqHubApplicationAccessClient } from "./application-access.js";
import { hashSessionToken } from "./crypto.js";
import { LauncherService, type LauncherIdentity } from "./launcher.js";
import { OidcProvider } from "./oidc-provider.js";
import { OidcLoginService, TRANSACTION_TTL_MINUTES } from "./oidc-service.js";
import { safeReturnTo } from "./return-to.js";
import {
  AUTH_COOKIE_NAME,
  AuthError,
  AuthService,
  readCookie,
  readOidcIdTokenCookie,
  type RequestContext,
} from "./service.js";

const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(256),
  mfaCode: z.string().trim().min(1).max(64).optional(),
});

function requestContext(request: FastifyRequest): RequestContext {
  return {
    ipAddress: request.ip || null,
    userAgent: request.headers["user-agent"]?.slice(0, 500) ?? null,
  };
}

function sendAuthError(reply: FastifyReply, error: AuthError) {
  return reply.status(error.statusCode).send({
    code: error.code,
    message: error.message,
  });
}

export type SafeOidcFailureCategory =
  | "access_denied"
  | "access_unavailable"
  | "account_inactive"
  | "oidc_failed";

export function safeOidcFailureCategory(error: unknown): SafeOidcFailureCategory {
  if (!(error instanceof AuthError)) return "oidc_failed";

  switch (error.code) {
    case "HCIS_ACCESS_DENIED":
      return "access_denied";
    case "APPLICATION_ACCESS_UNAVAILABLE":
      return "access_unavailable";
    case "ACCOUNT_INACTIVE":
      return "account_inactive";
    default:
      return "oidc_failed";
  }
}

export interface AuthRouteOptions {
  /** Test seam for AUTH-013; production builds it from the OIDC runtime config. */
  launcher?: LauncherService;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
  options: AuthRouteOptions = {},
) {
  if (!config.AUTH_ENCRYPTION_KEY) {
    throw new Error("AUTH_ENCRYPTION_KEY is required when the API auth routes are enabled");
  }

  const auth = new AuthService(
    pool,
    config.AUTH_ENCRYPTION_KEY,
    config.AUTH_SESSION_TTL_HOURS,
    config.NODE_ENV === "production",
  );

  let oidcLogin: OidcLoginService | null = null;
  // Local mode has no SQ Hub identity: the launcher always reports unavailable (current-app tile).
  let launcher = options.launcher ?? new LauncherService(null);
  if (config.AUTH_MODE === "oidc") {
    const oidcConfig = getOidcRuntimeConfig(config);
    const provider = new OidcProvider({
      issuer: oidcConfig.issuer,
      clientId: oidcConfig.clientId,
      clientSecret: oidcConfig.clientSecret,
      redirectUri: oidcConfig.redirectUri,
      postLogoutRedirectUri: oidcConfig.postLogoutRedirectUri,
    });
    const applicationAccess = new SqHubApplicationAccessClient(
      oidcConfig.issuer,
      oidcConfig.machineClientId,
      oidcConfig.machineClientSecret,
      oidcConfig.applicationAccessUrl,
      oidcConfig.applicationLauncherUrl,
    );
    oidcLogin = new OidcLoginService(pool, provider, applicationAccess, auth);
    launcher = options.launcher ?? new LauncherService(applicationAccess);
  }

  app.get("/auth/mode", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return reply.send({ mode: config.AUTH_MODE });
  });

  app.post("/auth/login", async (request, reply) => {
    reply.header("Cache-Control", "no-store");

    if (config.AUTH_MODE !== "local") {
      return reply.status(404).send({
        code: "LOCAL_AUTH_DISABLED",
        message: "Autentikasi lokal tidak tersedia.",
      });
    }

    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        code: "INVALID_REQUEST",
        message: "Format email atau kredensial tidak valid.",
      });
    }

    try {
      const result = await auth.login(parsed.data, requestContext(request));
      reply.header("Set-Cookie", result.setCookie);
      return reply.send({ ...result.session, authorization: await auth.getAuthorizationContext(result.session.principal) });
    } catch (error) {
      if (error instanceof AuthError) return sendAuthError(reply, error);
      throw error;
    }
  });

  app.get("/auth/oidc/start", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!oidcLogin) {
      return reply.status(404).send({
        code: "OIDC_AUTH_DISABLED",
        message: "Login Akun SQ belum aktif pada environment ini.",
      });
    }

    try {
      // An unsafe or missing returnTo is ignored: sign-in still starts and lands on "/".
      const { returnTo } = (request.query ?? {}) as { returnTo?: unknown };
      const { url, stateHash } = await oidcLogin.begin(safeReturnTo(returnTo));
      reply.header("Set-Cookie", auth.buildOidcStateCookie(stateHash, TRANSACTION_TTL_MINUTES * 60));
      return reply.redirect(url.href);
    } catch {
      return reply.status(503).send({
        code: "IDENTITY_UNAVAILABLE",
        message: "Akun SQ belum dapat dihubungi. Coba lagi.",
      });
    }
  });

  app.get("/auth/callback", { logLevel: "silent" }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!oidcLogin) {
      return reply.status(404).send({
        code: "OIDC_AUTH_DISABLED",
        message: "Login Akun SQ belum aktif pada environment ini.",
      });
    }

    const oidcConfig = getOidcRuntimeConfig(config);
    const callbackUrl = new URL(request.url, new URL(oidcConfig.redirectUri).origin);
    const state = callbackUrl.searchParams.get("state");
    // SEC-05: the per-state cookie is single-use; drop it whatever the outcome.
    const clearState = state ? [auth.clearOidcStateCookie(oidcLogin.hashState(state))] : [];

    try {
      const result = await oidcLogin.complete(
        callbackUrl,
        requestContext(request),
        (stateHash) => auth.hasOidcStateCookie(request.headers.cookie, stateHash),
      );
      reply.header(
        "Set-Cookie",
        result.idToken
          ? [result.setCookie, auth.buildOidcIdTokenCookie(result.idToken), ...clearState]
          : [result.setCookie, auth.clearOidcIdTokenCookie(), ...clearState],
      );
      return reply.redirect(result.returnTo ?? "/");
    } catch (error) {
      if (clearState.length > 0) reply.header("Set-Cookie", clearState);
      return reply.redirect(`/?authError=${safeOidcFailureCategory(error)}`);
    }
  });

  app.get("/auth/me", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const token = readCookie(request.headers.cookie, AUTH_COOKIE_NAME);
    const session = await auth.getSession(token);

    if (!session) {
      return reply.status(401).send({
        code: "UNAUTHENTICATED",
        message: "Sesi tidak ditemukan atau sudah berakhir.",
      });
    }

    return reply.send({ ...session, authorization: await auth.getAuthorizationContext(session.principal) });
  });

  // AUTH-013: the SQ Hub applications this session's Akun SQ identity may open.
  app.get("/auth/launcher", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const token = readCookie(request.headers.cookie, AUTH_COOKIE_NAME);
    const session = await auth.getSession(token);
    if (!session || !token) {
      return reply.status(401).send({
        code: "UNAUTHENTICATED",
        message: "Sesi tidak ditemukan atau sudah berakhir.",
      });
    }

    const result = await launcher.get(hashSessionToken(token), async () => {
      const identity = await pool.query<{ issuer: string | null; subject: string | null }>(
        `SELECT identity_issuer AS issuer, identity_subject AS subject FROM accounts WHERE id = $1`,
        [session.principal.id],
      );
      const row = identity.rows[0];
      return row?.issuer && row.subject ? ({ issuer: row.issuer, subject: row.subject } satisfies LauncherIdentity) : null;
    });
    return reply.send(result);
  });

  app.post("/auth/logout", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const token = readCookie(request.headers.cookie, AUTH_COOKIE_NAME);
    const idTokenHint = readOidcIdTokenCookie(request.headers.cookie);
    await auth.logout(token, requestContext(request));
    reply.header("Set-Cookie", [auth.clearSessionCookie(), auth.clearOidcIdTokenCookie()]);

    if (!oidcLogin) return reply.status(204).send();

    try {
      return reply.send({ logoutUrl: (await oidcLogin.buildLogoutUrl(idTokenHint)).href });
    } catch {
      return reply.send({ logoutUrl: null });
    }
  });
}
