// ORG-012 client. The API authorizes every call and owns every rule (line-up, chair transfer,
// decree numbering, state); this module only shapes requests and labels values.
// Spec: docs/domain/committees.md.

import type { ParticipantOption } from "@/lib/meetings";

export type CommitteeCategory = "ADMISSION" | "EXAM" | "GRADUATION" | "RAMADAN" | "EVENT" | "OTHER";
export type CommitteeRole = "CHAIR" | "VICE_CHAIR" | "SECRETARY" | "TREASURER" | "SECTION_COORDINATOR" | "MEMBER";
export type CommitteeStatus = "DRAFT" | "ACTIVE" | "COMPLETED" | "CANCELLED";

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

export interface CommitteeBase {
  id: string;
  name: string;
  category: CommitteeCategory;
  description: string | null;
  organizer: string | null;
  startOn: string;
  endOn: string;
  status: CommitteeStatus;
  activatedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
}

export interface CommitteeSummary extends CommitteeBase {
  version: number;
  decreeNumber: string | null;
  activeMemberCount: number;
  chairName: string | null;
}

export interface CommitteeMember {
  id: string;
  employeeId: string;
  fullName: string;
  employeeNumber?: string;
  employeeStatus?: string;
  unitName: string | null;
  role: CommitteeRole;
  section: string | null;
  joinedOn: string;
  leftOn: string | null;
  /** HC only (D-15). */
  endReason?: string | null;
}

export interface DecreeSnapshot {
  name: string;
  category: CommitteeCategory;
  organizer: string | null;
  startOn: string;
  endOn: string;
  members: Array<{ fullName: string; unitName: string | null; role: CommitteeRole; section: string | null }>;
}

export interface CommitteeDetail extends CommitteeBase {
  version?: number;
  decreeMode: "ISSUED" | "EXTERNAL" | null;
  decreeNumber: string | null;
  decreeDate: string | null;
  decreeStatus: "ISSUED" | "REVOKED" | null;
  decreeSigner: { title: string; name: string } | null;
  decreeSnapshot: DecreeSnapshot | null;
  members: CommitteeMember[];
  myMemberIds?: string[];
}

export interface MyCommittee extends CommitteeBase {
  decreeNumber: string | null;
  role: CommitteeRole;
  section: string | null;
  joinedOn: string;
  leftOn: string | null;
}

export interface CommitteeEvent {
  id: string;
  eventType: string;
  employeeId: string | null;
  reason: string | null;
  metadata: { name?: string; role?: CommitteeRole; decreeNumber?: string; before?: { role?: CommitteeRole }; after?: { role?: CommitteeRole } };
  occurredAt: string;
  actorName: string | null;
}

export interface EmployeeOption {
  id: string;
  fullName: string;
  employeeNumber: string;
  unitName: string | null;
}

export interface ParticipationRow {
  employeeId: string;
  fullName: string;
  employeeNumber: string;
  unitName: string | null;
  total: number;
  asChair: number;
  asCore: number;
  ongoing: number;
}

export interface EmployeeParticipation {
  year: number;
  employee: { id: string; fullName: string; employeeNumber: string; unitName: string | null };
  items: Array<{
    memberId: string; committeeId: string; name: string; category: CommitteeCategory; status: CommitteeStatus;
    startOn: string; endOn: string; role: CommitteeRole; section: string | null; joinedOn: string; leftOn: string | null;
    decreeNumber: string | null;
  }>;
  pagination: Pagination;
}

export interface MeetingGroup {
  id: string;
  name: string;
  members: ParticipantOption[];
}

export interface CommitteeInput {
  name: string;
  category: CommitteeCategory;
  description: string | null;
  organizer: string | null;
  startOn: string;
  endOn: string;
}

export type DecreeInput = { mode: "ISSUE" } | { mode: "EXTERNAL"; number: string; date: string };

export interface WriteResult {
  id: string;
  version: number;
  status?: CommitteeStatus;
  decreeNumber?: string;
}

