import type { OrganizationSnapshot } from "./domain.js";
import { isEffective } from "./jakarta-date.js";

// ORG-008-6 (O-8, O-9) lookups over one structure snapshot, shared by the structure screens and by
// ATT-011-6b-3 (overtime rules D-10 and HC notification D-11) so both read the structure the same way.

type NodeLink = Pick<OrganizationSnapshot["nodes"][number], "stableKey" | "parentNodeKey" | "legacyUnitId">;

/**
 * ORG-008-6 (O-9, ATT-011 D-11): the imported units a structural unit stands for, itself first and
 * then upwards.
 *
 * Role scopes point at organizational_units, a flat list with no parent. The hierarchy lives in
 * the structure. Walking up the structure and collecting each linked imported unit is what turns
 * "the employee's unit or the unit above it" into something that can actually be resolved.
 * A unit with no link contributes nothing, so an unlinked branch falls back to the
 * organisation-wide recipients ATT-011 uses rather than guessing.
 */
export function linkedUnitChain(nodes: ReadonlyArray<NodeLink>, nodeKey: string): string[] {
  const byKey = new Map(nodes.map((node) => [node.stableKey, node]));
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | null = nodeKey;
  while (current && !seen.has(current)) {
    seen.add(current);
    const node = byKey.get(current);
    if (!node) break;
    if (node.legacyUnitId) chain.push(node.legacyUnitId);
    current = node.parentNodeKey;
  }
  return chain;
}

/**
 * ATT-011 D-11: the imported units "the employee's unit or a unit above it" stands for. The employee's
 * own imported unit comes first; then every linked unit up the structure, starting from the unit the
 * employee sits in on that date (primary membership, else a held seat) and from every structural unit
 * linked to the employee's imported unit.
 */
export function employeeUnitChain(
  snapshot: OrganizationSnapshot | null,
  employee: { id: string; organizationalUnitId: string | null },
  asOf: string,
): string[] {
  const chain: string[] = [];
  const add = (ids: string[]) => { for (const id of ids) if (!chain.includes(id)) chain.push(id); };
  if (employee.organizationalUnitId) add([employee.organizationalUnitId]);
  if (!snapshot) return chain;
  const starts: string[] = [];
  const effective = <T extends { effectiveFrom: string; effectiveTo: string | null }>(item: T) =>
    isEffective(item.effectiveFrom, item.effectiveTo, asOf);
  const memberships = snapshot.memberships.filter((item) => item.employeeId === employee.id && effective(item));
  const primary = memberships.find((item) => item.isPrimary) ?? memberships[0];
  if (primary) starts.push(primary.nodeKey);
  const positionByKey = new Map(snapshot.positions.map((position) => [position.stableKey, position]));
  for (const seat of snapshot.incumbencies.filter((item) => item.employeeId === employee.id && effective(item))) {
    const position = positionByKey.get(seat.positionKey);
    if (position) starts.push(position.nodeKey);
  }
  if (employee.organizationalUnitId) {
    for (const node of snapshot.nodes) if (node.legacyUnitId === employee.organizationalUnitId) starts.push(node.stableKey);
  }
  for (const start of starts) add(linkedUnitChain(snapshot.nodes, start));
  return chain;
}

export type PositionSearchItem = { stableKey: string; title: string; nodeKey: string; unitPath: string[] };

/**
 * ORG-008-6 (O-8, ATT-011 D-10): active positions on a date, found by title or unit path. An overtime
 * rule points at a position by its stable key, which survives renames and restructuring. The unit path
 * tells apart two seats with the same title in different schools (gap S-4).
 */
export function searchPositions(snapshot: OrganizationSnapshot, input: { q?: string | undefined; asOf: string; limit: number }): PositionSearchItem[] {
  const nodeByKey = new Map(snapshot.nodes.map((node) => [node.stableKey, node]));
  const pathOf = (nodeKey: string) => {
    const names: string[] = [];
    const seen = new Set<string>();
    let current: string | null = nodeKey;
    while (current && !seen.has(current)) {
      seen.add(current);
      const node = nodeByKey.get(current);
      if (!node) break;
      names.unshift(node.name);
      current = node.parentNodeKey;
    }
    return names;
  };
  const needle = input.q?.toLowerCase() ?? "";
  return snapshot.positions
    .filter((position) => position.active && isEffective(position.effectiveFrom, position.effectiveTo, input.asOf))
    .map((position) => ({
      stableKey: position.stableKey,
      title: position.title,
      nodeKey: position.nodeKey,
      unitPath: pathOf(position.nodeKey),
    }))
    .filter((item) => !needle
      || item.title.toLowerCase().includes(needle)
      || item.unitPath.join(" ").toLowerCase().includes(needle))
    .slice(0, input.limit);
}
