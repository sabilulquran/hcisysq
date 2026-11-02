// TRAIN-001 client. The API authorizes every call and owns every rule (time blocking,
// completion, hours); this module only shapes requests and labels states.
// Spec: docs/domain/training.md.

export type TrainingCategory = "QURANIC" | "PEDAGOGY" | "CAREGIVING" | "SOP_ADMIN" | "ORIENTATION" | "COACHING" | "OTHER";
export type ProgramStatus = "ACTIVE" | "COMPLETED" | "CANCELLED";
export type ParticipantStatus = "ENROLLED" | "WITHDRAWN" | "COMPLETED" | "INCOMPLETE";
export type AttendanceStatus = "PRESENT" | "ABSENT" | "EXCUSED";
export type RecordStatus = "SUBMITTED" | "VERIFIED" | "REJECTED" | "WITHDRAWN";
export type ConflictReason = "IN_TRAINING" | "MEETING_OVERLAP" | "ON_LEAVE" | "ON_TRIP" | "LEAVE_PENDING" | "TRIP_PENDING";

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

export interface ProgramSummary {
  id: string;
  title: string;
  category: TrainingCategory;
  description: string | null;
  organizer: string;
  capacity: number | null;
  minAttendancePercent: number;
  status: ProgramStatus;
  cancelReason: string | null;
  createdAt: string;
  closedAt: string | null;
  participantCount: number;
  sessionCount: number;
  firstSessionAt: string | null;
  lastSessionEndAt: string | null;
  participantStatus?: ParticipantStatus;
  attendedHours?: number | null;
  nextSessionAt?: string | null;
}

export interface TrainingSession {
  id: string;
  programId: string;
  title: string;
  startAt: string;
  endAt: string;
  location: string | null;
  speakerEmployeeId: string | null;
  speakerName: string | null;
  status: "SCHEDULED" | "CANCELLED";
  cancelReason: string | null;
  presentCount?: number;
  recordedCount?: number;
  myAttendance?: AttendanceStatus | null;
}

export interface ProgramDetail extends ProgramSummary {
  sessions: TrainingSession[];
  participantsByStatus?: Partial<Record<ParticipantStatus, number>>;
}

export interface Participant {
  employeeId: string;
  fullName: string;
  employeeNumber: string;
  unitName: string | null;
  status: ParticipantStatus;
  withdrawReason: string | null;
  attendedHours: number | null;
  enrolledAt: string;
  presentSessions: number;
}

export interface AttendanceRow {
  employeeId: string;
  fullName: string;
  employeeNumber: string;
  participantStatus: ParticipantStatus;
  status: AttendanceStatus | null;
  note: string | null;
  recordedAt: string | null;
}

export interface Conflict {
  employeeId: string;
  name: string;
  reason: ConflictReason;
  sessionTitle: string;
  startAt: string;
  endAt: string;
  title: string | null;
}

export interface TrainingRecord {
  id: string;
  employeeId: string;
  source: "INTERNAL" | "EXTERNAL";
  role: "PARTICIPANT" | "SPEAKER";
  programId: string | null;
  title: string;
  category: TrainingCategory;
  organizer: string;
  description: string | null;
  startOn: string;
  endOn: string;
  hours: number;
  completed: boolean | null;
  status: RecordStatus;
  rejectReason: string | null;
  decidedAt: string | null;
  createdAt: string;
  certificateId: string | null;
  certificateFileName: string | null;
  employeeName?: string;
  employeeNumber?: string;
}

export interface RecordDetail extends TrainingRecord {
  employeeName: string;
  employeeNumber: string;
  unitName: string | null;
  events: Array<{ id: string; eventType: string; occurredAt: string; note: string | null; actorName: string | null }>;
}

export interface HoursSummary {
  year: number;
  totalHours: number;
  internalHours: number;
  externalHours: number;
  speakerHours: number;
  recordCount: number;
}

export interface HoursRow extends Omit<HoursSummary, "year"> {
  employeeId: string;
  fullName: string;
  employeeNumber: string;
  unitName: string | null;
}

export interface CertificateFile {
  fileName: string;
  contentType: "application/pdf" | "image/jpeg" | "image/png";
  contentBase64: string;
}

export class TrainingApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly conflicts: Conflict[] = []) {
    super(message);
    this.name = "TrainingApiError";
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as T | { code?: string; message?: string; conflicts?: Conflict[] } | null;
  if (!response.ok) {
    const problem = body as { code?: string; message?: string; conflicts?: Conflict[] } | null;
    throw new TrainingApiError(
      response.status, problem?.code ?? "TRAINING_FAILED", problem?.message ?? "Pelatihan tidak dapat diproses.", problem?.conflicts ?? [],
    );
  }
  return body as T;
}

