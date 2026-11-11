// EMP-011 Package 1 routes: the employee document archive.
// Spec: docs/domain/employee-documents.md.
//
// Two audiences. An EMPLOYEE session reads, downloads, proposes and withdraws its own documents
// (/me/employee-documents*); the employee id always comes from the session, never from the
// request, so another employee's document answers 404 exactly like a missing one (D-08).
// employee_documents.read / .manage (HC only, never through legacy Super Admin compatibility, never
// a unit-scoped role) read and manage every archive (/admin/employee-documents*). The permission is
// checked before any input is validated.
//
// Every file read and every write is audited; audit metadata never carries document content,
// numbers, file names, employee names or reason text (D-11).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { pageOffset, pageQuerySchema, pagination } from "../../lib/pagination.js";
import { decryptSecret, encryptSecret } from "../auth/crypto.js";
import type { EmployeeDocumentPermission } from "../auth/permissions.js";
import { AUTH_COOKIE_NAME, AuthService, readCookie, type AuthPrincipal } from "../auth/service.js";
import { OUTSIDE_HCIS_CODE, OUTSIDE_HCIS_MESSAGE } from "../employees/management-scope.js";
import {
  addDays,
  assertTransition,
  daysUntil,
  decodeDocumentFile,
  DOCUMENT_TYPE_RULES,
  DOCUMENT_TYPES,
  downloadFileName,
  EmployeeDocumentError,
  FILE_CONTENT_TYPES,
  MAX_PENDING_PER_EMPLOYEE,
  MAX_PROPOSALS_PER_DAY,
  numberLast4,
  UPLOAD_BODY_LIMIT,
  validateMetadata,
  wibDate,
  WORKLIST_WINDOWS,
  type DocumentStatus,
  type DocumentType,
} from "./domain.js";
import { fileDownloadHeaders, PostgresEmployeeFileStore, type EmployeeFileStore } from "./file-store.js";

type Db = Pick<PoolClient, "query">;

const noNul = (value: string) => !value.includes("\u0000");
const optionalText = (max: number) => z.string().max(max).refine(noNul).nullish();
const optionalDate = z.string().max(10).nullish();

const documentParams = z.object({ documentId: z.string().uuid() });
const employeeParams = z.object({ employeeId: z.string().uuid() });
const fileBody = z.object({
  contentType: z.enum(FILE_CONTENT_TYPES),
  contentBase64: z.string().min(1).max(UPLOAD_BODY_LIMIT),
});
const metadataFields = {
  documentType: z.enum(DOCUMENT_TYPES),
  title: optionalText(200),
  issuer: optionalText(200),
  issuedOn: optionalDate,
  expiresOn: optionalDate,
  documentNumber: optionalText(60),
  replacesDocumentId: z.string().uuid().nullish(),
  file: fileBody,
};
const selfUploadBody = z.object(metadataFields).strict();
const adminUploadBody = z.object({ ...metadataFields, notes: optionalText(500) }).strict();
const updateBody = z.object({
  title: optionalText(200),
  issuer: optionalText(200),
  issuedOn: optionalDate,
  expiresOn: optionalDate,
  documentNumber: optionalText(60),
  notes: optionalText(500),
}).strict();
const reasonBody = z.object({ reason: z.string().trim().min(5).max(300).refine(noNul) });
const adminListQuery = pageQuerySchema.extend({
  includeHistory: z.enum(["true", "false"]).optional(),
});
const expiringQuery = pageQuerySchema.extend({
  withinDays: z.coerce.number().int().refine((value) => (WORKLIST_WINDOWS as readonly number[]).includes(value)).default(60),
});

const DOCUMENT_COLUMNS = `
  doc.id, doc.employee_id AS "employeeId", doc.document_type AS "documentType", doc.title, doc.issuer,
  to_char(doc.issued_on, 'YYYY-MM-DD') AS "issuedOn", to_char(doc.expires_on, 'YYYY-MM-DD') AS "expiresOn",
  doc.number_last4 AS "numberLast4", doc.status, doc.source, doc.replaces_document_id AS "replacesDocumentId",
  doc.decided_at AS "decidedAt", doc.decision_reason AS "decisionReason", doc.ended_at AS "endedAt",
  doc.end_reason AS "endReason", doc.notes, doc.created_at AS "createdAt", doc.updated_at AS "updatedAt",
  file.content_type AS "contentType", file.byte_size AS "byteSize", (file.purged_at IS NOT NULL) AS "filePurged"`;
const DOCUMENT_FROM = `employee_documents doc LEFT JOIN employee_document_files file ON file.employee_document_id = doc.id`;

interface DocumentRow {
  id: string;
  employeeId: string;
  documentType: DocumentType;
  title: string | null;
  issuer: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  numberLast4: string | null;
  status: DocumentStatus;
  source: "HC" | "EMPLOYEE";
  replacesDocumentId: string | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  endedAt: Date | null;
  endReason: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  contentType: string | null;
  byteSize: number | null;
  filePurged: boolean | null;
}

