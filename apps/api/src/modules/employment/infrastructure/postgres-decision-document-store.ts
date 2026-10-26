// EMP-010 S4 register adapter. Rules live in ../domain/decision-documents.ts;
// this file only reads and writes rows and audits in the same transaction.
// DATE columns are read as text so calendar dates keep their value.

import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type { DecisionDocumentValues } from "../domain/decision-documents.js";
import type { DocumentKind } from "../domain/model.js";

type Db = Pick<Pool, "query"> | PoolClient;

export interface DecisionDocumentRow extends DecisionDocumentValues {
  id: string;
  signedYear: number;
  employeeNumber: string | null;
  employeeName: string | null;
  previousPkNumber: string | null;
  linkedActionCount: number;
  locked: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DecisionDocumentCorrectionRow {
  id: string;
  previousValues: Record<string, unknown>;
  reason: string;
  correctedAt: string;
}

export interface DecisionDocumentLink {
  actionId: string;
  actionType: string;
  effectiveOn: string | null;
  employeeId: string;
  employeeNumber: string | null;
  employeeName: string | null;
  state: string;
}

export interface DecisionDocumentListQuery {
  kind: DocumentKind;
  search?: string | null;
  year?: number | null;
  pkType?: string | null;
  skType?: string | null;
  category?: string | null;
  employeeId?: string | null;
  page: number;
  pageSize: number;
}

const SELECT_COLUMNS = `
  d.id,
  d.document_kind AS "documentKind",
  d.document_number AS "documentNumber",
  to_char(d.signed_on, 'YYYY-MM-DD') AS "signedOn",
  d.signed_year AS "signedYear",
  d.external_reference AS "externalReference",
  d.notes,
  d.pk_type AS "pkType",
  d.employee_id AS "employeeId",
  to_char(d.contract_from, 'YYYY-MM-DD') AS "contractFrom",
  to_char(d.contract_to, 'YYYY-MM-DD') AS "contractTo",
  d.category,
  d.signatory_employer_label AS "signatoryEmployerLabel",
  d.previous_pk_id AS "previousPkId",
  d.sk_type AS "skType",
  d.subject,
  d.issuing_authority_label AS "issuingAuthorityLabel",
  to_char(d.effective_on, 'YYYY-MM-DD') AS "effectiveOn",
  to_char(d.effective_to, 'YYYY-MM-DD') AS "effectiveTo",
  e.employee_number AS "employeeNumber",
  e.full_name AS "employeeName",
  prev.document_number AS "previousPkNumber",
  (SELECT count(*)::int FROM employment_action_documents link WHERE link.document_id = d.id) AS "linkedActionCount",
  d.created_at AS "createdAt",
  d.updated_at AS "updatedAt"
FROM employment_decision_documents d
LEFT JOIN employees e ON e.id = d.employee_id
LEFT JOIN employment_decision_documents prev ON prev.id = d.previous_pk_id`;

type RawRow = Omit<DecisionDocumentRow, "locked" | "createdAt" | "updatedAt"> & {
  createdAt: Date;
  updatedAt: Date;
};

function toRow(raw: RawRow): DecisionDocumentRow {
  return {
    ...raw,
    locked: raw.linkedActionCount > 0,
    createdAt: raw.createdAt.toISOString(),
    updatedAt: raw.updatedAt.toISOString(),
  };
}

export async function listDecisionDocuments(
  db: Db,
  query: DecisionDocumentListQuery,
): Promise<{ total: number; rows: DecisionDocumentRow[] }> {
  const filters: string[] = ["d.document_kind = $1"];
  const params: unknown[] = [query.kind];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    filters.push(clause.replace("$?", `$${params.length}`));
  };

  if (query.search) {
    params.push(`%${query.search.trim().toLowerCase()}%`);
    const placeholder = `$${params.length}`;
    filters.push(
      `(lower(d.document_number) LIKE ${placeholder}
        OR lower(coalesce(d.subject, '')) LIKE ${placeholder}
        OR lower(coalesce(e.full_name, '')) LIKE ${placeholder}
        OR lower(coalesce(e.employee_number, '')) LIKE ${placeholder})`,
    );
  }
  if (query.year) add("d.signed_year = $?", query.year);
  if (query.pkType) add("d.pk_type = $?", query.pkType);
  if (query.skType) add("d.sk_type = $?", query.skType);
  if (query.category) add("d.category = $?", query.category);
  if (query.employeeId) add("d.employee_id = $?", query.employeeId);

  const where = `WHERE ${filters.join(" AND ")}`;
  const totalResult = await db.query<{ total: string }>(
    `SELECT count(*)::text AS total
     FROM employment_decision_documents d
     LEFT JOIN employees e ON e.id = d.employee_id
     ${where}`,
    params,
  );
  const total = Number(totalResult.rows[0]?.total ?? "0");

