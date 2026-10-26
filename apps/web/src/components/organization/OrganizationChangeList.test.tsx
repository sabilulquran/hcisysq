import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OrganizationChangeList } from "@/components/organization/OrganizationChangeList";
import type { OrganizationJournalEntry, OrganizationReplayReport } from "@/lib/organizationCommands";
import {
  organizationItemInUseSentence,
  organizationJournalSentence,
  organizationMembershipConflictSentence,
} from "@/lib/organizationLanguage";

/** Tags out, entities back to characters: what the operator actually reads. */
function visibleText(html: string) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&bull;/g, "•")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

const noop = () => undefined;

function entry(overrides: Partial<OrganizationJournalEntry>): OrganizationJournalEntry {
  return {
    id: "journal-1", seq: 1, commandType: "ADD_UNIT", summary: {},
    actorAccountId: "actor", createdAt: "2026-10-20T00:00:00Z",
    ...overrides,
  } as OrganizationJournalEntry;
}

const render = (props: Partial<Parameters<typeof OrganizationChangeList>[0]> = {}) =>
  renderToStaticMarkup(
    <OrganizationChangeList
      entries={[]} loading={false} error={null} staleBaseName={null} busy={false}
      preview={null} previewFor={null}
      onUndo={noop} onConfirmPreview={noop} onCancelPreview={noop} onRebase={noop} onRetry={noop}
      {...props}
    />,
  );

describe("ORG-008-4d the change list reads as sentences", () => {
  it("describes a unit added together with its leadership and approver", () => {
    const text = visibleText(render({
      entries: [entry({
        commandType: "ADD_UNIT",
        summary: { name: "Bidang Pendidikan", positionTitle: "Kepala Bidang Pendidikan", unitApprover: true },
      })],
    }));

    expect(text).toContain('Unit "Bidang Pendidikan" ditambahkan dengan pimpinan Kepala Bidang Pendidikan');
    expect(text).toContain("juga menyetujui cuti unit");
    expect(text).not.toContain("ADD_UNIT");
  });

  it("describes placing and moving employees with their counts", () => {
    const text = visibleText(render({
      entries: [entry({ seq: 2, commandType: "PLACE_EMPLOYEES", summary: { placed: 30, moved: 4 } })],
    }));
    expect(text).toContain("30 pegawai ditempatkan, 4 di antaranya dipindahkan dari unit lain");
  });

  it("offers to undo each line", () => {
    const html = render({ entries: [entry({})] });
    expect(html).toContain("Batalkan");
  });

  it("says plainly when nothing has been changed yet", () => {
    expect(visibleText(render())).toContain("Belum ada yang diubah");
  });

  it("never prints a command code, whatever the server sends", () => {
    const text = visibleText(render({
      entries: [entry({ commandType: "SOME_FUTURE_COMMAND" as OrganizationJournalEntry["commandType"] })],
    }));
    expect(text).not.toContain("SOME_FUTURE_COMMAND");
    expect(text).toContain("Satu perubahan tercatat");
  });
});

describe("ORG-008-4d the way out of a replaced base", () => {
  it("names the publication that replaced the base and offers to rebuild", () => {
    const text = visibleText(render({ staleBaseName: "Koreksi Oktober" }));

    expect(text).toContain("Struktur sudah diubah oleh");
    expect(text).toContain("Koreksi Oktober");
    expect(text).toContain("Perbarui dari struktur terbaru");
    expect(text).toContain("belum bisa diterbitkan");
  });

  it("shows what a rebuild would keep and what it would drop, before anything is written", () => {
    const preview: OrganizationReplayReport = {
      applied: false,
      baseChangeSetId: "base",
      kept: [{ seq: 1, commandType: "ADD_UNIT", summary: {} }],
      skipped: [{ seq: 2, commandType: "PLACE_EMPLOYEES", code: "ORGANIZATION_NODE_NOT_FOUND", message: "gone" }],
    };
    const text = visibleText(render({ preview, previewFor: null }));

    expect(text).toContain("1 tindakan dipertahankan");
    expect(text).toContain("1 tidak bisa diterapkan lagi");
    expect(text).toContain("Tempatkan pegawai");
    expect(text).toContain("perlu Anda ulangi");
    // The server's code never reaches the screen.
    expect(text).not.toContain("ORGANIZATION_NODE_NOT_FOUND");
  });

  it("frames the preview as an undo when it belongs to one line", () => {
    const preview: OrganizationReplayReport = { applied: false, baseChangeSetId: null, kept: [], skipped: [] };
    expect(visibleText(render({ preview, previewFor: 2 }))).toContain("Bila baris ini dibatalkan");
  });
});

describe("ORG-008-4d refusals say what to do next", () => {
  it("names what still points at an item instead of showing a code", () => {
    const sentence = organizationItemInUseSentence({
      itemKind: "unit",
      uses: [
        { kind: "POSITION", name: "Kepala SDIT" },
        { kind: "MEMBERSHIP", name: null },
        { kind: "MEMBERSHIP", name: null },
      ],
    });

    expect(sentence).toContain("Unit ini masih dipakai");
    expect(sentence).toContain("1 jabatan di dalamnya (Kepala SDIT)");
    expect(sentence).toContain("2 anggota");
    expect(sentence).not.toMatch(/[A-Z]{3,}_[A-Z]/);
  });

  it("falls back to a truthful sentence when the server sends no detail", () => {
    expect(organizationItemInUseSentence({})).toContain("masih dipakai");
  });

  it("asks about the move by name when the chart knows the employee", () => {
    const conflicts = [{ employeeId: "employee-ahmad", nodeKey: "node-x", nodeName: "Divisi Sosial" }];
    const sentence = organizationMembershipConflictSentence(
      conflicts,
      (id) => (id === "employee-ahmad" ? "Ahmad Sintetis" : null),
      conflicts,
    );

    expect(sentence).toBe("Ahmad Sintetis (sekarang di Divisi Sosial) sudah tercatat di unit lain. Pindahkan ke unit ini?");
  });

  it("stays general when it cannot resolve the names", () => {
    const conflicts = [{ employeeId: "unknown", nodeKey: "node-x", nodeName: null }];
    expect(organizationMembershipConflictSentence(conflicts, () => null, conflicts))
      .toContain("1 pegawai sudah tercatat di unit lain");
  });
});

describe("ORG-008-4d journal sentences cover every command", () => {
  it.each([
    ["APPOINT_ACTING", { effectiveFrom: "2026-09-01", effectiveTo: "2026-12-31" }, "Plt ditunjuk"],
    ["SET_REPORTS_TO", { parentPositionKey: "position-x" }, "melapor ke"],
    ["SET_UNIT_LEADER", {}, "Pemimpin unit diganti"],
    ["SET_UNIT_APPROVER", {}, "Penyetuju cuti unit diganti"],
    ["SET_OVERRIDE", {}, "Atasan khusus ditetapkan"],
  ])("describes %s without its code", (commandType, summary, expected) => {
    const sentence = organizationJournalSentence({ commandType, summary });
    expect(sentence.toLowerCase()).toContain(expected.toLowerCase());
    expect(sentence).not.toContain(commandType);
  });
});
