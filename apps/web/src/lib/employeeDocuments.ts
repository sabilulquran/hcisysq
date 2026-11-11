// EMP-011 client: the employee document archive. The API owns every rule (types, expiry,
// who may read, the proposal limit); this module only shapes requests and labels states.
// Spec: docs/domain/employee-documents.md.

export type DocumentTypeCode =
  | "KTP" | "KK" | "NPWP" | "BPJS_KESEHATAN" | "BPJS_KETENAGAKERJAAN" | "IJAZAH" | "TRANSKRIP"
  | "SERTIFIKAT" | "SIM" | "PASPOR" | "SKCK" | "SURAT_SEHAT" | "LAINNYA";
export type DocumentStatus = "PENDING_REVIEW" | "VERIFIED" | "REJECTED" | "WITHDRAWN" | "REPLACED" | "REMOVED";
export type FileContentType = "application/pdf" | "image/jpeg" | "image/png";

export interface DocumentTypeRule {
  code: DocumentTypeCode;
  label: string;
  expiry: "REQUIRED" | "OPTIONAL";
  titleRequired: boolean;
}

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

export interface EmployeeDocument {
  id: string;
  employeeId: string;
  documentType: DocumentTypeCode;
  typeLabel: string;
  title: string | null;
  issuer: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  daysLeft: number | null;
  expired: boolean;
  numberMasked: string | null;
  status: DocumentStatus;
  source: "HC" | "EMPLOYEE";
  replacesDocumentId: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  createdAt: string;
  file: { contentType: string; byteSize: number; purged: boolean } | null;
  notes?: string | null;
  endedAt?: string | null;
  endReason?: string | null;
}

export interface MyDocumentList {
  items: EmployeeDocument[];
  pagination: Pagination;
  types: DocumentTypeRule[];
  canPropose: boolean;
  maxPending: number;
}

export interface EmployeeDocumentList {
  employee: { id: string; managementScope: "MANAGED" | "OUTSIDE_HCIS" };
  items: EmployeeDocument[];
  pagination: Pagination;
  types: DocumentTypeRule[];
}

export interface ExpiringItem {
  id: string;
  employeeId: string;
  fullName: string;
  employeeNumber: string;
  unitName: string | null;
  documentType: DocumentTypeCode;
  typeLabel: string;
  title: string | null;
  expiresOn: string;
  daysLeft: number;
  expired: boolean;
}

export interface PendingItem {
  id: string;
  employeeId: string;
  fullName: string;
  employeeNumber: string;
  unitName: string | null;
  documentType: DocumentTypeCode;
  typeLabel: string;
  title: string | null;
  createdAt: string;
  replacesDocumentId: string | null;
}

export interface UploadFile {
  contentType: FileContentType;
  contentBase64: string;
}

export interface DocumentDraft {
  documentType: DocumentTypeCode;
  title: string;
  issuer: string;
  issuedOn: string;
  expiresOn: string;
  documentNumber: string;
  notes: string;
  replacesDocumentId: string;
}

export class EmployeeDocumentApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly field?: string) {
    super(message);
    this.name = "EmployeeDocumentApiError";
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}) },
    ...init,
  });
  const body = await response.json().catch(() => null) as (T & { code?: string; message?: string; field?: string }) | null;
  if (!response.ok) {
    const fallback = response.status === 413 ? "Berkas maksimal 4 MB." : "Dokumen tidak dapat diproses.";
    throw new EmployeeDocumentApiError(response.status, body?.code ?? "REQUEST_FAILED", body?.message ?? fallback, body?.field);
  }
  return body as T;
}

const post = <T>(url: string, payload: unknown = {}) => request<T>(url, { method: "POST", body: JSON.stringify(payload) });

/** Blank text means "not given"; the API treats null the same and validates everything again. */
function metadataPayload(draft: DocumentDraft, withNotes: boolean) {
  const text = (value: string) => (value.trim() ? value.trim() : null);
  return {
    documentType: draft.documentType,
    title: text(draft.title),
    issuer: text(draft.issuer),
    issuedOn: text(draft.issuedOn),
    expiresOn: text(draft.expiresOn),
    documentNumber: text(draft.documentNumber),
    replacesDocumentId: text(draft.replacesDocumentId),
    ...(withNotes ? { notes: text(draft.notes) } : {}),
  };
}

// ---------------------------------------------------------------- employee

export const getMyDocuments = (page = 1) => request<MyDocumentList>(`/api/me/employee-documents?page=${page}`);
export const proposeMyDocument = (draft: DocumentDraft, file: UploadFile) =>
  post<EmployeeDocument>("/api/me/employee-documents", { ...metadataPayload(draft, false), file });
export const withdrawMyDocument = (id: string) => post<{ id: string }>(`/api/me/employee-documents/${encodeURIComponent(id)}/withdraw`);
export const myDocumentFileUrl = (id: string) => `/api/me/employee-documents/${encodeURIComponent(id)}/file`;

// ---------------------------------------------------------------- HC

