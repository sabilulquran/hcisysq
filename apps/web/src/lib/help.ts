// HELP-001 client. The API authorizes every call and owns every rule (who reads what, search,
// transitions, versions); this module only shapes requests and labels values.
// Spec: docs/domain/help-center.md.

export type HelpTopic =
  | "GENERAL" | "ATTENDANCE" | "OVERTIME" | "LEAVE" | "PAYSLIP" | "TRIPS" | "CALENDAR"
  | "TRAINING" | "LOANS" | "ASSETS" | "DOCUMENTS" | "PERFORMANCE" | "APPROVALS";
export type HelpKind = "FAQ" | "GUIDE";
export type HelpStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";
export type HelpChannel = "WHATSAPP" | "PHONE" | "EMAIL" | "OFFICE";

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

export interface HelpArticle {
  id: string;
  kind: HelpKind;
  topic: HelpTopic;
  title: string;
  body: string;
  sortOrder: number;
  publishedAt: string | null;
  updatedAt: string;
}

export interface AdminHelpArticle extends HelpArticle {
  status: HelpStatus;
  version: number;
  origin: "SEED" | "HC";
  archivedAt: string | null;
  createdAt: string;
}

export interface HelpContact {
  id: string;
  label: string;
  channel: HelpChannel;
  value: string;
  note: string | null;
  sortOrder: number;
  active?: boolean;
}

export interface HelpOverview {
  topics: Array<{ topic: HelpTopic; faqCount: number; guideCount: number }>;
  contacts: HelpContact[];
}

export interface HelpRevision {
  id: string;
  version: number;
  kind: HelpKind;
  topic: HelpTopic;
  title: string;
  body: string;
  status: HelpStatus;
  changeNote: string | null;
  actorName: string | null;
  createdAt: string;
}

export interface HelpAuditEvent {
  id: string;
  eventType: string;
  articleId: string | null;
  contactId: string | null;
  reason: string | null;
  metadata: { title?: string; version?: number; before?: { label?: string }; after?: { label?: string } };
  actorName: string | null;
  occurredAt: string;
}

export interface ArticleInput {
  kind: HelpKind;
  topic: HelpTopic;
  title: string;
  body: string;
  sortOrder: number;
}

export interface ContactInput {
  label: string;
  channel: HelpChannel;
  value: string;
  note?: string;
  sortOrder: number;
  active: boolean;
}

/** D-01 reading order with the labels employees see. */
export const helpTopics: Array<{ topic: HelpTopic; label: string; href: string | null }> = [
  { topic: "GENERAL", label: "Umum & akun", href: null },
  { topic: "ATTENDANCE", label: "Kehadiran", href: "/app/attendance" },
  { topic: "OVERTIME", label: "Lembur", href: "/app/attendance" },
  { topic: "LEAVE", label: "Cuti & izin", href: "/app/leave" },
  { topic: "PAYSLIP", label: "Slip gaji", href: "/app/payslips" },
  { topic: "TRIPS", label: "Perjalanan dinas", href: "/app/trips" },
  { topic: "CALENDAR", label: "Kalender & rapat", href: "/app/calendar" },
  { topic: "TRAINING", label: "Pelatihan", href: "/app/training" },
  { topic: "LOANS", label: "Pinjaman", href: "/app/loans" },
  { topic: "ASSETS", label: "Asset Saya", href: "/app/services/assets" },
  { topic: "DOCUMENTS", label: "Dokumen", href: "/app/documents" },
  { topic: "PERFORMANCE", label: "Kinerja", href: "/app/performance" },
  { topic: "APPROVALS", label: "Persetujuan", href: "/app/approvals" },
];

export function topicLabel(topic: HelpTopic) {
  return helpTopics.find((entry) => entry.topic === topic)?.label ?? topic;
}

export function topicHref(topic: HelpTopic) {
  return helpTopics.find((entry) => entry.topic === topic)?.href ?? null;
}

export const kindLabel: Record<HelpKind, string> = { FAQ: "FAQ", GUIDE: "Panduan" };
export const statusLabel: Record<HelpStatus, string> = { DRAFT: "Draf", PUBLISHED: "Terbit", ARCHIVED: "Arsip" };
export const channelLabel: Record<HelpChannel, string> = {
  WHATSAPP: "WhatsApp", PHONE: "Telepon", EMAIL: "Email", OFFICE: "Datang langsung",
};

export const auditLabel: Record<string, string> = {
  "help.article.created": "Artikel dibuat",
  "help.article.edited": "Artikel diubah",
  "help.article.published": "Artikel diterbitkan",
  "help.article.archived": "Artikel diarsipkan",
  "help.article.restored": "Artikel dipulihkan",
  "help.contact.created": "Kontak ditambahkan",
  "help.contact.updated": "Kontak diubah",
  "help.contact.deleted": "Kontak dihapus",
};

