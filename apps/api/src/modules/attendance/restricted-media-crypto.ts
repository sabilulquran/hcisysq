import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { ApiConfig } from "../../config/env.js";

const KEY_PATTERN = /^[a-fA-F0-9]{64}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

type Keyring = { activeKeyId: string; keys: Map<string, Buffer> };

export type EncryptedRestrictedMedia = {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyId: string;
  sha256: string;
  byteLength: number;
};

function keyring(config: ApiConfig): Keyring {
  const activeKeyId = config.BIOMETRIC_ACTIVE_KEY_ID?.trim();
  if (!activeKeyId || !KEY_ID_PATTERN.test(activeKeyId) || !config.BIOMETRIC_ENCRYPTION_KEYS) {
    throw new Error("Restricted-media keyring is not configured");
  }
  const parsed = JSON.parse(config.BIOMETRIC_ENCRYPTION_KEYS) as Record<string, unknown>;
  const keys = new Map<string, Buffer>();
  for (const [id, value] of Object.entries(parsed)) {
    if (!KEY_ID_PATTERN.test(id) || typeof value !== "string" || !KEY_PATTERN.test(value)) {
      throw new Error("Restricted-media keyring contains an invalid entry");
    }
    keys.set(id, Buffer.from(value, "hex"));
  }
  if (!keys.has(activeKeyId)) throw new Error("Restricted-media active key is unavailable");
  return { activeKeyId, keys };
}

function aad(input: { evidenceId: string; employeeId: string; eventId: string }) {
  return Buffer.from(
    JSON.stringify(["HCIS_ATTENDANCE_MOBILE_PHOTO_V1", input.evidenceId, input.employeeId, input.eventId]),
    "utf8",
  );
}

export function restrictedMediaReady(config: ApiConfig): boolean {
  try {
    keyring(config);
    return true;
  } catch {
    return false;
  }
}

export function encryptMobileAttendancePhoto(
  payload: Buffer,
  context: { evidenceId: string; employeeId: string; eventId: string },
  config: ApiConfig,
): EncryptedRestrictedMedia {
  if (payload.length < 1 || payload.length > MAX_PHOTO_BYTES) {
    throw new Error("Attendance photo size is outside the supported boundary");
  }
  if (payload[0] !== 0xff || payload[1] !== 0xd8 || payload[2] !== 0xff) {
    throw new Error("Attendance photo must be JPEG");
  }
  const ring = keyring(config);
  const key = ring.keys.get(ring.activeKeyId)!;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  return {
    ciphertext,
    iv,
    authTag: cipher.getAuthTag(),
    keyId: ring.activeKeyId,
    sha256: createHash("sha256").update(payload).digest("hex"),
    byteLength: payload.length,
  };
}

export function decryptMobileAttendancePhoto(
  encrypted: EncryptedRestrictedMedia,
  context: { evidenceId: string; employeeId: string; eventId: string },
  config: ApiConfig,
): Buffer {
  const ring = keyring(config);
  const key = ring.keys.get(encrypted.keyId);
  if (!key) throw new Error("Restricted-media encryption key is unavailable");
  const decipher = createDecipheriv("aes-256-gcm", key, encrypted.iv);
  decipher.setAAD(aad(context));
  decipher.setAuthTag(encrypted.authTag);
  const plaintext = Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
  const expected = Buffer.from(encrypted.sha256, "hex");
  const actual = createHash("sha256").update(plaintext).digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("Attendance photo integrity check failed");
  }
  if (plaintext.length !== encrypted.byteLength) throw new Error("Attendance photo length check failed");
  return plaintext;
}
