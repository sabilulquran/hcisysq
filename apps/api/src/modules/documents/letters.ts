// DOC-003 Package 1: outgoing letter numbering register (buku nomor surat keluar).
// Spec: docs/domain/outgoing-letter-register.md. Pure rules plus the allocation statement.

import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { jakartaDate } from "./service.js";

type QueryTarget = Pool | PoolClient;

const ROMAN_MONTHS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"] as const;

export const LETTER_RESET_PERIODS = ["YEARLY", "MONTHLY"] as const;
export type LetterResetPeriod = (typeof LETTER_RESET_PERIODS)[number];

export const LETTER_ISSUER_KINDS = ["ORGANIZATION", "UNIT", "COMMITTEE", "OTHER"] as const;
export type LetterIssuerKind = (typeof LETTER_ISSUER_KINDS)[number];

/** D-15: type codes start with a letter, so a DOC-003 number can never equal a DOC-001 one (D-10). */
export const LETTER_TYPE_CODE = /^[A-Z][A-Z0-9-]{0,9}$/;
export const LETTER_ISSUER_CODE = /^[A-Z0-9][A-Z0-9-]{0,15}$/;

/** §5.4: an export larger than this is refused with "persempit filter" (ENG-LIST-001-H). */
export const LETTER_EXPORT_LIMIT = 20_000;

export class LetterError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = "LetterError";
  }
}

/** D-04: 'YYYY' for a yearly type, 'YYYY-MM' for a monthly one, from the Jakarta calendar. */
export function letterPeriodKey(resetPeriod: LetterResetPeriod, date: string): string {
  return resetPeriod === "MONTHLY" ? date.slice(0, 7) : date.slice(0, 4);
}

/** D-02 DRAFT (legacy format): `<JENIS>.<urut>/<PENERBIT>/<bulan romawi>/<tahun>`. */
export function formatLetterNumber(typeCode: string, sequence: number, issuerCode: string, date: string): string {
  const [year, month] = date.split("-");
  return `${typeCode}.${String(sequence).padStart(3, "0")}/${issuerCode}/${ROMAN_MONTHS[Number(month) - 1]}/${year}`;
}

export function letterToday(now = new Date()): string {
  return jakartaDate(now);
}

export async function writeLetterAudit(
  db: QueryTarget,
  event: {
    eventType: string;
    letterNumberId?: string | null;
    issuerId?: string | null;
    actorAccountId: string | null;
    reason?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  await db.query(
    `INSERT INTO letter_audit_events (id, event_type, letter_number_id, issuer_id, actor_account_id, reason, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [
      randomUUID(), event.eventType, event.letterNumberId ?? null, event.issuerId ?? null,
      event.actorAccountId, event.reason ?? null, JSON.stringify(event.metadata ?? {}),
    ],
  );
}

export interface AllocatedLetter {
  id: string;
  letterNumber: string;
  letterDate: string;
  sequence: number;
  periodKey: string;
  issuerId: string;
  issuerCode: string;
  typeCode: string;
  subject: string;
  recipient: string;
  notes: string | null;
  status: "ALLOCATED";
  version: number;
}

/**
 * D-05: increments the counter and inserts the number in the caller's transaction. The
 * ON CONFLICT DO UPDATE takes the counter row lock, so a second allocation for the same issuer,
 * type and period waits until this transaction ends; a rollback gives the number back.
 * The caller has already checked the grant, the issuer and the type.
 */
export async function allocateLetterNumber(
  client: PoolClient,
  input: {
    issuer: { id: string; code: string };
    type: { code: string; resetPeriod: LetterResetPeriod };
    subject: string;
    recipient: string;
    notes: string | null;
    employeeId: string;
    accountId: string;
    now?: Date;
  },
): Promise<AllocatedLetter> {
  const letterDate = letterToday(input.now);
  const periodKey = letterPeriodKey(input.type.resetPeriod, letterDate);
  const counter = await client.query<{ lastSequence: number }>(
    `INSERT INTO letter_number_counters (issuer_id, type_code, period_key, last_sequence)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (issuer_id, type_code, period_key) DO UPDATE
       SET last_sequence = letter_number_counters.last_sequence + 1
     RETURNING last_sequence AS "lastSequence"`,
    [input.issuer.id, input.type.code, periodKey],
  );
  const sequence = counter.rows[0]!.lastSequence;
  const letterNumber = formatLetterNumber(input.type.code, sequence, input.issuer.code, letterDate);
  const id = randomUUID();
  await client.query(
    `INSERT INTO letter_numbers (
       id, issuer_id, type_code, period_key, sequence, letter_number, letter_date, subject, recipient, notes,
       requested_by_employee_id, requested_by_account_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10,$11,$12)`,
    [
      id, input.issuer.id, input.type.code, periodKey, sequence, letterNumber, letterDate,
      input.subject, input.recipient, input.notes, input.employeeId, input.accountId,
    ],
  );
  return {
    id, letterNumber, letterDate, sequence, periodKey, issuerId: input.issuer.id, issuerCode: input.issuer.code,
    typeCode: input.type.code, subject: input.subject, recipient: input.recipient, notes: input.notes,
    status: "ALLOCATED", version: 1,
  };
}

/** Escapes LIKE wildcards so a search for "50%" means the text, not a pattern. */
export function letterLikePattern(query: string) {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}
