import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * AGENTS.md section 4 and ADR-0003 keep the payroll calculation rules free of HTTP,
 * database, storage, queue and vendor SDK dependencies. The engine lives inside
 * apps/api for now, so nothing but this test stops an import from creeping in.
 */
const enginePath = fileURLToPath(new URL("../src/modules/payroll/engine.ts", import.meta.url));
const source = readFileSync(enginePath, "utf8");

const FORBIDDEN = [
  "pg",
  "fastify",
  "node:fs",
  "node:http",
  "node:https",
  "node:crypto",
  "exceljs",
  "openid-client",
  "jose",
];

describe("PAY-003 engine purity", () => {
  it("imports nothing at all", () => {
    const imports = source.match(/^\s*import\s[^\n]*from\s+["'][^"']+["']/gm) ?? [];
    expect(imports).toEqual([]);
  });

  it("names no infrastructure dependency", () => {
    for (const dependency of FORBIDDEN) {
      expect(source).not.toContain(`from "${dependency}"`);
      expect(source).not.toContain(`require("${dependency}")`);
    }
  });

  it("reaches for no ambient state that would make a result non-deterministic", () => {
    expect(source).not.toMatch(/\bnew Date\s*\(\s*\)/);
    expect(source).not.toMatch(/\bDate\.now\s*\(/);
    expect(source).not.toMatch(/\bMath\.random\s*\(/);
    expect(source).not.toMatch(/\bprocess\.env\b/);
  });
});

/**
 * The PPh21 TER report is held to the same rule: its arithmetic is a pure
 * function of the result rows and the policy, and only the store reads them.
 */
const pph21Path = fileURLToPath(new URL("../src/modules/payroll/pph21.ts", import.meta.url));
const pph21Source = readFileSync(pph21Path, "utf8");

describe("PAY-003 PPh21 report purity", () => {
  it("imports only the engine and the policy shape", () => {
    const imports = [...pph21Source.matchAll(/^\s*import\s[^\n]*from\s+["']([^"']+)["']/gm)].map((match) => match[1]);
    expect(imports.sort()).toEqual(["./engine.js", "./policy.js"]);
  });

  it("reaches for no ambient state", () => {
    expect(pph21Source).not.toMatch(/\bnew Date\s*\(\s*\)/);
    expect(pph21Source).not.toMatch(/\bDate\.now\s*\(/);
    expect(pph21Source).not.toMatch(/\bMath\.random\s*\(/);
    expect(pph21Source).not.toMatch(/\bprocess\.env\b/);
  });
});
