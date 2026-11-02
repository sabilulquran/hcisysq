// CAL-001 Package 1 rules: meeting times, availability (time blocking), visibility, state
// transitions, reminder timing and WhatsApp text. No database, no HTTP.
// Spec: docs/domain/meeting-calendar.md.

export const MEETING_STATUSES = ["ACTIVE", "CANCELLED"] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];
export type ParticipantRole = "ORGANIZER" | "ATTENDEE";
export type ParticipantResponse = "PENDING" | "ACCEPTED" | "DECLINED";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Asia/Jakarta has no daylight saving time: WIB is always UTC+7. */
const WIB_OFFSET_MS = 7 * 60 * MINUTE_MS;

/** K-09 DRAFT. */
export const MIN_MEETING_MS = 15 * MINUTE_MS;
export const MAX_MEETING_MS = 7 * DAY_MS;
export const MAX_PARTICIPANTS = 200;
/** A form opened a moment ago may still say "now"; one minute of grace (K-09 DRAFT). */
export const START_GRACE_MS = MINUTE_MS;
/** K-15 DRAFT: one reminder, 30 minutes before the start. */
export const REMINDER_LEAD_MS = 30 * MINUTE_MS;
export const REMINDER_RULE_KEY = "meeting.upcoming";
/** §11: calendar range and density limits (ENG-LIST-001 exception recorded in the spec). */
export const CALENDAR_MAX_DAYS = 42;
export const CALENDAR_MAX_ITEMS = 500;

export type MeetingPolicyCode =
  | "INVALID_MEETING"
  | "MEETING_START_IN_PAST"
  | "MEETING_ALREADY_STARTED"
  | "MEETING_ALREADY_ENDED"
  | "MEETING_CANCELLED"
  | "MEETING_NOT_ORGANIZER"
  | "MEETING_RESPONSE_NOT_ALLOWED";

export class MeetingPolicyError extends Error {
  constructor(readonly code: MeetingPolicyCode, message: string) {
    super(message);
    this.name = "MeetingPolicyError";
  }

  get statusCode(): number {
    if (this.code === "INVALID_MEETING") return 400;
    if (this.code === "MEETING_NOT_ORGANIZER") return 403;
    return 409;
  }
}

// ------------------------------------------------------------------ time

export interface Interval {
  startMs: number;
  endMs: number;
}

/** Half-open intervals: touching (`a.end === b.start`) is not an overlap (§6, CAL-001-C). */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

/** `YYYY-MM-DD` in Asia/Jakarta for an instant. */
export function jakartaDateOf(ms: number): string {
  return new Date(ms + WIB_OFFSET_MS).toISOString().slice(0, 10);
}

/** A whole WIB date as `[date 00:00 WIB, date+1 00:00 WIB)`. */
export function jakartaDayInterval(date: string): Interval {
  const startMs = Date.parse(`${date}T00:00:00.000Z`) - WIB_OFFSET_MS;
  return { startMs, endMs: startMs + DAY_MS };
}

/** Inclusive date range `[startOn, endOn]` as one interval. */
export function jakartaDateRangeInterval(startOn: string, endOn: string): Interval {
  return { startMs: jakartaDayInterval(startOn).startMs, endMs: jakartaDayInterval(endOn).endMs };
}

/** The first and last WIB dates an interval touches (the end is exclusive). */
export function jakartaDatesCovering(interval: Interval): { firstDate: string; lastDate: string } {
  return { firstDate: jakartaDateOf(interval.startMs), lastDate: jakartaDateOf(interval.endMs - 1) };
}

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function inclusiveDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** K-09: duration and start. `requireFutureStart` is false when an edit keeps the time. */
export function validateMeetingTimes(input: { startMs: number; endMs: number; nowMs: number; requireFutureStart?: boolean }) {
  const { startMs, endMs, nowMs } = input;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new MeetingPolicyError("INVALID_MEETING", "Waktu selesai harus sesudah waktu mulai.");
  }
  if (endMs - startMs < MIN_MEETING_MS) {
    throw new MeetingPolicyError("INVALID_MEETING", "Rapat paling singkat 15 menit.");
  }
  if (endMs - startMs > MAX_MEETING_MS) {
    throw new MeetingPolicyError("INVALID_MEETING", "Rapat paling lama 7 hari.");
  }
  if ((input.requireFutureStart ?? true) && startMs < nowMs - START_GRACE_MS) {
    throw new MeetingPolicyError("MEETING_START_IN_PAST", "Waktu mulai rapat sudah lewat.");
  }
}

