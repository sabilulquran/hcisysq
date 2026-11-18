// LEAVE-009 routes: HC manages critical periods (masa kritis). Spec:
// docs/domain/leave-critical-periods.md §5, §6, §8.
//
// Managing periods reuses leave.configuration.manage (the leave calendar permission). Since D-12
// (2026-11-18) a critical period no longer adds an HC review step, so there is no review queue
// and no HC decision route here: the unit head who approves carries the responsibility.

import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { pageOffset, pageQuerySchema, pagination } from "../../lib/pagination.js";
import { requirePermissionsFromCookie } from "../auth/authorization.js";
import { AuthError, AuthService, type AuthPrincipal } from "../auth/service.js";
import { assertCriticalPeriodRange, CriticalPeriodError } from "./domain/critical-period.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const periodBodySchema = z.object({
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  startOn: isoDate,
  endOn: isoDate,
  unitId: z.string().uuid().nullable(),
});
const periodPatchSchema = periodBodySchema.partial().extend({
  isActive: z.boolean().optional(),
}).refine((body) => Object.keys(body).length > 0, { message: "empty" });
const periodParamSchema = z.object({ id: z.string().uuid() });
const periodListQuery = pageQuerySchema.extend({
  status: z.enum(["active", "inactive", "all"]).default("active"),
  year: z.coerce.number().int().min(2020).max(2100).optional(),
});

interface PeriodRow {
  id: string;
  label: string;
  description: string | null;
  startOn: string;
  endOn: string;
  unitId: string | null;
  unitName: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

class CriticalPeriodRouteError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = "CriticalPeriodRouteError";
  }
}

const PERIOD_SELECT = `
  SELECT
    period.id,
    period.label,
    period.description,
    period.starts_on::text AS "startOn",
    period.ends_on::text AS "endOn",
    period.organizational_unit_id AS "unitId",
    unit.name AS "unitName",
    period.is_active AS "isActive",
    period.created_at AS "createdAt",
    period.updated_at AS "updatedAt"
  FROM leave_critical_periods period
  LEFT JOIN organizational_units unit ON unit.id = period.organizational_unit_id`;

