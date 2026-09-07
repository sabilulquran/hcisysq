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
  calculateAnnualLeaveYearView,
  type LeaveEntitlementGroup,
} from "./domain/annual-leave-policy.js";
import {
  LeaveApprovalConfigurationError,
  resolveLeaveLineApprovalChain,
} from "./domain/approval-chain.js";
import { LEAVE_POLICY_CATALOG } from "./domain/policy-catalog.js";

const unitIdSchema = z.object({ unitId: z.string().uuid() });
const employeeIdSchema = z.object({ employeeId: z.string().uuid() });
const approverSchema = z.object({ employeeId: z.string().uuid().nullable() });
const entitlementGroupSchema = z.object({
  group: z.enum(["education", "non_education"]).nullable(),
});
const previewQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

interface LeaveUnitRow {
  id: string;
  name: string;
  activeEmployeeCount: number;
  approverEmployeeId: string | null;
  approverName: string | null;
}

interface LeaveEmployeeRow {
  id: string;
  fullName: string;
  employeeNumber: string;
  status: "active" | "inactive" | "resigned";
  unitId: string | null;
  unitName: string | null;
  positionName: string | null;
  directManagerEmployeeId: string | null;
  directManagerName: string | null;
  leaveEntitlementGroup: LeaveEntitlementGroup | null;
}

interface LeavePreviewRow extends LeaveEmployeeRow {
  startedOn: string | null;
  unitApproverEmployeeId: string | null;
  unitApproverName: string | null;
}

