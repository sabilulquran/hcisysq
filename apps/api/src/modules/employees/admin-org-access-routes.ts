import {
  allowedScopes, assertAccountManagementTarget, assertRoleGrantor, canDelegateRole, createRoleAssignment,
  isSeatLinkableRole, removeRoleAssignment,
} from "../auth/role-assignment.js";
import { hasEffectiveOrganizationPermission } from "../auth/permissions.js";
import type { AdminPermission } from "../auth/permissions.js";
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { OUTSIDE_HCIS_CODE, OUTSIDE_HCIS_MESSAGE, isOutsideHcis } from "./management-scope.js";
import { pageOffset, pageQuerySchema, pagination } from "../../lib/pagination.js";
import { requirePermissionsFromCookie } from "../auth/authorization.js";
import { closeOpenInvitations } from "../auth/activation-invitation.js";
import {
  AUTH_COOKIE_NAME,
  AuthError,
  AuthService,
  readCookie,
  type AuthPrincipal,
} from "../auth/service.js";
import {
  activationReadiness,
  type ActivationReadiness,
} from "../auth/account-activation-readiness.js";
import {
  assertManagerAssignment,
  OrgAccessPolicyError,
} from "./org-access-policy.js";
import {
  computeRoleSeatCheck,
  type RoleSeatCheck,
  type RoleSeatHolder,
  type SeatHolderRow,
} from "../auth/role-seat-check.js";
import { jakartaBusinessDate } from "../organization/jakarta-date.js";
import { PostgresOrganizationRepository } from "../organization/repository.js";

const employeeIdSchema = z.object({ employeeId: z.string().uuid() });
const accountIdSchema = z.object({ accountId: z.string().uuid() });
const assignmentIdSchema = z.object({ assignmentId: z.string().uuid() });
// ENG-LIST-001: GET /admin/access pages accounts; includeInactive=true also lists inactive ones.
const accessListQuerySchema = pageQuerySchema.extend({
  q: z.string().trim().max(120).optional(),
  includeInactive: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
});

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

