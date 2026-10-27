import { describe, expect, it } from "vitest";

import { formatRupiah, transferListToCsv, type TransferRow } from "../src/modules/payroll/reports.js";

const HEADER =
  '﻿"NIP","Nama","Unit","Nominal dibayar","Bank","Nomor rekening","Nama pemilik rekening","Konfirmasi bayar"\r\n';

function row(overrides: Partial<TransferRow> = {}): TransferRow {
  return {
    employeeNumber: "2016001",
    fullName: "Pegawai Uji",
    unitRef: "unit-pusat",
    payable: "3000000",
    bankName: "BSI",
    bankAccountNumber: "0000000001",
    bankAccountName: "Pegawai Uji",
    paymentConfirmedAt: null,
    ...overrides,
  };
}

describe("PAY-003 transfer list CSV", () => {
  it("writes a header and one quoted row per recipient", () => {
    expect(transferListToCsv([row()])).toBe(
      `${HEADER}"2016001","Pegawai Uji","unit-pusat","3000000","BSI","'0000000001","Pegawai Uji",""\r\n`,
    );
  });

  it("forces an account number that begins with a zero to stay text", () => {
    // A spreadsheet reading 0012345678 as a number drops the leading zeros, and
    // the account becomes a different account.
    expect(transferListToCsv([row({ bankAccountNumber: "0012345678" })])).toContain(`"'0012345678"`);
  });

  it("leaves an account number without a leading zero alone", () => {
    expect(transferListToCsv([row({ bankAccountNumber: "7123456789" })])).toContain('"7123456789"');
  });

  it("starts with a byte order mark, so a diacritic survives Excel on Windows", () => {
    const csv = transferListToCsv([row({ fullName: "Siti Nurhalimah Áziz" })]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("Siti Nurhalimah Áziz");
  });

  it("separates records with CRLF, as the CSV format expects", () => {
    const csv = transferListToCsv([row()]);
    expect(csv.split("\r\n").filter((line) => line.length > 0)).toHaveLength(2);
  });

  it("neutralises a name a spreadsheet would run as a formula", () => {
    expect(transferListToCsv([row({ fullName: "=cmd|'/c calc'!A1" })])).toContain(`"'=cmd|'/c calc'!A1"`);
  });

  it("escapes a quote inside a name rather than breaking the row", () => {
    const csv = transferListToCsv([row({ fullName: 'Pegawai "Uji"' })]);
    expect(csv).toContain('"Pegawai ""Uji"""');
    expect(csv.split("\r\n").filter((line) => line.length > 0)).toHaveLength(2);
  });

  it("keeps a name with a newline inside one quoted field", () => {
    const csv = transferListToCsv([row({ fullName: "Pegawai\nUji" })]);
    expect(csv).toContain('"Pegawai\nUji"');
    expect(csv.split("\r\n").filter((line) => line.length > 0)).toHaveLength(2);
  });

  it("keeps a negative payable on the list rather than dropping the recipient", () => {
    expect(transferListToCsv([row({ payable: "-250000" })])).toContain('"-250000"');
  });

  it("leaves a missing bank or account visibly empty rather than writing null", () => {
    const csv = transferListToCsv([
      row({ bankName: null, bankAccountNumber: null, bankAccountName: null, unitRef: null }),
    ]);
    expect(csv).not.toContain("null");
    expect(csv).toContain('"2016001","Pegawai Uji","","3000000","","","",""');
  });

  it("writes only a header when nobody is paid", () => {
    expect(transferListToCsv([])).toBe(HEADER);
  });

  it("ends with a line break, so the file can be appended to", () => {
    expect(transferListToCsv([row()]).endsWith("\r\n")).toBe(true);
  });
});

describe("PAY-003 rupiah on a payslip", () => {
  it("separates thousands with a dot, as every other YSQ document does", () => {
    expect(formatRupiah("3000000")).toBe("Rp3.000.000");
    expect(formatRupiah(4_087_766)).toBe("Rp4.087.766");
  });

  it("writes small amounts without a separator", () => {
    expect(formatRupiah("0")).toBe("Rp0");
    expect(formatRupiah("750")).toBe("Rp750");
  });

  it("keeps a negative amount negative", () => {
    expect(formatRupiah("-250000")).toBe("-Rp250.000");
  });
});
