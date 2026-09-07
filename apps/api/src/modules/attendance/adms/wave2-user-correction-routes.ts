import type { AdminPermission } from "../../auth/permissions.js";
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../../config/env.js";
import { requirePermissionsFromCookie } from "../../auth/authorization.js";
import { AuthError, AuthService, type AuthPrincipal } from "../../auth/service.js";
import { userInfoNameUpdateWireCommand } from "./protocol.js";

const devicePinSchema = z.object({
  deviceId: z.string().uuid(),
  pin: z.string().regex(/^\d{1,128}$/),
});
const deviceIdSchema = z.object({ deviceId: z.string().uuid() });
const correctionIdSchema = z.object({ correctionId: z.string().uuid() });
const correctionPlanSchema = z.object({
  legacyPin: z.string().regex(/^\d{1,128}$/),
  intendedPin: z.string().regex(/^\d{1,128}$/),
}).refine((value) => value.legacyPin !== value.intendedPin, {
  message: "Legacy PIN dan intended PIN harus berbeda.",
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

export async function registerAdmsWave2UserCorrectionRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
) {
  if (!config.AUTH_ENCRYPTION_KEY) {
    throw new Error("AUTH_ENCRYPTION_KEY is required for ADMS Wave 2 user correction routes");
  }
  const auth = new AuthService(
    pool,
    config.AUTH_ENCRYPTION_KEY,
    config.AUTH_SESSION_TTL_HOURS,
    config.NODE_ENV === "production",
  );

  app.post("/admin/attendance/adms/devices/:deviceId/users/:pin/commands/sync-name", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.operate");
    if (!principal) return;
    const params = devicePinSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ code: "INVALID_ADMS_USER", message: "Mesin atau PIN tidak valid." });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const device = await client.query<{ id: string; lifecycle: string }>(
        `SELECT id, lifecycle FROM attendance_adms_devices WHERE id = $1 FOR UPDATE`,
        [params.data.deviceId],
      );
      const targetDevice = device.rows[0];
      if (!targetDevice) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ code: "ADMS_DEVICE_NOT_FOUND", message: "Mesin tidak ditemukan." });
      }
      if (targetDevice.lifecycle !== "active") {
        await client.query("ROLLBACK");
        return reply.status(409).send({ code: "ADMS_DEVICE_NOT_ACTIVE", message: "Sync nama hanya untuk mesin lifecycle active." });
      }

      const mapping = await client.query<{
        mappingId: string;
        employeeId: string;
        employeeName: string;
        employeeStatus: string;
      }>(
        `SELECT
           m.id AS "mappingId",
           m.employee_id AS "employeeId",
           e.full_name AS "employeeName",
           e.status AS "employeeStatus"
         FROM attendance_adms_employee_mappings m
         JOIN employees e ON e.id = m.employee_id
         WHERE m.device_id = $1
           AND m.pin = $2
           AND m.effective_from <= now()
           AND (m.effective_to IS NULL OR m.effective_to > now())
         ORDER BY m.effective_from DESC
         LIMIT 1`,
        [targetDevice.id, params.data.pin],
      );
      const targetMapping = mapping.rows[0];
      if (!targetMapping) {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "ADMS_PIN_NOT_MAPPED",
          message: "Sync nama hanya boleh dilakukan setelah PIN dimapping eksplisit ke pegawai HCIS.",
        });
      }
      if (targetMapping.employeeStatus !== "active") {
        await client.query("ROLLBACK");
        return reply.status(409).send({ code: "EMPLOYEE_NOT_ACTIVE", message: "Pegawai mapping sudah tidak aktif." });
      }

      const roster = await client.query<{ displayName: string | null; lastSeenAt: Date }>(
        `SELECT display_name AS "displayName", last_seen_at AS "lastSeenAt"
         FROM attendance_adms_device_roster_entries
         WHERE device_id = $1 AND pin = $2`,
        [targetDevice.id, params.data.pin],
      );
      const observed = roster.rows[0];
      if (!observed) {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "ADMS_USERINFO_NOT_OBSERVED",
          message: "Sinkronisasi nama membutuhkan observasi USERINFO aman yang sudah tersedia. Active USERINFO readback telah dipensiunkan.",
        });
      }

      const active = await client.query<{ id: string; commandNumber: string; status: string }>(
        `SELECT id, command_number::text AS "commandNumber", status
         FROM attendance_adms_commands
         WHERE device_id = $1 AND status IN ('pending', 'delivered', 'acknowledged')
         ORDER BY created_at, command_number
         LIMIT 1`,
        [targetDevice.id],
      );
      if (active.rows[0]) {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "ADMS_COMMAND_ACTIVE",
          message: "Masih ada command aktif untuk mesin ini.",
          command: active.rows[0],
        });
      }

      const wireCommand = userInfoNameUpdateWireCommand(params.data.pin, targetMapping.employeeName);
      const commandId = randomUUID();
      const inserted = await client.query<{
        id: string;
        commandNumber: string;
        status: string;
        createdAt: Date;
        expiresAt: Date;
      }>(
        `INSERT INTO attendance_adms_commands (
           id, device_id, command_type, wire_command, reason, status,
           requested_by_account_id, requested_range_start, requested_range_end, expires_at
         ) VALUES (
           $1, $2, 'update_user_info', $3, 'admin_update_user_info', 'pending',
           $4, NULL, NULL, now() + interval '15 minutes'
         )
         RETURNING
           id,
           command_number::text AS "commandNumber",
           status,
           created_at AS "createdAt",
           expires_at AS "expiresAt"`,
        [commandId, targetDevice.id, wireCommand, principal.id],
      );
      const command = inserted.rows[0]!;
      const sameValue = observed.displayName === targetMapping.employeeName;
      const metadata = {
        reason: "admin_update_user_info",
        capability: "name_only_userinfo_update",
        pin: params.data.pin,
        mappingId: targetMapping.mappingId,
        employeeId: targetMapping.employeeId,
        currentName: observed.displayName,
        targetName: targetMapping.employeeName,
        sameValue,
        fields: ["Name"],
        pinMutation: false,
        biometricMutation: false,
      };

      await client.query(
        `INSERT INTO attendance_adms_command_events (
           id, command_id, event_type, actor_account_id, metadata
         ) VALUES ($1, $2, 'queued', $3, $4::jsonb)`,
        [randomUUID(), commandId, principal.id, JSON.stringify(metadata)],
      );
      await client.query(
        `INSERT INTO attendance_adms_admin_audit_events (
           id, actor_account_id, action, device_id, mapping_id, before_state, after_state
         ) VALUES ($1, $2, 'command_requested', $3, $4, $5::jsonb, $6::jsonb)`,
        [
          randomUUID(),
          principal.id,
          targetDevice.id,
          targetMapping.mappingId,
          JSON.stringify({ pin: params.data.pin, displayName: observed.displayName }),
          JSON.stringify(metadata),
        ],
      );

      await client.query("COMMIT");
      reply.header("Cache-Control", "no-store");
      return reply.status(202).send({
        item: {
          ...command,
          commandType: "update_user_info",
          reason: "admin_update_user_info",
          pin: params.data.pin,
          currentName: observed.displayName,
          targetName: targetMapping.employeeName,
          sameValue,
          fields: ["Name"],
          expectedResultCommand: "DATA",
          verificationRequired: "active_userinfo_readback_retired_passive_or_separately_approved_evidence_required",
        },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      const databaseError = error as Error & { code?: string };
      if (databaseError.code === "23505") {
        return reply.status(409).send({ code: "ADMS_COMMAND_ACTIVE", message: "Command lain menjadi aktif. Muat ulang lalu coba lagi." });
      }
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/admin/attendance/adms/devices/:deviceId/user-corrections", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.read");
    if (!principal) return;
    const params = deviceIdSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ code: "INVALID_ADMS_DEVICE", message: "ID mesin tidak valid." });
    }
    const result = await pool.query(
      `SELECT
         c.id,
         c.device_id AS "deviceId",
         c.employee_id AS "employeeId",
         e.employee_number AS "employeeNumber",
         e.full_name AS "employeeName",
         c.legacy_pin AS "legacyPin",
         c.intended_pin AS "intendedPin",
         c.reason,
         c.status,
         c.safe_metadata AS "safeMetadata",
         c.created_at AS "createdAt",
         c.cancelled_at AS "cancelledAt",
         c.resolved_at AS "resolvedAt"
       FROM attendance_adms_device_user_corrections c
       JOIN employees e ON e.id = c.employee_id
       WHERE c.device_id = $1
       ORDER BY (c.status = 'planned') DESC, c.created_at DESC`,
      [params.data.deviceId],
    );
    reply.header("Cache-Control", "no-store");
    return reply.send({
      executionPolicy: "planning_only",
      destructivePinMutationEnabled: false,
      biometricTransferValidated: false,
      items: result.rows,
    });
  });

  app.post("/admin/attendance/adms/devices/:deviceId/user-corrections", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.operate");
    if (!principal) return;
    const params = deviceIdSchema.safeParse(request.params);
    const body = correctionPlanSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ code: "INVALID_ADMS_USER_CORRECTION", message: "Rencana koreksi PIN tidak valid." });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const device = await client.query<{ id: string; lifecycle: string }>(
        `SELECT id, lifecycle FROM attendance_adms_devices WHERE id = $1 FOR UPDATE`,
        [params.data.deviceId],
      );
      const targetDevice = device.rows[0];
      if (!targetDevice) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ code: "ADMS_DEVICE_NOT_FOUND", message: "Mesin tidak ditemukan." });
      }

      const mapping = await client.query<{
        mappingId: string;
        employeeId: string;
        employeeName: string;
        employeeNumber: string;
        employeeStatus: string;
      }>(
        `SELECT
           m.id AS "mappingId",
           m.employee_id AS "employeeId",
           e.full_name AS "employeeName",
           e.employee_number AS "employeeNumber",
           e.status AS "employeeStatus"
         FROM attendance_adms_employee_mappings m
         JOIN employees e ON e.id = m.employee_id
         WHERE m.device_id = $1
           AND m.pin = $2
           AND m.effective_from <= now()
           AND (m.effective_to IS NULL OR m.effective_to > now())
         ORDER BY m.effective_from DESC
         LIMIT 1`,
        [targetDevice.id, body.data.legacyPin],
      );
      const targetMapping = mapping.rows[0];
      if (!targetMapping) {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "ADMS_LEGACY_PIN_NOT_MAPPED",
          message: "Legacy PIN harus dimapping eksplisit ke pegawai sebelum rencana koreksi dibuat.",
        });
      }
      if (targetMapping.employeeStatus !== "active") {
        await client.query("ROLLBACK");
        return reply.status(409).send({ code: "EMPLOYEE_NOT_ACTIVE", message: "Pegawai mapping sudah tidak aktif." });
      }

      const legacyRoster = await client.query<{ displayName: string | null; cardNumber: string | null }>(
        `SELECT display_name AS "displayName", card_number AS "cardNumber"
         FROM attendance_adms_device_roster_entries
         WHERE device_id = $1 AND pin = $2`,
        [targetDevice.id, body.data.legacyPin],
      );
      if (!legacyRoster.rows[0]) {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "ADMS_LEGACY_USERINFO_NOT_OBSERVED",
          message: "Legacy PIN harus memiliki USERINFO observation sebelum koreksi direncanakan.",
        });
      }

      const intendedConflict = await client.query<{ conflict: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM attendance_adms_employee_mappings m
           WHERE m.device_id = $1 AND m.pin = $2
             AND m.effective_from <= now()
             AND (m.effective_to IS NULL OR m.effective_to > now())
           UNION ALL
           SELECT 1 FROM attendance_adms_device_roster_entries r
           WHERE r.device_id = $1 AND r.pin = $2
           UNION ALL
           SELECT 1 FROM attendance_adms_events ev
           WHERE ev.device_id = $1 AND ev.pin = $2
         ) AS conflict`,
        [targetDevice.id, body.data.intendedPin],
      );
      if (intendedConflict.rows[0]?.conflict) {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "ADMS_INTENDED_PIN_ALREADY_OBSERVED",
          message: "Intended PIN sudah memiliki fakta/mapping pada mesin ini. Koreksi otomatis diblokir.",
        });
      }

      const id = randomUUID();
      const safeMetadata = {
        mappingId: targetMapping.mappingId,
        legacyDisplayName: legacyRoster.rows[0].displayName,
        legacyCardNumber: legacyRoster.rows[0].cardNumber,
        employeeName: targetMapping.employeeName,
        employeeNumber: targetMapping.employeeNumber,
        executionAllowed: false,
        blockers: ["biometric_transfer_unverified", "destructive_user_delete_blocked"],
      };
      const inserted = await client.query(
        `INSERT INTO attendance_adms_device_user_corrections (
           id, device_id, employee_id, legacy_pin, intended_pin, reason, status,
           created_by_account_id, safe_metadata
         ) VALUES ($1, $2, $3, $4, $5, 'pin_typo', 'planned', $6, $7::jsonb)
         RETURNING
           id,
           device_id AS "deviceId",
           employee_id AS "employeeId",
           legacy_pin AS "legacyPin",
           intended_pin AS "intendedPin",
           reason,
           status,
           safe_metadata AS "safeMetadata",
           created_at AS "createdAt"`,
        [
          id,
          targetDevice.id,
          targetMapping.employeeId,
          body.data.legacyPin,
          body.data.intendedPin,
          principal.id,
          JSON.stringify(safeMetadata),
        ],
      );
      const item = inserted.rows[0]!;

      await client.query(
        `INSERT INTO attendance_adms_admin_audit_events (
           id, actor_account_id, action, device_id, mapping_id, before_state, after_state
         ) VALUES ($1, $2, 'device_user_correction_planned', $3, $4, NULL, $5::jsonb)`,
        [randomUUID(), principal.id, targetDevice.id, targetMapping.mappingId, JSON.stringify(item)],
      );
      await client.query("COMMIT");
      reply.header("Cache-Control", "no-store");
      return reply.status(201).send({
        item: {
          ...item,
          employeeName: targetMapping.employeeName,
          employeeNumber: targetMapping.employeeNumber,
        },
        executionPolicy: "planning_only",
        destructivePinMutationEnabled: false,
        biometricTransferValidated: false,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      const databaseError = error as Error & { code?: string };
      if (databaseError.code === "23505") {
        return reply.status(409).send({
          code: "ADMS_USER_CORRECTION_ALREADY_PLANNED",
          message: "Legacy atau intended PIN sudah memiliki rencana koreksi aktif.",
        });
      }
      throw error;
    } finally {
      client.release();
    }
  });

  app.delete("/admin/attendance/adms/user-corrections/:correctionId", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.operate");
    if (!principal) return;
    const params = correctionIdSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ code: "INVALID_ADMS_USER_CORRECTION", message: "ID koreksi tidak valid." });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query<{
        id: string;
        deviceId: string;
        status: string;
        legacyPin: string;
        intendedPin: string;
      }>(
        `SELECT
           id,
           device_id AS "deviceId",
           status,
           legacy_pin AS "legacyPin",
           intended_pin AS "intendedPin"
         FROM attendance_adms_device_user_corrections
         WHERE id = $1
         FOR UPDATE`,
        [params.data.correctionId],
      );
      const current = found.rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ code: "ADMS_USER_CORRECTION_NOT_FOUND", message: "Rencana koreksi tidak ditemukan." });
      }
      if (current.status !== "planned") {
        await client.query("ROLLBACK");
        return reply.status(409).send({ code: "ADMS_USER_CORRECTION_NOT_PLANNED", message: "Rencana koreksi sudah terminal." });
      }

      await client.query(
        `UPDATE attendance_adms_device_user_corrections
         SET status = 'cancelled',
             cancelled_at = now(),
             cancelled_by_account_id = $2,
             updated_at = now()
         WHERE id = $1`,
        [current.id, principal.id],
      );
      await client.query(
        `INSERT INTO attendance_adms_admin_audit_events (
           id, actor_account_id, action, device_id, mapping_id, before_state, after_state
         ) VALUES ($1, $2, 'device_user_correction_cancelled', $3, NULL, $4::jsonb, $5::jsonb)`,
        [
          randomUUID(),
          principal.id,
          current.deviceId,
          JSON.stringify(current),
          JSON.stringify({ ...current, status: "cancelled" }),
        ],
      );
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
