import {
  AlertTriangle,
  BriefcaseBusiness,
  Building2,
  ChevronDown,
  ChevronRight,
  Plus,
  UserCheck,
  UsersRound,
} from "lucide-react";
import { useMemo, useState } from "react";

import type {
  OrganizationNode,
  OrganizationPosition,
} from "@/lib/organizationDesigner";
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
              ? `${acting.employeeName} · Pelaksana tugas`
              : primary?.employeeName ?? "VACANT · Belum ada pejabat"}
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
          Tampilan {position.visualRankOffset} tingkat lebih rendah
        </span>
      ) : null}
      {isLeader ? (
        <span className="mt-2 ml-1 inline-flex rounded-full bg-brand-primary-pale px-2 py-0.5 text-[10px] font-semibold text-brand-primary-deep">
          Leader kelompok
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
}: {
  item: OrganizationTreeNode;
  selection: OrganizationSelection;
  onSelect: (selection: Exclude<OrganizationSelection, null>) => void;
  parentKey?: string;
}) {
  const [expanded, setExpanded] = useState(true);
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
        className={cn(
          "w-[22rem] rounded-2xl border bg-surface-raised p-4 shadow-[var(--shadow-soft)] transition-colors",
          selected
            ? "border-brand-primary ring-2 ring-brand-primary/15"
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
                {item.nodeType} · {item.memberCount} anggota
              </span>
            </span>
          </div>
          {hasDetails ? (
            <button
              type="button"
              aria-label={expanded ? `Ciutkan ${item.name}` : `Buka ${item.name}`}
              onClick={(event) => {
                event.stopPropagation();
                setExpanded((value) => !value);
              }}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"
            >
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
          ) : null}
        </div>

        {item.visualRankOffset > 0 ? (
          <div className="mt-3 rounded-lg bg-info-soft px-2.5 py-2 text-[10px] leading-4 text-info-ink">
            Rank visual diturunkan {item.visualRankOffset} tingkat. Hubungan struktural tetap mengikuti garis induk.
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
              />
            ))}
          </ol>
        </div>
      ) : null}
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
  const roots = useMemo(() => buildOrganizationTree(nodes, positions), [nodes, positions]);

  if (nodes.length === 0) {
    return (
      <div className="flex min-h-[30rem] items-center justify-center p-6 text-center">
        <div className="max-w-md">
          <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-primary-pale text-brand-primary-deep">
            <UsersRound className="h-7 w-7" aria-hidden="true" />
          </span>
          <h2 className="mt-5 text-xl font-bold text-brand-heading">Start organization structure</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Bangun struktur dari kelompok paling atas, lalu tambahkan unit, posisi, dan anggota secara bertahap.
          </p>
          <button
            type="button"
            onClick={onStart}
            className="mt-5 inline-flex h-11 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground shadow-sm hover:bg-brand-primary-deep"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {canEdit ? "Tambah kelompok pertama" : "Buat draft struktur"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-w-max overflow-auto p-5 sm:p-7">
      <ol className="flex min-w-max items-start justify-center gap-8" data-layout-axis="horizontal" data-root-level>
      {roots.map((root) => (
        <TreeBranch
          key={root.stableKey}
          item={root}
          selection={selection}
          onSelect={onSelect}
        />
      ))}
      </ol>
    </div>
  );
}
