// ORG-001: layar HC penetapan atasan langsung massal. Data sintetis, tanpa jaringan.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ManagerAssignmentPreviewTable,
  OrganizationManagerBulkTab,
} from "@/components/organization/OrganizationManagerBulkTab";
import type { ManagerAssignmentPreviewRow } from "@/lib/managerAssignments";
import type { AuthSession } from "@/types/hcis";

function session(permissions: string[]): AuthSession {
  return {
    principal: { id: "synthetic-actor", email: "actor@example.invalid", principalType: "EMPLOYEE" },
    expiresAt: "2099-01-01T00:00:00Z",
    authorization: { organizationPermissions: permissions },
  };
}

const rows: ManagerAssignmentPreviewRow[] = [
  {
    rowNumber: 2,
    employeeNumber: "SYN-002",
    employeeName: "Pegawai Sintetis Dua",
    managerNumber: "SYN-001",
    outcome: "change",
    fromManager: null,
    toManager: { employeeNumber: "SYN-001", fullName: "Pegawai Sintetis Satu" },
    code: null,
    message: null,
  },
  {
    rowNumber: 3,
    employeeNumber: "SYN-003",
    employeeName: "Pegawai Sintetis Tiga",
    managerNumber: "SYN-001",
    outcome: "unchanged",
    fromManager: { employeeNumber: "SYN-001", fullName: "Pegawai Sintetis Satu" },
    toManager: { employeeNumber: "SYN-001", fullName: "Pegawai Sintetis Satu" },
    code: null,
    message: null,
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

  it("memberi tahu account yang tidak memegang kewenangan persetujuan", () => {
    const markup = renderToStaticMarkup(
      <OrganizationManagerBulkTab session={session(["organization.manage"])} />,
    );
    expect(markup).toContain("dijalankan oleh pemegang kewenangan persetujuan");
  });
});
