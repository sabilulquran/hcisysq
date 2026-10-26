import { REPORT_TABLE_CSS } from "@/components/attendance/reports/ReportTableView";

// ATT-014 §19.2 print document: a page of its own, opened in a new tab, without sidebar, menu or
// filters. A4, orientation per model, column headings repeated on every page, rows never split,
// every unit after the first on a new page, page numbers where the browser supports them.
export function printCss(orientation: "landscape" | "portrait") {
  return `
${REPORT_TABLE_CSS}
@page { size: A4 ${orientation}; margin: 12mm 10mm 14mm;
  @bottom-right { content: "Halaman " counter(page) " dari " counter(pages); font-size: 9pt; color: #555; } }
html, body { background: #fff !important; color: #111; }
.report-sheet { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; max-width: ${orientation === "landscape" ? "277mm" : "190mm"}; margin: 0 auto; padding: 8mm 0; }
.report-table thead { display: table-header-group; }
.report-table tr { break-inside: avoid; page-break-inside: avoid; }
.report-group + .report-group { break-before: page; page-break-before: always; }
@media print {
  .report-sheet { padding: 0; max-width: none; }
  .report-screen-only { display: none !important; }
  .report-weekend, .report-head, .report-subtotal td { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`;
}
