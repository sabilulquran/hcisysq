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
      ["GET", "/internal/v1/role-administration/accounts?issuer=i&subject=s", undefined],
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

  /**
   * §2.1b. SQ Hub holds a Keycloak subject and needs the HCIS account id and assignment ids; the
   * alternative was the operator copying UUIDs between two applications by hand.
   */
  describe("account lookup", () => {
    const TARGET = "00000000-0000-4000-8000-00000000001a";
    const UNIT = "00000000-0000-4000-8000-00000000001b";
    const ACTOR = "00000000-0000-4000-8000-0000000000ff";
    const URL = "/internal/v1/role-administration/accounts";
    const WHO = "issuer=https%3A%2F%2Fidentity.example.test%2Frealms%2Fsq-staff&subject=target-sub";

    type Call = { text: string; values: unknown[] };

    /**
     * Answers by CALL ORDER, not by sniffing the SQL. An earlier version matched the target query
     * on the substring `"accountId"`, which meant that aliasing the actor query's column the same
     * way — a change that reads as cosmetic — would have fed the actor lookup the target's row
     * with every assertion in this file still green.
     */
    function lookupPool(options: {
      actor?: Record<string, unknown>;
      target?: Record<string, unknown> | null;
      total?: number;
      assignments?: unknown[];
    } = {}) {
      const calls: Call[] = [];
      const answers: Array<() => { rowCount: number; rows: unknown[] }> = [
        () => ({ rowCount: 1, rows: [options.actor ?? {
          id: ACTOR, email: "actor@example.test",
          principalType: "EMPLOYEE", accountStatus: "active", employeeStatus: "active",
        }] }),
        () => (options.target === null
          ? { rowCount: 0, rows: [] }
          : { rowCount: 1, rows: [options.target ?? {
            accountId: TARGET, principalType: "EMPLOYEE", status: "active", employeeStatus: "active",
          }] }),
        () => ({ rowCount: 1, rows: [{ total: options.total ?? 0 }] }),
        () => ({ rowCount: (options.assignments ?? []).length, rows: options.assignments ?? [] }),
      ];
      const pool = {
        query: async (text: string, values: unknown[] = []) => {
          calls.push({ text, values });
          const answer = answers[calls.length - 1];
          // Anything beyond the four expected reads is the audit insert.
          return answer ? answer() : { rowCount: 1, rows: [] };
        },
      } as unknown as Pool;
      return { pool, calls };
    }

    function lookupApp(pool: Pool, actorPrincipal = "EMPLOYEE") {
      const instance = Fastify();
      registerRoleAdministrationRoutes(instance, pool, config(true), {
        verifyMachineToken: async () => ({ clientId: "sq-hub-role-administration" }),
        verifyActorAssertion: async () => assertionClaims(),
        applicationAccess: { isAllowed: async () => true },
      });
      void actorPrincipal;
      return instance;
    }

    const assignmentRow = (roleKey: string, permissions: string[], id: string) => ({
      assignmentId: id, roleId: ROLE, roleKey, roleName: "Peran uji", permissions,
      scopeType: "unit", organizationalUnitId: UNIT, organizationalUnitName: "Unit Uji",
      startsOn: "2026-01-01", endsOn: null, createdAt: new Date("2026-01-02T03:04:05.000Z"),
    });

    it("answers the account id and its assignments, scoped to the subject that was asked for", async () => {
      const { pool, calls } = lookupPool({
        total: 2,
        assignments: [
          assignmentRow("human_capital", ["employees.read.unit"], "00000000-0000-4000-8000-00000000001c"),
          // Not grantable through this channel; still listed, but flagged, so the Hub does not
          // offer a revoke that HCIS will refuse.
          assignmentRow("tidak_dikenal", ["employees.read.unit"], "00000000-0000-4000-8000-00000000001d"),
        ],
      });
      const instance = lookupApp(pool);
      const response = await instance.inject({ method: "GET", url: `${URL}?${WHO}`, headers });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.account).toEqual({ accountId: TARGET, grantable: true, notGrantableReason: null });
      expect(body.assignments.pagination).toEqual({ page: 1, pageSize: 25, total: 2, pageCount: 1 });
      expect(body.assignments.items.map((item: { revocableViaHub: boolean }) => item.revocableViaHub))
        .toEqual([true, false]);

      // The parameters matter more than the SQL text: a handler that passed the ACTOR's identity,
      // or the actor's account id, would return a well-formed answer about the wrong person.
      expect(calls[1]?.values).toEqual([
        "https://identity.example.test/realms/sq-staff", "target-sub",
      ]);
      expect(calls[2]?.values).toEqual([TARGET]);
      expect(calls[3]?.values).toEqual([TARGET, 25, 0]);
      expect(calls[3]?.text).toContain("WHERE assignment.account_id = $1");

      // Reads do not spend the assertion: the Hub reads here and grants with the same one.
      expect(calls.some((call) => call.text.includes("auth_actor_assertions"))).toBe(false);
      // But a read that is neither spent nor rate limited must still leave a trace, tied to the
      // assertion that made it, or a run of lookups is indistinguishable from enumeration.
      const audit = calls.find((call) => call.text.includes("access_audit_events"));
      expect(audit?.text).toContain("role.account.lookup");
      expect(audit?.values?.[1]).toBe(ACTOR);
      expect(audit?.values?.[2]).toBe(TARGET);
      expect(String(audit?.values?.[3])).toContain("target-sub");
      await instance.close();
    });

    it("never returns the person's identity, even when the row it reads carries it", async () => {
      // The row is deliberately fatter than the handler needs. A handler that spread it, or that
      // added a field later, fails here; a mock returning only the wanted columns could not tell.
      const { pool } = lookupPool({
        target: {
          accountId: TARGET, principalType: "EMPLOYEE", status: "active", employeeStatus: "active",
          email: "target@example.test", fullName: "Nama Lengkap Target",
          identityNumber: "3201234567890001",
        },
        total: 0, assignments: [],
      });
      const instance = lookupApp(pool);
      const response = await instance.inject({ method: "GET", url: `${URL}?${WHO}`, headers });

      expect(response.statusCode).toBe(200);
      for (const leaked of ["target@example.test", "Nama Lengkap Target", "3201234567890001"]) {
        expect(response.body).not.toContain(leaked);
      }
      // Employment status itself is not exported either; only whether a grant would be refused.
      expect(Object.keys(response.json().account).sort())
        .toEqual(["accountId", "grantable", "notGrantableReason"]);
      await instance.close();
    });

    it("says why a grant would be refused without saying more than that", async () => {
      for (const [target, reason] of [
        [{ accountId: TARGET, principalType: "EMPLOYEE", status: "disabled", employeeStatus: "active" }, "account_inactive"],
        [{ accountId: TARGET, principalType: "EMPLOYEE", status: "active", employeeStatus: "resigned" }, "employee_inactive"],
      ] as const) {
        const { pool } = lookupPool({ target, total: 0, assignments: [] });
        const instance = lookupApp(pool);
        const response = await instance.inject({ method: "GET", url: `${URL}?${WHO}`, headers });
        expect(response.json().account).toEqual({
          accountId: TARGET, grantable: false, notGrantableReason: reason,
        });
        await instance.close();
      }
    });

    it("hides accounts this channel may not grant to behind the same 404 as an unknown subject", async () => {
      // 403 here would answer "that subject holds a privileged account", which is precisely what
      // an attacker enumerating subjects wants to learn.
      for (const target of [
        null,
        { accountId: TARGET, principalType: "SUPER_ADMIN", status: "active", employeeStatus: null },
        { accountId: TARGET, principalType: "FOUNDATION_BOARD", status: "active", employeeStatus: null },
      ]) {
        const { pool } = lookupPool({ target });
        const instance = lookupApp(pool);
        const response = await instance.inject({ method: "GET", url: `${URL}?${WHO}`, headers });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ code: "ROLE_ADMIN_ACCOUNT_NOT_FOUND" });
        await instance.close();
      }
    });

    it("refuses an actor who is not a valid grantor, as the mutating routes already do", async () => {
      const { pool, calls } = lookupPool({
        actor: {
          id: ACTOR, email: "board@example.test", principalType: "FOUNDATION_BOARD",
          accountStatus: "active", employeeStatus: null,
        },
      });
      const instance = lookupApp(pool);
      const response = await instance.inject({ method: "GET", url: `${URL}?${WHO}`, headers });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("ROLE_GRANT_ACTOR_INVALID");
      // Refused before it reads anything about the target.
      expect(calls).toHaveLength(1);
      await instance.close();
    });

    it("pages the way ENG-LIST-001 requires, including past the end", async () => {
      const second = lookupPool({
        total: 30,
        assignments: [assignmentRow("human_capital", ["employees.read.unit"], "00000000-0000-4000-8000-00000000001e")],
      });
      let instance = lookupApp(second.pool);
      let response = await instance.inject({ method: "GET", url: `${URL}?${WHO}&page=2&pageSize=10`, headers });
      expect(response.json().assignments.pagination)
        .toEqual({ page: 2, pageSize: 10, total: 30, pageCount: 3 });
      expect(second.calls[3]?.values).toEqual([TARGET, 10, 10]);
      // Stable order needs a unique tie-breaker, or page 2 can repeat a row from page 1.
      expect(second.calls[3]?.text).toContain("ORDER BY assignment.created_at DESC, assignment.id");
      await instance.close();

      // Past the end is an empty page with honest numbers, not an error.
      const beyond = lookupPool({ total: 3, assignments: [] });
      instance = lookupApp(beyond.pool);
      response = await instance.inject({ method: "GET", url: `${URL}?${WHO}&page=9&pageSize=25`, headers });
      expect(response.statusCode).toBe(200);
      expect(response.json().assignments.items).toEqual([]);
      expect(response.json().assignments.pagination)
        .toEqual({ page: 9, pageSize: 25, total: 3, pageCount: 1 });
      await instance.close();
    });

    it("refuses a missing subject and a page size beyond the ENG-LIST-001 maximum", async () => {
      // A fresh pool per case: lookupPool answers by call order, so reusing one across requests
      // would starve the actor lookup on the second and answer 403 for the wrong reason.
      for (const query of ["issuer=i", `${WHO}&pageSize=101`, `${WHO}&page=0`]) {
        const { pool } = lookupPool();
        const instance = lookupApp(pool);
        const response = await instance.inject({ method: "GET", url: `${URL}?${query}`, headers });
        // Out of range fails rather than being clamped, so the Hub never silently pages wrongly.
        expect(response.statusCode, query).toBe(400);
        expect(response.json()).toEqual({ code: "INVALID_REQUEST" });
        await instance.close();
      }
    });
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
