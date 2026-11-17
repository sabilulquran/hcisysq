// TRAIN-001 helpers shared by the Package 1, R3 evaluation and R4 online-module routes.

import { randomUUID } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";

import type { TrainingPermission } from "../auth/permissions.js";
import type { AuthPrincipal } from "../auth/service.js";

export type Queryable = Pool | PoolClient;

/** The request plumbing of registerTrainingRoutes, handed to the R3 and R4 route groups. */
export interface TrainingRouteKit {
  pool: Pool;
  requireEmployee: (request: FastifyRequest, reply: FastifyReply) => Promise<AuthPrincipal | null>;
  requirePermission: (request: FastifyRequest, reply: FastifyReply, permission: TrainingPermission) => Promise<AuthPrincipal | null>;
  handle: (reply: FastifyReply, work: () => Promise<unknown>) => Promise<unknown>;
  transact: (reply: FastifyReply, work: (client: PoolClient) => Promise<[number, unknown]>) => Promise<unknown>;
  invalid: (reply: FastifyReply, code: string, message: string) => unknown;
  /** Runs `work` in its own transaction (for steps around a long upload that must not hold locks). */
  transactWork: <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;
  /** Whether the principal also holds training.manage (answer keys are shown only then). */
  canManage: (principal: AuthPrincipal) => Promise<boolean>;
}

export class TrainingError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "TrainingError";
  }
}

export function send(reply: FastifyReply, status: number, body: unknown) {
  reply.header("Cache-Control", "no-store");
  return reply.status(status).send(body);
}

export async function audit(
  db: Queryable,
  input: {
    eventType: string;
    actorAccountId: string | null;
    programId?: string | null;
    sessionId?: string | null;
    recordId?: string | null;
    employeeId?: string | null;
    note?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  // clock_timestamp(), not now(): events written in one transaction keep their order.
  await db.query(
    `INSERT INTO training_audit_events
       (id, event_type, program_id, session_id, record_id, employee_id, actor_account_id, note, metadata, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, clock_timestamp())`,
    [
      randomUUID(), input.eventType, input.programId ?? null, input.sessionId ?? null, input.recordId ?? null,
      input.employeeId ?? null, input.actorAccountId, input.note ?? null, JSON.stringify(input.metadata ?? {}),
    ],
  );
}

export async function loadSelf(db: Queryable, accountId: string, lock = false): Promise<{ id: string; fullName: string }> {
  const result = await db.query<{ id: string; fullName: string; status: string }>(
    `SELECT employee.id, employee.full_name AS "fullName", employee.status
       FROM accounts account
       JOIN employees employee ON employee.id = account.employee_id
      WHERE account.id = $1 AND account.principal_type = 'EMPLOYEE' AND account.status = 'active'
        AND employee.removed_at IS NULL
      ${lock ? "FOR UPDATE OF employee" : ""}`,
    [accountId],
  );
  const employee = result.rows[0];
  if (!employee || employee.status !== "active") {
    throw new TrainingError(403, "EMPLOYEE_NOT_ACTIVE", "Akun tidak terhubung ke pegawai aktif.");
  }
  return employee;
}
