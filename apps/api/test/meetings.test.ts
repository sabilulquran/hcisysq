// CAL-001 Package 1 rules without a database: availability, visibility, transitions,
// reminder timing, WhatsApp text and the Kirim SQ adapter. Spec: docs/domain/meeting-calendar.md.

import { describe, expect, it, vi } from "vitest";

import { kirimSettings, loadConfig } from "../src/config/env.js";
import { whatsappDelivery } from "../src/modules/meetings/routes.js";
import {
  allowedActions,
  assertCancellable,
  assertEditable,
  assertRespondable,
  blocksTime,
  deliveryKey,
  describeIssue,
  evaluateAvailability,
  jakartaDateOf,
  jakartaDatesCovering,
  jakartaDayInterval,
  MeetingPolicyError,
  normalizeParticipants,
  overlaps,
  peopleToCheck,
  projectCalendarMeeting,
  reminderFireAt,
  retryDelayMs,
  validateMeetingTimes,
  whatsappText,
  type AvailabilityInput,
  type CalendarMeetingRow,
} from "../src/modules/meetings/domain.js";
import {
  ClientCredentialsTokenProvider,
  createWhatsAppSender,
  KirimWhatsAppSender,
  whatsappAllowlist,
  LogWhatsAppSender,
  maskWhatsAppNumber,
  normalizeWhatsAppNumber,
  WhatsAppRejectedError,
  WhatsAppRetryableError,
  type FetchLike,
} from "../src/modules/meetings/whatsapp.js";

const at = (text: string) => Date.parse(text);
const wib = (local: string) => at(`${local}:00+07:00`);
const MINUTE = 60_000;

const people = [
  { employeeId: "a", name: "Ahmad" },
  { employeeId: "b", name: "Budi" },
];

function availability(overrides: Partial<AvailabilityInput> = {}) {
  return evaluateAvailability({
    interval: { startMs: wib("2026-11-10T09:00"), endMs: wib("2026-11-10T10:00") },
    people,
    meetings: [],
    leaves: [],
    trips: [],
    nonWorkingDates: [],
    ...overrides,
  });
}

describe("CAL-001 time helpers", () => {
  it("treats touching intervals as free (CAL-001-C)", () => {
    const nine = { startMs: wib("2026-11-10T09:00"), endMs: wib("2026-11-10T10:00") };
    const ten = { startMs: wib("2026-11-10T10:00"), endMs: wib("2026-11-10T11:00") };
    expect(overlaps(nine, ten)).toBe(false);
    expect(overlaps(ten, nine)).toBe(false);
    expect(overlaps(nine, { startMs: wib("2026-11-10T09:59"), endMs: wib("2026-11-10T10:30") })).toBe(true);
  });

  it("converts whole WIB dates to [00:00, next 00:00) and back", () => {
    const day = jakartaDayInterval("2026-11-10");
    expect(new Date(day.startMs).toISOString()).toBe("2026-11-09T17:00:00.000Z");
    expect(day.endMs - day.startMs).toBe(86_400_000);
    expect(jakartaDateOf(at("2026-11-09T17:00:00Z"))).toBe("2026-11-10");
    expect(jakartaDateOf(at("2026-11-09T16:59:59Z"))).toBe("2026-11-09");
    // A meeting that ends exactly at midnight does not touch the next date.
    expect(jakartaDatesCovering({ startMs: wib("2026-11-10T22:00"), endMs: wib("2026-11-11T00:00") }))
      .toEqual({ firstDate: "2026-11-10", lastDate: "2026-11-10" });
  });

  it("enforces K-09 duration and start", () => {
    const now = wib("2026-11-10T08:00");
    expect(() => validateMeetingTimes({ startMs: now + 60 * MINUTE, endMs: now + 74 * MINUTE, nowMs: now }))
      .toThrow(/15 menit/);
    expect(() => validateMeetingTimes({ startMs: now, endMs: now + 7 * 1440 * MINUTE + MINUTE, nowMs: now }))
      .toThrow(/7 hari/);
    expect(() => validateMeetingTimes({ startMs: now, endMs: now - MINUTE, nowMs: now })).toThrow(/sesudah/);
    expect(() => validateMeetingTimes({ startMs: now - 2 * MINUTE, endMs: now + 30 * MINUTE, nowMs: now }))
      .toThrowError(expect.objectContaining({ code: "MEETING_START_IN_PAST" }));
    // An edit that keeps the time does not re-check the start.
    expect(() => validateMeetingTimes({ startMs: now - 2 * MINUTE, endMs: now + 30 * MINUTE, nowMs: now, requireFutureStart: false }))
      .not.toThrow();
    expect(() => validateMeetingTimes({ startMs: now, endMs: now + 15 * MINUTE, nowMs: now })).not.toThrow();
  });

  it("dedupes participants and refuses the organizer or an empty list", () => {
    expect(normalizeParticipants("o", ["a", "b", "a"])).toEqual(["a", "b"]);
    expect(() => normalizeParticipants("o", ["a", "o"])).toThrow(MeetingPolicyError);
    expect(() => normalizeParticipants("o", [])).toThrow(/1 sampai 200/);
    expect(() => normalizeParticipants("o", Array.from({ length: 201 }, (_, index) => `p${index}`))).toThrow(/1 sampai 200/);
  });
});

