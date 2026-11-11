// DOC-003 client: buku nomor surat keluar. The API authorizes every call, checks every grant and
// allocates every number; this module only shapes requests and labels values.
// Spec: docs/domain/outgoing-letter-register.md.

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

export interface Paged<T> {
  items: T[];
  pagination: Pagination;
}

export type IssuerKind = "ORGANIZATION" | "UNIT" | "COMMITTEE" | "OTHER";
export type ResetPeriod = "YEARLY" | "MONTHLY";

export interface LetterTypeOption {
  code: string;
  label: string;
  resetPeriod: ResetPeriod;
}

export interface LetterTypeRow extends LetterTypeOption {
  active: boolean;
  sortOrder: number;
  used: boolean;
}

export interface MyIssuerOption {
  id: string;
  code: string;
  name: string;
  kind: IssuerKind;
  available: boolean;
}

export interface LetterNumber {
  id: string;
  letterNumber: string;
  letterDate: string;
  issuerId: string;
  issuerCode: string;
  issuerName: string;
  typeCode: string;
  typeLabel: string;
  subject: string;
  recipient: string;
  notes: string | null;
  status: "ALLOCATED" | "VOIDED";
  voidedAt: string | null;
  voidReason: string | null;
  version: number;
  createdAt: string;
  requestedByName: string;
  mine?: boolean;
}

export interface RegisterRow {
  source: "BOOK" | "HCIS";
  id: string;
  letterNumber: string;
  letterDate: string;
  issuerCode: string | null;
  issuerName: string;
  typeCode: string;
  typeLabel: string;
  subject: string;
  recipient: string | null;
  status: "ACTIVE" | "VOIDED";
  voidedAt: string | null;
  voidReason: string | null;
  requestedByName: string | null;
  version: number | null;
}

export interface IssuerRow {
  id: string;
  code: string;
  name: string;
  kind: IssuerKind;
  active: boolean;
  unitName: string | null;
  committeeName: string | null;
  committeeStatus: string | null;
  activeGrants: number;
}

export interface GrantRow {
  id: string;
  issuerId: string;
  issuerCode: string;
  issuerName: string;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  employeeStatus: string;
  reason: string;
  grantedAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
}

export interface EmployeeOption {
  id: string;
  fullName: string;
  employeeNumber: string;
  unitName: string | null;
}

export interface TargetOption {
  id: string;
  name: string;
  status: string | null;
}

export interface RegisterFilter {
  source: "ALL" | "BOOK" | "HCIS";
  issuerCode: string;
  typeCode: string;
  status: "" | "ACTIVE" | "VOIDED";
  year: string;
  q: string;
  page: number;
  pageSize: number;
}

export const ISSUER_KIND_LABEL: Record<IssuerKind, string> = {
  ORGANIZATION: "Yayasan",
  UNIT: "Unit",
  COMMITTEE: "Panitia",
  OTHER: "Lainnya",
};

export const RESET_PERIOD_LABEL: Record<ResetPeriod, string> = {
  YEARLY: "Reset tiap tahun",
  MONTHLY: "Reset tiap bulan",
};

/** Carries the HTTP status and code, so a screen can tell forbidden from a failure. */
export class LetterApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = "LetterApiError";
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as T | { message?: string; code?: string } | null;
  if (!response.ok) {
    const failure = body as { message?: string; code?: string } | null;
    throw new LetterApiError(failure?.message ?? "Permintaan tidak dapat diproses.", response.status, failure?.code ?? null);
  }
  return body as T;
}

async function get<T>(path: string) {
  return readJson<T>(await fetch(`/api${path}`, { credentials: "include", headers: { Accept: "application/json" } }));
}

async function write<T>(path: string, method: "POST" | "PATCH", payload: unknown) {
  return readJson<T>(await fetch(`/api${path}`, {
    method,
    credentials: "include",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  }));
}

function query(values: Record<string, string | number | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  return params.toString();
}

// ---------------------------------------------------------------- employee

export const getMyLetterOptions = () =>
  get<{ today: string; issuers: MyIssuerOption[]; types: LetterTypeOption[] }>("/letters/me/options");

export const getMyLetterNumbers = (filter: { page: number; pageSize: number; q?: string; status?: string }) =>
  get<Paged<LetterNumber>>(`/letters/me/numbers?${query({ page: filter.page, pageSize: filter.pageSize, q: filter.q?.trim(), status: filter.status })}`);

