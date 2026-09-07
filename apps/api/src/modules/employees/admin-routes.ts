import type { AdminPermission } from "../auth/permissions.js";
import { basename } from "node:path";

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
import { EmployeeImportService } from "./application/employee-import-service.js";
import {
  EmployeeImportConflictError,
  PostgresEmployeeImportStore,
} from "./infrastructure/postgres-employee-import-store.js";

const listQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["active", "inactive", "resigned"]).optional(),
  unitId: z.string().uuid().optional(),
  positionId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const importIdSchema = z.object({ importId: z.string().uuid() });

interface EmployeeRow {
  id: string;
  employeeNumber: string;
  fullName: string;
  status: "active" | "inactive" | "resigned";
  employmentStatus: string | null;
  unitId: string | null;
  unitName: string | null;
  positionId: string | null;
  positionName: string | null;
  employmentType: string | null;
  functionalPosition: string | null;
  structuralPosition: string | null;
  email: string | null;
  phone: string | null;
  education: string | null;
  startedOn: string | null;
  endedOn: string | null;
  updatedAt: Date;
}

interface CountRow {
  total: number;
}

interface SummaryRow {
  total: number;
  active: number;
  inactive: number;
  resigned: number;
}

interface ReferenceRow {
  id: string;
  name: string;
}

interface ImportHistoryRow {
  importId: string;
  sourceFilename: string;
  checksumSha256: string;
  rowCount: number;
  insertCount: number;
  updateCount: number;
  warningCount: number;
  errorCount: number;
  status: "previewed" | "committed" | "failed";
  createdAt: Date;
  committedAt: Date | null;
  createdByEmail: string | null;
  committedByEmail: string | null;
}

function decodeFilename(value: string | undefined): string {
  if (!value) return "employee-import.csv";
  try {
    return basename(decodeURIComponent(value));
  } catch {
    return basename(value);
  }
}

