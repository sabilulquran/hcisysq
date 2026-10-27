// DOC-001/DOC-002 pure domain helpers. No database, synthetic data only.

import { describe, expect, it } from "vitest";

import {
  addMonths,
  formatDocumentNumber,
  isDisciplinaryActive,
  jakartaDate,
} from "../src/modules/documents/service.js";
import { buildLevelWarnings } from "../src/modules/documents/routes.js";

describe("DOC-001 document number (D-04)", () => {
  it("formats sequence, type code, roman month and year", () => {
    expect(formatDocumentNumber("SKK", 7, new Date("2026-03-11T04:00:00Z"))).toBe("007/SKK/YSQ/III/2026");
  });

  it("uses the Jakarta calendar, so an early-morning letter is not backdated a year", () => {
    // 31 Dec 2026 23:00 UTC is 1 Jan 2027 06:00 WIB.
    const turnOfYear = new Date("2026-12-31T23:00:00Z");
    expect(jakartaDate(turnOfYear)).toBe("2027-01-01");
    expect(formatDocumentNumber("SKPK", 142, turnOfYear)).toBe("142/SKPK/YSQ/I/2027");
  });
});

describe("DOC-002 validity window (D-10)", () => {
  it("adds months and clamps to the end of the target month", () => {
    expect(addMonths("2026-10-27", 6)).toBe("2027-04-27");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-08-31", 6)).toBe("2027-02-28");
    expect(addMonths("2028-08-31", 6)).toBe("2029-02-28");
  });

  it("derives active state on read, with no scheduled job (DOC-002-D)", () => {
    expect(isDisciplinaryActive("ISSUED", "2026-10-01", "2026-12-31", "2026-10-27")).toBe(true);
    expect(isDisciplinaryActive("ISSUED", "2026-10-01", "2026-10-27", "2026-10-27")).toBe(true);
    expect(isDisciplinaryActive("ISSUED", "2026-10-01", "2026-10-26", "2026-10-27")).toBe(false);
    // Not yet in force.
    expect(isDisciplinaryActive("ISSUED", "2026-11-01", "2027-05-01", "2026-10-27")).toBe(false);
    // Revoked letters never read as in force, whatever their dates say.
    expect(isDisciplinaryActive("REVOKED", "2026-10-01", "2026-12-31", "2026-10-27")).toBe(false);
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
