import { createHash } from "node:crypto";

import { isNonSensitivePhysicalWireCommand } from "./physical-parity-protocol.js";

export const ADMS_MAX_BODY_BYTES = 512 * 1024;
// SEC-11: bodies above ADMS_MAX_BODY_BYTES are still hashed as evidence, but reading stops here.
export const ADMS_HARD_MAX_BODY_BYTES = 8 * 1024 * 1024;
export const ADMS_FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

export type ParsedAttlogEvent = {
  rawLine: string;
  rawFields: string[];
  pin: string;
  occurredAtRaw: string;
  occurredAt: Date;
  rawLineSha256: string;
};

export type ParsedDeviceCommandResult = {
  rawLine: string;
  commandNumber: string;
  returnCode: number;
  command: string;
  safeOptions: Record<string, string>;
};

export type AttlogQuarantine = {
  reason:
    | "INVALID_FIELD_COUNT"
    | "INVALID_TIMESTAMP"
    | "FUTURE_TIMESTAMP"
    | "UNSUPPORTED_ENCODING"
    | "INVALID_COMMAND_RESULT";
  rawLine: string;
  details: Record<string, string | number | boolean>;
};

const SAFE_INFO_OPTION_KEYS = new Set([
  "DeviceName",
  "FWVersion",
  "IPAddress",
  "MAC",
  "MACAddress",
  "Platform",
  "PushVersion",
  "PushProtVer",
  "UserCount",
  "FPCount",
  "FaceCount",
  "PalmCount",
  "TransactionCount",
  "AttLogCount",
  "MaxUserCount",
  "MaxAttLogCount",
  "MaxFingerCount",
  "MaxFaceCount",
  "AlarmReRec",
  "PhotoFunOn",
  "FingerFunOn",
  "FaceFunOn",
  "FPVersion",
  "FaceVersion",
]);

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function containsControlCharacter(value: string) {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

export function normalizeDeviceSerial(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || containsControlCharacter(normalized)) {
    throw new Error("Invalid ADMS serial");
  }
  return normalized;
}

export function parseAttlogText(
  text: string,
  timezone: string,
  receivedAt: Date,
): { events: ParsedAttlogEvent[]; quarantines: AttlogQuarantine[] } {
  const events: ParsedAttlogEvent[] = [];
  const quarantines: AttlogQuarantine[] = [];
  for (const rawLine of text.split(/\r\n|\n|\r/)) {
    if (rawLine === "") continue;
    const rawFields = rawLine.split("\t");
    if (rawFields.length !== 11) {
      quarantines.push({
        reason: "INVALID_FIELD_COUNT",
        rawLine,
        details: { expected: 11, actual: rawFields.length },
      });
      continue;
    }
    const occurredAtRaw = rawFields[1] ?? "";
    const occurredAt = parseLocalDeviceTime(occurredAtRaw, timezone);
    if (!occurredAt) {
      quarantines.push({ reason: "INVALID_TIMESTAMP", rawLine, details: { timezone } });
      continue;
    }
    if (occurredAt.getTime() > receivedAt.getTime() + ADMS_FUTURE_TOLERANCE_MS) {
      quarantines.push({
        reason: "FUTURE_TIMESTAMP",
        rawLine,
        details: { toleranceMs: ADMS_FUTURE_TOLERANCE_MS },
      });
      continue;
    }
    events.push({
      rawLine,
      rawFields,
      pin: rawFields[0] ?? "",
      occurredAtRaw,
      occurredAt,
      rawLineSha256: sha256(rawLine),
    });
  }
  return { events, quarantines };
}

function parseSafeInfoOption(rawLine: string): [string, string] | null {
  const separator = rawLine.indexOf("=");
  if (separator <= 0) return null;
  const key = rawLine.slice(0, separator).trim();
  const value = rawLine.slice(separator + 1).trim();
  if (!SAFE_INFO_OPTION_KEYS.has(key)) return null;
  if (!value || value.length > 256 || containsControlCharacter(value)) return null;
  return [key, value];
}

function looksLikeCommandResult(rawLine: string) {
  return /(?:^|&)ID=[^&]+/.test(rawLine) && /(?:^|&)Return=[^&]+/.test(rawLine) && /(?:^|&)CMD=/.test(rawLine);
}