/** Unique attendees, never the organizer, 1 to 200 (K-09). */
export function normalizeParticipants(organizerEmployeeId: string, ids: readonly string[]): string[] {
  const unique = [...new Set(ids)];
  if (unique.includes(organizerEmployeeId)) {
    throw new MeetingPolicyError("INVALID_MEETING", "Penyelenggara sudah otomatis ikut; jangan pilih diri sendiri sebagai peserta.");
  }
  if (unique.length < 1 || unique.length > MAX_PARTICIPANTS) {
    throw new MeetingPolicyError("INVALID_MEETING", `Pilih 1 sampai ${MAX_PARTICIPANTS} peserta.`);
  }
  return unique;
}

// ------------------------------------------------------------ availability

export type BlockReason = "MEETING_OVERLAP" | "ON_LEAVE" | "ON_TRIP";
export type WarningReason = "LEAVE_PENDING" | "TRIP_PENDING" | "NON_WORKING_DAY";

export interface BusyMeeting {
  employeeId: string;
  meetingId: string;
  /** Null when the meeting is confidential and the person asking is not in it (§6, K-05). */
  title: string | null;
  startMs: number;
  endMs: number;
}

export interface BusyDates {
  employeeId: string;
  status: string;
  startOn: string;
  endOn: string;
}

export interface AvailabilityInput {
  interval: Interval;
  people: ReadonlyArray<{ employeeId: string; name: string }>;
  meetings: readonly BusyMeeting[];
  leaves: readonly BusyDates[];
  trips: readonly BusyDates[];
  /** WIB dates inside the interval that are not working days (leave_calendar_*). */
  nonWorkingDates: readonly string[];
}

export interface AvailabilityIssue {
  employeeId: string | null;
  name: string | null;
  reason: BlockReason | WarningReason;
  startAt?: string;
  endAt?: string;
  startOn?: string;
  endOn?: string;
  meetingTitle?: string | null;
}

export interface Availability {
  conflicts: AvailabilityIssue[];
  warnings: AvailabilityIssue[];
}

export const BLOCKING_LEAVE_STATUSES = ["approved"] as const;
export const WARNING_LEAVE_STATUSES = ["in_review"] as const;
export const BLOCKING_TRIP_STATUSES = ["APPROVED", "ISSUED"] as const;
export const WARNING_TRIP_STATUSES = ["IN_REVIEW"] as const;

/**
 * §6: a person is blocked by another active meeting they still attend, by approved leave and
 * by an approved or issued business trip; pending leave or trips and non-working days only
 * warn. Leave type, leave reason and trip destination never leave this function.
 */
