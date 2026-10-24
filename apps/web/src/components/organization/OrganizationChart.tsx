import {
  AlertTriangle,
  BriefcaseBusiness,
  Building2,
  ChevronDown,
  ChevronRight,
  Crosshair,
  FoldVertical,
  Plus,
  Search,
  UserCheck,
  UsersRound,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useMemo, useState } from "react";

import type {
  OrganizationNode,
  OrganizationPosition,
} from "@/lib/organizationDesigner";
import {
  organizationNodeTypeLabel,
  organizationSeatEditability,
} from "@/lib/organizationLanguage";
import {
  buildOrganizationTree,
  type OrganizationLayoutPosition,
  type OrganizationTreeNode,
} from "@/lib/organizationTree";
import { cn } from "@/lib/utils";

export type OrganizationSelection =
  | { kind: "node"; key: string }
  | { kind: "position"; key: string }
  | null;

function PositionCard({
  position,
  isLeader,
  selected,
  onSelect,
}: {
  position: OrganizationLayoutPosition;
  isLeader: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const acting = position.actingIncumbent;
  const primary = position.primaryIncumbent;
  const vacant = !primary && !acting;
  const editability = organizationSeatEditability(position);

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      className={cn(
        "w-full rounded-xl border px-3 py-2.5 text-left transition-colors",
        selected
          ? "border-brand-primary bg-brand-primary-pale/60 ring-2 ring-brand-primary/15"
          : vacant
            ? "border-dashed border-warning-line bg-warning-soft/60 hover:border-warning-line"
            : "border-border/70 bg-surface/70 hover:border-brand-primary/40",
      )}
    >
      <span className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block truncate text-xs font-bold text-brand-heading">
            {position.title}
          </span>
          <span
            className={cn(
              "mt-0.5 block truncate text-[11px]",
              vacant ? "font-semibold text-warning-ink" : "text-muted-foreground",
            )}
          >
            {acting
              ? `${acting.employeeName} · Plt`
              : primary?.employeeName ?? "Kosong · belum ada pejabat"}
          </span>
        </span>
        {vacant ? (
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning-ink" aria-hidden="true" />
        ) : acting ? (
          <UserCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info-ink" aria-hidden="true" />
        ) : (
          <BriefcaseBusiness className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-primary-deep" aria-hidden="true" />
        )}
      </span>
      {position.visualRankOffset > 0 ? (
        <span className="mt-2 inline-flex rounded-full bg-info-soft px-2 py-0.5 text-[10px] font-semibold text-info-ink">
          Tampilan: turun {position.visualRankOffset} tingkat
        </span>
      ) : null}
      {isLeader ? (
        <span className="mt-2 ml-1 inline-flex rounded-full bg-brand-primary-pale px-2 py-0.5 text-[10px] font-semibold text-brand-primary-deep">
          Pemimpin unit
        </span>
      ) : null}
      {editability.badge ? (
        <span
          title={editability.reason ?? undefined}
          className="mt-2 ml-1 inline-flex rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground"
        >
          {editability.badge}
        </span>
      ) : null}
    </button>
  );
}

