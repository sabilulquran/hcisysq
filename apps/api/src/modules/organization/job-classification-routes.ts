// ORG-011 Package 1 routes: the job classification and grade catalogs.
// Spec: docs/domain/job-classification-grade.md §5.
//
// job_classifications.* is HC-only: legacy Super Admin compatibility never grants it, so these
// routes resolve the permission from the organization context directly, like announcements.*.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { pageOffset, pageQuerySchema, pagination } from "../../lib/pagination.js";
import type { JobClassificationPermission } from "../auth/permissions.js";
import { AUTH_COOKIE_NAME, AuthService, readCookie, type AuthPrincipal } from "../auth/service.js";
import {
  JOB_FAMILIES,
  JobClassificationError,
  amendClassification,
  amendGrade,
  classificationOn,
  createClassification,
  createGrade,
  deactivateClassification,
  deactivateGrade,
  gradeOn,
  jakartaDate,
  listClassifications,
  listGrades,
} from "./job-classification-service.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tanggal harus berformat YYYY-MM-DD");

// Codes are permanent (spec §2.6), so the shape is enforced here as well as in the schema:
// a typo accepted today becomes a key stored verbatim in versioned payroll policy.
const gradeCode = z.string().trim().regex(/^[A-Z][A-Z0-9_]{0,31}$/, "Kode golongan harus huruf besar, angka, atau garis bawah.");
const classificationCode = z.string().trim().regex(/^[A-Z][A-Z0-9_]{0,47}$/, "Kode klasifikasi harus huruf besar, angka, atau garis bawah.");

// z.coerce.boolean() is Boolean(string), so "false" would come through as true. The flag is
// read from a query string, so it is parsed from the two words a caller can actually send.
const queryFlag = z.enum(["true", "false"]).default("false").transform((value) => value === "true");

const listQuery = pageQuerySchema.extend({
  onDate: isoDate.optional(),
  includeHistory: queryFlag,
});
const classificationListQuery = listQuery.extend({
  family: z.enum(JOB_FAMILIES).optional(),
});

const createGradeBody = z.object({
  code: gradeCode,
  name: z.string().trim().min(2).max(120),
  rankOrder: z.number().int().min(0).max(9999),
  effectiveFrom: isoDate,
});
const createClassificationBody = z.object({
  code: classificationCode,
  name: z.string().trim().min(2).max(120),
  family: z.enum(JOB_FAMILIES),
  gradeCode: gradeCode.nullable().default(null),
  effectiveFrom: isoDate,
});
const amendGradeBody = z.object({
  effectiveFrom: isoDate,
  name: z.string().trim().min(2).max(120).optional(),
  rankOrder: z.number().int().min(0).max(9999).optional(),
});
const amendClassificationBody = z.object({
  effectiveFrom: isoDate,
  name: z.string().trim().min(2).max(120).optional(),
  family: z.enum(JOB_FAMILIES).optional(),
  gradeCode: gradeCode.nullable().optional(),
});
const deactivateBody = z.object({
  endOn: isoDate,
  reason: z.string().trim().min(5).max(500),
});
const codeParams = z.object({ code: z.string().trim().min(1).max(48) });

function send(reply: FastifyReply, status: number, body: unknown) {
  reply.header("Cache-Control", "no-store");
  return reply.status(status).send(body);
}

