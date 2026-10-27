import { describe, expect, it } from "vitest";

import { TODAY_CARDS, todayCardLabel, todayDeltaLabel, todayFactLabel, todayScheduleLabel } from "@/lib/attendanceToday";
import type { AttendanceTodayFact } from "@/lib/workforceAttendance";

const FACTS: AttendanceTodayFact[] = [
  "before_shift", "no_scan", "not_connected", "checked_in", "has_scans", "scan_on_rest_day", "scan_without_schedule", "none",
];

describe("ATT-014-1 Pantauan Hari Ini labels", () => {
  it("never uses a verdict word", () => {
    const words = [
      ...TODAY_CARDS.map(todayCardLabel),
      ...FACTS.map((fact) => todayFactLabel({ fact, scanCount: 2 })),
      ...(["scheduled", "off", "holiday", "unscheduled", "leave", "resolved_absent", "configuration_error"] as const)
        .map((dayKind) => todayScheduleLabel({ dayKind, scheduleName: "Shift Pagi" }, "07:00–16:00")),
    ];
    for (const word of words) expect(word).not.toMatch(/Tidak hadir|Terlambat|Tidak lengkap|Pulang cepat/);
  });

  it("labels every card and falls back to a neutral word", () => {
    for (const card of TODAY_CARDS) expect(todayCardLabel(card)).not.toBe("Lainnya");
    expect(todayCardLabel("absent")).toBe("Lainnya");
  });

  it("separates a missing machine connection from a missing scan", () => {
    expect(todayFactLabel({ fact: "not_connected", scanCount: 0 })).toBe("Belum terhubung mesin");
    expect(todayFactLabel({ fact: "no_scan", scanCount: 0 })).toBe("Belum ada scan");
  });

  it("shows the schedule with its hours", () => {
    expect(todayScheduleLabel({ dayKind: "scheduled", scheduleName: "SDIT — Hari Penuh" }, "07:00–16:00")).toBe("SDIT — Hari Penuh · 07:00–16:00");
    expect(todayScheduleLabel({ dayKind: "unscheduled", scheduleName: null }, null)).toBe("Tanpa jadwal");
  });

  it("formats the start delta neutrally", () => {
    expect(todayDeltaLabel(6)).toBe("+6 mnt");
    expect(todayDeltaLabel(-5)).toBe("−5 mnt");
    expect(todayDeltaLabel(0)).toBe("tepat");
    expect(todayDeltaLabel(null)).toBe("—");
  });
});
