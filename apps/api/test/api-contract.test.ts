import { readdir, readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import type { ApiConfig } from "../src/config/env.js";

// AGENTS.md §7: the HTTP contract in docs/api must stay in sync with the code. This keeps
// every contract file parseable, every $ref resolvable, and every documented operation
// backed by a registered route (openapi.yaml was invalid YAML from 2026-09-24 to 2026-10-22
// without any check noticing).
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

const config = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://synthetic@127.0.0.1:1/unused",
  AUTH_MODE: "local",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
} as ApiConfig;

const API_DOCS = new URL("../../../docs/api/", import.meta.url);
const HTTP_METHODS = ["get", "put", "post", "delete", "patch"];

type Document = Record<string, unknown>;

async function loadContracts() {
  const files = (await readdir(API_DOCS)).filter((name) => name.endsWith(".yaml")).sort();
  const docs = new Map<string, Document>();
  for (const file of files) docs.set(file, parse(await readFile(new URL(file, API_DOCS), "utf8"), { uniqueKeys: true }) as Document);
  return docs;
}

function resolvePointer(doc: Document, fragment: string): unknown {
  let node: unknown = doc;
  for (const raw of fragment.replace(/^\//, "").split("/")) {
    const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (node === null || typeof node !== "object" || !(key in node)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

function collectRefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((item) => collectRefs(item, out));
  else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") out.push(value);
      else collectRefs(value, out);
    }
  }
  return out;
}

// Follows a path-item $ref into its target file so documented operations are counted once.
function documentedOperations(docs: Map<string, Document>) {
  const operations = new Set<string>();
  for (const doc of docs.values()) {
    const paths = (doc.paths ?? {}) as Record<string, Record<string, unknown>>;
    for (const [path, item] of Object.entries(paths)) {
      if (typeof item.$ref === "string") continue;
      for (const method of HTTP_METHODS) {
        if (item[method]) operations.add(`${method.toUpperCase()} ${path.replace(/\{([^}]+)\}/g, ":$1")}`);
      }
    }
  }
  return operations;
}

async function registeredRoutes() {
  registered.length = 0;
  const app = await createApp(config, {} as Pool);
  await app.ready();
  await app.close();
  return new Set(registered.filter((route) => route.method !== "HEAD").map((route) => `${route.method} ${route.url}`));
}

describe("docs/api contract", () => {
  it("parses every contract file without duplicate keys", async () => {
    const docs = await loadContracts();
    expect(docs.size).toBeGreaterThan(0);
    for (const [file, doc] of docs) expect(doc.openapi, file).toBe("3.1.0");
  });

  it("resolves every $ref", async () => {
    const docs = await loadContracts();
    const broken: string[] = [];
    for (const [file, doc] of docs) {
      for (const ref of collectRefs(doc)) {
        const [target, fragment = ""] = ref.split("#");
        const targetDoc = target ? docs.get(target.replace(/^\.\//, "")) : doc;
        if (!targetDoc || resolvePointer(targetDoc, fragment) === undefined) broken.push(`${file}: ${ref}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("documents only operations that have a registered route", async () => {
    const routes = await registeredRoutes();
    const stale = [...documentedOperations(await loadContracts())].filter((operation) => !routes.has(operation));
    expect(stale, "documented in docs/api but not registered in apps/api").toEqual([]);
  });
});