  const rows = await db.query<RawRow>(
    `SELECT ${SELECT_COLUMNS}
     ${where}
     ORDER BY d.signed_on DESC, d.document_number DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, query.pageSize, (query.page - 1) * query.pageSize],
  );
  return { total, rows: rows.rows.map(toRow) };
}

export async function getDecisionDocument(db: Db, id: string): Promise<DecisionDocumentRow | null> {
  const result = await db.query<RawRow>(`SELECT ${SELECT_COLUMNS} WHERE d.id = $1`, [id]);
  const raw = result.rows[0];
  return raw ? toRow(raw) : null;
}

export async function getDecisionDocumentLinks(db: Db, id: string): Promise<DecisionDocumentLink[]> {
  const result = await db.query<DecisionDocumentLink>(
    `SELECT a.id AS "actionId",
            a.action_type AS "actionType",
            to_char(a.effective_on, 'YYYY-MM-DD') AS "effectiveOn",
            a.employee_id AS "employeeId",
            e.employee_number AS "employeeNumber",
            e.full_name AS "employeeName",
            a.state
     FROM employment_action_documents link
     JOIN employment_actions a ON a.id = link.action_id
     LEFT JOIN employees e ON e.id = a.employee_id
     WHERE link.document_id = $1
     ORDER BY a.effective_on DESC NULLS LAST, a.recorded_at DESC`,
    [id],
  );
  return result.rows;
}

export async function getDecisionDocumentCorrections(db: Db, id: string): Promise<DecisionDocumentCorrectionRow[]> {
  const result = await db.query<{ id: string; previousValues: Record<string, unknown>; reason: string; correctedAt: Date }>(
    `SELECT id, previous_values AS "previousValues", reason, corrected_at AS "correctedAt"
     FROM employment_decision_document_corrections
     WHERE document_id = $1
     ORDER BY corrected_at DESC`,
    [id],
  );
  return result.rows.map((row) => ({ ...row, correctedAt: row.correctedAt.toISOString() }));
}

const WRITE_COLUMNS = [
  "document_kind",
  "document_number",
  "signed_on",
  "external_reference",
  "notes",
  "pk_type",
  "employee_id",
  "contract_from",
  "contract_to",
  "category",
  "signatory_employer_label",
  "previous_pk_id",
  "sk_type",
  "subject",
  "issuing_authority_label",
  "effective_on",
  "effective_to",
] as const;

function writeValues(values: DecisionDocumentValues): unknown[] {
  return [
    values.documentKind,
    values.documentNumber,
    values.signedOn,
    values.externalReference,
    values.notes,
    values.pkType,
    values.employeeId,
    values.contractFrom,
    values.contractTo,
    values.category,
    values.signatoryEmployerLabel,
    values.previousPkId,
    values.skType,
    values.subject,
    values.issuingAuthorityLabel,
    values.effectiveOn,
    values.effectiveTo,
  ];
}

/** Raised when the (kind, number, signing year) series already has this number. */
export class DecisionDocumentNumberTaken extends Error {
  constructor() {
    super("DECISION_DOCUMENT_NUMBER_TAKEN");
    this.name = "DecisionDocumentNumberTaken";
  }
}

function rethrowNumberConflict(error: unknown): never {
  const code = (error as { code?: string } | null)?.code;
  const constraint = (error as { constraint?: string } | null)?.constraint;
  if (code === "23505" && constraint?.startsWith("employment_decision_documents_number")) {
    throw new DecisionDocumentNumberTaken();
  }
  throw error;
}

export async function insertDecisionDocument(
  client: PoolClient,
  values: DecisionDocumentValues,
  actorAccountId: string,
): Promise<string> {
  const id = randomUUID();
  const placeholders = WRITE_COLUMNS.map((_, index) => `$${index + 3}`).join(", ");
  try {
    await client.query(
      `INSERT INTO employment_decision_documents (id, created_by_account_id, ${WRITE_COLUMNS.join(", ")})
       VALUES ($1, $2, ${placeholders})`,
      [id, actorAccountId, ...writeValues(values)],
    );
  } catch (error) {
    rethrowNumberConflict(error);
  }
  return id;
}

export async function updateDecisionDocument(
  client: PoolClient,
  id: string,
  values: DecisionDocumentValues,
): Promise<void> {
  const assignments = WRITE_COLUMNS.map((column, index) => `${column} = $${index + 2}`).join(", ");
  try {
    await client.query(
      `UPDATE employment_decision_documents SET ${assignments}, updated_at = now() WHERE id = $1`,
      [id, ...writeValues(values)],
    );
  } catch (error) {
    rethrowNumberConflict(error);
  }
}

export async function insertDecisionDocumentCorrection(
  client: PoolClient,
  input: { documentId: string; previousValues: Record<string, unknown>; reason: string; actorAccountId: string },
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO employment_decision_document_corrections
       (id, document_id, previous_values, reason, corrected_by_account_id)
     VALUES ($1, $2, $3::jsonb, $4, $5)`,
    [id, input.documentId, JSON.stringify(input.previousValues), input.reason, input.actorAccountId],
  );
  return id;
}

/** Locks the row for the read-modify-write of an edit or a correction. */
export async function lockDecisionDocumentRow(client: PoolClient, id: string): Promise<boolean> {
  const result = await client.query<{ id: string }>(
    "SELECT id FROM employment_decision_documents WHERE id = $1 FOR UPDATE",
    [id],
  );
  return result.rowCount === 1;
}
