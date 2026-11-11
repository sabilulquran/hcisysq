// EMP-011 Package 1 rules that need no database and no HTTP.
// Spec: docs/domain/employee-documents.md §3, §5.

export const DOCUMENT_TYPES = [
  "KTP", "KK", "NPWP", "BPJS_KESEHATAN", "BPJS_KETENAGAKERJAAN", "IJAZAH", "TRANSKRIP",
  "SERTIFIKAT", "SIM", "PASPOR", "SKCK", "SURAT_SEHAT", "LAINNYA",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_STATUSES = ["PENDING_REVIEW", "VERIFIED", "REJECTED", "WITHDRAWN", "REPLACED", "REMOVED"] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** D-04: how each type treats the expiry date and the title. */
export const DOCUMENT_TYPE_RULES: Record<DocumentType, { label: string; expiry: "REQUIRED" | "OPTIONAL"; titleRequired: boolean }> = {
  KTP: { label: "KTP", expiry: "OPTIONAL", titleRequired: false },
  KK: { label: "Kartu Keluarga", expiry: "OPTIONAL", titleRequired: false },
  NPWP: { label: "NPWP", expiry: "OPTIONAL", titleRequired: false },
  BPJS_KESEHATAN: { label: "Kartu BPJS Kesehatan", expiry: "OPTIONAL", titleRequired: false },
  BPJS_KETENAGAKERJAAN: { label: "Kartu BPJS Ketenagakerjaan", expiry: "OPTIONAL", titleRequired: false },
  IJAZAH: { label: "Ijazah", expiry: "OPTIONAL", titleRequired: false },
  TRANSKRIP: { label: "Transkrip nilai", expiry: "OPTIONAL", titleRequired: false },
  SERTIFIKAT: { label: "Sertifikat", expiry: "OPTIONAL", titleRequired: false },
  SIM: { label: "SIM", expiry: "REQUIRED", titleRequired: false },
  PASPOR: { label: "Paspor", expiry: "REQUIRED", titleRequired: false },
  SKCK: { label: "SKCK", expiry: "REQUIRED", titleRequired: false },
  SURAT_SEHAT: { label: "Surat keterangan sehat", expiry: "REQUIRED", titleRequired: false },
  LAINNYA: { label: "Dokumen lain", expiry: "OPTIONAL", titleRequired: true },
};

export const FILE_CONTENT_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
export type FileContentType = (typeof FILE_CONTENT_TYPES)[number];

/** D-02: 4 MB per file. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Base64 grows by a third; this is the longest contentBase64 a 4 MB file can produce. */
export const MAX_FILE_BASE64_LENGTH = Math.ceil(MAX_FILE_BYTES / 3) * 4;
/** JSON body limit for an upload route: the base64 plus metadata. */
export const UPLOAD_BODY_LIMIT = 6_000_000;
/** D-06: open proposals per employee. */
export const MAX_PENDING_PER_EMPLOYEE = 5;
/** D-06: proposals per employee in any 24 hours, withdrawn and rejected ones included. */
export const MAX_PROPOSALS_PER_DAY = 10;
export const WORKLIST_WINDOWS = [30, 60, 90, 180] as const;

export class EmployeeDocumentError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string, readonly field?: string) {
    super(message);
    this.name = "EmployeeDocumentError";
  }
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * D-07: markers of active content a PDF reader may act on. A best-effort guard: markers inside a
 * compressed object stream are invisible here, which is why every file is served as a download.
 * /OpenAction is left out on purpose: scanners write it to open on page one.
 */
const PDF_ACTIVE_CONTENT = /\/(?:JavaScript|JS|Launch|EmbeddedFile|EmbeddedFiles|RichMedia|XFA|AA|SubmitForm|ImportData)(?![A-Za-z0-9])/;

/** PDF names may spell any byte as #xx (`/J#61vaScript`); readers decode it, so the check must too. */
function decodePdfNames(text: string): string {
  return text.replace(/\/[^\s/<>[\]()%{}]*/g, (name) => name.replace(/#([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))));
}

/** D-02, D-07: decodes the upload and checks size, file signature and visible active content. */
export function decodeDocumentFile(contentType: FileContentType, contentBase64: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)) {
    throw new EmployeeDocumentError(400, "EMPLOYEE_DOCUMENT_FILE_INVALID", "Berkas tidak terbaca.");
  }
  const bytes = Buffer.from(contentBase64, "base64");
  if (bytes.length === 0) {
    throw new EmployeeDocumentError(400, "EMPLOYEE_DOCUMENT_FILE_INVALID", "Berkas kosong atau tidak terbaca.");
  }
  if (bytes.length > MAX_FILE_BYTES) {
    throw new EmployeeDocumentError(413, "EMPLOYEE_DOCUMENT_FILE_TOO_LARGE", "Berkas maksimal 4 MB.");
  }
  const signatureOk =
    (contentType === "application/pdf" && bytes.subarray(0, 5).toString("latin1") === "%PDF-")
    || (contentType === "image/jpeg" && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    || (contentType === "image/png" && bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE));
  if (!signatureOk) {
    throw new EmployeeDocumentError(400, "EMPLOYEE_DOCUMENT_FILE_INVALID", "Tipe berkas tidak sesuai dengan isinya. Unggah PDF, JPG, atau PNG.");
  }
  if (contentType === "application/pdf" && PDF_ACTIVE_CONTENT.test(decodePdfNames(bytes.toString("latin1")))) {
    throw new EmployeeDocumentError(
      400, "EMPLOYEE_DOCUMENT_FILE_ACTIVE_CONTENT",
      "PDF ini memuat skrip atau lampiran tersemat. Cetak ulang sebagai PDF biasa atau unggah hasil pindaian.",
    );
  }
  return bytes;
}

