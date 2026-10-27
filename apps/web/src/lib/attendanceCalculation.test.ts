import { describe, expect, it } from "vitest";

import {
  calculationProgress,
  calculationRange,
  calculationRowStatusLabel,
  calculationRunLabel,
  transactionSourceLabel,
  type AttendanceCalculationRun,
} from "@/lib/attendanceCalculation";

// ATT-014-2 Kalkulasi vocabulary and range shortcuts.

const NOW = new Date("2026-10-28T03:00:00Z"); // Wednesday 2026-10-28 in Jakarta

function run(overrides: Partial<AttendanceCalculationRun> = {}): AttendanceCalculationRun {
  return {
    id: "run", status: "running", position: null, unitId: null, employeeId: null, from: "2026-10-01", to: "2026-10-28",
    totalPairs: 200, processedPairs: 50, failedPairs: 0, uncoveredPairs: 0, cancelRequested: false, errorCode: null,
    createdAt: "2026-10-28T03:00:00Z", startedAt: null, finishedAt: null, ...overrides,
  };
}

describe("ATT-014-2 calculation range shortcuts", () => {
  it("never ends after today and uses Monday weeks", () => {
    expect(calculationRange("today", NOW)).toEqual({ from: "2026-10-28", to: "2026-10-28" });
    expect(calculationRange("yesterday", NOW)).toEqual({ from: "2026-10-27", to: "2026-10-27" });
    expect(calculationRange("this_week", NOW)).toEqual({ from: "2026-10-26", to: "2026-10-28" });
    expect(calculationRange("last_week", NOW)).toEqual({ from: "2026-10-19", to: "2026-10-25" });
    expect(calculationRange("this_month", NOW)).toEqual({ from: "2026-10-01", to: "2026-10-28" });
    expect(calculationRange("last_month", NOW)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  });

  it("treats Sunday as the last day of the week", () => {
    expect(calculationRange("this_week", new Date("2026-11-01T03:00:00Z"))).toEqual({ from: "2026-10-26", to: "2026-11-01" });
  });
});

describe("ATT-014-2 calculation vocabulary", () => {
  it("says not captured instead of absent before the machine is connected", () => {
    expect(calculationRowStatusLabel("not_captured")).toBe("Tidak tercatat (belum terhubung mesin)");
    expect(calculationRowStatusLabel("not_calculated")).toBe("Belum dikalkulasi");
    expect(calculationRowStatusLabel("absent")).toBe("Tidak hadir");
  });

  it("describes queue, interruption and partial failure", () => {
    expect(calculationRunLabel(run({ status: "queued", position: 2 }))).toBe("Menunggu giliran (urutan ke-2)");
    expect(calculationRunLabel(run({ status: "failed", errorCode: "INTERRUPTED" }))).toMatch(/terhenti/);
    expect(calculationRunLabel(run({ status: "completed", failedPairs: 3 }))).toMatch(/3 gagal/);
    expect(calculationProgress(run())).toBe(25);
    expect(calculationProgress(run({ status: "completed", totalPairs: 0 }))).toBe(100);
  });
});

describe("ATT-014 §19.1 Data Transaksi source badge", () => {
  it("names every source in operator words", () => {
    expect(transactionSourceLabel({ source: "adms", correctionBy: null, deviceName: "Mesin SDIT" })).toBe("Mesin · Mesin SDIT");
    expect(transactionSourceLabel({ source: "adms", correctionBy: null, deviceName: null })).toBe("Mesin");
    expect(transactionSourceLabel({ source: "mobile", correctionBy: null, deviceName: null })).toBe("HP");
    expect(transactionSourceLabel({ source: "correction", correctionBy: "hc", deviceName: null })).toBe("Koreksi HC");
    expect(transactionSourceLabel({ source: "correction", correctionBy: "employee", deviceName: null })).toBe("Koreksi pegawai");
  });
});
