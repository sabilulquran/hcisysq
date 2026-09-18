import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "../migrations");
const recovered = new Set([
  "0020_organization_revisions_and_account_holders.sql",
  "0021_multiple_structural_positions.sql",
  "0022_employee_master_lifecycle_and_source_snapshots.sql",
  "0023_leave_approval_principals.sql",
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function applyAndRecord(client, file) {
  const sql = await readFile(join(migrationsDir, file), "utf8");
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw new Error(`migration ${file} failed during organization recovery rehearsal`, { cause: error });
  }
}

async function runMigrationFiles(client, files) {
  await ensureMigrationTable(client);
  const appliedRows = await client.query("SELECT name FROM schema_migrations");
  const applied = new Set(appliedRows.rows.map((row) => row.name));
  const appliedNow = [];
  const skipped = [];
  for (const file of files) {
    if (applied.has(file)) {
      skipped.push(file);
      continue;
    }
    await applyAndRecord(client, file);
    applied.add(file);
    appliedNow.push(file);
  }
  return { appliedNow, skipped };
}

async function indexNames(client, schemaName) {
  const result = await client.query(
    `SELECT indexname
     FROM pg_indexes
     WHERE schemaname = $1 AND tablename = 'organization_change_sets'
     ORDER BY indexname`,
    [schemaName],
  );
  return new Set(result.rows.map((row) => row.indexname));
}

async function assertRevisionIndexContract(client, schemaName) {
  const indexes = await indexNames(client, schemaName);
  assert(
    indexes.has("organization_change_sets_effective_revision_idx"),
    "Final revision index organization_change_sets_effective_revision_idx is missing",
  );
  assert(
    !indexes.has("organization_change_sets_one_published_date_idx"),
    "Obsolete one-published-date unique index is still present",
  );
}

async function insertSyntheticIdentity(client, label) {
  const employeeId = randomUUID();
  const accountId = randomUUID();
  await client.query(
    `INSERT INTO employees (id, employee_number, full_name, status)
     VALUES ($1, $2, $3, 'active')`,
    [employeeId, `${label}-EMP`, `${label} Synthetic Employee`],
  );
  await client.query(
    `INSERT INTO accounts (id, employee_id, email, principal_type, status)
     VALUES ($1, $2, $3, 'EMPLOYEE', 'active')`,
    [accountId, employeeId, `${label.toLowerCase()}@example.invalid`],
  );
  return { employeeId, accountId };
}

async function assertSameDatePublishedRevisionsAllowed(client, actorAccountId, label) {
  const effectiveOn = "2031-01-15";
  const firstId = randomUUID();
  const secondId = randomUUID();
  await client.query(
    `INSERT INTO organization_change_sets (
       id, name, effective_on, status, created_by_account_id,
       validated_at, published_at
     ) VALUES
       ($1, $3, $4::date, 'PUBLISHED', $5, now(), now() - interval '1 second'),
       ($2, $6, $4::date, 'PUBLISHED', $5, now(), now())`,
    [firstId, secondId, `${label} revision 1`, effectiveOn, actorAccountId, `${label} revision 2`],
  );
  const result = await client.query(
    `SELECT count(*)::int AS count
     FROM organization_change_sets
     WHERE effective_on = $1::date AND status = 'PUBLISHED' AND id = ANY($2::uuid[])`,
    [effectiveOn, [firstId, secondId]],
  );
  assert(result.rows[0]?.count === 2, "Final schema did not permit two published revisions on one effective date");
}

async function createSchema(client, label) {
  const schemaName = `${label}_${randomUUID().replaceAll("-", "")}`;
  await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
  await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);
  return schemaName;
}

async function dropSchema(client, schemaName) {
  await client.query("SET search_path TO public");
  await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
}

