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
const importRowParamsSchema = z.object({
  batchId: z.string().uuid(),
  rowNumber: z.coerce.number().int().positive(),
});
const importRowCorrectionSchema = z.object({
  employeeNumber: z.string().trim().min(1).max(120),
  period: z.string().regex(periodPattern),
});
const bulkImportRowCorrectionSchema = z.object({
  rows: z.array(z.object({
    rowNumber: z.number().int().positive(),
    employeeNumber: z.string().trim().min(1).max(120),
    period: z.string().regex(periodPattern),
  })).min(1).max(500),
}).superRefine((value, context) => {
  const seen = new Set<number>();
  value.rows.forEach((row, index) => {
    if (seen.has(row.rowNumber)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rows", index, "rowNumber"],
        message: "rowNumber duplikat dalam bulk correction",
      });
    }
    seen.add(row.rowNumber);
  });
});
const bulkImportRowExcludeSchema = z.object({
  rowNumbers: z.array(z.number().int().positive()).min(1).max(500),
}).superRefine((value, context) => {
  if (new Set(value.rowNumbers).size !== value.rowNumbers.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["rowNumbers"],
      message: "rowNumbers harus unik",
    });
  }
});

type QueryTarget = Pool | PoolClient;

export type PayslipSourceFormat = "generic" | "tetap" | "honorer";
export type PayslipLineSection = "identity" | "income" | "deduction" | "summary" | "other";
export type PayslipRowResolutionStatus = "pending" | "drafted" | "excluded";

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
  id: string;
  rowNumber: number;
  employeeId: string;
  period: string;
  lines: ImportedLine[];
}

interface RowValidationResult {
  employeeId: string | null;
  period: string | null;
  errors: string[];
}

const correctableRowErrorPrefixes = [
  "employee_number wajib diisi",
  "NIP wajib diisi",
  "period wajib berformat YYYY-MM",
  "TANGGAL wajib berformat DD/MM/YYYY",
  "periode wajib tersedia dari TANGGAL atau fallback YYYY-MM",
  "employee reference tidak ditemukan",
  "employee dan period duplikat dalam batch",
  "payslip untuk employee dan period sudah ada",
];

function structuralRowErrors(errors: string[]): string[] {
  return errors.filter(
    (error) => !correctableRowErrorPrefixes.some((prefix) => error.startsWith(prefix)),
  );
}

async function revalidateImportRow(
  database: QueryTarget,
  options: {
    batchId: string;
    rowNumber: number;
    employeeNumber: string;
    period: string;
    lines: ImportedLine[] | null;
    previousErrors: string[];
  },
): Promise<RowValidationResult> {
  const errors = structuralRowErrors(options.previousErrors);
  const period = periodPattern.test(options.period) ? `${options.period}-01` : null;
  if (!period) errors.push("period wajib berformat YYYY-MM");
  if (!options.lines || options.lines.length === 0) {
    errors.push("baris tidak memiliki komponen payslip yang dikenali");
  }

  const employee = await database.query<{ id: string }>(
    `SELECT id FROM employees WHERE employee_number = $1 LIMIT 1`,
    [options.employeeNumber],
  );
  const employeeId = employee.rows[0]?.id ?? null;
  if (!employeeId) errors.push("employee reference tidak ditemukan");

  if (employeeId && period) {
    const duplicate = await database.query(
      `SELECT 1
         FROM payslip_import_rows
        WHERE batch_id = $1
          AND row_number <> $2
          AND resolution_status <> 'excluded'
          AND employee_id = $3
          AND period = $4::date
        LIMIT 1`,
      [options.batchId, options.rowNumber, employeeId, period],
    );
    if (duplicate.rowCount) errors.push("employee dan period duplikat dalam batch");

    const existing = await database.query(
      `SELECT 1
         FROM payslips
        WHERE employee_id = $1
          AND period = $2::date
        LIMIT 1`,
      [employeeId, period],
    );
    if (existing.rowCount) errors.push("payslip untuk employee dan period sudah ada");
  }

  return { employeeId, period, errors: [...new Set(errors)] };
}

