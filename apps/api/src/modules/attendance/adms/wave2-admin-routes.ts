import type { AdminPermission } from "../../auth/permissions.js";
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../../config/env.js";
import { requirePermissionsFromCookie } from "../../auth/authorization.js";
import { AuthError, AuthService, type AuthPrincipal } from "../../auth/service.js";
import { biometricCollectionEnabled, type BiometricModality } from "./biometric-crypto.js";

const deviceIdSchema = z.object({ deviceId: z.string().uuid() });
const biometricQuerySchema = z.object({
  employeeId: z.string().uuid().optional(),
  originDeviceId: z.string().uuid().optional(),
  modality: z.enum(["fingerprint", "face", "palm", "bio_photo"]).optional(),
});
const biometricCollectionPolicySchema = z.object({ enabled: z.boolean() });

type BiometricCollectionPolicyRow = {
  deviceId: string;
  lifecycle: "active" | "disabled" | "quarantined";
  deviceCollectionEnabled: boolean;
  enabledAt: Date | null;
  enabledByAccountId: string | null;
};

type MappingLifecycleRow = {
  mappingId: string;
  pin: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  employeeStatus: "active" | "inactive" | "resigned";
};

type MappingLifecycleSummaryRow = {
  deviceId: string;
  activeMappingCount: number;
  reviewRequiredCount: number;
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

async function writeDeviceAudit(
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
     ) VALUES ($1, $2, 'device_updated', $3, NULL, $4::jsonb, $5::jsonb)`,
    [
      randomUUID(),
      input.actorAccountId,
      input.deviceId,
      JSON.stringify(input.beforeState),
      JSON.stringify(input.afterState),
    ],
  );
}

function policyResponse(config: ApiConfig, item: BiometricCollectionPolicyRow) {
  const globalCollectionEnabled = biometricCollectionEnabled(config);
  return {
    ...item,
    globalCollectionEnabled,
    effectiveCollectionEnabled:
      globalCollectionEnabled && item.deviceCollectionEnabled && item.lifecycle === "active",
  };
}

export async function registerAdmsWave2AdminRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required for ADMS Wave 2 Admin routes");
  const auth = new AuthService(
    pool,
    config.AUTH_ENCRYPTION_KEY,
    config.AUTH_SESSION_TTL_HOURS,
    config.NODE_ENV === "production",
  );

  app.get("/admin/attendance/adms/devices/:deviceId/biometric-collection-policy", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.biometrics");
    if (!principal) return;
    const params = deviceIdSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ code: "INVALID_ADMS_DEVICE", message: "ID mesin tidak valid." });
    }

    const result = await pool.query<BiometricCollectionPolicyRow>(
      `SELECT
         id AS "deviceId",
         lifecycle,
         biometric_collection_enabled AS "deviceCollectionEnabled",
         biometric_collection_enabled_at AS "enabledAt",
         biometric_collection_enabled_by_account_id AS "enabledByAccountId"
       FROM attendance_adms_devices
       WHERE id = $1`,
      [params.data.deviceId],
    );
    const item = result.rows[0];
    if (!item) {
      return reply.status(404).send({ code: "ADMS_DEVICE_NOT_FOUND", message: "Mesin tidak ditemukan." });
    }

    reply.header("Cache-Control", "no-store");
    return reply.send({ item: policyResponse(config, item) });
  });

  app.patch("/admin/attendance/adms/devices/:deviceId/biometric-collection-policy", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.biometrics");
    if (!principal) return;
    const params = deviceIdSchema.safeParse(request.params);
    const body = biometricCollectionPolicySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({
        code: "INVALID_BIOMETRIC_COLLECTION_POLICY",
        message: "Policy biometric collection tidak valid.",
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query<BiometricCollectionPolicyRow>(
        `SELECT
           id AS "deviceId",
           lifecycle,
           biometric_collection_enabled AS "deviceCollectionEnabled",
           biometric_collection_enabled_at AS "enabledAt",
           biometric_collection_enabled_by_account_id AS "enabledByAccountId"
         FROM attendance_adms_devices
         WHERE id = $1
         FOR UPDATE`,
        [params.data.deviceId],
      );
      const current = found.rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ code: "ADMS_DEVICE_NOT_FOUND", message: "Mesin tidak ditemukan." });
      }
      if (body.data.enabled && !biometricCollectionEnabled(config)) {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "BIOMETRIC_GLOBAL_COLLECTION_DISABLED",
          message: "Global biometric collection masih OFF. Aktifkan global gate dan keyring secara terkontrol sebelum memilih mesin pilot.",
        });
      }
      if (body.data.enabled && current.lifecycle !== "active") {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "ADMS_DEVICE_INACTIVE",
          message: "Biometric collection hanya dapat diaktifkan untuk mesin lifecycle active.",
        });
      }

      const updated = await client.query<BiometricCollectionPolicyRow>(
        `UPDATE attendance_adms_devices
         SET biometric_collection_enabled = $2,
             biometric_collection_enabled_at = CASE WHEN $2::boolean THEN now() ELSE NULL END,
             biometric_collection_enabled_by_account_id = CASE WHEN $2::boolean THEN $3::uuid ELSE NULL END,
             updated_at = now()
         WHERE id = $1
         RETURNING
           id AS "deviceId",
           lifecycle,
           biometric_collection_enabled AS "deviceCollectionEnabled",
           biometric_collection_enabled_at AS "enabledAt",
           biometric_collection_enabled_by_account_id AS "enabledByAccountId"`,
        [current.deviceId, body.data.enabled, principal.id],
      );
      const item = updated.rows[0]!;
      await writeDeviceAudit(client, {
        actorAccountId: principal.id,
        deviceId: current.deviceId,
        beforeState: current,
        afterState: item,
      });
      await client.query("COMMIT");
      reply.header("Cache-Control", "no-store");
      return reply.send({ item: policyResponse(config, item) });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/admin/attendance/adms/devices/:deviceId/mapping-lifecycle-summary", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.read");
    if (!principal) return;
    const params = deviceIdSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ code: "INVALID_ADMS_DEVICE", message: "ID mesin tidak valid." });
    }

    const result = await pool.query<MappingLifecycleSummaryRow>(
      `SELECT
         d.id AS "deviceId",
         count(m.id)::int AS "activeMappingCount",
         (count(m.id) FILTER (WHERE emp.status <> 'active'))::int AS "reviewRequiredCount"
       FROM attendance_adms_devices d
       LEFT JOIN attendance_adms_employee_mappings m
         ON m.device_id = d.id
        AND m.effective_from <= now()
        AND (m.effective_to IS NULL OR m.effective_to > now())
       LEFT JOIN employees emp ON emp.id = m.employee_id
       WHERE d.id = $1
       GROUP BY d.id`,
      [params.data.deviceId],
    );
    const item = result.rows[0];
    if (!item) {
      return reply.status(404).send({ code: "ADMS_DEVICE_NOT_FOUND", message: "Mesin tidak ditemukan." });
    }

    reply.header("Cache-Control", "no-store");
    return reply.send({ item });
  });

  app.get("/admin/attendance/adms/devices/:deviceId/roster", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.read");
    if (!principal) return;
    const params = deviceIdSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ code: "INVALID_ADMS_DEVICE", message: "ID mesin tidak valid." });
    }

    const exists = await pool.query<{ id: string }>(
      `SELECT id FROM attendance_adms_devices WHERE id = $1`,
      [params.data.deviceId],
    );
    if (!exists.rows[0]) {
      return reply.status(404).send({ code: "ADMS_DEVICE_NOT_FOUND", message: "Mesin tidak ditemukan." });
    }

    const [result, mappingLifecycle] = await Promise.all([
      pool.query(
        `SELECT
           r.id,
           r.pin,
           r.display_name AS "displayName",
           r.card_number AS "cardNumber",
           r.privilege,
           r.verify_mode AS "verifyMode",
           r.safe_metadata AS "safeMetadata",
           r.first_seen_at AS "firstSeenAt",
           r.last_seen_at AS "lastSeenAt",
           r.source_request_id AS "sourceRequestId",
           m.id AS "mappingId",
           m.employee_id AS "employeeId",
           emp.employee_number AS "employeeNumber",
           emp.full_name AS "employeeName",
           emp.status AS "employeeStatus"
         FROM attendance_adms_device_roster_entries r
         LEFT JOIN LATERAL (
           SELECT id, employee_id
           FROM attendance_adms_employee_mappings
           WHERE device_id = r.device_id
             AND pin = r.pin
             AND effective_from <= now()
             AND (effective_to IS NULL OR effective_to > now())
           ORDER BY effective_from DESC
           LIMIT 1
         ) m ON true
         LEFT JOIN employees emp ON emp.id = m.employee_id
         WHERE r.device_id = $1
         ORDER BY r.pin`,
        [params.data.deviceId],
      ),
      pool.query<MappingLifecycleRow>(
        `SELECT
           m.id AS "mappingId",
           m.pin,
           m.employee_id AS "employeeId",
           emp.employee_number AS "employeeNumber",
           emp.full_name AS "employeeName",
           emp.status AS "employeeStatus"
         FROM attendance_adms_employee_mappings m
         JOIN employees emp ON emp.id = m.employee_id
         WHERE m.device_id = $1
           AND m.effective_from <= now()
           AND (m.effective_to IS NULL OR m.effective_to > now())
         ORDER BY m.pin, m.effective_from DESC`,
        [params.data.deviceId],
      ),
    ]);

    const mappingReviewRequiredCount = mappingLifecycle.rows.filter(
      (item) => item.employeeStatus !== "active",
    ).length;

    reply.header("Cache-Control", "no-store");
    return reply.send({
      inventorySemantics: "observed_only",
      completeSnapshot: false,
      note: "Daftar ini hanya berisi observasi aman yang pernah diterima HCIS. Absennya PIN tidak membuktikan user tidak ada di mesin; active USERINFO reads telah dipensiunkan untuk firmware ini.",
      mappingLifecycle: {
        semantics: "active_explicit_mappings",
        activeMappingCount: mappingLifecycle.rows.length,
        reviewRequiredCount: mappingReviewRequiredCount,
        items: mappingLifecycle.rows,
      },
      items: result.rows.map((row) => ({
        ...row,
        mappingStatus: row.mappingId ? "mapped" : "unmapped",
      })),
    });
  });

  app.get("/admin/attendance/adms/biometrics", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.biometrics");
    if (!principal) return;
    const query = biometricQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ code: "INVALID_BIOMETRIC_QUERY", message: "Filter biometric tidak valid." });
    }

    const result = await pool.query(
      `SELECT
         c.id,
         c.employee_id AS "employeeId",
         emp.employee_number AS "employeeNumber",
         emp.full_name AS "employeeName",
         emp.status AS "employeeStatus",
         c.modality,
         c.slot_index AS "slotIndex",
         c.vendor_format AS "vendorFormat",
         c.vendor_version AS "vendorVersion",
         c.origin_device_id AS "originDeviceId",
         d.serial_number AS "originDeviceSerial",
         c.source_pin AS "sourcePin",
         c.captured_at AS "capturedAt",
         c.imported_at AS "importedAt",
         c.lifecycle,
         c.payload_byte_length AS "payloadByteLength",
         c.safe_metadata AS "safeMetadata",
         c.created_at AS "createdAt",
         c.updated_at AS "updatedAt"
       FROM attendance_biometric_credentials c
       JOIN employees emp ON emp.id = c.employee_id
       LEFT JOIN attendance_adms_devices d ON d.id = c.origin_device_id
       WHERE ($1::uuid IS NULL OR c.employee_id = $1)
         AND ($2::uuid IS NULL OR c.origin_device_id = $2)
         AND ($3::text IS NULL OR c.modality = $3)
       ORDER BY emp.full_name, c.modality, c.slot_index NULLS LAST, c.created_at DESC
       LIMIT 1000`,
      [
        query.data.employeeId ?? null,
        query.data.originDeviceId ?? null,
        (query.data.modality as BiometricModality | undefined) ?? null,
      ],
    );

    reply.header("Cache-Control", "no-store");
    const globalCollectionEnabled = biometricCollectionEnabled(config);
    return reply.send({
      collectionEnabled: globalCollectionEnabled,
      globalCollectionEnabled,
      rawPayloadExposed: false,
      items: result.rows,
    });
  });

  app.get("/admin/attendance/adms/devices/:deviceId/biometric-inventory", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.biometrics");
    if (!principal) return;
    const params = deviceIdSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ code: "INVALID_ADMS_DEVICE", message: "ID mesin tidak valid." });
    }

    const exists = await pool.query<{ id: string }>(
      `SELECT id FROM attendance_adms_devices WHERE id = $1`,
      [params.data.deviceId],
    );
    if (!exists.rows[0]) {
      return reply.status(404).send({ code: "ADMS_DEVICE_NOT_FOUND", message: "Mesin tidak ditemukan." });
    }

    const result = await pool.query(
      `SELECT
         s.credential_id AS "credentialId",
         s.state,
         s.device_vendor_format AS "deviceVendorFormat",
         s.observed_at AS "observedAt",
         s.last_synced_at AS "lastSyncedAt",
         s.last_error_code AS "lastErrorCode",
         s.safe_metadata AS "safeMetadata",
         c.employee_id AS "employeeId",
         emp.employee_number AS "employeeNumber",
         emp.full_name AS "employeeName",
         c.modality,
         c.slot_index AS "slotIndex",
         c.vendor_format AS "vaultVendorFormat",
         c.vendor_version AS "vaultVendorVersion",
         c.lifecycle AS "credentialLifecycle"
       FROM attendance_biometric_device_states s
       JOIN attendance_biometric_credentials c ON c.id = s.credential_id
       JOIN employees emp ON emp.id = c.employee_id
       WHERE s.device_id = $1
       ORDER BY emp.full_name, c.modality, c.slot_index NULLS LAST`,
      [params.data.deviceId],
    );

    reply.header("Cache-Control", "no-store");
    return reply.send({
      inventorySemantics: "known_replica_state",
      rawPayloadExposed: false,
      items: result.rows,
    });
  });
}
