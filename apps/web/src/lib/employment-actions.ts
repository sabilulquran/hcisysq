// EMP-005 S5B action client (docs/api/employment.openapi.yaml 0.5.0). Every
// rule — dates, required basis documents, warnings, who may record — belongs
// to the API; this module only carries the request and the labels.

import { EmploymentApiError, type EmploymentCategory } from "@/lib/employment";

export type EmploymentActionType =
  | "HIRE"
  | "CONTRACT_EXTENSION"
  | "CATEGORY_CHANGE"
  | "TERMINATION"
  | "PLACEMENT"
  | "TRANSFER"
  | "PROMOTION"
  | "DEMOTION";

/** EMP-006: why a career move happened; a demotion must name one. */
export type CareerReasonCode =
  | "RESTRUKTURISASI"
  | "KINERJA"
  | "DISIPLIN"
  | "PERMINTAAN_PEGAWAI"
  | "KEBUTUHAN_ORGANISASI"
  | "LAINNYA";

export type EmploymentWarningCode =
  | "BACKDATED"
  | "TERM_GAP"
  | "CONTRACT_DURATION_LONG"
  | "PROBATION_DURATION_LONG";

export type TerminationReason =
  | "RESIGN"
  | "KONTRAK_BERAKHIR"
  | "PENSIUN"
  | "PEMBERHENTIAN"
  | "MENINGGAL_DUNIA"
  | "LAINNYA";

export type ActionCategory = Exclude<EmploymentCategory, "BELUM_DIKLASIFIKASIKAN">;

export interface PlacementInput {
  unitId: string;
  positionId?: string | null;
  jobTitleLabel: string;
}

/** Ending an additional duty is its own request (EMP-006). */
export interface PlacementEndRequest {
  actionType: "PLACEMENT_END";
  effectiveOn: string;
  placementId: string;
  reasonNote?: string | null;
}

interface CommonFields {
  reasonNote?: string | null;
  documentIds?: string[];
  acknowledgedWarnings?: EmploymentWarningCode[];
}

export type EmploymentActionRequest = (CommonFields & PlacementEndRequest) | (CommonFields &
  (
    | {
        actionType: "HIRE";
        effectiveOn: string;
        category: ActionCategory;
        termEndOn?: string | null;
        staffType?: "PENDIDIK" | "KEPENDIDIKAN" | null;
        contractReference?: string | null;
        placement: PlacementInput;
      }
    | { actionType: "CONTRACT_EXTENSION"; effectiveOn: string; termEndOn: string; contractReference?: string | null }
    | {
        actionType: "CATEGORY_CHANGE";
        effectiveOn: string;
        category: ActionCategory;
        termEndOn?: string | null;
        contractReference?: string | null;
      }
    | { actionType: "TERMINATION"; lastDayOn: string; reasonCode: TerminationReason }
    | { actionType: "PLACEMENT"; effectiveOn: string; placement: PlacementInput & { kind?: "PRIMARY" | "ADDITIONAL" } }
    | {
        actionType: "TRANSFER" | "PROMOTION" | "DEMOTION";
        effectiveOn: string;
        placement: PlacementInput;
        reasonCode?: CareerReasonCode | null;
      }
  ));

export interface EmploymentActionPreview {
  actionType: EmploymentActionType;
  effectiveOn: string | null;
  reasonCode: string | null;
  warnings: EmploymentWarningCode[];
  previous: Record<string, unknown>;
  next: Record<string, unknown>;
  documentIds: string[];
  expectedVersion: number | null;
  state: "AKTIF" | "AKAN_MULAI" | "BERAKHIR" | "TANPA_DATA";
  /** EMP-006 D-18: what a career move does not change. */
  structureNote: string | null;
  accountDeactivation: { willDeactivate: boolean; onDate: string | null };
}

export interface EmploymentActionResult {
  actionId: string;
  replayed: boolean;
  deactivatedAccounts?: number;
}

async function post<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (response.ok) return (await response.json()) as T;
  const failure = (await response.json().catch(() => null)) as { code?: string; message?: string } | null;
  throw new EmploymentApiError(
    response.status,
    failure?.code ?? "REQUEST_FAILED",
    failure?.message ?? "Tindakan tidak dapat diproses.",
  );
}

export function previewEmploymentAction(
  employeeId: string,
  body: EmploymentActionRequest,
): Promise<EmploymentActionPreview> {
  return post(`/api/admin/employees/${encodeURIComponent(employeeId)}/employment-actions/preview`, body);
}

/**
 * The key makes a retry safe: a repeated request returns the first action
 * instead of recording a second one, so one key belongs to one attempt.
 */
export function recordEmploymentAction(
  employeeId: string,
  body: EmploymentActionRequest,
  idempotencyKey: string,
): Promise<EmploymentActionResult> {
  return post(`/api/admin/employees/${encodeURIComponent(employeeId)}/employment-actions`, body, {
    "Idempotency-Key": idempotencyKey,
  });
}

