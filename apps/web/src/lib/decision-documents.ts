// EMP-010 register client (docs/api/employment.openapi.yaml, S4). Presentation
// labels only: every rule — required fields, the lock, numbering — is the API's.

import { EmploymentApiError, type EmploymentCategory } from "@/lib/employment";

export type DecisionDocumentKind = "PERJANJIAN_KERJA" | "SURAT_KEPUTUSAN";
export type PkType = "PK_BARU" | "PK_PERPANJANGAN";
export type SkType =
  | "SK_PENGANGKATAN"
  | "SK_MUTASI"
  | "SK_PROMOSI"
  | "SK_DEMOSI"
  | "SK_PEMBERHENTIAN"
  | "SK_PENEMPATAN"
  | "SK_LAINNYA";
export type PkCategory = Exclude<EmploymentCategory, "TETAP" | "BELUM_DIKLASIFIKASIKAN">;

export interface DecisionDocumentWrite {
  documentKind: DecisionDocumentKind;
  documentNumber: string;
  signedOn: string;
  externalReference?: string | null;
  notes?: string | null;
  pkType?: PkType | null;
  employeeId?: string | null;
  contractFrom?: string | null;
  contractTo?: string | null;
  category?: PkCategory | null;
  signatoryEmployerLabel?: string | null;
  previousPkId?: string | null;
  skType?: SkType | null;
  subject?: string | null;
  issuingAuthorityLabel?: string | null;
  effectiveOn?: string | null;
  effectiveTo?: string | null;
}

export interface DecisionDocument extends DecisionDocumentWrite {
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

export interface DecisionDocumentDetail extends DecisionDocument {
  links: Array<{
    actionId: string;
    actionType: string;
    effectiveOn: string | null;
    employeeId: string;
    employeeNumber: string | null;
    employeeName: string | null;
    state: "RECORDED" | "REVERSED";
  }>;
  corrections: Array<{ id: string; previousValues: Record<string, unknown>; reason: string; correctedAt: string }>;
}

export interface DecisionDocumentPage {
  kind: DecisionDocumentKind;
  page: number;
  pageSize: number;
  total: number;
  rows: DecisionDocument[];
}

export interface DecisionDocumentListInput {
  kind: DecisionDocumentKind;
  search?: string;
  year?: number;
  pkType?: PkType;
  skType?: SkType;
  category?: PkCategory;
  page?: number;
  pageSize?: number;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}) },
    ...init,
  });
  if (response.ok) return (await response.json()) as T;
  const body = (await response.json().catch(() => null)) as { code?: string; message?: string } | null;
  throw new EmploymentApiError(
    response.status,
    body?.code ?? "REQUEST_FAILED",
    body?.message ?? "Permintaan tidak dapat diproses.",
  );
}

export function listDecisionDocuments(input: DecisionDocumentListInput): Promise<DecisionDocumentPage> {
  const params = new URLSearchParams({
    kind: input.kind,
    page: String(input.page ?? 1),
    pageSize: String(input.pageSize ?? 25),
  });
  if (input.search) params.set("search", input.search);
  if (input.year) params.set("year", String(input.year));
  if (input.pkType) params.set("pkType", input.pkType);
  if (input.skType) params.set("skType", input.skType);
  if (input.category) params.set("category", input.category);
  return request(`/api/admin/decision-documents?${params.toString()}`);
}

export function getDecisionDocument(documentId: string): Promise<DecisionDocumentDetail> {
  return request(`/api/admin/decision-documents/${encodeURIComponent(documentId)}`);
}

export function createDecisionDocument(body: DecisionDocumentWrite): Promise<DecisionDocument> {
  return request("/api/admin/decision-documents", { method: "POST", body: JSON.stringify(body) });
}

