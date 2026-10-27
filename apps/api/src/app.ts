import Fastify from "fastify";
import type { Pool } from "pg";

import type { ApiConfig } from "./config/env.js";
import { createPool } from "./db/pool.js";
import { registerAdmsAdminRoutes } from "./modules/attendance/adms/admin-routes.js";
import { registerAdmsBiometricControlPlaneRoutes } from "./modules/attendance/adms/biometric-control-plane-routes.js";
import { registerAdmsPhysicalParityDeviceRoutes } from "./modules/attendance/adms/physical-parity-device-routes.js";
import { registerAdmsPhysicalParityExtendedRoutes } from "./modules/attendance/adms/physical-parity-extended-routes.js";
import { registerAdmsPhysicalParityObservabilityRoutes } from "./modules/attendance/adms/physical-parity-observability-routes.js";
import { registerAdmsPhysicalParityRegistryUserRoutes } from "./modules/attendance/adms/physical-parity-registry-user-routes.js";
import { registerAdmsPhysicalParityRoutes } from "./modules/attendance/adms/physical-parity-routes.js";
import { registerAdmsIngressRoutes } from "./modules/attendance/adms/routes.js";
import { registerAdmsManagementRoutes } from "./modules/attendance/adms/management-routes.js";
import { registerAdmsWave1AdminRoutes } from "./modules/attendance/adms/wave1-admin-routes.js";
import { registerAdmsWave1OpsRoutes } from "./modules/attendance/adms/wave1-ops-routes.js";
import { registerAdmsWave1RecoveryRoutes } from "./modules/attendance/adms/wave1-recovery-routes.js";
import { registerAdmsWave2AdminRoutes } from "./modules/attendance/adms/wave2-admin-routes.js";
import { registerAdmsWave2MappingAssistantRoutes } from "./modules/attendance/adms/wave2-mapping-assistant-routes.js";
import { registerAdmsWave2UserCorrectionRoutes } from "./modules/attendance/adms/wave2-user-correction-routes.js";
import { registerAdmsWave3AdminRoutes } from "./modules/attendance/adms/wave3-admin-routes.js";
import { registerAttendanceRoutes } from "./modules/attendance/routes.js";
import { registerAttendanceShiftSwapRoutes } from "./modules/attendance/shift-swap-routes.js";
import { registerAttendanceWorkforceRoutes } from "./modules/attendance/workforce-routes.js";
import { registerAccountActivationAdminRoutes } from "./modules/auth/admin-account-activation-routes.js";
import { registerAccountActivationRoutes } from "./modules/auth/activation-routes.js";
import { isCrossSiteMutation, publicOrigin } from "./modules/auth/csrf.js";
import { registerAuthRoutes } from "./modules/auth/routes.js";
import { registerBoardDashboardRoutes } from "./modules/board/dashboard-routes.js";
import { registerEmployeeContactAdminRoutes } from "./modules/employees/admin-employee-contact-routes.js";
import { registerStaffIdentityRoutes } from "./modules/employees/staff-identity-routes.js";
import { registerGovernanceSummaryRoutes } from "./modules/governance/routes.js";
import { registerEmployeeAdminRoutes } from "./modules/employees/admin-routes.js";
import { registerTemporaryReactivationRoutes } from "./modules/auth/temporary-reactivation-routes.js";
import { registerEmploymentActionRoutes } from "./modules/employment/action-routes.js";
import { registerDecisionDocumentRoutes } from "./modules/employment/decision-document-routes.js";
import { registerEmploymentAdminRoutes } from "./modules/employment/admin-routes.js";
import { registerOrgAccessAdminRoutes } from "./modules/employees/admin-org-access-routes.js";
import { registerLeaveAdminRoutes } from "./modules/leave/admin-routes.js";
import { registerAttendanceResolutionRoutes } from "./modules/leave/attendance-resolution-routes.js";
import { registerLeaveCalendarAdminRoutes } from "./modules/leave/calendar-admin-routes.js";
import { registerEmployeeLeaveRoutes } from "./modules/leave/employee-routes.js";
import { registerPlannedEvidenceRoutes } from "./modules/leave/planned-evidence-routes.js";
import { registerPlannedLeaveRoutes } from "./modules/leave/planned-leave-routes.js";
import { registerSpecialLeaveRoutes } from "./modules/leave/special-leave-routes.js";
import { registerPayrollAdminRoutes } from "./modules/payroll/admin-routes.js";
import { registerPayrollRoutes } from "./modules/payroll/routes.js";
import { registerPayslipRoutes } from "./modules/payslips/routes.js";
import { registerNotificationRoutes } from "./modules/notifications/routes.js";
import { registerOrganizationAdminRoutes } from "./modules/organization/admin-routes.js";
import { registerOrganizationDirectoryRoutes } from "./modules/organization-directory/routes.js";
import { registerSystemRoutes } from "./modules/system/routes.js";

