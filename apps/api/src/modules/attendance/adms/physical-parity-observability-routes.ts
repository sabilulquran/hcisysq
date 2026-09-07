import type { AdminPermission } from "../../auth/permissions.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../../config/env.js";
import { requirePermissionsFromCookie } from "../../auth/authorization.js";
import { AuthError, AuthService, type AuthPrincipal } from "../../auth/service.js";

const deviceParamsSchema = z.object({ deviceId: z.string().uuid() });
const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
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

function scalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function csv(rows: unknown[][]) {
  return rows
    .map((row) => row.map((value) => `"${scalar(value).replaceAll('"', '""')}"`).join(","))
    .join("\r\n") + "\r\n";
}

function sendCsv(reply: FastifyReply, filename: string, rows: unknown[][]) {
  reply.header("Cache-Control", "no-store");
  reply.header("Pragma", "no-cache");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Content-Disposition", `attachment; filename="${filename}"`);
  reply.type("text/csv; charset=utf-8");
  return reply.send(csv(rows));
}

async function requireDevice(pool: Pool, deviceId: string) {
  const result = await pool.query<{
    id: string;
    serialNumber: string;
    displayName: string | null;
    lifecycle: string;
    model: string | null;
    firmwareVersion: string | null;
    biometricCollectionEnabled: boolean;
    deviceRole: string;
    transferMode: string;
    heartbeatIntervalSeconds: number;
    desiredPushProtocolVersion: string | null;
    lastSeenAt: Date | null;
  }>(
    `SELECT id, serial_number AS "serialNumber", display_name AS "displayName", lifecycle,
            model, firmware_version AS "firmwareVersion",
            biometric_collection_enabled AS "biometricCollectionEnabled",
            device_role AS "deviceRole", transfer_mode AS "transferMode",
            heartbeat_interval_seconds AS "heartbeatIntervalSeconds",
            desired_push_protocol_version AS "desiredPushProtocolVersion",
            last_seen_at AS "lastSeenAt"
     FROM attendance_adms_devices WHERE id = $1`,
    [deviceId],
  );
  return result.rows[0] ?? null;
}

