// ORG-001: layar HC penetapan atasan langsung massal. Data sintetis, tanpa jaringan.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ManagerAssignmentPreviewTable,
  OrganizationManagerBulkTab,
} from "@/components/organization/OrganizationManagerBulkTab";
import {
  managerAssignmentChartCsv,
  type ManagerAssignmentPreviewRow,
} from "@/lib/managerAssignments";
import type { AuthSession } from "@/types/hcis";

function session(permissions: string[]): AuthSession {
  return {
    principal: { id: "synthetic-actor", email: "actor@example.invalid", principalType: "EMPLOYEE" },
    expiresAt: "2099-01-01T00:00:00Z",
    authorization: { organizationPermissions: permissions },
  };
}

const SATU = { employeeNumber: "SYN-001", fullName: "Pegawai Sintetis Satu" };
const PEMIMPIN = { employeeNumber: "SYN-009", fullName: "Pemimpin Unit Sintetis" };

const rows: ManagerAssignmentPreviewRow[] = [
  {
    rowNumber: 2,
    employeeNumber: "SYN-002",
    employeeName: "Pegawai Sintetis Dua",
    managerNumber: "SYN-001",
    outcome: "change",
    fromManager: null,
    toManager: SATU,
    code: null,
    message: null,
    // Berkas dan bagan berselisih di baris ini.
    chartManager: PEMIMPIN,
    chartSource: "MEMBERSHIP_LEADER",
    chartIssue: null,
    chartAgrees: false,
  },
  {
    rowNumber: 3,
    employeeNumber: "SYN-003",
    employeeName: "Pegawai Sintetis Tiga",
    managerNumber: "SYN-001",
    outcome: "unchanged",
    fromManager: SATU,
    toManager: SATU,
    code: null,
    message: null,
    chartManager: SATU,
    chartSource: "MEMBERSHIP_LEADER",
    chartIssue: null,
    chartAgrees: true,
  },
  {
    rowNumber: 4,
    employeeNumber: "SYN-004",
    employeeName: "Pegawai Sintetis Empat",
    managerNumber: "SYN-404",
    outcome: "refused",
    fromManager: null,
    toManager: null,
    code: "MANAGER_NOT_FOUND",
    message: "NIP atasan tidak terdaftar pada master pegawai.",
    chartManager: null,
    chartSource: null,
    chartIssue: "MEMBERSHIP_NOT_CONFIGURED",
    chartAgrees: null,
  },
];

describe("ORG-001 tabel hasil dry-run atasan langsung", () => {
  it("menyebut ketiga hasil, dengan atasan lama dan atasan baru pada baris yang berubah", () => {
    const markup = renderToStaticMarkup(<ManagerAssignmentPreviewTable rows={rows} />);

    expect(markup).toContain("Akan berubah");
    expect(markup).toContain("Tidak berubah");
    expect(markup).toContain("Ditolak");
    expect(markup).toContain("Tanpa atasan");
    expect(markup).toContain("Pegawai Sintetis Satu (SYN-001)");
    expect(markup).toContain("MANAGER_NOT_FOUND");
  });

  it("tidak menyembunyikan baris apa pun", () => {
    const markup = renderToStaticMarkup(<ManagerAssignmentPreviewTable rows={rows} />);
    for (const row of rows) expect(markup).toContain(row.employeeNumber);
  });

  it("menyebut atasan menurut bagan dan menandai baris yang berbeda darinya", () => {
    const markup = renderToStaticMarkup(<ManagerAssignmentPreviewTable rows={rows} />);

    expect(markup).toContain("Menurut bagan (usulan)");
    expect(markup).toContain("Pemimpin Unit Sintetis (SYN-009)");
    expect(markup).toContain("Berbeda dari berkas");
    expect(markup).toContain("Sama dengan berkas");
    // Baris yang bagannya tidak menjawab menyebut alasannya, bukan diam saja.
    expect(markup).toContain("Bagan belum menentukan");
    expect(markup).toContain("MEMBERSHIP_NOT_CONFIGURED");
  });
});

describe("ORG-001 berkas usulan dari bagan", () => {
  function row(employeeNumber: string, chartManagerNumber: string | null): ManagerAssignmentPreviewRow {
    return {
      ...rows[0]!,
      employeeNumber,
      chartManager: chartManagerNumber
        ? { employeeNumber: chartManagerNumber, fullName: "Pegawai Sintetis" }
        : null,
    };
  }

  it("menuliskan usulan bagan sebagai CSV yang dapat diunggah ulang HC", () => {
    expect(managerAssignmentChartCsv(rows)).toBe(
      ['NIP,NIP ATASAN', '"SYN-002","SYN-009"', '"SYN-003","SYN-001"', '"SYN-004",""'].join("\r\n"),
    );
  });

  it("mengutip sel yang memuat koma sehingga barisnya tidak pecah", () => {
    // employee_number bertipe text tanpa CHECK: sel seperti ini tidak merusak berkas.
    expect(managerAssignmentChartCsv([row('SYN,005', 'SYN"006')])).toBe(
      ['NIP,NIP ATASAN', '"SYN,005","SYN""006"'].join("\r\n"),
    );
  });

  it("menjinakkan sel yang dimulai dengan = agar tidak dieksekusi sebagai formula", () => {
    expect(managerAssignmentChartCsv([row("=cmd()", "+1")])).toBe(
      ['NIP,NIP ATASAN', `"'=cmd()","'+1"`].join("\r\n"),
    );
  });
});

describe("ORG-001 layar penetapan atasan langsung massal", () => {
  it("menerangkan format berkas dan arti sel kosong sebelum berkas diunggah", () => {
    const markup = renderToStaticMarkup(
      <OrganizationManagerBulkTab session={session(["organization.manage", "approvals.policy.manage"])} />,
    );

    expect(markup).toContain("NIP ATASAN");
    expect(markup).toContain("template-atasan-langsung.csv");
    expect(markup).toContain("Periksa berkas");
    // Tanpa dry-run tidak ada tombol konfirmasi sama sekali.
    expect(markup).not.toContain("Konfirmasi penetapan");
  });

  it("UX-FLOW-001: satu langkah per layar, tanpa ringkasan atau kirim bertumpuk", () => {
    const markup = renderToStaticMarkup(
      <OrganizationManagerBulkTab session={session(["organization.manage", "approvals.policy.manage"])} />,
    );

    // Penanda langkah ada, dan langkah pertama yang aktif.
    expect(markup).toContain("Unggah berkas");
    expect(markup).toContain("aria-current=\"step\"");
    // Tidak ada bagian langkah berikutnya yang ikut tampil di layar unggah.
    for (const later of ["Akan dikosongkan", "Ganti berkas", "Menurut bagan (usulan)", "Periksa berkas lain"]) {
      expect(markup, later).not.toContain(later);
    }
  });

  it("memberi tahu account yang tidak memegang kewenangan persetujuan", () => {
    const markup = renderToStaticMarkup(
      <OrganizationManagerBulkTab session={session(["organization.manage"])} />,
    );
    expect(markup).toContain("dijalankan oleh pemegang kewenangan persetujuan");
  });
});
