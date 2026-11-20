// ORG-001: jalur massal penetapan atasan langsung untuk HC.
//
// Dua panggilan, dry-run lebih dulu dan wajib:
//   POST /admin/employees/manager-assignments/preview  -> menilai, tidak menulis
//   POST /admin/employees/manager-assignments/apply    -> menerapkan satu transaksi
//
// Izinnya sama dengan jalur satuan (`approvals.policy.manage`); tidak ada izin
// baru. Aturannya pun sama persis karena keduanya memanggil evaluator di
// `manager-assignment.ts`.

import { createHash } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import type { ApiConfig } from "../../config/env.js";
import type { AdminPermission } from "../auth/permissions.js";
import { requirePermissionsFromCookie } from "../auth/authorization.js";
import { AuthError, AuthService, type AuthPrincipal } from "../auth/service.js";
import {
  applyManagerAssignments,
  buildManagerAssignmentPreview,
  ManagerAssignmentBatchError,
} from "./application/manager-assignment-batch.js";
import { CsvFormatError } from "./infrastructure/csv-records.js";
import { parseManagerAssignmentCsv } from "./infrastructure/parse-manager-assignment-csv.js";

/** Berkas HC ~95 baris hari ini; batasnya disamakan dengan impor pegawai. */
const MAX_ROWS = 2_000;
const BODY_LIMIT = 4 * 1024 * 1024;

function decodeFilename(value: string | undefined): string {
  if (!value) return "atasan-langsung.csv";
  try {
    return decodeURIComponent(value).slice(0, 255);
  } catch {
    return value.slice(0, 255);
  }
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export async function registerManagerAssignmentAdminRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
) {
  if (!config.AUTH_ENCRYPTION_KEY) {
    throw new Error("AUTH_ENCRYPTION_KEY is required for manager assignment admin routes");
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

  function readSource(request: FastifyRequest, reply: FastifyReply) {
    if (!Buffer.isBuffer(request.body)) {
      reply.status(400).send({
        code: "INVALID_MANAGER_ASSIGNMENT_FILE",
        message: "Body upload harus berupa file CSV.",
      });
      return null;
    }
    const filename = decodeFilename(header(request, "x-file-name"));
    if (!filename.toLowerCase().endsWith(".csv")) {
      reply.status(400).send({
        code: "INVALID_MANAGER_ASSIGNMENT_FILE",
        message: "Penetapan atasan langsung massal hanya menerima file .csv.",
      });
      return null;
    }
    try {
      return {
        filename,
        checksumSha256: createHash("sha256").update(request.body).digest("hex"),
        rows: parseManagerAssignmentCsv(request.body, { maxRows: MAX_ROWS }),
      };
    } catch (error) {
      reply.status(400).send({
        code: "INVALID_MANAGER_ASSIGNMENT_FILE",
        message: error instanceof CsvFormatError ? error.message : "File tidak dapat dibaca.",
      });
      return null;
    }
  }

  app.post(
    "/admin/employees/manager-assignments/preview",
    { bodyLimit: BODY_LIMIT },
    async (request, reply) => {
      const principal = await authenticateAdmin(request, reply, "approvals.policy.manage");
      if (!principal) return;

      const source = readSource(request, reply);
      if (!source) return;

      const preview = await buildManagerAssignmentPreview(pool, source.rows);
      reply.header("Cache-Control", "no-store");
      return reply.send({
        sourceFilename: source.filename,
        checksumSha256: source.checksumSha256,
        ...preview,
      });
    },
  );

  app.post(
    "/admin/employees/manager-assignments/apply",
    { bodyLimit: BODY_LIMIT },
    async (request, reply) => {
      const principal = await authenticateAdmin(request, reply, "approvals.policy.manage");
      if (!principal) return;

      const previewToken = header(request, "x-preview-token")?.trim();
      if (!previewToken || !/^[0-9a-f]{64}$/.test(previewToken)) {
        return reply.status(400).send({
          code: "MANAGER_ASSIGNMENT_PREVIEW_REQUIRED",
          message: "Dry-run wajib dijalankan lebih dulu; token preview tidak ada atau tidak valid.",
        });
      }

      const source = readSource(request, reply);
      if (!source) return;

      try {
        const result = await applyManagerAssignments(pool, {
          actorAccountId: principal.id,
          sourceRows: source.rows,
          previewToken,
          sourceFilename: source.filename,
          checksumSha256: source.checksumSha256,
        });
        reply.header("Cache-Control", "no-store");
        return reply.send(result);
      } catch (error) {
        if (error instanceof ManagerAssignmentBatchError) {
          reply.header("Cache-Control", "no-store");
          return reply.status(409).send({
            code: error.code,
            message: error.message,
            preview: {
              sourceFilename: source.filename,
              checksumSha256: source.checksumSha256,
              ...error.preview,
            },
          });
        }
        throw error;
      }
    },
  );
}
