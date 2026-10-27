// PAY-003 reference data: the versioned statutory policy, compensation
// profiles and the loan register.
//
// Every write opens a new effective-dated row rather than editing one, which is
// the server's rule; this module only carries the request and the refusal back.

import { PayrollApiError } from "@/lib/payroll";

export interface PayrollPolicyVersion {
  id: string;
  policyKey: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  payload: Record<string, unknown>;
  source: string;
  note: string | null;
  createdAt: string;
}

export interface PayrollEmployment {
  employmentId: string;
  employeeId: string;
  employeeNumber: string;
  fullName: string;
  startedOn: string;
  endedOn: string | null;
  profileCount: number;
}

export interface PayrollCompensationProfile {
  id: string;
  employmentId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  education: string | null;
  workPattern: string | null;
  teachingHoursPerWeek: string | null;
  spouseCount: number;
  childCount: number;
  registeredDependants: number;
  specialQualificationTarget: string | null;
  annualPerformanceRate: string | null;
  monthlyPerformanceRate: string | null;
  bpjsSegment: string;
  bankName: string | null;
  bankAccountNumber: string | null;
  bankAccountName: string | null;
}

export interface PayrollLoan {
  id: string;
  employeeId: string;
  employeeNumber: string;
  fullName: string;
  grantedOn: string;
  principal: string;
  instalment: string | null;
  note: string | null;
  closedAt: string | null;
  deducted: string;
  outstanding: string;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    ...init,
    ...(init?.body === undefined ? {} : { headers: { "Content-Type": "application/json", ...init.headers } }),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: string; code?: string } | null;
    throw new PayrollApiError(
      payload?.message ?? "Permintaan payroll gagal diproses.",
      payload?.code ?? "PAYROLL_REQUEST_FAILED",
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function listPayrollPolicies(policyKey?: string) {
  const query = policyKey ? `?policyKey=${encodeURIComponent(policyKey)}` : "";
  return request<{ policies: PayrollPolicyVersion[] }>(`/api/payroll/policies${query}`);
}

export function openPayrollPolicyVersion(body: {
  policyKey: string;
  effectiveFrom: string;
  payload: Record<string, unknown>;
  source: string;
  note?: string;
  backdateReason?: string;
}) {
  return request<{ policy: PayrollPolicyVersion }>("/api/payroll/policies", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** ENG-LIST-001: a picker over employees searches, it never lists everyone. */
export function searchPayrollEmployments(query: { q?: string; page?: number; pageSize?: number } = {}) {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  params.set("page", String(query.page ?? 1));
  params.set("pageSize", String(query.pageSize ?? 25));
  return request<{
    employments: PayrollEmployment[];
    total: number;
    page: number;
    pageSize: number;
  }>(`/api/payroll/employments?${params.toString()}`);
}

export function listCompensationProfiles(employmentId: string) {
  return request<{ profiles: PayrollCompensationProfile[] }>(
    `/api/payroll/employments/${encodeURIComponent(employmentId)}/compensation-profiles`,
  );
}

export function openCompensationProfile(employmentId: string, body: Record<string, unknown>) {
  return request<{ profile: PayrollCompensationProfile }>(
    `/api/payroll/employments/${encodeURIComponent(employmentId)}/compensation-profiles`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export function listPayrollLoans(query: { employeeId?: string; page?: number; pageSize?: number } = {}) {
  const params = new URLSearchParams();
  if (query.employeeId) params.set("employeeId", query.employeeId);
  params.set("page", String(query.page ?? 1));
  params.set("pageSize", String(query.pageSize ?? 25));
  return request<{ loans: PayrollLoan[]; total: number; page: number; pageSize: number }>(
    `/api/payroll/loans?${params.toString()}`,
  );
}

export function createPayrollLoan(body: {
  employeeId: string;
  grantedOn: string;
  principal: number;
  instalment?: number | null;
  note?: string;
}) {
  return request<{ loan: PayrollLoan }>("/api/payroll/loans", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const POLICY_LABELS: Record<string, string> = {
  BPJS_KESEHATAN: "BPJS Kesehatan",
  BPJS_KETENAGAKERJAAN: "BPJS Ketenagakerjaan",
  PPH21_TER: "PPh21 TER",
  OVERTIME: "Lembur",
  EARLY_SERVICE: "Masa kerja awal",
  MKG_SCALE: "Skala masa kerja golongan",
  EDUCATION_ALLOWANCE: "Tunjangan pendidikan",
  FUNCTIONAL_ALLOWANCE: "Tunjangan fungsional",
  STRUCTURAL_ALLOWANCE: "Tunjangan struktural",
  UNIT_MULTIPLIER: "Pengali unit",
  WORK_PATTERN: "Pola kerja",
  TRANSPORT_PKWT: "Transport PKWT",
  PJ_MEDIA: "Pj. Media",
  CHILD_EDUCATION: "Pendidikan anak",
  VARIANCE_THRESHOLD: "Ambang perlu ditinjau",
};

/** The policy key as an operator reads it; an unknown key is shown as it is. */
export function policyLabel(policyKey: string): string {
  return POLICY_LABELS[policyKey] ?? policyKey;
}

export const BPJS_SEGMENTS = ["PPU_YAYASAN", "PBI", "MANDIRI", "BELUM_TERDAFTAR"] as const;
export const EDUCATION_LEVELS = ["SD", "SMP", "SLTA", "D1_D2", "D3_D4", "S1", "S2_S3"] as const;
export const WORK_PATTERNS = ["FULL", "HALF_DAY", "HALF_DAY_II"] as const;
