// Accepted Package 1 policy values (owner decisions 2026-10-16, spec §15).
// Kept as data so later changes do not require code changes in the planner.

import type { ActionType, EmploymentCategory, EndReason, PkType, SkType } from "./model.js";

export interface DocumentRequirement {
  kind: "PERJANJIAN_KERJA" | "SURAT_KEPUTUSAN";
  pkTypes?: readonly PkType[];
  skTypes?: readonly SkType[];
}

export interface EmploymentPolicy {
  /** D-03: categories whose term must have an end date. */
  fixedTermCategories: readonly EmploymentCategory[];
  /** D-13: days a past effective date may lie before today without `employment.correct`. */
  backdatingWindowDays: number;
  /** D-11: days before a fixed-term end that raise KONTRAK_SEGERA_BERAKHIR. */
  contractReminderDays: number;
  /** D-04: warnings only; continuous fixed-term duration that triggers a warning. */
  contractWarningMonths: number;
  probationWarningMonths: number;
  /** D-08: termination reasons for which an SK Pemberhentian is optional. */
  terminationReasonsWithoutRequiredSk: readonly EndReason[];
}

export const DEFAULT_EMPLOYMENT_POLICY: EmploymentPolicy = {
  fixedTermCategories: ["KONTRAK", "KONTRAK_HONORER", "MAGANG", "PERCOBAAN", "LEPAS"],
  backdatingWindowDays: 31,
  contractReminderDays: 60,
  contractWarningMonths: 60,
  probationWarningMonths: 3,
  terminationReasonsWithoutRequiredSk: ["RESIGN", "MENINGGAL_DUNIA"],
};

export const ACTION_REASON_CODES: Readonly<Record<"TERMINATION", readonly EndReason[]>> = {
  TERMINATION: ["RESIGN", "KONTRAK_BERAKHIR", "PENSIUN", "PEMBERHENTIAN", "MENINGGAL_DUNIA", "LAINNYA"],
};

export function isFixedTerm(policy: EmploymentPolicy, category: EmploymentCategory): boolean {
  return policy.fixedTermCategories.includes(category);
}

/**
 * D-08: Perjanjian Kerja for contract hire/extension; SK for permanent
 * appointment, transfer, promotion, demotion, and termination. Returns null
 * when no document is required.
 */
export function requiredDocument(
  policy: EmploymentPolicy,
  actionType: ActionType,
  context: { category?: EmploymentCategory; terminationReason?: EndReason },
): DocumentRequirement | null {
  switch (actionType) {
    case "HIRE":
    case "CATEGORY_CHANGE":
      if (context.category === "TETAP") {
        return { kind: "SURAT_KEPUTUSAN", skTypes: ["SK_PENGANGKATAN"] };
      }
      return { kind: "PERJANJIAN_KERJA", pkTypes: actionType === "HIRE" ? ["PK_BARU"] : ["PK_BARU", "PK_PERPANJANGAN"] };
    case "CONTRACT_EXTENSION":
      return { kind: "PERJANJIAN_KERJA", pkTypes: ["PK_PERPANJANGAN"] };
    case "TRANSFER":
      return { kind: "SURAT_KEPUTUSAN", skTypes: ["SK_MUTASI"] };
    case "PROMOTION":
      return { kind: "SURAT_KEPUTUSAN", skTypes: ["SK_PROMOSI"] };
    case "DEMOTION":
      return { kind: "SURAT_KEPUTUSAN", skTypes: ["SK_DEMOSI"] };
    case "TERMINATION":
      if (context.terminationReason && policy.terminationReasonsWithoutRequiredSk.includes(context.terminationReason)) {
        return null;
      }
      return { kind: "SURAT_KEPUTUSAN", skTypes: ["SK_PEMBERHENTIAN"] };
    case "PLACEMENT":
    case "BASELINE":
    case "REVERSAL":
      return null;
  }
}