export class CommitteeRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null, readonly problems: string[] = []) {
    super(message);
    this.name = "CommitteeRequestError";
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as T | { message?: string; code?: string; problems?: string[] } | null;
  if (!response.ok) {
    const problem = body as { message?: string; code?: string; problems?: string[] } | null;
    throw new CommitteeRequestError(
      problem?.message ?? "Permintaan kepanitiaan tidak dapat diproses.",
      response.status,
      problem?.code ?? null,
      problem?.problems ?? [],
    );
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

export interface CommitteeFilter {
  status?: CommitteeStatus | "";
  category?: CommitteeCategory | "";
  year?: number | "";
  q?: string;
  page?: number;
  pageSize?: number;
}

export function committeeQuery(filter: CommitteeFilter) {
  const params = new URLSearchParams();
  if (filter.status) params.set("status", filter.status);
  if (filter.category) params.set("category", filter.category);
  if (filter.year) params.set("year", String(filter.year));
  const q = filter.q?.trim();
  // The API refuses a one-character query; the screen simply waits for a second one.
  if (q && q.length >= 2) params.set("q", q.slice(0, 100));
  params.set("page", String(filter.page ?? 1));
  params.set("pageSize", String(filter.pageSize ?? 25));
  return params.toString();
}

// ------------------------------------------------------------------ admin

export const listCommittees = (filter: CommitteeFilter) =>
  get<Paged<CommitteeSummary>>(`/admin/committees?${committeeQuery(filter)}`);
export const getCommittee = (id: string) => get<CommitteeDetail>(`/admin/committees/${id}`);
export const listCommitteeHistory = (id: string, page = 1) =>
  get<Paged<CommitteeEvent>>(`/admin/committees/${id}/history?page=${page}&pageSize=25`);
export const searchCommitteeEmployees = (q: string) =>
  get<{ items: EmployeeOption[] }>(`/admin/committees/employee-options?q=${encodeURIComponent(q)}`);
export const createCommittee = (input: CommitteeInput) => write<WriteResult>("/admin/committees", "POST", input);
export const updateCommittee = (id: string, input: CommitteeInput & { version: number }) =>
  write<WriteResult>(`/admin/committees/${id}`, "PATCH", input);
export const addCommitteeMember = (id: string, input: { employeeId: string; role: CommitteeRole; section: string | null; version: number }) =>
  write<WriteResult>(`/admin/committees/${id}/members`, "POST", input);
export const updateCommitteeMember = (id: string, memberId: string, input: { role: CommitteeRole; section: string | null; version: number }) =>
  write<WriteResult>(`/admin/committees/${id}/members/${memberId}`, "PATCH", input);
export const endCommitteeMember = (id: string, memberId: string, input: { reason: string | null; version: number }) =>
  write<WriteResult>(`/admin/committees/${id}/members/${memberId}/end`, "POST", input);
export const activateCommittee = (id: string, input: { decree: DecreeInput; version: number }) =>
  write<WriteResult>(`/admin/committees/${id}/activate`, "POST", input);
export const completeCommittee = (id: string, version: number) =>
  write<WriteResult>(`/admin/committees/${id}/complete`, "POST", { version });
export const cancelCommittee = (id: string, input: { reason: string; version: number }) =>
  write<WriteResult>(`/admin/committees/${id}/cancel`, "POST", input);

export function participationQuery(filter: { year: number; q?: string; page?: number; pageSize?: number }) {
  const params = new URLSearchParams({ year: String(filter.year), page: String(filter.page ?? 1), pageSize: String(filter.pageSize ?? 25) });
  const q = filter.q?.trim();
  if (q && q.length >= 2) params.set("q", q.slice(0, 100));
  return params.toString();
}

export const listParticipation = (filter: { year: number; q?: string; page?: number; pageSize?: number }) =>
  get<Paged<ParticipationRow> & { year: number }>(`/admin/committees/participation?${participationQuery(filter)}`);
export const getEmployeeParticipation = (employeeId: string, year: number, page = 1) =>
  get<EmployeeParticipation>(`/admin/committees/participation/${employeeId}?year=${year}&page=${page}&pageSize=25`);

// ------------------------------------------------------------------ employee

export const listMyCommittees = (scope: "current" | "history", page = 1) =>
  get<Paged<MyCommittee>>(`/me/committees?scope=${scope}&page=${page}&pageSize=25`);
export const getMyCommittee = (id: string) => get<CommitteeDetail>(`/me/committees/${id}`);
export const listMyMeetingGroups = () => get<{ items: MeetingGroup[] }>("/me/committees/meeting-groups");

// ------------------------------------------------------------------ labels

export const CATEGORY_LABELS: Record<CommitteeCategory, string> = {
  ADMISSION: "PPDB / SPMB",
  EXAM: "Ujian",
  GRADUATION: "Wisuda",
  RAMADAN: "Kegiatan Ramadhan",
  EVENT: "Acara / kegiatan",
  OTHER: "Lainnya",
};

export const ROLE_LABELS: Record<CommitteeRole, string> = {
  CHAIR: "Ketua",
  VICE_CHAIR: "Wakil Ketua",
  SECRETARY: "Sekretaris",
  TREASURER: "Bendahara",
  SECTION_COORDINATOR: "Koordinator Seksi",
  MEMBER: "Anggota",
};

export const STATUS_LABELS: Record<CommitteeStatus, string> = {
  DRAFT: "Draf",
  ACTIVE: "Berjalan",
  COMPLETED: "Selesai",
  CANCELLED: "Dibatalkan",
};

export const EVENT_LABELS: Record<string, string> = {
  "committee.created": "Kepanitiaan dicatat",
  "committee.updated": "Data kegiatan diubah",
  "committee.member.added": "Anggota ditambahkan",
  "committee.member.updated": "Peran anggota diubah",
  "committee.member.removed": "Anggota dihapus dari draf",
  "committee.member.ended": "Tugas anggota diakhiri",
  "committee.activated": "Kepanitiaan ditetapkan",
  "committee.completed": "Kepanitiaan selesai",
  "committee.cancelled": "Kepanitiaan dibatalkan",
  "committee.decree.revoked": "SK dicabut",
};

export const committeeCategories = Object.keys(CATEGORY_LABELS) as CommitteeCategory[];
export const committeeRoles = Object.keys(ROLE_LABELS) as CommitteeRole[];

const date = new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Jakarta" });
const longDate = new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Jakarta" });

export function formatDate(value: string | null, long = false) {
  if (!value) return "-";
  return (long ? longDate : date).format(new Date(`${value.slice(0, 10)}T00:00:00+07:00`));
}

export function formatPeriod(startOn: string, endOn: string) {
  return startOn === endOn ? formatDate(startOn) : `${formatDate(startOn)} – ${formatDate(endOn)}`;
}

export function formatInstant(value: string) {
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" }).format(new Date(value));
}

export function todayInJakarta() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export function roleLabel(role: CommitteeRole, section: string | null) {
  return section ? `${ROLE_LABELS[role]} · ${section}` : ROLE_LABELS[role];
}

/** One line for the history list: what happened and to whom. */
export function describeEvent(event: CommitteeEvent) {
  const label = EVENT_LABELS[event.eventType] ?? event.eventType;
  if (event.eventType === "committee.member.updated" && event.metadata.before?.role && event.metadata.after?.role) {
    return `${label}: ${event.metadata.name ?? ""} ${ROLE_LABELS[event.metadata.before.role]} → ${ROLE_LABELS[event.metadata.after.role]}`;
  }
  if (event.eventType.startsWith("committee.member.") && event.metadata.name) return `${label}: ${event.metadata.name}`;
  if (event.eventType === "committee.activated" && event.metadata.decreeNumber) return `${label} (SK ${event.metadata.decreeNumber})`;
  return label;
}

/** The decree printout lists the line-up as fixed at activation; an external decree has no snapshot. */
export function decreeLineUp(detail: CommitteeDetail) {
  if (detail.decreeSnapshot) return detail.decreeSnapshot.members;
  return detail.members.filter((member) => member.leftOn === null)
    .map((member) => ({ fullName: member.fullName, unitName: member.unitName, role: member.role, section: member.section }));
}