export const takeLetterNumber = (input: { issuerId: string; typeCode: string; subject: string; recipient: string; notes?: string }) =>
  write<LetterNumber & { sequence: number }>("/letters/me/numbers", "POST", input);

export const editMyLetterNumber = (id: string, input: { subject?: string; recipient?: string; notes?: string | null; version: number }) =>
  write<LetterNumber>(`/letters/me/numbers/${id}`, "PATCH", input);

export const voidMyLetterNumber = (id: string, reason: string) =>
  write<LetterNumber>(`/letters/me/numbers/${id}/void`, "POST", { reason });

// ---------------------------------------------------------------- admin

export function registerQuery(filter: RegisterFilter, paged = true) {
  return query({
    source: filter.source,
    issuerCode: filter.issuerCode.trim().toUpperCase(),
    typeCode: filter.typeCode,
    status: filter.status,
    year: filter.year,
    q: filter.q.trim(),
    ...(paged ? { page: filter.page, pageSize: filter.pageSize } : {}),
  });
}

export const getLetterRegister = (filter: RegisterFilter) =>
  get<Paged<RegisterRow>>(`/admin/letters/register?${registerQuery(filter)}`);

export function letterRegisterExportUrl(filter: RegisterFilter) {
  return `/api/admin/letters/register/export?${registerQuery(filter, false)}`;
}

export const voidLetterNumber = (id: string, reason: string) =>
  write<LetterNumber>(`/admin/letters/numbers/${id}/void`, "POST", { reason });

export const getLetterTypes = async () => (await get<{ items: LetterTypeRow[] }>("/admin/letters/types")).items;
export const createLetterType = (input: { code: string; label: string; resetPeriod: ResetPeriod }) =>
  write<{ code: string }>("/admin/letters/types", "POST", input);
export const updateLetterType = (code: string, input: { label?: string; resetPeriod?: ResetPeriod; active?: boolean }) =>
  write<{ code: string }>(`/admin/letters/types/${code}`, "PATCH", input);

export const getLetterIssuers = (filter: { page: number; pageSize: number; q?: string }) =>
  get<Paged<IssuerRow>>(`/admin/letters/issuers?${query({ page: filter.page, pageSize: filter.pageSize, q: filter.q?.trim() })}`);
export const searchIssuerTargets = async (kind: "UNIT" | "COMMITTEE", q: string) =>
  (await get<{ items: TargetOption[] }>(`/admin/letters/issuer-targets?${query({ kind, q: q.trim() })}`)).items;
export const createLetterIssuer = (input: {
  code: string; name: string; kind: IssuerKind; organizationalUnitId?: string; committeeId?: string;
}) => write<{ id: string; code: string }>("/admin/letters/issuers", "POST", input);
export const updateLetterIssuer = (id: string, input: { name?: string; active?: boolean }) =>
  write<{ id: string }>(`/admin/letters/issuers/${id}`, "PATCH", input);

export const getLetterGrants = (filter: { page: number; pageSize: number; active: boolean; q?: string; issuerCode?: string }) =>
  get<Paged<GrantRow>>(`/admin/letters/grants?${query({
    page: filter.page, pageSize: filter.pageSize, active: String(filter.active), q: filter.q?.trim(),
    issuerCode: filter.issuerCode?.trim().toUpperCase(),
  })}`);
export const searchLetterEmployees = async (q: string) =>
  (await get<{ items: EmployeeOption[] }>(`/admin/letters/employee-options?${query({ q: q.trim() })}`)).items;
export const createLetterGrant = (input: { employeeId: string; issuerId: string; reason: string }) =>
  write<{ id: string }>("/admin/letters/grants", "POST", input);
export const revokeLetterGrant = (id: string, reason: string) =>
  write<{ id: string }>(`/admin/letters/grants/${id}/revoke`, "POST", { reason });

export const raiseLetterCounter = (input: { issuerId: string; typeCode: string; periodKey: string; lastSequence: number }) =>
  write<{ lastSequence: number; previous: number }>("/admin/letters/counters", "POST", input);

export function formatLetterDate(value: string | null) {
  if (!value) return "-";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00+07:00`) : new Date(value);
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeZone: "Asia/Jakarta" }).format(date);
}
