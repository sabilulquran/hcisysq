// EMP-005 S2B: "di luar pengelolaan HCIS" (spec
// docs/domain/employment-administration-package1.md §8.7).
//
// Keputusan owner 2026-10-16: data staf BUMY dan Pengurus Yayasan yang sudah
// ada di master pegawai tidak dihapus, melainkan ditandai. Baris yang ditandai
// tetap dapat dibaca — riwayat cuti, kehadiran, slip, dan audit tidak berubah
// sedikit pun — tetapi tidak dapat ditulis lagi.
//
// Satu berkas kecil ini dipakai setiap jalur tulis supaya jawabannya sama di
// mana pun: kode, pesan, dan status yang sama.
//
// Pemeriksaannya membaca baris pegawai tanpa mengunci. Penandaan yang
// di-commit sesudah pembacaan itu belum terlihat, jadi satu penulisan masih
// bisa lolos beberapa milidetik setelah sebuah baris ditandai. Yang hilang
// hanyalah penulisan terakhir itu — bukan keutuhan data — dan jejaknya ada di
// audit. Mengunci baris pegawai pada setiap jalur tulis akan membuat satu
// penandaan memblokir seluruh HCIS untuk pegawai itu, yang harganya jauh
// lebih besar daripada yang dibelinya.

import type { Pool, PoolClient } from "pg";

export const MANAGEMENT_SCOPES = ["MANAGED", "OUTSIDE_HCIS"] as const;
export type ManagementScope = (typeof MANAGEMENT_SCOPES)[number];

export const MANAGEMENT_SCOPE_REASONS = ["BUMY", "PENGURUS_YAYASAN"] as const;
export type ManagementScopeReason = (typeof MANAGEMENT_SCOPE_REASONS)[number];

export const OUTSIDE_HCIS_CODE = "EMPLOYEE_OUTSIDE_HCIS_READ_ONLY";
export const OUTSIDE_HCIS_MESSAGE = "Data ini di luar pengelolaan HCIS dan hanya dapat dibaca.";

/**
 * What the person filing for themselves is told. Same code and same status as the message above;
 * only the wording differs, because the reader does. It says what is still true (the history stays
 * readable) and where to go next, so the refusal is not read as a broken account — which would send
 * the person to account support instead of to Human Capital.
 */
export const OUTSIDE_HCIS_SELF_SERVICE_MESSAGE =
  "Data Anda di luar pengelolaan HCIS, jadi pengajuan baru tidak dapat dibuat. Riwayat Anda tetap terbaca. Hubungi Human Capital bila ini keliru.";

/** Thrown by a write path that found the record marked; answered as 409. */
export class OutsideHcisError extends Error {
  readonly statusCode = 409;
  readonly code = OUTSIDE_HCIS_CODE;

  constructor(public readonly employeeId: string, message: string = OUTSIDE_HCIS_MESSAGE) {
    super(message);
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
 * The same guard on a path where the marked person is the one filing: same code, same status,
 * the wording of OUTSIDE_HCIS_SELF_SERVICE_MESSAGE.
 */
export async function assertSelfServiceManagedByHcis(db: Db, employeeId: string): Promise<void> {
  if (await isOutsideHcis(db, employeeId)) {
    throw new OutsideHcisError(employeeId, OUTSIDE_HCIS_SELF_SERVICE_MESSAGE);
  }
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
