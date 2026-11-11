// EMP-011 D-01: the employee-document storage boundary.
//
// Every employee-document file (the EMP-011 archive and the EMP-010 Perjanjian Kerja / Surat
// Keputusan attachments) is stored and read only through this port. The one adapter keeps files
// AES-256-GCM encrypted in the HCIS database (pattern TRAIN-001 D-10, EMP-012 D-03); moving to
// object storage later replaces the adapter, not the callers (ADR-0002).

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";

import { decryptSecret, encryptSecret } from "../auth/crypto.js";
import type { FileContentType } from "./domain.js";

type Db = Pick<PoolClient, "query">;

export type FileOwner =
  | { purpose: "EMPLOYEE_DOCUMENT"; employeeDocumentId: string }
  | { purpose: "DECISION_DOCUMENT"; decisionDocumentId: string };

export interface StoredFileInfo {
  id: string;
  contentType: FileContentType;
  byteSize: number;
  createdAt: Date;
  replacedAt: Date | null;
  purgedAt: Date | null;
}

export interface StoredFile extends StoredFileInfo {
  bytes: Buffer | null;
}

export interface EmployeeFileStore {
  /** Encrypts and stores a file for one owner; returns its id. */
  put(db: Db, owner: FileOwner, file: { contentType: FileContentType; bytes: Buffer }, uploadedByAccountId: string): Promise<StoredFileInfo>;
  /** The current file of a register document, or the one file of an archive document; null when none. */
  current(db: Db, owner: FileOwner): Promise<StoredFileInfo | null>;
  /** Decrypts the current file; `bytes` is null when the content was purged. */
  read(db: Db, owner: FileOwner): Promise<StoredFile | null>;
  /** Marks the current register file replaced (history keeps it). */
  markReplaced(db: Db, owner: FileOwner): Promise<void>;
  /** Erases the encrypted content for good; the metadata row stays (D-12, D-13). */
  purge(db: Db, owner: FileOwner): Promise<void>;
}

const OWNER_SQL = `(CASE WHEN $1::text = 'EMPLOYEE_DOCUMENT' THEN file.employee_document_id = $2::uuid
                        ELSE file.decision_document_id = $2::uuid END)
                   AND file.purpose = $1::text AND file.replaced_at IS NULL`;

function ownerValues(owner: FileOwner): [string, string] {
  return owner.purpose === "EMPLOYEE_DOCUMENT"
    ? [owner.purpose, owner.employeeDocumentId]
    : [owner.purpose, owner.decisionDocumentId];
}

const INFO_COLUMNS = `file.id, file.content_type AS "contentType", file.byte_size AS "byteSize",
  file.created_at AS "createdAt", file.replaced_at AS "replacedAt", file.purged_at AS "purgedAt"`;

export class PostgresEmployeeFileStore implements EmployeeFileStore {
  constructor(private readonly encryptionKey: string) {}

  async put(db: Db, owner: FileOwner, file: { contentType: FileContentType; bytes: Buffer }, uploadedByAccountId: string) {
    const encrypted = encryptSecret(file.bytes.toString("base64"), this.encryptionKey);
    const id = randomUUID();
    const result = await db.query<StoredFileInfo>(
      `INSERT INTO employee_document_files AS file
         (id, purpose, employee_document_id, decision_document_id, content_type, byte_size, sha256,
          ciphertext, iv, auth_tag, uploaded_by_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${INFO_COLUMNS}`,
      [
        id, owner.purpose,
        owner.purpose === "EMPLOYEE_DOCUMENT" ? owner.employeeDocumentId : null,
        owner.purpose === "DECISION_DOCUMENT" ? owner.decisionDocumentId : null,
        file.contentType, file.bytes.length, createHash("sha256").update(file.bytes).digest("hex"),
        encrypted.ciphertext, encrypted.iv, encrypted.tag, uploadedByAccountId,
      ],
    );
    return result.rows[0]!;
  }

  async current(db: Db, owner: FileOwner) {
    const result = await db.query<StoredFileInfo>(
      `SELECT ${INFO_COLUMNS} FROM employee_document_files file WHERE ${OWNER_SQL}`,
      ownerValues(owner),
    );
    return result.rows[0] ?? null;
  }

  async read(db: Db, owner: FileOwner): Promise<StoredFile | null> {
    const result = await db.query<StoredFileInfo & { sha256: string; ciphertext: string | null; iv: string | null; tag: string | null }>(
      `SELECT ${INFO_COLUMNS}, file.sha256, file.ciphertext, file.iv, file.auth_tag AS tag
         FROM employee_document_files file WHERE ${OWNER_SQL}`,
      ownerValues(owner),
    );
    const row = result.rows[0];
    if (!row) return null;
    const { sha256, ciphertext, iv, tag, ...info } = row;
    if (!ciphertext || !iv || !tag) return { ...info, bytes: null };
    const bytes = Buffer.from(decryptSecret({ ciphertext, iv, tag }, this.encryptionKey), "base64");
    const expected = Buffer.from(sha256, "hex");
    const actual = createHash("sha256").update(bytes).digest();
    if (bytes.length !== info.byteSize || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new Error("Employee document file integrity check failed");
    }
    return { ...info, bytes };
  }

  async markReplaced(db: Db, owner: FileOwner) {
    await db.query(
      `UPDATE employee_document_files file SET replaced_at = now() WHERE ${OWNER_SQL}`,
      ownerValues(owner),
    );
  }

  async purge(db: Db, owner: FileOwner) {
    await db.query(
      `UPDATE employee_document_files file
          SET ciphertext = NULL, iv = NULL, auth_tag = NULL, purged_at = now(),
              -- An unkeyed hash of the plaintext would still confirm a known scan; drop it too.
              sha256 = repeat('0', 64)
        WHERE ${OWNER_SQL} AND file.purged_at IS NULL`,
      ownerValues(owner),
    );
  }
}

/** D-07: headers for every file download; never inline on the HCIS origin. */
export function fileDownloadHeaders(contentType: string, fileName: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${fileName}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'",
  };
}