async function snapshotCounts(client) {
  const result = await client.query(
    `SELECT
       (SELECT count(*)::int FROM organization_change_sets) AS change_sets,
       (SELECT count(*)::int FROM organization_nodes) AS nodes,
       (SELECT count(*)::int FROM organization_positions) AS positions,
       (SELECT count(*)::int FROM organization_memberships) AS memberships,
       (SELECT count(*)::int FROM organization_incumbencies) AS incumbencies,
       (SELECT count(*)::int FROM organization_authority_bindings) AS bindings,
       (SELECT count(*)::int FROM organization_rollout_settings) AS rollout,
       (SELECT count(*)::int FROM leave_request_approval_steps) AS approval_steps`,
  );
  return result.rows[0];
}

function assertCountsEqual(before, after, label) {
  for (const key of Object.keys(before)) {
    assert(before[key] === after[key], `${label} changed row count ${key}: before=${before[key]} after=${after[key]}`);
  }
}

async function freshAndHistoryShapedScenario(client, files) {
  const schemaName = await createSchema(client, "org_recovery_fresh");
  try {
    const firstRun = await runMigrationFiles(client, files);
    assert(firstRun.appliedNow.length === files.length, "Fresh rehearsal did not apply every migration");
    for (const file of recovered) {
      assert(firstRun.appliedNow.includes(file), `Fresh rehearsal did not apply recovered migration ${file}`);
    }

    await assertRevisionIndexContract(client, schemaName);
    const identity = await insertSyntheticIdentity(client, "RECOVERY-FRESH");
    await assertSameDatePublishedRevisionsAllowed(client, identity.accountId, "fresh");

    const protectedRowsBefore = await client.query(
      `SELECT name, applied_at::text AS applied_at
       FROM schema_migrations
       WHERE name = ANY($1::text[])
       ORDER BY name`,
      [[...recovered]],
    );
    assert(protectedRowsBefore.rows.length === recovered.size, "Fresh schema did not record all recovered migration filenames");

    const countsBefore = await snapshotCounts(client);
    const rerun = await runMigrationFiles(client, files);
    assert(rerun.appliedNow.length === 0, "Migration runner reapplied files that were already recorded");
    for (const file of recovered) {
      assert(rerun.skipped.includes(file), `History-shaped rerun did not skip recovered migration ${file}`);
    }
    const countsAfter = await snapshotCounts(client);
    assertCountsEqual(countsBefore, countsAfter, "History-shaped rerun");

    const protectedRowsAfter = await client.query(
      `SELECT name, applied_at::text AS applied_at
       FROM schema_migrations
       WHERE name = ANY($1::text[])
       ORDER BY name`,
      [[...recovered]],
    );
    assert(
      JSON.stringify(protectedRowsAfter.rows) === JSON.stringify(protectedRowsBefore.rows),
      "History-shaped rerun changed recorded recovered migration history",
    );

    process.stdout.write(
      `Fresh install + production-history-shaped skip rehearsal passed in schema ${schemaName}\n`,
    );
  } finally {
    await dropSchema(client, schemaName);
  }
}

