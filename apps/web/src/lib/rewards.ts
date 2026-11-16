// REWARD-001 client. The API authorizes every call and owns every rule: candidates come only from
// the Al-Qur'an monthly scoreboard snapshot, and nothing here chooses or ranks anyone.
// Spec: docs/domain/rewards.md.

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

export type SourceStatus = "NOT_CONFIGURED" | "UNAVAILABLE" | "NOT_FINAL" | "AVAILABLE";
export type RoundStatus = "PENDING_DECISION" | "PUBLISHED" | "CANCELLED";
export type CandidateStatus = "CANDIDATE" | "AWARDED" | "DECLINED" | "UNRESOLVED";
export type RewardCategory = "FOUNDATION" | "UNIT";
export type SourceKind = "QURAN_API" | "MANUAL_IMPORT";

export interface SourceState {
  status: SourceStatus;
  latestFinalMonth: string;
  manualImportOpen: boolean;
  fetch: { month: string; attempts: number; lastAttemptAt: string | null; lastOutcome: string | null; exhaustedAt: string | null } | null;
}

export interface RoundSummary {
  id: string;
  month: string;
  status: RoundStatus;
  sourceKind: SourceKind;
  directoryStale: boolean;
  createdAt: string;
  publishedAt: string | null;
  candidateCount: number;
  awardedCount: number;
}

export interface Candidate {
  id: string;
  category: RewardCategory;
  unitRef: string;
  unitName: string | null;
  seat: number;
  rank: number;
  pages: number;
  activeDays: number;
  khatam: number;
  labels: Array<"AUTO" | "SELF_REPORTED">;
  personRef: string;
  employeeId: string | null;
  employeeName: string | null;
  employeeNumber: string | null;
  employeeUnitName: string | null;
  status: CandidateStatus;
  unresolvedReason: "UNKNOWN_PERSON" | "INACTIVE_EMPLOYEE" | null;
  declineReason: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
  replacesCandidateId: string | null;
  replaced: boolean;
}

export interface Award {
  id: string;
  candidateId: string;
  employeeId: string;
  category: RewardCategory;
  categoryLabel: string;
  recipientName: string;
  status: "ACTIVE" | "REVOKED";
  revokeReason: string | null;
  revokedAt: string | null;
  certificateReady: boolean;
  awardedAt: string;
}

export interface OutboxItem {
  id: string;
  awardId: string | null;
  effect: "NOTIFICATION" | "ANNOUNCEMENT" | "CERTIFICATE";
  status: "PENDING" | "DONE" | "FAILED";
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string;
  doneAt: string | null;
}

export interface RoundDetail {
  id: string;
  month: string;
  status: RoundStatus;
  sourceKind: SourceKind;
  snapshotVersion: string;
  snapshotFinalizedAt: string | null;
  directoryVersion: string | null;
  directoryAsOf: string | null;
  directoryStale: boolean;
  fetchedAt: string;
  createdAt: string;
  cancelReason: string | null;
  publishedAt: string | null;
  publishedByName: string | null;
  announcementId: string | null;
  importNote: string | null;
  importRowCount: number | null;
  importedByName: string | null;
  snapshotRowCount: number;
  candidates: Candidate[];
  awards: Award[];
  outbox: OutboxItem[];
  viewer: { canManage: boolean; decidableCandidateIds: string[]; isImporter: boolean };
}

export interface AuditEvent {
  id: string;
  eventType: string;
  reason: string | null;
  occurredAt: string;
  actorName: string;
}

export interface Recipient {
  id: string;
  month: string;
  monthLabel: string;
  category: RewardCategory;
  categoryLabel: string;
  recipientName: string;
  unitName: string | null;
}

export interface MyAward {
  id: string;
  month: string;
  monthLabel: string;
  category: RewardCategory;
  categoryLabel: string;
  status: "ACTIVE" | "REVOKED";
  revokeReason: string | null;
  certificateReady: boolean;
}

export interface CertificateCheck {
  status: "VALID" | "REVOKED";
  recipientName: string;
  categoryLabel: string;
  month: string;
  monthLabel: string;
}

