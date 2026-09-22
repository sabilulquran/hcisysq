import type { AdminPermission } from "../../auth/permissions.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { ApiConfig } from "../../../config/env.js";
import { requirePermissionsFromCookie } from "../../auth/authorization.js";
import { AuthError, AuthService, type AuthPrincipal } from "../../auth/service.js";

const deviceIdSchema = z.object({ deviceId: z.string().uuid() });
const retireDeviceSchema = z.object({
  note: z.string().trim().min(5).max(500),
  replacementDeviceId: z.string().uuid().nullable().optional(),
});
const syncQuerySchema = z.object({
  deviceId: z.string().uuid().optional(),
  state: z.enum(["synced", "unmapped", "missing_on_device", "name_drift", "review_required"]).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(250).default(100),
});
const jobQuerySchema = z.object({
  status: z.enum(["pending", "delivered", "acknowledged", "succeeded", "failed", "expired", "cancelled"]).optional(),
  deviceId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(250).default(100),
});
const limitQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(250).default(100),
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

async function writeRetirementAudit(
  client: PoolClient,
  input: {
    actorAccountId: string;
    deviceId: string;
    beforeState: unknown;
    afterState: unknown;
  },
) {
  await client.query(
    `INSERT INTO attendance_adms_admin_audit_events (
       id, actor_account_id, action, device_id, mapping_id, before_state, after_state
     ) VALUES ($1, $2, 'device_retired', $3, NULL, $4::jsonb, $5::jsonb)`,
    [
      randomUUID(),
      input.actorAccountId,
      input.deviceId,
      JSON.stringify(input.beforeState),
      JSON.stringify(input.afterState),
    ],
  );
}

function humanAction(commandType: string, reason: string) {
  if (reason === "scheduled_reconciliation") return "Rekonsiliasi terjadwal";
  if (reason === "admin_range_recovery" || reason === "admin_long_range_recovery") return "Ambil ulang transaksi";
  if (reason === "registration_recovery" || reason === "admin_sync_new") return "Sinkronkan data baru";
  if (reason === "admin_read_information") return "Perbarui informasi mesin";
  if (reason === "admin_update_user_info") return "Sinkronkan nama pengguna";
  if (reason === "admin_physical_operation") return "Operasi perangkat";
  if (commandType === "query_user_info") return "Baca data pengguna";
  return "Perintah perangkat";
}