export function evaluateAvailability(input: AvailabilityInput): Availability {
  const conflicts: AvailabilityIssue[] = [];
  const warnings: AvailabilityIssue[] = [];
  const names = new Map(input.people.map((person) => [person.employeeId, person.name]));
  const iso = (ms: number) => new Date(ms).toISOString();

  for (const meeting of input.meetings) {
    if (!names.has(meeting.employeeId) || !overlaps(input.interval, meeting)) continue;
    // A confidential meeting the asker is not in: neither its title nor its exact hours, so
    // probing slots cannot map out who attends it (I-12).
    conflicts.push({
      employeeId: meeting.employeeId,
      name: names.get(meeting.employeeId)!,
      reason: "MEETING_OVERLAP",
      ...(meeting.title === null ? {} : { startAt: iso(meeting.startMs), endAt: iso(meeting.endMs) }),
      meetingTitle: meeting.title,
    });
  }

  const dated = (rows: readonly BusyDates[], blocking: readonly string[], warning: readonly string[],
    blockReason: BlockReason, warnReason: WarningReason) => {
    for (const row of rows) {
      if (!names.has(row.employeeId)) continue;
      if (!overlaps(input.interval, jakartaDateRangeInterval(row.startOn, row.endOn))) continue;
      const issue = { employeeId: row.employeeId, name: names.get(row.employeeId)!, startOn: row.startOn, endOn: row.endOn };
      if (blocking.includes(row.status)) conflicts.push({ ...issue, reason: blockReason });
      else if (warning.includes(row.status)) warnings.push({ ...issue, reason: warnReason });
    }
  };
  dated(input.leaves, BLOCKING_LEAVE_STATUSES, WARNING_LEAVE_STATUSES, "ON_LEAVE", "LEAVE_PENDING");
  dated(input.trips, BLOCKING_TRIP_STATUSES, WARNING_TRIP_STATUSES, "ON_TRIP", "TRIP_PENDING");

  // K-10 DRAFT: one warning per non-working date, for the meeting rather than per person.
  for (const date of input.nonWorkingDates) {
    if (!overlaps(input.interval, jakartaDayInterval(date))) continue;
    warnings.push({ employeeId: null, name: null, reason: "NON_WORKING_DAY", startOn: date, endOn: date });
  }

  const order = (issue: AvailabilityIssue) => `${issue.name ?? ""}\u0000${issue.startAt ?? issue.startOn ?? ""}`;
  conflicts.sort((a, b) => order(a).localeCompare(order(b)));
  warnings.sort((a, b) => order(a).localeCompare(order(b)));
  return { conflicts, warnings };
}

/** The Indonesian sentence the organizer reads for one conflict (legacy wording, §2). */
export function describeIssue(issue: AvailabilityIssue): string {
  const who = issue.name ?? "Rapat";
  if (issue.reason === "MEETING_OVERLAP" && !issue.startAt) return `${who} sudah ada rapat lain pada waktu itu.`;
  const range = issue.startAt && issue.endAt
    ? `${formatWibTime(Date.parse(issue.startAt))}-${formatWibTime(Date.parse(issue.endAt))}`
    : issue.startOn === issue.endOn ? formatWibDate(issue.startOn!) : `${formatWibDate(issue.startOn!)} – ${formatWibDate(issue.endOn!)}`;
  switch (issue.reason) {
    case "MEETING_OVERLAP":
      return issue.meetingTitle
        ? `${who} bentrok dengan "${issue.meetingTitle}" (${range}).`
        : `${who} sudah ada rapat lain (${range}).`;
    case "ON_LEAVE": return `${who} sedang cuti (${range}).`;
    case "ON_TRIP": return `${who} sedang perjalanan dinas (${range}).`;
    case "LEAVE_PENDING": return `${who} punya pengajuan cuti yang belum diputus (${range}).`;
    case "TRIP_PENDING": return `${who} punya pengajuan perjalanan dinas yang belum diputus (${range}).`;
    case "NON_WORKING_DAY": return `${range} adalah hari libur/non-kerja.`;
  }
}

/**
 * Who must be checked: a new meeting or a new time checks everybody (all responses reset to
 * PENDING, K-11); otherwise only people who are new to the meeting, so editing the title of
 * a meeting whose participant later took approved leave (K-08) is not refused. DRAFT.
 */
export function peopleToCheck(input: {
  organizerEmployeeId: string;
  participantEmployeeIds: readonly string[];
  existing: { participantEmployeeIds: readonly string[]; timeChanged: boolean } | null;
}): string[] {
  const everyone = [input.organizerEmployeeId, ...input.participantEmployeeIds];
  if (!input.existing || input.existing.timeChanged) return everyone;
  const before = new Set(input.existing.participantEmployeeIds);
  return input.participantEmployeeIds.filter((id) => !before.has(id));
}

// --------------------------------------------------------- state transitions

