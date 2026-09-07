import type { AdminPermission } from "../../auth/permissions.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../../config/env.js";
import { requirePermissionsFromCookie } from "../../auth/authorization.js";
import { AuthError, AuthService, type AuthPrincipal } from "../../auth/service.js";
import { biometricKeyringReadiness } from "./biometric-crypto.js";
import {
  getBiometricControlPlaneSummary,
  listBiometricControlPlaneCredentials,
  reencryptBiometricCredentialBatch,
} from "./biometric-control-plane.js";

const summaryQuerySchema = z.object({
  deviceId: z.string().uuid().optional(),
});

const credentialsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(25),
  employeeId: z.string().uuid().optional(),
  originDeviceId: z.string().uuid().optional(),
  modality: z.enum(["fingerprint", "face", "palm", "bio_photo"]).optional(),
  lifecycleReviewOnly: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
});

const reencryptSchema = z.object({
  confirmation: z.literal("REENCRYPT_VAULT"),
  limit: z.number().int().min(1).max(100).default(25),
  credentialIds: z.array(z.string().uuid()).min(1).max(100).optional(),
});

async function authenticate(
  auth: AuthService,
  request: FastifyRequest,
  reply: FastifyReply,
    permission: AdminPermission | readonly AdminPermission[],
  ): Promise<AuthPrincipal | null> {
  try {
    return await requirePermissionsFromCookie(auth, request.headers.cookie, permission);
  } catch (error) {
    if (error instanceof AuthError) {
      reply.header("Cache-Control", "no-store");
      await reply.status(error.statusCode).send({ code: error.code, message: error.message });
      return null;
    }
    throw error;
  }
}

export async function registerAdmsBiometricControlPlaneRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
) {
  if (!config.AUTH_ENCRYPTION_KEY) {
    throw new Error("AUTH_ENCRYPTION_KEY is required for biometric control-plane routes");
  }
  const auth = new AuthService(
    pool,
    config.AUTH_ENCRYPTION_KEY,
    config.AUTH_SESSION_TTL_HOURS,
    config.NODE_ENV === "production",
  );

  app.get("/admin/attendance/adms/biometric-control-plane", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.biometrics");
    if (!principal) return;
    const query = summaryQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({
        code: "INVALID_BIOMETRIC_CONTROL_PLANE_QUERY",
        message: "Filter control plane biometric tidak valid.",
      });
    }

    if (query.data.deviceId) {
      const exists = await pool.query<{ id: string }>(
        `SELECT id FROM attendance_adms_devices WHERE id = $1`,
        [query.data.deviceId],
      );
      if (!exists.rows[0]) {
        return reply.status(404).send({ code: "ADMS_DEVICE_NOT_FOUND", message: "Mesin tidak ditemukan." });
      }
    }

    const item = await getBiometricControlPlaneSummary(pool, config, query.data.deviceId);
    reply.header("Cache-Control", "no-store");
    return reply.send({ item });
  });

  app.get("/admin/attendance/adms/biometric-control-plane/credentials", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.biometrics");
    if (!principal) return;
    const query = credentialsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({
        code: "INVALID_BIOMETRIC_CREDENTIAL_QUERY",
        message: "Filter credential biometric tidak valid.",
      });
    }

    const result = await listBiometricControlPlaneCredentials(pool, {
      page: query.data.page,
      pageSize: query.data.pageSize,
      ...(query.data.employeeId ? { employeeId: query.data.employeeId } : {}),
      ...(query.data.originDeviceId ? { originDeviceId: query.data.originDeviceId } : {}),
      ...(query.data.modality ? { modality: query.data.modality } : {}),
      ...(query.data.lifecycleReviewOnly !== undefined
        ? { lifecycleReviewOnly: query.data.lifecycleReviewOnly }
        : {}),
    });
    reply.header("Cache-Control", "no-store");
    return reply.send(result);
  });

  app.post("/admin/attendance/adms/biometric-control-plane/reencrypt", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.biometrics");
    if (!principal) return;
    const body = reencryptSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({
        code: "INVALID_BIOMETRIC_REENCRYPT_REQUEST",
        message: "Konfirmasi, credential, atau batas rotasi envelope tidak valid.",
      });
    }

    const keyring = biometricKeyringReadiness(config);
    if (!keyring.ready) {
      return reply.status(409).send({
        code: "BIOMETRIC_KEYRING_NOT_READY",
        message: "Keyring biometric belum dikonfigurasi untuk maintenance vault.",
      });
    }

    try {
      const result = await reencryptBiometricCredentialBatch(pool, config, {
        actorAccountId: principal.id,
        limit: body.data.limit,
        ...(body.data.credentialIds ? { credentialIds: body.data.credentialIds } : {}),
      });
      reply.header("Cache-Control", "no-store");
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      if (
        message === "Unsupported biometric envelope version" ||
        message === "Biometric encryption key is unavailable" ||
        message === "Biometric payload integrity check failed" ||
        message === "Biometric payload length check failed"
      ) {
        return reply.status(409).send({
          code: "BIOMETRIC_VAULT_MAINTENANCE_BLOCKED",
          message: "Rotasi envelope dihentikan karena vault membutuhkan pemeriksaan manual. Tidak ada payload yang dikembalikan.",
        });
      }
      throw error;
    }
  });
}