export function parseDeviceCommandResultText(
  text: string,
): { results: ParsedDeviceCommandResult[]; quarantines: AttlogQuarantine[] } {
  const results: ParsedDeviceCommandResult[] = [];
  const quarantines: AttlogQuarantine[] = [];
  const lines = text.split(/\r\n|\n|\r/);

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    if (!rawLine) continue;
    const params = new URLSearchParams(rawLine);
    const commandNumber = params.get("ID") ?? "";
    const returnRaw = params.get("Return") ?? params.get("return") ?? "";
    const command = (params.get("CMD") ?? "").trim();
    const returnCode = Number(returnRaw);
    const valid =
      /^[1-9]\d{0,18}$/.test(commandNumber) &&
      /^-?\d+$/.test(returnRaw) &&
      Number.isSafeInteger(returnCode) &&
      command.length > 0 &&
      command.length <= 256 &&
      !containsControlCharacter(command);

    if (!valid) {
      quarantines.push({
        reason: "INVALID_COMMAND_RESULT",
        rawLine,
        details: {
          hasId: Boolean(commandNumber),
          hasReturn: Boolean(returnRaw),
          hasCommand: Boolean(command),
        },
      });
      continue;
    }

    const safeOptions: Record<string, string> = {};
    if (command === "INFO") {
      let nextIndex = index + 1;
      while (nextIndex < lines.length) {
        const optionLine = lines[nextIndex] ?? "";
        if (looksLikeCommandResult(optionLine)) break;
        const option = parseSafeInfoOption(optionLine);
        if (option) safeOptions[option[0]] = option[1];
        nextIndex += 1;
      }
      index = nextIndex - 1;
    }

    results.push({ rawLine, commandNumber, returnCode, command, safeOptions });
  }

  return { results, quarantines };
}

const deviceTimestampPattern = "\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}";
const attlogRangeCommandPattern = new RegExp(
  `^DATA QUERY ATTLOG StartTime=${deviceTimestampPattern}\\tEndTime=${deviceTimestampPattern}$`,
);
const userInfoNameUpdateCommandPattern = /^DATA UPDATE USERINFO PIN=\d{1,128}\tName=[^\t\r\n]{1,160}$/u;
const fingerprintRestoreCommandPattern = /^DATA UPDATE FINGERTMP PIN=\d{1,128}\tFID=\d{1,2}\tSize=\d{1,6}\tValid=[13]\tTMP=[A-Za-z0-9+/=]{4,524288}$/u;
const faceRestoreCommandPattern = /^DATA UPDATE FACE PIN=\d{1,128}\tFID=\d{1,3}\tSize=\d{1,8}\tValid=1\tTMP=[A-Za-z0-9+/=]{4,5242880}$/u;
const unifiedBiometricRestoreCommandPattern = /^DATA UPDATE BIODATA Pin=\d{1,128}\tNo=\d{1,3}\tIndex=\d{1,5}\tValid=1\tDuress=0\tType=(1|2|6|8|9|10)\tMajorVer=\d{1,5}\tMinorVer=\d{1,5}\tFormat=\d{1,5}\tTmp=[A-Za-z0-9+/=]{4,5242880}$/u;

export function attlogRangeWireCommand(startTime: string, endTime: string) {
  const command = `DATA QUERY ATTLOG StartTime=${startTime}\tEndTime=${endTime}`;
  if (!attlogRangeCommandPattern.test(command)) throw new Error("Invalid ADMS ATTLOG range command");
  return command;
}

export function userInfoNameUpdateWireCommand(pin: string, name: string) {
  if (!/^\d{1,128}$/.test(pin)) throw new Error("Invalid ADMS USERINFO PIN");
  const normalizedName = name.trim();
  if (!normalizedName || normalizedName.length > 160 || containsControlCharacter(normalizedName)) {
    throw new Error("Invalid ADMS USERINFO name");
  }
  const command = `DATA UPDATE USERINFO PIN=${pin}\tName=${normalizedName}`;
  if (!userInfoNameUpdateCommandPattern.test(command)) throw new Error("Invalid ADMS USERINFO update command");
  return command;
}

export function deviceCommandWireBody(commandNumber: string | number, wireCommand: string) {
  const number = String(commandNumber);
  if (!/^[1-9]\d{0,18}$/.test(number)) throw new Error("Invalid ADMS command number");
  if (
    wireCommand !== "LOG" &&
    wireCommand !== "INFO" &&
    !attlogRangeCommandPattern.test(wireCommand) &&
    !userInfoNameUpdateCommandPattern.test(wireCommand) &&
    !isNonSensitivePhysicalWireCommand(wireCommand) &&
    !fingerprintRestoreCommandPattern.test(wireCommand) &&
    !faceRestoreCommandPattern.test(wireCommand) &&
    !unifiedBiometricRestoreCommandPattern.test(wireCommand)
  ) {
    throw new Error("Unsupported ADMS wire command");
  }
  return `C:${number}:${wireCommand}\n`;
}