describe("CAL-001 §6 availability", () => {
  it("blocks on an overlapping active meeting, not on a touching one", () => {
    const result = availability({
      meetings: [
        { employeeId: "a", meetingId: "m1", title: "Rapat kurikulum", startMs: wib("2026-11-10T09:30"), endMs: wib("2026-11-10T11:00") },
        { employeeId: "b", meetingId: "m2", title: "Rapat sebelum", startMs: wib("2026-11-10T08:00"), endMs: wib("2026-11-10T09:00") },
      ],
    });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({ employeeId: "a", reason: "MEETING_OVERLAP", meetingTitle: "Rapat kurikulum" });
    expect(describeIssue(result.conflicts[0]!)).toBe('Ahmad bentrok dengan "Rapat kurikulum" (09:30-11:00).');
  });

  it("blocks a scheduled training session (TRAIN-001 §7.3), not a touching one", () => {
    const result = availability({
      trainings: [
        { employeeId: "b", sessionId: "s1", title: "Tahsin Guru — Sesi 1", startMs: wib("2026-11-10T08:00"), endMs: wib("2026-11-10T09:30") },
        { employeeId: "a", sessionId: "s2", title: "Pedagogi — Sesi 2", startMs: wib("2026-11-10T10:00"), endMs: wib("2026-11-10T12:00") },
      ],
    });
    expect(result.conflicts).toEqual([expect.objectContaining({ employeeId: "b", reason: "IN_TRAINING", trainingTitle: "Tahsin Guru — Sesi 1" })]);
    expect(describeIssue(result.conflicts[0]!)).toBe('Budi sedang mengikuti pelatihan "Tahsin Guru — Sesi 1" (08:00-09:30).');
  });

  it("hides the title of a confidential meeting the viewer is not in (CAL-001-B)", () => {
    const result = availability({
      meetings: [{ employeeId: "a", meetingId: "m1", title: null, startMs: wib("2026-11-10T09:00"), endMs: wib("2026-11-10T10:00") }],
    });
    expect(result.conflicts[0]!.meetingTitle).toBeNull();
    // Nor its exact hours (I-12): probing slots must not map out who attends it.
    expect(result.conflicts[0]!.startAt).toBeUndefined();
    expect(describeIssue(result.conflicts[0]!)).toBe("Ahmad sudah ada rapat lain pada waktu itu.");
  });

  it("blocks approved leave and approved/issued trips; pending ones only warn (CAL-001-E)", () => {
    const result = availability({
      leaves: [
        { employeeId: "a", status: "approved", startOn: "2026-11-10", endOn: "2026-11-10" },
        { employeeId: "b", status: "in_review", startOn: "2026-11-09", endOn: "2026-11-12" },
      ],
      trips: [
        { employeeId: "b", status: "ISSUED", startOn: "2026-11-10", endOn: "2026-11-11" },
        { employeeId: "a", status: "IN_REVIEW", startOn: "2026-11-10", endOn: "2026-11-10" },
        { employeeId: "a", status: "APPROVED", startOn: "2026-11-11", endOn: "2026-11-12" },
      ],
    });
    expect(result.conflicts.map((issue) => `${issue.employeeId}:${issue.reason}`).sort()).toEqual(["a:ON_LEAVE", "b:ON_TRIP"]);
    expect(result.warnings.map((issue) => `${issue.employeeId}:${issue.reason}`).sort()).toEqual(["a:TRIP_PENDING", "b:LEAVE_PENDING"]);
    // Never the leave type or the trip destination: only dates and the reason.
    expect(Object.keys(result.conflicts[0]!).sort()).toEqual(["employeeId", "endOn", "name", "reason", "startOn"]);
  });

  it("a whole-day leave ending the day before does not touch a meeting at 00:00 (half-open)", () => {
    const result = availability({
      interval: { startMs: wib("2026-11-11T00:00"), endMs: wib("2026-11-11T01:00") },
      leaves: [{ employeeId: "a", status: "approved", startOn: "2026-11-10", endOn: "2026-11-10" }],
    });
    expect(result.conflicts).toEqual([]);
  });

  it("warns once per non-working date (K-10)", () => {
    const result = availability({ nonWorkingDates: ["2026-11-10", "2026-11-11"] });
    expect(result.conflicts).toEqual([]);
    expect(result.warnings).toEqual([{ employeeId: null, name: null, reason: "NON_WORKING_DAY", startOn: "2026-11-10", endOn: "2026-11-10" }]);
  });

  it("ignores people who are not being checked", () => {
    const result = availability({
      people: [{ employeeId: "b", name: "Budi" }],
      meetings: [{ employeeId: "a", meetingId: "m1", title: "x", startMs: wib("2026-11-10T09:00"), endMs: wib("2026-11-10T10:00") }],
    });
    expect(result.conflicts).toEqual([]);
  });

  it("checks everyone for a new meeting or time, only newcomers for other edits", () => {
    expect(peopleToCheck({ organizerEmployeeId: "o", participantEmployeeIds: ["a", "b"], existing: null })).toEqual(["o", "a", "b"]);
    expect(peopleToCheck({
      organizerEmployeeId: "o", participantEmployeeIds: ["a", "c"],
      existing: { participantEmployeeIds: ["a", "b"], timeChanged: true },
    })).toEqual(["o", "a", "c"]);
    expect(peopleToCheck({
      organizerEmployeeId: "o", participantEmployeeIds: ["a", "c"],
      existing: { participantEmployeeIds: ["a", "b"], timeChanged: false },
    })).toEqual(["c"]);
  });
});

