// EMP-010 Package 1 S4: the Perjanjian Kerja and Surat Keputusan register
// (spec §4.5, §13.5). Reading needs employment.read, recording and editing
// employment.manage; once a document is linked to a recorded action it is
// locked and only an audited correction (employment.correct, D-09) may change
// it. employment.* is HC-only: legacy Super Admin compatibility never grants it.
//
// EMP-011 D-16: a register document carries one current scanned file, stored through the
// employee-document storage boundary (EmployeeFileStore, D-01). Attaching needs employment.manage;
// replacing the file of a locked document also needs employment.correct and a reason; reading
// needs employment.read. Every attach, replace and read is audited.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import type { EmploymentPermission } from "../auth/permissions.js";
import { AUTH_COOKIE_NAME, AuthService, readCookie, type AuthPrincipal } from "../auth/service.js";
import { OUTSIDE_HCIS_CODE, OUTSIDE_HCIS_MESSAGE } from "../employees/management-scope.js";
import { STATUS_BY_CODE } from "./action-routes.js";
import { loadDecisionDocumentRefs } from "./infrastructure/postgres-action-store.js";
import {
  DEFAULT_EMPLOYMENT_POLICY,
  EmploymentDomainError,
  planDocumentLink,
  type LinkableAction,
  DECISION_DOCUMENT_KINDS,
  PK_CATEGORIES,
  PK_TYPES,
  SK_TYPES,
  isIsoDate,
  previousValuesOf,
  validateDecisionDocument,
  type DecisionDocumentValues,
} from "./domain/index.js";
import {
  DecisionDocumentNumberTaken,
  getDecisionDocument,
  getDecisionDocumentCorrections,
  getDecisionDocumentLinks,
  insertDecisionDocument,
  insertDecisionDocumentCorrection,
  listDecisionDocuments,
  lockDecisionDocument,
  updateDecisionDocument,
} from "./infrastructure/postgres-decision-document-store.js";
import { audit, getRolloutMode } from "./infrastructure/postgres-employment-store.js";
import {
  decodeDocumentFile,
  downloadFileName,
  EmployeeDocumentError,
  FILE_CONTENT_TYPES,
  UPLOAD_BODY_LIMIT,
} from "../employee-documents/domain.js";
import { fileDownloadHeaders, PostgresEmployeeFileStore } from "../employee-documents/file-store.js";

const optionalText = z.string().trim().max(500).nullish();

const documentBody = z.object({
  documentKind: z.enum(DECISION_DOCUMENT_KINDS),
  documentNumber: z.string().trim().min(1).max(120),
  signedOn: z.string().refine(isIsoDate),
  externalReference: optionalText,
  notes: z.string().trim().max(2000).nullish(),
  pkType: z.enum(PK_TYPES).nullish(),
  employeeId: z.string().uuid().nullish(),
  contractFrom: z.string().refine(isIsoDate).nullish(),
  contractTo: z.string().refine(isIsoDate).nullish(),
  category: z.enum(PK_CATEGORIES).nullish(),
  signatoryEmployerLabel: optionalText,
  previousPkId: z.string().uuid().nullish(),
  skType: z.enum(SK_TYPES).nullish(),
  subject: optionalText,
  issuingAuthorityLabel: optionalText,
  effectiveOn: z.string().refine(isIsoDate).nullish(),
  effectiveTo: z.string().refine(isIsoDate).nullish(),
});

/** expectedUpdatedAt is the version the operator had on screen (spec §12 EMPLOYMENT_VERSION_CONFLICT). */
const editBody = documentBody.extend({ expectedUpdatedAt: z.string().datetime().optional() });
const correctionBody = editBody.extend({ reason: z.string().trim().min(10).max(500) });

