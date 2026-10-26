import { describe, expect, it } from "vitest";

import { canClarifyDate } from "@/lib/workforceAttendance";

// ATT-011-7 §8: Riwayat offers "Ajukan klarifikasi" on late, incomplete and absent days, today and up to
// 7 days back. The server enforces the same window (CLARIFICATION_DATE_OUT_OF_RANGE).

describe("ATT-011-7 clarification from Riwayat", () => {
  it("offers it for the problem statuses within the last 7 days only", () => {
    expect(canClarifyDate("2026-10-26", "2026-10-26", "late")).toBe(true);
    expect(canClarifyDate("2026-10-19", "2026-10-26", "incomplete")).toBe(true);
    expect(canClarifyDate("2026-10-18", "2026-10-26", "absent")).toBe(false);
    expect(canClarifyDate("2026-10-27", "2026-10-26", "absent")).toBe(false);
    expect(canClarifyDate("2026-10-25", "2026-10-26", "present")).toBe(false);
    expect(canClarifyDate("2026-10-25", "2026-10-26", undefined)).toBe(false);
  });
});
