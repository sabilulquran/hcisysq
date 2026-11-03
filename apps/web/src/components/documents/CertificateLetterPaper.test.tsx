// DOC-001 D-20: the printable surat keterangan, rendered as markup. Synthetic data.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CertificateLetterPaper } from "@/components/documents/CertificateLetterPaper";
import type { IssuedDocumentSummary } from "@/lib/hrDocuments";

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
});