export class RewardApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly problems: Array<{ line: number; message: string }> = [],
  ) {
    super(message);
    this.name = "RewardApiError";
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as T | { code?: string; message?: string; problems?: [] } | null;
  if (!response.ok) {
    const problem = body as { code?: string; message?: string; problems?: Array<{ line: number; message: string }> } | null;
    throw new RewardApiError(
      response.status, problem?.code ?? "REWARD_FAILED", problem?.message ?? "Penghargaan tidak dapat diproses.", problem?.problems ?? [],
    );
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

function query(params: Record<string, string | number | undefined | null>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export const getSource = () => get<SourceState>("/admin/rewards/source");
export const getRounds = (params: { page: number; status?: RoundStatus | ""; month?: string }) =>
  get<{ items: RoundSummary[]; pagination: Pagination }>(`/admin/rewards/rounds${query(params)}`);
export const getRound = (id: string) => get<RoundDetail>(`/admin/rewards/rounds/${encodeURIComponent(id)}`);
export const getRoundEvents = (id: string, page: number) =>
  get<{ items: AuditEvent[]; pagination: Pagination }>(`/admin/rewards/rounds/${encodeURIComponent(id)}/events${query({ page, pageSize: 25 })}`);
export const buildRound = (month: string) => post<{ id: string }>("/admin/rewards/rounds", { month });
export const importSnapshot = (month: string, note: string, csv: string) =>
  post<{ id: string; rows: number; candidates: number }>("/admin/rewards/imports", { month, note, csv });
export const awardCandidate = (id: string) => post(`/admin/rewards/candidates/${encodeURIComponent(id)}/award`);
export const declineCandidate = (id: string, reason: string) => post(`/admin/rewards/candidates/${encodeURIComponent(id)}/decline`, { reason });
export const takeNextRank = (id: string) => post<{ candidateIds: string[] }>(`/admin/rewards/candidates/${encodeURIComponent(id)}/next-rank`);
export const publishRound = (id: string) => post<{ awards: number }>(`/admin/rewards/rounds/${encodeURIComponent(id)}/publish`);
export const cancelRound = (id: string, reason: string) => post(`/admin/rewards/rounds/${encodeURIComponent(id)}/cancel`, { reason });
export const revokeAward = (id: string, reason: string) => post(`/admin/rewards/awards/${encodeURIComponent(id)}/revoke`, { reason });
export const retryEffect = (id: string) => post<{ status: string }>(`/admin/rewards/outbox/${encodeURIComponent(id)}/retry`);
export const getRecipients = (params: { page: number; month?: string }) =>
  get<{ items: Recipient[]; pagination: Pagination }>(`/rewards/recipients${query(params)}`);
export const getMyAwards = (page: number) => get<{ items: MyAward[]; pagination: Pagination }>(`/me/rewards${query({ page })}`);
export const certificateHref = (id: string) => `/api/me/rewards/${encodeURIComponent(id)}/certificate`;
export const checkCertificate = (code: string) => get<CertificateCheck>(`/public/rewards/verify/${encodeURIComponent(code)}`);

const MONTH_NAMES = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

export function monthLabel(month: string): string {
  const [year, number] = month.split("-").map(Number);
  return year && number ? `${MONTH_NAMES[number - 1]} ${year}` : month;
}

export const ROUND_STATUS_LABELS: Record<RoundStatus, string> = {
  PENDING_DECISION: "Menunggu keputusan",
  PUBLISHED: "Terbit",
  CANCELLED: "Dibatalkan",
};

export const CANDIDATE_STATUS_LABELS: Record<CandidateStatus, string> = {
  CANDIDATE: "Belum diputuskan",
  AWARDED: "Ditetapkan",
  DECLINED: "Tidak ditetapkan",
  UNRESOLVED: "Tidak bisa ditetapkan",
};

export const EFFECT_LABELS: Record<OutboxItem["effect"], string> = {
  NOTIFICATION: "Notifikasi",
  ANNOUNCEMENT: "Pengumuman",
  CERTIFICATE: "Sertifikat",
};

export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  QURAN_API: "Papan skor Al-Qur'an",
  MANUAL_IMPORT: "Impor manual CSV (sementara)",
};

/** What the screen says about the source; never a guess about candidates. */
export function sourceMessage(status: SourceStatus): { tone: "info" | "warning" | "ok"; title: string; body: string } {
  if (status === "NOT_CONFIGURED") {
    return {
      tone: "info",
      title: "Sumber belum tersedia",
      body: "Papan skor aplikasi Al-Qur'an belum tersambung ke HCIS. Kandidat tidak disusun otomatis; HC dapat mengimpor snapshot bulanan dari CSV sebagai jalur sementara.",
    };
  }
  if (status === "UNAVAILABLE") {
    return { tone: "warning", title: "Papan skor belum bisa diambil", body: "Aplikasi Al-Qur'an sedang tidak dapat dihubungi. Sistem mencoba lagi tiap jam selama 3 hari." };
  }
  if (status === "NOT_FINAL") {
    return { tone: "info", title: "Papan skor bulan lalu belum final", body: "Papan bulanan final pada tanggal 3 pukul 00.00 WIB." };
  }
  return { tone: "ok", title: "Papan skor tersambung", body: "Putaran disusun otomatis tiap tanggal 3 pukul 06.00 WIB." };
}

export function labelText(labels: Candidate["labels"]): string {
  return labels.map((label) => (label === "AUTO" ? "otomatis" : "mandiri")).join(", ");
}

/** Candidates grouped by seat, in the order the API gives them (foundation first). */
export function seatGroups(candidates: Candidate[]): Array<{ key: string; title: string; candidates: Candidate[] }> {
  const groups = new Map<string, { key: string; title: string; candidates: Candidate[] }>();
  for (const candidate of candidates) {
    const key = candidate.category === "FOUNDATION" ? `F:${candidate.seat}` : `U:${candidate.unitRef}`;
    const title = candidate.category === "FOUNDATION"
      ? `Yayasan — Peringkat ${candidate.seat}`
      : `Unit ${candidate.unitName ?? "(nama unit tidak ditemukan)"}`;
    if (!groups.has(key)) groups.set(key, { key, title, candidates: [] });
    groups.get(key)!.candidates.push(candidate);
  }
  return [...groups.values()];
}

/** Publication is the API's decision; this only explains why the button is not offered. */
export function publishBlocker(round: Pick<RoundDetail, "status" | "candidates">): string | null {
  if (round.status !== "PENDING_DECISION") return "Putaran ini sudah tidak menerima keputusan.";
  if (round.candidates.some((candidate) => candidate.status === "CANDIDATE")) return "Masih ada kandidat yang belum diputuskan.";
  if (!round.candidates.some((candidate) => candidate.status === "AWARDED")) return "Belum ada kandidat yang ditetapkan.";
  return null;
}

export function previousMonth(today = new Date()): string {
  const wib = new Date(today.getTime() + 7 * 3_600_000);
  const date = new Date(Date.UTC(wib.getUTCFullYear(), wib.getUTCMonth() - 1, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export const MANUAL_CSV_TEMPLATE = "cakupan,peringkat,nip,halaman,hari_aktif,khatam,label\nYAYASAN,1,NIP-CONTOH,120.5,25,1,otomatis\n";
