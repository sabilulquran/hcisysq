// ORG-008-4c: rebuilding a change set by replaying what the operator asked for.
//
// Two operator actions need the same machinery:
//   - "Perbarui perubahan ini dari struktur terbaru" after another publication moved the base
//     (gap D-2, refused at publish time since ORG-008-3a);
//   - "batalkan" one line of the change list.
//
// Both drop the current contents and re-apply the journal onto a fresh base. A command that no
// longer fits — its unit was removed by the newer structure, its employee is now placed elsewhere —
// is NOT quietly resolved: it is reported per line, so the operator decides what to redo.
//
// Pure: snapshots and journal entries in, snapshot and report out. The caller persists.

import { randomUUID } from "node:crypto";

import {
  applyOrganizationCommand,
  OrganizationCommandError,
  REPLAYABLE_COMMAND_TYPES,
  type OrganizationCommand,
  type OrganizationCommandAudit,
  type OrganizationCommandKeys,
} from "./commands.js";
import type { OrganizationSnapshot } from "./domain.js";

export interface OrganizationJournalEntry {
  id: string;
  seq: number;
  commandType: string;
  payload: Record<string, unknown>;
  summary: Record<string, unknown>;
}

export interface OrganizationReplaySkip {
  seq: number;
  commandType: string;
  code: string;
  message: string;
}

/** A journal line that records a change replay cannot reproduce. */
export interface OrganizationReplayBlock {
  seq: number;
  commandType: string;
  summary: Record<string, unknown>;
}

export interface OrganizationReplayResult {
  snapshot: OrganizationSnapshot;
  /** Entries that applied cleanly, in order, with the sequence they will keep. */
  applied: OrganizationJournalEntry[];
  /** Entries that no longer fit the new base. Nothing was guessed on their behalf. */
  skipped: OrganizationReplaySkip[];
  /**
   * Lines kept in the change set that replay cannot reproduce: a manual edit through a single-record
   * endpoint, or the legacy seed. Rebuilding would drop what they did, so the caller must refuse to
   * write while any are present instead of losing them quietly.
   */
  blocked: OrganizationReplayBlock[];
  events: OrganizationCommandAudit[];
}

/** A change set's own header on top of another change set's contents, with fresh row identifiers. */
export function snapshotFromBase(
  changeSet: OrganizationSnapshot["changeSet"],
  base: OrganizationSnapshot | null,
): OrganizationSnapshot {
  if (!base) {
    return {
      changeSet,
      nodes: [], jobProfiles: [], positions: [], memberships: [],
      incumbencies: [], authorityBindings: [], reportingOverrides: [],
    };
  }
  return {
    changeSet,
    nodes: base.nodes.map((item) => ({ ...item, id: randomUUID() })),
    jobProfiles: base.jobProfiles.map((item) => ({ ...item, id: randomUUID() })),
    positions: base.positions.map((item) => ({ ...item, id: randomUUID() })),
    memberships: base.memberships.map((item) => ({ ...item, id: randomUUID() })),
    incumbencies: base.incumbencies.map((item) => ({ ...item, id: randomUUID() })),
    authorityBindings: base.authorityBindings.map((item) => ({ ...item, id: randomUUID() })),
    reportingOverrides: base.reportingOverrides.map((item) => ({ ...item, id: randomUUID() })),
  };
}

function reuseKeysOf(entry: OrganizationJournalEntry): OrganizationCommandKeys {
  const summary = entry.summary ?? {};
  return {
    nodeKey: typeof summary.nodeKey === "string" ? summary.nodeKey : undefined,
    positionKey: typeof summary.positionKey === "string" ? summary.positionKey : undefined,
  };
}

/**
 * Re-apply a journal onto a base snapshot, optionally leaving one line out.
 *
 * Each command is applied to the result of the one before it, exactly as the operator built it up.
 * A command that throws is skipped and reported; the ones after it still get their turn, because a
 * single stale line should not cost the rest of the work.
 */
export function replayJournal(input: {
  changeSet: OrganizationSnapshot["changeSet"];
  base: OrganizationSnapshot | null;
  entries: OrganizationJournalEntry[];
  /** The one line to leave out, for "batalkan". */
  skipSeq?: number | undefined;
}): OrganizationReplayResult {
  const snapshot = snapshotFromBase(input.changeSet, input.base);
  const applied: OrganizationJournalEntry[] = [];
  const skipped: OrganizationReplaySkip[] = [];
  const blocked: OrganizationReplayBlock[] = [];
  const events: OrganizationCommandAudit[] = [];

  for (const entry of [...input.entries].sort((left, right) => left.seq - right.seq)) {
    if (input.skipSeq !== undefined && entry.seq === input.skipSeq) continue;
    if (!REPLAYABLE_COMMAND_TYPES.has(entry.commandType)) {
      blocked.push({ seq: entry.seq, commandType: entry.commandType, summary: entry.summary });
      continue;
    }
    const command = entry.payload as unknown as OrganizationCommand;
    try {
      const result = applyOrganizationCommand(snapshot, command, reuseKeysOf(entry));
      events.push(...result.events);
      applied.push({ ...entry, seq: applied.length + 1, summary: result.summary });
    } catch (error) {
      if (error instanceof OrganizationCommandError) {
        skipped.push({
          seq: entry.seq,
          commandType: entry.commandType,
          code: error.code,
          message: error.message,
        });
        continue;
      }
      throw error;
    }
  }

  return { snapshot, applied, skipped, blocked, events };
}
