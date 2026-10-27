// EMP-009 / EMP-003 P2-3 screen: view states, what an account without
// employees.manage may do, how a period and a house move read, and what the
// forms send. Static render; synthetic records only.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AddressForm,
  AddressRecords,
  EMPTY_ADDRESS,
  EMPTY_FAMILY,
  FamilyForm,
  FamilyRecords,
  addressPayload,
  familyPayload,
  viewFromRelationError,
  type RelationActions,
} from "@/components/employment/FamilyAddressPanel";
import { EmploymentApiError } from "@/lib/employment";
import type { EmployeeAddress, FamilyMember } from "@/lib/employeeRelations";
import { EmployeeDetailTabs } from "@/pages/AdminEmployeeDetailPage";

const EMPLOYEE_ID = "10000000-0000-4000-8000-000000000001";
const ADDRESS_ID = "50000000-0000-4000-8000-000000000002";

const spouse: FamilyMember = {
  id: "50000000-0000-4000-8000-000000000001",
  employeeId: EMPLOYEE_ID,
  relation: "PASANGAN",
  fullName: "Nama Sintetis",
  birthDate: "1990-05-04",
  gender: "P",
  isDependent: true,
  dependentOrder: null,
  isEmergencyContact: true,
  emergencyPhone: "0800000000",
  emergencyPriority: 1,
  validFrom: "2015-06-01",
  validTo: null,
  notes: null,
  voidedAt: null,
  voidedReason: null,
};

const address: EmployeeAddress = {
  id: ADDRESS_ID,
  employeeId: EMPLOYEE_ID,
  kind: "DOMISILI",
  addressLine: "Jalan Sintetis 1",
  village: "Sukamaju",
  district: "Cibiru",
  city: "Bandung",
  province: "Jawa Barat",
  postalCode: "40111",
  validFrom: "2020-01-01",
  validTo: null,
  source: "HC",
  notes: null,
  voidedAt: null,
  voidedReason: null,
};

function actions(canManage: boolean): RelationActions {
  return { canManage, onEdit: () => undefined, onVoid: () => undefined };
}

const render = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

describe("EMP-009 family records", () => {
  it("says it is loading, and says plainly when the account may not look", () => {
    expect(render(<FamilyRecords view={{ kind: "loading" }} actions={actions(true)} onAdd={() => undefined} />))
      .toContain("Memuat data");
    expect(render(<FamilyRecords view={{ kind: "forbidden" }} actions={actions(true)} onAdd={() => undefined} />))
      .toContain("tidak berhak");
  });

  it("shows the relation, the flags and the period", () => {
    const html = render(
      <FamilyRecords
        view={{ kind: "ready", data: { rows: [spouse], dependents: 1, emergencyContacts: 1 } }}
        actions={actions(false)}
        onAdd={() => undefined}
      />,
    );
    expect(html).toContain("Nama Sintetis");
    expect(html).toContain("Pasangan");
    expect(html).toContain("Tanggungan");
    expect(html).toContain("Kontak darurat 1");
    expect(html).toContain("1 tanggungan");
  });

  it("marks a relationship that has ended rather than hiding it", () => {
    const html = render(
      <FamilyRecords
        view={{ kind: "ready", data: { rows: [{ ...spouse, validTo: "2024-03-01" }], dependents: 0, emergencyContacts: 0 } }}
        actions={actions(true)}
        onAdd={() => undefined}
      />,
    );
    expect(html).toContain("Sudah berakhir");
  });

  it("offers no recording or voiding without employees.manage", () => {
    const view = { kind: "ready" as const, data: { rows: [spouse], dependents: 1, emergencyContacts: 1 } };
    const readOnly = render(<FamilyRecords view={view} actions={actions(false)} onAdd={() => undefined} />);
    expect(readOnly).not.toContain("Tambah anggota keluarga");
    expect(readOnly).not.toContain("Batalkan");
    expect(render(<FamilyRecords view={view} actions={actions(true)} onAdd={() => undefined} />))
      .toContain("Tambah anggota keluarga");
  });
});

