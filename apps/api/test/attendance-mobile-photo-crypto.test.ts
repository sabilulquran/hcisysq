import { describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import {
  decryptMobileAttendancePhoto,
  encryptMobileAttendancePhoto,
  restrictedMediaReady,
} from "../src/modules/attendance/restricted-media-crypto.js";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x01, 0x02, 0x03]);

const config = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://test",
  AUTH_MODE: "local",
  AUTH_SESSION_TTL_HOURS: 8,
  BIOMETRIC_COLLECTION_ENABLED: "0",
  BIOMETRIC_ACTIVE_KEY_ID: "test-key",
  BIOMETRIC_ENCRYPTION_KEYS: JSON.stringify({ "test-key": "11".repeat(32) }),
  MOBILE_ATTENDANCE_ENABLED: "1",
} as ApiConfig;

describe("ATT-006 mobile attendance restricted media", () => {
  it("encrypts and decrypts JPEG without storing plaintext", () => {
    const context = {
      evidenceId: "00000000-0000-4000-8000-000000000001",
      employeeId: "00000000-0000-4000-8000-000000000002",
      eventId: "00000000-0000-4000-8000-000000000003",
    };
    expect(restrictedMediaReady(config)).toBe(true);
    const encrypted = encryptMobileAttendancePhoto(jpeg, context, config);
    expect(encrypted.ciphertext.equals(jpeg)).toBe(false);
    expect(encrypted.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(decryptMobileAttendancePhoto(encrypted, context, config)).toEqual(jpeg);
  });

  it("binds ciphertext to the exact employee/evidence context", () => {
    const context = {
      evidenceId: "00000000-0000-4000-8000-000000000001",
      employeeId: "00000000-0000-4000-8000-000000000002",
      eventId: "00000000-0000-4000-8000-000000000003",
    };
    const encrypted = encryptMobileAttendancePhoto(jpeg, context, config);
    expect(() => decryptMobileAttendancePhoto(encrypted, {
      ...context,
      employeeId: "00000000-0000-4000-8000-000000000099",
    }, config)).toThrow();
  });

  it("rejects non-JPEG payloads", () => {
    expect(() => encryptMobileAttendancePhoto(Buffer.from("not-a-jpeg"), {
      evidenceId: "00000000-0000-4000-8000-000000000001",
      employeeId: "00000000-0000-4000-8000-000000000002",
      eventId: "00000000-0000-4000-8000-000000000003",
    }, config)).toThrow("JPEG");
  });
});