export async function registerAdmsPhysicalParityObservabilityRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required for physical parity observability");
  const auth = new AuthService(
    pool,
    config.AUTH_ENCRYPTION_KEY,
    config.AUTH_SESSION_TTL_HOURS,
    config.NODE_ENV === "production",
  );

  app.get("/admin/attendance/adms/devices/:deviceId/wdms-evidence", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.read");
    if (!principal) return;
    const params = deviceParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: "INVALID_ADMS_DEVICE", message: "ID mesin tidak valid." });
    const device = await requireDevice(pool, params.data.deviceId);
    if (!device) return reply.status(404).send({ code: "ADMS_DEVICE_NOT_FOUND", message: "Mesin tidak ditemukan." });

    const evidence = await pool.query<{
      lastProtocolObservedAt: Date | null;
      lastRegistrationAt: Date | null;
      lastHeartbeatAt: Date | null;
      observedPushProtocolVersion: string | null;
    }>(
      `SELECT
         MAX(received_at) AS "lastProtocolObservedAt",
         MAX(received_at) FILTER (
           WHERE method = 'GET' AND path = '/iclock/cdata'
             AND (raw_query ILIKE '%options=all%' OR raw_query ILIKE '%option=all%')
         ) AS "lastRegistrationAt",
         MAX(received_at) FILTER (
           WHERE method = 'GET' AND path = '/iclock/getrequest'
         ) AS "lastHeartbeatAt",
         (
           SELECT COALESCE(j2.safe_metadata ->> 'pushver', j2.safe_metadata ->> 'PushVersion')
           FROM attendance_adms_request_journal j2
           WHERE j2.device_id = $1
             AND COALESCE(j2.safe_metadata ->> 'pushver', j2.safe_metadata ->> 'PushVersion') IS NOT NULL
           ORDER BY j2.received_at DESC
           LIMIT 1
         ) AS "observedPushProtocolVersion"
       FROM attendance_adms_request_journal
       WHERE device_id = $1`,
      [device.id],
    );
    const photo = await pool.query<{ state: string }>(
      `SELECT state FROM attendance_adms_physical_capabilities
       WHERE device_id = $1 AND capability_key = 'attendance_photo'`,
      [device.id],
    );
    const attendancePhotoAdvertised = ["canary_pending", "verified"].includes(photo.rows[0]?.state ?? "");
    const biometricAdvertised = config.BIOMETRIC_COLLECTION_ENABLED === "1" && device.biometricCollectionEnabled;

    reply.header("Cache-Control", "no-store");
    return reply.send({
      item: {
        device,
        evidence: evidence.rows[0] ?? {
          lastProtocolObservedAt: null,
          lastRegistrationAt: null,
          lastHeartbeatAt: null,
          observedPushProtocolVersion: null,
        },
        pushProfile: {
          transferMode: device.transferMode,
          deviceRole: device.deviceRole,
          heartbeatIntervalSeconds: device.heartbeatIntervalSeconds,
          desiredPushProtocolVersion: device.desiredPushProtocolVersion,
          baseTransferFlags: ["TransData", "AttLog"],
          biometricAdvertised,
          attendancePhotoAdvertised,
          idleAttendanceOnly: !biometricAdvertised && !attendancePhotoAdvertised,
        },
        activeUserInfoReadsRetired: true,
        arbitraryCommandEnabled: false,
      },
    });
  });

  app.get("/admin/attendance/adms/devices/:deviceId/physical/operations", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.read");
    if (!principal) return;
    const params = deviceParamsSchema.safeParse(request.params);
    const query = historyQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.status(400).send({ code: "INVALID_PHYSICAL_HISTORY", message: "Parameter history tidak valid." });
    const device = await requireDevice(pool, params.data.deviceId);
    if (!device) return reply.status(404).send({ code: "ADMS_DEVICE_NOT_FOUND", message: "Mesin tidak ditemukan." });

    const result = await pool.query<{
      id: string;
      capabilityKey: string;
      operationKey: string;
      mode: string;
      status: string;
      destructive: boolean;
      safeMetadata: Record<string, unknown>;
      failureCode: string | null;
      createdAt: Date;
      completedAt: Date | null;
      commandCount: number;
      succeededCommandCount: number;
      failedCommandCount: number;
      lastReturnCode: number | null;
    }>(
      `SELECT o.id, o.capability_key AS "capabilityKey", o.operation_key AS "operationKey",
              o.mode, o.status, o.destructive, o.safe_metadata AS "safeMetadata",
              o.failure_code AS "failureCode", o.created_at AS "createdAt",
              o.completed_at AS "completedAt",
              COUNT(c.id)::int AS "commandCount",
              COUNT(c.id) FILTER (WHERE c.status = 'succeeded')::int AS "succeededCommandCount",
              COUNT(c.id) FILTER (WHERE c.status = 'failed')::int AS "failedCommandCount",
              (ARRAY_AGG(c.return_code ORDER BY c.physical_sequence DESC NULLS LAST)
                FILTER (WHERE c.return_code IS NOT NULL))[1] AS "lastReturnCode"
       FROM attendance_adms_physical_operations o
       LEFT JOIN attendance_adms_commands c ON c.physical_operation_id = o.id
       WHERE o.device_id = $1
       GROUP BY o.id
       ORDER BY o.created_at DESC
       LIMIT $2`,
      [device.id, query.data.limit],
    );
    reply.header("Cache-Control", "no-store");
    return reply.send({ items: result.rows, rawWireCommandsReturned: false });
  });

  app.get("/admin/attendance/adms/devices/export.csv", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.export");
    if (!principal) return;
    const result = await pool.query(
      `SELECT serial_number, display_name, lifecycle, model, firmware_version,
              last_seen_at, last_successful_request_at, last_ip,
              device_role, transfer_mode, heartbeat_interval_seconds,
              desired_push_protocol_version, organizational_unit_id, area_context, worksite_label
       FROM attendance_adms_devices ORDER BY serial_number`,
    );
    return sendCsv(reply, "adms-device-inventory.csv", [
      ["serial_number", "display_name", "lifecycle", "model", "firmware_version", "last_seen_at", "last_successful_request_at", "last_ip", "device_role", "transfer_mode", "heartbeat_interval_seconds", "desired_push_protocol_version", "organizational_unit_id", "area_context", "worksite_label"],
      ...result.rows.map((row) => Object.values(row)),
    ]);
  });

  app.get("/admin/attendance/adms/devices/:deviceId/mappings/export.csv", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.export");
    if (!principal) return;
    const params = deviceParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: "INVALID_ADMS_DEVICE", message: "ID mesin tidak valid." });
    const result = await pool.query(
      `SELECT m.pin, m.employee_id, e.full_name, m.effective_from, m.effective_to, m.created_at
       FROM attendance_adms_employee_mappings m
       JOIN employees e ON e.id = m.employee_id
       WHERE m.device_id = $1
       ORDER BY m.pin, m.effective_from`,
      [params.data.deviceId],
    );
    return sendCsv(reply, `adms-mappings-${params.data.deviceId}.csv`, [
      ["pin", "employee_id", "full_name", "effective_from", "effective_to", "created_at"],
      ...result.rows.map((row) => Object.values(row)),
    ]);
  });

  app.get("/admin/attendance/adms/devices/:deviceId/work-codes/export.csv", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.export");
    if (!principal) return;
    const params = deviceParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: "INVALID_ADMS_DEVICE", message: "ID mesin tidak valid." });
    const result = await pool.query(
      `SELECT w.code, w.name, w.active, t.desired_state, t.delivery_state,
              t.last_command_id, t.updated_at
       FROM attendance_adms_work_code_targets t
       JOIN attendance_adms_work_codes w ON w.id = t.work_code_id
       WHERE t.device_id = $1
       ORDER BY w.code`,
      [params.data.deviceId],
    );
    return sendCsv(reply, `adms-work-codes-${params.data.deviceId}.csv`, [
      ["code", "name", "active", "desired_state", "delivery_state", "last_command_id", "updated_at"],
      ...result.rows.map((row) => Object.values(row)),
    ]);
  });

  app.get("/admin/attendance/adms/devices/:deviceId/physical/operations/export.csv", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.export");
    if (!principal) return;
    const params = deviceParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: "INVALID_ADMS_DEVICE", message: "ID mesin tidak valid." });
    const result = await pool.query(
      `SELECT o.id, o.capability_key, o.operation_key, o.mode, o.status, o.destructive,
              o.failure_code, o.safe_metadata, o.created_at, o.completed_at,
              COUNT(c.id)::int AS command_count,
              COUNT(c.id) FILTER (WHERE c.status = 'succeeded')::int AS command_succeeded,
              COUNT(c.id) FILTER (WHERE c.status = 'failed')::int AS command_failed,
              MAX(c.return_code) FILTER (WHERE c.return_code IS NOT NULL) AS observed_return_code
       FROM attendance_adms_physical_operations o
       LEFT JOIN attendance_adms_commands c ON c.physical_operation_id = o.id
       WHERE o.device_id = $1
       GROUP BY o.id
       ORDER BY o.created_at DESC`,
      [params.data.deviceId],
    );
    return sendCsv(reply, `adms-physical-operations-${params.data.deviceId}.csv`, [
      ["operation_id", "capability_key", "operation_key", "mode", "status", "destructive", "failure_code", "safe_metadata", "created_at", "completed_at", "command_count", "command_succeeded", "command_failed", "observed_return_code"],
      ...result.rows.map((row) => Object.values(row)),
    ]);
  });

  app.get("/admin/attendance/adms/devices/:deviceId/physical/audit/export.csv", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.export");
    if (!principal) return;
    const params = deviceParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: "INVALID_ADMS_DEVICE", message: "ID mesin tidak valid." });
    const result = await pool.query(
      `SELECT id, actor_account_id, action, after_state, created_at
       FROM attendance_adms_admin_audit_events
       WHERE device_id = $1
         AND action IN ('physical_operation_requested', 'physical_capability_updated', 'wdms_device_profile_updated')
       ORDER BY created_at DESC`,
      [params.data.deviceId],
    );
    return sendCsv(reply, `adms-physical-audit-${params.data.deviceId}.csv`, [
      ["audit_id", "actor_account_id", "action", "safe_after_state", "created_at"],
      ...result.rows.map((row) => Object.values(row)),
    ]);
  });

  app.get("/admin/attendance/adms/devices/:deviceId/attendance/export.csv", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.export");
    if (!principal) return;
    const params = deviceParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: "INVALID_ADMS_DEVICE", message: "ID mesin tidak valid." });
    const result = await pool.query(
      `SELECT id, pin, occurred_at_raw, occurred_at, raw_line, raw_fields,
              raw_line_sha256, source_request_id, received_at
       FROM attendance_adms_events
       WHERE device_id = $1
       ORDER BY received_at DESC, id DESC`,
      [params.data.deviceId],
    );
    return sendCsv(reply, `adms-raw-attendance-${params.data.deviceId}.csv`, [
      ["event_id", "pin", "occurred_at_raw", "occurred_at", "raw_line", "raw_fields", "raw_line_sha256", "source_request_id", "received_at"],
      ...result.rows.map((row) => Object.values(row)),
    ]);
  });
}