/** D-03: initial content HC has not touched yet. */
export function isUnreviewedSeed(article: Pick<AdminHelpArticle, "origin" | "version" | "status">) {
  return article.origin === "SEED" && article.version === 1 && article.status === "DRAFT";
}

/** D-09: the link a contact opens, or null for a place to visit. */
export function contactHref(contact: Pick<HelpContact, "channel" | "value">) {
  const digits = contact.value.replace(/[^0-9+]/g, "");
  if (contact.channel === "WHATSAPP") {
    // wa.me wants the international number without + or a leading 0.
    const international = digits.replace(/^\+/, "").replace(/^0/, "62");
    return `https://wa.me/${international}`;
  }
  if (contact.channel === "PHONE") return `tel:${digits}`;
  if (contact.channel === "EMAIL") return `mailto:${contact.value}`;
  return null;
}

/** D-05: plain text, paragraphs separated by a blank line. */
export function paragraphs(body: string) {
  return body.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
}

export class HelpRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as T | { message?: string; code?: string } | null;
  if (!response.ok) {
    const problem = body as { message?: string; code?: string } | null;
    throw new HelpRequestError(problem?.message ?? "Pusat Bantuan tidak dapat diproses.", response.status, problem?.code ?? null);
  }
  return body as T;
}

async function get<T>(path: string) {
  return readJson<T>(await fetch(`/api${path}`, { credentials: "include", headers: { Accept: "application/json" } }));
}

async function write<T>(path: string, method: "POST" | "PUT" | "DELETE", payload?: unknown) {
  return readJson<T>(await fetch(`/api${path}`, {
    method,
    credentials: "include",
    headers: { Accept: "application/json", ...(payload === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  }));
}

export interface ArticleFilter {
  q?: string;
  topic?: HelpTopic | "";
  kind?: HelpKind | "";
  status?: HelpStatus | "";
  page?: number;
  pageSize?: number;
}

export function articleQuery(filter: ArticleFilter) {
  const params = new URLSearchParams();
  const q = filter.q?.trim();
  // D-06: the API refuses a one-character query; the screen simply waits for a second one.
  if (q && q.length >= 2) params.set("q", q.slice(0, 100));
  if (filter.topic) params.set("topic", filter.topic);
  if (filter.kind) params.set("kind", filter.kind);
  if (filter.status) params.set("status", filter.status);
  params.set("page", String(filter.page ?? 1));
  params.set("pageSize", String(filter.pageSize ?? 25));
  return params.toString();
}

export function getHelpOverview() {
  return get<HelpOverview>("/help/overview");
}

export function listHelpArticles(filter: ArticleFilter) {
  return get<{ items: HelpArticle[]; pagination: Pagination }>(`/help/articles?${articleQuery(filter)}`);
}

export function listAdminHelpArticles(filter: ArticleFilter) {
  return get<{
    items: AdminHelpArticle[];
    pagination: Pagination;
    counts: Record<HelpStatus, number> & { unreviewedSeed: number };
  }>(`/admin/help/articles?${articleQuery(filter)}`);
}

export function createHelpArticle(input: ArticleInput) {
  return write<{ id: string; status: HelpStatus; version: number }>("/admin/help/articles", "POST", input);
}

export function editHelpArticle(id: string, input: ArticleInput & { version: number; changeNote?: string }) {
  return write<{ id: string; status: HelpStatus; version: number }>(`/admin/help/articles/${id}`, "PUT", input);
}

export function publishHelpArticle(id: string, version: number) {
  return write<{ id: string; status: HelpStatus; version: number }>(`/admin/help/articles/${id}/publish`, "POST", { version });
}

export function archiveHelpArticle(id: string, reason?: string) {
  return write<{ id: string; status: HelpStatus }>(`/admin/help/articles/${id}/archive`, "POST", reason ? { reason } : {});
}

export function restoreHelpArticle(id: string) {
  return write<{ id: string; status: HelpStatus }>(`/admin/help/articles/${id}/restore`, "POST", {});
}

export function listHelpRevisions(id: string, page = 1) {
  return get<{ items: HelpRevision[]; pagination: Pagination }>(`/admin/help/articles/${id}/revisions?page=${page}&pageSize=10`);
}

export function listHelpContacts() {
  return get<{ items: HelpContact[]; limit: number }>("/admin/help/contacts");
}

export function createHelpContact(input: ContactInput) {
  return write<{ id: string }>("/admin/help/contacts", "POST", input);
}

export function updateHelpContact(id: string, input: ContactInput) {
  return write<{ id: string }>(`/admin/help/contacts/${id}`, "PUT", input);
}

export function deleteHelpContact(id: string) {
  return write<{ id: string; deleted: boolean }>(`/admin/help/contacts/${id}`, "DELETE");
}

export function listHelpAuditEvents(page = 1, pageSize = 25) {
  return get<{ items: HelpAuditEvent[]; pagination: Pagination }>(`/admin/help/audit-events?page=${page}&pageSize=${pageSize}`);
}