function PositionLane({
  position,
  isLeader,
  selected,
  onSelect,
}: {
  position: OrganizationLayoutPosition;
  isLeader: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const offsetHeight = position.visualRankOffset * 40;
  const connectorHeight = (position.parentPositionKey ? 16 : 0) + offsetHeight;

  return (
    <div
      className="relative"
      data-position-key={position.stableKey}
      data-parent-position-key={position.parentPositionKey ?? undefined}
      data-structural-depth={position.structuralDepth}
      data-visual-band={position.visualDepth}
      data-visual-rank-offset={position.visualRankOffset}
    >
      {connectorHeight > 0 ? (
        <span
          aria-hidden="true"
          className={cn(
            "mx-auto block w-px",
            position.parentPositionKey ? "bg-brand-primary/35" : "bg-transparent",
          )}
          style={{ height: `${connectorHeight}px` }}
          data-connector-kind={position.parentPositionKey ? "position" : undefined}
          data-connector-from={position.parentPositionKey ?? undefined}
          data-connector-to={position.parentPositionKey ? position.stableKey : undefined}
        />
      ) : null}
      <PositionCard
        position={position}
        isLeader={isLeader}
        selected={selected}
        onSelect={onSelect}
      />
    </div>
  );
}

function TreeBranch({
  item,
  selection,
  onSelect,
  parentKey,
  collapsed,
  onToggleCollapse,
  matches,
}: {
  item: OrganizationTreeNode;
  selection: OrganizationSelection;
  onSelect: (selection: Exclude<OrganizationSelection, null>) => void;
  parentKey?: string;
  // ORG-008-5: expansion is held by the chart so "Ciutkan semua" can reach every branch at once.
  collapsed: ReadonlySet<string>;
  onToggleCollapse: (nodeKey: string) => void;
  /** Keys that matched the search; null when nothing is being searched for. */
  matches: ReadonlySet<string> | null;
}) {
  const expanded = !collapsed.has(item.stableKey);
  const setExpanded = () => onToggleCollapse(item.stableKey);
  const selected = selection?.kind === "node" && selection.key === item.stableKey;
  const hasDetails = item.positions.length > 0 || item.children.length > 0;
  const nodeOffsetHeight = item.visualRankOffset * 48;
  const connectorHeight = (parentKey ? 28 : 0) + nodeOffsetHeight;

  return (
    <li
      className="relative flex min-w-[22rem] flex-col items-center px-3"
      data-node-key={item.stableKey}
      data-parent-node-key={item.parentNodeKey ?? undefined}
      data-structural-depth={item.structuralDepth}
      data-visual-band={item.visualDepth}
      data-visual-rank-offset={item.visualRankOffset}
    >
      {connectorHeight > 0 ? (
        <span
          aria-hidden="true"
          className={cn("block w-px", parentKey ? "bg-brand-primary/40" : "bg-transparent")}
          style={{ height: `${connectorHeight}px` }}
          data-connector-kind={parentKey ? "node" : undefined}
          data-connector-from={parentKey}
          data-connector-to={parentKey ? item.stableKey : undefined}
        />
      ) : null}
      <article
        role="button"
        tabIndex={0}
        onClick={() => onSelect({ kind: "node", key: item.stableKey })}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect({ kind: "node", key: item.stableKey });
          }
        }}
        data-search-match={matches?.has(item.stableKey) ? "true" : undefined}
        className={cn(
          "w-[22rem] rounded-2xl border bg-surface-raised p-4 shadow-[var(--shadow-soft)] transition-colors",
          selected
            ? "border-brand-primary ring-2 ring-brand-primary/15"
            : matches?.has(item.stableKey)
              ? "border-info-line ring-2 ring-info-line/30"
              : "border-border/70 hover:border-brand-primary/40",
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-primary-pale text-brand-primary-deep">
              <Building2 className="h-4 w-4" aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-bold text-brand-heading">{item.name}</span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">
                {organizationNodeTypeLabel(item.nodeType)} · {item.memberCount} anggota
              </span>
            </span>
          </div>
          {hasDetails ? (
            <button
              type="button"
              aria-label={expanded ? `Ciutkan ${item.name}` : `Buka ${item.name}`}
              onClick={(event) => {
                event.stopPropagation();
                setExpanded();
              }}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"
            >
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
          ) : null}
        </div>

        {item.visualRankOffset > 0 ? (
          <div className="mt-3 rounded-lg bg-info-soft px-2.5 py-2 text-[10px] leading-4 text-info-ink">
            Tampilan kotak ini diturunkan {item.visualRankOffset} tingkat. Hubungan sebenarnya tetap mengikuti garis induk dan tidak memengaruhi persetujuan.
          </div>
        ) : null}

        {expanded && item.positions.length > 0 ? (
          <div className="mt-3 space-y-2 border-t border-border/60 pt-3">
            {item.positions.map((position) => (
              <PositionLane
                key={position.stableKey}
                position={position}
                isLeader={item.leaderPositionKey === position.stableKey}
                selected={selection?.kind === "position" && selection.key === position.stableKey}
                onSelect={() => onSelect({ kind: "position", key: position.stableKey })}
              />
            ))}
          </div>
        ) : null}
      </article>

      {expanded && item.children.length > 0 ? (
        <div className="relative mt-8 flex min-w-max flex-col items-center" data-child-level-of={item.stableKey}>
          <span aria-hidden="true" className="h-7 w-px bg-brand-primary/40" />
          <ol
            className="flex min-w-max items-start justify-center gap-6 border-t border-brand-primary/40"
            data-layout-axis="horizontal"
            data-sibling-parent={item.stableKey}
          >
            {item.children.map((child) => (
              <TreeBranch
                key={child.stableKey}
                item={child}
                selection={selection}
                onSelect={onSelect}
                parentKey={item.stableKey}
                collapsed={collapsed}
                onToggleCollapse={onToggleCollapse}
                matches={matches}
              />
            ))}
          </ol>
        </div>
      ) : null}
    </li>
  );
}

