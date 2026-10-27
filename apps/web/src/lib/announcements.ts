// NOTIF-002 client. The API authorizes every call; this module only shapes requests.

export type AnnouncementLevel = "NORMAL" | "PENTING";
export type AnnouncementVisibility = "HIDDEN" | "DUE" | "PUBLISHED" | "ARCHIVED" | "SUPERSEDED";

export interface EmployeeAnnouncement {
  id: string;
  title: string;
  body: string;
  level: AnnouncementLevel;
  publishedAt: string | null;
  displayUntil: string | null;
  readAt: string | null;
  acknowledgedAt: string | null;
  visibility: AnnouncementVisibility;
}

export interface AdminAnnouncement {
  id: string;
  title: string;
  level: AnnouncementLevel;
  status: "DRAFT" | "SCHEDULED" | "PUBLISHED" | "ARCHIVED" | "SUPERSEDED";
  publishAt: string | null;
  displayUntil: string | null;
  publishedAt: string | null;
  supersedesId: string | null;
  reach: number;
  readCount: number;
  acknowledgedCount: number;
  visibility: AnnouncementVisibility;
}

export type AnnouncementAudience =
  | { kind: "ALL_EMPLOYEES" }
  | { kind: "UNIT"; organizationalUnitId: string };

export interface AnnouncementDraft {
  title: string;
  body: string;
  level: AnnouncementLevel;
  audiences: AnnouncementAudience[];
  publishAt?: string;
  displayUntil?: string;
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as T | { message?: string } | null;
  if (!response.ok) {
    throw new Error((body as { message?: string } | null)?.message ?? "Pengumuman tidak dapat diproses.");
  }
  return body as T;
}

async function get<T>(path: string) {
  return readJson<T>(await fetch(`/api${path}`, { credentials: "include", headers: { Accept: "application/json" } }));
}

async function write<T>(path: string, method: "POST" | "PUT", payload?: unknown) {
  return readJson<T>(await fetch(`/api${path}`, {
    method,
    credentials: "include",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  }));
}

export async function getMyAnnouncements() {
  return get<{ items: EmployeeAnnouncement[]; pendingAcknowledgement: number }>("/announcements/me");
}

export async function markAnnouncementRead(id: string) {
  return write<{ announcementId: string; readAt: string }>(`/announcements/me/${id}/read`, "POST");
}

export async function acknowledgeAnnouncement(id: string) {
  return write<{ acknowledgedAt: string }>(`/announcements/me/${id}/acknowledge`, "POST");
}

const ADMIN_PAGE_SIZE = 100;

export async function getAnnouncements(page = 1) {
  return get<{ items: AdminAnnouncement[]; pagination: { total: number } }>(
    `/admin/announcements?page=${page}&pageSize=${ADMIN_PAGE_SIZE}`,
  );
}

export async function createAnnouncement(draft: AnnouncementDraft) {
  return write<{ id: string }>("/admin/announcements", "POST", draft);
}

export async function publishAnnouncement(id: string) {
  return write<{ id: string; reach: number }>(`/admin/announcements/${id}/publish`, "POST");
}

export async function archiveAnnouncement(id: string, reason?: string) {
  return write<{ id: string; status: string }>(`/admin/announcements/${id}/archive`, "POST", { reason });
}

export function announcementStatusLabel(announcement: Pick<AdminAnnouncement, "status" | "visibility">) {
  if (announcement.status === "SUPERSEDED") return "Diralat";
  if (announcement.visibility === "ARCHIVED") return "Arsip";
  if (announcement.visibility === "PUBLISHED") return "Terbit";
  // N-07: a scheduled moment that has passed is a reminder to publish, not a publication.
  if (announcement.visibility === "DUE") return "Jatuh tempo, belum diterbitkan";
  if (announcement.status === "SCHEDULED") return "Dijadwalkan";
  return "Draf";
}
