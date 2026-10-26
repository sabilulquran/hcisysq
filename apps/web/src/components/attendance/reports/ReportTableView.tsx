import { reportCellText, type AttendanceReportTable, type ReportCell } from "@/lib/attendanceReports";

// One renderer for the screen preview and the print document, so both show exactly the same columns.

function alignClass(align: "right" | "center" | undefined) {
  return align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
}

function Row({ table, values, emphasis }: { table: AttendanceReportTable; values: Record<string, ReportCell>; emphasis?: boolean }) {
  return (
    <tr className={emphasis ? "report-subtotal font-semibold" : undefined}>
      {table.columns.map((column) => (
        <td key={column.key} className={`report-cell ${alignClass(column.align)}${column.weekend ? " report-weekend" : ""}`}>
          {reportCellText(values[column.key])}
        </td>
      ))}
    </tr>
  );
}

export function ReportTableView({ table, print = false }: { table: AttendanceReportTable; print?: boolean }) {
  const compact = table.model === "daily_grid";
  return (
    <div className={print ? "report-print-body" : "overflow-x-auto"}>
      {table.groups.map((group) => (
        <section key={group.unitName} className="report-group mb-4">
          <h3 className="report-unit mb-1 text-sm font-bold text-brand-heading">{group.unitName}</h3>
          <table className={`report-table w-full border-collapse ${compact ? "text-[11px]" : "text-xs"}`}>
            <thead>
              <tr>
                {table.columns.map((column) => (
                  <th key={column.key} className={`report-head ${alignClass(column.align)}${column.weekend ? " report-weekend" : ""}`}>{column.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {group.rows.map((values, index) => <Row key={index} table={table} values={values} />)}
              {group.subtotal ? <Row table={table} values={group.subtotal} emphasis /> : null}
            </tbody>
          </table>
        </section>
      ))}
      {table.total ? (
        <table className={`report-table report-total w-full border-collapse ${compact ? "text-[11px]" : "text-xs"}`}>
          <tbody><Row table={table} values={table.total} emphasis /></tbody>
        </table>
      ) : null}
      {table.legend ? (
        <p className="report-legend mt-3 text-[11px] text-muted-foreground">
          <span className="font-semibold">Keterangan: </span>
          {table.legend.map((item) => `${item.symbol} = ${item.label}`).join(" · ")}
        </p>
      ) : null}
    </div>
  );
}

/** Table styling shared by preview and print; print-only rules live in the print page. */
export const REPORT_TABLE_CSS = `
.report-table { table-layout: auto; }
.report-head, .report-cell { border: 1px solid #c9ced6; padding: 3px 5px; vertical-align: top; }
.report-head { background: #eef1f5; font-weight: 700; white-space: nowrap; }
.report-weekend { background: #f3f4f6; }
.report-subtotal td { background: #f7f8fa; }
.report-total td { border-top: 2px solid #6b7280; }
`;
