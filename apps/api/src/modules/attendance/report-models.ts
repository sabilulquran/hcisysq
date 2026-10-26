import ExcelJS from "exceljs";

import type { CalculationRowStatus } from "./calculation-rows.js";

// ATT-014 §7 and §19.2 report models (D-14-11): Laporan Harian (Grid Bulanan), Rekapitulasi Pegawai
// and Detail Harian. Pure builders over the stored-result rows of calculation-rows; nothing here
// calculates attendance. The same table feeds the screen preview, the print document, CSV and XLSX.

// printTitle is the heading on paper (owner-approved print mock-up, 2026-10-26).
export const REPORT_MODELS = {
  daily_grid: { title: "Laporan Harian (Grid Bulanan)", printTitle: "Laporan Kehadiran Harian", orientation: "landscape" },
  employee_summary: { title: "Rekapitulasi Pegawai", printTitle: "Rekapitulasi Kehadiran Pegawai", orientation: "portrait" },
  daily_detail: { title: "Detail Harian", printTitle: "Detail Kehadiran Harian", orientation: "landscape" },
} as const;

/** Terms that are easy to misread, explained on the sheet itself. */
export const REPORT_NOTES = [
  "Tidak lengkap berarti ada scan masuk tanpa scan pulang, atau sebaliknya. Jam jadwal tidak pernah dipakai sebagai pengganti jam yang hilang.",
  "Tidak tercatat berarti tanggal itu belum tercakup mesin atau absen HP bagi pegawai tersebut, bukan berarti tidak hadir.",
];

export type ReportModel = keyof typeof REPORT_MODELS;

export type ReportSourceRow = {
  employeeId: string;
  employeeNumber: string | null;
  employeeName: string | null;
  unitName: string | null;
  workDate: string;
  status: CalculationRowStatus;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  firstCheckInAt: string | null;
  lastCheckOutAt: string | null;
  workedMinutes: number | null;
  lateMinutes: number | null;
  earlyLeaveMinutes: number | null;
  overtimeMinutes: number | null;
  normal: number | null;
  actual: number | null;
};

export type ReportCell = string | number | null;

export type ReportColumn = { key: string; label: string; align?: "right" | "center"; weekend?: boolean };

export type ReportTable = {
  model: ReportModel;
  title: string;
  printTitle: string;
  orientation: "landscape" | "portrait";
  columns: ReportColumn[];
  groups: Array<{ unitName: string; rows: Array<Record<string, ReportCell>>; subtotal: Record<string, ReportCell> | null }>;
  total: Record<string, ReportCell> | null;
  legend: Array<{ symbol: string; label: string }> | null;
  notes: string[];
};

/** §6.6 symbols, plain letters so a black-and-white print stays readable. */
export const SYMBOL_LEGEND = [
  { symbol: "H", label: "Hadir" },
  { symbol: "T", label: "Terlambat" },
  { symbol: "P", label: "Pulang cepat" },
  { symbol: "TL", label: "Tidak lengkap" },
  { symbol: "A", label: "Tidak hadir" },
  { symbol: "C", label: "Cuti/Izin" },
  { symbol: "L", label: "Libur" },
  { symbol: "!", label: "Jadwal bermasalah" },
  { symbol: "·", label: "Tidak tercatat / belum ditarik / hari berjalan" },
];

export function daySymbol(row: Pick<ReportSourceRow, "status" | "earlyLeaveMinutes">): string {
  switch (row.status) {
    case "present": return (row.earlyLeaveMinutes ?? 0) > 0 ? "P" : "H";
    case "late": return "T";
    case "incomplete": return "TL";
    case "absent": return "A";
    case "leave": return "C";
    case "off": return "L";
    case "configuration_error": return "!";
    default: return "·";
  }
}

const STATUS_WORDS: Record<CalculationRowStatus, string> = {
  scheduled: "Terjadwal",
  pending: "Belum absen",
  present: "Hadir",
  late: "Terlambat",
  incomplete: "Tidak lengkap",
  leave: "Cuti/Izin",
  absent: "Tidak hadir",
  off: "Libur",
  configuration_error: "Jadwal bermasalah",
  not_captured: "Tidak tercatat",
  not_calculated: "Belum ditarik",
};

function eachDate(from: string, to: string) {
  const dates: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

const WEEKDAY = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];

function clock(value: string | null) {
  if (!value) return null;
  return new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Jakarta" })
    .format(new Date(value)).replace(".", ":");
}

