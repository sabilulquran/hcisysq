import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import {
  attendancePercent,
  buildReportTable,
  daySymbol,
  reportCsv,
  reportXlsx,
  type ReportSourceRow,
} from "../src/modules/attendance/report-models.js";

// ATT-014 §7/§19.2 report models (D-14-11). Synthetic employees only.

function row(employeeId: string, workDate: string, status: ReportSourceRow["status"], extra: Partial<ReportSourceRow> = {}): ReportSourceRow {
  const scheduled = ["present", "late", "absent", "incomplete", "leave", "scheduled", "pending"].includes(status);
  return {
    employeeId,
    employeeNumber: employeeId === "a" ? "SYN-1" : "SYN-2",
    employeeName: employeeId === "a" ? "Pegawai A" : "Pegawai B",
    unitName: employeeId === "a" ? "SDIT" : "SMPIT",
    workDate,
    status,
    scheduledStartAt: scheduled ? `${workDate}T00:00:00.000Z` : null,
    scheduledEndAt: scheduled ? `${workDate}T09:00:00.000Z` : null,
    firstCheckInAt: null,
    lastCheckOutAt: null,
    workedMinutes: null,
    lateMinutes: null,
    earlyLeaveMinutes: null,
    overtimeMinutes: null,
    normal: scheduled ? 1 : null,
    actual: status === "present" || status === "late" ? 1 : status === "absent" ? 0 : null,
    ...extra,
  };
}

const rows: ReportSourceRow[] = [
  row("a", "2026-10-01", "present", { workedMinutes: 480 }),
  row("a", "2026-10-02", "late", { lateMinutes: 12, workedMinutes: 468 }),
  row("a", "2026-10-03", "off"),
  row("a", "2026-10-04", "off"),
  row("b", "2026-10-01", "absent"),
  row("b", "2026-10-02", "incomplete"),
  row("b", "2026-10-03", "off"),
  row("b", "2026-10-04", "not_captured"),
];

describe("ATT-014 report symbols and Presensi %", () => {
  it("uses the §6.6 symbols", () => {
    expect(daySymbol({ status: "present", earlyLeaveMinutes: 0 })).toBe("H");
    expect(daySymbol({ status: "present", earlyLeaveMinutes: 15 })).toBe("P");
    expect(daySymbol({ status: "late", earlyLeaveMinutes: 15 })).toBe("T");
    expect(daySymbol({ status: "incomplete", earlyLeaveMinutes: null })).toBe("TL");
    expect(daySymbol({ status: "absent", earlyLeaveMinutes: null })).toBe("A");
    expect(daySymbol({ status: "leave", earlyLeaveMinutes: null })).toBe("C");
    expect(daySymbol({ status: "off", earlyLeaveMinutes: null })).toBe("L");
    expect(daySymbol({ status: "not_captured", earlyLeaveMinutes: null })).toBe("·");
  });

  it("computes Presensi % as Riil ÷ Normal", () => {
    expect(attendancePercent({ normal: 3, actual: 2 })).toBe(66.7);
    expect(attendancePercent({ normal: 0, actual: 0 })).toBeNull();
  });
});

describe("ATT-014 report models", () => {
  it("builds the monthly grid with one column per date, weekend marks, unit subtotals and a legend", () => {
    const table = buildReportTable("daily_grid", rows, "2026-10-01", "2026-10-04");
    expect(table.orientation).toBe("landscape");
    const dayColumns = table.columns.filter((column) => column.key.startsWith("d:"));
    expect(dayColumns.map((column) => column.label)).toEqual(["1", "2", "3", "4"]);
    expect(dayColumns.map((column) => Boolean(column.weekend))).toEqual([false, false, true, true]);
    expect(table.groups.map((group) => group.unitName)).toEqual(["SDIT", "SMPIT"]);
    expect(table.groups[0]!.rows[0]).toMatchObject({ "d:2026-10-01": "H", "d:2026-10-02": "T", "d:2026-10-03": "L", present: 2, late: 1 });
    expect(table.groups[1]!.rows[0]).toMatchObject({ "d:2026-10-01": "A", "d:2026-10-02": "TL", "d:2026-10-04": "·", absent: 1, incomplete: 1, present: 0 });
    expect(table.total).toMatchObject({ present: 2, late: 1, absent: 1, incomplete: 1 });
    expect(table.printTitle).toBe("Laporan Kehadiran Harian");
    expect(table.notes[0]).toMatch(/^Tidak lengkap berarti/);
    expect(table.legend?.map((item) => item.symbol)).toContain("TL");
  });

  it("builds the employee summary with subtotals per unit and a grand total", () => {
    const table = buildReportTable("employee_summary", rows, "2026-10-01", "2026-10-04");
    expect(table.columns.map((column) => column.label)).toEqual(["NIP", "Nama", "Hari kerja", "Hadir", "Terlambat", "Menit telat", "Tidak lengkap", "Cuti/Izin", "Tidak hadir", "Lembur (mnt)", "Presensi %"]);
    expect(table.groups[0]!.rows[0]).toMatchObject({ employeeName: "Pegawai A", normal: 2, present: 2, late: 1, lateMinutes: 12, percent: 100 });
    expect(table.groups[1]!.subtotal).toMatchObject({ employeeNumber: "Jumlah SMPIT", absent: 1, incomplete: 1, notCaptured: 1 });
    expect(table.total).toMatchObject({ employeeNumber: "Jumlah seluruhnya", normal: 4, actual: 2, percent: 50 });
  });

  it("builds the daily detail with readable statuses and no raw enum", () => {
    const table = buildReportTable("daily_detail", rows, "2026-10-01", "2026-10-04");
    const statuses = table.groups.flatMap((group) => group.rows.map((item) => item.status));
    expect(statuses).toContain("Tidak tercatat");
    expect(statuses).not.toContain("not_captured");
    expect(table.groups[0]!.rows[1]).toMatchObject({ date: "2026-10-02", day: "Jum", schedule: "07:00–16:00", lateMinutes: 12 });
  });
});

describe("ATT-014 report exports", () => {
  it("writes CSV with BOM, unit column, subtotal rows and neutralised formulas", () => {
    const table = buildReportTable("employee_summary", [row("a", "2026-10-01", "present", { employeeName: "=HYPERLINK(1)" })], "2026-10-01", "2026-10-01");
    const csv = reportCsv(table);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]!.startsWith("Unit,NIP,Nama,Hari kerja,Hadir,Terlambat")).toBe(true);
    expect(lines[1]).toContain("'=HYPERLINK(1)");
    expect(lines.at(-1)).toContain("Jumlah seluruhnya");
  });

  it("writes an XLSX with the header block and the same columns", async () => {
    const table = buildReportTable("daily_grid", rows, "2026-10-01", "2026-10-04");
    const buffer = await reportXlsx(table, { scope: "Unit: Semua unit", period: "Periode 2026-10-01 s/d 2026-10-04", printedBy: "hc@example.invalid", printedAt: "4 Oktober 2026" });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0]!;
    expect(sheet.getRow(1).getCell(1).value).toBe("Laporan Kehadiran Harian");
    expect(sheet.pageSetup.orientation).toBe("landscape");
    const header = sheet.getRow(6).values as unknown[];
    expect(header.slice(1, 4)).toEqual(["Unit", "NIP", "Nama"]);
  });
});
