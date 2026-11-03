// EMP-012 client: employee ID cards.
// Spec: docs/domain/employee-id-card.md. The server decides validity; this file only shows it.

import { encode } from "uqr";

export type CardStatus = "ACTIVE" | "REPLACED" | "REPORTED_LOST" | "REVOKED";
export type InvalidReason = "REPLACED" | "REPORTED_LOST" | "REVOKED" | "EXPIRED" | "EMPLOYEE_INACTIVE";
export type IssueReason = "NEW" | "LOST" | "DAMAGED" | "DATA_CHANGED" | "EXPIRED";
export type CardFilter = "NO_PHOTO" | "NO_CARD" | "ACTIVE" | "NEEDS_REISSUE";

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

/** The data printed on a card, frozen when it was issued (D-13). */
export interface EmployeeCard {
  id: string;
  employeeId: string;
  cardNumber: string;
  edition: number;
  verifyCode: string;
  status: CardStatus;
  issueReason: IssueReason;
  issuedAt: string;
  validUntil: string;
  fullName: string;
  employeeNumber: string;
  positionTitle: string | null;
  unitName: string | null;
  signerName: string;
  signerTitle: string;
  printCount: number;
  lastPrintedAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  invalidReason?: InvalidReason | null;
  dataChanged?: boolean;
}

export interface MyEmployeeCard {
  card: EmployeeCard | null;
  hasSignature: boolean;
}

export interface CardListItem {
  employeeId: string;
  employeeNumber: string;
  fullName: string;
  employeeStatus: string;
  positionTitle: string | null;
  unitName: string | null;
  hasPhoto: boolean;
  photoUploadedAt: string | null;
  card: {
    id: string;
    cardNumber: string;
    edition: number;
    status: CardStatus;
    validUntil: string;
    printCount: number;
    invalidReason: InvalidReason | null;
    dataChanged: boolean;
  } | null;
}

export interface EmployeeCardDetail {
  employee: {
    id: string;
    employeeNumber: string;
    fullName: string;
    status: string;
    active: boolean;
    positionTitle: string | null;
    unitName: string | null;
  };
  photo: { id: string; contentType: string; byteSize: number; uploadedAt: string } | null;
  cards: EmployeeCard[];
}

export interface CardSettings {
  signerTitle: string;
  signerName: string | null;
  validityMonths: number;
  hasSignature: boolean;
  updatedAt: string;
}

export interface PrintBatch {
  items: EmployeeCard[];
  unavailableCardIds: string[];
  hasSignature: boolean;
}

export interface CardAuditEvent {
  id: string;
  eventType: string;
  employeeId: string | null;
  employeeName: string | null;
  cardId: string | null;
  reason: string | null;
  metadata: Record<string, unknown>;
  occurredAt: string;
  actorName: string | null;
}

export type PublicCardCheck =
  | {
    valid: true;
    cardNumber: string;
    edition: number;
    validUntil: string;
    fullName: string;
    positionTitle: string | null;
    unitName: string | null;
    checkedAt: string;
  }
  | {
    valid: false;
    reason: InvalidReason;
    cardNumber: string;
    edition: number;
    validUntil: string;
    invalidSince: string | null;
    checkedAt: string;
  };

export interface ImageFile {
  contentType: "image/jpeg" | "image/png";
  contentBase64: string;
}

export class EmployeeCardApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "EmployeeCardApiError";
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as T | { code?: string; message?: string } | null;
  if (!response.ok) {
    const problem = body as { code?: string; message?: string } | null;
    throw new EmployeeCardApiError(
      response.status, problem?.code ?? "EMPLOYEE_CARD_FAILED", problem?.message ?? "Kartu pegawai tidak dapat diproses.",
    );
  }
  return body as T;
}

async function get<T>(path: string) {
  return readJson<T>(await fetch(`/api${path}`, { credentials: "include", headers: { Accept: "application/json" } }));
}

async function send<T>(method: "POST" | "PUT", path: string, payload?: unknown) {
  return readJson<T>(await fetch(`/api${path}`, {
    method,
    credentials: "include",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  }));
}

function query(params: Record<string, string | number | undefined | null>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : "";
}

// ---------------------------------------------------------------- employee

export const getMyEmployeeCard = () => get<MyEmployeeCard>("/me/employee-card");
export const reportMyCardLost = () => send<{ id: string; status: CardStatus }>("POST", "/me/employee-card/report-lost");
export const myCardPhotoUrl = "/api/me/employee-card/photo";
export const myCardSignatureUrl = "/api/me/employee-card/signature";

// ---------------------------------------------------------------- admin

export const listEmployeeCards = (params: { page?: number; pageSize?: number; q?: string; filter?: CardFilter | "" }) =>
  get<Paged<CardListItem>>(`/admin/employee-cards${query(params)}`);
export const getEmployeeCardDetail = (employeeId: string) =>
  get<EmployeeCardDetail>(`/admin/employee-cards/employees/${employeeId}`);
export const uploadEmployeePhoto = (employeeId: string, file: ImageFile) =>
  send<{ id: string }>("PUT", `/admin/employee-cards/employees/${employeeId}/photo`, file);
export const issueEmployeeCard = (employeeId: string, input: { reason: IssueReason; note?: string }) =>
  send<{ id: string; cardNumber: string }>("POST", `/admin/employee-cards/employees/${employeeId}/cards`, input);
export const revokeEmployeeCard = (cardId: string, reason: string) =>
  send<{ id: string }>("POST", `/admin/employee-cards/cards/${cardId}/revoke`, { reason });
export const getPrintBatch = (cardIds: string[]) =>
  get<PrintBatch>(`/admin/employee-cards/print${query({ cardIds: cardIds.join(",") })}`);