async function refreshBatchValidationCounts(database: QueryTarget, batchId: string) {
  await database.query(
    `UPDATE payslip_import_batches batch
        SET valid_count = stats.valid_count,
            error_count = stats.error_count
       FROM (
         SELECT batch_id,
                count(*) FILTER (
                  WHERE resolution_status IN ('pending', 'drafted')
                    AND jsonb_array_length(validation_errors) = 0
                )::int AS valid_count,
                count(*) FILTER (
                  WHERE resolution_status = 'pending'
                    AND jsonb_array_length(validation_errors) > 0
                )::int AS error_count
           FROM payslip_import_rows
          WHERE batch_id = $1
          GROUP BY batch_id
       ) stats
      WHERE batch.id = stats.batch_id`,
    [batchId],
  );
}

type PayslipSignerTitle = "Kepala Human Capital Management" | "Direktur";

interface PayslipSignerCandidate {
  employeeId: string;
  name: string;
}

async function findDynamicSignerCandidate(
  database: QueryTarget,
  role: "hcm" | "director",
): Promise<PayslipSignerCandidate | null> {
  const result = await database.query<PayslipSignerCandidate>(
    `WITH latest AS (
       SELECT id
         FROM organization_change_sets
        WHERE status = 'PUBLISHED'
          AND effective_on <= current_date
        ORDER BY effective_on DESC, published_at DESC NULLS LAST, created_at DESC, id DESC
        LIMIT 1
     )
     SELECT employee.id AS "employeeId", employee.full_name AS name
       FROM latest
       JOIN organization_positions position
         ON position.change_set_id = latest.id
       JOIN organization_nodes node
         ON node.change_set_id = position.change_set_id
        AND node.stable_key = position.node_key
       JOIN organization_incumbencies incumbent
         ON incumbent.change_set_id = position.change_set_id
        AND incumbent.position_key = position.stable_key
       JOIN employees employee
         ON employee.id = incumbent.employee_id
      WHERE (
        (
          $1 = 'hcm'
          AND (
            lower(regexp_replace(btrim(position.title), '\\s+', ' ', 'g')) = 'kepala human capital management'
            OR (
              lower(regexp_replace(btrim(position.title), '\\s+', ' ', 'g')) = 'kepala'
              AND lower(regexp_replace(btrim(node.name), '\\s+', ' ', 'g')) = 'human capital management'
            )
          )
        )
        OR (
          $1 = 'director'
          AND lower(regexp_replace(btrim(position.title), '\\s+', ' ', 'g')) = 'direktur'
        )
      )
        AND position.active = true
        AND node.active = true
        AND position.effective_from <= current_date
        AND (position.effective_to IS NULL OR position.effective_to >= current_date)
        AND node.effective_from <= current_date
        AND (node.effective_to IS NULL OR node.effective_to >= current_date)
        AND incumbent.effective_from <= current_date
        AND (incumbent.effective_to IS NULL OR incumbent.effective_to >= current_date)
        AND incumbent.employee_id IS NOT NULL
        AND employee.status = 'active'
      ORDER BY CASE incumbent.kind WHEN 'PRIMARY' THEN 0 ELSE 1 END,
               incumbent.effective_from DESC,
               employee.full_name ASC
      LIMIT 1`,
    [role],
  );
  return result.rows[0] ?? null;
}

