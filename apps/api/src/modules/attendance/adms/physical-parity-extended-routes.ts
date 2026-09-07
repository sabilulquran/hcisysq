import type { AdminPermission } from "../../auth/permissions.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../../config/env.js";
import { requirePermissionsFromCookie } from "../../auth/authorization.js";
import { AuthError, AuthService, type AuthPrincipal } from "../../auth/service.js";
import {
  activeTimeSyncWireCommand,
  firmwareUpgradeWireCommand,
  type PhysicalCapabilityKey,
} from "./physical-parity-protocol.js";
import { queuePhysicalOperation } from "./physical-parity-service.js";

const packageQuerySchema = z.object({
  targetModel: z.string().trim().min(1).max(160),
  targetVersion: z.string().trim().min(1).max(160),
  filename: z.string().trim().min(1).max(255),
});
const deviceParamsSchema = z.object({ deviceId: z.string().uuid() });
const timeSyncBodySchema = z.object({
  mode: z.enum(["canary", "execute"]).default("canary"),
  confirmation: z.string(),
});
const firmwareBodySchema = z.object({
  packageId: z.string().uuid(),
  mode: z.enum(["canary", "execute"]).default("canary"),
  confirmation: z.string(),
});

class ExtendedParityError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ExtendedParityError";
  }
}

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

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof ExtendedParityError) {
    reply.header("Cache-Control", "no-store");
    return reply.status(error.statusCode).send({ code: error.code, message: error.message });
  }
  if (error instanceof Error) {
    if (
      error.message.startsWith("ADMS device") ||
      error.message.startsWith("Physical operation") ||
      error.message.startsWith("Firmware ") ||
      error.message.startsWith("Device synchronization")
    ) {
      reply.header("Cache-Control", "no-store");
      return reply.status(409).send({ code: "PHYSICAL_OPERATION_CONFLICT", message: error.message });
    }
  }
  throw error;
}

async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function capabilityState(db: Pool | PoolClient, deviceId: string, capabilityKey: PhysicalCapabilityKey) {
  const result = await db.query<{ state: string }>(
    `SELECT state FROM attendance_adms_physical_capabilities
     WHERE device_id = $1 AND capability_key = $2`,
    [deviceId, capabilityKey],
  );
  return result.rows[0]?.state ?? "documented";
}

async function enforceMode(
  db: Pool | PoolClient,
  deviceId: string,
  capabilityKey: PhysicalCapabilityKey,
  mode: "canary" | "execute",
) {
  const state = await capabilityState(db, deviceId, capabilityKey);
  if (state === "canary_pending") {
    throw new ExtendedParityError(409, "PHYSICAL_CANARY_PENDING", `${capabilityKey} masih memiliki physical canary yang menunggu result.`);
  }
  if (["unsupported", "blocked"].includes(state)) {
    throw new ExtendedParityError(409, "PHYSICAL_CAPABILITY_BLOCKED", `${capabilityKey} ditandai ${state} pada mesin ini.`);
  }
  if (mode === "execute" && state !== "verified") {
    throw new ExtendedParityError(409, "PHYSICAL_CAPABILITY_NOT_VERIFIED", `${capabilityKey} belum lolos physical canary.`);
  }
}

function requireConfirmation(actual: string, expected: string) {
  if (actual !== expected) {
    throw new ExtendedParityError(400, "PHYSICAL_CONFIRMATION_MISMATCH", `Ketik persis: ${expected}`);
  }
}

async function writePhysicalAudit(
  client: PoolClient,
  input: {
    actorAccountId: string;
    deviceId: string;
    operationId: string;
    capabilityKey: PhysicalCapabilityKey;
    operationKey: string;
    mode: "canary" | "execute";
  },
) {
  await client.query(
    `INSERT INTO attendance_adms_admin_audit_events (
       id, actor_account_id, action, device_id, mapping_id, before_state, after_state
     ) VALUES ($1, $2, 'physical_operation_requested', $3, NULL, NULL, $4::jsonb)`,
    [
      randomUUID(),
      input.actorAccountId,
      input.deviceId,
      JSON.stringify({
        operationId: input.operationId,
        capabilityKey: input.capabilityKey,
        operationKey: input.operationKey,
        mode: input.mode,
        commandCount: 1,
      }),
    ],
  );
}

export async function registerAdmsPhysicalParityExtendedRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required for physical parity routes");
  const auth = new AuthService(
    pool,
    config.AUTH_ENCRYPTION_KEY,
    config.AUTH_SESSION_TTL_HOURS,
    config.NODE_ENV === "production",
  );

  app.get("/admin/attendance/adms/firmware-packages", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.firmware");
    if (!principal) return;
    const result = await pool.query<{
      id: string;
      targetModel: string;
      targetVersion: string;
      filename: string;
      byteLength: number;
      createdAt: Date;
    }>(
      `SELECT id, target_model AS "targetModel", target_version AS "targetVersion",
              filename, byte_length AS "byteLength", created_at AS "createdAt"
       FROM attendance_adms_firmware_packages
       ORDER BY created_at DESC
       LIMIT 100`,
    );
    reply.header("Cache-Control", "no-store");
    return reply.send({ items: result.rows });
  });

  app.post(
    "/admin/attendance/adms/firmware-packages",
    { bodyLimit: 128 * 1024 * 1024 },
    async (request, reply) => {
      const principal = await authenticate(auth, request, reply, "attendance.devices.firmware");
      if (!principal) return;
      const query = packageQuerySchema.safeParse(request.query);
      if (!query.success || !Buffer.isBuffer(request.body) || request.body.length === 0) {
        return reply.status(400).send({ code: "INVALID_FIRMWARE_PACKAGE", message: "Metadata atau binary firmware tidak valid." });
      }
      if (request.body.length > 128 * 1024 * 1024) {
        return reply.status(413).send({ code: "FIRMWARE_TOO_LARGE", message: "Firmware melebihi 128 MiB." });
      }
      const md5 = createHash("md5").update(request.body).digest("hex");
      const sha256 = createHash("sha256").update(request.body).digest("hex");
      const id = randomUUID();
      const result = await pool.query<{ id: string }>(
        `INSERT INTO attendance_adms_firmware_packages (
           id, target_model, target_version, filename, md5, sha256,
           byte_length, payload, created_by_account_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (target_model, target_version, sha256) DO UPDATE
         SET filename = EXCLUDED.filename
         RETURNING id`,
        [
          id,
          query.data.targetModel,
          query.data.targetVersion,
          query.data.filename,
          md5,
          sha256,
          request.body.length,
          request.body,
          principal.id,
        ],
      );
      await pool.query(
        `INSERT INTO attendance_adms_admin_audit_events (
           id, actor_account_id, action, device_id, mapping_id, before_state, after_state
         ) VALUES ($1, $2, 'firmware_package_uploaded', NULL, NULL, NULL, $3::jsonb)`,
        [
          randomUUID(),
          principal.id,
          JSON.stringify({
            firmwarePackageId: result.rows[0]!.id,
            targetModel: query.data.targetModel,
            targetVersion: query.data.targetVersion,
            byteLength: request.body.length,
          }),
        ],
      );
      reply.header("Cache-Control", "no-store");
      return reply.status(201).send({
        item: {
          id: result.rows[0]!.id,
          targetModel: query.data.targetModel,
          targetVersion: query.data.targetVersion,
          filename: query.data.filename,
          byteLength: request.body.length,
        },
      });
    },
  );

  app.post("/admin/attendance/adms/devices/:deviceId/physical/time-sync", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.operate");
    if (!principal) return;
    const params = deviceParamsSchema.safeParse(request.params);
    const body = timeSyncBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ code: "INVALID_TIME_SYNC", message: "Permintaan sinkron waktu tidak valid." });
    }
    try {
      const queued = await withTransaction(pool, async (client) => {
        const device = await client.query<{ serialNumber: string; lifecycle: string; timezone: string }>(
          `SELECT serial_number AS "serialNumber", lifecycle, timezone
           FROM attendance_adms_devices WHERE id = $1 FOR UPDATE`,
          [params.data.deviceId],
        );
        const item = device.rows[0];
        if (!item) throw new ExtendedParityError(404, "ADMS_DEVICE_NOT_FOUND", "Mesin tidak ditemukan.");
        if (item.lifecycle !== "active") throw new ExtendedParityError(409, "ADMS_DEVICE_NOT_ACTIVE", "Mesin harus active.");
        requireConfirmation(body.data.confirmation, `SYNC TIME ${item.serialNumber}`);
        await enforceMode(client, params.data.deviceId, "time_sync", body.data.mode);
        const result = await queuePhysicalOperation(client, {
          deviceId: params.data.deviceId,
          capabilityKey: "time_sync",
          operationKey: "set_options_datetime",
          mode: body.data.mode,
          requestedByAccountId: principal.id,
          commands: [{ commandType: "device_option", wireCommand: activeTimeSyncWireCommand(new Date(), item.timezone) }],
          safeMetadata: { timezone: item.timezone },
        });
        await writePhysicalAudit(client, {
          actorAccountId: principal.id,
          deviceId: params.data.deviceId,
          operationId: result.operationId,
          capabilityKey: "time_sync",
          operationKey: "set_options_datetime",
          mode: body.data.mode,
        });
        return result;
      });
      reply.header("Cache-Control", "no-store");
      return reply.status(202).send({ operationId: queued.operationId, commandCount: 1 });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/admin/attendance/adms/devices/:deviceId/physical/firmware", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.firmware");
    if (!principal) return;
    const params = deviceParamsSchema.safeParse(request.params);
    const body = firmwareBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ code: "INVALID_FIRMWARE_UPGRADE", message: "Permintaan firmware tidak valid." });
    }
    try {
      const queued = await withTransaction(pool, async (client) => {
        const device = await client.query<{
          serialNumber: string;
          lifecycle: string;
          model: string | null;
          firmwareVersion: string | null;
        }>(
          `SELECT serial_number AS "serialNumber", lifecycle, model,
                  firmware_version AS "firmwareVersion"
           FROM attendance_adms_devices WHERE id = $1 FOR UPDATE`,
          [params.data.deviceId],
        );
        const item = device.rows[0];
        if (!item) throw new ExtendedParityError(404, "ADMS_DEVICE_NOT_FOUND", "Mesin tidak ditemukan.");
        if (item.lifecycle !== "active") throw new ExtendedParityError(409, "ADMS_DEVICE_NOT_ACTIVE", "Mesin harus active.");
        if (!item.model) throw new ExtendedParityError(409, "ADMS_DEVICE_MODEL_UNKNOWN", "Model mesin harus sudah terobservasi sebelum upgrade firmware.");
        const packages = await client.query<{
          id: string;
          targetModel: string;
          targetVersion: string;
          md5: string;
          byteLength: number;
        }>(
          `SELECT id, target_model AS "targetModel", target_version AS "targetVersion",
                  md5, byte_length AS "byteLength"
           FROM attendance_adms_firmware_packages WHERE id = $1`,
          [body.data.packageId],
        );
        const firmware = packages.rows[0];
        if (!firmware) throw new ExtendedParityError(404, "FIRMWARE_PACKAGE_NOT_FOUND", "Package firmware tidak ditemukan.");
        if (firmware.targetModel !== item.model) {
          throw new ExtendedParityError(409, "FIRMWARE_MODEL_MISMATCH", "Target model package tidak sama dengan model mesin.");
        }
        requireConfirmation(
          body.data.confirmation,
          `UPGRADE FIRMWARE ${item.serialNumber} ${firmware.targetVersion}`,
        );
        await enforceMode(client, params.data.deviceId, "firmware_upgrade", body.data.mode);

        const token = randomBytes(32).toString("base64url");
        const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
        const ticketId = randomUUID();
        await client.query(
          `INSERT INTO attendance_adms_firmware_download_tickets (
             id, package_id, device_id, token_sha256, expires_at
           ) VALUES ($1, $2, $3, $4, now() + interval '15 minutes')`,
          [ticketId, firmware.id, params.data.deviceId, tokenHash],
        );
        const wire = firmwareUpgradeWireCommand({
          checksumMd5: firmware.md5,
          byteLength: firmware.byteLength,
          urlPath: `/iclock/file?token=${token}`,
        });
        const result = await queuePhysicalOperation(client, {
          deviceId: params.data.deviceId,
          capabilityKey: "firmware_upgrade",
          operationKey: "firmware_upgrade",
          mode: body.data.mode,
          destructive: true,
          requestedByAccountId: principal.id,
          commands: [{ commandType: "firmware_upgrade", wireCommand: wire, firmwareTicketId: ticketId }],
          safeMetadata: {
            firmwarePackageId: firmware.id,
            targetVersion: firmware.targetVersion,
            previousVersion: item.firmwareVersion,
          },
          expiresInHours: 1,
        });
        await writePhysicalAudit(client, {
          actorAccountId: principal.id,
          deviceId: params.data.deviceId,
          operationId: result.operationId,
          capabilityKey: "firmware_upgrade",
          operationKey: "firmware_upgrade",
          mode: body.data.mode,
        });
        return result;
      });
      reply.header("Cache-Control", "no-store");
      return reply.status(202).send({ operationId: queued.operationId, commandCount: 1 });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
