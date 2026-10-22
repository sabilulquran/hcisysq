import { createHash } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import type { ApiConfig } from "../../../config/env.js";
import {
  importMappedPassiveBiometrics,
  parsePassiveBiometricCandidates,
  type PassiveBiometricCandidate,
} from "./biometric-ingress.js";
import {
  importMappedUnifiedBiometrics,
  parseAttendancePhotoBody,
  parseUnifiedBiometricCandidates,
  persistEncryptedAttendancePhoto,
  type ParsedAttendancePhoto,
  type UnifiedBiometricCandidate,
} from "./physical-parity-ingress.js";
import {
  ADMS_HARD_MAX_BODY_BYTES,
  ADMS_MAX_BODY_BYTES,
  attlogAcknowledgementBody,
  deviceTimeResponseBody,
  extractAttlogStamp,
  extractSerialCandidate,
  getRequestIdleAcknowledgementBody,
  optionsAllHandshakeBody,
  parseDeviceCommandResultText,
  type AttlogQuarantine,
  type ParsedDeviceCommandResult,
} from "./protocol.js";
import { projectAdmsRequest } from "./projection.js";
import { getAdmsAttlogTransferStamp, persistAdmsIngress } from "./repository.js";
import { observeDeviceRosterEntries } from "./roster.js";
import { observeDetectedAdmsDevice } from "./wave1.js";
import {
  deviceDataAcknowledgementBody,
  extractProtocolTable,
  isAttlogDeviceData,
  isSensitiveProtocolTable,
  parseSafeDeviceRosterRecords,
  shouldRedactDeviceDataBody,
  type SafeDeviceRosterRecord,
} from "./wave2-protocol.js";

