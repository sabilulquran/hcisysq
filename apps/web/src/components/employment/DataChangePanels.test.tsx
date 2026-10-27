// EMP-003 P2-4 screens: view states, what each side may do, how a proposal
// reads, and the access the two paths need. Static render; synthetic
// proposals only.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  DataChangeWorklistView,
  MyDataChanges,
  ProposalSummary,
  StateBadge,
} from "@/components/employment/DataChangePanels";
import { payloadLines, type DataChangeRequest } from "@/lib/employeeDataChanges";
import { viewFromDataChangeError } from "@/pages/EmployeeDataChangesPage";
import { EmploymentApiError } from "@/lib/employment";
import { canAccessAdminPath } from "@/lib/authorization";
import type { AuthSession } from "@/types/hcis";

const EMPLOYEE_ID = "10000000-0000-4000-8000-000000000001";

const pending: DataChangeRequest = {
  id: "60000000-0000-4000-8000-000000000001",
  employeeId: EMPLOYEE_ID,
  employeeNumber: "YSQ-0001",
  fullName: "Pegawai Sintetis",
  unitName: "Unit Sintetis",
  submittedByAccountId: "00000000-0000-4000-8000-000000000001",
  target: "ALAMAT",
  payload: { kind: "DOMISILI", addressLine: "Jalan Sintetis 9", city: "Bandung", validFrom: "2026-11-01" },
  state: "DIAJUKAN",
  decidedByAccountId: null,
  decidedAt: null,
  decisionNote: null,
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z",
};

const rejected: DataChangeRequest = {
  ...pending,
  id: "60000000-0000-4000-8000-000000000002",
  state: "DITOLAK",
  decisionNote: "Alamat tidak sesuai dokumen",
  decidedByAccountId: "00000000-0000-4000-8000-000000000002",
  decidedAt: "2026-10-21T00:00:00.000Z",
};

const render = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

function session(permissions: string[]): AuthSession {
  return {
    principal: { id: "actor", email: "actor@example.invalid", principalType: "EMPLOYEE" },
    expiresAt: "2099-01-01T00:00:00Z",
    authorization: { organizationPermissions: permissions },
  };
}

function worklistActions(canDecide: boolean) {
  return { canDecide, onAccept: () => undefined, onReject: () => undefined };
}

describe("EMP-003 the employee's own list", () => {
  it("says it is loading, and says plainly when the account may not look", () => {
    expect(render(<MyDataChanges view={{ kind: "loading" }} onCancel={() => undefined} />)).toContain("Memuat data");
    expect(render(<MyDataChanges view={{ kind: "forbidden" }} onCancel={() => undefined} />)).toContain("tidak berhak");
    expect(render(<MyDataChanges view={{ kind: "ready", data: [] }} onCancel={() => undefined} />))
      .toContain("Belum ada usulan");
  });

  it("offers a withdrawal only while the proposal is waiting", () => {
    expect(render(<MyDataChanges view={{ kind: "ready", data: [pending] }} onCancel={() => undefined} />))
      .toContain("Batalkan usulan");
    const decided = render(<MyDataChanges view={{ kind: "ready", data: [rejected] }} onCancel={() => undefined} />);
    expect(decided).not.toContain("Batalkan usulan");
    expect(decided).toContain("Alasan penolakan: Alamat tidak sesuai dokumen");
  });

  it("spells out what was proposed, field by field", () => {
    const html = render(<ProposalSummary request={pending} />);
    expect(html).toContain("Alamat:");
    expect(html).toContain("Jalan Sintetis 9");
    expect(html).toContain("Kota/kabupaten:");
  });

  it("leaves out the fields a proposal did not name", () => {
    expect(payloadLines({ email: "a@b.c", phone: null, notes: "" })).toEqual([{ label: "Email", value: "a@b.c" }]);
    expect(payloadLines({ isDependent: true })).toEqual([{ label: "Tanggungan", value: "Ya" }]);
  });

  it("names each state in words", () => {
    expect(render(<StateBadge state="DIAJUKAN" />)).toContain("Menunggu keputusan");
    expect(render(<StateBadge state="DITERIMA" />)).toContain("Diterima");
  });
});

describe("EMP-003 the HC worklist", () => {
  const view = { kind: "ready" as const, data: { rows: [pending], total: 1, state: "DIAJUKAN" as const } };

  it("shows who proposed what, and links to the employee", () => {
    const html = render(
      <DataChangeWorklistView view={view} actions={worklistActions(true)} employeeHref={(id) => `/admin/employees/${id}`} />,
    );
    expect(html).toContain("Pegawai Sintetis");
    expect(html).toContain(`/admin/employees/${EMPLOYEE_ID}`);
    expect(html).toContain("Alamat");
    expect(html).toContain("Terima");
    expect(html).toContain("Tolak");
  });

  it("offers no decision to an account that may only read", () => {
    const html = render(
      <DataChangeWorklistView view={view} actions={worklistActions(false)} employeeHref={() => "#"} />,
    );
    expect(html).not.toContain("Terima");
    expect(html).not.toContain("Tolak");
  });

  it("offers no decision on a proposal already decided", () => {
    const html = render(
      <DataChangeWorklistView
        view={{ kind: "ready", data: { rows: [rejected], total: 1, state: "DITOLAK" } }}
        actions={worklistActions(true)}
        employeeHref={() => "#"}
      />,
    );
    expect(html).not.toContain(">Terima<");
    expect(html).toContain("Catatan keputusan: Alamat tidak sesuai dokumen");
  });

  it("says which queue is empty rather than just showing nothing", () => {
    const html = render(
      <DataChangeWorklistView
        view={{ kind: "ready", data: { rows: [], total: 0, state: "DIAJUKAN" } }}
        actions={worklistActions(true)}
        employeeHref={() => "#"}
      />,
    );
    expect(html).toContain("Tidak ada usulan berstatus menunggu keputusan");
  });
});

describe("EMP-003 access", () => {
  it("gates the HC queue on employees.read.all", () => {
    const path = "/admin/employees/data-changes";
    expect(canAccessAdminPath(session(["employees.read.all"]), path)).toBe(true);
    expect(canAccessAdminPath(session(["employment.read"]), path)).toBe(false);
  });

  it("turns a refusal into its own view state", () => {
    expect(viewFromDataChangeError(new EmploymentApiError(403, "EMPLOYEE_ACCOUNT_REQUIRED", "x")))
      .toEqual({ kind: "forbidden" });
    expect(viewFromDataChangeError(new EmploymentApiError(409, "DATA_CHANGE_NOT_PENDING", "Usulan ini sudah diputuskan.")))
      .toEqual({ kind: "error", message: "Usulan ini sudah diputuskan." });
    expect(viewFromDataChangeError(new Error("offline")).kind).toBe("error");
  });
});
