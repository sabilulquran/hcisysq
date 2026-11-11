// DOC-003 Package 1 routes: outgoing letter numbering register (buku nomor surat keluar).
// Spec: docs/domain/outgoing-letter-register.md.
//
// /letters/me/* is grant-based self service: the employee comes from the session and the right to
// take a number is a letter_number_grants row, not a permission (D-07). /admin/letters/* reuses
// documents.read / documents.manage (D-11), resolved from the organization context like the rest
// of the documents module, so legacy Super Admin compatibility never reaches it.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { quoteCsvCell } from "../../lib/csv.js";
import { pageOffset, pageQuerySchema, pagination } from "../../lib/pagination.js";
import type { DocumentPermission } from "../auth/permissions.js";
import { AUTH_COOKIE_NAME, AuthService, readCookie, type AuthPrincipal } from "../auth/service.js";
import {
  LETTER_EXPORT_LIMIT,
  LETTER_ISSUER_CODE,
  LETTER_ISSUER_KINDS,
  LETTER_RESET_PERIODS,
  LETTER_TYPE_CODE,
  LetterError,
  allocateLetterNumber,
  letterLikePattern,
  letterToday,
  writeLetterAudit,
  type LetterResetPeriod,
} from "./letters.js";

const uuid = z.string().uuid();
/** Length in characters (code points), as the CHECK constraints count it, not UTF-16 units. */
const text = (min: number, max: number) => z.string().trim()
  .refine((value) => { const length = [...value].length; return length >= min && length <= max; }, {
    message: `Panjang ${min}–${max} karakter.`,
  });
const optionalText = (max: number) => text(0, max).optional().transform((value) => value || undefined);
const search = z.string().trim().min(2).max(100).optional();

const allocateBody = z.object({
  issuerId: uuid,
  typeCode: z.string().trim().regex(LETTER_TYPE_CODE),
  subject: text(3, 300),
  recipient: text(2, 300),
  notes: optionalText(1000),
});
const editBody = z.object({
  subject: text(3, 300).optional(),
  recipient: text(2, 300).optional(),
  // null clears the note.
  notes: z.union([text(0, 1000), z.null()]).optional(),
  version: z.number().int().min(1),
}).refine((value) => value.subject !== undefined || value.recipient !== undefined || value.notes !== undefined, {
  message: "Tidak ada perubahan.",
});
const voidBody = z.object({ reason: text(10, 500) });
const idParams = z.object({ id: uuid });
const codeParams = z.object({ code: z.string().regex(LETTER_TYPE_CODE) });

const myNumbersQuery = pageQuerySchema.extend({
  issuerId: uuid.optional(),
  status: z.enum(["ALLOCATED", "VOIDED"]).optional(),
  q: search,
});

const registerFilter = z.object({
  source: z.enum(["ALL", "BOOK", "HCIS"]).default("ALL"),
  issuerCode: z.string().trim().toUpperCase().regex(LETTER_ISSUER_CODE).optional(),
  typeCode: z.string().trim().regex(LETTER_TYPE_CODE).optional(),
  status: z.enum(["ACTIVE", "VOIDED"]).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  q: search,
});
const registerQuery = pageQuerySchema.merge(registerFilter);

const typeBody = z.object({
  code: z.string().trim().regex(LETTER_TYPE_CODE),
  label: text(2, 120),
  resetPeriod: z.enum(LETTER_RESET_PERIODS).default("YEARLY"),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});
const typePatch = z.object({
  label: text(2, 120).optional(),
  resetPeriod: z.enum(LETTER_RESET_PERIODS).optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
}).refine((value) => Object.values(value).some((field) => field !== undefined), { message: "Tidak ada perubahan." });

const issuerBody = z.object({
  code: z.string().trim().regex(LETTER_ISSUER_CODE),
  name: text(2, 200),
  kind: z.enum(LETTER_ISSUER_KINDS),
  organizationalUnitId: uuid.optional(),
  committeeId: uuid.optional(),
});
const issuerPatch = z.object({
  name: text(2, 200).optional(),
  active: z.boolean().optional(),
}).refine((value) => value.name !== undefined || value.active !== undefined, { message: "Tidak ada perubahan." });
const issuersQuery = pageQuerySchema.extend({
  // Exact code, for forms that name an issuer by its code (one-character codes included).
  code: z.string().trim().toUpperCase().regex(LETTER_ISSUER_CODE).optional(),
  q: search,
  active: z.enum(["true", "false"]).optional(),
});
const targetQuery = z.object({ kind: z.enum(["UNIT", "COMMITTEE"]), q: z.string().trim().min(2).max(100) });

const grantBody = z.object({
  employeeId: uuid,
  issuerId: uuid,
  reason: text(5, 500),
});
const grantRevokeBody = z.object({ reason: text(5, 500) });
const grantsQuery = pageQuerySchema.extend({
  issuerCode: z.string().trim().toUpperCase().regex(LETTER_ISSUER_CODE).optional(),
  active: z.enum(["true", "false"]).default("true"),
  q: search,
});
const optionsQuery = z.object({ q: z.string().trim().min(2).max(100) });

const counterQuery = z.object({
  issuerId: uuid,
  typeCode: z.string().trim().regex(LETTER_TYPE_CODE),
  periodKey: z.string().regex(/^\d{4}(-(0[1-9]|1[0-2]))?$/),
});
const counterBody = counterQuery.extend({ lastSequence: z.number().int().min(1).max(99_999) });

function send(reply: FastifyReply, status: number, body: unknown) {
  reply.header("Cache-Control", "no-store");
  return reply.status(status).send(body);
}

function invalid(reply: FastifyReply, message = "Data tidak valid.") {
  return send(reply, 400, { code: "INVALID_LETTER_REQUEST", message });
}

function isUniqueViolation(error: unknown, constraint?: string) {
  const pgError = error as { code?: string; constraint?: string };
  return pgError?.code === "23505" && (!constraint || pgError.constraint === constraint);
}