/** ORG-008-5: every unit under one, so focusing a unit keeps its branch whole. */
function descendantsOf(nodes: OrganizationNode[], nodeKey: string): Set<string> {
  const keys = new Set([nodeKey]);
  let added = true;
  while (added) {
    added = false;
    for (const node of nodes) {
      if (node.parentNodeKey && keys.has(node.parentNodeKey) && !keys.has(node.stableKey)) {
        keys.add(node.stableKey);
        added = true;
      }
    }
  }
  return keys;
}

/**
 * ORG-008-5 (gap S-5): units and positions whose name matches, plus every unit above a hit, so a
 * match deep in the structure is reachable rather than hidden inside a collapsed branch.
 */
function searchMatches(
  nodes: OrganizationNode[],
  positions: OrganizationPosition[],
  query: string,
): Set<string> | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  const direct = new Set<string>();
  for (const node of nodes) {
    if (node.name.toLowerCase().includes(needle)) direct.add(node.stableKey);
  }
  for (const position of positions) {
    const holder = position.primaryIncumbent?.employeeName ?? position.actingIncumbent?.employeeName ?? "";
    if (position.title.toLowerCase().includes(needle) || holder.toLowerCase().includes(needle)) {
      direct.add(position.nodeKey);
    }
  }
  const byKey = new Map(nodes.map((node) => [node.stableKey, node]));
  const withAncestors = new Set(direct);
  for (const key of direct) {
    let parent = byKey.get(key)?.parentNodeKey ?? null;
    while (parent && !withAncestors.has(parent)) {
      withAncestors.add(parent);
      parent = byKey.get(parent)?.parentNodeKey ?? null;
    }
  }
  return withAncestors;
}

/**
 * ORG-008-5 (decision O-10): below 768px the horizontal chart is replaced by a nested list that
 * folds open and closed. It is view-only on a phone; editing stays on a laptop.
 */
