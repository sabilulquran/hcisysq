// DOC-001 D-20: the printable surat keterangan, rendered as markup. Synthetic data.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CertificateLetterPaper,
  incomeEmployerBorneNote,
  incomeEmployerColumnTitle,
  incomeMixedLayoutNote,
} from "@/components/documents/CertificateLetterPaper";
import { formatRupiahAmount, type IssuedDocumentSummary } from "@/lib/hrDocuments";

function letter(overrides: Partial<IssuedDocumentSummary> = {}): IssuedDocumentSummary {
  return {
    id: "30000000-0000-4000-8000-000000000001",
    documentCode: "KETERANGAN_KERJA",
    documentNumber: "001/SKK/YSQ/XI/2026",
    status: "ISSUED",
    issuedAt: "2026-11-03T01:00:00.000Z",
    signer: { title: "Kepala Human Capital Management", name: "Contoh Penandatangan" },
    contentSnapshot: {
      documentLabel: "Surat Keterangan Kerja",
      fullName: "Pegawai Contoh",
      employeeNumber: "YSQ-0001",
      positionTitle: "Guru",
      unitName: "SDIT",
      startedOn: "2020-01-06",
      endedOn: null,
      purpose: "Pengajuan beasiswa anak",
    },
    ...overrides,
  };
}

