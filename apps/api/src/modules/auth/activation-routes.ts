import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import {
  AccountActivationError,
  AccountActivationService,
  ACCOUNT_ACTIVATION_PASSWORD_MAX_LENGTH,
  ACCOUNT_ACTIVATION_PASSWORD_MIN_LENGTH,
} from "./account-activation.js";
import type { RequestContext } from "./service.js";
import type { ApiConfig } from "../../config/env.js";

const tokenSchema = z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/);
const previewBodySchema = z.object({ token: tokenSchema });
const activationBodySchema = z.object({
  token: tokenSchema,
  password: z
    .string()
    .min(ACCOUNT_ACTIVATION_PASSWORD_MIN_LENGTH)
    .max(ACCOUNT_ACTIVATION_PASSWORD_MAX_LENGTH),
});

function requestContext(request: FastifyRequest): RequestContext {
  return {
    ipAddress: request.ip || null,
    userAgent: request.headers["user-agent"]?.slice(0, 500) ?? null,
  };
}

async function sendActivationError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof AccountActivationError)) throw error;
  return reply.status(error.statusCode).send({ code: error.code, message: error.message });
}

/**
 * AUTH-002 (closing note 2026-11-11): with AUTH_MODE=oidc nobody signs in to HCIS with a
 * local password, so a local activation link can only mislead. Employees are activated
 * with "Kirim aktivasi" (Akun SQ e-mail), Organ Yayasan accounts through the Akun SQ
 * identity mapping, and password recovery is "Lupa kata sandi?" on the Akun SQ page.
 */
export const ACTIVATION_USES_AKUN_SQ = {
  code: "ACTIVATION_USES_AKUN_SQ",
  message:
    "HCIS memakai Akun SQ. Aktifkan akun lewat email dari Akun SQ, lalu masuk dari halaman login. Lupa kata sandi? Pakai tautan \"Lupa kata sandi?\" di halaman Akun SQ.",
} as const;

export async function registerAccountActivationRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: Pick<ApiConfig, "AUTH_MODE">,
) {
  const activation = new AccountActivationService(pool);
  const usesAkunSq = config.AUTH_MODE === "oidc";

  app.post("/auth/activation/preview", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (usesAkunSq) return reply.status(409).send(ACTIVATION_USES_AKUN_SQ);
    const body = previewBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(410).send({
        code: "ACTIVATION_LINK_INVALID",
        message: "Link aktivasi tidak berlaku atau sudah kedaluwarsa. Minta link aktivasi baru kepada administrator.",
      });
    }

    try {
      return reply.send(await activation.preview(body.data.token));
    } catch (error) {
      return sendActivationError(reply, error);
    }
  });

  app.post("/auth/activation/complete", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (usesAkunSq) return reply.status(409).send(ACTIVATION_USES_AKUN_SQ);
    const body = activationBodySchema.safeParse(request.body);
    if (!body.success) {
      const tokenValid = previewBodySchema.safeParse(request.body).success;
      if (!tokenValid) {
        return reply.status(410).send({
          code: "ACTIVATION_LINK_INVALID",
          message: "Link aktivasi tidak berlaku atau sudah kedaluwarsa. Minta link aktivasi baru kepada administrator.",
        });
      }
      return reply.status(400).send({
        code: "INVALID_ACTIVATION_PASSWORD",
        message: `Kata sandi harus ${ACCOUNT_ACTIVATION_PASSWORD_MIN_LENGTH}-${ACCOUNT_ACTIVATION_PASSWORD_MAX_LENGTH} karakter.`,
      });
    }

    try {
      const result = await activation.activate(
        body.data.token,
        body.data.password,
        requestContext(request),
      );
      return reply.send({
        status: "active",
        principalType: result.principalType,
        message: "Account berhasil diaktifkan. Silakan masuk menggunakan email dan kata sandi Anda.",
      });
    } catch (error) {
      return sendActivationError(reply, error);
    }
  });
}
