import type { AdminPermission } from "../../auth/permissions.js";
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../../config/env.js";
import { requirePermissionsFromCookie } from "../../auth/authorization.js";
import { AuthError, AuthService, type AuthPrincipal } from "../../auth/service.js";
import {
  deliveryCapabilitySummary,
  loadPhysicalCapabilitySnapshots,
  operationsCapabilities,
} from "./operations-capability-state.js";
import {
  ADMS_MAX_BODY_BYTES,
  attlogEventIdentity,
  bodySha256,
  parseAttlogText,
} from "./protocol.js";
import { projectAdmsAttendanceDay } from "./projection.js";

const deviceIdSchema = z.object({ deviceId: z.string().uuid() });
const workCodeTargetParamsSchema = z.object({ deviceId: z.string().uuid(), workCodeId: z.string().uuid() });
const messageTargetParamsSchema = z.object({ deviceId: z.string().uuid(), messageId: z.string().uuid() });
const messageIdSchema = z.object({ messageId: z.string().uuid() });
const filterIdSchema = z.object({ filterId: z.string().uuid() });
const workCodeSchema = z.object({
  code: z.string().trim().regex(/^[0-9A-Za-z._-]{1,32}$/),
  name: z.string().trim().min(1).max(120),
  active: z.boolean().default(true),
});
const targetSchema = z.object({ desiredState: z.enum(["present", "absent"]) });
const messageCreateSchema = z.object({
  audience: z.enum(["public", "private"]),
  employeeId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(120),
  messageText: z.string().trim().min(1).max(500),
  startsAt: z.string().datetime({ offset: true }).nullable().optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  active: z.boolean().default(true),
}).superRefine((value, ctx) => {
  if (value.audience === "private" && !value.employeeId) {
    ctx.addIssue({ code: "custom", message: "Pesan private memerlukan employeeId." });
  }
  if (value.audience === "public" && value.employeeId) {
    ctx.addIssue({ code: "custom", message: "Pesan public tidak boleh mempunyai employeeId." });
  }
  if (value.startsAt && value.endsAt && new Date(value.endsAt) <= new Date(value.startsAt)) {
    ctx.addIssue({ code: "custom", message: "endsAt harus setelah startsAt." });
  }
});
const messageUpdateSchema = z.object({
  active: z.boolean().optional(),
  title: z.string().trim().min(1).max(120).optional(),
  messageText: z.string().trim().min(1).max(500).optional(),
  startsAt: z.string().datetime({ offset: true }).nullable().optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
}).refine((value) => Object.values(value).some((item) => item !== undefined), {
  message: "Minimal satu field harus diubah.",
});
const savedFilterSchema = z.object({
  deviceId: z.string().uuid().nullable().optional(),
  viewKey: z.enum(["transactions", "commands", "logs"]),
  name: z.string().trim().min(1).max(80),
  criteria: z.record(z.string(), z.unknown()).default({}),
});
const savedFilterQuerySchema = z.object({
  deviceId: z.string().uuid().optional(),
  viewKey: z.enum(["transactions", "commands", "logs"]).optional(),
});
const exportQuerySchema = z.object({
  startAt: z.string().datetime({ offset: true }).optional(),
  endAt: z.string().datetime({ offset: true }).optional(),
  pin: z.string().regex(/^\d{1,128}$/).optional(),
});
const offlineImportSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  content: z.string().min(1),
});

type AuditAction =
  | "work_code_saved"
  | "work_code_target_updated"
  | "device_message_saved"
  | "device_message_target_updated"
  | "offline_attlog_imported"
  | "saved_filter_saved"
  | "saved_filter_deleted"
  | "pending_commands_cleared";

type DeviceRow = {
  id: string;
  serialNumber: string;
  displayName: string | null;
  lifecycle: "active" | "disabled" | "quarantined";
  timezone: string;
  model: string | null;
  firmwareVersion: string | null;
  lastSuccessfulRequestAt: Date | null;
};

class Wave3Error extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "Wave3Error";
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

function sendWave3Error(reply: FastifyReply, error: unknown) {
  if (error instanceof Wave3Error) {
    reply.header("Cache-Control", "no-store");
    return reply.status(error.statusCode).send({ code: error.code, message: error.message });
  }
  throw error;
}

