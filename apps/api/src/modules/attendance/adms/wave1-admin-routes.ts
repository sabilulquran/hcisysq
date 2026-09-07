import type { AdminPermission } from "../../auth/permissions.js";
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../../config/env.js";
import { requirePermissionsFromCookie } from "../../auth/authorization.js";
import { AuthError, AuthService, type AuthPrincipal } from "../../auth/service.js";
import {
  attlogRangeWireCommand,
  formatDeviceLocalTimestamp,
} from "./protocol.js";

const detectedIdSchema = z.object({ detectedId: z.string().uuid() });
const deviceIdSchema = z.object({ deviceId: z.string().uuid() });
const commandIdSchema = z.object({ commandId: z.string().uuid() });
const claimSchema = z.object({
  displayName: z.string().trim().max(160).nullable().optional(),
  timezone: z.string().trim().min(1).max(100).default("Asia/Jakarta"),
});
const rangeSchema = z.object({
  startAt: z.string().datetime({ offset: true }),
  endAt: z.string().datetime({ offset: true }),
});

type AdminCommandReason =
  | "admin_sync_new"
  | "admin_range_recovery"
  | "admin_read_information";
type AdminCommandType = "sync_new" | "data_query" | "read_info";

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

function validTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

async function writeAudit(
  client: PoolClient,
  input: {
    actorAccountId: string;
    action: "device_claimed" | "transfer_requested" | "command_requested" | "command_cancelled";
    deviceId: string | null;
    beforeState: unknown;
    afterState: unknown;
  },
) {
  await client.query(
    `INSERT INTO attendance_adms_admin_audit_events (
       id, actor_account_id, action, device_id, mapping_id, before_state, after_state
     ) VALUES ($1, $2, $3, $4, NULL, $5::jsonb, $6::jsonb)`,
    [
      randomUUID(),
      input.actorAccountId,
      input.action,
      input.deviceId,
      input.beforeState === null ? null : JSON.stringify(input.beforeState),
      input.afterState === null ? null : JSON.stringify(input.afterState),
    ],
  );
}