// SEC-09: never write credentials or session material to the log.
const LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers[\"set-cookie\"]",
  "*.password",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.idToken",
  "*.clientSecret",
  "err.detail",
];

// SEC-09: query strings can carry search terms with names; device ingress keeps them for protocol diagnosis.
export function logUrl(url: string) {
  return url.startsWith("/iclock/") ? url : url.split("?")[0]!;
}

const INTERNAL_ERROR_BODY = {
  code: "INTERNAL_ERROR",
  message: "Terjadi kesalahan pada server. Coba lagi beberapa saat.",
};

export function securityHeaders(config: Pick<ApiConfig, "NODE_ENV">): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    // The API serves JSON, files and redirects, never pages: it must not be framed. The page CSP belongs to
    // the SPA static server at the edge (SEC-07 edge part, owner-approved device change).
    "Content-Security-Policy": "frame-ancestors 'none'",
  };
  if (config.NODE_ENV === "production") headers["Strict-Transport-Security"] = "max-age=31536000";
  return headers;
}

export async function createApp(config: ApiConfig, injectedPool?: Pool) {
  const pool = injectedPool ?? createPool(config.DATABASE_URL);
  const app = Fastify({
    logger: config.NODE_ENV !== "test"
      ? {
        redact: { paths: LOG_REDACT_PATHS, censor: "[redacted]" },
        serializers: {
          req: (request) => ({
            method: request.method,
            url: logUrl(request.url),
            host: request.host,
            remoteAddress: request.ip,
            remotePort: request.socket?.remotePort ?? 0,
          }),
        },
      }
      : false,
    trustProxy: true,
  });

  // SEC-07: baseline headers on every API response; a route that sets its own value keeps it.
  app.addHook("onSend", async (_request, reply) => {
    for (const [name, value] of Object.entries(securityHeaders(config))) {
      if (!reply.hasHeader(name)) reply.header(name, value);
    }
  });

  const appOrigin = publicOrigin(config);
  app.addHook("onRequest", async (request, reply) => {
    if (!isCrossSiteMutation(request.method, request.url, request.headers, appOrigin)) return;
    request.log.warn({ method: request.method, url: logUrl(request.url) }, "cross-site mutation rejected");
    return reply.status(403).send({
      code: "CROSS_SITE_REQUEST_REJECTED",
      message: "Permintaan ditolak karena tidak berasal dari aplikasi HCIS.",
    });
  });

  app.addContentTypeParser(
    [
      "application/octet-stream",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/csv",
    ],
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );

  // EMP-005 §8.5: the employment guard is registered before every route, so a
  // plugin context added later cannot escape it.
  await registerTemporaryReactivationRoutes(app, pool, config);
  await registerSystemRoutes(app, pool);
  await registerAdmsPhysicalParityDeviceRoutes(app, pool, config);
  await registerAdmsIngressRoutes(app, pool, config);
  await registerAuthRoutes(app, pool, config);
  await registerAccountActivationRoutes(app, pool);
  await registerAccountActivationAdminRoutes(app, pool, config);
  await registerBoardDashboardRoutes(app, pool, config);
  registerGovernanceSummaryRoutes(app, pool, config);
  await registerEmployeeAdminRoutes(app, pool, config);
  await registerOrgAccessAdminRoutes(app, pool, config);
  await registerOrganizationAdminRoutes(app, pool, config);
  await registerOrganizationDirectoryRoutes(app, pool, config);
  registerStaffIdentityRoutes(app, pool, config);
  await registerEmployeeContactAdminRoutes(app, pool, config);
  await registerEmploymentAdminRoutes(app, pool, config);
  await registerDecisionDocumentRoutes(app, pool, config);
  await registerEmploymentActionRoutes(app, pool, config);
  await registerAttendanceRoutes(app, pool, config);
  await registerAttendanceWorkforceRoutes(app, pool, config);
  await registerAttendanceShiftSwapRoutes(app, pool, config);
  await registerAdmsAdminRoutes(app, pool, config);
  await registerAdmsManagementRoutes(app, pool, config);
  await registerAdmsWave1AdminRoutes(app, pool, config);
  await registerAdmsWave1OpsRoutes(app, pool, config);
  await registerAdmsWave1RecoveryRoutes(app, pool, config);
  await registerAdmsWave2AdminRoutes(app, pool, config);
  await registerAdmsBiometricControlPlaneRoutes(app, pool, config);
  await registerAdmsWave2MappingAssistantRoutes(app, pool, config);
  await registerAdmsWave2UserCorrectionRoutes(app, pool, config);
  await registerAdmsWave3AdminRoutes(app, pool, config);
  await registerAdmsPhysicalParityRoutes(app, pool, config);
  await registerAdmsPhysicalParityExtendedRoutes(app, pool, config);
  await registerAdmsPhysicalParityRegistryUserRoutes(app, pool, config);
  await registerAdmsPhysicalParityObservabilityRoutes(app, pool, config);
  await registerLeaveAdminRoutes(app, pool, config);
  await registerLeaveCalendarAdminRoutes(app, pool, config);
  await registerEmployeeLeaveRoutes(app, pool, config);
  await registerPlannedLeaveRoutes(app, pool, config);
  await registerPlannedEvidenceRoutes(app, pool, config);
  await registerSpecialLeaveRoutes(app, pool, config);
  await registerAttendanceResolutionRoutes(app, pool, config);
  await registerPayrollAdminRoutes(app, pool, config);
  await registerPayrollRoutes(app, pool, config);
  await registerPayslipRoutes(app, pool, config);
  await registerNotificationRoutes(app, pool, config);

  app.setErrorHandler((error, request, reply) => {
    const databaseError = error as Error & { code?: string; constraint?: string };
    if (
      databaseError.code === "23514" &&
      databaseError.message === "active leave request overlaps another active leave request"
    ) {
      return reply.status(409).send({
        code: "LEAVE_REQUEST_OVERLAP",
        message: "Rentang cuti bertabrakan dengan pengajuan aktif lain.",
      });
    }
    if (
      databaseError.code === "23514" &&
      databaseError.message === "ADMS employee mapping overlaps existing mapping"
    ) {
      return reply.status(409).send({
        code: "ADMS_MAPPING_OVERLAP",
        message: "Rentang mapping PIN bertabrakan dengan histori mapping yang sudah ada.",
      });
    }
    if (
      databaseError.code === "23514" &&
      [
        "attendance resolution is already final",
        "attendance resolution is awaiting employee decision",
        "invalid attendance resolution transition",
      ].includes(databaseError.message)
    ) {
      return reply.status(409).send({
        code: "ATTENDANCE_RESOLUTION_STATE_CONFLICT",
        message: "Status penyelesaian kehadiran sudah berubah. Muat ulang sebelum mengambil keputusan.",
      });
    }
    if (
      databaseError.code === "23505" &&
      databaseError.constraint === "leave_request_approval_steps_one_pending_idx"
    ) {
      return reply.status(409).send({
        code: "APPROVAL_STATE_CONFLICT",
        message: "Tahap persetujuan aktif sudah berubah. Muat ulang sebelum mengambil keputusan.",
      });
    }
    if (
      databaseError.code === "23505" &&
      databaseError.constraint === "leave_hajj_one_active_request_idx"
    ) {
      return reply.status(409).send({
        code: "HAJJ_REQUEST_ALREADY_ACTIVE",
        message: "Masih ada pengajuan Cuti Ibadah Haji Wajib yang aktif untuk pegawai ini.",
      });
    }
    if (
      databaseError.code === "23505" &&
      databaseError.constraint === "leave_hajj_final_usage_pkey"
    ) {
      return reply.status(409).send({
        code: "HAJJ_ALREADY_USED",
        message: "Hak Cuti Ibadah Haji Wajib sudah pernah digunakan selama masa kerja.",
      });
    }
    // SEC-10: a 5xx body never carries the internal message; details stay in the log.
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, "unhandled request error");
      return reply.status(statusCode).send(INTERNAL_ERROR_BODY);
    }
    return reply.send(error);
  });

  app.addHook("onClose", async () => {
    if (!injectedPool) await pool.end();
  });

  return app;
}
