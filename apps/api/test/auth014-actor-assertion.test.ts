import { randomUUID } from "node:crypto";

import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from "jose";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  ActorAssertionError,
  createActorAssertionVerifier,
  resolveAssertedActor,
} from "../src/modules/auth/actor-assertion.js";

const ISSUER = "https://identity.example.test/realms/sq-staff";
const AUDIENCE = "hcis-role-administration-actor";
const MACHINE_CLIENTS = new Set(["sq-hub-role-administration", "sq-hub-identity-management"]);

let privateKey: KeyLike;
let publicJwk: JWK;
const originalFetch = globalThis.fetch;

/**
 * AUTH-014 §2.2/§2.4. These sign real assertions with a real key and let the verifier fetch the
 * JWKS, so issuer, audience, age and the machine-token checks are exercised rather than stubbed.
 */
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), alg: "RS256", kid: "test-key", use: "sig" };

  globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (href === `${ISSUER}/protocol/openid-connect/certs`) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
});

afterAll(() => { globalThis.fetch = originalFetch; });

function verifier(maxAgeSeconds = 60) {
  return createActorAssertionVerifier({
    issuer: ISSUER, audience: AUDIENCE, maxAgeSeconds, machineClients: MACHINE_CLIENTS,
  });
}

async function sign(claims: Record<string, unknown>, options: {
  issuer?: string; audience?: string; issuedAt?: number;
} = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ jti: randomUUID(), ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuedAt(options.issuedAt ?? now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);
}

describe("AUTH-014 actor assertion verification", () => {
  it("accepts an assertion for a person", async () => {
    const assertion = await sign({ sub: "person-sub", azp: "sq-hub", preferred_username: "owner" });
    await expect(verifier()(assertion)).resolves.toMatchObject({ issuer: ISSUER, subject: "person-sub" });
  });

  it("refuses a wrong issuer and a wrong audience", async () => {
    for (const options of [{ issuer: "https://identity.example.test/realms/other" }, { audience: "hcis-role-administration" }]) {
      const assertion = await sign({ sub: "person-sub" }, options);
      await expect(verifier()(assertion)).rejects.toMatchObject({ code: "ACTOR_ASSERTION_INVALID" });
    }
  });

  it("refuses an assertion older than the maximum age, even before it expires", async () => {
    const assertion = await sign({ sub: "person-sub" }, { issuedAt: Math.floor(Date.now() / 1000) - 600 });
    await expect(verifier(60)(assertion)).rejects.toMatchObject({ code: "ACTOR_ASSERTION_INVALID" });
  });

  it("refuses an assertion with no subject", async () => {
    const assertion = await sign({ azp: "sq-hub" });
    await expect(verifier()(assertion)).rejects.toMatchObject({ code: "ACTOR_ASSERTION_INVALID" });
  });

  it("refuses a service-account token even though azp and sub differ", async () => {
    // Keycloak gives a client-credentials token azp = clientId and sub = the service-account user
    // id, so comparing the two would never catch it. Both real signals are tested here.
    const byClient = await sign({
      sub: "service-account-uuid", azp: "sq-hub-identity-management",
      preferred_username: "service-account-sq-hub-identity-management",
    });
    await expect(verifier()(byClient)).rejects.toMatchObject({ code: "ACTOR_ASSERTION_INVALID" });

    const byUsername = await sign({
      sub: "service-account-uuid", azp: "some-other-client",
      preferred_username: "service-account-some-other-client",
    });
    await expect(verifier()(byUsername)).rejects.toMatchObject({ code: "ACTOR_ASSERTION_INVALID" });
  });

  it("refuses the exact token the Keycloak probe minted from the machine client", async () => {
    // 2026-10-31: the K-4 probe proved sq-hub-role-administration can mint a token whose audience
    // is hcis-role-administration-actor, from its own machine token, with no human involved. The
    // optional-scope split does not stop that, because the same client may request its own
    // optional scope. This is the token that attack produces; it must be refused here, and it is
    // refused on two independent grounds.
    const minted = await sign({
      sub: "4f0b1d3e-service-account-uuid",
      azp: "sq-hub-role-administration",
      preferred_username: "service-account-sq-hub-role-administration",
    });
    await expect(verifier()(minted)).rejects.toMatchObject({ code: "ACTOR_ASSERTION_INVALID" });

    // Ground 1 alone: the issuing client is a known machine client, even without the username.
    const byClientOnly = await sign({
      sub: "4f0b1d3e-service-account-uuid",
      azp: "sq-hub-role-administration",
    });
    await expect(verifier()(byClientOnly)).rejects.toMatchObject({ code: "ACTOR_ASSERTION_INVALID" });

    // Ground 2 alone: a machine client this deployment has not listed still carries the
    // service-account username convention. This is the one that survives a misconfigured allowlist.
    const byUsernameOnly = await sign({
      sub: "4f0b1d3e-service-account-uuid",
      azp: "some-client-nobody-listed",
      preferred_username: "service-account-some-client-nobody-listed",
    });
    await expect(verifier()(byUsernameOnly)).rejects.toMatchObject({ code: "ACTOR_ASSERTION_INVALID" });
  });

  it("refuses a tampered signature", async () => {
    const assertion = await sign({ sub: "person-sub" });
    await expect(verifier()(`${assertion.slice(0, -4)}AAAA`)).rejects.toBeInstanceOf(ActorAssertionError);
  });
});

describe("AUTH-014 asserted actor resolution", () => {
  const claims = { issuer: ISSUER, subject: "person-sub" };

  function poolReturning(rows: unknown[]): Pool {
    return { query: async () => ({ rowCount: rows.length, rows }) } as unknown as Pool;
  }

  it("resolves exactly one active employee account", async () => {
    const pool = poolReturning([{
      id: "00000000-0000-4000-8000-000000000001", email: "owner@example.test",
      principalType: "EMPLOYEE", accountStatus: "active", employeeStatus: "active",
    }]);
    await expect(resolveAssertedActor(pool, claims)).resolves.toEqual({
      id: "00000000-0000-4000-8000-000000000001", email: "owner@example.test", principalType: "EMPLOYEE",
    });
  });

  it("fails closed on every branch", async () => {
    const cases: Array<[string, unknown[]]> = [
      ["no account for that subject", []],
      ["inactive account", [{
        id: "x", email: "a@b.test", principalType: "EMPLOYEE",
        accountStatus: "inactive", employeeStatus: "active",
      }]],
      ["active account whose employee has left", [{
        id: "x", email: "a@b.test", principalType: "EMPLOYEE",
        accountStatus: "active", employeeStatus: "resigned",
      }]],
    ];
    for (const [, rows] of cases) {
      await expect(resolveAssertedActor(poolReturning(rows), claims))
        .rejects.toMatchObject({ code: "ACTOR_UNRESOLVED" });
    }
  });

  it("matches only on issuer and subject, never on email or name", async () => {
    const query = vi.fn(async () => ({ rowCount: 0, rows: [] }));
    await expect(resolveAssertedActor({ query } as unknown as Pool, claims)).rejects.toBeInstanceOf(ActorAssertionError);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("identity_issuer");
    expect(sql).toContain("identity_subject");
    expect(sql).not.toContain("email =");
    expect(sql).not.toContain("full_name");
    expect(params).toEqual([ISSUER, "person-sub"]);
  });
});
