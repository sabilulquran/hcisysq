// PAY-003 §7.4 against real PostgreSQL: migration 0157 (PPH21_ANNUAL policy key,
// payroll_tax_identities), the policy lookup and the year loader's SQL. Runs only
// against the loopback CI database; every write happens inside a transaction that
// is rolled back. Synthetic data only.

import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findPph21AnnualPolicy, loadAnnualYear, loadTaxIdentities } from "../src/modules/payroll/pph21-annual-store.js";
import { findPph21Settings } from "../src/modules/payroll/reports.js";
import { sealTaxIdentity } from "../src/modules/payroll/tax-identity.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

const POLICY = {
  source: "Contoh uji",
  ptkp: { taxpayer: 54_000_000, married: 4_500_000, perDependent: 4_500_000, maxDependents: 3 },
  positionCost: { rate: 0.05, monthlyCap: 500_000, annualCap: 6_000_000 },
  brackets: [{ upTo: 60_000_000, rate: 0.05 }, { upTo: null, rate: 0.15 }],
  pkpRoundingUnit: 1000,
};

describe.skipIf(!allowed)("PAY-003 annual PPh21 against PostgreSQL", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl!, max: 2 });
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function inRollback(work: (client: PoolClient) => Promise<void>) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await work(client);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  it("accepts a PPH21_ANNUAL policy row and finds it for the tax year", async () => {
    await inRollback(async (client) => {
      await client.query(
        `INSERT INTO payroll_policy_versions(id, policy_key, effective_from, effective_to, payload, source)
         VALUES ($1, 'PPH21_ANNUAL', DATE '2099-01-01', DATE '2099-12-31', $2::jsonb, 'uji sintetis')`,
        [randomUUID(), JSON.stringify(POLICY)],
      );
      const lookup = await findPph21AnnualPolicy(client as unknown as Pool, 2099);
      expect(lookup.ok).toBe(true);
      if (!lookup.ok) return;
      expect(lookup.policy.pkpRoundingUnit).toBe(1000);
      // A year with no period answers an empty recap, not an error.
      const annual = await loadAnnualYear(client as unknown as Pool, 2099, lookup.policy);
      expect(annual).toEqual({ year: 2099, segments: [], pendingPeriods: [], periodsWithoutTer: [] });
      expect((await findPph21AnnualPolicy(client as unknown as Pool, 2098)).ok).toBe(false);
    });
  });

  it("accepts a PPH21_SETTINGS row (migration 0160) and reads it back as settings", async () => {
    await inRollback(async (client) => {
      await client.query(
        `INSERT INTO payroll_policy_versions(id, policy_key, effective_from, effective_to, payload, source)
         VALUES ($1, 'PPH21_SETTINGS', DATE '2099-01-01', DATE '2099-12-31', $2::jsonb, 'uji sintetis')`,
        [randomUUID(), JSON.stringify({ source: "uji", employerBorne: true })],
      );
      const found = await findPph21Settings(client, "2099-06-25");
      expect(found).toMatchObject({ ok: true, settings: { employerBorne: true, nonPermanentDailyTer: false } });
      // No row: both switches off.
      expect(await findPph21Settings(client, "2098-06-25")).toMatchObject({ ok: true, versionId: null, settings: { employerBorne: false } });
    });
  });

  it("still refuses an unknown policy key", async () => {
    await inRollback(async (client) => {
      await expect(
        client.query(
          `INSERT INTO payroll_policy_versions(id, policy_key, effective_from, payload, source)
           VALUES ($1, 'PPH21_UNKNOWN', DATE '2099-01-01', '{}'::jsonb, 'uji')`,
          [randomUUID()],
        ),
      ).rejects.toThrow(/payroll_policy_versions_policy_key_check/);
    });
  });

  it("stores the identity sealed with its last four digits, and refuses half a pair", async () => {
    await inRollback(async (client) => {
      const employeeId = randomUUID();
      await client.query(
        "INSERT INTO employees(id, employee_number, full_name, status) VALUES ($1, $2, 'Pegawai Pajak Uji', 'active')",
        [employeeId, `EMP-A1-${employeeId.slice(0, 8)}`],
      );
      const sealed = sealTaxIdentity("11".repeat(32), employeeId, "nik", "3209010101900001");
      await client.query(
        "INSERT INTO payroll_tax_identities(employee_id, nik_sealed, nik_last4) VALUES ($1, $2, '0001')",
        [employeeId, sealed],
      );
      const rows = await loadTaxIdentities(client as unknown as Pool, [employeeId]);
      expect(rows.get(employeeId)).toMatchObject({ nikSealed: sealed, nikLast4: "0001", npwpSealed: null });
      await client.query("SAVEPOINT half");
      await expect(
        client.query("UPDATE payroll_tax_identities SET npwp_last4 = '1234' WHERE employee_id = $1", [employeeId]),
      ).rejects.toThrow(/payroll_tax_identities_npwp_pair/);
      await client.query("ROLLBACK TO SAVEPOINT half");
      await expect(
        client.query("UPDATE payroll_tax_identities SET nik_last4 = 'abcd' WHERE employee_id = $1", [employeeId]),
      ).rejects.toThrow();
    });
  });
});