const NUMBER_COLUMNS = `
  n.id, n.letter_number AS "letterNumber", to_char(n.letter_date, 'YYYY-MM-DD') AS "letterDate",
  n.issuer_id AS "issuerId", issuer.code AS "issuerCode", issuer.name AS "issuerName",
  n.type_code AS "typeCode", type.label AS "typeLabel", n.subject, n.recipient, n.notes, n.status,
  n.voided_at AS "voidedAt", n.void_reason AS "voidReason", n.version, n.created_at AS "createdAt",
  requester.full_name AS "requestedByName"`;
const NUMBER_FROM = `
  FROM letter_numbers n
  JOIN letter_issuers issuer ON issuer.id = n.issuer_id
  JOIN letter_types type ON type.code = n.type_code
  JOIN employees requester ON requester.id = n.requested_by_employee_id`;

type RegisterFilter = z.infer<typeof registerFilter>;

/**
 * §5.4: the book and the letters HCIS issued itself (D-10), in one stable order. Every filter runs
 * before LIMIT and the count uses the same rows. An HCIS row carries register facts only (D-12):
 * no employee, no recipient. An issuer or type filter names a book issuer/type, so it hides HCIS rows.
 */
function registerRows(filter: RegisterFilter) {
  const values: unknown[] = [];
  const param = (value: unknown) => { values.push(value); return `$${values.length}`; };
  const book: string[] = [];
  const hcis: string[] = [];
  if (filter.issuerCode) book.push(`issuer.code = ${param(filter.issuerCode)}`);
  if (filter.typeCode) book.push(`n.type_code = ${param(filter.typeCode)}`);
  if (filter.status) {
    const status = param(filter.status);
    book.push(`(CASE WHEN n.status = 'VOIDED' THEN 'VOIDED' ELSE 'ACTIVE' END) = ${status}`);
    hcis.push(`(CASE WHEN d.status = 'REVOKED' THEN 'VOIDED' ELSE 'ACTIVE' END) = ${status}`);
  }
  if (filter.year) {
    const year = param(filter.year);
    book.push(`extract(year FROM n.letter_date)::int = ${year}`);
    hcis.push(`extract(year FROM (d.issued_at AT TIME ZONE 'Asia/Jakarta'))::int = ${year}`);
  }
  if (filter.q) {
    const like = param(letterLikePattern(filter.q));
    book.push(`(n.letter_number ILIKE ${like} ESCAPE '\\' OR n.subject ILIKE ${like} ESCAPE '\\' OR n.recipient ILIKE ${like} ESCAPE '\\')`);
    hcis.push(`d.document_number ILIKE ${like} ESCAPE '\\'`);
  }
  const includeBook = filter.source !== "HCIS";
  const includeHcis = filter.source !== "BOOK" && !filter.issuerCode && !filter.typeCode;
  const where = (clauses: string[]) => (clauses.length ? `WHERE ${clauses.join(" AND ")}` : "");
  const parts: string[] = [];
  if (includeBook) {
    parts.push(`
      SELECT 'BOOK'::text AS source, n.id, n.letter_number AS "letterNumber", n.letter_date AS sort_date,
             n.created_at AS sort_at,
             to_char(n.letter_date, 'YYYY-MM-DD') AS "letterDate", issuer.code AS "issuerCode",
             issuer.name AS "issuerName", n.type_code AS "typeCode", type.label AS "typeLabel",
             n.subject, n.recipient, CASE WHEN n.status = 'VOIDED' THEN 'VOIDED' ELSE 'ACTIVE' END AS status,
             n.voided_at AS "voidedAt", n.void_reason AS "voidReason", requester.full_name AS "requestedByName",
             n.version
      ${NUMBER_FROM}
      ${where(book)}`);
  }
  if (includeHcis) {
    parts.push(`
      SELECT 'HCIS'::text AS source, d.id, d.document_number AS "letterNumber",
             (d.issued_at AT TIME ZONE 'Asia/Jakarta')::date AS sort_date, d.issued_at AS sort_at,
             to_char(d.issued_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD') AS "letterDate",
             NULL::text AS "issuerCode", 'HCIS'::text AS "issuerName", d.number_code AS "typeCode",
             CASE d.document_kind
               WHEN 'CERTIFICATE' THEN coalesce(document_type.label, 'Surat Keterangan')
               WHEN 'DISCIPLINARY' THEN 'Surat Peringatan'
               WHEN 'ASSIGNMENT' THEN 'Surat Tugas'
               WHEN 'COMMITTEE' THEN 'SK Panitia'
               ELSE d.document_kind END AS "typeLabel",
             CASE d.document_kind
               WHEN 'CERTIFICATE' THEN coalesce(document_type.label, 'Surat Keterangan')
               WHEN 'DISCIPLINARY' THEN 'Surat Peringatan'
               WHEN 'ASSIGNMENT' THEN 'Surat Tugas'
               WHEN 'COMMITTEE' THEN 'SK Panitia'
               ELSE d.document_kind END AS subject,
             NULL::text AS recipient, CASE WHEN d.status = 'REVOKED' THEN 'VOIDED' ELSE 'ACTIVE' END AS status,
             d.revoked_at AS "voidedAt", d.revoke_reason AS "voidReason", NULL::text AS "requestedByName",
             NULL::int AS version
        FROM hr_issued_documents d
        LEFT JOIN hr_document_types document_type ON document_type.code = d.document_code
      ${where(hcis)}`);
  }
  if (!parts.length) return null;
  return { sql: parts.join(" UNION ALL "), values };
}

