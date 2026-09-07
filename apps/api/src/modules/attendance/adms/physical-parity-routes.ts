import type { AdminPermission } from "../../auth/permissions.js";
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../../config/env.js";
import { requirePermissionsFromCookie } from "../../auth/authorization.js";
import { AuthError, AuthService, type AuthPrincipal } from "../../auth/service.js";
import { biometricKeyringReadiness } from "./biometric-crypto.js";
import {
  clearAllDataWireCommand,
  clearAttendanceWireCommand,
  clearPhotoCacheWireCommand,
  faceDeleteWireCommand,
  fingerprintDeleteWireCommand,
  fingerprintEnrollWireCommand,
  fingerprintQueryWireCommand,
  messageDeleteWireCommand,
  PHYSICAL_CAPABILITY_KEYS,
  privateMessageAssignWireCommand,
  privateMessageUpsertWireCommand,
  publicMessageUpsertWireCommand,
  rebootWireCommand,
  reloadOptionsWireCommand,
  setDuplicatePunchPeriodWireCommand,
  unifiedBiometricDeleteWireCommand,
  unifiedBiometricQueryWireCommand,
  unifiedEnrollWireCommand,
  workCodeDeleteWireCommand,
  workCodeUpsertWireCommand,
  type PhysicalCapabilityKey,
  type UnifiedBiometricType,
} from "./physical-parity-protocol.js";
import {
  createTimeSyncCanary,
  listPhysicalCapabilities,
  queuePhysicalOperation,
} from "./physical-parity-service.js";
import { formatDeviceLocalTimestamp } from "./protocol.js";

const deviceParamsSchema = z.object({ deviceId: z.string().uuid() });
const modeSchema = z.enum(["canary", "execute"]);
const targetStateSchema = z.enum(["present", "absent"]);
const workCodeBodySchema = z.object({
  workCodeId: z.string().uuid(),
  desiredState: targetStateSchema,
  mode: modeSchema.default("canary"),
});
const messageBodySchema = z.object({
  messageId: z.string().uuid(),
  desiredState: targetStateSchema,
  mode: modeSchema.default("canary"),
  durationMinutes: z.number().int().min(1).max(525_600).optional(),
});
const duplicatePunchBodySchema = z.object({
  seconds: z.number().int().min(0).max(86_400),
  mode: modeSchema.default("canary"),
  confirmation: z.string(),
});
const rebootBodySchema = z.object({
  mode: modeSchema.default("canary"),
  confirmation: z.string(),
});
const biometricProtocolSchema = z.enum(["legacy_fingerprint", "unified"]);
const biometricTypeSchema = z.union([
  z.literal(1), z.literal(2), z.literal(6), z.literal(8), z.literal(9), z.literal(10),
]);
const biometricQueryBodySchema = z.object({
  employeeId: z.string().uuid(),
  protocol: biometricProtocolSchema,
  biometricType: biometricTypeSchema.default(1),
  slotIndex: z.number().int().min(0).max(255),
  mode: modeSchema.default("canary"),
});
const biometricEnrollBodySchema = z.object({
  employeeId: z.string().uuid(),
  protocol: biometricProtocolSchema,
  biometricType: biometricTypeSchema.default(1),
  slotIndex: z.number().int().min(0).max(255),
  retry: z.number().int().min(1).max(10).default(3),
  overwrite: z.boolean().default(true),
  mode: modeSchema.default("canary"),
  confirmation: z.string(),
});
const biometricRestoreBodySchema = z.object({
  credentialId: z.string().uuid(),
  mode: modeSchema.default("canary"),
  confirmation: z.string(),
});
const biometricDeleteBodySchema = z.object({
  credentialId: z.string().uuid(),
  mode: modeSchema.default("canary"),
  confirmation: z.string(),
});
const destructiveBodySchema = z.object({
  mode: modeSchema.default("canary"),
  confirmation: z.string(),
});
const passiveCanaryBodySchema = z.object({
  confirmation: z.string(),
});
const capabilityOverrideBodySchema = z.object({
  capabilityKey: z.enum(PHYSICAL_CAPABILITY_KEYS),
  state: z.enum(["unsupported", "blocked"]),
  confirmation: z.string(),
  note: z.string().trim().min(1).max(500),
});

class PhysicalParityError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PhysicalParityError";
  }
}

type DeviceRow = {
  id: string;
  serialNumber: string;
  displayName: string | null;
  lifecycle: "active" | "disabled" | "quarantined";
  timezone: string;
  model: string | null;
  firmwareVersion: string | null;
  biometricCollectionEnabled: boolean;
};

