// CAL-001 client. The API owns every rule (time blocking, visibility, who may edit); this module
// only shapes requests, builds the month grid and labels states.
// Spec: docs/domain/meeting-calendar.md.

export type MeetingStatus = "ACTIVE" | "CANCELLED";
export type ParticipantRole = "ORGANIZER" | "ATTENDEE";
export type ParticipantResponse = "PENDING" | "ACCEPTED" | "DECLINED";

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

export type CalendarItem =
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
    }
  | { kind: "busy"; id: null; startAt: string; endAt: string; involvesMe: false }
  | { kind: "leave"; id: string; status: "approved" | "in_review"; startOn: string; endOn: string }
  | { kind: "trip"; id: string; status: "APPROVED" | "ISSUED" | "IN_REVIEW"; destination: string; startOn: string; endOn: string }
  | { kind: "non_working"; date: string; label: string | null };

export interface MeetingSummary {
  id: string;
  title: string;
  location: string | null;
  startAt: string;
  endAt: string;
  status: MeetingStatus;
  confidential: boolean;
  organizerName: string;
  myRole: ParticipantRole;
  myResponse: ParticipantResponse;
  participantCount: number;
}

export interface MeetingParticipant {
  employeeId: string;
  name: string;
  unitName: string | null;
  role: ParticipantRole;
  response: ParticipantResponse;
  responseNote: string | null;
  respondedAt: string | null;
  hasAccount: boolean | null;
  hasWhatsApp: boolean | null;
  unavailableReason: "LEAVE" | "TRIP" | null;
}

export interface MeetingDetail {
  id: string;
  organizerEmployeeId: string;
  organizerName: string;
  title: string;
  description: string | null;
  location: string | null;
  startAt: string;
  endAt: string;
  status: MeetingStatus;
  confidential: boolean;
  notifyWhatsApp: boolean;
  version: number;
  cancelReason: string | null;
  cancelledAt: string | null;
  me: { role: ParticipantRole; response: ParticipantResponse; responseNote: string | null };
  canEdit: boolean;
  canCancel: boolean;
  canRespond: boolean;
  participants: MeetingParticipant[];
  events: Array<{ id: string; eventType: string; occurredAt: string; actorName: string | null }>;
}

export interface ParticipantOption {
  id: string;
  name: string;
  unitName: string | null;
  hasAccount: boolean;
  hasWhatsApp: boolean;
}

export interface AvailabilityIssue {
  employeeId: string | null;
  name: string | null;
  reason: "MEETING_OVERLAP" | "IN_TRAINING" | "ON_LEAVE" | "ON_TRIP" | "LEAVE_PENDING" | "TRIP_PENDING" | "NON_WORKING_DAY" | "ON_FIELD_ASSIGNMENT";
  message: string;
}

export interface Availability {
  conflicts: AvailabilityIssue[];
  warnings: AvailabilityIssue[];
}

export interface MeetingInput {
  title: string;
  description: string | null;
  location: string | null;
  startAt: string;
  endAt: string;
  participantEmployeeIds: string[];
  confidential: boolean;
  notifyWhatsApp: boolean;
}

export interface MeetingWriteResult {
  id: string;
  version: number;
  warnings: AvailabilityIssue[];
  whatsappWithoutNumber: string[];
}

export class MeetingApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly conflicts: AvailabilityIssue[] = [],
  ) {
    super(message);
    this.name = "MeetingApiError";
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as T | { code?: string; message?: string; conflicts?: AvailabilityIssue[] } | null;
  if (!response.ok) {
    const problem = body as { code?: string; message?: string; conflicts?: AvailabilityIssue[] } | null;
    throw new MeetingApiError(
      response.status,
      problem?.code ?? "MEETING_FAILED",
      problem?.message ?? "Permintaan rapat tidak dapat diproses.",
      problem?.conflicts ?? [],
    );
  }
  return body as T;
}

async function get<T>(path: string) {
  return readJson<T>(await fetch(`/api${path}`, { credentials: "include", headers: { Accept: "application/json" } }));
}

async function send<T>(method: "POST" | "PATCH", path: string, payload: unknown, headers: Record<string, string> = {}) {
  return readJson<T>(await fetch(`/api${path}`, {
    method,
    credentials: "include",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload ?? {}),
  }));
}

export const getMyCalendar = (from: string, to: string) =>
  get<{ from: string; to: string; items: CalendarItem[] }>(`/me/calendar?from=${from}&to=${to}`);
export const getMyMeetings = (tab: "upcoming" | "past", page = 1) =>
  get<{ items: MeetingSummary[]; pagination: Pagination }>(`/me/meetings?tab=${tab}&page=${page}`);
export const getMeeting = (id: string) => get<MeetingDetail>(`/me/meetings/${id}`);
export const searchParticipants = (q: string) =>
  get<{ items: ParticipantOption[] }>(`/me/meetings/participant-options?q=${encodeURIComponent(q)}`);
export const checkMeetingAvailability = (input: { startAt: string; endAt: string; participantEmployeeIds: string[]; excludeMeetingId?: string | null }) =>
  send<Availability>("POST", "/me/meetings/availability", input);
export const createMeeting = (input: MeetingInput, idempotencyKey: string) =>
  send<MeetingWriteResult>("POST", "/me/meetings", input, { "Idempotency-Key": idempotencyKey });
export const updateMeeting = (id: string, input: Partial<MeetingInput> & { expectedVersion: number }) =>
  send<MeetingWriteResult>("PATCH", `/me/meetings/${id}`, input);