async function findLegacySignerCandidate(
  database: QueryTarget,
  role: "hcm" | "director",
): Promise<PayslipSignerCandidate | null> {
  const result = await database.query<PayslipSignerCandidate>(
    `SELECT employee.id AS "employeeId", employee.full_name AS name
       FROM employees employee
       LEFT JOIN positions position ON position.id = employee.position_id
       LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
      WHERE employee.status = 'active'
        AND (
          (
            $1 = 'hcm'
            AND (
              lower(regexp_replace(btrim(coalesce(position.name, '')), '\\s+', ' ', 'g')) = 'kepala human capital management'
              OR lower(regexp_replace(btrim(coalesce(employee.structural_position, '')), '\\s+', ' ', 'g')) = 'kepala human capital management'
              OR (
                lower(regexp_replace(btrim(coalesce(position.name, '')), '\\s+', ' ', 'g')) = 'kepala'
                AND lower(regexp_replace(btrim(coalesce(unit.name, '')), '\\s+', ' ', 'g')) = 'human capital management'
              )
            )
          )
          OR (
            $1 = 'director'
            AND (
              lower(regexp_replace(btrim(coalesce(position.name, '')), '\\s+', ' ', 'g')) = 'direktur'
              OR lower(regexp_replace(btrim(coalesce(employee.structural_position, '')), '\\s+', ' ', 'g')) = 'direktur'
            )
          )
        )
      ORDER BY employee.full_name ASC
      LIMIT 1`,
    [role],
  );
  return result.rows[0] ?? null;
}

async function findPayslipSignerCandidate(
  database: QueryTarget,
  role: "hcm" | "director",
): Promise<PayslipSignerCandidate | null> {
  return (
    (await findDynamicSignerCandidate(database, role))
    ?? (await findLegacySignerCandidate(database, role))
  );
}

