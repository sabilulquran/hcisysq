import type { AdminPermission } from "../auth/permissions.js";
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { requirePermissionsFromCookie } from "../auth/authorization.js";
import { AuthError, AuthService, type AuthPrincipal } from "../auth/service.js";

const employeeIdSchema = z.object({ employeeId: z.string().uuid() });
const contactSchema = z.object({
  email: z.string().trim().email().max(254).nullable(),
  phone: z.string().trim().max(50).nullable(),
});

export async function registerEmployeeContactAdminRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
) {
  if (!config.AUTH_ENCRYPTION_KEY) {
    throw new Error("AUTH_ENCRYPTION_KEY is required for employee contact admin routes");
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

  app.patch("/admin/employees/:employeeId/contact", async (request, reply) => {
    const principal = await authenticateAdmin(request, reply, "employees.manage");
    if (!principal) return;

    const params = employeeIdSchema.safeParse(request.params);
    const body = contactSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({
        code: "INVALID_EMPLOYEE_CONTACT",
        message: "Email atau nomor telepon tidak valid.",
      });
    }

    const email = body.data.email?.toLowerCase() ?? null;
    const phone = body.data.phone || null;
    const updated = await pool.query<{ id: string; email: string | null; phone: string | null }>(
      `UPDATE employees
       SET email = $2, phone = $3, updated_at = now()
       WHERE id = $1
       RETURNING id, email, phone`,
      [params.data.employeeId, email, phone],
    );
    const row = updated.rows[0];
    if (!row) {
      return reply.status(404).send({ code: "EMPLOYEE_NOT_FOUND", message: "Pegawai tidak ditemukan." });
    }

    await pool.query(
      `INSERT INTO access_audit_events (
        id, actor_account_id, action, entity_type, entity_id, payload
      ) VALUES ($1, $2, 'employee.contact.updated', 'employee', $3, $4::jsonb)`,
      [
        randomUUID(),
        principal.id,
        row.id,
        JSON.stringify({ email: row.email, phoneUpdated: true, accountEmailChanged: false }),
      ],
    );

    reply.header("Cache-Control", "no-store");
    return reply.send({
      employeeId: row.id,
      email: row.email,
      phone: row.phone,
      accountEmailChanged: false,
    });
  });
}
