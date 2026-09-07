import { hasEffectiveOrganizationPermission } from "../auth/permissions.js";
import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import {
  AUTH_COOKIE_NAME,
  AuthService,
  readCookie,
  type AuthPrincipal,
} from "../auth/service.js";

export type PayslipPermission = "payslips.import" | "payslips.publish";

const idSchema = z.object({ id: z.string().uuid() });
const batchIdSchema = z.object({ batchId: z.string().uuid() });
const periodPattern = /^\d{4}-(0[1-9]|1[0-2])$/;

type QueryTarget = Pool | PoolClient;

interface ImportedLine {
  label: string;
  value: string;
}

interface ParsedRow {
  rowNumber: number;
  employeeNumber: string;
  period: string | null;
  lines: ImportedLine[] | null;
  errors: string[];
}

interface ImportRowRecord {
  employeeId: string;
  period: string;
  lines: ImportedLine[];
}

function decodeFilename(value: string | undefined): string {
  if (!value) return "payslip-import.csv";
  try {
    return basename(decodeURIComponent(value));
  } catch {
    return basename(value);
  }
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
}

export function parsePayslipCsv(buffer: Buffer): ParsedRow[] {
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  const rawLines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (rawLines.length === 0) throw new Error("File CSV kosong.");

  const headers = parseCsvLine(rawLines[0] ?? "").map((value) => value.trim().toLowerCase());
  const required = ["employee_number", "period", "lines_json"];
  if (
    headers.length !== required.length ||
    required.some((header, index) => headers[index] !== header)
  ) {
    throw new Error("Header CSV wajib tepat: employee_number,period,lines_json.");
  }

  return rawLines.slice(1).map((line, index) => {
    const rowNumber = index + 2;
    const columns = parseCsvLine(line);
    const employeeNumber = (columns[0] ?? "").trim();
    const periodValue = (columns[1] ?? "").trim();
    const linesValue = (columns[2] ?? "").trim();
    const errors: string[] = [];
    let lines: ImportedLine[] | null = null;

    if (!employeeNumber) errors.push("employee_number wajib diisi");
    if (!periodPattern.test(periodValue)) errors.push("period wajib berformat YYYY-MM");

    try {
      const parsed: unknown = JSON.parse(linesValue);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        errors.push("lines_json wajib berupa array non-kosong");
      } else if (
        parsed.length > 100 ||
        parsed.some((item) => {
          if (typeof item !== "object" || item === null) return true;
          const record = item as Record<string, unknown>;
          return (
            typeof record.label !== "string" ||
            typeof record.value !== "string" ||
            !record.label.trim() ||
            record.label.length > 120 ||
            record.value.length > 240
          );
        })
      ) {
        errors.push("lines_json hanya menerima maksimal 100 item {label,value} string");
      } else {
        lines = parsed.map((item) => {
          const record = item as ImportedLine;
          return { label: record.label.trim(), value: record.value };
        });
      }
    } catch {
      errors.push("lines_json bukan JSON yang valid");
    }

    if (columns.length !== 3) errors.push("setiap baris wajib memiliki tepat tiga kolom");

    return {
      rowNumber,
      employeeNumber,
      period: periodPattern.test(periodValue) ? `${periodValue}-01` : null,
      lines,
      errors,
    };
  });
}

