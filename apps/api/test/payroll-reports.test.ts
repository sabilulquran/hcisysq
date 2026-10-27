import { describe, expect, it } from "vitest";

import { transferListToCsv, type TransferRow } from "../src/modules/payroll/reports.js";

function row(overrides: Partial<TransferRow> = {}): TransferRow {
  return {
    employeeNumber: "2016001",
    fullName: "Pegawai Uji",
    unitRef: "unit-pusat",
    payable: "3000000",
    bankAccountNumber: "0000000001",
    bankAccountName: "Pegawai Uji",
    paymentConfirmedAt: null,
    ...overrides,
  };
}

describe("PAY-003 transfer list CSV", () => {
  it("writes a header and one quoted row per recipient", () => {
    const csv = transferListToCsv([row()]);
    expect(csv).toBe(
      '"NIP","Nama","Unit","Nominal dibayar","Nomor rekening","Nama pemilik rekening","Konfirmasi bayar"\n' +
        '"2016001","Pegawai Uji","unit-pusat","3000000","0000000001","Pegawai Uji",""\n',
    );
  });

  it("keeps an account number that begins with a zero intact", () => {
    const csv = transferListToCsv([row({ bankAccountNumber: "0012345678" })]);
    expect(csv).toContain('"0012345678"');
  });

  it("neutralises a name a spreadsheet would run as a formula", () => {
    const csv = transferListToCsv([row({ fullName: "=cmd|'/c calc'!A1" })]);
    expect(csv).toContain(`"'=cmd|'/c calc'!A1"`);
  });

  it("escapes a quote inside a name rather than breaking the row", () => {
    const csv = transferListToCsv([row({ fullName: 'Pegawai "Uji"' })]);
    expect(csv).toContain('"Pegawai ""Uji"""');
    expect(csv.trimEnd().split("\n")).toHaveLength(2);
  });

  it("leaves a missing account visibly empty rather than writing null", () => {
    const csv = transferListToCsv([row({ bankAccountNumber: null, bankAccountName: null, unitRef: null })]);
    expect(csv).not.toContain("null");
    expect(csv).toContain('"2016001","Pegawai Uji","","3000000","","",""');
  });

  it("writes only a header when nobody is paid", () => {
    expect(transferListToCsv([])).toBe(
      '"NIP","Nama","Unit","Nominal dibayar","Nomor rekening","Nama pemilik rekening","Konfirmasi bayar"\n',
    );
  });

  it("ends with a newline, so the file can be appended to", () => {
    expect(transferListToCsv([row()]).endsWith("\n")).toBe(true);
  });
});
