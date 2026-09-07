import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import { getOidcRuntimeConfig, type ApiConfig } from "../../config/env.js";
import { SqHubApplicationAccessClient } from "./application-access.js";
import { OidcProvider } from "./oidc-provider.js";
import { OidcLoginService } from "./oidc-service.js";
import {
  AUTH_COOKIE_NAME,
  AuthError,
  AuthService,
  readCookie,
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

export async function registerAuthRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
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
    );
    oidcLogin = new OidcLoginService(pool, provider, applicationAccess, auth);
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

  app.get("/auth/oidc/start", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!oidcLogin) {
      return reply.status(404).send({
        code: "OIDC_AUTH_DISABLED",
        message: "SQ Identity tidak aktif pada environment ini.",
      });
    }

    try {
      const authorizationUrl = await oidcLogin.begin();
      return reply.redirect(authorizationUrl.href);
    } catch {
      return reply.status(503).send({
        code: "IDENTITY_UNAVAILABLE",
        message: "SQ Identity belum dapat dihubungi. Coba lagi.",
      });
    }
  });

  app.get("/auth/callback", { logLevel: "silent" }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!oidcLogin) {
      return reply.status(404).send({
        code: "OIDC_AUTH_DISABLED",
        message: "SQ Identity tidak aktif pada environment ini.",
      });
    }

    const oidcConfig = getOidcRuntimeConfig(config);
    const callbackUrl = new URL(request.url, new URL(oidcConfig.redirectUri).origin);

    try {
      const result = await oidcLogin.complete(callbackUrl, requestContext(request));
      reply.header("Set-Cookie", result.setCookie);
      return reply.redirect("/");
    } catch (error) {
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

  app.post("/auth/logout", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const token = readCookie(request.headers.cookie, AUTH_COOKIE_NAME);
    await auth.logout(token, requestContext(request));
    reply.header("Set-Cookie", auth.clearSessionCookie());

    if (!oidcLogin) return reply.status(204).send();

    try {
      return reply.send({ logoutUrl: (await oidcLogin.buildLogoutUrl()).href });
    } catch {
      return reply.send({ logoutUrl: null });
    }
  });
}
