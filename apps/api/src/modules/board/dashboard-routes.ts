import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import type { ApiConfig } from "../../config/env.js";
import { requireBoardAccessFromCookie } from "../auth/authorization.js";
import { AuthError, AuthService } from "../auth/service.js";
import { loadBoardAggregates } from "./aggregates.js";

export async function registerBoardDashboardRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
) {
  if (!config.AUTH_ENCRYPTION_KEY) {
    throw new Error("AUTH_ENCRYPTION_KEY is required for board dashboard routes");
  }

  const auth = new AuthService(
    pool,
    config.AUTH_ENCRYPTION_KEY,
    config.AUTH_SESSION_TTL_HOURS,
    config.NODE_ENV === "production",
  );

  // ORG-010-A: FOUNDATION_BOARD, or EMPLOYEE with effective organization-scope board.read.
  app.get("/board/dashboard", async (request, reply) => {
    let principalType: string;
    try {
      principalType = (await requireBoardAccessFromCookie(auth, pool, request.headers.cookie)).principalType;
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      reply.header("Cache-Control", "no-store");
      return reply.status(error.statusCode).send({ code: error.code, message: error.message });
    }

    const aggregates = await loadBoardAggregates(pool);
    reply.header("Cache-Control", "private, no-store");
    return reply.send({
      // ORG-010 D7: the actor's e-mail is no longer returned.
      actor: { principalType },
      ...aggregates,
      unavailableModules: {
        attendance: true,
        payroll: true,
      },
    });
  });
}
