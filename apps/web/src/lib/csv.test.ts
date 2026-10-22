import { describe, expect, it } from "vitest";

import { csvCell } from "@/lib/csv";

describe("SEC-13 csvCell", () => {
  it("neutralizes formula-like text", () => {
    expect(csvCell("=1+1")).toBe("\"'=1+1\"");
    expect(csvCell("@cmd")).toBe("\"'@cmd\"");
    expect(csvCell("+62 812")).toBe("\"'+62 812\"");
  });

  it("keeps numbers, empty values and quotes intact", () => {
    expect(csvCell(-3)).toBe("\"-3\"");
    expect(csvCell("-3")).toBe("\"-3\"");
    expect(csvCell(null)).toBe("\"\"");
    expect(csvCell("Ruang \"A\"")).toBe("\"Ruang \"\"A\"\"\"");
  });
});
