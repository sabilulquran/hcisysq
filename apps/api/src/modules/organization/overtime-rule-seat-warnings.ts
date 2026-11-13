import type { OrganizationSnapshot } from "./domain.js";
import { isEffective } from "./jakarta-date.js";
import type { OrganizationQueryable } from "./repository.js";

/**
 * ORG-008-12 (decision O-8): an ATT-011 overtime rule (D-10) names a seat by its stable key. When a
 * structure change removes, switches off, or moves that seat, the rule silently stops matching the
 * people it was meant for, or starts matching others. The designer warns; it never blocks, and it
 * never edits the rule — HC decides in Pengaturan > Aturan lembur.
 */
export type OvertimeRuleSeatChange = "REMOVED" | "DEACTIVATED" | "MOVED";

export interface OvertimeRuleForSeatWarning {
  id: string;
  positionKey: string;
  targetLabel: string;
  reasonLabel: string;
}

export interface OvertimeRuleSeatWarning {
  ruleId: string;
  positionKey: string;
  targetLabel: string;
  reasonLabel: string;
  change: OvertimeRuleSeatChange;
  /** Seat title in the change, or before it when the seat is gone. */
  positionTitle: string | null;
  beforeUnitName: string | null;
  afterUnitName: string | null;
}

function seatInForce(snapshot: OrganizationSnapshot, positionKey: string, date: string) {
  const position = snapshot.positions.find((item) => item.stableKey === positionKey);
  if (!position) return { position: null, inForce: false };
  return { position, inForce: position.active && isEffective(position.effectiveFrom, position.effectiveTo, date) };
}

function unitName(snapshot: OrganizationSnapshot | null, nodeKey: string | null | undefined): string | null {
  if (!snapshot || !nodeKey) return null;
  return snapshot.nodes.find((node) => node.stableKey === nodeKey)?.name ?? null;
}

/**
 * Compares each rule's seat in the base the change was built on with the change itself, on the
 * change's effective date. A seat that was not in force before is not this change's doing and is not
 * reported; without a base (the very first structure) nothing can have been removed or moved.
 */
export function overtimeRuleSeatWarnings(
  rules: readonly OvertimeRuleForSeatWarning[],
  before: OrganizationSnapshot | null,
  after: OrganizationSnapshot,
): OvertimeRuleSeatWarning[] {
  if (!before) return [];
  const date = after.changeSet.effectiveOn;
  const warnings: OvertimeRuleSeatWarning[] = [];
  for (const rule of rules) {
    const was = seatInForce(before, rule.positionKey, date);
    if (!was.position || !was.inForce) continue;
    const now = seatInForce(after, rule.positionKey, date);
    let change: OvertimeRuleSeatChange | null = null;
    if (!now.position) change = "REMOVED";
    else if (!now.inForce) change = "DEACTIVATED";
    else if (now.position.nodeKey !== was.position.nodeKey) change = "MOVED";
    if (!change) continue;
    warnings.push({
      ruleId: rule.id,
      positionKey: rule.positionKey,
      targetLabel: rule.targetLabel,
      reasonLabel: rule.reasonLabel,
      change,
      positionTitle: now.position?.title ?? was.position.title,
      beforeUnitName: unitName(before, was.position.nodeKey),
      afterUnitName: now.position ? unitName(after, now.position.nodeKey) : null,
    });
  }
  return warnings;
}

/** Position rules still open on or after the date (rules that start later count: they will meet the change). */
export async function openPositionOvertimeRules(
  db: OrganizationQueryable,
  date: string,
): Promise<OvertimeRuleForSeatWarning[]> {
  const result = await db.query<OvertimeRuleForSeatWarning>(
    `SELECT id, target_ref AS "positionKey", target_label AS "targetLabel", reason_label AS "reasonLabel"
     FROM attendance_overtime_eligibility_rules
     WHERE target_kind = 'position' AND (effective_to IS NULL OR effective_to >= $1::date)
     ORDER BY effective_from, id`,
    [date],
  );
  return result.rows;
}