async function get<T>(path: string) {
  return readJson<T>(await fetch(`/api${path}`, { credentials: "include", headers: { Accept: "application/json" } }));
}

async function send<T>(method: "POST" | "PATCH" | "PUT", path: string, payload?: unknown) {
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

export const getMyTrainingSummary = (year?: number) => get<HoursSummary>(`/training/me/summary${query({ year })}`);
export const getMyTrainingRecords = (page = 1) => get<Paged<TrainingRecord>>(`/training/me/records${query({ page })}`);
export const getMyPrograms = (page = 1) => get<Paged<ProgramSummary>>(`/training/me/programs${query({ page })}`);
export const getMyProgram = (id: string) => get<ProgramDetail>(`/training/me/programs/${id}`);
export const submitExternalTraining = (input: {
  title: string; category: TrainingCategory; organizer: string; description: string | null;
  startOn: string; endOn: string; hours: number; certificate: CertificateFile | null; idempotencyKey: string;
}) => send<{ id: string; status: RecordStatus }>("POST", "/training/me/records", input);
export const withdrawMyRecord = (id: string) => send<{ id: string }>("POST", `/training/me/records/${id}/withdraw`);
export const uploadMyCertificate = (id: string, file: CertificateFile) => send("POST", `/training/me/records/${id}/certificate`, file);
export const myCertificateUrl = (id: string) => `/api/training/me/records/${id}/certificate`;

// ---------------------------------------------------------------- HC

export const getPrograms = (filter: { page?: number; status?: ProgramStatus | ""; q?: string }) =>
  get<Paged<ProgramSummary>>(`/admin/training/programs${query({ page: filter.page ?? 1, status: filter.status, q: filter.q })}`);
export const getProgram = (id: string) => get<ProgramDetail>(`/admin/training/programs/${id}`);
export const createProgram = (input: {
  title: string; category: TrainingCategory; organizer: string | null; description: string | null;
  capacity: number | null; minAttendancePercent: number;
}) => send<{ id: string }>("POST", "/admin/training/programs", input);
export const cancelProgram = (id: string, reason: string) => send("POST", `/admin/training/programs/${id}/cancel`, { reason });
export const completeProgram = (id: string) =>
  send<{ totalHours: number; records: number }>("POST", `/admin/training/programs/${id}/complete`);
export const createSession = (programId: string, input: {
  title: string; startAt: string; endAt: string; location: string | null; speakerEmployeeId: string | null; speakerName: string | null;
}) => send<{ id: string; warnings: Conflict[] }>("POST", `/admin/training/programs/${programId}/sessions`, input);
export const cancelSession = (id: string, reason: string) => send("POST", `/admin/training/sessions/${id}/cancel`, { reason });
export const getParticipants = (programId: string, page = 1) =>
  get<Paged<Participant>>(`/admin/training/programs/${programId}/participants${query({ page })}`);
export const enrollParticipants = (programId: string, employeeIds: string[]) =>
  send<{ enrolled: string[]; alreadyEnrolled: string[]; warnings: Conflict[] }>(
    "POST", `/admin/training/programs/${programId}/participants`, { employeeIds },
  );
export const withdrawParticipant = (programId: string, employeeId: string, reason: string) =>
  send("POST", `/admin/training/programs/${programId}/participants/${employeeId}/withdraw`, { reason });
export const getAttendance = (sessionId: string, page = 1) =>
  get<Paged<AttendanceRow> & { session: TrainingSession }>(`/admin/training/sessions/${sessionId}/attendance${query({ page, pageSize: 100 })}`);
export const saveAttendance = (sessionId: string, entries: Array<{ employeeId: string; status: AttendanceStatus }>) =>
  send<{ recorded: number }>("PUT", `/admin/training/sessions/${sessionId}/attendance`, { entries });
export const getRecords = (filter: { page?: number; status?: RecordStatus | ""; source?: "INTERNAL" | "EXTERNAL" | "" }) =>
  get<Paged<TrainingRecord>>(`/admin/training/records${query({ page: filter.page ?? 1, status: filter.status, source: filter.source })}`);
export const getRecord = (id: string) => get<RecordDetail>(`/admin/training/records/${id}`);
export const verifyRecord = (id: string) => send("POST", `/admin/training/records/${id}/verify`);
export const rejectRecord = (id: string, reason: string) => send("POST", `/admin/training/records/${id}/reject`, { reason });
export const uploadCertificate = (id: string, file: CertificateFile) => send("POST", `/admin/training/records/${id}/certificate`, file);
export const adminCertificateUrl = (id: string) => `/api/admin/training/records/${id}/certificate`;
export const getHours = (filter: { page?: number; year: number; q?: string }) =>
  get<Paged<HoursRow> & { year: number }>(`/admin/training/hours${query({ page: filter.page ?? 1, year: filter.year, q: filter.q })}`);
export const searchTrainingEmployees = async (q: string) =>
  (await get<{ items: Array<{ id: string; fullName: string; employeeNumber: string; unitName: string | null }> }>(
    `/admin/training/employee-options${query({ q })}`,
  )).items;

// ---------------------------------------------------------------- labels

export const CATEGORY_LABELS: Record<TrainingCategory, string> = {
  QURANIC: "Keterampilan Qur'ani",
  PEDAGOGY: "Pedagogi guru",
  CAREGIVING: "Pengasuhan",
  SOP_ADMIN: "SOP / administrasi",
  ORIENTATION: "Orientasi pegawai baru",
  COACHING: "Pembinaan rutin",
  OTHER: "Lainnya",
};

export const PROGRAM_STATUS_LABELS: Record<ProgramStatus, string> = {
  ACTIVE: "Berjalan", COMPLETED: "Ditutup", CANCELLED: "Dibatalkan",
};

export const PARTICIPANT_STATUS_LABELS: Record<ParticipantStatus, string> = {
  ENROLLED: "Terdaftar", WITHDRAWN: "Dikeluarkan", COMPLETED: "Menyelesaikan", INCOMPLETE: "Belum memenuhi kehadiran",
};

export const ATTENDANCE_LABELS: Record<AttendanceStatus, string> = { PRESENT: "Hadir", ABSENT: "Tidak hadir", EXCUSED: "Izin" };

export const RECORD_STATUS_LABELS: Record<RecordStatus, string> = {
  SUBMITTED: "Menunggu verifikasi", VERIFIED: "Terverifikasi", REJECTED: "Ditolak", WITHDRAWN: "Ditarik",
};

const CONFLICT_LABELS: Record<ConflictReason, string> = {
  IN_TRAINING: "pelatihan lain",
  MEETING_OVERLAP: "rapat",
  ON_LEAVE: "cuti disetujui",
  ON_TRIP: "perjalanan dinas",
  LEAVE_PENDING: "cuti yang sedang diajukan",
  TRIP_PENDING: "perjalanan dinas yang sedang diajukan",
};

const EVENT_LABELS: Record<string, string> = {
  "training.record.submitted": "Diajukan",
  "training.record.withdrawn": "Ditarik",
  "training.record.verified": "Diverifikasi",
  "training.record.rejected": "Ditolak",
  "training.record.created": "Dicatat dari program",
  "training.certificate.uploaded": "Sertifikat diunggah",
};

export function eventLabel(eventType: string) {
  return EVENT_LABELS[eventType] ?? eventType;
}

const dateTime = new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" });
const time = new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" });
const date = new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Jakarta" });

export function formatInstant(value: string | null | undefined) {
  return value ? dateTime.format(new Date(value)) : "-";
}

export function formatSessionTime(startAt: string, endAt: string) {
  return `${dateTime.format(new Date(startAt))}–${time.format(new Date(endAt))} WIB`;
}

export function formatDateRange(startOn: string, endOn: string) {
  const from = date.format(new Date(`${startOn}T00:00:00+07:00`));
  return startOn === endOn ? from : `${from} – ${date.format(new Date(`${endOn}T00:00:00+07:00`))}`;
}

export function formatHours(hours: number) {
  return `${new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 }).format(hours)} jam`;
}

/** One line per conflict: who, what, when; never a leave type or trip destination (the API never sends them). */
export function describeConflict(conflict: Conflict) {
  const what = conflict.title ? `${CONFLICT_LABELS[conflict.reason]} "${conflict.title}"` : CONFLICT_LABELS[conflict.reason];
  return `${conflict.name} — ${what}, ${formatInstant(conflict.startAt)}`;
}

/** `YYYY-MM-DD` and `HH:MM` entered in WIB, as an ISO instant the API accepts. */
export function wibInstant(day: string, clock: string) {
  return `${day}T${clock}:00+07:00`;
}

export function todayInJakarta() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export const MAX_CERTIFICATE_BYTES = 2_097_152;

/** Reads a picked file into the JSON shape the API takes; the API re-checks size and signature. */
export async function readCertificate(file: File): Promise<CertificateFile> {
  if (!["application/pdf", "image/jpeg", "image/png"].includes(file.type)) {
    throw new Error("Sertifikat harus PDF, JPG, atau PNG.");
  }
  if (file.size > MAX_CERTIFICATE_BYTES) throw new Error("Sertifikat maksimal 2 MB.");
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Berkas tidak dapat dibaca."));
    reader.readAsDataURL(file);
  });
  return {
    fileName: file.name.slice(0, 180),
    contentType: file.type as CertificateFile["contentType"],
    contentBase64: dataUrl.slice(dataUrl.indexOf(",") + 1),
  };
}