describe("DOC-001 D-20 certificate letter", () => {
  it("prints the snapshot, purpose, number and signer of an active employee's letter", () => {
    const html = renderToStaticMarkup(<CertificateLetterPaper document={letter()} />);
    expect(html).toContain("SURAT KETERANGAN KERJA");
    expect(html).toContain("Nomor: 001/SKK/YSQ/XI/2026");
    expect(html).toContain("Pegawai Contoh");
    expect(html).toContain("6 Januari 2020");
    expect(html).toContain("masih aktif bekerja");
    expect(html).toContain("untuk keperluan: Pengajuan beasiswa anak.");
    expect(html).toContain("3 November 2026");
    expect(html).toContain("Contoh Penandatangan");
  });

  it("states the period for a paklaring and skips an empty purpose", () => {
    const html = renderToStaticMarkup(<CertificateLetterPaper document={letter({
      documentCode: "PAKLARING",
      contentSnapshot: { ...letter().contentSnapshot, documentLabel: "Surat Keterangan Pengalaman Kerja", endedOn: "2026-06-30", purpose: null },
    })} />);
    expect(html).toContain("sejak 6 Januari 2020 sampai dengan 30 Juni 2026");
    expect(html).not.toContain("masih aktif");
    expect(html).not.toContain("untuk keperluan");
  });

  it("prints the income letter's frozen slip figures and averages as stored, without calculating", () => {
    const html = renderToStaticMarkup(<CertificateLetterPaper document={letter({
      documentCode: "KETERANGAN_PENGHASILAN",
      documentNumber: "001/SKP/YSQ/XI/2026",
      contentSnapshot: {
        ...letter().contentSnapshot,
        documentLabel: "Surat Keterangan Penghasilan",
        purpose: "Pengajuan kredit rumah",
        income: {
          months: [
            { period: "2026-08", gross: "5000000", net: "4500000" },
            { period: "2026-09", gross: "5250000", net: "4700000" },
            { period: "2026-10", gross: "5100000.50", net: "4600001" },
          ],
          monthCount: 3,
          averageGross: "5116667",
          averageNet: "4600000",
          windowFrom: "2026-08",
          windowTo: "2026-10",
        },
      },
    })} />);
    expect(html).toContain("SURAT KETERANGAN PENGHASILAN");
    expect(html).toContain("penghasilan menurut slip gaji resmi");
    expect(html).toContain("Agustus 2026");
    expect(html).toContain("Rp5.250.000");
    expect(html).toContain("Rp5.100.000,50");
    expect(html).toContain("Rp5.116.667");
    expect(html).toContain("Rp4.600.000");
    expect(html).toContain("periode Agustus 2026 sampai dengan Oktober 2026.");
    expect(html).not.toContain("rata-rata dihitung dari");
  });

  it("says when fewer months than the window had an official slip", () => {
    const html = renderToStaticMarkup(<CertificateLetterPaper document={letter({
      documentCode: "KETERANGAN_PENGHASILAN",
      contentSnapshot: {
        ...letter().contentSnapshot,
        income: {
          months: [{ period: "2026-10", gross: "3000000", net: "2800000" }],
          monthCount: 1, averageGross: "3000000", averageNet: "2800000", windowFrom: "2026-08", windowTo: "2026-10",
        },
      },
    })} />);
    expect(html).toContain("rata-rata dihitung dari 1 bulan yang memiliki slip gaji resmi.");
  });

  // DOC-001 D-27 (owner decision 2026-11-17): the gross follows the slip, and the BPJS Kesehatan
  // contribution the yayasan bears is named on a line of its own.
  function incomeLetter(income: Record<string, unknown>) {
    return renderToStaticMarkup(<CertificateLetterPaper document={letter({
      documentCode: "KETERANGAN_PENGHASILAN",
      contentSnapshot: { ...letter().contentSnapshot, documentLabel: "Surat Keterangan Penghasilan", income },
    })} />);
  }

  it("says nothing about an employer-borne contribution when no slip in the window states one", () => {
    const html = incomeLetter({
      months: [
        { period: "2026-09", gross: "4305000", net: "3759000", employerBorne: "0", layout: "LEGACY" },
        { period: "2026-10", gross: "4305000", net: "3759000", employerBorne: "0", layout: "LEGACY" },
      ],
      monthCount: 2,
      averageGross: "4305000",
      averageNet: "3759000",
      averageEmployerBorne: "0",
      mixedLayout: false,
      windowFrom: "2026-09",
      windowTo: "2026-10",
    });
    expect(html).not.toContain(incomeEmployerColumnTitle);
    expect(html).not.toContain(incomeEmployerBorneNote);
  });

  it("names the contribution the yayasan bears, beside the pay and never inside it", () => {
    const html = incomeLetter({
      months: [
        { period: "2026-09", gross: "4100000", net: "3759000", employerBorne: "205000", layout: "EMPLOYER_BLOCK" },
        { period: "2026-10", gross: "4100000", net: "3759000", employerBorne: "205000", layout: "EMPLOYER_BLOCK" },
      ],
      monthCount: 2,
      averageGross: "4100000",
      averageNet: "3759000",
      averageEmployerBorne: "205000",
      mixedLayout: false,
      windowFrom: "2026-09",
      windowTo: "2026-10",
    });
    expect(html).toContain(incomeEmployerColumnTitle);
    expect(html).toContain(incomeEmployerBorneNote);
    expect(html).toContain("Rp205.000");
    // Not a mixed window: no warning, and no month left empty.
    expect(html).not.toContain("menggabungkan dua cara penyajian slip");
  });

  it("warns, and names the months, when the window mixes the two slip layouts", () => {
    const html = incomeLetter({
      months: [
        { period: "2026-08", gross: "4305000", net: "3759000", employerBorne: "0", layout: "LEGACY", employerBorneInGross: "205000" },
        { period: "2026-09", gross: "4100000", net: "3759000", employerBorne: "205000", layout: "EMPLOYER_BLOCK" },
        { period: "2026-10", gross: "4100000", net: "3759000", employerBorne: "205000", layout: "EMPLOYER_BLOCK" },
      ],
      monthCount: 3,
      averageGross: "4168333",
      averageNet: "3759000",
      averageEmployerBorne: "136667",
      mixedLayout: true,
      windowFrom: "2026-08",
      windowTo: "2026-10",
    });
    expect(html).toContain(incomeMixedLayoutNote([{ period: "2026-08", employerBorneInGross: "205000" }]));
    expect(html).toContain("Agustus 2026 (Rp205.000)");
    expect(html).toContain("tidak disusun dengan cara yang sama");
    // The sentence that defines the contribution must be read before the one referring to it.
    expect(html.indexOf(incomeEmployerBorneNote)).toBeLessThan(
      html.indexOf(incomeMixedLayoutNote([{ period: "2026-08", employerBorneInGross: "205000" }])),
    );
    // ...and both before the source note at the foot of the figures.
    expect(html.indexOf(incomeMixedLayoutNote([{ period: "2026-08", employerBorneInGross: "205000" }])))
      .toBeLessThan(html.indexOf("Angka diambil dari slip gaji resmi periode"));
    // B2: the average would add a month that states the contribution to one that does not.
    expect(html).not.toContain("Rp136.667");
  });

  it("names every month of a mixed window, not only the first", () => {
    const note = incomeMixedLayoutNote([
      { period: "2026-08", employerBorneInGross: "205000" },
      { period: "2026-09", employerBorneInGross: null },
    ]);
    expect(note).toContain("Agustus 2026 (Rp205.000) dan September 2026");
    expect(note).toContain("Nominal dalam kurung");
  });

  it("claims nothing it did not read when no legacy slip stated an amount", () => {
    const note = incomeMixedLayoutNote([{ period: "2026-08", employerBorneInGross: null }]);
    expect(note).toContain("Slip periode Agustus 2026 masih disusun dengan cara lama");
    // It must not assert that a contribution IS inside that month's gross: the slip did not say so.
    expect(note).toContain("bila ada");
    expect(note).not.toContain("Nominal dalam kurung");
  });

  it("prints a letter issued before the block existed exactly as it did", () => {
    const html = incomeLetter({
      months: [{ period: "2026-10", gross: "3000000", net: "2800000" }],
      monthCount: 1,
      averageGross: "3000000",
      averageNet: "2800000",
      windowFrom: "2026-10",
      windowTo: "2026-10",
    });
    expect(html).toContain("Rp3.000.000");
    expect(html).not.toContain(incomeEmployerColumnTitle);
  });

  it("formats rupiah strings without floating point", () => {
    expect(formatRupiahAmount("5116667")).toBe("Rp5.116.667");
    expect(formatRupiahAmount("999")).toBe("Rp999");
    expect(formatRupiahAmount("1234567890123.05")).toBe("Rp1.234.567.890.123,05");
  });
});
