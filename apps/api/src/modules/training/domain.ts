// TRAIN-001 Package 1 rules: categories, session times, time blocking, completion and hours,
// certificate files. No database, no HTTP. Spec: docs/domain/training.md.

export const TRAINING_CATEGORIES = [
  "QURANIC", "PEDAGOGY", "CAREGIVING", "SOP_ADMIN", "ORIENTATION", "COACHING", "OTHER",
] as const;
export type TrainingCategory = (typeof TRAINING_CATEGORIES)[number];

export const PROGRAM_STATUSES = ["ACTIVE", "COMPLETED", "CANCELLED"] as const;
export type ProgramStatus = (typeof PROGRAM_STATUSES)[number];
export const PARTICIPANT_STATUSES = ["ENROLLED", "WITHDRAWN", "COMPLETED", "INCOMPLETE"] as const;
export type ParticipantStatus = (typeof PARTICIPANT_STATUSES)[number];
export const ATTENDANCE_STATUSES = ["PRESENT", "ABSENT", "EXCUSED"] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];
export const RECORD_STATUSES = ["SUBMITTED", "VERIFIED", "REJECTED", "WITHDRAWN"] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 86_400_000;
/** Asia/Jakarta has no daylight saving time: WIB is always UTC+7. */
const WIB_OFFSET_MS = 7 * HOUR_MS;

/** D-17 DRAFT. */
export const MIN_SESSION_MS = 15 * MINUTE_MS;
export const MAX_SESSION_MS = 12 * HOUR_MS;
export const MAX_SESSIONS_PER_PROGRAM = 50;
/** D-03 DRAFT. */
export const MAX_ENROLL_BATCH = 100;
/** D-07 DRAFT: hours declared on an external record. */
export const MIN_EXTERNAL_HOURS = 0.5;
export const MAX_EXTERNAL_HOURS = 200;
export const MAX_EXTERNAL_RANGE_DAYS = 366;
export const DEFAULT_ORGANIZER = "Yayasan Sabilul Qur'an";

export type TrainingPolicyCode =
  | "INVALID_TRAINING_SESSION"
  | "INVALID_TRAINING_RECORD"
  | "TRAINING_RECORD_FUTURE";

export class TrainingPolicyError extends Error {
  constructor(readonly code: TrainingPolicyCode, message: string) {
    super(message);
    this.name = "TrainingPolicyError";
  }

  get statusCode(): number {
    return this.code === "TRAINING_RECORD_FUTURE" ? 409 : 400;
  }
}

// ------------------------------------------------------------------ time

export interface Interval {
  startMs: number;
  endMs: number;
}

/** Half-open intervals: touching (`a.end === b.start`) is not an overlap (§7.1). */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** `YYYY-MM-DD` in Asia/Jakarta for an instant. */
export function jakartaDateOf(ms: number): string {
  return new Date(ms + WIB_OFFSET_MS).toISOString().slice(0, 10);
}

/** Inclusive WIB dates `[startOn, endOn]` as `[startOn 00:00 WIB, endOn+1 00:00 WIB)`. */
export function jakartaDateRangeInterval(startOn: string, endOn: string): Interval {
  const startMs = Date.parse(`${startOn}T00:00:00.000Z`) - WIB_OFFSET_MS;
  const endMs = Date.parse(`${endOn}T00:00:00.000Z`) - WIB_OFFSET_MS + DAY_MS;
  return { startMs, endMs };
}

/** D-17: one session lasts 15 minutes to 12 hours. */
export function validateSessionTimes(startAt: string, endAt: string): Interval {
  const startMs = Date.parse(startAt);
  const endMs = Date.parse(endAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new TrainingPolicyError("INVALID_TRAINING_SESSION", "Waktu selesai sesi harus sesudah waktu mulai.");
  }
  if (endMs - startMs < MIN_SESSION_MS) {
    throw new TrainingPolicyError("INVALID_TRAINING_SESSION", "Sesi paling singkat 15 menit.");
  }
  if (endMs - startMs > MAX_SESSION_MS) {
    throw new TrainingPolicyError("INVALID_TRAINING_SESSION", "Sesi paling lama 12 jam.");
  }
  return { startMs, endMs };
}

