import type { AdminPermission } from "../../auth/permissions.js";
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../../config/env.js";
import { requirePermissionsFromCookie } from "../../auth/authorization.js";
import { AuthError, AuthService, type AuthPrincipal } from "../../auth/service.js";
import { attlogRangeWireCommand, formatDeviceLocalTimestamp } from "./protocol.js";

const DAY_MS = 86_400_000;
const SECOND_MS = 1_000;
const SINGLE_COMMAND_MAX_MS = 31 * DAY_MS;
const RECOVERY_JOB_MAX_MS = 730 * DAY_MS;

const deviceIdSchema = z.object({ deviceId: z.string().uuid() });
const recoveryJobIdSchema = z.object({ jobId: z.string().uuid() });
const recoveryJobSchema = z.object({
  startAt: z.string().datetime({ offset: true }),
  endAt: z.string().datetime({ offset: true }),
  chunkDays: z.number().int().min(1).max(31).default(31),
});

type RecoveryChunk = {
  sequence: number;
  startAt: Date;
  endAt: Date;
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

function floorToSecond(value: Date) {
  return new Date(Math.floor(value.getTime() / SECOND_MS) * SECOND_MS);
}

export function buildAdmsRecoveryChunks(startAt: Date, endAt: Date, chunkDays: number): RecoveryChunk[] {
  const start = floorToSecond(startAt);
  const end = floorToSecond(endAt);
  const chunkSpanMs = chunkDays * DAY_MS;
  const chunks: RecoveryChunk[] = [];
  let cursor = start;

  while (cursor.getTime() <= end.getTime()) {
    const chunkEndMs = Math.min(end.getTime(), cursor.getTime() + chunkSpanMs - SECOND_MS);
    const chunkEnd = new Date(chunkEndMs);
    chunks.push({ sequence: chunks.length + 1, startAt: cursor, endAt: chunkEnd });
    cursor = new Date(chunkEndMs + SECOND_MS);
  }

  return chunks;
}

async function writeAudit(
  client: PoolClient,
  input: {
    actorAccountId: string;
    action: "transfer_requested" | "command_cancelled";
    deviceId: string;
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

export async function registerAdmsWave1RecoveryRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
) {
  if (!config.AUTH_ENCRYPTION_KEY) {
    throw new Error("AUTH_ENCRYPTION_KEY is required for ADMS recovery routes");
  }
  const auth = new AuthService(
    pool,
    config.AUTH_ENCRYPTION_KEY,
    config.AUTH_SESSION_TTL_HOURS,
    config.NODE_ENV === "production",
  );

  app.get("/admin/attendance/adms/devices/:deviceId/recovery-jobs", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.read");
    if (!principal) return;
    const params = deviceIdSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ code: "INVALID_ADMS_DEVICE", message: "ID mesin tidak valid." });
    }

    const exists = await pool.query<{ id: string }>(
      "SELECT id FROM attendance_adms_devices WHERE id = $1",
      [params.data.deviceId],
    );
    if (!exists.rows[0]) {
      return reply.status(404).send({ code: "ADMS_DEVICE_NOT_FOUND", message: "Mesin tidak ditemukan." });
    }

    const result = await pool.query(
      `SELECT
         j.id,
         j.device_id AS "deviceId",
         j.requested_range_start AS "requestedRangeStart",
         j.requested_range_end AS "requestedRangeEnd",
         j.chunk_days AS "chunkDays",
         j.total_chunks AS "totalChunks",
         j.status,
         j.failure_reason AS "failureReason",
         j.completed_at AS "completedAt",
         j.created_at AS "createdAt",
         j.updated_at AS "updatedAt",
         count(c.id) FILTER (WHERE c.status = 'succeeded')::int AS "succeededChunks",
         count(c.id) FILTER (WHERE c.status = 'failed')::int AS "failedChunks",
         count(c.id) FILTER (WHERE c.status = 'expired')::int AS "expiredChunks",
         count(c.id) FILTER (WHERE c.status = 'cancelled')::int AS "cancelledChunks",
         count(c.id) FILTER (WHERE c.status = 'queued')::int AS "queuedChunks",
         count(c.id) FILTER (WHERE c.status IN ('pending', 'delivered', 'acknowledged'))::int AS "activeChunks",
         min(c.command_number) FILTER (WHERE c.status IN ('pending', 'delivered', 'acknowledged'))::text AS "activeCommandNumber"
       FROM attendance_adms_recovery_jobs j
       LEFT JOIN attendance_adms_commands c ON c.recovery_job_id = j.id
       WHERE j.device_id = $1
       GROUP BY j.id
       ORDER BY j.created_at DESC
       LIMIT 20`,
      [params.data.deviceId],
    );

    reply.header("Cache-Control", "no-store");
    return reply.send({
      execution: "serialized_bounded_attlog",
      maxChunkDays: 31,
      maxRangeDays: 730,
      note: "Setiap job hanya mengorkestrasi DATA QUERY ATTLOG yang sudah diizinkan, satu chunk aktif pada satu waktu. Tidak ada command upload-all baru.",
      items: result.rows,
    });
  });

  app.post("/admin/attendance/adms/devices/:deviceId/transfers/attendance-recovery-job", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.operate");
    if (!principal) return;
    const params = deviceIdSchema.safeParse(request.params);
    const body = recoveryJobSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({
        code: "INVALID_ADMS_RECOVERY_JOB",
        message: "Rentang pemulihan atau ukuran chunk tidak valid.",
      });
    }

    const startAt = floorToSecond(new Date(body.data.startAt));
    const endAt = floorToSecond(new Date(body.data.endAt));
    const durationMs = endAt.getTime() - startAt.getTime();
    if (durationMs < 0) {
      return reply.status(400).send({
        code: "INVALID_ADMS_RECOVERY_RANGE",
        message: "Waktu akhir tidak boleh sebelum waktu awal.",
      });
    }
    if (durationMs <= SINGLE_COMMAND_MAX_MS) {
      return reply.status(400).send({
        code: "ADMS_RECOVERY_JOB_NOT_REQUIRED",
        message: "Rentang sampai 31 hari gunakan pengambilan ulang transaksi biasa.",
      });
    }
    if (durationMs > RECOVERY_JOB_MAX_MS) {
      return reply.status(400).send({
        code: "ADMS_RECOVERY_RANGE_TOO_LARGE",
        message: "Satu job pemulihan periode panjang dibatasi maksimal 730 hari.",
      });
    }

    const chunks = buildAdmsRecoveryChunks(startAt, endAt, body.data.chunkDays);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const deviceResult = await client.query<{ id: string; lifecycle: string; timezone: string }>(
        `SELECT id, lifecycle, timezone
         FROM attendance_adms_devices
         WHERE id = $1
         FOR UPDATE`,
        [params.data.deviceId],
      );
      const device = deviceResult.rows[0];
      if (!device) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ code: "ADMS_DEVICE_NOT_FOUND", message: "Mesin tidak ditemukan." });
      }
      if (device.lifecycle !== "active") {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "ADMS_DEVICE_NOT_ACTIVE",
          message: "Pemulihan transaksi hanya dapat dijalankan untuk mesin aktif.",
        });
      }

      const activeCommand = await client.query<{ id: string }>(
        `SELECT id
         FROM attendance_adms_commands
         WHERE device_id = $1
           AND status IN ('pending', 'delivered', 'acknowledged')
         LIMIT 1
         FOR UPDATE`,
        [device.id],
      );
      if (activeCommand.rows[0]) {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "ADMS_COMMAND_ALREADY_ACTIVE",
          message: "Selesaikan command aktif sebelum memulai pemulihan periode panjang.",
        });
      }

      const existingJob = await client.query<{ id: string }>(
        `SELECT id
         FROM attendance_adms_recovery_jobs
         WHERE device_id = $1 AND status = 'running'
         LIMIT 1
         FOR UPDATE`,
        [device.id],
      );
      if (existingJob.rows[0]) {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "ADMS_RECOVERY_JOB_ALREADY_ACTIVE",
          message: "Masih ada pemulihan periode panjang yang berjalan untuk mesin ini.",
        });
      }

      const jobId = randomUUID();
      await client.query(
        `INSERT INTO attendance_adms_recovery_jobs (
           id, device_id, requested_range_start, requested_range_end,
           chunk_days, total_chunks, status, requested_by_account_id
         ) VALUES ($1, $2, $3, $4, $5, $6, 'running', $7)`,
        [jobId, device.id, startAt, endAt, body.data.chunkDays, chunks.length, principal.id],
      );

      let firstCommandNumber: string | null = null;
      for (const chunk of chunks) {
        const commandId = randomUUID();
        const status = chunk.sequence === 1 ? "pending" : "queued";
        const wireCommand = attlogRangeWireCommand(
          formatDeviceLocalTimestamp(chunk.startAt, device.timezone),
          formatDeviceLocalTimestamp(chunk.endAt, device.timezone),
        );
        const inserted = await client.query<{ commandNumber: string }>(
          `INSERT INTO attendance_adms_commands (
             id, device_id, command_type, wire_command, reason, status,
             requested_by_account_id, requested_range_start, requested_range_end,
             expires_at, recovery_job_id, recovery_sequence
           ) VALUES (
             $1, $2, 'data_query', $3, 'admin_long_range_recovery', $4,
             $5, $6, $7,
             CASE WHEN $4 = 'pending' THEN now() + interval '24 hours' ELSE NULL END,
             $8, $9
           )
           RETURNING command_number::text AS "commandNumber"`,
          [
            commandId,
            device.id,
            wireCommand,
            status,
            principal.id,
            chunk.startAt,
            chunk.endAt,
            jobId,
            chunk.sequence,
          ],
        );
        if (chunk.sequence === 1) firstCommandNumber = inserted.rows[0]?.commandNumber ?? null;

        await client.query(
          `INSERT INTO attendance_adms_command_events (
             id, command_id, event_type, actor_account_id, metadata
           ) VALUES ($1, $2, 'queued', $3, $4::jsonb)`,
          [
            randomUUID(),
            commandId,
            principal.id,
            JSON.stringify({
              reason: "admin_long_range_recovery",
              recoveryJobId: jobId,
              recoverySequence: chunk.sequence,
              totalChunks: chunks.length,
              rangeStart: chunk.startAt.toISOString(),
              rangeEnd: chunk.endAt.toISOString(),
              serialized: true,
            }),
          ],
        );
      }

      const summary = {
        id: jobId,
        deviceId: device.id,
        requestedRangeStart: startAt.toISOString(),
        requestedRangeEnd: endAt.toISOString(),
        chunkDays: body.data.chunkDays,
        totalChunks: chunks.length,
        status: "running",
        firstCommandNumber,
      };
      await writeAudit(client, {
        actorAccountId: principal.id,
        action: "transfer_requested",
        deviceId: device.id,
        beforeState: null,
        afterState: {
          recoveryJobId: jobId,
          requestedRangeStart: startAt.toISOString(),
          requestedRangeEnd: endAt.toISOString(),
          chunkDays: body.data.chunkDays,
          totalChunks: chunks.length,
          protocol: "bounded_attlog_only",
        },
      });

      await client.query("COMMIT");
      reply.header("Cache-Control", "no-store");
      return reply.status(201).send({ item: summary });
    } catch (error) {
      await client.query("ROLLBACK");
      const databaseError = error as Error & { code?: string };
      if (databaseError.code === "23505") {
        return reply.status(409).send({
          code: "ADMS_RECOVERY_JOB_CONFLICT",
          message: "Pemulihan periode panjang atau command lain sudah aktif untuk mesin ini.",
        });
      }
      throw error;
    } finally {
      client.release();
    }
  });

  app.post("/admin/attendance/adms/recovery-jobs/:jobId/cancel", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.operate");
    if (!principal) return;
    const params = recoveryJobIdSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ code: "INVALID_ADMS_RECOVERY_JOB", message: "ID job tidak valid." });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const jobResult = await client.query<{
        id: string;
        deviceId: string;
        status: string;
        totalChunks: number;
      }>(
        `SELECT
           id,
           device_id AS "deviceId",
           status,
           total_chunks AS "totalChunks"
         FROM attendance_adms_recovery_jobs
         WHERE id = $1
         FOR UPDATE`,
        [params.data.jobId],
      );
      const job = jobResult.rows[0];
      if (!job) {
        await client.query("ROLLBACK");
        return reply.status(404).send({
          code: "ADMS_RECOVERY_JOB_NOT_FOUND",
          message: "Job pemulihan tidak ditemukan.",
        });
      }
      if (job.status !== "running") {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "ADMS_RECOVERY_JOB_NOT_CANCELLABLE",
          message: "Job pemulihan ini sudah selesai.",
        });
      }

      const active = await client.query<{ id: string; status: string; commandNumber: string }>(
        `SELECT id, status, command_number::text AS "commandNumber"
         FROM attendance_adms_commands
         WHERE recovery_job_id = $1
           AND status IN ('pending', 'delivered', 'acknowledged')
         ORDER BY recovery_sequence
         LIMIT 1
         FOR UPDATE`,
        [job.id],
      );
      const command = active.rows[0];
      if (command && command.status !== "pending") {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "ADMS_RECOVERY_CHUNK_ALREADY_DELIVERED",
          message: "Chunk aktif sudah dikirim ke mesin dan tidak dapat dibatalkan dengan aman. Tunggu hasil command tersebut.",
        });
      }

      if (command) {
        await client.query(
          `UPDATE attendance_adms_commands
           SET status = 'cancelled', completed_at = now(), updated_at = now()
           WHERE id = $1`,
          [command.id],
        );
        await client.query(
          `INSERT INTO attendance_adms_command_events (
             id, command_id, event_type, actor_account_id, metadata
           ) VALUES ($1, $2, 'cancelled', $3, $4::jsonb)`,
          [
            randomUUID(),
            command.id,
            principal.id,
            JSON.stringify({ reason: "admin_cancel_long_range_recovery", recoveryJobId: job.id }),
          ],
        );
      } else {
        await client.query(
          `UPDATE attendance_adms_recovery_jobs
           SET status = 'cancelled', completed_at = now(), updated_at = now()
           WHERE id = $1`,
          [job.id],
        );
        await client.query(
          `UPDATE attendance_adms_commands
           SET status = 'cancelled', completed_at = COALESCE(completed_at, now()), updated_at = now()
           WHERE recovery_job_id = $1 AND status = 'queued'`,
          [job.id],
        );
      }

      await writeAudit(client, {
        actorAccountId: principal.id,
        action: "command_cancelled",
        deviceId: job.deviceId,
        beforeState: { recoveryJobId: job.id, status: job.status, totalChunks: job.totalChunks },
        afterState: { recoveryJobId: job.id, status: "cancelled" },
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
}
