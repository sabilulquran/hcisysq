import { describe, expect, it } from "vitest";

import { calculationRowStatusLabel } from "@/lib/attendanceCalculation";
import { groupByPosition, planAssignments, unattributedStatusLabel, unscheduledReason, type UnscheduledEmployee } from "@/lib/attendanceUnscheduled";

// ATT-014 §20.3 Tanpa Jadwal (R2a). Synthetic employees only.

function employee(overrides: Partial<UnscheduledEmployee>): UnscheduledEmployee {
  return {
    employeeId: "e", employeeNumber: "SYN-1", employeeName: "Pegawai Sintetis", unitName: "SD", position: null,
    days: 3, firstDate: "2026-10-01", lastDate: "2026-10-03", earliestLastScan: "12:01", latestLastScan: "12:20", scheduleStartsOn: null,
    ...overrides,
  };
}

describe("Tanpa Jadwal grouping and wording", () => {
  it("groups by position and shows the last-scan range as information", () => {
    const groups = groupByPosition([
      employee({ employeeId: "a", position: "Guru Tahfizh (Half Day)", earliestLastScan: "12:01", latestLastScan: "12:10" }),
      employee({ employeeId: "b", position: "Guru Tahfizh (Half Day)", earliestLastScan: "11:58", latestLastScan: "13:30" }),
      employee({ employeeId: "c", position: null, earliestLastScan: "16:00", latestLastScan: "16:00" }),
    ]);
    expect(groups.map((group) => [group.position, group.employees.length, group.lastScanRange])).toEqual([
      ["Guru Tahfizh (Half Day)", 2, "11:58–13:30"],
      ["Tanpa jabatan", 1, "16:00"],
    ]);
  });

  it("explains why a day is not judged", () => {
    expect(unscheduledReason({ scheduleStartsOn: null })).toBe("Belum punya pola jadwal");
    expect(unscheduledReason({ scheduleStartsOn: "2026-10-24" })).toBe("Pola jadwal mulai 24 Okt 2026; scan sebelumnya tidak dinilai");
    expect(unattributedStatusLabel("unmapped")).toBe("PIN belum dipetakan");
    expect(unattributedStatusLabel("before_mapping")).toBe("Scan sebelum pemetaan berlaku");
  });

  it("calls a day without any schedule Tanpa jadwal, not Libur", () => {
    expect(calculationRowStatusLabel("unscheduled")).toBe("Tanpa jadwal");
    expect(calculationRowStatusLabel("off")).toBe("Libur");
  });
});

describe("Pasang ke shift yang ada never overlaps an existing pattern", () => {
  it("ends the new pattern the day before the next one and skips covered employees", () => {
    const existing = [
      { employeeId: "later", effectiveFrom: "2026-10-24", effectiveTo: null },
      { employeeId: "covered", effectiveFrom: "2026-09-01", effectiveTo: null },
      { employeeId: "ended", effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30" },
    ];
    expect(planAssignments(["none", "later", "covered", "ended"], existing, "2026-09-01")).toEqual([
      { employeeId: "none", action: "create", from: "2026-09-01", to: null },
      { employeeId: "later", action: "create", from: "2026-09-01", to: "2026-10-23" },
      { employeeId: "covered", action: "skip", reason: "sudah punya pola sejak 2026-09-01" },
      { employeeId: "ended", action: "create", from: "2026-09-01", to: null },
    ]);
  });
});
