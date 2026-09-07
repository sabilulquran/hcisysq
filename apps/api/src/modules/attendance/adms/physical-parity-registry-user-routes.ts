import type { AdminPermission } from "../../auth/permissions.js";
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../../config/env.js";
import { requirePermissionsFromCookie } from "../../auth/authorization.js";
import { AuthError, AuthService, type AuthPrincipal } from "../../auth/service.js";
import type { PhysicalCapabilityKey } from "./physical-parity-protocol.js";
import { queuePhysicalOperation } from "./physical-parity-service.js";
import {
  deviceUserAuthorizationWireCommand,
  deviceUserExpirationWireCommand,
  deviceUserUpsertWireCommand,
  ntpServerWireCommand,
  webServerWireCommand,
} from "./physical-parity-user-config-protocol.js";
import { formatDeviceLocalTimestamp } from "./protocol.js";

const deviceParamsSchema = z.object({ deviceId: z.string().uuid() });
const modeSchema = z.enum(["canary", "execute"]);
const profileSchema = z.object({
  organizationalUnitId: z.string().uuid().nullable().optional(),
  areaContext: z.string().trim().min(1).max(160).nullable().optional(),
  worksiteLabel: z.string().trim().min(1).max(160).nullable().optional(),
  heartbeatIntervalSeconds: z.number().int().min(5).max(3600).optional(),
  desiredPushProtocolVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/).nullable().optional(),
}).refine((value) => Object.values(value).some((entry) => entry !== undefined), {
  message: "Minimal satu field harus diubah.",
});
const userProfileSchema = z.object({
  employeeId: z.string().uuid(),
  group: z.number().int().min(1).max(99).default(1),
  mode: modeSchema.default("canary"),
  confirmation: z.string(),
});
const userEnabledSchema = z.object({
  employeeId: z.string().uuid(),
  enabled: z.boolean(),
  group: z.number().int().min(1).max(99).default(1),
  authorizationTimezoneId: z.number().int().min(1).max(99).default(1),
  authorizationDoorId: z.number().int().min(1).max(99).default(1),
  mode: modeSchema.default("canary"),
  confirmation: z.string(),
});
const ntpSchema = z.object({
  host: z.string().trim().min(1).max(253),
  mode: modeSchema.default("canary"),
  confirmation: z.string(),
});
const serverSchema = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  mode: modeSchema.default("canary"),
  confirmation: z.string(),
});
const jobCodeSchema = z.object({
  code: z.string().trim().regex(/^[0-9A-Za-z._-]{1,32}$/),
  name: z.string().trim().min(1).max(120),
  active: z.boolean().default(true),
});

