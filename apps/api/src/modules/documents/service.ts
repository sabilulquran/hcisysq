// DOC-001 / DOC-002 Package 1 service: number allocation, issuing, snapshots, audit.
// Spec: docs/domain/hr-documents.md.

import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { resolveDocumentSigner, type SignerTitle } from "./signer-authority.js";

type QueryTarget = Pool | PoolClient;

export const DISCIPLINARY_LEVELS = ["SP1", "SP2", "SP3"] as const;
export type DisciplinaryLevel = (typeof DISCIPLINARY_LEVELS)[number];

/** D-10 DRAFT: a warning letter stays in force for six months unless HC says otherwise. */
export const DEFAULT_DISCIPLINARY_MONTHS = 6;

/** D-08 DRAFT: an employee may keep at most three open certificate requests. */
export const MAX_OPEN_REQUESTS = 3;

const ROMAN_MONTHS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"] as const;

export class DocumentError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = "DocumentError";
  }
}

export interface DocumentType {
  code: string;
  label: string;
  numberCode: string;
  requiresActiveEmployment: boolean;
  requiresEndedEmployment: boolean;
  selfRequestable: boolean;
  available: boolean;
}

export interface EmployeeFacts {
  id: string;
  employeeNumber: string;
  fullName: string;
  status: string;
  positionTitle: string | null;
  unitName: string | null;
  startedOn: string | null;
  endedOn: string | null;
}

/** D-04 DRAFT: `<seq>/<kode>/YSQ/<bulan romawi>/<tahun>`. */
export function formatDocumentNumber(numberCode: string, sequence: number, issuedAt: Date): string {
  const month = ROMAN_MONTHS[issuedAt.getUTCMonth()];
  return `${String(sequence).padStart(3, "0")}/${numberCode}/YSQ/${month}/${issuedAt.getUTCFullYear()}`;
}

export function addMonths(date: string, months: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const base = new Date(Date.UTC(year!, (month! - 1) + months, day!));
  return base.toISOString().slice(0, 10);
}

/** DOC-002-D: expiry is derived from the date, never from a scheduled job. */
export function isDisciplinaryActive(expiresOn: string, today: string): boolean {
  return expiresOn >= today;
}

export async function listDocumentTypes(db: QueryTarget): Promise<DocumentType[]> {
  const result = await db.query<DocumentType>(
    `SELECT code, label, number_code AS "numberCode",
            requires_active_employment AS "requiresActiveEmployment",
            requires_ended_employment AS "requiresEndedEmployment",
            self_requestable AS "selfRequestable",
            available
       FROM hr_document_types
      ORDER BY sort_order ASC, code ASC`,
  );
  return result.rows;
}

export async function loadEmployeeFacts(db: QueryTarget, employeeId: string): Promise<EmployeeFacts | null> {
  const result = await db.query<EmployeeFacts>(
    `SELECT employee.id,
            employee.employee_number AS "employeeNumber",
            employee.full_name AS "fullName",
            employee.status,
            coalesce(position.name, employee.structural_position, employee.functional_position) AS "positionTitle",
            unit.name AS "unitName",
            to_char(employee.started_on, 'YYYY-MM-DD') AS "startedOn",
            to_char(employee.ended_on, 'YYYY-MM-DD') AS "endedOn"
       FROM employees employee
       LEFT JOIN positions position ON position.id = employee.position_id
       LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
      WHERE employee.id = $1`,
    [employeeId],
  );
  return result.rows[0] ?? null;
}

/**
 * D-15: only these facts reach a letter. Salary, bank account, full identity
 * numbers, medical data and home address are never copied into a snapshot.
 */
export function buildContentSnapshot(employee: EmployeeFacts, extra: Record<string, unknown> = {}) {
  return {
    employeeNumber: employee.employeeNumber,
    fullName: employee.fullName,
    positionTitle: employee.positionTitle,
    unitName: employee.unitName,
    startedOn: employee.startedOn,
    endedOn: employee.endedOn,
    ...extra,
  };
}

