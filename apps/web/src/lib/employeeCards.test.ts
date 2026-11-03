// EMP-012 client helpers. Synthetic values only.

import { describe, expect, it } from "vitest";

import { formatCode, formatDate, formatInstantDate, qrPath, verifyUrl } from "./employeeCards";

describe("EMP-012 card helpers", () => {
  it("D-07: the QR opens the check page on the given origin", () => {
    expect(verifyUrl("7Q2M9XPA4K", "https://hcis.sabilulquran.or.id")).toBe("https://hcis.sabilulquran.or.id/cek/7Q2M9XPA4K");
    expect(formatCode("7Q2M9XPA4K")).toBe("7Q2M9-XPA4K");
  });

  it("encodes a QR without quiet zone as one path of dark modules", () => {
    const qr = qrPath("https://hcis.sabilulquran.or.id/cek/7Q2M9XPA4K");
    expect(qr.size).toBeGreaterThanOrEqual(21);
    // The top-left finder pattern starts dark at 0,0.
    expect(qr.path.startsWith("M0 0h1v1h-1z")).toBe(true);
    expect(qr.path).toMatch(/^(M\d+ \d+h1v1h-1z)+$/);
  });

  it("formats calendar dates without the browser time zone", () => {
    expect(formatDate("2028-11-30")).toBe("30 Nov 2028");
    expect(formatDate("2026-01-05T00:00:00.000Z")).toBe("5 Jan 2026");
    expect(formatInstantDate("2026-12-01T18:30:00Z")).toBe("2 Des 2026");
  });
});