async function audit(
  pool: Pool,
  principal: AuthPrincipal,
  action: string,
  entityType: string,
  entityId: string | null,
  payload: Record<string, unknown>,
) {
  await pool.query(
    `INSERT INTO access_audit_events (
      id, actor_account_id, action, entity_type, entity_id, payload
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [randomUUID(), principal.id, action, entityType, entityId, JSON.stringify(payload)],
  );
}

function jakartaToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export async function registerLeaveAdminRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
) {
  if (!config.AUTH_ENCRYPTION_KEY) {
    throw new Error("AUTH_ENCRYPTION_KEY is required for leave admin routes");
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

  app.get("/admin/leave/configuration", async (request, reply) => {
    const principal = await authenticateAdmin(request, reply, "leave.configuration.manage");
    if (!principal) return;

    const [units, employees] = await Promise.all([
      pool.query<LeaveUnitRow>(
        `
          SELECT
            u.id,
            u.name,
            count(e.id) FILTER (WHERE e.status = 'active')::int AS "activeEmployeeCount",
            u.leave_approver_employee_id AS "approverEmployeeId",
            approver.full_name AS "approverName"
          FROM organizational_units u
          LEFT JOIN employees e ON e.organizational_unit_id = u.id
          LEFT JOIN employees approver ON approver.id = u.leave_approver_employee_id
          GROUP BY u.id, u.name, u.leave_approver_employee_id, approver.full_name
          ORDER BY u.name ASC
        `,
      ),
      pool.query<LeaveEmployeeRow>(
        `
          SELECT
            e.id,
            e.full_name AS "fullName",
            e.employee_number AS "employeeNumber",
            e.status,
            u.id AS "unitId",
            u.name AS "unitName",
            p.name AS "positionName",
            e.direct_manager_employee_id AS "directManagerEmployeeId",
            manager.full_name AS "directManagerName",
            e.leave_entitlement_group AS "leaveEntitlementGroup"
          FROM employees e
          LEFT JOIN organizational_units u ON u.id = e.organizational_unit_id
          LEFT JOIN positions p ON p.id = e.position_id
          LEFT JOIN employees manager ON manager.id = e.direct_manager_employee_id
          WHERE e.status = 'active'
          ORDER BY e.full_name ASC
        `,
      ),
    ]);

    const unitApproverConfigured = units.rows.filter(
      (unit) => unit.approverEmployeeId !== null,
    ).length;
    const entitlementGroupConfigured = employees.rows.filter(
      (employee) => employee.leaveEntitlementGroup !== null,
    ).length;
    const directManagerConfigured = employees.rows.filter(
      (employee) => employee.directManagerEmployeeId !== null,
    ).length;

    reply.header("Cache-Control", "no-store");
    return reply.send({
      policies: LEAVE_POLICY_CATALOG,
      units: units.rows,
      employees: employees.rows,
      summary: {
        activeUnits: units.rows.filter((unit) => unit.activeEmployeeCount > 0).length,
        unitApproverConfigured,
        activeEmployees: employees.rows.length,
        directManagerConfigured,
        entitlementGroupConfigured,
      },
    });
  });

  app.patch("/admin/leave/units/:unitId/approver", async (request, reply) => {
    const principal = await authenticateAdmin(request, reply, "approvals.policy.manage");
    if (!principal) return;

    const params = unitIdSchema.safeParse(request.params);
    const body = approverSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({
        code: "INVALID_UNIT_APPROVER",
        message: "Konfigurasi approver unit tidak valid.",
      });
    }

    const unit = await pool.query<{ id: string }>(
      "SELECT id FROM organizational_units WHERE id = $1",
      [params.data.unitId],
    );
    if (!unit.rows[0]) {
      return reply.status(404).send({
        code: "UNIT_NOT_FOUND",
        message: "Unit organisasi tidak ditemukan.",
      });
    }

    if (body.data.employeeId) {
      const approver = await pool.query<{ id: string }>(
        "SELECT id FROM employees WHERE id = $1 AND status = 'active'",
        [body.data.employeeId],
      );
      if (!approver.rows[0]) {
        return reply.status(409).send({
          code: "UNIT_APPROVER_NOT_ACTIVE",
          message: "Approver unit harus merupakan pegawai aktif.",
        });
      }
    }

    await pool.query(
      `UPDATE organizational_units
       SET leave_approver_employee_id = $2, updated_at = now()
       WHERE id = $1`,
      [params.data.unitId, body.data.employeeId],
    );
    await audit(
      pool,
      principal,
      "leave.unit_approver.changed",
      "organizational_unit",
      params.data.unitId,
      { approverEmployeeId: body.data.employeeId },
    );

    return reply.send({
      unitId: params.data.unitId,
      approverEmployeeId: body.data.employeeId,
    });
  });

  app.patch(
    "/admin/leave/employees/:employeeId/entitlement-group",
    async (request, reply) => {
      const principal = await authenticateAdmin(request, reply, "leave.configuration.manage");
      if (!principal) return;

      const params = employeeIdSchema.safeParse(request.params);
      const body = entitlementGroupSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.status(400).send({
          code: "INVALID_LEAVE_ENTITLEMENT_GROUP",
          message: "Kelompok hak cuti tidak valid.",
        });
      }

      const employee = await pool.query<{ id: string }>(
        "SELECT id FROM employees WHERE id = $1",
        [params.data.employeeId],
      );
      if (!employee.rows[0]) {
        return reply.status(404).send({
          code: "EMPLOYEE_NOT_FOUND",
          message: "Pegawai tidak ditemukan.",
        });
      }

      await pool.query(
        `UPDATE employees
         SET leave_entitlement_group = $2, updated_at = now()
         WHERE id = $1`,
        [params.data.employeeId, body.data.group],
      );
      await audit(
        pool,
        principal,
        "leave.entitlement_group.changed",
        "employee",
        params.data.employeeId,
        { group: body.data.group },
      );

      return reply.send({
        employeeId: params.data.employeeId,
        leaveEntitlementGroup: body.data.group,
      });
    },
  );

  app.get("/admin/leave/employees/:employeeId/preview", async (request, reply) => {
    const principal = await authenticateAdmin(request, reply, "leave.configuration.manage");
    if (!principal) return;

    const params = employeeIdSchema.safeParse(request.params);
    const query = previewQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.status(400).send({
        code: "INVALID_LEAVE_PREVIEW",
        message: "Parameter preview cuti tidak valid.",
      });
    }

    const result = await pool.query<LeavePreviewRow>(
      `
        SELECT
          e.id,
          e.full_name AS "fullName",
          e.employee_number AS "employeeNumber",
          e.status,
          e.started_on::text AS "startedOn",
          u.id AS "unitId",
          u.name AS "unitName",
          p.name AS "positionName",
          e.direct_manager_employee_id AS "directManagerEmployeeId",
          manager.full_name AS "directManagerName",
          e.leave_entitlement_group AS "leaveEntitlementGroup",
          u.leave_approver_employee_id AS "unitApproverEmployeeId",
          unit_approver.full_name AS "unitApproverName"
        FROM employees e
        LEFT JOIN organizational_units u ON u.id = e.organizational_unit_id
        LEFT JOIN positions p ON p.id = e.position_id
        LEFT JOIN employees manager ON manager.id = e.direct_manager_employee_id
        LEFT JOIN employees unit_approver ON unit_approver.id = u.leave_approver_employee_id
        WHERE e.id = $1
        LIMIT 1
      `,
      [params.data.employeeId],
    );

    const employee = result.rows[0];
    if (!employee) {
      return reply.status(404).send({
        code: "EMPLOYEE_NOT_FOUND",
        message: "Pegawai tidak ditemukan.",
      });
    }

    const warnings: Array<{ code: string; message: string }> = [];
    let approvalChain: ReturnType<typeof resolveLeaveLineApprovalChain> = [];
    try {
      approvalChain = resolveLeaveLineApprovalChain({
        requesterEmployeeId: employee.id,
        directManagerEmployeeId: employee.directManagerEmployeeId,
        unitApproverEmployeeId: employee.unitApproverEmployeeId,
      });
    } catch (error) {
      if (error instanceof LeaveApprovalConfigurationError) {
        warnings.push({ code: error.code, message: error.message });
      } else {
        throw error;
      }
    }

    const referenceDate = query.data.date ?? jakartaToday();
    const annualLeave = employee.startedOn
      ? calculateAnnualLeaveYearView({
          employmentStartedOn: employee.startedOn,
          referenceDate,
        })
      : null;

    if (!employee.leaveEntitlementGroup) {
      warnings.push({
        code: "ENTITLEMENT_GROUP_MISSING",
        message: "Kelompok hak cuti tenaga pendidikan/non-pendidikan belum dikonfigurasi.",
      });
    }

    reply.header("Cache-Control", "no-store");
    return reply.send({
      employee,
      referenceDate,
      approvalChain,
      annualLeave,
      warnings,
    });
  });
}
