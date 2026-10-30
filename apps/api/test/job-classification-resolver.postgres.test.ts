// ORG-011 Package 2: the resolver PAY-003 will consume.
// Synthetic employees and catalog entries only; each test rolls back.

import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { JobClassificationError } from "../src/modules/organization/job-classification-service.js";
import { resolveJobClassifications } from "../src/modules/organization/job-classification-resolver.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

describe.skipIf(!allowed)("ORG-011 classification resolver", () => {
  let pool: Pool;
  let client: PoolClient;
  let employmentId: string;
  let employeeId: string;
  let accountId: string;
  let changeSetId: string;
  let nodeKey: string;
  let suffix: string;

  const code = (name: string) => `${name}_${suffix}`;

  async function addClassification(
    value: string, family: "FUNCTIONAL" | "STRUCTURAL" | "SUPPORT", from = "2026-01-01", to: string | null = null,
  ) {
    await client.query(
      `INSERT INTO job_classifications (id, code, name, family, effective_from, effective_to)
       VALUES ($1,$2,$3,$4,$5::date,$6::date)`,
      [randomUUID(), value, `Nama ${value}`, family, from, to],
    );
  }

  /** A seat in the published structure, optionally carrying a default classification. */
  async function addPosition(classificationCode: string | null): Promise<string> {
    const positionKey = randomUUID();
    await client.query(
      `INSERT INTO organization_positions
         (id, change_set_id, stable_key, node_key, title, effective_from, job_classification_code)
       VALUES ($1,$2,$3,$4,$5,'2026-01-01'::date,$6)`,
      [randomUUID(), changeSetId, positionKey, nodeKey, "Kursi sintetis", classificationCode],
    );
    return positionKey;
  }

  async function addPlacement(
    kind: "PRIMARY" | "ADDITIONAL", positionKey: string | null, classificationCode: string | null,
  ) {
    const actionId = randomUUID();
    await client.query(
      `INSERT INTO employment_actions (id, employment_id, action_type, effective_from, recorded_by_account_id)
       VALUES ($1,$2,'PLACEMENT','2026-01-01'::date,$3)`,
      [actionId, employmentId, accountId],
    );
    await client.query(
      `INSERT INTO employment_placements
         (id, employment_id, kind, org_node_key, org_position_key, job_title_label,
          effective_from, effective_from_basis, opened_by_action_id, job_classification_code)
       VALUES ($1,$2,$3,$4,$5,$6,'2026-01-01'::date,'RECORDED',$7,$8)`,
      [randomUUID(), employmentId, kind, nodeKey, positionKey, "Jabatan sintetis", actionId, classificationCode],
    );
  }

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    suffix = randomUUID().slice(0, 8).toUpperCase().replace(/[^A-Z0-9]/g, "X");

    accountId = randomUUID();
    await client.query(
      `INSERT INTO accounts (id, employee_id, email, principal_type, status,
         mfa_secret_ciphertext, mfa_secret_iv, mfa_secret_tag, mfa_enabled_at)
       VALUES ($1, NULL, $2, 'SUPER_ADMIN', 'active', 'synthetic', 'synthetic', 'synthetic', now())`,
      [accountId, `org011r-${accountId}@example.invalid`],
    );
    employeeId = randomUUID();
    await client.query(
      `INSERT INTO employees (id, employee_number, full_name, status)
       VALUES ($1,$2,'Pegawai Sintetis','active')`,
      [employeeId, `ORG011R-${employeeId.slice(0, 8)}`],
    );
    employmentId = randomUUID();
    await client.query(
      `INSERT INTO employments (id, employee_id, status, started_on, started_on_basis)
       VALUES ($1,$2,'ACTIVE','2026-01-01'::date,'RECORDED')`,
      [employmentId, employeeId],
    );

    changeSetId = randomUUID();
    await client.query(
      `INSERT INTO organization_change_sets
         (id, name, effective_on, status, created_by_account_id, validated_at, published_at)
       VALUES ($1,'Struktur sintetis ORG-011','2026-01-01'::date,'PUBLISHED',$2, now(), now())`,
      [changeSetId, accountId],
    );
    nodeKey = randomUUID();
    await client.query(
      `INSERT INTO organization_nodes (id, change_set_id, stable_key, name, node_type, effective_from)
       VALUES ($1,$2,$3,'Unit sintetis','UNIT','2026-01-01'::date)`,
      [randomUUID(), changeSetId, nodeKey],
    );
  });

  afterEach(async () => {
    if (client) { await client.query("ROLLBACK"); client.release(); }
  });

  it("ORG-011-R1: both slots are empty when nothing is bound", async () => {
    await addPlacement("PRIMARY", await addPosition(null), null);
    expect(await resolveJobClassifications(client, employmentId, "2026-06-01"))
      .toEqual({ functional: null, structural: null });
  });

  it("ORG-011-R2: a placement code wins over the seat default", async () => {
    await addClassification(code("FUNC_SEAT"), "FUNCTIONAL");
    await addClassification(code("FUNC_OWN"), "FUNCTIONAL");
    await addPlacement("PRIMARY", await addPosition(code("FUNC_SEAT")), code("FUNC_OWN"));

    const resolved = await resolveJobClassifications(client, employmentId, "2026-06-01");
    expect(resolved.functional).toMatchObject({ code: code("FUNC_OWN"), source: "PLACEMENT" });
    expect(resolved.structural).toBeNull();
  });

  it("ORG-011-R3: the seat default applies when the placement names none", async () => {
    await addClassification(code("FUNC_SEAT"), "FUNCTIONAL");
    await addPlacement("PRIMARY", await addPosition(code("FUNC_SEAT")), null);

    const resolved = await resolveJobClassifications(client, employmentId, "2026-06-01");
    expect(resolved.functional).toMatchObject({ code: code("FUNC_SEAT"), source: "POSITION" });
  });

  it("ORG-011-R4: a structural slot filled from a PRIMARY placement still counts", async () => {
    // This is the rule that keeps the PAY-003 70% concurrency factor unchanged: the slot is
    // what matters, not whether the structural job came from the primary or an extra placement.
    await addClassification(code("STRUCT_HEAD"), "STRUCTURAL");
    await addPlacement("PRIMARY", await addPosition(null), code("STRUCT_HEAD"));

    const resolved = await resolveJobClassifications(client, employmentId, "2026-06-01");
    expect(resolved.structural).toMatchObject({ code: code("STRUCT_HEAD"), source: "PLACEMENT" });
    expect(resolved.functional).toBeNull();
  });

  it("ORG-011-R5: a teacher who also heads a unit fills both slots at once", async () => {
    await addClassification(code("FUNC_TEACH"), "FUNCTIONAL");
    await addClassification(code("STRUCT_HEAD"), "STRUCTURAL");
    await addPlacement("PRIMARY", await addPosition(null), code("FUNC_TEACH"));
    await addPlacement("ADDITIONAL", await addPosition(null), code("STRUCT_HEAD"));

    const resolved = await resolveJobClassifications(client, employmentId, "2026-06-01");
    expect(resolved.functional?.code).toBe(code("FUNC_TEACH"));
    expect(resolved.structural?.code).toBe(code("STRUCT_HEAD"));
  });

  it("ORG-011-R6: SUPPORT fills neither slot", async () => {
    await addClassification(code("SUPPORT_TU"), "SUPPORT");
    await addPlacement("PRIMARY", await addPosition(null), code("SUPPORT_TU"));
    expect(await resolveJobClassifications(client, employmentId, "2026-06-01"))
      .toEqual({ functional: null, structural: null });
  });

  it("ORG-011-R7: two classifications in one slot fail with their own code", async () => {
    await addClassification(code("STRUCT_A"), "STRUCTURAL");
    await addClassification(code("STRUCT_B"), "STRUCTURAL");
    await addPlacement("PRIMARY", await addPosition(null), code("STRUCT_A"));
    await addPlacement("ADDITIONAL", await addPosition(null), code("STRUCT_B"));

    await expect(resolveJobClassifications(client, employmentId, "2026-06-01"))
      .rejects.toMatchObject({ code: "CLASSIFICATION_AMBIGUOUS", statusCode: 409 });
  });

  it("ORG-011-R8: a code that is not in force on the date is an error, not an empty slot", async () => {
    // Resolving it to nothing would quietly drop an allowance the person is entitled to.
    await addClassification(code("FUNC_OLD"), "FUNCTIONAL", "2026-01-01", "2026-03-31");
    await addPlacement("PRIMARY", await addPosition(null), code("FUNC_OLD"));

    expect((await resolveJobClassifications(client, employmentId, "2026-03-01")).functional?.code)
      .toBe(code("FUNC_OLD"));
    await expect(resolveJobClassifications(client, employmentId, "2026-06-01"))
      .rejects.toBeInstanceOf(JobClassificationError);
  });

  it("ORG-011-R9: a voided placement stops resolving", async () => {
    await addClassification(code("FUNC_TEACH"), "FUNCTIONAL");
    await addPlacement("PRIMARY", await addPosition(null), code("FUNC_TEACH"));
    const voidAction = randomUUID();
    await client.query(
      `INSERT INTO employment_actions (id, employment_id, action_type, effective_from, recorded_by_account_id)
       VALUES ($1,$2,'CORRECTION','2026-02-01'::date,$3)`,
      [voidAction, employmentId, accountId],
    );
    await client.query(
      `UPDATE employment_placements SET voided_by_action_id = $2 WHERE employment_id = $1`,
      [employmentId, voidAction],
    );
    expect(await resolveJobClassifications(client, employmentId, "2026-06-01"))
      .toEqual({ functional: null, structural: null });
  });

  it("ORG-011-R10: the seat is read from the structure published for that date", async () => {
    await addClassification(code("FUNC_OLD_SEAT"), "FUNCTIONAL");
    await addClassification(code("FUNC_NEW_SEAT"), "FUNCTIONAL");
    const positionKey = await addPosition(code("FUNC_OLD_SEAT"));
    await addPlacement("PRIMARY", positionKey, null);

    // A later change set re-states the same seat with a different classification.
    const laterChangeSet = randomUUID();
    await client.query(
      `INSERT INTO organization_change_sets
         (id, name, effective_on, status, created_by_account_id, validated_at, published_at)
       VALUES ($1,'Revisi sintetis','2026-07-01'::date,'PUBLISHED',$2, now(), now())`,
      [laterChangeSet, accountId],
    );
    await client.query(
      `INSERT INTO organization_nodes (id, change_set_id, stable_key, name, node_type, effective_from)
       VALUES ($1,$2,$3,'Unit sintetis','UNIT','2026-07-01'::date)`,
      [randomUUID(), laterChangeSet, nodeKey],
    );
    await client.query(
      `INSERT INTO organization_positions
         (id, change_set_id, stable_key, node_key, title, effective_from, job_classification_code)
       VALUES ($1,$2,$3,$4,'Kursi sintetis','2026-07-01'::date,$5)`,
      [randomUUID(), laterChangeSet, positionKey, nodeKey, code("FUNC_NEW_SEAT")],
    );

    // June still resolves against the structure that was published then, which is what makes
    // a past payroll period explainable after a reorganisation.
    expect((await resolveJobClassifications(client, employmentId, "2026-06-01")).functional?.code)
      .toBe(code("FUNC_OLD_SEAT"));
    expect((await resolveJobClassifications(client, employmentId, "2026-08-01")).functional?.code)
      .toBe(code("FUNC_NEW_SEAT"));
  });
});