export const recordPrinted = (cardIds: string[]) =>
  send<{ printed: Array<{ id: string; printCount: number }> }>("POST", "/admin/employee-cards/print", { cardIds });
export const getCardSettings = () => get<CardSettings>("/admin/employee-cards/settings");
export const saveCardSettings = (input: { signerTitle: string; signerName: string; validityMonths: number }) =>
  send<CardSettings>("PUT", "/admin/employee-cards/settings", input);
export const uploadSignature = (file: ImageFile) =>
  send<{ byteSize: number }>("PUT", "/admin/employee-cards/settings/signature", file);
export const listCardAuditEvents = (page = 1, pageSize = 25) =>
  get<Paged<CardAuditEvent>>(`/admin/employee-cards/audit-events${query({ page, pageSize })}`);
export const employeePhotoUrl = (employeeId: string, version?: string) =>
  `/api/admin/employee-cards/employees/${employeeId}/photo${version ? `?v=${encodeURIComponent(version)}` : ""}`;
export const cardPhotoUrl = (cardId: string) => `/api/admin/employee-cards/cards/${cardId}/photo`;
export const adminSignatureUrl = (version?: string) =>
  `/api/admin/employee-cards/settings/signature${version ? `?v=${encodeURIComponent(version)}` : ""}`;
export const printHref = (cardIds: string[]) => `/admin/employee-cards/print?cardIds=${cardIds.join(",")}`;

// ---------------------------------------------------------------- public

export const checkEmployeeCard = (code: string) => get<PublicCardCheck>(`/public/employee-cards/${encodeURIComponent(code)}`);
export const publicCardPhotoUrl = (code: string) => `/api/public/employee-cards/${encodeURIComponent(code)}/photo`;

// ---------------------------------------------------------------- shared

/** D-07: the QR opens the check page on the HCIS origin that shows or prints the card. */
export function verifyUrl(code: string, origin = window.location.origin): string {
  return `${origin}/cek/${code}`;
}

/** Card codes are read in groups of five: 7Q2M9-XPA4K. */
export function formatCode(code: string): string {
  return code.length === 10 ? `${code.slice(0, 5)}-${code.slice(5)}` : code;
}

/** The QR as one SVG path in module units, error correction M, no quiet zone (the card adds it). */
export function qrPath(text: string): { size: number; path: string } {
  const qr = encode(text, { ecc: "M", border: 0 });
  let path = "";
  qr.data.forEach((row, y) => row.forEach((dark, x) => { if (dark) path += `M${x} ${y}h1v1h-1z`; }));
  return { size: qr.size, path };
}

export const issueReasonLabel: Record<IssueReason, string> = {
  NEW: "Terbit baru",
  LOST: "Hilang",
  DAMAGED: "Rusak",
  DATA_CHANGED: "Data berubah",
  EXPIRED: "Habis masa berlaku",
};

export const invalidReasonLabel: Record<InvalidReason, string> = {
  REPLACED: "Sudah diganti kartu baru",
  REPORTED_LOST: "Dilaporkan hilang",
  REVOKED: "Dicabut",
  EXPIRED: "Masa berlaku habis",
  EMPLOYEE_INACTIVE: "Pemegang bukan pegawai aktif",
};

export const filterLabel: Record<CardFilter, string> = {
  NO_PHOTO: "Belum ada foto",
  NO_CARD: "Belum punya kartu",
  ACTIVE: "Kartu aktif",
  NEEDS_REISSUE: "Perlu terbit ulang",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

/** `2028-11-30` → `30 Nov 2028`, without the browser's time zone touching a calendar date. */
export function formatDate(date: string): string {
  const [year, month, day] = date.slice(0, 10).split("-").map(Number);
  return `${day} ${MONTHS[(month ?? 1) - 1]} ${year}`;
}

/** An instant shown as a WIB date. */
export function formatInstantDate(instant: string): string {
  return formatDate(new Date(new Date(instant).getTime() + 7 * 3_600_000).toISOString());
}

export function formatInstant(instant: string): string {
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(new Date(instant)) + " WIB";
}

/** D-03: crop the centre to 3:4 and scale to 600 × 800 JPEG in the browser before upload. */
export async function preparePhoto(file: File): Promise<ImageFile> {
  if (!["image/jpeg", "image/png"].includes(file.type)) throw new Error("Pilih foto JPEG atau PNG.");
  if (file.size > 15 * 1024 * 1024) throw new Error("Berkas foto terlalu besar (maks 15 MB sebelum diperkecil).");
  const bitmap = await createImageBitmap(file);
  const targetRatio = 3 / 4;
  let sw = bitmap.width;
  let sh = bitmap.height;
  if (sw / sh > targetRatio) sw = Math.round(sh * targetRatio);
  else sh = Math.round(sw / targetRatio);
  const canvas = document.createElement("canvas");
  canvas.width = 600;
  canvas.height = 800;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Peramban tidak dapat mengolah foto.");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, 600, 800);
  context.drawImage(bitmap, (bitmap.width - sw) / 2, (bitmap.height - sh) / 2, sw, sh, 0, 0, 600, 800);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
  if (!blob) throw new Error("Foto tidak dapat diproses.");
  return { contentType: "image/jpeg", contentBase64: await toBase64(blob) };
}

export async function readSignature(file: File): Promise<ImageFile> {
  if (file.type !== "image/png") throw new Error("Tanda tangan harus PNG (sebaiknya berlatar transparan).");
  if (file.size > 512 * 1024) throw new Error("Tanda tangan maksimal 512 KB.");
  return { contentType: "image/png", contentBase64: await toBase64(file) };
}

async function toBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Berkas tidak dapat dibaca."));
    reader.readAsDataURL(blob);
  });
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}
