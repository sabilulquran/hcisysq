// RPT-001: the scope note and the client's request shaping. Synthetic data.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { currentMonthPeriod, formatReportCell, reportSearchParams, type HrReportAccess } from "@/lib/hrReports";
import { ReportScopeNote } from "@/pages/AdminHrReportsPage";

function access(overrides: Partial<HrReportAccess> = {}): HrReportAccess {
  return {
    scope: { type: "organization", units: [] },
    canExport: true,
    exportScope: { type: "organization", unitIds: [] },
    reports: [],
    filters: { units: [], employmentTypes: [] },
    limits: { maxPeriodDays: 366, exportRowLimit: 50000 },
    ...overrides,
  };
}

describe("RPT-001 Laporan HR screen", () => {
  it("names the scope and whether the account may download", () => {
    const org = renderToStaticMarkup(<ReportScopeNote access={access()} />);
    expect(org).toContain("seluruh organisasi");
    expect(org).toContain("tercatat di audit");
    const unit = renderToStaticMarkup(<ReportScopeNote access={access({
      scope: { type: "unit", units: [{ id: "u1", name: "SDIT Alpha" }] }, canExport: false, exportScope: null,
    })} />);
    expect(unit).toContain("unit SDIT Alpha");
    expect(unit).toContain("hanya untuk melihat");
    expect(unit).toContain("Pimpinan (Laporan)");
  });

  it("sends only the filters a report uses, and never the name search with an export", () => {
    const filters = { unitId: "u1", status: "all" as const, employmentType: "Tetap", from: "2026-10-01", to: "2026-10-31", q: "Siti" };
    expect(reportSearchParams("employees", filters, { page: "1" }).toString())
      .toBe("page=1&unitId=u1&status=all&employmentType=Tetap&q=Siti");
    expect(reportSearchParams("leave", filters, { page: "2" }).toString())
      .toBe("page=2&unitId=u1&from=2026-10-01&to=2026-10-31&q=Siti");
    expect(reportSearchParams("leave", filters, { format: "csv" }).toString())
      .toBe("format=csv&unitId=u1&from=2026-10-01&to=2026-10-31");
  });

  it("defaults to the current Jakarta month and formats cells", () => {
    expect(currentMonthPeriod(new Date("2026-02-28T18:00:00Z"))).toEqual({ from: "2026-03-01", to: "2026-03-31" });
    expect(currentMonthPeriod(new Date("2024-02-10T00:00:00Z"))).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(formatReportCell({ key: "h", label: "Jam", kind: "number" }, 1.5)).toBe("1,5");
    expect(formatReportCell({ key: "d", label: "Tanggal", kind: "date" }, "2026-10-05")).toBe("5 Okt 2026");
    expect(formatReportCell({ key: "t", label: "Unit", kind: "text" }, null)).toBe("—");
  });
});