async function writeAudit(
  client: PoolClient,
  input: {
    actorAccountId: string;
    action: AuditAction;
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

async function loadDevice(db: Pool | PoolClient, deviceId: string): Promise<DeviceRow | null> {
  const result = await db.query<DeviceRow>(
    `SELECT
       id,
       serial_number AS "serialNumber",
       display_name AS "displayName",
       lifecycle,
       timezone,
       model,
       firmware_version AS "firmwareVersion",
       last_successful_request_at AS "lastSuccessfulRequestAt"
     FROM attendance_adms_devices
     WHERE id = $1`,
    [deviceId],
  );
  return result.rows[0] ?? null;
}

async function requireDevice(db: Pool | PoolClient, deviceId: string) {
  const device = await loadDevice(db, deviceId);
  if (!device) throw new Wave3Error(404, "ADMS_DEVICE_NOT_FOUND", "Mesin tidak ditemukan.");
  return device;
}

async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
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

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export async function registerAdmsWave3AdminRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required for ADMS Wave 3 Admin routes");
  const auth = new AuthService(
    pool,
    config.AUTH_ENCRYPTION_KEY,
    config.AUTH_SESSION_TTL_HOURS,
    config.NODE_ENV === "production",
  );

  app.get("/admin/attendance/adms/devices/:deviceId/operations", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.read");
    if (!principal) return;
    const params = deviceIdSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: "INVALID_ADMS_DEVICE", message: "ID mesin tidak valid." });
    try {
      const device = await requireDevice(pool, params.data.deviceId);
      const [pending, physicalCapabilities] = await Promise.all([
        pool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM attendance_adms_commands WHERE device_id = $1 AND status = 'pending'`,
          [device.id],
        ),
        loadPhysicalCapabilitySnapshots(pool, device.id),
      ]);
      reply.header("Cache-Control", "no-store");
      return reply.send({
        item: {
          device,
          pendingCommandCount: pending.rows[0]?.count ?? 0,
          rawPayloadExposed: false,
          arbitraryCommandEnabled: false,
          userInfoReadsRetired: true,
          operationalRetention: {
            deletionEnabled: false,
            state: "policy_required",
            note: "Retention cleanup belum mengeksekusi DELETE sampai kebijakan retention HCIS disetujui.",
          },
          capabilities: operationsCapabilities(physicalCapabilities),
        },
      });
    } catch (error) {
      return sendWave3Error(reply, error);
    }
  });

  app.get("/admin/attendance/adms/devices/:deviceId/work-codes", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.read");
    if (!principal) return;
    const params = deviceIdSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: "INVALID_ADMS_DEVICE", message: "ID mesin tidak valid." });
    try {
      const device = await requireDevice(pool, params.data.deviceId);
      const [result, physicalCapabilities] = await Promise.all([
        pool.query(
          `SELECT
             w.id, w.code, w.name, w.active,
             t.desired_state AS "desiredState",
             COALESCE(t.delivery_state, 'not_verified') AS "deliveryState",
             w.created_at AS "createdAt", w.updated_at AS "updatedAt"
           FROM attendance_adms_work_codes w
           LEFT JOIN attendance_adms_work_code_targets t
             ON t.work_code_id = w.id AND t.device_id = $1
           ORDER BY w.active DESC, w.code`,
          [device.id],
        ),
        loadPhysicalCapabilitySnapshots(pool, device.id),
      ]);
      const delivery = deliveryCapabilitySummary(physicalCapabilities, "work_code_delivery", "Work Code");
      reply.header("Cache-Control", "no-store");
      return reply.send({
        deliveryCapability: delivery.state,
        note: delivery.note,
        items: result.rows,
      });
    } catch (error) {
      return sendWave3Error(reply, error);
    }
  });

  app.post("/admin/attendance/adms/work-codes", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.operate");
    if (!principal) return;
    const body = workCodeSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ code: "INVALID_WORK_CODE", message: "Work Code tidak valid." });
    try {
      const result = await withTransaction(pool, async (client) => {
        const before = await client.query(`SELECT id, code, name, active FROM attendance_adms_work_codes WHERE code = $1 FOR UPDATE`, [body.data.code]);
        const saved = await client.query(
          `INSERT INTO attendance_adms_work_codes (id, code, name, active, created_by_account_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (code) DO UPDATE
           SET name = EXCLUDED.name, active = EXCLUDED.active, updated_at = now()
           RETURNING id, code, name, active, created_at AS "createdAt", updated_at AS "updatedAt"`,
          [randomUUID(), body.data.code, body.data.name, body.data.active, principal.id],
        );
        await writeAudit(client, { actorAccountId: principal.id, action: "work_code_saved", deviceId: null, beforeState: before.rows[0] ?? null, afterState: saved.rows[0] });
        return { item: saved.rows[0], created: !before.rows[0] };
      });
      reply.header("Cache-Control", "no-store");
      return reply.status(result.created ? 201 : 200).send({ item: result.item });
    } catch (error) {
      return sendWave3Error(reply, error);
    }
  });

  app.put("/admin/attendance/adms/devices/:deviceId/work-codes/:workCodeId", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.operate");
    if (!principal) return;
    const params = workCodeTargetParamsSchema.safeParse(request.params);
    const body = targetSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ code: "INVALID_WORK_CODE_TARGET", message: "Target Work Code tidak valid." });
    try {
      const item = await withTransaction(pool, async (client) => {
        const device = await requireDevice(client, params.data.deviceId);
        const workCode = await client.query(`SELECT id FROM attendance_adms_work_codes WHERE id = $1`, [params.data.workCodeId]);
        if (!workCode.rows[0]) throw new Wave3Error(404, "WORK_CODE_NOT_FOUND", "Work Code tidak ditemukan.");
        const before = await client.query(`SELECT desired_state AS "desiredState", delivery_state AS "deliveryState" FROM attendance_adms_work_code_targets WHERE work_code_id = $1 AND device_id = $2 FOR UPDATE`, [params.data.workCodeId, device.id]);
        const saved = await client.query(
          `INSERT INTO attendance_adms_work_code_targets (
             work_code_id, device_id, desired_state, delivery_state, updated_by_account_id
           ) VALUES ($1, $2, $3, 'not_verified', $4)
           ON CONFLICT (work_code_id, device_id) DO UPDATE
           SET desired_state = EXCLUDED.desired_state,
               delivery_state = 'not_verified',
               updated_by_account_id = EXCLUDED.updated_by_account_id,
               updated_at = now()
           RETURNING desired_state AS "desiredState", delivery_state AS "deliveryState", updated_at AS "updatedAt"`,
          [params.data.workCodeId, device.id, body.data.desiredState, principal.id],
        );
        await writeAudit(client, { actorAccountId: principal.id, action: "work_code_target_updated", deviceId: device.id, beforeState: before.rows[0] ?? null, afterState: { workCodeId: params.data.workCodeId, ...saved.rows[0] } });
        return saved.rows[0];
      });
      reply.header("Cache-Control", "no-store");
      return reply.send({ item, commandCreated: false });
    } catch (error) {
      return sendWave3Error(reply, error);
    }
  });

  app.get("/admin/attendance/adms/devices/:deviceId/messages", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.read");
    if (!principal) return;
    const params = deviceIdSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: "INVALID_ADMS_DEVICE", message: "ID mesin tidak valid." });
    try {
      const device = await requireDevice(pool, params.data.deviceId);
      const [result, physicalCapabilities] = await Promise.all([
        pool.query(
          `SELECT
             m.id, m.audience, m.employee_id AS "employeeId",
             e.employee_number AS "employeeNumber", e.full_name AS "employeeName",
             m.title, m.message_text AS "messageText",
             m.starts_at AS "startsAt", m.ends_at AS "endsAt", m.active,
             t.desired_state AS "desiredState",
             COALESCE(t.delivery_state, 'not_verified') AS "deliveryState",
             m.created_at AS "createdAt", m.updated_at AS "updatedAt"
           FROM attendance_adms_device_messages m
           LEFT JOIN employees e ON e.id = m.employee_id
           LEFT JOIN attendance_adms_device_message_targets t
             ON t.message_id = m.id AND t.device_id = $1
           ORDER BY m.active DESC, m.created_at DESC`,
          [device.id],
        ),
        loadPhysicalCapabilitySnapshots(pool, device.id),
      ]);
      const delivery = deliveryCapabilitySummary(physicalCapabilities, "message_delivery", "Pesan perangkat");
      reply.header("Cache-Control", "no-store");
      return reply.send({
        deliveryCapability: delivery.state,
        note: delivery.note,
        items: result.rows,
      });
    } catch (error) {
      return sendWave3Error(reply, error);
    }
  });

  app.post("/admin/attendance/adms/messages", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.operate");
    if (!principal) return;
    const body = messageCreateSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ code: "INVALID_DEVICE_MESSAGE", message: "Pesan perangkat tidak valid." });
    try {
      if (body.data.employeeId) {
        const employee = await pool.query(`SELECT id FROM employees WHERE id = $1`, [body.data.employeeId]);
        if (!employee.rows[0]) throw new Wave3Error(404, "EMPLOYEE_NOT_FOUND", "Pegawai tidak ditemukan.");
      }
      const item = await withTransaction(pool, async (client) => {
        const saved = await client.query(
          `INSERT INTO attendance_adms_device_messages (
             id, audience, employee_id, title, message_text, starts_at, ends_at, active, created_by_account_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id, audience, employee_id AS "employeeId", title, message_text AS "messageText",
             starts_at AS "startsAt", ends_at AS "endsAt", active, created_at AS "createdAt", updated_at AS "updatedAt"`,
          [randomUUID(), body.data.audience, body.data.employeeId ?? null, body.data.title, body.data.messageText, body.data.startsAt ?? null, body.data.endsAt ?? null, body.data.active, principal.id],
        );
        await writeAudit(client, { actorAccountId: principal.id, action: "device_message_saved", deviceId: null, beforeState: null, afterState: saved.rows[0] });
        return saved.rows[0];
      });
      reply.header("Cache-Control", "no-store");
      return reply.status(201).send({ item });
    } catch (error) {
      return sendWave3Error(reply, error);
    }
  });

  app.patch("/admin/attendance/adms/messages/:messageId", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.operate");
    if (!principal) return;
    const params = messageIdSchema.safeParse(request.params);
    const body = messageUpdateSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ code: "INVALID_DEVICE_MESSAGE", message: "Perubahan pesan tidak valid." });
    try {
      const item = await withTransaction(pool, async (client) => {
        const before = await client.query<{ id: string; title: string; messageText: string; startsAt: Date | null; endsAt: Date | null; active: boolean }>(
          `SELECT id, title, message_text AS "messageText", starts_at AS "startsAt", ends_at AS "endsAt", active
           FROM attendance_adms_device_messages WHERE id = $1 FOR UPDATE`,
          [params.data.messageId],
        );
        const current = before.rows[0];
        if (!current) throw new Wave3Error(404, "DEVICE_MESSAGE_NOT_FOUND", "Pesan tidak ditemukan.");
        const startsAt = body.data.startsAt === undefined ? current.startsAt : body.data.startsAt;
        const endsAt = body.data.endsAt === undefined ? current.endsAt : body.data.endsAt;
        if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) {
          throw new Wave3Error(400, "INVALID_DEVICE_MESSAGE_RANGE", "Waktu selesai harus setelah waktu mulai.");
        }
        const saved = await client.query(
          `UPDATE attendance_adms_device_messages
           SET title = COALESCE($2, title),
               message_text = COALESCE($3, message_text),
               starts_at = CASE WHEN $4::boolean THEN $5::timestamptz ELSE starts_at END,
               ends_at = CASE WHEN $6::boolean THEN $7::timestamptz ELSE ends_at END,
               active = COALESCE($8::boolean, active),
               updated_at = now()
           WHERE id = $1
           RETURNING id, audience, employee_id AS "employeeId", title, message_text AS "messageText",
             starts_at AS "startsAt", ends_at AS "endsAt", active, created_at AS "createdAt", updated_at AS "updatedAt"`,
          [params.data.messageId, body.data.title ?? null, body.data.messageText ?? null, body.data.startsAt !== undefined, body.data.startsAt ?? null, body.data.endsAt !== undefined, body.data.endsAt ?? null, body.data.active ?? null],
        );
        await writeAudit(client, { actorAccountId: principal.id, action: "device_message_saved", deviceId: null, beforeState: current, afterState: saved.rows[0] });
        return saved.rows[0];
      });
      reply.header("Cache-Control", "no-store");
      return reply.send({ item });
    } catch (error) {
      return sendWave3Error(reply, error);
    }
  });

  app.put("/admin/attendance/adms/devices/:deviceId/messages/:messageId", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.operate");
    if (!principal) return;
    const params = messageTargetParamsSchema.safeParse(request.params);
    const body = targetSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ code: "INVALID_DEVICE_MESSAGE_TARGET", message: "Target pesan tidak valid." });
    try {
      const item = await withTransaction(pool, async (client) => {
        const device = await requireDevice(client, params.data.deviceId);
        const message = await client.query(`SELECT id FROM attendance_adms_device_messages WHERE id = $1`, [params.data.messageId]);
        if (!message.rows[0]) throw new Wave3Error(404, "DEVICE_MESSAGE_NOT_FOUND", "Pesan tidak ditemukan.");
        const before = await client.query(`SELECT desired_state AS "desiredState", delivery_state AS "deliveryState" FROM attendance_adms_device_message_targets WHERE message_id = $1 AND device_id = $2 FOR UPDATE`, [params.data.messageId, device.id]);
        const saved = await client.query(
          `INSERT INTO attendance_adms_device_message_targets (
             message_id, device_id, desired_state, delivery_state, updated_by_account_id
           ) VALUES ($1, $2, $3, 'not_verified', $4)
           ON CONFLICT (message_id, device_id) DO UPDATE
           SET desired_state = EXCLUDED.desired_state,
               delivery_state = 'not_verified',
               updated_by_account_id = EXCLUDED.updated_by_account_id,
               updated_at = now()
           RETURNING desired_state AS "desiredState", delivery_state AS "deliveryState", updated_at AS "updatedAt"`,
          [params.data.messageId, device.id, body.data.desiredState, principal.id],
        );
        await writeAudit(client, { actorAccountId: principal.id, action: "device_message_target_updated", deviceId: device.id, beforeState: before.rows[0] ?? null, afterState: { messageId: params.data.messageId, ...saved.rows[0] } });
        return saved.rows[0];
      });
      reply.header("Cache-Control", "no-store");
      return reply.send({ item, commandCreated: false });
    } catch (error) {
      return sendWave3Error(reply, error);
    }
  });

  app.get("/admin/attendance/adms/saved-filters", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.read");
    if (!principal) return;
    const query = savedFilterQuerySchema.safeParse(request.query);
    if (!query.success) return reply.status(400).send({ code: "INVALID_SAVED_FILTER_QUERY", message: "Filter tersimpan tidak valid." });
    const result = await pool.query(
      `SELECT id, device_id AS "deviceId", view_key AS "viewKey", name, criteria,
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM attendance_adms_saved_filters
       WHERE owner_account_id = $1
         AND ($2::uuid IS NULL OR device_id = $2)
         AND ($3::text IS NULL OR view_key = $3)
       ORDER BY updated_at DESC, name`,
      [principal.id, query.data.deviceId ?? null, query.data.viewKey ?? null],
    );
    reply.header("Cache-Control", "no-store");
    return reply.send({ items: result.rows });
  });

  app.post("/admin/attendance/adms/saved-filters", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.operate");
    if (!principal) return;
    const body = savedFilterSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ code: "INVALID_SAVED_FILTER", message: "Filter tersimpan tidak valid." });
    try {
      if (body.data.deviceId) await requireDevice(pool, body.data.deviceId);
      const item = await withTransaction(pool, async (client) => {
        const saved = await client.query(
          `INSERT INTO attendance_adms_saved_filters (
             id, owner_account_id, device_id, view_key, name, criteria
           ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
           ON CONFLICT (owner_account_id, device_id, view_key, name) DO UPDATE
           SET criteria = EXCLUDED.criteria, updated_at = now()
           RETURNING id, device_id AS "deviceId", view_key AS "viewKey", name, criteria,
                     created_at AS "createdAt", updated_at AS "updatedAt"`,
          [randomUUID(), principal.id, body.data.deviceId ?? null, body.data.viewKey, body.data.name, JSON.stringify(body.data.criteria)],
        );
        await writeAudit(client, { actorAccountId: principal.id, action: "saved_filter_saved", deviceId: body.data.deviceId ?? null, beforeState: null, afterState: { filterId: saved.rows[0].id, viewKey: body.data.viewKey, name: body.data.name } });
        return saved.rows[0];
      });
      reply.header("Cache-Control", "no-store");
      return reply.send({ item });
    } catch (error) {
      return sendWave3Error(reply, error);
    }
  });

  app.delete("/admin/attendance/adms/saved-filters/:filterId", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.operate");
    if (!principal) return;
    const params = filterIdSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: "INVALID_SAVED_FILTER", message: "ID filter tidak valid." });
    try {
      await withTransaction(pool, async (client) => {
        const deleted = await client.query<{ id: string; deviceId: string | null; viewKey: string; name: string }>(
          `DELETE FROM attendance_adms_saved_filters
           WHERE id = $1 AND owner_account_id = $2
           RETURNING id, device_id AS "deviceId", view_key AS "viewKey", name`,
          [params.data.filterId, principal.id],
        );
        const item = deleted.rows[0];
        if (!item) throw new Wave3Error(404, "SAVED_FILTER_NOT_FOUND", "Filter tidak ditemukan.");
        await writeAudit(client, { actorAccountId: principal.id, action: "saved_filter_deleted", deviceId: item.deviceId, beforeState: item, afterState: null });
      });
      return reply.status(204).send();
    } catch (error) {
      return sendWave3Error(reply, error);
    }
  });

  app.post("/admin/attendance/adms/devices/:deviceId/commands/clear-pending", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.destructive");
    if (!principal) return;
    const params = deviceIdSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: "INVALID_ADMS_DEVICE", message: "ID mesin tidak valid." });
    try {
      const cancelledCount = await withTransaction(pool, async (client) => {
        const device = await requireDevice(client, params.data.deviceId);
        const cancelled = await client.query<{ id: string; commandNumber: string }>(
          `UPDATE attendance_adms_commands
           SET status = 'cancelled', completed_at = now(), updated_at = now()
           WHERE device_id = $1 AND status = 'pending'
           RETURNING id, command_number::text AS "commandNumber"`,
          [device.id],
        );
        for (const command of cancelled.rows) {
          await client.query(
            `INSERT INTO attendance_adms_command_events (
               id, command_id, event_type, actor_account_id, metadata
             ) VALUES ($1, $2, 'cancelled', $3, $4::jsonb)`,
            [randomUUID(), command.id, principal.id, JSON.stringify({ reason: "admin_clear_pending" })],
          );
        }
        await writeAudit(client, { actorAccountId: principal.id, action: "pending_commands_cleared", deviceId: device.id, beforeState: { pendingCount: cancelled.rows.length }, afterState: { cancelledCommandNumbers: cancelled.rows.map((item) => item.commandNumber) } });
        return cancelled.rows.length;
      });
      reply.header("Cache-Control", "no-store");
      return reply.send({ cancelledCount, deliveredOrAcknowledgedCommandsUntouched: true });
    } catch (error) {
      return sendWave3Error(reply, error);
    }
  });

  app.get("/admin/attendance/adms/devices/:deviceId/transactions/export.csv", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.export");
    if (!principal) return;
    const params = deviceIdSchema.safeParse(request.params);
    const query = exportQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.status(400).send({ code: "INVALID_TRANSACTION_EXPORT", message: "Parameter export tidak valid." });
    try {
      const device = await requireDevice(pool, params.data.deviceId);
      const startAt = query.data.startAt ? new Date(query.data.startAt) : null;
      const endAt = query.data.endAt ? new Date(query.data.endAt) : null;
      if (startAt && endAt && endAt < startAt) throw new Wave3Error(400, "INVALID_TRANSACTION_EXPORT_RANGE", "Waktu selesai tidak boleh sebelum waktu mulai.");
      const result = await pool.query<{
        occurredAtRaw: string;
        occurredAt: Date;
        receivedAt: Date;
        pin: string;
        workCode: string | null;
        source: string;
        employeeNumber: string | null;
        employeeName: string | null;
      }>(
        `SELECT
           e.occurred_at_raw AS "occurredAtRaw",
           e.occurred_at AS "occurredAt",
           e.received_at AS "receivedAt",
           e.pin,
           e.raw_fields ->> 4 AS "workCode",
           r.classification AS source,
           m.employee_number AS "employeeNumber",
           m.employee_name AS "employeeName"
         FROM attendance_adms_events e
         JOIN attendance_adms_request_journal r ON r.id = e.source_request_id
         LEFT JOIN LATERAL (
           SELECT emp.employee_number, emp.full_name AS employee_name
           FROM attendance_adms_employee_mappings map
           JOIN employees emp ON emp.id = map.employee_id
           WHERE map.device_id = e.device_id
             AND map.pin = e.pin
             AND e.occurred_at >= map.effective_from
             AND (map.effective_to IS NULL OR e.occurred_at < map.effective_to)
           ORDER BY map.effective_from DESC
           LIMIT 1
         ) m ON true
         WHERE e.device_id = $1
           AND ($2::timestamptz IS NULL OR e.occurred_at >= $2)
           AND ($3::timestamptz IS NULL OR e.occurred_at <= $3)
           AND ($4::text IS NULL OR e.pin = $4)
         ORDER BY e.occurred_at, e.id
         LIMIT 50000`,
        [device.id, startAt, endAt, query.data.pin ?? null],
      );
      const header = ["device_serial", "occurred_at_raw", "occurred_at", "received_at", "pin", "work_code", "employee_number", "employee_name", "source"];
      const rows = result.rows.map((row) => [
        device.serialNumber,
        row.occurredAtRaw,
        row.occurredAt.toISOString(),
        row.receivedAt.toISOString(),
        row.pin,
        row.workCode,
        row.employeeNumber,
        row.employeeName,
        row.source,
      ].map(csvCell).join(","));
      const csv = `${header.map(csvCell).join(",")}\n${rows.join("\n")}${rows.length ? "\n" : ""}`;
      reply.header("Cache-Control", "no-store");
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="attendance-${device.serialNumber}.csv"`);
      return reply.send(csv);
    } catch (error) {
      return sendWave3Error(reply, error);
    }
  });

  app.post("/admin/attendance/adms/devices/:deviceId/offline-attlog-imports", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.operate");
    if (!principal) return;
    const params = deviceIdSchema.safeParse(request.params);
    const body = offlineImportSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ code: "INVALID_OFFLINE_ATTLOG_IMPORT", message: "File ATTLOG offline tidak valid." });
    const payload = Buffer.from(body.data.content, "utf8");
    if (payload.byteLength > ADMS_MAX_BODY_BYTES) return reply.status(413).send({ code: "OFFLINE_ATTLOG_IMPORT_TOO_LARGE", message: "File ATTLOG maksimal 512 KiB per import." });
    const payloadHash = bodySha256(payload);
    const receivedAt = new Date();
    const insertedEventIds: string[] = [];
    try {
      const summary = await withTransaction(pool, async (client) => {
        const device = await requireDevice(client, params.data.deviceId);
        if (device.lifecycle !== "active") throw new Wave3Error(409, "ADMS_DEVICE_NOT_ACTIVE", "Import offline hanya untuk mesin lifecycle active.");
        const duplicateFile = await client.query(`SELECT id FROM attendance_adms_offline_imports WHERE device_id = $1 AND source_sha256 = $2`, [device.id, payloadHash]);
        if (duplicateFile.rows[0]) throw new Wave3Error(409, "OFFLINE_ATTLOG_IMPORT_DUPLICATE_FILE", "File identik sudah pernah diimport untuk mesin ini.");

        const parsed = parseAttlogText(body.data.content, device.timezone, receivedAt);
        const requestId = randomUUID();
        await client.query(
          `INSERT INTO attendance_adms_request_journal (
             id, device_id, serial_candidate_hash, method, path, raw_query, content_type,
             source_ip, safe_metadata, body, body_sha256, body_byte_length, body_captured,
             classification, response_status, response_body, received_at
           ) VALUES ($1, $2, NULL, 'OFFLINE', '/admin/offline-attlog-import', '', 'text/plain',
             NULL, $3::jsonb, $4, $5, $6, true, 'offline_attlog_import', 201, NULL, $7)`,
          [requestId, device.id, JSON.stringify({ source: "admin_offline_import", filename: body.data.filename }), payload, payloadHash, payload.byteLength, receivedAt],
        );

        for (const quarantine of parsed.quarantines) {
          await client.query(
            `INSERT INTO attendance_adms_quarantines (id, request_id, device_id, reason, raw_line, details)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
            [randomUUID(), requestId, device.id, `OFFLINE_IMPORT_${quarantine.reason}`, quarantine.rawLine, JSON.stringify(quarantine.details)],
          );
        }

        let duplicateCount = 0;
        for (const event of parsed.events) {
          const eventId = randomUUID();
          const identity = attlogEventIdentity(device.serialNumber, event);
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO attendance_adms_events (
               id, device_id, source_request_id, event_identity_hash, pin,
               occurred_at_raw, occurred_at, raw_line, raw_fields, raw_line_sha256, received_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
             ON CONFLICT (event_identity_hash) DO NOTHING
             RETURNING id`,
            [eventId, device.id, requestId, identity, event.pin, event.occurredAtRaw, event.occurredAt, event.rawLine, JSON.stringify(event.rawFields), event.rawLineSha256, receivedAt],
          );
          if (inserted.rows[0]) {
            insertedEventIds.push(eventId);
          } else {
            duplicateCount += 1;
            await client.query(
              `INSERT INTO attendance_adms_quarantines (id, request_id, device_id, reason, raw_line, details)
               VALUES ($1, $2, $3, 'DUPLICATE_EXACT', $4, $5::jsonb)`,
              [randomUUID(), requestId, device.id, event.rawLine, JSON.stringify({ source: "offline_import", eventIdentityHash: identity })],
            );
          }
        }

        const importId = randomUUID();
        const quarantineCount = parsed.quarantines.length + duplicateCount;
        const result = {
          id: importId,
          parsedEventCount: parsed.events.length,
          insertedEventCount: insertedEventIds.length,
          duplicateEventCount: duplicateCount,
          quarantineCount,
        };
        await client.query(
          `INSERT INTO attendance_adms_offline_imports (
             id, device_id, source_request_id, source_filename, source_sha256,
             parsed_event_count, inserted_event_count, duplicate_event_count, quarantine_count,
             created_by_account_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [importId, device.id, requestId, body.data.filename, payloadHash, parsed.events.length, insertedEventIds.length, duplicateCount, quarantineCount, principal.id],
        );
        await writeAudit(client, { actorAccountId: principal.id, action: "offline_attlog_imported", deviceId: device.id, beforeState: null, afterState: result });
        return result;
      });

      const projection: unknown[] = [];
      if (insertedEventIds.length > 0) {
        const targets = await pool.query<{ employeeId: string; attendanceDate: string }>(
          `SELECT DISTINCT
             m.employee_id AS "employeeId",
             ((e.occurred_at AT TIME ZONE 'Asia/Jakarta')::date)::text AS "attendanceDate"
           FROM attendance_adms_events e
           JOIN attendance_adms_employee_mappings m
             ON m.device_id = e.device_id
            AND m.pin = e.pin
            AND e.occurred_at >= m.effective_from
            AND (m.effective_to IS NULL OR e.occurred_at < m.effective_to)
           WHERE e.id = ANY($1::uuid[])
           ORDER BY "attendanceDate", "employeeId"`,
          [insertedEventIds],
        );
        for (const target of targets.rows) {
          try {
            projection.push(await projectAdmsAttendanceDay(pool, target.employeeId, target.attendanceDate));
          } catch (error) {
            request.log.error({ err: error, employeeId: target.employeeId, attendanceDate: target.attendanceDate }, "offline ATTLOG projection failed");
          }
        }
      }
      reply.header("Cache-Control", "no-store");
      return reply.status(201).send({ item: summary, projection, deviceCommandsRequested: 0 });
    } catch (error) {
      return sendWave3Error(reply, error);
    }
  });

  app.get("/admin/attendance/adms/devices/:deviceId/offline-attlog-imports", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.read");
    if (!principal) return;
    const params = deviceIdSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: "INVALID_ADMS_DEVICE", message: "ID mesin tidak valid." });
    try {
      const device = await requireDevice(pool, params.data.deviceId);
      const result = await pool.query(
        `SELECT
           id, source_filename AS "sourceFilename",
           parsed_event_count AS "parsedEventCount",
           inserted_event_count AS "insertedEventCount",
           duplicate_event_count AS "duplicateEventCount",
           quarantine_count AS "quarantineCount",
           created_at AS "createdAt"
         FROM attendance_adms_offline_imports
         WHERE device_id = $1
         ORDER BY created_at DESC
         LIMIT 50`,
        [device.id],
      );
      reply.header("Cache-Control", "no-store");
      return reply.send({ items: result.rows });
    } catch (error) {
      return sendWave3Error(reply, error);
    }
  });
}