type Totals = {
  normal: number; actual: number; present: number; late: number; lateMinutes: number; early: number; earlyMinutes: number;
  incomplete: number; absent: number; leave: number; overtimeMinutes: number; workedMinutes: number;
  notCaptured: number; notCalculated: number;
};

function emptyTotals(): Totals {
  return {
    normal: 0, actual: 0, present: 0, late: 0, lateMinutes: 0, early: 0, earlyMinutes: 0, incomplete: 0, absent: 0,
    leave: 0, overtimeMinutes: 0, workedMinutes: 0, notCaptured: 0, notCalculated: 0,
  };
}

function addRow(totals: Totals, row: ReportSourceRow) {
  totals.normal += row.normal ?? 0;
  totals.actual += row.actual ?? 0;
  if (row.status === "present" || row.status === "late") totals.present += 1;
  if (row.status === "late") { totals.late += 1; totals.lateMinutes += row.lateMinutes ?? 0; }
  if ((row.status === "present" || row.status === "late") && (row.earlyLeaveMinutes ?? 0) > 0) {
    totals.early += 1;
    totals.earlyMinutes += row.earlyLeaveMinutes ?? 0;
  }
  if (row.status === "incomplete") totals.incomplete += 1;
  if (row.status === "absent") totals.absent += 1;
  if (row.status === "leave") totals.leave += 1;
  if (row.status === "not_captured") totals.notCaptured += 1;
  if (row.status === "not_calculated") totals.notCalculated += 1;
  totals.overtimeMinutes += row.overtimeMinutes ?? 0;
  totals.workedMinutes += row.workedMinutes ?? 0;
}

function mergeTotals(target: Totals, source: Totals) {
  for (const key of Object.keys(target) as Array<keyof Totals>) target[key] += source[key];
}

/** Presensi % = Riil ÷ Normal (§6.3), one decimal; empty when nothing was scheduled. */
export function attendancePercent(totals: Pick<Totals, "normal" | "actual">): number | null {
  return totals.normal > 0 ? Math.round((totals.actual / totals.normal) * 1000) / 10 : null;
}

function summaryCells(totals: Totals): Record<string, ReportCell> {
  return {
    normal: totals.normal, actual: totals.actual, percent: attendancePercent(totals),
    present: totals.present, late: totals.late, lateMinutes: totals.lateMinutes, early: totals.early,
    earlyMinutes: totals.earlyMinutes, incomplete: totals.incomplete, absent: totals.absent, leave: totals.leave,
    overtimeMinutes: totals.overtimeMinutes, workedMinutes: totals.workedMinutes, notCaptured: totals.notCaptured,
    notCalculated: totals.notCalculated,
  };
}

// Columns of the owner-approved mock-up, plus Presensi % (§6.3); fits A4 portrait.
const SUMMARY_COLUMNS: ReportColumn[] = [
  { key: "normal", label: "Hari kerja", align: "center" },
  { key: "present", label: "Hadir", align: "center" },
  { key: "late", label: "Terlambat", align: "center" },
  { key: "lateMinutes", label: "Menit telat", align: "center" },
  { key: "incomplete", label: "Tidak lengkap", align: "center" },
  { key: "leave", label: "Cuti/Izin", align: "center" },
  { key: "absent", label: "Tidak hadir", align: "center" },
  { key: "overtimeMinutes", label: "Lembur (mnt)", align: "center" },
  { key: "percent", label: "Presensi %", align: "center" },
];

function groupByUnitAndEmployee(rows: ReportSourceRow[]) {
  const units = new Map<string, Map<string, ReportSourceRow[]>>();
  for (const row of rows) {
    const unit = row.unitName ?? "Tanpa unit";
    const employees = units.get(unit) ?? new Map<string, ReportSourceRow[]>();
    const list = employees.get(row.employeeId) ?? [];
    list.push(row);
    employees.set(row.employeeId, list);
    units.set(unit, employees);
  }
  return [...units.entries()]
    .sort(([left], [right]) => (left === "Tanpa unit" ? 1 : right === "Tanpa unit" ? -1 : left.localeCompare(right, "id")))
    .map(([unitName, employees]) => ({
      unitName,
      employees: [...employees.values()]
        .map((list) => list.sort((left, right) => left.workDate.localeCompare(right.workDate)))
        .sort((left, right) => (left[0]?.employeeName ?? "").localeCompare(right[0]?.employeeName ?? "", "id")),
    }));
}

