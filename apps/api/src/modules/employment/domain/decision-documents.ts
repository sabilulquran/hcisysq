// EMP-010 Package 1 S4: Perjanjian Kerja and Surat Keputusan are separate kinds
// with their own fields and numbering (spec §4.5, D-08). Pure validation: no DB,
// no HTTP. The store enforces uniqueness and the lock; this file decides which
// fields a kind may carry and refuses the combinations the register must reject.

import { isIsoDate } from "./dates.js";
import type { DocumentKind, PkType, SkType } from "./model.js";

export const DECISION_DOCUMENT_KINDS = ["PERJANJIAN_KERJA", "SURAT_KEPUTUSAN"] as const satisfies readonly DocumentKind[];

export const PK_TYPES = ["PK_BARU", "PK_PERPANJANGAN"] as const satisfies readonly PkType[];

export const SK_TYPES = [
  "SK_PENGANGKATAN",
  "SK_MUTASI",
  "SK_PROMOSI",
  "SK_DEMOSI",
  "SK_PEMBERHENTIAN",
  "SK_PENEMPATAN",
  "SK_LAINNYA",
] as const satisfies readonly SkType[];

/** Categories a Perjanjian Kerja can establish; TETAP comes from an SK, not a PK (§4.5.2). */
export const PK_CATEGORIES = ["KONTRAK", "KONTRAK_HONORER", "MAGANG", "PERCOBAAN", "LEPAS"] as const;
export type PkCategory = (typeof PK_CATEGORIES)[number];

export interface DecisionDocumentInput {
  documentKind: DocumentKind;
  documentNumber: string;
  signedOn: string;
  externalReference?: string | null | undefined;
  notes?: string | null | undefined;
  // Perjanjian Kerja
  pkType?: PkType | null | undefined;
  employeeId?: string | null | undefined;
  contractFrom?: string | null | undefined;
  contractTo?: string | null | undefined;
  category?: PkCategory | null | undefined;
  signatoryEmployerLabel?: string | null | undefined;
  previousPkId?: string | null | undefined;
  // Surat Keputusan
  skType?: SkType | null | undefined;
  subject?: string | null | undefined;
  issuingAuthorityLabel?: string | null | undefined;
  effectiveOn?: string | null | undefined;
  effectiveTo?: string | null | undefined;
}

export interface DecisionDocumentValues {
  documentKind: DocumentKind;
  documentNumber: string;
  signedOn: string;
  externalReference: string | null;
  notes: string | null;
  pkType: PkType | null;
  employeeId: string | null;
  contractFrom: string | null;
  contractTo: string | null;
  category: PkCategory | null;
  signatoryEmployerLabel: string | null;
  previousPkId: string | null;
  skType: SkType | null;
  subject: string | null;
  issuingAuthorityLabel: string | null;
  effectiveOn: string | null;
  effectiveTo: string | null;
}

export interface DecisionDocumentFailure {
  code: "DECISION_DOCUMENT_INVALID";
  field: string;
  message: string;
}

export type DecisionDocumentValidation =
  | { ok: true; value: DecisionDocumentValues }
  | { ok: false; failure: DecisionDocumentFailure };

