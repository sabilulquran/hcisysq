import { createRoleAssignment, removeRoleAssignment, assertAccountManagementTarget, canDelegateRole } from "../auth/role-assignment.js";
import { hasEffectiveOrganizationPermission } from "../auth/permissions.js";
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
  assertManagerAssignment,
  OrgAccessPolicyError,
} from "./org-access-policy.js";

const employeeIdSchema = z.object({ employeeId: z.string().uuid() });
const accountIdSchema = z.object({ accountId: z.string().uuid() });
const assignmentIdSchema = z.object({ assignmentId: z.string().uuid() });

const managerSchema = z.object({
  managerEmployeeId: z.string().uuid().nullable(),
});

const createEmployeeAccountSchema = z.object({
  employeeId: z.string().uuid(),
  email: z.string().trim().email().max(254).optional(),
});

const accountStatusSchema = z.object({
  status: z.enum(["invited", "active", "suspended", "inactive"]),
});

const roleAssignmentSchema = z.object({
  roleId: z.string().uuid(),
  scopeType: z.enum(["own", "unit", "organization"]),
  organizationalUnitId: z.string().uuid().nullable().optional(),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  reason: z.string().trim().max(500).nullable().optional(),
});

interface UnitRow {
  id: string;
  name: string;
  employeeCount: number;
  activeCount: number;
}

interface PositionRow {
  id: string;
  name: string;
  employeeCount: number;
  activeCount: number;
}

interface CoverageRow {
  activeEmployees: number;
  assignedManagers: number;
}

interface EmployeeDetailRow {
  id: string;
  employeeNumber: string;
  fullName: string;
  status: "active" | "inactive" | "resigned";
  employmentStatus: string | null;
  unitId: string | null;
  unitName: string | null;
  positionId: string | null;
  positionName: string | null;
  email: string | null;
  phone: string | null;
  education: string | null;
  startedOn: string | null;
  endedOn: string | null;
  managerEmployeeId: string | null;
  managerEmployeeNumber: string | null;
  managerFullName: string | null;
  accountId: string | null;
  accountEmail: string | null;
  accountStatus: "invited" | "active" | "suspended" | "inactive" | null;
}

interface ManagerCandidateRow {
  id: string;
  employeeNumber: string;
  fullName: string;
  unitName: string | null;
  positionName: string | null;
}

interface AssignmentRow {
  id: string;
  accountId: string;
  roleId: string;
  roleKey: string;
  roleName: string;
  scopeType: "own" | "unit" | "organization";
  organizationalUnitId: string | null;
  organizationalUnitName: string | null;
  startsOn: string | null;
  endsOn: string | null;
  reason: string | null;
  createdAt: Date;
}

interface AccessAccountRow {
  id: string;
  employeeId: string | null;
  email: string;
  principalType: "EMPLOYEE" | "FOUNDATION_BOARD" | "SUPER_ADMIN";
  status: "invited" | "active" | "suspended" | "inactive";
  employeeNumber: string | null;
  employeeName: string | null;
  employeeStatus: "active" | "inactive" | "resigned" | null;
  unitName: string | null;
  createdAt: Date;
}

interface RoleRow {
  id: string;
  roleKey: string;
  name: string;
  description: string | null;
  permissions: string[];
}

interface SimpleUnitRow {
  id: string;
  name: string;
}