describe("CAL-001 transitions", () => {
  const meeting = { status: "ACTIVE" as const, startMs: wib("2026-11-10T09:00"), endMs: wib("2026-11-10T10:00"), organizerEmployeeId: "o" };
  const before = wib("2026-11-10T08:00");
  const during = wib("2026-11-10T09:30");

  it("only the organizer edits, before the start, an active meeting (CAL-001-G)", () => {
    expect(() => assertEditable(meeting, "o", before)).not.toThrow();
    expect(() => assertEditable(meeting, "a", before)).toThrowError(expect.objectContaining({ code: "MEETING_NOT_ORGANIZER", statusCode: 403 }));
    expect(() => assertEditable(meeting, "o", during)).toThrowError(expect.objectContaining({ code: "MEETING_ALREADY_STARTED" }));
    expect(() => assertEditable({ ...meeting, status: "CANCELLED" }, "o", before)).toThrowError(expect.objectContaining({ code: "MEETING_CANCELLED" }));
  });

  it("the organizer cancels until the end", () => {
    expect(() => assertCancellable(meeting, "o", during)).not.toThrow();
    expect(() => assertCancellable(meeting, "o", meeting.endMs)).toThrowError(expect.objectContaining({ code: "MEETING_ALREADY_ENDED" }));
    expect(() => assertCancellable(meeting, "a", before)).toThrowError(expect.objectContaining({ code: "MEETING_NOT_ORGANIZER" }));
  });

  it("attendees answer until the start; the organizer never answers", () => {
    expect(() => assertRespondable(meeting, "ATTENDEE", before)).not.toThrow();
    expect(() => assertRespondable(meeting, "ATTENDEE", during)).toThrowError(expect.objectContaining({ code: "MEETING_ALREADY_STARTED" }));
    expect(() => assertRespondable(meeting, "ORGANIZER", before)).toThrowError(expect.objectContaining({ code: "MEETING_RESPONSE_NOT_ALLOWED" }));
  });

  it("declined and cancelled free the time (CAL-001-D)", () => {
    expect(blocksTime("ACTIVE", "PENDING")).toBe(true);
    expect(blocksTime("ACTIVE", "ACCEPTED")).toBe(true);
    expect(blocksTime("ACTIVE", "DECLINED")).toBe(false);
    expect(blocksTime("CANCELLED", "ACCEPTED")).toBe(false);
  });

  it("tells the screen which buttons apply", () => {
    expect(allowedActions(meeting, { employeeId: "o", role: "ORGANIZER" }, before)).toEqual({ canEdit: true, canCancel: true, canRespond: false });
    expect(allowedActions(meeting, { employeeId: "a", role: "ATTENDEE" }, before)).toEqual({ canEdit: false, canCancel: false, canRespond: true });
    expect(allowedActions(meeting, { employeeId: "o", role: "ORGANIZER" }, during)).toEqual({ canEdit: false, canCancel: true, canRespond: false });
  });

  it("schedules the reminder 30 minutes ahead, or not at all (K-15)", () => {
    expect(reminderFireAt(meeting.startMs, before)).toBe(meeting.startMs - 30 * MINUTE);
    expect(reminderFireAt(meeting.startMs, meeting.startMs - 30 * MINUTE)).toBeNull();
    expect(reminderFireAt(meeting.startMs, meeting.startMs - 20 * MINUTE)).toBeNull();
  });
});