/** Register numbers are compared without surrounding or repeated whitespace. */
export function normalizeDocumentNumber(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function text(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function fail(field: string, message: string): DecisionDocumentValidation {
  return { ok: false, failure: { code: "DECISION_DOCUMENT_INVALID", field, message } };
}

/**
 * Validates one register entry. The caller has already checked the shape; this
 * adds the kind rules the database CHECK also enforces, so the API answers with
 * a field-level message instead of a constraint violation.
 */
export function validateDecisionDocument(input: DecisionDocumentInput): DecisionDocumentValidation {
  const documentNumber = normalizeDocumentNumber(input.documentNumber ?? "");
  if (!documentNumber) return fail("documentNumber", "Nomor dokumen wajib diisi.");
  if (!isIsoDate(input.signedOn)) return fail("signedOn", "Tanggal tanda tangan tidak valid.");

  const common = {
    documentNumber,
    signedOn: input.signedOn,
    externalReference: text(input.externalReference),
    notes: text(input.notes),
  };

  if (input.documentKind === "PERJANJIAN_KERJA") {
    if (!input.pkType || !PK_TYPES.includes(input.pkType)) return fail("pkType", "Pilih jenis Perjanjian Kerja.");
    if (!input.employeeId) return fail("employeeId", "Perjanjian Kerja harus menyebut satu pegawai.");
    if (!isIsoDate(input.contractFrom ?? "")) return fail("contractFrom", "Tanggal mulai kontrak tidak valid.");
    if (!isIsoDate(input.contractTo ?? "")) return fail("contractTo", "Tanggal akhir kontrak wajib diisi.");
    if ((input.contractTo as string) < (input.contractFrom as string)) {
      return fail("contractTo", "Tanggal akhir kontrak tidak boleh sebelum tanggal mulai.");
    }
    if (!input.category || !PK_CATEGORIES.includes(input.category)) {
      return fail("category", "Pilih status kepegawaian yang ditetapkan Perjanjian Kerja.");
    }
    if (input.previousPkId && input.pkType !== "PK_PERPANJANGAN") {
      return fail("previousPkId", "Perjanjian Kerja sebelumnya hanya diisi pada perpanjangan.");
    }
    return {
      ok: true,
      value: {
        documentKind: "PERJANJIAN_KERJA",
        ...common,
        pkType: input.pkType,
        employeeId: input.employeeId,
        contractFrom: input.contractFrom as string,
        contractTo: input.contractTo as string,
        category: input.category,
        signatoryEmployerLabel: text(input.signatoryEmployerLabel),
        previousPkId: input.previousPkId ?? null,
        skType: null,
        subject: null,
        issuingAuthorityLabel: null,
        effectiveOn: null,
        effectiveTo: null,
      },
    };
  }

  if (!input.skType || !SK_TYPES.includes(input.skType)) return fail("skType", "Pilih jenis Surat Keputusan.");
  const subject = text(input.subject);
  if (!subject) return fail("subject", "Perihal SK wajib diisi.");
  const issuingAuthorityLabel = text(input.issuingAuthorityLabel);
  if (!issuingAuthorityLabel) return fail("issuingAuthorityLabel", "Pejabat penerbit wajib diisi.");
  if (!isIsoDate(input.effectiveOn ?? "")) return fail("effectiveOn", "Tanggal berlaku SK tidak valid.");
  if (input.effectiveTo !== null && input.effectiveTo !== undefined) {
    if (!isIsoDate(input.effectiveTo)) return fail("effectiveTo", "Tanggal akhir berlaku tidak valid.");
    if (input.effectiveTo < (input.effectiveOn as string)) {
      return fail("effectiveTo", "Tanggal akhir berlaku tidak boleh sebelum tanggal berlaku.");
    }
  }
  return {
    ok: true,
    value: {
      documentKind: "SURAT_KEPUTUSAN",
      ...common,
      pkType: null,
      employeeId: null,
      contractFrom: null,
      contractTo: null,
      category: null,
      signatoryEmployerLabel: null,
      previousPkId: null,
      skType: input.skType,
      subject,
      issuingAuthorityLabel,
      effectiveOn: input.effectiveOn as string,
      effectiveTo: input.effectiveTo ?? null,
    },
  };
}

/**
 * Fields an edit or a correction (D-09) may change. The kind itself and, for a
 * Perjanjian Kerja, the employee it belongs to are never rewritten: a wrong kind
 * or a wrong employee is a different document.
 */
export const DECISION_DOCUMENT_EDITABLE_FIELDS = [
  "documentNumber",
  "signedOn",
  "externalReference",
  "notes",
  "pkType",
  "contractFrom",
  "contractTo",
  "category",
  "signatoryEmployerLabel",
  "previousPkId",
  "skType",
  "subject",
  "issuingAuthorityLabel",
  "effectiveOn",
  "effectiveTo",
] as const satisfies readonly (keyof DecisionDocumentValues)[];

/** The values a correction keeps, so the prior version stays readable (D-09). */
export function previousValuesOf(values: DecisionDocumentValues): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const field of DECISION_DOCUMENT_EDITABLE_FIELDS) snapshot[field] = values[field];
  return snapshot;
}
