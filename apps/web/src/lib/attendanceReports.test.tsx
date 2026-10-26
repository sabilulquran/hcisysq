import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReportTableView } from "@/components/attendance/reports/ReportTableView";
import {
  parseReportPrintSearch,
  reportCellText,
  reportPrintHref,
  reportWarningText,
  type AttendanceReportTable,
} from "@/lib/attendanceReports";
import { printCss } from "@/lib/reportPrintCss";

// ATT-014 §19.2 report preview and print document. Synthetic data only.

const table: AttendanceReportTable = {
  model: "daily_grid",
  title: "Laporan Harian (Grid Bulanan)",
  orientation: "landscape",
  columns: [
    { key: "employeeNumber", label: "NIP" }, { key: "employeeName", label: "Nama" },
    { key: "d:2026-10-03", label: "3 Sab", align: "center", weekend: true }, { key: "percent", label: "Presensi %", align: "right" },
  ],
  groups: [
    { unitName: "SDIT", rows: [{ employeeNumber: "SYN-1", employeeName: "Pegawai A", "d:2026-10-03": "L", percent: 66.7 }], subtotal: { employeeNumber: "Jumlah SDIT", percent: 66.7 } },
    { unitName: "SMPIT", rows: [{ employeeNumber: "SYN-2", employeeName: "Pegawai B", "d:2026-10-03": "L", percent: null }], subtotal: null },
  ],
  total: { employeeNumber: "Jumlah seluruhnya", percent: 66.7 },
  legend: [{ symbol: "L", label: "Libur" }],
  header: { scope: "Unit: Semua unit", period: "Periode 2026-10-01 s/d 2026-10-31", printedBy: "hc@example.invalid", printedAt: "26 Oktober 2026" },
  warnings: { notCalculated: 3, changed: 0, provisional: true },
  from: "2026-10-01",
  to: "2026-10-31",
};

describe("ATT-014 report print address", () => {
  it("round-trips the scope and model through the print document address", () => {
    const href = reportPrintHref({ from: "2026-10-01", to: "2026-10-31", unitId: "unit-1" }, "employee_summary");
    expect(href.startsWith("/admin/attendance/reports/print?")).toBe(true);
    expect(parseReportPrintSearch(href.split("?")[1]!)).toEqual({ model: "employee_summary", scope: { from: "2026-10-01", to: "2026-10-31", unitId: "unit-1" } });
  });

  it("refuses an incomplete or unknown address", () => {
    expect(parseReportPrintSearch("model=daily_grid&from=2026-10-01")).toBeNull();
    expect(parseReportPrintSearch("model=payroll&from=2026-10-01&to=2026-10-02")).toBeNull();
  });
});

describe("ATT-014 report rendering", () => {
  it("formats numbers the Indonesian way and leaves empty cells blank", () => {
    expect(reportCellText(66.7)).toBe("66,7");
    expect(reportCellText(null)).toBe("");
    expect(reportWarningText(table.warnings)).toBe("Perhatian: 3 pegawai-hari belum ditarik, hari ini masih hasil sementara.");
    expect(reportWarningText({ notCalculated: 0, changed: 0, provisional: false })).toBeNull();
  });

  it("renders one table per unit with its own heading row, subtotals, total and legend", () => {
    const html = renderToStaticMarkup(<ReportTableView table={table} print />);
    expect(html.match(/<thead>/g)).toHaveLength(2);
    expect(html).toContain("Jumlah SDIT");
    expect(html).toContain("Jumlah seluruhnya");
    expect(html).toContain("report-weekend");
    expect(html).toContain("L = Libur");
    expect(html).not.toMatch(/<nav|<aside/);
  });

  it("prints A4 in the model orientation, repeats headings and starts each unit on a new page", () => {
    const css = printCss("landscape");
    expect(css).toContain("size: A4 landscape");
    expect(css).toContain("thead { display: table-header-group; }");
    expect(css).toContain("break-inside: avoid");
    expect(css).toContain(".report-group + .report-group { break-before: page;");
    expect(css).toContain("counter(pages)");
    expect(printCss("portrait")).toContain("size: A4 portrait");
  });
});
