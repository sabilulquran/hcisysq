import { describe, expect, it, vi } from "vitest";
import { cameraErrorMessage, locationErrorMessage, mobileRequestError, prepareMobileClockAttempt } from "@/lib/mobileCapture";

const input = { action: "check_in" as const, latitude: -6.7, longitude: 108.55, accuracyMeters: 12, photoBase64: "synthetic-photo" };

describe("mobile capture attempt identity", () => {
  it("reuses the exact key and payload after an ambiguous failure", () => {
    const createKey = vi.fn(() => "stable-synthetic-attempt");
    const attempt = prepareMobileClockAttempt(input, null, createKey);
    expect(Object.isFrozen(attempt)).toBe(true);
    const retry = prepareMobileClockAttempt({ ...input }, attempt, createKey);
    expect(retry).toBe(attempt);
    expect(retry.idempotencyKey).toBe("stable-synthetic-attempt");
    expect(createKey).toHaveBeenCalledTimes(1);
  });
  it("does not silently reuse or replace an outstanding attempt for changed evidence", () => {
    const attempt = prepareMobileClockAttempt(input, null, () => "first");
    for (const changed of [{ ...input, action: "check_out" as const }, { ...input, photoBase64: "other-photo" }, { ...input, latitude: -6.8 }]) {
      expect(() => prepareMobileClockAttempt(changed, attempt)).toThrow("Selesaikan pengiriman sebelumnya");
    }
    expect(prepareMobileClockAttempt(input, null, () => "explicit-new").idempotencyKey).toBe("explicit-new");
  });
});

describe("capture failures are actionable and preserve diagnostic codes", () => {
  it("distinguishes denied, unavailable and timed-out location", () => {
    expect(locationErrorMessage(1)).toContain("Izin lokasi ditolak");
    expect(locationErrorMessage(2)).toContain("belum dapat ditemukan");
    expect(locationErrorMessage(3)).toContain("batas waktu");
  });
  it("distinguishes a missing webcam from permission denial", () => {
    expect(cameraErrorMessage({ name: "NotFoundError" })).toContain("tidak memiliki kamera");
    expect(cameraErrorMessage({ name: "NotAllowedError" })).toContain("Izin kamera ditolak");
    expect(cameraErrorMessage({ name: "NotReadableError" })).toContain("aplikasi lain");
  });
  it("keeps the server error code without rendering SQL/internal error messages", () => {
    const cause = Object.assign(new Error("sensitive internal SQL detail"), { status: 500, code: "42703" });
    const message = mobileRequestError(cause);
    expect(message).toContain("HTTP 500 / 42703");
    expect(message).not.toContain("sensitive internal");
    expect(mobileRequestError(new TypeError("Failed to fetch"))).toContain("belum pasti");
  });
});
