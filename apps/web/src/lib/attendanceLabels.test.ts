import { describe, expect, it } from "vitest";

import { ATTENDANCE_STATUSES, attendanceStatusLabel } from "./attendanceLabels";

describe("attendance status words", () => {
  it("shows the disposition statuses in operator words (ATT-015, TRIP-001 Paket 2)", () => {
    expect(attendanceStatusLabel("field_assignment")).toBe("Tugas luar");
    expect(attendanceStatusLabel("remote_work")).toBe("WFH/WFA");
    expect(attendanceStatusLabel("business_trip")).toBe("Dinas");
  });

  it("never prints a raw enum", () => {
    for (const status of ATTENDANCE_STATUSES) {
      expect(attendanceStatusLabel(status)).not.toBe(status);
    }
    expect(attendanceStatusLabel("something_new")).toBe("Tidak diketahui");
  });
});