export async function registerAdmsWave1AdminRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required for ADMS Wave 1 routes");
  const auth = new AuthService(
    pool,
    config.AUTH_ENCRYPTION_KEY,
    config.AUTH_SESSION_TTL_HOURS,
    config.NODE_ENV === "production",
  );

  app.get("/admin/attendance/adms/detected-devices", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.read");
    if (!principal) return;
    const result = await pool.query(
      `SELECT
         id,
         serial_number AS "serialNumber",
         status,
         first_seen_at AS "firstSeenAt",
         last_seen_at AS "lastSeenAt",
         last_ip AS "lastIp",
         observed_count::int AS "observedCount",
         safe_metadata AS "safeMetadata",
         claimed_device_id AS "claimedDeviceId",
         claimed_at AS "claimedAt"
       FROM attendance_adms_detected_devices
       ORDER BY (status = 'detected') DESC, last_seen_at DESC`,
    );
    reply.header("Cache-Control", "no-store");
    return reply.send({ items: result.rows });
  });

  app.post("/admin/attendance/adms/detected-devices/:detectedId/claim", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.configure");
    if (!principal) return;
    const params = detectedIdSchema.safeParse(request.params);
    const body = claimSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success || !validTimezone(body.data.timezone)) {
      return reply.status(400).send({ code: "INVALID_ADMS_CLAIM", message: "Data claim mesin tidak valid." });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const detected = await client.query<{
        id: string;
        serialNumber: string;
        status: string;
      }>(
        `SELECT id, serial_number AS "serialNumber", status
         FROM attendance_adms_detected_devices
         WHERE id = $1
         FOR UPDATE`,
        [params.data.detectedId],
      );
      const candidate = detected.rows[0];
      if (!candidate) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ code: "ADMS_DETECTED_NOT_FOUND", message: "Mesin terdeteksi tidak ditemukan." });
      }
      if (candidate.status !== "detected") {
        await client.query("ROLLBACK");
        return reply.status(409).send({ code: "ADMS_ALREADY_CLAIMED", message: "Mesin terdeteksi sudah diproses." });
      }

      const deviceId = randomUUID();
      const inserted = await client.query(
        `INSERT INTO attendance_adms_devices (
           id, serial_number, lifecycle, timezone, display_name
         ) VALUES ($1, $2, 'disabled', $3, $4)
         RETURNING id, serial_number AS "serialNumber", lifecycle, timezone, display_name AS "displayName", created_at AS "createdAt"`,
        [deviceId, candidate.serialNumber, body.data.timezone, body.data.displayName ?? null],
      );
      await client.query(
        `UPDATE attendance_adms_detected_devices
         SET status = 'claimed', claimed_device_id = $2, claimed_at = now(), updated_at = now()
         WHERE id = $1`,
        [candidate.id, deviceId],
      );
      await writeAudit(client, {
        actorAccountId: principal.id,
        action: "device_claimed",
        deviceId,
        beforeState: candidate,
        afterState: inserted.rows[0],
      });
      await client.query("COMMIT");
      reply.header("Cache-Control", "no-store");
      return reply.status(201).send({ item: inserted.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      const databaseError = error as Error & { code?: string };
      if (databaseError.code === "23505") {
        return reply.status(409).send({ code: "ADMS_DEVICE_SERIAL_EXISTS", message: "Serial mesin sudah terdaftar." });
      }
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/admin/attendance/adms/devices/:deviceId/health", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.read");
    if (!principal) return;
    const params = deviceIdSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: "INVALID_ADMS_DEVICE", message: "ID mesin tidak valid." });

    const result = await pool.query<{
      id: string;
      lifecycle: string;
      lastSeenAt: Date | null;
      lastSuccessfulRequestAt: Date | null;
      lastIp: string | null;
      timeoutOverride: number | null;
      medianIntervalSeconds: number | null;
      lastCommandActivityAt: Date | null;
      lastTransactionActivityAt: Date | null;
      lastSuccessfulSyncAt: Date | null;
    }>(
      `WITH recent AS (
         SELECT received_at,
                EXTRACT(EPOCH FROM (received_at - lag(received_at) OVER (ORDER BY received_at))) AS gap_seconds
         FROM (
           SELECT received_at
           FROM attendance_adms_request_journal
           WHERE device_id = $1 AND response_status = 200
           ORDER BY received_at DESC
           LIMIT 12
         ) q
       ), cadence AS (
         SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_seconds) AS median_gap
         FROM recent
         WHERE gap_seconds > 0
       )
       SELECT
         d.id,
         d.lifecycle,
         d.last_seen_at AS "lastSeenAt",
         d.last_successful_request_at AS "lastSuccessfulRequestAt",
         d.last_ip AS "lastIp",
         d.connectivity_timeout_seconds AS "timeoutOverride",
         cadence.median_gap::float8 AS "medianIntervalSeconds",
         (SELECT max(updated_at) FROM attendance_adms_commands WHERE device_id = d.id) AS "lastCommandActivityAt",
         (SELECT max(received_at) FROM attendance_adms_events WHERE device_id = d.id) AS "lastTransactionActivityAt",
         (SELECT max(completed_at)
          FROM attendance_adms_commands
          WHERE device_id = d.id
            AND status = 'succeeded'
            AND reason IN ('registration_recovery', 'admin_sync_new', 'admin_range_recovery', 'scheduled_reconciliation')) AS "lastSuccessfulSyncAt"
       FROM attendance_adms_devices d
       CROSS JOIN cadence
       WHERE d.id = $1`,
      [params.data.deviceId],
    );
    const row = result.rows[0];
    if (!row) return reply.status(404).send({ code: "ADMS_DEVICE_NOT_FOUND", message: "Mesin tidak ditemukan." });

    const adaptive = row.medianIntervalSeconds === null
      ? null
      : Math.max(60, Math.min(900, Math.round(row.medianIntervalSeconds * 3)));
    const effectiveTimeoutSeconds = row.timeoutOverride ?? adaptive;
    const offlineAt = row.lastSeenAt && effectiveTimeoutSeconds
      ? new Date(row.lastSeenAt.getTime() + effectiveTimeoutSeconds * 1000)
      : null;
    const connectivityStatus = !row.lastSeenAt || !effectiveTimeoutSeconds
      ? "unknown"
      : offlineAt!.getTime() >= Date.now()
        ? "online"
        : "offline";

    reply.header("Cache-Control", "no-store");
    return reply.send({
      item: {
        deviceId: row.id,
        lifecycle: row.lifecycle,
        connectivityStatus,
        lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
        lastSuccessfulRequestAt: row.lastSuccessfulRequestAt?.toISOString() ?? null,
        lastIp: row.lastIp,
        observedMedianRequestIntervalSeconds: row.medianIntervalSeconds,
        connectivityTimeoutOverrideSeconds: row.timeoutOverride,
        effectiveConnectivityTimeoutSeconds: effectiveTimeoutSeconds,
        offlineAt: offlineAt?.toISOString() ?? null,
        lastCommandActivityAt: row.lastCommandActivityAt?.toISOString() ?? null,
        lastTransactionActivityAt: row.lastTransactionActivityAt?.toISOString() ?? null,
        lastSuccessfulSyncAt: row.lastSuccessfulSyncAt?.toISOString() ?? null,
      },
    });
  });

  app.get("/admin/attendance/adms/devices/:deviceId/commands", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.read");
    if (!principal) return;
    const params = deviceIdSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: "INVALID_ADMS_DEVICE", message: "ID mesin tidak valid." });
    const result = await pool.query(
      `SELECT
         id,
         command_number::text AS "commandNumber",
         command_type AS "commandType",
         reason,
         status,
         attempt_count AS "attemptCount",
         requested_range_start AS "requestedRangeStart",
         requested_range_end AS "requestedRangeEnd",
         expires_at AS "expiresAt",
         delivered_at AS "deliveredAt",
         acknowledged_at AS "acknowledgedAt",
         completed_at AS "completedAt",
         return_code AS "returnCode",
         created_at AS "createdAt",
         updated_at AS "updatedAt"
       FROM attendance_adms_commands
       WHERE device_id = $1
       ORDER BY created_at DESC, command_number DESC
       LIMIT 100`,
      [params.data.deviceId],
    );
    reply.header("Cache-Control", "no-store");
    return reply.send({ items: result.rows });
  });

  app.post("/admin/attendance/adms/devices/:deviceId/commands/read-information", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.operate");
    if (!principal) return;
    const params = deviceIdSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: "INVALID_ADMS_DEVICE", message: "ID mesin tidak valid." });
    return queueDeviceCommand(pool, reply, principal.id, params.data.deviceId, {
      commandType: "read_info",
      wireCommand: "INFO",
      reason: "admin_read_information",
      rangeStart: null,
      rangeEnd: null,
      auditAction: "command_requested",
    });
  });

  app.post("/admin/attendance/adms/devices/:deviceId/transfers/sync-new", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.operate");
    if (!principal) return;
    const params = deviceIdSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: "INVALID_ADMS_DEVICE", message: "ID mesin tidak valid." });
    return queueDeviceCommand(pool, reply, principal.id, params.data.deviceId, {
      commandType: "sync_new",
      wireCommand: "LOG",
      reason: "admin_sync_new",
      rangeStart: null,
      rangeEnd: null,
      auditAction: "transfer_requested",
    });
  });

  app.post("/admin/attendance/adms/devices/:deviceId/transfers/attendance-range", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.operate");
    if (!principal) return;
    const params = deviceIdSchema.safeParse(request.params);
    const body = rangeSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ code: "INVALID_ADMS_RANGE", message: "Rentang transaksi tidak valid." });
    }
    const startAt = new Date(body.data.startAt);
    const endAt = new Date(body.data.endAt);
    const duration = endAt.getTime() - startAt.getTime();
    if (duration < 0 || duration > 31 * 86_400_000) {
      return reply.status(400).send({ code: "ADMS_RANGE_TOO_LARGE", message: "Rentang maksimal 31 hari dan waktu akhir tidak boleh sebelum waktu awal." });
    }
    const device = await pool.query<{ timezone: string; lifecycle: string }>(
      `SELECT timezone, lifecycle FROM attendance_adms_devices WHERE id = $1`,
      [params.data.deviceId],
    );
    const target = device.rows[0];
    if (!target) {
      return reply.status(404).send({ code: "ADMS_DEVICE_NOT_FOUND", message: "Mesin tidak ditemukan." });
    }
    if (target.lifecycle !== "active") {
      return reply.status(409).send({ code: "ADMS_DEVICE_NOT_ACTIVE", message: "Historical upload hanya dapat diminta ke mesin aktif." });
    }
    const wireCommand = attlogRangeWireCommand(
      formatDeviceLocalTimestamp(startAt, target.timezone),
      formatDeviceLocalTimestamp(endAt, target.timezone),
    );
    return queueDeviceCommand(pool, reply, principal.id, params.data.deviceId, {
      commandType: "data_query",
      wireCommand,
      reason: "admin_range_recovery",
      rangeStart: startAt,
      rangeEnd: endAt,
      auditAction: "transfer_requested",
    });
  });

  app.post("/admin/attendance/adms/commands/:commandId/cancel", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.operate");
    if (!principal) return;
    const params = commandIdSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: "INVALID_ADMS_COMMAND", message: "ID command tidak valid." });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query<{ id: string; deviceId: string; status: string }>(
        `SELECT id, device_id AS "deviceId", status FROM attendance_adms_commands WHERE id = $1 FOR UPDATE`,
        [params.data.commandId],
      );
      const command = found.rows[0];
      if (!command) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ code: "ADMS_COMMAND_NOT_FOUND", message: "Command tidak ditemukan." });
      }
      if (command.status !== "pending") {
        await client.query("ROLLBACK");
        return reply.status(409).send({ code: "ADMS_COMMAND_NOT_CANCELLABLE", message: "Hanya command pending yang dapat dibatalkan." });
      }
      await client.query(
        `UPDATE attendance_adms_commands SET status = 'cancelled', completed_at = now(), updated_at = now() WHERE id = $1`,
        [command.id],
      );
      await client.query(
        `INSERT INTO attendance_adms_command_events (id, command_id, event_type, actor_account_id, metadata)
         VALUES ($1, $2, 'cancelled', $3, '{}'::jsonb)`,
        [randomUUID(), command.id, principal.id],
      );
      await writeAudit(client, {
        actorAccountId: principal.id,
        action: "command_cancelled",
        deviceId: command.deviceId,
        beforeState: command,
        afterState: { ...command, status: "cancelled" },
      });
      await client.query("COMMIT");
      return reply.status(204).send();
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/admin/attendance/adms/devices/:deviceId/transactions", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.read");
    if (!principal) return;
    const params = deviceIdSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: "INVALID_ADMS_DEVICE", message: "ID mesin tidak valid." });
    const result = await pool.query(
      `SELECT
         e.id,
         e.pin,
         e.occurred_at_raw AS "occurredAtRaw",
         e.occurred_at AS "occurredAt",
         e.received_at AS "receivedAt",
         e.source_request_id AS "sourceRequestId",
         m.employee_id AS "employeeId",
         emp.employee_number AS "employeeNumber",
         emp.full_name AS "employeeName"
       FROM attendance_adms_events e
       LEFT JOIN LATERAL (
         SELECT employee_id
         FROM attendance_adms_employee_mappings
         WHERE device_id = e.device_id
           AND pin = e.pin
           AND e.occurred_at >= effective_from
           AND (effective_to IS NULL OR e.occurred_at < effective_to)
         ORDER BY effective_from DESC
         LIMIT 1
       ) m ON true
       LEFT JOIN employees emp ON emp.id = m.employee_id
       WHERE e.device_id = $1
       ORDER BY e.occurred_at DESC, e.id DESC
       LIMIT 200`,
      [params.data.deviceId],
    );
    reply.header("Cache-Control", "no-store");
    return reply.send({ items: result.rows });
  });
}