export async function registerAdmsManagementRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
) {
  if (!config.AUTH_ENCRYPTION_KEY) {
    throw new Error("AUTH_ENCRYPTION_KEY is required for ADMS management routes");
  }
  const auth = new AuthService(
    pool,
    config.AUTH_ENCRYPTION_KEY,
    config.AUTH_SESSION_TTL_HOURS,
    config.NODE_ENV === "production",
  );

  app.get("/admin/attendance/adms/management/summary", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.read");
    if (!principal) return;

    const [fleet, detected, mapping, commands] = await Promise.all([
      pool.query<{
        total: number; active: number; disabled: number; quarantined: number; retired: number;
      }>(
        `SELECT
           count(*)::int AS total,
           count(*) FILTER (WHERE lifecycle = 'active')::int AS active,
           count(*) FILTER (WHERE lifecycle = 'disabled')::int AS disabled,
           count(*) FILTER (WHERE lifecycle = 'quarantined')::int AS quarantined,
           count(*) FILTER (WHERE lifecycle = 'retired')::int AS retired
         FROM attendance_adms_devices`,
      ),
      pool.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM attendance_adms_detected_devices
         WHERE status = 'detected'`,
      ),
      pool.query<{ unmapped: number; reviewRequired: number }>(
        `WITH event_pins AS (
           SELECT DISTINCT device_id, pin FROM attendance_adms_events
         )
         SELECT
           count(*) FILTER (
             WHERE m.id IS NULL
           )::int AS unmapped,
           count(*) FILTER (
             WHERE m.id IS NOT NULL AND e.status <> 'active'
           )::int AS "reviewRequired"
         FROM event_pins p
         LEFT JOIN attendance_adms_employee_mappings m
           ON m.device_id = p.device_id AND m.pin = p.pin AND m.effective_to IS NULL
         LEFT JOIN employees e ON e.id = m.employee_id`,
      ),
      pool.query<{ pending: number; failed: number }>(
        `SELECT
           count(*) FILTER (WHERE status IN ('pending', 'delivered', 'acknowledged'))::int AS pending,
           count(*) FILTER (WHERE status = 'failed' AND updated_at >= now() - interval '24 hours')::int AS failed
         FROM attendance_adms_commands`,
      ),
    ]);

    const fleetRow = fleet.rows[0] ?? { total: 0, active: 0, disabled: 0, quarantined: 0, retired: 0 };
    reply.header("Cache-Control", "no-store");
    return reply.send({
      fleet: fleetRow,
      detectedCount: detected.rows[0]?.count ?? 0,
      unmappedPinCount: mapping.rows[0]?.unmapped ?? 0,
      reviewRequiredCount: mapping.rows[0]?.reviewRequired ?? 0,
      pendingJobCount: commands.rows[0]?.pending ?? 0,
      failedJob24hCount: commands.rows[0]?.failed ?? 0,
    });
  });

  app.get("/admin/attendance/adms/management/user-sync", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.read");
    if (!principal) return;
    const parsed = syncQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ code: "INVALID_ADMS_SYNC_QUERY", message: "Filter sinkronisasi pengguna tidak valid." });
    }
    const q = parsed.data.q?.trim() || null;
    const result = await pool.query(
      `WITH event_pins AS (
         SELECT device_id, pin, max(occurred_at) AS last_event_at
         FROM attendance_adms_events
         GROUP BY device_id, pin
       ), candidates AS (
         SELECT device_id, pin FROM event_pins
         UNION
         SELECT device_id, pin FROM attendance_adms_device_roster_entries
         UNION
         SELECT device_id, pin FROM attendance_adms_employee_mappings WHERE effective_to IS NULL
       ), base AS (
         SELECT
           d.id AS "deviceId",
           d.serial_number AS "serialNumber",
           d.display_name AS "deviceName",
           d.lifecycle AS "deviceLifecycle",
           c.pin,
           m.id AS "mappingId",
           m.employee_id AS "employeeId",
           e.employee_number AS "employeeNumber",
           e.full_name AS "employeeName",
           e.status AS "employeeStatus",
           r.display_name AS "observedName",
           r.card_number AS "observedCardNumber",
           r.last_seen_at AS "rosterObservedAt",
           ep.last_event_at AS "lastEventAt",
           CASE
             WHEN m.id IS NULL THEN 'unmapped'
             WHEN e.status <> 'active' THEN 'review_required'
             WHEN r.pin IS NULL THEN 'missing_on_device'
             WHEN lower(trim(coalesce(r.display_name, ''))) <> lower(trim(e.full_name)) THEN 'name_drift'
             ELSE 'synced'
           END AS state
         FROM candidates c
         JOIN attendance_adms_devices d ON d.id = c.device_id
         LEFT JOIN attendance_adms_employee_mappings m
           ON m.device_id = c.device_id AND m.pin = c.pin AND m.effective_to IS NULL
         LEFT JOIN employees e ON e.id = m.employee_id
         LEFT JOIN attendance_adms_device_roster_entries r
           ON r.device_id = c.device_id AND r.pin = c.pin
         LEFT JOIN event_pins ep ON ep.device_id = c.device_id AND ep.pin = c.pin
       )
       SELECT *
       FROM base
       WHERE ($1::uuid IS NULL OR "deviceId" = $1)
         AND ($2::text IS NULL OR state = $2)
         AND (
           $3::text IS NULL
           OR pin ILIKE '%' || $3 || '%'
           OR coalesce("observedName", '') ILIKE '%' || $3 || '%'
           OR coalesce("employeeName", '') ILIKE '%' || $3 || '%'
           OR coalesce("employeeNumber", '') ILIKE '%' || $3 || '%'
           OR coalesce("deviceName", '') ILIKE '%' || $3 || '%'
           OR "serialNumber" ILIKE '%' || $3 || '%'
         )
       ORDER BY
         CASE state
           WHEN 'unmapped' THEN 1
           WHEN 'review_required' THEN 2
           WHEN 'name_drift' THEN 3
           WHEN 'missing_on_device' THEN 4
           ELSE 5
         END,
         "deviceName" NULLS LAST, "serialNumber", pin
       LIMIT $4`,
      [parsed.data.deviceId ?? null, parsed.data.state ?? null, q, parsed.data.limit],
    );
    reply.header("Cache-Control", "no-store");
    return reply.send({ items: result.rows });
  });

  app.get("/admin/attendance/adms/management/jobs", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.read");
    if (!principal) return;
    const parsed = jobQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ code: "INVALID_ADMS_JOB_QUERY", message: "Filter perintah tidak valid." });
    }
    const result = await pool.query<{
      id: string;
      deviceId: string;
      serialNumber: string;
      deviceName: string | null;
      commandNumber: string;
      commandType: string;
      reason: string;
      status: string;
      attemptCount: number;
      requestedRangeStart: Date | null;
      requestedRangeEnd: Date | null;
      deliveredAt: Date | null;
      acknowledgedAt: Date | null;
      completedAt: Date | null;
      returnCode: string | null;
      createdAt: Date;
      updatedAt: Date;
    }>(
      `SELECT
         c.id,
         c.device_id AS "deviceId",
         d.serial_number AS "serialNumber",
         d.display_name AS "deviceName",
         c.command_number::text AS "commandNumber",
         c.command_type AS "commandType",
         c.reason,
         c.status,
         c.attempt_count AS "attemptCount",
         c.requested_range_start AS "requestedRangeStart",
         c.requested_range_end AS "requestedRangeEnd",
         c.delivered_at AS "deliveredAt",
         c.acknowledged_at AS "acknowledgedAt",
         c.completed_at AS "completedAt",
         c.return_code::text AS "returnCode",
         c.created_at AS "createdAt",
         c.updated_at AS "updatedAt"
       FROM attendance_adms_commands c
       JOIN attendance_adms_devices d ON d.id = c.device_id
       WHERE ($1::text IS NULL OR c.status = $1)
         AND ($2::uuid IS NULL OR c.device_id = $2)
       ORDER BY c.created_at DESC, c.command_number DESC
       LIMIT $3`,
      [parsed.data.status ?? null, parsed.data.deviceId ?? null, parsed.data.limit],
    );
    reply.header("Cache-Control", "no-store");
    return reply.send({
      items: result.rows.map((row) => ({
        ...row,
        action: humanAction(row.commandType, row.reason),
        requestedRangeStart: row.requestedRangeStart?.toISOString() ?? null,
        requestedRangeEnd: row.requestedRangeEnd?.toISOString() ?? null,
        deliveredAt: row.deliveredAt?.toISOString() ?? null,
        acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
        completedAt: row.completedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    });
  });

  app.get("/admin/attendance/adms/management/health", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.read");
    if (!principal) return;

    const result = await pool.query<{
      deviceId: string;
      serialNumber: string;
      deviceName: string | null;
      lifecycle: string;
      lastSeenAt: Date | null;
      lastSuccessfulRequestAt: Date | null;
      lastIp: string | null;
      effectiveTimeoutSeconds: number;
      reconciliationEnabled: boolean;
      reconciliationIntervalMinutes: number;
      reconciliationLastRequestedAt: Date | null;
      failedJob24hCount: number;
      unmappedPinCount: number;
      sourceIp24hCount: number;
    }>(
      `SELECT
         d.id AS "deviceId",
         d.serial_number AS "serialNumber",
         d.display_name AS "deviceName",
         d.lifecycle,
         d.last_seen_at AS "lastSeenAt",
         d.last_successful_request_at AS "lastSuccessfulRequestAt",
         d.last_ip AS "lastIp",
         coalesce(
           d.connectivity_timeout_seconds,
           greatest(60, least(900, d.heartbeat_interval_seconds * 3))
         )::int AS "effectiveTimeoutSeconds",
         d.reconciliation_enabled AS "reconciliationEnabled",
         d.reconciliation_interval_minutes AS "reconciliationIntervalMinutes",
         d.reconciliation_last_requested_at AS "reconciliationLastRequestedAt",
         (SELECT count(*)::int
          FROM attendance_adms_commands c
          WHERE c.device_id = d.id
            AND c.status = 'failed'
            AND c.updated_at >= now() - interval '24 hours') AS "failedJob24hCount",
         (SELECT count(*)::int
          FROM (
            SELECT DISTINCT e.pin
            FROM attendance_adms_events e
            WHERE e.device_id = d.id
              AND NOT EXISTS (
                SELECT 1
                FROM attendance_adms_employee_mappings m
                WHERE m.device_id = d.id
                  AND m.pin = e.pin
                  AND m.effective_to IS NULL
              )
          ) unresolved) AS "unmappedPinCount",
         (SELECT count(DISTINCT j.source_ip)::int
          FROM attendance_adms_request_journal j
          WHERE j.device_id = d.id
            AND j.received_at >= now() - interval '24 hours'
            AND j.source_ip IS NOT NULL) AS "sourceIp24hCount"
       FROM attendance_adms_devices d
       ORDER BY d.display_name NULLS LAST, d.serial_number`,
    );

    const now = Date.now();
    const items = result.rows.map((row) => {
      const offline = row.lastSeenAt
        ? now - row.lastSeenAt.getTime() > row.effectiveTimeoutSeconds * 1000
        : false;
      const connectivityStatus = !row.lastSeenAt ? "unknown" : offline ? "offline" : "online";
      const reconciliationStale = row.reconciliationEnabled && (
        !row.reconciliationLastRequestedAt
        || now - row.reconciliationLastRequestedAt.getTime()
          > row.reconciliationIntervalMinutes * 2 * 60_000
      );
      const alertCodes: string[] = [];
      if (row.lifecycle === "active" && connectivityStatus === "offline") alertCodes.push("device_offline");
      if (row.lifecycle === "active" && connectivityStatus === "unknown") alertCodes.push("connectivity_unknown");
      if (row.unmappedPinCount > 0) alertCodes.push("unmapped_pin");
      if (row.failedJob24hCount > 0) alertCodes.push("failed_job");
      if (reconciliationStale) alertCodes.push("reconciliation_stale");
      if (row.sourceIp24hCount > 3) alertCodes.push("source_ip_anomaly");
      return {
        ...row,
        connectivityStatus,
        reconciliationStale,
        alertCodes,
        lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
        lastSuccessfulRequestAt: row.lastSuccessfulRequestAt?.toISOString() ?? null,
        reconciliationLastRequestedAt: row.reconciliationLastRequestedAt?.toISOString() ?? null,
      };
    });
    reply.header("Cache-Control", "no-store");
    return reply.send({ items });
  });

  app.get("/admin/attendance/adms/management/audit", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.read");
    if (!principal) return;
    const parsed = limitQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ code: "INVALID_ADMS_AUDIT_QUERY", message: "Filter audit tidak valid." });
    }
    const result = await pool.query<{
      id: string; action: string; deviceId: string | null; serialNumber: string | null;
      deviceName: string | null; actorEmail: string | null; createdAt: Date;
    }>(
      `SELECT
         a.id,
         a.action,
         a.device_id AS "deviceId",
         d.serial_number AS "serialNumber",
         d.display_name AS "deviceName",
         actor.email AS "actorEmail",
         a.created_at AS "createdAt"
       FROM attendance_adms_admin_audit_events a
       LEFT JOIN attendance_adms_devices d ON d.id = a.device_id
       LEFT JOIN accounts actor ON actor.id = a.actor_account_id
       ORDER BY a.created_at DESC
       LIMIT $1`,
      [parsed.data.limit],
    );
    reply.header("Cache-Control", "no-store");
    return reply.send({
      items: result.rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
    });
  });

  app.post("/admin/attendance/adms/devices/:deviceId/retire", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.configure");
    if (!principal) return;
    const params = deviceIdSchema.safeParse(request.params);
    const body = retireDeviceSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ code: "INVALID_ADMS_RETIREMENT", message: "Data retirement mesin tidak valid." });
    }
    const replacementDeviceId = body.data.replacementDeviceId ?? null;
    if (replacementDeviceId === params.data.deviceId) {
      return reply.status(400).send({ code: "ADMS_REPLACEMENT_SELF_REFERENCE", message: "Mesin pengganti harus berbeda dari mesin yang dipensiunkan." });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query(
        `SELECT id, serial_number AS "serialNumber", display_name AS "displayName",
                lifecycle, retired_at AS "retiredAt", replaced_by_device_id AS "replacedByDeviceId"
         FROM attendance_adms_devices
         WHERE id = $1
         FOR UPDATE`,
        [params.data.deviceId],
      );
      const before = current.rows[0];
      if (!before) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ code: "ADMS_DEVICE_NOT_FOUND", message: "Mesin tidak ditemukan." });
      }
      if (before.lifecycle === "retired") {
        await client.query("ROLLBACK");
        return reply.status(409).send({ code: "ADMS_DEVICE_ALREADY_RETIRED", message: "Mesin sudah dipensiunkan." });
      }
      if (replacementDeviceId) {
        const replacement = await client.query<{ id: string; lifecycle: string }>(
          "SELECT id, lifecycle FROM attendance_adms_devices WHERE id = $1",
          [replacementDeviceId],
        );
        if (!replacement.rows[0]) {
          await client.query("ROLLBACK");
          return reply.status(404).send({ code: "ADMS_REPLACEMENT_NOT_FOUND", message: "Mesin pengganti tidak ditemukan." });
        }
        if (replacement.rows[0].lifecycle === "retired") {
          await client.query("ROLLBACK");
          return reply.status(409).send({ code: "ADMS_REPLACEMENT_RETIRED", message: "Mesin pengganti tidak boleh berstatus retired." });
        }
      }

      const updated = await client.query(
        `UPDATE attendance_adms_devices
         SET lifecycle = 'retired',
             retired_at = now(),
             retired_by_account_id = $2,
             retirement_note = $3,
             replaced_by_device_id = $4,
             updated_at = now()
         WHERE id = $1
         RETURNING
           id, serial_number AS "serialNumber", display_name AS "displayName", lifecycle,
           retired_at AS "retiredAt", retirement_note AS "retirementNote",
           replaced_by_device_id AS "replacedByDeviceId", updated_at AS "updatedAt"`,
        [params.data.deviceId, principal.id, body.data.note, replacementDeviceId],
      );
      const after = updated.rows[0];
      await writeRetirementAudit(client, {
        actorAccountId: principal.id,
        deviceId: params.data.deviceId,
        beforeState: before,
        afterState: after,
      });
      await client.query("COMMIT");
      reply.header("Cache-Control", "no-store");
      return reply.send({
        item: {
          ...after,
          retiredAt: after.retiredAt?.toISOString?.() ?? after.retiredAt,
          updatedAt: after.updatedAt?.toISOString?.() ?? after.updatedAt,
        },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}