function MobileBranch({
  item,
  onSelect,
}: {
  item: OrganizationTreeNode;
  onSelect: (selection: Exclude<OrganizationSelection, null>) => void;
}) {
  return (
    <li className="border-l border-border/60 pl-3">
      <details open>
        <summary className="cursor-pointer py-2 text-sm font-bold text-brand-heading">
          {item.name}
          <span className="ml-2 text-[11px] font-semibold text-muted-foreground">
            {organizationNodeTypeLabel(item.nodeType)} &middot; {item.memberCount} anggota
          </span>
        </summary>
        {item.positions.length > 0 ? (
          <ul className="mb-2 space-y-1">
            {item.positions.map((position) => (
              <li key={position.stableKey}>
                <button
                  type="button"
                  onClick={() => onSelect({ kind: "position", key: position.stableKey })}
                  className="w-full rounded-lg border border-border/60 bg-surface px-3 py-2 text-left text-xs"
                >
                  <span className="block font-bold text-brand-heading">{position.title}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {position.actingIncumbent
                      ? `${position.actingIncumbent.employeeName} · Plt`
                      : position.primaryIncumbent?.employeeName ?? "Kosong · belum ada pejabat"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {item.children.length > 0 ? (
          <ul className="space-y-1">
            {item.children.map((child) => (
              <MobileBranch key={child.stableKey} item={child} onSelect={onSelect} />
            ))}
          </ul>
        ) : null}
      </details>
    </li>
  );
}

export function OrganizationChart({
  nodes,
  positions,
  selection,
  onSelect,
  canEdit,
  onStart,
}: {
  nodes: OrganizationNode[];
  positions: OrganizationPosition[];
  selection: OrganizationSelection;
  onSelect: (selection: Exclude<OrganizationSelection, null>) => void;
  canEdit: boolean;
  onStart: () => void;
}) {
  const [query, setQuery] = useState("");
  const [focusNodeKey, setFocusNodeKey] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [zoom, setZoom] = useState(1);

  const matches = useMemo(() => searchMatches(nodes, positions, query), [nodes, positions, query]);
  const visibleNodes = useMemo(() => {
    if (!focusNodeKey) return nodes;
    const keys = descendantsOf(nodes, focusNodeKey);
    return nodes
      .filter((node) => keys.has(node.stableKey))
      // The focused unit becomes the root of what is drawn.
      .map((node) => (node.stableKey === focusNodeKey ? { ...node, parentNodeKey: null } : node));
  }, [nodes, focusNodeKey]);

  const roots = useMemo(
    () => buildOrganizationTree(visibleNodes, positions),
    [visibleNodes, positions],
  );

  const toggleCollapse = (nodeKey: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(nodeKey)) next.delete(nodeKey);
      else next.add(nodeKey);
      return next;
    });
  };

  if (nodes.length === 0) {
    return (
      <div className="flex min-h-[30rem] items-center justify-center p-6 text-center">
        <div className="max-w-md">
          <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-primary-pale text-brand-primary-deep">
            <UsersRound className="h-7 w-7" aria-hidden="true" />
          </span>
          <h2 className="mt-5 text-xl font-bold text-brand-heading">Belum ada struktur</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Mulai dari unit paling atas, lalu tambahkan unit, jabatan, dan anggota secara bertahap.
          </p>
          <button
            type="button"
            onClick={onStart}
            className="mt-5 inline-flex h-11 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground shadow-sm hover:bg-brand-primary-deep"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {canEdit ? "Tambah unit pertama" : "Mulai perubahan struktur"}
          </button>
        </div>
      </div>
    );
  }

  const matchCount = matches
    ? nodes.filter((node) => node.name.toLowerCase().includes(query.trim().toLowerCase())).length
      + positions.filter((position) => {
        const needle = query.trim().toLowerCase();
        const holder = position.primaryIncumbent?.employeeName ?? position.actingIncumbent?.employeeName ?? "";
        return position.title.toLowerCase().includes(needle) || holder.toLowerCase().includes(needle);
      }).length
    : 0;

  return (
    <div>
      <div className="flex flex-col gap-2 border-b border-border/70 bg-surface-raised px-5 py-3 lg:flex-row lg:items-center">
        <span className="relative block flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Cari unit, jabatan, atau nama pejabat..."
            aria-label="Cari di bagan"
            className="h-10 w-full rounded-xl border border-border bg-surface-raised pl-9 pr-3 text-sm outline-none focus:border-brand-primary"
          />
        </span>
        <span className="flex flex-wrap items-center gap-2">
          <select
            value={focusNodeKey}
            onChange={(event) => setFocusNodeKey(event.target.value)}
            aria-label="Fokus unit"
            className="h-10 rounded-xl border border-border bg-surface-raised px-3 text-xs font-bold"
          >
            <option value="">Seluruh struktur</option>
            {nodes.map((node) => <option key={node.stableKey} value={node.stableKey}>{node.name}</option>)}
          </select>
          {focusNodeKey ? (
            <button type="button" onClick={() => setFocusNodeKey("")} className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-border px-3 text-xs font-bold hover:bg-muted">
              <Crosshair className="h-3.5 w-3.5" aria-hidden="true" /> Tampilkan semua
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setCollapsed(collapsed.size > 0 ? new Set() : new Set(nodes.map((node) => node.stableKey)))}
            className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-border px-3 text-xs font-bold hover:bg-muted"
          >
            <FoldVertical className="h-3.5 w-3.5" aria-hidden="true" />
            {collapsed.size > 0 ? "Buka semua" : "Ciutkan semua"}
          </button>
          <span className="inline-flex items-center gap-1">
            <button type="button" aria-label="Perkecil" onClick={() => setZoom((value) => Math.max(0.6, Math.round((value - 0.1) * 10) / 10))} className="flex h-10 w-10 items-center justify-center rounded-xl border border-border hover:bg-muted">
              <ZoomOut className="h-4 w-4" aria-hidden="true" />
            </button>
            <button type="button" aria-label="Perbesar" onClick={() => setZoom((value) => Math.min(1.4, Math.round((value + 0.1) * 10) / 10))} className="flex h-10 w-10 items-center justify-center rounded-xl border border-border hover:bg-muted">
              <ZoomIn className="h-4 w-4" aria-hidden="true" />
            </button>
          </span>
        </span>
      </div>

      {query.trim() ? (
        <p className="border-b border-border/70 bg-info-soft px-5 py-2 text-xs text-info-ink">
          {matchCount === 0
            ? "Tidak ada unit, jabatan, atau pejabat yang cocok."
            : `${matchCount} hasil ditandai. Unit di atasnya ikut ditampilkan agar hasilnya terlihat.`}
        </p>
      ) : null}

      {/* Below 768px the horizontal chart is unreadable, so a nested list takes its place (O-10). */}
      <ul className="space-y-1 p-4 md:hidden" data-chart-view="mobile">
        {roots.map((root) => <MobileBranch key={root.stableKey} item={root} onSelect={onSelect} />)}
      </ul>

      <div className="hidden min-w-max overflow-auto p-5 sm:p-7 md:block" data-chart-view="desktop">
        <div style={{ transform: `scale(${zoom})`, transformOrigin: "top center" }} data-chart-zoom={zoom}>
          <ol className="flex min-w-max items-start justify-center gap-8" data-layout-axis="horizontal" data-root-level>
            {roots.map((root) => (
              <TreeBranch
                key={root.stableKey}
                item={root}
                selection={selection}
                onSelect={onSelect}
                collapsed={collapsed}
                onToggleCollapse={toggleCollapse}
                matches={matches}
              />
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}
