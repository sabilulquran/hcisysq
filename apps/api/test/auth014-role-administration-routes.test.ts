import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config/env.js";
import { ActorAssertionError } from "../src/modules/auth/actor-assertion.js";
import { registerRoleAdministrationRoutes } from "../src/modules/auth/role-administration-routes.js";
import { OrganizationDirectoryMachineAuthError } from "../src/modules/organization-directory/machine-auth.js";
import { ApplicationAccessError } from "../src/modules/auth/application-access.js";

const BASE = { DATABASE_URL: "postgresql://example.invalid/test" };

// §2.4 step 4b re-checks SQ Hub Application Access, so the channel refuses to start without the
// OIDC machine client — the same one HCIS already uses at login.
const OIDC = {
  AUTH_MODE: "oidc",
  OIDC_ISSUER: "https://identity.example.test/realms/sq-staff",
  OIDC_CLIENT_ID: "hcis",
  OIDC_CLIENT_SECRET: "synthetic-secret",
  OIDC_REDIRECT_URI: "https://hcis.example.test/auth/callback",
  OIDC_POST_LOGOUT_REDIRECT_URI: "https://hcis.example.test/",
  SQ_HUB_APPLICATION_ACCESS_URL: "https://hub.example.test/internal/v1/application-access/check",
  SQ_HUB_MACHINE_CLIENT_ID: "hcis-api",
  SQ_HUB_MACHINE_CLIENT_SECRET: "synthetic-machine-secret",
};

const CHANNEL = {
  HCIS_ROLE_ADMIN_TOKEN_ISSUER: "https://identity.example.test/realms/sq-staff",
  HCIS_ROLE_ADMIN_TOKEN_AUDIENCE: "hcis-role-administration",
  HCIS_ROLE_ADMIN_ALLOWED_CLIENTS: "sq-hub-role-administration",
  HCIS_ROLE_ADMIN_ACTOR_AUDIENCE: "hcis-role-administration-actor",
};

const config = (enabled: boolean) => loadConfig({
  ...BASE, ...OIDC, ...CHANNEL,
  HCIS_ROLE_ADMIN_ENABLED: enabled ? "1" : "0",
});

// §2.11: the assertion now carries a jti and an expiry, and is spent once per request.
function assertionClaims() {
  return {
    issuer: "https://identity.example.test/realms/sq-staff",
    subject: "actor-sub",
    jti: randomUUID(),
    authorizedParty: "sq-hub",
    expiresAt: new Date(Date.now() + 60_000),
  };
}

const ACCOUNT = "00000000-0000-4000-8000-00000000000a";
const ROLE = "00000000-0000-4000-8000-00000000000b";
const REQUEST = "00000000-0000-4000-8000-00000000000c";

const grantBody = {
  requestId: REQUEST, roleId: ROLE, scopeType: "organization" as const,
  organizationalUnitId: null, reason: "mandat uji", startsOn: null, endsOn: null,
};

function app(options: { enabled?: boolean; pool?: Partial<Pool> } = {}) {
  const instance = Fastify();
  registerRoleAdministrationRoutes(
    instance,
    (options.pool ?? {}) as Pool,
    config(options.enabled ?? true),
    {
      verifyMachineToken: async () => ({ clientId: "sq-hub-role-administration" }),
      verifyActorAssertion: async () => assertionClaims(),
      applicationAccess: { isAllowed: async () => true },
    },
  );
  return instance;
}

const headers = { authorization: "Bearer synthetic", "x-sq-actor-assertion": "synthetic-assertion" };

