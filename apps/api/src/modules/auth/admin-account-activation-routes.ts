import type { AdminPermission } from "./permissions.js";
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { requirePermissionsFromCookie } from "./authorization.js";
import {
  AccountActivationError,
  AccountActivationService,
} from "./account-activation.js";
import {
  AuthError,
  AuthService,
  type AuthPrincipal,
} from "./service.js";

const accountIdSchema = z.object({ accountId: z.string().uuid() });
const boardAccountSchema = z.object({
  email: z.string().trim().email().max(254),
});

async function audit(
  pool: Pool,
  principal: AuthPrincipal,
  action: string,
  entityType: string,
  entityId: string | null,
  payload: Record<string, unknown> = {},
) {
  await pool.query(
    `INSERT INTO access_audit_events (
      id, actor_account_id, action, entity_type, entity_id, payload
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [randomUUID(), principal.id, action, entityType, entityId, JSON.stringify(payload)],
  );
}

export async function registerAccountActivationAdminRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
) {
  if (!config.AUTH_ENCRYPTION_KEY) {
    throw new Error("AUTH_ENCRYPTION_KEY is required for account activation admin routes");
  }

  const auth = new AuthService(
    pool,
    config.AUTH_ENCRYPTION_KEY,
    config.AUTH_SESSION_TTL_HOURS,
    config.NODE_ENV === "production",
  );
  const activation = new AccountActivationService(pool);

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

  app.post("/admin/access/board-accounts", async (request, reply) => {
    const principal = await authenticateAdmin(request, reply, "access.governance.manage");
    if (!principal) return;
    const body = boardAccountSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({
        code: "INVALID_BOARD_ACCOUNT_INPUT",
        message: "Email account Organ Yayasan tidak valid.",
      });
    }

    const accountId = randomUUID();
    const email = body.data.email.toLowerCase();
    try {
      await pool.query(
        `INSERT INTO accounts (
          id, employee_id, email, principal_type, status
        ) VALUES ($1, NULL, $2, 'FOUNDATION_BOARD', 'invited')`,
        [accountId, email],
      );
    } catch (error) {
      const pgError = error as { code?: string };
      if (pgError.code === "23505") {
        return reply.status(409).send({
          code: "ACCOUNT_ALREADY_EXISTS",
          message: "Email tersebut sudah memiliki account.",
        });
      }
      throw error;
    }

    await audit(pool, principal, "board.account.prepared", "account", accountId, {
      principalType: "FOUNDATION_BOARD",
      status: "invited",
    });
    reply.header("Cache-Control", "no-store");
    return reply.status(201).send({
      id: accountId,
      email,
      principalType: "FOUNDATION_BOARD",
      status: "invited",
    });
  });

  app.post("/admin/access/accounts/:accountId/activation", async (request, reply) => {
    const principal = await authenticateAdmin(request, reply, "access.manage");
    if (!principal) return;
    const params = accountIdSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        code: "INVALID_ACCOUNT_ID",
        message: "Account ID tidak valid.",
      });
    }

    try {
      const issued = await activation.issue(params.data.accountId, principal);
      await audit(pool, principal, "account.activation.issued", "account", params.data.accountId, {
        expiresAt: issued.expiresAt,
      });
      reply.header("Cache-Control", "no-store");
      return reply.status(201).send({
        activationPath: `/activate#token=${issued.token}`,
        expiresAt: issued.expiresAt,
      });
    } catch (error) {
      if (error instanceof AccountActivationError || error instanceof AuthError) {
        return reply.status(error.statusCode).send({ code: error.code, message: error.message });
      }
      throw error;
    }
  });
}
