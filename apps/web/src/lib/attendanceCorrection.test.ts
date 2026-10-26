import { describe, expect, it } from "vitest";

import { correctionTimestamps } from "@/lib/attendanceCorrection";

describe("Koreksi HC timestamps", () => {
  it("puts both times on the selected work date in WIB", () => {
    expect(correctionTimestamps({ date: "2026-10-20", checkIn: "08:00", checkOut: "16:00", checkOutNextDay: false })).toEqual({
      checkInAt: "2026-10-20T01:00:00.000Z", checkOutAt: "2026-10-20T09:00:00.000Z", error: null,
    });
  });

  it("moves only the check-out to the next day when marked +1 hari", () => {
    expect(correctionTimestamps({ date: "2026-10-20", checkIn: "21:00", checkOut: "05:00", checkOutNextDay: true })).toEqual({
      checkInAt: "2026-10-20T14:00:00.000Z", checkOutAt: "2026-10-20T22:00:00.000Z", error: null,
    });
  });

  it("asks for +1 hari when the check-out is earlier than the check-in", () => {
    expect(correctionTimestamps({ date: "2026-10-20", checkIn: "21:00", checkOut: "05:00", checkOutNextDay: false }).error)
      .toMatch(/keesokan hari/);
  });

  it("rejects more than 24 hours and allows a single time", () => {
    expect(correctionTimestamps({ date: "2026-10-20", checkIn: "07:00", checkOut: "08:00", checkOutNextDay: true }).error).toMatch(/24 jam/);
    expect(correctionTimestamps({ date: "2026-10-20", checkIn: "", checkOut: "16:00", checkOutNextDay: false })).toEqual({
      checkInAt: null, checkOutAt: "2026-10-20T09:00:00.000Z", error: null,
    });
  });
});