export async function writeDocumentAudit(
  db: QueryTarget,
  event: {
    eventType: string;
    requestId?: string | null;
    issuedDocumentId?: string | null;
    employeeId?: string | null;
    actorAccountId?: string | null;
    reason?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  await db.query(
    `INSERT INTO hr_document_audit_events (
       id, event_type, request_id, issued_document_id, employee_id, actor_account_id, reason, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [
      randomUUID(), event.eventType, event.requestId ?? null, event.issuedDocumentId ?? null,
      event.employeeId ?? null, event.actorAccountId ?? null, event.reason ?? null,
      JSON.stringify(event.metadata ?? {}),
    ],
  );
}

/**
 * DOC-001-D: the counter row is locked for the rest of the transaction, so two
 * concurrent issues serialize and never share a sequence. The caller owns the
 * transaction; a rollback gives the number back because the counter row rolls
 * back with it, and nothing else has seen it.
 */
async function allocateNumber(client: PoolClient, numberCode: string, issuedAt: Date) {
  const year = issuedAt.getUTCFullYear();
  const result = await client.query<{ lastSequence: number }>(
    `INSERT INTO hr_document_number_counters (number_code, number_year, last_sequence)
     VALUES ($1, $2, 1)
     ON CONFLICT (number_code, number_year) DO UPDATE
       SET last_sequence = hr_document_number_counters.last_sequence + 1
     RETURNING last_sequence AS "lastSequence"`,
    [numberCode, year],
  );
  const sequence = result.rows[0]!.lastSequence;
  return { year, sequence, documentNumber: formatDocumentNumber(numberCode, sequence, issuedAt) };
}

export interface IssuedDocument {
  id: string;
  documentKind: "CERTIFICATE" | "DISCIPLINARY";
  documentCode: string;
  documentNumber: string;
  signerTitle: SignerTitle;
  signerName: string | null;
  issuedAt: Date;
}

export async function issueDocument(
  client: PoolClient,
  input: {
    documentKind: "CERTIFICATE" | "DISCIPLINARY";
    documentCode: string;
    numberCode: string;
    employee: EmployeeFacts;
    issuedByAccountId: string;
    contentSnapshot: Record<string, unknown>;
  },
): Promise<IssuedDocument> {
  const issuedAt = new Date();
  const signer = await resolveDocumentSigner(client, input.employee.id);
  if (!signer.name) {
    // DOC-001-F: no eligible incumbent means no letter; the HC decision survives.
    throw new DocumentError(
      409,
      "DOCUMENT_SIGNER_UNAVAILABLE",
      "Pejabat penandatangan belum ditetapkan, surat belum dapat diterbitkan.",
    );
  }
  const { year, sequence, documentNumber } = await allocateNumber(client, input.numberCode, issuedAt);
  const id = randomUUID();
  await client.query(
    `INSERT INTO hr_issued_documents (
       id, document_kind, document_code, employee_id, number_code, number_year,
       number_sequence, document_number, content_snapshot, signer, issued_at, issued_by_account_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12)`,
    [
      id, input.documentKind, input.documentCode, input.employee.id, input.numberCode, year,
      sequence, documentNumber, JSON.stringify(input.contentSnapshot),
      JSON.stringify({ title: signer.title, name: signer.name }), issuedAt, input.issuedByAccountId,
    ],
  );
  return {
    id,
    documentKind: input.documentKind,
    documentCode: input.documentCode,
    documentNumber,
    signerTitle: signer.title,
    signerName: signer.name,
    issuedAt,
  };
}

export function assertEmploymentStateAllows(type: DocumentType, employee: EmployeeFacts) {
  if (!type.available) {
    throw new DocumentError(409, "DOCUMENT_TYPE_UNAVAILABLE", "Jenis surat ini belum tersedia.");
  }
  if (type.requiresActiveEmployment && employee.status !== "active") {
    throw new DocumentError(409, "DOCUMENT_EMPLOYMENT_STATE", "Surat ini hanya untuk pegawai aktif.");
  }
  // DOC-001-G: paklaring describes a finished employment.
  if (type.requiresEndedEmployment && employee.status === "active") {
    throw new DocumentError(
      409,
      "DOCUMENT_EMPLOYMENT_STATE",
      "Surat ini hanya untuk pegawai yang hubungan kerjanya sudah berakhir.",
    );
  }
}
