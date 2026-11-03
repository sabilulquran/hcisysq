// PAY-003-MIG initial load against real PostgreSQL, with synthetic data only.
// Runs only against the loopback CI database.
//
// The policy table is shared with other payroll suites that run in parallel, so
// this suite writes only VARIANCE_THRESHOLD (no other suite owns it) and only on
// dates far after anything they use; the other keys are exercised by dry-run,
// which writes nothing.

import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { openPolicyVersion } from "../src/modules/payroll/admin-store.js";
import {
  InitialLoadRefused,
  MIGRATION_MARKER,
  parseInitialLoadFile,
  positionRef,
  runInitialLoad,
  type InitialLoadReport,
} from "../src/modules/payroll/initial-load.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

const EFFECTIVE = "2091-01-01";
const suffix = randomUUID().slice(0, 8);
const UNIT_A = `Unit Uji Migrasi ${suffix}`;
const UNIT_HALF = `Unit Uji Separuh ${suffix}`;
const NAME_A = `Pegawai Sintetis A ${suffix}`;
const ACCOUNT_A = `99${suffix.replace(/[^0-9]/g, "7").padEnd(8, "7")}01`;

describe.skipIf(!allowed)("PAY-003-MIG initial load against PostgreSQL", () => {
  let pool: Pool;
  const legalEntityKey = randomUUID();
  const nip = { a: `MIG-A-${suffix}`, b: `MIG-B-${suffix}`, noEmployment: `MIG-C-${suffix}`, actor: `MIG-ACT-${suffix}` };
  const ids: Record<string, { employeeId: string; employmentId: string | null }> = {};
  let unitA: string;
  let actorAccountId: string;
  let weakAccountId: string;
  const ownedPeriodIds: string[] = [];
  const ownedRoleIds: string[] = [];

  async function newEmployee(employeeNumber: string, fullName: string, category: string | null) {
    const employeeId = randomUUID();
    const client = await pool.connect();
    await client.query("BEGIN");
    await client.query("INSERT INTO employees(id, employee_number, full_name, status) VALUES ($1, $2, $3, 'active')", [
      employeeId,
      employeeNumber,
      fullName,
    ]);
    let employmentId: string | null = null;
    if (category) {
      employmentId = randomUUID();
      const actionId = randomUUID();
      await client.query(
        `INSERT INTO employments(id, employee_id, legal_entity_key, started_on, start_basis, source, opened_by_action_id)
         VALUES ($1, $2, $3, DATE '2016-07-01', 'RECORDED', 'ACTION', $4)`,
        [employmentId, employeeId, legalEntityKey, actionId],
      );
      await client.query(
        `INSERT INTO employment_actions(id, employee_id, employment_id, action_type, effective_on)
         VALUES ($1, $2, $3, 'BASELINE', DATE '2016-07-01')`,
        [actionId, employeeId, employmentId],
      );
      await client.query(
        `INSERT INTO employment_terms(id, employment_id, sequence, category, effective_from, opened_by_action_id)
         VALUES ($1, $2, 1, $3, DATE '2016-07-01', $4)`,
        [randomUUID(), employmentId, category, actionId],
      );
    }
    await client.query("COMMIT");
    client.release();
    return { employeeId, employmentId };
  }

  async function newAccount(employeeId: string, permissions: string[]) {
    const accountId = randomUUID();
    const roleId = randomUUID();
    ownedRoleIds.push(roleId);
    await pool.query(
      `INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1, $2, $3, 'EMPLOYEE', 'active')`,
      [accountId, employeeId, `mig-${accountId}@example.invalid`],
    );
    await pool.query("INSERT INTO roles(id, role_key, name, is_system) VALUES ($1, $2, 'Peran sintetis PAY-003-MIG', false)", [
      roleId,
      `pay003mig-${roleId}`,
    ]);
    for (const permission of permissions) {
      await pool.query("INSERT INTO role_permissions(role_id, permission_key) VALUES ($1, $2)", [roleId, permission]);
    }
    await pool.query(
      `INSERT INTO account_role_assignments(id, account_id, role_id, scope_type) VALUES ($1, $2, $3, 'organization')`,
      [randomUUID(), accountId, roleId],
    );
    return accountId;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl!, max: 4 });
    unitA = randomUUID();
    await pool.query("INSERT INTO organizational_units(id, normalized_name, name) VALUES ($1, $2, $3), ($4, $5, $6)", [
      unitA,
      UNIT_A.toLowerCase(),
      UNIT_A,
      randomUUID(),
      UNIT_HALF.toLowerCase(),
      UNIT_HALF,
    ]);
    ids.a = await newEmployee(nip.a, NAME_A, "TETAP");
    ids.b = await newEmployee(nip.b, `Pegawai Sintetis B ${suffix}`, "KONTRAK");
    ids.noEmployment = await newEmployee(nip.noEmployment, `Pegawai Sintetis C ${suffix}`, null);
    ids.actor = await newEmployee(nip.actor, `Operator Sintetis ${suffix}`, "TETAP");
    actorAccountId = await newAccount(ids.actor.employeeId, [
      "payroll.policies.manage",
      "payroll.profiles.manage",
      "payroll.loans.manage",
    ]);
    const weak = await newEmployee(`MIG-W-${suffix}`, `Operator Lemah ${suffix}`, null);
    weakAccountId = await newAccount(weak.employeeId, ["payroll.loans.manage"]);
  });

  async function clearOwnRows() {
    const employeeIds = Object.values(ids).map((item) => item.employeeId);
    const employmentIds = Object.values(ids).flatMap((item) => (item.employmentId ? [item.employmentId] : []));
    await pool.query("DELETE FROM payroll_loans WHERE employee_id = ANY($1::uuid[])", [employeeIds]);
    await pool.query("DELETE FROM payroll_compensation_profiles WHERE employment_id = ANY($1::uuid[])", [employmentIds]);
    await pool.query(
      "DELETE FROM payroll_policy_versions WHERE policy_key = 'VARIANCE_THRESHOLD' AND effective_from >= $1::date",
      [EFFECTIVE],
    );
    await pool.query("DELETE FROM payroll_periods WHERE id = ANY($1::uuid[])", [ownedPeriodIds]);
  }

  beforeEach(clearOwnRows);

  afterAll(async () => {
    if (pool) {
      await clearOwnRows();
      // Leave no synthetic account holding payroll permissions behind in the
      // shared database; other suites pick "any account" as their actor.
      await pool.query("DELETE FROM account_role_assignments WHERE role_id = ANY($1::uuid[])", [ownedRoleIds]);
      await pool.query("DELETE FROM role_permissions WHERE role_id = ANY($1::uuid[])", [ownedRoleIds]);
      await pool.query("DELETE FROM roles WHERE id = ANY($1::uuid[])", [ownedRoleIds]);
      await pool.end();
    }
  });

  const varianceRow = {
    rowId: "POL-VAR",
    policyKey: "VARIANCE_THRESHOLD",
    effectiveFrom: EFFECTIVE,
    source: "Uji sintetis PAY-003-MIG",
    payload: { relative: 0.1, absolute: 50_000, manualInput: 1_000_000 },
  };

  const profileA = {
    rowId: "PRF-1",
    nip: nip.a,
    effectiveFrom: EFFECTIVE,
    education: "S1",
    workPattern: null,
    unit: UNIT_A,
    functional: "Guru Uji",
    structural: "Kepala Uji",
    teachingHoursPerWeek: 24,
    spouseCount: 1,
    childCount: 2,
    registeredDependants: 3,
    annualPerformanceRate: 1,
    monthlyPerformanceRate: 1,
    bpjsSegment: "PPU_YAYASAN",
    bpjsActiveFrom: EFFECTIVE,
    ptkpStatus: "K/2",
    bankName: "BSI",
    bankAccountNumber: ACCOUNT_A,
    bankAccountName: NAME_A,
    legacyServiceStartDate: "2016-07-01",
  };

  const profileB = {
    rowId: "PRF-2",
    nip: nip.b,
    effectiveFrom: EFFECTIVE,
    bankName: "BSI",
    bankAccountNumber: "8800000002",
    bankAccountName: "Pegawai Sintetis B",
    legacyServiceStartDate: "2017-01-01",
  };

  const loanA = { rowId: "KSB-1", nip: nip.a, grantedOn: "2090-12-31", principal: 1_234_567 };

  const cleanFile = () =>
    parseInitialLoadFile({
      format: "PAY-003-MIG/1",
      policies: [varianceRow],
      profiles: [profileA, profileB],
      loans: [loanA],
    });

  async function countOwnRows() {
    const employeeIds = Object.values(ids).map((item) => item.employeeId);
    const employmentIds = Object.values(ids).flatMap((item) => (item.employmentId ? [item.employmentId] : []));
    const { rows } = await pool.query<{ profiles: number; loans: number; policies: number }>(
      `SELECT
         (SELECT count(*)::int FROM payroll_compensation_profiles WHERE employment_id = ANY($1::uuid[])) AS profiles,
         (SELECT count(*)::int FROM payroll_loans WHERE employee_id = ANY($2::uuid[])) AS loans,
         (SELECT count(*)::int FROM payroll_policy_versions WHERE effective_from >= $3::date) AS policies`,
      [employmentIds, employeeIds, EFFECTIVE],
    );
    return rows[0]!;
  }

  function expectNoPersonalData(report: InitialLoadReport) {
    const text = JSON.stringify(report);
    for (const secret of [nip.a, nip.b, nip.noEmployment, NAME_A, ACCOUNT_A, "8800000002", "1234567", "Pegawai Sintetis"]) {
      expect(text).not.toContain(secret);
    }
  }

  it("dry-run plans every policy key and reports unmatched rows without writing anything", async () => {
    const before = await countOwnRows();
    const scale = Array.from({ length: 28 }, (_, mkg) => 1_000_000.6 + mkg * 1_000.123);
    const file = parseInitialLoadFile({
      format: "PAY-003-MIG/1",
      policies: [
        { policyKey: "SALARY_SCALE", effectiveFrom: EFFECTIVE, source: "uji", payload: { scale: { S1: scale } } },
        {
          policyKey: "BASIC_MULTIPLIER",
          effectiveFrom: EFFECTIVE,
          source: "uji",
          payload: {
            units: { [`unit:${UNIT_HALF}`]: 0.5 },
            knownUnitRefs: [`unit:${UNIT_A}`, `unit:${UNIT_HALF}`],
            workPatterns: { HALF_DAY: 0.6, HALF_DAY_II: 0.65 },
          },
        },
        {
          policyKey: "TEACHING_HOURS",
          effectiveFrom: EFFECTIVE,
          source: "uji",
          payload: { monthlyHourLimit: 96, overRatePerHour: 10_000, shortRatePerHour: 10_000, weeksPerMonth: 4 },
        },
        {
          policyKey: "PERFORMANCE",
          effectiveFrom: EFFECTIVE,
          source: "uji",
          payload: {
            defaultBase: 100_000,
            baseByPosition: { "structural:Kepala Khusus": 150_000 },
            annualShare: 0.6,
            monthlyShare: 0.4,
            unratedBelowOneYear: { annualRate: 0, monthlyRate: 1 },
          },
        },
        { policyKey: "FAMILY", effectiveFrom: EFFECTIVE, source: "uji", payload: { spouseRate: 0.05, childRate: 0.02 } },
        {
          policyKey: "FUNCTIONAL_ALLOWANCE",
          effectiveFrom: EFFECTIVE,
          source: "uji",
          payload: {
            byPosition: { "functional:Guru Uji": 100_000 },
            concurrentStructuralFactor: 0.7,
            excludedUnits: [`unit:${UNIT_HALF}`],
            positionsWithoutAllowance: [],
          },
        },
        {
          policyKey: "POSITIONAL_ALLOWANCE",
          effectiveFrom: EFFECTIVE,
          source: "uji",
          payload: {
            byPosition: { "structural:Kepala Uji": 650_000 },
            unitMultipliers: { [`unit:${UNIT_HALF}`]: 0.5 },
            positionsWithoutAllowance: [],
          },
        },
        { policyKey: "OVERTIME", effectiveFrom: EFFECTIVE, source: "uji", payload: { monthlyHourDivisor: 173 } },
        {
          policyKey: "BPJS_KESEHATAN",
          effectiveFrom: EFFECTIVE,
          source: "uji",
          payload: {
            contributionRate: 0.05,
            extraFamilyRate: 0.01,
            floor: 2_878_646,
            ceiling: 12_000_000,
            coveredChildren: 3,
            fixedAllowanceComponents: ["BASIC", "PERF"],
          },
        },
        {
          policyKey: "CONTRACT_RATES",
          effectiveFrom: EFFECTIVE,
          source: "uji",
          payload: { transportPerAttendance: 15_000, teachingFeePerHour: 15_400 },
        },
        { policyKey: "EARLY_SERVICE", effectiveFrom: EFFECTIVE, source: "uji", payload: { months: 2, netRate: 0.8 } },
        varianceRow,
        // A unit nobody has, and a key twice: both reported, neither guessed.
        {
          rowId: "POL-BAD-UNIT",
          policyKey: "BASIC_MULTIPLIER",
          effectiveFrom: EFFECTIVE,
          source: "uji",
          payload: { units: {}, knownUnitRefs: ["unit:Tidak Ada"], workPatterns: {} },
        },
      ],
      profiles: [
        profileA,
        { ...profileB, functional: "Jabatan Tanpa Tarif" },
        { rowId: "PRF-3", nip: nip.noEmployment, effectiveFrom: EFFECTIVE },
        { rowId: "PRF-4", nip: "TIDAK-ADA-NIP", effectiveFrom: EFFECTIVE },
        { rowId: "PRF-5", nip: nip.a, effectiveFrom: EFFECTIVE },
        { rowId: "PRF-6", nip: nip.actor, effectiveFrom: EFFECTIVE, unit: "Unit Yang Tidak Ada" },
        { rowId: "PRF-7", nip: nip.actor, effectiveFrom: EFFECTIVE, education: "SMA" },
      ],
      loans: [loanA, { rowId: "KSB-2", nip: "TIDAK-ADA-NIP", grantedOn: "2090-12-31", principal: 1 }],
    });

    const report = await runInitialLoad(pool, { file, apply: false, actorAccountId, sourceName: "uji.json" });

    expect(report.mode).toBe("dry-run");
    expect(report.actor).toEqual({ checked: true, problems: [] });
    for (const key of [
      "SALARY_SCALE",
      "TEACHING_HOURS",
      "PERFORMANCE",
      "FAMILY",
      "FUNCTIONAL_ALLOWANCE",
      "POSITIONAL_ALLOWANCE",
      "OVERTIME",
      "BPJS_KESEHATAN",
      "CONTRACT_RATES",
      "EARLY_SERVICE",
      "VARIANCE_THRESHOLD",
      "BASIC_MULTIPLIER",
    ]) {
      expect(report.policies.byKey[key]).toBe("CREATE");
    }
    expect(report.policies.create).toBe(12);
    expect(report.policies.errors).toEqual({ DUPLICATE_ROW: 1 });

    const issue = (rowId: string) => report.profiles.issues.find((item) => item.rowId === rowId);
    expect(report.profiles.create).toBe(2);
    expect(issue("PRF-1")).toBeUndefined();
    expect(issue("PRF-2")).toMatchObject({ outcome: "CREATE", warnings: ["TMT_DIFFERS", "POSITION_NOT_IN_POLICY"] });
    expect(issue("PRF-3")).toMatchObject({ outcome: "ERROR", errors: ["EMPLOYMENT_MISSING"] });
    expect(issue("PRF-4")).toMatchObject({ outcome: "ERROR", errors: ["EMPLOYEE_NOT_FOUND"] });
    expect(issue("PRF-5")).toMatchObject({ outcome: "ERROR", errors: ["DUPLICATE_ROW"] });
    expect(issue("PRF-6")?.errors).toEqual(expect.arrayContaining(["UNIT_UNKNOWN", "OWN_RECORD"]));
    expect(issue("PRF-7")).toMatchObject({ outcome: "ERROR", errors: ["INVALID"] });

    expect(report.loans.create).toBe(1);
    expect(report.loans.errors).toEqual({ EMPLOYEE_NOT_FOUND: 1 });

    expect(await countOwnRows()).toEqual(before);
    expectNoPersonalData(report);
  });

  it("reports a unit nobody has as UNIT_UNKNOWN on the policy row", async () => {
    const file = parseInitialLoadFile({
      format: "PAY-003-MIG/1",
      policies: [
        {
          rowId: "POL-BAD-UNIT",
          policyKey: "BASIC_MULTIPLIER",
          effectiveFrom: EFFECTIVE,
          source: "uji",
          payload: { units: {}, knownUnitRefs: ["unit:Tidak Ada"], workPatterns: {} },
        },
      ],
    });
    const report = await runInitialLoad(pool, { file, apply: false, actorAccountId: null, sourceName: "uji.json" });
    expect(report.policies.byKey.BASIC_MULTIPLIER).toBe("UNIT_UNKNOWN");
    expect(report.actor.checked).toBe(false);
  });

  it("refuses to apply a plan with any error and writes nothing", async () => {
    const before = await countOwnRows();
    const file = parseInitialLoadFile({
      format: "PAY-003-MIG/1",
      policies: [varianceRow],
      profiles: [profileA, { rowId: "PRF-3", nip: nip.noEmployment, effectiveFrom: EFFECTIVE }],
    });
    await expect(
      runInitialLoad(pool, { file, apply: true, actorAccountId, sourceName: "uji.json" }),
    ).rejects.toBeInstanceOf(InitialLoadRefused);
    expect(await countOwnRows()).toEqual(before);
  });

  it("refuses to apply without an actor account", async () => {
    await expect(
      runInitialLoad(pool, { file: cleanFile(), apply: true, actorAccountId: null, sourceName: "uji.json" }),
    ).rejects.toThrow(/actor-account/);
  });

  it("refuses an actor without the permission a section needs", async () => {
    const report = await runInitialLoad(pool, {
      file: cleanFile(),
      apply: false,
      actorAccountId: weakAccountId,
      sourceName: "uji.json",
    });
    expect(report.actor.problems).toEqual([
      "ACTOR_LACKS_payroll.policies.manage",
      "ACTOR_LACKS_payroll.profiles.manage",
    ]);
    await expect(
      runInitialLoad(pool, { file: cleanFile(), apply: true, actorAccountId: weakAccountId, sourceName: "uji.json" }),
    ).rejects.toBeInstanceOf(InitialLoadRefused);
  });

  it("applies through the store functions with their audit events, and a re-run creates nothing", async () => {
    const applied = await runInitialLoad(pool, {
      file: cleanFile(),
      apply: true,
      actorAccountId,
      sourceName: "uji.json",
    });
    expect(applied.written).toEqual({ policies: 1, profiles: 2, loans: 1 });
    expectNoPersonalData(applied);

    const policy = await pool.query<{ source: string; payload: Record<string, unknown> }>(
      "SELECT source, payload FROM payroll_policy_versions WHERE policy_key = 'VARIANCE_THRESHOLD' AND effective_from = $1::date",
      [EFFECTIVE],
    );
    expect(policy.rows[0]!.source).toContain(MIGRATION_MARKER);

    const profile = await pool.query<{
      unitRef: string;
      functionalRef: string;
      structuralRef: string;
      recordedBy: string;
    }>(
      `SELECT unit_ref AS "unitRef", functional_position_ref AS "functionalRef",
              structural_position_ref AS "structuralRef", recorded_by_account_id AS "recordedBy"
       FROM payroll_compensation_profiles WHERE employment_id = $1`,
      [ids.a!.employmentId],
    );
    expect(profile.rows[0]).toEqual({
      unitRef: unitA,
      functionalRef: positionRef("functional", "Guru Uji"),
      structuralRef: positionRef("structural", "Kepala Uji"),
      recordedBy: actorAccountId,
    });

    const loan = await pool.query<{ principal: string; note: string; instalment: string | null }>(
      "SELECT principal::text AS principal, note, instalment::text AS instalment FROM payroll_loans WHERE employee_id = $1",
      [ids.a!.employeeId],
    );
    expect(loan.rows).toEqual([{ principal: "1234567", note: expect.stringContaining(MIGRATION_MARKER), instalment: null }]);

    const audit = await pool.query<{ action: string; total: number }>(
      `SELECT action, count(*)::int AS total FROM payroll_audit_events
       WHERE actor_account_id = $1 AND occurred_at >= $2::timestamptz
       GROUP BY action ORDER BY action`,
      [actorAccountId, applied.startedAt],
    );
    expect(audit.rows).toEqual([
      { action: "payroll.initial_load.applied", total: 1 },
      { action: "payroll.initial_load.started", total: 1 },
      { action: "payroll.loan.created", total: 1 },
      { action: "payroll.policy.version_opened", total: 1 },
      { action: "payroll.profile.opened", total: 2 },
    ]);

    const rerun = await runInitialLoad(pool, { file: cleanFile(), apply: true, actorAccountId, sourceName: "uji.json" });
    expect(rerun.written).toEqual({ policies: 0, profiles: 0, loans: 0 });
    expect(rerun.policies.unchanged).toBe(1);
    expect(rerun.profiles.unchanged).toBe(2);
    expect(rerun.loans.unchanged).toBe(1);
    expect(await countOwnRows()).toMatchObject({ profiles: 2, loans: 1 });
  });

  it("never overwrites: a changed row against loaded data is EXISTS_DIFFERENT", async () => {
    await runInitialLoad(pool, { file: cleanFile(), apply: true, actorAccountId, sourceName: "uji.json" });
    const changed = parseInitialLoadFile({
      format: "PAY-003-MIG/1",
      policies: [{ ...varianceRow, payload: { ...varianceRow.payload, relative: 0.2 } }],
      profiles: [{ ...profileA, bankName: "Bank Lain" }, profileB],
      // Only the DRAFT date moved: still the same migrated balance, never a second debt.
      loans: [{ ...loanA, grantedOn: "2090-12-30" }],
    });
    const report = await runInitialLoad(pool, { file: changed, apply: false, actorAccountId, sourceName: "uji.json" });
    expect(report.policies.byKey.VARIANCE_THRESHOLD).toBe("EXISTS_DIFFERENT");
    expect(report.profiles.errors).toEqual({ EXISTS_DIFFERENT: 1 });
    expect(report.profiles.unchanged).toBe(1);
    expect(report.loans.errors).toEqual({ EXISTS_DIFFERENT: 1 });
  });

  it("keeps an identical row UNCHANGED after a later version was opened, so a re-run still recovers", async () => {
    await runInitialLoad(pool, { file: cleanFile(), apply: true, actorAccountId, sourceName: "uji.json" });
    await openPolicyVersion(
      pool,
      { policyKey: "VARIANCE_THRESHOLD", effectiveFrom: "2091-06-01", payload: varianceRow.payload, source: "uji" },
      actorAccountId,
    );
    const report = await runInitialLoad(pool, { file: cleanFile(), apply: false, actorAccountId, sourceName: "uji.json" });
    expect(report.policies.byKey.VARIANCE_THRESHOLD).toBe("UNCHANGED");
    expect(report.policies.error).toBe(0);
  });

  it("refuses impossible dates, over-precise numbers, misspelt and colliding symbols as INVALID", async () => {
    const file = parseInitialLoadFile({
      format: "PAY-003-MIG/1",
      policies: [
        {
          rowId: "POL-TYPO",
          policyKey: "FUNCTIONAL_ALLOWANCE",
          effectiveFrom: EFFECTIVE,
          source: "uji",
          payload: {
            byPosition: { "Functional:Guru Uji": 100_000 },
            concurrentStructuralFactor: 0.7,
            excludedUnits: [],
            positionsWithoutAllowance: [],
          },
        },
        {
          rowId: "POL-COLLIDE",
          policyKey: "POSITIONAL_ALLOWANCE",
          effectiveFrom: EFFECTIVE,
          source: "uji",
          payload: {
            byPosition: { "structural:Kepala Uji": 650_000, "structural:kepala  uji": 1 },
            unitMultipliers: {},
            positionsWithoutAllowance: [],
          },
        },
        { rowId: "POL-DATE", policyKey: "OVERTIME", effectiveFrom: "2091-02-30", source: "uji", payload: { monthlyHourDivisor: 173 } },
      ],
      profiles: [
        { ...profileA, rowId: "PRF-PRECISE", annualPerformanceRate: 0.12345 },
        { ...profileB, rowId: "PRF-DATE", effectiveFrom: "2091-02-30" },
      ],
    });
    const report = await runInitialLoad(pool, { file, apply: false, actorAccountId, sourceName: "uji.json" });
    expect(report.policies.byKey).toEqual({ FUNCTIONAL_ALLOWANCE: "INVALID", POSITIONAL_ALLOWANCE: "INVALID", OVERTIME: "INVALID" });
    expect(report.profiles.errors).toEqual({ INVALID: 2 });
    expect(() => parseInitialLoadFile({ format: "PAY-003-MIG/1", loan: [] })).toThrow();
  });

  it("refuses policies and profiles that would reach a calculated period", async () => {
    const periodId = randomUUID();
    ownedPeriodIds.push(periodId);
    await pool.query(
      `INSERT INTO payroll_periods(
         id, legal_entity_key, period_month, pay_date, period_start, period_end, cutoff_start, cutoff_end, state)
       VALUES ($1, $2, DATE '2091-01-01', DATE '2091-01-28', DATE '2091-01-01', DATE '2091-01-31',
               DATE '2090-12-23', DATE '2091-01-22', 'CALCULATED')`,
      [periodId, randomUUID()],
    );
    const report = await runInitialLoad(pool, { file: cleanFile(), apply: false, actorAccountId, sourceName: "uji.json" });
    expect(report.policies.byKey.VARIANCE_THRESHOLD).toBe("SETTLED_PERIOD");
    expect(report.profiles.errors).toEqual({ SETTLED_PERIOD: 2 });
    expect(report.loans.create).toBe(1);
  });
});