async function queueDeviceCommand(
  pool: Pool,
  reply: FastifyReply,
  actorAccountId: string,
  deviceId: string,
  input: {
    commandType: AdminCommandType;
    wireCommand: string;
    reason: AdminCommandReason;
    rangeStart: Date | null;
    rangeEnd: Date | null;
    auditAction: "transfer_requested" | "command_requested";
  },
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const device = await client.query<{ id: string; lifecycle: string }>(
      `SELECT id, lifecycle FROM attendance_adms_devices WHERE id = $1 FOR UPDATE`,
      [deviceId],
    );
    if (!device.rows[0]) {
      await client.query("ROLLBACK");
      return reply.status(404).send({ code: "ADMS_DEVICE_NOT_FOUND", message: "Mesin tidak ditemukan." });
    }
    if (device.rows[0].lifecycle !== "active") {
      await client.query("ROLLBACK");
      return reply.status(409).send({ code: "ADMS_DEVICE_NOT_ACTIVE", message: "Command hanya dapat dikirim ke mesin aktif." });
    }
    const commandId = randomUUID();
    const inserted = await client.query(
      `INSERT INTO attendance_adms_commands (
         id, device_id, command_type, wire_command, reason, status,
         requested_by_account_id, requested_range_start, requested_range_end, expires_at
       ) VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, now() + interval '24 hours')
       RETURNING
         id,
         command_number::text AS "commandNumber",
         command_type AS "commandType",
         reason,
         status,
         expires_at AS "expiresAt",
         created_at AS "createdAt"`,
      [
        commandId,
        deviceId,
        input.commandType,
        input.wireCommand,
        input.reason,
        actorAccountId,
        input.rangeStart,
        input.rangeEnd,
      ],
    );
    await client.query(
      `INSERT INTO attendance_adms_command_events (
         id, command_id, event_type, actor_account_id, metadata
       ) VALUES ($1, $2, 'queued', $3, $4::jsonb)`,
      [
        randomUUID(),
        commandId,
        actorAccountId,
        JSON.stringify({
          reason: input.reason,
          commandType: input.commandType,
          rangeStart: input.rangeStart,
          rangeEnd: input.rangeEnd,
        }),
      ],
    );
    await writeAudit(client, {
      actorAccountId,
      action: input.auditAction,
      deviceId,
      beforeState: null,
      afterState: inserted.rows[0],
    });
    await client.query("COMMIT");
    reply.header("Cache-Control", "no-store");
    return reply.status(201).send({ item: inserted.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    const databaseError = error as Error & { code?: string };
    if (databaseError.code === "23505") {
      return reply.status(409).send({ code: "ADMS_COMMAND_ALREADY_ACTIVE", message: "Masih ada command yang belum selesai untuk mesin ini." });
    }
    throw error;
  } finally {
    client.release();
  }
}
