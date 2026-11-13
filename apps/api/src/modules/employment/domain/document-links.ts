// EMP-010-A: link a Perjanjian Kerja or SK to an employment action that is already
// recorded (spec §4.5.3, audit employment.decision_document.linked). The usual path
// links documents while recording the action; this covers the document that arrives
// later (a resignation recorded before its SK was signed, or the PK/SK behind the
// baseline data). Pure: the route loads the rows and persists the result.

import { EmploymentDomainError, type ActionType, type DecisionDocumentRef, type EmploymentCategory, type EndReason } from "./model.js";
import { requiredDocument, type EmploymentPolicy } from "./policy.js";

export interface LinkableAction {
  id: string;
  employeeId: string;
  actionType: ActionType;
  state: "RECORDED" | "REVERSED";
  reasonCode: string | null;
  /** The action's "menjadi" snapshot: category and term dates for contract actions. */
  newSnapshot: { category?: EmploymentCategory | null; termFrom?: string | null; termTo?: string | null } | null;
}

export interface DocumentLinkPlan {
  /** Documents to link now, in request order. */
  link: string[];
  /** Documents already linked to this action; linking again is a no-op. */
  alreadyLinked: string[];
}

function fail(code: ConstructorParameters<typeof EmploymentDomainError>[0], message: string): never {
  throw new EmploymentDomainError(code, message);
}

/**
 * Which documents an already recorded action may take (DRAFT where §5 is silent):
 * - an action with a required kind (D-08) takes only that kind and type, and a PK must
 *   match the term the action recorded (PK_TERM_MISMATCH);
 * - a termination for resign or death (SK optional) takes only SK Pemberhentian;
 * - PLACEMENT takes any SK, BASELINE any SK or a PK of the same employee;
 * - a reversal, or an action that has been reversed, takes nothing.
 * A PK always belongs to exactly one employee (EMP-010-A).
 */
export function planDocumentLink(
  action: LinkableAction,
  documents: DecisionDocumentRef[],
  alreadyLinkedIds: readonly string[],
  policy: EmploymentPolicy,
): DocumentLinkPlan {
  if (action.state !== "RECORDED" || action.actionType === "REVERSAL") {
    fail("DECISION_DOCUMENT_LINK_NOT_ALLOWED", "Dokumen hanya dapat ditautkan ke tindakan yang masih berlaku.");
  }
  const linked = new Set(alreadyLinkedIds);
  const plan: DocumentLinkPlan = { link: [], alreadyLinked: [] };

  const context: { category?: EmploymentCategory; terminationReason?: EndReason } = {};
  if (action.newSnapshot?.category) context.category = action.newSnapshot.category;
  if (action.actionType === "TERMINATION" && action.reasonCode) context.terminationReason = action.reasonCode as EndReason;
  const requirement = requiredDocument(policy, action.actionType, context);

  for (const document of documents) {
    if (document.kind === "PERJANJIAN_KERJA" && document.employeeId !== action.employeeId) {
      fail("DECISION_DOCUMENT_EMPLOYEE_MISMATCH", "Perjanjian Kerja ini milik pegawai lain.");
    }

    if (requirement) {
      const kindOk = document.kind === requirement.kind
        && (!requirement.pkTypes || (document.pkType !== null && requirement.pkTypes.includes(document.pkType)))
        && (!requirement.skTypes || (document.skType !== null && requirement.skTypes.includes(document.skType)));
      if (!kindOk) {
        fail("DECISION_DOCUMENT_KIND_INVALID", "Jenis dokumen tidak sesuai dengan tindakan ini.");
      }
      if (requirement.kind === "PERJANJIAN_KERJA") {
        const snapshot = action.newSnapshot ?? {};
        const termMatches = document.contractFrom === (snapshot.termFrom ?? null)
          && document.contractTo === (snapshot.termTo ?? null)
          && document.category === (snapshot.category ?? null);
        if (!termMatches) fail("PK_TERM_MISMATCH", "Masa kontrak tidak sama dengan yang tertulis di Perjanjian Kerja.");
      }
    } else if (action.actionType === "TERMINATION") {
      if (document.kind !== "SURAT_KEPUTUSAN" || document.skType !== "SK_PEMBERHENTIAN") {
        fail("DECISION_DOCUMENT_KIND_INVALID", "Pemberhentian hanya dapat ditautkan ke SK Pemberhentian.");
      }
    } else if (action.actionType === "PLACEMENT") {
      if (document.kind !== "SURAT_KEPUTUSAN") {
        fail("DECISION_DOCUMENT_KIND_INVALID", "Penempatan hanya dapat ditautkan ke SK.");
      }
    }
    // BASELINE: any SK, or a PK of the same employee (checked above).

    if (linked.has(document.id)) plan.alreadyLinked.push(document.id);
    else if (!plan.link.includes(document.id)) plan.link.push(document.id);
  }
  return plan;
}
