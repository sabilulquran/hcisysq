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
import { ReportPrintSheet } from "@/pages/AdminAttendanceReportPrintPage";

// ATT-014 §19.2 report preview and print document. Synthetic data only.

const table: AttendanceReportTable = {
  model: "daily_grid",
  title: "Laporan Harian (Grid Bulanan)",
  printTitle: "Laporan Kehadiran Harian",
  orientation: "landscape",
  columns: [
    { key: "employeeNumber", label: "NIP" }, { key: "employeeName", label: "Nama" },
    { key: "d:2026-10-03", label: "3", align: "center", weekend: true }, { key: "present", label: "Hadir", align: "center" },
  ],
  groups: [
    { unitName: "SDIT", rows: [{ employeeNumber: "SYN-1", employeeName: "Pegawai A", "d:2026-10-03": "L", present: 20 }], subtotal: { employeeNumber: "Jumlah SDIT", present: 20 } },
    { unitName: "SMPIT", rows: [{ employeeNumber: "SYN-2", employeeName: "Pegawai B", "d:2026-10-03": "L", present: null }], subtotal: null },
  ],
  total: { employeeNumber: "Jumlah seluruhnya", present: 20 },
  legend: [{ symbol: "L", label: "Libur" }],
  notes: ["Tidak lengkap berarti ada scan masuk tanpa scan pulang, atau sebaliknya."],
  header: {
    scope: "Unit: Semua unit", unit: "Semua unit", employeeCount: 2, filter: "Semua pegawai, semua sumber", workDays: 22,
    period: "Periode 1 Oktober 2026 – 31 Oktober 2026", calculatedAt: "26 Okt 2026 08.41 WIB",
    printedBy: "hc@example.invalid", printedAt: "26 Okt 2026 09.12 WIB",
  },
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
    expect(html.match(/Jumlah seluruhnya/g)).toHaveLength(1);
    expect(html).not.toContain("<tfoot");
    expect(html).toContain('class="report-cell hari libur t-tengah"');
    expect(html).toContain('<div class="n">Pegawai A</div><div class="nip">SYN-1</div>');
    expect(html).toContain("<b>L</b> Libur");
    expect(html).toContain("Tidak lengkap berarti");
    expect(html).not.toMatch(/<nav|<aside/);
  });

  it("prints the mock-up sheet: kop, title, identity, separate calculated/printed meta, no app chrome", () => {
    const html = renderToStaticMarkup(<ReportPrintSheet table={table} />);
    expect(html).toContain('class="kop"');
    expect(html).toContain("Yayasan Sabilul Qur&#x27;an");
    expect(html).toContain("<h1>Laporan Kehadiran Harian</h1>");
    expect(html).toMatch(/<dt>Hari kerja<\/dt><dd>22(<!-- -->)? hari<\/dd>/);
    expect(html).toContain("Data dihitung: <b>26 Okt 2026 08.41 WIB</b>");
    expect(html).toContain("Dicetak oleh: <b>hc@example.invalid</b>");
    expect(html).not.toContain('class="ttd"');
    expect(html).not.toMatch(/<nav|<aside/);
  });

  it("prints A4 in the model orientation, repeats headings and starts each unit on a new page", () => {
    const css = printCss("landscape", "Dokumen ini dibuat otomatis oleh HCIS Yayasan Sabilul Qur'an.");
    expect(css).toContain("@page lanskap { size: A4 landscape; margin: 10mm 12mm 12mm;");
    expect(css).toContain("page: lanskap;");
    expect(css).toContain(".report-table thead { display: table-header-group; }");
    expect(css).toContain(".report-table tbody tr { break-inside: avoid;");
    expect(css).toContain('content: "Halaman " counter(page) " dari " counter(pages)');
    expect(css).toContain(`content: "Dokumen ini dibuat otomatis oleh HCIS Yayasan Sabilul Qur'an."`);
    expect(printCss("portrait", "x")).toContain("page: potret;");
  });
});