export async function registerJobClassificationRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
  injectedAuth?: Pick<AuthService, "getSession" | "getAuthorizationContext">,
) {
  if (!config.AUTH_ENCRYPTION_KEY) {
    throw new Error("AUTH_ENCRYPTION_KEY is required for job classification routes");
  }
  const auth = injectedAuth ?? new AuthService(
    pool, config.AUTH_ENCRYPTION_KEY, config.AUTH_SESSION_TTL_HOURS, config.NODE_ENV === "production",
  );

  async function requirePermission(
    request: FastifyRequest,
    reply: FastifyReply,
    permission: JobClassificationPermission,
  ): Promise<AuthPrincipal | null> {
    const session = await auth.getSession(readCookie(request.headers.cookie, AUTH_COOKIE_NAME));
    if (!session) {
      await send(reply, 401, { code: "UNAUTHENTICATED", message: "Sesi tidak ditemukan atau sudah berakhir." });
      return null;
    }
    const context = await auth.getAuthorizationContext(session.principal);
    if (!context.organizationPermissions.includes(permission)) {
      await send(reply, 403, {
        code: "JOB_CLASSIFICATION_FORBIDDEN",
        message: "Anda tidak memiliki akses untuk tindakan ini.",
      });
      return null;
    }
    return session.principal;
  }

  function handleError(reply: FastifyReply, error: unknown) {
    if (error instanceof JobClassificationError) {
      return send(reply, error.statusCode, { code: error.code, message: error.message });
    }
    // 23P01 is the exclusion constraint on (code, effective range). The service checks first,
    // but two concurrent writes for one code both pass that check under READ COMMITTED and
    // the second one lands here. The database kept the catalog correct; answer the caller
    // with the same conflict the sequential path gives instead of a 500 carrying SQL text.
    if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23P01") {
      return send(reply, 409, {
        code: "CATALOG_VERSION_CONFLICT",
        message: "Kode ini sedang diubah bersamaan. Muat ulang dan coba lagi.",
      });
    }
    throw error;
  }

  app.get("/admin/job-grades", async (request, reply) => {
    const principal = await requirePermission(request, reply, "job_classifications.read");
    if (!principal) return reply;
    const query = listQuery.parse(request.query ?? {});
    const onDate = query.onDate ?? jakartaDate(new Date());
    const { rows, total } = await listGrades(pool, {
      onDate,
      includeHistory: query.includeHistory,
      limit: query.pageSize,
      offset: pageOffset(query),
    });
    return send(reply, 200, {
      grades: rows, onDate, includeHistory: query.includeHistory, pagination: pagination(query, total),
    });
  });

  app.post("/admin/job-grades", async (request, reply) => {
    const principal = await requirePermission(request, reply, "job_classifications.manage");
    if (!principal) return reply;
    const body = createGradeBody.parse(request.body ?? {});
    try {
      return send(reply, 201, { grade: await createGrade(pool, body, principal.id) });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post("/admin/job-grades/:code/amendments", async (request, reply) => {
    const principal = await requirePermission(request, reply, "job_classifications.manage");
    if (!principal) return reply;
    const { code } = codeParams.parse(request.params);
    const body = amendGradeBody.parse(request.body ?? {});
    try {
      return send(reply, 200, { grade: await amendGrade(pool, code, body, principal.id) });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post("/admin/job-grades/:code/deactivation", async (request, reply) => {
    const principal = await requirePermission(request, reply, "job_classifications.manage");
    if (!principal) return reply;
    const { code } = codeParams.parse(request.params);
    const body = deactivateBody.parse(request.body ?? {});
    try {
      const grade = await deactivateGrade(pool, code, body.endOn, body.reason, principal.id);
      return send(reply, 200, { grade });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get("/admin/job-classifications", async (request, reply) => {
    const principal = await requirePermission(request, reply, "job_classifications.read");
    if (!principal) return reply;
    const query = classificationListQuery.parse(request.query ?? {});
    const onDate = query.onDate ?? jakartaDate(new Date());
    const { rows, total } = await listClassifications(pool, {
      onDate,
      includeHistory: query.includeHistory,
      family: query.family,
      limit: query.pageSize,
      offset: pageOffset(query),
    });
    return send(reply, 200, {
      classifications: rows, onDate, includeHistory: query.includeHistory,
      pagination: pagination(query, total),
    });
  });

  /** One code as it stood on a date, so an operator can check a past period's meaning. */
  app.get("/admin/job-classifications/:code", async (request, reply) => {
    const principal = await requirePermission(request, reply, "job_classifications.read");
    if (!principal) return reply;
    const { code } = codeParams.parse(request.params);
    const query = z.object({ onDate: isoDate.optional() }).parse(request.query ?? {});
    const onDate = query.onDate ?? jakartaDate(new Date());
    const classification = await classificationOn(pool, code, onDate);
    if (!classification) {
      return send(reply, 404, {
        code: "CLASSIFICATION_NOT_EFFECTIVE",
        message: `Klasifikasi ${code} tidak berlaku pada ${onDate}.`,
      });
    }
    const grade = classification.gradeCode
      ? await gradeOn(pool, classification.gradeCode, onDate)
      : null;
    return send(reply, 200, { classification, grade, onDate });
  });

  app.post("/admin/job-classifications", async (request, reply) => {
    const principal = await requirePermission(request, reply, "job_classifications.manage");
    if (!principal) return reply;
    const body = createClassificationBody.parse(request.body ?? {});
    try {
      const classification = await createClassification(pool, body, principal.id);
      return send(reply, 201, { classification });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post("/admin/job-classifications/:code/amendments", async (request, reply) => {
    const principal = await requirePermission(request, reply, "job_classifications.manage");
    if (!principal) return reply;
    const { code } = codeParams.parse(request.params);
    const body = amendClassificationBody.parse(request.body ?? {});
    try {
      const classification = await amendClassification(pool, code, body, principal.id);
      return send(reply, 200, { classification });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post("/admin/job-classifications/:code/deactivation", async (request, reply) => {
    const principal = await requirePermission(request, reply, "job_classifications.manage");
    if (!principal) return reply;
    const { code } = codeParams.parse(request.params);
    const body = deactivateBody.parse(request.body ?? {});
    try {
      const classification = await deactivateClassification(
        pool, code, body.endOn, body.reason, principal.id,
      );
      return send(reply, 200, { classification });
    } catch (error) {
      return handleError(reply, error);
    }
  });
}
