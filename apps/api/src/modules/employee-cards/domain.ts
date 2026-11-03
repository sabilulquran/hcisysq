// EMP-012 Package 1 rules that need no database.
// Spec: docs/domain/employee-id-card.md §3.

import { randomBytes } from "node:crypto";

export const CARD_STATUSES = ["ACTIVE", "REPLACED", "REPORTED_LOST", "REVOKED"] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

/** D-09: NEW only for the first card; the others replace or follow an ended card. */
export const ISSUE_REASONS = ["NEW", "LOST", "DAMAGED", "DATA_CHANGED", "EXPIRED"] as const;
export type IssueReason = (typeof ISSUE_REASONS)[number];

/** D-08: why a card does not verify. EXPIRED and EMPLOYEE_INACTIVE are computed, never stored. */
export type InvalidReason = "REPLACED" | "REPORTED_LOST" | "REVOKED" | "EXPIRED" | "EMPLOYEE_INACTIVE";

/** Admin list filter: what the HC screen needs to act on. */
export const CARD_FILTERS = ["NO_PHOTO", "NO_CARD", "ACTIVE", "NEEDS_REISSUE"] as const;
export type CardFilter = (typeof CARD_FILTERS)[number];

export const PHOTO_CONTENT_TYPES = ["image/jpeg", "image/png"] as const;
export type PhotoContentType = (typeof PHOTO_CONTENT_TYPES)[number];
export const MAX_PHOTO_BYTES = 2_097_152;
export const MAX_SIGNATURE_BYTES = 524_288;
export const MAX_PRINT_BATCH = 50;

export class EmployeeCardError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = "EmployeeCardError";
  }
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** D-03: size and file-signature check, the same as training certificates (TRAIN-001 D-10). */
export function decodeImage(
  contentType: PhotoContentType,
  contentBase64: string,
  maxBytes: number,
  label: string,
): Buffer {
  const bytes = Buffer.from(contentBase64, "base64");
  if (bytes.length === 0) {
    throw new EmployeeCardError(400, "INVALID_EMPLOYEE_CARD_IMAGE", `${label} kosong atau tidak terbaca.`);
  }
  if (bytes.length > maxBytes) {
    const limit = maxBytes >= 1_048_576 ? `${maxBytes / 1_048_576} MB` : `${maxBytes / 1024} KB`;
    throw new EmployeeCardError(413, "EMPLOYEE_CARD_IMAGE_TOO_LARGE", `${label} maksimal ${limit}.`);
  }
  const signatureOk =
    (contentType === "image/jpeg" && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    || (contentType === "image/png" && bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE));
  if (!signatureOk) {
    throw new EmployeeCardError(400, "INVALID_EMPLOYEE_CARD_IMAGE", `Tipe berkas tidak sesuai dengan isi ${label.toLowerCase()}.`);
  }
  return bytes;
}

/** Crockford base32: no I, L, O or U, so a code read aloud or retyped stays unambiguous. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const VERIFY_CODE_LENGTH = 10;

/** D-07: 50 random bits from the CSPRNG; never derived from NIP or an id. */
export function generateVerifyCode(random: (size: number) => Buffer = randomBytes): string {
  const bytes = random(VERIFY_CODE_LENGTH);
  let code = "";
  for (const byte of bytes) code += CROCKFORD[byte & 31];
  return code;
}

/** Accepts what a person may type: lower case, hyphens and spaces, O for 0, I/L for 1. */
export function normalizeVerifyCode(input: string): string | null {
  const cleaned = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (cleaned.length !== VERIFY_CODE_LENGTH) return null;
  for (const character of cleaned) if (!CROCKFORD.includes(character)) return null;
  return cleaned;
}

/** D-06: KP-YYMM-NNNN, the month of issue in WIB and a never-reused running number. */
export function formatCardNumber(issuedOnWib: string, sequence: number): string {
  const [year, month] = issuedOnWib.split("-");
  return `KP-${year!.slice(2)}${month}-${String(sequence).padStart(4, "0")}`;
}

/** D-04: `months` after the WIB issue date, ending on the last day of that month. */
export function validUntil(issuedOnWib: string, months: number): string {
  const [year, month] = issuedOnWib.split("-").map(Number);
  const target = (month! - 1) + months;
  const lastDay = new Date(Date.UTC(year! + Math.floor(target / 12), (target % 12) + 1, 0));
  return lastDay.toISOString().slice(0, 10);
}

/** D-08: the reason a card does not verify today, or null when it is valid. */
export function invalidReason(card: {
  status: CardStatus;
  validUntil: string;
  employeeActive: boolean;
}, todayWib: string): InvalidReason | null {
  if (card.status !== "ACTIVE") return card.status;
  if (todayWib > card.validUntil) return "EXPIRED";
  if (!card.employeeActive) return "EMPLOYEE_INACTIVE";
  return null;
}

/** §5.1: which issue reasons fit the current state of the employee's cards. */
export function assertIssueReason(reason: IssueReason, hasActiveCard: boolean, hasAnyCard: boolean) {
  if (reason === "NEW" && hasAnyCard) {
    throw new EmployeeCardError(
      409,
      hasActiveCard ? "EMPLOYEE_CARD_ALREADY_ACTIVE" : "EMPLOYEE_CARD_INVALID_TRANSITION",
      hasActiveCard
        ? "Pegawai ini sudah punya kartu aktif. Pilih alasan terbit ulang."
        : "Pegawai ini sudah pernah punya kartu. Pilih alasan terbit ulang.",
    );
  }
  if (reason !== "NEW" && !hasAnyCard) {
    throw new EmployeeCardError(409, "EMPLOYEE_CARD_INVALID_TRANSITION", "Kartu pertama diterbitkan dengan alasan Terbit baru.");
  }
}

/** The WIB calendar date of an instant: card numbers, validity and checks all use it. */
export function wibDate(instant: Date): string {
  return new Date(instant.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
}