export function newIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `hcis-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export const ACTION_TITLE: Record<EmploymentActionType, string> = {
  HIRE: "Mulai hubungan kerja",
  CONTRACT_EXTENSION: "Perpanjang kontrak",
  CATEGORY_CHANGE: "Ubah status kepegawaian",
  TERMINATION: "Akhiri hubungan kerja",
  PLACEMENT: "Penempatan",
  TRANSFER: "Mutasi",
  PROMOTION: "Promosi",
  DEMOTION: "Demosi",
};

export const CAREER_REASON_LABEL: Record<CareerReasonCode, string> = {
  RESTRUKTURISASI: "Restrukturisasi organisasi",
  KINERJA: "Kinerja",
  DISIPLIN: "Kedisiplinan",
  PERMINTAAN_PEGAWAI: "Permintaan pegawai",
  KEBUTUHAN_ORGANISASI: "Kebutuhan organisasi",
  LAINNYA: "Lainnya",
};

export const ACTION_DONE_MESSAGE: Record<EmploymentActionType, string> = {
  HIRE: "Hubungan kerja dicatat",
  CONTRACT_EXTENSION: "Perpanjangan kontrak dicatat",
  CATEGORY_CHANGE: "Perubahan status kepegawaian dicatat",
  TERMINATION: "Pengakhiran hubungan kerja dicatat",
  PLACEMENT: "Penempatan dicatat",
  TRANSFER: "Mutasi dicatat",
  PROMOTION: "Promosi dicatat",
  DEMOTION: "Demosi dicatat",
};

export const TERMINATION_REASON_LABEL: Record<TerminationReason, string> = {
  RESIGN: "Mengundurkan diri",
  KONTRAK_BERAKHIR: "Kontrak berakhir",
  PENSIUN: "Pensiun",
  PEMBERHENTIAN: "Pemberhentian",
  MENINGGAL_DUNIA: "Meninggal dunia",
  LAINNYA: "Lainnya",
};

export const WARNING_LABEL: Record<EmploymentWarningCode, string> = {
  BACKDATED: "Tindakan ini berlaku mundur dari hari ini.",
  TERM_GAP: "Ada jeda antara kontrak sebelumnya dan tanggal berlaku ini.",
  CONTRACT_DURATION_LONG: "Total masa kontrak melebihi batas yang biasa dipakai; pastikan sesuai kebijakan.",
  PROBATION_DURATION_LONG: "Masa percobaan lebih panjang dari yang biasa dipakai; pastikan sesuai kebijakan.",
};

/** Which basis document the API will ask for, so the dialog filters the register. */
export function requiredDocumentKind(
  actionType: EmploymentActionType,
  category: ActionCategory | null,
  reasonCode: TerminationReason | null,
): { kind: "PERJANJIAN_KERJA" | "SURAT_KEPUTUSAN"; skType?: string; hint: string } | null {
  switch (actionType) {
    case "HIRE":
    case "CATEGORY_CHANGE":
      return category === "TETAP"
        ? { kind: "SURAT_KEPUTUSAN", skType: "SK_PENGANGKATAN", hint: "Pengangkatan pegawai tetap memerlukan SK Pengangkatan." }
        : { kind: "PERJANJIAN_KERJA", hint: "Tindakan kontrak memerlukan Perjanjian Kerja." };
    case "CONTRACT_EXTENSION":
      return { kind: "PERJANJIAN_KERJA", hint: "Perpanjangan memerlukan Perjanjian Kerja perpanjangan." };
    case "TERMINATION":
      return reasonCode === "RESIGN" || reasonCode === "MENINGGAL_DUNIA"
        ? null
        : { kind: "SURAT_KEPUTUSAN", skType: "SK_PEMBERHENTIAN", hint: "Pemberhentian memerlukan SK Pemberhentian." };
    case "TRANSFER":
      return { kind: "SURAT_KEPUTUSAN", skType: "SK_MUTASI", hint: "Mutasi memerlukan SK Mutasi." };
    case "PROMOTION":
      return { kind: "SURAT_KEPUTUSAN", skType: "SK_PROMOSI", hint: "Promosi memerlukan SK Promosi." };
    case "DEMOTION":
      return { kind: "SURAT_KEPUTUSAN", skType: "SK_DEMOSI", hint: "Demosi memerlukan SK Demosi." };
    case "PLACEMENT":
      // A placement needs no basis document; an SK may still be attached.
      return null;
  }
}

/** The career moves an operator starts from the placement tab. */
export const CAREER_ACTIONS: readonly EmploymentActionType[] = ["PLACEMENT", "TRANSFER", "PROMOTION", "DEMOTION"];