class RegistryParityError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RegistryParityError";
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
  if (error instanceof RegistryParityError) {
    reply.header("Cache-Control", "no-store");
    return reply.status(error.statusCode).send({ code: error.code, message: error.message });
  }
  if (error instanceof Error && (
    error.message.startsWith("ADMS device") ||
    error.message.startsWith("Physical operation") ||
    error.message.startsWith("ADMS user") ||
    error.message.startsWith("NTP server") ||
    error.message.startsWith("ADMS server")
  )) {
    reply.header("Cache-Control", "no-store");
    return reply.status(409).send({ code: "WDMS_OPERATION_CONFLICT", message: error.message });
  }
  throw error;
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>) {
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

type Device = {
  id: string;
  serialNumber: string;
  lifecycle: string;
  timezone: string;
  organizationalUnitId: string | null;
  areaContext: string | null;
  worksiteLabel: string | null;
  deviceRole: string;
  transferMode: string;
  heartbeatIntervalSeconds: number;
  desiredPushProtocolVersion: string | null;
};

async function deviceForUpdate(client: PoolClient, deviceId: string) {
  const result = await client.query<Device>(
    `SELECT id, serial_number AS "serialNumber", lifecycle, timezone,
            organizational_unit_id AS "organizationalUnitId",
            area_context AS "areaContext", worksite_label AS "worksiteLabel",
            device_role AS "deviceRole", transfer_mode AS "transferMode",
            heartbeat_interval_seconds AS "heartbeatIntervalSeconds",
            desired_push_protocol_version AS "desiredPushProtocolVersion"
     FROM attendance_adms_devices WHERE id = $1 FOR UPDATE`,
    [deviceId],
  );
  const device = result.rows[0];
  if (!device) throw new RegistryParityError(404, "ADMS_DEVICE_NOT_FOUND", "Mesin tidak ditemukan.");
  if (device.lifecycle !== "active") throw new RegistryParityError(409, "ADMS_DEVICE_NOT_ACTIVE", "Mesin harus active.");
  return device;
}

async function exactEmployeeMapping(
  client: PoolClient,
  deviceId: string,
  employeeId: string,
) {
  const result = await client.query<{ pin: string; fullName: string; status: string }>(
    `SELECT m.pin, e.full_name AS "fullName", e.status
     FROM attendance_adms_employee_mappings m
     JOIN employees e ON e.id = m.employee_id
     WHERE m.device_id = $1 AND m.employee_id = $2
       AND m.effective_from <= now()
       AND (m.effective_to IS NULL OR m.effective_to > now())
     ORDER BY m.effective_from DESC
     LIMIT 2`,
    [deviceId, employeeId],
  );
  if (result.rows.length !== 1) {
    throw new RegistryParityError(409, "ADMS_MAPPING_NOT_EXACT", "Operasi user memerlukan tepat satu mapping aktif pegawai→PIN.");
  }
  const row = result.rows[0]!;
  if (!/^\d{1,128}$/.test(row.pin)) {
    throw new RegistryParityError(409, "ADMS_MAPPING_PIN_INVALID", "PIN mapping tidak valid.");
  }
  return row;
}

async function state(
  client: PoolClient,
  deviceId: string,
  capabilityKey: PhysicalCapabilityKey,
) {
  const result = await client.query<{ state: string }>(
    `SELECT state FROM attendance_adms_physical_capabilities
     WHERE device_id = $1 AND capability_key = $2`,
    [deviceId, capabilityKey],
  );
  return result.rows[0]?.state ?? "documented";
}

async function enforce(
  client: PoolClient,
  deviceId: string,
  capabilityKey: PhysicalCapabilityKey,
  mode: "canary" | "execute",
) {
  const current = await state(client, deviceId, capabilityKey);
  if (current === "canary_pending") {
    throw new RegistryParityError(409, "PHYSICAL_CANARY_PENDING", `${capabilityKey} masih memiliki physical canary yang menunggu result.`);
  }
  if (["unsupported", "blocked"].includes(current)) {
    throw new RegistryParityError(409, "PHYSICAL_CAPABILITY_BLOCKED", `${capabilityKey} ditandai ${current} pada mesin ini.`);
  }
  if (mode === "execute" && current !== "verified") {
    throw new RegistryParityError(409, "PHYSICAL_CAPABILITY_NOT_VERIFIED", `${capabilityKey} belum lolos physical canary.`);
  }
}

function confirm(actual: string, expected: string) {
  if (actual !== expected) throw new RegistryParityError(400, "PHYSICAL_CONFIRMATION_MISMATCH", `Ketik persis: ${expected}`);
}

async function audit(
  client: PoolClient,
  input: { actorId: string; deviceId: string | null; action: "physical_operation_requested" | "wdms_device_profile_updated" | "job_code_saved"; after: Record<string, unknown> },
) {
  await client.query(
    `INSERT INTO attendance_adms_admin_audit_events (
       id, actor_account_id, action, device_id, mapping_id, before_state, after_state
     ) VALUES ($1, $2, $3, $4, NULL, NULL, $5::jsonb)`,
    [randomUUID(), input.actorId, input.action, input.deviceId, JSON.stringify(input.after)],
  );
}

async function queue(
  client: PoolClient,
  input: {
    deviceId: string;
    capabilityKey: PhysicalCapabilityKey;
    operationKey: string;
    mode: "canary" | "execute";
    actorId: string;
    wires: string[];
    safeMetadata?: Record<string, string | number | boolean | null>;
  },
) {
  const result = await queuePhysicalOperation(client, {
    deviceId: input.deviceId,
    capabilityKey: input.capabilityKey,
    operationKey: input.operationKey,
    mode: input.mode,
    requestedByAccountId: input.actorId,
    commands: input.wires.map((wireCommand) => ({ commandType: "device_option" as const, wireCommand })),
    ...(input.safeMetadata === undefined ? {} : { safeMetadata: input.safeMetadata }),
  });
  await audit(client, {
    actorId: input.actorId,
    deviceId: input.deviceId,
    action: "physical_operation_requested",
    after: {
      operationId: result.operationId,
      capabilityKey: input.capabilityKey,
      operationKey: input.operationKey,
      mode: input.mode,
      commandCount: input.wires.length,
    },
  });
  return result;
}

export async function registerAdmsPhysicalParityRegistryUserRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required");
  const auth = new AuthService(pool, config.AUTH_ENCRYPTION_KEY, config.AUTH_SESSION_TTL_HOURS, config.NODE_ENV === "production");

  app.get("/admin/attendance/adms/devices/:deviceId/wdms-profile", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.read");
    if (!principal) return;
    const params = deviceParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: "INVALID_ADMS_DEVICE", message: "ID mesin tidak valid." });
    const result = await pool.query<Device>(
      `SELECT id, serial_number AS "serialNumber", lifecycle, timezone,
              organizational_unit_id AS "organizationalUnitId",
              area_context AS "areaContext", worksite_label AS "worksiteLabel",
              device_role AS "deviceRole", transfer_mode AS "transferMode",
              heartbeat_interval_seconds AS "heartbeatIntervalSeconds",
              desired_push_protocol_version AS "desiredPushProtocolVersion"
       FROM attendance_adms_devices WHERE id = $1`,
      [params.data.deviceId],
    );
    if (!result.rows[0]) return reply.status(404).send({ code: "ADMS_DEVICE_NOT_FOUND", message: "Mesin tidak ditemukan." });
    reply.header("Cache-Control", "no-store");
    return reply.send({ item: result.rows[0] });
  });

  app.patch("/admin/attendance/adms/devices/:deviceId/wdms-profile", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.configure");
    if (!principal) return;
    const params = deviceParamsSchema.safeParse(request.params);
    const body = profileSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ code: "INVALID_WDMS_PROFILE", message: "Profil WDMS tidak valid." });
    try {
      const item = await transaction(pool, async (client) => {
        const before = await deviceForUpdate(client, params.data.deviceId);
        if (body.data.organizationalUnitId) {
          const unit = await client.query<{ id: string }>(`SELECT id FROM organizational_units WHERE id = $1`, [body.data.organizationalUnitId]);
          if (!unit.rows[0]) throw new RegistryParityError(404, "ORGANIZATIONAL_UNIT_NOT_FOUND", "Unit organisasi tidak ditemukan.");
        }
        await client.query(
          `UPDATE attendance_adms_devices
           SET organizational_unit_id = CASE WHEN $2::boolean THEN $3::uuid ELSE organizational_unit_id END,
               area_context = CASE WHEN $4::boolean THEN $5::text ELSE area_context END,
               worksite_label = CASE WHEN $6::boolean THEN $7::text ELSE worksite_label END,
               heartbeat_interval_seconds = COALESCE($8, heartbeat_interval_seconds),
               desired_push_protocol_version = CASE WHEN $9::boolean THEN $10::text ELSE desired_push_protocol_version END,
               device_role = 'attendance_only', transfer_mode = 'push', updated_at = now()
           WHERE id = $1`,
          [
            before.id,
            body.data.organizationalUnitId !== undefined,
            body.data.organizationalUnitId ?? null,
            body.data.areaContext !== undefined,
            body.data.areaContext ?? null,
            body.data.worksiteLabel !== undefined,
            body.data.worksiteLabel ?? null,
            body.data.heartbeatIntervalSeconds ?? null,
            body.data.desiredPushProtocolVersion !== undefined,
            body.data.desiredPushProtocolVersion ?? null,
          ],
        );
        await audit(client, {
          actorId: principal.id,
          deviceId: before.id,
          action: "wdms_device_profile_updated",
          after: { ...body.data, deviceRole: "attendance_only", transferMode: "push" },
        });
        const updated = await client.query<Device>(
          `SELECT id, serial_number AS "serialNumber", lifecycle, timezone,
                  organizational_unit_id AS "organizationalUnitId",
                  area_context AS "areaContext", worksite_label AS "worksiteLabel",
                  device_role AS "deviceRole", transfer_mode AS "transferMode",
                  heartbeat_interval_seconds AS "heartbeatIntervalSeconds",
                  desired_push_protocol_version AS "desiredPushProtocolVersion"
           FROM attendance_adms_devices WHERE id = $1`,
          [before.id],
        );
        return updated.rows[0]!;
      });
      reply.header("Cache-Control", "no-store");
      return reply.send({ item });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/admin/attendance/adms/devices/:deviceId/physical/user-profile", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.configure");
    if (!principal) return;
    const params = deviceParamsSchema.safeParse(request.params);
    const body = userProfileSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ code: "INVALID_USER_PROFILE_SYNC", message: "Permintaan user profile tidak valid." });
    try {
      const result = await transaction(pool, async (client) => {
        const device = await deviceForUpdate(client, params.data.deviceId);
        confirm(body.data.confirmation, `UPSERT USER ${device.serialNumber} ${body.data.employeeId}`);
        await enforce(client, device.id, "user_profile_upsert", body.data.mode);
        const employee = await exactEmployeeMapping(client, device.id, body.data.employeeId);
        if (employee.status !== "active") throw new RegistryParityError(409, "EMPLOYEE_NOT_ACTIVE", "Hanya pegawai aktif yang dapat di-push sebagai user aktif.");
        const expiration = formatDeviceLocalTimestamp(new Date("2099-12-31T16:59:59.000Z"), device.timezone);
        return queue(client, {
          deviceId: device.id,
          capabilityKey: "user_profile_upsert",
          operationKey: "user_profile_upsert",
          mode: body.data.mode,
          actorId: principal.id,
          wires: [deviceUserUpsertWireCommand({ pin: employee.pin, name: employee.fullName, group: body.data.group, expiredTime: expiration })],
          safeMetadata: { employeeId: body.data.employeeId, pin: employee.pin, group: body.data.group, deletesBiometrics: false },
        });
      });
      reply.header("Cache-Control", "no-store");
      return reply.status(202).send({ operationId: result.operationId, commandCount: result.commandIds.length, deletesBiometrics: false });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/admin/attendance/adms/devices/:deviceId/physical/user-enabled", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.configure");
    if (!principal) return;
    const params = deviceParamsSchema.safeParse(request.params);
    const body = userEnabledSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ code: "INVALID_USER_ENABLED_STATE", message: "Permintaan enable/disable user tidak valid." });
    try {
      const result = await transaction(pool, async (client) => {
        const device = await deviceForUpdate(client, params.data.deviceId);
        confirm(body.data.confirmation, `${body.data.enabled ? "ENABLE" : "DISABLE"} USER ${device.serialNumber} ${body.data.employeeId}`);
        await enforce(client, device.id, "user_enable_disable", body.data.mode);
        const employee = await exactEmployeeMapping(client, device.id, body.data.employeeId);
        const expiration = body.data.enabled
          ? formatDeviceLocalTimestamp(new Date("2099-12-31T16:59:59.000Z"), device.timezone)
          : formatDeviceLocalTimestamp(new Date("2000-01-01T00:00:00.000Z"), device.timezone);
        const wires = body.data.enabled
          ? [
              deviceUserUpsertWireCommand({ pin: employee.pin, name: employee.fullName, group: body.data.group, expiredTime: expiration }),
              deviceUserAuthorizationWireCommand({ pin: employee.pin, timezoneId: body.data.authorizationTimezoneId, doorId: body.data.authorizationDoorId }),
            ]
          : [
              deviceUserExpirationWireCommand(employee.pin, expiration),
              deviceUserAuthorizationWireCommand({ pin: employee.pin, timezoneId: 0, doorId: 0 }),
            ];
        return queue(client, {
          deviceId: device.id,
          capabilityKey: "user_enable_disable",
          operationKey: body.data.enabled ? "user_enable" : "user_disable",
          mode: body.data.mode,
          actorId: principal.id,
          wires,
          safeMetadata: { employeeId: body.data.employeeId, pin: employee.pin, enabled: body.data.enabled, deletesIdentity: false, deletesBiometrics: false },
        });
      });
      reply.header("Cache-Control", "no-store");
      return reply.status(202).send({ operationId: result.operationId, commandCount: result.commandIds.length, deletesIdentity: false, deletesBiometrics: false });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/admin/attendance/adms/devices/:deviceId/physical/ntp", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.configure");
    if (!principal) return;
    const params = deviceParamsSchema.safeParse(request.params);
    const body = ntpSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ code: "INVALID_NTP_CONFIG", message: "Konfigurasi NTP tidak valid." });
    try {
      const result = await transaction(pool, async (client) => {
        const device = await deviceForUpdate(client, params.data.deviceId);
        confirm(body.data.confirmation, `SET NTP ${device.serialNumber} ${body.data.host}`);
        await enforce(client, device.id, "ntp_config", body.data.mode);
        return queue(client, {
          deviceId: device.id,
          capabilityKey: "ntp_config",
          operationKey: "set_ntp_server",
          mode: body.data.mode,
          actorId: principal.id,
          wires: [ntpServerWireCommand(body.data.host), "RELOAD OPTIONS"],
          safeMetadata: { host: body.data.host },
        });
      });
      reply.header("Cache-Control", "no-store");
      return reply.status(202).send({ operationId: result.operationId, commandCount: result.commandIds.length });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/admin/attendance/adms/devices/:deviceId/physical/server-config", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.configure");
    if (!principal) return;
    const params = deviceParamsSchema.safeParse(request.params);
    const body = serverSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ code: "INVALID_SERVER_CONFIG", message: "Konfigurasi server tidak valid." });
    try {
      const result = await transaction(pool, async (client) => {
        const device = await deviceForUpdate(client, params.data.deviceId);
        confirm(body.data.confirmation, `SET SERVER ${device.serialNumber} ${body.data.host}:${body.data.port}`);
        await enforce(client, device.id, "server_config", body.data.mode);
        const approvedHost = config.ADMS_INGRESS_HOST?.trim().toLowerCase() ?? "";
        if (!approvedHost) {
          throw new RegistryParityError(409, "SERVER_TARGET_NOT_CONFIGURED", "Approved ADMS ingress target belum dikonfigurasi di server HCIS.");
        }
        if (body.data.host.toLowerCase() !== approvedHost || body.data.port !== 80) {
          throw new RegistryParityError(409, "SERVER_TARGET_NOT_APPROVED", `Server config hanya boleh menulis ulang target yang disetujui ${approvedHost}:80 agar device tidak terputus.`);
        }
        return queue(client, {
          deviceId: device.id,
          capabilityKey: "server_config",
          operationKey: "set_web_server",
          mode: body.data.mode,
          actorId: principal.id,
          wires: [webServerWireCommand({ host: approvedHost, port: 80 })],
          safeMetadata: { host: approvedHost, port: 80, approvedIngressTarget: true },
        });
      });
      reply.header("Cache-Control", "no-store");
      return reply.status(202).send({ operationId: result.operationId, commandCount: result.commandIds.length });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/admin/attendance/adms/job-codes", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.read");
    if (!principal) return;
    const result = await pool.query<{
      id: string;
      code: string;
      name: string;
      active: boolean;
      safeMetadata: Record<string, unknown>;
      updatedAt: Date;
    }>(
      `SELECT id, code, name, active, safe_metadata AS "safeMetadata", updated_at AS "updatedAt"
       FROM attendance_adms_job_codes ORDER BY code LIMIT 1000`,
    );
    reply.header("Cache-Control", "no-store");
    return reply.send({ items: result.rows, semantics: "raw_reference_only", affectsPayroll: false });
  });

  app.post("/admin/attendance/adms/job-codes", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.configure");
    if (!principal) return;
    const body = jobCodeSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ code: "INVALID_JOB_CODE", message: "Job Code tidak valid." });
    const id = randomUUID();
    const result = await pool.query<{ id: string }>(
      `INSERT INTO attendance_adms_job_codes (
         id, code, name, active, safe_metadata, created_by_account_id
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (code) DO UPDATE
       SET name = EXCLUDED.name, active = EXCLUDED.active,
           safe_metadata = attendance_adms_job_codes.safe_metadata || EXCLUDED.safe_metadata,
           updated_at = now()
       RETURNING id`,
      [id, body.data.code, body.data.name, body.data.active, JSON.stringify({ semantics: "raw_reference_only" }), principal.id],
    );
    await pool.query(
      `INSERT INTO attendance_adms_admin_audit_events (
         id, actor_account_id, action, device_id, mapping_id, before_state, after_state
       ) VALUES ($1, $2, 'job_code_saved', NULL, NULL, NULL, $3::jsonb)`,
      [randomUUID(), principal.id, JSON.stringify({ jobCodeId: result.rows[0]!.id, code: body.data.code, active: body.data.active, affectsPayroll: false })],
    );
    reply.header("Cache-Control", "no-store");
    return reply.status(201).send({ item: { id: result.rows[0]!.id, ...body.data }, affectsPayroll: false });
  });
}