/** The catalog the screens render; the API keeps enforcing it (D-04). */
const TYPE_CATALOG = DOCUMENT_TYPES.map((code) => ({ code, ...DOCUMENT_TYPE_RULES[code] }));

function send(reply: FastifyReply, status: number, body: unknown) {
  reply.header("Cache-Control", "no-store");
  return reply.status(status).send(body);
}

/** D-05: only the last four characters ever leave the API. */
function present(row: DocumentRow, todayWib: string, audience: "HC" | "SELF") {
  const expiry = row.expiresOn
    ? { daysLeft: daysUntil(row.expiresOn, todayWib), expired: row.expiresOn < todayWib }
    : { daysLeft: null, expired: false };
  const base = {
    id: row.id,
    employeeId: row.employeeId,
    documentType: row.documentType,
    typeLabel: DOCUMENT_TYPE_RULES[row.documentType].label,
    title: row.title,
    issuer: row.issuer,
    issuedOn: row.issuedOn,
    expiresOn: row.expiresOn,
    ...expiry,
    numberMasked: row.numberLast4 ? `••••${row.numberLast4}` : null,
    status: row.status,
    source: row.source,
    replacesDocumentId: row.replacesDocumentId,
    decidedAt: row.decidedAt,
    decisionReason: row.decisionReason,
    createdAt: row.createdAt,
    file: row.contentType ? { contentType: row.contentType, byteSize: row.byteSize, purged: row.filePurged === true } : null,
  };
  if (audience === "SELF") return base;
  return { ...base, notes: row.notes, endedAt: row.endedAt, endReason: row.endReason, updatedAt: row.updatedAt };
}

