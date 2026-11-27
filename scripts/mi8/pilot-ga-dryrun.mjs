// OPS-PILOT-GA-001 dry-run against production. ONE transaction, ALWAYS rolled back.
// Reads the running release's compiled code; prints names/codes only (no NIP, email, env values).
//
// Evidence: docs/operations/pilot-cuti-general-affair-2026-11-27.md §4.
// Inside the transaction it temporarily inserts a STRUCTURE rollout row for the General Affair node
// and marks active the accounts of the seat holders the chain can reach (General Affair subtree and
// its ancestors), so the resolver can show the full chain. The entitlement group is overridden in
// memory only for the hypothetical previews, never written. The final ROLLBACK discards everything,
// and the before/after counts are compared from a separate session.
// Run on the device as the HCIS service user, with DATABASE_URL and
// ANNUAL_LEAVE_SEMESTER_QUOTA_EFFECTIVE_FROM taken from the running API process, and
// REL_DIR=/srv/hcis/releases/<release>/apps/api. Never during the 19 UTC backup hour.
import { createRequire } from "node:module";

const REL = process.env.REL_DIR;
const require = createRequire(`${REL}/package.json`);
const { Pool, Client } = require("pg");
const dist = (p) => import(`file://${REL}/dist/${p}`);

const { buildAnnualPreview, jakartaToday } = await dist("modules/leave/employee-routes.js");
const { resolveLeaveAuthorities } = await dist("modules/leave/organization-authority.js");
const { leaveWorkflowKey } = await dist("modules/organization/workflow-keys.js");
const { annualLeaveSemesterQuotaEffectiveFrom } = await dist("config/env.js");

const effectiveFrom = annualLeaveSemesterQuotaEffectiveFrom({
  ANNUAL_LEAVE_SEMESTER_QUOTA_EFFECTIVE_FROM: process.env.ANNUAL_LEAVE_SEMESTER_QUOTA_EFFECTIVE_FROM,
});
const today = jakartaToday();
const out = (...a) => console.log(...a);
out(`today=${today} semesterEffectiveFrom=${effectiveFrom}`);

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const client = await pool.connect();
const counts = async (c) => (await c.query(`SELECT
  (SELECT count(*) FROM organization_rollout_settings)::int AS rollout,
  (SELECT count(*) FROM accounts WHERE status='active')::int AS active_accounts,
  (SELECT count(*) FROM accounts WHERE status='invited')::int AS invited_accounts,
  (SELECT count(*) FROM leave_requests)::int AS leave_requests,
  (SELECT count(*) FROM account_activation_invitations)::int AS invitations,
  (SELECT count(*) FROM employees WHERE leave_entitlement_group IS NULL AND status='active')::int AS unclassified`)).rows[0];

const ctxSql = `SELECT e.id, e.employee_number AS "employeeNumber", e.full_name AS "fullName", e.status,
  e.started_on::text AS "startedOn", e.leave_entitlement_group AS "leaveEntitlementGroup",
  u.id AS "unitId", u.name AS "unitName", NULL::text AS "positionName",
  e.direct_manager_employee_id AS "directManagerEmployeeId",
  u.leave_approver_employee_id AS "unitApproverEmployeeId",
  a.id AS "accountId", a.status AS "accountStatus"
  FROM employees e
  LEFT JOIN organizational_units u ON u.id = e.organizational_unit_id
  LEFT JOIN accounts a ON a.employee_id = e.id AND a.principal_type = 'EMPLOYEE'
  WHERE e.full_name = $1 AND e.status = 'active' AND e.removed_at IS NULL`;
const person = async (name) => {
  const r = await client.query(ctxSql, [name]);
  if (r.rows.length !== 1) throw new Error(`expected 1 active row for ${name}, got ${r.rows.length}`);
  return r.rows[0];
};