export function getEmployeeDocuments(employeeId: string, options: { page?: number; includeHistory?: boolean } = {}) {
  const params = new URLSearchParams({ page: String(options.page ?? 1) });
  if (options.includeHistory) params.set("includeHistory", "true");
  return request<EmployeeDocumentList>(`/api/admin/employee-documents/employees/${encodeURIComponent(employeeId)}?${params.toString()}`);
}
export const uploadEmployeeDocument = (employeeId: string, draft: DocumentDraft, file: UploadFile) =>
  post<EmployeeDocument>(`/api/admin/employee-documents/employees/${encodeURIComponent(employeeId)}`, { ...metadataPayload(draft, true), file });
/**
 * The screen only ever sees the masked number (D-05), so a blank number field means "keep it";
 * clearing the stored number is an explicit choice.
 */
export function updateEmployeeDocument(id: string, draft: DocumentDraft, clearNumber = false) {
  const payload = metadataPayload(draft, true);
  const fields: Record<string, string | null> = {
    title: payload.title, issuer: payload.issuer, issuedOn: payload.issuedOn, expiresOn: payload.expiresOn, notes: payload.notes ?? null,
  };
  if (clearNumber) fields.documentNumber = null;
  else if (payload.documentNumber) fields.documentNumber = payload.documentNumber;
  return request<EmployeeDocument>(`/api/admin/employee-documents/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(fields) });
}
export const verifyEmployeeDocument = (id: string) => post<EmployeeDocument>(`/api/admin/employee-documents/${encodeURIComponent(id)}/verify`);
export const rejectEmployeeDocument = (id: string, reason: string) =>
  post<EmployeeDocument>(`/api/admin/employee-documents/${encodeURIComponent(id)}/reject`, { reason });
export const removeEmployeeDocument = (id: string, reason: string) =>
  post<EmployeeDocument>(`/api/admin/employee-documents/${encodeURIComponent(id)}/remove`, { reason });
export const employeeDocumentFileUrl = (id: string) => `/api/admin/employee-documents/${encodeURIComponent(id)}/file`;
export function getExpiringDocuments(input: { withinDays: number; page: number }) {
  return request<{ withinDays: number; items: ExpiringItem[]; pagination: Pagination }>(
    `/api/admin/employee-documents/expiring?withinDays=${input.withinDays}&page=${input.page}`,
  );
}
export const getPendingDocuments = (page: number) =>
  request<{ items: PendingItem[]; pagination: Pagination }>(`/api/admin/employee-documents/pending?page=${page}`);

// ---------------------------------------------------------------- shared

export const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const ACCEPTED_TYPES: FileContentType[] = ["application/pdf", "image/jpeg", "image/png"];
export const ACCEPT_ATTRIBUTE = ".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png";

/** Reads a picked file into the JSON shape the API takes; the API re-checks size and content. */
export async function readDocumentFile(file: File): Promise<UploadFile> {
  if (!ACCEPTED_TYPES.includes(file.type as FileContentType)) throw new Error("Berkas harus PDF, JPG, atau PNG.");
  if (file.size > MAX_DOCUMENT_BYTES) throw new Error("Berkas maksimal 4 MB.");
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Berkas tidak dapat dibaca."));
    reader.readAsDataURL(file);
  });
  return { contentType: file.type as FileContentType, contentBase64: dataUrl.slice(dataUrl.indexOf(",") + 1) };
}

export const STATUS_LABEL: Record<DocumentStatus, string> = {
  PENDING_REVIEW: "Menunggu verifikasi HC",
  VERIFIED: "Terverifikasi",
  REJECTED: "Ditolak",
  WITHDRAWN: "Ditarik",
  REPLACED: "Diganti",
  REMOVED: "Berkas dihapus",
};

export function emptyDraft(type: DocumentTypeCode = "KTP"): DocumentDraft {
  return { documentType: type, title: "", issuer: "", issuedOn: "", expiresOn: "", documentNumber: "", notes: "", replacesDocumentId: "" };
}

/** "Berlaku s.d. …" with a plain-language remainder; null when the document has no expiry. */
export function expiryText(document: Pick<EmployeeDocument, "expiresOn" | "daysLeft" | "expired">, formatDate: (value: string) => string) {
  if (!document.expiresOn || document.daysLeft === null) return null;
  if (document.expired) return `Berakhir ${formatDate(document.expiresOn)} (lewat ${Math.abs(document.daysLeft)} hari)`;
  if (document.daysLeft === 0) return `Berakhir hari ini`;
  return `Berlaku s.d. ${formatDate(document.expiresOn)} (${document.daysLeft} hari lagi)`;
}

/** Badge colour: pending, ended, past, within 60 days, or fine. */
export function statusTone(document: Pick<EmployeeDocument, "status" | "expired" | "daysLeft">) {
  if (document.status === "PENDING_REVIEW") return "bg-info-soft text-info-ink";
  if (document.status !== "VERIFIED") return "bg-muted text-muted-foreground";
  if (document.expired) return "bg-danger-soft text-danger-ink";
  if (document.daysLeft !== null && document.daysLeft <= 60) return "bg-warning-soft text-warning-ink";
  return "bg-success-soft text-success-ink";
}

export function formatBytes(bytes: number) {
  return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
