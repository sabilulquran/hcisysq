import type { AdminPermission } from "../auth/permissions.js";
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import {
  annualLeaveSemesterQuotaEffectiveFrom,
  type ApiConfig,
} from "../../config/env.js";
import { OUTSIDE_HCIS_CODE, OUTSIDE_HCIS_MESSAGE } from "../employees/management-scope.js";
import { requirePermissionsFromCookie } from "../auth/authorization.js";
import {
  AuthError,
  AuthService,
  type AuthPrincipal,
} from "../auth/service.js";
import {
  ANNUAL_LEAVE_ENTITLEMENT_DAYS,
  ANNUAL_LEAVE_QUARTER_LIMIT_DAYS,
  ANNUAL_LEAVE_SEMESTER_LIMIT_DAYS,
  annualLeavePeriodLimitDays,
  annualLeaveQuotaScheme,
  calculateAnnualLeaveYearView,
  type LeaveEntitlementGroup,
} from "./domain/annual-leave-policy.js";
import {
  LeaveApprovalConfigurationError,
  resolveLeaveLineApprovalChain,
} from "./domain/approval-chain.js";
import { LEAVE_POLICY_CATALOG } from "./domain/policy-catalog.js";
import { addEvent, enqueueNotification } from "./employee-routes.js";
import { notifyApprovalRequested } from "./approver-notifications.js";
import { jakartaBusinessDate } from "../organization/jakarta-date.js";
import { PostgresOrganizationRepository } from "../organization/index.js";
import { leaveWorkflowKey } from "../organization/workflow-keys.js";
import { isoCalendarDate } from "./iso-date.js";

