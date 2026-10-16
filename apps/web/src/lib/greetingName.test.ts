import { describe, expect, it } from "vitest";
import { greetingName } from "./greetingName";

describe("greetingName", () => {
  it("uses the first word of an ordinary name", () => {
    expect(greetingName("Ahmad Fauzi")).toBe("Ahmad");
  });

  it("skips a leading initial", () => {
    expect(greetingName("M. Rahman Hakim")).toBe("Rahman");
    expect(greetingName("M Rizki")).toBe("Rizki");
  });

  it("skips abbreviated titles", () => {
    expect(greetingName("Dr. H. Abdul Karim")).toBe("Abdul");
  });

  it("keeps the whole name when every word is abbreviated", () => {
    expect(greetingName("A. B.")).toBe("A. B.");
  });

  it("falls back when the name is missing", () => {
    expect(greetingName(undefined)).toBe("Pegawai");
    expect(greetingName("   ")).toBe("Pegawai");
  });
});