function directHostname(hostHeader: string | undefined): string | null {
  if (!hostHeader || hostHeader.includes(",")) return null;
  try {
    return new URL(`http://${hostHeader.trim()}`).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

function safeHeader(value: string | string[] | undefined, max = 512) {
  const first = Array.isArray(value) ? value[0] : value;
  if (!first) return null;
  const compact = Array.from(first, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? " " : character;
  })
    .join("")
    .trim();
  return compact ? compact.slice(0, max) : null;
}

function sourceIp(request: FastifyRequest) {
  const forwarded = safeHeader(request.headers["x-forwarded-for"]);
  const candidate = forwarded?.split(",")[0]?.trim() ?? request.ip ?? null;
  return candidate && /^[0-9A-Fa-f:.]{1,45}$/.test(candidate) ? candidate : null;
}

function acceptsUtf8(contentType: string | null, contentEncoding: string | null) {
  if (contentEncoding && !/^identity$/i.test(contentEncoding.trim())) return false;
  if (!contentType) return true;
  const charset = /charset\s*=\s*([^;\s]+)/i.exec(contentType)?.[1]?.replace(/["']/g, "");
  return !charset || /^utf-?8$/i.test(charset);
}

type CapturedBody = {
  body: Buffer | null;
  bodySha256: string;
  bodyByteLength: number;
  bodyCaptured: boolean;
};

function asCapturedBody(value: unknown): CapturedBody {
  if (
    value &&
    typeof value === "object" &&
    "bodyByteLength" in value &&
    "bodyCaptured" in value &&
    "bodySha256" in value
  ) {
    return value as CapturedBody;
  }
  return {
    body: Buffer.alloc(0),
    bodySha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
    bodyByteLength: 0,
    bodyCaptured: true,
  };
}

async function pushFlags(pool: Pool, config: ApiConfig, serialNumber: string | null) {
  if (!serialNumber) return { attendancePhoto: false, biometric: false };
  const result = await pool.query<{
    collectionEnabled: boolean;
    attendancePhotoState: string | null;
  }>(
    `SELECT
       d.biometric_collection_enabled AS "collectionEnabled",
       c.state AS "attendancePhotoState"
     FROM attendance_adms_devices d
     LEFT JOIN attendance_adms_physical_capabilities c
       ON c.device_id = d.id AND c.capability_key = 'attendance_photo'
     WHERE d.serial_number = $1 AND d.lifecycle = 'active'
     LIMIT 1`,
    [serialNumber],
  );
  const row = result.rows[0];
  return {
    attendancePhoto: Boolean(row && ["canary_pending", "verified"].includes(row.attendancePhotoState ?? "")),
    biometric: Boolean(row?.collectionEnabled && config.BIOMETRIC_COLLECTION_ENABLED === "1"),
  };
}

function handshakeWithPushFlags(base: string | null, flags: { attendancePhoto: boolean; biometric: boolean }) {
  if (!base) return null;
  const transFlags = ["TransData", "AttLog"];
  if (flags.biometric) transFlags.push("OpLog");
  if (flags.attendancePhoto) transFlags.push("AttPhoto");
  return base.replace(/^TransFlag=.*$/m, `TransFlag=${transFlags.join("\t")}`);
}

export async function registerAdmsIngressRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
) {
  await app.register(async (adms) => {
    adms.removeAllContentTypeParsers();
    adms.addContentTypeParser("*", (_request, payload, done) => {
      const hash = createHash("sha256");
      const chunks: Buffer[] = [];
      let length = 0;
      let captured = true;

      const onData = (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += buffer.length;
        if (length > ADMS_HARD_MAX_BODY_BYTES) {
          payload.removeListener("data", onData);
          payload.removeListener("end", onEnd);
          done(Object.assign(new Error("ADMS request body exceeds the hard limit"), {
            statusCode: 413,
            code: "ADMS_BODY_TOO_LARGE",
          }), undefined);
          return;
        }
        hash.update(buffer);
        if (length <= ADMS_MAX_BODY_BYTES) chunks.push(buffer);
        else captured = false;
      };
      const onEnd = () => {
        done(null, {
          body: captured ? Buffer.concat(chunks, length) : null,
          bodySha256: hash.digest("hex"),
          bodyByteLength: length,
          bodyCaptured: captured,
        } satisfies CapturedBody);
      };
      payload.on("data", onData);
      payload.on("end", onEnd);
      payload.on("error", done);
    });

    adms.all("/iclock/*", async (request, reply) => {
      const expectedHost = config.ADMS_INGRESS_HOST?.toLowerCase().replace(/\.$/, "");
      if (!expectedHost || directHostname(request.headers.host) !== expectedHost) {
        return reply.status(404).send();
      }

      const url = new URL(request.raw.url ?? "/", `http://${request.headers.host}`);
      const receivedAt = new Date();
      const contentType = safeHeader(request.headers["content-type"]);
      const contentEncoding = safeHeader(request.headers["content-encoding"]);
      const capture = asCapturedBody(request.body);
      const protocolTable = extractProtocolTable(url);
      const safeMetadata: Record<string, string> = {};
      const userAgent = safeHeader(request.headers["user-agent"]);
      const accept = safeHeader(request.headers.accept);
      if (userAgent) safeMetadata.userAgent = userAgent;
      if (accept) safeMetadata.accept = accept;
      if (contentEncoding) safeMetadata.contentEncoding = contentEncoding;
      if (protocolTable) safeMetadata.protocolTable = protocolTable;
      for (const key of ["pushver", "PushVersion", "language", "cmdid", "packcnt", "packidx"]) {
        const value = url.searchParams.get(key);
        if (value && value.length <= 128) safeMetadata[key] = value;
      }

      const quarantines: AttlogQuarantine[] = [];
      const commandResults: ParsedDeviceCommandResult[] = [];
      let attlogText: string | null = null;
      let decodedDeviceText: string | null = null;
      let observedRosterRecords: SafeDeviceRosterRecord[] = [];
      let passiveBiometricCandidates: PassiveBiometricCandidate[] = [];
      let unifiedBiometricCandidates: UnifiedBiometricCandidate[] = [];
      let attendancePhoto: ParsedAttendancePhoto | null = null;
      let redactJournalBody = false;
      let classification = "protocol_discovery";

      const isAttendancePhoto =
        request.method === "POST" &&
        url.pathname === "/iclock/cdata" &&
        protocolTable === "ATTPHOTO";
      if (capture.body && capture.body.length > 0 && isAttendancePhoto) {
        redactJournalBody = true;
        attendancePhoto = parseAttendancePhotoBody(capture.body);
        classification = attendancePhoto ? "attendance_photo" : "attendance_photo_rejected";
        safeMetadata.bodyRedaction = "sensitive_device_data_redacted";
        safeMetadata.attendancePhotoParsed = attendancePhoto ? "true" : "false";
      } else if (capture.body && capture.body.length > 0) {
        if (!acceptsUtf8(contentType, contentEncoding)) {
          classification = "unsupported_encoding";
          const nonAttendanceData =
            request.method === "POST" &&
            ["/iclock/cdata", "/iclock/querydata"].includes(url.pathname) &&
            protocolTable !== "ATTLOG";
          if (nonAttendanceData) {
            redactJournalBody = true;
            safeMetadata.bodyRedaction = isSensitiveProtocolTable(protocolTable)
              ? "sensitive_device_data_redacted"
              : "device_data_redacted";
          }
          quarantines.push({ reason: "UNSUPPORTED_ENCODING", rawLine: "", details: {} });
        } else {
          try {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(capture.body);
            decodedDeviceText = text;
            if (request.method === "POST" && url.pathname === "/iclock/devicecmd") {
              classification = "device_command_result";
              const parsed = parseDeviceCommandResultText(text);
              commandResults.push(...parsed.results);
              quarantines.push(...parsed.quarantines);
            } else if (
              request.method === "POST" &&
              url.pathname === "/iclock/cdata" &&
              isAttlogDeviceData({ table: protocolTable, text })
            ) {
              classification = "attlog";
              attlogText = text;
            } else if (
              request.method === "POST" &&
              (
                (url.pathname === "/iclock/querydata" && protocolTable === "BIODATA") ||
                (url.pathname === "/iclock/cdata" && url.searchParams.get("type")?.toLowerCase() === "biodata")
              )
            ) {
              redactJournalBody = true;
              classification = "sensitive_device_data_redacted";
              safeMetadata.bodyRedaction = classification;
              const parsed = parseUnifiedBiometricCandidates(text);
              unifiedBiometricCandidates = parsed.records;
              safeMetadata.biometricRecordCount = String(parsed.records.length);
              safeMetadata.biometricRejectedRecordCount = String(parsed.rejectedRecords);
            } else if (
              shouldRedactDeviceDataBody({
                method: request.method,
                path: url.pathname,
                table: protocolTable,
                text,
              })
            ) {
              redactJournalBody = true;
              classification = isSensitiveProtocolTable(protocolTable)
                ? "sensitive_device_data_redacted"
                : "device_data_redacted";
              safeMetadata.bodyRedaction = classification;
              if (protocolTable === "OPERLOG" || protocolTable === "USERINFO") {
                observedRosterRecords = parseSafeDeviceRosterRecords(text);
                if (observedRosterRecords.length > 0) {
                  safeMetadata.safeRosterRecordCount = String(observedRosterRecords.length);
                }
              }
              if (protocolTable === "OPERLOG") {
                const parsedBiometrics = parsePassiveBiometricCandidates(text, protocolTable);
                passiveBiometricCandidates = parsedBiometrics.records;
                if (parsedBiometrics.records.length > 0) {
                  safeMetadata.biometricRecordCount = String(parsedBiometrics.records.length);
                }
                if (parsedBiometrics.rejectedRecords > 0) {
                  safeMetadata.biometricRejectedRecordCount = String(parsedBiometrics.rejectedRecords);
                }
              }
            }
          } catch {
            classification = "unsupported_encoding";
            const nonAttendanceData =
              request.method === "POST" &&
              ["/iclock/cdata", "/iclock/querydata"].includes(url.pathname) &&
              protocolTable !== "ATTLOG";
            if (nonAttendanceData) {
              redactJournalBody = true;
              safeMetadata.bodyRedaction = isSensitiveProtocolTable(protocolTable)
                ? "sensitive_device_data_redacted"
                : "device_data_redacted";
            }
            quarantines.push({ reason: "UNSUPPORTED_ENCODING", rawLine: "", details: {} });
          }
        }
      }

      if (
        !capture.bodyCaptured &&
        capture.bodyByteLength > 0 &&
        request.method === "POST" &&
        ["/iclock/cdata", "/iclock/querydata"].includes(url.pathname)
      ) {
        safeMetadata.bodyCapture = "hash_only_oversize";
        if (protocolTable === "ATTLOG") {
          classification = "attlog_oversize_rejected";
        } else {
          redactJournalBody = true;
          classification = isSensitiveProtocolTable(protocolTable)
            ? "sensitive_device_data_redacted"
            : "device_data_redacted";
          safeMetadata.bodyRedaction = classification;
        }
      }

      const serialCandidate = extractSerialCandidate(url);
      const requestSourceIp = sourceIp(request);
      await observeDetectedAdmsDevice(pool, {
        serialNumber: serialCandidate,
        sourceIp: requestSourceIp,
        receivedAt,
        safeMetadata,
      });

      const attlogStamp = extractAttlogStamp(url);
      const configuredAttlogStamp = serialCandidate
        ? await getAdmsAttlogTransferStamp(pool, serialCandidate)
        : null;
      const flags = await pushFlags(pool, config, serialCandidate);
      const baseHandshake = optionsAllHandshakeBody(url, serialCandidate, configuredAttlogStamp ?? "None");
      const timeBody = deviceTimeResponseBody(url, receivedAt);
      const queryDataAck =
        request.method === "POST" && url.pathname === "/iclock/querydata" && protocolTable === "BIODATA"
          ? `biophoto=${unifiedBiometricCandidates.length}`
          : null;
      const successResponseBody =
        request.method === "GET"
          ? timeBody ?? handshakeWithPushFlags(baseHandshake, flags) ?? getRequestIdleAcknowledgementBody(url)
          : url.pathname === "/iclock/devicecmd"
            ? "OK"
            : queryDataAck ?? (attlogText
              ? attlogAcknowledgementBody(attlogText)
              : redactJournalBody
                ? decodedDeviceText !== null
                  ? deviceDataAcknowledgementBody(decodedDeviceText)
                  : "OK"
                : null);

      if (timeBody) classification = "time_sync";

      const result = await persistAdmsIngress(pool, {
        receivedAt,
        method: request.method,
        path: url.pathname,
        rawQuery: url.search,
        contentType,
        sourceIp: requestSourceIp,
        safeMetadata,
        serialCandidate,
        body: redactJournalBody ? null : capture.body,
        bodySha256: capture.bodySha256,
        bodyByteLength: capture.bodyByteLength,
        bodyCaptured: capture.bodyCaptured,
        classification,
        attlogText,
        attlogStamp,
        commandResults,
        quarantines,
        successResponseBody,
      }, config);

      if (result.accepted && result.deviceId && observedRosterRecords.length > 0) {
        try {
          await observeDeviceRosterEntries(pool, {
            deviceId: result.deviceId,
            sourceRequestId: result.requestId,
            observedAt: receivedAt,
            records: observedRosterRecords,
          });
        } catch (error) {
          request.log.error(
            {
              error: error instanceof Error ? error.message : "unknown roster observation error",
              requestId: result.requestId,
              deviceId: result.deviceId,
            },
            "ADMS safe roster observation failed after redacted durable capture",
          );
        }
      }

      if (result.accepted && result.deviceId && passiveBiometricCandidates.length > 0) {
        await importMappedPassiveBiometrics(pool, config, {
          deviceId: result.deviceId,
          sourceRequestId: result.requestId,
          observedAt: receivedAt,
          records: passiveBiometricCandidates,
        });
      }

      if (result.accepted && result.deviceId && unifiedBiometricCandidates.length > 0) {
        await importMappedUnifiedBiometrics(pool, config, {
          deviceId: result.deviceId,
          sourceRequestId: result.requestId,
          observedAt: receivedAt,
          records: unifiedBiometricCandidates,
        });
      }

      if (result.accepted && result.deviceId && attendancePhoto) {
        const stored = await persistEncryptedAttendancePhoto(pool, config, {
          deviceId: result.deviceId,
          sourceRequestId: result.requestId,
          receivedAt,
          photo: attendancePhoto,
        });
        if (!stored.stored) {
          request.log.info(
            { deviceId: result.deviceId, requestId: result.requestId, reason: stored.reason },
            "ADMS attendance photo remained redacted because encrypted storage gate is not ready",
          );
        }
      }

      const projectionRequestIds = new Set(result.recoveredRequestIds);
      if (result.accepted && result.insertedEvents > 0) projectionRequestIds.add(result.requestId);
      for (const projectionRequestId of projectionRequestIds) {
        try {
          await projectAdmsRequest(pool, projectionRequestId);
        } catch (error) {
          request.log.error(
            { err: error, requestId: projectionRequestId, deviceId: result.deviceId },
            "ADMS attendance projection failed after durable capture/recovery",
          );
        }
      }

      reply.header("cache-control", "no-store");
      reply.header("x-content-type-options", "nosniff");
      if (result.responseBody !== null) reply.type("text/plain; charset=utf-8");
      return reply.status(result.responseStatus).send(result.responseBody ?? undefined);
    });
  });
}