export const cancelMeeting = (id: string, reason: string) => send<{ id: string }>("POST", `/me/meetings/${id}/cancel`, { reason });
export const respondToMeeting = (id: string, response: "ACCEPTED" | "DECLINED", note: string | null) =>
  send<{ id: string; changed: boolean }>("POST", `/me/meetings/${id}/response`, { response, note });

// ------------------------------------------------------------------- dates (WIB)

const WIB_OFFSET = "+07:00";

/** `YYYY-MM-DD` in Asia/Jakarta. */
export function jakartaDate(instant: Date | string = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(instant));
}

/** `HH:MM` in Asia/Jakarta. */
export function jakartaTime(instant: Date | string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", hour12: false })
    .format(new Date(instant));
}

/** A WIB date and `HH:MM` as an ISO instant, whatever the browser's own zone. */
export function wibInstant(date: string, time: string): string {
  return new Date(`${date}T${time}:00${WIB_OFFSET}`).toISOString();
}

export function addDays(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** `YYYY-MM` of a WIB date, and the first day of the next/previous month. */
export function shiftMonth(month: string, delta: number): string {
  const [year, monthIndex] = month.split("-").map(Number) as [number, number];
  const shifted = new Date(Date.UTC(year, monthIndex - 1 + delta, 1));
  return shifted.toISOString().slice(0, 7);
}

/**
 * The six-week grid of a month, Monday first (the legacy grid). Every date belongs to the
 * month view; `inMonth` greys out the leading and trailing days.
 */
export function monthGrid(month: string): Array<{ date: string; inMonth: boolean }> {
  const first = `${month}-01`;
  const weekday = new Date(`${first}T00:00:00Z`).getUTCDay() || 7;
  const start = addDays(first, 1 - weekday);
  return Array.from({ length: 42 }, (_, index) => {
    const date = addDays(start, index);
    return { date, inMonth: date.startsWith(month) };
  });
}

/** WIB dates an item covers, so a multi-day meeting or leave appears on each day. */
export function itemDates(item: CalendarItem): string[] {
  if (item.kind === "non_working") return [item.date];
  const [first, last] = item.kind === "meeting" || item.kind === "busy"
    ? [jakartaDate(item.startAt), jakartaDate(new Date(Date.parse(item.endAt) - 1))]
    : [item.startOn, item.endOn];
  const dates: string[] = [];
  for (let date = first; date <= last && dates.length < 43; date = addDays(date, 1)) dates.push(date);
  return dates;
}

export function itemsByDate(items: readonly CalendarItem[]): Map<string, CalendarItem[]> {
  const map = new Map<string, CalendarItem[]>();
  for (const item of items) {
    for (const date of itemDates(item)) {
      const list = map.get(date) ?? [];
      list.push(item);
      map.set(date, list);
    }
  }
  for (const list of map.values()) {
    list.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  }
  return map;
}

function sortKey(item: CalendarItem): string {
  if (item.kind === "non_working") return "0";
  if (item.kind === "leave" || item.kind === "trip") return `1${item.startOn}`;
  return `2${item.startAt}`;
}

// --------------------------------------------------------------------- labels

const DATE_LONG = new Intl.DateTimeFormat("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Jakarta" });
const MONTH_LONG = new Intl.DateTimeFormat("id-ID", { month: "long", year: "numeric", timeZone: "UTC" });

export function formatDateLong(date: string) {
  return DATE_LONG.format(new Date(`${date}T00:00:00${WIB_OFFSET}`));
}

export function formatMonth(month: string) {
  return MONTH_LONG.format(new Date(`${month}-01T00:00:00Z`));
}

/** "09:00–10:00" on one day, otherwise with both dates. */
export function formatMeetingRange(startAt: string, endAt: string) {
  const sameDay = jakartaDate(startAt) === jakartaDate(new Date(Date.parse(endAt) - 1));
  return sameDay
    ? `${formatDateLong(jakartaDate(startAt))}, ${jakartaTime(startAt)}–${jakartaTime(endAt)} WIB`
    : `${formatDateLong(jakartaDate(startAt))} ${jakartaTime(startAt)} – ${formatDateLong(jakartaDate(endAt))} ${jakartaTime(endAt)} WIB`;
}

export const RESPONSE_LABELS: Record<ParticipantResponse, string> = {
  PENDING: "Belum menjawab",
  ACCEPTED: "Hadir",
  DECLINED: "Berhalangan",
};

const EVENT_LABELS: Record<string, string> = {
  "meeting.created": "Undangan dibuat",
  "meeting.updated": "Rapat diubah",
  "meeting.participant.added": "Peserta ditambahkan",
  "meeting.participant.removed": "Peserta dikeluarkan",
  "meeting.participant.responded": "Peserta menjawab",
  "meeting.cancelled": "Rapat dibatalkan",
};

export function meetingEventLabel(eventType: string) {
  return EVENT_LABELS[eventType] ?? eventType;
}

export function calendarItemLabel(item: CalendarItem): string {
  switch (item.kind) {
    case "meeting": return `${jakartaTime(item.startAt)} ${item.title}`;
    case "busy": return `${jakartaTime(item.startAt)} Sibuk`;
    case "leave": return item.status === "approved" ? "Cuti" : "Cuti (diajukan)";
    case "trip": return item.status === "IN_REVIEW" ? `Dinas (diajukan): ${item.destination}` : `Dinas: ${item.destination}`;
    case "non_working": return item.label ?? "Libur";
  }
}
