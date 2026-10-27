// DOC-001 / DOC-002 client. The API authorizes every call; this module only shapes requests.

export interface DocumentTypeOption {
  code: string;
  label: string;
}

export interface DocumentRequestSummary {
  id: string;
  documentCode: string;
  documentLabel: string;
  purpose: string;
  status: "SUBMITTED" | "APPROVED" | "REJECTED" | "CANCELLED" | "ISSUED";
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
  documentNumber: string | null;
  employeeId?: string;
  employeeName?: string;
  employeeNumber?: string;
}

export interface IssuedDocumentSummary {
  id: string;
  documentCode: string;
  documentNumber: string;
  status: "ISSUED" | "REVOKED";
  issuedAt: string;
  signer: { title: string; name: string | null };
  contentSnapshot: Record<string, string | null>;
}

export interface DisciplinaryLetterSummary {
  id: string;
  level: "SP1" | "SP2" | "SP3";
  subject: string;
  narrative?: string;
  effectiveDate: string;
  expiresOn: string;
  acknowledgedAt: string | null;
  documentNumber: string;
  status: "ISSUED" | "REVOKED";
  active: boolean;
  employeeId?: string;
  employeeName?: string;
  employeeNumber?: string;
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as T | { message?: string } | null;
  if (!response.ok) {
    throw new Error((body as { message?: string } | null)?.message ?? "Dokumen tidak dapat diproses.");
  }
  return body as T;
}

async function get<T>(path: string) {
  return readJson<T>(await fetch(`/api${path}`, { credentials: "include", headers: { Accept: "application/json" } }));
}

async function post<T>(path: string, payload?: unknown) {
  return readJson<T>(await fetch(`/api${path}`, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  }));
}

export async function getMyDocumentTypes() {
  return (await get<{ items: DocumentTypeOption[] }>("/documents/me/types")).items;
}

export async function getMyDocumentRequests() {
  return (await get<{ items: DocumentRequestSummary[] }>("/documents/me/requests")).items;
}

export async function submitDocumentRequest(documentCode: string, purpose: string) {
  return post<{ id: string; status: string }>("/documents/me/requests", { documentCode, purpose });
}

export async function cancelDocumentRequest(requestId: string) {
  return post<{ id: string; status: string }>(`/documents/me/requests/${requestId}/cancel`);
}

export async function getMyIssuedDocuments() {
  return (await get<{ items: IssuedDocumentSummary[] }>("/documents/me/issued")).items;
}

export async function getMyDisciplinaryLetters() {
  return (await get<{ items: DisciplinaryLetterSummary[] }>("/documents/me/disciplinary")).items;
}

export async function acknowledgeDisciplinaryLetter(letterId: string) {
  return post<{ id: string; acknowledgedAt: string }>(`/documents/me/disciplinary/${letterId}/acknowledge`);
}

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

export interface Page<T> {
  items: T[];
  pagination: Pagination;
}

// ENG-LIST-001: the organization-wide lists page; the screens ask for one full page.
const ADMIN_PAGE_SIZE = 100;

export async function getDocumentRequests(page = 1, status?: DocumentRequestSummary["status"]) {
  const query = `?page=${page}&pageSize=${ADMIN_PAGE_SIZE}${status ? `&status=${status}` : ""}`;
  return get<Page<DocumentRequestSummary>>(`/admin/documents/requests${query}`);
}

export async function approveDocumentRequest(requestId: string, note?: string) {
  return post<{ id: string; status: string }>(`/admin/documents/requests/${requestId}/approve`, { note });
}

export async function rejectDocumentRequest(requestId: string, note: string) {
  return post<{ id: string; status: string }>(`/admin/documents/requests/${requestId}/reject`, { note });
}

export async function issueDocumentRequest(requestId: string) {
  return post<{ id: string; documentNumber: string }>(`/admin/documents/requests/${requestId}/issue`);
}

export async function getDocumentRegister(page = 1) {
  return get<Page<IssuedDocumentSummary & { employeeName: string; employeeNumber: string }>>(
    `/admin/documents/register?page=${page}&pageSize=${ADMIN_PAGE_SIZE}`,
  );
}

export async function revokeIssuedDocument(documentId: string, reason: string) {
  return post<{ id: string; status: string }>(`/admin/documents/issued/${documentId}/revoke`, { reason });
}

export async function getDisciplinaryLetters(page = 1) {
  return get<Page<DisciplinaryLetterSummary>>(`/admin/documents/disciplinary?page=${page}&pageSize=${ADMIN_PAGE_SIZE}`);
}

export async function issueDisciplinaryLetter(input: {
  employeeId: string;
  level: DisciplinaryLetterSummary["level"];
  subject: string;
  narrative: string;
  effectiveDate: string;
  expiresOn?: string;
}) {
  return post<{ id: string; documentNumber: string; expiresOn: string; warnings: string[] }>(
    "/admin/documents/disciplinary",
    input,
  );
}

export function documentStatusLabel(status: DocumentRequestSummary["status"]) {
  if (status === "SUBMITTED") return "Menunggu keputusan";
  if (status === "APPROVED") return "Disetujui, menunggu terbit";
  if (status === "ISSUED") return "Sudah terbit";
  if (status === "REJECTED") return "Ditolak";
  return "Dibatalkan";
}