const listQuery = z.object({
  kind: z.enum(DECISION_DOCUMENT_KINDS),
  search: z.string().trim().max(120).optional(),
  year: z.coerce.number().int().min(1900).max(2999).optional(),
  pkType: z.enum(PK_TYPES).optional(),
  skType: z.enum(SK_TYPES).optional(),
  category: z.enum(PK_CATEGORIES).optional(),
  employeeId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const documentParams = z.object({ documentId: z.string().uuid() });
const actionParams = z.object({ actionId: z.string().uuid() });
const linkBody = z.object({ documentIds: z.array(z.string().uuid()).min(1).max(10) }).strict();

const fileBody = z.object({
  contentType: z.enum(FILE_CONTENT_TYPES),
  contentBase64: z.string().min(1).max(UPLOAD_BODY_LIMIT),
  reason: z.string().trim().min(10).max(500).optional(),
}).strict();

function send(reply: FastifyReply, status: number, body: unknown) {
  reply.header("Cache-Control", "no-store");
  return reply.status(status).send(body);
}

export async function registerDecisionDocumentRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
  injectedAuth?: Pick<AuthService, "getSession" | "getAuthorizationContext">,
) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required for decision document routes");
  const auth = injectedAuth ?? new AuthService(
    pool,
    config.AUTH_ENCRYPTION_KEY,
    config.AUTH_SESSION_TTL_HOURS,
    config.NODE_ENV === "production",
  );
  const files = new PostgresEmployeeFileStore(config.AUTH_ENCRYPTION_KEY);

  async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
    permission: EmploymentPermission,
  ): Promise<AuthPrincipal | null> {
    const session = await auth.getSession(readCookie(request.headers.cookie, AUTH_COOKIE_NAME));
    if (!session) {
      await send(reply, 401, { code: "UNAUTHENTICATED", message: "Sesi tidak ditemukan atau sudah berakhir." });
      return null;
    }
    const context = await auth.getAuthorizationContext(session.principal);
    if (!context.organizationPermissions.includes(permission)) {
      await send(reply, 403, { code: "EMPLOYMENT_FORBIDDEN", message: "Anda tidak memiliki akses untuk tindakan ini." });
      return null;
    }
    return session.principal;
  }

  /** The register follows the employment rollout mode; it is unavailable while OFF. */
  async function requireEnabled(reply: FastifyReply): Promise<boolean> {
    const { mode } = await getRolloutMode(pool);
    if (mode === "OFF") {
      await send(reply, 409, { code: "EMPLOYMENT_HISTORY_DISABLED", message: "Riwayat kepegawaian belum diaktifkan." });
      return false;
    }
    return true;
  }

  function invalid(reply: FastifyReply, message = "Data dokumen tidak valid.") {
    return send(reply, 400, { code: "DECISION_DOCUMENT_INVALID", message });
  }

  /** Checks the references the validated values actually keep; never the raw body. */
  async function validateReferences(
    reply: FastifyReply,
    values: DecisionDocumentValues,
    documentId: string | null,
  ): Promise<boolean> {
    if (values.employeeId) {
      const employee = await pool.query("SELECT id FROM employees WHERE id = $1", [values.employeeId]);
      if (!employee.rows[0]) {
        await send(reply, 404, { code: "EMPLOYEE_NOT_FOUND", message: "Pegawai tidak ditemukan." });
        return false;
      }
    }
    if (values.previousPkId) {
      if (values.previousPkId === documentId) {
        await send(reply, 422, {
          code: "DECISION_DOCUMENT_INVALID",
          field: "previousPkId",
          message: "Perjanjian Kerja tidak dapat menjadi perpanjangan dari dirinya sendiri.",
        });
        return false;
      }
      const previous = await getDecisionDocument(pool, values.previousPkId);
      if (!previous) {
        await send(reply, 404, {
          code: "DECISION_DOCUMENT_NOT_FOUND",
          message: "Perjanjian Kerja sebelumnya tidak ditemukan.",
        });
        return false;
      }
      if (previous.documentKind !== "PERJANJIAN_KERJA") {
        await send(reply, 422, {
          code: "DECISION_DOCUMENT_KIND_INVALID",
          message: "Dokumen sebelumnya bukan Perjanjian Kerja.",
        });
        return false;
      }
      if (previous.employeeId !== values.employeeId) {
        await send(reply, 422, {
          code: "DECISION_DOCUMENT_EMPLOYEE_MISMATCH",
          message: "Perjanjian Kerja ini milik pegawai lain.",
        });
        return false;
      }
    }
    return true;
  }

  app.get("/admin/decision-documents", async (request, reply) => {
    if (!(await authenticate(request, reply, "employment.read"))) return;
    const query = listQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, "Filter dokumen tidak valid.");
    if (!(await requireEnabled(reply))) return;
    const { page, pageSize } = query.data;
    const result = await listDecisionDocuments(pool, {
      kind: query.data.kind,
      search: query.data.search ?? null,
      year: query.data.year ?? null,
      pkType: query.data.pkType ?? null,
      skType: query.data.skType ?? null,
      category: query.data.category ?? null,
      employeeId: query.data.employeeId ?? null,
      page,
      pageSize,
    });
    return send(reply, 200, { kind: query.data.kind, page, pageSize, total: result.total, rows: result.rows });
  });

  app.post("/admin/decision-documents", async (request, reply) => {
    const principal = await authenticate(request, reply, "employment.manage");
    if (!principal) return;
    const body = documentBody.safeParse(request.body);
    if (!body.success) return invalid(reply);
    if (!(await requireEnabled(reply))) return;

    const validation = validateDecisionDocument(body.data);
    if (!validation.ok) {
      return send(reply, 400, { ...validation.failure });
    }
    if (!(await validateReferences(reply, validation.value, null))) return;

    let recorded = "";
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const id = await insertDecisionDocument(client, validation.value, principal.id);
      await audit(client, {
        actorAccountId: principal.id,
        action: "employment.document.recorded",
        entityType: "employment_decision_document",
        entityId: id,
        employeeId: validation.value.employeeId,
        payload: {
          documentKind: validation.value.documentKind,
          pkType: validation.value.pkType,
          skType: validation.value.skType,
          signedOn: validation.value.signedOn,
        },
      });
      await client.query("COMMIT");
      recorded = id;
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof DecisionDocumentNumberTaken) {
        return send(reply, 409, {
          code: "DECISION_DOCUMENT_NUMBER_TAKEN",
          message: "Nomor dokumen ini sudah tercatat untuk tahun yang sama.",
        });
      }
      throw error;
    } finally {
      client.release();
    }
    return send(reply, 201, await getDecisionDocument(pool, recorded));
  });

  app.get("/admin/decision-documents/:documentId", async (request, reply) => {
    if (!(await authenticate(request, reply, "employment.read"))) return;
    const params = documentParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "Dokumen tidak valid.");
    if (!(await requireEnabled(reply))) return;
    const document = await getDecisionDocument(pool, params.data.documentId);
    if (!document) return send(reply, 404, { code: "DECISION_DOCUMENT_NOT_FOUND", message: "Dokumen tidak ditemukan." });
    const [links, corrections, file] = await Promise.all([
      getDecisionDocumentLinks(pool, document.id),
      getDecisionDocumentCorrections(pool, document.id),
      files.current(pool, { purpose: "DECISION_DOCUMENT", decisionDocumentId: document.id }),
    ]);
    return send(reply, 200, {
      ...document,
      links,
      corrections,
      file: file ? { contentType: file.contentType, byteSize: file.byteSize, uploadedAt: file.createdAt } : null,
    });
  });

  // EMP-011 D-16: the scanned original of a register document.
  app.get("/admin/decision-documents/:documentId/file", async (request, reply) => {
    const principal = await authenticate(request, reply, "employment.read");
    if (!principal) return;
    const params = documentParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "Dokumen tidak valid.");
    if (!(await requireEnabled(reply))) return;
    const document = await getDecisionDocument(pool, params.data.documentId);
    if (!document) return send(reply, 404, { code: "DECISION_DOCUMENT_NOT_FOUND", message: "Dokumen tidak ditemukan." });
    const file = await files.read(pool, { purpose: "DECISION_DOCUMENT", decisionDocumentId: document.id });
    if (!file || !file.bytes) {
      return send(reply, 404, { code: "DECISION_DOCUMENT_FILE_NOT_FOUND", message: "Dokumen ini belum punya berkas." });
    }
    // EMP-011 D-11: recorded before a single byte leaves; a failed audit means no file.
    await audit(pool, {
      actorAccountId: principal.id,
      action: "employment.document.file_read",
      entityType: "employment_decision_document",
      entityId: document.id,
      employeeId: document.employeeId,
      payload: { documentKind: document.documentKind, fileId: file.id },
    });
    const prefix = document.documentKind === "PERJANJIAN_KERJA" ? "PK" : "SK";
    reply.headers(fileDownloadHeaders(file.contentType, downloadFileName(prefix, file.createdAt, file.contentType)));
    return reply.status(200).send(file.bytes);
  });

  app.put("/admin/decision-documents/:documentId/file", { bodyLimit: UPLOAD_BODY_LIMIT }, async (request, reply) => {
    const principal = await authenticate(request, reply, "employment.manage");
    if (!principal) return;
    const params = documentParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "Dokumen tidak valid.");
    const body = fileBody.safeParse(request.body);
    if (!body.success) return invalid(reply, "Berkas tidak valid. Alasan penggantian minimal 10 karakter.");
    if (!(await requireEnabled(reply))) return;
    let bytes: Buffer;
    try {
      bytes = decodeDocumentFile(body.data.contentType, body.data.contentBase64);
    } catch (error) {
      if (error instanceof EmployeeDocumentError) return send(reply, error.statusCode, { code: error.code, message: error.message });
      throw error;
    }
    const permissions = (await auth.getAuthorizationContext(principal)).organizationPermissions;
    const owner = { purpose: "DECISION_DOCUMENT" as const, decisionDocumentId: params.data.documentId };
    const client = await pool.connect();
    let outcome: { status: number; body: unknown };
    try {
      await client.query("BEGIN");
      const existing = await lockDecisionDocument(client, params.data.documentId);
      const current = existing ? await files.current(client, owner) : null;
      if (!existing) {
        outcome = { status: 404, body: { code: "DECISION_DOCUMENT_NOT_FOUND", message: "Dokumen tidak ditemukan." } };
      } else if (current && existing.locked && !permissions.includes("employment.correct")) {
        outcome = {
          status: 403,
          body: { code: "EMPLOYMENT_FORBIDDEN", message: "Mengganti berkas dokumen yang sudah dipakai pada tindakan butuh izin koreksi." },
        };
      } else if (current && existing.locked && !body.data.reason) {
        outcome = {
          status: 400,
          body: { code: "DECISION_DOCUMENT_INVALID", message: "Alasan penggantian berkas wajib diisi (minimal 10 karakter)." },
        };
      } else {
        if (current) await files.markReplaced(client, owner);
        const stored = await files.put(client, owner, { contentType: body.data.contentType, bytes }, principal.id);
        // EMP-010 D-09: replacing a locked document's file is a correction; its reason is kept there.
        if (current && existing.locked && body.data.reason) {
          await insertDecisionDocumentCorrection(client, {
            documentId: existing.id,
            previousValues: { fileId: current.id, fileContentType: current.contentType, fileByteSize: current.byteSize },
            reason: body.data.reason,
            actorAccountId: principal.id,
          });
        }
        await audit(client, {
          actorAccountId: principal.id,
          action: current ? "employment.document.file_replaced" : "employment.document.file_attached",
          entityType: "employment_decision_document",
          entityId: existing.id,
          employeeId: existing.employeeId,
          payload: {
            documentKind: existing.documentKind,
            locked: existing.locked,
            fileId: stored.id,
            contentType: stored.contentType,
            byteSize: stored.byteSize,
            ...(current ? { replacedFileId: current.id, reasonLength: body.data.reason?.length ?? 0 } : {}),
          },
        });
        outcome = { status: 200, body: { contentType: stored.contentType, byteSize: stored.byteSize, uploadedAt: stored.createdAt } };
      }
      await client.query(outcome.status === 200 ? "COMMIT" : "ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return send(reply, outcome.status, outcome.body);
  });

  /**
   * One write path for both an edit of an unlinked document (employment.manage)
   * and an audited correction of a locked one (employment.correct): the body of
   * a correction carries a reason, and the prior values are kept either way.
   *
   * Everything that depends on the stored row — the kind, the Perjanjian Kerja
   * employee, the lock, and the values a correction keeps — is decided inside
   * the transaction on the row read under FOR UPDATE, so an action linking the
   * document meanwhile cannot let a plain edit slip past the lock, and the
   * correction never keeps values that were already stale when it was read.
   */
  async function writeDocument(
    request: FastifyRequest,
    reply: FastifyReply,
    mode: "edit" | "correction",
  ) {
    const permission: EmploymentPermission = mode === "edit" ? "employment.manage" : "employment.correct";
    const principal = await authenticate(request, reply, permission);
    if (!principal) return;
    const params = documentParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "Dokumen tidak valid.");
    const parsed = mode === "edit" ? editBody.safeParse(request.body) : correctionBody.safeParse(request.body);
    if (!parsed.success) {
      return invalid(reply, mode === "correction" ? "Data koreksi tidak valid (alasan minimal 10 karakter)." : undefined);
    }
    if (!(await requireEnabled(reply))) return;

    const body = parsed.data;
    const reason: string = "reason" in body && typeof body.reason === "string" ? body.reason : "";
    const validation = validateDecisionDocument(body);
    if (!validation.ok) return send(reply, 400, { ...validation.failure });
    if (!(await validateReferences(reply, validation.value, params.data.documentId))) return;

    let written = false;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await lockDecisionDocument(client, params.data.documentId);
      if (!existing) {
        await client.query("ROLLBACK");
        return send(reply, 404, { code: "DECISION_DOCUMENT_NOT_FOUND", message: "Dokumen tidak ditemukan." });
      }
      if (body.documentKind !== existing.documentKind) {
        await client.query("ROLLBACK");
        return send(reply, 422, {
          code: "DECISION_DOCUMENT_KIND_INVALID",
          message: "Jenis dokumen tidak dapat diubah. Catat dokumen baru bila jenisnya berbeda.",
        });
      }
      if (existing.documentKind === "PERJANJIAN_KERJA" && validation.value.employeeId !== existing.employeeId) {
        await client.query("ROLLBACK");
        return send(reply, 422, {
          code: "DECISION_DOCUMENT_EMPLOYEE_MISMATCH",
          message: "Pegawai pada Perjanjian Kerja tidak dapat diubah.",
        });
      }
      if (mode === "edit" && existing.locked) {
        await client.query("ROLLBACK");
        return send(reply, 409, {
          code: "DECISION_DOCUMENT_LOCKED",
          message: "Dokumen sudah dipakai pada tindakan; gunakan koreksi.",
        });
      }
      if (body.expectedUpdatedAt && body.expectedUpdatedAt !== existing.updatedAt) {
        await client.query("ROLLBACK");
        return send(reply, 409, {
          code: "EMPLOYMENT_VERSION_CONFLICT",
          message: "Data berubah sejak Anda membuka halaman. Muat ulang lalu ulangi.",
        });
      }

      const previousValues = previousValuesOf(existing);
      const nextValues = previousValuesOf(validation.value);
      await updateDecisionDocument(client, existing.id, validation.value);
      if (mode === "correction") {
        await insertDecisionDocumentCorrection(client, {
          documentId: existing.id,
          previousValues,
          reason,
          actorAccountId: principal.id,
        });
      }
      await audit(client, {
        actorAccountId: principal.id,
        action: mode === "edit" ? "employment.document.updated" : "employment.document.corrected",
        entityType: "employment_decision_document",
        entityId: existing.id,
        employeeId: existing.employeeId,
        payload: {
          documentKind: existing.documentKind,
          locked: existing.locked,
          changedFields: Object.keys(previousValues).filter((field) => previousValues[field] !== nextValues[field]),
        },
      });
      await client.query("COMMIT");
      written = true;
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof DecisionDocumentNumberTaken) {
        return send(reply, 409, {
          code: "DECISION_DOCUMENT_NUMBER_TAKEN",
          message: "Nomor dokumen ini sudah tercatat untuk tahun yang sama.",
        });
      }
      throw error;
    } finally {
      client.release();
    }
    if (!written) return;
    return send(reply, 200, await getDecisionDocument(pool, params.data.documentId));
  }

  app.patch("/admin/decision-documents/:documentId", (request, reply) => writeDocument(request, reply, "edit"));
  app.post("/admin/decision-documents/:documentId/corrections", (request, reply) =>
    writeDocument(request, reply, "correction"),
  );

  /**
   * EMP-010-A: link PK/SK to an action that is already recorded, for the document that
   * arrives after the action (or the one behind the baseline data). Same gate as recording
   * an action: employment.manage, mode AUTHORITATIVE, never one's own record, never a record
   * outside HCIS management. Linking locks the document (D-09) and is audited per document.
   */
  app.post("/admin/employment-actions/:actionId/documents", async (request, reply) => {
    const principal = await authenticate(request, reply, "employment.manage");
    if (!principal) return;
    const params = actionParams.safeParse(request.params);
    if (!params.success) {
      return send(reply, 400, { code: "INVALID_EMPLOYMENT_REQUEST", message: "Tindakan tidak valid." });
    }
    const body = linkBody.safeParse(request.body);
    if (!body.success) return invalid(reply, "Pilih satu sampai sepuluh dokumen.");
    const { mode } = await getRolloutMode(pool);
    if (mode !== "AUTHORITATIVE") {
      return send(reply, 409, { code: "EMPLOYMENT_HISTORY_DISABLED", message: "Riwayat kepegawaian belum diaktifkan." });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query<{
        id: string; employeeId: string; actionType: LinkableAction["actionType"]; state: LinkableAction["state"];
        reasonCode: string | null; newSnapshot: LinkableAction["newSnapshot"]; outside: boolean;
      }>(
        `SELECT a.id, a.employee_id AS "employeeId", a.action_type AS "actionType", a.state,
                a.reason_code AS "reasonCode", a.new_snapshot AS "newSnapshot",
                (e.management_scope = 'OUTSIDE_HCIS') AS outside
         FROM employment_actions a JOIN employees e ON e.id = a.employee_id AND e.removed_at IS NULL
         WHERE a.id = $1
         FOR UPDATE OF a`,
        [params.data.actionId],
      );
      const action = found.rows[0];
      if (!action) {
        await client.query("ROLLBACK");
        return send(reply, 404, { code: "EMPLOYMENT_ACTION_NOT_FOUND", message: "Tindakan tidak ditemukan." });
      }
      if (action.outside) {
        await client.query("ROLLBACK");
        return send(reply, 409, { code: OUTSIDE_HCIS_CODE, message: OUTSIDE_HCIS_MESSAGE });
      }
      const actor = await client.query<{ employeeId: string }>(
        `SELECT employee_id AS "employeeId" FROM accounts WHERE id = $1 AND employee_id IS NOT NULL`,
        [principal.id],
      );
      if (actor.rows[0]?.employeeId === action.employeeId) {
        await client.query("ROLLBACK");
        return send(reply, 403, {
          code: "EMPLOYMENT_SELF_ACTION_FORBIDDEN",
          message: "Tindakan kepegawaian untuk diri sendiri harus dicatat oleh petugas lain.",
        });
      }

      const requested = [...new Set(body.data.documentIds)];
      // Lock in id order so two concurrent links cannot deadlock; a locked row stays put
      // while it is checked and linked (the link is what makes it immutable, D-09).
      await client.query(
        "SELECT id FROM employment_decision_documents WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE",
        [requested],
      );
      const documents = await loadDecisionDocumentRefs(client, requested);
      if (documents.length !== requested.length) {
        await client.query("ROLLBACK");
        return send(reply, 404, { code: "DECISION_DOCUMENT_NOT_FOUND", message: "Dokumen dasar tidak ditemukan." });
      }
      const ordered = requested.map((id) => documents.find((document) => document.id === id)!);
      const existing = await client.query<{ documentId: string }>(
        `SELECT document_id AS "documentId" FROM employment_action_documents WHERE action_id = $1`,
        [action.id],
      );
      const plan = planDocumentLink(
        action,
        ordered,
        existing.rows.map((row) => row.documentId),
        DEFAULT_EMPLOYMENT_POLICY,
      );
      for (const documentId of plan.link) {
        await client.query(
          "INSERT INTO employment_action_documents (action_id, document_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [action.id, documentId],
        );
        await audit(client, {
          actorAccountId: principal.id,
          action: "employment.decision_document.linked",
          entityType: "employment_decision_document",
          entityId: documentId,
          employeeId: action.employeeId,
          payload: { documentId, actionId: action.id, actionType: action.actionType, after: "RECORDED" },
        });
      }
      await client.query("COMMIT");
      return send(reply, plan.link.length > 0 ? 201 : 200, {
        actionId: action.id,
        linkedDocumentIds: plan.link,
        alreadyLinkedDocumentIds: plan.alreadyLinked,
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // A failed ROLLBACK must not hide the error that caused it.
      }
      if (error instanceof EmploymentDomainError) {
        return send(reply, STATUS_BY_CODE[error.code], { code: error.code, message: error.message });
      }
      throw error;
    } finally {
      client.release();
    }
  });
}
