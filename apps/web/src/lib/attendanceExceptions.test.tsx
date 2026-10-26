import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CalculationDialog } from "@/components/attendance/reports/ReportExtraTabs";
import type { AttendanceCalculationRun } from "@/lib/attendanceCalculation";
import { exportModelForTab } from "@/lib/attendanceExceptions";

// ATT-014 §20.2 (R2b) single-window Laporan. Synthetic data only.

const run = {
  id: "run", status: "running", position: null, unitId: null, employeeId: null, from: "2026-10-01", to: "2026-10-26",
  totalPairs: 346, processedPairs: 218, failedPairs: 0, uncoveredPairs: 12, cancelRequested: false, errorCode: null,
  requestedByAccountId: "a", createdAt: "2026-10-26T02:00:00Z", startedAt: "2026-10-26T02:00:01Z", finishedAt: null,
} as unknown as AttendanceCalculationRun;

describe("R2b Laporan dan Kalkulasi", () => {
  it("exports the server model behind the Harian and Rekapitulasi tabs only", () => {
    expect(exportModelForTab("detail")).toBe("daily_detail");
    expect(exportModelForTab("summary")).toBe("employee_summary");
    for (const tab of ["transactions", "exceptions", "overtime", "unscheduled"]) expect(exportModelForTab(tab)).toBeNull();
  });

  it("shows progress with Batal while running and no close button", () => {
    const html = renderToStaticMarkup(<CalculationDialog run={run} onCancel={vi.fn()} onClose={vi.fn()} />);
    expect(html).toContain("Menghitung");
    expect(html).toContain("63% (218 dari 346 pegawai-hari) · 12 tidak tercatat");
    expect(html).toContain("Batal");
    expect(html).not.toContain("Tutup");
  });

  it("offers Tutup once the run stopped", () => {
    const html = renderToStaticMarkup(<CalculationDialog run={{ ...run, status: "failed", finishedAt: "2026-10-26T02:01:00Z" } as AttendanceCalculationRun} onCancel={vi.fn()} onClose={vi.fn()} />);
    expect(html).toContain("Tutup");
    expect(html).not.toContain(">Batal<");
  });
});
