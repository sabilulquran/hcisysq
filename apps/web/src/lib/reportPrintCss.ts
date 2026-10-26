import { REPORT_TABLE_CSS } from "@/components/attendance/reports/ReportTableView";

// ATT-014 §19.2 print document, after the owner-approved print mock-up (2026-10-26).
//
// Orientation uses named pages (`page: lanskap | potret`). Page numbers "Halaman n dari N" and the
// neutral maker sentence are CSS page margin boxes. Those only render inside a non-zero page margin,
// so the mock-up's sheet padding (10/12 mm landscape, 14 mm portrait) is the @page margin here.
// Verified 2026-10-26 by printing to PDF with Chrome 155: page numbers, the footer sentence, repeated
// column headings and mixed orientation all appear. Chrome/Edge 131+ support margin boxes; Firefox
// and Safari print the document without them (no page numbers), which is stated on the screen bar.

function cssString(text: string) {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function printCss(orientation: "landscape" | "portrait", footer: string) {
  const box = 'font-family: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 7.2pt; color: #55514b;';
  const margins = `@bottom-left { content: ${cssString(footer)}; ${box} }`
    + ` @bottom-right { content: "Halaman " counter(page) " dari " counter(pages); ${box} }`;
  return `
${REPORT_TABLE_CSS}
@page lanskap { size: A4 landscape; margin: 10mm 12mm 12mm; ${margins} }
@page potret { size: A4 portrait; margin: 14mm 14mm 14mm; ${margins} }
html, body { background: #fff !important; color: #14130f; }
.report-sheet { page: ${orientation === "landscape" ? "lanskap" : "potret"}; font-family: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 8.4pt; background: #fff; max-width: ${orientation === "landscape" ? "273mm" : "182mm"}; margin: 0 auto; padding: 8mm 0; }
.kop { display: flex; gap: 5mm; align-items: center; border-bottom: 1.4pt solid #14130f; padding-bottom: 3mm; }
.kop img { width: 15mm; height: 15mm; flex: none; }
.kop .nama { font-family: "Source Serif 4", Georgia, "Times New Roman", serif; font-weight: 700; font-size: 13pt; letter-spacing: .01em; line-height: 1.15; }
.kop .alamat { font-size: 7.6pt; color: #55514b; }
.judul { text-align: center; margin-top: 4mm; }
.judul h1 { margin: 0; font-family: "Source Serif 4", Georgia, "Times New Roman", serif; font-size: 12pt; letter-spacing: .06em; text-transform: uppercase; }
.judul .sub { font-size: 8.6pt; color: #55514b; margin-top: 1mm; }
.identitas { margin: 4mm 0 0; display: grid; gap: 1mm 8mm; grid-template-columns: repeat(auto-fit, minmax(62mm, 1fr)); font-size: 8.2pt; }
.identitas div { display: flex; gap: 2mm; }
.identitas dt { color: #55514b; min-width: 26mm; }
.identitas dd { margin: 0; font-weight: 600; }
.meta-hitung { margin-top: 3mm; border: .6pt solid #c9c5bf; border-left: 2.2pt solid #14130f; padding: 2mm 3mm; font-size: 7.8pt; color: #55514b;
  display: flex; flex-wrap: wrap; gap: 1mm 6mm; }
.meta-hitung b { color: #14130f; font-weight: 600; }
.peringatan { margin-top: 2mm; font-size: 7.8pt; font-weight: 600; }
.report-table thead { display: table-header-group; }
.report-table tbody tr { break-inside: avoid; page-break-inside: avoid; }
.report-group + .report-group { break-before: page; page-break-before: always; }
.ttd { margin-top: 8mm; display: flex; justify-content: flex-end; break-inside: avoid; }
.ttd .blok { width: 62mm; text-align: center; font-size: 8.4pt; }
.ttd .garis { margin-top: 18mm; border-bottom: .6pt solid #14130f; }
.ttd .jabatan { margin-top: 1mm; color: #55514b; font-size: 7.8pt; }
@media print {
  .report-sheet { padding: 0; max-width: none; }
  .report-screen-only { display: none !important; }
  .report-table thead th, .report-table .libur, .report-subtotal td { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`;
}
