import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OrganizationChart } from "@/components/organization/OrganizationChart";
import { organizationCommandLabel, organizationJournalSentence } from "@/lib/organizationLanguage";

/**
 * ORG-008-7 on screen (decision O-3): the empty-structure state offers both ways to start, and the
 * change list says where seeded content came from.
 */

function visibleText(html: string) {
  return html.replace(/<[^>]*>/g, " ").replace(/&quot;/g, '"').replace(/\s+/g, " ");
}

const noop = () => undefined;

const render = (onSeedFromLegacy?: () => void) =>
  renderToStaticMarkup(
    <OrganizationChart
      nodes={[]} positions={[]} selection={null} onSelect={noop}
      canEdit onStart={noop} onSeedFromLegacy={onSeedFromLegacy}
    />,
  );

describe("ORG-008-7 layar belum ada struktur", () => {
  it("offers both ways to start when seeding is available", () => {
    const text = visibleText(render(noop));

    expect(text).toContain("Belum ada struktur");
    expect(text).toContain("Mulai dari data yang sudah ada");
    expect(text).toContain("Mulai dari kosong");
    expect(text).toContain("sudah tercatat di HCIS");
  });

  it("keeps the single start button when seeding is not available to this session", () => {
    // Seeding writes incumbents and authority, so a session that may not do that is not offered a
    // button that would end in 403 (acceptance ORG-008-J).
    const text = visibleText(render());

    expect(text).not.toContain("Mulai dari data yang sudah ada");
    expect(text).toContain("Tambah unit pertama");
  });
});

describe("ORG-008-7 di daftar perubahan", () => {
  it("says where the content came from, with its counts", () => {
    const sentence = organizationJournalSentence({
      commandType: "SEED_FROM_LEGACY",
      summary: { units: 12, placements: 412 },
    });

    expect(sentence).toContain("Disusun dari data lama: 12 unit, 412 penempatan pegawai");
    expect(sentence).toContain("tinjau sebelum diterbitkan");
    expect(sentence).not.toContain("SEED_FROM_LEGACY");
  });

  it("still reads as a sentence when the counts are missing", () => {
    const sentence = organizationJournalSentence({ commandType: "SEED_FROM_LEGACY", summary: {} });
    expect(sentence).toContain("usulan");
    expect(sentence).not.toContain("SEED_FROM_LEGACY");
  });

  it("has a short name for a seeded line that could not be replayed", () => {
    expect(organizationCommandLabel("SEED_FROM_LEGACY")).toBe("Usulan dari data lama");
  });
});