const observe = async () => {
  const other = new Client({ connectionString: process.env.DATABASE_URL });
  await other.connect();
  try {
    const pid = (await other.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    return { pid, ...(await counts(other)) };
  } finally { await other.end(); }
};
const dryRunPid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
const { pid: observerBefore, ...before } = await observe();
if (observerBefore === dryRunPid) throw new Error("observer shares the dry-run session");
out("before", JSON.stringify(before));

try {
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '2s'");
  await client.query("SET LOCAL statement_timeout = '20s'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");

  const resolve = async (label, emp) => {
    await client.query("SAVEPOINT r");
    try {
      const r = await resolveLeaveAuthorities(client, {
        workflowKey: leaveWorkflowKey("annual"), requesterEmployeeId: emp.id, effectiveDate: today,
        legacy: { directManagerEmployeeId: emp.directManagerEmployeeId, unitApproverEmployeeId: emp.unitApproverEmployeeId },
        policyChain: "LINE_AND_UNIT", allowAccountPrincipal: true,
      });
      const steps = [];
      for (const s of r.approvalChain) {
        const name = s.employeeId
          ? (await client.query("SELECT full_name FROM employees WHERE id=$1", [s.employeeId])).rows[0].full_name
          : "akun";
        steps.push(`${name} [${(s.sources ?? []).join("+")}]`);
      }
      out(`ROUTE ${label}: sumber=${r.context?.authoritativeSource} rantai=${steps.join(" -> ")}`);
    } catch (err) {
      out(`ROUTE ${label}: DITOLAK ${err.code ?? err.name}: ${err.message}`);
    }
    await client.query("ROLLBACK TO SAVEPOINT r");
  };

  const kholik = await person("Abdul Kholik");
  const wahyu = await person("Wahyu Sanjaya");
  const yani = await person("Ahmad Yani");
  const muslihah = await person("Muslihah");

  await resolve("G1 Kepala GA, tanpa baris rollout (hari ini)", kholik);
  await resolve("G2 Keamanan, tanpa baris rollout (hari ini)", wahyu);

  const latest = (await client.query(
    `SELECT id, name, effective_on::text AS eff FROM organization_change_sets
     WHERE status = 'PUBLISHED' AND effective_on <= $1::date
     ORDER BY effective_on DESC, published_at DESC LIMIT 1`, [today])).rows[0];
  const nodes = (await client.query(
    `SELECT stable_key, name FROM organization_nodes
     WHERE change_set_id = $1 AND name = 'General Affair' AND active`, [latest.id])).rows;
  if (nodes.length !== 1) throw new Error(`expected exactly one General Affair node, got ${nodes.length}`);
  const node = nodes[0];
  out(`node: ${node.name} dari bagan terbit "${latest.name}" (berlaku ${latest.eff})`);
  const actor = (await client.query(
    "SELECT id FROM accounts WHERE status='active' AND principal_type <> 'EMPLOYEE' ORDER BY created_at LIMIT 1")).rows[0]
    ?? (await client.query("SELECT id FROM accounts WHERE status='active' ORDER BY created_at LIMIT 1")).rows[0];
  await client.query(
    `INSERT INTO organization_rollout_settings (id, workflow_key, node_key, mode, effective_from, reason, changed_by_account_id)
     VALUES (gen_random_uuid(), 'leave.annual', $1, 'STRUCTURE', $2::date, 'DRY-RUN OPS-PILOT-GA-001 (rolled back)', $3)`,
    [node.stable_key, today, actor.id]);

  await resolve("G3 Keamanan, STRUCTURE, akun penyetuju masih invited", wahyu);

  // Seat holders the chain can reach: positions on the General Affair subtree and its ancestors.
  const holders = (await client.query(
    `WITH RECURSIVE down(k) AS (
       SELECT stable_key FROM organization_nodes WHERE change_set_id = $1 AND stable_key = $2
       UNION SELECT n.stable_key FROM organization_nodes n JOIN down ON n.parent_node_key = down.k
        WHERE n.change_set_id = $1 AND n.active),
     up(k) AS (
       SELECT parent_node_key FROM organization_nodes WHERE change_set_id = $1 AND stable_key = $2
       UNION SELECT n.parent_node_key FROM organization_nodes n JOIN up ON n.stable_key = up.k
        WHERE n.change_set_id = $1 AND n.parent_node_key IS NOT NULL)
     SELECT DISTINCT e.full_name, a.id AS account_id, a.status
       FROM organization_positions p
       JOIN organization_incumbencies i ON i.position_key = p.stable_key AND i.change_set_id = p.change_set_id AND i.kind = 'PRIMARY'
       JOIN employees e ON e.id = i.employee_id
       LEFT JOIN accounts a ON a.employee_id = e.id AND a.principal_type = 'EMPLOYEE'
      WHERE p.change_set_id = $1 AND (p.node_key IN (SELECT k FROM down) OR p.node_key IN (SELECT k FROM up))`,
    [latest.id, node.stable_key])).rows;
  out(`holders: ${holders.map((h) => `${h.full_name} (${h.status ?? "tanpa akun"})`).join(", ")}`);
  const activatable = holders.filter((h) => h.account_id).map((h) => h.account_id);
  await client.query("UPDATE accounts SET status='active' WHERE id = ANY($1::uuid[])", [activatable]);

  await resolve("G4 Keamanan, STRUCTURE, akun pejabat aktif", wahyu);
  await resolve("G5 Kebersihan, STRUCTURE, akun pejabat aktif", yani);
  await resolve("G6 Kepala GA sebagai pemohon", kholik);
  await resolve("G7 Juru Masak (di bawah Dapur)", muslihah);

  const otherId = (await client.query(
    `WITH RECURSIVE down(k) AS (
       SELECT stable_key FROM organization_nodes WHERE change_set_id = $1 AND name = 'Bidang Operasional'
       UNION SELECT n.stable_key FROM organization_nodes n JOIN down ON n.parent_node_key = down.k WHERE n.change_set_id = $1)
     SELECT m.employee_id AS id FROM organization_memberships m JOIN employees e ON e.id = m.employee_id
      WHERE m.change_set_id = $1 AND m.is_primary AND e.status = 'active'
        AND m.node_key NOT IN (SELECT k FROM down) ORDER BY m.employee_id LIMIT 1`, [latest.id])).rows[0].id;
  const other = (await client.query(ctxSql.replace("e.full_name = $1", "e.id = $1"), [otherId])).rows[0];
  await resolve("G8 satu pegawai di luar Bidang Operasional — harus tetap LEGACY", other);

  const preview = async (label, emp, s, e) => {
    await client.query("SAVEPOINT p");
    try {
      const p = await buildAnnualPreview(client, emp, { startOn: s, endOn: e }, today, { semesterEffectiveFrom: effectiveFrom });
      out(`PREVIEW ${label} ${s}..${e}: ${p.calculation.workingDays}hk ${p.validation.quotaScheme} ${p.validation.periodKey} batas=${p.validation.periodLimitDays} rantai=${p.approvalChain.map((x) => x.name).join(" -> ")}`);
    } catch (err) {
      out(`PREVIEW ${label} ${s}..${e}: DITOLAK ${err.code ?? err.name}: ${err.message}`);
    }
    await client.query("ROLLBACK TO SAVEPOINT p");
  };
  await preview("P1 Kepala GA (kelompok tercatat)", kholik, "2026-12-10", "2026-12-10");
  await preview("P2 Kepala GA (kelompok tercatat)", kholik, "2027-01-07", "2027-01-07");
  await preview("P3 Keamanan, kelompok kosong seperti tercatat", wahyu, "2026-12-17", "2026-12-17");
  await preview("P4 Keamanan, ANDAI HCM menetapkan non_education (hanya di memori)",
    { ...wahyu, leaveEntitlementGroup: "non_education" }, "2026-12-17", "2026-12-17");
} finally {
  try {
    await client.query("ROLLBACK");
    out("ROLLBACK done");
  } finally {
    client.release();
  }
}
await pool.end();
const { pid: observerAfter, ...after } = await observe();
out(`observer sessions ${observerBefore}/${observerAfter}, dry-run session ${dryRunPid}`);
out("after ", JSON.stringify(after));
out(JSON.stringify(before) === JSON.stringify(after) ? "UNCHANGED: production identik sebelum dan sesudah" : "WARNING: counts differ");
