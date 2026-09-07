import type { AdminPermission } from "../auth/permissions.js";
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { requirePermissionsFromCookie } from "../auth/authorization.js";
import {
  AuthError,
  AuthService,
  type AuthPrincipal,
} from "../auth/service.js";
import {
  decodeWorkingWeekdays,
  encodeWorkingWeekdays,
  type IsoWeekday,
} from "./domain/working-calendar.js";

const weekdaySchema = z.number().int().min(1).max(7);
const workweekSchema = z.object({
  workingWeekdays: z.array(weekdaySchema).min(1).max(7),
});
const yearQuerySchema = z.object({
  year: z.coerce.number().int().min(2020).max(2100).optional(),
});
const dateParamSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
const exceptionSchema = z.object({
  isWorkingDay: z.boolean(),
  label: z.string().trim().max(200).nullable().optional(),
});

interface CalendarSettingRow {
  timezone: string;
  workingWeekdayMask: number | null;
  updatedAt: Date;
}

interface CalendarExceptionRow {
  date: string;
  isWorkingDay: boolean;
  label: string | null;
  updatedAt: Date;
}

async function audit(
  pool: Pool,
  principal: AuthPrincipal,
  action: string,
  entityId: string | null,
  payload: Record<string, unknown>,
) {
  await pool.query(
    `INSERT INTO access_audit_events (
      id, actor_account_id, action, entity_type, entity_id, payload
    ) VALUES ($1, $2, $3, 'leave_calendar', $4, $5::jsonb)`,
    [randomUUID(), principal.id, action, entityId, JSON.stringify(payload)],
  );
}

function jakartaYear(): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Jakarta",
      year: "numeric",
    }).format(new Date()),
  );
}

export async function registerLeaveCalendarAdminRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
) {
  if (!config.AUTH_ENCRYPTION_KEY) {
    throw new Error("AUTH_ENCRYPTION_KEY is required for leave calendar admin routes");
  }

  const auth = new AuthService(
    pool,
    config.AUTH_ENCRYPTION_KEY,
    config.AUTH_SESSION_TTL_HOURS,
    config.NODE_ENV === "production",
  );

  async function authenticateAdmin(
    request: FastifyRequest,
    reply: FastifyReply,
    permission: AdminPermission | readonly AdminPermission[],
  ): Promise<AuthPrincipal | null> {
    try {
      return await requirePermissionsFromCookie(
        auth,
        request.headers.cookie,
        permission,
      );
    } catch (error) {
      if (error instanceof AuthError) {
        reply.header("Cache-Control", "no-store");
        await reply.status(error.statusCode).send({
          code: error.code,
          message: error.message,
        });
        return null;
      }
      throw error;
    }
  }

  app.get("/admin/leave/calendar", async (request, reply) => {
    const principal = await authenticateAdmin(request, reply, "leave.configuration.manage");
    if (!principal) return;

    const parsed = yearQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        code: "INVALID_CALENDAR_YEAR",
        message: "Tahun kalender cuti tidak valid.",
      });
    }

    const year = parsed.data.year ?? jakartaYear();
    const [settings, exceptions] = await Promise.all([
      pool.query<CalendarSettingRow>(
        `SELECT
          timezone,
          working_weekday_mask AS "workingWeekdayMask",
          updated_at AS "updatedAt"
        FROM leave_calendar_settings
        WHERE singleton = true`,
      ),
      pool.query<CalendarExceptionRow>(
        `SELECT
          calendar_date::text AS date,
          is_working_day AS "isWorkingDay",
          label,
          updated_at AS "updatedAt"
        FROM leave_calendar_exceptions
        WHERE calendar_date >= make_date($1, 1, 1)
          AND calendar_date < make_date($1 + 1, 1, 1)
        ORDER BY calendar_date ASC`,
        [year],
      ),
    ]);

    const setting = settings.rows[0];
    reply.header("Cache-Control", "no-store");
    return reply.send({
      year,
      timezone: setting?.timezone ?? "Asia/Jakarta",
      workingWeekdays: decodeWorkingWeekdays(setting?.workingWeekdayMask),
      configured: Boolean(setting?.workingWeekdayMask),
      exceptions: exceptions.rows.map((item) => ({
        ...item,
        updatedAt: item.updatedAt.toISOString(),
      })),
    });
  });

  app.patch("/admin/leave/calendar/workweek", async (request, reply) => {
    const principal = await authenticateAdmin(request, reply, "leave.configuration.manage");
    if (!principal) return;

    const parsed = workweekSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        code: "INVALID_WORKWEEK",
        message: "Hari kerja mingguan tidak valid.",
      });
    }

    const workingWeekdays = [
      ...new Set<number>(parsed.data.workingWeekdays as number[]),
    ].sort((a: number, b: number) => a - b) as IsoWeekday[];
    const mask = encodeWorkingWeekdays(workingWeekdays);

    await pool.query(
      `UPDATE leave_calendar_settings
       SET working_weekday_mask = $1,
           updated_by_account_id = $2,
           updated_at = now()
       WHERE singleton = true`,
      [mask, principal.id],
    );
    await audit(pool, principal, "leave.calendar.workweek.changed", null, {
      workingWeekdays,
    });

    return reply.send({ workingWeekdays });
  });

  app.put("/admin/leave/calendar/exceptions/:date", async (request, reply) => {
    const principal = await authenticateAdmin(request, reply, "leave.configuration.manage");
    if (!principal) return;

    const params = dateParamSchema.safeParse(request.params);
    const body = exceptionSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({
        code: "INVALID_CALENDAR_EXCEPTION",
        message: "Pengecualian kalender tidak valid.",
      });
    }

    await pool.query(
      `INSERT INTO leave_calendar_exceptions (
        calendar_date, is_working_day, label, updated_by_account_id, updated_at
      ) VALUES ($1::date, $2, $3, $4, now())
      ON CONFLICT (calendar_date) DO UPDATE SET
        is_working_day = EXCLUDED.is_working_day,
        label = EXCLUDED.label,
        updated_by_account_id = EXCLUDED.updated_by_account_id,
        updated_at = now()`,
      [
        params.data.date,
        body.data.isWorkingDay,
        body.data.label ?? null,
        principal.id,
      ],
    );
    await audit(pool, principal, "leave.calendar.exception.upserted", null, {
      date: params.data.date,
      isWorkingDay: body.data.isWorkingDay,
    });

    return reply.send({
      date: params.data.date,
      isWorkingDay: body.data.isWorkingDay,
      label: body.data.label ?? null,
    });
  });

  app.delete("/admin/leave/calendar/exceptions/:date", async (request, reply) => {
    const principal = await authenticateAdmin(request, reply, "leave.configuration.manage");
    if (!principal) return;

    const params = dateParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        code: "INVALID_CALENDAR_EXCEPTION",
        message: "Tanggal pengecualian kalender tidak valid.",
      });
    }

    await pool.query(
      "DELETE FROM leave_calendar_exceptions WHERE calendar_date = $1::date",
      [params.data.date],
    );
    await audit(pool, principal, "leave.calendar.exception.deleted", null, {
      date: params.data.date,
    });

    return reply.status(204).send();
  });
}
