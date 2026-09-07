import type { AdminPermission } from "../../auth/permissions.js";
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../../config/env.js";
import { requirePermissionsFromCookie } from "../../auth/authorization.js";
import { AuthError, AuthService, type AuthPrincipal } from "../../auth/service.js";
import { normalizeDeviceSerial } from "./protocol.js";
import { projectAdmsAttendanceDay } from "./projection.js";

const deviceIdSchema = z.object({ deviceId: z.string().uuid() });
const mappingIdSchema = z.object({ mappingId: z.string().uuid() });
const createDeviceSchema = z.object({
  serialNumber: z.string().trim().min(1).max(128),
  displayName: z.string().trim().max(160).nullable().optional(),
  timezone: z.string().trim().min(1).max(100).default("Asia/Jakarta"),
});
const updateDeviceSchema = z
  .object({
    displayName: z.string().trim().max(160).nullable().optional(),
    lifecycle: z.enum(["active", "disabled", "quarantined"]).optional(),
    timezone: z.string().trim().min(1).max(100).optional(),
    model: z.string().trim().max(160).nullable().optional(),
    firmwareVersion: z.string().trim().max(160).nullable().optional(),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: "Minimal satu field harus diubah.",
  });
const createMappingSchema = z.object({
  pin: z.string().trim().min(1).max(128),
  employeeId: z.string().uuid(),
  effectiveFrom: z.string().datetime({ offset: true }).optional(),
});

export class AdmsAdminError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AdmsAdminError";
  }
}

function isValidTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
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

function sendAdminError(reply: FastifyReply, error: unknown) {
  if (error instanceof AdmsAdminError) {
    reply.header("Cache-Control", "no-store");
    return reply.status(error.statusCode).send({ code: error.code, message: error.message });
  }
  const databaseError = error as Error & { code?: string; constraint?: string };
  if (
    databaseError.code === "23505" &&
    databaseError.constraint === "attendance_adms_devices_serial_number_key"
  ) {
    return reply.status(409).send({
      code: "ADMS_DEVICE_SERIAL_EXISTS",
      message: "Serial mesin sudah terdaftar.",
    });
  }
  if (
    databaseError.code === "23505" &&
    databaseError.constraint === "attendance_adms_employee_mappings_active_pin_idx"
  ) {
    return reply.status(409).send({
      code: "ADMS_PIN_ALREADY_MAPPED",
      message: "PIN tersebut sudah mempunyai mapping aktif pada mesin ini.",
    });
  }
  throw error;
}