const unitIdSchema = z.object({ unitId: z.string().uuid() });
const employeeIdSchema = z.object({ employeeId: z.string().uuid() });
const approverSchema = z.object({ employeeId: z.string().uuid().nullable() });
const entitlementGroupSchema = z.object({
  group: z.enum(["education", "non_education"]).nullable(),
});
const previewQuerySchema = z.object({
  date: isoCalendarDate.optional(),
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

  /** LEAVE-003 R2: `null` until the owner sets a date, which keeps the quarter rule in force. */
  const semesterEffectiveFrom = annualLeaveSemesterQuotaEffectiveFrom(config);

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

    // EMP-005 S2B §8.7: a record outside HCIS management is not part of the leave population and is
    // never a working approver, so a marked unit approver or line manager reads as not configured —
    // which is what routing will do with it (APPROVER_NOT_ACTIVE).
    const [units, employees] = await Promise.all([
      pool.query<LeaveUnitRow>(
        `
          SELECT
            u.id,
            u.name,
            count(e.id) FILTER (WHERE e.status = 'active' AND e.management_scope = 'MANAGED')::int AS "activeEmployeeCount",
            CASE WHEN approver.management_scope = 'MANAGED' THEN u.leave_approver_employee_id END AS "approverEmployeeId",
            CASE WHEN approver.management_scope = 'MANAGED' THEN approver.full_name END AS "approverName"
          FROM organizational_units u
          LEFT JOIN employees e ON e.organizational_unit_id = u.id
          LEFT JOIN employees approver ON approver.id = u.leave_approver_employee_id
          GROUP BY u.id, u.name, u.leave_approver_employee_id, approver.full_name, approver.management_scope
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
            CASE WHEN manager.management_scope = 'MANAGED' THEN e.direct_manager_employee_id END AS "directManagerEmployeeId",
            CASE WHEN manager.management_scope = 'MANAGED' THEN manager.full_name END AS "directManagerName",
            e.leave_entitlement_group AS "leaveEntitlementGroup"
          FROM employees e
          LEFT JOIN organizational_units u ON u.id = e.organizational_unit_id
          LEFT JOIN positions p ON p.id = e.position_id
          LEFT JOIN employees manager ON manager.id = e.direct_manager_employee_id
          WHERE e.status = 'active' AND e.management_scope = 'MANAGED'
          ORDER BY e.full_name ASC
        `,
      ),
    ]);

    /**
     * ORG-004 (D-R6, 2026-11-24): pegawai yang Cuti Tahunannya sudah dirutekan lewat bagan.
     *
     * Sebelum ini layar menghitung kolom atasan lama untuk setiap pegawai aktif tanpa kecuali,
     * sehingga unit yang sudah pindah ke bagan tetap terbaca "belum siap" — padahal rute berbasis
     * bagan tidak membaca kolom itu sama sekali, dan mengisinya hanya menambah sumber kedua untuk
     * hubungan yang sama. Angka kesiapan kini memakai sumber yang benar-benar dibaca runtime untuk
     * tiap orang: bagan bila modenya `STRUCTURE`, kolom lama bila `LEGACY`.
     *
     * Dihitung untuk **Cuti Tahunan** saja, karena mode rollout disimpan per kunci workflow dan
     * itulah kunci yang layar ini urus. Orang yang sama bisa `STRUCTURE` untuk cuti tahunan dan
     * `LEGACY` untuk lembur atau perjalanan dinas, jadi layar menyebut alurnya, bukan menyimpulkan
     * bahwa kolom atasannya tidak diperlukan sama sekali.
     */
    const modes = await new PostgresOrganizationRepository(pool).resolveRolloutModes(
      leaveWorkflowKey("annual"),
      employees.rows.map((employee) => employee.id),
      jakartaBusinessDate(),
    );
    const employeeRows = employees.rows.map((employee) => ({
      ...employee,
      /** `STRUCTURE` berarti penyetujunya datang dari bagan, bukan dari kolom di baris ini. */
      approvalSource: modes.get(employee.id) ?? "LEGACY",
    }));

    const unitApproverConfigured = units.rows.filter(
      (unit) => unit.approverEmployeeId !== null,
    ).length;
    const entitlementGroupConfigured = employees.rows.filter(
      (employee) => employee.leaveEntitlementGroup !== null,
    ).length;
    const structureRouted = employeeRows.filter(
      (employee) => employee.approvalSource === "STRUCTURE",
    ).length;
    const directManagerConfigured = employeeRows.filter(
      (employee) => employee.approvalSource === "STRUCTURE" || employee.directManagerEmployeeId !== null,
    ).length;

    /**
     * LEAVE-003 R2: which Cuti Tahunan quota rule is in force today, and the day the semester rule
     * starts. HC reads the rule from this screen instead of from a figure written into the page, so
     * the screen cannot drift away from what submission actually enforces.
     */
    const today = jakartaBusinessDate();
    const annualQuota = {
      entitlementDays: ANNUAL_LEAVE_ENTITLEMENT_DAYS,
      quarterLimitDays: ANNUAL_LEAVE_QUARTER_LIMIT_DAYS,
      semesterLimitDays: ANNUAL_LEAVE_SEMESTER_LIMIT_DAYS,
      semesterEffectiveFrom,
      scheme: annualLeaveQuotaScheme(today, semesterEffectiveFrom),
      periodLimitDays: annualLeavePeriodLimitDays(
        annualLeaveQuotaScheme(today, semesterEffectiveFrom),
      ),
    };

    reply.header("Cache-Control", "no-store");
    return reply.send({
      policies: LEAVE_POLICY_CATALOG,
      annualQuota,
      units: units.rows,
      employees: employeeRows,
      summary: {
        activeUnits: units.rows.filter((unit) => unit.activeEmployeeCount > 0).length,
        unitApproverConfigured,
        activeEmployees: employees.rows.length,
        directManagerConfigured,
        /** Bagian dari `directManagerConfigured` yang terpenuhi oleh bagan, bukan oleh kolom lama. */
        structureRouted,
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
        // EMP-005 S2B §8.7: a record outside HCIS management is never configured as an approver.
        "SELECT id FROM employees WHERE id = $1 AND status = 'active' AND management_scope = 'MANAGED'",
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

      const employee = await pool.query<{ id: string; outside: boolean }>(
        `SELECT id, management_scope = 'OUTSIDE_HCIS' AS outside FROM employees WHERE id = $1`,
        [params.data.employeeId],
      );
      if (!employee.rows[0]) {
        return reply.status(404).send({
          code: "EMPLOYEE_NOT_FOUND",
          message: "Pegawai tidak ditemukan.",
        });
      }
      // EMP-005 S2B §8.7: this writes the employee master, so a record outside
      // HCIS management is read-only here as much as on the HC routes.
      if (employee.rows[0].outside) {
        reply.header("Cache-Control", "no-store");
        return reply.status(409).send({ code: OUTSIDE_HCIS_CODE, message: OUTSIDE_HCIS_MESSAGE });
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
          semesterEffectiveFrom,
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

  /**
   * APR-001 "Reassignment" (2026-11-24): memindahkan satu langkah persetujuan yang tersangkut.
   *
   * Spesifikasi sudah memintanya sejak awal — "If an approver already stored in the snapshot can
   * no longer act, an authorized administrator may reassign the specific step" — tetapi cuti tidak
   * pernah punya jalurnya. Akibatnya nyata: begitu akun kepala unit ditangguhkan atau orangnya
   * berhenti, setiap pengajuan yang sudah ada di mejanya berhenti selamanya. Pemohon memang masih
   * dapat membatalkan, tetapi itu membuang persetujuan langkah pertama yang sudah diberikan dan
   * memaksanya mengajukan ulang; dan pada rilis yang berjalan tidak ada lagi jalan lain selain
   * menyunting basis data.
   *
   * Tiga batas yang dijaga di sini, sesuai APR-001:
   * - **Hanya langkah yang sedang aktif.** Langkah yang sudah diputuskan adalah sejarah.
   * - **Rantainya tidak dihitung ulang.** Hanya satu langkah yang berpindah; `sources` dan urutan
   *   langkah tidak disentuh, sehingga snapshot tetap snapshot.
   * - **Penggantinya harus benar-benar dapat memutuskan**, dan tidak boleh pemohon sendiri.
   */
  app.post("/admin/leave/approvals/:stepId/reassign", async (request, reply) => {
    const principal = await authenticateAdmin(request, reply, "approvals.policy.manage");
    if (!principal) return;
    const params = z.object({ stepId: z.string().uuid() }).safeParse(request.params);
    const body = z.object({
      newApproverEmployeeId: z.string().uuid(),
      reason: z.string().trim().min(5).max(500),
    }).strict().safeParse(request.body);
    reply.header("Cache-Control", "no-store");
    if (!params.success || !body.success) {
      return reply.status(400).send({
        code: "INVALID_APPROVAL_REASSIGNMENT",
        message: "Langkah persetujuan dan alasan pengalihan wajib diisi (alasan minimal 5 karakter).",
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const step = await client.query<{
        id: string; requestId: string; status: string; stepOrder: number;
        approverEmployeeId: string | null; approverAccountId: string | null;
        requesterEmployeeId: string; requestStatus: string;
      }>(
        `SELECT s.id, s.leave_request_id AS "requestId", s.status, s.step_order AS "stepOrder",
                s.approver_employee_id AS "approverEmployeeId",
                s.approver_account_id AS "approverAccountId",
                r.employee_id AS "requesterEmployeeId", r.status AS "requestStatus"
           FROM leave_request_approval_steps s
           JOIN leave_requests r ON r.id = s.leave_request_id
          WHERE s.id = $1
          FOR UPDATE OF s`,
        [params.data.stepId],
      );
      const current = step.rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return reply.status(404).send({
          code: "APPROVAL_STEP_NOT_FOUND",
          message: "Tahap approval tidak ditemukan.",
        });
      }
      if (current.status !== "pending" || current.requestStatus !== "in_review") {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "APPROVAL_STEP_NOT_PENDING",
          message: "Hanya tahap approval yang sedang menunggu keputusan yang dapat dialihkan.",
        });
      }
      /**
       * ORG-013: langkah yang dipegang **akun** Organ Yayasan tidak dapat dialihkan ke pegawai.
       *
       * Langkah semacam itu lahir dari binding `GOVERNANCE_APPROVER`, dan keputusannya melewati
       * `assertGovernanceApprovalCapability` — gerbang yang hanya ada pada cabang principal akun.
       * Memindahkannya ke `approver_employee_id` akan membuat keputusan berikutnya mengambil
       * cabang pegawai biasa, sehingga kapabilitas governance tidak pernah diperiksa, sementara
       * `sources` tetap menuliskan `GOVERNANCE_APPROVER`. Itu menurunkan wewenang tanpa jejak.
       * Kursi organ yang tersangkut diselesaikan di bagannya, bukan dengan memindah langkahnya.
       */
      if (current.approverAccountId !== null) {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "APPROVAL_STEP_ACCOUNT_HELD",
          message: "Tahap ini dipegang akun Pengurus Yayasan dan tidak dapat dialihkan ke pegawai. "
            + "Selesaikan lewat Portal Organ atau perbaiki kursinya di bagan organisasi.",
        });
      }
      if (current.approverEmployeeId === body.data.newApproverEmployeeId) {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "APPROVAL_REASSIGNMENT_UNCHANGED",
          message: "Tahap ini sudah menjadi milik pegawai tersebut.",
        });
      }
      if (current.requesterEmployeeId === body.data.newApproverEmployeeId) {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "APPROVAL_REASSIGNMENT_SELF",
          message: "Pemohon tidak dapat menjadi penyetuju pengajuannya sendiri.",
        });
      }
      // Penggantinya harus memenuhi syarat yang sama dengan penyetuju mana pun: pegawai aktif yang
      // dikelola HCIS, dan akunnya sudah aktif. Tanpa ini pengalihan hanya memindahkan kemacetan.
      const replacement = await client.query<{ fullName: string; accountStatus: string | null }>(
        `SELECT e.full_name AS "fullName",
                (SELECT a.status FROM accounts a
                  WHERE a.employee_id = e.id AND a.principal_type = 'EMPLOYEE'
                  ORDER BY a.id LIMIT 1) AS "accountStatus"
           FROM employees e
          WHERE e.id = $1 AND e.status = 'active' AND e.removed_at IS NULL
            AND e.management_scope = 'MANAGED'`,
        [body.data.newApproverEmployeeId],
      );
      const candidate = replacement.rows[0];
      if (!candidate) {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "APPROVER_NOT_ACTIVE",
          message: "Penyetuju pengganti harus pegawai aktif yang dikelola HCIS.",
        });
      }
      if (candidate.accountStatus !== "active") {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "APPROVER_ACCOUNT_NOT_READY",
          message: `Akun ${candidate.fullName} belum aktif, sehingga ia belum dapat memutuskan `
            + "pengajuan. Selesaikan aktivasi akunnya lebih dulu.",
        });
      }

      // `approver_account_id` sudah dipastikan NULL di atas; tidak ditulis ulang di sini supaya
      // baris ini tidak pernah menjadi cara mengubah langkah akun menjadi langkah pegawai.
      await client.query(
        `UPDATE leave_request_approval_steps SET approver_employee_id = $2 WHERE id = $1`,
        [current.id, body.data.newApproverEmployeeId],
      );
      // Jejaknya ditulis dua kali dengan sengaja: pada riwayat pengajuan, yang dibaca pemohon dan
      // HC, dan pada audit akses, yang dibaca pemeriksa.
      await addEvent(client, current.requestId, principal.id, "leave.approval.reassigned", {
        stepId: current.id,
        stepOrder: current.stepOrder,
        previousApproverEmployeeId: current.approverEmployeeId,
        previousApproverAccountId: current.approverAccountId,
        newApproverEmployeeId: body.data.newApproverEmployeeId,
        reason: body.data.reason,
      });
      await notifyApprovalRequested(client, {
        requestId: current.requestId,
        stepId: current.id,
        approverEmployeeId: body.data.newApproverEmployeeId,
        approverAccountId: null,
      });
      // Setiap pengaktifan langkah lain menulis dua hal: notifikasi dalam aplikasi dan intent di
      // outbox. Pengalihan adalah pengaktifan langkah bagi penyetuju baru, jadi ia menulis keduanya;
      // tanpa intent itu, jalur pengiriman di luar aplikasi melewatkan satu-satunya langkah yang
      // berpindah tangan.
      await enqueueNotification(
        client, current.requestId, "leave.approval.requested", "employee", body.data.newApproverEmployeeId,
      );
      await client.query("COMMIT");
      await audit(pool, principal, "leave.approval.reassigned", "leave_request_approval_step", current.id, {
        leaveRequestId: current.requestId,
        stepOrder: current.stepOrder,
        previousApproverEmployeeId: current.approverEmployeeId,
        previousApproverAccountId: current.approverAccountId,
        newApproverEmployeeId: body.data.newApproverEmployeeId,
        reason: body.data.reason,
      });
      return reply.send({
        stepId: current.id,
        requestId: current.requestId,
        approverEmployeeId: body.data.newApproverEmployeeId,
        approverName: candidate.fullName,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}
