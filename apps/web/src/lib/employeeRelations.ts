// EMP-009 / EMP-003 P2-3 client (docs/api/employment.openapi.yaml). Periods,
// the one-spouse rule and the house move all belong to the API and the
// database; this module carries the request and the Indonesian labels.
//
// There is deliberately no identity-number field anywhere here: the API
// refuses one outright until column encryption exists (spec §8).

import { EmploymentApiError } from "@/lib/employment";

export type FamilyRelation = "PASANGAN" | "ANAK" | "ORANG_TUA" | "SAUDARA" | "LAINNYA";
export type Gender = "L" | "P";
export type AddressKind = "DOMISILI" | "KTP";
export type AddressSource = "IMPOR" | "HC" | "USULAN_PEGAWAI";

export const FAMILY_RELATION_LABEL: Record<FamilyRelation, string> = {
  PASANGAN: "Pasangan",
  ANAK: "Anak",
  ORANG_TUA: "Orang tua",
  SAUDARA: "Saudara",
  LAINNYA: "Lainnya",
};

export const GENDER_LABEL: Record<Gender, string> = { L: "Laki-laki", P: "Perempuan" };

export const ADDRESS_KIND_LABEL: Record<AddressKind, string> = {
  DOMISILI: "Domisili",
  KTP: "Sesuai KTP",
};

export const ADDRESS_SOURCE_LABEL: Record<AddressSource, string> = {
  IMPOR: "Dari impor",
  HC: "Dicatat HC",
  USULAN_PEGAWAI: "Usulan pegawai",
};

interface DatedRecord {
  id: string;
  employeeId: string;
  validFrom: string;
  validTo: string | null;
  notes: string | null;
  voidedAt: string | null;
  voidedReason: string | null;
}

export interface FamilyMember extends DatedRecord {
  relation: FamilyRelation;
  fullName: string;
  birthDate: string | null;
  gender: Gender | null;
  isDependent: boolean;
  dependentOrder: number | null;
  isEmergencyContact: boolean;
  emergencyPhone: string | null;
  emergencyPriority: number | null;
}

export interface FamilyList {
  rows: FamilyMember[];
  dependents: number;
  emergencyContacts: number;
}

export interface EmployeeAddress extends DatedRecord {
  kind: AddressKind;
  addressLine: string;
  village: string | null;
  district: string | null;
  city: string;
  province: string | null;
  postalCode: string | null;
  source: AddressSource;
}

export interface AddressList {
  rows: EmployeeAddress[];
  /** Which record of each kind is in force now, derived by the API. */
  current: Record<AddressKind, string | null>;
}

export interface FamilyMemberInput {
  relation: FamilyRelation;
  fullName: string;
  birthDate?: string | null;
  gender?: Gender | null;
  isDependent?: boolean;
  dependentOrder?: number | null;
  isEmergencyContact?: boolean;
  emergencyPhone?: string | null;
  emergencyPriority?: number | null;
  validFrom: string;
  validTo?: string | null;
  notes?: string | null;
}

export interface AddressInput {
  kind: AddressKind;
  addressLine: string;
  village?: string | null;
  district?: string | null;
  city: string;
  province?: string | null;
  postalCode?: string | null;
  validFrom: string;
  validTo?: string | null;
  source?: AddressSource;
  notes?: string | null;
}

async function send<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}) },
    ...init,
  });
  if (response.ok) return (await response.json()) as T;
  const body = (await response.json().catch(() => null)) as { code?: string; message?: string } | null;
  throw new EmploymentApiError(
    response.status,
    body?.code ?? "REQUEST_FAILED",
    body?.message ?? "Permintaan tidak dapat diproses.",
  );
}

const employee = (employeeId: string) => encodeURIComponent(employeeId);
const record = (recordId: string) => encodeURIComponent(recordId);

export function getFamily(employeeId: string): Promise<FamilyList> {
  return send(`/api/admin/employees/${employee(employeeId)}/family`);
}

export function recordFamilyMember(employeeId: string, input: FamilyMemberInput): Promise<FamilyMember> {
  return send(`/api/admin/employees/${employee(employeeId)}/family`, { method: "POST", body: JSON.stringify(input) });
}

export function amendFamilyMember(recordId: string, input: FamilyMemberInput): Promise<FamilyMember> {
  return send(`/api/admin/family-records/${record(recordId)}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function getAddresses(employeeId: string): Promise<AddressList> {
  return send(`/api/admin/employees/${employee(employeeId)}/addresses`);
}

/** Recording an address of a kind already in force is a move: the API closes the old one. */
export function recordAddress(
  employeeId: string,
  input: AddressInput,
): Promise<EmployeeAddress & { closedAddressId: string | null }> {
  return send(`/api/admin/employees/${employee(employeeId)}/addresses`, { method: "POST", body: JSON.stringify(input) });
}

export function amendAddress(recordId: string, input: AddressInput): Promise<EmployeeAddress> {
  return send(`/api/admin/address-records/${record(recordId)}`, { method: "PATCH", body: JSON.stringify(input) });
}

export type RelationRecordKind = "family" | "address";

const prefix = (kind: RelationRecordKind) => (kind === "family" ? "family-records" : "address-records");

export function voidRelationRecord(
  kind: RelationRecordKind,
  recordId: string,
  reason: string,
): Promise<{ id: string; voided: true }> {
  return send(`/api/admin/${prefix(kind)}/${record(recordId)}/void`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}
