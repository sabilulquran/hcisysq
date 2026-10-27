// NOTIF-002 pure domain helpers. No database, synthetic data only.

import { describe, expect, it } from "vitest";

import { jakartaDate, visibleState } from "../src/modules/announcements/service.js";

const now = new Date("2026-10-27T03:00:00Z"); // 10:00 WIB

function row(over: Partial<{ status: string; publishAt: string | null; displayUntil: string | null }>) {
  return { status: "PUBLISHED", publishAt: null, displayUntil: null, ...over };
}

describe("NOTIF-002 derived visibility (N-07/N-08)", () => {
  it("hides a draft and a schedule whose moment has not arrived", () => {
    expect(visibleState(row({ status: "DRAFT" }), now)).toBe("HIDDEN");
    expect(visibleState(row({ status: "SCHEDULED", publishAt: "2026-10-28T00:00:00Z" }), now)).toBe("HIDDEN");
  });

  it("marks a passed schedule DUE, never PUBLISHED, because nobody has received it", () => {
    // N-07: Package 1 has no auto-publication; recipients exist only after an explicit
    // publish, so a passed moment is a reminder to the operator, not a publication.
    expect(visibleState(row({ status: "SCHEDULED", publishAt: "2026-10-27T02:00:00Z" }), now)).toBe("DUE");
  });

  it("archives a published announcement past its display window", () => {
    expect(visibleState(row({ displayUntil: "2026-10-26" }), now)).toBe("ARCHIVED");
    expect(visibleState(row({ displayUntil: "2026-10-27" }), now)).toBe("PUBLISHED");
  });

  it("keeps an explicit archive and a correction distinguishable", () => {
    expect(visibleState(row({ status: "ARCHIVED" }), now)).toBe("ARCHIVED");
    expect(visibleState(row({ status: "SUPERSEDED" }), now)).toBe("SUPERSEDED");
  });

  it("reads the display window on the Jakarta calendar", () => {
    // 2026-10-26T23:00Z is already 27 October in Jakarta, so a window ending the 26th is over.
    const earlyMorning = new Date("2026-10-26T23:00:00Z");
    expect(jakartaDate(earlyMorning)).toBe("2026-10-27");
    expect(visibleState(row({ displayUntil: "2026-10-26" }), earlyMorning)).toBe("ARCHIVED");
  });
});