export interface MeetingState {
  status: MeetingStatus;
  startMs: number;
  endMs: number;
  organizerEmployeeId: string;
}

/** K-11: organizer only, active, before the start. */
export function assertEditable(meeting: MeetingState, actorEmployeeId: string, nowMs: number) {
  if (meeting.organizerEmployeeId !== actorEmployeeId) {
    throw new MeetingPolicyError("MEETING_NOT_ORGANIZER", "Hanya penyelenggara yang dapat mengubah rapat ini.");
  }
  if (meeting.status === "CANCELLED") throw new MeetingPolicyError("MEETING_CANCELLED", "Rapat ini sudah dibatalkan.");
  if (nowMs >= meeting.startMs) throw new MeetingPolicyError("MEETING_ALREADY_STARTED", "Rapat yang sudah dimulai tidak dapat diubah.");
}

/** K-12: organizer only, active, before the end. */
export function assertCancellable(meeting: MeetingState, actorEmployeeId: string, nowMs: number) {
  if (meeting.organizerEmployeeId !== actorEmployeeId) {
    throw new MeetingPolicyError("MEETING_NOT_ORGANIZER", "Hanya penyelenggara yang dapat membatalkan rapat ini.");
  }
  if (meeting.status === "CANCELLED") throw new MeetingPolicyError("MEETING_CANCELLED", "Rapat ini sudah dibatalkan.");
  if (nowMs >= meeting.endMs) throw new MeetingPolicyError("MEETING_ALREADY_ENDED", "Rapat yang sudah selesai tidak dapat dibatalkan.");
}

/** §7.3: attendees answer until the start; the organizer is always ACCEPTED. */
export function assertRespondable(meeting: MeetingState, role: ParticipantRole, nowMs: number) {
  if (role === "ORGANIZER") {
    throw new MeetingPolicyError("MEETING_RESPONSE_NOT_ALLOWED", "Penyelenggara tidak perlu menjawab undangannya sendiri.");
  }
  if (meeting.status === "CANCELLED") throw new MeetingPolicyError("MEETING_CANCELLED", "Rapat ini sudah dibatalkan.");
  if (nowMs >= meeting.startMs) throw new MeetingPolicyError("MEETING_ALREADY_STARTED", "Jawaban tidak dapat diubah setelah rapat dimulai.");
}

export function blocksTime(status: MeetingStatus, response: ParticipantResponse): boolean {
  return status === "ACTIVE" && response !== "DECLINED";
}

/** What the screen may offer; the routes enforce the same rules again. */
export function allowedActions(meeting: MeetingState, viewer: { employeeId: string; role: ParticipantRole }, nowMs: number) {
  const organizer = viewer.role === "ORGANIZER";
  const active = meeting.status === "ACTIVE";
  return {
    canEdit: organizer && active && nowMs < meeting.startMs,
    canCancel: organizer && active && nowMs < meeting.endMs,
    canRespond: !organizer && active && nowMs < meeting.startMs,
  };
}

/** §9.3: null when the meeting starts in less than 30 minutes. */
export function reminderFireAt(startMs: number, nowMs: number): number | null {
  const fireAt = startMs - REMINDER_LEAD_MS;
  return fireAt > nowMs ? fireAt : null;
}

// --------------------------------------------------------------- visibility

export interface CalendarMeetingRow {
  id: string;
  title: string;
  location: string | null;
  organizerName: string;
  startAt: string;
  endAt: string;
  status: MeetingStatus;
  confidential: boolean;
  involvesMe: boolean;
  myRole: ParticipantRole | null;
  myResponse: ParticipantResponse | null;
}

export type CalendarMeetingItem =
  | { kind: "busy"; id: null; startAt: string; endAt: string; involvesMe: false }
  | {
      kind: "meeting";
      id: string | null;
      title: string;
      location: string | null;
      organizerName: string;
      startAt: string;
      endAt: string;
      status: MeetingStatus;
      confidential: boolean;
      involvesMe: boolean;
      myRole: ParticipantRole | null;
      myResponse: ParticipantResponse | null;
    };

