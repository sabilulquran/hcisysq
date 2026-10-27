// DOC-001 / DOC-002 Package 1 routes.
// Spec: docs/domain/hr-documents.md.
//
// documents.* is HC-only: legacy Super Admin compatibility never grants it, so
// these routes resolve the permission from the organization context directly
// instead of going through requirePermissionsFromCookie (ADMIN_PERMISSIONS).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import type { DocumentPermission } from "../auth/permissions.js";
import { AUTH_COOKIE_NAME, AuthService, readCookie, type AuthPrincipal } from "../auth/service.js";
import { notifyEmployee } from "../notifications/service.js";
import {
  DEFAULT_DISCIPLINARY_MONTHS,
  DISCIPLINARY_LEVELS,
  DocumentError,
  MAX_OPEN_REQUESTS,
  addMonths,
  assertEmploymentStateAllows,
  buildContentSnapshot,
  isDisciplinaryActive,
  issueDocument,
  listDocumentTypes,
  loadEmployeeFacts,
  writeDocumentAudit,
} from "./service.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tanggal harus YYYY-MM-DD");

const requestBody = z.object({
  documentCode: z.string().trim().min(1).max(64),
  purpose: z.string().trim().min(5).max(500),
});
const decisionBody = z.object({ note: z.string().trim().max(500).optional() });
const rejectBody = z.object({ note: z.string().trim().min(5).max(500) });
const revokeBody = z.object({ reason: z.string().trim().min(10).max(500) });
const directIssueBody = z.object({
  employeeId: z.string().uuid(),
  documentCode: z.string().trim().min(1).max(64),
  purpose: z.string().trim().min(5).max(500),
});
const disciplinaryBody = z.object({
  employeeId: z.string().uuid(),
  level: z.enum(DISCIPLINARY_LEVELS),
  subject: z.string().trim().min(5).max(200),
  narrative: z.string().trim().min(10).max(4000),
  effectiveDate: isoDate,
  expiresOn: isoDate.optional(),
});
const idParams = z.object({ id: z.string().uuid() });
const registerQuery = z.object({
  status: z.enum(["SUBMITTED", "APPROVED", "REJECTED", "CANCELLED", "ISSUED"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const OPEN_REQUEST_STATES = ["SUBMITTED", "APPROVED"] as const;

function send(reply: FastifyReply, status: number, body: unknown) {
  reply.header("Cache-Control", "no-store");
  return reply.status(status).send(body);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function registerDocumentRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
  injectedAuth?: Pick<AuthService, "getSession" | "getAuthorizationContext">,
) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required for document routes");
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

  async function requirePermission(
    request: FastifyRequest,
    reply: FastifyReply,
    ...permissions: DocumentPermission[]
  ): Promise<AuthPrincipal | null> {
    const principal = await authenticate(request, reply);
    if (!principal) return null;
    const context = await auth.getAuthorizationContext(principal);
    const granted = permissions.every((key) => context.organizationPermissions.includes(key));
    if (!granted) {
      await send(reply, 403, { code: "DOCUMENT_FORBIDDEN", message: "Anda tidak memiliki akses untuk tindakan ini." });
      return null;
    }
    return principal;
  }

  /** Self access is ownership, not a permission: the employee id comes from the session. */
  async function requireSelf(request: FastifyRequest, reply: FastifyReply) {
    const principal = await authenticate(request, reply);
    if (!principal) return null;
    if (principal.principalType !== "EMPLOYEE") {
      await send(reply, 403, { code: "FORBIDDEN", message: "Dokumen pribadi hanya tersedia untuk pegawai." });
      return null;
    }
    const result = await pool.query<{ employeeId: string }>(
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
    const employeeId = result.rows[0]?.employeeId;
    if (!employeeId) {
      await send(reply, 403, {
        code: "EMPLOYEE_LINK_REQUIRED",
        message: "Account employee tidak terhubung ke employee aktif.",
      });
      return null;
    }
    return { principal, employeeId };
  }

  function handleDocumentError(reply: FastifyReply, error: unknown) {
    if (error instanceof DocumentError) return send(reply, error.statusCode, { code: error.code, message: error.message });
    throw error;
  }

  // ---------------------------------------------------------------- employee

  app.get("/documents/me/types", async (request, reply) => {
    const self = await requireSelf(request, reply);
    if (!self) return;
    const types = await listDocumentTypes(pool);
    return send(reply, 200, {
      items: types
        .filter((type) => type.selfRequestable && type.available)
        .map((type) => ({ code: type.code, label: type.label })),
    });
  });

  app.get("/documents/me/requests", async (request, reply) => {
    const self = await requireSelf(request, reply);
    if (!self) return;
    const result = await pool.query(
      `SELECT request.id, request.document_code AS "documentCode", type.label AS "documentLabel",
              request.purpose, request.status, request.decision_note AS "decisionNote",
              request.decided_at AS "decidedAt", request.created_at AS "createdAt",
              request.issued_document_id AS "issuedDocumentId",
              issued.document_number AS "documentNumber"
         FROM hr_document_requests request
         JOIN hr_document_types type ON type.code = request.document_code
         LEFT JOIN hr_issued_documents issued ON issued.id = request.issued_document_id
        WHERE request.employee_id = $1
        ORDER BY request.created_at DESC
        LIMIT 100`,
      [self.employeeId],
    );
    return send(reply, 200, { items: result.rows });
  });

  app.post("/documents/me/requests", async (request, reply) => {
    const self = await requireSelf(request, reply);
    if (!self) return;
    const body = requestBody.safeParse(request.body);
    if (!body.success) {
      return send(reply, 400, { code: "INVALID_DOCUMENT_REQUEST", message: "Jenis surat atau keperluan tidak valid (keperluan minimal 5 karakter)." });
    }
    const types = await listDocumentTypes(pool);
    const type = types.find((candidate) => candidate.code === body.data.documentCode);
    if (!type || !type.selfRequestable || !type.available) {
      return send(reply, 409, { code: "DOCUMENT_TYPE_UNAVAILABLE", message: "Jenis surat ini belum tersedia." });
    }
    const open = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM hr_document_requests
        WHERE employee_id = $1 AND status = ANY($2::text[])`,
      [self.employeeId, [...OPEN_REQUEST_STATES]],
    );
    if ((open.rows[0]?.count ?? 0) >= MAX_OPEN_REQUESTS) {
      return send(reply, 409, {
        code: "DOCUMENT_REQUEST_LIMIT",
        message: `Anda masih memiliki ${MAX_OPEN_REQUESTS} permintaan yang belum selesai.`,
      });
    }
    const id = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO hr_document_requests (id, employee_id, document_code, purpose, status)
         VALUES ($1,$2,$3,$4,'SUBMITTED')`,
        [id, self.employeeId, type.code, body.data.purpose],
      );
      await writeDocumentAudit(client, {
        eventType: "doc.request.submitted",
        requestId: id,
        employeeId: self.employeeId,
        actorAccountId: self.principal.id,
        metadata: { documentCode: type.code },
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return send(reply, 201, { id, status: "SUBMITTED" });
  });

  app.post("/documents/me/requests/:id/cancel", async (request, reply) => {
    const self = await requireSelf(request, reply);
    if (!self) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_DOCUMENT_ID", message: "Permintaan tidak valid." });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const changed = await client.query(
        `UPDATE hr_document_requests
            SET status = 'CANCELLED', updated_at = now()
          WHERE id = $1 AND employee_id = $2 AND status = 'SUBMITTED'
          RETURNING id`,
        [params.data.id, self.employeeId],
      );
      if (!changed.rows[0]) {
        await client.query("ROLLBACK");
        return send(reply, 409, { code: "DOCUMENT_REQUEST_NOT_CANCELLABLE", message: "Permintaan tidak dapat dibatalkan." });
      }
      await writeDocumentAudit(client, {
        eventType: "doc.request.cancelled",
        requestId: params.data.id,
        employeeId: self.employeeId,
        actorAccountId: self.principal.id,
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return send(reply, 200, { id: params.data.id, status: "CANCELLED" });
  });

  app.get("/documents/me/issued", async (request, reply) => {
    const self = await requireSelf(request, reply);
    if (!self) return;
    const result = await pool.query(
      `SELECT id, document_code AS "documentCode", document_number AS "documentNumber",
              status, issued_at AS "issuedAt", signer, content_snapshot AS "contentSnapshot"
         FROM hr_issued_documents
        WHERE employee_id = $1 AND document_kind = 'CERTIFICATE'
        ORDER BY issued_at DESC
        LIMIT 100`,
      [self.employeeId],
    );
    return send(reply, 200, { items: result.rows });
  });

  app.get("/documents/me/disciplinary", async (request, reply) => {
    const self = await requireSelf(request, reply);
    if (!self) return;
    const result = await pool.query<{ expiresOn: string }>(
      `SELECT letter.id, letter.level, letter.subject, letter.narrative,
              to_char(letter.effective_date, 'YYYY-MM-DD') AS "effectiveDate",
              to_char(letter.expires_on, 'YYYY-MM-DD') AS "expiresOn",
              letter.acknowledged_at AS "acknowledgedAt",
              issued.document_number AS "documentNumber", issued.status, issued.signer
         FROM hr_disciplinary_letters letter
         JOIN hr_issued_documents issued ON issued.id = letter.issued_document_id
        WHERE letter.employee_id = $1
        ORDER BY letter.effective_date DESC`,
      [self.employeeId],
    );
    const now = today();
    return send(reply, 200, {
      items: result.rows.map((row) => ({ ...row, active: isDisciplinaryActive(row.expiresOn, now) })),
    });
  });

  app.post("/documents/me/disciplinary/:id/acknowledge", async (request, reply) => {
    const self = await requireSelf(request, reply);
    if (!self) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_DOCUMENT_ID", message: "Surat tidak valid." });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // DOC-002-C: the employee filter is what stops acknowledging someone else's letter.
      const changed = await client.query(
        `UPDATE hr_disciplinary_letters
            SET acknowledged_at = coalesce(acknowledged_at, now())
          WHERE id = $1 AND employee_id = $2
          RETURNING id, acknowledged_at AS "acknowledgedAt"`,
        [params.data.id, self.employeeId],
      );
      if (!changed.rows[0]) {
        await client.query("ROLLBACK");
        return send(reply, 404, { code: "DOCUMENT_NOT_FOUND", message: "Surat tidak ditemukan." });
      }
      await writeDocumentAudit(client, {
        eventType: "doc.discipline.acknowledged",
        employeeId: self.employeeId,
        actorAccountId: self.principal.id,
        metadata: { letterId: params.data.id },
      });
      await client.query("COMMIT");
      return send(reply, 200, changed.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  // ------------------------------------------------------------------- admin

  app.get("/admin/documents/types", async (request, reply) => {
    if (!(await requirePermission(request, reply, "documents.read"))) return;
    return send(reply, 200, { items: await listDocumentTypes(pool) });
  });

  app.get("/admin/documents/requests", async (request, reply) => {
    if (!(await requirePermission(request, reply, "documents.read"))) return;
    const query = registerQuery.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_DOCUMENT_FILTER", message: "Filter tidak valid." });
    const values: unknown[] = [];
    let statusClause = "";
    if (query.data.status) {
      values.push(query.data.status);
      statusClause = `WHERE request.status = $${values.length}`;
    }
    values.push(query.data.limit);
    const result = await pool.query(
      `SELECT request.id, request.document_code AS "documentCode", type.label AS "documentLabel",
              request.purpose, request.status, request.created_at AS "createdAt",
              request.decided_at AS "decidedAt", request.decision_note AS "decisionNote",
              employee.id AS "employeeId", employee.full_name AS "employeeName",
              employee.employee_number AS "employeeNumber",
              issued.document_number AS "documentNumber"
         FROM hr_document_requests request
         JOIN hr_document_types type ON type.code = request.document_code
         JOIN employees employee ON employee.id = request.employee_id
         LEFT JOIN hr_issued_documents issued ON issued.id = request.issued_document_id
         ${statusClause}
        ORDER BY request.created_at DESC
        LIMIT $${values.length}`,
      values,
    );
    return send(reply, 200, { items: result.rows });
  });

  async function decideRequest(
    request: FastifyRequest,
    reply: FastifyReply,
    decision: "APPROVED" | "REJECTED",
  ) {
    const principal = await requirePermission(request, reply, "documents.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_DOCUMENT_ID", message: "Permintaan tidak valid." });
    const parsedBody = decision === "REJECTED" ? rejectBody.safeParse(request.body) : decisionBody.safeParse(request.body);
    if (!parsedBody.success) {
      return send(reply, 400, { code: "INVALID_DOCUMENT_DECISION", message: "Alasan penolakan wajib diisi, minimal 5 karakter." });
    }
    const note = parsedBody.data.note ?? null;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const changed = await client.query<{ employeeId: string; documentCode: string }>(
        `UPDATE hr_document_requests
            SET status = $2, decided_by_account_id = $3, decided_at = now(), decision_note = $4, updated_at = now()
          WHERE id = $1 AND status = 'SUBMITTED'
          RETURNING employee_id AS "employeeId", document_code AS "documentCode"`,
        [params.data.id, decision, principal.id, note],
      );
      if (!changed.rows[0]) {
        await client.query("ROLLBACK");
        return send(reply, 409, { code: "DOCUMENT_REQUEST_NOT_OPEN", message: "Permintaan sudah diputuskan." });
      }
      await writeDocumentAudit(client, {
        eventType: decision === "APPROVED" ? "doc.request.approved" : "doc.request.rejected",
        requestId: params.data.id,
        employeeId: changed.rows[0].employeeId,
        actorAccountId: principal.id,
        reason: note,
      });
      await notifyEmployee(client, changed.rows[0].employeeId, {
        eventKey: `doc.request.${params.data.id}.${decision}`,
        category: "system",
        title: decision === "APPROVED" ? "Permintaan surat disetujui" : "Permintaan surat ditolak",
        body: decision === "APPROVED"
          ? "Permintaan surat Anda disetujui dan sedang disiapkan."
          : "Permintaan surat Anda tidak dapat diproses. Lihat catatan dari Human Capital.",
        href: "/app/services/documents",
      });
      await client.query("COMMIT");
      return send(reply, 200, { id: params.data.id, status: decision });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  app.post("/admin/documents/requests/:id/approve", (request, reply) => decideRequest(request, reply, "APPROVED"));
  app.post("/admin/documents/requests/:id/reject", (request, reply) => decideRequest(request, reply, "REJECTED"));

  app.post("/admin/documents/requests/:id/issue", async (request, reply) => {
    const principal = await requirePermission(request, reply, "documents.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_DOCUMENT_ID", message: "Permintaan tidak valid." });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query<{ employeeId: string; documentCode: string; purpose: string }>(
        `SELECT employee_id AS "employeeId", document_code AS "documentCode", purpose
           FROM hr_document_requests
          WHERE id = $1 AND status = 'APPROVED'
          FOR UPDATE`,
        [params.data.id],
      );
      const found0 = found.rows[0];
      if (!found0) {
        await client.query("ROLLBACK");
        return send(reply, 409, { code: "DOCUMENT_REQUEST_NOT_APPROVED", message: "Permintaan belum disetujui atau sudah terbit." });
      }
      const types = await listDocumentTypes(client);
      const type = types.find((candidate) => candidate.code === found0.documentCode)!;
      const employee = await loadEmployeeFacts(client, found0.employeeId);
      if (!employee) {
        await client.query("ROLLBACK");
        return send(reply, 404, { code: "EMPLOYEE_NOT_FOUND", message: "Pegawai tidak ditemukan." });
      }
      assertEmploymentStateAllows(type, employee);
      const issued = await issueDocument(client, {
        documentKind: "CERTIFICATE",
        documentCode: type.code,
        numberCode: type.numberCode,
        employee,
        issuedByAccountId: principal.id,
        contentSnapshot: buildContentSnapshot(employee, { purpose: found0.purpose, documentLabel: type.label }),
      });
      await client.query(
        `UPDATE hr_document_requests SET status = 'ISSUED', issued_document_id = $2, updated_at = now() WHERE id = $1`,
        [params.data.id, issued.id],
      );
      await writeDocumentAudit(client, {
        eventType: "doc.issued",
        requestId: params.data.id,
        issuedDocumentId: issued.id,
        employeeId: employee.id,
        actorAccountId: principal.id,
        metadata: { documentCode: type.code, documentNumber: issued.documentNumber },
      });
      await notifyEmployee(client, employee.id, {
        eventKey: `doc.issued.${issued.id}`,
        category: "system",
        title: "Surat Anda sudah terbit",
        body: `${type.label} dengan nomor ${issued.documentNumber} sudah dapat dilihat.`,
        href: "/app/services/documents",
      });
      await client.query("COMMIT");
      return send(reply, 201, issued);
    } catch (error) {
      await client.query("ROLLBACK");
      return handleDocumentError(reply, error);
    } finally {
      client.release();
    }
  });

  /** HC issues directly, without a request: paklaring for an employee who has left. */
  app.post("/admin/documents/issue", async (request, reply) => {
    const principal = await requirePermission(request, reply, "documents.manage");
    if (!principal) return;
    const body = directIssueBody.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "INVALID_DOCUMENT_REQUEST", message: "Data penerbitan tidak valid." });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const types = await listDocumentTypes(client);
      const type = types.find((candidate) => candidate.code === body.data.documentCode);
      if (!type) {
        await client.query("ROLLBACK");
        return send(reply, 404, { code: "DOCUMENT_TYPE_NOT_FOUND", message: "Jenis surat tidak ditemukan." });
      }
      const employee = await loadEmployeeFacts(client, body.data.employeeId);
      if (!employee) {
        await client.query("ROLLBACK");
        return send(reply, 404, { code: "EMPLOYEE_NOT_FOUND", message: "Pegawai tidak ditemukan." });
      }
      assertEmploymentStateAllows(type, employee);
      const issued = await issueDocument(client, {
        documentKind: "CERTIFICATE",
        documentCode: type.code,
        numberCode: type.numberCode,
        employee,
        issuedByAccountId: principal.id,
        contentSnapshot: buildContentSnapshot(employee, { purpose: body.data.purpose, documentLabel: type.label }),
      });
      await writeDocumentAudit(client, {
        eventType: "doc.issued",
        issuedDocumentId: issued.id,
        employeeId: employee.id,
        actorAccountId: principal.id,
        metadata: { documentCode: type.code, documentNumber: issued.documentNumber },
      });
      await client.query("COMMIT");
      return send(reply, 201, issued);
    } catch (error) {
      await client.query("ROLLBACK");
      return handleDocumentError(reply, error);
    } finally {
      client.release();
    }
  });

  app.get("/admin/documents/register", async (request, reply) => {
    if (!(await requirePermission(request, reply, "documents.read"))) return;
    const result = await pool.query(
      `SELECT issued.id, issued.document_kind AS "documentKind", issued.document_code AS "documentCode",
              issued.document_number AS "documentNumber", issued.status,
              issued.issued_at AS "issuedAt", issued.signer,
              employee.full_name AS "employeeName", employee.employee_number AS "employeeNumber"
         FROM hr_issued_documents issued
         JOIN employees employee ON employee.id = issued.employee_id
        WHERE issued.document_kind = 'CERTIFICATE'
        ORDER BY issued.issued_at DESC
        LIMIT 200`,
    );
    return send(reply, 200, { items: result.rows });
  });

  app.post("/admin/documents/issued/:id/revoke", async (request, reply) => {
    const principal = await requirePermission(request, reply, "documents.correct");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_DOCUMENT_ID", message: "Surat tidak valid." });
    const body = revokeBody.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "INVALID_DOCUMENT_REVOKE", message: "Alasan pembatalan minimal 10 karakter." });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // D-03: the number stays allocated; only the status changes.
      const changed = await client.query<{ employeeId: string; documentKind: string }>(
        `UPDATE hr_issued_documents
            SET status = 'REVOKED', revoked_at = now(), revoked_by_account_id = $2, revoke_reason = $3
          WHERE id = $1 AND status = 'ISSUED'
          RETURNING employee_id AS "employeeId", document_kind AS "documentKind"`,
        [params.data.id, principal.id, body.data.reason],
      );
      if (!changed.rows[0]) {
        await client.query("ROLLBACK");
        return send(reply, 409, { code: "DOCUMENT_NOT_REVOCABLE", message: "Surat tidak ditemukan atau sudah dibatalkan." });
      }
      await writeDocumentAudit(client, {
        eventType: changed.rows[0].documentKind === "DISCIPLINARY" ? "doc.discipline.revoked" : "doc.revoked",
        issuedDocumentId: params.data.id,
        employeeId: changed.rows[0].employeeId,
        actorAccountId: principal.id,
        reason: body.data.reason,
      });
      await client.query("COMMIT");
      return send(reply, 200, { id: params.data.id, status: "REVOKED" });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  // ------------------------------------------------------------- disciplinary

  app.get("/admin/documents/disciplinary", async (request, reply) => {
    if (!(await requirePermission(request, reply, "documents.discipline.manage"))) return;
    const result = await pool.query<{ expiresOn: string }>(
      `SELECT letter.id, letter.level, letter.subject,
              to_char(letter.effective_date, 'YYYY-MM-DD') AS "effectiveDate",
              to_char(letter.expires_on, 'YYYY-MM-DD') AS "expiresOn",
              letter.acknowledged_at AS "acknowledgedAt",
              issued.document_number AS "documentNumber", issued.status,
              employee.id AS "employeeId", employee.full_name AS "employeeName",
              employee.employee_number AS "employeeNumber"
         FROM hr_disciplinary_letters letter
         JOIN hr_issued_documents issued ON issued.id = letter.issued_document_id
         JOIN employees employee ON employee.id = letter.employee_id
        ORDER BY letter.effective_date DESC
        LIMIT 200`,
    );
    const now = today();
    return send(reply, 200, {
      items: result.rows.map((row) => ({ ...row, active: isDisciplinaryActive(row.expiresOn, now) })),
    });
  });

  app.post("/admin/documents/disciplinary", async (request, reply) => {
    const principal = await requirePermission(request, reply, "documents.discipline.manage");
    if (!principal) return;
    const body = disciplinaryBody.safeParse(request.body);
    if (!body.success) {
      return send(reply, 400, { code: "INVALID_DISCIPLINARY_LETTER", message: "Data surat peringatan tidak valid." });
    }
    const expiresOn = body.data.expiresOn ?? addMonths(body.data.effectiveDate, DEFAULT_DISCIPLINARY_MONTHS);
    if (expiresOn < body.data.effectiveDate) {
      return send(reply, 400, { code: "INVALID_DISCIPLINARY_PERIOD", message: "Tanggal berakhir mendahului tanggal berlaku." });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const employee = await loadEmployeeFacts(client, body.data.employeeId);
      if (!employee) {
        await client.query("ROLLBACK");
        return send(reply, 404, { code: "EMPLOYEE_NOT_FOUND", message: "Pegawai tidak ditemukan." });
      }
      if (employee.status !== "active") {
        await client.query("ROLLBACK");
        return send(reply, 409, { code: "DOCUMENT_EMPLOYMENT_STATE", message: "Surat peringatan hanya untuk pegawai aktif." });
      }
      // DOC-002-E: an out-of-order level is a warning, never a refusal (D-11).
      const existing = await client.query<{ level: string; expiresOn: string }>(
        `SELECT letter.level, to_char(letter.expires_on, 'YYYY-MM-DD') AS "expiresOn"
           FROM hr_disciplinary_letters letter
           JOIN hr_issued_documents issued ON issued.id = letter.issued_document_id
          WHERE letter.employee_id = $1 AND issued.status = 'ISSUED' AND letter.expires_on >= current_date`,
        [employee.id],
      );
      const warnings = buildLevelWarnings(body.data.level, existing.rows.map((row) => row.level));
      const issued = await issueDocument(client, {
        documentKind: "DISCIPLINARY",
        documentCode: body.data.level,
        numberCode: body.data.level,
        employee,
        issuedByAccountId: principal.id,
        contentSnapshot: buildContentSnapshot(employee, {
          level: body.data.level,
          subject: body.data.subject,
          effectiveDate: body.data.effectiveDate,
          expiresOn,
        }),
      });
      const letterId = randomUUID();
      await client.query(
        `INSERT INTO hr_disciplinary_letters (
           id, issued_document_id, employee_id, level, subject, narrative, effective_date, expires_on
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          letterId, issued.id, employee.id, body.data.level, body.data.subject,
          body.data.narrative, body.data.effectiveDate, expiresOn,
        ],
      );
      await writeDocumentAudit(client, {
        eventType: "doc.discipline.issued",
        issuedDocumentId: issued.id,
        employeeId: employee.id,
        actorAccountId: principal.id,
        // Spec §7: the narrative never reaches the audit trail.
        metadata: { level: body.data.level, documentNumber: issued.documentNumber, effectiveDate: body.data.effectiveDate },
      });
      // DOC-002-G: a neutral preview, without the narrative.
      await notifyEmployee(client, employee.id, {
        eventKey: `doc.discipline.${issued.id}`,
        category: "system",
        title: "Dokumen kepegawaian baru",
        body: "Ada dokumen kepegawaian yang perlu Anda baca dan konfirmasi.",
        href: "/app/services/documents",
      });
      await client.query("COMMIT");
      return send(reply, 201, { id: letterId, documentNumber: issued.documentNumber, expiresOn, warnings });
    } catch (error) {
      await client.query("ROLLBACK");
      return handleDocumentError(reply, error);
    } finally {
      client.release();
    }
  });
}

/** D-11: HC keeps the decision; the system only says what looks unusual. */
export function buildLevelWarnings(level: string, activeLevels: string[]): string[] {
  const warnings: string[] = [];
  const rank = (value: string) => DISCIPLINARY_LEVELS.indexOf(value as (typeof DISCIPLINARY_LEVELS)[number]);
  const highest = activeLevels.reduce((best, current) => (rank(current) > rank(best) ? current : best), activeLevels[0] ?? "");
  if (highest && rank(level) <= rank(highest)) {
    warnings.push(`Pegawai masih memiliki ${highest} yang berlaku.`);
  }
  if (!activeLevels.length && level !== "SP1") {
    warnings.push("Tidak ada surat peringatan yang masih berlaku; tingkat ini melompat dari SP1.");
  }
  return warnings;
}
