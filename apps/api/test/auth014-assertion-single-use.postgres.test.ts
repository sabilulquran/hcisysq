import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ActorAssertionError,
  spendActorAssertion,
  type ActorAssertionClaims,
} from "../src/modules/auth/actor-assertion.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

const ISSUER = "https://identity.example.test/realms/sq-staff";

function claims(jti = randomUUID(), secondsAhead = 60): ActorAssertionClaims {
  return {
    issuer: ISSUER, subject: "person-sub", jti,
    expiresAt: new Date(Date.now() + secondsAhead * 1000),
  };
}

const binding = {
  method: "POST",
  path: "/internal/v1/role-administration/accounts/00000000-0000-4000-8000-00000000000a/role-assignments",
};

// AUTH-014 §2.11 gap 1, against the real table. Synthetic rows only, rolled back.
describe.skipIf(!allowed)("AUTH-014 actor assertion is spendable once (PostgreSQL)", () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("DELETE FROM auth_actor_assertions");
  });

  /**
   * A refused spend raises 23505, which aborts the surrounding transaction — and this whole file
   * runs in one, so the next statement would fail with 25P02 instead of the error being tested.
   * The savepoint keeps each expected failure local. Production never needs this: there
   * `spendActorAssertion` runs on the autocommit pool, so every statement stands alone.
   */
  async function expectRefused(run: () => Promise<unknown>) {
    await client.query("SAVEPOINT spend_attempt");
    try {
      await run();
      throw new Error("expected the assertion to be refused");
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT spend_attempt");
      return error;
    } finally {
      await client.query("RELEASE SAVEPOINT spend_attempt");
    }
  }

  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  it("accepts an assertion once and refuses the same jti afterwards", async () => {
    const first = claims();
    await spendActorAssertion(client, first, { ...binding, hubRequestId: randomUUID() });

    const second = await expectRefused(() => spendActorAssertion(client, first, binding));
    expect(second).toBeInstanceOf(ActorAssertionError);
    expect(second).toMatchObject({ code: "ACTOR_ASSERTION_SPENT" });

    // Still refused on a third try: the row is the state, not a one-shot flag in memory.
    const third = await expectRefused(() => spendActorAssertion(client, first, binding));
    expect(third).toMatchObject({ code: "ACTOR_ASSERTION_SPENT" });
  });

  it("refuses a replay aimed at a different request, which is the whole point", async () => {
    // The captured assertion is worthless even when the attacker picks a fresh requestId and a
    // different target account — the (hub_request_id, action) index would not have stopped that.
    const captured = claims();
    await spendActorAssertion(client, captured, { ...binding, hubRequestId: randomUUID() });

    const refused = await expectRefused(() => spendActorAssertion(client, captured, {
      method: "DELETE",
      path: "/internal/v1/role-administration/role-assignments/00000000-0000-4000-8000-00000000000b",
      hubRequestId: randomUUID(),
    }));
    expect(refused).toMatchObject({ code: "ACTOR_ASSERTION_SPENT" });
  });

  it("records what the assertion was spent on, so a race leaves a trace", async () => {
    const hubRequestId = randomUUID();
    const spent = claims();
    await spendActorAssertion(client, spent, { ...binding, hubRequestId });

    const row = await client.query<{
      requestMethod: string; requestPath: string; hubRequestId: string | null;
    }>(
      `SELECT request_method AS "requestMethod", request_path AS "requestPath",
              hub_request_id AS "hubRequestId"
         FROM auth_actor_assertions WHERE issuer = $1 AND jti = $2`,
      [ISSUER, spent.jti],
    );
    expect(row.rows[0]).toEqual({
      requestMethod: "POST", requestPath: binding.path, hubRequestId,
    });
  });

  it("lets a different jti through, so ordinary work is unaffected", async () => {
    await spendActorAssertion(client, claims(), binding);
    await expect(spendActorAssertion(client, claims(), binding)).resolves.toBeUndefined();
  });

  it("separates jti by issuer", async () => {
    const shared = randomUUID();
    await spendActorAssertion(client, claims(shared), binding);
    await expect(spendActorAssertion(client, {
      ...claims(shared), issuer: "https://identity.example.test/realms/other",
    }, binding)).resolves.toBeUndefined();
  });

  it("sweeps expired rows instead of growing without bound", async () => {
    // Well past the sweep's clock-skew margin, not merely past its own expiry.
    const stale = claims(randomUUID(), -3600);
    await client.query(
      `INSERT INTO auth_actor_assertions (issuer, jti, expires_at, request_method, request_path)
       VALUES ($1, $2, $3, 'POST', $4)`,
      [stale.issuer, stale.jti, stale.expiresAt, binding.path],
    );

    await spendActorAssertion(client, claims(), binding);

    const remaining = await client.query<{ jti: string }>(
      "SELECT jti FROM auth_actor_assertions ORDER BY spent_at",
    );
    expect(remaining.rows.map((row) => row.jti)).not.toContain(stale.jti);

    // And an expired jti can be spent again — it could not be presented anyway, because the
    // verifier refuses an assertion past its age long before it reaches this table.
    await expect(spendActorAssertion(client, stale, binding)).resolves.toBeUndefined();
  });
});