export function buildReportTable(model: ReportModel, rows: ReportSourceRow[], from: string, to: string): ReportTable {
  const meta = REPORT_MODELS[model];
  const grouped = groupByUnitAndEmployee(rows);
  const grand = emptyTotals();

  if (model === "daily_detail") {
    const columns: ReportColumn[] = [
      { key: "date", label: "Tanggal" }, { key: "day", label: "Hari" },
      { key: "employeeNumber", label: "NIP" }, { key: "employeeName", label: "Nama" },
      { key: "schedule", label: "Jadwal" }, { key: "checkIn", label: "Masuk" }, { key: "checkOut", label: "Pulang" },
      { key: "status", label: "Status" }, { key: "lateMinutes", label: "Terlambat (mnt)", align: "right" },
      { key: "earlyMinutes", label: "Pulang cepat (mnt)", align: "right" },
      { key: "workedMinutes", label: "Jam kerja (mnt)", align: "right" },
      { key: "overtimeMinutes", label: "Lembur (mnt)", align: "right" },
      { key: "normalActual", label: "Normal/Riil", align: "center" },
    ];
    const groups = grouped.map(({ unitName, employees }) => {
      const unitTotals = emptyTotals();
      const groupRows = employees.flat().map((row) => {
        addRow(unitTotals, row);
        return {
          date: row.workDate,
          day: WEEKDAY[new Date(`${row.workDate}T00:00:00Z`).getUTCDay()]!,
          employeeNumber: row.employeeNumber,
          employeeName: row.employeeName,
          schedule: row.scheduledStartAt ? `${clock(row.scheduledStartAt)}–${clock(row.scheduledEndAt)}` : null,
          checkIn: clock(row.firstCheckInAt),
          checkOut: clock(row.lastCheckOutAt),
          status: STATUS_WORDS[row.status],
          lateMinutes: row.lateMinutes || null,
          earlyMinutes: row.earlyLeaveMinutes || null,
          workedMinutes: row.workedMinutes || null,
          overtimeMinutes: row.overtimeMinutes || null,
          normalActual: row.normal === null ? null : `${row.normal}/${row.actual ?? "–"}`,
        };
      });
      mergeTotals(grand, unitTotals);
      return {
        unitName,
        rows: groupRows,
        subtotal: {
          date: `Jumlah ${unitName}`, lateMinutes: unitTotals.lateMinutes, earlyMinutes: unitTotals.earlyMinutes,
          workedMinutes: unitTotals.workedMinutes, overtimeMinutes: unitTotals.overtimeMinutes,
          normalActual: `${unitTotals.normal}/${unitTotals.actual}`,
        },
      };
    });
    return {
      model, title: meta.title, printTitle: meta.printTitle, orientation: meta.orientation, columns, groups, notes: REPORT_NOTES,
      total: {
        date: "Jumlah seluruhnya", lateMinutes: grand.lateMinutes, earlyMinutes: grand.earlyMinutes,
        workedMinutes: grand.workedMinutes, overtimeMinutes: grand.overtimeMinutes, normalActual: `${grand.normal}/${grand.actual}`,
      },
      legend: null,
    };
  }

  if (model === "employee_summary") {
    const columns: ReportColumn[] = [{ key: "employeeNumber", label: "NIP" }, { key: "employeeName", label: "Nama" }, ...SUMMARY_COLUMNS];
    const groups = grouped.map(({ unitName, employees }) => {
      const unitTotals = emptyTotals();
      const groupRows = employees.map((list) => {
        const totals = emptyTotals();
        for (const row of list) addRow(totals, row);
        mergeTotals(unitTotals, totals);
        return { employeeNumber: list[0]?.employeeNumber ?? null, employeeName: list[0]?.employeeName ?? null, ...summaryCells(totals) };
      });
      mergeTotals(grand, unitTotals);
      return { unitName, rows: groupRows, subtotal: { employeeNumber: `Jumlah ${unitName}`, ...summaryCells(unitTotals) } };
    });
    return {
      model, title: meta.title, printTitle: meta.printTitle, orientation: meta.orientation, columns, groups, notes: REPORT_NOTES,
      total: { employeeNumber: "Jumlah seluruhnya", ...summaryCells(grand) }, legend: null,
    };
  }

  // daily_grid: one row per employee, one column per date, plus the §7 totals.
  const dates = eachDate(from, to);
  const columns: ReportColumn[] = [
    { key: "employeeNumber", label: "NIP" }, { key: "employeeName", label: "Nama" },
    ...dates.map((date) => {
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      return { key: `d:${date}`, label: String(Number(date.slice(8, 10))), align: "center" as const, weekend: weekday === 0 || weekday === 6 };
    }),
    { key: "present", label: "Hadir", align: "center" }, { key: "late", label: "Telat", align: "center" },
    { key: "incomplete", label: "Tdk lengkap", align: "center" }, { key: "leave", label: "Cuti/Izin", align: "center" },
    { key: "absent", label: "Tdk hadir", align: "center" },
  ];
  const groups = grouped.map(({ unitName, employees }) => {
    const unitTotals = emptyTotals();
    const groupRows = employees.map((list) => {
      const totals = emptyTotals();
      const cells: Record<string, ReportCell> = {};
      for (const row of list) {
        addRow(totals, row);
        cells[`d:${row.workDate}`] = daySymbol(row);
      }
      mergeTotals(unitTotals, totals);
      const summary = summaryCells(totals);
      return {
        employeeNumber: list[0]?.employeeNumber ?? null, employeeName: list[0]?.employeeName ?? null, ...cells,
        present: summary.present!, late: summary.late!, incomplete: summary.incomplete!, leave: summary.leave!,
        absent: summary.absent!,
      };
    });
    mergeTotals(grand, unitTotals);
    const summary = summaryCells(unitTotals);
    return {
      unitName,
      rows: groupRows,
      subtotal: {
        employeeNumber: `Jumlah ${unitName}`, present: summary.present!, late: summary.late!,
        incomplete: summary.incomplete!, leave: summary.leave!, absent: summary.absent!,
      },
    };
  });
  const summary = summaryCells(grand);
  return {
    model, title: meta.title, printTitle: meta.printTitle, orientation: meta.orientation, columns, groups, notes: REPORT_NOTES,
    total: {
      employeeNumber: "Jumlah seluruhnya", present: summary.present!, late: summary.late!,
      incomplete: summary.incomplete!, leave: summary.leave!, absent: summary.absent!,
    },
    legend: SYMBOL_LEGEND,
  };
}

