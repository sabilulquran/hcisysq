import { reportCellText, type AttendanceReportTable, type ReportCell } from "@/lib/attendanceReports";

// One renderer for the screen preview and the print document, so both show exactly the same columns.
// Layout follows the owner-approved print mock-up (2026-10-26): employee name with NIP beneath in one
// "Pegawai" cell, narrow day columns with a very light holiday tint, tabular numbers.

type Column = AttendanceReportTable["columns"][number];

function cellClass(table: AttendanceReportTable, column: Column) {
  const classes = ["report-cell"];
  if (column.key.startsWith("d:")) classes.push("hari");
  else if (table.model === "daily_grid") classes.push("rekap-sel");
  if (column.weekend) classes.push("libur");
  if (column.align === "right") classes.push("t-kanan");
  else if (column.align === "center") classes.push("t-tengah");
  return classes.join(" ");
}

function visibleColumns(table: AttendanceReportTable) {
  // NIP and Nama stay separate columns in CSV/XLSX; on paper they share one "Pegawai" cell.
  return table.columns.filter((column) => column.key !== "employeeNumber");
}

function PegawaiCell({ values }: { values: Record<string, ReportCell> }) {
  const number = values.employeeNumber;
  const name = values.employeeName;
  if (typeof number === "string" && number.startsWith("Jumlah")) return <td className="nama-sel">{number}</td>;
  return (
    <td className="nama-sel">
      <div className="n">{reportCellText(name)}</div>
      {number ? <div className="nip">{reportCellText(number)}</div> : null}
    </td>
  );
}

function Row({ table, values, emphasis, total }: { table: AttendanceReportTable; values: Record<string, ReportCell>; emphasis?: boolean; total?: boolean }) {
  return (
    <tr className={total ? "report-total" : emphasis ? "report-subtotal" : undefined}>
      {visibleColumns(table).map((column) => column.key === "employeeName"
        ? <PegawaiCell key={column.key} values={values} />
        : <td key={column.key} className={cellClass(table, column)}>{reportCellText(values[column.key])}</td>)}
    </tr>
  );
}

function Head({ table }: { table: AttendanceReportTable }) {
  const columns = visibleColumns(table);
  if (table.model !== "daily_grid") {
    return (
      <thead>
        <tr>{columns.map((column) => column.key === "employeeName"
          ? <th key={column.key} className="nama-sel">Pegawai</th>
          : <th key={column.key} className={cellClass(table, column)}>{column.label}</th>)}</tr>
      </thead>
    );
  }
  const days = columns.filter((column) => column.key.startsWith("d:"));
  const recap = columns.filter((column) => !column.key.startsWith("d:") && column.key !== "employeeName");
  return (
    <thead>
      <tr>
        <th rowSpan={2} className="nama-sel">Pegawai</th>
        <th colSpan={days.length}>Tanggal</th>
        <th colSpan={recap.length}>Rekap</th>
      </tr>
      <tr>{[...days, ...recap].map((column) => <th key={column.key} className={cellClass(table, column)}>{column.label}</th>)}</tr>
    </thead>
  );
}

export function ReportTableView({ table, print = false }: { table: AttendanceReportTable; print?: boolean }) {
  return (
    <div className={print ? "report-print-body" : "overflow-x-auto"}>
      {table.groups.map((group) => (
        <section key={group.unitName} className="report-group">
          {table.groups.length > 1 ? <h4 className="report-unit">{group.unitName}</h4> : null}
          <table className="report-table">
            <Head table={table} />
            <tbody>
              {group.rows.map((values, index) => <Row key={index} table={table} values={values} />)}
              {group.subtotal && table.groups.length > 1 ? <Row table={table} values={group.subtotal} emphasis /> : null}
              {/* The grand total closes the last table once; a tfoot would repeat on every printed page. */}
              {table.total && table.groups.at(-1) === group ? <Row table={table} values={table.total} total /> : null}
            </tbody>
          </table>
        </section>
      ))}
      {table.legend ? (
        <p className="legenda">
          <b>Keterangan:</b>
          {table.legend.map((item) => <span key={item.symbol}><b>{item.symbol}</b> {item.label}</span>)}
        </p>
      ) : null}
      {table.notes.map((note) => <p key={note} className="legenda">{note}</p>)}
    </div>
  );
}

/** Table styling shared by preview and print (mock-up values); print-only rules live in reportPrintCss. */
export const REPORT_TABLE_CSS = `
.report-table { border-collapse: collapse; width: 100%; margin-top: 4mm; font-variant-numeric: tabular-nums; font-size: 8.4pt; color: #14130f; }
.report-table th, .report-table td { border: .5pt solid #c9c5bf; padding: 1.1mm 1.2mm; }
.report-table thead th { background: #f1efec; font-weight: 600; font-size: 7.4pt; text-align: center; border-bottom: .9pt solid #14130f; }
.report-table .nama-sel { text-align: left; width: 48mm; }
.report-table .nama-sel .n { font-weight: 600; }
.report-table .nama-sel .nip { font-size: 6.8pt; color: #55514b; letter-spacing: .01em; }
.report-table .hari { width: 5.4mm; text-align: center; font-size: 6.8pt; padding-left: 0; padding-right: 0; }
.report-table .libur { background: #f3f1ee; color: #55514b; }
.report-table .rekap-sel { width: 9mm; text-align: center; font-weight: 600; }
.report-table .t-kanan { text-align: right; }
.report-table .t-tengah { text-align: center; }
.report-table .report-subtotal td { background: #f7f6f4; font-weight: 600; }
.report-table .report-total td { border-top: .9pt solid #14130f; font-weight: 700; }
.report-unit { margin: 5mm 0 0; font-size: 9pt; font-weight: 700; }
.legenda { margin-top: 3mm; display: flex; flex-wrap: wrap; gap: 1mm 5mm; font-size: 7.4pt; color: #55514b; }
.legenda b { color: #14130f; font-weight: 700; }
`;