/**
 * K-05: every active meeting is visible to every employee. A non-participant sees title,
 * time, location and organizer — or only "Sibuk" when the meeting is confidential — and
 * never an id to open (the detail answers 404 to them anyway). Cancelled meetings are
 * shown to their own participants only.
 */
export function projectCalendarMeeting(row: CalendarMeetingRow): CalendarMeetingItem | null {
  if (!row.involvesMe) {
    if (row.status !== "ACTIVE") return null;
    if (row.confidential) return { kind: "busy", id: null, startAt: row.startAt, endAt: row.endAt, involvesMe: false };
    return {
      kind: "meeting", id: null, title: row.title, location: row.location, organizerName: row.organizerName,
      startAt: row.startAt, endAt: row.endAt, status: row.status, confidential: false,
      involvesMe: false, myRole: null, myResponse: null,
    };
  }
  return { kind: "meeting", ...row };
}

// ------------------------------------------------------------------ WhatsApp

export type DeliveryEvent = "invited" | "rescheduled" | "removed" | "cancelled" | "reminder";

/** §9.2: `cal:<meetingId>:<employeeId>:<event>:<version>`. */
export function deliveryKey(meetingId: string, employeeId: string, event: DeliveryEvent, version: number): string {
  return `cal:${meetingId}:${employeeId}:${event}:${version}`;
}

/** Kirim SQ consumer retry: after 1, 5 and 30 minutes, then give up (four attempts). */
export function retryDelayMs(attemptsSoFar: number): number | null {
  const delays = [1, 5, 30];
  const delay = delays[attemptsSoFar - 1];
  return delay === undefined ? null : delay * MINUTE_MS;
}

const WIB_DATE = new Intl.DateTimeFormat("id-ID", {
  weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Jakarta",
});
const WIB_SHORT_DATE = new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Jakarta" });
const WIB_TIME = new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Jakarta" });

export function formatWibTime(ms: number): string {
  return WIB_TIME.format(new Date(ms)).replace(".", ":");
}

export function formatWibDate(date: string): string {
  return WIB_SHORT_DATE.format(new Date(jakartaDayInterval(date).startMs));
}

/** "Senin, 3 November 2026, 09:00–10:00 WIB" (or two dates for a multi-day meeting). */
export function formatWibRange(startMs: number, endMs: number): string {
  const sameDay = jakartaDateOf(startMs) === jakartaDateOf(endMs - 1);
  return sameDay
    ? `${WIB_DATE.format(new Date(startMs))}, ${formatWibTime(startMs)}–${formatWibTime(endMs)} WIB`
    : `${WIB_DATE.format(new Date(startMs))} ${formatWibTime(startMs)} – ${WIB_DATE.format(new Date(endMs))} ${formatWibTime(endMs)} WIB`;
}

export interface MessageFacts {
  title: string;
  startMs: number;
  endMs: number;
  location: string | null;
  organizerName: string;
  link: string | null;
}

const MESSAGE_HEADINGS: Record<DeliveryEvent, string> = {
  invited: "Undangan rapat",
  rescheduled: "Jadwal rapat berubah",
  removed: "Anda tidak lagi diundang ke rapat",
  cancelled: "Rapat dibatalkan",
  reminder: "Pengingat: rapat mulai 30 menit lagi",
};

/**
 * §9.2: title, day and time in WIB, location, organizer and a link. Never the description,
 * the participant list or anything about another employee.
 */
export function whatsappText(event: DeliveryEvent, facts: MessageFacts): string {
  const lines = [
    `*${MESSAGE_HEADINGS[event]}*`,
    facts.title,
    formatWibRange(facts.startMs, facts.endMs),
    facts.location ? `Lokasi: ${facts.location}` : null,
    `Penyelenggara: ${facts.organizerName}`,
    event === "removed" || event === "cancelled" || !facts.link ? null : `Detail dan konfirmasi hadir: ${facts.link}`,
    "— HCIS Yayasan Sabilul Qur'an",
  ];
  return lines.filter((line): line is string => line !== null).join("\n");
}