async function seedCanonicalOrganizationState(client) {
  const identity = await insertSyntheticIdentity(client, "RECOVERY-UPGRADE");
  const unitId = randomUUID();
  const legacyPositionId = randomUUID();
  const requestId = randomUUID();
  const stepId = randomUUID();
  const changeSetId = randomUUID();
  const nodeKey = randomUUID();
  const nodeRowId = randomUUID();
  const structuralPositionKey = randomUUID();
  const structuralPositionRowId = randomUUID();
  const membershipId = randomUUID();
  const incumbencyId = randomUUID();
  const bindingId = randomUUID();

  await client.query(
    `INSERT INTO organizational_units (id, normalized_name, name)
     VALUES ($1, 'migration recovery unit', 'Migration Recovery Unit')`,
    [unitId],
  );
  await client.query(
    `INSERT INTO positions (id, normalized_name, name)
     VALUES ($1, 'migration recovery position', 'Migration Recovery Position')`,
    [legacyPositionId],
  );
  await client.query(
    `UPDATE employees
     SET organizational_unit_id = $2, position_id = $3
     WHERE id = $1`,
    [identity.employeeId, unitId, legacyPositionId],
  );

  await client.query(
    `INSERT INTO leave_requests (
       id, employee_id, policy_key, status, start_on, end_on, working_days,
       reason, annual_period_key, annual_entitlement_days, annual_period_limit_days,
       annual_available_before, hc_handling, idempotency_key, validation_summary
     ) VALUES (
       $1, $2, 'annual', 'in_review', DATE '2030-02-01', DATE '2030-02-01', 1,
       'Synthetic recovery rehearsal', 'JAN_MAR', 12, 3, 3,
       'notify', 'migration-recovery-upgrade', '{"source":"synthetic-recovery"}'::jsonb
     )`,
    [requestId, identity.employeeId],
  );
  await client.query(
    `INSERT INTO leave_request_approval_steps (
       id, leave_request_id, step_order, approver_employee_id, sources, status
     ) VALUES ($1, $2, 1, $3, ARRAY['DIRECT_MANAGER'], 'pending')`,
    [stepId, requestId, identity.employeeId],
  );

  await client.query(
    `INSERT INTO organization_change_sets (
       id, name, effective_on, status, created_by_account_id,
       validated_at, published_at
     ) VALUES ($1, 'Synthetic canonical snapshot', DATE '2030-01-01', 'PUBLISHED', $2, now(), now())`,
    [changeSetId, identity.accountId],
  );
  await client.query(
    `INSERT INTO organization_nodes (
       id, change_set_id, stable_key, name, node_type, parent_node_key,
       active, effective_from, effective_to, visual_rank_offset
     ) VALUES ($1, $2, $3, 'Synthetic Node', 'UNIT', NULL, true, DATE '2030-01-01', NULL, 0)`,
    [nodeRowId, changeSetId, nodeKey],
  );
  await client.query(
    `INSERT INTO organization_positions (
       id, change_set_id, stable_key, node_key, title, parent_position_key,
       single_incumbent, vacancy_policy, active, effective_from, effective_to, visual_rank_offset
     ) VALUES ($1, $2, $3, $4, 'Synthetic Structural Position', NULL, true,
       'CLIMB_TO_PARENT', true, DATE '2030-01-01', NULL, 0)`,
    [structuralPositionRowId, changeSetId, structuralPositionKey, nodeKey],
  );
  await client.query(
    `INSERT INTO organization_memberships (
       id, change_set_id, employee_id, node_key, job_profile_key,
       is_primary, effective_from, effective_to
     ) VALUES ($1, $2, $3, $4, NULL, true, DATE '2030-01-01', NULL)`,
    [membershipId, changeSetId, identity.employeeId, nodeKey],
  );
  await client.query(
    `INSERT INTO organization_incumbencies (
       id, change_set_id, position_key, employee_id, kind,
       effective_from, effective_to, reason
     ) VALUES ($1, $2, $3, $4, 'PRIMARY', DATE '2030-01-01', NULL, NULL)`,
    [incumbencyId, changeSetId, structuralPositionKey, identity.employeeId],
  );
  await client.query(
    `INSERT INTO organization_authority_bindings (
       id, change_set_id, subject_kind, subject_key, binding_type,
       target_position_key, vacancy_policy, effective_from, effective_to
     ) VALUES ($1, $2, 'NODE', $3, 'LEADER', $4, 'CLIMB_TO_PARENT', DATE '2030-01-01', NULL)`,
    [bindingId, changeSetId, nodeKey, structuralPositionKey],
  );

  return { ...identity, requestId, stepId, changeSetId, structuralPositionKey, incumbencyId };
}