// AUTH-014 F4 (§2.2, §2.4): the channel ships registered but switched off, and never accepts one
// proof in place of the other.
describe("AUTH-014 role administration channel", () => {
  it("requires its configuration before it can be switched on", () => {
    expect(() => loadConfig({ ...BASE, HCIS_ROLE_ADMIN_ENABLED: "1" })).toThrow();
    expect(loadConfig({ ...BASE }).HCIS_ROLE_ADMIN_ENABLED).toBe("0");
  });

  it("refuses the machine account that holds manage-users", () => {
    // ADR-0006 R-1 point 1: one leaked secret must not open both user management and role granting.
    expect(() => loadConfig({
      ...BASE,
      HCIS_ROLE_ADMIN_ENABLED: "1",
      HCIS_ROLE_ADMIN_TOKEN_ISSUER: "https://identity.example.test/realms/sq-staff",
      HCIS_ROLE_ADMIN_TOKEN_AUDIENCE: "hcis-role-administration",
      HCIS_ROLE_ADMIN_ALLOWED_CLIENTS: "sq-hub-identity-management",
      HCIS_ROLE_ADMIN_ACTOR_AUDIENCE: "hcis-role-administration-actor",
    })).toThrow();
  });

  it("refuses an actor audience equal to the machine audience", () => {
    // Otherwise a machine token would verify as an actor assertion.
    expect(() => loadConfig({
      ...BASE,
      HCIS_ROLE_ADMIN_ENABLED: "1",
      HCIS_ROLE_ADMIN_TOKEN_ISSUER: "https://identity.example.test/realms/sq-staff",
      HCIS_ROLE_ADMIN_TOKEN_AUDIENCE: "hcis-role-administration",
      HCIS_ROLE_ADMIN_ALLOWED_CLIENTS: "sq-hub-role-administration",
      HCIS_ROLE_ADMIN_ACTOR_AUDIENCE: "hcis-role-administration",
    })).toThrow();
  });

  it("fails closed while the switch is off, on every route", async () => {
    const instance = app({ enabled: false });
    for (const [method, url, payload] of [
      ["POST", `/internal/v1/role-administration/accounts/${ACCOUNT}/role-assignments`, grantBody],
      ["DELETE", `/internal/v1/role-administration/role-assignments/${ACCOUNT}`, { requestId: REQUEST }],
      ["GET", "/internal/v1/role-administration/catalog", undefined],
    ] as const) {
      const response = await instance.inject({ method, url, headers, payload });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ code: "ROLE_ADMIN_CHANNEL_DISABLED" });
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    await instance.close();
  });

  it("refuses a machine token without the actor assertion", async () => {
    const instance = app();
    const response = await instance.inject({
      method: "POST", url: `/internal/v1/role-administration/accounts/${ACCOUNT}/role-assignments`,
      headers: { authorization: "Bearer synthetic" }, payload: grantBody,
    });
    // Both credentials are demanded together, before the feature switch and before either is
    // verified, so a caller presenting one of the two learns nothing about the other.
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ code: "UNAUTHENTICATED" });
    await instance.close();
  });

  it("refuses an actor assertion without the machine token", async () => {
    const instance = app();
    const response = await instance.inject({
      method: "POST", url: `/internal/v1/role-administration/accounts/${ACCOUNT}/role-assignments`,
      headers: { "x-sq-actor-assertion": "synthetic-assertion" }, payload: grantBody,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ code: "UNAUTHENTICATED" });
    await instance.close();
  });

  it("refuses a client outside the allowlist and a token without the scope", async () => {
    for (const [code, status] of [["FORBIDDEN_CLIENT", 403], ["INSUFFICIENT_SCOPE", 403], ["INVALID_TOKEN", 401]] as const) {
      const instance = Fastify();
      registerRoleAdministrationRoutes(instance, {} as Pool, config(true), {
        verifyMachineToken: async () => {
          throw new OrganizationDirectoryMachineAuthError(code, "synthetic");
        },
        verifyActorAssertion: async () => assertionClaims(),
        applicationAccess: { isAllowed: async () => true },
      });
      const response = await instance.inject({
        method: "POST", url: `/internal/v1/role-administration/accounts/${ACCOUNT}/role-assignments`,
        headers, payload: grantBody,
      });
      expect(response.statusCode).toBe(status);
      await instance.close();
    }
  });

  it("separates an invalid assertion from an actor HCIS does not know", async () => {
    for (const [code, status, body] of [
      ["ACTOR_ASSERTION_INVALID", 401, "ROLE_ADMIN_ACTOR_ASSERTION_INVALID"],
      ["ACTOR_UNRESOLVED", 403, "ROLE_ADMIN_ACTOR_UNRESOLVED"],
    ] as const) {
      const instance = Fastify();
      registerRoleAdministrationRoutes(instance, {} as Pool, config(true), {
        verifyMachineToken: async () => ({ clientId: "sq-hub-role-administration" }),
        verifyActorAssertion: async () => { throw new ActorAssertionError(code, "synthetic"); },
        applicationAccess: { isAllowed: async () => true },
      });
      const response = await instance.inject({
        method: "POST", url: `/internal/v1/role-administration/accounts/${ACCOUNT}/role-assignments`,
        headers, payload: grantBody,
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ code: body });
      await instance.close();
    }
  });

  it("refuses a body that still states the actor, instead of ignoring the field", async () => {
    // §2.2: a caller sending it is working from the superseded design; swallowing the field would
    // hide that and leave the sender believing it was honoured.
    const query = vi.fn(async () => ({ rowCount: 1, rows: [{
      id: ACCOUNT, email: "actor@example.test", principalType: "EMPLOYEE",
      accountStatus: "active", employeeStatus: "active",
    }] }));
    const instance = app({ pool: { query } as unknown as Partial<Pool> });
    const response = await instance.inject({
      method: "POST", url: `/internal/v1/role-administration/accounts/${ACCOUNT}/role-assignments`,
      headers,
      payload: { ...grantBody, actor: { issuer: "https://identity.example.test", subject: "someone-else" } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: "INVALID_REQUEST" });
    await instance.close();
  });

  it("refuses an unknown field and a missing requestId", async () => {
    const query = vi.fn(async () => ({ rowCount: 1, rows: [{
      id: ACCOUNT, email: "actor@example.test", principalType: "EMPLOYEE",
      accountStatus: "active", employeeStatus: "active",
    }] }));
    const instance = app({ pool: { query } as unknown as Partial<Pool> });

    const withoutRequestId = { ...grantBody, requestId: undefined };
    for (const payload of [withoutRequestId, { ...grantBody, surprise: true }]) {
      const response = await instance.inject({
        method: "POST", url: `/internal/v1/role-administration/accounts/${ACCOUNT}/role-assignments`,
        headers, payload,
      });
      expect(response.statusCode).toBe(400);
    }
    await instance.close();
  });

  it("refuses to grant to the actor's own account", async () => {
    // §2.4 step 6, evaluated against the human the assertion named — not against the machine.
    const query = vi.fn(async () => ({ rowCount: 1, rows: [{
      id: ACCOUNT, email: "actor@example.test", principalType: "EMPLOYEE",
      accountStatus: "active", employeeStatus: "active",
    }] }));
    const instance = app({ pool: { query } as unknown as Partial<Pool> });
    const response = await instance.inject({
      method: "POST", url: `/internal/v1/role-administration/accounts/${ACCOUNT}/role-assignments`,
      headers, payload: grantBody,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "ROLE_DELEGATION_FORBIDDEN" });
    await instance.close();
  });

  it("refuses an actor assertion issued to the very machine client that presented the bearer", async () => {
    // Structural, not configuration-dependent: whoever presented the machine token on THIS request
    // cannot also be the human it names. The Keycloak probe of 2026-10-31 showed the machine client
    // can mint exactly such a token from its own client-credentials token, with no human anywhere.
    const pool = { query: async () => ({ rowCount: 1, rows: [{
      id: "00000000-0000-4000-8000-0000000000ff", email: "actor@example.test",
      principalType: "EMPLOYEE", accountStatus: "active", employeeStatus: "active",
    }] }) } as unknown as Pool;

    const instance = Fastify();
    registerRoleAdministrationRoutes(instance, pool, config(true), {
      verifyMachineToken: async () => ({ clientId: "sq-hub-role-administration" }),
      verifyActorAssertion: async () => ({ ...assertionClaims(), authorizedParty: "sq-hub-role-administration" }),
      applicationAccess: { isAllowed: async () => true },
    });
    const response = await instance.inject({
      method: "POST", url: `/internal/v1/role-administration/accounts/${ACCOUNT}/role-assignments`,
      headers, payload: grantBody,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ code: "ROLE_ADMIN_ACTOR_ASSERTION_INVALID" });
    await instance.close();
  });

  it("accepts an actor assertion issued to a different client than the bearer", async () => {
    // The corrected design: sq-hub issues the assertion, the machine client presents the bearer.
    const pool = { query: async () => ({ rowCount: 1, rows: [{
      id: "00000000-0000-4000-8000-0000000000ff", email: "actor@example.test",
      principalType: "EMPLOYEE", accountStatus: "active", employeeStatus: "active",
    }] }) } as unknown as Pool;

    const instance = Fastify();
    registerRoleAdministrationRoutes(instance, pool, config(true), {
      verifyMachineToken: async () => ({ clientId: "sq-hub-role-administration" }),
      verifyActorAssertion: async () => ({ ...assertionClaims(), authorizedParty: "sq-hub" }),
      applicationAccess: { isAllowed: async () => true },
    });
    const response = await instance.inject({
      method: "GET", url: "/internal/v1/role-administration/catalog", headers,
    });
    // Reaches the handler rather than being refused at the door; the query itself is mocked.
    expect(response.statusCode).not.toBe(401);
    await instance.close();
  });

  it("refuses an actor whose HCIS access SQ Hub has revoked, and fails closed when it cannot ask", async () => {
    // §2.4 step 4b. An employee whose Hub access was withdrawn but whose HCIS account row is still
    // active would otherwise remain a valid grantor; and an unanswerable Hub must deny, not admit.
    const pool = { query: async () => ({ rowCount: 1, rows: [{
      id: "00000000-0000-4000-8000-0000000000ff", email: "actor@example.test",
      principalType: "EMPLOYEE", accountStatus: "active", employeeStatus: "active",
    }] }) } as unknown as Pool;

    for (const [access, status, code] of [
      [{ isAllowed: async () => false }, 403, "HCIS_ACCESS_DENIED"],
      [{ isAllowed: async () => { throw new ApplicationAccessError("hub unreachable"); } }, 503, "APPLICATION_ACCESS_UNAVAILABLE"],
    ] as const) {
      const instance = Fastify();
      registerRoleAdministrationRoutes(instance, pool, config(true), {
        verifyMachineToken: async () => ({ clientId: "sq-hub-role-administration" }),
        verifyActorAssertion: async () => assertionClaims(),
        applicationAccess: access,
      });
      const response = await instance.inject({
        method: "POST", url: `/internal/v1/role-administration/accounts/${ACCOUNT}/role-assignments`,
        headers, payload: grantBody,
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ code });
      await instance.close();
    }
  });

  it("answers a spent actor assertion with 409, and never reaches the grant", async () => {
    // §2.11 gap 1 at the route level: once the legitimate request has spent the assertion, a
    // captured copy buys nothing, whatever requestId or target the attacker picks.
    let connected = false;
    const pool = {
      query: async (sql: string) => {
        if (sql.includes("INSERT INTO auth_actor_assertions")) {
          throw Object.assign(new Error("duplicate key"), {
            code: "23505", constraint: "auth_actor_assertions_pkey",
          });
        }
        return { rowCount: 1, rows: [{
          id: "00000000-0000-4000-8000-0000000000ff", email: "actor@example.test",
          principalType: "EMPLOYEE", accountStatus: "active", employeeStatus: "active",
        }] };
      },
      connect: async () => { connected = true; throw new Error("must not reach the grant"); },
    } as unknown as Pool;

    const instance = Fastify();
    registerRoleAdministrationRoutes(instance, pool, config(true), {
      verifyMachineToken: async () => ({ clientId: "sq-hub-role-administration" }),
      verifyActorAssertion: async () => assertionClaims(),
      applicationAccess: { isAllowed: async () => true },
    });
    const response = await instance.inject({
      method: "POST", url: `/internal/v1/role-administration/accounts/${ACCOUNT}/role-assignments`,
      headers, payload: { ...grantBody, requestId: randomUUID() },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: "ROLE_ADMIN_ACTOR_ASSERTION_SPENT" });
    expect(connected, "a spent assertion must not reach the grant").toBe(false);
    await instance.close();
  });

  it("answers a replayed requestId with 409 rather than a 500", async () => {
    const replay = Object.assign(new Error("duplicate key"), {
      code: "23505", constraint: "access_audit_events_hub_request_idx",
    });
    const instance = Fastify();
    registerRoleAdministrationRoutes(instance, {
      query: async () => ({ rowCount: 1, rows: [{
        id: "00000000-0000-4000-8000-0000000000ff", email: "actor@example.test",
        principalType: "EMPLOYEE", accountStatus: "active", employeeStatus: "active",
      }] }),
      connect: async () => { throw replay; },
    } as unknown as Pool, config(true), {
      verifyMachineToken: async () => ({ clientId: "sq-hub-role-administration" }),
      verifyActorAssertion: async () => assertionClaims(),
      applicationAccess: { isAllowed: async () => true },
    });
    const response = await instance.inject({
      method: "POST", url: `/internal/v1/role-administration/accounts/${ACCOUNT}/role-assignments`,
      headers, payload: grantBody,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: "ROLE_ADMIN_REQUEST_REPLAYED" });
    await instance.close();
  });
});