async function writeAudit(
  database: QueryTarget,
  actorAccountId: string,
  action: string,
  options: {
    batchId?: string | null;
    payslipId?: string | null;
    employeeId?: string | null;
    payload?: object;
  } = {},
) {
  await database.query(
    `INSERT INTO payslip_audit_events
      (id, actor_account_id, action, batch_id, payslip_id, employee_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      randomUUID(),
      actorAccountId,
      action,
      options.batchId ?? null,
      options.payslipId ?? null,
      options.employeeId ?? null,
      JSON.stringify(options.payload ?? {}),
    ],
  );
}

export async function hasPayslipCapability(
  pool: Pick<Pool, "query">,
  principal: AuthPrincipal,
  permission: PayslipPermission,
): Promise<boolean> {
  return hasEffectiveOrganizationPermission(pool, principal, permission);
}

export async function registerPayslipRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
  injectedAuth?: Pick<AuthService, "getSession">,
) {
  if (!config.AUTH_ENCRYPTION_KEY) {
    throw new Error("AUTH_ENCRYPTION_KEY is required for payslip routes");
  }

  const auth =
    injectedAuth ??
    new AuthService(
      pool,
      config.AUTH_ENCRYPTION_KEY,
      config.AUTH_SESSION_TTL_HOURS,
      config.NODE_ENV === "production",
    );

  async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthPrincipal | null> {
    const token = readCookie(request.headers.cookie, AUTH_COOKIE_NAME);
    const session = await auth.getSession(token);
    if (!session) {
      reply.header("Cache-Control", "no-store");
      await reply.status(401).send({
        code: "UNAUTHENTICATED",
        message: "Sesi tidak ditemukan atau sudah berakhir.",
      });
      return null;
    }
    return session.principal;
  }

  async function requireCapability(
    request: FastifyRequest,
    reply: FastifyReply,
    permission: PayslipPermission,
  ): Promise<AuthPrincipal | null> {
    const principal = await authenticate(request, reply);
    if (!principal) return null;
    if (!(await hasPayslipCapability(pool, principal, permission))) {
      reply.header("Cache-Control", "no-store");
      await reply.status(403).send({
        code: "FORBIDDEN",
        message: "Akun ini tidak memiliki capability payslip yang diperlukan.",
      });
      return null;
    }
    return principal;
  }

  async function requireEmployee(request: FastifyRequest, reply: FastifyReply) {
    const principal = await authenticate(request, reply);
    if (!principal) return null;
    if (principal.principalType !== "EMPLOYEE") {
      reply.header("Cache-Control", "no-store");
      await reply.status(403).send({
        code: "FORBIDDEN",
        message: "Payslip pribadi hanya tersedia untuk employee.",
      });
      return null;
    }

    const employee = await pool.query<{ employeeId: string }>(
      `SELECT account.employee_id AS "employeeId"
         FROM accounts account
         JOIN employees employee ON employee.id = account.employee_id
        WHERE account.id = $1
          AND account.principal_type = 'EMPLOYEE'
          AND account.status = 'active'
          AND employee.status = 'active'
        LIMIT 1`,
      [principal.id],
    );
    const employeeId = employee.rows[0]?.employeeId;
    if (!employeeId) {
      reply.header("Cache-Control", "no-store");
      await reply.status(403).send({
        code: "EMPLOYEE_LINK_REQUIRED",
        message: "Account employee tidak terhubung ke employee aktif.",
      });
      return null;
    }
    return { principal, employeeId };
  }

  app.get("/admin/payslip-imports", async (request, reply) => {
    const principal = await requireCapability(request, reply, "payslips.import");
    if (!principal) return;
    const result = await pool.query(
      `SELECT id, source_filename AS "sourceFilename", status,
              row_count AS "rowCount", valid_count AS "validCount",
              error_count AS "errorCount", created_at AS "createdAt",
              committed_at AS "committedAt", published_at AS "publishedAt"
         FROM payslip_import_batches
        ORDER BY created_at DESC
        LIMIT 50`,
    );
    reply.header("Cache-Control", "private, no-store");
    return reply.send({ items: result.rows });
  });

  app.post(
    "/admin/payslip-imports/preview",
    { bodyLimit: 8 * 1024 * 1024 },
    async (request, reply) => {
      const principal = await requireCapability(request, reply, "payslips.import");
      if (!principal) return;
      if (!Buffer.isBuffer(request.body)) {
        return reply.status(400).send({
          code: "INVALID_IMPORT_FILE",
          message: "Body upload harus berupa file CSV.",
        });
      }

      const filenameHeader = request.headers["x-file-name"];
      const filename = decodeFilename(
        Array.isArray(filenameHeader) ? filenameHeader[0] : filenameHeader,
      );
      if (!filename.toLowerCase().endsWith(".csv")) {
        return reply.status(400).send({
          code: "INVALID_IMPORT_FILE",
          message: "Payslip MVP hanya menerima CSV sesuai contract terdokumentasi.",
        });
      }

      let parsed: ParsedRow[];
      try {
        parsed = parsePayslipCsv(request.body);
      } catch (error) {
        return reply.status(400).send({
          code: "IMPORT_PREVIEW_FAILED",
          message: error instanceof Error ? error.message : "CSV tidak dapat dipreview.",
        });
      }
      if (parsed.length === 0) {
        return reply.status(400).send({
          code: "IMPORT_PREVIEW_FAILED",
          message: "CSV tidak memiliki baris data.",
        });
      }

      const employeeNumbers = [
        ...new Set(parsed.map((row) => row.employeeNumber).filter(Boolean)),
      ];
      const employees = employeeNumbers.length
        ? await pool.query<{ id: string; employeeNumber: string }>(
            `SELECT id, employee_number AS "employeeNumber"
               FROM employees
              WHERE employee_number = ANY($1::text[])`,
            [employeeNumbers],
          )
        : { rows: [] as Array<{ id: string; employeeNumber: string }> };
      const employeeByNumber = new Map(
        employees.rows.map((row) => [row.employeeNumber, row.id]),
      );
      const seen = new Set<string>();
      const rows = parsed.map((row) => {
        const errors = [...row.errors];
        const employeeId = employeeByNumber.get(row.employeeNumber) ?? null;
        if (row.employeeNumber && !employeeId) {
          errors.push("employee reference tidak ditemukan");
        }
        const key = employeeId && row.period ? `${employeeId}|${row.period}` : null;
        if (key && seen.has(key)) {
          errors.push("employee dan period duplikat dalam batch");
        }
        if (key) seen.add(key);
        return { ...row, employeeId, errors };
      });

      const batchId = randomUUID();
      const validCount = rows.filter((row) => row.errors.length === 0).length;
      const errorCount = rows.length - validCount;
      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO payslip_import_batches
            (id, source_filename, checksum_sha256, status, row_count,
             valid_count, error_count, created_by_account_id)
           VALUES ($1, $2, $3, 'previewed', $4, $5, $6, $7)`,
          [
            batchId,
            filename,
            createHash("sha256").update(request.body).digest("hex"),
            rows.length,
            validCount,
            errorCount,
            principal.id,
          ],
        );
        for (const row of rows) {
          await client.query(
            `INSERT INTO payslip_import_rows
              (id, batch_id, row_number, employee_id, employee_number,
               period, lines, validation_errors)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
            [
              randomUUID(),
              batchId,
              row.rowNumber,
              row.employeeId,
              row.employeeNumber,
              row.period,
              row.lines ? JSON.stringify(row.lines) : null,
              JSON.stringify(row.errors),
            ],
          );
        }
        await writeAudit(client, principal.id, "payslip.import.previewed", {
          batchId,
          payload: { rowCount: rows.length, validCount, errorCount },
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      reply.header("Cache-Control", "private, no-store");
      return reply.status(201).send({
        batchId,
        status: "previewed",
        rowCount: rows.length,
        validCount,
        errorCount,
        rows,
      });
    },
  );

  app.get("/admin/payslip-imports/:batchId", async (request, reply) => {
    const principal = await requireCapability(request, reply, "payslips.import");
    if (!principal) return;
    const parsed = batchIdSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({
        code: "INVALID_BATCH_ID",
        message: "Batch ID tidak valid.",
      });
    }

    const batch = await pool.query(
      `SELECT id, source_filename AS "sourceFilename", status,
              row_count AS "rowCount", valid_count AS "validCount",
              error_count AS "errorCount", created_at AS "createdAt",
              committed_at AS "committedAt", published_at AS "publishedAt"
         FROM payslip_import_batches
        WHERE id = $1`,
      [parsed.data.batchId],
    );
    if (!batch.rows[0]) {
      return reply.status(404).send({
        code: "BATCH_NOT_FOUND",
        message: "Batch payslip tidak ditemukan.",
      });
    }

    const rows = await pool.query(
      `SELECT row_number AS "rowNumber", employee_number AS "employeeNumber",
              to_char(period, 'YYYY-MM') AS period, lines,
              validation_errors AS errors
         FROM payslip_import_rows
        WHERE batch_id = $1
        ORDER BY row_number`,
      [parsed.data.batchId],
    );
    await writeAudit(pool, principal.id, "payslip.import.review_opened", {
      batchId: parsed.data.batchId,
      payload: { rowCount: rows.rowCount ?? rows.rows.length },
    });
    reply.header("Cache-Control", "private, no-store");
    return reply.send({ ...batch.rows[0], rows: rows.rows });
  });

  app.post("/admin/payslip-imports/:batchId/commit", async (request, reply) => {
    const principal = await requireCapability(request, reply, "payslips.import");
    if (!principal) return;
    const parsed = batchIdSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({
        code: "INVALID_BATCH_ID",
        message: "Batch ID tidak valid.",
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const batch = await client.query<{ status: string; errorCount: number }>(
        `SELECT status, error_count AS "errorCount"
           FROM payslip_import_batches
          WHERE id = $1
          FOR UPDATE`,
        [parsed.data.batchId],
      );
      const current = batch.rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return reply.status(404).send({
          code: "BATCH_NOT_FOUND",
          message: "Batch payslip tidak ditemukan.",
        });
      }
      if (current.status !== "previewed") {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "INVALID_BATCH_STATE",
          message: "Hanya batch previewed yang dapat di-commit.",
        });
      }
      if (current.errorCount > 0) {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "BATCH_HAS_ERRORS",
          message: "Perbaiki seluruh validation error sebelum commit.",
        });
      }

      const importRows = await client.query<ImportRowRecord>(
        `SELECT employee_id AS "employeeId", period::text AS period, lines
           FROM payslip_import_rows
          WHERE batch_id = $1
            AND jsonb_array_length(validation_errors) = 0
          ORDER BY row_number`,
        [parsed.data.batchId],
      );
      const conflict = await client.query(
        `SELECT 1
           FROM payslips payslip
           JOIN payslip_import_rows imported
             ON imported.employee_id = payslip.employee_id
            AND imported.period = payslip.period
          WHERE imported.batch_id = $1
          LIMIT 1`,
        [parsed.data.batchId],
      );
      if (conflict.rowCount) {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "PAYSLIP_ALREADY_EXISTS",
          message: "Payslip untuk employee dan period tersebut sudah ada.",
        });
      }

      for (const row of importRows.rows) {
        await client.query(
          `INSERT INTO payslips (id, employee_id, period, lines, source_batch_id)
           VALUES ($1, $2, $3, $4::jsonb, $5)`,
          [
            randomUUID(),
            row.employeeId,
            row.period,
            JSON.stringify(row.lines),
            parsed.data.batchId,
          ],
        );
      }
      await client.query(
        `UPDATE payslip_import_batches
            SET status = 'committed', committed_by_account_id = $2, committed_at = now()
          WHERE id = $1`,
        [parsed.data.batchId, principal.id],
      );
      await writeAudit(client, principal.id, "payslip.import.committed", {
        batchId: parsed.data.batchId,
        payload: { payslipCount: importRows.rows.length },
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    reply.header("Cache-Control", "no-store");
    return reply.send({ batchId: parsed.data.batchId, status: "committed" });
  });

  app.post("/admin/payslip-imports/:batchId/publish", async (request, reply) => {
    const principal = await requireCapability(request, reply, "payslips.publish");
    if (!principal) return;
    const parsed = batchIdSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({
        code: "INVALID_BATCH_ID",
        message: "Batch ID tidak valid.",
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const batch = await client.query<{ status: string }>(
        `SELECT status FROM payslip_import_batches WHERE id = $1 FOR UPDATE`,
        [parsed.data.batchId],
      );
      if (!batch.rows[0]) {
        await client.query("ROLLBACK");
        return reply.status(404).send({
          code: "BATCH_NOT_FOUND",
          message: "Batch payslip tidak ditemukan.",
        });
      }
      if (batch.rows[0].status !== "committed") {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "INVALID_BATCH_STATE",
          message: "Hanya batch committed yang dapat dipublish.",
        });
      }

      const published = await client.query(
        `UPDATE payslips
            SET published_at = now(), published_by_account_id = $2
          WHERE source_batch_id = $1
            AND published_at IS NULL
        RETURNING id`,
        [parsed.data.batchId, principal.id],
      );
      await client.query(
        `UPDATE payslip_import_batches
            SET status = 'published', published_by_account_id = $2, published_at = now()
          WHERE id = $1`,
        [parsed.data.batchId, principal.id],
      );
      await writeAudit(client, principal.id, "payslip.batch.published", {
        batchId: parsed.data.batchId,
        payload: { payslipCount: published.rowCount ?? published.rows.length },
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    reply.header("Cache-Control", "no-store");
    return reply.send({ batchId: parsed.data.batchId, status: "published" });
  });

  app.get("/payslips", async (request, reply) => {
    const self = await requireEmployee(request, reply);
    if (!self) return;
    const result = await pool.query(
      `SELECT id, to_char(period, 'YYYY-MM') AS period, published_at AS "publishedAt"
         FROM payslips
        WHERE employee_id = $1
          AND published_at IS NOT NULL
        ORDER BY period DESC`,
      [self.employeeId],
    );
    reply.header("Cache-Control", "private, no-store");
    return reply.send({ items: result.rows });
  });

  app.get("/payslips/:id", async (request, reply) => {
    const self = await requireEmployee(request, reply);
    if (!self) return;
    const parsed = idSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({
        code: "INVALID_PAYSLIP_ID",
        message: "Payslip ID tidak valid.",
      });
    }

    const result = await pool.query<{
      id: string;
      period: string;
      lines: ImportedLine[];
      publishedAt: Date;
    }>(
      `SELECT id, to_char(period, 'YYYY-MM') AS period, lines,
              published_at AS "publishedAt"
         FROM payslips
        WHERE id = $1
          AND employee_id = $2
          AND published_at IS NOT NULL
        LIMIT 1`,
      [parsed.data.id, self.employeeId],
    );
    const payslip = result.rows[0];
    if (!payslip) {
      return reply.status(404).send({
        code: "PAYSLIP_NOT_FOUND",
        message: "Payslip tidak ditemukan.",
      });
    }

    await writeAudit(pool, self.principal.id, "payslip.read", {
      payslipId: payslip.id,
      employeeId: self.employeeId,
      payload: { period: payslip.period },
    });
    reply.header("Cache-Control", "private, no-store");
    return reply.send(payslip);
  });
}