async function audit(
  pool: Pick<Pool, "query">,
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

export async function registerOrgAccessAdminRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
) {
  if (!config.AUTH_ENCRYPTION_KEY) {
    throw new Error("AUTH_ENCRYPTION_KEY is required for org/access admin routes");
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

  app.get("/admin/organization", async (request, reply) => {
    const principal = await authenticateAdmin(request, reply, "organization.manage");
    if (!principal) return;

    const [units, positions, coverage] = await Promise.all([
      pool.query<UnitRow>(
        `
          SELECT
            u.id,
            u.name,
            count(e.id)::int AS "employeeCount",
            count(e.id) FILTER (WHERE e.status = 'active')::int AS "activeCount"
          FROM organizational_units u
          LEFT JOIN employees e ON e.organizational_unit_id = u.id
          GROUP BY u.id, u.name
          ORDER BY u.name ASC
        `,
      ),
      pool.query<PositionRow>(
        `
          SELECT
            p.id,
            p.name,
            count(e.id)::int AS "employeeCount",
            count(e.id) FILTER (WHERE e.status = 'active')::int AS "activeCount"
          FROM positions p
          LEFT JOIN employees e ON e.position_id = p.id
          GROUP BY p.id, p.name
          ORDER BY p.name ASC
        `,
      ),
      pool.query<CoverageRow>(
        `
          SELECT
            count(*) FILTER (WHERE status = 'active')::int AS "activeEmployees",
            count(*) FILTER (
              WHERE status = 'active' AND direct_manager_employee_id IS NOT NULL
            )::int AS "assignedManagers"
          FROM employees
        `,
      ),
    ]);

    const summary = coverage.rows[0] ?? { activeEmployees: 0, assignedManagers: 0 };
    reply.header("Cache-Control", "no-store");
    return reply.send({
      units: units.rows,
      positions: positions.rows,
      reportingLines: {
        ...summary,
        missingManagers: Math.max(0, summary.activeEmployees - summary.assignedManagers),
      },
    });
  });

  app.get("/admin/employees/:employeeId", async (request, reply) => {
    const principal = await authenticateAdmin(request, reply, "employees.manage");
    if (!principal) return;

    const parsed = employeeIdSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({ code: "INVALID_EMPLOYEE_ID", message: "Employee ID tidak valid." });
    }

    const employeeId = parsed.data.employeeId;
    const [employee, candidates, assignments] = await Promise.all([
      pool.query<EmployeeDetailRow>(
        `
          SELECT
            e.id,
            e.employee_number AS "employeeNumber",
            e.full_name AS "fullName",
            e.status,
            e.employment_status AS "employmentStatus",
            u.id AS "unitId",
            u.name AS "unitName",
            p.id AS "positionId",
            p.name AS "positionName",
            e.email,
            e.phone,
            e.education,
            e.started_on AS "startedOn",
            e.ended_on AS "endedOn",
            manager.id AS "managerEmployeeId",
            manager.employee_number AS "managerEmployeeNumber",
            manager.full_name AS "managerFullName",
            a.id AS "accountId",
            a.email AS "accountEmail",
            a.status AS "accountStatus"
          FROM employees e
          LEFT JOIN organizational_units u ON u.id = e.organizational_unit_id
          LEFT JOIN positions p ON p.id = e.position_id
          LEFT JOIN employees manager ON manager.id = e.direct_manager_employee_id
          LEFT JOIN accounts a ON a.employee_id = e.id AND a.principal_type = 'EMPLOYEE'
          WHERE e.id = $1
          LIMIT 1
        `,
        [employeeId],
      ),
      pool.query<ManagerCandidateRow>(
        `
          SELECT
            e.id,
            e.employee_number AS "employeeNumber",
            e.full_name AS "fullName",
            u.name AS "unitName",
            p.name AS "positionName"
          FROM employees e
          LEFT JOIN organizational_units u ON u.id = e.organizational_unit_id
          LEFT JOIN positions p ON p.id = e.position_id
          WHERE e.status = 'active' AND e.id <> $1
          ORDER BY e.full_name ASC
        `,
        [employeeId],
      ),
      pool.query<AssignmentRow>(
        `
          SELECT
            ara.id,
            ara.account_id AS "accountId",
            r.id AS "roleId",
            r.role_key AS "roleKey",
            r.name AS "roleName",
            ara.scope_type AS "scopeType",
            ara.organizational_unit_id AS "organizationalUnitId",
            u.name AS "organizationalUnitName",
            ara.starts_on AS "startsOn",
            ara.ends_on AS "endsOn",
            ara.reason,
            ara.created_at AS "createdAt"
          FROM account_role_assignments ara
          JOIN accounts a ON a.id = ara.account_id
          JOIN roles r ON r.id = ara.role_id
          LEFT JOIN organizational_units u ON u.id = ara.organizational_unit_id
          WHERE a.employee_id = $1
          ORDER BY ara.created_at DESC
        `,
        [employeeId],
      ),
    ]);

    const row = employee.rows[0];
    if (!row) {
      return reply.status(404).send({ code: "EMPLOYEE_NOT_FOUND", message: "Pegawai tidak ditemukan." });
    }

    reply.header("Cache-Control", "no-store");
    return reply.send({
      employee: row,
      managerCandidates: candidates.rows,
      assignments: assignments.rows.map((item) => ({
        ...item,
        createdAt: item.createdAt.toISOString(),
      })),
    });
  });

  app.patch("/admin/employees/:employeeId/manager", async (request, reply) => {
    const principal = await authenticateAdmin(request, reply, "approvals.policy.manage");
    if (!principal) return;

    const params = employeeIdSchema.safeParse(request.params);
    const body = managerSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ code: "INVALID_MANAGER_ASSIGNMENT", message: "Data atasan langsung tidak valid." });
    }

    const employeeId = params.data.employeeId;
    const managerId = body.data.managerEmployeeId;

    try {
      assertManagerAssignment(employeeId, managerId);
    } catch (error) {
      if (error instanceof OrgAccessPolicyError) {
        return reply.status(400).send({ code: error.code, message: error.message });
      }
      throw error;
    }

    const employee = await pool.query<{ id: string }>(
      "SELECT id FROM employees WHERE id = $1",
      [employeeId],
    );
    if (!employee.rows[0]) {
      return reply.status(404).send({ code: "EMPLOYEE_NOT_FOUND", message: "Pegawai tidak ditemukan." });
    }

    if (managerId) {
      const manager = await pool.query<{ id: string }>(
        "SELECT id FROM employees WHERE id = $1 AND status = 'active'",
        [managerId],
      );
      if (!manager.rows[0]) {
        return reply.status(409).send({
          code: "MANAGER_NOT_ACTIVE",
          message: "Atasan langsung harus merupakan pegawai aktif.",
        });
      }

      const cycle = await pool.query<{ found: number }>(
        `
          WITH RECURSIVE manager_chain AS (
            SELECT id, direct_manager_employee_id
            FROM employees
            WHERE id = $2
            UNION ALL
            SELECT e.id, e.direct_manager_employee_id
            FROM employees e
            JOIN manager_chain chain ON e.id = chain.direct_manager_employee_id
          )
          SELECT 1 AS found FROM manager_chain WHERE id = $1 LIMIT 1
        `,
        [employeeId, managerId],
      );
      if (cycle.rows[0]) {
        return reply.status(409).send({
          code: "REPORTING_LINE_CYCLE",
          message: "Assignment ini akan membentuk siklus pada reporting line.",
        });
      }
    }

    await pool.query(
      `UPDATE employees
       SET direct_manager_employee_id = $2, updated_at = now()
       WHERE id = $1`,
      [employeeId, managerId],
    );
    await audit(pool, principal, "employee.manager.updated", "employee", employeeId, {
      managerEmployeeId: managerId,
    });

    return reply.send({ employeeId, managerEmployeeId: managerId });
  });

  app.get("/admin/access", async (request, reply) => {
    const principal = await authenticateAdmin(request, reply, "access.manage");
    if (!principal) return;

    const [accounts, assignments, roles, units, unaccounted] = await Promise.all([
      pool.query<AccessAccountRow>(
        `
          SELECT
            a.id,
            a.employee_id AS "employeeId",
            a.email,
            a.principal_type AS "principalType",
            a.status,
            e.employee_number AS "employeeNumber",
            e.full_name AS "employeeName",
            e.status AS "employeeStatus",
            u.name AS "unitName",
            a.created_at AS "createdAt"
          FROM accounts a
          LEFT JOIN employees e ON e.id = a.employee_id
          LEFT JOIN organizational_units u ON u.id = e.organizational_unit_id
          ORDER BY a.principal_type DESC, coalesce(e.full_name, a.email) ASC
        `,
      ),
      pool.query<AssignmentRow>(
        `
          SELECT
            ara.id,
            ara.account_id AS "accountId",
            r.id AS "roleId",
            r.role_key AS "roleKey",
            r.name AS "roleName",
            ara.scope_type AS "scopeType",
            ara.organizational_unit_id AS "organizationalUnitId",
            u.name AS "organizationalUnitName",
            ara.starts_on AS "startsOn",
            ara.ends_on AS "endsOn",
            ara.reason,
            ara.created_at AS "createdAt"
          FROM account_role_assignments ara
          JOIN roles r ON r.id = ara.role_id
          LEFT JOIN organizational_units u ON u.id = ara.organizational_unit_id
          ORDER BY ara.created_at DESC
        `,
      ),
      pool.query<RoleRow>(
        `
          SELECT
            r.id,
            r.role_key AS "roleKey",
            r.name,
            r.description,
            coalesce(
              array_agg(rp.permission_key ORDER BY rp.permission_key)
                FILTER (WHERE rp.permission_key IS NOT NULL),
              ARRAY[]::text[]
            ) AS permissions
          FROM roles r
          LEFT JOIN role_permissions rp ON rp.role_id = r.id
          GROUP BY r.id, r.role_key, r.name, r.description
          ORDER BY r.name ASC
        `,
      ),
      pool.query<SimpleUnitRow>("SELECT id, name FROM organizational_units ORDER BY name ASC"),
      pool.query<{ count: number }>(
        `
          SELECT count(*)::int AS count
          FROM employees e
          WHERE e.status = 'active'
            AND NOT EXISTS (
              SELECT 1 FROM accounts a
              WHERE a.employee_id = e.id AND a.principal_type = 'EMPLOYEE'
            )
        `,
      ),
    ]);

    const canDelegate = await hasEffectiveOrganizationPermission(pool, principal, "access.roles.delegate");
    reply.header("Cache-Control", "no-store");
    return reply.send({
      accounts: accounts.rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        assignments: assignments.rows
          .filter((assignment) => assignment.accountId === row.id)
          .map((assignment) => ({
            ...assignment,
            createdAt: assignment.createdAt.toISOString(),
          })),
      })),
      roles: roles.rows.filter((role) => canDelegateRole(role, canDelegate)),
      units: units.rows,
      summary: {
        accounts: accounts.rows.length,
        active: accounts.rows.filter((row) => row.status === "active").length,
        invited: accounts.rows.filter((row) => row.status === "invited").length,
        unaccountedActiveEmployees: unaccounted.rows[0]?.count ?? 0,
      },
    });
  });

  app.post("/admin/access/employee-accounts", async (request, reply) => {
    const principal = await authenticateAdmin(request, reply, "access.manage");
    if (!principal) return;

    const parsed = createEmployeeAccountSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ code: "INVALID_ACCOUNT_INPUT", message: "Data account pegawai tidak valid." });
    }

    const employee = await pool.query<{
      id: string;
      status: "active" | "inactive" | "resigned";
      email: string | null;
    }>(
      "SELECT id, status, email FROM employees WHERE id = $1",
      [parsed.data.employeeId],
    );
    const row = employee.rows[0];
    if (!row) {
      return reply.status(404).send({ code: "EMPLOYEE_NOT_FOUND", message: "Pegawai tidak ditemukan." });
    }
    if (row.status !== "active") {
      return reply.status(409).send({
        code: "EMPLOYEE_NOT_ACTIVE",
        message: "Account baru hanya dapat disiapkan untuk pegawai aktif.",
      });
    }

    const emailCandidate = parsed.data.email?.trim().toLowerCase() ?? row.email?.trim().toLowerCase() ?? null;
    const validEmail = z.string().email().safeParse(emailCandidate);
    if (!validEmail.success) {
      return reply.status(409).send({
        code: "EMPLOYEE_EMAIL_REQUIRED",
        message: "Email valid diperlukan sebelum account pegawai dapat disiapkan.",
      });
    }

    const accountId = randomUUID();
    try {
      await pool.query(
        `
          INSERT INTO accounts (
            id, employee_id, email, principal_type, status
          ) VALUES ($1, $2, $3, 'EMPLOYEE', 'invited')
        `,
        [accountId, row.id, validEmail.data.toLowerCase()],
      );
    } catch (error) {
      const pgError = error as { code?: string };
      if (pgError.code === "23505") {
        return reply.status(409).send({
          code: "ACCOUNT_ALREADY_EXISTS",
          message: "Pegawai atau email tersebut sudah memiliki account.",
        });
      }
      throw error;
    }

    await audit(pool, principal, "employee.account.prepared", "account", accountId, {
      employeeId: row.id,
      status: "invited",
    });
    return reply.status(201).send({
      id: accountId,
      employeeId: row.id,
      email: validEmail.data.toLowerCase(),
      principalType: "EMPLOYEE",
      status: "invited",
    });
  });

  app.patch("/admin/access/accounts/:accountId/status", async (request, reply) => {
    const principal = await authenticateAdmin(request, reply, "access.manage");
    if (!principal) return;

    const params = accountIdSchema.safeParse(request.params);
    const body = accountStatusSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ code: "INVALID_ACCOUNT_STATUS", message: "Status account tidak valid." });
    }

    const client = await pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      const account = await client.query<{
        id: string;
        principalType: "EMPLOYEE" | "FOUNDATION_BOARD" | "SUPER_ADMIN";
        passwordHash: string | null;
      }>(
        `SELECT id, principal_type AS "principalType", password_hash AS "passwordHash"
         FROM accounts WHERE id = $1 FOR UPDATE`,
        [params.data.accountId],
      );
      const row = account.rows[0];
      if (!row) {
        return reply.status(404).send({ code: "ACCOUNT_NOT_FOUND", message: "Account tidak ditemukan." });
      }
      await assertAccountManagementTarget(client, principal, row.id);
      if (row.principalType === "SUPER_ADMIN") {
        return reply.status(403).send({
          code: "SUPER_ADMIN_STATUS_PROTECTED",
          message: "Status Super Admin tidak diubah melalui employee access administration.",
        });
      }
      if (body.data.status === "active" && !row.passwordHash) {
        return reply.status(409).send({
          code: "ACCOUNT_ACTIVATION_NOT_READY",
          message: "Account belum memiliki metode autentikasi. Aktivasi akan dibuka pada flow invite/login berikutnya.",
        });
      }

      await client.query(
        "UPDATE accounts SET status = $2, updated_at = now() WHERE id = $1",
        [row.id, body.data.status],
      );
      await audit(client, principal, "account.status.updated", "account", row.id, {
        status: body.data.status,
      });
      await client.query("COMMIT");
      committed = true;
      return reply.send({ id: row.id, status: body.data.status });
    } catch (error) {
      if (error instanceof AuthError) return reply.status(error.statusCode).send({ code: error.code, message: error.message });
      throw error;
    } finally {
      try { if (!committed) await client.query("ROLLBACK"); } finally { client.release(); }
    }
  });

  app.post("/admin/access/accounts/:accountId/role-assignments", async (request, reply) => {
    const principal = await authenticateAdmin(request, reply, "access.roles.assign");
    if (!principal) return;

    const params = accountIdSchema.safeParse(request.params);
    const body = roleAssignmentSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ code: "INVALID_ROLE_ASSIGNMENT", message: "Role assignment tidak valid." });
    }

    try {
      const id = await createRoleAssignment(pool, principal, params.data.accountId, body.data);
      return reply.status(201).send({ id });
    } catch (error) {
      if (error instanceof AuthError || error instanceof OrgAccessPolicyError) {
        return reply.status(error instanceof AuthError ? error.statusCode : 400).send({ code: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.delete("/admin/access/role-assignments/:assignmentId", async (request, reply) => {
    const principal = await authenticateAdmin(request, reply, "access.roles.assign");
    if (!principal) return;

    const params = assignmentIdSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ code: "INVALID_ASSIGNMENT_ID", message: "Assignment ID tidak valid." });
    }

    try {
      await removeRoleAssignment(pool, principal, params.data.assignmentId);
      return reply.status(204).send();
    } catch (error) {
      if (error instanceof AuthError) return reply.status(error.statusCode).send({ code: error.code, message: error.message });
      throw error;
    }
  });
}