function flatRows(table: ReportTable) {
  const out: Array<Record<string, ReportCell>> = [];
  for (const group of table.groups) {
    for (const row of group.rows) out.push({ unitName: group.unitName, ...row });
    if (group.subtotal) out.push({ unitName: group.unitName, ...group.subtotal });
  }
  if (table.total) out.push({ unitName: "", ...table.total });
  return out;
}

function csvCell(value: ReportCell) {
  if (value === null || value === undefined) return "";
  // A leading formula character is neutralised so a spreadsheet never evaluates exported text.
  const text = typeof value === "string" && /^[=+\-@]/.test(value) ? `'${value}` : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const BOM = String.fromCharCode(0xfeff);

/** UTF-8 CSV with BOM (as ATT-009), unit first, subtotals and total as their own rows. */
export function reportCsv(table: ReportTable): string {
  const columns = [{ key: "unitName", label: "Unit" }, ...table.columns];
  const lines = [columns.map((column) => csvCell(column.label)).join(",")];
  for (const row of flatRows(table)) lines.push(columns.map((column) => csvCell(row[column.key] ?? null)).join(","));
  return `${BOM}${lines.join("\r\n")}`;
}

export async function reportXlsx(
  table: ReportTable,
  header: { scope: string; period: string; printedBy: string; printedAt: string; calculatedAt?: string },
) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(table.title.slice(0, 31), {
    pageSetup: { paperSize: 9, orientation: table.orientation, fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  const columns = [{ key: "unitName", label: "Unit" }, ...table.columns];
  sheet.addRow([table.printTitle]).font = { bold: true, size: 14 };
  sheet.addRow([header.scope]);
  sheet.addRow([header.period]);
  sheet.addRow([`Data dihitung: ${header.calculatedAt ?? "-"} · Dicetak: ${header.printedAt} oleh ${header.printedBy}`]);
  sheet.addRow([]);
  const headerRow = sheet.addRow(columns.map((column) => column.label));
  headerRow.font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: headerRow.number }];
  for (const row of flatRows(table)) {
    const added = sheet.addRow(columns.map((column) => row[column.key] ?? null));
    if (String(row.employeeNumber ?? row.date ?? "").startsWith("Jumlah")) added.font = { bold: true };
  }
  sheet.addRow([]);
  if (table.legend) sheet.addRow([`Keterangan: ${table.legend.map((item) => `${item.symbol} = ${item.label}`).join("; ")}`]);
  for (const note of table.notes) sheet.addRow([note]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
