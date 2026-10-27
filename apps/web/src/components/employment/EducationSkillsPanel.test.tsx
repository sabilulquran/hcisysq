// EMP-007 P2-2 screen: view states, what an account without employees.manage
// may do, the derived labels, and the payload the API is sent (spec §7.1).
// Static render; synthetic records only.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  EDUCATION_LEVEL_LABEL,
  type EducationRecord,
  type SkillRecord,
} from "@/lib/employeeProfile";
import {
  EMPTY_EDUCATION,
  EMPTY_SKILL,
  EducationForm,
  EducationRecords,
  SkillForm,
  SkillRecords,
  educationPayload,
  skillPayload,
  viewFromProfileError,
  type RecordActions,
} from "@/components/employment/EducationSkillsPanel";
import { EmploymentApiError } from "@/lib/employment";
import { EmployeeDetailTabs } from "@/pages/AdminEmployeeDetailPage";
import { canAccessAdminPath } from "@/lib/authorization";
import type { AuthSession } from "@/types/hcis";

const EMPLOYEE_ID = "10000000-0000-4000-8000-000000000001";

const education: EducationRecord = {
  id: "40000000-0000-4000-8000-000000000001",
  employeeId: EMPLOYEE_ID,
  level: "D4_S1",
  institutionName: "Universitas Sintetis",
  major: "Pendidikan Agama Islam",
  startedYear: 2014,
  completedYear: 2018,
  completionStatus: "SELESAI",
  degreeTitle: "S.Pd.",
  certificateNumber: null,
  archiveReference: null,
  notes: null,
  verificationStatus: "DIVERIFIKASI",
  verifiedAt: "2026-10-01T00:00:00.000Z",
  unverifiedAt: null,
  unverifiedReason: null,
  voidedAt: null,
  voidedReason: null,
};

const skill: SkillRecord = {
  id: "40000000-0000-4000-8000-000000000002",
  employeeId: EMPLOYEE_ID,
  kind: "SERTIFIKAT",
  name: "Sertifikat Pendidik",
  category: "PENGAJARAN",
  proficiency: null,
  issuer: "Kementerian Agama",
  certificateNumber: null,
  issuedOn: "2020-01-10",
  expiresOn: "2024-01-10",
  archiveReference: null,
  notes: null,
  verificationStatus: "DILAPORKAN",
  verifiedAt: null,
  unverifiedAt: null,
  unverifiedReason: null,
  voidedAt: null,
  voidedReason: null,
  expired: true,
};

function actions(canManage: boolean): RecordActions {
  return {
    canManage,
    onEdit: () => undefined,
    onVerify: () => undefined,
    onUnverify: () => undefined,
    onVoid: () => undefined,
  };
}

const render = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

function session(permissions: string[]): AuthSession {
  return {
    principal: { id: "actor", email: "actor@example.invalid", principalType: "EMPLOYEE" },
    expiresAt: "2099-01-01T00:00:00Z",
    authorization: { organizationPermissions: permissions },
  };
}

describe("EMP-007 education records", () => {
  it("says it is loading, and says plainly when the account may not look", () => {
    expect(render(<EducationRecords view={{ kind: "loading" }} actions={actions(true)} onAdd={() => undefined} />))
      .toContain("Memuat data");
    expect(render(<EducationRecords view={{ kind: "forbidden" }} actions={actions(true)} onAdd={() => undefined} />))
      .toContain("tidak berhak");
  });

  it("shows the derived highest level rather than anything typed in", () => {
    const html = render(
      <EducationRecords
        view={{ kind: "ready", data: { rows: [education], highestLevel: "D4_S1" } }}
        actions={actions(false)}
        onAdd={() => undefined}
      />,
    );
    expect(html).toContain("Pendidikan tertinggi");
    expect(html).toContain(EDUCATION_LEVEL_LABEL.D4_S1);
    expect(html).toContain("Universitas Sintetis");
  });

  it("says so when no verified record can settle the highest level", () => {
    const html = render(
      <EducationRecords
        view={{ kind: "ready", data: { rows: [], highestLevel: null } }}
        actions={actions(true)}
        onAdd={() => undefined}
      />,
    );
    expect(html).toContain("Belum dapat ditentukan");
    expect(html).toContain("Belum ada catatan pendidikan");
  });

  it("offers no recording or voiding to an account without employees.manage", () => {
    const view = { kind: "ready" as const, data: { rows: [education], highestLevel: "D4_S1" as const } };
    const readOnly = render(<EducationRecords view={view} actions={actions(false)} onAdd={() => undefined} />);
    expect(readOnly).not.toContain("Tambah pendidikan");
    expect(readOnly).not.toContain("Batalkan");
    const managing = render(<EducationRecords view={view} actions={actions(true)} onAdd={() => undefined} />);
    expect(managing).toContain("Tambah pendidikan");
    expect(managing).toContain("Batalkan");
    // A verified record is offered the revert, not a second verification.
    expect(managing).toContain("Cabut verifikasi");
    expect(managing).not.toContain("Tandai terverifikasi");
  });

  it("keeps the reason a revoked verification carries", () => {
    const html = render(
      <EducationRecords
        view={{
          kind: "ready",
          data: {
            rows: [{ ...education, verificationStatus: "DILAPORKAN", unverifiedReason: "Ijazah asli belum ditunjukkan" }],
            highestLevel: null,
          },
        }}
        actions={actions(true)}
        onAdd={() => undefined}
      />,
    );
    expect(html).toContain("Ijazah asli belum ditunjukkan");
    expect(html).toContain("Tandai terverifikasi");
  });
});