/** D-03: the original name is never kept; a download is named after the type and the date. */
export function downloadFileName(prefix: string, createdAt: Date, contentType: string): string {
  const extension = contentType === "application/pdf" ? "pdf" : contentType === "image/png" ? "png" : "jpg";
  const day = new Date(createdAt.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
  return `${prefix.replace(/[^A-Za-z0-9_-]/g, "_")}-${day}.${extension}`;
}

const NUMBER_PATTERN = /^[A-Za-z0-9 ./-]{1,60}$/;

/** D-05: the last four characters, without separators, for the masked display. */
export function numberLast4(value: string): string {
  const compact = value.replace(/[\s./-]/g, "");
  return compact.slice(-4);
}

const isIsoDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export interface DocumentMetadataInput {
  documentType: DocumentType;
  title?: string | null | undefined;
  issuer?: string | null | undefined;
  issuedOn?: string | null | undefined;
  expiresOn?: string | null | undefined;
  documentNumber?: string | null | undefined;
  notes?: string | null | undefined;
}

export interface DocumentMetadata {
  title: string | null;
  issuer: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  documentNumber: string | null;
  notes: string | null;
}

const blank = (value: string | null | undefined) => {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
};

/** §5.2: metadata rules, evaluated against today's WIB date. */
export function validateMetadata(input: DocumentMetadataInput, todayWib: string): DocumentMetadata {
  const rule = DOCUMENT_TYPE_RULES[input.documentType];
  const fail = (field: string, message: string) => new EmployeeDocumentError(400, "EMPLOYEE_DOCUMENT_INVALID", message, field);
  const value: DocumentMetadata = {
    title: blank(input.title),
    issuer: blank(input.issuer),
    issuedOn: blank(input.issuedOn),
    expiresOn: blank(input.expiresOn),
    documentNumber: blank(input.documentNumber),
    notes: blank(input.notes),
  };
  if (value.title && value.title.length > 200) throw fail("title", "Judul maksimal 200 karakter.");
  if (rule.titleRequired && !value.title) throw fail("title", "Judul wajib diisi untuk dokumen lain.");
  if (value.issuer && value.issuer.length > 200) throw fail("issuer", "Penerbit maksimal 200 karakter.");
  if (value.notes && value.notes.length > 500) throw fail("notes", "Catatan maksimal 500 karakter.");
  if (value.documentNumber && !NUMBER_PATTERN.test(value.documentNumber)) {
    throw fail("documentNumber", "Nomor dokumen hanya huruf, angka, spasi, titik, garis miring, atau tanda hubung (maks 60).");
  }
  if (value.issuedOn && !isIsoDate(value.issuedOn)) throw fail("issuedOn", "Tanggal terbit tidak valid.");
  if (value.expiresOn && !isIsoDate(value.expiresOn)) throw fail("expiresOn", "Tanggal berakhir tidak valid.");
  if (value.issuedOn && value.issuedOn > todayWib) throw fail("issuedOn", "Tanggal terbit tidak boleh di masa depan.");
  if (value.issuedOn && value.expiresOn && value.expiresOn < value.issuedOn) {
    throw fail("expiresOn", "Tanggal berakhir tidak boleh sebelum tanggal terbit.");
  }
  if (rule.expiry === "REQUIRED" && !value.expiresOn) {
    throw fail("expiresOn", `Tanggal berakhir wajib diisi untuk ${rule.label}.`);
  }
  return value;
}

/** D-15: days from today (WIB) to the expiry date; negative once past. */
export function daysUntil(expiresOn: string, todayWib: string): number {
  return Math.round((Date.parse(`${expiresOn}T00:00:00Z`) - Date.parse(`${todayWib}T00:00:00Z`)) / 86_400_000);
}

export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The WIB calendar date of an instant. */
export function wibDate(instant: Date): string {
  return new Date(instant.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
}

/** §5.1: the statuses each transition starts from. */
export const TRANSITIONS = {
  verify: ["PENDING_REVIEW"],
  reject: ["PENDING_REVIEW"],
  withdraw: ["PENDING_REVIEW"],
  update: ["PENDING_REVIEW", "VERIFIED"],
  remove: ["VERIFIED", "REPLACED"],
} as const satisfies Record<string, readonly DocumentStatus[]>;

export function assertTransition(action: keyof typeof TRANSITIONS, status: DocumentStatus) {
  if (!(TRANSITIONS[action] as readonly DocumentStatus[]).includes(status)) {
    throw new EmployeeDocumentError(409, "EMPLOYEE_DOCUMENT_INVALID_TRANSITION", "Status dokumen tidak mengizinkan tindakan ini.");
  }
}