export function extractSerialCandidate(url: URL): string | null {
  for (const key of ["SN", "sn", "serial", "Serial"]) {
    const value = url.searchParams.get(key);
    if (!value) continue;
    try {
      return normalizeDeviceSerial(value);
    } catch {
      return null;
    }
  }
  return null;
}

export function optionsAllHandshakeBody(url: URL, serial: string | null, attlogStamp = "None") {
  if (!serial || url.pathname !== "/iclock/cdata" || url.searchParams.get("options") !== "all") {
    return null;
  }
  return [
    `GET OPTION FROM: ${serial}`,
    `ATTLOGStamp=${attlogStamp}`,
    "OPERLOGStamp=None",
    "ATTPHOTOStamp=None",
    "ErrorDelay=30",
    "Delay=10",
    "TransTimes=00:00;14:05",
    "TransInterval=1",
    "TransFlag=TransData\tAttLog",
    "TimeZone=7",
    "Realtime=1",
    "Encrypt=None",
    "ServerVer=2.4.1",
    "PushProtVer=2.4.1",
    "PushOptionsFlag=0",
  ].join("\n");
}

/**
 * PUSH SDK devices poll this endpoint even when the server has no command to send.
 * The vendor protocol requires a literal two-byte "OK" response in that idle case;
 * an empty 200 response is not protocol-equivalent for all firmware generations.
 */
export function getRequestIdleAcknowledgementBody(url: URL): string | null {
  return url.pathname === "/iclock/getrequest" ? "OK" : null;
}

export function deviceTimeResponseBody(url: URL, now = new Date()) {
  if (url.pathname !== "/iclock/cdata" || url.searchParams.get("type")?.toLowerCase() !== "time") return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `Time=${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}+07:00`;
}

export function extractAttlogStamp(url: URL): string | null {
  const value = url.searchParams.get("Stamp") ?? url.searchParams.get("stamp");
  if (!value || value.length > 256 || containsControlCharacter(value)) return null;
  return value;
}

export function attlogAcknowledgementBody(text: string): string | null {
  const records = text.split(/\r\n|\n|\r/).filter((line) => line !== "").length;
  return records > 0 ? `OK: ${records}` : null;
}

export function bodySha256(body: Uint8Array) {
  return sha256(body);
}

export function attlogEventIdentity(serialNumber: string, event: ParsedAttlogEvent): string {
  const [status = "", verify = "", workcode = ""] = event.rawFields.slice(2, 5);
  return sha256(
    [
      serialNumber,
      event.pin,
      event.occurredAtRaw,
      status,
      verify,
      workcode,
      event.rawLineSha256,
    ].join("\0"),
  );
}

type LocalParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function parseLocalParts(value: string): LocalParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  if ([year, month, day, hour, minute, second].some((part) => !Number.isInteger(part))) return null;
  if (month! < 1 || month! > 12 || day! < 1 || day! > 31 || hour! > 23 || minute! > 59 || second! > 59) return null;
  const date = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!, second!));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month! - 1 || date.getUTCDate() !== day) return null;
  return { year: year!, month: month!, day: day!, hour: hour!, minute: minute!, second: second! };
}

function localPartsAt(date: Date, timezone: string): LocalParts {
  const values = new Intl.DateTimeFormat("en-CA", {
    calendar: "iso8601",
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => Number(values.find((part) => part.type === type)?.value);
  return {
    year: get("year"), month: get("month"), day: get("day"),
    hour: get("hour"), minute: get("minute"), second: get("second"),
  };
}

export function formatDeviceLocalTimestamp(date: Date, timezone: string) {
  const parts = localPartsAt(date, timezone);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

function sameParts(left: LocalParts, right: LocalParts) {
  return left.year === right.year && left.month === right.month && left.day === right.day &&
    left.hour === right.hour && left.minute === right.minute && left.second === right.second;
}

function parseLocalDeviceTime(value: string, timezone: string): Date | null {
  const target = parseLocalParts(value);
  if (!target) return null;
  const assumedUtc = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, target.second);
  const observed = localPartsAt(new Date(assumedUtc), timezone);
  const observedAsUtc = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second);
  const candidate = new Date(assumedUtc - (observedAsUtc - assumedUtc));
  if (!sameParts(localPartsAt(candidate, timezone), target)) return null;
  for (const delta of [-60, 60]) {
    if (sameParts(localPartsAt(new Date(candidate.getTime() + delta * 60_000), timezone), target)) return null;
  }
  return candidate;
}