export async function registerEmployeeAdminRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
) {
  if (!config.AUTH_ENCRYPTION_KEY) {
    throw new Error("AUTH_ENCRYPTION_KEY is required for employee admin routes");
  }

  const auth = new AuthService(
    pool,
    config.AUTH_ENCRYPTION_KEY,
    config.AUTH_SESSION_TTL_HOURS,
    config.NODE_ENV === "production",
  );
  const imports = new EmployeeImportService(new PostgresEmployeeImportStore(pool));

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

  app.get("/admin/employees", async (request, reply) => {
    const principal = await authenticateAdmin(request, reply, "employees.manage");
    if (!principal) return;

    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        code: "INVALID_QUERY",
        message: "Filter daftar pegawai tidak valid.",
      });
    }

    const { page, pageSize, status, unitId, positionId } = parsed.data;
    const search = parsed.data.q?.trim() || null;
    const offset = (page - 1) * pageSize;
    const filterValues = [search, status ?? null, unitId ?? null, positionId ?? null];
    const where = `
      WHERE ($1::text IS NULL
        OR e.employee_number ILIKE '%' || $1 || '%'
        OR e.full_name ILIKE '%' || $1 || '%'
        OR coalesce(e.email, '') ILIKE '%' || $1 || '%')
        AND ($2::text IS NULL OR e.status = $2)
        AND ($3::uuid IS NULL OR e.organizational_unit_id = $3)
        AND ($4::uuid IS NULL OR e.position_id = $4)
    `;

    const [items, count, summary, units, positions] = await Promise.all([
      pool.query<EmployeeRow>(
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
            e.employment_type AS "employmentType",
            e.functional_position AS "functionalPosition",
            e.structural_position AS "structuralPosition",
            e.email,
            e.phone,
            e.education,
            e.started_on AS "startedOn",
            e.ended_on AS "endedOn",
            e.updated_at AS "updatedAt"
          FROM employees e
          LEFT JOIN organizational_units u ON u.id = e.organizational_unit_id
          LEFT JOIN positions p ON p.id = e.position_id
          ${where}
          ORDER BY e.full_name ASC, e.employee_number ASC
          LIMIT $5 OFFSET $6
        `,
        [...filterValues, pageSize, offset],
      ),
      pool.query<CountRow>(
        `SELECT count(*)::int AS total FROM employees e ${where}`,
        filterValues,
      ),
      pool.query<SummaryRow>(
        `
          SELECT
            count(*)::int AS total,
            count(*) FILTER (WHERE status = 'active')::int AS active,
            count(*) FILTER (WHERE status = 'inactive')::int AS inactive,
            count(*) FILTER (WHERE status = 'resigned')::int AS resigned
          FROM employees
        `,
      ),
      pool.query<ReferenceRow>(
        "SELECT id, name FROM organizational_units ORDER BY name ASC",
      ),
      pool.query<ReferenceRow>("SELECT id, name FROM positions ORDER BY name ASC"),
    ]);

    const total = count.rows[0]?.total ?? 0;
    const globalSummary = summary.rows[0] ?? {
      total: 0,
      active: 0,
      inactive: 0,
      resigned: 0,
    };

    reply.header("Cache-Control", "no-store");
    return reply.send({
      items: items.rows.map((row) => ({
        ...row,
        updatedAt: row.updatedAt.toISOString(),
      })),
      pagination: {
        page,
        pageSize,
        total,
        pageCount: Math.max(1, Math.ceil(total / pageSize)),
      },
      summary: globalSummary,
      filters: {
        units: units.rows,
        positions: positions.rows,
      },
    });
  });

  app.get("/admin/employee-imports", async (request, reply) => {
    const principal = await authenticateAdmin(request, reply, "employees.manage");
    if (!principal) return;

    const result = await pool.query<ImportHistoryRow>(
      `
        SELECT
          j.id AS "importId",
          j.source_filename AS "sourceFilename",
          j.checksum_sha256 AS "checksumSha256",
          j.row_count AS "rowCount",
          j.insert_count AS "insertCount",
          j.update_count AS "updateCount",
          j.warning_count AS "warningCount",
          j.error_count AS "errorCount",
          j.status,
          j.created_at AS "createdAt",
          j.committed_at AS "committedAt",
          creator.email AS "createdByEmail",
          committer.email AS "committedByEmail"
        FROM employee_import_jobs j
        LEFT JOIN accounts creator ON creator.id = j.created_by_account_id
        LEFT JOIN accounts committer ON committer.id = j.committed_by_account_id
        ORDER BY j.created_at DESC
        LIMIT 50
      `,
    );

    reply.header("Cache-Control", "no-store");
    return reply.send({
      items: result.rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        committedAt: row.committedAt?.toISOString() ?? null,
      })),
    });
  });

  app.post(
    "/admin/employee-imports/preview",
    { bodyLimit: 16 * 1024 * 1024 },
    async (request, reply) => {
      const principal = await authenticateAdmin(request, reply, "employees.manage");
      if (!principal) return;

      if (!Buffer.isBuffer(request.body)) {
        return reply.status(400).send({
          code: "INVALID_IMPORT_FILE",
          message: "Body upload harus berupa file CSV atau XLSX.",
        });
      }

      const filenameHeader = request.headers["x-file-name"];
      const filename = decodeFilename(
        Array.isArray(filenameHeader) ? filenameHeader[0] : filenameHeader,
      );
      const lower = filename.toLowerCase();
      if (!lower.endsWith(".csv") && !lower.endsWith(".xlsx")) {
        return reply.status(400).send({
          code: "INVALID_IMPORT_FILE",
          message: "Employee import hanya menerima file .csv atau .xlsx.",
        });
      }

      try {
        const preview = await imports.preview({ filename, buffer: request.body });
        await pool.query(
          `UPDATE employee_import_jobs
           SET created_by_account_id = $2
           WHERE id = $1 AND created_by_account_id IS NULL`,
          [preview.importId, principal.id],
        );
        reply.header("Cache-Control", "no-store");
        return reply.status(201).send(preview);
      } catch (error) {
        request.log.warn({ err: error }, "employee import preview rejected");
        return reply.status(400).send({
          code: "IMPORT_PREVIEW_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "File import tidak dapat dipreview.",
        });
      }
    },
  );

  app.get("/admin/employee-imports/:importId", async (request, reply) => {
    const principal = await authenticateAdmin(request, reply, "employees.manage");
    if (!principal) return;

    const parsed = importIdSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({ code: "INVALID_IMPORT_ID", message: "Import ID tidak valid." });
    }

    const preview = await imports.getPreview(parsed.data.importId);
    if (!preview) {
      return reply.status(404).send({ code: "IMPORT_NOT_FOUND", message: "Riwayat import tidak ditemukan." });
    }

    reply.header("Cache-Control", "no-store");
    return reply.send(preview);
  });

  app.post("/admin/employee-imports/:importId/commit", async (request, reply) => {
    const principal = await authenticateAdmin(request, reply, "employees.manage");
    if (!principal) return;

    const parsed = importIdSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({ code: "INVALID_IMPORT_ID", message: "Import ID tidak valid." });
    }

    try {
      const result = await imports.commit(parsed.data.importId);
      await pool.query(
        `UPDATE employee_import_jobs
         SET committed_by_account_id = $2
         WHERE id = $1`,
        [result.importId, principal.id],
      );
      reply.header("Cache-Control", "no-store");
      return reply.send(result);
    } catch (error) {
      if (error instanceof EmployeeImportConflictError) {
        return reply.status(409).send({
          code: "IMPORT_CONFLICT",
          message: error.message,
        });
      }
      throw error;
    }
  });
}