async function writeAdminAudit(
  client: PoolClient,
  input: {
    actorAccountId: string;
    action: "device_registered" | "device_updated" | "mapping_created" | "mapping_ended";
    deviceId: string | null;
    mappingId: string | null;
    beforeState: unknown;
    afterState: unknown;
  },
) {
  await client.query(
    `INSERT INTO attendance_adms_admin_audit_events (
       id, actor_account_id, action, device_id, mapping_id, before_state, after_state
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
    [
      randomUUID(),
      input.actorAccountId,
      input.action,
      input.deviceId,
      input.mappingId,
      input.beforeState === null ? null : JSON.stringify(input.beforeState),
      input.afterState === null ? null : JSON.stringify(input.afterState),
    ],
  );
}

async function loadDevice(db: Pool | PoolClient, deviceId: string) {
  const result = await db.query<{
    id: string;
    serialNumber: string;
    displayName: string | null;
    lifecycle: "active" | "disabled" | "quarantined";
    timezone: string;
    model: string | null;
    firmwareVersion: string | null;
    firstSeenAt: Date | null;
    lastSeenAt: Date | null;
    lastSuccessfulRequestAt: Date | null;
    lastIp: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>(
    `SELECT
       id,
       serial_number AS "serialNumber",
       display_name AS "displayName",
       lifecycle,
       timezone,
       model,
       firmware_version AS "firmwareVersion",
       first_seen_at AS "firstSeenAt",
       last_seen_at AS "lastSeenAt",
       last_successful_request_at AS "lastSuccessfulRequestAt",
       last_ip AS "lastIp",
       created_at AS "createdAt",
       updated_at AS "updatedAt"
     FROM attendance_adms_devices
     WHERE id = $1`,
    [deviceId],
  );
  return result.rows[0] ?? null;
}

async function loadMapping(db: Pool | PoolClient, mappingId: string) {
  const result = await db.query<{
    id: string;
    deviceId: string;
    pin: string;
    employeeId: string;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }>(
    `SELECT
       id,
       device_id AS "deviceId",
       pin,
       employee_id AS "employeeId",
       effective_from AS "effectiveFrom",
       effective_to AS "effectiveTo",
       created_at AS "createdAt",
       updated_at AS "updatedAt"
     FROM attendance_adms_employee_mappings
     WHERE id = $1`,
    [mappingId],
  );
  return result.rows[0] ?? null;
}

function mapDate(value: Date | null) {
  return value?.toISOString() ?? null;
}

function presentDevice<T extends {
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
  lastSuccessfulRequestAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>(row: T) {
  return {
    ...row,
    firstSeenAt: mapDate(row.firstSeenAt),
    lastSeenAt: mapDate(row.lastSeenAt),
    lastSuccessfulRequestAt: mapDate(row.lastSuccessfulRequestAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function reprojectMapping(pool: Pool, mappingId: string) {
  const targets = await pool.query<{ employeeId: string; attendanceDate: string }>(
    `SELECT DISTINCT
       m.employee_id AS "employeeId",
       ((e.occurred_at AT TIME ZONE 'Asia/Jakarta')::date)::text AS "attendanceDate"
     FROM attendance_adms_employee_mappings m
     JOIN attendance_adms_events e
       ON e.device_id = m.device_id
      AND e.pin = m.pin
      AND e.occurred_at >= m.effective_from
      AND (m.effective_to IS NULL OR e.occurred_at < m.effective_to)
     WHERE m.id = $1
     ORDER BY "attendanceDate"`,
    [mappingId],
  );
  const results = [];
  for (const target of targets.rows) {
    results.push(
      await projectAdmsAttendanceDay(pool, target.employeeId, target.attendanceDate),
    );
  }
  return results;
}

export async function registerAdmsAdminRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
) {
  if (!config.AUTH_ENCRYPTION_KEY) {
    throw new Error("AUTH_ENCRYPTION_KEY is required for ADMS admin routes");
  }
  const auth = new AuthService(
    pool,
    config.AUTH_ENCRYPTION_KEY,
    config.AUTH_SESSION_TTL_HOURS,
    config.NODE_ENV === "production",
  );

  app.get("/admin/attendance/adms/devices", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.read");
    if (!principal) return;
    const result = await pool.query<{
      id: string;
      serialNumber: string;
      displayName: string | null;
      lifecycle: "active" | "disabled" | "quarantined";
      timezone: string;
      model: string | null;
      firmwareVersion: string | null;
      firstSeenAt: Date | null;
      lastSeenAt: Date | null;
      lastSuccessfulRequestAt: Date | null;
      lastIp: string | null;
      createdAt: Date;
      updatedAt: Date;
      activeMappingCount: number;
      unmappedPinCount: number;
    }>(
      `SELECT
         d.id,
         d.serial_number AS "serialNumber",
         d.display_name AS "displayName",
         d.lifecycle,
         d.timezone,
         d.model,
         d.firmware_version AS "firmwareVersion",
         d.first_seen_at AS "firstSeenAt",
         d.last_seen_at AS "lastSeenAt",
         d.last_successful_request_at AS "lastSuccessfulRequestAt",
         d.last_ip AS "lastIp",
         d.created_at AS "createdAt",
         d.updated_at AS "updatedAt",
         (SELECT count(*)::int
          FROM attendance_adms_employee_mappings m
          WHERE m.device_id = d.id AND m.effective_to IS NULL) AS "activeMappingCount",
         (SELECT count(DISTINCT e.pin)::int
          FROM attendance_adms_events e
          WHERE e.device_id = d.id
            AND NOT EXISTS (
              SELECT 1
              FROM attendance_adms_employee_mappings m
              WHERE m.device_id = d.id
                AND m.pin = e.pin
                AND m.effective_to IS NULL
            )) AS "unmappedPinCount"
       FROM attendance_adms_devices d
       ORDER BY d.display_name NULLS LAST, d.serial_number`,
    );
    reply.header("Cache-Control", "no-store");
    return reply.send({ items: result.rows.map(presentDevice) });
  });

  app.post("/admin/attendance/adms/devices", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.configure");
    if (!principal) return;
    const body = createDeviceSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ code: "INVALID_ADMS_DEVICE", message: "Data mesin tidak valid." });
    }
    try {
      const serialNumber = normalizeDeviceSerial(body.data.serialNumber);
      if (!isValidTimezone(body.data.timezone)) {
        throw new AdmsAdminError(400, "INVALID_ADMS_TIMEZONE", "Timezone mesin tidak valid.");
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const id = randomUUID();
        const result = await client.query(
          `INSERT INTO attendance_adms_devices (
             id, serial_number, lifecycle, timezone, display_name
           ) VALUES ($1, $2, 'active', $3, $4)
           RETURNING
             id,
             serial_number AS "serialNumber",
             display_name AS "displayName",
             lifecycle,
             timezone,
             model,
             firmware_version AS "firmwareVersion",
             first_seen_at AS "firstSeenAt",
             last_seen_at AS "lastSeenAt",
             last_successful_request_at AS "lastSuccessfulRequestAt",
             last_ip AS "lastIp",
             created_at AS "createdAt",
             updated_at AS "updatedAt"`,
          [id, serialNumber, body.data.timezone, body.data.displayName ?? null],
        );
        const item = result.rows[0];
        await writeAdminAudit(client, {
          actorAccountId: principal.id,
          action: "device_registered",
          deviceId: id,
          mappingId: null,
          beforeState: null,
          afterState: item,
        });
        await client.query("COMMIT");
        reply.header("Cache-Control", "no-store");
        return reply.status(201).send({ item: presentDevice(item) });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      return sendAdminError(reply, error);
    }
  });

  app.get("/admin/attendance/adms/devices/:deviceId", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.read");
    if (!principal) return;
    const params = deviceIdSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ code: "INVALID_ADMS_DEVICE", message: "ID mesin tidak valid." });
    }
    const device = await loadDevice(pool, params.data.deviceId);
    if (!device) {
      return reply.status(404).send({ code: "ADMS_DEVICE_NOT_FOUND", message: "Mesin tidak ditemukan." });
    }
    const [mappings, observedPins, events, quarantines] = await Promise.all([
      pool.query(
        `SELECT
           m.id,
           m.pin,
           m.employee_id AS "employeeId",
           e.employee_number AS "employeeNumber",
           e.full_name AS "employeeName",
           m.effective_from AS "effectiveFrom",
           m.effective_to AS "effectiveTo",
           m.created_at AS "createdAt"
         FROM attendance_adms_employee_mappings m
         JOIN employees e ON e.id = m.employee_id
         WHERE m.device_id = $1
         ORDER BY (m.effective_to IS NULL) DESC, m.pin, m.effective_from DESC`,
        [device.id],
      ),
      pool.query(
        `SELECT
           raw.pin,
           raw.event_count AS "eventCount",
           raw.first_event_at AS "firstEventAt",
           raw.last_event_at AS "lastEventAt",
           m.id AS "mappingId",
           m.employee_id AS "employeeId",
           emp.employee_number AS "employeeNumber",
           emp.full_name AS "employeeName"
         FROM (
           SELECT
             pin,
             count(*)::int AS event_count,
             min(occurred_at) AS first_event_at,
             max(occurred_at) AS last_event_at
           FROM attendance_adms_events
           WHERE device_id = $1
           GROUP BY pin
         ) raw
         LEFT JOIN LATERAL (
           SELECT id, employee_id
           FROM attendance_adms_employee_mappings
           WHERE device_id = $1
             AND pin = raw.pin
             AND effective_to IS NULL
           ORDER BY effective_from DESC
           LIMIT 1
         ) m ON true
         LEFT JOIN employees emp ON emp.id = m.employee_id
         ORDER BY raw.last_event_at DESC, raw.pin
         LIMIT 100`,
        [device.id],
      ),
      pool.query(
        `SELECT
           id,
           pin,
           occurred_at AS "occurredAt",
           received_at AS "receivedAt",
           source_request_id AS "sourceRequestId"
         FROM attendance_adms_events
         WHERE device_id = $1
         ORDER BY occurred_at DESC, id DESC
         LIMIT 50`,
        [device.id],
      ),
      pool.query(
        `SELECT
           id,
           reason,
           details,
           created_at AS "createdAt",
           request_id AS "requestId"
         FROM attendance_adms_quarantines
         WHERE device_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT 50`,
        [device.id],
      ),
    ]);
    reply.header("Cache-Control", "no-store");
    return reply.send({
      item: presentDevice(device),
      mappings: mappings.rows,
      observedPins: observedPins.rows,
      recentEvents: events.rows,
      recentQuarantines: quarantines.rows,
    });
  });

  app.patch("/admin/attendance/adms/devices/:deviceId", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.configure");
    if (!principal) return;
    const params = deviceIdSchema.safeParse(request.params);
    const body = updateDeviceSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ code: "INVALID_ADMS_DEVICE", message: "Perubahan mesin tidak valid." });
    }
    try {
      if (body.data.timezone && !isValidTimezone(body.data.timezone)) {
        throw new AdmsAdminError(400, "INVALID_ADMS_TIMEZONE", "Timezone mesin tidak valid.");
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const before = await loadDevice(client, params.data.deviceId);
        if (!before) throw new AdmsAdminError(404, "ADMS_DEVICE_NOT_FOUND", "Mesin tidak ditemukan.");
        await client.query(
          `UPDATE attendance_adms_devices
           SET display_name = CASE WHEN $2::boolean THEN $3 ELSE display_name END,
               lifecycle = COALESCE($4, lifecycle),
               timezone = COALESCE($5, timezone),
               model = CASE WHEN $6::boolean THEN $7 ELSE model END,
               firmware_version = CASE WHEN $8::boolean THEN $9 ELSE firmware_version END,
               updated_at = now()
           WHERE id = $1`,
          [
            before.id,
            body.data.displayName !== undefined,
            body.data.displayName ?? null,
            body.data.lifecycle ?? null,
            body.data.timezone ?? null,
            body.data.model !== undefined,
            body.data.model ?? null,
            body.data.firmwareVersion !== undefined,
            body.data.firmwareVersion ?? null,
          ],
        );
        const after = await loadDevice(client, before.id);
        await writeAdminAudit(client, {
          actorAccountId: principal.id,
          action: "device_updated",
          deviceId: before.id,
          mappingId: null,
          beforeState: before,
          afterState: after,
        });
        await client.query("COMMIT");
        reply.header("Cache-Control", "no-store");
        return reply.send({ item: presentDevice(after!) });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      return sendAdminError(reply, error);
    }
  });

  app.post("/admin/attendance/adms/devices/:deviceId/mappings", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.operate");
    if (!principal) return;
    const params = deviceIdSchema.safeParse(request.params);
    const body = createMappingSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ code: "INVALID_ADMS_MAPPING", message: "Mapping PIN tidak valid." });
    }
    try {
      const effectiveFrom = body.data.effectiveFrom ? new Date(body.data.effectiveFrom) : new Date();
      const now = new Date();
      const oldestAllowed = now.getTime() - 62 * 86_400_000;
      if (
        effectiveFrom.getTime() < oldestAllowed ||
        effectiveFrom.getTime() > now.getTime() + 5 * 60_000
      ) {
        throw new AdmsAdminError(
          400,
          "ADMS_MAPPING_EFFECTIVE_RANGE_INVALID",
          "Awal mapping harus berada dalam 62 hari terakhir dan tidak jauh di masa depan.",
        );
      }
      const client = await pool.connect();
      let mappingId = "";
      let mapping: unknown = null;
      try {
        await client.query("BEGIN");
        const device = await loadDevice(client, params.data.deviceId);
        if (!device) throw new AdmsAdminError(404, "ADMS_DEVICE_NOT_FOUND", "Mesin tidak ditemukan.");
        const employee = await client.query<{ id: string; status: string }>(
          `SELECT id, status FROM employees WHERE id = $1 FOR UPDATE`,
          [body.data.employeeId],
        );
        if (!employee.rows[0]) {
          throw new AdmsAdminError(404, "EMPLOYEE_NOT_FOUND", "Pegawai tidak ditemukan.");
        }
        if (employee.rows[0].status !== "active") {
          throw new AdmsAdminError(409, "EMPLOYEE_NOT_ACTIVE", "Mapping hanya dapat dibuat ke pegawai aktif.");
        }
        mappingId = randomUUID();
        const inserted = await client.query(
          `INSERT INTO attendance_adms_employee_mappings (
             id, device_id, pin, employee_id, effective_from, created_by_account_id
           ) VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING
             id,
             device_id AS "deviceId",
             pin,
             employee_id AS "employeeId",
             effective_from AS "effectiveFrom",
             effective_to AS "effectiveTo",
             created_at AS "createdAt"`,
          [mappingId, device.id, body.data.pin, body.data.employeeId, effectiveFrom, principal.id],
        );
        mapping = inserted.rows[0];
        await writeAdminAudit(client, {
          actorAccountId: principal.id,
          action: "mapping_created",
          deviceId: device.id,
          mappingId,
          beforeState: null,
          afterState: mapping,
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      let projection: unknown = null;
      try {
        projection = await reprojectMapping(pool, mappingId);
      } catch (error) {
        request.log.error({ err: error, mappingId }, "ADMS mapping re-projection failed");
      }
      reply.header("Cache-Control", "no-store");
      return reply.status(201).send({ item: mapping, projection });
    } catch (error) {
      return sendAdminError(reply, error);
    }
  });

  app.delete("/admin/attendance/adms/mappings/:mappingId", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.operate");
    if (!principal) return;
    const params = mappingIdSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ code: "INVALID_ADMS_MAPPING", message: "ID mapping tidak valid." });
    }
    try {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const before = await loadMapping(client, params.data.mappingId);
        if (!before) throw new AdmsAdminError(404, "ADMS_MAPPING_NOT_FOUND", "Mapping tidak ditemukan.");
        if (before.effectiveTo) {
          throw new AdmsAdminError(409, "ADMS_MAPPING_ALREADY_ENDED", "Mapping sudah tidak aktif.");
        }
        const now = new Date();
        if (now.getTime() <= before.effectiveFrom.getTime()) {
          throw new AdmsAdminError(409, "ADMS_MAPPING_NOT_STARTED", "Mapping yang belum mulai tidak dapat diakhiri dengan waktu sekarang.");
        }
        await client.query(
          `UPDATE attendance_adms_employee_mappings
           SET effective_to = $2,
               ended_by_account_id = $3,
               updated_at = $2
           WHERE id = $1`,
          [before.id, now, principal.id],
        );
        const after = await loadMapping(client, before.id);
        await writeAdminAudit(client, {
          actorAccountId: principal.id,
          action: "mapping_ended",
          deviceId: before.deviceId,
          mappingId: before.id,
          beforeState: before,
          afterState: after,
        });
        await client.query("COMMIT");
        reply.header("Cache-Control", "no-store");
        return reply.status(204).send();
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      return sendAdminError(reply, error);
    }
  });
}