function presentPeriod(row: PeriodRow) {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

async function audit(
  db: Pool | PoolClient,
  principal: AuthPrincipal,
  action: string,
  entityId: string,
  payload: Record<string, unknown>,
) {
  await db.query(
    `INSERT INTO access_audit_events (
      id, actor_account_id, action, entity_type, entity_id, payload
    ) VALUES ($1, $2, $3, 'leave_critical_period', $4, $5::jsonb)`,
    [randomUUID(), principal.id, action, entityId, JSON.stringify(payload)],
  );
}

async function assertUnitExists(db: Pool | PoolClient, unitId: string | null) {
  if (!unitId) return;
  const unit = await db.query("SELECT 1 FROM organizational_units WHERE id = $1", [unitId]);
  if (!unit.rows[0]) {
    throw new CriticalPeriodRouteError(404, "UNIT_NOT_FOUND", "Unit tidak ditemukan.");
  }
}

function mapKnownError(error: unknown): CriticalPeriodRouteError | null {
  if (error instanceof CriticalPeriodRouteError) return error;
  if (error instanceof CriticalPeriodError) return new CriticalPeriodRouteError(400, error.code, error.message);
  if (error instanceof AuthError) return new CriticalPeriodRouteError(error.statusCode, error.code, error.message);
  return null;
}

async function sendKnownError(reply: FastifyReply, error: unknown) {
  const known = mapKnownError(error);
  if (!known) throw error;
  reply.header("Cache-Control", "no-store");
  return reply.status(known.statusCode).send({ code: known.code, message: known.message });
}

export async function registerLeaveCriticalPeriodRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
) {
  if (!config.AUTH_ENCRYPTION_KEY) {
    throw new Error("AUTH_ENCRYPTION_KEY is required for leave critical period routes");
  }
  const auth = new AuthService(
    pool,
    config.AUTH_ENCRYPTION_KEY,
    config.AUTH_SESSION_TTL_HOURS,
    config.NODE_ENV === "production",
  );

  async function authenticateAdmin(request: FastifyRequest, reply: FastifyReply) {
    try {
      return await requirePermissionsFromCookie(auth, request.headers.cookie, "leave.configuration.manage");
    } catch (error) {
      await sendKnownError(reply, error);
      return null;
    }
  }

  // ------------------------------------------------------------ HC Admin: periods

  app.get("/admin/leave/critical-periods", async (request, reply) => {
    const principal = await authenticateAdmin(request, reply);
    if (!principal) return;
    const query = periodListQuery.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ code: "INVALID_CRITICAL_PERIOD_QUERY", message: "Filter masa kritis tidak valid." });
    }
    const { status, year } = query.data;
    const where = `
      WHERE ($1::text = 'all' OR period.is_active = ($1::text = 'active'))
        AND ($2::int IS NULL OR (
          period.starts_on < make_date($2::int + 1, 1, 1) AND period.ends_on >= make_date($2::int, 1, 1)
        ))`;
    const params = [status, year ?? null];
    const [rows, total, units] = await Promise.all([
      pool.query<PeriodRow>(
        `${PERIOD_SELECT}
        ${where}
        ORDER BY period.starts_on DESC, period.id ASC
        LIMIT $3 OFFSET $4`,
        [...params, query.data.pageSize, pageOffset(query.data)],
      ),
      pool.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM leave_critical_periods period ${where}`,
        params,
      ),
      // Units are bounded organization data (ENG-LIST-001 §1), offered for the scope picker.
      pool.query<{ id: string; name: string }>(
        "SELECT id, name FROM organizational_units ORDER BY name ASC, id ASC",
      ),
    ]);
    reply.header("Cache-Control", "no-store");
    return reply.send({
      items: rows.rows.map(presentPeriod),
      pagination: pagination(query.data, total.rows[0]?.total ?? 0),
      unitOptions: units.rows,
    });
  });

  app.post("/admin/leave/critical-periods", async (request, reply) => {
    const principal = await authenticateAdmin(request, reply);
    if (!principal) return;
    const body = periodBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ code: "INVALID_CRITICAL_PERIOD", message: "Data masa kritis tidak valid." });
    }
    try {
      assertCriticalPeriodRange(body.data.startOn, body.data.endOn);
      await assertUnitExists(pool, body.data.unitId);
      const id = randomUUID();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO leave_critical_periods (
            id, label, description, starts_on, ends_on, organizational_unit_id,
            created_by_account_id, updated_by_account_id
          ) VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $7)`,
          [
            id,
            body.data.label,
            body.data.description || null,
            body.data.startOn,
            body.data.endOn,
            body.data.unitId,
            principal.id,
          ],
        );
        await audit(client, principal, "leave.critical_period.created", id, {
          label: body.data.label,
          startOn: body.data.startOn,
          endOn: body.data.endOn,
          unitId: body.data.unitId,
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      const created = await pool.query<PeriodRow>(`${PERIOD_SELECT} WHERE period.id = $1`, [id]);
      return reply.status(201).send(presentPeriod(created.rows[0]!));
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.patch("/admin/leave/critical-periods/:id", async (request, reply) => {
    const principal = await authenticateAdmin(request, reply);
    if (!principal) return;
    const params = periodParamSchema.safeParse(request.params);
    const body = periodPatchSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ code: "INVALID_CRITICAL_PERIOD", message: "Data masa kritis tidak valid." });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<PeriodRow>(
        `${PERIOD_SELECT} WHERE period.id = $1 FOR UPDATE OF period`,
        [params.data.id],
      );
      const before = current.rows[0];
      if (!before) {
        throw new CriticalPeriodRouteError(404, "CRITICAL_PERIOD_NOT_FOUND", "Masa kritis tidak ditemukan.");
      }
      const next = {
        label: body.data.label ?? before.label,
        description: body.data.description !== undefined ? body.data.description || null : before.description,
        startOn: body.data.startOn ?? before.startOn,
        endOn: body.data.endOn ?? before.endOn,
        unitId: body.data.unitId !== undefined ? body.data.unitId : before.unitId,
        isActive: body.data.isActive ?? before.isActive,
      };
      assertCriticalPeriodRange(next.startOn, next.endOn);
      if (next.unitId !== before.unitId) await assertUnitExists(client, next.unitId);
      await client.query(
        `UPDATE leave_critical_periods
         SET label = $2, description = $3, starts_on = $4::date, ends_on = $5::date,
             organizational_unit_id = $6, is_active = $7,
             updated_by_account_id = $8, updated_at = now()
         WHERE id = $1`,
        [params.data.id, next.label, next.description, next.startOn, next.endOn, next.unitId, next.isActive, principal.id],
      );
      const changedFields = (["label", "description", "startOn", "endOn", "unitId"] as const)
        .filter((field) => next[field] !== before[field]);
      if (changedFields.length > 0) {
        await audit(client, principal, "leave.critical_period.updated", params.data.id, {
          before: Object.fromEntries(changedFields.map((field) => [field, before[field]])),
          after: Object.fromEntries(changedFields.map((field) => [field, next[field]])),
        });
      }
      if (next.isActive !== before.isActive) {
        await audit(
          client,
          principal,
          next.isActive ? "leave.critical_period.reactivated" : "leave.critical_period.deactivated",
          params.data.id,
          { label: next.label },
        );
      }
      await client.query("COMMIT");
      const updated = await pool.query<PeriodRow>(`${PERIOD_SELECT} WHERE period.id = $1`, [params.data.id]);
      return reply.send(presentPeriod(updated.rows[0]!));
    } catch (error) {
      await client.query("ROLLBACK");
      return sendKnownError(reply, error);
    } finally {
      client.release();
    }
  });
}