describe("EMP-003 addresses", () => {
  it("separates the address in force from the history", () => {
    const html = render(
      <AddressRecords
        view={{
          kind: "ready",
          data: {
            rows: [address, { ...address, id: "old", validFrom: "2015-01-01", validTo: "2019-12-31" }],
            current: { DOMISILI: ADDRESS_ID, KTP: null },
          },
        }}
        actions={actions(true)}
        onAdd={() => undefined}
      />,
    );
    expect(html).toContain("Berlaku sekarang");
    expect(html).toContain("Riwayat");
    expect(html).toContain("Sukamaju, Cibiru, Bandung, Jawa Barat 40111");
  });

  it("says a move closes the previous address rather than replacing it", () => {
    const html = render(
      <AddressForm draft={EMPTY_ADDRESS} editing={false} busy={false} onChange={() => undefined} onSubmit={() => undefined} onCancel={() => undefined} />,
    );
    expect(html).toContain("akan ditutup sehari sebelum");
    expect(html).not.toContain("dihapus permanen");
  });
});

describe("EMP-009 / EMP-003 forms", () => {
  it("never asks for a family identity number", () => {
    // Spec §8: the API refuses one until column encryption exists, so the
    // screen must not invite it either.
    const html = render(
      <FamilyForm draft={EMPTY_FAMILY} editing={false} busy={false} onChange={() => undefined} onSubmit={() => undefined} onCancel={() => undefined} />,
    );
    expect(html.toLowerCase()).not.toContain("nik");
    expect(html.toLowerCase()).not.toContain("identitas");
  });

  it("asks for the phone and the order only when the member is an emergency contact", () => {
    const plain = render(
      <FamilyForm draft={EMPTY_FAMILY} editing={false} busy={false} onChange={() => undefined} onSubmit={() => undefined} onCancel={() => undefined} />,
    );
    expect(plain).not.toContain("Nomor telepon (wajib)");
    const contact = render(
      <FamilyForm
        draft={{ ...EMPTY_FAMILY, isEmergencyContact: true }}
        editing={false} busy={false} onChange={() => undefined} onSubmit={() => undefined} onCancel={() => undefined}
      />,
    );
    expect(contact).toContain("Nomor telepon (wajib)");
    expect(contact).toContain("Urutan dihubungi (wajib)");
  });

  it("demands a birth date once the member is a dependant", () => {
    const html = render(
      <FamilyForm
        draft={{ ...EMPTY_FAMILY, isDependent: true }}
        editing={false} busy={false} onChange={() => undefined} onSubmit={() => undefined} onCancel={() => undefined}
      />,
    );
    expect(html).toContain("Tanggal lahir (wajib untuk tanggungan)");
    expect(html).toContain("Urutan tanggungan");
  });

  it("clears the fields a cleared flag owns, and sends nulls rather than blanks", () => {
    expect(familyPayload({
      ...EMPTY_FAMILY,
      fullName: "  Nama  ",
      isDependent: false,
      dependentOrder: 2,
      isEmergencyContact: false,
      emergencyPhone: "0800000000",
      emergencyPriority: 1,
      validFrom: "2020-01-01",
      validTo: "",
    })).toMatchObject({
      fullName: "Nama",
      dependentOrder: null,
      emergencyPhone: null,
      emergencyPriority: null,
      validTo: null,
      birthDate: null,
    });

    expect(addressPayload({ ...EMPTY_ADDRESS, addressLine: " Jalan ", city: " Bandung ", province: "  " }))
      .toMatchObject({ addressLine: "Jalan", city: "Bandung", province: null, postalCode: null });
  });
});

describe("EMP-009 / EMP-003 access", () => {
  it("shows the tab to an account that may read the employee master", () => {
    const html = render(
      <EmployeeDetailTabs active="ringkasan" canReadEmployment={false} canReadProfile onSelect={() => undefined} />,
    );
    expect(html).toContain("Keluarga &amp; Alamat");
    expect(render(<EmployeeDetailTabs active="ringkasan" canReadEmployment canReadProfile={false} onSelect={() => undefined} />))
      .not.toContain("Keluarga");
  });

  it("turns a refusal into its own view state", () => {
    expect(viewFromRelationError(new EmploymentApiError(403, "FORBIDDEN", "x"))).toEqual({ kind: "forbidden" });
    expect(viewFromRelationError(new EmploymentApiError(409, "FAMILY_SPOUSE_OVERLAP", "Sudah ada pasangan yang tercatat pada periode tersebut.")))
      .toEqual({ kind: "error", message: "Sudah ada pasangan yang tercatat pada periode tersebut." });
    expect(viewFromRelationError(new Error("offline")).kind).toBe("error");
  });
});