export async function registerLetterRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
  injectedAuth?: Pick<AuthService, "getSession" | "getAuthorizationContext">,
) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required for letter routes");
  const auth = injectedAuth ?? new AuthService(
    pool, config.AUTH_ENCRYPTION_KEY, config.AUTH_SESSION_TTL_HOURS, config.NODE_ENV === "production",
  );

  async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<AuthPrincipal | null> {
    const session = await auth.getSession(readCookie(request.headers.cookie, AUTH_COOKIE_NAME));
    if (!session) {
      await send(reply, 401, { code: "UNAUTHENTICATED", message: "Sesi tidak ditemukan atau sudah berakhir." });
      return null;
    }
    return session.principal;
  }

  async function requirePermission(request: FastifyRequest, reply: FastifyReply, permission: DocumentPermission) {
    const principal = await authenticate(request, reply);
    if (!principal) return null;
    const context = await auth.getAuthorizationContext(principal);
    if (!context.organizationPermissions.includes(permission)) {
      await send(reply, 403, { code: "DOCUMENT_FORBIDDEN", message: "Anda tidak memiliki akses untuk tindakan ini." });
      return null;
    }
    return { principal, canManage: context.organizationPermissions.includes("documents.manage") };
  }

  /** The employee comes from the session; an inactive account or employee takes no number. */
  async function requireSelf(request: FastifyRequest, reply: FastifyReply) {
    const principal = await authenticate(request, reply);
    if (!principal) return null;
    if (principal.principalType !== "EMPLOYEE") {
      await send(reply, 403, { code: "FORBIDDEN", message: "Nomor surat hanya tersedia untuk pegawai." });
      return null;
    }
    const result = await pool.query<{ employeeId: string }>(
      `SELECT account.employee_id AS "employeeId"
         FROM accounts account
         JOIN employees employee ON employee.id = account.employee_id
        WHERE account.id = $1 AND account.principal_type = 'EMPLOYEE' AND account.status = 'active'
          AND employee.status = 'active' AND employee.removed_at IS NULL
        LIMIT 1`,
      [principal.id],
    );
    const employeeId = result.rows[0]?.employeeId;
    if (!employeeId) {
      await send(reply, 403, { code: "EMPLOYEE_LINK_REQUIRED", message: "Account employee tidak terhubung ke employee aktif." });
      return null;
    }
    return { principal, employeeId };
  }

  async function transact<T>(reply: FastifyReply, work: (client: PoolClient) => Promise<[number, T]>) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const [status, body] = await work(client);
      await client.query("COMMIT");
      return send(reply, status, body);
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof LetterError) return send(reply, error.statusCode, { code: error.code, message: error.message });
      throw error;
    } finally {
      client.release();
    }
  }

  async function loadNumber(db: Pool | PoolClient, id: string) {
    const result = await db.query(`SELECT ${NUMBER_COLUMNS}, n.requested_by_employee_id AS "requestedByEmployeeId" ${NUMBER_FROM} WHERE n.id = $1`, [id]);
    return result.rows[0] as (Record<string, unknown> & { requestedByEmployeeId: string; status: string; version: number }) | undefined;
  }

  /** §5.2: subject, recipient and notes only; the number, issuer, type and date never change. */
  async function editNumber(
    client: PoolClient,
    input: { id: string; actorAccountId: string; ownerEmployeeId: string | null; body: z.infer<typeof editBody> },
  ): Promise<[number, unknown]> {
    const current = await client.query<{
      status: string; version: number; owner: string; issuerId: string; subject: string; recipient: string; notes: string | null;
    }>(
      `SELECT status, version, requested_by_employee_id AS owner, issuer_id AS "issuerId", subject, recipient, notes
         FROM letter_numbers WHERE id = $1 FOR UPDATE`,
      [input.id],
    );
    const row = current.rows[0];
    if (!row || (input.ownerEmployeeId && row.owner !== input.ownerEmployeeId)) {
      throw new LetterError(404, "LETTER_NOT_FOUND", "Nomor surat tidak ditemukan.");
    }
    if (row.status !== "ALLOCATED") throw new LetterError(409, "LETTER_NOT_EDITABLE", "Nomor surat yang sudah dibatalkan tidak dapat diubah.");
    if (row.version !== input.body.version) {
      throw new LetterError(409, "LETTER_VERSION_CONFLICT", "Nomor surat sudah diubah orang lain. Muat ulang lalu coba lagi.");
    }
    const next = {
      subject: input.body.subject ?? row.subject,
      recipient: input.body.recipient ?? row.recipient,
      notes: input.body.notes === undefined ? row.notes : (input.body.notes || null),
    };
    const changed = (["subject", "recipient", "notes"] as const).filter((field) => next[field] !== row[field]);
    if (!changed.length) return [200, await loadNumber(client, input.id)];
    await client.query(
      `UPDATE letter_numbers
          SET subject = $2, recipient = $3, notes = $4, version = version + 1, updated_at = now()
        WHERE id = $1`,
      [input.id, next.subject, next.recipient, next.notes],
    );
    await writeLetterAudit(client, {
      eventType: "letter.updated", letterNumberId: input.id, issuerId: row.issuerId,
      actorAccountId: input.actorAccountId, metadata: { fields: changed },
    });
    return [200, await loadNumber(client, input.id)];
  }

  /** §5.3 / D-08: the number stays taken; only the status changes. */
  async function voidNumber(
    client: PoolClient,
    input: { id: string; actorAccountId: string; ownerEmployeeId: string | null; reason: string },
  ): Promise<[number, unknown]> {
    const current = await client.query<{ status: string; owner: string; issuerId: string; letterNumber: string }>(
      `SELECT status, requested_by_employee_id AS owner, issuer_id AS "issuerId", letter_number AS "letterNumber"
         FROM letter_numbers WHERE id = $1 FOR UPDATE`,
      [input.id],
    );
    const row = current.rows[0];
    if (!row || (input.ownerEmployeeId && row.owner !== input.ownerEmployeeId)) {
      throw new LetterError(404, "LETTER_NOT_FOUND", "Nomor surat tidak ditemukan.");
    }
    if (row.status !== "ALLOCATED") throw new LetterError(409, "LETTER_NOT_VOIDABLE", "Nomor surat ini sudah dibatalkan.");
    await client.query(
      `UPDATE letter_numbers
          SET status = 'VOIDED', voided_at = now(), voided_by_account_id = $2, void_reason = $3,
              version = version + 1, updated_at = now()
        WHERE id = $1`,
      [input.id, input.actorAccountId, input.reason],
    );
    await writeLetterAudit(client, {
      eventType: "letter.voided", letterNumberId: input.id, issuerId: row.issuerId,
      actorAccountId: input.actorAccountId, reason: input.reason, metadata: { letterNumber: row.letterNumber },
    });
    return [200, await loadNumber(client, input.id)];
  }

  // ---------------------------------------------------------------- employee

  app.get("/letters/me/options", async (request, reply) => {
    const self = await requireSelf(request, reply);
    if (!self) return;
    // Bounded by the caller's own grants; types are the small HC-managed catalog.
    const [issuers, types] = await Promise.all([
      pool.query(
        `SELECT issuer.id, issuer.code, issuer.name, issuer.kind,
                (issuer.active AND (issuer.committee_id IS NULL OR committee.status = 'ACTIVE')) AS available
           FROM letter_number_grants grant_row
           JOIN letter_issuers issuer ON issuer.id = grant_row.issuer_id
           LEFT JOIN committees committee ON committee.id = issuer.committee_id
          WHERE grant_row.employee_id = $1 AND grant_row.revoked_at IS NULL
          ORDER BY issuer.code ASC`,
        [self.employeeId],
      ),
      pool.query(
        `SELECT code, label, reset_period AS "resetPeriod" FROM letter_types WHERE active ORDER BY sort_order, code`,
      ),
    ]);
    return send(reply, 200, { today: letterToday(), issuers: issuers.rows, types: types.rows });
  });

  app.get("/letters/me/numbers", async (request, reply) => {
    const self = await requireSelf(request, reply);
    if (!self) return;
    const query = myNumbersQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, "Filter tidak valid.");
    // D-13: the books of the issuers this employee holds a grant for, plus every number they took.
    const values: unknown[] = [self.employeeId];
    const clauses = [`(n.requested_by_employee_id = $1 OR n.issuer_id IN (
      SELECT issuer_id FROM letter_number_grants WHERE employee_id = $1 AND revoked_at IS NULL))`];
    if (query.data.issuerId) { values.push(query.data.issuerId); clauses.push(`n.issuer_id = $${values.length}`); }
    if (query.data.status) { values.push(query.data.status); clauses.push(`n.status = $${values.length}`); }
    if (query.data.q) {
      values.push(letterLikePattern(query.data.q));
      const like = `$${values.length}`;
      clauses.push(`(n.letter_number ILIKE ${like} ESCAPE '\\' OR n.subject ILIKE ${like} ESCAPE '\\' OR n.recipient ILIKE ${like} ESCAPE '\\')`);
    }
    const where = `WHERE ${clauses.join(" AND ")}`;
    const [items, count] = await Promise.all([
      pool.query(
        `SELECT ${NUMBER_COLUMNS}, (n.requested_by_employee_id = $1) AS mine
           ${NUMBER_FROM} ${where}
          ORDER BY n.letter_date DESC, n.created_at DESC, n.id DESC
          LIMIT ${query.data.pageSize} OFFSET ${pageOffset(query.data)}`,
        values,
      ),
      pool.query<{ total: number }>(`SELECT count(*)::int AS total ${NUMBER_FROM} ${where}`, values),
    ]);
    return send(reply, 200, { items: items.rows, pagination: pagination(query.data, count.rows[0]?.total ?? 0) });
  });

  app.post("/letters/me/numbers", async (request, reply) => {
    const self = await requireSelf(request, reply);
    if (!self) return;
    const body = allocateBody.safeParse(request.body);
    if (!body.success) return invalid(reply, "Lengkapi penerbit, jenis, perihal (3–300 karakter), dan tujuan surat.");
    return transact(reply, async (client) => {
      // D-07: the grant is checked inside the transaction that takes the number.
      const issuer = await client.query<{ id: string; code: string; active: boolean; committeeStatus: string | null; granted: boolean }>(
        `SELECT issuer.id, issuer.code, issuer.active, committee.status AS "committeeStatus",
                EXISTS (SELECT 1 FROM letter_number_grants grant_row
                         WHERE grant_row.issuer_id = issuer.id AND grant_row.employee_id = $2
                           AND grant_row.revoked_at IS NULL) AS granted
           FROM letter_issuers issuer
           LEFT JOIN committees committee ON committee.id = issuer.committee_id
          WHERE issuer.id = $1`,
        [body.data.issuerId, self.employeeId],
      );
      const found = issuer.rows[0];
      if (!found?.granted) {
        throw new LetterError(403, "LETTER_GRANT_REQUIRED", "Anda belum diberi akses mengambil nomor surat untuk penerbit ini.");
      }
      if (!found.active || (found.committeeStatus !== null && found.committeeStatus !== "ACTIVE")) {
        throw new LetterError(409, "LETTER_ISSUER_INACTIVE", "Penerbit ini sedang tidak aktif, nomor surat tidak dapat diambil.");
      }
      const type = await client.query<{ code: string; resetPeriod: LetterResetPeriod; active: boolean }>(
        `SELECT code, reset_period AS "resetPeriod", active FROM letter_types WHERE code = $1`,
        [body.data.typeCode],
      );
      if (!type.rows[0]?.active) throw new LetterError(409, "LETTER_TYPE_INACTIVE", "Jenis surat ini tidak tersedia.");
      // A collision with an older number (backstop for D-04) aborts the transaction; transact rolls it back.
      const allocated = await allocateLetterNumber(client, {
        issuer: { id: found.id, code: found.code },
        type: type.rows[0],
        subject: body.data.subject,
        recipient: body.data.recipient,
        notes: body.data.notes ?? null,
        employeeId: self.employeeId,
        accountId: self.principal.id,
      }).catch(async (error: unknown) => {
        if (!isUniqueViolation(error)) throw error;
        throw new LetterError(409, "LETTER_NUMBER_CONFLICT",
          "Nomor berikutnya bertabrakan dengan nomor lama. Minta Human Capital menaikkan nomor awal untuk jenis dan periode ini.");
      });
      await writeLetterAudit(client, {
        eventType: "letter.allocated", letterNumberId: allocated.id, issuerId: found.id,
        actorAccountId: self.principal.id,
        metadata: { letterNumber: allocated.letterNumber, typeCode: allocated.typeCode, issuerCode: found.code },
      });
      return [201, allocated];
    });
  });

  app.patch("/letters/me/numbers/:id", async (request, reply) => {
    const self = await requireSelf(request, reply);
    if (!self) return;
    const params = idParams.safeParse(request.params);
    const body = editBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "Perihal 3–300 karakter, tujuan 2–300 karakter, dan versi wajib.");
    return transact(reply, (client) => editNumber(client, {
      id: params.data.id, actorAccountId: self.principal.id, ownerEmployeeId: self.employeeId, body: body.data,
    }));
  });

  app.post("/letters/me/numbers/:id/void", async (request, reply) => {
    const self = await requireSelf(request, reply);
    if (!self) return;
    const params = idParams.safeParse(request.params);
    const body = voidBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "Alasan pembatalan wajib diisi, 10 sampai 500 karakter.");
    return transact(reply, (client) => voidNumber(client, {
      id: params.data.id, actorAccountId: self.principal.id, ownerEmployeeId: self.employeeId, reason: body.data.reason,
    }));
  });

  // ---------------------------------------------------------------- register

  app.get("/admin/letters/register", async (request, reply) => {
    if (!(await requirePermission(request, reply, "documents.read"))) return;
    const query = registerQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, "Filter tidak valid.");
    const rows = registerRows(query.data);
    // An HCIS-only view filtered by a book issuer or type has nothing to show.
    if (!rows) return send(reply, 200, { items: [], pagination: pagination(query.data, 0) });
    const { sql, values } = rows;
    const [items, count] = await Promise.all([
      pool.query(
        `SELECT source, id, "letterNumber", "letterDate", "issuerCode", "issuerName", "typeCode", "typeLabel",
                subject, recipient, status, "voidedAt", "voidReason", "requestedByName", version
           FROM (${sql}) rows
          ORDER BY sort_date DESC, sort_at DESC, id DESC
          LIMIT ${query.data.pageSize} OFFSET ${pageOffset(query.data)}`,
        values,
      ),
      pool.query<{ total: number }>(`SELECT count(*)::int AS total FROM (${sql}) rows`, values),
    ]);
    return send(reply, 200, { items: items.rows, pagination: pagination(query.data, count.rows[0]?.total ?? 0) });
  });

  app.get("/admin/letters/register/export", async (request, reply) => {
    const access = await requirePermission(request, reply, "documents.read");
    if (!access) return;
    const query = registerFilter.safeParse(request.query);
    if (!query.success) return invalid(reply, "Filter tidak valid.");
    const selected = registerRows(query.data);
    const sql = selected?.sql ?? "SELECT NULL::text AS source, NULL::text AS \"letterNumber\", NULL::text AS \"letterDate\", NULL::text AS \"issuerName\", NULL::text AS \"typeLabel\", NULL::text AS subject, NULL::text AS recipient, NULL::text AS status, NULL::text AS \"voidReason\", NULL::text AS \"requestedByName\", NULL::date AS sort_date, NULL::timestamptz AS sort_at, NULL::uuid AS id WHERE false";
    const values = selected?.values ?? [];
    const count = await pool.query<{ total: number }>(`SELECT count(*)::int AS total FROM (${sql}) rows`, values);
    const total = count.rows[0]?.total ?? 0;
    // ENG-LIST-001-H: complete or explicitly refused, never silently cut.
    if (total > LETTER_EXPORT_LIMIT) {
      return send(reply, 422, {
        code: "LETTER_EXPORT_TOO_LARGE",
        message: `Hasil ekspor ${total} baris melebihi batas ${LETTER_EXPORT_LIMIT}. Persempit filter, misalnya per tahun.`,
      });
    }
    const rows = await pool.query<Record<string, string | null>>(
      `SELECT source, "letterNumber", "letterDate", "issuerName", "typeLabel", subject, recipient, status,
              "voidReason", "requestedByName"
         FROM (${sql}) rows
        ORDER BY sort_date DESC, sort_at DESC, id DESC`,
      values,
    );
    await writeLetterAudit(pool, {
      eventType: "letter.register.exported", actorAccountId: access.principal.id,
      metadata: { filter: query.data, rows: rows.rows.length },
    });
    const header = ["Sumber", "Nomor", "Tanggal", "Penerbit", "Jenis", "Perihal", "Tujuan", "Status", "Alasan batal", "Diambil oleh"];
    const lines = [header.map(quoteCsvCell).join(",")];
    for (const row of rows.rows) {
      lines.push([
        row.source === "HCIS" ? "HCIS" : "Buku", row.letterNumber, row.letterDate, row.issuerName, row.typeLabel,
        row.subject, row.recipient, row.status === "VOIDED" ? "Dibatalkan" : "Terpakai", row.voidReason, row.requestedByName,
      ].map((cell) => quoteCsvCell(cell ?? "")).join(","));
    }
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="buku-nomor-surat-${letterToday()}.csv"`);
    // A byte-order mark so spreadsheet programs read the file as UTF-8.
    return send(reply, 200, `${String.fromCharCode(0xfeff)}${lines.join("\r\n")}\r\n`);
  });

  app.patch("/admin/letters/numbers/:id", async (request, reply) => {
    const access = await requirePermission(request, reply, "documents.manage");
    if (!access) return;
    const params = idParams.safeParse(request.params);
    const body = editBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "Perihal 3–300 karakter, tujuan 2–300 karakter, dan versi wajib.");
    return transact(reply, (client) => editNumber(client, {
      id: params.data.id, actorAccountId: access.principal.id, ownerEmployeeId: null, body: body.data,
    }));
  });

  app.post("/admin/letters/numbers/:id/void", async (request, reply) => {
    const access = await requirePermission(request, reply, "documents.manage");
    if (!access) return;
    const params = idParams.safeParse(request.params);
    const body = voidBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "Alasan pembatalan wajib diisi, 10 sampai 500 karakter.");
    return transact(reply, (client) => voidNumber(client, {
      id: params.data.id, actorAccountId: access.principal.id, ownerEmployeeId: null, reason: body.data.reason,
    }));
  });

  // ---------------------------------------------------------------- settings

  app.get("/admin/letters/types", async (request, reply) => {
    if (!(await requirePermission(request, reply, "documents.read"))) return;
    // Bounded: the HC-managed catalog of letter kinds (D-16), tens of rows at most.
    const result = await pool.query(
      `SELECT code, label, reset_period AS "resetPeriod", active, sort_order AS "sortOrder",
              EXISTS (SELECT 1 FROM letter_numbers n WHERE n.type_code = type.code) AS used
         FROM letter_types type ORDER BY sort_order, code`,
    );
    return send(reply, 200, { items: result.rows });
  });

  app.post("/admin/letters/types", async (request, reply) => {
    const access = await requirePermission(request, reply, "documents.manage");
    if (!access) return;
    const body = typeBody.safeParse(request.body);
    if (!body.success) return invalid(reply, "Kode jenis 1–10 huruf kapital/angka diawali huruf, dan nama 2–120 karakter.");
    return transact(reply, async (client) => {
      try {
        await client.query(
          `INSERT INTO letter_types (code, label, reset_period, sort_order) VALUES ($1,$2,$3,$4)`,
          [body.data.code, body.data.label, body.data.resetPeriod, body.data.sortOrder ?? 50],
        );
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        throw new LetterError(409, "LETTER_TYPE_CODE_TAKEN", "Kode jenis surat sudah dipakai.");
      }
      await writeLetterAudit(client, {
        eventType: "letter.type.created", actorAccountId: access.principal.id,
        metadata: { code: body.data.code, resetPeriod: body.data.resetPeriod },
      });
      return [201, { code: body.data.code }];
    });
  });

  app.patch("/admin/letters/types/:code", async (request, reply) => {
    const access = await requirePermission(request, reply, "documents.manage");
    if (!access) return;
    const params = codeParams.safeParse(request.params);
    const body = typePatch.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply);
    return transact(reply, async (client) => {
      if (body.data.resetPeriod) {
        const current = await client.query<{ resetPeriod: string; used: boolean }>(
          `SELECT reset_period AS "resetPeriod",
                  EXISTS (SELECT 1 FROM letter_numbers n WHERE n.type_code = type.code) AS used
             FROM letter_types type WHERE code = $1 FOR UPDATE`,
          [params.data.code],
        );
        const row = current.rows[0];
        if (row && row.used && row.resetPeriod !== body.data.resetPeriod) {
          throw new LetterError(409, "LETTER_TYPE_IN_USE",
            "Periode reset tidak dapat diubah karena jenis ini sudah punya nomor. Buat jenis baru bila perlu periode lain.");
        }
      }
      const result = await client.query(
        `UPDATE letter_types
            SET label = coalesce($2, label), reset_period = coalesce($3, reset_period),
                active = coalesce($4, active), sort_order = coalesce($5, sort_order), updated_at = now()
          WHERE code = $1 RETURNING code`,
        [params.data.code, body.data.label ?? null, body.data.resetPeriod ?? null, body.data.active ?? null,
          body.data.sortOrder ?? null],
      );
      if (!result.rows[0]) throw new LetterError(404, "LETTER_TYPE_NOT_FOUND", "Jenis surat tidak ditemukan.");
      await writeLetterAudit(client, {
        eventType: "letter.type.updated", actorAccountId: access.principal.id,
        metadata: { code: params.data.code, fields: Object.keys(body.data) },
      });
      return [200, { code: params.data.code }];
    });
  });

  app.get("/admin/letters/issuers", async (request, reply) => {
    if (!(await requirePermission(request, reply, "documents.read"))) return;
    const query = issuersQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, "Filter tidak valid.");
    const values: unknown[] = [];
    const clauses: string[] = [];
    if (query.data.code) { values.push(query.data.code); clauses.push(`issuer.code = $${values.length}`); }
    if (query.data.active) { values.push(query.data.active === "true"); clauses.push(`issuer.active = $${values.length}`); }
    if (query.data.q) {
      values.push(letterLikePattern(query.data.q));
      clauses.push(`(issuer.code ILIKE $${values.length} ESCAPE '\\' OR issuer.name ILIKE $${values.length} ESCAPE '\\')`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const [items, count] = await Promise.all([
      pool.query(
        `SELECT issuer.id, issuer.code, issuer.name, issuer.kind, issuer.active,
                issuer.organizational_unit_id AS "organizationalUnitId", unit.name AS "unitName",
                issuer.committee_id AS "committeeId", committee.name AS "committeeName",
                committee.status AS "committeeStatus",
                (SELECT count(*)::int FROM letter_number_grants grant_row
                  WHERE grant_row.issuer_id = issuer.id AND grant_row.revoked_at IS NULL) AS "activeGrants"
           FROM letter_issuers issuer
           LEFT JOIN organizational_units unit ON unit.id = issuer.organizational_unit_id
           LEFT JOIN committees committee ON committee.id = issuer.committee_id
           ${where}
          ORDER BY issuer.code ASC, issuer.id ASC
          LIMIT ${query.data.pageSize} OFFSET ${pageOffset(query.data)}`,
        values,
      ),
      pool.query<{ total: number }>(`SELECT count(*)::int AS total FROM letter_issuers issuer ${where}`, values),
    ]);
    return send(reply, 200, { items: items.rows, pagination: pagination(query.data, count.rows[0]?.total ?? 0) });
  });

  app.get("/admin/letters/issuer-targets", async (request, reply) => {
    if (!(await requirePermission(request, reply, "documents.manage"))) return;
    const query = targetQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, "Ketik minimal 2 huruf.");
    // ENG-LIST-001 typeahead: at most 20 matches.
    const result = query.data.kind === "UNIT"
      ? await pool.query(
        `SELECT id, name, NULL::text AS status FROM organizational_units
          WHERE name ILIKE $1 ESCAPE '\\' ORDER BY name ASC, id ASC LIMIT 20`,
        [letterLikePattern(query.data.q)],
      )
      : await pool.query(
        `SELECT id, name, status FROM committees
          WHERE name ILIKE $1 ESCAPE '\\' AND status IN ('DRAFT', 'ACTIVE')
          ORDER BY start_on DESC, name ASC, id ASC LIMIT 20`,
        [letterLikePattern(query.data.q)],
      );
    return send(reply, 200, { items: result.rows });
  });

  app.post("/admin/letters/issuers", async (request, reply) => {
    const access = await requirePermission(request, reply, "documents.manage");
    if (!access) return;
    const body = issuerBody.safeParse(request.body);
    if (!body.success) return invalid(reply, "Kode penerbit 1–16 huruf kapital/angka/tanda hubung, dan nama 2–200 karakter.");
    const { kind } = body.data;
    if ((kind === "UNIT") !== Boolean(body.data.organizationalUnitId) || (kind === "COMMITTEE") !== Boolean(body.data.committeeId)) {
      return invalid(reply, "Penerbit unit wajib memilih unit, penerbit panitia wajib memilih panitia.");
    }
    return transact(reply, async (client) => {
      if (body.data.organizationalUnitId) {
        const unit = await client.query("SELECT 1 FROM organizational_units WHERE id = $1", [body.data.organizationalUnitId]);
        if (!unit.rows[0]) throw new LetterError(404, "LETTER_TARGET_NOT_FOUND", "Unit tidak ditemukan.");
      }
      if (body.data.committeeId) {
        const committee = await client.query("SELECT 1 FROM committees WHERE id = $1", [body.data.committeeId]);
        if (!committee.rows[0]) throw new LetterError(404, "LETTER_TARGET_NOT_FOUND", "Panitia tidak ditemukan.");
      }
      const id = randomUUID();
      try {
        await client.query(
          `INSERT INTO letter_issuers (id, code, name, kind, organizational_unit_id, committee_id, created_by_account_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, body.data.code, body.data.name, kind, body.data.organizationalUnitId ?? null, body.data.committeeId ?? null,
            access.principal.id],
        );
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        throw new LetterError(409, "LETTER_ISSUER_CODE_TAKEN", "Kode penerbit sudah dipakai.");
      }
      await writeLetterAudit(client, {
        eventType: "letter.issuer.created", issuerId: id, actorAccountId: access.principal.id,
        metadata: { code: body.data.code, kind },
      });
      return [201, { id, code: body.data.code }];
    });
  });

  app.patch("/admin/letters/issuers/:id", async (request, reply) => {
    const access = await requirePermission(request, reply, "documents.manage");
    if (!access) return;
    const params = idParams.safeParse(request.params);
    const body = issuerPatch.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply);
    return transact(reply, async (client) => {
      const result = await client.query(
        `UPDATE letter_issuers SET name = coalesce($2, name), active = coalesce($3, active), updated_at = now()
          WHERE id = $1 RETURNING id`,
        [params.data.id, body.data.name ?? null, body.data.active ?? null],
      );
      if (!result.rows[0]) throw new LetterError(404, "LETTER_ISSUER_NOT_FOUND", "Penerbit tidak ditemukan.");
      await writeLetterAudit(client, {
        eventType: "letter.issuer.updated", issuerId: params.data.id, actorAccountId: access.principal.id,
        metadata: { fields: Object.keys(body.data), active: body.data.active ?? null },
      });
      return [200, { id: params.data.id }];
    });
  });

  // ---------------------------------------------------------------- grants

  app.get("/admin/letters/grants", async (request, reply) => {
    if (!(await requirePermission(request, reply, "documents.read"))) return;
    const query = grantsQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, "Filter tidak valid.");
    const values: unknown[] = [];
    const clauses = [query.data.active === "true" ? "grant_row.revoked_at IS NULL" : "grant_row.revoked_at IS NOT NULL"];
    if (query.data.issuerCode) { values.push(query.data.issuerCode); clauses.push(`issuer.code = $${values.length}`); }
    if (query.data.q) {
      values.push(letterLikePattern(query.data.q));
      clauses.push(`(employee.full_name ILIKE $${values.length} ESCAPE '\\' OR employee.employee_number ILIKE $${values.length} ESCAPE '\\')`);
    }
    const from = `
      FROM letter_number_grants grant_row
      JOIN letter_issuers issuer ON issuer.id = grant_row.issuer_id
      JOIN employees employee ON employee.id = grant_row.employee_id
      WHERE ${clauses.join(" AND ")}`;
    const [items, count] = await Promise.all([
      pool.query(
        `SELECT grant_row.id, grant_row.issuer_id AS "issuerId", issuer.code AS "issuerCode", issuer.name AS "issuerName",
                grant_row.employee_id AS "employeeId", employee.full_name AS "employeeName",
                employee.employee_number AS "employeeNumber", employee.status AS "employeeStatus",
                grant_row.reason, grant_row.granted_at AS "grantedAt", grant_row.revoked_at AS "revokedAt",
                grant_row.revoke_reason AS "revokeReason"
           ${from}
          ORDER BY issuer.code ASC, employee.full_name ASC, grant_row.id ASC
          LIMIT ${query.data.pageSize} OFFSET ${pageOffset(query.data)}`,
        values,
      ),
      pool.query<{ total: number }>(`SELECT count(*)::int AS total ${from}`, values),
    ]);
    return send(reply, 200, { items: items.rows, pagination: pagination(query.data, count.rows[0]?.total ?? 0) });
  });

  app.get("/admin/letters/employee-options", async (request, reply) => {
    if (!(await requirePermission(request, reply, "documents.manage"))) return;
    const query = optionsQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, "Ketik minimal 2 huruf.");
    // ENG-LIST-001 typeahead: at most 20 matches; the caller narrows the query for more.
    const result = await pool.query(
      `SELECT employee.id, employee.full_name AS "fullName", employee.employee_number AS "employeeNumber",
              unit.name AS "unitName"
         FROM employees employee
         LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
        WHERE employee.status = 'active' AND employee.removed_at IS NULL
          AND (employee.full_name ILIKE $1 ESCAPE '\\' OR employee.employee_number ILIKE $1 ESCAPE '\\')
        ORDER BY employee.full_name ASC, employee.id ASC
        LIMIT 20`,
      [letterLikePattern(query.data.q)],
    );
    return send(reply, 200, { items: result.rows });
  });

  app.post("/admin/letters/grants", async (request, reply) => {
    const access = await requirePermission(request, reply, "documents.manage");
    if (!access) return;
    const body = grantBody.safeParse(request.body);
    if (!body.success) return invalid(reply, "Pilih pegawai dan penerbit, lalu tulis alasan 5–500 karakter.");
    return transact(reply, async (client) => {
      const employee = await client.query(
        "SELECT 1 FROM employees WHERE id = $1 AND status = 'active' AND removed_at IS NULL",
        [body.data.employeeId],
      );
      if (!employee.rows[0]) throw new LetterError(409, "LETTER_EMPLOYEE_INACTIVE", "Hak ambil nomor hanya untuk pegawai aktif.");
      const issuer = await client.query<{ active: boolean }>("SELECT active FROM letter_issuers WHERE id = $1", [body.data.issuerId]);
      if (!issuer.rows[0]) throw new LetterError(404, "LETTER_ISSUER_NOT_FOUND", "Penerbit tidak ditemukan.");
      if (!issuer.rows[0].active) throw new LetterError(409, "LETTER_ISSUER_INACTIVE", "Penerbit ini sedang tidak aktif.");
      const id = randomUUID();
      try {
        await client.query(
          `INSERT INTO letter_number_grants (id, employee_id, issuer_id, reason, granted_by_account_id)
           VALUES ($1,$2,$3,$4,$5)`,
          [id, body.data.employeeId, body.data.issuerId, body.data.reason, access.principal.id],
        );
      } catch (error) {
        if (!isUniqueViolation(error, "letter_number_grants_active_unique")) throw error;
        throw new LetterError(409, "LETTER_GRANT_EXISTS", "Pegawai ini sudah punya hak ambil nomor untuk penerbit ini.");
      }
      await writeLetterAudit(client, {
        eventType: "letter.grant.created", issuerId: body.data.issuerId, actorAccountId: access.principal.id,
        reason: body.data.reason, metadata: { grantId: id, employeeId: body.data.employeeId },
      });
      return [201, { id }];
    });
  });

  app.post("/admin/letters/grants/:id/revoke", async (request, reply) => {
    const access = await requirePermission(request, reply, "documents.manage");
    if (!access) return;
    const params = idParams.safeParse(request.params);
    const body = grantRevokeBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "Alasan pencabutan wajib diisi, 5 sampai 500 karakter.");
    return transact(reply, async (client) => {
      const result = await client.query<{ issuerId: string; employeeId: string }>(
        `UPDATE letter_number_grants
            SET revoked_at = now(), revoked_by_account_id = $2, revoke_reason = $3
          WHERE id = $1 AND revoked_at IS NULL
          RETURNING issuer_id AS "issuerId", employee_id AS "employeeId"`,
        [params.data.id, access.principal.id, body.data.reason],
      );
      if (!result.rows[0]) throw new LetterError(409, "LETTER_GRANT_NOT_REVOCABLE", "Hak ambil nomor tidak ditemukan atau sudah dicabut.");
      await writeLetterAudit(client, {
        eventType: "letter.grant.revoked", issuerId: result.rows[0].issuerId, actorAccountId: access.principal.id,
        reason: body.data.reason, metadata: { grantId: params.data.id, employeeId: result.rows[0].employeeId },
      });
      return [200, { id: params.data.id }];
    });
  });

  // ---------------------------------------------------------------- counters

  app.get("/admin/letters/counters", async (request, reply) => {
    if (!(await requirePermission(request, reply, "documents.read"))) return;
    const query = counterQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, "Pilih penerbit, jenis, dan periode.");
    const result = await pool.query<{ lastSequence: number }>(
      `SELECT last_sequence AS "lastSequence" FROM letter_number_counters
        WHERE issuer_id = $1 AND type_code = $2 AND period_key = $3`,
      [query.data.issuerId, query.data.typeCode, query.data.periodKey],
    );
    return send(reply, 200, { ...query.data, lastSequence: result.rows[0]?.lastSequence ?? 0 });
  });

  /** §5.5 / D-17: continue a manual book. The counter only ever moves up, so no number is taken twice. */
  app.post("/admin/letters/counters", async (request, reply) => {
    const access = await requirePermission(request, reply, "documents.manage");
    if (!access) return;
    const body = counterBody.safeParse(request.body);
    if (!body.success) return invalid(reply, "Pilih penerbit, jenis, periode, dan nomor terakhir yang sudah terpakai (1–99999).");
    return transact(reply, async (client) => {
      const type = await client.query<{ resetPeriod: LetterResetPeriod }>(
        `SELECT reset_period AS "resetPeriod" FROM letter_types WHERE code = $1`, [body.data.typeCode],
      );
      const issuer = await client.query("SELECT 1 FROM letter_issuers WHERE id = $1", [body.data.issuerId]);
      if (!type.rows[0] || !issuer.rows[0]) throw new LetterError(404, "LETTER_COUNTER_TARGET_NOT_FOUND", "Penerbit atau jenis surat tidak ditemukan.");
      if (body.data.periodKey.length !== (type.rows[0].resetPeriod === "MONTHLY" ? 7 : 4)) {
        throw new LetterError(400, "INVALID_LETTER_REQUEST",
          type.rows[0].resetPeriod === "MONTHLY" ? "Periode jenis ini bulanan (YYYY-MM)." : "Periode jenis ini tahunan (YYYY).");
      }
      // Make sure the counter row exists (this waits for an allocation that is inserting it), then
      // lock it, so the comparison below cannot race an allocation and lower the counter.
      await client.query(
        `INSERT INTO letter_number_counters (issuer_id, type_code, period_key, last_sequence) VALUES ($1,$2,$3,0)
         ON CONFLICT (issuer_id, type_code, period_key) DO NOTHING`,
        [body.data.issuerId, body.data.typeCode, body.data.periodKey],
      );
      const current = await client.query<{ lastSequence: number }>(
        `SELECT last_sequence AS "lastSequence" FROM letter_number_counters
          WHERE issuer_id = $1 AND type_code = $2 AND period_key = $3 FOR UPDATE`,
        [body.data.issuerId, body.data.typeCode, body.data.periodKey],
      );
      const before = current.rows[0]?.lastSequence ?? 0;
      if (body.data.lastSequence <= before) {
        throw new LetterError(409, "LETTER_COUNTER_NOT_RAISED",
          `Nomor terakhir sekarang ${before}. Nomor awal hanya dapat dinaikkan, tidak diturunkan.`);
      }
      await client.query(
        `UPDATE letter_number_counters SET last_sequence = $4
          WHERE issuer_id = $1 AND type_code = $2 AND period_key = $3`,
        [body.data.issuerId, body.data.typeCode, body.data.periodKey, body.data.lastSequence],
      );
      await writeLetterAudit(client, {
        eventType: "letter.counter.raised", issuerId: body.data.issuerId, actorAccountId: access.principal.id,
        metadata: { typeCode: body.data.typeCode, periodKey: body.data.periodKey, from: before, to: body.data.lastSequence },
      });
      return [200, { ...body.data, previous: before }];
    });
  });
}