describe("CAL-001 K-05 visibility", () => {
  const row: CalendarMeetingRow = {
    id: "m1", title: "Rapat yayasan", location: "Aula", organizerName: "Ahmad",
    startAt: "2026-11-10T02:00:00.000Z", endAt: "2026-11-10T03:00:00.000Z",
    status: "ACTIVE", confidential: false, involvesMe: false, myRole: null, myResponse: null,
  };

  it("shows title, time, location and organizer of an ordinary meeting, without an id to open", () => {
    expect(projectCalendarMeeting(row)).toEqual({ ...row, kind: "meeting", id: null });
  });

  it("shows a confidential meeting as Sibuk only to non-participants (CAL-001-I)", () => {
    const busy = projectCalendarMeeting({ ...row, confidential: true });
    expect(busy).toEqual({ kind: "busy", id: null, startAt: row.startAt, endAt: row.endAt, involvesMe: false });
    expect(JSON.stringify(busy)).not.toMatch(/Rapat yayasan|Aula|Ahmad/);
    expect(projectCalendarMeeting({ ...row, confidential: true, involvesMe: true, myRole: "ATTENDEE", myResponse: "PENDING" }))
      .toMatchObject({ kind: "meeting", id: "m1", title: "Rapat yayasan" });
  });

  it("hides a cancelled meeting from non-participants and keeps it for participants", () => {
    expect(projectCalendarMeeting({ ...row, status: "CANCELLED" })).toBeNull();
    expect(projectCalendarMeeting({ ...row, status: "CANCELLED", involvesMe: true, myRole: "ATTENDEE", myResponse: "ACCEPTED" }))
      .toMatchObject({ status: "CANCELLED", id: "m1" });
  });
});

