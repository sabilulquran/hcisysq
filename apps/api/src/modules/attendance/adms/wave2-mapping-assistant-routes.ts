import type { AdminPermission } from "../../auth/permissions.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../../config/env.js";
import { requirePermissionsFromCookie } from "../../auth/authorization.js";
import { AuthError, AuthService, type AuthPrincipal } from "../../auth/service.js";
import {
  rankMappingCandidates,
  type MappingAssistantEmployee,
} from "./mapping-assistant.js";

const deviceIdSchema = z.object({ deviceId: z.string().uuid() });

type ObservedPinRow = {
  pin: string;
  eventCount: number;
  firstEventAt: Date | null;
  lastEventAt: Date | null;
  rosterDisplayName: string | null;
  cardNumber: string | null;
  privilege: string | null;
  verifyMode: string | null;
  rosterObservedAt: Date | null;
  rosterSourceRequestId: string | null;
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

export async function registerAdmsWave2MappingAssistantRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
) {
  if (!config.AUTH_ENCRYPTION_KEY) {
    throw new Error("AUTH_ENCRYPTION_KEY is required for ADMS mapping assistant routes");
  }
  const auth = new AuthService(
    pool,
    config.AUTH_ENCRYPTION_KEY,
    config.AUTH_SESSION_TTL_HOURS,
    config.NODE_ENV === "production",
  );

  app.get("/admin/attendance/adms/devices/:deviceId/mapping-assistant", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.devices.read");
    if (!principal) return;

    const params = deviceIdSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ code: "INVALID_ADMS_DEVICE", message: "ID mesin tidak valid." });
    }

    const device = await pool.query<{ id: string; lifecycle: string }>(
      `SELECT id, lifecycle FROM attendance_adms_devices WHERE id = $1`,
      [params.data.deviceId],
    );
    if (!device.rows[0]) {
      return reply.status(404).send({ code: "ADMS_DEVICE_NOT_FOUND", message: "Mesin tidak ditemukan." });
    }

    const [observedResult, employeeResult] = await Promise.all([
      pool.query<ObservedPinRow>(
        `WITH raw AS (
           SELECT
             pin,
             count(*)::int AS event_count,
             min(occurred_at) AS first_event_at,
             max(occurred_at) AS last_event_at
           FROM attendance_adms_events
           WHERE device_id = $1
           GROUP BY pin
         ), observed_pins AS (
           SELECT pin FROM raw
           UNION
           SELECT pin
           FROM attendance_adms_device_roster_entries
           WHERE device_id = $1
         )
         SELECT
           p.pin,
           COALESCE(raw.event_count, 0)::int AS "eventCount",
           raw.first_event_at AS "firstEventAt",
           raw.last_event_at AS "lastEventAt",
           r.display_name AS "rosterDisplayName",
           r.card_number AS "cardNumber",
           r.privilege,
           r.verify_mode AS "verifyMode",
           r.last_seen_at AS "rosterObservedAt",
           r.source_request_id AS "rosterSourceRequestId"
         FROM observed_pins p
         LEFT JOIN raw ON raw.pin = p.pin
         LEFT JOIN attendance_adms_device_roster_entries r
           ON r.device_id = $1 AND r.pin = p.pin
         WHERE NOT EXISTS (
           SELECT 1
           FROM attendance_adms_employee_mappings m
           WHERE m.device_id = $1
             AND m.pin = p.pin
             AND m.effective_from <= now()
             AND (m.effective_to IS NULL OR m.effective_to > now())
         )
         ORDER BY r.display_name NULLS LAST, p.pin`,
        [params.data.deviceId],
      ),
      pool.query<MappingAssistantEmployee>(
        `SELECT
           e.id,
           e.employee_number AS "employeeNumber",
           e.full_name AS "fullName",
           ou.name AS "unitName",
           pos.name AS "positionName"
         FROM employees e
         LEFT JOIN organizational_units ou ON ou.id = e.organizational_unit_id
         LEFT JOIN positions pos ON pos.id = e.position_id
         WHERE e.status = 'active'
           AND NOT EXISTS (
             SELECT 1
             FROM attendance_adms_employee_mappings m
             WHERE m.device_id = $1
               AND m.employee_id = e.id
               AND m.effective_from <= now()
               AND (m.effective_to IS NULL OR m.effective_to > now())
           )
         ORDER BY e.full_name, e.employee_number`,
        [params.data.deviceId],
      ),
    ]);

    reply.header("Cache-Control", "no-store");
    return reply.send({
      inventorySemantics: "observed_union",
      completeSnapshot: false,
      autoMapping: false,
      scoring: {
        basis: "name_only",
        candidateLimit: 5,
        minimumSimilarity: 35,
        note: "Similarity adalah alat urut untuk review manusia, bukan confidence/probability dan tidak membuat mapping otomatis.",
      },
      note: "Daftar PIN berasal dari fakta ATTLOG dan safe USERINFO yang pernah teramati. Absennya PIN tidak membuktikan user tidak ada di mesin.",
      items: observedResult.rows.map((row) => ({
        ...row,
        requiresUserInfo: !row.rosterDisplayName?.trim(),
        candidates: row.rosterDisplayName?.trim()
          ? rankMappingCandidates(row.rosterDisplayName, employeeResult.rows, {
              limit: 5,
              minimumSimilarity: 35,
            })
          : [],
      })),
    });
  });
}