async function canonicalUpgradeScenario(client, files) {
  const schemaName = await createSchema(client, "org_recovery_upgrade");
  try {
    const canonicalFiles = files.filter((file) => !recovered.has(file));
    const initial = await runMigrationFiles(client, canonicalFiles);
    assert(
      initial.appliedNow.length === canonicalFiles.length,
      "Pre-recovery canonical fixture did not apply every canonical migration",
    );
    for (const file of recovered) {
      assert(!initial.appliedNow.includes(file), `Pre-recovery fixture unexpectedly included ${file}`);
    }

    const seeded = await seedCanonicalOrganizationState(client);
    const countsBefore = await snapshotCounts(client);

    for (const file of [...recovered].sort()) {
      await applyAndRecord(client, file);
    }

    const countsAfter = await snapshotCounts(client);
    assertCountsEqual(countsBefore, countsAfter, "Recovered migration sequence");

    const preserved = await client.query(
      `SELECT
         (SELECT approver_employee_id = $1 AND approver_account_id IS NULL
          FROM leave_request_approval_steps WHERE id = $2) AS approval_principal_preserved,
         (SELECT holder_source = 'EMPLOYEE'
          FROM organization_positions WHERE stable_key = $3) AS holder_default_preserved,
         (SELECT employee_id = $1 AND account_id IS NULL AND is_primary_structural = false
          FROM organization_incumbencies WHERE id = $4) AS incumbency_preserved,
         (SELECT removed_at IS NULL FROM employees WHERE id = $1) AS employee_lifecycle_preserved,
         (SELECT count(*)::int FROM organization_rollout_settings) AS rollout_count`,
      [seeded.employeeId, seeded.stepId, seeded.structuralPositionKey, seeded.incumbencyId],
    );
    const row = preserved.rows[0];
    assert(row?.approval_principal_preserved === true, "Recovered Leave principal migration rewrote an employee approval snapshot");
    assert(row?.holder_default_preserved === true, "Recovered holder-source migration changed an existing employee-held position");
    assert(row?.incumbency_preserved === true, "Recovered multi-position migration rewrote an existing incumbency");
    assert(row?.employee_lifecycle_preserved === true, "Recovered employee lifecycle migration removed an existing employee");
    assert(row?.rollout_count === 0, "Recovered migrations unexpectedly activated organization rollout");

    const sourceSnapshotTable = await client.query(
      "SELECT to_regclass('employee_import_source_snapshots')::text AS table_name",
    );
    assert(
      typeof sourceSnapshotTable.rows[0]?.table_name === "string",
      "Recovered employee source-snapshot table is missing",
    );

    await assertRevisionIndexContract(client, schemaName);
    await assertSameDatePublishedRevisionsAllowed(client, seeded.accountId, "upgrade");

    const recorded = await client.query(
      "SELECT count(*)::int AS count FROM schema_migrations WHERE name = ANY($1::text[])",
      [[...recovered]],
    );
    assert(recorded.rows[0]?.count === recovered.size, "Recovered migration filenames were not recorded exactly");

    process.stdout.write(
      `Pre-recovery canonical -> recovered migration sequence rehearsal passed in schema ${schemaName}\n`,
    );
  } finally {
    await dropSchema(client, schemaName);
  }
}

const client = new Client({ connectionString: databaseUrl });
await client.connect();

try {
  const files = (await readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const file of recovered) {
    assert(files.includes(file), `Recovered migration missing from source: ${file}`);
  }

  const expectedWindow = files.filter((name) => name >= "0019_" && name < "0025_");
  const exactWindow = [
    "0019_dynamic_organization.sql",
    "0020_hub_oidc_identity_mapping.sql",
    "0020_organization_revisions_and_account_holders.sql",
    "0021_attendance_adms_ingress.sql",
    "0021_multiple_structural_positions.sql",
    "0022_attendance_adms_projection.sql",
    "0022_employee_master_lifecycle_and_source_snapshots.sql",
    "0023_attendance_adms_admin.sql",
    "0023_leave_approval_principals.sql",
    "0024_attendance_adms_transport_recovery.sql",
  ];
  assert(
    JSON.stringify(expectedWindow) === JSON.stringify(exactWindow),
    `Unexpected lexical migration order 0019-0024: ${expectedWindow.join(", ")}`,
  );

  await freshAndHistoryShapedScenario(client, files);
  await canonicalUpgradeScenario(client, files);

  process.stdout.write("Organization production migration recovery rehearsal passed.\n");
} finally {
  await client.end();
}
