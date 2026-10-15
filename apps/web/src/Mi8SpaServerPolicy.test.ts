import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

describe("Mi8VPS SPA static server parity with nginx.conf", () => {
  it("keeps the SPA shell and hashed-asset cache headers identical", async () => {
    const nginx = await source("../nginx.conf");
    const server = await source("../deploy/mi8/spa_static_server.py");

    expect(nginx).toContain('add_header Cache-Control "no-store, no-cache, must-revalidate" always;');
    expect(server).toContain('"Cache-Control": "no-store, no-cache, must-revalidate"');
    expect(server).toContain('"Pragma": "no-cache"');
    expect(server).toContain('"Expires": "0"');

    expect(nginx).toContain('add_header Cache-Control "public, max-age=604800, immutable";');
    expect(server).toContain('ASSET_CACHE = "public, max-age=604800, immutable"');
  });

  it("covers the same asset extensions as nginx.conf and never lists directories", async () => {
    const nginx = await source("../nginx.conf");
    const server = await source("../deploy/mi8/spa_static_server.py");

    const nginxExtensions = /\\\.\(\?:([^)]+)\)\$/.exec(nginx)?.[1].split("|") ?? [];
    expect(nginxExtensions.length).toBeGreaterThan(0);
    for (const pattern of nginxExtensions) {
      for (const extension of pattern === "woff2?" ? ["woff", "woff2"] : pattern === "jpe?g" ? ["jpg", "jpeg"] : [pattern]) {
        expect(server).toContain(`".${extension}"`);
      }
    }
    expect(server).not.toContain("list_directory(");
    expect(server).toContain('relative == "healthz"');
  });
});
