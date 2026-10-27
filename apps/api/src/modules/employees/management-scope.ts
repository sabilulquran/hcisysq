// EMP-005 S2B: "di luar pengelolaan HCIS" (spec
// docs/domain/employment-administration-package1.md §8.7).
//
// Keputusan owner 2026-10-16: data staf BUMY dan Pengurus Yayasan yang sudah
// ada di master pegawai tidak dihapus, melainkan ditandai. Baris yang ditandai
// tetap dapat dibaca — riwayat cuti, kehadiran, slip, dan audit tidak berubah
// sedikit pun — tetapi tidak dapat ditulis lagi.
//
// Satu berkas kecil ini dipakai setiap jalur tulis supaya jawabannya sama di
// mana pun: kode, pesan, dan status yang sama, diputuskan dari baris yang
// sudah dikunci, bukan dari pembacaan yang mendahuluinya.

import type { Pool, PoolClient } from "pg";

export const MANAGEMENT_SCOPES = ["MANAGED", "OUTSIDE_HCIS"] as const;
export type ManagementScope = (typeof MANAGEMENT_SCOPES)[number];

export const MANAGEMENT_SCOPE_REASONS = ["BUMY", "PENGURUS_YAYASAN"] as const;
export type ManagementScopeReason = (typeof MANAGEMENT_SCOPE_REASONS)[number];

export const OUTSIDE_HCIS_CODE = "EMPLOYEE_OUTSIDE_HCIS_READ_ONLY";
export const OUTSIDE_HCIS_MESSAGE = "Data ini di luar pengelolaan HCIS dan hanya dapat dibaca.";

/** Thrown by a write path that found the record marked; answered as 409. */
export class OutsideHcisError extends Error {
  readonly statusCode = 409;
  readonly code = OUTSIDE_HCIS_CODE;

  constructor(public readonly employeeId: string) {
    super(OUTSIDE_HCIS_MESSAGE);
    this.name = "OutsideHcisError";
  }
}

type Db = Pick<Pool, "query"> | PoolClient;

/**
 * True when the record is marked. Reads the row itself rather than a cached
 * set, so a mark applied a moment ago is already in force.
 */
export async function isOutsideHcis(db: Db, employeeId: string): Promise<boolean> {
  const result = await db.query<{ outside: boolean }>(
    `SELECT management_scope = 'OUTSIDE_HCIS' AS outside FROM employees WHERE id = $1`,
    [employeeId],
  );
  return result.rows[0]?.outside === true;
}

/** Refuses the write when the record is marked; does nothing otherwise. */
export async function assertManagedByHcis(db: Db, employeeId: string): Promise<void> {
  if (await isOutsideHcis(db, employeeId)) throw new OutsideHcisError(employeeId);
}

/**
 * The marked employee numbers among the ones an import is about to touch.
 * The import names people by number, not by id, which is why this answers in
 * numbers.
 */
export async function outsideHcisEmployeeNumbers(db: Db, numbers: readonly string[]): Promise<Set<string>> {
  if (numbers.length === 0) return new Set();
  const result = await db.query<{ employeeNumber: string }>(
    `SELECT employee_number AS "employeeNumber" FROM employees
     WHERE employee_number = ANY($1::text[]) AND management_scope = 'OUTSIDE_HCIS'`,
    [numbers],
  );
  return new Set(result.rows.map((row) => row.employeeNumber));
}

export const IMPORT_SKIPPED_MESSAGE = "Di luar pengelolaan HCIS — dilewati.";