const ACTIVATION_NOT_READY_MESSAGES: Record<Extract<ActivationReadiness, { ready: false }>["code"], string> = {
  ACCOUNT_ACTIVATION_NOT_READY:
    "Account belum memiliki metode masuk. Petakan identitas Akun SQ-nya terlebih dahulu, atau gunakan link aktivasi.",
  OIDC_ISSUER_MISMATCH: "Identitas Akun SQ pada account ini bukan dari realm login HCIS yang aktif.",
  EMPLOYEE_NOT_ACTIVE: "Account pegawai hanya dapat diaktifkan untuk pegawai aktif.",
};

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
  managementScope: "MANAGED" | "OUTSIDE_HCIS";
  managementScopeReason: string | null;
  managementScopeNote: string | null;
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
            -- S2B §8.7: the screen has to know, or its edit forms invite a
            -- write the API will refuse with a bare 409.
            e.management_scope AS "managementScope",
            e.management_scope_reason AS "managementScopeReason",
            e.management_scope_note AS "managementScopeNote",
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

    // EMP-005 S2B: a record outside HCIS management is read-only (§8.7), and
    // one may not be named as a manager either. Existing subordinates of a
    // record marked later keep pointing at it until approval routing learns
    // the marker, which is S2B-b.
    for (const target of [employeeId, managerId]) {
      if (target && await isOutsideHcis(pool, target)) {
        reply.header("Cache-Control", "no-store");
        return reply.status(409).send({ code: OUTSIDE_HCIS_CODE, message: OUTSIDE_HCIS_MESSAGE });
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

    const query = accessListQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ code: "INVALID_QUERY", message: "Pencarian atau halaman account tidak valid." });
    }
    // ENG-LIST-001: accounts are searched and paged in SQL; inactive ones stay out unless asked for.
    // % and _ typed by the admin are matched literally, not as wildcards.
    const search = query.data.q?.trim().replace(/[\\%_]/g, (character) => `\\${character}`) || null;
    const accountFilter = `
          WHERE ($1::text IS NULL
            OR a.email ILIKE '%' || $1 || '%'
            OR coalesce(e.full_name, '') ILIKE '%' || $1 || '%'
            OR coalesce(e.employee_number, '') ILIKE '%' || $1 || '%')
            AND ($2::boolean OR a.status <> 'inactive')`;
    const filterValues = [search, query.data.includeInactive];

    const [accounts, accountCount, summaryCounts, roles, units, unaccounted] = await Promise.all([
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
          ${accountFilter}
          ORDER BY a.principal_type DESC, coalesce(e.full_name, a.email) ASC, a.id ASC
          LIMIT $3 OFFSET $4
        `,
        [...filterValues, query.data.pageSize, pageOffset(query.data)],
      ),
      pool.query<{ total: number }>(
        `SELECT count(*)::int AS total
           FROM accounts a
           LEFT JOIN employees e ON e.id = a.employee_id
           ${accountFilter}`,
        filterValues,
      ),
      // The summary cards count every account, whatever page or search is showing.
      pool.query<{ accounts: number; active: number; invited: number }>(
        `SELECT count(*)::int AS accounts,
                count(*) FILTER (WHERE status = 'active')::int AS active,
                count(*) FILTER (WHERE status = 'invited')::int AS invited
           FROM accounts`,
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
    // Role assignments (current and ended) only for the accounts on this page.
    const assignments = await pool.query<AssignmentRow>(
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
          WHERE ara.account_id = ANY($1::uuid[])
          ORDER BY ara.created_at DESC, ara.id DESC
        `,
      [accounts.rows.map((row) => row.id)],
    );
    // AUTH-015: roles these accounts hold because of a seat, shown apart from direct grants and
    // with the seat they come from. `effective` is false while the account or employee is not
    // active, exactly as the permission engine decides (hcis_seat_permissions).
    const seatRoles = await pool.query<{
      accountId: string; roleKey: string; roleName: string; positionKey: string;
      positionTitle: string; unitName: string | null; kind: "PRIMARY" | "ACTING"; effective: boolean;
    }>(
      `SELECT h.account_id AS "accountId", r.role_key AS "roleKey", r.name AS "roleName",
              h.position_key AS "positionKey", p.title AS "positionTitle", n.name AS "unitName",
              h.incumbency_kind AS kind, (h.account_status = 'active' AND h.employee_active) AS effective
         FROM hcis_seat_role_holders(current_date) h
         JOIN roles r ON r.role_key = h.role_key
         JOIN organization_positions p ON p.change_set_id = h.change_set_id AND p.stable_key = h.position_key
         LEFT JOIN organization_nodes n ON n.change_set_id = h.change_set_id AND n.stable_key = p.node_key
        WHERE h.account_id = ANY($1::uuid[])
        ORDER BY r.name, p.title`,
      [accounts.rows.map((row) => row.id)],
    );

    // AUTH-002-INVITE: the latest activation send per account on this page, without contacts.
    const invitations = await pool.query<{
      accountId: string;
      createdAt: Date;
      emailStatus: string;
      whatsappStatus: string;
      hubAccess: string;
      completedAt: Date | null;
      revokedAt: Date | null;
    }>(
      `SELECT DISTINCT ON (account_id)
              account_id AS "accountId", created_at AS "createdAt", email_status AS "emailStatus",
              whatsapp_status AS "whatsappStatus", hub_access AS "hubAccess",
              completed_at AS "completedAt", revoked_at AS "revokedAt"
         FROM account_activation_invitations
        WHERE account_id = ANY($1::uuid[]) AND state = 'issued'
        ORDER BY account_id, created_at DESC`,
      [accounts.rows.map((row) => row.id)],
    );
    const latestInvitation = new Map(invitations.rows.map((row) => [row.accountId, {
      sentAt: row.createdAt.toISOString(),
      emailStatus: row.emailStatus,
      whatsappStatus: row.whatsappStatus,
      hubAccess: row.hubAccess,
      completedAt: row.completedAt?.toISOString() ?? null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
    }]));

    const canDelegate = await hasEffectiveOrganizationPermission(pool, principal, "access.roles.delegate");
    const counts = summaryCounts.rows[0] ?? { accounts: 0, active: 0, invited: 0 };
    reply.header("Cache-Control", "no-store");
    return reply.send({
      accounts: accounts.rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        latestInvitation: latestInvitation.get(row.id) ?? null,
        assignments: assignments.rows
          .filter((assignment) => assignment.accountId === row.id)
          .map((assignment) => ({
            ...assignment,
            createdAt: assignment.createdAt.toISOString(),
          })),
        seatRoles: seatRoles.rows
          .filter((seatRole) => seatRole.accountId === row.id)
          .map(({ accountId, ...seatRole }) => { void accountId; return seatRole; }),
      })),
      pagination: pagination(query.data, accountCount.rows[0]?.total ?? 0),
      // AUTH-002-INVITE: OIDC production activates employees by invitation; local mode by link.
      activationMethod: config.AUTH_MODE === "oidc" ? "invitation" : "link",
      // AUTH-011 §Scope per peran: the screen offers only the scopes that make the role work.
      roles: roles.rows
        .filter((role) => canDelegateRole(role, canDelegate))
        .map((role) => ({ ...role, allowedScopes: allowedScopes(role.roleKey) })),
      units: units.rows,
      summary: {
        accounts: counts.accounts,
        active: counts.active,
        invited: counts.invited,
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
        status: "invited" | "active" | "suspended" | "inactive";
        hasPassword: boolean;
        identityIssuer: string | null;
        identitySubject: string | null;
        employeeStatus: "active" | "inactive" | "resigned" | null;
      }>(
        `SELECT a.id, a.principal_type AS "principalType", a.status, a.password_hash IS NOT NULL AS "hasPassword",
                a.identity_issuer AS "identityIssuer", a.identity_subject AS "identitySubject",
                e.status AS "employeeStatus"
         FROM accounts a LEFT JOIN employees e ON e.id = a.employee_id
         WHERE a.id = $1 FOR UPDATE OF a`,
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
      const readiness = body.data.status === "active"
        ? activationReadiness(row, config.OIDC_ISSUER)
        : null;
      if (readiness && !readiness.ready) {
        return reply.status(409).send({ code: readiness.code, message: ACTIVATION_NOT_READY_MESSAGES[readiness.code] });
      }

      await client.query(
        "UPDATE accounts SET status = $2, updated_at = now() WHERE id = $1",
        [row.id, body.data.status],
      );
      if (body.data.status !== "active") {
        await client.query(
          "UPDATE auth_sessions SET revoked_at = coalesce(revoked_at, now()) WHERE account_id = $1 AND revoked_at IS NULL",
          [row.id],
        );
        await client.query(
          `UPDATE account_activation_tokens
           SET revoked_at = coalesce(revoked_at, now())
           WHERE account_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`,
          [row.id],
        );
      }
      // AUTH-002-INVITE: after any status change, a later sign-in can no longer activate by invitation.
      const invitationsClosed = row.status !== body.data.status
        ? await closeOpenInvitations(client, row.id, body.data.status)
        : 0;
      await audit(client, principal, "account.status.updated", "account", row.id, {
        status: body.data.status,
        ...(readiness?.ready ? { authenticationMethod: readiness.method } : {}),
        sessionsRevoked: body.data.status !== "active",
        activationTokensRevoked: body.data.status !== "active",
        ...(invitationsClosed ? { activationInvitationsClosed: invitationsClosed } : {}),
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

  // Role grants are Super Admin only; the check precedes input validation so other actors learn nothing.
  async function authenticateRoleGrantor(request: FastifyRequest, reply: FastifyReply) {
    // ORG-010-C: every signed-in actor other than Super Admin gets ROLE_GRANT_SUPER_ADMIN_ONLY,
    // whatever permissions it holds; nothing is read or written.
    const session = await auth.getSession(readCookie(request.headers.cookie, AUTH_COOKIE_NAME));
    const principal = session && session.principal.principalType !== "SUPER_ADMIN"
      ? session.principal
      : await authenticateAdmin(request, reply, "access.roles.assign");
    if (!principal) return null;
    try {
      assertRoleGrantor(principal, "break_glass");
      return principal;
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      reply.header("Cache-Control", "no-store");
      await reply.status(error.statusCode).send({ code: error.code, message: error.message });
      return null;
    }
  }

  app.post("/admin/access/accounts/:accountId/role-assignments", async (request, reply) => {
    const principal = await authenticateRoleGrantor(request, reply);
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
    const principal = await authenticateRoleGrantor(request, reply);
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

  /**
   * AUTH-015 (ADR-0007): the roles that may follow a seat, decided from the stored permissions of
   * each role. Never a list the caller supplied, and never a role that carries an access.* key.
   */
  async function loadSeatLinkableRoles(): Promise<Array<{ roleKey: string; roleName: string }>> {
    const result = await pool.query<{ roleKey: string; roleName: string; permissions: string[] }>(
      `SELECT r.role_key AS "roleKey", r.name AS "roleName",
              coalesce(array_agg(rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL), ARRAY[]::text[]) AS permissions
         FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
        GROUP BY r.id ORDER BY r.name`,
    );
    return result.rows
      .filter((role) => isSeatLinkableRole(role))
      .map(({ roleKey, roleName }) => ({ roleKey, roleName }));
  }

  /**
   * AUTH-015: per linked role, its seats, who sits in each today and whether the role is in force
   * for them, and the direct grants that follow no seat. Read-only. The seat holders come from the
   * same SQL function the permission engine uses, so the screen cannot disagree with who can act.
   */
  async function loadRoleSeatChecks(onlyRoleKey: string | null = null): Promise<RoleSeatCheck[]> {
    const asOf = jakartaBusinessDate();
    const links = await pool.query<{ roleKey: string; roleName: string; positionKey: string; reason: string; setAt: Date }>(
      `SELECT l.role_key AS "roleKey", r.name AS "roleName", l.position_key AS "positionKey", l.reason, l.set_at AS "setAt"
         FROM access_role_position_links l JOIN roles r ON r.role_key = l.role_key
        WHERE ($1::text IS NULL OR l.role_key = $1)
        ORDER BY r.name, l.set_at, l.position_key`,
      [onlyRoleKey],
    );
    const roleKeys = [...new Set(links.rows.map((row) => row.roleKey))];
    if (roleKeys.length === 0) return [];
    const [holders, seatHolders, snapshot] = await Promise.all([
      // Exactly the direct assignments the permission engine honours right now.
      pool.query<RoleSeatHolder & { roleKey: string }>(
        `SELECT DISTINCT r.role_key AS "roleKey", a.id AS "accountId", a.employee_id AS "employeeId",
                coalesce(e.full_name, a.email) AS name
           FROM account_role_assignments ara
           JOIN roles r ON r.id = ara.role_id
           JOIN accounts a ON a.id = ara.account_id
           JOIN employees e ON e.id = a.employee_id
          WHERE r.role_key = ANY($1::text[])
            AND a.principal_type = 'EMPLOYEE' AND a.status = 'active' AND e.status = 'active'
            AND ara.scope_type = 'organization' AND ara.organizational_unit_id IS NULL
            AND (ara.starts_on IS NULL OR ara.starts_on <= current_date)
            AND (ara.ends_on IS NULL OR ara.ends_on >= current_date)
          ORDER BY name`,
        [roleKeys],
      ),
      pool.query<SeatHolderRow & { roleKey: string }>(
        `SELECT h.role_key AS "roleKey", h.position_key AS "positionKey", h.employee_id AS "employeeId",
                e.full_name AS name, h.incumbency_kind AS kind, h.account_id AS "accountId",
                h.account_status AS "accountStatus", h.employee_active AS "employeeActive"
           FROM hcis_seat_role_holders(current_date) h
           JOIN employees e ON e.id = h.employee_id
          WHERE h.role_key = ANY($1::text[])`,
        [roleKeys],
      ),
      new PostgresOrganizationRepository(pool).loadEffectiveSnapshot(asOf),
    ]);
    return roleKeys.map((roleKey) => {
      const roleLinks = links.rows.filter((row) => row.roleKey === roleKey);
      return computeRoleSeatCheck({
        roleKey,
        roleName: roleLinks[0]!.roleName,
        asOf,
        links: roleLinks.map((row) => ({ positionKey: row.positionKey, reason: row.reason, setAt: row.setAt.toISOString() })),
        snapshot,
        holders: holders.rows.filter((row) => row.roleKey === roleKey)
          .map(({ accountId, employeeId, name }) => ({ accountId, employeeId, name })),
        seatHolders: seatHolders.rows.filter((row) => row.roleKey === roleKey),
      });
    });
  }

  app.get("/admin/access/role-seat-checks", async (request, reply) => {
    const principal = await authenticateAdmin(request, reply, "access.manage");
    if (!principal) return;
    const [items, linkableRoles] = await Promise.all([loadRoleSeatChecks(), loadSeatLinkableRoles()]);
    reply.header("Cache-Control", "no-store");
    return reply.send({ asOf: jakartaBusinessDate(), items, linkableRoles });
  });

  async function auditSeatLink(
    client: PoolClient, principal: AuthPrincipal, action: string,
    payload: { roleKey: string; positionKey: string; reason: string },
  ) {
    // Linking a seat grants the role to whoever sits there, so it is recorded like a grant: the
    // channel it came through (AUTH-014 §2.7 actor_source) and the reason.
    await client.query(
      `INSERT INTO access_audit_events (id, actor_account_id, action, entity_type, entity_id, payload, actor_source)
       VALUES ($1, $2, $3, 'role', NULL, $4::jsonb, 'hcis_break_glass')`,
      [randomUUID(), principal.id, action, JSON.stringify(payload)],
    );
  }

  const seatLinkBodySchema = z.object({
    roleKey: z.string().trim().min(1).max(100),
    positionKey: z.string().uuid(),
    reason: z.string().trim().min(1).max(500),
  });

  // AUTH-015 G-3: linking a role to a seat grants the role to whoever holds that seat, now and
  // later, so it is held to the role-granting rule (break-glass in HCIS; the SQ Hub channel is TBD).
  app.post("/admin/access/role-seat-links", async (request, reply) => {
    const principal = await authenticateRoleGrantor(request, reply);
    if (!principal) return;
    reply.header("Cache-Control", "no-store");

    const body = seatLinkBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ code: "INVALID_ROLE_SEAT_LINK", message: "Peran, jabatan, atau alasannya tidak valid." });
    }
    const { roleKey, positionKey, reason } = body.data;
    if (!(await loadSeatLinkableRoles()).some((role) => role.roleKey === roleKey)) {
      return reply.status(400).send({
        code: "ROLE_NOT_SEAT_LINKABLE",
        message: "Peran ini tidak dapat mengikuti jabatan (peran pengelola akses, peran khusus unit, atau peran Organ Yayasan).",
      });
    }
    // Only a seat that has been published can be followed; a draft-only position may never exist.
    if (!(await new PostgresOrganizationRepository(pool).isStableKeyPublished("position", positionKey))) {
      return reply.status(404).send({
        code: "ORGANIZATION_POSITION_NOT_PUBLISHED",
        message: "Jabatan itu belum pernah ada di struktur yang diterbitkan.",
      });
    }

    const client = await pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `INSERT INTO access_role_position_links (role_key, position_key, reason, set_by_account_id, set_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (role_key, position_key) DO NOTHING`,
        [roleKey, positionKey, reason, principal.id],
      );
      if (inserted.rowCount === 0) {
        await client.query("ROLLBACK");
        committed = true;
        return reply.status(409).send({ code: "ROLE_SEAT_LINK_EXISTS", message: "Peran ini sudah mengikuti jabatan tersebut." });
      }
      await auditSeatLink(client, principal, "role.seat_link.set", { roleKey, positionKey, reason });
      await client.query("COMMIT");
      committed = true;
    } finally {
      try { if (!committed) await client.query("ROLLBACK"); } finally { client.release(); }
    }
    const [check] = await loadRoleSeatChecks(roleKey);
    return reply.status(201).send({ roleKey, check: check ?? null });
  });

  app.delete("/admin/access/role-seat-links/:roleKey/:positionKey", async (request, reply) => {
    const principal = await authenticateRoleGrantor(request, reply);
    if (!principal) return;
    reply.header("Cache-Control", "no-store");

    const params = z.object({ roleKey: z.string().trim().min(1).max(100), positionKey: z.string().uuid() })
      .safeParse(request.params);
    const body = z.object({ reason: z.string().trim().min(1).max(500) }).safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ code: "INVALID_ROLE_SEAT_LINK", message: "Peran, jabatan, atau alasannya tidak valid." });
    }
    const { roleKey, positionKey } = params.data;

    const client = await pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      const removed = await client.query(
        "DELETE FROM access_role_position_links WHERE role_key = $1 AND position_key = $2",
        [roleKey, positionKey],
      );
      if (removed.rowCount === 0) {
        await client.query("ROLLBACK");
        committed = true;
        return reply.status(404).send({ code: "ROLE_SEAT_LINK_NOT_FOUND", message: "Peran ini tidak mengikuti jabatan tersebut." });
      }
      await auditSeatLink(client, principal, "role.seat_link.cleared", { roleKey, positionKey, reason: body.data.reason });
      await client.query("COMMIT");
      committed = true;
    } finally {
      try { if (!committed) await client.query("ROLLBACK"); } finally { client.release(); }
    }
    const [check] = await loadRoleSeatChecks(roleKey);
    return reply.send({ roleKey, check: check ?? null });
  });
}