describe("EMP-007 skill records", () => {
  it("marks a lapsed certificate instead of hiding it", () => {
    const html = render(
      <SkillRecords view={{ kind: "ready", data: { rows: [skill], date: "2026-10-27" } }} actions={actions(true)} onAdd={() => undefined} />,
    );
    expect(html).toContain("Sertifikat Pendidik");
    expect(html).toContain("Masa berlaku habis");
    expect(html).toContain("Kementerian Agama");
  });

  it("says when a skill has no expiry at all", () => {
    const html = render(
      <SkillRecords
        view={{ kind: "ready", data: { rows: [{ ...skill, kind: "KEAHLIAN", proficiency: "MAHIR", expiresOn: null, issuedOn: null, expired: false }], date: "2026-10-27" } }}
        actions={actions(true)}
        onAdd={() => undefined}
      />,
    );
    expect(html).toContain("Tanpa masa berlaku");
    expect(html).toContain("Mahir");
    expect(html).not.toContain("Masa berlaku habis");
  });
});

describe("EMP-007 forms", () => {
  it("asks for the certificate dates, and for a level only on a plain skill", () => {
    const certificate = render(
      <SkillForm draft={EMPTY_SKILL} editing={false} busy={false} onChange={() => undefined} onSubmit={() => undefined} onCancel={() => undefined} />,
    );
    expect(certificate).toContain("Berlaku sampai");
    expect(certificate).not.toContain("Tingkat");
    // The table demands both of these for a certificate, so the form does too.
    expect(certificate).toContain("Penerbit (wajib)");
    expect(certificate).toContain("Tanggal terbit (wajib)");
    const plain = render(
      <SkillForm draft={{ ...EMPTY_SKILL, kind: "KEAHLIAN" }} editing={false} busy={false} onChange={() => undefined} onSubmit={() => undefined} onCancel={() => undefined} />,
    );
    expect(plain).toContain("Tingkat");
    expect(plain).not.toContain("(wajib)");
  });

  it("names itself an amendment when it edits an existing record", () => {
    const html = render(
      <EducationForm draft={EMPTY_EDUCATION} editing busy={false} onChange={() => undefined} onSubmit={() => undefined} onCancel={() => undefined} />,
    );
    expect(html).toContain("Ubah catatan pendidikan");
  });

  it("sends nulls rather than empty strings, and no proficiency on a certificate", () => {
    expect(educationPayload({ ...EMPTY_EDUCATION, institutionName: "  Universitas Sintetis  ", major: "   " }))
      .toMatchObject({ institutionName: "Universitas Sintetis", major: null, degreeTitle: null });
    expect(skillPayload({ ...EMPTY_SKILL, name: "Sertifikat", proficiency: "MAHIR", expiresOn: "" }))
      .toMatchObject({ proficiency: null, expiresOn: null });
    expect(skillPayload({ ...EMPTY_SKILL, kind: "KEAHLIAN", name: "Excel", proficiency: "MAHIR" }))
      .toMatchObject({ proficiency: "MAHIR" });
  });
});

describe("EMP-007 access", () => {
  it("shows the tab to an account that may read the employee master, and hides it otherwise", () => {
    const withProfile = render(
      <EmployeeDetailTabs active="ringkasan" canReadEmployment={false} canReadProfile onSelect={() => undefined} />,
    );
    expect(withProfile).toContain("Pendidikan &amp; Keahlian");
    expect(withProfile).not.toContain("Kepegawaian");

    const withoutProfile = render(
      <EmployeeDetailTabs active="ringkasan" canReadEmployment canReadProfile={false} onSelect={() => undefined} />,
    );
    expect(withoutProfile).not.toContain("Pendidikan");
    expect(withoutProfile).toContain("Kepegawaian");

    expect(render(<EmployeeDetailTabs active="ringkasan" canReadEmployment={false} onSelect={() => undefined} />)).toBe("");
  });

  it("gates the expiring-certificate worklist on employees.read.all", () => {
    const path = "/admin/employees/certificates/expiring";
    expect(canAccessAdminPath(session(["employees.read.all"]), path)).toBe(true);
    expect(canAccessAdminPath(session(["employment.read"]), path)).toBe(false);
  });

  it("turns a refusal into its own view state rather than an error message", () => {
    expect(viewFromProfileError(new EmploymentApiError(403, "FORBIDDEN", "x"))).toEqual({ kind: "forbidden" });
    expect(viewFromProfileError(new EmploymentApiError(409, "EMPLOYEE_RECORD_VOIDED", "Catatan ini sudah dibatalkan.")))
      .toEqual({ kind: "error", message: "Catatan ini sudah dibatalkan." });
    expect(viewFromProfileError(new Error("offline")).kind).toBe("error");
  });
});