describe("CAL-001 WhatsApp", () => {
  const facts = {
    title: "Rapat kurikulum", startMs: wib("2026-11-10T09:00"), endMs: wib("2026-11-10T10:00"),
    location: "Ruang guru", organizerName: "Ahmad", link: "https://hcis.example/app/calendar?meeting=m1",
  };

  it("builds a message with title, WIB time, location, organizer and link only", () => {
    const text = whatsappText("invited", facts);
    expect(text).toContain("*Undangan rapat*");
    expect(text).toContain("Rapat kurikulum");
    expect(text).toMatch(/10 November 2026, 09:00–10:00 WIB/);
    expect(text).toContain("Lokasi: Ruang guru");
    expect(text).toContain("Penyelenggara: Ahmad");
    expect(text).toContain(facts.link);
    expect(whatsappText("cancelled", facts)).not.toContain("http");
  });

  it("derives stable idempotency keys and the retry schedule", () => {
    expect(deliveryKey("m1", "e1", "reminder", 3)).toBe("cal:m1:e1:reminder:3");
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([MINUTE, 5 * MINUTE, 30 * MINUTE, null]);
  });

  it("normalizes Indonesian numbers and masks them for logs", () => {
    expect(normalizeWhatsAppNumber("0812-3456-7890")).toBe("+6281234567890");
    expect(normalizeWhatsAppNumber("+62 812 3456 7890")).toBe("+6281234567890");
    expect(normalizeWhatsAppNumber("021-555-1234")).toBeNull();
    expect(normalizeWhatsAppNumber(null)).toBeNull();
    expect(maskWhatsAppNumber("+6281234567890")).toBe("+62812•••••890");
  });

  it("log adapter makes no network call and reports a dry run (CAL-001-L)", async () => {
    const fetchSpy = vi.fn<FetchLike>();
    const entries: unknown[] = [];
    const sender = createWhatsAppSender({ WHATSAPP_ADAPTER: "log", KIRIM_AUDIENCE: "sq-hub-kirim" } as never, {
      fetch: fetchSpy, log: (entry) => entries.push(entry),
    });
    expect(sender).toBeInstanceOf(LogWhatsAppSender);
    const result = await sender.send({
      device: "hcis", to: "+6281234567890", text: "rahasia", expiresAt: "2026-11-10T02:00:00Z", ref: "cal:m1:invited", idempotencyKey: "k1",
    });
    expect(result.dryRun).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(entries)).not.toContain("rahasia");
    expect(JSON.stringify(entries)).not.toContain("81234567890");
  });

  function kirim(responses: Array<() => Response | Promise<Response>>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/token")) return Response.json({ access_token: `t${calls.length}`, expires_in: 300 });
      const next = responses.shift();
      if (!next) throw new Error("unexpected call");
      return next();
    };
    const tokens = new ClientCredentialsTokenProvider(
      { tokenUrl: "https://sso.example/token", clientId: "hcis-kirim", clientSecret: "s", audience: "sq-hub-kirim" }, fetchImpl,
    );
    return { calls, sender: new KirimWhatsAppSender("http://127.0.0.1:3302/", tokens, fetchImpl) };
  }

  const message = {
    device: "hcis", to: "+6281234567890", text: "Halo", expiresAt: "2026-11-10T02:00:00.000Z",
    ref: "cal:m1:invited", idempotencyKey: "cal:m1:e1:invited:1",
  };

  it("kirim adapter posts the Kirim SQ contract with the idempotency key", async () => {
    const { calls, sender } = kirim([() => Response.json({ id: "msg-1", status: "antre" }, { status: 202 })]);
    await expect(sender.send(message)).resolves.toEqual({ id: "msg-1", dryRun: false });
    const post = calls.find((call) => call.url.endsWith("/internal/kirim/messages"))!;
    expect(post.url).toBe("http://127.0.0.1:3302/internal/kirim/messages");
    const headers = post.init.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBe("cal:m1:e1:invited:1");
    expect(headers.authorization).toMatch(/^Bearer t/);
    expect(JSON.parse(post.init.body as string)).toEqual({
      device: "hcis", jenis: "notifikasi", to: "+6281234567890", text: "Halo", prioritas: "normal",
      kedaluwarsa: "2026-11-10T02:00:00.000Z", ref: "cal:m1:invited",
    });
  });

  it("kirim adapter leaves the device out when none is configured, so Kirim SQ uses the HCIS card", async () => {
    const { calls, sender } = kirim([() => Response.json({ id: "msg-2", status: "antre" }, { status: 202 })]);
    await sender.send({ ...message, device: undefined });
    const post = calls.find((call) => call.url.endsWith("/internal/kirim/messages"))!;
    expect(JSON.parse(post.init.body as string)).not.toHaveProperty("device");
  });

  it("KIRIM-IMPL-003: the kirim adapter uses the SQ Hub machine client, issuer and origin HCIS already has", async () => {
    const base = { NODE_ENV: "test", DATABASE_URL: "postgres://x@127.0.0.1/db" };
    const hub = {
      OIDC_ISSUER: "https://login.example/realms/sq-staff/",
      SQ_HUB_APPLICATION_ACCESS_URL: "http://127.0.0.1:3302/internal/v1/application-access/check",
      SQ_HUB_MACHINE_CLIENT_ID: "hcis-api",
      SQ_HUB_MACHINE_CLIENT_SECRET: "machine-secret",
    };
    const config = loadConfig({ ...base, ...hub, WHATSAPP_ADAPTER: "kirim" });
    expect(kirimSettings(config)).toEqual({
      baseUrl: "http://127.0.0.1:3302",
      tokenUrl: "https://login.example/realms/sq-staff/protocol/openid-connect/token",
      clientId: "hcis-api",
      clientSecret: "machine-secret",
    });
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push(url);
      if (url.endsWith("/token")) {
        expect(new URLSearchParams(init.body as string).get("client_id")).toBe("hcis-api");
        return Response.json({ access_token: "t", expires_in: 300 });
      }
      return Response.json({ id: "msg-3", status: "antre" }, { status: 202 });
    };
    await createWhatsAppSender(config, { fetch: fetchImpl }).send({ ...message, device: undefined });
    expect(calls).toEqual(["https://login.example/realms/sq-staff/protocol/openid-connect/token", "http://127.0.0.1:3302/internal/kirim/messages"]);
    // A half-set explicit client never silently falls back to the machine client.
    expect(() => loadConfig({ ...base, ...hub, WHATSAPP_ADAPTER: "kirim", KIRIM_CLIENT_ID: "lain" })).toThrow(/KIRIM_CLIENT_SECRET is required/);
  });

  it("CAL-001 K-17: real WhatsApp is limited to the allowlist until one switch lifts it", () => {
    const base = { NODE_ENV: "test", DATABASE_URL: "postgres://x@127.0.0.1/db" };
    const defaults = loadConfig(base);
    expect(defaults.WHATSAPP_RECIPIENT_MODE).toBe("allowlist");
    expect(whatsappAllowlist(defaults)).toEqual(new Set());
    const listed = loadConfig({ ...base, WHATSAPP_ALLOWLIST: "202001011990010001, 202001011990010002 ,202001011990010001" });
    expect(whatsappAllowlist(listed)).toEqual(new Set(["202001011990010001", "202001011990010002"]));
    expect(() => loadConfig({ ...base, WHATSAPP_ALLOWLIST: "+62 812 3456 7890" })).toThrow(/NIPs/);
    expect(whatsappAllowlist(loadConfig({ ...base, WHATSAPP_RECIPIENT_MODE: "all", WHATSAPP_ALLOWLIST: "202001011990010001" }))).toBeNull();
  });

  it("kirim adapter re-authenticates once on 401 and classifies failures", async () => {
    const reauth = kirim([
      () => new Response("", { status: 401 }),
      () => Response.json({ id: "msg-2" }, { status: 202 }),
    ]);
    await expect(reauth.sender.send(message)).resolves.toMatchObject({ id: "msg-2" });
    expect(reauth.calls.filter((call) => call.url.endsWith("/token"))).toHaveLength(2);

    await expect(kirim([() => new Response("", { status: 503 })]).sender.send(message)).rejects.toBeInstanceOf(WhatsAppRetryableError);
    await expect(kirim([() => Response.json({ error: { code: "invalid_request" } }, { status: 400 })]).sender.send(message))
      .rejects.toMatchObject({ code: "invalid_request" });
    await expect(kirim([() => { throw new TypeError("fetch failed"); }]).sender.send(message))
      .rejects.toBeInstanceOf(WhatsAppRetryableError);
    await expect(kirim([() => new Response("", { status: 422 })]).sender.send(message)).rejects.toBeInstanceOf(WhatsAppRejectedError);
  });

  it("refuses WHATSAPP_ADAPTER=kirim without credentials and defaults to log", () => {
    const base = { NODE_ENV: "test", DATABASE_URL: "postgres://x@127.0.0.1/db" };
    expect(loadConfig(base).WHATSAPP_ADAPTER).toBe("log");
    expect(loadConfig(base).KIRIM_DEVICE_HCIS).toBeUndefined();
    expect(() => loadConfig({ ...base, WHATSAPP_ADAPTER: "kirim" })).toThrow(/KIRIM_BASE_URL is required/);
    const full = loadConfig({
      ...base, WHATSAPP_ADAPTER: "kirim", KIRIM_BASE_URL: "http://127.0.0.1:3302", KIRIM_TOKEN_URL: "https://sso.example/token",
      KIRIM_CLIENT_ID: "hcis-kirim", KIRIM_CLIENT_SECRET: "s",
    });
    expect(createWhatsAppSender(full)).toBeInstanceOf(KirimWhatsAppSender);
    // K-16: the screen learns from the API whether WhatsApp really goes out.
    expect(whatsappDelivery(loadConfig(base))).toBe("dry_run");
    expect(whatsappDelivery(full)).toBe("active");
  });
});