async function resolvePayslipSigner(
  database: QueryTarget,
  payslipOwnerEmployeeId: string,
): Promise<{ title: PayslipSignerTitle; name: string | null }> {
  const hcm = await findPayslipSignerCandidate(database, "hcm");
  if (hcm && hcm.employeeId !== payslipOwnerEmployeeId) {
    return { title: "Kepala Human Capital Management", name: hcm.name };
  }

  const director = await findPayslipSignerCandidate(database, "director");
  if (director && director.employeeId !== payslipOwnerEmployeeId) {
    return { title: "Direktur", name: director.name };
  }

  if (hcm?.employeeId === payslipOwnerEmployeeId || !hcm) {
    return { title: "Direktur", name: null };
  }

  return { title: "Kepala Human Capital Management", name: null };
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
      `SELECT batch.id, batch.source_filename AS "sourceFilename",
              batch.source_format AS "sourceFormat", batch.status,
              batch.row_count AS "rowCount", batch.valid_count AS "validCount",
              batch.error_count AS "errorCount", batch.created_at AS "createdAt",
              batch.committed_at AS "committedAt", batch.published_at AS "publishedAt",
              COALESCE(stats.drafted_count, 0)::int AS "draftedCount",
              COALESCE(stats.pending_valid_count, 0)::int AS "pendingValidCount",
              COALESCE(stats.unresolved_count, 0)::int AS "unresolvedCount",
              COALESCE(stats.excluded_count, 0)::int AS "excludedCount"
         FROM payslip_import_batches batch
         LEFT JOIN LATERAL (
           SELECT count(*) FILTER (WHERE resolution_status = 'drafted') AS drafted_count,
                  count(*) FILTER (
                    WHERE resolution_status = 'pending'
                      AND jsonb_array_length(validation_errors) = 0
                  ) AS pending_valid_count,
                  count(*) FILTER (
                    WHERE resolution_status = 'pending'
                      AND jsonb_array_length(validation_errors) > 0
                  ) AS unresolved_count,
                  count(*) FILTER (WHERE resolution_status = 'excluded') AS excluded_count
             FROM payslip_import_rows
            WHERE batch_id = batch.id
         ) stats ON true
        ORDER BY batch.created_at DESC
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
      `SELECT batch.id, batch.source_filename AS "sourceFilename",
              batch.source_format AS "sourceFormat", batch.status,
              batch.row_count AS "rowCount", batch.valid_count AS "validCount",
              batch.error_count AS "errorCount", batch.created_at AS "createdAt",
              batch.committed_at AS "committedAt", batch.published_at AS "publishedAt",
              COALESCE(stats.drafted_count, 0)::int AS "draftedCount",
              COALESCE(stats.pending_valid_count, 0)::int AS "pendingValidCount",
              COALESCE(stats.unresolved_count, 0)::int AS "unresolvedCount",
              COALESCE(stats.excluded_count, 0)::int AS "excludedCount"
         FROM payslip_import_batches batch
         LEFT JOIN LATERAL (
           SELECT count(*) FILTER (WHERE resolution_status = 'drafted') AS drafted_count,
                  count(*) FILTER (
                    WHERE resolution_status = 'pending'
                      AND jsonb_array_length(validation_errors) = 0
                  ) AS pending_valid_count,
                  count(*) FILTER (
                    WHERE resolution_status = 'pending'
                      AND jsonb_array_length(validation_errors) > 0
                  ) AS unresolved_count,
                  count(*) FILTER (WHERE resolution_status = 'excluded') AS excluded_count
             FROM payslip_import_rows
            WHERE batch_id = batch.id
         ) stats ON true
        WHERE batch.id = $1`,
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
              validation_errors AS errors,
              resolution_status AS "resolutionStatus",
              draft_payslip_id AS "draftPayslipId",
              excluded_at AS "excludedAt"
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

  app.patch("/admin/payslip-imports/:batchId/rows", async (request, reply) => {
    const principal = await requireCapability(request, reply, "payslips.import");
    if (!principal) return;
    const params = batchIdSchema.safeParse(request.params);
    const body = bulkImportRowCorrectionSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({
        code: "INVALID_BULK_IMPORT_ROW_CORRECTION",
        message: "Bulk correction membutuhkan maksimal 500 row unik dengan NIP/nomor pegawai dan periode YYYY-MM.",
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const batch = await client.query<{ status: string }>(
        `SELECT status
           FROM payslip_import_batches
          WHERE id = $1
          FOR UPDATE`,
        [params.data.batchId],
      );
      if (!batch.rows[0]) {
        await client.query("ROLLBACK");
        return reply.status(404).send({
          code: "BATCH_NOT_FOUND",
          message: "Batch payslip tidak ditemukan.",
        });
      }
      if (batch.rows[0].status === "published") {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "BATCH_ALREADY_PUBLISHED",
          message: "Batch yang sudah dipublish tidak dapat dikoreksi.",
        });
      }

      const rowNumbers = body.data.rows.map((row) => row.rowNumber);
      const locked = await client.query<{
        rowNumber: number;
        resolutionStatus: PayslipRowResolutionStatus;
        lines: ImportedLine[] | null;
        errors: string[];
      }>(
        `SELECT row_number AS "rowNumber",
                resolution_status AS "resolutionStatus",
                lines,
                validation_errors AS errors
           FROM payslip_import_rows
          WHERE batch_id = $1
            AND row_number = ANY($2::int[])
          FOR UPDATE`,
        [params.data.batchId, rowNumbers],
      );
      if (locked.rows.length !== rowNumbers.length) {
        await client.query("ROLLBACK");
        return reply.status(404).send({
          code: "IMPORT_ROW_NOT_FOUND",
          message: "Satu atau lebih baris import tidak ditemukan.",
        });
      }
      if (locked.rows.some((row) => row.resolutionStatus !== "pending")) {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "IMPORT_ROW_NOT_EDITABLE",
          message: "Bulk correction hanya menerima baris yang masih pending.",
        });
      }

      const currentByNumber = new Map(locked.rows.map((row) => [row.rowNumber, row]));
      const updatedRows: unknown[] = [];
      let validAfterCorrection = 0;

      for (const correction of body.data.rows) {
        const current = currentByNumber.get(correction.rowNumber)!;
        const validated = await revalidateImportRow(client, {
          batchId: params.data.batchId,
          rowNumber: correction.rowNumber,
          employeeNumber: correction.employeeNumber,
          period: correction.period,
          lines: current.lines,
          previousErrors: current.errors,
        });
        if (validated.errors.length === 0) validAfterCorrection += 1;

        const updated = await client.query(
          `UPDATE payslip_import_rows
              SET employee_number = $3,
                  employee_id = $4,
                  period = $5::date,
                  validation_errors = $6::jsonb
            WHERE batch_id = $1
              AND row_number = $2
              AND resolution_status = 'pending'
          RETURNING row_number AS "rowNumber", employee_number AS "employeeNumber",
                    to_char(period, 'YYYY-MM') AS period, lines,
                    validation_errors AS errors,
                    resolution_status AS "resolutionStatus",
                    draft_payslip_id AS "draftPayslipId",
                    excluded_at AS "excludedAt"`,
          [
            params.data.batchId,
            correction.rowNumber,
            correction.employeeNumber,
            validated.employeeId,
            validated.period,
            JSON.stringify(validated.errors),
          ],
        );
        updatedRows.push(updated.rows[0]);
      }

      await refreshBatchValidationCounts(client, params.data.batchId);
      await writeAudit(client, principal.id, "payslip.import.rows_bulk_corrected", {
        batchId: params.data.batchId,
        payload: {
          rowCount: body.data.rows.length,
          validAfterCorrection,
        },
      });
      await client.query("COMMIT");
      reply.header("Cache-Control", "private, no-store");
      return reply.send({
        updatedCount: body.data.rows.length,
        rows: updatedRows,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.post("/admin/payslip-imports/:batchId/rows/exclude", async (request, reply) => {
    const principal = await requireCapability(request, reply, "payslips.import");
    if (!principal) return;
    const params = batchIdSchema.safeParse(request.params);
    const body = bulkImportRowExcludeSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({
        code: "INVALID_BULK_IMPORT_ROW_EXCLUSION",
        message: "Pilih 1 sampai 500 nomor baris unik untuk dihapus dari batch.",
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const batch = await client.query<{ status: string }>(
        `SELECT status
           FROM payslip_import_batches
          WHERE id = $1
          FOR UPDATE`,
        [params.data.batchId],
      );
      if (!batch.rows[0]) {
        await client.query("ROLLBACK");
        return reply.status(404).send({
          code: "BATCH_NOT_FOUND",
          message: "Batch payslip tidak ditemukan.",
        });
      }
      if (batch.rows[0].status === "published") {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "BATCH_ALREADY_PUBLISHED",
          message: "Batch yang sudah dipublish tidak dapat diubah.",
        });
      }

      const locked = await client.query<{ rowNumber: number; resolutionStatus: PayslipRowResolutionStatus }>(
        `SELECT row_number AS "rowNumber", resolution_status AS "resolutionStatus"
           FROM payslip_import_rows
          WHERE batch_id = $1
            AND row_number = ANY($2::int[])
          FOR UPDATE`,
        [params.data.batchId, body.data.rowNumbers],
      );
      if (locked.rows.length !== body.data.rowNumbers.length) {
        await client.query("ROLLBACK");
        return reply.status(404).send({
          code: "IMPORT_ROW_NOT_FOUND",
          message: "Satu atau lebih baris import tidak ditemukan.",
        });
      }
      if (locked.rows.some((row) => row.resolutionStatus !== "pending")) {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "IMPORT_ROW_NOT_EXCLUDABLE",
          message: "Hanya baris pending yang dapat dihapus dari batch.",
        });
      }

      const excluded = await client.query(
        `UPDATE payslip_import_rows
            SET resolution_status = 'excluded',
                excluded_by_account_id = $3,
                excluded_at = now()
          WHERE batch_id = $1
            AND row_number = ANY($2::int[])
            AND resolution_status = 'pending'
        RETURNING row_number`,
        [params.data.batchId, body.data.rowNumbers, principal.id],
      );
      await refreshBatchValidationCounts(client, params.data.batchId);
      await writeAudit(client, principal.id, "payslip.import.rows_bulk_excluded", {
        batchId: params.data.batchId,
        payload: { rowCount: excluded.rowCount ?? excluded.rows.length },
      });
      await client.query("COMMIT");
      reply.header("Cache-Control", "private, no-store");
      return reply.send({ excludedCount: excluded.rowCount ?? excluded.rows.length });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.patch("/admin/payslip-imports/:batchId/rows/:rowNumber", async (request, reply) => {
    const principal = await requireCapability(request, reply, "payslips.import");
    if (!principal) return;
    const params = importRowParamsSchema.safeParse(request.params);
    const body = importRowCorrectionSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({
        code: "INVALID_IMPORT_ROW_CORRECTION",
        message: "NIP/nomor pegawai dan periode YYYY-MM wajib diisi dengan format yang valid.",
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const batch = await client.query<{ status: string }>(
        `SELECT status
           FROM payslip_import_batches
          WHERE id = $1
          FOR UPDATE`,
        [params.data.batchId],
      );
      if (!batch.rows[0]) {
        await client.query("ROLLBACK");
        return reply.status(404).send({
          code: "BATCH_NOT_FOUND",
          message: "Batch payslip tidak ditemukan.",
        });
      }
      if (batch.rows[0].status === "published") {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "BATCH_ALREADY_PUBLISHED",
          message: "Batch yang sudah dipublish tidak dapat dikoreksi.",
        });
      }

      const row = await client.query<{
        resolutionStatus: PayslipRowResolutionStatus;
        lines: ImportedLine[] | null;
        errors: string[];
      }>(
        `SELECT resolution_status AS "resolutionStatus", lines,
                validation_errors AS errors
           FROM payslip_import_rows
          WHERE batch_id = $1
            AND row_number = $2
          FOR UPDATE`,
        [params.data.batchId, params.data.rowNumber],
      );
      const current = row.rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return reply.status(404).send({
          code: "IMPORT_ROW_NOT_FOUND",
          message: "Baris import tidak ditemukan.",
        });
      }
      if (current.resolutionStatus !== "pending") {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "IMPORT_ROW_NOT_EDITABLE",
          message: "Hanya baris yang masih Perlu tindakan/Siap draft yang dapat diperbaiki.",
        });
      }

      const validated = await revalidateImportRow(client, {
        batchId: params.data.batchId,
        rowNumber: params.data.rowNumber,
        employeeNumber: body.data.employeeNumber,
        period: body.data.period,
        lines: current.lines,
        previousErrors: current.errors,
      });

      const updated = await client.query(
        `UPDATE payslip_import_rows
            SET employee_number = $3,
                employee_id = $4,
                period = $5::date,
                validation_errors = $6::jsonb
          WHERE batch_id = $1
            AND row_number = $2
        RETURNING row_number AS "rowNumber", employee_number AS "employeeNumber",
                  to_char(period, 'YYYY-MM') AS period, lines,
                  validation_errors AS errors,
                  resolution_status AS "resolutionStatus",
                  draft_payslip_id AS "draftPayslipId",
                  excluded_at AS "excludedAt"`,
        [
          params.data.batchId,
          params.data.rowNumber,
          body.data.employeeNumber,
          validated.employeeId,
          validated.period,
          JSON.stringify(validated.errors),
        ],
      );
      await refreshBatchValidationCounts(client, params.data.batchId);
      await writeAudit(client, principal.id, "payslip.import.row_corrected", {
        batchId: params.data.batchId,
        employeeId: validated.employeeId,
        payload: {
          rowNumber: params.data.rowNumber,
          validAfterCorrection: validated.errors.length === 0,
        },
      });
      await client.query("COMMIT");
      reply.header("Cache-Control", "private, no-store");
      return reply.send(updated.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.delete("/admin/payslip-imports/:batchId/rows/:rowNumber", async (request, reply) => {
    const principal = await requireCapability(request, reply, "payslips.import");
    if (!principal) return;
    const params = importRowParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        code: "INVALID_IMPORT_ROW",
        message: "Batch ID atau nomor baris tidak valid.",
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const batch = await client.query<{ status: string }>(
        `SELECT status
           FROM payslip_import_batches
          WHERE id = $1
          FOR UPDATE`,
        [params.data.batchId],
      );
      if (!batch.rows[0]) {
        await client.query("ROLLBACK");
        return reply.status(404).send({
          code: "BATCH_NOT_FOUND",
          message: "Batch payslip tidak ditemukan.",
        });
      }
      if (batch.rows[0].status === "published") {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "BATCH_ALREADY_PUBLISHED",
          message: "Batch yang sudah dipublish tidak dapat diubah.",
        });
      }

      const updated = await client.query(
        `UPDATE payslip_import_rows
            SET resolution_status = 'excluded',
                excluded_by_account_id = $3,
                excluded_at = now()
          WHERE batch_id = $1
            AND row_number = $2
            AND resolution_status = 'pending'
        RETURNING row_number AS "rowNumber", employee_number AS "employeeNumber",
                  to_char(period, 'YYYY-MM') AS period, lines,
                  validation_errors AS errors,
                  resolution_status AS "resolutionStatus",
                  draft_payslip_id AS "draftPayslipId",
                  excluded_at AS "excludedAt"`,
        [params.data.batchId, params.data.rowNumber, principal.id],
      );
      if (!updated.rows[0]) {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "IMPORT_ROW_NOT_EXCLUDABLE",
          message: "Baris tidak ditemukan atau sudah masuk draft/dihapus dari batch.",
        });
      }
      await refreshBatchValidationCounts(client, params.data.batchId);
      await writeAudit(client, principal.id, "payslip.import.row_excluded", {
        batchId: params.data.batchId,
        payload: { rowNumber: params.data.rowNumber },
      });
      await client.query("COMMIT");
      reply.header("Cache-Control", "private, no-store");
      return reply.send(updated.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
      const batch = await client.query<{ status: string; sourceFormat: PayslipSourceFormat }>(
        `SELECT status, source_format AS "sourceFormat"
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
      if (!["previewed", "committed"].includes(current.status)) {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "INVALID_BATCH_STATE",
          message: "Batch yang sudah dipublish tidak dapat di-commit lagi.",
        });
      }

      await client.query(
        `WITH conflict_rows AS (
           SELECT imported.id
             FROM payslip_import_rows imported
             JOIN payslips payslip
               ON payslip.employee_id = imported.employee_id
              AND payslip.period = imported.period
            WHERE imported.batch_id = $1
              AND imported.resolution_status = 'pending'
              AND jsonb_array_length(imported.validation_errors) = 0
         )
         UPDATE payslip_import_rows imported
            SET validation_errors =
                CASE
                  WHEN imported.validation_errors ? 'payslip untuk employee dan period sudah ada'
                    THEN imported.validation_errors
                  ELSE imported.validation_errors || to_jsonb('payslip untuk employee dan period sudah ada'::text)
                END
           FROM conflict_rows conflict
          WHERE imported.id = conflict.id`,
        [parsed.data.batchId],
      );
      await refreshBatchValidationCounts(client, parsed.data.batchId);

      const importRows = await client.query<ImportRowRecord>(
        `SELECT id, row_number AS "rowNumber", employee_id AS "employeeId",
                period::text AS period, lines
           FROM payslip_import_rows
          WHERE batch_id = $1
            AND resolution_status = 'pending'
            AND jsonb_array_length(validation_errors) = 0
          ORDER BY row_number
          FOR UPDATE`,
        [parsed.data.batchId],
      );
      if (importRows.rows.length === 0) {
        await client.query("COMMIT");
        return reply.status(409).send({
          code: "NO_READY_PAYSLIP_ROWS",
          message: "Tidak ada baris valid yang siap dimasukkan ke draft.",
        });
      }

      const chunkSize = 300;
      for (let offset = 0; offset < importRows.rows.length; offset += chunkSize) {
        const chunk = importRows.rows.slice(offset, offset + chunkSize);
        const values: unknown[] = [];
        const tuples: string[] = [];
        const rowIds: string[] = [];
        const payslipIds: string[] = [];

        chunk.forEach((row, index) => {
          const base = index * 6;
          const payslipId = randomUUID();
          payslipIds.push(payslipId);
          rowIds.push(row.id);
          values.push(
            payslipId,
            row.employeeId,
            row.period,
            JSON.stringify(row.lines),
            current.sourceFormat,
            parsed.data.batchId,
          );
          tuples.push(
            `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb, $${base + 5}, $${base + 6})`,
          );
        });

        await client.query(
          `INSERT INTO payslips
            (id, employee_id, period, lines, source_format, source_batch_id)
           VALUES ${tuples.join(", ")}`,
          values,
        );
        await client.query(
          `UPDATE payslip_import_rows imported
              SET resolution_status = 'drafted',
                  draft_payslip_id = mapping.payslip_id
             FROM unnest($1::uuid[], $2::uuid[]) AS mapping(row_id, payslip_id)
            WHERE imported.id = mapping.row_id
              AND imported.resolution_status = 'pending'`,
          [rowIds, payslipIds],
        );
      }

      await client.query(
        `UPDATE payslip_import_batches
            SET status = 'committed',
                committed_by_account_id = COALESCE(committed_by_account_id, $2),
                committed_at = COALESCE(committed_at, now())
          WHERE id = $1`,
        [parsed.data.batchId, principal.id],
      );
      await refreshBatchValidationCounts(client, parsed.data.batchId);
      const stats = await client.query<{
        draftedCount: number;
        pendingValidCount: number;
        unresolvedCount: number;
        excludedCount: number;
      }>(
        `SELECT count(*) FILTER (WHERE resolution_status = 'drafted')::int AS "draftedCount",
                count(*) FILTER (
                  WHERE resolution_status = 'pending'
                    AND jsonb_array_length(validation_errors) = 0
                )::int AS "pendingValidCount",
                count(*) FILTER (
                  WHERE resolution_status = 'pending'
                    AND jsonb_array_length(validation_errors) > 0
                )::int AS "unresolvedCount",
                count(*) FILTER (WHERE resolution_status = 'excluded')::int AS "excludedCount"
           FROM payslip_import_rows
          WHERE batch_id = $1`,
        [parsed.data.batchId],
      );
      await writeAudit(client, principal.id, "payslip.import.committed", {
        batchId: parsed.data.batchId,
        payload: {
          draftedNow: importRows.rows.length,
          draftedCount: stats.rows[0]?.draftedCount ?? importRows.rows.length,
          unresolvedCount: stats.rows[0]?.unresolvedCount ?? 0,
          excludedCount: stats.rows[0]?.excludedCount ?? 0,
        },
      });
      await client.query("COMMIT");

      reply.header("Cache-Control", "no-store");
      return reply.send({
        batchId: parsed.data.batchId,
        status: "committed",
        draftedNow: importRows.rows.length,
        ...(stats.rows[0] ?? {}),
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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

      const pending = await client.query<{ total: number; unresolved: number; ready: number }>(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE jsonb_array_length(validation_errors) > 0)::int AS unresolved,
                count(*) FILTER (WHERE jsonb_array_length(validation_errors) = 0)::int AS ready
           FROM payslip_import_rows
          WHERE batch_id = $1
            AND resolution_status = 'pending'`,
        [parsed.data.batchId],
      );
      if ((pending.rows[0]?.total ?? 0) > 0) {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "BATCH_HAS_PENDING_ROWS",
          message:
            (pending.rows[0]?.unresolved ?? 0) > 0
              ? "Masih ada baris Perlu tindakan. Perbaiki atau Hapus dari batch sebelum publish."
              : "Masih ada baris valid yang belum masuk draft. Masukkan ke draft sebelum publish.",
        });
      }

      const draftCount = await client.query<{ total: number }>(
        `SELECT count(*)::int AS total
           FROM payslips
          WHERE source_batch_id = $1
            AND published_at IS NULL`,
        [parsed.data.batchId],
      );
      if ((draftCount.rows[0]?.total ?? 0) === 0) {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "BATCH_HAS_NO_DRAFTS",
          message: "Batch tidak memiliki slip draft untuk dipublish.",
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

    const signer = await resolvePayslipSigner(pool, self.employeeId);
    await writeAudit(pool, self.principal.id, "payslip.read", {
      payslipId: payslip.id,
      employeeId: self.employeeId,
      payload: { period: payslip.period },
    });
    reply.header("Cache-Control", "private, no-store");
    return reply.send({ ...payslip, signer });
  });
}
