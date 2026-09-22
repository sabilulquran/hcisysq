import { hasEffectiveOrganizationPermission } from "../auth/permissions.js";
import { notifyEmployee } from "../notifications/service.js";
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

export type PayslipSourceFormat = "generic" | "tetap" | "honorer";
export type PayslipLineSection = "identity" | "income" | "deduction" | "summary" | "other";

interface ImportedLine {
  label: string;
  value: string;
  section?: PayslipLineSection;
}

interface ParsedRow {
  rowNumber: number;
  employeeNumber: string;
  period: string | null;
  lines: ImportedLine[] | null;
  errors: string[];
}

interface ParsedPayslipDocument {
  sourceFormat: PayslipSourceFormat;
  rows: ParsedRow[];
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

function parseCsvLine(line: string, delimiter = ","): string[] {
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
    } else if (char === delimiter && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
}

function normalizeLegacyHeader(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

function detectLegacyDelimiter(headerLine: string): "," | ";" {
  const commaColumns = parseCsvLine(headerLine, ",").length;
  const semicolonColumns = parseCsvLine(headerLine, ";").length;
  return semicolonColumns > commaColumns ? ";" : ",";
}

function resolveLegacyPeriod(value: string | undefined, fallbackPeriod?: string | null): string | null {
  const trimmed = value?.trim();
  if (trimmed) {
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(trimmed);
    if (!match) return null;
    const [, day, month, year] = match;
    const candidate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (
      candidate.getUTCFullYear() !== Number(year) ||
      candidate.getUTCMonth() + 1 !== Number(month) ||
      candidate.getUTCDate() !== Number(day)
    ) return null;
    return `${year}-${month}-01`;
  }
  return fallbackPeriod && periodPattern.test(fallbackPeriod) ? `${fallbackPeriod}-01` : null;
}

type LegacyLineDefinition = {
  label: string;
  aliases: string[];
  section: PayslipLineSection;
};

const fixedLineDefinitions: LegacyLineDefinition[] = [
  { label: "Gaji Pokok", aliases: ["GAJI POKOK"], section: "income" },
  { label: "Kelebihan Jam", aliases: ["KELEBIHAN JAM"], section: "income" },
  { label: "Tunjangan Kinerja", aliases: ["TUNJANGAN KINERJA"], section: "income" },
  { label: "Tunjangan Istri", aliases: ["TUNJANGAN ISTRI", "TUNJ. ISTRI", "TUNJ ISTRI"], section: "income" },
  { label: "Tunjangan Anak", aliases: ["TUNJANGAN ANAK", "TUNJ. ANAK", "TUNJ ANAK"], section: "income" },
  { label: "Tunjangan Fungsional", aliases: ["TUNJANGAN FUNGSIONAL", "TUNJ. FUNGSIONAL", "TUNJ FUNGSIONAL"], section: "income" },
  { label: "Tunjangan Jabatan", aliases: ["TUNJANGAN JABATAN", "TUNJ. JABATAN", "TUNJ JABATAN"], section: "income" },
  { label: "Tunjangan Kualifikasi Khusus", aliases: ["TUNJANGAN KUALIFIKASI KHUSUS"], section: "income" },
  { label: "Tunjangan BPJS", aliases: ["TUNJANGAN BPJS", "TUNJ. BPJS", "TUNJ BPJS"], section: "income" },
  { label: "Lembur", aliases: ["LEMBUR"], section: "income" },
  { label: "Rapel Gaji", aliases: ["RAPEL GAJI"], section: "income" },
  { label: "Potongan Kasbon", aliases: ["POTONGAN KASBON"], section: "deduction" },
  { label: "BPJS", aliases: ["BPJS"], section: "deduction" },
  { label: "Pendidikan Anak", aliases: ["PENDIDIKAN ANAK"], section: "deduction" },
  { label: "Kekurangan Jam", aliases: ["KEKURANGAN JAM"], section: "deduction" },
  { label: "Total Bruto Gaji", aliases: ["TOTAL BRUTO GAJI", "TOTAL BRUTO"], section: "summary" },
  { label: "Total Potongan", aliases: ["TOTAL POTONGAN"], section: "summary" },
  { label: "Gaji Neto", aliases: ["GAJI NETO", "GAJI NETTO"], section: "summary" },
  { label: "Gaji Neto 80%", aliases: ["GAJI NETO 80%", "GAJI NETTO 80%"], section: "summary" },
  { label: "Gaji Prorata", aliases: ["GAJI PRORATA"], section: "summary" },
];

const honorerLineDefinitions: LegacyLineDefinition[] = [
  { label: "Value Transport", aliases: ["VALUE TRANSPORT"], section: "income" },
  { label: "Jumlah Kehadiran", aliases: ["JUMLAH KEHADIRAN (TRANSPORT)", "JUMLAH KEHADIRAN"], section: "income" },
  { label: "Value Honor", aliases: ["VALUE HONOR"], section: "income" },
  { label: "Jumlah Jam Mengajar", aliases: ["JUMLAH JAM MENGAJAR"], section: "income" },
  { label: "Total Transport", aliases: ["TOTAL TRANSPORT"], section: "income" },
  { label: "Total Honor Mengajar", aliases: ["TOTAL HONOR MENGAJAR"], section: "income" },
  { label: "Pemasukan Lainnya", aliases: ["PEMASUKAN LAINNYA", "PEMASUKAN LAINYA"], section: "income" },
  { label: "Potongan Kasbon", aliases: ["POTONGAN KASBON"], section: "deduction" },
  { label: "BPJS", aliases: ["BPJS"], section: "deduction" },
  { label: "Pendidikan Anak", aliases: ["PENDIDIKAN ANAK"], section: "deduction" },
  { label: "Total Penghasilan", aliases: ["TOTAL PENGHASILAN"], section: "summary" },
  { label: "Total Potongan", aliases: ["TOTAL POTONGAN"], section: "summary" },
  { label: "Gaji Neto", aliases: ["GAJI NETO", "GAJI NETTO"], section: "summary" },
];

function firstLegacyValue(row: Map<string, string>, aliases: string[]): string | null {
  for (const alias of aliases) {
    const value = row.get(normalizeLegacyHeader(alias));
    if (value !== undefined) return value.trim();
  }
  return null;
}

function hasLegacyHeader(headers: string[], aliases: string[]): boolean {
  const set = new Set(headers);
  return aliases.some((alias) => set.has(normalizeLegacyHeader(alias)));
}

function assertLegacyRequiredHeaders(headers: string[], sourceFormat: Exclude<PayslipSourceFormat, "generic">) {
  const groups = sourceFormat === "honorer"
    ? [
        { label: "TOTAL PENGHASILAN", aliases: ["TOTAL PENGHASILAN"] },
        { label: "GAJI NETO", aliases: ["GAJI NETO", "GAJI NETTO"] },
      ]
    : [
        { label: "GAJI POKOK", aliases: ["GAJI POKOK"] },
        { label: "TOTAL BRUTO", aliases: ["TOTAL BRUTO GAJI", "TOTAL BRUTO"] },
        { label: "GAJI NETO", aliases: ["GAJI NETO", "GAJI NETTO"] },
      ];
  const missing = groups.filter((group) => !hasLegacyHeader(headers, group.aliases)).map((group) => group.label);
  if (missing.length) {
    throw new Error(`Kolom wajib format ${sourceFormat} tidak ditemukan: ${missing.join(", ")}.`);
  }
}

function parseCanonicalPayslipCsv(buffer: Buffer): ParsedRow[] {
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  const rawLines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (rawLines.length === 0) throw new Error("File CSV kosong.");

  const headers = parseCsvLine(rawLines[0] ?? "").map((value) => value.trim().toLowerCase());
  const required = ["employee_number", "period", "lines_json"];
  if (headers.length !== required.length || required.some((header, index) => headers[index] !== header)) {
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

function parseLegacyPayslipCsv(
  buffer: Buffer,
  sourceFormat: Exclude<PayslipSourceFormat, "generic">,
  fallbackPeriod?: string | null,
): ParsedRow[] {
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  const rawLines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (rawLines.length === 0) throw new Error("File CSV kosong.");
  const delimiter = detectLegacyDelimiter(rawLines[0] ?? "");
  const headers = parseCsvLine(rawLines[0] ?? "", delimiter).map(normalizeLegacyHeader);
  assertLegacyRequiredHeaders(headers, sourceFormat);
  const definitions = sourceFormat === "honorer" ? honorerLineDefinitions : fixedLineDefinitions;

  return rawLines.slice(1).map((line, index) => {
    const rowNumber = index + 2;
    const values = parseCsvLine(line, delimiter);
    const row = new Map<string, string>();
    headers.forEach((header, columnIndex) => row.set(header, values[columnIndex] ?? ""));
    const employeeNumber = firstLegacyValue(row, ["NIP"]) ?? "";
    const dateValue = firstLegacyValue(row, ["TANGGAL"]) ?? undefined;
    const period = resolveLegacyPeriod(dateValue, fallbackPeriod);
    const errors: string[] = [];
    if (!employeeNumber) errors.push("NIP wajib diisi");
    if (dateValue && !resolveLegacyPeriod(dateValue, null)) {
      errors.push("TANGGAL wajib berformat DD/MM/YYYY");
    } else if (!period) {
      errors.push("periode wajib tersedia dari TANGGAL atau fallback YYYY-MM");
    }
    const lines = definitions.flatMap((definition) => {
      const value = firstLegacyValue(row, definition.aliases);
      return value === null || value === ""
        ? []
        : [{ label: definition.label, value, section: definition.section }];
    });
    if (lines.length === 0) errors.push("baris tidak memiliki komponen payslip yang dikenali");
    return { rowNumber, employeeNumber, period, lines, errors };
  });
}

export function parsePayslipCsvDocument(
  buffer: Buffer,
  fallbackPeriod?: string | null,
): ParsedPayslipDocument {
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (!firstLine) throw new Error("File CSV kosong.");

  const canonicalHeaders = parseCsvLine(firstLine, ",").map((value) => value.trim().toLowerCase());
  if (
    canonicalHeaders.length === 3 &&
    canonicalHeaders[0] === "employee_number" &&
    canonicalHeaders[1] === "period" &&
    canonicalHeaders[2] === "lines_json"
  ) {
    return { sourceFormat: "generic", rows: parseCanonicalPayslipCsv(buffer) };
  }

  const delimiter = detectLegacyDelimiter(firstLine);
  const headers = parseCsvLine(firstLine, delimiter).map(normalizeLegacyHeader);
  if (!headers.includes("NIP")) {
    throw new Error("Format CSV tidak dikenali. Gunakan contract generic atau format legacy dengan kolom NIP.");
  }
  const sourceFormat: Exclude<PayslipSourceFormat, "generic"> =
    ["VALUE TRANSPORT", "VALUE HONOR", "JUMLAH JAM MENGAJAR"].some((header) => headers.includes(header))
      ? "honorer"
      : ["GAJI POKOK", "TUNJANGAN KINERJA"].some((header) => headers.includes(header))
        ? "tetap"
        : (() => { throw new Error("Format payroll legacy tidak dapat dideteksi sebagai tetap atau honorer."); })();

  return { sourceFormat, rows: parseLegacyPayslipCsv(buffer, sourceFormat, fallbackPeriod) };
}

export function parsePayslipCsv(buffer: Buffer): ParsedRow[] {
  return parseCanonicalPayslipCsv(buffer);
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
      `SELECT id, source_filename AS "sourceFilename", source_format AS "sourceFormat", status,
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

      const periodHeader = request.headers["x-payslip-period"];
      const fallbackPeriod = (
        Array.isArray(periodHeader) ? periodHeader[0] : periodHeader
      )?.trim() || null;
      if (fallbackPeriod && !periodPattern.test(fallbackPeriod)) {
        return reply.status(400).send({
          code: "INVALID_FALLBACK_PERIOD",
          message: "Fallback periode wajib berformat YYYY-MM.",
        });
      }

      let parsedDocument: ParsedPayslipDocument;
      try {
        parsedDocument = parsePayslipCsvDocument(request.body, fallbackPeriod);
      } catch (error) {
        return reply.status(400).send({
          code: "IMPORT_PREVIEW_FAILED",
          message: error instanceof Error ? error.message : "CSV tidak dapat dipreview.",
        });
      }
      if (parsedDocument.rows.length === 0) {
        return reply.status(400).send({
          code: "IMPORT_PREVIEW_FAILED",
          message: "CSV tidak memiliki baris data.",
        });
      }

      const employeeNumbers = [
        ...new Set(parsedDocument.rows.map((row) => row.employeeNumber).filter(Boolean)),
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
      const rows = parsedDocument.rows.map((row) => {
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
            (id, source_filename, source_format, checksum_sha256, status, row_count,
             valid_count, error_count, created_by_account_id)
           VALUES ($1, $2, $3, $4, 'previewed', $5, $6, $7, $8)`,
          [
            batchId,
            filename,
            parsedDocument.sourceFormat,
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
          payload: { rowCount: rows.length, validCount, errorCount, sourceFormat: parsedDocument.sourceFormat },
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
        sourceFormat: parsedDocument.sourceFormat,
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
      `SELECT id, source_filename AS "sourceFilename", source_format AS "sourceFormat", status,
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
      const batch = await client.query<{ status: string; errorCount: number; sourceFormat: PayslipSourceFormat }>(
        `SELECT status, error_count AS "errorCount", source_format AS "sourceFormat"
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
          `INSERT INTO payslips (id, employee_id, period, lines, source_format, source_batch_id)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
          [
            randomUUID(),
            row.employeeId,
            row.period,
            JSON.stringify(row.lines),
            current.sourceFormat,
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

      const published = await client.query<{ id: string; employeeId: string; period: string }>(
        `UPDATE payslips
            SET published_at = now(), published_by_account_id = $2
          WHERE source_batch_id = $1
            AND published_at IS NULL
        RETURNING id, employee_id AS "employeeId", to_char(period, 'YYYY-MM') AS period`,
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
      for (const payslip of published.rows) {
        await notifyEmployee(client, payslip.employeeId, {
          eventKey: `payslip:${payslip.id}:published`,
          category: "payslip",
          title: "Slip gaji tersedia",
          body: `Slip gaji periode ${payslip.period} sudah dipublikasikan.`,
          href: "/app/payslips",
          actorAccountId: principal.id,
          metadata: { payslipId: payslip.id, period: payslip.period },
        });
      }
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
      `SELECT id, to_char(period, 'YYYY-MM') AS period,
              source_format AS "sourceFormat", published_at AS "publishedAt"
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
      sourceFormat: PayslipSourceFormat;
      publishedAt: Date;
    }>(
      `SELECT id, to_char(period, 'YYYY-MM') AS period, lines,
              source_format AS "sourceFormat", published_at AS "publishedAt"
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
