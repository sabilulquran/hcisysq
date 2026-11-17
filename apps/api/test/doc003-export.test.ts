// DOC-004 §10: the export rules, without a database.

import { describe, expect, it } from "vitest";

import { buildEkspor, ringkasan, validateEkspor, type BarisDoc003 } from "../src/modules/documents/doc003-export.js";

const EMPLOYEE = "3f1a2b4c-5d6e-4f70-8192-a3b4c5d6e7f8";
const NUMBER_ID = "9a8b7c6d-5e4f-4039-8271-6a5b4c3d2e1f";

function rows(override: Partial<BarisDoc003> = {}): BarisDoc003 {
  return {
    types: [{ code: "UND", label: "Undangan" }],
    issuers: [{ code: "HCM.YSQ", name: "Human Capital", kind: "UNIT" }],
    grants: [{ issuer_code: "HCM.YSQ", employee_id: EMPLOYEE, reason: "Petugas register" }],
    counters: [{ issuer_code: "HCM.YSQ", type_code: "UND", period_key: "2026", last_sequence: 4 }],
    numbers: [
      {
        id: NUMBER_ID,
        issuer_code: "HCM.YSQ",
        type_code: "UND",
        period_key: "2026",
        sequence: 4,
        letter_number: "004/UND/YSQ/XI/2026",
        letter_date: "2026-11-17",
        subject: "Undangan rapat",
        recipient: "Seluruh kepala unit",
        status: "ALLOCATED",
        void_reason: null,
        requested_by_employee_id: EMPLOYEE,
      },
    ],
    ...override,
  };
}

describe("ekspor DOC-003", () => {
  it("hanya membawa rujukan pegawai, bukan data pribadi (C-04)", () => {
    const ekspor = buildEkspor(rows());
    expect(ekspor.grants[0]!.personId).toBe(`hcis:employee:${EMPLOYEE}`);
    expect(ekspor.numbers[0]!.requestedBy).toBe(`hcis:employee:${EMPLOYEE}`);
    expect(JSON.stringify(ekspor)).not.toContain("Human Capital, NIP");
  });

  it("memakai id baris sebagai sourceId (C-03)", () => {
    expect(buildEkspor(rows()).numbers[0]!.sourceId).toBe(NUMBER_ID);
  });

  it("menerima buku yang konsisten", () => {
    expect(validateEkspor(buildEkspor(rows()))).toEqual([]);
  });

  it("membawa nomor yang dibatalkan beserta alasannya", () => {
    const ekspor = buildEkspor(
      rows({
        numbers: [
          {
            ...rows().numbers[0]!,
            status: "VOIDED",
            void_reason: "Surat dibatalkan karena acara ditunda",
          },
        ],
      }),
    );
    expect(ekspor.numbers[0]!.status).toBe("VOIDED");
    expect(ekspor.numbers[0]!.voidedReason).toBe("Surat dibatalkan karena acara ditunda");
    expect(ringkasan(ekspor)).toMatchObject({ nomorDibatalkan: 1, nomorTerpakai: 0 });
  });

  it("menolak penghitung yang lebih kecil dari urut tertinggi", () => {
    const problems = validateEkspor(
      buildEkspor(rows({ counters: [{ issuer_code: "HCM.YSQ", type_code: "UND", period_key: "2026", last_sequence: 3 }] })),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("lebih kecil dari urut tertinggi 4");
  });

  it("menolak kode penerbit satu karakter yang ditolak katalog Sekretariat", () => {
    const base = rows();
    const problems = validateEkspor(
      buildEkspor({
        ...base,
        issuers: [{ code: "A", name: "Penerbit lama", kind: "OTHER" }],
        grants: [],
        counters: [{ issuer_code: "A", type_code: "UND", period_key: "2026", last_sequence: 4 }],
        numbers: [{ ...base.numbers[0]!, issuer_code: "A" }],
      }),
    );
    expect(problems.some((problem) => problem.includes("minimal dua karakter"))).toBe(true);
  });

  it("menolak nomor yang penerbitnya tidak ikut terekspor", () => {
    const base = rows();
    const problems = validateEkspor(buildEkspor({ ...base, issuers: [], grants: [], counters: [] }));
    expect(problems.some((problem) => problem.includes("tidak ikut terekspor"))).toBe(true);
  });

  it("menolak perihal yang melebihi batas Sekretariat", () => {
    const base = rows();
    const problems = validateEkspor(
      buildEkspor({ ...base, numbers: [{ ...base.numbers[0]!, subject: "x".repeat(301) }] }),
    );
    expect(problems.some((problem) => problem.includes("melebihi 300 karakter"))).toBe(true);
  });

  it("menghasilkan berkas yang sama bila dijalankan dua kali", () => {
    expect(JSON.stringify(buildEkspor(rows()))).toBe(JSON.stringify(buildEkspor(rows())));
  });

  it("melipat penghitung bulanan ke tahunnya pada ringkasan", () => {
    const hitung = ringkasan(
      buildEkspor(
        rows({
          counters: [
            { issuer_code: "HCM.YSQ", type_code: "UND", period_key: "2026-01", last_sequence: 2 },
            { issuer_code: "HCM.YSQ", type_code: "UND", period_key: "2026-11", last_sequence: 9 },
          ],
        }),
      ),
    );
    expect(hitung.urutTertinggi).toEqual([{ kunci: "HCM.YSQ UND 2026", nilai: 9 }]);
  });
});
