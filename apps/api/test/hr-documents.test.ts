// DOC-001/DOC-002 pure domain helpers. No database, synthetic data only.

import { describe, expect, it } from "vitest";

import {
  addMonths,
  formatDocumentNumber,
  isDisciplinaryActive,
} from "../src/modules/documents/service.js";
import { buildLevelWarnings } from "../src/modules/documents/routes.js";

describe("DOC-001 document number (D-04)", () => {
  it("formats sequence, type code, roman month and year", () => {
    expect(formatDocumentNumber("SKK", 7, new Date("2026-03-11T04:00:00Z"))).toBe("007/SKK/YSQ/III/2026");
    expect(formatDocumentNumber("SKPK", 142, new Date("2026-12-31T23:00:00Z"))).toBe("142/SKPK/YSQ/XII/2026");
  });
});

describe("DOC-002 validity window (D-10)", () => {
  it("adds months across a year boundary", () => {
    expect(addMonths("2026-10-27", 6)).toBe("2027-04-27");
    expect(addMonths("2026-01-31", 1)).toBe("2026-03-03"); // month overflow normalizes, never throws
  });

  it("derives active state from the date, with no stored status (DOC-002-D)", () => {
    expect(isDisciplinaryActive("2026-12-31", "2026-10-27")).toBe(true);
    expect(isDisciplinaryActive("2026-10-27", "2026-10-27")).toBe(true);
    expect(isDisciplinaryActive("2026-10-26", "2026-10-27")).toBe(false);
  });
});

describe("DOC-002-E level warnings (D-11)", () => {
  it("warns when an equal or higher level is still in force, without refusing", () => {
    expect(buildLevelWarnings("SP1", ["SP2"])).toContain("Pegawai masih memiliki SP2 yang berlaku.");
    expect(buildLevelWarnings("SP2", ["SP2"])).toHaveLength(1);
  });

  it("warns when the level jumps past SP1 with nothing in force", () => {
    expect(buildLevelWarnings("SP3", [])).toHaveLength(1);
    expect(buildLevelWarnings("SP1", [])).toHaveLength(0);
  });

  it("stays silent on the ordinary escalation", () => {
    expect(buildLevelWarnings("SP2", ["SP1"])).toHaveLength(0);
  });
});