/** §6.6 / D-09: an external record ended today or earlier, spans at most a year. */
export function validateExternalRecord(input: { startOn: string; endOn: string; hours: number; today: string }) {
  if (!isCalendarDate(input.startOn) || !isCalendarDate(input.endOn) || input.endOn < input.startOn) {
    throw new TrainingPolicyError("INVALID_TRAINING_RECORD", "Tanggal pelatihan tidak valid.");
  }
  const days = (Date.parse(`${input.endOn}T00:00:00Z`) - Date.parse(`${input.startOn}T00:00:00Z`)) / DAY_MS + 1;
  if (days > MAX_EXTERNAL_RANGE_DAYS) {
    throw new TrainingPolicyError("INVALID_TRAINING_RECORD", "Rentang pelatihan paling lama satu tahun.");
  }
  if (input.endOn > input.today) {
    throw new TrainingPolicyError("TRAINING_RECORD_FUTURE", "Pelatihan eksternal dicatat setelah selesai.");
  }
  if (!(input.hours >= MIN_EXTERNAL_HOURS && input.hours <= MAX_EXTERNAL_HOURS) || !Number.isInteger(input.hours * 4)) {
    throw new TrainingPolicyError("INVALID_TRAINING_RECORD", "Jam pelatihan 0,5 sampai 200, kelipatan 0,25.");
  }
}

/** D-07: hours with two decimals, from milliseconds. */
export function hoursOf(ms: number): number {
  return Math.round((ms / HOUR_MS) * 100) / 100;
}

// ------------------------------------------------------------ availability

export type BlockReason = "IN_TRAINING" | "MEETING_OVERLAP" | "ON_LEAVE" | "ON_TRIP";
export type WarningReason = "LEAVE_PENDING" | "TRIP_PENDING";
export type ConflictReason = BlockReason | WarningReason;

