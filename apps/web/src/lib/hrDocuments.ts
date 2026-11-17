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
  /** Facts frozen at issue (§4.1); an income letter adds `income` (D-24). */
  contentSnapshot: Record<string, unknown>;
}

/** DOC-001 Package 2: the surat keterangan penghasilan, whose snapshot carries pay figures. */
export const INCOME_DOCUMENT_CODE = "KETERANGAN_PENGHASILAN";

/** D-26: besides documents.manage, any of these opens an income letter of someone else (mirrors the API). */
export const INCOME_READER_PERMISSIONS = [
  "payroll.results.read.organization",
  "payroll.calculate",
  "payroll.inputs.manage",
] as const;

/** D-24: amounts are rupiah decimal strings ("5116667" or "5250000.50"), never floats. */
export interface IncomeFigures {
  months: Array<{ period: string; gross: string; net: string; employerBorne?: string; layout?: "EMPLOYER_BLOCK" | "LEGACY" }>;
  monthCount: number;
  averageGross: string;
  averageNet: string;
  /** D-27; absent on letters issued before the block "Ditanggung yayasan" existed. */
  averageEmployerBorne?: string;
  mixedLayout?: boolean;
  windowFrom: string;
  windowTo: string;
}

/** D-27: is there an employer-borne figure worth a line of its own on this letter? */
export function hasEmployerBorneIncome(income: IncomeFigures): boolean {
  return income.months.some((month) => Boolean(month.employerBorne) && month.employerBorne !== "0");
}

export function incomeFigures(document: Pick<IssuedDocumentSummary, "contentSnapshot">): IncomeFigures | null {
  const income = document.contentSnapshot.income as IncomeFigures | undefined;
  return income && Array.isArray(income.months) ? income : null;
}

/** "5116667" -> "Rp5.116.667", "5250000.50" -> "Rp5.250.000,50"; string arithmetic only. */
export function formatRupiahAmount(amount: string): string {
  const negative = amount.startsWith("-");
  const [whole = "0", sen] = (negative ? amount.slice(1) : amount).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}Rp${grouped}${sen ? `,${sen}` : ""}`;
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

/** Carries the HTTP status and code, so a screen can tell forbidden from a failure. */
export class HrDocumentApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = "HrDocumentApiError";
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as T | { message?: string; code?: string } | null;
  if (!response.ok) {
    const failure = body as { message?: string; code?: string } | null;
    throw new HrDocumentApiError(failure?.message ?? "Dokumen tidak dapat diproses.", response.status, failure?.code ?? null);
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

/** D-20: my own issued certificate, to print or save as PDF. The API audits each opening. */
export async function getMyIssuedDocument(documentId: string) {
  return get<IssuedDocumentSummary>(`/documents/me/issued/${documentId}`);
}

/**
 * D-25: HC reads one issued certificate. The API audits each read and answers 403 for an income
 * letter unless the account also holds documents.manage.
 */
export async function getIssuedDocument(documentId: string) {
  return get<IssuedDocumentSummary & { revokedAt: string | null }>(`/admin/documents/issued/${documentId}`);
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

export type RegisterKind = "CERTIFICATE" | "DISCIPLINARY";

/**
 * One register row. D-18: a warning letter row carries register facts only, so its employee,
 * signer and content are always null; the number is how a corrector recognizes it.
 */
export interface RegisterEntry {
  id: string;
  documentKind: RegisterKind;
  documentCode: string;
  documentNumber: string;
  status: IssuedDocumentSummary["status"];
  issuedAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
  signer: IssuedDocumentSummary["signer"] | null;
  employeeName: string | null;
  employeeNumber: string | null;
}

export interface RegisterFilter {
  kind: RegisterKind;
  status: IssuedDocumentSummary["status"] | null;
  page: number;
  pageSize: number;
}

export const REGISTER_PAGE_SIZES = [10, 25, 50, 100] as const;
export const DEFAULT_REGISTER_FILTER: RegisterFilter = { kind: "CERTIFICATE", status: null, page: 1, pageSize: 25 };

/** ENG-LIST-001-J: the register keeps its tab, filter and page in the query string. */
export function readRegisterFilter(search: string): RegisterFilter {
  const params = new URLSearchParams(search);
  const kind = params.get("registerKind");
  const status = params.get("registerStatus");
  const page = Number(params.get("registerPage") ?? "1");
  const pageSize = Number(params.get("registerPageSize") ?? String(DEFAULT_REGISTER_FILTER.pageSize));
  return {
    kind: kind === "DISCIPLINARY" ? "DISCIPLINARY" : "CERTIFICATE",
    status: status === "ISSUED" || status === "REVOKED" ? status : null,
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: (REGISTER_PAGE_SIZES as readonly number[]).includes(pageSize) ? pageSize : DEFAULT_REGISTER_FILTER.pageSize,
  };
}

/** Writes the register filter into `search`, leaving any other parameter as it was. */
export function writeRegisterFilter(search: string, filter: RegisterFilter): string {
  const params = new URLSearchParams(search);
  const set = (key: string, value: string | null, fallback: string | null) => {
    if (value === null || value === fallback) params.delete(key);
    else params.set(key, value);
  };
  set("registerKind", filter.kind, DEFAULT_REGISTER_FILTER.kind);
  set("registerStatus", filter.status, null);
  set("registerPage", String(filter.page), "1");
  set("registerPageSize", String(filter.pageSize), String(DEFAULT_REGISTER_FILTER.pageSize));
  const query = params.toString();
  return query ? `?${query}` : "";
}

export async function getDocumentRegister(filter: RegisterFilter) {
  const params = new URLSearchParams({
    kind: filter.kind, page: String(filter.page), pageSize: String(filter.pageSize),
  });
  if (filter.status) params.set("status", filter.status);
  return get<Page<RegisterEntry>>(`/admin/documents/register?${params.toString()}`);
}

/** Mirrors the API's own limits so the dialog can say so before sending; the API still decides. */
export const REVOKE_REASON_MIN = 10;
export const REVOKE_REASON_MAX = 500;

export function revokeReasonProblem(reason: string): string | null {
  const length = reason.trim().length;
  if (length === 0) return "Alasan pembatalan wajib diisi.";
  if (length < REVOKE_REASON_MIN) return `Alasan minimal ${REVOKE_REASON_MIN} karakter (sekarang ${length}).`;
  if (length > REVOKE_REASON_MAX) return `Alasan maksimal ${REVOKE_REASON_MAX} karakter.`;
  return null;
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