/** expectedUpdatedAt is the version the operator had on screen; the API refuses a stale one. */
export function updateDecisionDocument(
  documentId: string,
  body: DecisionDocumentWrite & { expectedUpdatedAt?: string },
): Promise<DecisionDocument> {
  return request(`/api/admin/decision-documents/${encodeURIComponent(documentId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function correctDecisionDocument(
  documentId: string,
  body: DecisionDocumentWrite & { reason: string; expectedUpdatedAt?: string },
): Promise<DecisionDocument> {
  return request(`/api/admin/decision-documents/${encodeURIComponent(documentId)}/corrections`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export const DOCUMENT_KIND_LABEL: Record<DecisionDocumentKind, string> = {
  PERJANJIAN_KERJA: "Perjanjian Kerja",
  SURAT_KEPUTUSAN: "Surat Keputusan",
};

export const PK_TYPE_LABEL: Record<PkType, string> = {
  PK_BARU: "PK baru",
  PK_PERPANJANGAN: "Perpanjangan",
};

export const SK_TYPE_LABEL: Record<SkType, string> = {
  SK_PENGANGKATAN: "SK Pengangkatan",
  SK_MUTASI: "SK Mutasi",
  SK_PROMOSI: "SK Promosi",
  SK_DEMOSI: "SK Demosi",
  SK_PEMBERHENTIAN: "SK Pemberhentian",
  SK_PENEMPATAN: "SK Penempatan",
  SK_LAINNYA: "SK Lainnya",
};

export const PK_CATEGORY_LABEL: Record<PkCategory, string> = {
  KONTRAK: "Pegawai Kontrak",
  KONTRAK_HONORER: "Pegawai Kontrak Honorer",
  MAGANG: "Magang",
  PERCOBAAN: "Masa Percobaan",
  LEPAS: "Pegawai Lepas",
};

/** One form state covering both kinds, with empty strings where the API takes null. */
export type Draft = DecisionDocumentWrite & { reason: string };

export function emptyDraft(kind: DecisionDocumentKind): Draft {
  return {
    documentKind: kind,
    documentNumber: "",
    signedOn: "",
    externalReference: "",
    notes: "",
    pkType: kind === "PERJANJIAN_KERJA" ? "PK_BARU" : null,
    employeeId: null,
    contractFrom: "",
    contractTo: "",
    category: kind === "PERJANJIAN_KERJA" ? "KONTRAK" : null,
    signatoryEmployerLabel: "",
    previousPkId: null,
    skType: kind === "SURAT_KEPUTUSAN" ? "SK_PENEMPATAN" : null,
    subject: "",
    issuingAuthorityLabel: "",
    effectiveOn: "",
    effectiveTo: "",
    reason: "",
  };
}

export function draftFrom(document: DecisionDocument): Draft {
  return {
    documentKind: document.documentKind,
    documentNumber: document.documentNumber,
    signedOn: document.signedOn,
    externalReference: document.externalReference ?? "",
    notes: document.notes ?? "",
    pkType: document.pkType ?? null,
    employeeId: document.employeeId ?? null,
    contractFrom: document.contractFrom ?? "",
    contractTo: document.contractTo ?? "",
    category: document.category ?? null,
    signatoryEmployerLabel: document.signatoryEmployerLabel ?? "",
    previousPkId: document.previousPkId ?? null,
    skType: document.skType ?? null,
    subject: document.subject ?? "",
    issuingAuthorityLabel: document.issuingAuthorityLabel ?? "",
    effectiveOn: document.effectiveOn ?? "",
    effectiveTo: document.effectiveTo ?? "",
    reason: "",
  };
}

/** Empty optional text is sent as null so the API stores an absent value, not "". */
export function payloadOf(draft: Draft): DecisionDocumentWrite {
  const optional = (value: string | null | undefined) => (value && value.trim() ? value.trim() : null);
  const base: DecisionDocumentWrite = {
    documentKind: draft.documentKind,
    documentNumber: draft.documentNumber.trim(),
    signedOn: draft.signedOn,
    externalReference: optional(draft.externalReference),
    notes: optional(draft.notes),
  };
  if (draft.documentKind === "PERJANJIAN_KERJA") {
    return {
      ...base,
      pkType: draft.pkType ?? null,
      employeeId: draft.employeeId ?? null,
      contractFrom: optional(draft.contractFrom),
      contractTo: optional(draft.contractTo),
      category: draft.category ?? null,
      signatoryEmployerLabel: optional(draft.signatoryEmployerLabel),
      previousPkId: draft.previousPkId ?? null,
    };
  }
  return {
    ...base,
    skType: draft.skType ?? null,
    subject: optional(draft.subject),
    issuingAuthorityLabel: optional(draft.issuingAuthorityLabel),
    effectiveOn: optional(draft.effectiveOn),
    effectiveTo: optional(draft.effectiveTo),
  };
}
