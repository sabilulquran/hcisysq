// EMP-010 S4 register screen: view states, the lock, and the permission-driven
// controls (spec §13.5). Static render; synthetic documents only.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  DecisionDocumentRegister,
  DocumentDetail,
  DocumentForm,
} from "@/components/employment/DecisionDocumentRegister";
import { canAccessAdminPath } from "@/lib/authorization";
import {
  draftFrom,
  emptyDraft,
  payloadOf,
  type DecisionDocument,
  type DecisionDocumentDetail,
} from "@/lib/decision-documents";
import type { AuthSession, PrincipalType } from "@/types/hcis";

const EMPLOYEE_ID = "10000000-0000-4000-8000-000000000001";

const pk: DecisionDocument = {
  id: "30000000-0000-4000-8000-000000000001",
  documentKind: "PERJANJIAN_KERJA",
  documentNumber: "001/PK/YSQ/2027",
  signedOn: "2027-06-20",
  signedYear: 2027,
  externalReference: "Arsip HC lemari 2",
  notes: null,
  pkType: "PK_BARU",
  employeeId: EMPLOYEE_ID,
  contractFrom: "2027-07-01",
  contractTo: "2028-06-30",
  category: "KONTRAK",
  signatoryEmployerLabel: "Ketua Yayasan",
  previousPkId: null,
  skType: null,
  subject: null,
  issuingAuthorityLabel: null,
  effectiveOn: null,
  effectiveTo: null,
  employeeNumber: "YSQ-0001",
  employeeName: "Pegawai Sintetis",
  previousPkNumber: null,
  linkedActionCount: 0,
  locked: false,
  createdAt: "2027-06-20T03:00:00.000Z",
  updatedAt: "2027-06-20T03:00:00.000Z",
};

const lockedDetail: DecisionDocumentDetail = {
  ...pk,
  linkedActionCount: 1,
  locked: true,
  links: [{
    actionId: "40000000-0000-4000-8000-000000000001",
    actionType: "CONTRACT_EXTENSION",
    effectiveOn: "2027-07-01",
    employeeId: EMPLOYEE_ID,
    employeeNumber: "YSQ-0001",
    employeeName: "Pegawai Sintetis",
    state: "RECORDED",
  }],
  corrections: [{
    id: "50000000-0000-4000-8000-000000000001",
    previousValues: { documentNumber: "001/PK/YSQ/2027" },
    reason: "Nomor pada arsip berbeda",
    correctedAt: "2027-07-05T02:00:00.000Z",
  }],
};

function session(permissions: string[], principalType: PrincipalType = "EMPLOYEE"): AuthSession {
  return {
    principal: { id: "actor", email: "actor@example.invalid", principalType },
    expiresAt: "2099-01-01T00:00:00Z",
    authorization: { organizationPermissions: permissions },
  };
}

function render(node: Parameters<typeof renderToStaticMarkup>[0]) {
  return renderToStaticMarkup(node);
}

describe("EMP-010 register screen", () => {
  const props = {
    kind: "PERJANJIAN_KERJA" as const,
    onKindChange: () => undefined,
    canCorrect: false,
    employeeHref: (employeeId: string) => `/admin/employees/${employeeId}`,
  };

  it("opens on the Perjanjian Kerja tab while the list loads", () => {
    const html = render(<DecisionDocumentRegister {...props} canManage />);
    expect(html).toContain("Perjanjian Kerja");
    expect(html).toContain("Surat Keputusan");
    expect(html).toContain("Memuat daftar dokumen");
  });

  it("hides the recording button from an account without employment.manage", () => {
    expect(render(<DecisionDocumentRegister {...props} canManage={false} />)).not.toContain("Catat Perjanjian Kerja");
    expect(render(<DecisionDocumentRegister {...props} canManage />)).toContain("Catat Perjanjian Kerja");
  });
});

describe("EMP-010 document form", () => {
  it("asks for the Perjanjian Kerja fields and not the SK ones", () => {
    const html = render(
      <DocumentForm
        mode="create"
        draft={emptyDraft("PERJANJIAN_KERJA")}
        busy={false}
        error={null}
        onChange={() => undefined}
        onCancel={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    expect(html).toContain("Kontrak selesai");
    expect(html).toContain("Status kepegawaian");
    expect(html).not.toContain("Pejabat penerbit");
    expect(html).toContain("berkas hasil pindai belum dapat diunggah");
  });

  it("asks for the Surat Keputusan fields and not the PK ones", () => {
    const html = render(
      <DocumentForm
        mode="create"
        draft={emptyDraft("SURAT_KEPUTUSAN")}
        busy={false}
        error={null}
        onChange={() => undefined}
        onCancel={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    expect(html).toContain("Pejabat penerbit");
    expect(html).toContain("Perihal");
    expect(html).not.toContain("Kontrak selesai");
  });

  it("asks for a reason when correcting a locked document", () => {
    const html = render(
      <DocumentForm
        mode="correction"
        draft={draftFrom(lockedDetail)}
        busy={false}
        error="Nomor dokumen ini sudah tercatat untuk tahun yang sama."
        onChange={() => undefined}
        onCancel={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    expect(html).toContain("Alasan koreksi");
    expect(html).toContain("sudah tercatat untuk tahun yang sama");
  });

  it("sends empty optional text as null and drops fields of the other kind", () => {
    const payload = payloadOf({ ...draftFrom(pk), externalReference: "  ", notes: "", reason: "" });
    expect(payload.externalReference).toBeNull();
    expect(payload.notes).toBeNull();
    expect(payload).not.toHaveProperty("skType");
    expect(payload.contractTo).toBe("2028-06-30");
  });
});

describe("EMP-010 document detail", () => {
  const detailProps = {
    employeeHref: (employeeId: string) => `/admin/employees/${employeeId}`,
    onClose: () => undefined,
    onEdit: () => undefined,
  };

  it("marks a linked document as locked and lists the actions using it", () => {
    const html = render(<DocumentDetail document={lockedDetail} canManage canCorrect {...detailProps} />);
    expect(html).toContain("Terkunci");
    expect(html).toContain("Perpanjang kontrak");
    expect(html).toContain("Koreksi");
    expect(html).toContain("Nomor pada arsip berbeda");
  });

  it("offers no correction to an account without employment.correct", () => {
    const html = render(<DocumentDetail document={lockedDetail} canManage canCorrect={false} {...detailProps} />);
    expect(html).not.toContain(">Koreksi<");
  });

  it("offers a plain edit while no action uses the document", () => {
    const html = render(
      <DocumentDetail
        document={{ ...lockedDetail, linkedActionCount: 0, locked: false, links: [], corrections: [] }}
        canManage
        canCorrect={false}
        {...detailProps}
      />,
    );
    expect(html).toContain("Ubah");
    expect(html).toContain("Belum dipakai pada tindakan kepegawaian mana pun.");
  });
});

describe("EMP-010 menu eligibility", () => {
  it("opens the register for employment.read only", () => {
    expect(canAccessAdminPath(session(["employment.read"]), "/admin/decision-documents")).toBe(true);
    expect(canAccessAdminPath(session(["employees.manage"]), "/admin/decision-documents")).toBe(false);
    // Legacy Super Admin compatibility never carries employment.* (spec §9).
    expect(canAccessAdminPath(session(["employees.manage", "access.governance.manage"], "SUPER_ADMIN"), "/admin/decision-documents")).toBe(false);
  });
});
