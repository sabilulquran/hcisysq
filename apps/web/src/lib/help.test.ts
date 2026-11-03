import { describe, expect, it } from "vitest";

import { articleQuery, contactHref, helpTopics, isUnreviewedSeed, paragraphs, topicHref, topicLabel } from "@/lib/help";

describe("HELP-001 client helpers", () => {
  it("keeps the thirteen topics in the API reading order (D-01)", () => {
    expect(helpTopics.map((entry) => entry.topic)).toEqual([
      "GENERAL", "ATTENDANCE", "OVERTIME", "LEAVE", "PAYSLIP", "TRIPS", "CALENDAR",
      "TRAINING", "LOANS", "ASSETS", "DOCUMENTS", "PERFORMANCE", "APPROVALS",
    ]);
    expect(topicLabel("ASSETS")).toBe("Asset Saya");
    expect(topicHref("LOANS")).toBe("/app/loans");
    expect(topicHref("GENERAL")).toBeNull();
  });

  it("sends a search only from two characters and always pages (D-06, ENG-LIST-001)", () => {
    expect(articleQuery({ q: "a", topic: "LEAVE" })).toBe("topic=LEAVE&page=1&pageSize=25");
    expect(articleQuery({ q: "  saldo cuti ", kind: "FAQ", page: 2, pageSize: 50 })).toBe("q=saldo+cuti&kind=FAQ&page=2&pageSize=50");
    expect(articleQuery({ q: "x".repeat(150) })).toContain(`q=${"x".repeat(100)}&`);
    expect(articleQuery({ status: "DRAFT" })).toBe("status=DRAFT&page=1&pageSize=25");
  });

  it("builds the link each contact channel opens (D-09)", () => {
    expect(contactHref({ channel: "WHATSAPP", value: "0812-0000-0000" })).toBe("https://wa.me/6281200000000");
    expect(contactHref({ channel: "WHATSAPP", value: "+62 812 0000 0000" })).toBe("https://wa.me/6281200000000");
    expect(contactHref({ channel: "PHONE", value: "0274 000000" })).toBe("tel:0274000000");
    expect(contactHref({ channel: "EMAIL", value: "hc@example.invalid" })).toBe("mailto:hc@example.invalid");
    expect(contactHref({ channel: "OFFICE", value: "Ruang HC" })).toBeNull();
  });

  it("flags only untouched initial drafts for review (D-03)", () => {
    const seed = { origin: "SEED", version: 1, status: "DRAFT", publishedAt: null } as const;
    expect(isUnreviewedSeed(seed)).toBe(true);
    expect(isUnreviewedSeed({ ...seed, version: 2 })).toBe(false);
    expect(isUnreviewedSeed({ ...seed, status: "PUBLISHED" })).toBe(false);
    expect(isUnreviewedSeed({ ...seed, origin: "HC" })).toBe(false);
    // Published once, archived and restored: HC has reviewed it already.
    expect(isUnreviewedSeed({ ...seed, publishedAt: "2026-11-03T02:00:00Z" })).toBe(false);
  });

  it("splits plain text into paragraphs on blank lines (D-05)", () => {
    expect(paragraphs("Satu.\n\n\nDua\nbaris.\n\n ")).toEqual(["Satu.", "Dua\nbaris."]);
  });
});