/** One source of busy time for one person, already reduced to an interval. */
export interface BusySpan {
  employeeId: string;
  reason: ConflictReason;
  startMs: number;
  endMs: number;
  /** Shown only for other training sessions and non-confidential meetings (§7.1). */
  title: string | null;
  /** Set for training sessions, so a session never conflicts with itself. */
  sessionId?: string;
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

const BLOCKING: ReadonlySet<ConflictReason> = new Set<ConflictReason>(["IN_TRAINING", "MEETING_OVERLAP", "ON_LEAVE", "ON_TRIP"]);

/**
 * §7.1. Every busy span that overlaps one of the sessions becomes a conflict for that person.
 * A blocking reason stays a block only when the session has not ended yet (D-04): a session
 * recorded after the fact never blocks, its overlaps are warnings.
 */
export function evaluateAvailability(input: {
  sessions: ReadonlyArray<Interval & { id: string | null; title: string }>;
  people: ReadonlyArray<{ employeeId: string; name: string }>;
  busy: readonly BusySpan[];
  nowMs: number;
}): { blocks: Conflict[]; warnings: Conflict[] } {
  const names = new Map(input.people.map((person) => [person.employeeId, person.name]));
  const blocks: Conflict[] = [];
  const warnings: Conflict[] = [];
  for (const session of input.sessions) {
    const past = session.endMs <= input.nowMs;
    for (const span of input.busy) {
      const name = names.get(span.employeeId);
      if (name === undefined || !overlaps(session, span)) continue;
      if (span.sessionId !== undefined && span.sessionId === session.id) continue;
      const conflict: Conflict = {
        employeeId: span.employeeId,
        name,
        reason: span.reason,
        sessionTitle: session.title,
        startAt: new Date(span.startMs).toISOString(),
        endAt: new Date(span.endMs).toISOString(),
        title: span.title,
      };
      (BLOCKING.has(span.reason) && !past ? blocks : warnings).push(conflict);
    }
  }
  const order = (a: Conflict, b: Conflict) =>
    a.name.localeCompare(b.name, "id") || a.startAt.localeCompare(b.startAt) || a.reason.localeCompare(b.reason);
  return { blocks: blocks.sort(order), warnings: warnings.sort(order) };
}

// ----------------------------------------------------------- completion

export interface SessionForCompletion {
  id: string;
  startMs: number;
  endMs: number;
  speakerEmployeeId: string | null;
}

/**
 * §6.5, D-06, D-07, D-08: attended hours per participant, whether the attendance threshold was
 * met, and the hours each internal speaker led. Cancelled sessions are not passed in.
 */
export function computeCompletion(input: {
  sessions: readonly SessionForCompletion[];
  participants: readonly string[];
  attendance: ReadonlyArray<{ sessionId: string; employeeId: string; status: AttendanceStatus }>;
  minAttendancePercent: number;
}) {
  const duration = new Map(input.sessions.map((session) => [session.id, session.endMs - session.startMs]));
  const totalMs = [...duration.values()].reduce((sum, ms) => sum + ms, 0);
  const attendedMs = new Map<string, number>(input.participants.map((id) => [id, 0]));
  for (const mark of input.attendance) {
    const ms = duration.get(mark.sessionId);
    if (mark.status !== "PRESENT" || ms === undefined || !attendedMs.has(mark.employeeId)) continue;
    attendedMs.set(mark.employeeId, attendedMs.get(mark.employeeId)! + ms);
  }
  const participants = input.participants.map((employeeId) => {
    const ms = attendedMs.get(employeeId)!;
    // Integer arithmetic on milliseconds, so 80% of 10 hours is exactly 8 hours.
    const completed = totalMs > 0 && ms * 100 >= totalMs * input.minAttendancePercent;
    return { employeeId, attendedHours: hoursOf(ms), attendedAny: ms > 0, completed };
  });
  const speakerMs = new Map<string, number>();
  for (const session of input.sessions) {
    if (!session.speakerEmployeeId) continue;
    speakerMs.set(session.speakerEmployeeId, (speakerMs.get(session.speakerEmployeeId) ?? 0) + session.endMs - session.startMs);
  }
  const speakers = [...speakerMs.entries()].map(([employeeId, ms]) => ({ employeeId, hours: hoursOf(ms) }));
  const startMs = Math.min(...input.sessions.map((session) => session.startMs));
  const endMs = Math.max(...input.sessions.map((session) => session.endMs));
  return {
    totalHours: hoursOf(totalMs),
    participants,
    speakers,
    startOn: jakartaDateOf(startMs),
    endOn: jakartaDateOf(endMs - 1),
  };
}

// ----------------------------------------------------------- certificates

export const CERTIFICATE_CONTENT_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
export type CertificateContentType = (typeof CERTIFICATE_CONTENT_TYPES)[number];
export const MAX_CERTIFICATE_BYTES = 2_097_152;

export class CertificateError extends Error {
  constructor(readonly statusCode: 400 | 413, readonly code: "CERTIFICATE_TYPE_MISMATCH" | "CERTIFICATE_TOO_LARGE", message: string) {
    super(message);
    this.name = "CertificateError";
  }
}

/** D-10: the same size and file-signature check as leave supporting documents (0007). */
export function decodeCertificate(contentType: CertificateContentType, contentBase64: string): Buffer {
  const bytes = Buffer.from(contentBase64, "base64");
  if (bytes.length === 0 || bytes.length > MAX_CERTIFICATE_BYTES) {
    throw new CertificateError(413, "CERTIFICATE_TOO_LARGE", "Sertifikat maksimal 2 MB.");
  }
  const signatureOk =
    (contentType === "application/pdf" && bytes.subarray(0, 5).toString("ascii") === "%PDF-")
    || (contentType === "image/jpeg" && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    || (contentType === "image/png" && bytes.length >= 8
      && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  if (!signatureOk) {
    throw new CertificateError(400, "CERTIFICATE_TYPE_MISMATCH", "Tipe berkas tidak sesuai dengan isi sertifikat.");
  }
  return bytes;
}
