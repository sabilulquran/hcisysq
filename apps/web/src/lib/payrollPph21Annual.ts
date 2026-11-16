// PAY-003 §7.4 client: annual PPh21 recap, bukti potong 1721-A1, and the tax identity
// HC records for it. Every figure and every rule comes from the server; the screens only
// show what it returns (AGENTS.md §4).

import { PayrollApiError } from "@/lib/payroll";

export type A1LineKey =
  | "salary"
  | "taxAllowance"
  | "otherAllowances"
  | "honorarium"
  | "insurancePremium"
  | "inKind"
  | "bonusThr";

export type Pph21AnnualFlag = "OPEN" | "PTKP_MISSING" | "PRIOR_TAX_INCOMPLETE";

export interface Pph21AnnualSegment {
  employeeId: string;
  employeeNumber: string;
  fullName: string;
  index: number;
  startPeriod: string;
  endPeriod: string;
  monthCount: number;
  closed: boolean;
  ptkpStatus: string | null;
  lines: Record<A1LineKey, string>;
  gross: string;
  positionCost: string;
  pensionContribution: string;
  deductions: string;
  net: string;
  ptkp: string | null;
  pkp: string | null;
  annualTax: string | null;
  terWithheld: string | null;
  finalMasaTax: string | null;
  flags: Pph21AnnualFlag[];
  note: string;
}

export interface Pph21AnnualRecap {
  year: number;
  objectCode: string;
  policy: { versionId: string; effectiveFrom: string; source: string };
  pendingPeriods: Array<{ periodMonth: string; state: string }>;
  periodsWithoutTer: string[];
  totals: { segmentCount: number; closedCount: number; annualTax: string; finalMasaTax: string };
  rows: Array<Pph21AnnualSegment & { taxIdentity: { nik: boolean; npwp: boolean } }>;
}

export interface Pph21A1Document {
  year: number;
  objectCode: string;
  reference: string;
  issuedOn: string;
  withholder: { name: string; taxNumber: string | null };
  employee: { employeeNumber: string; fullName: string; position: string | null; nik: string | null; npwp: string | null };
  policy: { versionId: string; effectiveFrom: string; source: string };
  segment: Pph21AnnualSegment;
  signer: { title: string; name: string | null };
}

export interface TaxIdentityMasked {
  nikMasked: string | null;
  npwpMasked: string | null;
  updatedAt: string | null;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    ...init,
    ...(init?.body === undefined ? {} : { headers: { "Content-Type": "application/json", ...init.headers } }),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: string; code?: string } | null;
    throw new PayrollApiError(payload?.message ?? "Permintaan PPh21 gagal diproses.", payload?.code ?? "PAYROLL_REQUEST_FAILED");
  }
  return (await response.json()) as T;
}

export function getPph21AnnualRecap(year: number) {
  return request<{ annual: Pph21AnnualRecap }>(`/api/payroll/pph21/annual?year=${year}`);
}

/** The e-Bupot recap the server builds; it carries NIK/NPWP and every download is recorded. */
export function pph21AnnualCsvUrl(year: number) {
  return `/api/payroll/pph21/annual?year=${year}&format=csv`;
}

export function getPph21A1(year: number, employeeId: string, index: number) {
  return request<{ a1: Pph21A1Document }>(
    `/api/payroll/pph21/annual/${year}/employees/${encodeURIComponent(employeeId)}/a1/${index}`,
  );
}

export function listOwnA1() {
  return request<{ items: Array<{ year: number; index: number; startPeriod: string; endPeriod: string }> }>(
    "/api/payroll/me/a1",
  );
}

export function getOwnA1(year: number, index: number) {
  return request<{ a1: Pph21A1Document }>(`/api/payroll/me/a1/${year}/${index}`);
}

export function getTaxIdentity(employeeId: string) {
  return request<{ taxIdentity: TaxIdentityMasked }>(`/api/payroll/employees/${encodeURIComponent(employeeId)}/tax-identity`);
}

export function putTaxIdentity(employeeId: string, body: { nik?: string | null; npwp?: string | null }) {
  return request<{ taxIdentity: TaxIdentityMasked }>(`/api/payroll/employees/${encodeURIComponent(employeeId)}/tax-identity`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

/** Rupiah as Indonesians read it; a negative final tax (lebih potong) keeps its sign. */
export function rupiah(value: string | null): string {
  if (value === null) return "—";
  const amount = Number(value);
  const formatted = new Intl.NumberFormat("id-ID").format(Math.abs(amount));
  return amount < 0 ? `(${formatted})` : formatted;
}

export const A1_LINE_LABELS: Array<[A1LineKey, string]> = [
  ["salary", "Gaji/pensiun atau THT/JHT"],
  ["taxAllowance", "Tunjangan PPh"],
  ["otherAllowances", "Tunjangan lainnya, uang lembur dan sejenisnya"],
  ["honorarium", "Honorarium dan imbalan lain sejenisnya"],
  ["insurancePremium", "Premi asuransi yang dibayar pemberi kerja"],
  ["inKind", "Penerimaan dalam bentuk natura dan kenikmatan lainnya"],
  ["bonusThr", "Tantiem, bonus, gratifikasi, jasa produksi dan THR"],
];

export const ANNUAL_FLAG_LABELS: Record<Pph21AnnualFlag, string> = {
  OPEN: "Belum masa pajak terakhir",
  PTKP_MISSING: "PTKP belum dapat ditentukan",
  PRIOR_TAX_INCOMPLETE: "TER bulan sebelumnya belum lengkap",
};
