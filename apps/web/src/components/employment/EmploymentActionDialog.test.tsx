// EMP-005 S5B: the action dialog and its buttons (spec §13.1, §13.3), and the
// S5A temporary-reactivation panel (§13.8). Static render; synthetic data only.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EmploymentActionDialog } from "@/components/employment/EmploymentActionDialog";
import { EmploymentActionButtons } from "@/components/employment/EmploymentPanels";
import { TemporaryReactivationPanel } from "@/components/employment/TemporaryReactivationPanel";
import { requiredDocumentKind } from "@/lib/employment-actions";

const EMPLOYEE_ID = "10000000-0000-4000-8000-000000000001";

function render(node: Parameters<typeof renderToStaticMarkup>[0]) {
  return renderToStaticMarkup(node);
}

function dialog(actionType: Parameters<typeof EmploymentActionDialog>[0]["actionType"]) {
  return render(
    <EmploymentActionDialog
      employeeId={EMPLOYEE_ID}
      employeeName="Pegawai Sintetis"
      actionType={actionType}
      onClose={() => undefined}
      onRecorded={() => undefined}
    />,
  );
}

describe("EMP-005 action buttons", () => {
  const start = () => undefined;

  it("offers the three contract actions while an employment runs", () => {
    const html = render(<EmploymentActionButtons mode="AUTHORITATIVE" state="AKTIF" canManage onStart={start} />);
    expect(html).toContain("Perpanjang kontrak");
    expect(html).toContain("Ubah status kepegawaian");
    expect(html).toContain("Akhiri hubungan kerja");
    expect(html).not.toContain("Mulai hubungan kerja baru");
  });

  it("offers a new employment only when none is effective", () => {
    const html = render(<EmploymentActionButtons mode="AUTHORITATIVE" state="BERAKHIR" canManage onStart={start} />);
    expect(html).toContain("Mulai hubungan kerja baru");
    expect(html).not.toContain("Perpanjang kontrak");
  });

  it("shows nothing without employment.manage, or while the mode is not AUTHORITATIVE", () => {
    expect(render(<EmploymentActionButtons mode="AUTHORITATIVE" state="AKTIF" canManage={false} onStart={start} />)).toBe("");
    expect(render(<EmploymentActionButtons mode="SHADOW" state="AKTIF" canManage onStart={start} />)).toBe("");
    expect(render(<EmploymentActionButtons mode="OFF" state="AKTIF" canManage onStart={start} />)).toBe("");
  });
});

describe("EMP-005 action dialog", () => {
  it("asks for the contract fields on an extension", () => {
    const html = dialog("CONTRACT_EXTENSION");
    expect(html).toContain("Perpanjang kontrak");
    expect(html).toContain("Tanggal berlaku");
    expect(html).toContain("Kontrak selesai");
    expect(html).toContain("Perjanjian Kerja");
    expect(html).not.toContain("Tanggal terakhir bekerja");
  });

  it("asks for the last working day and a reason on a termination", () => {
    const html = dialog("TERMINATION");
    expect(html).toContain("Tanggal terakhir bekerja");
    expect(html).toContain("Kontrak berakhir");
    expect(html).toContain("Mengundurkan diri");
    expect(html).not.toContain("Kontrak selesai");
  });

  it("asks where to place a new employee", () => {
    const html = dialog("HIRE");
    expect(html).toContain("Unit penempatan");
    expect(html).toContain("Label jabatan");
    expect(html).toContain("Jenis kepegawaian");
  });

  it("records nothing before the operator has checked the result", () => {
    // "Simpan" appears only once a preview came back.
    expect(dialog("CONTRACT_EXTENSION")).not.toContain(">Simpan<");
    expect(dialog("CONTRACT_EXTENSION")).toContain("Periksa");
  });
});

describe("EMP-006 career actions", () => {
  const start = () => undefined;

  it("offers every career move once a primary placement exists", () => {
    const html = render(
      <EmploymentActionButtons mode="AUTHORITATIVE" state="AKTIF" canManage group="career" hasPrimaryPlacement onStart={start} />,
    );
    expect(html).toContain("Penempatan");
    expect(html).toContain("Mutasi");
    expect(html).toContain("Promosi");
    expect(html).toContain("Demosi");
  });

  it("offers only a placement while there is none to move", () => {
    const html = render(
      <EmploymentActionButtons mode="AUTHORITATIVE" state="AKTIF" canManage group="career" onStart={start} />,
    );
    expect(html).toContain("Penempatan");
    expect(html).not.toContain("Mutasi");
  });

  it("offers nothing once the employment ended", () => {
    expect(render(
      <EmploymentActionButtons mode="AUTHORITATIVE" state="BERAKHIR" canManage group="career" hasPrimaryPlacement onStart={start} />,
    )).toBe("");
  });

  it("asks a transfer for its destination and its SK", () => {
    const html = dialog("TRANSFER");
    expect(html).toContain("Mutasi");
    expect(html).toContain("Unit tujuan");
    expect(html).toContain("Surat Keputusan");
    expect(html).toContain("Mutasi memerlukan SK Mutasi.");
    expect(html).not.toContain("Status kepegawaian");
  });

  it("marks the reason as required on a demotion", () => {
    expect(dialog("DEMOTION")).toContain("Alasan (wajib)");
    expect(dialog("TRANSFER")).toContain("Alasan</span>");
  });

  it("lets a placement be recorded as an additional duty", () => {
    const html = dialog("PLACEMENT");
    expect(html).toContain("Tugas tambahan (penempatan utama tetap)");
    expect(html).toContain("Unit penempatan");
    // A placement needs no basis document of its own.
    expect(html).not.toContain("Pilih dokumen dasar");
  });
});

describe("EMP-005 basis document the dialog asks for", () => {
  it("follows the action and the category", () => {
    expect(requiredDocumentKind("CONTRACT_EXTENSION", "KONTRAK", null)?.kind).toBe("PERJANJIAN_KERJA");
    expect(requiredDocumentKind("HIRE", "KONTRAK", null)?.kind).toBe("PERJANJIAN_KERJA");
    expect(requiredDocumentKind("HIRE", "TETAP", null)?.kind).toBe("SURAT_KEPUTUSAN");
    expect(requiredDocumentKind("CATEGORY_CHANGE", "TETAP", null)?.kind).toBe("SURAT_KEPUTUSAN");
    expect(requiredDocumentKind("TERMINATION", null, "PEMBERHENTIAN")?.kind).toBe("SURAT_KEPUTUSAN");
    // Resignation and death need no SK (policy, spec §5).
    expect(requiredDocumentKind("TERMINATION", null, "RESIGN")).toBeNull();
    expect(requiredDocumentKind("TERMINATION", null, "MENINGGAL_DUNIA")).toBeNull();
  });
});

describe("EMP-005 D-15 temporary reactivation panel", () => {
  it("explains the limit and offers to open the access", () => {
    const html = render(<TemporaryReactivationPanel accountId="00000000-0000-4000-8000-000000000001" />);
    expect(html).toContain("Akses sementara pegawai yang sudah berakhir");
    expect(html).toContain("Aktifkan sementara");
    expect(html).toContain("Maksimal 30 hari");
  });
});
