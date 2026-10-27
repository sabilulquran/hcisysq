// EMP-010 S4 validation rules (spec §4.5). Pure domain: synthetic values only.

import { describe, expect, it } from "vitest";

import {
  normalizeDocumentNumber,
  previousValuesOf,
  validateDecisionDocument,
  type DecisionDocumentInput,
} from "../src/modules/employment/domain/decision-documents.js";

const EMPLOYEE_ID = "10000000-0000-4000-8000-000000000001";

const pk: DecisionDocumentInput = {
  documentKind: "PERJANJIAN_KERJA",
  documentNumber: "  001/PK/YSQ/2027 ",
  signedOn: "2027-06-20",
  pkType: "PK_BARU",
  employeeId: EMPLOYEE_ID,
  contractFrom: "2027-07-01",
  contractTo: "2028-06-30",
  category: "KONTRAK",
  signatoryEmployerLabel: "Ketua Yayasan",
};

const sk: DecisionDocumentInput = {
  documentKind: "SURAT_KEPUTUSAN",
  documentNumber: "012/SK/YSQ/2027",
  signedOn: "2027-06-25",
  skType: "SK_PENEMPATAN",
  subject: "Penempatan guru semester ganjil 2027/2028",
  issuingAuthorityLabel: "Ketua Yayasan",
  effectiveOn: "2027-07-01",
};

function expectField(input: DecisionDocumentInput, field: string) {
  const result = validateDecisionDocument(input);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.failure.code).toBe("DECISION_DOCUMENT_INVALID");
    expect(result.failure.field).toBe(field);
  }
}

describe("EMP-010-A Perjanjian Kerja and Surat Keputusan keep separate fields", () => {
  it("accepts a Perjanjian Kerja and clears every SK field", () => {
    const result = validateDecisionDocument(pk);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.documentNumber).toBe("001/PK/YSQ/2027");
    expect(result.value.employeeId).toBe(EMPLOYEE_ID);
    expect(result.value.skType).toBeNull();
    expect(result.value.subject).toBeNull();
    expect(result.value.effectiveOn).toBeNull();
  });

  it("accepts a Surat Keputusan and clears every PK field", () => {
    const result = validateDecisionDocument(sk);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.skType).toBe("SK_PENEMPATAN");
    expect(result.value.employeeId).toBeNull();
    expect(result.value.contractTo).toBeNull();
    expect(result.value.category).toBeNull();
  });

  it("ignores values sent for the other kind instead of storing them", () => {
    const mixed = validateDecisionDocument({ ...pk, skType: "SK_MUTASI", subject: "Mutasi" });
    expect(mixed.ok).toBe(true);
    if (mixed.ok) expect(mixed.value.skType).toBeNull();
  });
});

describe("EMP-010-A required fields per kind", () => {
  it("requires a number and a signing date for both kinds", () => {
    expectField({ ...pk, documentNumber: "   " }, "documentNumber");
    expectField({ ...sk, signedOn: "2027-02-30" }, "signedOn");
  });

  it("requires the Perjanjian Kerja employee, period, and category", () => {
    expectField({ ...pk, employeeId: null }, "employeeId");
    expectField({ ...pk, contractTo: null }, "contractTo");
    expectField({ ...pk, category: null }, "category");
    expectField({ ...pk, pkType: null }, "pkType");
  });

  it("rejects a contract that ends before it starts", () => {
    expectField({ ...pk, contractFrom: "2028-01-01", contractTo: "2027-12-31" }, "contractTo");
  });

  it("allows a contract of a single day", () => {
    expect(validateDecisionDocument({ ...pk, contractFrom: "2027-07-01", contractTo: "2027-07-01" }).ok).toBe(true);
  });

  it("accepts a previous PK only on an extension", () => {
    expectField({ ...pk, previousPkId: "20000000-0000-4000-8000-000000000001" }, "previousPkId");
    expect(
      validateDecisionDocument({ ...pk, pkType: "PK_PERPANJANGAN", previousPkId: "20000000-0000-4000-8000-000000000001" }).ok,
    ).toBe(true);
  });

  it("requires the SK type, subject, issuing authority, and effective date", () => {
    expectField({ ...sk, skType: null }, "skType");
    expectField({ ...sk, subject: "  " }, "subject");
    expectField({ ...sk, issuingAuthorityLabel: null }, "issuingAuthorityLabel");
    expectField({ ...sk, effectiveOn: null }, "effectiveOn");
    expectField({ ...sk, effectiveTo: "2027-06-30" }, "effectiveTo");
  });

  it("keeps effectiveTo optional on an SK", () => {
    const result = validateDecisionDocument({ ...sk, effectiveTo: null });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.effectiveTo).toBeNull();
  });
});

describe("EMP-010-B corrections keep the prior values", () => {
  it("normalises numbers so the same series is detected", () => {
    expect(normalizeDocumentNumber("  001 /PK/  YSQ/2027  ")).toBe("001 /PK/ YSQ/2027");
  });

  it("snapshots every editable field and nothing else", () => {
    const result = validateDecisionDocument(pk);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const snapshot = previousValuesOf(result.value);
    expect(snapshot).toMatchObject({ documentNumber: "001/PK/YSQ/2027", category: "KONTRAK", contractTo: "2028-06-30" });
    expect(snapshot).not.toHaveProperty("documentKind");
    expect(snapshot).not.toHaveProperty("employeeId");
  });
});
