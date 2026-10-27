import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { ApiConfig } from "../src/config/env.js";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, pageOffset, pageQuerySchema, pagination } from "../src/lib/pagination.js";

// ENG-LIST-001 §5: every registered GET route carries a list classification, so a new list
// endpoint cannot ship without deciding how it pages. Known violations are listed as debt
// against a PAG package and pinned, so the debt can only shrink.
const registered: Array<{ method: string; url: string }> = [];

vi.mock("fastify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fastify")>();
  const factory = ((options?: object) => {
    const app = actual.default(options);
    app.addHook("onRoute", (route) => {
      for (const method of [route.method].flat()) registered.push({ method, url: route.url });
    });
    return app;
  }) as unknown as typeof actual.default;
  return { ...actual, default: factory };
});

const { createApp } = await import("../src/app.js");

// Lower this when a PAG package fixes routes; raising it needs an owner-approved exception.
const DEBT_ROUTES = 42;

const KINDS = ["paged", "typeahead", "range", "bounded", "aggregate", "single", "export", "snapshot", "debt"] as const;

type Entry = {
  url: string;
  list: (typeof KINDS)[number];
  reason?: string;
  package?: string;
};

const config = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://synthetic@127.0.0.1:1/unused",
  AUTH_MODE: "local",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
} as ApiConfig;

async function registeredGetUrls() {
  registered.length = 0;
  // Route registration does not query the database; an inert pool keeps this test DB-free.
  const app = await createApp(config, {} as Pool);
  await app.ready();
  await app.close();
  return [...new Set(registered.filter((route) => route.method === "GET").map((route) => route.url))].sort();
}

async function classification() {
  const file = JSON.parse(
    await readFile(new URL("../../../docs/development/list-endpoint-classification.json", import.meta.url), "utf8"),
  ) as { routes: Entry[] };
  return file.routes;
}

describe("ENG-LIST-001 list endpoint classification", () => {
  it("classifies every registered GET route exactly once", async () => {
    const urls = await registeredGetUrls();
    const entries = await classification();
    const keys = entries.map((entry) => entry.url);
    expect(urls.filter((url) => !keys.includes(url)), "GET routes missing from list-endpoint-classification.json").toEqual([]);
    expect(keys.filter((url) => !urls.includes(url)), "classified routes that are not registered").toEqual([]);
    expect(keys.length).toBe(new Set(keys).size);
    // Building the whole app cold can take longer than the default 5 s on a loaded machine.
  }, 30_000);

  it("explains every exception and ties every violation to a PAG package", async () => {
    for (const entry of await classification()) {
      expect(KINDS, entry.url).toContain(entry.list);
      if (["bounded", "range", "typeahead", "snapshot", "export"].includes(entry.list)) {
        expect(entry.reason?.trim(), `${entry.url} needs a reason`).toBeTruthy();
      }
      if (entry.list === "debt") {
        expect(entry.package, `${entry.url} needs a PAG package`).toMatch(/^PAG-\d+$/);
        expect(entry.reason?.trim(), `${entry.url} needs a reason`).toBeTruthy();
      }
    }
  });

  it("pins the pagination debt so it can only shrink", async () => {
    expect((await classification()).filter((entry) => entry.list === "debt")).toHaveLength(DEBT_ROUTES);
  });
});

describe("ENG-LIST-001 shared offset pagination", () => {
  it("defaults to the first page of 25 and caps the page size at 100", () => {
    expect(pageQuerySchema.parse({})).toEqual({ page: 1, pageSize: DEFAULT_PAGE_SIZE });
    expect(pageQuerySchema.parse({ page: "3", pageSize: "100" })).toEqual({ page: 3, pageSize: MAX_PAGE_SIZE });
    for (const query of [{ pageSize: "101" }, { pageSize: "0" }, { page: "0" }, { page: "x" }, { pageSize: "2.5" }]) {
      expect(pageQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
    }
  });

  it("computes the offset and the page count", () => {
    expect(pageOffset({ page: 3, pageSize: 25 })).toBe(50);
    expect(pagination({ page: 2, pageSize: 25 }, 863)).toEqual({ page: 2, pageSize: 25, total: 863, pageCount: 35 });
    expect(pagination({ page: 1, pageSize: 25 }, 0)).toEqual({ page: 1, pageSize: 25, total: 0, pageCount: 1 });
  });
});
