import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config/env.js";
import type { OrganizationDirectorySnapshot } from "../src/modules/organization-directory/contract.js";
import {
  OrganizationDirectoryMachineAuthError,
} from "../src/modules/organization-directory/machine-auth.js";
import {
  OrganizationDirectoryUnavailableError,
} from "../src/modules/organization-directory/producer.js";
import { registerOrganizationDirectoryRoutes } from "../src/modules/organization-directory/routes.js";

const response: OrganizationDirectorySnapshot = {
  schemaVersion: "hcis-organization-directory.v1",
  source: {
    system: "hcis",
    snapshotId: "00000000-0000-4000-8000-000000000201",
    effectiveOn: "2026-09-01",
    publishedAt: "2026-09-01T01:00:00.000Z",
    createdAt: "2026-08-25T01:00:00.000Z",
  },
  asOf: "2026-09-24",
  version: `sha256:${"0".repeat(64)}`,
  generatedAt: "2026-09-24T01:30:00.000Z",
  counts: { units: 0, positions: 0, people: 0 },
  units: [],
  positions: [],
  people: [],
};

function config(enabled = true) {
  return loadConfig({
    DATABASE_URL: "postgresql://example.invalid/test",
    ORG_DIRECTORY_EXPORT_ENABLED: enabled ? "1" : "0",
    ORG_DIRECTORY_TOKEN_ISSUER: "https://identity.example.test/realms/sq-staff",
    ORG_DIRECTORY_TOKEN_AUDIENCE: "hcis-organization-directory",
    ORG_DIRECTORY_ALLOWED_CLIENTS: "sq-hub-organization-directory",
    ORG_DIRECTORY_REQUIRED_SCOPE: "organization-directory.read",
  });
}

describe("ORG-006 route", () => {
  it("fails closed while export is disabled", async () => {
    const app = Fastify();
    const verify = vi.fn(async () => ({ clientId: "sq-hub-organization-directory" }));
    await registerOrganizationDirectoryRoutes(app, {} as Pool, config(false), {
      verifyMachineToken: verify,
      loadSnapshot: async () => response,
    });

    const result = await app.inject({
      method: "GET",
      url: "/internal/v1/organization-directory/snapshot?asOf=2026-09-24",
      headers: { authorization: "Bearer synthetic-token" },
    });

    expect(result.statusCode).toBe(503);
    expect(result.json()).toMatchObject({ code: "ORGANIZATION_DIRECTORY_EXPORT_DISABLED" });
    expect(verify).not.toHaveBeenCalled();
    await app.close();
  });

  it("requires a bearer machine identity", async () => {
    const app = Fastify();
    await registerOrganizationDirectoryRoutes(app, {} as Pool, config(), {
      verifyMachineToken: async () => ({ clientId: "sq-hub-organization-directory" }),
      loadSnapshot: async () => response,
    });

    const result = await app.inject({
      method: "GET",
      url: "/internal/v1/organization-directory/snapshot?asOf=2026-09-24",
    });

    expect(result.statusCode).toBe(401);
    expect(result.json()).toMatchObject({ code: "INVALID_TOKEN" });
    await app.close();
  });

  it("returns 403 for a valid token principal without allowed client/scope authorization", async () => {
    const app = Fastify();
    await registerOrganizationDirectoryRoutes(app, {} as Pool, config(), {
      verifyMachineToken: async () => {
        throw new OrganizationDirectoryMachineAuthError(
          "INSUFFICIENT_SCOPE",
          "synthetic missing scope",
        );
      },
      loadSnapshot: async () => response,
    });

    const result = await app.inject({
      method: "GET",
      url: "/internal/v1/organization-directory/snapshot?asOf=2026-09-24",
      headers: { authorization: "Bearer synthetic-token" },
    });

    expect(result.statusCode).toBe(403);
    expect(result.json()).toMatchObject({ code: "INSUFFICIENT_SCOPE" });
    await app.close();
  });

  it("validates the business date and returns a safe snapshot to an authorized machine", async () => {
    const app = Fastify();
    const loadSnapshot = vi.fn(async () => response);
    await registerOrganizationDirectoryRoutes(app, {} as Pool, config(), {
      verifyMachineToken: async () => ({ clientId: "sq-hub-organization-directory" }),
      loadSnapshot,
    });

    const invalid = await app.inject({
      method: "GET",
      url: "/internal/v1/organization-directory/snapshot?asOf=2026-02-31",
      headers: { authorization: "Bearer synthetic-token" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(loadSnapshot).not.toHaveBeenCalled();

    const valid = await app.inject({
      method: "GET",
      url: "/internal/v1/organization-directory/snapshot?asOf=2026-09-24",
      headers: { authorization: "Bearer synthetic-token" },
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toEqual(response);
    expect(valid.headers["cache-control"]).toBe("no-store");
    expect(loadSnapshot).toHaveBeenCalledWith("2026-09-24");
    await app.close();
  });

  it("returns a generic 500 without leaking unexpected source errors", async () => {
    const app = Fastify();
    await registerOrganizationDirectoryRoutes(app, {} as Pool, config(), {
      verifyMachineToken: async () => ({ clientId: "sq-hub-organization-directory" }),
      loadSnapshot: async () => {
        throw new Error("synthetic internal detail that must not be returned");
      },
    });

    const result = await app.inject({
      method: "GET",
      url: "/internal/v1/organization-directory/snapshot?asOf=2026-09-24",
      headers: { authorization: "Bearer synthetic-token" },
    });

    expect(result.statusCode).toBe(500);
    expect(result.json()).toMatchObject({ code: "ORGANIZATION_DIRECTORY_INTERNAL_ERROR" });
    expect(result.body).not.toContain("synthetic internal detail");
    await app.close();
  });

  it("returns 503 without fabricating data when HCIS has no effective published snapshot", async () => {
    const app = Fastify();
    await registerOrganizationDirectoryRoutes(app, {} as Pool, config(), {
      verifyMachineToken: async () => ({ clientId: "sq-hub-organization-directory" }),
      loadSnapshot: async () => {
        throw new OrganizationDirectoryUnavailableError("synthetic no snapshot");
      },
    });

    const result = await app.inject({
      method: "GET",
      url: "/internal/v1/organization-directory/snapshot?asOf=2026-09-24",
      headers: { authorization: "Bearer synthetic-token" },
    });

    expect(result.statusCode).toBe(503);
    expect(result.json()).toMatchObject({ code: "ORGANIZATION_DIRECTORY_UNAVAILABLE" });
    await app.close();
  });
});