type CredentialRow = {
  id: string;
  employeeId: string;
  modality: "fingerprint" | "face" | "palm" | "bio_photo";
  slotIndex: number | null;
  vendorFormat: string;
  originDeviceId: string | null;
  lifecycle: "active" | "retired" | "destroyed";
  safeMetadata: Record<string, unknown>;
};

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
  if (error instanceof PhysicalParityError) {
    reply.header("Cache-Control", "no-store");
    return reply.status(error.statusCode).send({ code: error.code, message: error.message });
  }
  if (error instanceof Error) {
    const known = [
      "ADMS device not found",
      "ADMS device is not active",
      "ADMS device already has an active command",
      "Physical operation must contain",
      "Physical operation expiry is invalid",
    ].some((prefix) => error.message.startsWith(prefix));
    if (known) {
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

async function requireDevice(db: Pool | PoolClient, deviceId: string, lock = false) {
  const result = await db.query<DeviceRow>(
    `SELECT id, serial_number AS "serialNumber", display_name AS "displayName", lifecycle,
            timezone, model, firmware_version AS "firmwareVersion",
            biometric_collection_enabled AS "biometricCollectionEnabled"
     FROM attendance_adms_devices
     WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
    [deviceId],
  );
  const device = result.rows[0];
  if (!device) throw new PhysicalParityError(404, "ADMS_DEVICE_NOT_FOUND", "Mesin tidak ditemukan.");
  if (device.lifecycle !== "active") {
    throw new PhysicalParityError(409, "ADMS_DEVICE_NOT_ACTIVE", "Mesin harus berstatus active untuk operasi fisik.");
  }
  return device;
}

async function writeAudit(
  client: PoolClient,
  input: {
    actorAccountId: string;
    deviceId: string;
    action: "physical_operation_requested" | "physical_capability_updated";
    afterState: Record<string, unknown>;
  },
) {
  await client.query(
    `INSERT INTO attendance_adms_admin_audit_events (
       id, actor_account_id, action, device_id, mapping_id, before_state, after_state
     ) VALUES ($1, $2, $3, $4, NULL, NULL, $5::jsonb)`,
    [randomUUID(), input.actorAccountId, input.action, input.deviceId, JSON.stringify(input.afterState)],
  );
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
    throw new PhysicalParityError(
      409,
      "PHYSICAL_CANARY_PENDING",
      `Capability ${capabilityKey} masih memiliki physical canary yang menunggu result.`,
    );
  }
  if (state === "unsupported" || state === "blocked") {
    throw new PhysicalParityError(
      409,
      "PHYSICAL_CAPABILITY_BLOCKED",
      `Capability ${capabilityKey} ditandai ${state} pada mesin ini.`,
    );
  }
  if (mode === "execute" && state !== "verified") {
    throw new PhysicalParityError(
      409,
      "PHYSICAL_CAPABILITY_NOT_VERIFIED",
      `Capability ${capabilityKey} belum lolos physical canary pada mesin ini.`,
    );
  }
  return state;
}

async function activePinForEmployee(
  db: Pool | PoolClient,
  deviceId: string,
  employeeId: string,
) {
  const result = await db.query<{ pin: string; status: string }>(
    `SELECT m.pin, e.status
     FROM attendance_adms_employee_mappings m
     JOIN employees e ON e.id = m.employee_id
     WHERE m.device_id = $1 AND m.employee_id = $2
       AND m.effective_from <= now()
       AND (m.effective_to IS NULL OR m.effective_to > now())
     ORDER BY m.effective_from DESC
     LIMIT 2`,
    [deviceId, employeeId],
  );
  if (result.rows.length !== 1 || result.rows[0]!.status !== "active") {
    throw new PhysicalParityError(
      409,
      "ADMS_MAPPING_NOT_EXACT",
      "Operasi biometrik/pesan private memerlukan tepat satu mapping aktif pegawai→PIN pada mesin target.",
    );
  }
  if (!/^\d{1,128}$/.test(result.rows[0]!.pin)) {
    throw new PhysicalParityError(409, "ADMS_MAPPING_PIN_INVALID", "PIN mapping tidak valid untuk protocol fisik.");
  }
  return result.rows[0]!.pin;
}

function requireConfirmation(actual: string, expected: string) {
  if (actual !== expected) {
    throw new PhysicalParityError(400, "PHYSICAL_CONFIRMATION_MISMATCH", `Ketik persis: ${expected}`);
  }
}

function modalityType(credential: CredentialRow): UnifiedBiometricType {
  const raw = credential.safeMetadata.biometricType;
  if (typeof raw === "number" && [1, 2, 6, 8, 9, 10].includes(raw)) {
    return raw as UnifiedBiometricType;
  }
  if (credential.modality === "fingerprint") return 1;
  if (credential.modality === "face") return 9;
  if (credential.modality === "palm") return 8;
  throw new PhysicalParityError(409, "BIOMETRIC_MODALITY_UNSUPPORTED", "Bio-photo bukan template yang dapat disinkronkan ke mesin.");
}

async function requireBiometricHardwareGate(
  db: Pool | PoolClient,
  config: ApiConfig,
  deviceId: string,
) {
  const device = await requireDevice(db, deviceId);
  const readiness = biometricKeyringReadiness(config);
  if (config.BIOMETRIC_COLLECTION_ENABLED !== "1" || !device.biometricCollectionEnabled || !readiness.ready) {
    throw new PhysicalParityError(
      409,
      "BIOMETRIC_HARDWARE_GATE_CLOSED",
      "Biometric hardware gate belum dibuka: global/device collection dan maintenance keyring harus siap secara eksplisit.",
    );
  }
  return device;
}

async function loadCredential(db: Pool | PoolClient, credentialId: string) {
  const result = await db.query<CredentialRow>(
    `SELECT id, employee_id AS "employeeId", modality, slot_index AS "slotIndex",
            vendor_format AS "vendorFormat", origin_device_id AS "originDeviceId",
            lifecycle, safe_metadata AS "safeMetadata"
     FROM attendance_biometric_credentials
     WHERE id = $1`,
    [credentialId],
  );
  const credential = result.rows[0];
  if (!credential || credential.lifecycle !== "active" || credential.slotIndex === null) {
    throw new PhysicalParityError(404, "BIOMETRIC_CREDENTIAL_NOT_ELIGIBLE", "Credential biometrik aktif tidak ditemukan.");
  }
  return credential;
}

async function queueAndAudit(
  client: PoolClient,
  input: Parameters<typeof queuePhysicalOperation>[1],
) {
  const queued = await queuePhysicalOperation(client, input);
  await writeAudit(client, {
    actorAccountId: input.requestedByAccountId,
    deviceId: input.deviceId,
    action: "physical_operation_requested",
    afterState: {
      operationId: queued.operationId,
      capabilityKey: input.capabilityKey,
      operationKey: input.operationKey,
      mode: input.mode,
      destructive: input.destructive ?? false,
      commandCount: queued.commandIds.length,
    },
  });
  return queued;
}

function capabilityLabel(key: PhysicalCapabilityKey) {
  const labels: Record<PhysicalCapabilityKey, string> = {
    work_code_delivery: "Distribusi Work Code",
    message_delivery: "Pesan perangkat",
    time_sync: "Sinkron waktu",
    duplicate_punch_period: "Duplicate-punch period",
    reboot: "Reboot",
    biometric_query: "Query template biometrik",
    biometric_restore: "Restore/distribusi biometrik",
    biometric_enrollment: "Remote enrollment biometrik",
    biometric_delete: "Hapus biometrik terpilih",
    clear_attendance: "Hapus attendance di mesin",
    clear_photo_cache: "Hapus photo/cache di mesin",
    clear_all_data: "Hapus seluruh data mesin",
    firmware_upgrade: "Upgrade firmware",
    attendance_photo: "Attendance photo",
    user_profile_upsert: "Push profil user",
    user_enable_disable: "Enable/disable user",
    server_config: "Konfigurasi server ADMS",
    ntp_config: "Konfigurasi NTP",
  };
  return labels[key];
}

export async function registerAdmsPhysicalParityRoutes(
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

  app.get("/admin/attendance/adms/devices/:deviceId/physical-capabilities", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.read");
    if (!principal) return;
    const params = deviceParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: "INVALID_ADMS_DEVICE", message: "ID mesin tidak valid." });
    try {
      const device = await requireDevice(pool, params.data.deviceId);
      const stored = await listPhysicalCapabilities(pool, device.id);
      const storedByKey = new Map(stored.map((item) => [item.capabilityKey, item]));
      const running = await pool.query<{
        id: string;
        capabilityKey: PhysicalCapabilityKey;
        operationKey: string;
        mode: string;
        destructive: boolean;
        createdAt: Date;
      }>(
        `SELECT id, capability_key AS "capabilityKey", operation_key AS "operationKey",
                mode, destructive, created_at AS "createdAt"
         FROM attendance_adms_physical_operations
         WHERE device_id = $1 AND status = 'running'
         ORDER BY created_at`,
        [device.id],
      );
      const biometricGate = {
        globalCollectionEnabled: config.BIOMETRIC_COLLECTION_ENABLED === "1",
        deviceCollectionEnabled: device.biometricCollectionEnabled,
        keyringReady: biometricKeyringReadiness(config).ready,
      };
      const approvedServerHost = config.ADMS_INGRESS_HOST?.trim().toLowerCase() || null;
      reply.header("Cache-Control", "no-store");
      return reply.send({
        item: {
          device: {
            id: device.id,
            serialNumber: device.serialNumber,
            displayName: device.displayName,
            model: device.model,
            firmwareVersion: device.firmwareVersion,
          },
          arbitraryCommandEnabled: false,
          activeUserInfoReadsRetired: true,
          biometricGate,
          approvedServerTarget: approvedServerHost ? { host: approvedServerHost, port: 80 } : null,
          capabilities: PHYSICAL_CAPABILITY_KEYS.map((key) => ({
            key,
            label: capabilityLabel(key),
            state: storedByKey.get(key)?.state ?? "documented",
            lastResultCode: storedByKey.get(key)?.lastResultCode ?? null,
            verifiedAt: storedByKey.get(key)?.verifiedAt ?? null,
            safeMetadata: storedByKey.get(key)?.safeMetadata ?? {},
          })),
          runningOperations: running.rows,
        },
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/admin/attendance/adms/devices/:deviceId/physical/work-code", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.operate");
    if (!principal) return;
    const params = deviceParamsSchema.safeParse(request.params);
    const body = workCodeBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ code: "INVALID_WORK_CODE_SYNC", message: "Permintaan Work Code tidak valid." });
    try {
      const result = await withTransaction(pool, async (client) => {
        const device = await requireDevice(client, params.data.deviceId, true);
        await enforceMode(client, device.id, "work_code_delivery", body.data.mode);
        const workCode = await client.query<{ id: string; code: string; name: string; active: boolean }>(
          `SELECT id, code, name, active FROM attendance_adms_work_codes WHERE id = $1`,
          [body.data.workCodeId],
        );
        const item = workCode.rows[0];
        if (!item) throw new PhysicalParityError(404, "WORK_CODE_NOT_FOUND", "Work Code tidak ditemukan.");
        const wire = body.data.desiredState === "present"
          ? workCodeUpsertWireCommand(item.code, item.name)
          : workCodeDeleteWireCommand(item.code);
        await client.query(
          `INSERT INTO attendance_adms_work_code_targets (
             work_code_id, device_id, desired_state, delivery_state, updated_by_account_id
           ) VALUES ($1, $2, $3, 'pending', $4)
           ON CONFLICT (work_code_id, device_id) DO UPDATE
           SET desired_state = EXCLUDED.desired_state, delivery_state = 'pending',
               updated_by_account_id = EXCLUDED.updated_by_account_id, updated_at = now()`,
          [item.id, device.id, body.data.desiredState, principal.id],
        );
        return queueAndAudit(client, {
          deviceId: device.id,
          capabilityKey: "work_code_delivery",
          operationKey: body.data.desiredState === "present" ? "work_code_upsert" : "work_code_delete",
          mode: body.data.mode,
          requestedByAccountId: principal.id,
          commands: [{ commandType: "physical_work_code", wireCommand: wire }],
          safeMetadata: { workCodeId: item.id, desiredState: body.data.desiredState },
        });
      });
      reply.header("Cache-Control", "no-store");
      return reply.status(202).send({ operationId: result.operationId, commandCount: result.commandIds.length });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/admin/attendance/adms/devices/:deviceId/physical/message", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.operate");
    if (!principal) return;
    const params = deviceParamsSchema.safeParse(request.params);
    const body = messageBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ code: "INVALID_MESSAGE_SYNC", message: "Permintaan pesan perangkat tidak valid." });
    try {
      const result = await withTransaction(pool, async (client) => {
        const device = await requireDevice(client, params.data.deviceId, true);
        await enforceMode(client, device.id, "message_delivery", body.data.mode);
        const messages = await client.query<{
          id: string;
          audience: "public" | "private";
          employeeId: string | null;
          messageText: string;
          startsAt: Date | null;
          endsAt: Date | null;
          active: boolean;
          deviceUid: string;
        }>(
          `SELECT id, audience, employee_id AS "employeeId", message_text AS "messageText",
                  starts_at AS "startsAt", ends_at AS "endsAt", active,
                  device_uid::text AS "deviceUid"
           FROM attendance_adms_device_messages WHERE id = $1`,
          [body.data.messageId],
        );
        const message = messages.rows[0];
        if (!message) throw new PhysicalParityError(404, "DEVICE_MESSAGE_NOT_FOUND", "Pesan perangkat tidak ditemukan.");
        const uid = Number(message.deviceUid);
        if (!Number.isSafeInteger(uid) || uid <= 0 || uid > 2_147_483_647) {
          throw new PhysicalParityError(409, "DEVICE_MESSAGE_UID_INVALID", "UID pesan tidak dapat dikirim ke firmware.");
        }
        const commands: Array<{ commandType: "physical_message"; wireCommand: string }> = [];
        if (body.data.desiredState === "absent") {
          commands.push({ commandType: "physical_message", wireCommand: messageDeleteWireCommand(uid) });
        } else {
          const startsAt = message.startsAt ?? new Date();
          const calculatedDuration = message.endsAt
            ? Math.max(1, Math.ceil((message.endsAt.getTime() - startsAt.getTime()) / 60_000))
            : 60;
          const durationMinutes = body.data.durationMinutes ?? calculatedDuration;
          const input = {
            uid,
            message: message.messageText,
            startTime: formatDeviceLocalTimestamp(startsAt, device.timezone),
            durationMinutes,
          };
          if (message.audience === "public") {
            commands.push({ commandType: "physical_message", wireCommand: publicMessageUpsertWireCommand(input) });
          } else {
            if (!message.employeeId) throw new PhysicalParityError(409, "PRIVATE_MESSAGE_EMPLOYEE_MISSING", "Pesan private tidak memiliki pegawai target.");
            const pin = await activePinForEmployee(client, device.id, message.employeeId);
            commands.push({ commandType: "physical_message", wireCommand: privateMessageUpsertWireCommand(input) });
            commands.push({ commandType: "physical_message", wireCommand: privateMessageAssignWireCommand(pin, uid) });
          }
        }
        await client.query(
          `INSERT INTO attendance_adms_device_message_targets (
             message_id, device_id, desired_state, delivery_state, updated_by_account_id
           ) VALUES ($1, $2, $3, 'pending', $4)
           ON CONFLICT (message_id, device_id) DO UPDATE
           SET desired_state = EXCLUDED.desired_state, delivery_state = 'pending',
               updated_by_account_id = EXCLUDED.updated_by_account_id, updated_at = now()`,
          [message.id, device.id, body.data.desiredState, principal.id],
        );
        return queueAndAudit(client, {
          deviceId: device.id,
          capabilityKey: "message_delivery",
          operationKey: body.data.desiredState === "present" ? "message_upsert" : "message_delete",
          mode: body.data.mode,
          requestedByAccountId: principal.id,
          commands,
          safeMetadata: { messageId: message.id, audience: message.audience, desiredState: body.data.desiredState },
        });
      });
      reply.header("Cache-Control", "no-store");
      return reply.status(202).send({ operationId: result.operationId, commandCount: result.commandIds.length });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/admin/attendance/adms/devices/:deviceId/physical/time-sync-canary", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.operate");
    if (!principal) return;
    const params = deviceParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: "INVALID_ADMS_DEVICE", message: "ID mesin tidak valid." });
    try {
      const result = await withTransaction(pool, async (client) => {
        const device = await requireDevice(client, params.data.deviceId, true);
        await enforceMode(client, device.id, "time_sync", "canary");
        const created = await createTimeSyncCanary(client, { deviceId: device.id, requestedByAccountId: principal.id });
        await writeAudit(client, {
          actorAccountId: principal.id,
          deviceId: device.id,
          action: "physical_operation_requested",
          afterState: { operationId: created.operationId, capabilityKey: "time_sync", operationKey: "time_sync_request_response", mode: "canary", commandCount: 0 },
        });
        return created;
      });
      reply.header("Cache-Control", "no-store");
      return reply.status(202).send({ operationId: result.operationId, commandCount: 0 });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/admin/attendance/adms/devices/:deviceId/physical/duplicate-punch", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.configure");
    if (!principal) return;
    const params = deviceParamsSchema.safeParse(request.params);
    const body = duplicatePunchBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ code: "INVALID_DUPLICATE_PUNCH", message: "Konfigurasi duplicate-punch tidak valid." });
    try {
      const result = await withTransaction(pool, async (client) => {
        const device = await requireDevice(client, params.data.deviceId, true);
        requireConfirmation(body.data.confirmation, `SET DUPLICATE ${device.serialNumber} ${body.data.seconds}`);
        await enforceMode(client, device.id, "duplicate_punch_period", body.data.mode);
        return queueAndAudit(client, {
          deviceId: device.id,
          capabilityKey: "duplicate_punch_period",
          operationKey: "set_alarm_rerec",
          mode: body.data.mode,
          requestedByAccountId: principal.id,
          commands: [
            { commandType: "device_option", wireCommand: setDuplicatePunchPeriodWireCommand(body.data.seconds) },
            { commandType: "device_option", wireCommand: reloadOptionsWireCommand() },
          ],
          safeMetadata: { seconds: body.data.seconds },
        });
      });
      reply.header("Cache-Control", "no-store");
      return reply.status(202).send({ operationId: result.operationId, commandCount: result.commandIds.length });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/admin/attendance/adms/devices/:deviceId/physical/reboot", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.destructive");
    if (!principal) return;
    const params = deviceParamsSchema.safeParse(request.params);
    const body = rebootBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ code: "INVALID_REBOOT", message: "Permintaan reboot tidak valid." });
    try {
      const result = await withTransaction(pool, async (client) => {
        const device = await requireDevice(client, params.data.deviceId, true);
        requireConfirmation(body.data.confirmation, `REBOOT ${device.serialNumber}`);
        await enforceMode(client, device.id, "reboot", body.data.mode);
        return queueAndAudit(client, {
          deviceId: device.id,
          capabilityKey: "reboot",
          operationKey: "reboot",
          mode: body.data.mode,
          requestedByAccountId: principal.id,
          commands: [{ commandType: "reboot", wireCommand: rebootWireCommand() }],
          safeMetadata: {},
        });
      });
      reply.header("Cache-Control", "no-store");
      return reply.status(202).send({ operationId: result.operationId, commandCount: 1 });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/admin/attendance/adms/devices/:deviceId/physical/biometric-query", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.biometrics");
    if (!principal) return;
    const params = deviceParamsSchema.safeParse(request.params);
    const body = biometricQueryBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ code: "INVALID_BIOMETRIC_QUERY", message: "Permintaan query biometrik tidak valid." });
    try {
      const result = await withTransaction(pool, async (client) => {
        const device = await requireBiometricHardwareGate(client, config, params.data.deviceId);
        await enforceMode(client, device.id, "biometric_query", body.data.mode);
        const pin = await activePinForEmployee(client, device.id, body.data.employeeId);
        const wire = body.data.protocol === "legacy_fingerprint"
          ? fingerprintQueryWireCommand(pin, body.data.slotIndex)
          : unifiedBiometricQueryWireCommand({ type: body.data.biometricType, pin, slotIndex: body.data.slotIndex });
        return queueAndAudit(client, {
          deviceId: device.id,
          capabilityKey: "biometric_query",
          operationKey: body.data.protocol === "legacy_fingerprint" ? "legacy_fingerprint_query" : "unified_biometric_query",
          mode: body.data.mode,
          requestedByAccountId: principal.id,
          commands: [{ commandType: "biometric_query", wireCommand: wire }],
          safeMetadata: { employeeId: body.data.employeeId, protocol: body.data.protocol, biometricType: body.data.biometricType, slotIndex: body.data.slotIndex },
        });
      });
      reply.header("Cache-Control", "no-store");
      return reply.status(202).send({ operationId: result.operationId, commandCount: 1 });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/admin/attendance/adms/devices/:deviceId/physical/biometric-enroll", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.biometrics");
    if (!principal) return;
    const params = deviceParamsSchema.safeParse(request.params);
    const body = biometricEnrollBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ code: "INVALID_BIOMETRIC_ENROLL", message: "Permintaan enrollment biometrik tidak valid." });
    try {
      const result = await withTransaction(pool, async (client) => {
        const device = await requireBiometricHardwareGate(client, config, params.data.deviceId);
        requireConfirmation(body.data.confirmation, `ENROLL BIOMETRIC ${device.serialNumber} ${body.data.employeeId}`);
        await enforceMode(client, device.id, "biometric_enrollment", body.data.mode);
        const pin = await activePinForEmployee(client, device.id, body.data.employeeId);
        const wire = body.data.protocol === "legacy_fingerprint"
          ? fingerprintEnrollWireCommand({ pin, slotIndex: body.data.slotIndex, retry: body.data.retry, overwrite: body.data.overwrite })
          : unifiedEnrollWireCommand({ type: body.data.biometricType, pin, slotIndex: body.data.slotIndex, retry: body.data.retry, overwrite: body.data.overwrite });
        return queueAndAudit(client, {
          deviceId: device.id,
          capabilityKey: "biometric_enrollment",
          operationKey: body.data.protocol === "legacy_fingerprint" ? "legacy_fingerprint_enroll" : "unified_biometric_enroll",
          mode: body.data.mode,
          requestedByAccountId: principal.id,
          commands: [{ commandType: "biometric_enroll", wireCommand: wire }],
          safeMetadata: { employeeId: body.data.employeeId, protocol: body.data.protocol, biometricType: body.data.biometricType, slotIndex: body.data.slotIndex },
        });
      });
      reply.header("Cache-Control", "no-store");
      return reply.status(202).send({ operationId: result.operationId, commandCount: 1 });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/admin/attendance/adms/devices/:deviceId/physical/biometric-restore", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.biometrics");
    if (!principal) return;
    const params = deviceParamsSchema.safeParse(request.params);
    const body = biometricRestoreBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ code: "INVALID_BIOMETRIC_RESTORE", message: "Permintaan restore biometrik tidak valid." });
    try {
      const result = await withTransaction(pool, async (client) => {
        const device = await requireBiometricHardwareGate(client, config, params.data.deviceId);
        const credential = await loadCredential(client, body.data.credentialId);
        requireConfirmation(body.data.confirmation, `RESTORE BIOMETRIC ${device.serialNumber} ${credential.id}`);
        await enforceMode(client, device.id, "biometric_restore", body.data.mode);
        const pin = await activePinForEmployee(client, device.id, credential.employeeId);
        return queueAndAudit(client, {
          deviceId: device.id,
          capabilityKey: "biometric_restore",
          operationKey: "credential_restore",
          mode: body.data.mode,
          requestedByAccountId: principal.id,
          commands: [{ commandType: "biometric_restore", wireCommand: "BIOMETRIC_RESTORE", biometricCredentialId: credential.id }],
          safeMetadata: { credentialId: credential.id, employeeId: credential.employeeId, targetPin: pin, modality: credential.modality, slotIndex: credential.slotIndex },
        });
      });
      reply.header("Cache-Control", "no-store");
      return reply.status(202).send({ operationId: result.operationId, commandCount: 1, rawTemplateReturned: false });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/admin/attendance/adms/devices/:deviceId/physical/biometric-delete", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, ["attendance.devices.biometrics","attendance.devices.destructive"]);
    if (!principal) return;
    const params = deviceParamsSchema.safeParse(request.params);
    const body = biometricDeleteBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ code: "INVALID_BIOMETRIC_DELETE", message: "Permintaan hapus biometrik tidak valid." });
    try {
      const result = await withTransaction(pool, async (client) => {
        const device = await requireBiometricHardwareGate(client, config, params.data.deviceId);
        const credential = await loadCredential(client, body.data.credentialId);
        requireConfirmation(body.data.confirmation, `DELETE BIOMETRIC ${device.serialNumber} ${credential.id}`);
        await enforceMode(client, device.id, "biometric_delete", body.data.mode);
        const pin = await activePinForEmployee(client, device.id, credential.employeeId);
        const state = await client.query<{ state: string }>(
          `SELECT state FROM attendance_biometric_device_states
           WHERE credential_id = $1 AND device_id = $2`,
          [credential.id, device.id],
        );
        if (credential.originDeviceId !== device.id && state.rows[0]?.state !== "present") {
          throw new PhysicalParityError(409, "BIOMETRIC_DEVICE_PRESENCE_UNKNOWN", "Tidak ada bukti credential ini hadir di mesin target.");
        }
        let wire: string;
        if (credential.vendorFormat === "zkteco-push-fingertmp-base64" && credential.modality === "fingerprint") {
          wire = fingerprintDeleteWireCommand(pin, credential.slotIndex!);
        } else if (credential.vendorFormat === "zkteco-push-face-base64" && credential.modality === "face") {
          wire = faceDeleteWireCommand(pin);
        } else if (credential.vendorFormat === "zkteco-push-biodata-base64") {
          wire = unifiedBiometricDeleteWireCommand({ type: modalityType(credential), pin, slotIndex: credential.slotIndex! });
        } else {
          throw new PhysicalParityError(409, "BIOMETRIC_VENDOR_FORMAT_UNSUPPORTED", "Vendor format credential belum memiliki typed delete command.");
        }
        return queueAndAudit(client, {
          deviceId: device.id,
          capabilityKey: "biometric_delete",
          operationKey: "credential_delete",
          mode: body.data.mode,
          requestedByAccountId: principal.id,
          commands: [{ commandType: "biometric_delete", wireCommand: wire, biometricCredentialId: credential.id }],
          safeMetadata: { credentialId: credential.id, employeeId: credential.employeeId, modality: credential.modality, slotIndex: credential.slotIndex },
        });
      });
      reply.header("Cache-Control", "no-store");
      return reply.status(202).send({ operationId: result.operationId, commandCount: 1, masterCredentialDestroyed: false });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  for (const spec of [
    { path: "clear-attendance", capabilityKey: "clear_attendance" as const, phrase: "CLEAR ATTENDANCE", wire: clearAttendanceWireCommand() },
    { path: "clear-photo", capabilityKey: "clear_photo_cache" as const, phrase: "CLEAR PHOTO", wire: clearPhotoCacheWireCommand() },
    { path: "clear-all", capabilityKey: "clear_all_data" as const, phrase: "CLEAR ALL DATA", wire: clearAllDataWireCommand() },
  ]) {
    app.post(`/admin/attendance/adms/devices/:deviceId/physical/${spec.path}`, async (request, reply) => {
      const principal = await authenticate(auth, request, reply, "attendance.devices.destructive");
      if (!principal) return;
      const params = deviceParamsSchema.safeParse(request.params);
      const body = destructiveBodySchema.safeParse(request.body);
      if (!params.success || !body.success) return reply.status(400).send({ code: "INVALID_DESTRUCTIVE_OPERATION", message: "Permintaan destructive operation tidak valid." });
      try {
        const result = await withTransaction(pool, async (client) => {
          const device = await requireDevice(client, params.data.deviceId, true);
          requireConfirmation(body.data.confirmation, `${spec.phrase} ${device.serialNumber}`);
          await enforceMode(client, device.id, spec.capabilityKey, body.data.mode);
          return queueAndAudit(client, {
            deviceId: device.id,
            capabilityKey: spec.capabilityKey,
            operationKey: spec.path.replaceAll("-", "_"),
            mode: body.data.mode,
            destructive: true,
            requestedByAccountId: principal.id,
            commands: [{ commandType: "device_clear", wireCommand: spec.wire }],
            safeMetadata: { hcisRawHistoryPreserved: true },
          });
        });
        reply.header("Cache-Control", "no-store");
        return reply.status(202).send({ operationId: result.operationId, commandCount: 1, hcisRawHistoryDeleted: false });
      } catch (error) {
        return sendError(reply, error);
      }
    });
  }

  app.post("/admin/attendance/adms/devices/:deviceId/physical/attendance-photo-canary", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.operate");
    if (!principal) return;
    const params = deviceParamsSchema.safeParse(request.params);
    const body = passiveCanaryBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ code: "INVALID_ATTENDANCE_PHOTO_CANARY", message: "Permintaan attendance-photo canary tidak valid." });
    try {
      const result = await withTransaction(pool, async (client) => {
        const device = await requireDevice(client, params.data.deviceId, true);
        requireConfirmation(body.data.confirmation, `ENABLE ATTPHOTO CANARY ${device.serialNumber}`);
        if (!biometricKeyringReadiness(config).ready) {
          throw new PhysicalParityError(409, "RESTRICTED_MEDIA_KEYRING_NOT_READY", "Keyring terenkripsi harus siap sebelum attendance photo diiklankan ke device.");
        }
        await enforceMode(client, device.id, "attendance_photo", "canary");
        const operationId = randomUUID();
        await client.query(
          `INSERT INTO attendance_adms_physical_operations (
             id, device_id, capability_key, operation_key, mode, status, destructive,
             requested_by_account_id, safe_metadata
           ) VALUES ($1, $2, 'attendance_photo', 'attendance_photo_upload', 'canary', 'running', false, $3, $4::jsonb)`,
          [operationId, device.id, principal.id, JSON.stringify({ encryptedStorageRequired: true })],
        );
        await client.query(
          `INSERT INTO attendance_adms_physical_capabilities (
             device_id, capability_key, state, last_operation_id, safe_metadata, updated_at
           ) VALUES ($1, 'attendance_photo', 'canary_pending', $2, $3::jsonb, now())
           ON CONFLICT (device_id, capability_key) DO UPDATE
           SET state = 'canary_pending', last_operation_id = EXCLUDED.last_operation_id,
               safe_metadata = attendance_adms_physical_capabilities.safe_metadata || EXCLUDED.safe_metadata,
               updated_at = now()`,
          [device.id, operationId, JSON.stringify({ handshakeFlag: "AttPhoto" })],
        );
        await writeAudit(client, {
          actorAccountId: principal.id,
          deviceId: device.id,
          action: "physical_operation_requested",
          afterState: { operationId, capabilityKey: "attendance_photo", operationKey: "attendance_photo_upload", mode: "canary", commandCount: 0 },
        });
        return { operationId };
      });
      reply.header("Cache-Control", "no-store");
      return reply.status(202).send({ operationId: result.operationId, commandCount: 0, rawPhotoStored: false });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/admin/attendance/adms/devices/:deviceId/physical/capability-state", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.configure");
    if (!principal) return;
    const params = deviceParamsSchema.safeParse(request.params);
    const body = capabilityOverrideBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ code: "INVALID_CAPABILITY_STATE", message: "Capability state tidak valid." });
    try {
      const result = await withTransaction(pool, async (client) => {
        const device = await requireDevice(client, params.data.deviceId, true);
        requireConfirmation(body.data.confirmation, `${body.data.state.toUpperCase()} ${body.data.capabilityKey} ${device.serialNumber}`);
        const running = await client.query<{ id: string }>(
          `SELECT id FROM attendance_adms_physical_operations
           WHERE device_id = $1 AND capability_key = $2 AND status = 'running' LIMIT 1`,
          [device.id, body.data.capabilityKey],
        );
        if (running.rows[0]) throw new PhysicalParityError(409, "PHYSICAL_OPERATION_RUNNING", "Capability masih memiliki operasi aktif.");
        await client.query(
          `INSERT INTO attendance_adms_physical_capabilities (
             device_id, capability_key, state, safe_metadata, updated_at
           ) VALUES ($1, $2, $3, $4::jsonb, now())
           ON CONFLICT (device_id, capability_key) DO UPDATE
           SET state = EXCLUDED.state,
               safe_metadata = attendance_adms_physical_capabilities.safe_metadata || EXCLUDED.safe_metadata,
               updated_at = now()`,
          [device.id, body.data.capabilityKey, body.data.state, JSON.stringify({ evidenceNote: body.data.note, manuallyClassified: true })],
        );
        await writeAudit(client, {
          actorAccountId: principal.id,
          deviceId: device.id,
          action: "physical_capability_updated",
          afterState: { capabilityKey: body.data.capabilityKey, state: body.data.state, note: body.data.note },
        });
        return { capabilityKey: body.data.capabilityKey, state: body.data.state };
      });
      reply.header("Cache-Control", "no-store");
      return reply.send({ item: result });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
