import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import {
  createOrganizationDirectoryMachineTokenVerifier,
  OrganizationDirectoryMachineAuthError,
  readBearerToken,
} from "../organization-directory/machine-auth.js";
import type { VerifyOrganizationDirectoryMachineToken } from "../organization-directory/machine-auth.js";

const querySchema = z.object({
  employeeNumber: z.string().trim().min(1).max(80),
}).strict();

export function registerStaffIdentityRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
  overrideVerifier?: VerifyOrganizationDirectoryMachineToken,
) {
  const enabled = config.STAFF_IDENTITY_VERIFY_ENABLED === "1";
  const verifier = enabled
    ? overrideVerifier ?? createOrganizationDirectoryMachineTokenVerifier({
      issuer: config.STAFF_IDENTITY_TOKEN_ISSUER!,
      audience: config.STAFF_IDENTITY_TOKEN_AUDIENCE!,
      allowedClients: new Set(config.STAFF_IDENTITY_ALLOWED_CLIENTS!.split(",").map((value) => value.trim()).filter(Boolean)),
      requiredScope: "staff-identity.verify",
    })
    : null;

  app.post("/internal/v1/staff-identity/verify-employee", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!verifier) return reply.code(503).send({ code: "STAFF_IDENTITY_VERIFY_DISABLED" });
    const token = readBearerToken(request.headers.authorization);
    if (!token) return reply.code(401).send({ code: "UNAUTHENTICATED" });
    try {
      await verifier(token);
    } catch (error) {
      if (error instanceof OrganizationDirectoryMachineAuthError) {
        const forbidden = error.code === "FORBIDDEN_CLIENT" || error.code === "INSUFFICIENT_SCOPE";
        return reply.code(forbidden ? 403 : 401).send({ code: forbidden ? "FORBIDDEN_CLIENT" : "UNAUTHENTICATED" });
      }
      throw error;
    }
    const parsed = querySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: "INVALID_REQUEST" });
    const found = await pool.query<{
      id: string; employee_number: string; full_name: string;
      email: string | null; status: "active" | "inactive" | "resigned";
    }>(
      `SELECT id, employee_number, full_name, email, status
         FROM employees WHERE employee_number = $1 AND removed_at IS NULL LIMIT 2`,
      [parsed.data.employeeNumber],
    );
    if (found.rowCount === 0) return reply.code(404).send({ code: "EMPLOYEE_NOT_FOUND" });
    if (found.rowCount !== 1) return reply.code(409).send({ code: "EMPLOYEE_AMBIGUOUS" });
    const row = found.rows[0]!;
    return reply.send({
      employeeId: `hcis:employee:${row.id}`,
      employeeNumber: row.employee_number,
      displayName: row.full_name,
      email: row.email,
      status: row.status,
      verifiedAt: new Date().toISOString(),
    });
  });
}