async function writeAudit(
  db: Db,
  event: {
    eventType: string;
    employeeId?: string | null;
    documentId?: string | null;
    actorAccountId: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  await db.query(
    `INSERT INTO employee_document_audit_events (id, event_type, employee_id, document_id, actor_account_id, metadata, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, clock_timestamp())`,
    [
      randomUUID(), event.eventType, event.employeeId ?? null, event.documentId ?? null,
      event.actorAccountId, JSON.stringify(event.metadata ?? {}),
    ],
  );
}

const notFound = () => new EmployeeDocumentError(404, "EMPLOYEE_DOCUMENT_NOT_FOUND", "Dokumen tidak ditemukan.");
const outside = () => new EmployeeDocumentError(409, OUTSIDE_HCIS_CODE, OUTSIDE_HCIS_MESSAGE);

export async function registerEmployeeDocumentRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
  injectedAuth?: Pick<AuthService, "getSession" | "getAuthorizationContext">,
  now: () => Date = () => new Date(),
  injectedStore?: EmployeeFileStore,
) {
  const encryptionKey = config.AUTH_ENCRYPTION_KEY;
  if (!encryptionKey) throw new Error("AUTH_ENCRYPTION_KEY is required for employee document routes");
  const key: string = encryptionKey;
  const store = injectedStore ?? new PostgresEmployeeFileStore(key);
  const auth = injectedAuth ?? new AuthService(pool, key, config.AUTH_SESSION_TTL_HOURS, config.NODE_ENV === "production");

  async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<AuthPrincipal | null> {
    const session = await auth.getSession(readCookie(request.headers.cookie, AUTH_COOKIE_NAME));
    if (!session) {
      await send(reply, 401, { code: "UNAUTHENTICATED", message: "Sesi tidak ditemukan atau sudah berakhir." });
      return null;
    }
    return session.principal;
  }

  async function requireEmployee(request: FastifyRequest, reply: FastifyReply) {
    const principal = await authenticate(request, reply);
    if (!principal) return null;
    if (principal.principalType !== "EMPLOYEE") {
      await send(reply, 403, { code: "FORBIDDEN", message: "Dokumen pribadi hanya tersedia untuk pegawai." });
      return null;
    }
    return principal;
  }

  async function requirePermission(request: FastifyRequest, reply: FastifyReply, permission: EmployeeDocumentPermission) {
    const principal = await authenticate(request, reply);
    if (!principal) return null;
    const context = await auth.getAuthorizationContext(principal);
    if (!context.organizationPermissions.includes(permission)) {
      await send(reply, 403, { code: "EMPLOYEE_DOCUMENT_FORBIDDEN", message: "Anda tidak memiliki akses ke arsip dokumen pegawai." });
      return null;
    }
    return principal;
  }

  function handleError(reply: FastifyReply, error: unknown) {
    if (error instanceof EmployeeDocumentError) {
      return send(reply, error.statusCode, { code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) });
    }
    throw error;
  }

  /** Runs `work` in one transaction and answers only after COMMIT succeeded. */
  async function inTransaction(reply: FastifyReply, status: number, work: (client: PoolClient) => Promise<unknown>) {
    const client = await pool.connect();
    let result: unknown;
    try {
      await client.query("BEGIN");
      result = await work(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      return handleError(reply, error);
    } finally {
      client.release();
    }
    return send(reply, status, result);
  }

  /** The employee behind an EMPLOYEE session; null when the account is not linked. */
  async function selfEmployee(db: Db, accountId: string) {
    const found = await db.query<{ id: string; managementScope: string; active: boolean }>(
      `SELECT employee.id, employee.management_scope AS "managementScope", employee.status = 'active' AS active
         FROM accounts account
         JOIN employees employee ON employee.id = account.employee_id
        WHERE account.id = $1 AND account.principal_type = 'EMPLOYEE' AND account.status = 'active'
          AND employee.removed_at IS NULL`,
      [accountId],
    );
    return found.rows[0] ?? null;
  }

  /**
   * Locks the employee row so uploads for one person serialize (D-06 limit). NO KEY UPDATE does not
   * conflict with the FOR KEY SHARE locks foreign-key checks take elsewhere.
   */
  async function lockManagedEmployee(db: Db, employeeId: string) {
    const found = await db.query<{ managementScope: string }>(
      `SELECT management_scope AS "managementScope" FROM employees
        WHERE id = $1 AND removed_at IS NULL FOR NO KEY UPDATE`,
      [employeeId],
    );
    const employee = found.rows[0];
    if (!employee) throw new EmployeeDocumentError(404, "EMPLOYEE_NOT_FOUND", "Pegawai tidak ditemukan.");
    if (employee.managementScope === "OUTSIDE_HCIS") throw outside();
  }

  async function loadDocument(db: Db, documentId: string, options: { lock?: boolean; employeeId?: string } = {}) {
    const found = await db.query<DocumentRow>(
      `SELECT ${DOCUMENT_COLUMNS} FROM ${DOCUMENT_FROM}
        WHERE doc.id = $1 AND ($2::uuid IS NULL OR doc.employee_id = $2::uuid)
        ${options.lock ? "FOR UPDATE OF doc" : ""}`,
      [documentId, options.employeeId ?? null],
    );
    return found.rows[0] ?? null;
  }

  async function assertManaged(db: Db, employeeId: string) {
    const found = await db.query<{ managementScope: string }>(
      `SELECT management_scope AS "managementScope" FROM employees WHERE id = $1`,
      [employeeId],
    );
    if (found.rows[0]?.managementScope === "OUTSIDE_HCIS") throw outside();
  }

  function encryptNumber(value: string | null) {
    if (!value) return { ciphertext: null, iv: null, tag: null, last4: null };
    const encrypted = encryptSecret(value, key);
    return { ...encrypted, last4: numberLast4(value) || value.slice(-4) };
  }

  /** D-14: the document a new upload replaces must be the same person's VERIFIED document of the same type. */
  async function lockReplaceable(db: Db, documentId: string, employeeId: string, documentType: DocumentType) {
    const found = await db.query<{ id: string }>(
      `SELECT id FROM employee_documents
        WHERE id = $1 AND employee_id = $2 AND document_type = $3 AND status = 'VERIFIED' FOR UPDATE`,
      [documentId, employeeId, documentType],
    );
    if (!found.rows[0]) {
      throw new EmployeeDocumentError(
        409, "EMPLOYEE_DOCUMENT_REPLACE_INVALID",
        "Dokumen yang diganti harus dokumen terverifikasi milik pegawai yang sama dengan jenis yang sama.",
      );
    }
  }

  async function markReplaced(db: Db, input: { oldId: string; newId: string; employeeId: string; documentType: DocumentType; actorAccountId: string }) {
    await db.query(
      `UPDATE employee_documents SET status = 'REPLACED', ended_at = now(), ended_by_account_id = $2, updated_at = now()
        WHERE id = $1`,
      [input.oldId, input.actorAccountId],
    );
    await writeAudit(db, {
      eventType: "employee_document.replaced", employeeId: input.employeeId, documentId: input.oldId,
      actorAccountId: input.actorAccountId, metadata: { documentType: input.documentType, replacedBy: input.newId },
    });
  }

  /**
   * D-06: the open-proposal limit and the daily proposal limit. Checked once before the upload is
   * decoded (cheap refusal, no connection held) and again under the employee lock.
   */
  async function assertProposalAllowed(db: Db, employeeId: string) {
    const counts = await db.query<{ pending: number; recent: number }>(
      `SELECT count(*) FILTER (WHERE status = 'PENDING_REVIEW')::int AS pending,
              count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS recent
         FROM employee_documents WHERE employee_id = $1 AND source = 'EMPLOYEE'`,
      [employeeId],
    );
    const { pending = 0, recent = 0 } = counts.rows[0] ?? {};
    if (pending >= MAX_PENDING_PER_EMPLOYEE) {
      throw new EmployeeDocumentError(
        409, "EMPLOYEE_DOCUMENT_PENDING_LIMIT",
        `Masih ada ${MAX_PENDING_PER_EMPLOYEE} usulan yang menunggu verifikasi HC. Tunggu keputusan HC atau tarik salah satunya.`,
      );
    }
    if (recent >= MAX_PROPOSALS_PER_DAY) {
      throw new EmployeeDocumentError(
        429, "EMPLOYEE_DOCUMENT_RATE_LIMITED",
        `Paling banyak ${MAX_PROPOSALS_PER_DAY} unggahan dalam 24 jam. Coba lagi besok.`,
      );
    }
  }

  /** Shared by the HC upload and the employee proposal (§5.1). */
  async function createDocument(
    client: PoolClient,
    input: {
      employeeId: string;
      actorAccountId: string;
      source: "HC" | "EMPLOYEE";
      body: z.infer<typeof adminUploadBody>;
      bytes: Buffer;
    },
  ) {
    const today = wibDate(now());
    const metadata = validateMetadata(input.body, today);
    const replaces = input.body.replacesDocumentId ?? null;
    if (replaces) await lockReplaceable(client, replaces, input.employeeId, input.body.documentType);
    const id = randomUUID();
    const number = encryptNumber(metadata.documentNumber);
    const verified = input.source === "HC";
    await client.query(
      `INSERT INTO employee_documents
         (id, employee_id, document_type, title, issuer, issued_on, expires_on,
          number_ciphertext, number_iv, number_auth_tag, number_last4, status, source, replaces_document_id,
          submitted_by_account_id, decided_by_account_id, decided_at, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        id, input.employeeId, input.body.documentType, metadata.title, metadata.issuer, metadata.issuedOn, metadata.expiresOn,
        number.ciphertext, number.iv, number.tag, number.last4, verified ? "VERIFIED" : "PENDING_REVIEW", input.source, replaces,
        input.actorAccountId, verified ? input.actorAccountId : null, verified ? now() : null,
        input.source === "HC" ? metadata.notes : null,
      ],
    );
    await store.put(client, { purpose: "EMPLOYEE_DOCUMENT", employeeDocumentId: id }, {
      contentType: input.body.file.contentType, bytes: input.bytes,
    }, input.actorAccountId);
    await writeAudit(client, {
      eventType: "employee_document.uploaded", employeeId: input.employeeId, documentId: id, actorAccountId: input.actorAccountId,
      metadata: {
        documentType: input.body.documentType, source: input.source, contentType: input.body.file.contentType,
        byteSize: input.bytes.length, hasExpiry: metadata.expiresOn !== null, hasNumber: metadata.documentNumber !== null,
      },
    });
    if (verified && replaces) {
      await markReplaced(client, {
        oldId: replaces, newId: id, employeeId: input.employeeId, documentType: input.body.documentType, actorAccountId: input.actorAccountId,
      });
    }
    return present((await loadDocument(client, id))!, today, input.source === "HC" ? "HC" : "SELF");
  }

  async function sendFile(reply: FastifyReply, db: Db, document: DocumentRow, actorAccountId: string, via: "SELF" | "HC") {
    const file = await store.read(db, { purpose: "EMPLOYEE_DOCUMENT", employeeDocumentId: document.id });
    if (!file) return send(reply, 404, { code: "EMPLOYEE_DOCUMENT_FILE_NOT_FOUND", message: "Berkas tidak ditemukan." });
    if (!file.bytes) return send(reply, 410, { code: "EMPLOYEE_DOCUMENT_FILE_PURGED", message: "Isi berkas sudah dihapus." });
    // D-11: the read is recorded before a single byte leaves; a failed audit means no file.
    await writeAudit(db, {
      eventType: "employee_document.file_read", employeeId: document.employeeId, documentId: document.id,
      actorAccountId, metadata: { documentType: document.documentType, via },
    });
    reply.headers(fileDownloadHeaders(file.contentType, downloadFileName(document.documentType, file.createdAt, file.contentType)));
    return reply.status(200).send(file.bytes);
  }

  async function page(db: Db, where: string, values: unknown[], query: { page: number; pageSize: number }, order: string) {
    const total = await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM ${DOCUMENT_FROM} WHERE ${where}`, values);
    const rows = await db.query<DocumentRow>(
      `SELECT ${DOCUMENT_COLUMNS} FROM ${DOCUMENT_FROM} WHERE ${where} ORDER BY ${order}
        LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, query.pageSize, pageOffset(query)],
    );
    return { total: total.rows[0]?.total ?? 0, rows: rows.rows };
  }

  // ---------------------------------------------------------------- employee

  app.get("/me/employee-documents", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const query = pageQuerySchema.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_EMPLOYEE_DOCUMENT_FILTER", message: "Halaman tidak valid." });
    const self = await selfEmployee(pool, principal.id);
    if (!self) return send(reply, 404, { code: "EMPLOYEE_NOT_FOUND", message: "Akun tidak terhubung ke data pegawai." });
    const today = wibDate(now());
    const { total, rows } = await page(
      pool, `doc.employee_id = $1 AND doc.status IN ('PENDING_REVIEW', 'VERIFIED', 'REJECTED')`, [self.id], query.data,
      `CASE doc.status WHEN 'PENDING_REVIEW' THEN 0 WHEN 'VERIFIED' THEN 1 ELSE 2 END, doc.document_type, doc.created_at DESC`,
    );
    return send(reply, 200, {
      items: rows.map((row) => present(row, today, "SELF")),
      pagination: pagination(query.data, total),
      types: TYPE_CATALOG,
      canPropose: self.managementScope !== "OUTSIDE_HCIS" && self.active,
      maxPending: MAX_PENDING_PER_EMPLOYEE,
    });
  });

  app.post("/me/employee-documents", { bodyLimit: UPLOAD_BODY_LIMIT }, async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const body = selfUploadBody.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "EMPLOYEE_DOCUMENT_INVALID", message: "Data dokumen tidak lengkap atau tidak valid." });
    let bytes: Buffer;
    try {
      const self = await selfEmployee(pool, principal.id);
      if (!self || !self.active) throw new EmployeeDocumentError(404, "EMPLOYEE_NOT_FOUND", "Akun tidak terhubung ke data pegawai aktif.");
      if (self.managementScope === "OUTSIDE_HCIS") throw outside();
      await assertProposalAllowed(pool, self.id);
      bytes = decodeDocumentFile(body.data.file.contentType, body.data.file.contentBase64);
    } catch (error) {
      return handleError(reply, error);
    }
    return inTransaction(reply, 201, async (client) => {
      const self = await selfEmployee(client, principal.id);
      if (!self || !self.active) throw new EmployeeDocumentError(404, "EMPLOYEE_NOT_FOUND", "Akun tidak terhubung ke data pegawai aktif.");
      await lockManagedEmployee(client, self.id);
      await assertProposalAllowed(client, self.id);
      return createDocument(client, {
        employeeId: self.id, actorAccountId: principal.id, source: "EMPLOYEE", bytes, body: { ...body.data, notes: null },
      });
    });
  });

  app.get("/me/employee-documents/:documentId/file", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = documentParams.safeParse(request.params);
    if (!params.success) return send(reply, 404, { code: "EMPLOYEE_DOCUMENT_NOT_FOUND", message: "Dokumen tidak ditemukan." });
    const self = await selfEmployee(pool, principal.id);
    const document = self ? await loadDocument(pool, params.data.documentId, { employeeId: self.id }) : null;
    // D-08: another person's document, and the owner's ended ones, look exactly like a missing one.
    if (!document || !["PENDING_REVIEW", "VERIFIED"].includes(document.status)) {
      return send(reply, 404, { code: "EMPLOYEE_DOCUMENT_NOT_FOUND", message: "Dokumen tidak ditemukan." });
    }
    return sendFile(reply, pool, document, principal.id, "SELF");
  });

  app.post("/me/employee-documents/:documentId/withdraw", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = documentParams.safeParse(request.params);
    if (!params.success) return send(reply, 404, { code: "EMPLOYEE_DOCUMENT_NOT_FOUND", message: "Dokumen tidak ditemukan." });
    return inTransaction(reply, 200, async (client) => {
      const self = await selfEmployee(client, principal.id);
      const document = self ? await loadDocument(client, params.data.documentId, { lock: true, employeeId: self.id }) : null;
      if (!document) throw notFound();
      assertTransition("withdraw", document.status);
      await client.query(
        `UPDATE employee_documents SET status = 'WITHDRAWN', ended_at = now(), ended_by_account_id = $2, updated_at = now()
          WHERE id = $1`,
        [document.id, principal.id],
      );
      await store.purge(client, { purpose: "EMPLOYEE_DOCUMENT", employeeDocumentId: document.id });
      await writeAudit(client, {
        eventType: "employee_document.withdrawn", employeeId: document.employeeId, documentId: document.id,
        actorAccountId: principal.id, metadata: { documentType: document.documentType },
      });
      return { id: document.id, status: "WITHDRAWN" };
    });
  });

  // ---------------------------------------------------------------- admin

  app.get("/admin/employee-documents/expiring", async (request, reply) => {
    const principal = await requirePermission(request, reply, "employee_documents.read");
    if (!principal) return;
    const query = expiringQuery.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_EMPLOYEE_DOCUMENT_FILTER", message: "Rentang hari atau halaman tidak valid." });
    const today = wibDate(now());
    const cutoff = addDays(today, query.data.withinDays);
    // D-15: active employees HCIS manages; filters run before LIMIT (ENG-LIST-001).
    const where = `doc.status = 'VERIFIED' AND doc.expires_on IS NOT NULL AND doc.expires_on <= $1::date
      AND employee.status = 'active' AND employee.removed_at IS NULL AND employee.management_scope = 'MANAGED'`;
    const from = `employee_documents doc JOIN employees employee ON employee.id = doc.employee_id
      LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id`;
    const total = await pool.query<{ total: number }>(`SELECT count(*)::int AS total FROM ${from} WHERE ${where}`, [cutoff]);
    const rows = await pool.query<{
      id: string; employeeId: string; fullName: string; employeeNumber: string; unitName: string | null;
      documentType: DocumentType; title: string | null; expiresOn: string;
    }>(
      `SELECT doc.id, doc.employee_id AS "employeeId", employee.full_name AS "fullName",
              employee.employee_number AS "employeeNumber", unit.name AS "unitName",
              doc.document_type AS "documentType", doc.title, to_char(doc.expires_on, 'YYYY-MM-DD') AS "expiresOn"
         FROM ${from} WHERE ${where}
        ORDER BY doc.expires_on, employee.full_name, doc.id
        LIMIT $2 OFFSET $3`,
      [cutoff, query.data.pageSize, pageOffset(query.data)],
    );
    const count = total.rows[0]?.total ?? 0;
    await writeAudit(pool, {
      eventType: "employee_document.worklist_read", actorAccountId: principal.id,
      metadata: { view: "EXPIRING", withinDays: query.data.withinDays, total: count },
    });
    return send(reply, 200, {
      withinDays: query.data.withinDays,
      items: rows.rows.map((row) => ({
        ...row,
        typeLabel: DOCUMENT_TYPE_RULES[row.documentType].label,
        daysLeft: daysUntil(row.expiresOn, today),
        expired: row.expiresOn < today,
      })),
      pagination: pagination(query.data, count),
    });
  });

  app.get("/admin/employee-documents/pending", async (request, reply) => {
    const principal = await requirePermission(request, reply, "employee_documents.read");
    if (!principal) return;
    const query = pageQuerySchema.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_EMPLOYEE_DOCUMENT_FILTER", message: "Halaman tidak valid." });
    const where = `doc.status = 'PENDING_REVIEW' AND employee.removed_at IS NULL`;
    const from = `employee_documents doc JOIN employees employee ON employee.id = doc.employee_id
      LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id`;
    const total = await pool.query<{ total: number }>(`SELECT count(*)::int AS total FROM ${from} WHERE ${where}`);
    const rows = await pool.query<{
      id: string; employeeId: string; fullName: string; employeeNumber: string; unitName: string | null;
      documentType: DocumentType; title: string | null; createdAt: Date; replacesDocumentId: string | null;
    }>(
      `SELECT doc.id, doc.employee_id AS "employeeId", employee.full_name AS "fullName",
              employee.employee_number AS "employeeNumber", unit.name AS "unitName",
              doc.document_type AS "documentType", doc.title, doc.created_at AS "createdAt",
              doc.replaces_document_id AS "replacesDocumentId"
         FROM ${from} WHERE ${where}
        ORDER BY doc.created_at, doc.id
        LIMIT $1 OFFSET $2`,
      [query.data.pageSize, pageOffset(query.data)],
    );
    const count = total.rows[0]?.total ?? 0;
    await writeAudit(pool, {
      eventType: "employee_document.worklist_read", actorAccountId: principal.id, metadata: { view: "PENDING", total: count },
    });
    return send(reply, 200, {
      items: rows.rows.map((row) => ({ ...row, typeLabel: DOCUMENT_TYPE_RULES[row.documentType].label })),
      pagination: pagination(query.data, count),
    });
  });

  app.get("/admin/employee-documents/employees/:employeeId", async (request, reply) => {
    const principal = await requirePermission(request, reply, "employee_documents.read");
    if (!principal) return;
    const params = employeeParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_EMPLOYEE_ID", message: "Pegawai tidak valid." });
    const query = adminListQuery.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_EMPLOYEE_DOCUMENT_FILTER", message: "Halaman tidak valid." });
    const employee = await pool.query<{ id: string; managementScope: string }>(
      `SELECT id, management_scope AS "managementScope" FROM employees WHERE id = $1 AND removed_at IS NULL`,
      [params.data.employeeId],
    );
    if (!employee.rows[0]) return send(reply, 404, { code: "EMPLOYEE_NOT_FOUND", message: "Pegawai tidak ditemukan." });
    const history = query.data.includeHistory === "true";
    const today = wibDate(now());
    const { total, rows } = await page(
      pool,
      `doc.employee_id = $1 ${history ? "" : "AND doc.status IN ('PENDING_REVIEW', 'VERIFIED')"}`,
      [params.data.employeeId],
      query.data,
      `CASE doc.status WHEN 'PENDING_REVIEW' THEN 0 WHEN 'VERIFIED' THEN 1 ELSE 2 END, doc.document_type, doc.created_at DESC`,
    );
    await writeAudit(pool, {
      eventType: "employee_document.list_read", employeeId: params.data.employeeId, actorAccountId: principal.id,
      metadata: { count: total, includeHistory: history },
    });
    return send(reply, 200, {
      employee: employee.rows[0],
      items: rows.map((row) => present(row, today, "HC")),
      pagination: pagination(query.data, total),
      types: TYPE_CATALOG,
    });
  });

  app.post("/admin/employee-documents/employees/:employeeId", { bodyLimit: UPLOAD_BODY_LIMIT }, async (request, reply) => {
    const principal = await requirePermission(request, reply, "employee_documents.manage");
    if (!principal) return;
    const params = employeeParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_EMPLOYEE_ID", message: "Pegawai tidak valid." });
    const body = adminUploadBody.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "EMPLOYEE_DOCUMENT_INVALID", message: "Data dokumen tidak lengkap atau tidak valid." });
    let bytes: Buffer;
    try {
      bytes = decodeDocumentFile(body.data.file.contentType, body.data.file.contentBase64);
    } catch (error) {
      return handleError(reply, error);
    }
    return inTransaction(reply, 201, async (client) => {
      await lockManagedEmployee(client, params.data.employeeId);
      return createDocument(client, {
        employeeId: params.data.employeeId, actorAccountId: principal.id, source: "HC", bytes, body: body.data,
      });
    });
  });

  app.get("/admin/employee-documents/:documentId/file", async (request, reply) => {
    const principal = await requirePermission(request, reply, "employee_documents.read");
    if (!principal) return;
    const params = documentParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_EMPLOYEE_DOCUMENT_ID", message: "Dokumen tidak valid." });
    const document = await loadDocument(pool, params.data.documentId);
    if (!document) return send(reply, 404, { code: "EMPLOYEE_DOCUMENT_NOT_FOUND", message: "Dokumen tidak ditemukan." });
    return sendFile(reply, pool, document, principal.id, "HC");
  });

  app.patch("/admin/employee-documents/:documentId", async (request, reply) => {
    const principal = await requirePermission(request, reply, "employee_documents.manage");
    if (!principal) return;
    const params = documentParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_EMPLOYEE_DOCUMENT_ID", message: "Dokumen tidak valid." });
    const body = updateBody.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "EMPLOYEE_DOCUMENT_INVALID", message: "Data dokumen tidak valid." });
    return inTransaction(reply, 200, async (client) => {
      const document = await loadDocument(client, params.data.documentId, { lock: true });
      if (!document) throw notFound();
      assertTransition("update", document.status);
      await assertManaged(client, document.employeeId);
      const stored = await client.query<{ ciphertext: string | null; iv: string | null; tag: string | null }>(
        `SELECT number_ciphertext AS ciphertext, number_iv AS iv, number_auth_tag AS tag FROM employee_documents WHERE id = $1`,
        [document.id],
      );
      const current = stored.rows[0]!;
      const currentNumber = current.ciphertext && current.iv && current.tag
        ? decryptSecret({ ciphertext: current.ciphertext, iv: current.iv, tag: current.tag }, key)
        : null;
      const pick = <T>(next: T | undefined, previous: T) => (next === undefined ? previous : next);
      const metadata = validateMetadata({
        documentType: document.documentType,
        title: pick(body.data.title, document.title),
        issuer: pick(body.data.issuer, document.issuer),
        issuedOn: pick(body.data.issuedOn, document.issuedOn),
        expiresOn: pick(body.data.expiresOn, document.expiresOn),
        documentNumber: pick(body.data.documentNumber, currentNumber),
        notes: pick(body.data.notes, document.notes),
      }, wibDate(now()));
      const changedFields = ([
        ["title", document.title], ["issuer", document.issuer], ["issuedOn", document.issuedOn],
        ["expiresOn", document.expiresOn], ["documentNumber", currentNumber], ["notes", document.notes],
      ] as const).filter(([field, previous]) => metadata[field] !== previous).map(([field]) => field);
      if (changedFields.length === 0) return present(document, wibDate(now()), "HC");
      const number = changedFields.includes("documentNumber")
        ? encryptNumber(metadata.documentNumber)
        : null;
      await client.query(
        `UPDATE employee_documents
            SET title = $2, issuer = $3, issued_on = $4, expires_on = $5, notes = $6, updated_at = now(),
                number_ciphertext = CASE WHEN $7 THEN $8 ELSE number_ciphertext END,
                number_iv = CASE WHEN $7 THEN $9 ELSE number_iv END,
                number_auth_tag = CASE WHEN $7 THEN $10 ELSE number_auth_tag END,
                number_last4 = CASE WHEN $7 THEN $11 ELSE number_last4 END
          WHERE id = $1`,
        [
          document.id, metadata.title, metadata.issuer, metadata.issuedOn, metadata.expiresOn, metadata.notes,
          number !== null, number?.ciphertext ?? null, number?.iv ?? null, number?.tag ?? null, number?.last4 ?? null,
        ],
      );
      await writeAudit(client, {
        eventType: "employee_document.updated", employeeId: document.employeeId, documentId: document.id,
        actorAccountId: principal.id, metadata: { documentType: document.documentType, changedFields },
      });
      return present((await loadDocument(client, document.id))!, wibDate(now()), "HC");
    });
  });

  app.post("/admin/employee-documents/:documentId/verify", async (request, reply) => {
    const principal = await requirePermission(request, reply, "employee_documents.manage");
    if (!principal) return;
    const params = documentParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_EMPLOYEE_DOCUMENT_ID", message: "Dokumen tidak valid." });
    return inTransaction(reply, 200, async (client) => {
      const document = await loadDocument(client, params.data.documentId, { lock: true });
      if (!document) throw notFound();
      assertTransition("verify", document.status);
      await assertManaged(client, document.employeeId);
      await client.query(
        `UPDATE employee_documents SET status = 'VERIFIED', decided_by_account_id = $2, decided_at = now(), updated_at = now()
          WHERE id = $1`,
        [document.id, principal.id],
      );
      await writeAudit(client, {
        eventType: "employee_document.verified", employeeId: document.employeeId, documentId: document.id,
        actorAccountId: principal.id, metadata: { documentType: document.documentType },
      });
      // D-14: the proposal named a document to replace; it is replaced only if still VERIFIED.
      if (document.replacesDocumentId) {
        const replaced = await client.query<{ id: string }>(
          `SELECT id FROM employee_documents
            WHERE id = $1 AND employee_id = $2 AND document_type = $3 AND status = 'VERIFIED' FOR UPDATE`,
          [document.replacesDocumentId, document.employeeId, document.documentType],
        );
        if (replaced.rows[0]) {
          await markReplaced(client, {
            oldId: document.replacesDocumentId, newId: document.id, employeeId: document.employeeId,
            documentType: document.documentType, actorAccountId: principal.id,
          });
        }
      }
      return present((await loadDocument(client, document.id))!, wibDate(now()), "HC");
    });
  });

  app.post("/admin/employee-documents/:documentId/reject", async (request, reply) => {
    const principal = await requirePermission(request, reply, "employee_documents.manage");
    if (!principal) return;
    const params = documentParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_EMPLOYEE_DOCUMENT_ID", message: "Dokumen tidak valid." });
    const body = reasonBody.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "EMPLOYEE_DOCUMENT_REASON_REQUIRED", message: "Alasan wajib diisi (5–300 karakter)." });
    return inTransaction(reply, 200, async (client) => {
      const document = await loadDocument(client, params.data.documentId, { lock: true });
      if (!document) throw notFound();
      assertTransition("reject", document.status);
      await assertManaged(client, document.employeeId);
      await client.query(
        `UPDATE employee_documents
            SET status = 'REJECTED', decided_by_account_id = $2, decided_at = now(), decision_reason = $3, updated_at = now()
          WHERE id = $1`,
        [document.id, principal.id, body.data.reason],
      );
      // D-12: a refused scan has no purpose; its content goes at once.
      await store.purge(client, { purpose: "EMPLOYEE_DOCUMENT", employeeDocumentId: document.id });
      await writeAudit(client, {
        eventType: "employee_document.rejected", employeeId: document.employeeId, documentId: document.id,
        actorAccountId: principal.id, metadata: { documentType: document.documentType, reasonLength: body.data.reason.length },
      });
      return present((await loadDocument(client, document.id))!, wibDate(now()), "HC");
    });
  });

  app.post("/admin/employee-documents/:documentId/remove", async (request, reply) => {
    const principal = await requirePermission(request, reply, "employee_documents.manage");
    if (!principal) return;
    const params = documentParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_EMPLOYEE_DOCUMENT_ID", message: "Dokumen tidak valid." });
    const body = reasonBody.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "EMPLOYEE_DOCUMENT_REASON_REQUIRED", message: "Alasan wajib diisi (5–300 karakter)." });
    return inTransaction(reply, 200, async (client) => {
      const document = await loadDocument(client, params.data.documentId, { lock: true });
      if (!document) throw notFound();
      assertTransition("remove", document.status);
      await assertManaged(client, document.employeeId);
      await client.query(
        `UPDATE employee_documents
            SET status = 'REMOVED', ended_at = now(), ended_by_account_id = $2, end_reason = $3, updated_at = now()
          WHERE id = $1`,
        [document.id, principal.id, body.data.reason],
      );
      // D-13: permanent; the metadata row and the audit stay.
      await store.purge(client, { purpose: "EMPLOYEE_DOCUMENT", employeeDocumentId: document.id });
      await writeAudit(client, {
        eventType: "employee_document.removed", employeeId: document.employeeId, documentId: document.id,
        actorAccountId: principal.id,
        metadata: { documentType: document.documentType, previousStatus: document.status, reasonLength: body.data.reason.length },
      });
      return present((await loadDocument(client, document.id))!, wibDate(now()), "HC");
    });
  });
}
